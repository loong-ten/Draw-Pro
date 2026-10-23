import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SLICE_LIMITS, defaultSliceOptions, normalizeSliceOptions,
  createSlicePlan, addCutLine, evenCutLines,
} from '../dist/slice-core.js';

function assertCompleteCoverage(plan) {
  const visits = new Uint8Array(plan.outputWidth * plan.outputHeight);
  for (const [index, rect] of plan.rects.entries()) {
    assert.equal(rect.row, Math.floor(index / plan.columns));
    assert.equal(rect.column, index % plan.columns);
    for (const key of ['x', 'y', 'w', 'h', 'copyWidth', 'copyHeight']) assert.ok(Number.isInteger(rect[key]));
    assert.ok(rect.w > 0 && rect.h > 0);
    for (let y = rect.y; y < rect.y + rect.h; y++) {
      for (let x = rect.x; x < rect.x + rect.w; x++) {
        assert.ok(x >= 0 && y >= 0 && x < plan.outputWidth && y < plan.outputHeight);
        visits[y * plan.outputWidth + x]++;
      }
    }
    assert.equal(rect.copyWidth, Math.max(0, Math.min(rect.w, plan.width - rect.x)));
    assert.equal(rect.copyHeight, Math.max(0, Math.min(rect.h, plan.height - rect.y)));
  }
  assert.ok(visits.every(value => value === 1), 'every source and padded output pixel is covered exactly once');
  assert.equal(plan.rects.reduce((sum, rect) => sum + rect.w * rect.h, 0), plan.outputPixels);
}

test('slice defaults and normalized options are fresh, sorted, and validated without mutating input', () => {
  const first = defaultSliceOptions(), second = defaultSliceOptions();
  first.vLines.push(0.5);
  assert.deepEqual(second, { mode: 'manual', vLines: [], hLines: [], rows: 1, columns: 1, padFrames: false });
  const input = { vLines: [1, 0.4, 0, 0.4, 0.2], hLines: [0.75, 0.25], rows: 4, columns: 4 };
  const before = structuredClone(input);
  const normalized = normalizeSliceOptions(input, 1, 1);
  assert.deepEqual(normalized.vLines, [0, 0.2, 0.4, 1]);
  assert.deepEqual(normalized.hLines, [0.25, 0.75]);
  assert.deepEqual(input, before);
  normalized.vLines.push(0.9);
  assert.deepEqual(input, before);
  assert.throws(() => normalizeSliceOptions({ ...input, mode: 'sprite' }, 1, 1), /不能超过源图/);
  // Holding non-divisible settings is allowed; geometry creation supplies the error.
  assert.equal(normalizeSliceOptions({ mode: 'sprite', columns: 2 }, 3, 2).columns, 2);
});

test('manual cuts round to integer edges, collapse duplicates, and cover uneven source dimensions', () => {
  const plan = createSlicePlan(7, 5, {
    vLines: [1, 0.5, 0, 0.499, 0.01, 0.99, 0.2],
    hLines: [0, 0.1, 0.499, 0.5, 0.99, 1],
  });
  assert.deepEqual(plan.xEdges, [0, 1, 3, 4, 7]);
  assert.deepEqual(plan.yEdges, [0, 1, 2, 3, 5]);
  assert.equal(plan.total, 16);
  assert.equal(plan.frameWidth, null);
  assert.equal(plan.frameHeight, null);
  assert.deepEqual([plan.paddedX, plan.paddedY], [0, 0]);
  assertCompleteCoverage(plan);
  const tiny = createSlicePlan(1, 1, { vLines: evenCutLines(40), hLines: evenCutLines(40) });
  assert.equal(tiny.total, 1);
  assert.deepEqual(tiny.rects, [{ row: 0, column: 0, x: 0, y: 0, w: 1, h: 1, copyWidth: 1, copyHeight: 1 }]);
  assertCompleteCoverage(tiny);
});

test('manual edge quantization retains all pixels across small odd and even source sizes', () => {
  for (let width = 1; width <= 17; width++) {
    for (let height = 1; height <= 13; height++) {
      assertCompleteCoverage(createSlicePlan(width, height, {
        vLines: [0, 0.001, 0.17, 0.333, 0.5, 0.501, 0.9, 0.999, 1],
        hLines: [0.01, 0.25, 0.5001, 0.75, 0.99],
      }));
    }
  }
});

