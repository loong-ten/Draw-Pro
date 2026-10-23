import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const canvasPath = require.resolve('@napi-rs/canvas', {
  paths: [process.cwd(), process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES].filter(Boolean),
});
const { createCanvas, ImageData } = require(canvasPath);
globalThis.ImageData = ImageData;
const allocated = [];
globalThis.document = {
  createElement(tag) {
    assert.equal(tag, 'canvas');
    const canvas = createCanvas(1, 1);
    allocated.push(canvas);
    return canvas;
  },
};

const { PaintDocument } = await import('../dist/core.js');
const { createSlicePlan } = await import('../dist/slice-core.js');
const { buildSliceDocuments } = await import('../dist/slice-raster.js');
const pixels = canvas => canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;

function sourceCanvas(width, height) {
  const canvas = createCanvas(width, height);
  const rgba = new Uint8ClampedArray(width * height * 4);
  const alphas = [0, 1, 2, 17, 64, 127, 128, 192, 254, 255];
  for (let index = 0; index < width * height; index++) {
    rgba[index * 4] = (index * 47 + 13) % 256;
    rgba[index * 4 + 1] = (index * 79 + 31) % 256;
    rgba[index * 4 + 2] = (index * 37 + 109) % 256;
    rgba[index * 4 + 3] = alphas[index % alphas.length];
  }
  canvas.getContext('2d').putImageData(new ImageData(rgba, width, height), 0, 0);
  return canvas;
}

function assertFramePixels(before, sourceWidth, sourceHeight, doc, rect) {
  assert.ok(doc instanceof PaintDocument);
  assert.equal(doc.width, rect.w);
  assert.equal(doc.height, rect.h);
  assert.equal(doc.layers.length, 1);
  const actual = pixels(doc.activeLayer.canvas);
  for (let y = 0; y < rect.h; y++) for (let x = 0; x < rect.w; x++) {
    const sourceX = rect.x + x, sourceY = rect.y + y;
    const inside = sourceX < sourceWidth && sourceY < sourceHeight;
    for (let channel = 0; channel < 4; channel++) {
      const expected = inside ? before[(sourceY * sourceWidth + sourceX) * 4 + channel] : 0;
      assert.equal(actual[(y * rect.w + x) * 4 + channel], expected,
        `frame r${rect.row} c${rect.column}: RGBA ${channel} at ${x},${y} is preserved`);
    }
  }
}

test('manual slicing preserves every native RGBA byte, including alpha 1, and reports ordered progress', async () => {
  const source = sourceCanvas(7, 5), before = pixels(source).slice();
  const plan = createSlicePlan(7, 5, { vLines: [0.5, 0.2, 0.499], hLines: [0.3, 0.7] });
  const progress = [];
  const documents = await buildSliceDocuments(source, plan, { name: '角色.png', onProgress: value => progress.push(value) });
  assert.equal(documents.length, plan.total);
  documents.forEach((doc, index) => assertFramePixels(before, 7, 5, doc, plan.rects[index]));
  assert.deepEqual(pixels(source), before);
  assert.equal(documents[0].name, '角色_切图_r01c01.png');
  assert.equal(documents.at(-1).name, `角色_切图_r03c04.png`);
  assert.deepEqual(progress.map(value => value.completed), Array.from({ length: plan.total + 1 }, (_, index) => index));
  assert.ok(progress.every(value => value.total === plan.total));
  assert.equal(progress[0].pixels, 0);
  assert.equal(progress.at(-1).pixels, 35);
  const originalAlphas = before.filter((_, index) => index % 4 === 3);
  for (const alpha of [0, 1, 2, 17, 64, 127, 128, 192, 254, 255]) assert.ok(originalAlphas.includes(alpha));
});

test('padded sprite frames retain source coordinates and keep right/bottom pixels and empty frames transparent', async () => {
  const source = sourceCanvas(5, 3), before = pixels(source).slice();
  const plan = createSlicePlan(5, 3, { mode: 'sprite', columns: 4, rows: 2, padFrames: true });
  const docs = await buildSliceDocuments(source, plan, { name: '动画.gif' });
  assert.equal(docs.length, 8);
  assert.equal(docs[0].name, '动画_帧_001_r01c01.png');
  assert.equal(docs[7].name, '动画_帧_008_r02c04.png');
  docs.forEach((doc, index) => assertFramePixels(before, 5, 3, doc, plan.rects[index]));
  assert.ok(pixels(docs[3].activeLayer.canvas).every(value => value === 0));
  assert.ok(pixels(docs[7].activeLayer.canvas).every(value => value === 0));
  assert.deepEqual(pixels(source), before);
});

