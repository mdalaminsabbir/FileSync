// Service Worker preview-route tests.
//
// Loads the REAL web/sw.js with a fake `self`, sends it fetch events for
// /__preview/{id}, and answers its MessagePort protocol with a fake owning page. Media
// elements are picky about range responses, so this pins the HTTP contract:
//
//   1. No Range: 200 with the whole file. Range: 206 with the exact bytes and a
//      correct Content-Range — open-ended, bounded and suffix forms.
//   2. Unsatisfiable ranges get 416; unknown ids 404; non-GET 405.
//   3. Responses carry a fixed type, nosniff and same-origin framing/embedding.
//   4. Dropping the response body (a seek) cancels the page-side read.
//   5. The ping the page uses to detect a preview-capable worker is answered, and
//      cross-origin URLs are never intercepted.
//
// Run: npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const ORIGIN = 'https://filesync.test';
const handlers = {};
let windows = [];
const fakeSelf = {
  location: { origin: ORIGIN },
  addEventListener: (type, fn) => { handlers[type] = fn; },
  skipWaiting() {},
  clients: { claim: async () => {}, matchAll: async () => windows },
};
const swSource = await readFile(new URL('../../web/sw.js', import.meta.url), 'utf8');
// Classic worker script: run it with our `self`, and a no-op GC timer.
new Function('self', 'setInterval', swSource)(fakeSelf, () => 0);

// A window that owns preview `id` and serves it the way viewer.js does.
function owningPage(bytes, { id = 'clip-1', mime = 'video/mp4', name = 'clip.mp4' } = {}) {
  const log = [];
  return {
    log,
    postMessage(msg, transfer) {
      const port = transfer[0];
      if (msg.type !== 'preview-lookup') return;
      if (msg.id !== id) { port.postMessage({ ok: false }); return; }
      port.postMessage({ ok: true, size: bytes.length, mime, name });
      let cursor = 0;
      let end = 0;
      port.onmessage = (ev) => {
        const m = ev.data;
        log.push(m.type === 'open' ? `open ${m.start}-${m.end}` : m.type);
        if (m.type === 'open') { cursor = m.start; end = m.end; }
        if (m.type === 'pull') {
          if (cursor >= end) { port.postMessage({ type: 'done' }); return; }
          const stop = Math.min(cursor + 1000, end);
          const buf = bytes.slice(cursor, stop).buffer;
          cursor = stop;
          port.postMessage({ type: 'chunk', buf }, [buf]);
        }
        if (m.type === 'cancel') port.close();
      };
    },
  };
}

// A window that isn't FileSync (e.g. the PDF viewer frame): never answers.
const silentFrame = { postMessage() {} };

async function fetchPreview(path, { range, method = 'GET', origin = ORIGIN } = {}) {
  let responded = null;
  handlers.fetch({
    request: { url: `${origin}${path}`, method, headers: new Headers(range ? { range } : {}) },
    respondWith(p) { responded = p; },
  });
  return responded === null ? null : await responded;
}

const bytes = new Uint8Array(5000).map((_, i) => (i * 7) & 0xff);

test('no Range: 200 with the whole file and safe headers', async () => {
  windows = [silentFrame, owningPage(bytes)];
  const res = await fetchPreview('/__preview/clip-1');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'video/mp4');
  assert.equal(res.headers.get('content-length'), '5000');
  assert.equal(res.headers.get('accept-ranges'), 'bytes');
  assert.equal(res.headers.get('content-range'), null);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal(res.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.match(res.headers.get('content-disposition'), /^inline; filename\*=UTF-8''clip\.mp4$/);
  assert.ok(Buffer.from(await res.arrayBuffer()).equals(Buffer.from(bytes)));
});

test('Range forms: probe, open-ended, bounded, suffix', async () => {
  const cases = [
    ['bytes=0-1', 0, 2],               // Safari's first probe
    ['bytes=2500-', 2500, 5000],       // Chrome/Firefox seek
    ['bytes=100-2099', 100, 2100],
    ['bytes=4990-99999', 4990, 5000],  // clamped to the end
    ['bytes=-300', 4700, 5000],        // last 300 bytes (MP4 moov at the end)
  ];
  for (const [range, start, end] of cases) {
    windows = [owningPage(bytes)];
    const res = await fetchPreview('/__preview/clip-1', { range });
    assert.equal(res.status, 206, range);
    assert.equal(res.headers.get('content-range'), `bytes ${start}-${end - 1}/5000`, range);
    assert.equal(res.headers.get('content-length'), String(end - start), range);
    const body = Buffer.from(await res.arrayBuffer());
    assert.ok(body.equals(Buffer.from(bytes.subarray(start, end))), `${range}: body differs`);
  }
});

test('unsatisfiable, unknown, non-GET and multi-range requests', async () => {
  windows = [owningPage(bytes)];
  let res = await fetchPreview('/__preview/clip-1', { range: 'bytes=5000-' });
  assert.equal(res.status, 416);
  assert.equal(res.headers.get('content-range'), 'bytes */5000');

  windows = [owningPage(bytes)];
  res = await fetchPreview('/__preview/other-id');
  assert.equal(res.status, 404);

  res = await fetchPreview('/__preview/clip-1', { method: 'POST' });
  assert.equal(res.status, 405);

  // A trailing file name (shown by the PDF viewer) doesn't change what is served.
  windows = [owningPage(bytes)];
  res = await fetchPreview('/__preview/clip-1/My%20Clip.mp4', { range: 'bytes=0-9' });
  assert.equal(res.status, 206);
  assert.equal((await res.arrayBuffer()).byteLength, 10);
  assert.equal(await fetchPreview('/__preview/clip-1/a/b'), null, 'deeper paths are not previews');

  // Multiple ranges aren't supported: serve the whole file instead (allowed by RFC 9110).
  windows = [owningPage(bytes)];
  res = await fetchPreview('/__preview/clip-1', { range: 'bytes=0-10,20-30' });
  assert.equal(res.status, 200);
  assert.equal((await res.arrayBuffer()).byteLength, 5000);
});

test('dropping the body cancels the read in the page', async () => {
  const page = owningPage(bytes);
  windows = [page];
  const res = await fetchPreview('/__preview/clip-1', { range: 'bytes=0-' });
  const reader = res.body.getReader();
  await reader.read();
  await reader.cancel();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(page.log[0], 'open 0-5000');
  assert.equal(page.log.at(-1), 'cancel');
  assert.ok(page.log.filter((t) => t === 'pull').length < 10, 'stopped pulling long before the end');
});

test('answers the capability ping and ignores other origins', async () => {
  const { port1, port2 } = new MessageChannel();
  const pong = new Promise((resolve) => { port1.onmessage = (ev) => resolve(ev.data); });
  handlers.message({ data: { type: 'preview-ping' }, ports: [port2] });
  assert.deepEqual(await pong, { type: 'preview-pong' });
  port1.close();

  windows = [owningPage(bytes)];
  assert.equal(await fetchPreview('/__preview/clip-1', { origin: 'https://elsewhere.test' }), null);
});
