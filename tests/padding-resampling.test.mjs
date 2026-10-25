import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { Worker as NodeWorker } from 'node:worker_threads';

const require = createRequire(import.meta.url);
const { createCanvas, ImageData } = require(require.resolve('@napi-rs/canvas', {
  paths: [process.cwd(), process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES].filter(Boolean),
}));
globalThis.ImageData = ImageData;
globalThis.document = { createElement(tag) { assert.equal(tag, 'canvas'); return createCanvas(1, 1); } };

const { PaintDocument } = await import('../dist/core.js');
const { paddedCanvas, paddedCanvasAsync, paddedLayers, paddedLayersAsync, applyPaddingSnapshot, duplicateWithPadding } = await import('../dist/padding-raster.js');
const rgba = canvas => canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
const keys = ['id', 'name', 'visible', 'locked', 'opacity', 'blend'];
const meta = layer => Object.fromEntries(keys.map(key => [key, layer[key]]));
const stateOf = doc => ({
  id: doc.id, name: doc.name, width: doc.width, height: doc.height, activeLayerId: doc.activeLayerId,
  layers: doc.layers.map(layer => ({ ...meta(layer), data: [...rgba(layer.canvas)] })),
});
const snapshot = doc => ({ width: doc.width, height: doc.height, layers: doc.layers.map(layer => ({ ...layer })), activeLayerId: doc.activeLayerId });
const resizePlan = (algorithm = 'lanczos3') => ({
  operation: 'resize', width: 9, height: 8, contentWidth: 7, contentHeight: 6, offsetX: 1, offsetY: 1,
  algorithm, sourceRect: { x: 0.5, y: 0.25, width: 6, height: 4.5 },
});

function layeredDoc() {
  const doc = new PaintDocument({ name: '采样测试.png', width: 7, height: 5 });
  doc.addLayer('隐藏图层'); doc.addLayer('锁定高光');
  for (let layer = 0; layer < doc.layers.length; layer++) {
    const data = new Uint8ClampedArray(7 * 5 * 4), alpha = [0, 1, 2, 17, 64, 128, 255];
    for (let p = 0; p < 7 * 5; p++) data.set([(p * 37 + layer * 29) % 256, (p * 79 + 13) % 256, (p * 11 + 67) % 256, alpha[(p + layer) % 7]], p * 4);
    doc.layers[layer].canvas.getContext('2d').putImageData(new ImageData(data, 7, 5), 0, 0);
  }
  Object.assign(doc.layers[1], { visible: false, locked: true, opacity: 0.37, blend: 'multiply' });
  Object.assign(doc.layers[2], { locked: true, opacity: 0.65, blend: 'screen' });
  doc.activeLayerId = doc.layers[1].id;
  doc.resetHistory('原始图层'); doc.dirty = false;
  return doc;
}

test('async native Canvas results match synchronous algorithms, preserving hidden/locked layers and arbitrary metadata', async () => {
  const doc = layeredDoc(), before = stateOf(doc), source = snapshot(doc);
  const symbol = Symbol('layer metadata');
  Object.defineProperty(source.layers[1], 'sourceTag', { value: 'immutable tag', enumerable: false, writable: false });
  source.layers[1][symbol] = { original: true };
  for (const algorithm of ['nearest', 'bilinear', 'bicubic', 'lanczos3', 'area']) {
    const plan = resizePlan(algorithm), expected = paddedLayers(source, plan);
    const prepared = await paddedLayersAsync(source, plan);
    assert.equal(prepared.length, source.layers.length);
    prepared.forEach((layer, i) => {
      assert.deepEqual(meta(layer), meta(source.layers[i]));
      assert.notEqual(layer.canvas, source.layers[i].canvas);
      assert.deepEqual(rgba(layer.canvas), rgba(expected[i].canvas), algorithm + ' layer ' + i);
      const bytes = rgba(layer.canvas);
      for (let x = 0; x < 9; x++) {
        assert.equal(bytes[x * 4 + 3], 0, 'top padding transparent');
        assert.equal(bytes[(7 * 9 + x) * 4 + 3], 0, 'bottom padding transparent');
      }
    });
    assert.equal(prepared[1].sourceTag, 'immutable tag');
    assert.deepEqual(Object.getOwnPropertyDescriptor(prepared[1], 'sourceTag'), Object.getOwnPropertyDescriptor(source.layers[1], 'sourceTag'));
    assert.equal(prepared[1][symbol], source.layers[1][symbol]);
    assert.deepEqual(stateOf(doc), before);
  }
});

