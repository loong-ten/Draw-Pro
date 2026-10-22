import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { PaintDocument, makeCanvas, composite } from '../dist/core.js';
import { applyOptimizationResult, validateOptimizationTarget } from '../dist/optimization-result.js';

const require = createRequire(import.meta.url);
const nativePath = require.resolve('@napi-rs/canvas', {
  paths: [process.cwd(), process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES].filter(Boolean),
});
const { createCanvas, ImageData } = require(nativePath);
globalThis.ImageData = ImageData;
globalThis.document = {
  createElement(tag) {
    assert.equal(tag, 'canvas');
    return createCanvas(1, 1);
  },
};

const rgba = canvas => [...canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data];
const expected = doc => ({ revision: doc.revision, width: doc.width, height: doc.height, layerId: doc.activeLayerId });
function fixture(name, width = 4, height = 3, color = '#ee7733') {
  const d = new PaintDocument({ name, width, height });
  const ctx = d.layers[0].canvas.getContext('2d');
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, width - 1, height);
  d.path = `sprites/${name}`;
  d.fileHandle = { name, kind: 'file' };
  d.resetHistory('测试初始状态');
  d.dirty = false;
  return d;
}
function output(width, height, color) {
  const canvas = makeCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = color;
  ctx.fillRect(1, 0, width - 1, height);
  ctx.clearRect(0, 0, 1, 1);
  return canvas;
}
function snapshot(d) {
  return {
    layers: d.layers, layerObjects: [...d.layers], layerCanvases: d.layers.map(l => l.canvas),
    pixels: d.layers.map(l => rgba(l.canvas)),
    props: d.layers.map(({ id, name, visible, opacity, blend, locked }) => ({ id, name, visible, opacity, blend, locked })),
    activeLayerId: d.activeLayerId, history: d.history, historyEntries: [...d.history],
    historyIndex: d.historyIndex, revision: d.revision, dirty: d.dirty,
    composite: d._composite, thumb: d._thumb, isDemo: d.isDemo,
  };
}
function assertUntouched(d, before) {
  assert.strictEqual(d.layers, before.layers, 'Must retain the original layer array');
  for (let i = 0; i < before.layerObjects.length; i++) {
    assert.strictEqual(d.layers[i], before.layerObjects[i], 'Must retain each original layer object');
    assert.strictEqual(d.layers[i].canvas, before.layerCanvases[i], 'Must retain each original canvas');
    const { id, name, visible, opacity, blend, locked } = d.layers[i];
    assert.deepEqual({ id, name, visible, opacity, blend, locked }, before.props[i]);
    assert.deepEqual(rgba(d.layers[i].canvas), before.pixels[i]);
  }
  assert.strictEqual(d.history, before.history, 'Must restore the original history array');
  assert.deepEqual(d.history, before.historyEntries);
  for (const key of ['activeLayerId', 'historyIndex', 'revision', 'dirty', 'isDemo']) assert.equal(d[key], before[key], key);
  assert.strictEqual(d._composite, before.composite);
  assert.strictEqual(d._thumb, before.thumb);
}

