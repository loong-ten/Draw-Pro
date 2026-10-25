import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createCanvas, ImageData } = require(require.resolve('@napi-rs/canvas', {
  paths: [process.cwd(), process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES].filter(Boolean),
}));
globalThis.ImageData = ImageData;
let allocated = [];
let factory = () => createCanvas(1, 1);
globalThis.document = {
  createElement(tag) {
    assert.equal(tag, 'canvas');
    const canvas = factory();
    allocated.push(canvas);
    return canvas;
  },
};
const { PaintDocument } = await import('../dist/core.js');
const { canvasFrameFromDrag, prepareCanvasFrame, applyCanvasFrame } = await import('../dist/canvas-frame-core.js');

const rgba = canvas => [...canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data];
const metadata = layer => Object.fromEntries(['id', 'name', 'visible', 'locked', 'opacity', 'blend'].map(k => [k, layer[k]]));
function fill(canvas, seed = 0) {
  const bytes = new Uint8ClampedArray(canvas.width * canvas.height * 4);
  const alpha = [0, 1, 2, 17, 64, 127, 128, 192, 254, 255];
  for (let i = 0; i < bytes.length / 4; i++) {
    bytes[i * 4] = (i * 37 + seed * 11 + 63) % 256;
    bytes[i * 4 + 1] = (i * 71 + seed * 7 + 127) % 256;
    bytes[i * 4 + 2] = (i * 19 + seed * 23 + 255) % 256;
    bytes[i * 4 + 3] = alpha[(i + seed) % alpha.length];
  }
  canvas.getContext('2d').putImageData(new ImageData(bytes, canvas.width, canvas.height), 0, 0);
}
function documentWithLayers(width = 7, height = 5) {
  const doc = new PaintDocument({ name: '画幅像素测试.png', width, height });
  fill(doc.activeLayer.canvas);
  const hidden = doc.addLayer('隐藏半透明层');
  fill(hidden.canvas, 1); hidden.visible = false; hidden.opacity = .37; hidden.blend = 'screen';
  const locked = doc.addLayer('锁定混合层');
  fill(locked.canvas, 2); locked.locked = true; locked.opacity = .64; locked.blend = 'multiply';
  doc.activeLayerId = hidden.id;
  doc.fileHandle = { name: 'source-file' }; doc.view = { x: 13, y: 17, z: 2 };
  doc._composite = { cached: true }; doc._thumb = { cached: true };
  doc.resetHistory('测试初始图像');
  return doc;
}
function snapshot(doc) {
  return {
    width: doc.width, height: doc.height, id: doc.id, name: doc.name, activeLayerId: doc.activeLayerId,
    layers: doc.layers, layerObjects: [...doc.layers], canvases: doc.layers.map(l => l.canvas),
    metadata: doc.layers.map(metadata), pixels: doc.layers.map(l => rgba(l.canvas)),
    history: doc.history, historyIndex: doc.historyIndex, dirty: doc.dirty, revision: doc.revision,
    fileHandle: doc.fileHandle, view: doc.view, composite: doc._composite, thumb: doc._thumb,
  };
}
function unchanged(doc, before) {
  for (const k of ['width', 'height', 'id', 'name', 'activeLayerId', 'history', 'historyIndex', 'dirty', 'revision', 'fileHandle', 'view']) {
    assert.strictEqual(doc[k], before[k], k + ' must remain untouched');
  }
  assert.strictEqual(doc.layers, before.layers);
  assert.strictEqual(doc._composite, before.composite);
  assert.strictEqual(doc._thumb, before.thumb);
  doc.layers.forEach((l, i) => {
    assert.strictEqual(l, before.layerObjects[i]);
    assert.strictEqual(l.canvas, before.canvases[i]);
    assert.deepEqual(metadata(l), before.metadata[i]);
    assert.deepEqual(rgba(l.canvas), before.pixels[i]);
  });
}
function verifyResult(docOrStage, before, frame) {
  assert.equal(docOrStage.width, frame.width); assert.equal(docOrStage.height, frame.height);
  assert.equal(docOrStage.layers.length, before.pixels.length);
  docOrStage.layers.forEach((l, i) => {
    assert.deepEqual(metadata(l), before.metadata[i]);
    const actual = rgba(l.canvas);
    for (let y = 0; y < frame.height; y++) for (let x = 0; x < frame.width; x++) {
      const sx = x + frame.x, sy = y + frame.y;
      for (let channel = 0; channel < 4; channel++) {
        const expected = sx >= 0 && sy >= 0 && sx < before.width && sy < before.height
          ? before.pixels[i][(sy * before.width + sx) * 4 + channel] : 0;
        assert.equal(actual[(y * frame.width + x) * 4 + channel], expected,
          'layer ' + i + ' result (' + x + ',' + y + ') channel ' + channel);
      }
    }
  });
}

