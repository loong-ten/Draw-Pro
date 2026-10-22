import assert from 'node:assert/strict';
import test from 'node:test';
import { findAlphaBounds, planPadding } from '../dist/padding-core.js';

const makeImage = (width, height, pixels = []) => {
  const data = new Uint8ClampedArray(width * height * 4);
  for (const [x, y, alpha] of pixels) data[(y * width + x) * 4 + 3] = alpha;
  return { width, height, data };
};
const movedSource = (source, plan) => ({
  width: plan.width,
  height: plan.height,
  bounds: source.bounds && { ...source.bounds, x: source.bounds.x + plan.offsetX, y: source.bounds.y + plan.offsetY },
});
const verifyGeometry = (source, plan, margin = 0) => {
  for (const key of ['width', 'height', 'offsetX', 'offsetY', 'left', 'right', 'top', 'bottom', 'minWidth', 'minHeight']) {
    assert.ok(Number.isInteger(plan[key]), `${key} is an integer`);
    assert.ok(plan[key] >= 0, `${key} is nonnegative`);
  }
  assert.equal(source.width + plan.left + plan.right, plan.width, 'complete source width is retained');
  assert.equal(source.height + plan.top + plan.bottom, plan.height, 'complete source height is retained');
  assert.ok(Math.abs(plan.centerX + plan.offsetX - plan.width / 2) <= 0.5, 'horizontal center is within half a pixel');
  assert.ok(Math.abs(plan.centerY + plan.offsetY - plan.height / 2) <= 0.5, 'vertical center is within half a pixel');
  const b = source.bounds ?? { x: 0, y: 0, width: source.width, height: source.height };
  assert.ok(b.x + plan.offsetX >= margin, 'left visible margin is sufficient');
  assert.ok(b.y + plan.offsetY >= margin, 'top visible margin is sufficient');
  assert.ok(plan.width - b.x - b.width - plan.offsetX >= margin, 'right visible margin is sufficient');
  assert.ok(plan.height - b.y - b.height - plan.offsetY >= margin, 'bottom visible margin is sufficient');
};

test('alpha bounds include alpha=1 and use exclusive right/bottom edges', () => {
  const image = makeImage(8, 6, [[1, 4, 255], [6, 1, 1], [3, 2, 128]]);
  const snapshot = image.data.slice();
  assert.deepEqual(findAlphaBounds(image), { x: 1, y: 1, width: 6, height: 4 });
  assert.deepEqual(image.data, snapshot, 'input pixel buffer stays unchanged');
  assert.deepEqual(findAlphaBounds(makeImage(1, 1, [[0, 0, 1]])), { x: 0, y: 0, width: 1, height: 1 });
});

test('transparent RGB values do not create visible bounds and empty input uses canvas center', () => {
  const image = makeImage(9, 4);
  image.data[0] = 255;
  assert.equal(findAlphaBounds(image), null);
  const source = { width: 9, height: 4, bounds: null };
  const plan = planPadding(source);
  assert.equal(plan.empty, true);
  assert.equal(plan.centerX, 4.5);
  assert.equal(plan.centerY, 2);
  verifyGeometry(source, plan);
  assert.equal(planPadding(movedSource(source, plan)).changed, false);
  verifyGeometry(source, planPadding(source, { margin: 2 }), 2);
});

test('off-center content is centered without removing asymmetric existing transparency', () => {
  const source = { width: 100, height: 40, bounds: { x: 0, y: 10, width: 40, height: 20 } };
  const snapshot = structuredClone(source);
  const plan = planPadding(source);
  assert.equal(plan.width, 159);
  assert.equal(plan.height, 159);
  assert.equal(plan.minWidth, 159);
  assert.equal(plan.offsetX, 59);
  verifyGeometry(source, plan);
  assert.deepEqual(source, snapshot, 'input geometry is not mutated');
  assert.equal(planPadding(movedSource(source, plan)).changed, false);
});

test('odd/even dimensions keep pixels on the integer grid and do not grow on reapplication', () => {
  const source = { width: 63, height: 21, bounds: { x: 0, y: 0, width: 63, height: 21 } };
  const options = { ratioWidth: 16, ratioHeight: 9 };
  const plan = planPadding(source, options);
  assert.deepEqual([plan.width, plan.height], [64, 36]);
  verifyGeometry(source, plan);
  assert.equal(planPadding(movedSource(source, plan), options).changed, false);
});

test('extremely long sprites and unreduced ratio inputs preserve exact proportions', () => {
  const source = { width: 4000, height: 3, bounds: { x: 0, y: 0, width: 4000, height: 3 } };
  const options = { ratioWidth: 4000, ratioHeight: 1000 };
  const plan = planPadding(source, options);
  assert.deepEqual([plan.width, plan.height], [4000, 1000]);
  verifyGeometry(source, plan);
  const tiny = planPadding({ width: 1, height: 1, bounds: null }, { ratioWidth: 10000, ratioHeight: 10000 });
  assert.deepEqual([tiny.width, tiny.height], [1, 1]);
});

test('margin measures existing visible whitespace and is stable after ratio padding', () => {
  const source = { width: 20, height: 20, bounds: { x: 5, y: 5, width: 10, height: 10 } };
  assert.equal(planPadding(source, { margin: 5 }).changed, false);
  const options = { margin: 7, ratioWidth: 4, ratioHeight: 3 };
  const plan = planPadding(source, options);
  verifyGeometry(source, plan, 7);
  assert.equal(planPadding(movedSource(source, plan), options).changed, false);
});

