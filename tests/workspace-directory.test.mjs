import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { PaintDocument } from '../dist/core.js';
import { prepareWorkspaceDocuments } from '../dist/workspace-documents.js';
import * as realIO from '../dist/io.js';

const require = createRequire(import.meta.url);
const nativePath = require.resolve('@napi-rs/canvas', { paths: [process.cwd(), process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES].filter(Boolean) });
const { createCanvas, loadImage } = require(nativePath);
globalThis.document = { createElement(tag) { assert.equal(tag, 'canvas'); return createCanvas(1, 1); } };
globalThis.createImageBitmap = async blob => loadImage(Buffer.from(await blob.arrayBuffer()));
const plain = value => JSON.parse(JSON.stringify(value));

function fixture(name = '原素材.png') {
  const doc = new PaintDocument({ name, width: 3, height: 2 });
  const context = doc.layers[0].canvas.getContext('2d');
  context.fillStyle = '#2468ac'; context.fillRect(1, 0, 1, 1);
  doc.fileHandle = { name, old: true }; doc.path = 'old/' + name; doc.isDemo = false;
  doc.resetHistory('原始素材');
  return doc;
}
function imageFile(name = '新素材.png', path = '') {
  const canvas = createCanvas(2, 3), context = canvas.getContext('2d');
  context.fillStyle = '#ed7144'; context.fillRect(0, 1, 1, 1);
  const file = new File([canvas.toBuffer('image/png')], name, { type: 'image/png' });
  Object.defineProperty(file, 'webkitRelativePath', { value: path });
  return file;
}
function directory(name, files = [imageFile()], guideData) {
  const handle = {
    name,
    async getFileHandle(filename) {
      assert.equal(filename, '.paint-guides.json');
      if (guideData === undefined) throw Object.assign(new Error('not found'), { name: 'NotFoundError' });
      return { getFile: async () => new File([typeof guideData === 'string' ? guideData : JSON.stringify(guideData)], filename, { type: 'application/json' }) };
    },
  };
  return { name, handle, files: files.map(file => ({ file, handle: { name: file.name, new: true, getFile: async () => file }, path: 'sprites/' + file.name })), errors: [] };
}

// Run the real app transaction and applyWorkspace. Only host UI, module restore,
// and the native directory picker are adapted; PNG decoding/import remain real.
const app = readFileSync(new URL('../dist/app.js', import.meta.url), 'utf8');
const directoryCode = app.slice(app.indexOf('let directoryOpenSerial='), app.indexOf('async function openFiles('));
const applyCode = app.slice(app.indexOf('async function applyWorkspace('), app.indexOf('function commitDocuments('));
const fallbackCode = app.slice(app.indexOf("$('#directory-input').onchange="), app.indexOf("$('#project-input').onchange="));
assert.ok(directoryCode.includes('async function openDirectoryWorkspace('));