test('three explicit documents apply in place, keep identity and dimensions, and each undo/redo once', () => {
  const documents = [fixture('红.png', 4, 3, '#ff0000'), fixture('绿.png', 5, 4, '#00ff00'), fixture('蓝.png', 6, 2, '#0000ff')];
  const identities = [...documents];
  const originals = documents.map(d => ({ pixels: rgba(composite(d)), name: d.name, path: d.path, handle: d.fileHandle, width: d.width, height: d.height, id: d.id, sourceId: d.layers[0].id, historyIndex: d.historyIndex }));
  const results = documents.map((d, i) => output(d.width, d.height, ['#00ffff', '#ffff00', '#ff00ff'][i]));
  // Deliberately process out of workspace order; no current-document global exists.
  for (const index of [2, 0, 1]) {
    const d = documents[index];
    const layer = applyOptimizationResult(d, results[index], { documents, expected: expected(d), label: `优化 ${index}` });
    assert.strictEqual(d.activeLayer, layer);
    assert.equal(d.layers.length, 2);
    assert.equal(d.layers[0].visible, false);
    assert.equal(d.layers[0].id, originals[index].sourceId);
    assert.equal(layer.opacity, 1);
    assert.equal(layer.blend, 'source-over');
    assert.deepEqual(rgba(composite(d)), rgba(results[index]), 'Output must belong to this explicit document');
    assert.equal(d.historyIndex, originals[index].historyIndex + 1);
    assert.equal(d.dirty, true);
  }
  assert.equal(documents.length, 3, 'Applying must not append a document');
  documents.forEach((d, index) => {
    assert.strictEqual(d, identities[index]);
    const original = originals[index];
    for (const key of ['name', 'path', 'width', 'height', 'id']) assert.equal(d[key], original[key]);
    assert.strictEqual(d.fileHandle, original.handle);
    assert.equal(d.undo(), true);
    assert.equal(d.layers.length, 1);
    assert.equal(d.layers[0].visible, true);
    assert.deepEqual(rgba(composite(d)), original.pixels);
    assert.equal(d.canUndo, false, 'The complete application must be one history step');
    assert.equal(d.redo(), true);
    assert.equal(d.layers.length, 2);
    assert.equal(d.layers[0].visible, false);
    assert.deepEqual(rgba(composite(d)), rgba(results[index]));
    assert.equal(d.canRedo, false);
  });
});

test('middle-layer identity application preserves multiply 65%, stack order and exact composited RGBA', () => {
  const d = fixture('混合图层.png', 4, 3, '#c0d0e0');
  const bottom = d.layers[0];
  const middle = d.addLayer('中间叠色');
  middle.canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray([
    255,0,0,128, 0,255,0,64, 0,0,255,255, 0,0,0,0,
    255,255,255,255, 0,0,0,0, 255,0,255,192, 0,0,0,0,
    0,0,0,0, 0,255,255,128, 255,255,0,255, 0,0,0,0,
  ]), 4, 3), 0, 0);
  middle.opacity = .65; middle.blend = 'multiply'; middle.locked = true;
  const top = d.addLayer('上方细节');
  top.canvas.getContext('2d').fillStyle = '#404080';
  top.canvas.getContext('2d').fillRect(1, 1, 2, 1);
  top.opacity = .4; top.blend = 'screen';
  d.activeLayerId = middle.id;
  d.resetHistory('三层混合');
  const before = rgba(composite(d));
  const result = applyOptimizationResult(d, middle.canvas, { documents: [d], expected: expected(d), sourceMode: 'layer' });
  assert.deepEqual(d.layers.map(l => l.id), [bottom.id, middle.id, result.id, top.id]);
  assert.strictEqual(d.layers[0], bottom);
  assert.strictEqual(d.layers[3], top);
  assert.equal(d.layers[1].visible, false);
  assert.equal(d.layers[1].locked, true);
  assert.equal(result.visible, true);
  assert.equal(result.opacity, .65);
  assert.equal(result.blend, 'multiply');
  assert.equal(result.locked, false);
  assert.deepEqual(rgba(result.canvas), rgba(middle.canvas));
  assert.deepEqual(rgba(composite(d)), before, 'Identity processing must not change layer blending or appearance');
  d.undo(); assert.deepEqual(d.layers.map(l => l.id), [bottom.id, middle.id, top.id]);
  assert.deepEqual(rgba(composite(d)), before);
  d.redo(); assert.deepEqual(rgba(composite(d)), before);
});

test('a hidden source layer stays hidden after single-layer application', () => {
  const d = fixture('隐藏.png');
  d.activeLayer.visible = false;
  d.activeLayer.opacity = .35;
  d.activeLayer.blend = 'overlay';
  d.resetHistory('隐藏源图层');
  const before = rgba(composite(d));
  const result = applyOptimizationResult(d, d.activeLayer.canvas, { documents: [d], expected: expected(d), sourceMode: 'layer' });
  assert.equal(result.visible, false);
  assert.equal(result.opacity, .35);
  assert.equal(result.blend, 'overlay');
  assert.deepEqual(rgba(composite(d)), before);
});

