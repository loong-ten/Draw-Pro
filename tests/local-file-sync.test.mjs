import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createCanvas, loadImage } = require(require.resolve('@napi-rs/canvas', {
  paths: [process.cwd(), process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES].filter(Boolean),
}));
let encodeGate = null, encodes = 0, activeWrites = 0, maxActiveWrites = 0;
function gate() {
  let release, entered;
  return {
    promise: new Promise(resolve => { release = resolve; }),
    entered: new Promise(resolve => { entered = resolve; }),
    release: () => release(), start: () => entered(),
  };
}
function nativeCanvas() {
  const canvas = createCanvas(1, 1);
  canvas.toBlob = (callback, mime = 'image/png') => {
    encodes++;
    const blob = new Blob([canvas.toBuffer(mime)], { type: mime });
    const hold = encodeGate; encodeGate = null;
    if (hold) { hold.start(); hold.promise.then(() => callback(blob)); }
    else queueMicrotask(() => callback(blob));
  };
  return canvas;
}
globalThis.document = {
  createElement(tag) { assert.equal(tag, 'canvas', 'background sync must never create a download link'); return nativeCanvas(); },
};
globalThis.window = {};
const { PaintDocument } = await import('../dist/core.js');
const { writeDocumentFile, saveDocument } = await import('../dist/io.js');
const { createLocalFileSync } = await import('../dist/local-file-sync.js');

function namedError(name, message = name) { const error = new Error(message); error.name = name; return error; }
class FakeFile {
  constructor(name) { this.kind = 'file'; this.name = name; this.permission = 'granted'; this.requests = 0; this.opens = 0; this.writes = []; this.aborts = 0; this.writeGate = null; this.fail = null; }
  async queryPermission() { return this.permission; }
  async requestPermission() { this.requests++; throw Error('background permission prompt is forbidden'); }
  async createWritable() {
    this.opens++; activeWrites++; maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
    const target = this; let blob = null, completed = false;
    const finish = () => { if (!completed) { completed = true; activeWrites--; } };
    return {
      async write(value) {
        blob = value;
        if (target.writeGate) { const hold = target.writeGate; target.writeGate = null; hold.start(); await hold.promise; }
        if (target.fail) throw target.fail;
      },
      async close() { target.writes.push(new Uint8Array(await blob.arrayBuffer())); finish(); },
      async abort() { target.aborts++; finish(); },
    };
  }
}
class FakeDirectory {
  constructor(name = 'work') { this.kind = 'directory'; this.name = name; this.permission = 'granted'; this.requests = 0; this.files = new Map(); this.paths = new Map(); this.permissionGate = null; this.calls = []; }
  async queryPermission() {
    if (this.permissionGate) { const hold = this.permissionGate; this.permissionGate = null; hold.start(); await hold.promise; }
    return this.permission;
  }
  async requestPermission() { this.requests++; throw Error('background permission prompt is forbidden'); }
  add(name, file = new FakeFile(name), path = [name]) { this.files.set(name, file); this.paths.set(file, path); return file; }
  async resolve(file) { return this.paths.get(file) || null; }
  async getFileHandle(name, { create = false } = {}) {
    this.calls.push({ name, create });
    await Promise.resolve();
    const found = this.files.get(name);
    if (found?.kind === 'directory') throw namedError('TypeMismatchError');
    if (found) return found;
    if (!create) throw namedError('NotFoundError');
    return this.add(name);
  }
}
function makeDoc(name = 'asset.png', color = '#ff0000') {
  const doc = new PaintDocument({ name, width: 3, height: 2, fill: color });
  const hidden = doc.addLayer('隐藏图层'); hidden.visible = false; hidden.locked = true; hidden.opacity = .4; hidden.blend = 'screen';
  hidden.canvas.getContext('2d').fillRect(0, 0, 1, 1);
  doc.activeLayerId = doc.layers[0].id; doc.resetHistory('初始内容'); doc.dirty = true; doc.revision = 1;
  return doc;
}
function edit(doc, color) {
  const ctx = doc.layers[0].canvas.getContext('2d'); ctx.fillStyle = color; ctx.fillRect(0, 0, doc.width, doc.height);
  doc.commit('新编辑');
}
async function pixel(bytes, x = 0, y = 0) {
  const image = await loadImage(Buffer.from(bytes)), canvas = createCanvas(image.width, image.height);
  canvas.getContext('2d').drawImage(image, 0, 0);
  return [...canvas.getContext('2d').getImageData(x, y, 1, 1).data];
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  const end = Date.now() + 1000;
  while (!predicate()) { if (Date.now() > end) throw Error('timed out waiting for sync state'); await wait(4); }
}
function harness(documents, directory, extra = {}) {
  const state = { docs: documents, directory, enabled: true, ready: true }, statuses = [];
  const sync = createLocalFileSync({
    getDocs: () => state.docs, getDirectory: () => state.directory, isEnabled: () => state.enabled,
    canWrite: () => state.ready, onStatus: value => statuses.push(value),
    delay: 15, retryDelay: 10, ...extra,
  });
  return { state, sync, statuses };
}

