// FileSync streaming-download Service Worker. It also serves streaming previews at
// /__preview/{id} — see the section further down.
//
// The page registers a transfer by posting `{ type: 'register', id, name, size, mime, port }`
// where `port` is one end of a MessageChannel. The page then navigates (or anchor-clicks)
// to `/__download/{id}`; this SW intercepts that fetch and returns a Response whose body
// is a ReadableStream fed by chunks pushed through the port.
//
// Port messages from the page:
//   ArrayBuffer | Uint8Array  -> enqueued as a chunk
//   { type: 'end' }           -> stream is closed cleanly
//   { type: 'abort' }         -> stream is errored (browser will show an incomplete download)
//
// The transfer entry deliberately stays in the map after 'end': in Firefox the
// navigation's fetch event can arrive AFTER the page finished streaming (fast
// drain of small staged files), so deleting on 'end' would 404 a download whose
// bytes are already fully buffered in the closed stream. The fetch handler
// guards re-serving with `served`; the GC reclaims old entries.

const transfers = new Map();
const KEEPALIVE_MS = 15_000;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('message', (event) => {
  const msg = event.data;
  // The page checks the active worker knows the preview route before relying on it
  // (a worker cached from an older release doesn't). Its periodic 'keepalive' messages
  // need no handling: receiving any message keeps the worker running.
  if (msg && msg.type === 'preview-ping' && event.ports[0]) {
    event.ports[0].postMessage({ type: 'preview-pong' });
    return;
  }
  if (!msg || msg.type !== 'register') return;

  const { id, name, size, mime, port } = msg;
  if (!id || !port) return;

  let controller;
  const stream = new ReadableStream({
    start(c) { controller = c; },
    cancel() {
      // User cancelled the download in the browser UI.
      try { port.postMessage({ type: 'cancel' }); } catch {}
      transfers.delete(id);
    },
  });

  port.onmessage = (ev) => {
    const data = ev.data;
    if (data instanceof ArrayBuffer) {
      controller.enqueue(new Uint8Array(data));
      return;
    }
    if (ArrayBuffer.isView(data)) {
      controller.enqueue(data);
      return;
    }
    if (data && data.type === 'end') {
      try { controller.close(); } catch {}
      return;
    }
    if (data && data.type === 'abort') {
      try { controller.error(new Error(data.reason || 'aborted')); } catch {}
      transfers.delete(id);
    }
  };

  transfers.set(id, { name, size, mime: mime || 'application/octet-stream', stream, createdAt: Date.now() });

  // Tell the page we're ready to receive bytes.
  port.postMessage({ type: 'ready' });
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const preview = url.origin === self.location.origin && url.pathname.match(PREVIEW_RE);
  if (preview) {
    event.respondWith(servePreview(event.request, preview[1]));
    return;
  }

  const match = url.pathname.match(/^\/__download\/([A-Za-z0-9._-]+)$/);
  if (!match) return;

  const id = match[1];
  const entry = transfers.get(id);
  if (!entry || entry.served) {
    event.respondWith(new Response('Transfer not found or expired.', { status: 404 }));
    return;
  }
  entry.served = true;

  const headers = new Headers({
    'Content-Type': entry.mime,
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(entry.name)}`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  if (Number.isFinite(entry.size) && entry.size > 0) {
    headers.set('Content-Length', String(entry.size));
  }

  event.respondWith(new Response(entry.stream, { headers }));
});

// ---- Streaming previews ---------------------------------------------------------------
//
// `/__preview/{id}` serves a file another peer is sharing, read on demand over a WebRTC
// preview session that the page holds (js/modules/viewer.js). The worker keeps no state:
// per request it asks the window clients which one owns `id`, each over its own
// MessagePort, then streams the requested range from that page one chunk per pull, as
// fast as the browser consumes the body. Honoring Range is what lets <video> start at
// once and seek.
//
// Port messages, worker -> page: {type:'open', start, end}, {type:'pull'}, {type:'cancel'}
//                page -> worker: {ok, size, mime, name} (lookup reply), then
//                                {type:'chunk', buf} | {type:'done'} | {type:'error', reason}

// /__preview/{id}, optionally followed by /{file name} for the browser's viewer UI.
const PREVIEW_RE = /^\/__preview\/([A-Za-z0-9_-]{1,64})(?:\/[^/]*)?$/;
const PREVIEW_LOOKUP_TIMEOUT_MS = 3000;

async function servePreview(request, id) {
  if (request.method !== 'GET') return new Response(null, { status: 405 });
  const owner = await findPreviewOwner(id);
  if (!owner) return new Response('Preview not found or expired.', { status: 404 });
  const { port, size, mime, name } = owner;

  const range = parseRange(request.headers.get('range'), size);
  if (range === null) {
    port.close();
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  }
  const { start, end } = range || { start: 0, end: size };  // end is exclusive
  const headers = new Headers({
    'Content-Type': mime,
    'Content-Length': String(end - start),
    'Accept-Ranges': 'bytes',
    'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(name)}`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Cross-Origin-Resource-Policy': 'same-origin',
  });
  if (range) headers.set('Content-Range', `bytes ${start}-${end - 1}/${size}`);
  const status = range ? 206 : 200;
  if (start === end) {
    port.close();
    return new Response(null, { status, headers });
  }

  let pending = null;   // the pull waiting for the page's next message
  let failure = null;
  port.onmessage = (ev) => {
    const msg = ev.data || {};
    if (msg.type === 'error') failure = new Error(msg.reason || 'preview failed');
    const p = pending;
    pending = null;
    if (!p) return;
    if (msg.type === 'chunk' && msg.buf instanceof ArrayBuffer) {
      p.controller.enqueue(new Uint8Array(msg.buf));
    } else if (msg.type === 'done') {
      p.controller.close();
      port.close();
    } else {
      p.controller.error(failure || new Error('preview failed'));
      port.close();
    }
    p.resolve();
  };
  port.postMessage({ type: 'open', start, end });

  const body = new ReadableStream({
    pull(controller) {
      if (failure) { controller.error(failure); return; }
      return new Promise((resolve) => {
        pending = { controller, resolve };
        port.postMessage({ type: 'pull' });
      });
    },
    cancel() {
      // The element moved on (seek, close): stop the reads behind this response.
      port.postMessage({ type: 'cancel' });
      port.close();
    },
  }, { highWaterMark: 4 });
  return new Response(body, { status, headers });
}

