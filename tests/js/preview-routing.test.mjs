// Preview request routing tests.
//
// Imports the REAL User class and drives the room-level preview messages over in-memory
// room connections (host H, guests A and B, B owns the file), with the owner's
// PreviewServer.start stubbed out — the session protocol itself is covered by
// preview-protocol.test.mjs. Proves:
//
//   1. A guest's preview request reaches a guest owner through the host; a host's goes
//      straight to the owner. The owner starts exactly one session for it.
//   2. Refusals (owner at its cap, file removed, owner gone, session failed to start)
//      travel back to the requester and fail its pending preview with that reason.
//   3. A late refusal for an older session never fails the current one.
//   4. Removing a file, or the viewer leaving, ends the owner's sessions for it.
//   5. Only fixed, non-document media types are ever chosen for a file name.
//
// Run: npm test

import test from 'node:test';
import assert from 'node:assert/strict';

// ---------- browser environment stubs (must exist before app modules are imported) ----------
function makeDoc(key) {
  const elements = new Map();
  const makeEl = (id) => ({
    id, style: {}, textContent: '', innerHTML: '', value: '', disabled: false,
    addEventListener() {}, removeEventListener() {}, focus() {}, click() {}, remove() {},
    appendChild() {}, setAttribute() {}, removeAttribute() {},
    classList: { add() {}, remove() {}, toggle() {} },
  });
  return {
    elements,
    getElementById(id) { if (!elements.has(id)) elements.set(id, makeEl(id)); return elements.get(id); },
    createElement(tag) { return makeEl(`dyn-${tag}`); },
    body: makeEl(`${key}-body`),
    addEventListener() {},
  };
}
const mainDoc = makeDoc('main');
globalThis.document = mainDoc;
const _ss = new Map();
globalThis.sessionStorage = {
  getItem: (k) => (_ss.has(k) ? _ss.get(k) : null),
  setItem: (k, v) => _ss.set(k, String(v)),
  removeItem: (k) => _ss.delete(k),
  clear: () => _ss.clear(),
};
globalThis.window = globalThis;
globalThis.location = { search: '', href: 'http://localhost/', protocol: 'http:', origin: 'http://localhost', hostname: 'localhost', port: '', replace() {} };
globalThis.addEventListener = () => {};
globalThis.isSecureContext = false;
try { globalThis.navigator = { serviceWorker: undefined, clipboard: undefined }; }
catch { try { Object.defineProperty(globalThis, 'navigator', { value: { serviceWorker: undefined, clipboard: undefined }, configurable: true }); } catch {} }

// The viewer's per-session Peer registers with a (fake) signaling server.
let uuidSeq = 0;
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
globalThis.fetch = async (url) => {
  if (String(url).includes('/api/uuid')) {
    return { ok: true, json: async () => ({ uuid: `preview-peer-${++uuidSeq}` }) };
  }
  if (String(url).includes('/api/credentials')) {
    const token = `${b64u({ alg: 'none' })}.${b64u({ username: '1:u', credential: 'c', exp: Math.floor(Date.now() / 1000) + 300 })}.sig`;
    return { ok: true, json: async () => ({ token }) };
  }
  throw new Error(`unexpected fetch ${url}`);
};
class FakeWS {
  constructor() {
    this.readyState = 0;
    queueMicrotask(() => { this.readyState = 1; this.onopen?.(); });
  }
  send(json) {
    const msg = JSON.parse(json);
    if (msg.type === 'register') {
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ type: 'registered', id: msg.id }) }));
    }
  }
  close() { this.readyState = 3; }
}
FakeWS.OPEN = 1;
globalThis.WebSocket = FakeWS;
globalThis.RTCPeerConnection = class {};

const { User } = await import(new URL('../../web/js/modules/webrtc/user.js', import.meta.url).href);
const { File } = await import(new URL('../../web/js/modules/webrtc/file.js', import.meta.url).href);
const { PreviewServer } = await import(new URL('../../web/js/modules/webrtc/preview.js', import.meta.url).href);
const { previewFormat } = await import(new URL('../../web/js/modules/viewer.js', import.meta.url).href);

