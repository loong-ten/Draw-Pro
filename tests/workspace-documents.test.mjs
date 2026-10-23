import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { PaintDocument } from '../dist/core.js';
import { prepareWorkspaceDocuments } from '../dist/workspace-documents.js';

const require = createRequire(import.meta.url);
const nativePath = require.resolve('@napi-rs/canvas', { paths: [process.cwd(), process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES].filter(Boolean) });
const { createCanvas } = require(nativePath);
globalThis.document = { createElement(tag) { assert.equal(tag, 'canvas'); return createCanvas(1, 1); } };

function fixture(id, width = 2, height = 2, count = 1) {
  const document = new PaintDocument({ id, name: id + '.png', width, height });
  for (let i = 1; i < count; i++) document.addLayer('图层 ' + (i + 1));
  const context = document.layers[0].canvas.getContext('2d'); context.fillStyle = '#123456'; context.fillRect(0, 0, 1, 1);
  document.path = 'sprites/' + document.name; document.isDemo = false;
  return document;
}
function snapshot(document) {
  return {
    id: document.id, name: document.name, dirty: document.dirty, isDemo: document.isDemo,
    activeLayerId: document.activeLayerId, history: document.history, historyIndex: document.historyIndex,
    layers: document.layers, layerObjects: [...document.layers],
    pixels: document.layers.map(layer => layer.canvas.toDataURL()),
  };
}
function assertUntouched(document, before) {
  for (const key of ['id', 'name', 'dirty', 'isDemo', 'activeLayerId', 'history', 'historyIndex', 'layers']) assert.strictEqual(document[key], before[key], key + ' remains unchanged');
  document.layers.forEach((layer, index) => assert.strictEqual(layer, before.layerObjects[index]));
  assert.deepEqual(document.layers.map(layer => layer.canvas.toDataURL()), before.pixels);
}

// Exercise the actual host transaction without booting the complete editor DOM.
// Only its rendering/persistence adapters are substituted; document validation
// and all workspace mutations run from app.js itself.
const appSource = readFileSync(new URL('../dist/app.js', import.meta.url), 'utf8');
const transactionSource = appSource.slice(appSource.indexOf('function commitDocuments('), appSource.indexOf('function applyLayer('));
assert.ok(transactionSource.includes('function addDocuments('));
function transactionHost({ renderError, persistError, busy = false, mode = 'slice' } = {}) {
  const source = fixture('source'), selection = { x: 1, y: 1 };
  source.isDemo = true;
  const state = { docs: [source], activeId: source.id, mode, selection, workspaceDirty: false };
  const search = { value: 'source.png' }, list = { scrollTop: 0, scrollHeight: 600 };
  const calls = { finish: 0, deactivate: 0, render: 0, fit: 0, persist: 0, errors: [] };
  const api = runInNewContext(transactionSource + '\n({ addDocument, addDocuments })', {
    prepareWorkspaceDocuments, state, console,
    workbench: { deactivate() { calls.deactivate++; } },
    finishPending() { calls.finish++; },
    renderUI() { calls.render++; if (renderError) throw renderError; },
    fit() { calls.fit++; },
    persist() { calls.persist++; if (persistError) throw persistError; },
    caught(error) { calls.errors.push(error); },
    assertSlicerIdle() { if (busy) throw Error('切图处理中'); },
    $(selector) { assert.ok(['#asset-search', '#asset-list'].includes(selector)); return selector === '#asset-search' ? search : list; },
  });
  return { ...api, state, source, selection, search, list, calls };
}

test('planning preserves native pixels, document identity and demo sources without committing anything', () => {
  const source = fixture('source', 3, 2); source.isDemo = true;
  const incoming = [fixture('frame-a', 2, 2), fixture('frame-b', 2, 1, 2)];
  const existing = [source], snapshots = [source, ...incoming].map(snapshot);
  Object.freeze(incoming[0]); Object.freeze(existing); Object.freeze(incoming);
  const plan = prepareWorkspaceDocuments(existing, incoming);
  assert.equal(plan.totalPixels, 14);
  assert.deepEqual(plan.entries.map(entry => entry.id), ['frame-a', 'frame-b']);
  plan.entries.forEach((entry, index) => assert.strictEqual(entry.document, incoming[index]));
  assert.equal(existing.length, 1); assert.strictEqual(existing[0], source);
  [source, ...incoming].forEach((document, index) => assertUntouched(document, snapshots[index]));
});