// Find the window that holds preview `id`. Every window is asked: a request can come from
// a frame (e.g. the PDF viewer) that isn't the owning page.
async function findPreviewOwner(id) {
  const clients = await self.clients.matchAll({ type: 'window' });
  const ports = [];
  const owner = await new Promise((resolve) => {
    let waiting = clients.length;
    if (!waiting) { resolve(null); return; }
    const timer = setTimeout(() => resolve(null), PREVIEW_LOOKUP_TIMEOUT_MS);
    for (const client of clients) {
      const channel = new MessageChannel();
      ports.push(channel.port1);
      channel.port1.onmessage = (ev) => {
        const reply = ev.data || {};
        if (reply.ok && Number.isSafeInteger(reply.size) && reply.size >= 0 && typeof reply.mime === 'string') {
          clearTimeout(timer);
          resolve({ port: channel.port1, size: reply.size, mime: reply.mime, name: String(reply.name || 'file') });
        } else if (--waiting === 0) {
          clearTimeout(timer);
          resolve(null);
        }
      };
      client.postMessage({ type: 'preview-lookup', id }, [channel.port2]);
    }
  });
  for (const port of ports) {
    if (!owner || port !== owner.port) port.close();
  }
  return owner;
}

// Single-range `Range: bytes=…` as { start, end } (end exclusive). undefined means serve
// the whole file (no header, or one we don't handle, like multiple ranges); null means
// the range can't be satisfied (416).
function parseRange(header, size) {
  if (!header) return undefined;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return undefined;
  if (m[1] === '') {
    // Suffix range: the last N bytes.
    const n = Number(m[2]);
    return n > 0 && size > 0 ? { start: Math.max(0, size - n), end: size } : null;
  }
  const start = Number(m[1]);
  if (m[2] !== '' && Number(m[2]) < start) return undefined;
  const end = m[2] === '' ? size : Math.min(Number(m[2]) + 1, size);
  return start < size ? { start, end } : null;
}

// Garbage-collect transfers that were never fetched, or whose download has long finished.
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of transfers) {
    if (now - entry.createdAt > 5 * 60_000) transfers.delete(id);
  }
}, KEEPALIVE_MS);
