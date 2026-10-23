import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { planPadding } from '../dist/padding-core.js';

// Native pixel buffers/PNG raster model, with only canvas creation adapted to Node.
const require = createRequire(import.meta.url);
const canvasPath = require.resolve('@napi-rs/canvas', {
  paths: [process.cwd(), process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES].filter(Boolean),
});
const { createCanvas, ImageData } = require(canvasPath);
globalThis.ImageData = ImageData;
globalThis.document = {
  createElement(tag) {
    assert.equal(tag, 'canvas');
    return createCanvas(1, 1);
  },
};
const { PaintDocument, makeCanvas } = await import('../dist/core.js');
const { paddedCanvas, paddedLayers, applyPaddingSnapshot, duplicateWithPadding } = await import('../dist/padding-raster.js');
const rgba = canvas => canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
const metadataKeys = ['id', 'name', 'visible', 'locked', 'opacity', 'blend'];
const metadata = layer => Object.fromEntries(metadataKeys.map(key => [key, layer[key]]));
const stateOf = doc => ({
  id: doc.id, name: doc.name, width: doc.width, height: doc.height, activeLayerId: doc.activeLayerId,
  layers: doc.layers.map(layer => ({ ...metadata(layer), rgba: [...rgba(layer.canvas)] })),
});

function fill(canvas, seed = 0, opaque = false) {
  const data = new Uint8ClampedArray(canvas.width * canvas.height * 4);
  const alphas = [0, 1, 17, 64, 127, 128, 192, 254, 255];
  for (let i = 0; i < data.length / 4; i++) {
    data[i * 4] = (i * 47 + 23 + seed) % 256;
    data[i * 4 + 1] = (i * 79 + 41 + seed) % 256;
    data[i * 4 + 2] = (i * 31 + 67 + seed) % 256;
    data[i * 4 + 3] = opaque ? 255 : alphas[(i + seed) % alphas.length];
  }
  canvas.getContext('2d').putImageData(new ImageData(data, canvas.width, canvas.height), 0, 0);
}

// Maps below are fixtures obtained from Pillow 12.3.0 RGBA + Resampling.NEAREST,
// not copies of the implementation under test. Every border RGBA byte is checked.
function verifyPixels(source, result, plan, mapX, mapY) {
  assert.equal(result.width, plan.width);
  assert.equal(result.height, plan.height);
  assert.equal(mapX.length, plan.contentWidth);
  assert.equal(mapY.length, plan.contentHeight);
  const before = rgba(source), after = rgba(result);
  for (let y = 0; y < plan.height; y++) for (let x = 0; x < plan.width; x++) {
    const localX = x - plan.offsetX, localY = y - plan.offsetY;
    const inside = localX >= 0 && localX < mapX.length && localY >= 0 && localY < mapY.length;
    const input = inside ? (mapY[localY] * source.width + mapX[localX]) * 4 : -1;
    for (let channel = 0; channel < 4; channel++) {
      assert.equal(after[(y * plan.width + x) * 4 + channel], inside ? before[input + channel] : 0,
        `pixel (${x}, ${y}), channel ${channel}`);
    }
  }
}

function layeredDocument() {
  const doc = new PaintDocument({ name: '多图层缩放.png', width: 3, height: 2 });
  fill(doc.layers[0].canvas, 0);
  doc.layers[0].opacity = 0.9;
  const hidden = doc.addLayer('隐藏锁定层');
  hidden.visible = false; hidden.locked = true; hidden.opacity = 0.37; hidden.blend = 'multiply';
  fill(hidden.canvas, 1);
  const upper = doc.addLayer('高光');
  upper.locked = true; upper.opacity = 0.65; upper.blend = 'screen';
  fill(upper.canvas, 2);
  doc.activeLayerId = hidden.id;
  doc.resetHistory('完整原图');
  doc.dirty = false;
  return doc;
}

const snapshot = doc => ({
  width: doc.width, height: doc.height, bounds: null, activeLayerId: doc.activeLayerId,
  layers: doc.layers.map(layer => ({ ...layer })),
});

test('resize defaults to 48 × 48 stretch, ignores padding controls, and reports actual scale', () => {
  const source = { width: 8, height: 3, bounds: { x: 0, y: 0, width: 1, height: 1 } };
  const plan = planPadding(source, { mode: 'resize', center: 'invalid', margin: 'ignored' });
  assert.deepEqual(plan, {
    operation: 'resize', width: 48, height: 48, contentWidth: 48, contentHeight: 48,
    scaleX: 6, scaleY: 16, offsetX: 0, offsetY: 0, left: 0, right: 0, top: 0, bottom: 0,
    centerX: 4, centerY: 1.5, empty: false, changed: true, minWidth: 1, minHeight: 1,
  });
  const smaller = planPadding(source, { mode: 'resize', resizeWidth: 2, resizeHeight: 9 });
  assert.deepEqual([smaller.contentWidth, smaller.contentHeight, smaller.scaleX, smaller.scaleY], [2, 9, 0.25, 3]);
  for (const resizeFit of ['stretch', 'contain']) {
    assert.equal(planPadding(source, { mode: 'resize', resizeWidth: 8, resizeHeight: 3, resizeFit }).changed, false);
  }
});