function host(options = {}) {
  const docs = Array.from({ length: options.count || 2 }, (_, index) => fixture('原素材' + index + '.png'));
  docs[0].dirty = !!options.dirty;
  const oldDirectory = { name: '旧目录' };
  const state = {
    docs, activeId: docs[0].id, workspaceName: '旧工作区', directory: oldDirectory, mode: 'compose',
    guides: [{ id: 'old-guide', type: 'v', x: 1, y: 0 }], selectedGuide: 'old-guide',
    referenceMode: 'relative', baseWidth: 300, baseHeight: 200, showGuides: false, snapToGuides: false,
    showGrid: true, gridSize: 16, pixelDisplay: false, moveAutoSelect: true, moveKeepInside: false,
    workspaceDirty: !!options.workspaceDirty, selection: options.pending ? { float: {} } : null,
    gesture: null, polygon: null, curve: null, pointer: { x: 1, y: 1 }, clipboard: { old: true },
    lastAction: 'guide', guideHistory: [{ guides: [{ id: 'history-from-old-workspace' }] }], guideHistoryIndex: 0,
  };
  const nodes = new Map([
    ['#directory-detail', { textContent: '旧目录已授权' }], ['#asset-search', { value: '旧搜索' }],
    ['#text-editor', { value: '' }], ['#text-editor-box', { hidden: true }],
    ['#directory-input', { clicks: 0, click() { this.clicks++; } }],
  ]);
  const calls = { finish: 0, render: 0, persist: 0, fit: 0, ask: [], restore: [], modes: [], toasts: [], errors: [], pick: 0, imports: [] };
  let scene = { mode: 'compose', composer: { layers: ['old scene'], assets: ['old pixels'] }, tileCanvas: { layers: ['old tile'] }, optimizer: { options: { paletteSize: 17 } }, padding: { options: { margin: 29 } }, slicer: { sourceId: docs[0].id }, converter: { options: { pixelSize: 7 } } };
  let shouldFailRestore = !!options.failRestore, shouldFailMode = !!options.failMode;
  const selected = options.directory || directory('新目录');
  const environment = {
    state, PaintDocument, prepareWorkspaceDocuments, console, autosaveDisabled: false, lastDraftError: 0,
    workspaceApplying: false, localSaveTask: null, localFileSync: null, renderLocalSync() {},
    clearTimeout() {}, layerMove: { cancel() {} },
    $(selector) { assert.ok(nodes.has(selector), selector); return nodes.get(selector); },
    doc: () => state.docs.find(doc => doc.id === state.activeId),
    esc: text => String(text).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])),
    captureRefs: () => ({ guides: plain(state.guides), referenceMode: state.referenceMode, baseWidth: state.baseWidth, baseHeight: state.baseHeight }),
    assertSlicerIdle() { if (options.busy === 'slice') throw Error('切图处理中'); },
    finishPending() { calls.finish++; }, renderUI() { calls.render++; }, fit() { calls.fit++; }, persist() { calls.persist++; },
    toast(message, error = false) { calls.toasts.push({ message, error }); }, caught(error) { calls.errors.push(error); },
    async ask(title, html, settings) { calls.ask.push({ title, html, settings }); options.beforeAsk?.({ state, scene, calls }); return options.answer === undefined ? {} : options.answer; },
    async openProject() { throw Error('folder loading must not take the tool-project import path'); },
    IO: {
      ...realIO,
      async pickDirectory() { calls.pick++; if (options.pickError) throw options.pickError; return selected; },
      async importFiles(files, limits) {
        calls.imports.push({ limits, files });
        if (options.beforeImport) await options.beforeImport(files, limits);
        return realIO.importFiles(files, limits);
      },
    },
    workbench: {
      padding: { isBusy: () => options.busy === 'padding' }, tileCanvas: { isBusy: () => options.busy === 'tile' },
      serialize: () => structuredClone(scene),
      async restore(saved) {
        calls.restore.push(plain(saved));
        scene.composer = null; // Simulates a later module failing after the first reset.
        if (shouldFailRestore) { shouldFailRestore = false; throw Error('mode restore failed'); }
        scene = { mode: saved.mode || 'paint', composer: saved.composer || null, tileCanvas: saved.tileCanvas || null,
          optimizer: saved.optimizer || null, padding: saved.padding || null, slicer: saved.slicer || null, converter: saved.converter || null };
      },
      async setMode(mode) {
        calls.modes.push(mode); state.mode = mode; state.workspaceDirty = true;
        if (shouldFailMode) { shouldFailMode = false; throw Error('mode activation failed'); }
      },
    },
  };
  const api = runInNewContext(directoryCode + '\n' + applyCode + '\n' + fallbackCode + '\n({openFolder,openDirectoryWorkspace,importImages})', environment);
  return { ...api, state, calls, nodes, oldDirectory, selected, environment, scene: () => scene,
    async fallback(files) { const input = nodes.get('#directory-input'); input.files = files; input.value = 'chosen'; await input.onchange({ target: input }); } };
}
function originalState(h) {
  return { docs: h.state.docs, directory: h.state.directory, workspaceName: h.state.workspaceName, guides: h.state.guides,
    history: h.state.guideHistory, scene: plain(h.scene()), pixel: h.state.docs[0].layers[0].canvas.toDataURL(),
    activeId: h.state.activeId, search: h.nodes.get('#asset-search').value, detail: h.nodes.get('#directory-detail').textContent };
}
function unchanged(h, previous) {
  for (const key of ['docs', 'directory', 'workspaceName', 'guides', 'activeId']) assert.strictEqual(h.state[key], previous[key], key);
  assert.strictEqual(h.state.guideHistory, previous.history);
  assert.equal(h.state.docs[0].layers[0].canvas.toDataURL(), previous.pixel);
  assert.deepEqual(plain(h.scene()), previous.scene);
  assert.equal(h.nodes.get('#asset-search').value, previous.search);
  assert.equal(h.nodes.get('#directory-detail').textContent, previous.detail);
}