const size = { width: 7, height: 5 };
const expansions = [
  ['n', 99, -2, { x: 0, y: -2, width: 7, height: 7 }],
  ['ne', 3, -2, { x: 0, y: -2, width: 10, height: 7 }],
  ['e', 3, 99, { x: 0, y: 0, width: 10, height: 5 }],
  ['se', 3, 2, { x: 0, y: 0, width: 10, height: 7 }],
  ['s', 99, 2, { x: 0, y: 0, width: 7, height: 7 }],
  ['sw', -3, 2, { x: -3, y: 0, width: 10, height: 7 }],
  ['w', -3, 99, { x: -3, y: 0, width: 10, height: 5 }],
  ['nw', -3, -2, { x: -3, y: -2, width: 10, height: 7 }],
];
const contractions = [
  ['n', 99, 2, { x: 0, y: 2, width: 7, height: 3 }],
  ['ne', -2, 2, { x: 0, y: 2, width: 5, height: 3 }],
  ['e', -2, 99, { x: 0, y: 0, width: 5, height: 5 }],
  ['se', -2, -2, { x: 0, y: 0, width: 5, height: 3 }],
  ['s', 99, -2, { x: 0, y: 0, width: 7, height: 3 }],
  ['sw', 2, -2, { x: 2, y: 0, width: 5, height: 3 }],
  ['w', 2, 99, { x: 2, y: 0, width: 5, height: 5 }],
  ['nw', 2, 2, { x: 2, y: 2, width: 5, height: 3 }],
];

test('all four edges and four corners expand and contract while opposite edges stay fixed', () => {
  for (const [handle, dx, dy, expected] of [...expansions, ...contractions]) {
    const frame = canvasFrameFromDrag(size, handle, dx, dy);
    assert.deepEqual(frame, expected, handle + ' drag');
    if (handle.includes('w')) assert.equal(frame.x + frame.width, size.width);
    if (handle.includes('n')) assert.equal(frame.y + frame.height, size.height);
    if (!handle.includes('w')) assert.equal(frame.x, 0);
    if (!handle.includes('n')) assert.equal(frame.y, 0);
  }
});

test('fractional drag rounds symmetrically and crossing an opposite edge stops at one pixel', () => {
  assert.deepEqual(canvasFrameFromDrag(size, 'nw', -.5, -.5), { x: -1, y: -1, width: 8, height: 6 });
  assert.deepEqual(canvasFrameFromDrag(size, 'nw', .5, .5), { x: 1, y: 1, width: 6, height: 4 });
  assert.deepEqual(canvasFrameFromDrag(size, 'e', .49, .49), { x: 0, y: 0, width: 7, height: 5 });
  assert.deepEqual(canvasFrameFromDrag(size, 'nw', 999, 999), { x: 6, y: 4, width: 1, height: 1 });
  assert.deepEqual(canvasFrameFromDrag(size, 'se', -999, -999), { x: 0, y: 0, width: 1, height: 1 });
});

