import { sinkState } from './sink.js';

// File previews. Images, PDFs and text render inline; audio and video play in the
// browser's own player. The owner previews straight from the local file. Everyone
// else reads it from the owner over a preview session (webrtc/preview.js), in one of
// two ways:
//
//   - Service Worker (HTTPS or localhost): the element loads /__preview/{id} and sw.js
//     turns its Range requests into reads over the session. Playback starts at once and
//     seeking fetches only the bytes it needs, whatever the file size.
//   - In memory (plain HTTP, or the page isn't controlled by the worker): the file is
//     read whole into a Blob first, up to MEMORY_LIMIT.

const TEXT_LIMIT = 1024 * 1024;
const MEMORY_LIMIT = 256 * 1024 * 1024;
const SW_PING_TIMEOUT_MS = 1500;
// Browsers stop an idle Service Worker after ~30s, even mid-stream. Any message
// from the page resets that clock.
const SW_KEEPALIVE_MS = 10_000;

// ---- Formats ---------------------------------------------------------------------------

const IMAGE = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', png: 'image/png', apng: 'image/apng',
  gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon',
  svg: 'image/svg+xml', heic: 'image/heic', heif: 'image/heif',
};
// .mov and .mkv are announced as their closest web container: some browsers refuse a
// media type they don't list, yet play H.264 .mov as MP4 and VP9/AV1 .mkv as WebM.
const VIDEO = {
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/mp4', webm: 'video/webm', mkv: 'video/webm',
  ogv: 'video/ogg',
};
const AUDIO = {
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', flac: 'audio/flac',
  ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', weba: 'audio/webm',
};
const TEXT = new Set([
  'txt', 'text', 'md', 'markdown', 'csv', 'tsv', 'log', 'json', 'jsonl', 'xml', 'yaml', 'yml',
  'toml', 'ini', 'cfg', 'conf', 'env', 'properties', 'sql', 'html', 'htm', 'css', 'scss', 'sass',
  'less', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'vue', 'svelte', 'py', 'rb', 'php', 'java',
  'kt', 'kts', 'go', 'rs', 'swift', 'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'cs', 'scala', 'lua',
  'pl', 'r', 'dart', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd', 'gradle', 'srt', 'vtt',
  'gitignore', 'gitattributes', 'editorconfig',
]);
const TEXT_NAMES = new Set(['dockerfile', 'makefile', 'readme', 'license', 'changelog']);

// { kind, mime } for a previewable file name, or null. Only these fixed media types
// are ever handed to the browser: a sender can't get a file rendered as HTML (or SVG
// as a document) by naming it cleverly.
export function previewFormat(name) {
  const lower = String(name || '').toLowerCase();
  const dot = lower.lastIndexOf('.');
  const ext = dot >= 0 ? lower.slice(dot + 1) : '';
  if (Object.hasOwn(IMAGE, ext)) return { kind: 'image', mime: IMAGE[ext] };
  if (Object.hasOwn(VIDEO, ext)) return { kind: 'video', mime: VIDEO[ext] };
  if (Object.hasOwn(AUDIO, ext)) return { kind: 'audio', mime: AUDIO[ext] };
  if (ext === 'pdf') return { kind: 'pdf', mime: 'application/pdf' };
  if (TEXT.has(ext) || TEXT_NAMES.has(lower)) return { kind: 'text', mime: 'text/plain' };
  return null;
}

// ---- Messages --------------------------------------------------------------------------

const MESSAGES = {
  busy: 'The sender is busy with other previews. Try again in a moment.',
  removed: 'This file is no longer shared.',
  unavailable: 'The sender is no longer connected.',
  timeout: 'Could not connect to the sender.',
  'connection-lost': 'The connection to the sender was lost.',
  unsupported: 'Your browser can\'t preview this file. Download it to open it.',
  'not-text': 'This file doesn\'t look like text. Download it to open it.',
  'too-large': 'This file is too large to preview on this connection. Download it instead.',
};
const NOT_RETRYABLE = new Set(['removed', 'unavailable', 'unsupported', 'not-text', 'too-large']);

function errorMessage(s, reason) {
  if (s.local && reason === 'unsupported') return 'Your browser can\'t preview this file.';
  if (reason === 'too-large' && !window.isSecureContext) {
    return `${MESSAGES['too-large']} Serving FileSync over HTTPS lets large files stream instead.`;
  }
  return Object.hasOwn(MESSAGES, reason) ? MESSAGES[reason] : 'Something went wrong while loading the preview.';
}