test('the real host submits a whole batch once, reveals new assets and preserves the selected source', () => {
  const host = transactionHost({ busy: true }), before = snapshot(host.source);
  const incoming = [fixture('frame-a'), fixture('frame-b')];
  const result = host.addDocuments(incoming);
  assert.equal(result.length, 2);
  incoming.forEach((document, index) => {
    assert.strictEqual(result[index], document);
    assert.strictEqual(host.state.docs[index + 1], document);
    assert.equal(document.dirty, true); assert.equal(document.isDemo, false);
  });
  assert.equal(host.state.activeId, host.source.id);
  assert.strictEqual(host.state.selection, host.selection);
  assert.equal(host.state.workspaceDirty, true);
  assert.equal(host.search.value, ''); assert.equal(host.list.scrollTop, host.list.scrollHeight);
  assert.deepEqual(host.calls, { finish: 1, deactivate: 1, render: 1, fit: 0, persist: 1, errors: [] });
  assertUntouched(host.source, before);
  assert.throws(() => host.addDocument(fixture('blocked-single')), /切图处理中/);
  assert.equal(host.state.docs.length, 3);

  const single = transactionHost({ mode: 'paint' }), newDocument = fixture('single');
  assert.strictEqual(single.addDocument(newDocument), newDocument);
  assert.equal(single.state.activeId, newDocument.id); assert.equal(single.state.selection, null);
  assert.equal(single.search.value, 'source.png'); assert.equal(single.list.scrollTop, 0);
  assert.equal(single.calls.fit, 1);
});

test('the real host rejects before committing and never rejects an owned batch because of UI or persistence errors', () => {
  const host = transactionHost(), before = snapshot(host.source);
  const first = fixture('first'), invalid = fixture('invalid'), last = fixture('last');
  invalid.activeLayerId = 'missing';
  assert.throws(() => host.addDocuments([first, invalid, last]), /活动图层/);
  assert.deepEqual(host.state.docs, [host.source]); assertUntouched(host.source, before);
  assert.deepEqual(host.calls, { finish: 0, deactivate: 0, render: 0, fit: 0, persist: 0, errors: [] });
  assert.equal(host.search.value, 'source.png');

  const renderError = Error('render failed'), persistError = Error('persist failed');
  const failedView = transactionHost({ renderError, persistError });
  const incoming = [fixture('a'), fixture('b')], pixels = incoming.map(document => document.layers[0].canvas.toDataURL());
  const result = failedView.addDocuments(incoming);
  assert.equal(result.length, 2); assert.equal(failedView.state.docs.length, 3);
  incoming.forEach((document, index) => {
    assert.strictEqual(result[index], document); assert.strictEqual(failedView.state.docs[index + 1], document);
    assert.equal(document.layers[0].canvas.toDataURL(), pixels[index]);
  });
  assert.deepEqual(failedView.calls.errors, [renderError, persistError]);
  assert.equal(failedView.calls.render, 1); assert.equal(failedView.calls.persist, 1);
  assert.equal(failedView.state.workspaceDirty, true);
});

test('duplicate IDs are planned against both the workspace and the entire incoming batch', () => {
  const source = fixture('shared'), first = fixture('shared'), second = fixture('shared'), third = fixture('reserved');
  const incoming = [first, second, third], before = incoming.map(snapshot);
  const candidates = ['reserved', 'shared', 'new-a', 'new-a', 'new-b'];
  const plan = prepareWorkspaceDocuments([source], incoming, { makeId: () => candidates.shift() });
  assert.deepEqual(plan.entries.map(entry => entry.id), ['new-a', 'new-b', 'reserved']);
  assert.equal(new Set([source.id, ...plan.entries.map(entry => entry.id)]).size, 4);
  incoming.forEach((document, index) => assertUntouched(document, before[index]));
});

test('an invalid middle document rejects the complete batch before any ID generation or mutation', () => {
  const source = fixture('shared'), first = fixture('shared'), broken = fixture('broken'), last = fixture('last');
  broken.activeLayerId = 'missing';
  const incoming = [first, broken, last], originalExisting = [source], before = [source, ...incoming].map(snapshot);
  let generated = 0;
  assert.throws(() => prepareWorkspaceDocuments(originalExisting, incoming, { makeId: () => { generated++; return 'new'; } }), /活动图层/);
  assert.equal(generated, 0); assert.deepEqual(originalExisting, [source]); assert.deepEqual(incoming, [first, broken, last]);
  [source, ...incoming].forEach((document, index) => assertUntouched(document, before[index]));
});