test('edge and area limits clamp preview geometry without allocating pixels', () => {
  allocated = [];
  assert.deepEqual(canvasFrameFromDrag(size, 'w', -999999, 0), { x: 7 - 8192, y: 0, width: 8192, height: 5 });
  assert.deepEqual(canvasFrameFromDrag({ width: 8192, height: 4096 }, 'n', 0, -3000), { x: 0, y: 0, width: 8192, height: 4096 });
  const frame = canvasFrameFromDrag({ width: 4096, height: 4096 }, 'nw', -4096, -4096);
  assert.equal(frame.width, 5792); assert.equal(frame.height, 5792);
  assert.ok(frame.width * frame.height <= 32 * 1024 * 1024);
  assert.equal(frame.x + frame.width, 4096); assert.equal(frame.y + frame.height, 4096);
  assert.equal(allocated.length, 0);
});

test('malformed dimensions, handles, offsets and fractional frame coordinates reject before allocation', () => {
  for (const bad of [null, { width: 0, height: 5 }, { width: 7.5, height: 5 }, { width: 8193, height: 1 }, { width: 8192, height: 8192 }]) {
    assert.throws(() => canvasFrameFromDrag(bad, 'se', 0, 0));
  }
  for (const handle of ['', 'center', 'N', 'news', null]) assert.throws(() => canvasFrameFromDrag(size, handle, 0, 0));
  for (const offset of [NaN, Infinity, '2', null, Number.MAX_VALUE]) assert.throws(() => canvasFrameFromDrag(size, 'e', offset, 0));
  const doc = documentWithLayers(), before = snapshot(doc); allocated = [];
  for (const frame of [
    { x: .5, y: 0, width: 7, height: 5 }, { x: 0, y: 0, width: 0, height: 5 },
    { x: 0, y: 0, width: 8192, height: 8192 }, { x: Number.MAX_SAFE_INTEGER, y: 0, width: 7, height: 5 },
  ]) assert.throws(() => applyCanvasFrame(doc, frame));
  assert.equal(allocated.length, 0); unchanged(doc, before);
});

test('all eight directions preserve exact native RGBA bytes, including low alpha, with transparent new margins', () => {
  for (const [handle, dx, dy, expected] of [...expansions, ...contractions]) {
    const doc = documentWithLayers(), before = snapshot(doc);
    const frame = canvasFrameFromDrag(size, handle, dx, dy);
    assert.equal(applyCanvasFrame(doc, frame, { documents: [doc] }), true);
    verifyResult(doc, before, expected);
    assert.equal(doc.activeLayerId, before.activeLayerId);
    assert.equal(doc.history.length, before.history.length + 1);
    assert.equal(doc.history.at(-1).label, '调整画幅');
    assert.equal(doc.revision, before.revision + 1);
  }
});

test('prepare stages pixels without mutating the source, and preserves arbitrary layer/document metadata on apply', () => {
  const doc = documentWithLayers(), extra = { role: 'normal-map', links: ['source'] }, symbol = Symbol('layer metadata');
  doc.layers[0].extra = extra; doc.layers[0][symbol] = 'symbol-value';
  Object.defineProperty(doc.layers[0], 'nonEnumerable', { value: 42, writable: true, configurable: true });
  const before = snapshot(doc), frame = { x: -2, y: 1, width: 10, height: 6 };
  const stage = prepareCanvasFrame(doc, frame, { documents: [doc] });
  assert.equal(stage.changed, true); assert.equal(stage.workspacePixels, 10 * 6 * 3);
  unchanged(doc, before); verifyResult(stage, before, frame);
  assert.strictEqual(stage.layers[0].extra, extra);
  assert.equal(stage.layers[0][symbol], 'symbol-value');
  assert.equal(stage.layers[0].nonEnumerable, 42);
  assert.equal(Object.getOwnPropertyDescriptor(stage.layers[0], 'nonEnumerable').enumerable, false);
  assert.equal(applyCanvasFrame(doc, frame), true);
  assert.strictEqual(doc.fileHandle, before.fileHandle); assert.strictEqual(doc.view, before.view);
  assert.equal(doc.id, before.id); assert.equal(doc.name, before.name); assert.equal(doc.activeLayerId, before.activeLayerId);
  assert.strictEqual(doc.layers[0].extra, extra); assert.equal(doc.layers[0][symbol], 'symbol-value');
  assert.equal(doc.layers[0].nonEnumerable, 42);
  assert.equal(doc._composite, null); assert.equal(doc._thumb, null); assert.equal(doc.dirty, true);
});

