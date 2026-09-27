import { turn } from './turn.js';
import { applyIceMode } from './mode.js';
import { Peer } from './peer.js';

// Streaming previews: random-access reads of a shared file, served straight from the
// owner's disk. A download is one sequential pass into a sink; a preview instead asks
// for byte ranges on demand, so a video starts playing at once and can seek anywhere
// without the whole file crossing the wire first.
//
// Each preview session gets its own RTCPeerConnection, set up like a download: the
// viewer registers a fresh per-session Peer and asks the owner (over the room
// connection, relayed by the host) to connect to it. The channel then carries JSON
// strings for control and raw ArrayBuffers for bytes:
//
//   viewer -> owner  {type:'range', id, start, end}   read bytes [start, end)
//                    {type:'cancel', id}               drop a queued or running read
//   owner -> viewer  {type:'ready', size}              the session is serving
//                    {type:'begin', id}                binary frames that follow are read `id`
//                    {type:'end', id}                  read `id` is complete
//                    {type:'error', id?, reason}       read failed (no id: session is over)
//
// The owner serves reads one at a time in request order, and the channel is ordered,
// so the binary frames between 'begin' and 'end' belong to exactly one read.

const CHUNK_SIZE = 16 * 1024;          // Per DataChannel message — same as downloads.
const DISK_READ_SIZE = 256 * 1024;     // Owner: bytes read from the file per slice.
// Owner: channel buffer bounds. Far below a download's 1 MiB on purpose: bytes queued
// on the channel can't be recalled, so when the viewer seeks, everything still queued
// for the dropped read has to cross the wire before the first byte it now wants.
const HIGH_WATER = 256 * 1024;
const LOW_WATER = 64 * 1024;
const MAX_READ = 8 * 1024 * 1024;      // Largest single range a viewer may ask for.
const MAX_QUEUED_READS = 32;           // Owner: reads held per session before refusing more.
// Viewer: each stream starts with one small read and widens (bigger blocks, more of
// them in flight) as its reader keeps consuming — like TCP slow start. Media elements
// open many short-lived probe requests (a fragmented MP4 is scanned ~500 KB at a
// time); asking for megabytes on each would bury the next request under bytes that are
// thrown away.
const FIRST_BLOCK_SIZE = 64 * 1024;
const BLOCK_SIZE = 1024 * 1024;        // Viewer: largest single range request.
const READ_AHEAD = 4;                  // Viewer: most range requests in flight per stream.
const OPEN_TIMEOUT_MS = 20_000;
// Same policy as downloads: browsers retry a 'disconnected' ICE session for ~30s.
const ICE_DISCONNECT_GRACE_MS = 30_000;

// Reasons either side may put on the wire or surface to the viewer UI.
export const PREVIEW_REASONS = new Set([
  'busy', 'removed', 'unavailable', 'failed', 'timeout', 'connection-lost',
  'invalid-range', 'read-failed', 'mismatch', 'closed',
]);

function reasonError(reason) {
  const err = new Error(`Preview ${reason}`);
  err.reason = reason;
  return err;
}

function withTimeout(promise, ms, reason) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(reasonError(reason)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

// Resolve once the channel buffer has drained below HIGH_WATER (or the channel died).
function awaitDrain(dc) {
  if (dc.bufferedAmount < HIGH_WATER) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      dc.removeEventListener('bufferedamountlow', done);
      dc.removeEventListener('close', done);
      dc.removeEventListener('error', done);
      resolve();
    };
    dc.addEventListener('bufferedamountlow', done);
    dc.addEventListener('close', done);
    dc.addEventListener('error', done);
    if (dc.bufferedAmount < HIGH_WATER || dc.readyState !== 'open') done();
  });
}