test('document count and summed layer pixels enforce exact boundaries for a whole group', () => {
  const source = fixture('source', 2, 2), incoming = [fixture('a', 2, 1, 2), fixture('b', 1, 2)];
  assert.equal(prepareWorkspaceDocuments([source], incoming, { maxDocuments: 3, maxPixels: 10 }).totalPixels, 10);
  assert.throws(() => prepareWorkspaceDocuments([source], incoming, { maxDocuments: 2, maxPixels: 10 }), /最多支持 2 张/);
  let generated = 0;
  incoming[0].id = source.id;
  assert.throws(() => prepareWorkspaceDocuments([source], incoming, { maxPixels: 9, makeId: () => { generated++; return 'new'; } }), /像素总量/);
  assert.equal(generated, 0);
  const hundred = Array.from({ length: 100 }, (_, index) => fixture('small-' + index, 1, 1));
  assert.equal(prepareWorkspaceDocuments(hundred.slice(0, 99), hundred.slice(99)).entries.length, 1);
  assert.throws(() => prepareWorkspaceDocuments(hundred, [fixture('overflow', 1, 1)]), /最多支持 100 张/);
});

test('malformed dimensions, layers, contexts and opacity cannot enter the workspace', () => {
  const invalid = [
    [document => { document.id = ' '; }, /素材标识/],
    [document => { document.width = 1.5; }, /素材尺寸/],
    [document => { document.width = 8193; }, /素材尺寸/],
    [document => { document.width = 8192; document.height = 4097; }, /素材尺寸/],
    [document => { document.layers = []; }, /1–50/],
    [document => { document.layers = Array.from({ length: 51 }, (_, i) => ({ ...document.layers[0], id: 'layer-' + i })); }, /1–50/],
    [document => { document.layers.push({ ...document.layers[0] }); }, /重复的图层标识/],
    [document => { document.layers[0].canvas = createCanvas(1, 1); }, /尺寸与素材不一致/],
    [document => { document.layers[0].canvas = { width: 2, height: 2 }; }, /画布无效/],
    [document => { document.layers[0].canvas = { width: 2, height: 2, toDataURL() {}, getContext() { return null; } }; }, /无法读取/],
    [document => { document.layers[0].opacity = NaN; }, /不透明度/],
    [document => { document.layers[0].opacity = 1.01; }, /不透明度/],
    [document => { document.activeLayerId = 'gone'; }, /活动图层/],
  ];
  for (const [damage, expected] of invalid) {
    const document = fixture('invalid'); damage(document);
    assert.throws(() => prepareWorkspaceDocuments([], [document]), expected);
  }
  const fifty = fixture('fifty', 1, 1, 50);
  assert.equal(prepareWorkspaceDocuments([], [fifty]).totalPixels, 50);
  delete fifty.layers[0].blend;
  assert.equal(prepareWorkspaceDocuments([], [fifty]).entries.length, 1, 'optional compositor layer properties remain supported');
  assert.throws(() => prepareWorkspaceDocuments([], [{ ...fixture('plain') }]), /有效的绘画文档/);
  assert.throws(() => prepareWorkspaceDocuments([], []), /没有可加入/);
  assert.throws(() => prepareWorkspaceDocuments(null, [fixture('a')]), /列表格式/);
});

test('object aliases are rejected while distinct documents may safely share their original ID', () => {
  const source = fixture('source'), incoming = fixture('new');
  assert.throws(() => prepareWorkspaceDocuments([source], [source]), /独立副本/);
  assert.throws(() => prepareWorkspaceDocuments([source], [incoming, incoming]), /独立副本/);
  const independent = fixture('source');
  assert.equal(prepareWorkspaceDocuments([source], [independent], { makeId: () => 'distinct' }).entries[0].id, 'distinct');
  assert.equal(independent.id, 'source');
});

test('ID generation failure and invalid capacity settings leave the batch untouched', () => {
  const source = fixture('source'), incoming = fixture('source'), before = snapshot(incoming);
  assert.throws(() => prepareWorkspaceDocuments([source], [incoming], { makeId: () => 'source' }), /唯一的素材标识/);
  assertUntouched(incoming, before);
  for (const settings of [{ maxDocuments: 0 }, { maxPixels: NaN }, { maxPixels: 1.5 }, { makeId: null }]) {
    assert.throws(() => prepareWorkspaceDocuments([source], [incoming], settings), /容量设置/);
    assertUntouched(incoming, before);
  }
});
