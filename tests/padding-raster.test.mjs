import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

// Only canvas creation is adapted to Node. All raster operations, layer objects,
// PaintDocument history, padding and duplication use the production modules.
const require = createRequire(import.meta.url);
const canvasPath = require.resolve('@napi-rs/canvas', {
  paths: [process.cwd(), process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES].filter(Boolean),
});
const { createCanvas, ImageData } = require(canvasPath);
globalThis.ImageData = ImageData;
globalThis.document = {
  createElement(tag) {
    assert.equal(tag, 'canvas', 'these raster tests need no DOM elements except native canvas');
    return createCanvas(1, 1);
  },
};

const { PaintDocument, makeCanvas, composite } = await import('../dist/core.js');
const { findAlphaBounds, planPadding } = await import('../dist/padding-core.js');
const { paddedCanvas, paddedLayers, applyPaddingSnapshot, duplicateWithPadding } = await import('../dist/padding-raster.js');
const metadataKeys = ['id', 'name', 'visible', 'locked', 'opacity', 'blend'];
const pixels = canvas => canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
const layerMetadata = layer => Object.fromEntries(metadataKeys.map(key => [key, layer[key]]));

function fillPixels(canvas, seed = 0) {
  const data = new Uint8ClampedArray(canvas.width * canvas.height * 4);
  const alphas = [0, 1, 2, 17, 64, 127, 128, 192, 254, 255];
  for (let i = 0; i < data.length / 4; i++) {
    data[i * 4] = (i * 47 + seed * 29) % 256;
    data[i * 4 + 1] = (i * 79 + seed * 17 + 13) % 256;
    data[i * 4 + 2] = (i * 31 + seed * 43 + 121) % 256;
    data[i * 4 + 3] = alphas[(i + seed) % alphas.length];
  }
  canvas.getContext('2d').putImageData(new ImageData(data, canvas.width, canvas.height), 0, 0);
}

function inspectDocument(doc) {
  return {
    id: doc.id, name: doc.name, width: doc.width, height: doc.height,
    activeLayerId: doc.activeLayerId,
    layers: doc.layers.map(layer => ({ ...layerMetadata(layer), rgba: [...pixels(layer.canvas)] })),
  };
}

function snapshot(doc) {
  const canvas = composite(doc);
  return {
    id: doc.id, name: doc.name, width: doc.width, height: doc.height,
    canvas, bounds: findAlphaBounds(canvas.getContext('2d').getImageData(0, 0, doc.width, doc.height)),
    layers: doc.layers.map(layer => ({ ...layer })), activeLayerId: doc.activeLayerId,
  };
}

function verifyPadded(sourceCanvas, targetCanvas, plan) {
  assert.equal(targetCanvas.width, plan.width);
  assert.equal(targetCanvas.height, plan.height);
  const before = pixels(sourceCanvas), after = pixels(targetCanvas);
  for (let y = 0; y < plan.height; y++) for (let x = 0; x < plan.width; x++) {
    const sourceX = x - plan.offsetX, sourceY = y - plan.offsetY;
    const inside = sourceX >= 0 && sourceY >= 0 && sourceX < sourceCanvas.width && sourceY < sourceCanvas.height;
    for (let channel = 0; channel < 4; channel++) {
      const expected = inside ? before[(sourceY * sourceCanvas.width + sourceX) * 4 + channel] : 0;
      assert.equal(after[(y * plan.width + x) * 4 + channel], expected,
        `RGBA channel ${channel} at (${x}, ${y}) preserves the source or is transparent padding`);
    }
  }
}

function layeredDocument() {
  const doc = new PaintDocument({ name: '真实像素验证.png', width: 7, height: 5 });
  const base = doc.layers[0];
  base.name = '基础像素'; base.opacity = 0.9;
  fillPixels(base.canvas, 0);
  const hidden = doc.addLayer('隐藏并锁定的半透明层');
  hidden.visible = false; hidden.locked = true; hidden.opacity = 0.37; hidden.blend = 'multiply';
  fillPixels(hidden.canvas, 1);
  const highlights = doc.addLayer('屏幕混合高光');
  highlights.locked = true; highlights.opacity = 0.65; highlights.blend = 'screen';
  fillPixels(highlights.canvas, 2);
  doc.activeLayerId = hidden.id;
  doc.resetHistory('完整多图层原图');
  doc.dirty = false;
  return doc;
}

test('paddedCanvas preserves every native RGBA byte by integer translation and all new pixels are transparent', () => {
  const source = makeCanvas(7, 5);
  fillPixels(source);
  const original = pixels(source).slice();
  const plan = { width: 15, height: 11, offsetX: 4, offsetY: 3 };
  const output = paddedCanvas(source, plan);
  assert.notEqual(output, source);
  verifyPadded(source, output, plan);
  assert.deepEqual(pixels(source), original, 'padding never modifies the input canvas');
  const originalAlphas = original.filter((_, index) => index % 4 === 3);
  for (const alpha of [0, 1, 2, 17, 64, 127, 128, 192, 254, 255]) {
    assert.ok(originalAlphas.includes(alpha), `source really includes alpha=${alpha}`);
  }
});

test('paddedCanvas rejects fractional movement and clipping instead of resampling', () => {
  const source = makeCanvas(3, 2);
  for (const plan of [
    { width: 5, height: 4, offsetX: 0.5, offsetY: 1 },
    { width: 5, height: 4, offsetX: 1, offsetY: -1 },
    { width: 2, height: 4, offsetX: 0, offsetY: 0 },
    { width: 5, height: 2, offsetX: 1, offsetY: 1 },
  ]) assert.throws(() => paddedCanvas(source, plan), RangeError);
});