test('a granted in-directory handle is written without prompting, downloads, layer loss or history changes', async () => {
  const dir = new FakeDirectory(), file = dir.add('asset.png'), doc = makeDoc(); doc.fileHandle = file;
  const layers = doc.layers, canvases = doc.layers.map(l => l.canvas), history = doc.history;
  const result = await writeDocumentFile(doc, { directory: dir });
  assert.equal(result.method, 'file'); assert.equal(result.clean, true); assert.equal(doc.dirty, false);
  assert.equal(file.writes.length, 1); assert.deepEqual(await pixel(file.writes[0]), [255, 0, 0, 255]);
  assert.strictEqual(doc.layers, layers); assert.strictEqual(doc.history, history);
  doc.layers.forEach((l, i) => assert.strictEqual(l.canvas, canvases[i]));
  assert.equal(doc.layers[1].visible, false); assert.equal(doc.layers[1].locked, true); assert.equal(doc.layers[1].blend, 'screen');
  assert.equal(dir.requests, 0); assert.equal(file.requests, 0);
});

test('subdirectory handles stay bound, but an external source is never overwritten', async () => {
  const dir = new FakeDirectory(), child = dir.add('source.png', new FakeFile('source.png'), ['sprites', 'source.png']);
  const doc = makeDoc('source.png'); doc.fileHandle = child; doc.path = 'sprites/source.png';
  await writeDocumentFile(doc, { directory: dir }); assert.strictEqual(doc.fileHandle, child); assert.equal(doc.path, 'sprites/source.png');
  const external = new FakeFile('outside.png'), imported = makeDoc('outside.png'); imported.fileHandle = external; imported.path = '/elsewhere/outside.png';
  await writeDocumentFile(imported, { directory: dir });
  assert.equal(external.opens, 0); assert.notStrictEqual(imported.fileHandle, external);
  assert.equal(imported.fileHandle.writes.length, 1); assert.equal(imported.path, 'outside.png');
});

test('concurrent same-name creations reserve unique filenames and preserve existing files/folders', async () => {
  const dir = new FakeDirectory(), existing = dir.add('art.png');
  dir.files.set('art (1).png', { kind: 'directory' });
  const a = makeDoc('art.png'), b = makeDoc('art.png');
  await Promise.all([writeDocumentFile(a, { directory: dir }), writeDocumentFile(b, { directory: dir })]);
  assert.deepEqual(new Set([a.name, b.name]), new Set(['art (2).png', 'art (3).png']));
  assert.notStrictEqual(a.fileHandle, b.fileHandle); assert.equal(existing.opens, 0);
});