test('contain follows Python ties-to-even, clamps tiny content, and gives odd extra padding to right/bottom', () => {
  const resize = (width, height, targetWidth, targetHeight) => planPadding({ width, height }, {
    mode: 'resize', resizeWidth: targetWidth, resizeHeight: targetHeight, resizeFit: 'contain',
  });
  const down = resize(5, 2, 5, 1); // 5 * 0.5 = 2.5 -> 2, not Math.round's 3.
  assert.deepEqual([down.contentWidth, down.contentHeight, down.left, down.right], [2, 1, 1, 2]);
  const upTie = resize(7, 2, 5, 1); // 7 * 0.5 = 3.5 -> 4.
  assert.deepEqual([upTie.contentWidth, upTie.contentHeight, upTie.left, upTie.right], [4, 1, 0, 1]);
  const vertical = resize(2, 5, 1, 5);
  assert.deepEqual([vertical.contentWidth, vertical.contentHeight, vertical.top, vertical.bottom], [1, 2, 1, 2]);
  const enlarge = resize(3, 2, 8, 8);
  assert.deepEqual([enlarge.contentWidth, enlarge.contentHeight, enlarge.top, enlarge.bottom], [8, 5, 1, 2]);
  assert.equal(enlarge.scaleY, 2.5, 'scale metadata describes rounded raster size');
  const tiny = resize(8192, 1, 1, 1);
  assert.deepEqual([tiny.contentWidth, tiny.contentHeight], [1, 1], 'rounded zero is clamped to one pixel');
  const exact = resize(6, 4, 3, 2);
  assert.deepEqual([exact.left, exact.right, exact.top, exact.bottom], [0, 0, 0, 0]);
});

test('invalid resize parameters and oversized target canvases are rejected before allocation', () => {
  for (const key of ['resizeWidth', 'resizeHeight']) {
    for (const value of [NaN, Infinity, -Infinity, 0, -1, 0.5, 8193, '48', true]) {
      assert.throws(() => planPadding({ width: 3, height: 2 }, { mode: 'resize', [key]: value }), RangeError);
    }
  }
  for (const resizeFit of ['cover', '', false, {}]) {
    assert.throws(() => planPadding({ width: 3, height: 2 }, { mode: 'resize', resizeFit }), RangeError);
  }
  assert.throws(() => planPadding({ width: 3, height: 2 }, {
    mode: 'resize', resizeWidth: 8192, resizeHeight: 8192,
  }), RangeError);
  const boundary = planPadding({ width: 1, height: 1 }, { mode: 'resize', resizeWidth: 8192, resizeHeight: 4096 });
  assert.deepEqual([boundary.width, boundary.height], [8192, 4096]);
  const source = makeCanvas(3, 2);
  for (const change of [
    { contentWidth: 0 }, { contentHeight: 1.5 }, { contentWidth: 9 },
    { offsetX: -1 }, { offsetY: 0.5 }, { width: 7.5 },
  ]) {
    assert.throws(() => paddedCanvas(source, {
      operation: 'resize', width: 8, height: 8, contentWidth: 8, contentHeight: 5, offsetX: 0, offsetY: 1, ...change,
    }), RangeError);
  }
});

test('stretch uses Pillow nearest sampling at floating boundaries on both axes, including shrink', () => {
  const cases = [
    [4, 2, 7, 7, [0, 0, 1, 1, 2, 3, 3], [0, 0, 0, 0, 1, 1, 1]],
    [7, 5, 4, 3, [0, 2, 4, 6], [0, 2, 4]],
    [4, 5, 3, 4, [0, 2, 3], [0, 1, 3, 4]],
    [1, 1, 3, 5, [0, 0, 0], [0, 0, 0, 0, 0]],
  ];
  for (const [width, height, resizeWidth, resizeHeight, mapX, mapY] of cases) {
    const source = makeCanvas(width, height);
    fill(source, 0, true);
    const before = rgba(source).slice();
    const plan = planPadding(source, { mode: 'resize', resizeWidth, resizeHeight });
    const output = paddedCanvas(source, plan);
    verifyPixels(source, output, plan, mapX, mapY);
    assert.deepEqual(rgba(source), before, 'source raster is unchanged');
  }
});