test('prepared application does not resample or reread the source and is exactly one undoable history step', async () => {
  const doc = layeredDoc(), before = stateOf(doc), source = snapshot(doc), plan = resizePlan('area');
  const prepared = await paddedLayersAsync(source, plan), revision = doc.revision;
  const originalGet = source.layers[0].canvas.getContext;
  source.layers[0].canvas.getContext = () => { throw new Error('prepared apply must not reread its source'); };
  try { assert.equal(applyPaddingSnapshot(doc, source, plan, prepared), doc); }
  finally { source.layers[0].canvas.getContext = originalGet; }
  assert.equal(doc.history.length, 2); assert.equal(doc.historyIndex, 1); assert.equal(doc.revision, revision + 1);
  assert.equal(doc.activeLayerId, before.activeLayerId);
  doc.layers.forEach((layer, i) => {
    assert.equal(layer.canvas, prepared[i].canvas, 'prepared pixels are directly committed');
    assert.deepEqual(meta(layer), meta(source.layers[i]));
  });
  const after = stateOf(doc);
  assert.equal(doc.undo(), true); assert.deepEqual(stateOf(doc), before); assert.equal(doc.canUndo, false);
  assert.equal(doc.redo(), true); assert.deepEqual(stateOf(doc), after);
});

test('prepared duplication clones every canvas and creates new IDs without sharing with originals or other duplicates', async () => {
  const doc = layeredDoc(), before = stateOf(doc), source = snapshot(doc), plan = resizePlan('bicubic');
  const prepared = await paddedLayersAsync(source, plan);
  const copies = [duplicateWithPadding(source, plan, '副本 A.png', prepared), duplicateWithPadding(source, plan, '副本 B.png', prepared)];
  const ids = new Set(doc.layers.map(layer => layer.id));
  for (const copy of copies) {
    assert.notEqual(copy.id, doc.id);
    assert.equal(copy.history.length, 1); assert.equal(copy.canUndo, false); assert.equal(copy.dirty, true);
    assert.equal(copy.activeLayerId, copy.layers[1].id);
    copy.layers.forEach((layer, i) => {
      assert.equal(ids.has(layer.id), false); ids.add(layer.id);
      assert.notEqual(layer.canvas, prepared[i].canvas);
      assert.deepEqual(rgba(layer.canvas), rgba(prepared[i].canvas));
      for (const key of keys.filter(key => key !== 'id')) assert.equal(layer[key], source.layers[i][key]);
    });
  }
  const pixelsBefore = rgba(prepared[0].canvas).slice();
  copies[0].layers[0].canvas.getContext('2d').clearRect(0, 0, 9, 8);
  assert.deepEqual(rgba(prepared[0].canvas), pixelsBefore);
  assert.deepEqual(rgba(copies[1].layers[0].canvas), pixelsBefore);
  assert.deepEqual(stateOf(doc), before);
});

test('failed history commit is atomic, including original array/view references, while prepared pixels remain reusable', async () => {
  const doc = layeredDoc(), source = snapshot(doc), plan = resizePlan(), prepared = await paddedLayersAsync(source, plan);
  doc.view = { fit: false, zoom: 2 }; doc.isDemo = true; doc._composite = source.layers[0].canvas; doc._thumb = source.layers[1].canvas;
  const before = stateOf(doc), original = Object.fromEntries(['layers', 'history', 'historyIndex', 'revision', 'dirty', 'view', 'isDemo', '_composite', '_thumb'].map(key => [key, doc[key]]));
  const historyLength = doc.history.length, firstPrepared = rgba(prepared[0].canvas).slice(), commit = doc.commit;
  doc.commit = function(label) {
    this.history.push({ label: 'synthetic candidate mutation', bytes: 0 });
    this.view.fit = true;
    commit.call(this, label);
    throw new Error('synthetic history capture failure');
  };
  assert.throws(() => applyPaddingSnapshot(doc, source, plan, prepared), /synthetic history capture failure/);
  assert.deepEqual(stateOf(doc), before);
  for (const [key, value] of Object.entries(original)) assert.equal(doc[key], value, key);
  assert.equal(doc.history.length, historyLength); assert.deepEqual(doc.view, { fit: false, zoom: 2 });
  assert.equal(prepared[0].canvas.width, 9); assert.deepEqual(rgba(prepared[0].canvas), firstPrepared);
  doc.commit = commit;
  applyPaddingSnapshot(doc, source, plan, prepared);
  assert.equal(doc.history.length, historyLength + 1, 'the same prepared result remains retryable');
});