test('native directory replaces even a full old workspace, resets scenes and references, and binds only the new directory files', async () => {
  const h = host({ count: 100 }), previous = originalState(h);
  await h.openFolder();
  assert.equal(h.state.docs.length, 1);
  assert.equal(h.state.docs[0].name, '新素材.png');
  assert.deepEqual([h.state.docs[0].width, h.state.docs[0].height], [2, 3]);
  assert.strictEqual(h.state.directory, h.selected.handle);
  assert.strictEqual(h.state.docs[0].fileHandle, h.selected.files[0].handle);
  assert.equal(h.state.docs[0].path, 'sprites/新素材.png');
  assert.equal(h.state.workspaceName, '新目录');
  assert.equal(h.state.activeId, h.state.docs[0].id);
  assert.equal(h.state.mode, 'paint'); assert.equal(h.state.workspaceDirty, false);
  assert.equal(h.state.guides.length, 0); assert.equal(h.state.guideHistory.length, 1);
  assert.equal(h.state.selectedGuide, null); assert.equal(h.state.clipboard, null); assert.equal(h.state.lastAction, 'image');
  assert.equal(h.nodes.get('#asset-search').value, '');
  for (const key of ['composer', 'tileCanvas', 'optimizer', 'padding', 'slicer', 'converter']) assert.equal(h.scene()[key], null);
  assert.deepEqual(plain(h.calls.imports[0].limits), { limit: 100, pixelBudget: 64 * 1024 * 1024 });
  assert.equal(previous.docs[0].layers[0].canvas.toDataURL(), previous.pixel, 'detached old pixels remain untouched');
  assert.equal(previous.docs.length, 100, 'the old collection was replaced, not emptied in place');
});

test('independent image import appends while retaining the current directory, references and scenes', async () => {
  const h = host(), previous = originalState(h);
  await h.importImages([imageFile('追加.png')]);
  assert.strictEqual(h.state.docs, previous.docs); assert.equal(h.state.docs.length, 3);
  assert.equal(h.state.docs[2].name, '追加.png');
  assert.strictEqual(h.state.directory, previous.directory); assert.strictEqual(h.state.guides, previous.guides);
  assert.equal(h.state.workspaceName, previous.workspaceName); assert.deepEqual(plain(h.scene()), previous.scene);
  assert.equal(h.calls.restore.length, 0); assert.equal(h.calls.ask.length, 0);
});

test('fallback directory input replaces the workspace, preserves relative paths, and has no writable binding', async () => {
  const h = host();
  await h.fallback([imageFile('只读.png', '所选文件夹/子目录/只读.png')]);
  assert.equal(h.state.docs.length, 1); assert.equal(h.state.docs[0].name, '只读.png');
  assert.equal(h.state.docs[0].path, '所选文件夹/子目录/只读.png');
  assert.equal(h.state.directory, null); assert.equal(h.state.docs[0].fileHandle, null);
  assert.equal(h.state.workspaceName, '所选文件夹');
  assert.equal(h.nodes.get('#directory-input').value, ''); assert.equal(h.calls.errors.length, 0);
});

test('picker cancellation, unsaved-change cancellation and empty fallback selection preserve the entire old workspace', async () => {
  const native = host({ pickError: Object.assign(Error('cancelled'), { name: 'AbortError' }) }), beforeNative = originalState(native);
  await native.openFolder(); unchanged(native, beforeNative); assert.equal(native.calls.finish, 0);
  const dirty = host({ dirty: true, answer: null }), beforeDirty = originalState(dirty);
  await dirty.openFolder(); unchanged(dirty, beforeDirty); assert.equal(dirty.calls.finish, 0);
  assert.equal(dirty.calls.ask.length, 1); assert.match(dirty.calls.ask[0].html, /替换当前 2 张素材/);
  const fallback = host(), beforeFallback = originalState(fallback);
  await fallback.fallback([]); unchanged(fallback, beforeFallback); assert.equal(fallback.calls.imports.length, 0);
});

test('pending edits and workspace-only changes receive the same explicit replacement confirmation', async () => {
  for (const dirtyOptions of [{ pending: true }, { workspaceDirty: true }]) {
    const h = host({ ...dirtyOptions, answer: null }), previous = originalState(h);
    await h.openFolder(); unchanged(h, previous); assert.equal(h.calls.ask.length, 1);
  }
});