function sendOn(dc, data) {
  if (!dc || dc.readyState !== 'open') return false;
  try {
    dc.send(typeof data === 'string' || data instanceof ArrayBuffer ? data : JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
}

function concat(chunks) {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.byteLength; }
  return out;
}

// A per-session Peer registered with the signaling server, mirroring File.init.
async function createPeer() {
  const iceServers = await turn.getServers();
  const response = await fetch('/api/uuid');
  if (!response.ok) throw new Error(`uuid endpoint failed: HTTP ${response.status}`);
  const { uuid } = await response.json();
  const isSecure = window.location.protocol === 'https:';
  const peer = new Peer(uuid, {
    host: window.location.hostname,
    port: parseInt(window.location.port) || (isSecure ? 443 : 80),
    secure: isSecure,
    config: applyIceMode({ iceServers }),
  });
  await new Promise((resolve, reject) => {
    let settled = false;
    peer.on('open', () => { if (!settled) { settled = true; resolve(); } });
    // Post-open signaling errors don't matter: once the RTC link is up the session
    // no longer needs the signaling socket.
    peer.on('error', (err) => {
      if (settled) return;
      settled = true;
      try { peer.destroy(); } catch {}
      reject(err);
    });
  });
  return peer;
}

// ---- Owner side ------------------------------------------------------------------------

export class PreviewServer {
  _file;
  _request;              // the validated webrtc-file-preview payload
  _peer = null;
  _conn = null;
  _dc = null;
  _queue = [];
  _active = null;        // the read being sent right now
  _pumping = false;
  _failing = false;
  _closed = false;
  _iceTimer = null;
  onClose = null;

  constructor(file, request) {
    this._file = file;
    this._request = request;
  }

  get fileId() { return this._file.id }
  get requesterId() { return this._request.requester_id }
  get closed() { return this._closed }

  // Connect to the viewer's per-session peer and start serving. Rejects when the
  // viewer can't be reached — the caller then tells it over the room connection.
  async start() {
    try {
      const peer = await createPeer();
      if (this._closed) { try { peer.destroy(); } catch {} throw reasonError('closed'); }
      this._peer = peer;
      const conn = peer.connect(this._request.peer_id, { serialization: 'raw', reliable: true });
      await withTimeout(new Promise((resolve, reject) => {
        conn.on('open', resolve);
        conn.on('error', reject);
        conn.on('close', () => reject(reasonError('connection-lost')));
      }), OPEN_TIMEOUT_MS, 'timeout');
      if (this._closed) throw reasonError('closed');
      this.attach(conn);
    } catch (err) {
      this.close();
      throw err;
    }
  }

  // Serve over an open connection. Split from start() so tests can drive the protocol.
  attach(conn) {
    this._conn = conn;
    this._dc = conn.dataChannel;
    this._dc.bufferedAmountLowThreshold = LOW_WATER;
    conn.on('data', (data) => this._onData(data));
    conn.on('close', () => this.close());
    this._watchIce(conn.peerConnection);
    sendOn(this._dc, { type: 'ready', size: this._file.size });
  }

  // End the session and tell the viewer why. Closing drops whatever is still queued on
  // the channel, so give the error up to a second to get out first (best-effort: the
  // viewer also learns of a removal over the room connection).
  fail(reason) {
    if (this._closed || this._failing) return;
    this._failing = true;
    this._queue.length = 0;
    if (this._active) this._active.cancelled = true;
    sendOn(this._dc, { type: 'error', reason });
    const deadline = Date.now() + 1000;
    const closeWhenSent = () => {
      if (this._closed) return;
      if (!this._dc || this._dc.bufferedAmount === 0 || Date.now() > deadline) this.close();
      else setTimeout(closeWhenSent, 50);
    };
    closeWhenSent();
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    this._queue.length = 0;
    clearTimeout(this._iceTimer);
    try { this._conn?.close(); } catch {}
    try { this._peer?.destroy(); } catch {}
    const cb = this.onClose;
    this.onClose = null;
    if (cb) cb();
  }

  _watchIce(pc) {
    if (!pc || typeof pc.addEventListener !== 'function') return;
    pc.addEventListener('iceconnectionstatechange', () => {
      clearTimeout(this._iceTimer);
      if (pc.iceConnectionState === 'disconnected') {
        this._iceTimer = setTimeout(() => this.close(), ICE_DISCONNECT_GRACE_MS);
      }
    });
  }

  _onData(data) {
    if (typeof data !== 'string') return;  // Owners never receive bytes.
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'range') this._onRange(msg);
    else if (msg.type === 'cancel') this._onCancel(msg);
  }

  _onRange({ id, start, end }) {
    if (!Number.isSafeInteger(id) || this._failing) return;
    const valid = Number.isSafeInteger(start) && Number.isSafeInteger(end)
      && start >= 0 && start <= end && end <= this._file.size && end - start <= MAX_READ;
    if (!valid) {
      sendOn(this._dc, { type: 'error', id, reason: 'invalid-range' });
      return;
    }
    if (this._queue.length >= MAX_QUEUED_READS) {
      sendOn(this._dc, { type: 'error', id, reason: 'busy' });
      return;
    }
    this._queue.push({ id, start, end, cancelled: false });
    this._pump();
  }

  _onCancel({ id }) {
    const i = this._queue.findIndex((r) => r.id === id);
    if (i >= 0) this._queue.splice(i, 1);
    if (this._active && this._active.id === id) this._active.cancelled = true;
  }

  async _pump() {
    if (this._pumping) return;
    this._pumping = true;
    try {
      while (!this._closed && this._queue.length) {
        const read = this._queue.shift();
        this._active = read;
        if (!sendOn(this._dc, { type: 'begin', id: read.id })) return this.close();
        for (let pos = read.start; pos < read.end && !read.cancelled;) {
          if (this._file.removed) return this.fail('removed');
          const stop = Math.min(pos + DISK_READ_SIZE, read.end);
          const bytes = await this._file._content.slice(pos, stop).arrayBuffer();
          for (let off = 0; off < bytes.byteLength && !read.cancelled; off += CHUNK_SIZE) {
            await awaitDrain(this._dc);
            if (this._closed) return;
            if (read.cancelled) break;  // Cancelled while we waited for room.
            if (!sendOn(this._dc, bytes.slice(off, off + CHUNK_SIZE))) return this.close();
          }
          pos = stop;
        }
        this._active = null;
        sendOn(this._dc, { type: 'end', id: read.id });
      }
    } catch (err) {
      console.warn('Preview read failed:', err);
      this.fail('read-failed');
    } finally {
      this._active = null;
      this._pumping = false;
    }
  }
}