test('nearest copies every observed RGBA byte including low alpha, and contain leaves exact transparent borders', () => {
  const source = makeCanvas(3, 3);
  fill(source);
  const original = rgba(source).slice();
  for (const alpha of [0, 1, 17, 64, 127, 128, 192, 254, 255]) {
    assert.ok(original.some((value, index) => index % 4 === 3 && value === alpha));
  }
  const doubled = planPadding(source, { mode: 'resize', resizeWidth: 6, resizeHeight: 6 });
  verifyPixels(source, paddedCanvas(source, doubled), doubled, [0, 0, 1, 1, 2, 2], [0, 0, 1, 1, 2, 2]);
  const contained = planPadding(source, { mode: 'resize', resizeWidth: 10, resizeHeight: 7, resizeFit: 'contain' });
  assert.deepEqual([contained.left, contained.right, contained.top, contained.bottom], [1, 2, 0, 0]);
  verifyPixels(source, paddedCanvas(source, contained), contained, [0, 0, 1, 1, 1, 2, 2], [0, 0, 1, 1, 1, 2, 2]);
  assert.deepEqual(rgba(source), original);
  const empty = makeCanvas(3, 2);
  const emptyPlan = planPadding(empty, { mode: 'resize', resizeWidth: 8, resizeHeight: 8, resizeFit: 'contain' });
  assert.ok(rgba(paddedCanvas(empty, emptyPlan)).every(channel => channel === 0));
});

test('resize keeps hidden/locked layer order and metadata, applies one history step, and undo/redo restores all RGBA', () => {
  const doc = layeredDocument();
  const before = stateOf(doc), source = snapshot(doc);
  const initialRevision = doc.revision;
  const plan = planPadding(source, { mode: 'resize', resizeWidth: 8, resizeHeight: 8, resizeFit: 'contain' });
  const prepared = paddedLayers(source, plan);
  assert.equal(prepared.length, source.layers.length);
  prepared.forEach((layer, index) => {
    assert.deepEqual(metadata(layer), metadata(source.layers[index]));
    assert.notEqual(layer.canvas, source.layers[index].canvas);
    verifyPixels(source.layers[index].canvas, layer.canvas, plan, [0, 0, 0, 1, 1, 2, 2, 2], [0, 0, 1, 1, 1]);
  });
  assert.deepEqual(stateOf(doc), before, 'preparing results does not mutate original layers');
  applyPaddingSnapshot(doc, source, plan);
  assert.equal(doc.history.length, 2);
  assert.equal(doc.historyIndex, 1);
  assert.equal(doc.revision, initialRevision + 1);
  assert.equal(doc.history[1].label, '宽高缩放 · 8 × 8');
  assert.equal(doc.id, before.id);
  assert.equal(doc.name, before.name);
  assert.equal(doc.activeLayerId, before.activeLayerId);
  doc.layers.forEach((layer, index) => {
    assert.deepEqual(metadata(layer), metadata(source.layers[index]));
    assert.deepEqual(rgba(layer.canvas), rgba(prepared[index].canvas));
  });
  const after = stateOf(doc);
  assert.equal(doc.undo(), true);
  assert.deepEqual(stateOf(doc), before);
  assert.equal(doc.canUndo, false);
  assert.equal(doc.redo(), true);
  assert.deepEqual(stateOf(doc), after);
});

test('resize duplicate has fresh IDs, retains all layer attributes, and cannot mutate its source', () => {
  const original = layeredDocument(), before = stateOf(original), source = snapshot(original);
  const history = original.history;
  const plan = planPadding(source, { mode: 'resize', resizeWidth: 2, resizeHeight: 3 });
  const duplicate = duplicateWithPadding(source, plan, '缩放副本.png');
  assert.notEqual(duplicate.id, original.id);
  assert.equal(duplicate.name, '缩放副本.png');
  assert.equal(duplicate.history.length, 1);
  assert.equal(duplicate.history[0].label, '创建宽高缩放副本');
  assert.equal(duplicate.canUndo, false);
  assert.equal(duplicate.dirty, true);
  duplicate.layers.forEach((layer, index) => {
    assert.notEqual(layer.id, original.layers[index].id);
    for (const key of metadataKeys.filter(key => key !== 'id')) assert.equal(layer[key], original.layers[index][key]);
    verifyPixels(original.layers[index].canvas, layer.canvas, plan, [0, 2], [0, 1, 1]);
  });
  assert.equal(duplicate.activeLayerId, duplicate.layers[1].id);
  assert.deepEqual(stateOf(original), before);
  assert.equal(original.history, history);
  duplicate.layers[0].canvas.getContext('2d').clearRect(0, 0, duplicate.width, duplicate.height);
  assert.deepEqual(stateOf(original), before);
});

test('resize rolls back original document and history references if commit fails', () => {
  const doc = layeredDocument(), before = stateOf(doc), source = snapshot(doc);
  const references = {
    layers: doc.layers, history: doc.history, historyIndex: doc.historyIndex,
    revision: doc.revision, dirty: doc.dirty,
  };
  const commit = doc.commit;
  doc.commit = function(label) { commit.call(this, label); throw new Error('test commit failure'); };
  const plan = planPadding(source, { mode: 'resize', resizeWidth: 8, resizeHeight: 8 });
  assert.throws(() => applyPaddingSnapshot(doc, source, plan), /test commit failure/);
  assert.deepEqual(stateOf(doc), before);
  for (const [key, value] of Object.entries(references)) assert.equal(doc[key], value, `${key} rolled back`);
});