// The owner's side of the session is out of scope here: record starts instead.
let startBehavior = 'hang';
const started = [];
PreviewServer.prototype.start = async function () {
  started.push(this);
  if (startBehavior === 'fail') throw new Error('viewer unreachable');
};

// ---------- room factory (same topology as webrtc-file-cancel.test.mjs) ----------
const HOST = 'room-host-peer-000000000000000000000000000';
const A = 'guest-a-peer-0000000000000000000000000000000';
const B = 'guest-b-peer-0000000000000000000000000000000';
const FILE = 'file-abc123';

function makeRoom() {
  started.length = 0;
  startBehavior = 'hang';
  const hops = [];
  const users = {};
  for (const [key, id, isHost] of [['H', HOST, true], ['A', A, false], ['B', B, false]]) {
    const u = new User(isHost ? '' : HOST);
    u.__doc = makeDoc(key);
    u._peer = { id };
    u._files[FILE] = new File({ id: FILE, name: 'holiday.mp4', size: 4096, owner_id: B, owner_name: 'B', content: new Blob([new Uint8Array(4096)]) });
    users[key] = u;
  }
  function connectPair(u1, id1, u2, id2) {
    const deliver = (to, conn, m) => queueMicrotask(() => {
      globalThis.document = to.__doc;
      to._handleData(conn, m);
      globalThis.document = mainDoc;
    });
    const c1 = { peer: id2, open: true, close() {}, send(m) { hops.push({ from: id1, to: id2, msg: m }); deliver(u2, c2, m); } };
    const c2 = { peer: id1, open: true, close() {}, send(m) { hops.push({ from: id2, to: id1, msg: m }); deliver(u1, c1, m); } };
    return [c1, c2];
  }
  const [cH_A, cA_H] = connectPair(users.H, HOST, users.A, A);
  const [cH_B, cB_H] = connectPair(users.H, HOST, users.B, B);
  users.H._remotePeers[A] = { name: 'A', conn: cH_A, interval: null };
  users.H._remotePeers[B] = { name: 'B', conn: cH_B, interval: null };
  users.A._remotePeers[HOST] = { name: 'Host', conn: cA_H, interval: null };
  users.B._remotePeers[HOST] = { name: 'Host', conn: cB_H, interval: null };
  return { users, hops };
}

const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const previewHops = (hops, key) => hops.filter((h) => key in h.msg).map((h) => `${h.from.slice(0, 7)}->${h.to.slice(0, 7)}`);

// Start a preview from `user` and return its session plus how `opened` settled.
function startPreview(user) {
  const { source, opened } = user._connectPreview(user._files[FILE]);
  const outcome = { reason: null };
  opened.then(() => { outcome.reason = 'opened'; }, (err) => { outcome.reason = err.reason; });
  return { source, outcome };
}

// ---------- scenarios ----------
test('guest request reaches a guest owner through the host', async () => {
  const { users, hops } = makeRoom();
  const { source } = startPreview(users.A);
  await settle();

  assert.deepEqual(previewHops(hops, 'webrtc-file-preview'), ['guest-a->room-ho', 'room-ho->guest-b']);
  const request = hops.at(-1).msg['webrtc-file-preview'];
  assert.deepEqual(request, { file_id: FILE, requester_id: A, peer_id: source.peerId });
  assert.equal(started.length, 1, 'owner starts one session');
  assert.equal(started[0].requesterId, A);
  assert.equal(users.B._previewServers.size, 1);
  source.close();
});

test('host request goes straight to the owner', async () => {
  const { users, hops } = makeRoom();
  const { source } = startPreview(users.H);
  await settle();
  assert.deepEqual(previewHops(hops, 'webrtc-file-preview'), ['room-ho->guest-b']);
  assert.equal(started.length, 1);
  source.close();
});