// ---- Modal -----------------------------------------------------------------------------

let current = null;    // the open preview session
let els = null;

function ui() {
  if (els) return els;
  const $ = (id) => document.getElementById(id);
  els = {
    modal: $('preview-modal'),
    name: $('preview-modal-name'),
    meta: $('preview-modal-meta'),
    status: $('preview-modal-status'),
    statusText: $('preview-modal-status-text'),
    error: $('preview-modal-error'),
    errorText: $('preview-modal-error-text'),
    retry: $('preview-modal-retry'),
    stage: $('preview-modal-stage'),
    note: $('preview-modal-note'),
    download: $('preview-modal-download'),
  };
  els.modal.addEventListener('hidden.bs.modal', () => {
    if (!current) return;
    current.attempt++;
    release(current);
    current = null;
  });
  els.retry.addEventListener('click', () => { if (current) load(current); });
  els.download.addEventListener('click', () => {
    const s = current;
    if (!s || !s.onDownload) return;
    bootstrap.Modal.getOrCreateInstance(els.modal).hide();
    // Synchronous, so the click still counts as the gesture the save picker needs.
    s.onDownload();
  });
  return els;
}

// Open the preview modal for one file.
//   file        { id, name, size, owner }   owner is the label shown as "Shared by"
//   format      from previewFormat()
//   local       the owner's own File/Blob, or null
//   connect     () => { source: RemoteSource, opened: Promise } — remote files only
//   onDownload  starts a regular download, or null to hide the button
export function openPreview({ file, format, local = null, connect = null, onDownload = null }) {
  const e = ui();
  if (current) { current.attempt++; release(current); }
  const s = { file, format, local, connect, onDownload, attempt: 0, failed: false, source: null, urls: [], streamId: null, keepalive: null };
  current = s;
  e.name.textContent = file.name;
  e.meta.textContent = `${formatBytes(file.size)} · Shared by ${file.owner}`;
  e.download.style.display = onDownload ? '' : 'none';
  bootstrap.Modal.getOrCreateInstance(e.modal).show();
  load(s);
}

// The file went away (removed, or its owner left). Stop a preview still reading it, and
// replace a vaguer error it already hit — the session often drops a moment before the
// room tells us why. A preview that already has all its bytes stays up.
export function previewFileGone(fileId, reason) {
  const s = current;
  if (!s || s.local || s.file.id !== fileId) return;
  s.onDownload = null;
  ui().download.style.display = 'none';
  if (s.failed || (s.source && !s.source.closed)) showError(s, reason);
}

async function load(s) {
  release(s);
  s.failed = false;
  const attempt = ++s.attempt;
  const live = () => current === s && s.attempt === attempt;
  const { file, format } = s;
  const e = ui();
  e.error.style.display = 'none';
  e.note.style.display = 'none';
  setStatus(s.local ? 'Loading…' : `Connecting to ${file.owner}…`);

  try {
    if (s.local) {
      if (format.kind === 'text') {
        const bytes = new Uint8Array(await s.local.slice(0, Math.min(file.size, TEXT_LIMIT)).arrayBuffer());
        if (live()) showText(s, bytes);
      } else {
        // Re-typed slice: the element sees our media type, not whatever the OS guessed.
        showMedia(s, blobUrl(s, s.local.slice(0, file.size, format.mime)), live);
      }
      return;
    }

    const streaming = format.kind !== 'text' && await canStream();
    if (!live()) return;
    if (format.kind !== 'text' && !streaming && file.size > MEMORY_LIMIT) {
      showError(s, 'too-large');
      return;
    }

    const { source, opened } = s.connect();
    s.source = source;
    source.onClose = (err) => { if (live()) showError(s, err.reason); };
    await opened;
    if (!live()) return;
    setStatus('Loading…');

    if (format.kind === 'text') {
      const bytes = await source.read(0, Math.min(file.size, TEXT_LIMIT));
      if (!live()) return;
      closeSource(s);
      showText(s, bytes);
      return;
    }
    if (streaming) {
      showMedia(s, streamUrl(s, source), live);
      return;
    }
    const blob = await readToBlob(source, format.mime, (received) => {
      if (live()) setStatus(`Loading… ${file.size ? Math.floor(received / file.size * 100) : 100}%`);
    });
    if (!live()) return;
    closeSource(s);
    showMedia(s, blobUrl(s, blob), live);
  } catch (err) {
    if (live()) showError(s, err && err.reason);
  }
}