test('invalid plans and aggregate layer capacity are rejected before any pixel read or canvas allocation', async () => {
  let reads = 0, allocations = 0;
  const canvas = { width: 1, height: 1, getContext() { reads++; throw new Error('unexpected pixel read'); } };
  const source = { width: 1, height: 1, layers: Array.from({ length: 5 }, (_, id) => ({ id, canvas })) };
  const create = document.createElement;
  document.createElement = (...args) => { allocations++; return create(...args); };
  try {
    const overArea = { operation: 'resize', width: 8192, height: 8192, contentWidth: 8192, contentHeight: 8192, offsetX: 0, offsetY: 0 };
    assert.throws(() => paddedCanvas(canvas, overArea), RangeError);
    await assert.rejects(paddedCanvasAsync(canvas, overArea), RangeError);
    const tooManyLayerPixels = { ...overArea, height: 4096, contentHeight: 4096 };
    assert.throws(() => paddedLayers(source, tooManyLayerPixels), /128 Mi/);
    await assert.rejects(paddedLayersAsync(source, tooManyLayerPixels), /128 Mi/);
    assert.throws(() => paddedCanvas(canvas, { ...resizePlan(), sourceRect: { x: 0, y: 0, width: 2, height: 1 } }), RangeError);
  } finally { document.createElement = create; }
  assert.equal(reads, 0); assert.equal(allocations, 0);
});

test('prepared layer IDs/order, dimensions, ownership and count are validated before document mutation', async () => {
  const doc = layeredDoc(), source = snapshot(doc), before = stateOf(doc), plan = resizePlan();
  const prepared = await paddedLayersAsync(source, plan), history = doc.history;
  const invalid = [prepared.slice(1), [...prepared].reverse(),
    prepared.map((layer, i) => i ? layer : { ...layer, id: 'wrong ID' }),
    prepared.map((layer, i) => i ? layer : { ...layer, canvas: source.layers[0].canvas }),
    prepared.map((layer, i) => i ? layer : { ...layer, canvas: prepared[1].canvas }),
  ];
  for (const layers of invalid) {
    assert.throws(() => applyPaddingSnapshot(doc, source, plan, layers), RangeError);
    assert.deepEqual(stateOf(doc), before); assert.equal(doc.history, history);
  }
  assert.equal(prepared[0].canvas.width, 9);
});

test('mid-layer cancellation or pixel-read failure disposes staged canvases and never changes the document', async () => {
  for (const failure of ['cancel', 'read']) {
    const doc = layeredDoc(), source = snapshot(doc), before = stateOf(doc), history = doc.history;
    const controller = new AbortController(), created = [], create = document.createElement;
    const canvas = source.layers[1].canvas, getContext = canvas.getContext;
    document.createElement = (...args) => { const result = create(...args); created.push(result); return result; };
    canvas.getContext = function(...args) {
      if (failure === 'cancel') { controller.abort(); return getContext.apply(this, args); }
      throw new Error('synthetic second-layer read failure');
    };
    try {
      await assert.rejects(paddedLayersAsync(source, resizePlan(), { signal: controller.signal }),
        failure === 'cancel' ? { name: 'AbortError' } : /synthetic second-layer read failure/);
    } finally { canvas.getContext = getContext; document.createElement = create; }
    assert.equal(created.length, 1, 'only the first layer reached canvas construction');
    assert.deepEqual([created[0].width, created[0].height], [1, 1], 'the incomplete result is released');
    assert.deepEqual(stateOf(doc), before); assert.equal(doc.history, history);
  }
});