test('failed image decoding, unreadable directory entries or invalid reference files preserve old data and labels', async () => {
  const invalid = new File(['not an image'], 'broken.png', { type: 'image/png' });
  const cases = [directory('损坏图片', [invalid]), { ...directory('不可读', []), errors: [{ message: '拒绝读取' }] }, directory('损坏参考', [imageFile()], '{invalid')];
  for (const selected of cases) {
    const h = host({ directory: selected }), previous = originalState(h);
    await assert.rejects(h.openFolder()); unchanged(h, previous);
    assert.equal(h.calls.restore.length, 0); assert.equal(h.calls.finish, 0);
  }
});

test('a confirmed native empty directory clears old assets and creates one transparent editable canvas', async () => {
  const h = host({ directory: directory('空目录', []), dirty: true });
  await h.openFolder();
  assert.equal(h.state.docs.length, 1); const blank = h.state.docs[0];
  assert.deepEqual([blank.width, blank.height, blank.layers.length], [960, 640, 1]);
  assert.equal(blank.name, '未命名.png'); assert.equal(blank.canUndo, false); assert.equal(blank.fileHandle ?? null, null);
  assert.ok(blank.layers[0].canvas.getContext('2d').getImageData(0, 0, blank.width, blank.height).data.every(value => value === 0));
  assert.strictEqual(h.state.directory, h.selected.handle); assert.equal(h.state.workspaceName, '空目录');
  assert.equal(h.calls.ask.length, 1); assert.match(h.calls.ask[0].html, /透明空白画布/);
});

test('new directory references replace old history and cannot override the new name or install old scenes', async () => {
  const guides = { kind: 'paint-studio-guides', version: 1, guides: [{ id: 'new-reference', type: 'h', x: 0, y: 2 }],
    settings: { referenceMode: 'relative', baseWidth: 10, baseHeight: 15, workspaceName: '错误旧名称', activeDocId: 'old-id', workbench: { composer: { layers: ['unrelated'] } } } };
  const h = host({ directory: directory('正确目录', [imageFile()], guides) });
  await h.openFolder();
  assert.equal(h.state.workspaceName, '正确目录'); assert.equal(h.state.guides[0].id, 'new-reference');
  assert.equal(h.state.referenceMode, 'relative'); assert.equal(h.state.baseWidth, 10); assert.equal(h.state.baseHeight, 15);
  assert.equal(h.state.guideHistory.length, 1); assert.equal(h.state.guideHistoryIndex, 0);
  assert.equal(h.state.guideHistory[0].guides[0].id, 'new-reference'); assert.equal(h.scene().composer, null);
  const file = new File([JSON.stringify(guides)], '.paint-guides.json', { type: 'application/json' });
  Object.defineProperty(file, 'webkitRelativePath', { value: '只读参考目录/.paint-guides.json' });
  await h.fallback([imageFile('新图.png', '只读参考目录/新图.png'), file]);
  assert.equal(h.state.docs.length, 1); assert.equal(h.state.workspaceName, '只读参考目录'); assert.equal(h.state.guides[0].id, 'new-reference');
  assert.equal(h.calls.errors.length, 0, 'reference JSON is not mistaken for a paintspace or tool project');
});

test('a later module restore or mode activation failure rolls back original document identities, scenes, handles and labels', async () => {
  for (const failure of [{ failRestore: true }, { failMode: true }]) {
    const h = host({ ...failure, dirty: true, workspaceDirty: true }), previous = originalState(h);
    await assert.rejects(h.openFolder(), /mode .* failed/);
    unchanged(h, previous); assert.equal(h.state.mode, 'compose'); assert.equal(h.state.workspaceDirty, true);
    assert.equal(h.calls.restore.length, 2, 'old module snapshot is restored after the failed reset');
  }
});

test('delayed folder or image import cannot overwrite or append to a subsequently opened workspace', async () => {
  let release, started;
  const blocked = new Promise(resolve => { release = resolve; });
  const reading = new Promise(resolve => { started = resolve; });
  const h = host({ beforeImport: async () => { started(); await blocked; } });
  const pending = h.openFolder(); await reading;
  const replacement = [fixture('另一个工程.png')]; h.state.docs = replacement; h.state.activeId = replacement[0].id; h.state.workspaceName = '另一个工程';
  release(); await pending;
  assert.strictEqual(h.state.docs, replacement); assert.equal(h.state.workspaceName, '另一个工程'); assert.equal(h.calls.restore.length, 0);
  let releaseAppend, startedAppend;
  const appendBlocked = new Promise(resolve => { releaseAppend = resolve; });
  const appendReading = new Promise(resolve => { startedAppend = resolve; });
  const a = host({ beforeImport: async () => { startedAppend(); await appendBlocked; } });
  const append = a.importImages([imageFile()]); await appendReading;
  a.state.docs = replacement; a.state.activeId = replacement[0].id;
  releaseAppend(); await append;
  assert.strictEqual(a.state.docs, replacement); assert.equal(replacement.length, 1);
});

