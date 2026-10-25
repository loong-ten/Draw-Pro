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
    operation: 'resize', algorithm: 'nearest', sizeMode: 'dimensions', resizeFit: 'stretch',
    width: 48, height: 48, contentWidth: 48, contentHeight: 48,
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
  for (const resizeFit of ['invalid', '', false, {}]) {
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

test('inside returns the actual proportional dimensions with no border, matching independent Pillow contain fixtures', () => {
  // Recorded from Pillow 12.3.0 ImageOps.contain(..., Resampling.NEAREST).
  const fixtures = [
    [5, 2, 5, 1, 2, 1], [7, 2, 5, 1, 4, 1], [3, 2, 8, 8, 8, 5],
    [17, 11, 13, 7, 11, 7], [11, 17, 7, 13, 7, 11],
    [9, 5, 5, 5, 5, 3], [5, 9, 5, 5, 3, 5], [7, 5, 10, 10, 10, 7],
  ];
  for (const [width, height, resizeWidth, resizeHeight, expectedWidth, expectedHeight] of fixtures) {
    const source = Object.freeze({ width, height });
    const options = Object.freeze({ mode: 'resize', resizeFit: 'inside', resizeWidth, resizeHeight });
    const plan = planPadding(source, options);
    assert.deepEqual([plan.width, plan.height, plan.contentWidth, plan.contentHeight],
      [expectedWidth, expectedHeight, expectedWidth, expectedHeight]);
    assert.deepEqual([plan.offsetX, plan.offsetY, plan.left, plan.right, plan.top, plan.bottom], [0, 0, 0, 0, 0, 0]);
    assert.deepEqual([plan.centerX, plan.centerY, plan.scaleX, plan.scaleY],
      [width / 2, height / 2, expectedWidth / width, expectedHeight / height]);
    assert.equal('sourceRect' in plan, false);
  }
  const narrow = planPadding({ width: 8192, height: 1 }, {
    mode: 'resize', resizeFit: 'inside', resizeWidth: 8192, resizeHeight: 8192,
  });
  assert.deepEqual([narrow.width, narrow.height], [8192, 1], 'only the actual output consumes the pixel budget');
  assert.equal(narrow.changed, false);
});

test('cover plans centered source-coordinate crops across parity and extreme aspect ratios without an intermediate canvas', () => {
  const fixtures = [
    [7, 3, 4, 4, { x: 2, y: 0, width: 3, height: 3 }],
    [5, 2, 3, 4, { x: 1.75, y: 0, width: 1.5, height: 2 }],
    [3, 5, 4, 3, { x: 0, y: 1.375, width: 3, height: 2.25 }],
    [7, 4, 5, 5, { x: 1.5, y: 0, width: 4, height: 4 }],
    [4, 7, 5, 5, { x: 0, y: 1.5, width: 4, height: 4 }],
    [4, 3, 8, 6, { x: 0, y: 0, width: 4, height: 3 }],
    [8192, 1, 1, 8192, { x: 4096 - 1 / 16384, y: 0, width: 1 / 8192, height: 1 }],
    [1, 8192, 8192, 1, { x: 0, y: 4096 - 1 / 16384, width: 1, height: 1 / 8192 }],
  ];
  for (const [width, height, resizeWidth, resizeHeight, crop] of fixtures) {
    const plan = planPadding({ width, height, bounds: { x: 0, y: 0, width: 1, height: 1 } }, {
      mode: 'resize', resizeFit: 'cover', resizeWidth, resizeHeight, center: 'content', margin: 9999,
    });
    assert.deepEqual(plan.sourceRect, crop);
    assert.deepEqual([plan.width, plan.height, plan.contentWidth, plan.contentHeight],
      [resizeWidth, resizeHeight, resizeWidth, resizeHeight]);
    assert.deepEqual([plan.offsetX, plan.offsetY, plan.left, plan.right, plan.top, plan.bottom], [0, 0, 0, 0, 0, 0]);
    assert.equal(plan.scaleX, resizeWidth / crop.width); assert.equal(plan.scaleY, resizeHeight / crop.height);
    assert.ok(Math.abs(plan.scaleX - plan.scaleY) <= 1e-12, 'cover has one proportional scale');
    assert.equal(crop.x + crop.width / 2, width / 2); assert.equal(crop.y + crop.height / 2, height / 2);
    assert.ok(crop.width > 0 && crop.height > 0 && crop.x >= 0 && crop.y >= 0);
    assert.ok(crop.x + crop.width <= width && crop.y + crop.height <= height);
    assert.equal(plan.changed, true);
  }
  const identity = planPadding({ width: 7, height: 5 }, {
    mode: 'resize', resizeFit: 'cover', resizeWidth: 7, resizeHeight: 5,
  });
  assert.equal(identity.changed, false);
  assert.deepEqual(identity.sourceRect, { x: 0, y: 0, width: 7, height: 5 });
});

test('percent operates on each source independently and preserves ties-to-even at half pixels', () => {
  // Recorded independently from Pillow 12.3.0 ImageOps.scale for these inputs.
  const fixtures = [
    [5, 7, 50, 2, 4], [7, 5, 50, 4, 2], [641, 479, 33.3, 213, 160],
    [12, 9, 125, 15, 11], [3, 5, 150, 4, 8], [17, 11, 200, 34, 22],
  ];
  for (const [width, height, resizePercent, expectedWidth, expectedHeight] of fixtures) {
    const plan = planPadding({ width, height }, { mode: 'resize', resizeSizeMode: 'percent', resizePercent });
    assert.deepEqual([plan.width, plan.height], [expectedWidth, expectedHeight]);
    assert.deepEqual([plan.contentWidth, plan.contentHeight], [expectedWidth, expectedHeight]);
    assert.deepEqual([plan.left, plan.right, plan.top, plan.bottom], [0, 0, 0, 0]);
    assert.equal(plan.scaleX, expectedWidth / width); assert.equal(plan.scaleY, expectedHeight / height);
  }
  const defaults = planPadding({ width: 17, height: 11 }, { mode: 'resize', resizeSizeMode: 'percent' });
  assert.deepEqual([defaults.width, defaults.height, defaults.changed], [17, 11, false]);
  const tiny = planPadding({ width: 8, height: 3 }, { mode: 'resize', resizeSizeMode: 'percent', resizePercent: 0.1 });
  assert.deepEqual([tiny.width, tiny.height], [1, 1], 'a tiny percentage cannot create a zero-sized canvas');
});

test('single-edge and longest-edge modes honor their exact edge and independently round the proportional edge', () => {
  const fixtures = [
    [2, 5, 'width', 1, 1, 2], [2, 7, 'width', 1, 1, 4],
    [5, 2, 'height', 1, 2, 1], [7, 2, 'height', 1, 4, 1],
    [7, 5, 'width', 10, 10, 7], [5, 7, 'height', 10, 7, 10],
    [11, 7, 'long-edge', 6, 6, 4], [7, 11, 'long-edge', 6, 4, 6],
    [9, 9, 'long-edge', 6, 6, 6], [8192, 1, 'long-edge', 1, 1, 1],
    [1, 8192, 'long-edge', 1, 1, 1],
  ];
  for (const [width, height, resizeSizeMode, value, expectedWidth, expectedHeight] of fixtures) {
    const key = { width: 'resizeWidth', height: 'resizeHeight', 'long-edge': 'resizeLongEdge' }[resizeSizeMode];
    const plan = planPadding({ width, height }, { mode: 'resize', resizeSizeMode, [key]: value });
    assert.deepEqual([plan.width, plan.height, plan.contentWidth, plan.contentHeight],
      [expectedWidth, expectedHeight, expectedWidth, expectedHeight]);
    assert.deepEqual([plan.offsetX, plan.offsetY, plan.left, plan.right, plan.top, plan.bottom], [0, 0, 0, 0, 0, 0]);
    assert.equal('sourceRect' in plan, false);
  }
  const defaults = planPadding({ width: 640, height: 480 }, { mode: 'resize', resizeSizeMode: 'long-edge' });
  assert.deepEqual([defaults.width, defaults.height], [256, 192]);
  for (const [resizeSizeMode, key, value] of [['width', 'resizeWidth', 7], ['height', 'resizeHeight', 5], ['long-edge', 'resizeLongEdge', 7]]) {
    assert.equal(planPadding({ width: 7, height: 5 }, { mode: 'resize', resizeSizeMode, [key]: value }).changed, false);
  }
});

test('inactive fit and size controls do not affect proportional modes, while every supported algorithm is preserved', () => {
  const source = { width: 6, height: 4 };
  for (const resizeSizeMode of ['percent', 'width', 'height', 'long-edge']) {
    const baseline = { mode: 'resize', resizeSizeMode };
    const unused = { resizeFit: 'invalid-but-inactive' };
    if (resizeSizeMode !== 'width') unused.resizeWidth = NaN;
    if (resizeSizeMode !== 'height') unused.resizeHeight = -8;
    if (resizeSizeMode !== 'percent') unused.resizePercent = Infinity;
    if (resizeSizeMode !== 'long-edge') unused.resizeLongEdge = 'invalid';
    assert.deepEqual(planPadding(source, { ...baseline, ...unused }), planPadding(source, baseline));
    assert.equal(planPadding(source, baseline).resizeFit, 'inside');
  }
  for (const resizeAlgorithm of ['nearest', 'bilinear', 'bicubic', 'lanczos3', 'area']) {
    const plan = planPadding(source, { mode: 'resize', resizeAlgorithm });
    assert.equal(plan.algorithm, resizeAlgorithm);
    assert.deepEqual([plan.width, plan.height], [48, 48]);
  }
});

test('new size modes validate active inputs and reject final dimensions or areas beyond the existing limits', () => {
  const source = { width: 3, height: 2 };
  for (const resizeSizeMode of ['', 'scale', false, 1, {}]) {
    assert.throws(() => planPadding(source, { mode: 'resize', resizeSizeMode }), RangeError);
  }
  for (const resizeAlgorithm of ['', 'smooth', 'lanczos', false, 1, {}]) {
    assert.throws(() => planPadding(source, { mode: 'resize', resizeAlgorithm }), RangeError);
  }
  for (const resizePercent of [NaN, Infinity, -Infinity, 0, -1, 0.099, 3200.001, '100', true]) {
    assert.throws(() => planPadding(source, { mode: 'resize', resizeSizeMode: 'percent', resizePercent }), RangeError);
  }
  for (const [resizeSizeMode, key] of [['width', 'resizeWidth'], ['height', 'resizeHeight'], ['long-edge', 'resizeLongEdge']]) {
    for (const value of [NaN, Infinity, 0, -1, 1.5, 8193, '48', true]) {
      assert.throws(() => planPadding(source, { mode: 'resize', resizeSizeMode, [key]: value }), RangeError);
    }
  }
  const oversized = [
    [{ width: 1, height: 8192 }, { resizeSizeMode: 'width', resizeWidth: 2 }],
    [{ width: 8192, height: 1 }, { resizeSizeMode: 'height', resizeHeight: 2 }],
    [{ width: 257, height: 1 }, { resizeSizeMode: 'percent', resizePercent: 3200 }],
    [{ width: 256, height: 129 }, { resizeSizeMode: 'percent', resizePercent: 3200 }],
    [{ width: 1, height: 1 }, { resizeSizeMode: 'long-edge', resizeLongEdge: 8192 }],
    [{ width: 1, height: 1 }, { resizeFit: 'inside', resizeWidth: 8192, resizeHeight: 8192 }],
    [{ width: 1, height: 1 }, { resizeFit: 'cover', resizeWidth: 8192, resizeHeight: 4097 }],
  ];
  for (const [input, options] of oversized) assert.throws(() => planPadding(input, { mode: 'resize', ...options }), RangeError);
  const limits = [
    [{ width: 256, height: 128 }, { resizeSizeMode: 'percent', resizePercent: 3200 }],
    [{ width: 2, height: 1 }, { resizeSizeMode: 'width', resizeWidth: 8192 }],
    [{ width: 2, height: 1 }, { resizeSizeMode: 'long-edge', resizeLongEdge: 8192 }],
    [{ width: 1, height: 1 }, { resizeFit: 'cover', resizeWidth: 8192, resizeHeight: 4096 }],
  ];
  for (const [input, options] of limits) {
    const plan = planPadding(input, { mode: 'resize', ...options });
    assert.deepEqual([plan.width, plan.height], [8192, 4096]);
  }
});

test('pure padding modes completely ignore resize geometry and algorithm options', () => {
  const source = { width: 7, height: 5, bounds: { x: 1, y: 1, width: 3, height: 2 } };
  const unrelated = { resizeSizeMode: 'invalid', resizeFit: false, resizeAlgorithm: 'invalid',
    resizeWidth: NaN, resizeHeight: Infinity, resizePercent: -1, resizeLongEdge: 'bad' };
  for (const options of [
    { mode: 'ratio', ratioWidth: 4, ratioHeight: 3, margin: 2 },
    { mode: 'scale', scale: 2, margin: 1 },
    { mode: 'size', targetWidth: 20, targetHeight: 16, center: 'canvas' },
  ]) {
    const oldPlan = planPadding(source, options);
    assert.deepEqual(planPadding(source, { ...options, ...unrelated }), oldPlan);
    assert.equal('algorithm' in oldPlan, false); assert.equal('sourceRect' in oldPlan, false);
  }
});