function showMedia(s, url, live) {
  const { kind } = s.format;
  const stage = ui().stage;
  // The element loads while collapsed, and appears in one piece once it can render.
  const ready = () => {
    if (!live()) return;
    ui().status.style.display = 'none';
    stage.classList.remove('preview-loading');
  };
  let el, view;
  if (kind === 'image') {
    el = view = document.createElement('img');
    el.className = 'preview-image';
    el.alt = s.file.name;
    el.decoding = 'async';
    el.addEventListener('load', ready);
    el.addEventListener('error', () => { if (live()) showError(s, 'unsupported'); });
  } else if (kind === 'video' || kind === 'audio') {
    el = document.createElement(kind);
    el.className = `preview-${kind}`;
    el.controls = true;
    el.autoplay = true;
    el.playsInline = true;
    el.preload = 'metadata';
    el.addEventListener('loadedmetadata', ready);
    el.addEventListener('error', () => {
      if (!live()) return;
      // A network error is the stream dying; anything else is the browser refusing
      // the format or failing to decode it.
      const network = el.error && el.error.code === 2;
      showError(s, network ? 'connection-lost' : 'unsupported');
    });
    view = el;
    if (kind === 'audio') {
      view = document.createElement('div');
      view.className = 'preview-audio-wrap';
      view.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="56" height="56" fill="currentColor" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 13c0 1.105-1.12 2-2.5 2S1 14.105 1 13s1.12-2 2.5-2 2.5.896 2.5 2m9-2c0 1.105-1.12 2-2.5 2s-2.5-.895-2.5-2 1.12-2 2.5-2 2.5.895 2.5 2"/><path fill-rule="evenodd" d="M14 11V2h1v9zM6 3v10H5V3z"/><path d="M5 2.905a1 1 0 0 1 .9-.995l8-.8a1 1 0 0 1 1.1.995V3L5 4z"/></svg>';
      view.appendChild(el);
    }
  } else {
    el = view = document.createElement('iframe');
    el.className = 'preview-pdf';
    el.title = s.file.name;
    el.addEventListener('load', ready);
  }
  el.src = url;
  stage.classList.add('preview-loading');
  stage.replaceChildren(view);
}

function showText(s, bytes) {
  let encoding = 'utf-8';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'utf-16le';
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'utf-16be';
  else if (bytes.subarray(0, 8192).includes(0)) return showError(s, 'not-text');

  const truncated = s.file.size > bytes.byteLength;
  const pre = document.createElement('pre');
  pre.className = 'preview-text';
  // stream:true holds back a multi-byte character cut in half at the limit.
  pre.textContent = new TextDecoder(encoding).decode(bytes, { stream: truncated });
  const e = ui();
  e.stage.replaceChildren(pre);
  e.status.style.display = 'none';
  if (truncated) {
    e.note.textContent = `Showing the first ${formatBytes(bytes.byteLength)} of ${formatBytes(s.file.size)}.`;
    e.note.style.display = '';
  }
}

function showError(s, reason) {
  s.attempt++;  // This attempt is over — ignore its late events.
  s.failed = true;
  release(s);
  const e = ui();
  e.status.style.display = 'none';
  e.errorText.textContent = errorMessage(s, reason);
  e.retry.style.display = NOT_RETRYABLE.has(reason) ? 'none' : '';
  e.error.style.display = '';
}

function setStatus(text) {
  const e = ui();
  e.statusText.textContent = text;
  e.status.style.display = '';
}

// Drop everything the current attempt holds: element, stream, object URLs, session.
function release(s) {
  clearInterval(s.keepalive);
  s.keepalive = null;
  if (s.streamId) { streams.delete(s.streamId); s.streamId = null; }
  const stage = ui().stage;
  for (const media of stage.querySelectorAll('video, audio')) {
    // Detaching alone leaves the element fetching; clearing src stops it.
    media.pause();
    media.removeAttribute('src');
    media.load();
  }
  stage.replaceChildren();
  stage.classList.remove('preview-loading');
  for (const url of s.urls) URL.revokeObjectURL(url);
  s.urls = [];
  closeSource(s);
}