test('a same-size translated frame moves and crops pixels, while a frame outside all content produces transparency', () => {
  for (const frame of [
    { x: 2, y: -1, width: 7, height: 5 },
    { x: -2, y: 1, width: 7, height: 5 },
    { x: 100, y: -100, width: 7, height: 5 },
  ]) {
    const doc = documentWithLayers(), before = snapshot(doc);
    assert.equal(applyCanvasFrame(doc, frame), true); verifyResult(doc, before, frame);
    assert.equal(doc.history.length, before.history.length + 1);
  }
});

test('a true zero drag allocates and commits nothing, even if the existing workspace is over its requested budget', () => {
  const doc = documentWithLayers(), before = snapshot(doc); allocated = [];
  const frame = canvasFrameFromDrag(size, 'se', .1, -.1);
  const stage = prepareCanvasFrame(doc, frame, { maxPixels: 1 });
  assert.equal(stage.changed, false); assert.strictEqual(stage.layers, doc.layers);
  assert.equal(applyCanvasFrame(doc, frame, { maxPixels: 1 }), false);
  assert.equal(allocated.length, 0); unchanged(doc, before);
});

test('one undo and redo restore dimensions, pixels, layer ordering, standard metadata and the active layer', () => {
  const doc = documentWithLayers(), before = snapshot(doc), frame = { x: -2, y: 2, width: 11, height: 4 };
  applyCanvasFrame(doc, frame); const after = snapshot(doc);
  assert.equal(doc.undo(), true);
  assert.equal(doc.width, before.width); assert.equal(doc.height, before.height); assert.equal(doc.activeLayerId, before.activeLayerId);
  assert.deepEqual(doc.layers.map(metadata), before.metadata); assert.deepEqual(doc.layers.map(l => rgba(l.canvas)), before.pixels);
  assert.equal(doc.redo(), true);
  assert.equal(doc.width, after.width); assert.equal(doc.height, after.height); assert.equal(doc.activeLayerId, after.activeLayerId);
  assert.deepEqual(doc.layers.map(metadata), after.metadata); assert.deepEqual(doc.layers.map(l => rgba(l.canvas)), after.pixels);
});

test('applying after undo discards only the redo branch and creates one new history entry', () => {
  const doc = documentWithLayers();
  applyCanvasFrame(doc, { x: -1, y: 0, width: 8, height: 5 });
  applyCanvasFrame(doc, { x: 0, y: -1, width: 8, height: 6 });
  doc.undo(); const index = doc.historyIndex, previous = doc.history[index];
  applyCanvasFrame(doc, { x: 1, y: 0, width: 7, height: 5 });
  assert.equal(doc.historyIndex, index + 1); assert.equal(doc.history.length, index + 2);
  assert.strictEqual(doc.history[index], previous); assert.equal(doc.canRedo, false);
});

test('capacity counts every hidden/locked layer across the workspace and replaces the target exactly once', () => {
  const doc = documentWithLayers(), other = new PaintDocument({ width: 4, height: 3 });
  const before = snapshot(doc), frame = { x: -1, y: -1, width: 8, height: 6 };
  const exact = 8 * 6 * 3 + 4 * 3; allocated = [];
  assert.throws(() => applyCanvasFrame(doc, frame, { documents: [doc, other], maxPixels: exact - 1 }), /像素总量超限/);
  assert.equal(allocated.length, 0); unchanged(doc, before);
  assert.throws(() => prepareCanvasFrame(doc, frame, { documents: [other], maxPixels: exact }), /不在当前工作区/);
  assert.equal(allocated.length, 0);
  assert.equal(applyCanvasFrame(doc, frame, { documents: [doc, other, doc], maxPixels: exact }), true);
  verifyResult(doc, before, frame);
});