// ---- Viewer side -----------------------------------------------------------------------

export class RemoteSource {
  _size;
  _peer = null;
  _conn = null;
  _dc = null;
  _reads = new Map();    // id -> pending read
  _current = null;       // the read whose bytes are on the wire right now
  _seq = 0;
  _closed = false;
  _error = null;
  _ready;
  onClose = null;        // called with the error when the session dies on its own

  constructor(size) {
    this._size = size;
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    promise.catch(() => {});
    this._ready = { promise, resolve, reject };
  }

  get size() { return this._size }
  get peerId() { return this._peer ? this._peer.id : null }
  get closed() { return this._closed }

  // Register a per-session peer, ask the owner to connect to it, and wait until it
  // serves. `request(peerId)` routes the ask and returns false if it couldn't.
  async open(request) {
    try {
      const peer = await createPeer();
      if (this._closed) { try { peer.destroy(); } catch {} throw this._error || reasonError('closed'); }
      this._peer = peer;
      peer.on('connection', (conn) => conn.on('open', () => {
        // Only the first connection is the owner's; nobody else should know this id.
        if (this._conn || this._closed) { try { conn.close(); } catch {} return; }
        this.attach(conn);
      }));
      if (!request(peer.id)) throw reasonError('unavailable');
      await withTimeout(this._ready.promise, OPEN_TIMEOUT_MS, 'timeout');
    } catch (err) {
      this.close(err.reason ? err : reasonError('failed'));
      throw this._error || err;
    }
  }

  attach(conn) {
    this._conn = conn;
    this._dc = conn.dataChannel;
    conn.on('data', (data) => this._onData(data));
    conn.on('close', () => this.close(reasonError('connection-lost')));
  }

  // Abort from outside, e.g. the owner declined the session over the room connection.
  fail(reason) {
    this.close(reasonError(reason));
  }

  close(err = null) {
    if (this._closed) return;
    this._closed = true;
    this._error = err;
    this._ready.reject(err || reasonError('closed'));
    for (const read of this._reads.values()) this._settle(read, err || reasonError('closed'));
    this._reads.clear();
    this._current = null;
    try { this._conn?.close(); } catch {}
    try { this._peer?.destroy(); } catch {}
    const cb = this.onClose;
    this.onClose = null;
    if (cb && err) cb(err);
  }