test('permission loss reports an error with dirty retained and never requests permission', async () => {
  const dir = new FakeDirectory(), doc = makeDoc(); dir.permission = 'prompt'; const beforeEncodes = encodes;
  await assert.rejects(writeDocumentFile(doc, { directory: dir }), error => error.code === 'PERMISSION_DENIED' && /重试同步/.test(error.message));
  assert.equal(doc.dirty, true); assert.equal(dir.files.size, 0); assert.equal(dir.requests, 0); assert.equal(encodes, beforeEncodes);
  const file = dir.add('asset.png'); doc.fileHandle = file; dir.permission = 'granted'; file.permission = 'denied';
  await assert.rejects(writeDocumentFile(doc, { directory: dir }), { code: 'PERMISSION_DENIED' });
  assert.equal(file.opens, 0); assert.equal(file.requests, 0); assert.equal(doc.dirty, true);
});

test('auto and manual file saves encode an immutable composite and cannot clear later edits', async () => {
  for (const write of [
    (doc, dir) => writeDocumentFile(doc, { directory: dir }),
    (doc, dir) => saveDocument(doc, { directory: dir }),
  ]) {
    const dir = new FakeDirectory(), file = dir.add('asset.png'), doc = makeDoc(); doc.fileHandle = file;
    const hold = gate(); encodeGate = hold;
    const saving = write(doc, dir); await hold.entered;
    edit(doc, '#00ff00'); hold.release(); await saving;
    assert.deepEqual(await pixel(file.writes[0]), [255, 0, 0, 255]);
    assert.equal(doc.dirty, true, 'old success cannot acknowledge the newer revision');
    assert.deepEqual([...doc.layers[0].canvas.getContext('2d').getImageData(0, 0, 1, 1).data], [0, 255, 0, 255]);
  }
});

test('unchanged revision but changed layer fingerprint does not clear dirty after manual save', async () => {
  const dir = new FakeDirectory(), file = dir.add('asset.png'), doc = makeDoc(); doc.fileHandle = file;
  const hold = gate(); encodeGate = hold; const saving = saveDocument(doc, { directory: dir }); await hold.entered;
  doc.layers[0].opacity = .25; hold.release(); await saving;
  assert.equal(doc.dirty, true); assert.equal(doc.layers[0].opacity, .25);
});

test('debounce coalesces repeated edits into the latest file revision', async () => {
  const dir = new FakeDirectory(), doc = makeDoc(), h = harness([doc], dir);
  try {
    h.sync.schedule(); edit(doc, '#00ff00'); h.sync.schedule(); edit(doc, '#0000ff'); h.sync.schedule();
    await until(() => !doc.dirty);
    assert.equal(doc.fileHandle.writes.length, 1); assert.deepEqual(await pixel(doc.fileHandle.writes[0]), [0, 0, 255, 255]);
    assert.equal(h.sync.getStatus().phase, 'synced'); assert.ok(h.sync.getStatus().lastSyncedAt);
  } finally { await h.sync.pause(); }
});

test('editing during a write queues a second latest snapshot, never overlaps a document write, and flush drains both', async () => {
  const dir = new FakeDirectory(), file = dir.add('asset.png'), doc = makeDoc(); doc.fileHandle = file;
  const hold = gate(); file.writeGate = hold; const h = harness([doc], dir); maxActiveWrites = 0;
  try {
    h.sync.schedule(); await hold.entered; edit(doc, '#00ff00'); h.sync.schedule();
    await wait(25); assert.equal(file.opens, 1); assert.equal(doc.dirty, true);
    hold.release(); await h.sync.flush();
    assert.equal(file.writes.length, 2); assert.equal(maxActiveWrites, 1);
    assert.deepEqual(await pixel(file.writes[0]), [255, 0, 0, 255]); assert.deepEqual(await pixel(file.writes[1]), [0, 255, 0, 255]);
    assert.equal(doc.dirty, false);
  } finally { hold.release(); await h.sync.pause(); }
});