test('canvas centering still guarantees minimum margin for off-center visible content', () => {
  const source = { width: 15, height: 10, bounds: { x: 0, y: 8, width: 4, height: 2 } };
  const options = { center: 'canvas', margin: 3, ratioWidth: 2, ratioHeight: 1 };
  const plan = planPadding(source, options);
  assert.equal(plan.centerX, 7.5);
  assert.equal(plan.centerY, 5);
  verifyGeometry(source, plan, 3);
  assert.equal(planPadding(movedSource(source, plan), options).changed, false);
});

test('fixed sizes are honored strictly and insufficient dimensions explain the required size', () => {
  const source = { width: 100, height: 40, bounds: { x: 0, y: 10, width: 40, height: 20 } };
  assert.throws(() => planPadding(source, { mode: 'size', targetWidth: 100, targetHeight: 100 }),
    error => error instanceof RangeError && error.message.includes('159 × 40'));
  assert.throws(() => planPadding(source, { mode: 'size', targetWidth: 200, targetHeight: 39 }), RangeError);
  const plan = planPadding(source, { mode: 'size', targetWidth: 200, targetHeight: 100 });
  assert.deepEqual([plan.width, plan.height], [200, 100]);
  verifyGeometry(source, plan);
});

test('scale is a minimum canvas expansion and auto-centering may need a larger result', () => {
  const source = { width: 100, height: 40, bounds: { x: 0, y: 10, width: 40, height: 20 } };
  const plan = planPadding(source, { mode: 'scale', scale: 1.5 });
  assert.deepEqual([plan.width, plan.height], [159, 60]);
  verifyGeometry(source, plan);
  const odd = { width: 3, height: 5, bounds: { x: 0, y: 0, width: 3, height: 5 } };
  const expanded = planPadding(odd, { mode: 'scale', scale: 1.25 });
  assert.deepEqual([expanded.width, expanded.height], [4, 7]);
  verifyGeometry(odd, expanded);
});

test('invalid numbers, bounds, modes and oversized output are rejected before allocation', () => {
  const source = { width: 10, height: 10, bounds: null };
  for (const value of [NaN, Infinity, -1, 0, 1.5, 10001, '2']) {
    assert.throws(() => planPadding(source, { ratioWidth: value }), RangeError);
  }
  for (const value of [NaN, Infinity, -1, 0, 0.5, '2']) {
    assert.throws(() => planPadding(source, { mode: 'scale', scale: value }), RangeError);
  }
  for (const value of [NaN, Infinity, -1, 0.5]) assert.throws(() => planPadding(source, { margin: value }), RangeError);
  assert.throws(() => planPadding(source, { mode: 'unknown' }), RangeError);
  assert.throws(() => planPadding(source, { center: 'unknown' }), RangeError);
  assert.throws(() => planPadding({ ...source, width: NaN }), RangeError);
  assert.throws(() => planPadding({ ...source, bounds: { x: 9, y: 0, width: 2, height: 1 } }), RangeError);
  assert.throws(() => planPadding({ ...source, bounds: { x: -1, y: 0, width: 2, height: 1 } }), RangeError);
  assert.throws(() => planPadding(source, { mode: 'size', targetWidth: 8193, targetHeight: 1 }), RangeError);
  assert.throws(() => planPadding(source, { mode: 'size', targetWidth: 8192, targetHeight: 8192 }), RangeError);
  assert.throws(() => planPadding(source, { ratioWidth: 10000, ratioHeight: 1 }), RangeError);
  assert.throws(() => planPadding(source, { mode: 'scale', scale: Number.MAX_VALUE }), RangeError);
  assert.throws(() => findAlphaBounds({ width: 1, height: 1, data: new Uint8ClampedArray(3) }), TypeError);
  assert.throws(() => findAlphaBounds(null), TypeError);
  const boundary = planPadding({ width: 8192, height: 4096, bounds: null }, { ratioWidth: 2, ratioHeight: 1 });
  assert.equal(boundary.changed, false, '32 megapixels and 8192-pixel edge are accepted exactly');
});

test('small asymmetric boxes across parity, margins and ratios satisfy geometry and idempotence', () => {
  let scenarios = 0;
  for (let width = 1; width <= 6; width++) for (let height = 1; height <= 4; height++) {
    for (let x = 0; x < width; x++) for (let right = x + 1; right <= width; right++) {
      for (let y = 0; y < height; y++) for (let bottom = y + 1; bottom <= height; bottom++) {
        const source = { width, height, bounds: { x, y, width: right - x, height: bottom - y } };
        for (const [ratioWidth, ratioHeight] of [[1, 1], [2, 1], [4, 3], [16, 9], [9, 16]]) {
          for (const margin of [0, 1, 3]) for (const center of ['content', 'canvas']) {
            const options = { ratioWidth, ratioHeight, margin, center };
            const plan = planPadding(source, options);
            verifyGeometry(source, plan, margin);
            assert.equal(plan.width * ratioHeight, plan.height * ratioWidth, 'ratio is exact');
            const repeated = planPadding(movedSource(source, plan), options);
            assert.equal(repeated.changed, false, 'same ratio does not repeatedly enlarge or move content');
            scenarios++;
          }
        }
      }
    }
  }
  assert.equal(scenarios, 33600);
});