test('invalid layer dimensions and a nonwritable document reject before allocating any output', () => {
  const doc = documentWithLayers();
  const existing = doc.layers[1].canvas; doc.layers[1].canvas = createCanvas(1, 1); allocated = [];
  assert.throws(() => applyCanvasFrame(doc, { x: -1, y: 0, width: 8, height: 5 }), /图层画布尺寸/);
  assert.equal(allocated.length, 0); doc.layers[1].canvas = existing;
  const before = snapshot(doc);
  Object.defineProperty(doc, 'width', { writable: false });
  assert.throws(() => applyCanvasFrame(doc, { x: -1, y: 0, width: 8, height: 5 }), /不可写/);
  assert.equal(allocated.length, 0); unchanged(doc, before);
});

test('a canvas allocation failure releases staged canvases and leaves original pixels, references and history intact', () => {
  const doc = documentWithLayers(), before = snapshot(doc); allocated = []; let attempts = 0;
  factory = () => { if (++attempts === 2) throw Error('injected allocation failure'); return createCanvas(1, 1); };
  try { assert.throws(() => applyCanvasFrame(doc, { x: -1, y: 0, width: 8, height: 5 }), /injected allocation failure/); }
  finally { factory = () => createCanvas(1, 1); }
  unchanged(doc, before); assert.equal(allocated.length, 1);
  assert.deepEqual([allocated[0].width, allocated[0].height], [1, 1]);
});

test('source read failure and destination write failure both leave the complete original document unchanged', () => {
  const doc = documentWithLayers(), before = snapshot(doc), frame = { x: -1, y: 0, width: 8, height: 5 };
  const target = doc.layers[1].canvas, originalGet = target.getContext;
  target.getContext = function () { return { getImageData() { throw Error('injected read failure'); } }; };
  allocated = [];
  try { assert.throws(() => applyCanvasFrame(doc, frame), /injected read failure/); }
  finally { target.getContext = originalGet; }
  unchanged(doc, before); assert.ok(allocated.every(c => c.width === 1 && c.height === 1));
  allocated = []; let count = 0;
  factory = () => {
    const canvas = createCanvas(1, 1);
    if (++count === 2) {
      const get = canvas.getContext.bind(canvas);
      canvas.getContext = function (...args) { const context = get(...args); context.putImageData = () => { throw Error('injected write failure'); }; return context; };
    }
    return canvas;
  };
  try { assert.throws(() => applyCanvasFrame(doc, frame), /injected write failure/); }
  finally { factory = () => createCanvas(1, 1); }
  unchanged(doc, before); assert.ok(allocated.every(c => c.width === 1 && c.height === 1));
});

test('history construction failure, including after candidate commit, is atomic and never commits on the original receiver', () => {
  for (const mode of ['capture', 'after-commit']) {
    const doc = documentWithLayers(), before = snapshot(doc); let calls = 0, receiver;
    if (mode === 'capture') {
      doc._capture = function () { throw Error('injected history capture failure'); };
      doc.commit = function (label) { calls++; receiver = this; return PaintDocument.prototype.commit.call(this, label); };
    } else {
      doc.commit = function (label) { calls++; receiver = this; PaintDocument.prototype.commit.call(this, label); throw Error('injected after-commit failure'); };
    }
    allocated = [];
    assert.throws(() => applyCanvasFrame(doc, { x: -1, y: -1, width: 8, height: 6 }), /injected/);
    assert.equal(calls, 1); assert.notStrictEqual(receiver, doc);
    unchanged(doc, before); assert.ok(allocated.every(c => c.width === 1 && c.height === 1));
  }
});

test('success calls the document commit implementation exactly once with the canonical label', () => {
  const doc = documentWithLayers(), before = snapshot(doc); let calls = 0, label;
  doc.commit = function (received) { calls++; label = received; return PaintDocument.prototype.commit.call(this, received); };
  assert.equal(applyCanvasFrame(doc, { x: 0, y: 0, width: 8, height: 5 }), true);
  assert.equal(calls, 1); assert.equal(label, '调整画幅');
  assert.equal(doc.historyIndex, before.historyIndex + 1); assert.equal(doc.history.at(-1).label, '调整画幅');
});