test('partial import replaces with readable files and busy tools block before starting a directory switch', async () => {
  const broken = new File(['bad'], 'broken.png', { type: 'image/png' });
  const h = host({ directory: directory('部分可读', [imageFile(), broken]) });
  await h.openFolder();
  assert.equal(h.state.docs.length, 1); assert.match(h.calls.toasts.at(-1).message, /1 个文件未能读取/);
  for (const busy of ['slice', 'padding', 'tile']) {
    const blocked = host({ busy }), previous = originalState(blocked);
    await assert.rejects(blocked.openFolder()); unchanged(blocked, previous); assert.equal(blocked.calls.pick, 0);
  }
});

test('workspace replacement waits for sync pause and always resumes after success or restore failure', async () => {
  for (const failRestore of [false, true]) {
    let releasePause, enteredPause;
    const paused = new Promise(resolve => { releasePause = resolve; });
    const started = new Promise(resolve => { enteredPause = resolve; });
    const h = host({ failRestore }), previous = originalState(h), events = [];
    let statusRenders = 0;
    h.environment.localFileSync = {
      async pause() { events.push('pause'); enteredPause(); await paused; },
      resume() { events.push('resume'); },
    };
    h.environment.renderLocalSync = () => { statusRenders++; };
    const opening = h.openFolder();
    await started;
    unchanged(h, previous);
    assert.equal(h.calls.restore.length, 0, 'no scene or document replacement before the old sync settles');
    assert.equal(h.environment.workspaceApplying, false, 'the outer read barrier precedes applyWorkspace');
    assert.deepEqual(events, ['pause']);
    releasePause();
    if (failRestore) {
      await assert.rejects(opening, /mode restore failed/);
      unchanged(h, previous);
    } else {
      await opening;
      assert.equal(h.state.docs.length, 1);
      assert.equal(h.state.docs[0].name, '新素材.png');
      assert.strictEqual(h.state.directory, h.selected.handle);
    }
    assert.deepEqual(events, ['pause', 'pause', 'resume', 'resume']);
    assert.equal(h.environment.workspaceApplying, false);
    assert.equal(statusRenders, 1);
  }
});

test('reopening a directory obtains fresh file snapshots after the write barrier instead of decoding picker snapshots', async () => {
  const staleFile=imageFile('same.png');
  const updatedCanvas=createCanvas(5,4);
  updatedCanvas.getContext('2d').fillRect(0,0,5,4);
  const freshFile=new File([updatedCanvas.toBuffer('image/png')],'same.png',{type:'image/png'});
  let currentFile=staleFile,releaseWrite,enteredBarrier,reads=0,depth=0;
  const writing=new Promise(resolve=>{releaseWrite=resolve});
  const started=new Promise(resolve=>{enteredBarrier=resolve});
  const selected=directory('同一目录',[staleFile]);
  selected.files[0].handle.getFile=async()=>{
    reads++;
    assert.equal(currentFile,freshFile,'getFile runs after the previous write finishes');
    assert.ok(depth>0,'automatic writes remain paused while obtaining the new snapshot');
    return currentFile;
  };
  const h=host({directory:selected});
  h.environment.localFileSync={
    async pause(){depth++;enteredBarrier();await writing},
    resume(){depth--},
  };
  const opening=h.openFolder();
  await started;
  assert.equal(reads,0);assert.equal(h.calls.imports.length,0,'no image decoding before the barrier');
  currentFile=freshFile;releaseWrite();
  await opening;
  assert.equal(reads,1);assert.equal(depth,0,'both nested pauses have matching resumes');
  assert.deepEqual([h.state.docs[0].width,h.state.docs[0].height],[5,4]);
  assert.equal(h.calls.imports[0].files[0].file,freshFile);
  assert.equal(selected.files[0].file,staleFile,'the picker snapshot itself is never reused or mutated');
});