test('multiple documents are globally serialized so composite/encoding and file writes cannot fan out', async () => {
  const dir = new FakeDirectory(), docs = [makeDoc('a.png'), makeDoc('b.png'), makeDoc('c.png')];
  const first = dir.add('a.png'); docs[0].fileHandle = first;
  const hold = gate(); first.writeGate = hold; const h = harness(docs, dir); maxActiveWrites = 0;
  try {
    const all = h.sync.flush(); await hold.entered; await wait(20);
    assert.equal(dir.files.has('b.png'), false); assert.equal(dir.files.has('c.png'), false); assert.equal(h.sync.getStatus().syncing, 1);
    hold.release(); await all;
    assert.equal(maxActiveWrites, 1); assert.ok(docs.every(d => !d.dirty && d.fileHandle.writes.length === 1));
  } finally { hold.release(); await h.sync.pause(); }
});

test('busy uncommitted gestures are skipped and automatically rechecked without another schedule call', async () => {
  const dir = new FakeDirectory(), doc = makeDoc(), h = harness([doc], dir); h.state.ready = false;
  try {
    h.sync.schedule(); await wait(35); assert.equal(dir.files.size, 0); assert.equal(h.sync.getStatus().phase, 'pending');
    const status = await h.sync.flush(); assert.equal(status.phase, 'pending'); assert.equal(dir.files.size, 0);
    h.state.ready = true; await until(() => !doc.dirty); assert.equal(doc.fileHandle.writes.length, 1);
  } finally { await h.sync.pause(); }
});

test('a gesture that starts during an async permission check is rechecked before any composite is captured', async () => {
  const dir = new FakeDirectory(), doc = makeDoc(), h = harness([doc], dir), hold = gate(); dir.permissionGate = hold;
  const beforeEncodes = encodes;
  try {
    const flushing = h.sync.flush(); await hold.entered; h.state.ready = false; hold.release(); await flushing;
    assert.equal(encodes, beforeEncodes); assert.equal(dir.files.size, 0); assert.equal(h.sync.getStatus().phase, 'pending');
    h.state.ready = true; await h.sync.flush(); assert.equal(doc.dirty, false);
  } finally { hold.release(); await h.sync.pause(); }
});

test('a gesture starting after capture may finish the valid old snapshot but cannot clear dirty', async () => {
  const dir = new FakeDirectory(), file = dir.add('asset.png'), doc = makeDoc(); doc.fileHandle = file;
  const h = harness([doc], dir), hold = gate(); file.writeGate = hold;
  try {
    const flushing = h.sync.flush(); await hold.entered; h.state.ready = false; hold.release(); await flushing;
    assert.equal(file.writes.length, 1); assert.equal(doc.dirty, true); assert.equal(h.sync.getStatus().phase, 'pending');
    edit(doc, '#0000ff'); h.state.ready = true; await h.sync.flush();
    assert.equal(file.writes.length, 2); assert.deepEqual(await pixel(file.writes[1]), [0, 0, 255, 255]); assert.equal(doc.dirty, false);
  } finally { hold.release(); await h.sync.pause(); }
});

test('write errors retain dirty, are not retried in a loop, and explicit flush retries the same revision', async () => {
  const dir = new FakeDirectory(), file = dir.add('asset.png'), doc = makeDoc(); doc.fileHandle = file; file.fail = namedError('NotAllowedError', 'injected write denial');
  const h = harness([doc], dir);
  try {
    let status = await h.sync.flush(); assert.equal(status.phase, 'error'); assert.match(status.error, /injected/);
    assert.equal(doc.dirty, true); assert.equal(file.aborts, 1); assert.equal(file.writes.length, 0);
    h.sync.schedule(); h.sync.schedule(); await wait(30); assert.equal(file.opens, 1);
    file.fail = null; status = await h.sync.flush(); assert.equal(status.phase, 'synced');
    assert.equal(file.opens, 2); assert.equal(file.writes.length, 1); assert.equal(doc.dirty, false);
  } finally { await h.sync.pause(); }
});