test('each sliced document owns its pixels, IDs, and initial history; editing and undo are independent', async () => {
  const source = sourceCanvas(6, 4), before = pixels(source).slice();
  const plan = createSlicePlan(6, 4, { mode: 'sprite', rows: 2, columns: 3 });
  const docs = await buildSliceDocuments(source, plan);
  assert.equal(new Set(docs.map(doc => doc.id)).size, docs.length);
  assert.equal(new Set(docs.map(doc => doc.activeLayerId)).size, docs.length);
  assert.equal(new Set(docs.map(doc => doc.activeLayer.canvas)).size, docs.length);
  assert.equal(new Set(docs.map(doc => doc.history)).size, docs.length);
  assert.equal(new Set(docs.map(doc => doc.history[0].layers[0].pixels.data.buffer)).size, docs.length);
  for (const doc of docs) {
    assert.equal(doc.dirty, true);
    assert.equal(doc.isDemo, false);
    assert.equal(doc.revision, 1);
    assert.equal(doc.history.length, 1);
    assert.equal(doc.historyIndex, 0);
    assert.equal(doc.canUndo, false);
    assert.equal(doc.canRedo, false);
    assert.deepEqual(doc.history[0].layers[0].pixels.data, pixels(doc.activeLayer.canvas));
  }
  const originalFrames = docs.map(doc => pixels(doc.activeLayer.canvas).slice());
  const changed = docs[0], context = changed.activeLayer.canvas.getContext('2d');
  context.fillStyle = '#ff00ff';
  context.fillRect(0, 0, changed.width, changed.height);
  changed.commit('编辑第一帧');
  const edited = pixels(changed.activeLayer.canvas).slice();
  assert.notDeepEqual(edited, originalFrames[0]);
  assert.equal(changed.undo(), true);
  assert.deepEqual(pixels(changed.activeLayer.canvas), originalFrames[0]);
  assert.equal(changed.redo(), true);
  assert.deepEqual(pixels(changed.activeLayer.canvas), edited);
  docs.slice(1).forEach((doc, index) => assert.deepEqual(pixels(doc.activeLayer.canvas), originalFrames[index + 1]));
  assert.deepEqual(pixels(source), before);
  source.getContext('2d').clearRect(0, 0, 6, 4);
  docs.slice(1).forEach((doc, index) => assert.deepEqual(pixels(doc.activeLayer.canvas), originalFrames[index + 1]));
});