test('sprite mode creates equal frames without rescaling and explains indivisible dimensions', () => {
  const plan = createSlicePlan(12, 6, { mode: 'sprite', columns: 4, rows: 3 });
  assert.deepEqual([plan.frameWidth, plan.frameHeight, plan.rows, plan.columns, plan.total], [3, 2, 3, 4, 12]);
  assert.deepEqual([plan.outputWidth, plan.outputHeight, plan.paddedX, plan.paddedY], [12, 6, 0, 0]);
  assertCompleteCoverage(plan);
  assert.throws(() => createSlicePlan(11, 6, { mode: 'sprite', columns: 4, rows: 3 }), /不能被.*整除.*透明/);
  assert.throws(() => createSlicePlan(12, 7, { mode: 'sprite', columns: 4, rows: 3 }), /不能被.*整除/);
  assert.throws(() => createSlicePlan(2, 2, { mode: 'sprite', columns: 3, padFrames: true }), /不能超过源图/);
});

test('sprite padding extends only right and bottom, keeps equal frame sizes, and permits empty frames', () => {
  const plan = createSlicePlan(5, 3, { mode: 'sprite', columns: 4, rows: 2, padFrames: true });
  assert.deepEqual([plan.outputWidth, plan.outputHeight, plan.frameWidth, plan.frameHeight], [8, 4, 2, 2]);
  assert.deepEqual([plan.paddedX, plan.paddedY], [3, 1]);
  assert.deepEqual(plan.rects[6], { row: 1, column: 2, x: 4, y: 2, w: 2, h: 2, copyWidth: 1, copyHeight: 1 });
  assert.deepEqual(plan.rects[7], { row: 1, column: 3, x: 6, y: 2, w: 2, h: 2, copyWidth: 0, copyHeight: 1 });
  assertCompleteCoverage(plan);
  const bottomEmpty = createSlicePlan(3, 5, { mode: 'sprite', columns: 2, rows: 4, padFrames: true });
  assert.equal(bottomEmpty.rects.at(-1).copyHeight, 0);
  assertCompleteCoverage(bottomEmpty);
});

test('line helpers add inside the largest gap deterministically and preserve caller arrays', () => {
  assert.deepEqual(evenCutLines(0), []);
  assert.deepEqual(evenCutLines(3), [0.25, 0.5, 0.75]);
  assert.deepEqual(addCutLine(), [0.5]);
  const lines = [0.75, 0.25];
  assert.deepEqual(addCutLine(lines), [0.25, 0.5, 0.75]);
  assert.deepEqual(lines, [0.75, 0.25]);
  assert.deepEqual(addCutLine([0.5]), [0.25, 0.5]);
  assert.deepEqual(addCutLine([0, 1]), [0, 0.5, 1]);
  assert.throws(() => addCutLine(evenCutLines(40)), /最多.*40/);
  for (const invalid of [-1, 41, 1.5, NaN, Infinity, '3']) assert.throws(() => evenCutLines(invalid), RangeError);
});

test('invalid dimensions, fractions, and sprite counts fail before any geometry allocation', () => {
  for (const bad of [0, -1, 1.5, NaN, Infinity, 8193, '10', null]) {
    assert.throws(() => createSlicePlan(bad, 10), RangeError);
    assert.throws(() => createSlicePlan(10, bad), RangeError);
  }
  assert.throws(() => createSlicePlan(8192, 4097), /32 Mi/);
  assert.equal(createSlicePlan(8192, 4096).outputPixels, SLICE_LIMITS.pixels);
  for (const options of [
    { mode: 'other' }, { rows: 0 }, { rows: 101 }, { columns: 0.5 }, { columns: Infinity },
    { vLines: [-0.1] }, { vLines: [1.1] }, { hLines: [NaN] }, { hLines: ['0.5'] },
    { vLines: Array(41).fill(0.5) }, { hLines: null }, { padFrames: 1 },
  ]) assert.throws(() => normalizeSliceOptions(options));
  for (const options of [null, [], 'manual']) assert.throws(() => normalizeSliceOptions(options), TypeError);
});

test('preview can represent ten thousand frames while preserving the separate build limit', () => {
  const plan = createSlicePlan(100, 100, { mode: 'sprite', rows: 100, columns: 100 });
  assert.equal(plan.total, SLICE_LIMITS.previewCount);
  assert.equal(plan.rects.length, 10000);
  assert.equal(SLICE_LIMITS.documents, 100);
  assertCompleteCoverage(plan);
  // The padded extent is virtual; no canvas larger than the source is allocated.
  const wide = createSlicePlan(8192, 1, { mode: 'sprite', columns: 100, padFrames: true });
  assert.equal(wide.outputWidth, 8200);
  assert.equal(wide.frameWidth, 82);
});