test('stale revision, resized target and changed active layer reject without touching source state', () => {
  const d = fixture('变更.png');
  const image = output(d.width, d.height, '#ffffff');
  const cases = [
    { value: { ...expected(d), revision: d.revision - 1 }, mode: 'composite' },
    { value: { ...expected(d), width: d.width + 1 }, mode: 'composite' },
    { value: { ...expected(d), height: d.height + 1 }, mode: 'composite' },
    { value: { ...expected(d), layerId: 'different-layer' }, mode: 'layer' },
  ];
  for (const entry of cases) {
    const before = snapshot(d);
    assert.throws(() => applyOptimizationResult(d, image, { documents: [d], expected: entry.value, sourceMode: entry.mode }), /处理期间已修改/);
    assertUntouched(d, before);
  }
});

test('reopening the same id as another document object rejects the old target', () => {
  const old = fixture('原对象.png');
  const reopened = new PaintDocument({ id: old.id, name: old.name, width: old.width, height: old.height });
  const beforeOld = snapshot(old), beforeReopened = snapshot(reopened);
  assert.throws(() => applyOptimizationResult(old, output(old.width, old.height, '#ffffff'), { documents: [reopened], expected: expected(old) }), /已关闭或工作区已切换/);
  assertUntouched(old, beforeOld);
  assertUntouched(reopened, beforeReopened);
});

test('50 layers and workspace pixel budget reject before hiding layers', () => {
  const full = fixture('满层.png', 1, 1);
  for (let i = 1; i < 50; i++) full.addLayer(`图层 ${i + 1}`);
  full.resetHistory('50 个图层');
  const beforeFull = snapshot(full);
  assert.throws(() => applyOptimizationResult(full, output(1, 1, '#fff'), { documents: [full], expected: expected(full) }), /50 个图层上限/);
  assertUntouched(full, beforeFull);

  const small = fixture('超预算.png', 2, 2);
  const beforeSmall = snapshot(small);
  // The budget calculation only needs dimensions and layer count. Avoid a
  // pointless half-gigabyte allocation while target canvases stay native.
  const budgetOccupant = { width: 8192, height: 4096, layers: [{}, {}, {}, {}] };
  assert.throws(() => applyOptimizationResult(small, output(2, 2, '#fff'), { documents: [small, budgetOccupant], expected: expected(small) }), /像素总量已达上限/);
  assertUntouched(small, beforeSmall);
});

test('100 existing documents do not prevent an in-place application', () => {
  const documents = Array.from({ length: 100 }, (_, i) => fixture(`${i}.png`, 1, 1));
  const target = documents[99];
  assert.doesNotThrow(() => validateOptimizationTarget(target, documents, expected(target)));
  applyOptimizationResult(target, output(1, 1, '#fff'), { documents, expected: expected(target) });
  assert.equal(documents.length, 100);
  assert.equal(target.layers.length, 2);
});

test('dimension mismatch rejects atomically', () => {
  const d = fixture('错误尺寸.png');
  const before = snapshot(d);
  assert.throws(() => applyOptimizationResult(d, makeCanvas(d.width + 1, d.height), { documents: [d], expected: expected(d) }), /尺寸与原画布不一致/);
  assertUntouched(d, before);
});

test('commit failure after real history mutation rolls back original object state', () => {
  for (const mode of ['composite', 'layer']) {
    const d = fixture(`提交失败-${mode}.png`);
    const upper = d.addLayer('第二层');
    upper.canvas.getContext('2d').fillStyle = '#00ffff';
    upper.canvas.getContext('2d').fillRect(1, 1, 2, 1);
    upper.blend = 'multiply'; upper.opacity = .65; upper.locked = true;
    d.resetHistory('异常测试基线');
    d.isDemo = true; d.dirty = false;
    d._composite = composite(d); d._thumb = 'cached-thumb';
    const before = snapshot(d);
    d.commit = function (label) {
      PaintDocument.prototype.commit.call(this, label);
      throw new Error('模拟提交异常');
    };
    assert.throws(() => applyOptimizationResult(d, output(d.width, d.height, '#ffff00'), { documents: [d], expected: expected(d), sourceMode: mode }), /模拟提交异常/);
    assertUntouched(d, before);
    assert.equal(d.history.length, 1);
    assert.equal(d.canUndo, false);
  }
});
