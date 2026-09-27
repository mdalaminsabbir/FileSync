// Preview session protocol tests.
//
// Drives the REAL PreviewServer (owner) and RemoteSource (viewer) from
// web/js/modules/webrtc/preview.js against each other over an in-memory, ordered
// channel pair, and proves:
//
//   1. Any byte range comes back byte-exact, across block boundaries.
//   2. Two streams open at once (a media element's overlapping requests) each get
//      exactly their own bytes, even though reads share one ordered channel.
//   3. Cancelling a stream stops the owner early, and the cancelled read's in-flight
//      tail never leaks into the next read.
//   4. The owner refuses out-of-bounds and oversized ranges and floods of reads, per
//      read, without ending the session.
//   5. A removed file ends the session with 'removed'; a dropped channel with
//      'connection-lost'.
//
// Run: npm test

import test from 'node:test';
import assert from 'node:assert/strict';

// ---------- browser environment stubs (must exist before app modules are imported) ----------
globalThis.window = globalThis;
globalThis.location = { search: '', href: 'http://localhost/', protocol: 'http:', origin: 'http://localhost', hostname: 'localhost', port: '', replace() {} };
const _ss = new Map();
globalThis.sessionStorage = {
  getItem: (k) => (_ss.has(k) ? _ss.get(k) : null),
  setItem: (k, v) => _ss.set(k, String(v)),
  removeItem: (k) => _ss.delete(k),
};
globalThis.document = {
  getElementById: () => null,
  createElement: () => ({ style: {}, appendChild() {}, addEventListener() {} }),
  body: { appendChild() {} },
};

const _previewUrl = new URL('../../web/js/modules/webrtc/preview.js', import.meta.url);
const { PreviewServer, RemoteSource } = await import(_previewUrl.href);

// ---------- in-memory channel pair ----------
// Mirrors the slice of DataConnection the preview code touches: on('data'|'close'),
// close(), dataChannel.{send, readyState, bufferedAmount}. Delivery is async and FIFO,
// like a reliable ordered RTCDataChannel.
class Endpoint {
  constructor(name) {
    this.name = name;
    this.other = null;
    this.handlers = { data: [], close: [] };
    this.closed = false;
    this.peerConnection = null;
    this.bytesSent = 0;
    this.controlSent = [];
    const self = this;
    this.dataChannel = {
      readyState: 'open',
      bufferedAmount: 0,
      send(data) {
        if (this.readyState !== 'open') throw new Error('channel not open');
        if (typeof data === 'string') self.controlSent.push(JSON.parse(data));
        else self.bytesSent += data.byteLength;
        const copy = typeof data === 'string' ? data : data.slice(0);
        queueMicrotask(() => self.other._emit('data', copy));
      },
      addEventListener() {},
      removeEventListener() {},
    };
  }
  on(ev, fn) { this.handlers[ev].push(fn); return this; }
  _emit(ev, ...args) { if (!this.closed || ev === 'close') for (const fn of this.handlers[ev].slice()) fn(...args); }
  close() {
    if (this.closed) return;
    for (const end of [this, this.other]) end.dataChannel.readyState = 'closed';
    this.closed = true;
    queueMicrotask(() => {
      this._emit('close');
      if (!this.other.closed) { this.other.closed = true; this.other._emit('close'); }
    });
  }
}

function pipe() {
  const owner = new Endpoint('owner');
  const viewer = new Endpoint('viewer');
  owner.other = viewer;
  viewer.other = owner;
  return { owner, viewer };
}

function patternBytes(size) {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 31 + (i >> 11)) & 0xff;
  return bytes;
}

// A session wired end to end. `file` is what the owner shares (a Blob, like a File).
function session(size) {
  const bytes = patternBytes(size);
  const file = { id: 'file-1', size, removed: false, _content: new Blob([bytes]) };
  const { owner, viewer } = pipe();
  const server = new PreviewServer(file, { requester_id: 'viewer-1', peer_id: 'viewer-peer-1' });
  const source = new RemoteSource(size);
  source.attach(viewer);
  server.attach(owner);
  return { bytes, file, owner, viewer, server, source };
}

const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const MiB = 1024 * 1024;

function assertBytes(actual, expected, label) {
  assert.equal(actual.byteLength, expected.byteLength, `${label}: length`);
  // Compare in one shot — deepEqual on multi-MiB arrays is very slow.
  assert.ok(Buffer.from(actual).equals(Buffer.from(expected)), `${label}: content differs`);
}

// ---------- scenarios ----------
test('owner announces itself with the file size', async () => {
  const { owner } = session(1000);
  await settle();
  assert.deepEqual(owner.controlSent[0], { type: 'ready', size: 1000 });
});

test('ranges come back byte-exact across block boundaries', async () => {
  const size = 3 * MiB + 12345;
  const { bytes, source } = session(size);

  assertBytes(await source.read(0, size), bytes, 'whole file');
  assertBytes(await source.read(MiB - 7, 2 * MiB + 9), bytes.subarray(MiB - 7, 2 * MiB + 9), 'mid range');
  assertBytes(await source.read(size - 2, size), bytes.subarray(size - 2), 'last two bytes');
  assertBytes(await source.read(5, 5), new Uint8Array(0), 'empty range');
});