  // Bytes [start, end) as a pull-driven stream. Keeps up to READ_AHEAD block requests
  // in flight so the owner never idles, and never buffers more than that ahead of the
  // consumer — a paused video stops pulling, and so does the network.
  stream(start = 0, end = this._size) {
    let next = start;
    let blockSize = FIRST_BLOCK_SIZE;
    let depth = 1;   // Requests allowed in flight; grows with every block consumed.
    const inflight = [];
    const fill = () => {
      while (inflight.length < depth && next < end) {
        const stop = Math.min(next + blockSize, end);
        inflight.push(this._request(next, stop));
        next = stop;
        blockSize = Math.min(blockSize * 2, BLOCK_SIZE);
      }
    };
    const cancelAll = () => {
      for (const read of inflight) this._cancel(read);
      inflight.length = 0;
    };
    return new ReadableStream({
      pull: async (controller) => {
        fill();
        for (;;) {
          const head = inflight[0];
          if (!head) { controller.close(); return; }
          if (head.chunks.length) {
            const chunks = head.chunks.splice(0);
            controller.enqueue(chunks.length === 1 ? chunks[0] : concat(chunks));
            return;
          }
          if (head.error) { cancelAll(); throw head.error; }
          if (head.done) {
            inflight.shift();
            depth = Math.min(depth + 1, READ_AHEAD);
            fill();
            continue;
          }
          await new Promise((resolve) => { head.waiter = resolve; });
        }
      },
      cancel: cancelAll,
    }, { highWaterMark: 0 });
  }

  // Bytes [start, end) as one buffer — for small reads like text previews.
  async read(start, end) {
    const chunks = [];
    const reader = this.stream(start, end).getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return concat(chunks);
      chunks.push(value);
    }
  }

  _request(start, end) {
    const read = { id: ++this._seq, start, end, chunks: [], received: 0, done: false, cancelled: false, error: null, waiter: null };
    if (this._closed) { read.error = this._error || reasonError('closed'); return read; }
    this._reads.set(read.id, read);
    if (!sendOn(this._dc, { type: 'range', id: read.id, start, end })) {
      this._settle(read, reasonError('connection-lost'));
    }
    return read;
  }

  _cancel(read) {
    if (read.done || read.error || read.cancelled) return;
    read.cancelled = true;
    read.chunks.length = 0;
    this._reads.delete(read.id);
    sendOn(this._dc, { type: 'cancel', id: read.id });
  }

  _settle(read, err) {
    read.error = err;
    this._reads.delete(read.id);
    this._wake(read);
  }

  _wake(read) {
    const waiter = read.waiter;
    read.waiter = null;
    if (waiter) waiter();
  }

  _onData(data) {
    if (typeof data === 'string') {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      this._onControl(msg);
      return;
    }
    const buf = data instanceof ArrayBuffer ? data
      : ArrayBuffer.isView(data) ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
      : null;
    const read = this._current;
    // No current read: these are the tail of a read we cancelled — drop them.
    if (!buf || !read || read.cancelled || read.error) return;
    read.received += buf.byteLength;
    if (read.received > read.end - read.start) {
      this._current = null;
      this._settle(read, reasonError('mismatch'));
      return;
    }
    read.chunks.push(new Uint8Array(buf));
    this._wake(read);
  }

  _onControl(msg) {
    switch (msg.type) {
      case 'ready':
        if (msg.size !== this._size) this.close(reasonError('mismatch'));
        else this._ready.resolve();
        return;
      case 'begin':
        this._current = this._reads.get(msg.id) || null;
        return;
      case 'end': {
        const read = this._reads.get(msg.id);
        if (this._current && this._current.id === msg.id) this._current = null;
        if (!read) return;
        if (read.received !== read.end - read.start) {
          this._settle(read, reasonError('mismatch'));
        } else {
          read.done = true;
          this._reads.delete(read.id);
          this._wake(read);
        }
        return;
      }
      case 'error': {
        const reason = PREVIEW_REASONS.has(msg.reason) ? msg.reason : 'failed';
        if (msg.id === undefined) { this.close(reasonError(reason)); return; }
        const read = this._reads.get(msg.id);
        if (!read) return;
        if (this._current === read) this._current = null;
        this._settle(read, reasonError(reason));
      }
    }
  }
}