function closeSource(s) {
  if (!s.source) return;
  s.source.onClose = null;
  s.source.close();
  s.source = null;
}

function blobUrl(s, blob) {
  const url = URL.createObjectURL(blob);
  s.urls.push(url);
  return url;
}

async function readToBlob(source, mime, onProgress) {
  const parts = [];
  let received = 0;
  const reader = source.stream().getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return new Blob(parts, { type: mime });
    parts.push(value);
    received += value.byteLength;
    onProgress(received);
  }
}

// ---- Service Worker streaming ----------------------------------------------------------
//
// Page side of the /__preview/{id} bridge (see sw.js). For each request the worker asks
// every window for the id over a fresh MessagePort; the owning page answers with the
// size and type, then serves the requested range one chunk per 'pull'. The worker holds
// no state of its own, so a worker restart between requests loses nothing.

const streams = new Map();   // id -> { source, mime, name }
let bridged = false;

async function canStream() {
  // The dev override ?sink=blob forces the in-memory path, so it can be exercised too.
  if (sinkState.forced === 'blob') return false;
  const controller = navigator.serviceWorker && navigator.serviceWorker.controller;
  if (!controller) return false;
  installBridge();
  // An older worker (cached from a previous release) has no preview route — ask first.
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => { channel.port1.close(); resolve(false); }, SW_PING_TIMEOUT_MS);
    channel.port1.onmessage = (ev) => {
      clearTimeout(timer);
      channel.port1.close();
      resolve(!!ev.data && ev.data.type === 'preview-pong');
    };
    try {
      controller.postMessage({ type: 'preview-ping' }, [channel.port2]);
    } catch {
      clearTimeout(timer);
      resolve(false);
    }
  });
}

function installBridge() {
  if (bridged) return;
  bridged = true;
  navigator.serviceWorker.addEventListener('message', (event) => {
    const msg = event.data;
    const port = event.ports && event.ports[0];
    if (!port || !msg || msg.type !== 'preview-lookup') return;
    serveStream(port, typeof msg.id === 'string' ? streams.get(msg.id) : undefined);
  });
  navigator.serviceWorker.startMessages();
}

function streamUrl(s, source) {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const id = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  streams.set(id, { source, mime: s.format.mime, name: s.file.name });
  s.streamId = id;
  s.keepalive = setInterval(() => {
    try { navigator.serviceWorker.controller?.postMessage({ type: 'keepalive' }); } catch {}
  }, SW_KEEPALIVE_MS);
  // The trailing name is cosmetic: it's what the browser's PDF viewer shows as the title.
  return `/__preview/${id}/${encodeURIComponent(s.file.name)}`;
}

function serveStream(port, entry) {
  if (!entry || entry.source.closed) {
    port.postMessage({ ok: false });
    port.close();
    return;
  }
  const { source, mime, name } = entry;
  port.postMessage({ ok: true, size: source.size, mime, name });
  let reader = null;
  const finish = (msg) => {
    port.postMessage(msg);
    port.close();
    reader = null;
  };
  port.onmessage = async (ev) => {
    const msg = ev.data || {};
    if (msg.type === 'open') {
      const { start, end } = msg;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || end > source.size) {
        return finish({ type: 'error', reason: 'invalid-range' });
      }
      reader = source.stream(start, end).getReader();
    } else if (msg.type === 'pull' && reader) {
      try {
        const { value, done } = await reader.read();
        if (done) return finish({ type: 'done' });
        const whole = value.byteOffset === 0 && value.byteLength === value.buffer.byteLength;
        const buf = whole ? value.buffer : value.slice().buffer;
        port.postMessage({ type: 'chunk', buf }, [buf]);
      } catch (err) {
        finish({ type: 'error', reason: (err && err.reason) || 'failed' });
      }
    } else if (msg.type === 'cancel') {
      if (reader) reader.cancel().catch(() => {});
      reader = null;
      port.close();
    }
  };
}

// ---- Helpers ---------------------------------------------------------------------------

function formatBytes(bytes) {
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB', 'PB'];
  if (!bytes) return '0 bytes';
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / Math.pow(1024, exponent)).toFixed(2)} ${units[exponent]}`;
}