test('overlapping streams each get exactly their own bytes', async () => {
  const size = 5 * MiB;
  const { bytes, source } = session(size);
  const a = source.stream(0, 3 * MiB).getReader();
  const b = source.stream(2 * MiB + 100, size).getReader();
  const got = { a: [], b: [] };
  let doneA = false, doneB = false;
  // Alternate reads, the way a media element juggles a request it's about to drop.
  while (!doneA || !doneB) {
    if (!doneA) { const r = await a.read(); if (r.done) doneA = true; else got.a.push(r.value); }
    if (!doneB) { const r = await b.read(); if (r.done) doneB = true; else got.b.push(r.value); }
  }
  assertBytes(Buffer.concat(got.a), bytes.subarray(0, 3 * MiB), 'stream a');
  assertBytes(Buffer.concat(got.b), bytes.subarray(2 * MiB + 100), 'stream b');
});

test('cancel stops the owner early and never leaks into the next read', async () => {
  const size = 24 * MiB;
  const { bytes, source, owner, server } = session(size);

  const reader = source.stream(0, size).getReader();
  const first = await reader.read();
  assertBytes(first.value, bytes.subarray(0, first.value.byteLength), 'first chunk');
  await reader.cancel();

  // A seek right after: the old read's tail may still be on the wire.
  const seek = 17 * MiB + 3;
  assertBytes(await source.read(seek, seek + MiB), bytes.subarray(seek, seek + MiB), 'read after cancel');
  await settle();

  assert.ok(owner.bytesSent < size / 2, `owner kept sending after cancel: ${owner.bytesSent} of ${size} bytes`);
  assert.equal(server._queue.length, 0, 'no reads left queued');
  assert.equal(server._active, null, 'no read left running');
  assert.equal(source._reads.size, 0, 'viewer tracks no pending reads');
});

test('owner refuses bad ranges per read and keeps serving', async () => {
  const size = 10 * MiB;
  const { bytes, viewer, source } = session(size);
  const errors = [];
  viewer.on('data', (d) => { if (typeof d === 'string') { const m = JSON.parse(d); if (m.type === 'error') errors.push(m); } });
  const send = (m) => viewer.dataChannel.send(JSON.stringify(m));

  send({ type: 'range', id: 9001, start: size - 10, end: size + 10 });   // past the end
  send({ type: 'range', id: 9002, start: 0, end: 9 * MiB });             // over MAX_READ
  send({ type: 'range', id: 9003, start: 50, end: 10 });                 // backwards
  send({ type: 'range', id: 'x', start: 0, end: 10 });                   // bad id: ignored
  await settle();
  assert.deepEqual(errors.map((e) => [e.id, e.reason]), [
    [9001, 'invalid-range'], [9002, 'invalid-range'], [9003, 'invalid-range'],
  ]);

  // Through the RemoteSource the same refusal fails just that stream.
  await assert.rejects(source.read(size - 10, size + 10), (err) => err.reason === 'invalid-range');
  assertBytes(await source.read(0, 4096), bytes.subarray(0, 4096), 'session still serves');
});

test('owner refuses a flood of queued reads with busy', async () => {
  const { viewer } = session(MiB);
  const errors = [];
  viewer.on('data', (d) => { if (typeof d === 'string') { const m = JSON.parse(d); if (m.type === 'error') errors.push(m); } });
  for (let id = 1; id <= 40; id++) {
    viewer.dataChannel.send(JSON.stringify({ type: 'range', id, start: 0, end: 1024 }));
  }
  await settle(100);
  assert.ok(errors.length > 0 && errors.every((e) => e.reason === 'busy'), `expected busy refusals, got ${JSON.stringify(errors)}`);
});

test('removing the file ends the session with "removed"', async () => {
  const size = 2 * MiB;
  const { file, source, server } = session(size);
  let closedWith = null;
  source.onClose = (err) => { closedWith = err.reason; };
  file.removed = true;

  await assert.rejects(source.read(0, size), (err) => err.reason === 'removed');
  await settle();
  assert.equal(closedWith, 'removed');
  assert.equal(source.closed, true);
  assert.equal(server.closed, true);
});

test('owner lets its error drain before closing the channel', async () => {
  const { owner, server } = session(MiB);
  await settle();
  owner.dataChannel.bufferedAmount = 5000;  // bytes still queued ahead of the error
  server.fail('read-failed');
  assert.deepEqual(owner.controlSent.at(-1), { type: 'error', reason: 'read-failed' });
  assert.equal(server.closed, false, 'closing now would drop the queued error');
  owner.dataChannel.bufferedAmount = 0;
  await settle(120);
  assert.equal(server.closed, true);
});

test('a dropped channel fails pending reads with "connection-lost"', async () => {
  const size = 8 * MiB;
  const { bytes, file, source, owner } = session(size);
  // The owner's disk stalls after two slices, so the read is surely mid-flight.
  let slices = 0;
  file._content = {
    slice: (a, b) => ({
      arrayBuffer: () => (slices++ < 2 ? Promise.resolve(bytes.slice(a, b).buffer) : new Promise(() => {})),
    }),
  };
  let closedWith = null;
  source.onClose = (err) => { closedWith = err.reason; };
  const reading = source.read(0, size);
  await settle();
  owner.close();

  await assert.rejects(reading, (err) => err.reason === 'connection-lost');
  assert.equal(closedWith, 'connection-lost');
  // Reads after the session died fail at once instead of hanging.
  await assert.rejects(source.read(0, 10), (err) => err.reason === 'connection-lost');
});

test('closing the viewer side ends the owner session', async () => {
  const { source, server } = session(MiB);
  let ownerClosed = false;
  server.onClose = () => { ownerClosed = true; };
  source.close();
  await settle();
  assert.equal(ownerClosed, true);
});