test('names are sanitized, preserve row/column numbering, and avoid existing names without mutating the name set', async () => {
  const source = sourceCanvas(2, 1), plan = createSlicePlan(2, 1, { vLines: [0.5] });
  const existing = new Set(['Hero_切图_r01c01.PNG', 'Hero_切图_r01c01 (2).png', 'hero_切图_r01c02.png']);
  const before = [...existing];
  const docs = await buildSliceDocuments(source, plan, { name: 'Hero.PNG', existingNames: existing });
  assert.deepEqual(docs.map(doc => doc.name), ['Hero_切图_r01c01 (3).png', 'Hero_切图_r01c02 (2).png']);
  assert.deepEqual([...existing], before);
  const safe = await buildSliceDocuments(source, plan, { name: ' ../hero:walk?.png ', existingNames: docs });
  assert.ok(safe.every(doc => !/[\\/:*?"<>|\u0000-\u001f]/.test(doc.name)));
  assert.ok(safe.every(doc => doc.name.endsWith('.png')));
});

test('pre-aborted and over-capacity builds allocate no documents', async () => {
  const source = sourceCanvas(11, 10), plan = createSlicePlan(11, 10, { mode: 'sprite', columns: 11, rows: 10 });
  const start = allocated.length;
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(buildSliceDocuments(source, plan, { signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(buildSliceDocuments(source, plan), /一次最多生成 100/);
  assert.equal(allocated.length, start);
});

test('cancellation after a completed frame releases every temporary canvas and returns no partial group', async () => {
  const source = sourceCanvas(6, 4), before = pixels(source).slice();
  const plan = createSlicePlan(6, 4, { mode: 'sprite', rows: 2, columns: 3 });
  const controller = new AbortController(), completed = [], start = allocated.length;
  await assert.rejects(buildSliceDocuments(source, plan, {
    signal: controller.signal,
    onProgress(progress) {
      completed.push(progress.completed);
      if (progress.completed === 2) controller.abort();
    },
  }), { name: 'AbortError' });
  assert.deepEqual(completed, [0, 1, 2]);
  const temporary = allocated.slice(start);
  assert.ok(temporary.length >= 2);
  assert.ok(temporary.every(canvas => canvas.width === 1 && canvas.height === 1));
  assert.deepEqual(pixels(source), before);
});

test('a failed progress callback also cleans all temporary canvases; final progress can still cancel atomically', async () => {
  const source = sourceCanvas(4, 2), before = pixels(source).slice();
  const plan = createSlicePlan(4, 2, { mode: 'sprite', columns: 2 });
  const start = allocated.length;
  await assert.rejects(buildSliceDocuments(source, plan, {
    onProgress({ completed }) { if (completed === 1) throw new Error('停止生成'); },
  }), /停止生成/);
  assert.ok(allocated.slice(start).every(canvas => canvas.width === 1 && canvas.height === 1));
  const controller = new AbortController(), finalStart = allocated.length;
  await assert.rejects(buildSliceDocuments(source, plan, {
    signal: controller.signal,
    onProgress({ completed, total }) { if (completed === total) controller.abort(); },
  }), { name: 'AbortError' });
  assert.ok(allocated.slice(finalStart).every(canvas => canvas.width === 1 && canvas.height === 1));
  assert.deepEqual(pixels(source), before);
});

test('stale source sizes, corrupt plans, and source budgets fail before canvas allocation', async () => {
  const source = sourceCanvas(4, 3), plan = createSlicePlan(4, 3, { vLines: [0.5] });
  const start = allocated.length;
  await assert.rejects(buildSliceDocuments(sourceCanvas(3, 3), plan), /源图尺寸已变化/);
  for (const mutate of [
    value => { value.rects[0].w++; },
    value => { value.rects[0].copyWidth--; },
    value => { value.rects[1].x = 1; },
    value => { value.outputWidth++; },
    value => { value.rects[1].row++; },
    value => { value.total = 1; },
    value => { value.rects[0].x = 0.5; },
  ]) {
    const invalid = structuredClone(plan);
    mutate(invalid);
    await assert.rejects(buildSliceDocuments(source, invalid), RangeError);
  }
  const overBudget = {
    ...plan, width: 8192, height: 8192,
    rects: [{ row: 0, column: 0, x: 0, y: 0, w: 8192, h: 8192, copyWidth: 8192, copyHeight: 8192 }],
    rows: 1, columns: 1, total: 1,
  };
  const fakeSource = { width: 8192, height: 8192, getContext() { throw new Error('must not allocate or read invalid source'); } };
  await assert.rejects(buildSliceDocuments(fakeSource, overBudget), /32 Mi/);
  assert.equal(allocated.length, start);
});

test('asynchronous progress cannot mutate the validated slice geometry or caller name reservations', async () => {
  const source = sourceCanvas(4, 2), before = pixels(source).slice();
  const plan = createSlicePlan(4, 2, { vLines: [0.5] });
  const rectangles = structuredClone(plan.rects), names = new Set();
  const docs = await buildSliceDocuments(source, plan, {
    name: '固定.png', existingNames: names,
    onProgress({ completed }) {
      if (completed === 0) {
        plan.rects[1].x = 0;
        plan.rects[0].w = 1;
        names.add('固定_切图_r01c01.png');
      }
    },
  });
  docs.forEach((doc, index) => assertFramePixels(before, 4, 2, doc, rectangles[index]));
  assert.equal(docs[0].name, '固定_切图_r01c01.png');
});