test('paddedLayers includes hidden and locked layers while keeping order, metadata, IDs and pixels', () => {
  const doc = layeredDocument();
  const before = inspectDocument(doc);
  const source = snapshot(doc);
  const plan = planPadding(source, { ratioWidth: 4, ratioHeight: 3, margin: 2 });
  const result = paddedLayers(source, plan);
  assert.equal(result.length, 3);
  for (let i = 0; i < result.length; i++) {
    assert.deepEqual(layerMetadata(result[i]), layerMetadata(source.layers[i]));
    assert.notEqual(result[i], source.layers[i]);
    assert.notEqual(result[i].canvas, source.layers[i].canvas);
    verifyPadded(source.layers[i].canvas, result[i].canvas, plan);
  }
  assert.deepEqual(inspectDocument(doc), before, 'building padded layers does not modify the source document');
});

test('applyPaddingSnapshot is one real PaintDocument history step and undo/redo restore all dimensions, layer metadata and RGBA', () => {
  const doc = layeredDocument();
  const source = snapshot(doc);
  const before = inspectDocument(doc);
  const originalLayerCanvases = source.layers.map(layer => layer.canvas);
  const originalPixels = originalLayerCanvases.map(canvas => pixels(canvas).slice());
  const initialHistoryIndex = doc.historyIndex;
  const initialHistoryLength = doc.history.length;
  const initialRevision = doc.revision;
  doc.view = { fit: false };
  doc.isDemo = true;
  doc._composite = source.canvas;
  doc._thumb = source.canvas;
  const plan = planPadding(source, { mode: 'size', targetWidth: 15, targetHeight: 13, margin: 3 });
  assert.equal(applyPaddingSnapshot(doc, source, plan), doc);
  assert.equal(doc.historyIndex, initialHistoryIndex + 1);
  assert.equal(doc.history.length, initialHistoryLength + 1);
  assert.equal(doc.revision, initialRevision + 1);
  assert.equal(doc.activeLayerId, before.activeLayerId);
  assert.equal(doc.canUndo, true);
  assert.equal(doc.canRedo, false);
  assert.equal(doc.dirty, true);
  assert.equal(doc.view.fit, true);
  assert.equal(doc.isDemo, false);
  assert.equal(doc._composite, null);
  assert.equal(doc._thumb, null);
  for (let i = 0; i < doc.layers.length; i++) {
    assert.deepEqual(layerMetadata(doc.layers[i]), layerMetadata(source.layers[i]));
    verifyPadded(source.layers[i].canvas, doc.layers[i].canvas, plan);
    assert.deepEqual(pixels(originalLayerCanvases[i]), originalPixels[i], 'source snapshot remains reusable');
  }
  const padded = inspectDocument(doc);
  assert.equal(doc.undo(), true);
  assert.equal(doc.historyIndex, initialHistoryIndex);
  assert.deepEqual(inspectDocument(doc), before, 'one undo restores every original layer pixel and dimension');
  assert.equal(doc.canUndo, false, 'no hidden extra history entries were added');
  assert.equal(doc.canRedo, true);
  assert.equal(doc.redo(), true);
  assert.deepEqual(inspectDocument(doc), padded, 'one redo restores the complete padded state');
  assert.equal(doc.canRedo, false);
});

test('duplicateWithPadding creates fresh document and layer IDs without touching the source or its history', () => {
  const original = layeredDocument();
  const before = inspectDocument(original);
  const originalHistory = original.history;
  const originalHistoryIndex = original.historyIndex;
  const originalRevision = original.revision;
  const originalDirty = original.dirty;
  const originalCanvases = original.layers.map(layer => layer.canvas);
  const source = snapshot(original);
  const plan = planPadding(source, { ratioWidth: 2, ratioHeight: 1, margin: 2 });
  const duplicate = duplicateWithPadding(source, plan, '透明扩边副本.png');
  assert.ok(duplicate instanceof PaintDocument);
  assert.notEqual(duplicate.id, original.id);
  assert.equal(duplicate.name, '透明扩边副本.png');
  assert.equal(duplicate.width, plan.width);
  assert.equal(duplicate.height, plan.height);
  assert.equal(duplicate.layers.length, original.layers.length);
  const originalIds = new Set(original.layers.map(layer => layer.id));
  assert.equal(new Set(duplicate.layers.map(layer => layer.id)).size, duplicate.layers.length);
  for (let i = 0; i < duplicate.layers.length; i++) {
    assert.equal(originalIds.has(duplicate.layers[i].id), false, 'duplicated layer has a new ID');
    for (const key of metadataKeys.filter(key => key !== 'id')) {
      assert.equal(duplicate.layers[i][key], original.layers[i][key], `layer ${i} preserves ${key}`);
    }
    verifyPadded(original.layers[i].canvas, duplicate.layers[i].canvas, plan);
  }
  const originalActiveIndex = original.layers.findIndex(layer => layer.id === original.activeLayerId);
  assert.equal(duplicate.activeLayerId, duplicate.layers[originalActiveIndex].id, 'corresponding hidden active layer remains selected');
  assert.equal(duplicate.history.length, 1);
  assert.equal(duplicate.canUndo, false);
  assert.equal(duplicate.canRedo, false);
  assert.equal(duplicate.dirty, true);
  assert.deepEqual(inspectDocument(original), before);
  assert.equal(original.history, originalHistory);
  assert.equal(original.historyIndex, originalHistoryIndex);
  assert.equal(original.revision, originalRevision);
  assert.equal(original.dirty, originalDirty);
  original.layers.forEach((layer, i) => assert.equal(layer.canvas, originalCanvases[i]));
  duplicate.layers[0].canvas.getContext('2d').clearRect(0, 0, duplicate.width, duplicate.height);
  assert.deepEqual(inspectDocument(original), before, 'later edits to the duplicate cannot mutate source layer canvases');
});