test('owner at its cap refuses with busy, relayed back to the requester', async () => {
  const { users, hops } = makeRoom();
  for (let i = 0; i < 8; i++) users.B._previewServers.add({ requesterId: 'x', fileId: 'y' });
  const { source, outcome } = startPreview(users.A);
  await settle();

  assert.equal(started.length, 0);
  assert.deepEqual(previewHops(hops, 'webrtc-file-preview-cancel'), ['guest-b->room-ho', 'room-ho->guest-a']);
  assert.equal(outcome.reason, 'busy');
  assert.equal(source.closed, true);
});

test('removed file, missing owner and failed start each come back with their reason', async () => {
  let room = makeRoom();
  room.users.H._files[FILE].removed = true;
  let preview = startPreview(room.users.A);
  await settle();
  assert.equal(preview.outcome.reason, 'removed');

  room = makeRoom();
  delete room.users.H._remotePeers[B];  // owner left the room
  preview = startPreview(room.users.A);
  await settle();
  assert.equal(preview.outcome.reason, 'unavailable');

  room = makeRoom();
  startBehavior = 'fail';
  preview = startPreview(room.users.A);
  await settle();
  assert.equal(preview.outcome.reason, 'failed');
  assert.equal(room.users.B._previewServers.size, 0, 'failed session is not kept');
});

test('a late refusal for an older session leaves the current one alone', async () => {
  const { users } = makeRoom();
  const { source, outcome } = startPreview(users.A);
  await settle();
  users.A._onFilePreviewCancel({ file_id: FILE, requester_id: A, peer_id: 'some-older-peer-id', reason: 'busy' });
  await settle();
  assert.equal(outcome.reason, null, 'still waiting for the owner');
  assert.equal(source.closed, false);

  // A reason from the wire outside the known set is reported as a plain failure.
  users.A._onFilePreviewCancel({ file_id: FILE, requester_id: A, peer_id: source.peerId, reason: '__proto__' });
  await settle();
  assert.equal(outcome.reason, 'failed');
});

test('removing the file or losing the viewer ends owner sessions', async () => {
  const { users } = makeRoom();
  const ended = [];
  const fake = (fileId, requesterId) => ({
    fileId, requesterId,
    fail(reason) { ended.push(`${requesterId}:fail:${reason}`); },
    close() { ended.push(`${requesterId}:close`); },
  });
  users.B._previewServers.add(fake(FILE, A));
  users.B._previewServers.add(fake('file-other', HOST));
  users.B._remotePeers = Object.create(null);  // no one to notify; only local effects matter
  globalThis.document = users.B.__doc;
  users.B.removeFile(FILE);
  users.B._closePreviewsFor(HOST);
  globalThis.document = mainDoc;
  assert.deepEqual(ended, [`${A}:fail:removed`, `${HOST}:close`]);
  assert.equal(users.B.__doc.getElementById(`file-${FILE}-preview`).style.display, 'none');
});

test('receivers hide the preview button when the file is removed', async () => {
  const { users } = makeRoom();
  globalThis.document = users.A.__doc;
  users.A._onFileRemove({ file_id: FILE, peer_id: B });
  globalThis.document = mainDoc;
  assert.equal(users.A.__doc.getElementById(`file-${FILE}-preview`).style.display, 'none');
});

test('file names map to fixed, non-document media types', () => {
  const cases = {
    'clip.MP4': ['video', 'video/mp4'],
    'phone.mov': ['video', 'video/mp4'],
    'song.mp3': ['audio', 'audio/mpeg'],
    'scan.pdf': ['pdf', 'application/pdf'],
    'logo.svg': ['image', 'image/svg+xml'],
    'page.html': ['text', 'text/plain'],     // shown as source, never rendered
    'notes.txt': ['text', 'text/plain'],
    'Dockerfile': ['text', 'text/plain'],
  };
  for (const [name, [kind, mime]] of Object.entries(cases)) {
    assert.deepEqual(previewFormat(name), { kind, mime }, name);
  }
  for (const name of ['archive.zip', 'setup.exe', 'noextension', 'constructor', '__proto__', 'x.toString']) {
    assert.equal(previewFormat(name), null, name);
  }
});