test('pause waits for the current write, binds newly created files once, and cancels only work not yet started', async () => {
  const dir = new FakeDirectory(), a = makeDoc('a.png'), b = makeDoc('b.png'), h = harness([a, b], dir);
  const original = dir.getFileHandle.bind(dir), hold = gate();
  dir.getFileHandle = async (...args) => { const file = await original(...args); if (args[0] === 'a.png' && args[1]?.create) file.writeGate = hold; return file; };
  try {
    h.sync.schedule(); await hold.entered;
    let finished = false; const pausing = h.sync.pause().then(() => { finished = true; });
    await wait(15); assert.equal(finished, false); assert.equal(h.sync.getStatus().phase, 'paused');
    hold.release(); await pausing; assert.equal(a.dirty, false); assert.ok(a.fileHandle); assert.equal(dir.files.has('b.png'), false); assert.equal(b.dirty, true);
    h.sync.resume(); await h.sync.flush(); assert.equal(dir.files.size, 2); assert.equal(b.dirty, false);
  } finally { hold.release(); await h.sync.pause(); }
});

test('directory/workspace replacement aborts an old task and never acknowledges a new document with the same id', async () => {
  const oldDir = new FakeDirectory('old'), newDir = new FakeDirectory('new'), oldDoc = makeDoc(), newDoc = makeDoc();
  newDoc.id = oldDoc.id;
  const file = oldDir.add('asset.png'); oldDoc.fileHandle = file;
  const hold = gate(); file.writeGate = hold; const h = harness([oldDoc], oldDir);
  try {
    h.sync.schedule(); await hold.entered;
    h.state.docs = [newDoc]; h.state.directory = newDir; h.state.enabled = false; h.sync.schedule();
    hold.release(); await until(() => file.aborts === 1);
    assert.equal(file.writes.length, 0); assert.equal(newDoc.dirty, true); assert.equal(newDoc.fileHandle, undefined);
    assert.equal(h.sync.getStatus().phase, 'disabled'); assert.equal(h.sync.getStatus().lastSyncedAt, null);
    h.state.enabled = true; h.sync.resume(); await h.sync.flush();
    assert.equal(newDoc.dirty, false); assert.equal(newDoc.fileHandle.writes.length, 1);
  } finally { hold.release(); await h.sync.pause(); }
});

test('disabled or read-only/fallback directories do not write, and getStatus never emits recursively', async () => {
  const dir = new FakeDirectory(), doc = makeDoc(), h = harness([doc], dir);
  try {
    h.state.enabled = false; h.sync.schedule(); await h.sync.flush(); assert.equal(dir.files.size, 0); assert.equal(h.sync.getStatus().phase, 'disabled');
    h.state.enabled = true; h.state.directory = null; h.sync.schedule(); assert.equal(h.sync.getStatus().phase, 'disconnected');
    const count = h.statuses.length; for (let i = 0; i < 20; i++) h.sync.getStatus(); assert.equal(h.statuses.length, count);
    h.state.directory = { kind: 'directory', getFileHandle() { throw Error('must not write'); } };
    h.sync.schedule(); await h.sync.flush(); assert.equal(h.sync.getStatus().phase, 'disconnected'); assert.equal(doc.dirty, true);
  } finally { await h.sync.pause(); }
});


test('nested pause barriers keep the queue suspended until the final matching resume', async () => {
  const dir = new FakeDirectory(), doc = makeDoc(), h = harness([doc], dir);
  try {
    await h.sync.pause();
    await h.sync.pause();
    h.sync.schedule();
    assert.equal(h.sync.resume().phase, 'paused');
    await wait(35);
    assert.equal(dir.files.size, 0); assert.equal(doc.dirty, true);
    assert.equal((await h.sync.flush()).phase, 'paused');
    h.sync.resume();
    const status = await h.sync.flush();
    assert.equal(status.phase, 'synced');
    assert.equal(doc.fileHandle.writes.length, 1); assert.equal(doc.dirty, false);
  } finally { await h.sync.pause(); }
});