// This adapter only supplies the browser Worker event surface. It loads and runs
// the actual production module Worker on a separate Node thread, with transferable
// buffers; neither the algorithm nor the Worker response is replaced by a mock.
// napi-rs owns its ImageData storage outside V8 and Node cannot transfer that
// external buffer, so this environment adapter copies it to a transferable JS
// buffer. Browser ImageData has a native transferable ArrayBuffer already.
const workerInstances = [];
class NativeModuleWorker {
  constructor(url, options) {
    assert.equal(options.type, 'module');
    assert.match(url.href, /padding-resize-worker\.js$/);
    this.requests = 0; this.pending = 0; this.maxPending = 0; this.transfers = 0; this.terminations = 0;
    workerInstances.push(this);
    const bridge = `const {parentPort} = require('node:worker_threads');
      globalThis.self = {postMessage: (message, transfer) => parentPort.postMessage(message, transfer)};
      import(${JSON.stringify(url.href)}).then(() => {
        parentPort.on('message', data => self.onmessage({data}));
      }).catch(error => { throw error; });`;
    this.thread = new NodeWorker(bridge, { eval: true });
    this.thread.on('message', data => { this.pending--; this.onmessage?.({ data }); });
    this.thread.on('error', error => this.onerror?.({ message: error.message, preventDefault() {} }));
  }
  postMessage(message, transfer) {
    this.requests++; this.pending++; this.maxPending = Math.max(this.maxPending, this.pending);
    assert.deepEqual(transfer, [message.image.data.buffer]);
    const adapted = { ...message, image: { ...message.image, data: new Uint8ClampedArray(message.image.data) } };
    this.thread.postMessage(adapted, [adapted.image.data.buffer]);
    if (adapted.image.data.buffer.byteLength === 0) this.transfers++;
  }
  terminate() { this.terminations++; return this.thread.terminate(); }
}

test('actual module Worker produces all five algorithms faithfully, processes layers serially and transfers only detached snapshots', async () => {
  const previous = globalThis.Worker;
  globalThis.Worker = NativeModuleWorker;
  const doc = layeredDoc(), source = snapshot(doc), before = stateOf(doc);
  try {
    for (const algorithm of ['nearest', 'bilinear', 'bicubic', 'lanczos3', 'area']) {
      const plan = resizePlan(algorithm), expected = paddedLayers(source, plan), count = workerInstances.length;
      const prepared = await paddedLayersAsync(source, plan);
      assert.equal(workerInstances.length, count + 1, 'one Worker is reused for all layers');
      const worker = workerInstances.at(-1);
      assert.equal(worker.requests, 3); assert.equal(worker.maxPending, 1); assert.equal(worker.transfers, 3); assert.equal(worker.terminations, 1);
      prepared.forEach((layer, i) => assert.deepEqual(rgba(layer.canvas), rgba(expected[i].canvas), algorithm));
      assert.deepEqual(stateOf(doc), before, 'transferred ImageData never detaches the source canvas');
    }
  } finally { globalThis.Worker = previous; }
});

test('Worker startup/runtime failures report explicit errors and never silently execute a different path', async () => {
  const previous = globalThis.Worker, doc = layeredDoc(), source = snapshot(doc), before = stateOf(doc);
  let starts = 0, stops = 0;
  try {
    globalThis.Worker = class { constructor() { starts++; throw new Error('blocked by policy'); } };
    await assert.rejects(paddedLayersAsync(source, resizePlan()), /无法启动.*blocked by policy/);
    assert.equal(starts, 1);
    globalThis.Worker = class {
      postMessage() { queueMicrotask(() => this.onerror({ message: 'synthetic module failure', preventDefault() {} })); }
      terminate() { stops++; }
    };
    await assert.rejects(paddedLayersAsync(source, resizePlan()), /计算线程失败.*synthetic module failure/);
    assert.equal(stops, 1);
    assert.deepEqual(stateOf(doc), before);
  } finally { globalThis.Worker = previous; }
});

test('aborting an in-flight Worker immediately terminates it and leaves source layers/history unchanged', async () => {
  const previous = globalThis.Worker, doc = layeredDoc(), source = snapshot(doc), before = stateOf(doc), history = doc.history;
  const controller = new AbortController();
  let started, stops = 0;
  const running = new Promise(resolve => { started = resolve; });
  globalThis.Worker = class {
    postMessage() { started(); } // Hold computation pending to test cancellation, not pixel sampling.
    terminate() { stops++; }
  };
  try {
    const task = paddedLayersAsync(source, resizePlan(), { signal: controller.signal });
    await running;
    controller.abort();
    await assert.rejects(task, { name: 'AbortError' });
    assert.equal(stops, 1); assert.deepEqual(stateOf(doc), before); assert.equal(doc.history, history);
  } finally { globalThis.Worker = previous; }
});
