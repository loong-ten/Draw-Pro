import assert from 'node:assert/strict';
import test from 'node:test';
import { RESAMPLING_ALGORITHMS, resampleRGBA, resampleRGBAAsync, validateResamplePlan } from '../dist/image-resampling.js';

const image = (width, height, bytes) => ({ width, height, data: Uint8ClampedArray.from(bytes) });
const gray = values => image(values.length, 1, values.flatMap(value => [value, value, value, 255]));
const redValues = result => Array.from({ length: result.width * result.height }, (_, i) => result.data[i * 4]);
const pixel = (result, x, y = 0) => [...result.data.slice((y * result.width + x) * 4, (y * result.width + x + 1) * 4)];

test('geometry/data validation rejects invalid sizes, crop rectangles and unknown algorithms before allocating pixels', () => {
  for (const value of [0, -1, 0.5, NaN, Infinity, '3', 8193]) {
    assert.throws(() => validateResamplePlan(3, 2, { width: value, height: 2 }), RangeError);
    assert.throws(() => validateResamplePlan(value, 2, { width: 2, height: 2 }), RangeError);
  }
  assert.throws(() => validateResamplePlan(3, 2, { width: 8192, height: 8192 }), RangeError);
  assert.deepEqual(validateResamplePlan(8192, 4096, { width: 8192, height: 4096 }).sourceRect,
    { x: 0, y: 0, width: 8192, height: 4096 });
  for (const sourceRect of [
    { x: -0.1, y: 0, width: 1, height: 1 }, { x: 0, y: 0, width: 0, height: 1 },
    { x: 2.5, y: 0, width: 1, height: 1 }, { x: 0, y: 2, width: 1, height: 1 },
    { x: NaN, y: 0, width: 1, height: 1 }, { x: 0, y: 0, width: Infinity, height: 1 },
    { x: 0.5, y: 0, width: Number.MIN_VALUE, height: 1 },
  ]) assert.throws(() => validateResamplePlan(3, 2, { width: 2, height: 2, sourceRect }), RangeError);
  assert.throws(() => resampleRGBA(gray([0, 255]), { width: 3, height: 1, algorithm: 'browser-high' }), RangeError);
  assert.throws(() => resampleRGBA({ width: 2, height: 1, data: new Uint8ClampedArray(7) }, { width: 1, height: 1 }), TypeError);
  assert.throws(() => resampleRGBA({ width: 2, height: 1, data: new Float32Array(8) }, { width: 1, height: 1 }), TypeError);
});

test('nearest keeps Pillow repeated-center boundary choices and copies raw RGBA, including unaligned byte views', () => {
  const source = image(4, 2, Array.from({ length: 8 }, (_, i) => [i * 20, i + 4, 255 - i, i]).flat());
  const original = source.data.slice();
  const result = resampleRGBA(source, { width: 7, height: 7 });
  const xs = [0, 0, 1, 1, 2, 3, 3], ys = [0, 0, 0, 0, 1, 1, 1];
  for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) assert.deepEqual(pixel(result, x, y), pixel(source, xs[x], ys[y]));
  assert.deepEqual(source.data, original);
  const buffer = new Uint8Array(source.data.length + 1); buffer.set(source.data, 1);
  assert.deepEqual(resampleRGBA({ ...source, data: buffer.subarray(1) }, { width: 7, height: 7 }).data, result.data);
});

test('every algorithm preserves an identity or integer unit crop byte-for-byte, including hidden RGB and alpha=1', () => {
  const source = image(3, 2, [
    238, 14, 99, 0, 255, 127, 9, 1, 70, 80, 90, 2,
    12, 23, 34, 17, 45, 56, 67, 128, 78, 89, 90, 255,
  ]);
  for (const algorithm of RESAMPLING_ALGORITHMS) {
    const same = resampleRGBA(source, { width: 3, height: 2, algorithm });
    assert.notEqual(same.data, source.data);
    assert.deepEqual(same.data, source.data, algorithm);
    const crop = resampleRGBA(source, { width: 2, height: 2, algorithm, sourceRect: { x: 1, y: 0, width: 2, height: 2 } });
    assert.deepEqual([...crop.data], [...source.data.slice(4, 12), ...source.data.slice(16, 24)], algorithm);
  }
});

test('five algorithms match independent mathematical reduction fixtures and remain visibly distinct', () => {
  // Exact rational triangle / a=-0.5 cubic / area weights and a high-precision
  // sinc evaluation, normalized at the original image edge. These fixtures are
  // constants, not a second invocation of the implementation under test.
  const expected = {
    nearest: [0, 240, 60], bilinear: [36, 180, 114], bicubic: [23, 191, 111],
    lanczos3: [14, 199, 114], area: [30, 180, 105],
  };
  const source = gray([0, 120, 240, 60]);
  const outputs = new Set();
  for (const algorithm of RESAMPLING_ALGORITHMS) {
    const result = resampleRGBA(source, { width: 3, height: 1, algorithm });
    assert.deepEqual(redValues(result), expected[algorithm], algorithm);
    assert.ok(result.data.every((value, index) => index % 4 !== 3 || value === 255));
    outputs.add(redValues(result).join(','));
  }
  assert.equal(outputs.size, 5);
});

test('triangle, Catmull-Rom and three-lobe Lanczos match interpolation fixtures, including negative-lobe clamping', () => {
  const expected = {
    bilinear: [0, 64, 191, 191, 64, 0],
    bicubic: [0, 54, 216, 216, 54, 0],
    lanczos3: [0, 63, 221, 221, 63, 0],
  };
  for (const [algorithm, values] of Object.entries(expected)) {
    const result = resampleRGBA(gray([0, 255, 0]), { width: 6, height: 1, algorithm });
    assert.deepEqual(redValues(result), values, algorithm);
  }
});

test('all reconstruction kernels widen during reduction instead of just sampling isolated centers', () => {
  const source = gray([0, 0, 255, 255]);
  const fixtures = { bilinear: [36, 219], bicubic: [21, 234], lanczos3: [18, 237] };
  for (const [algorithm, values] of Object.entries(fixtures)) {
    assert.deepEqual(redValues(resampleRGBA(source, { width: 2, height: 1, algorithm })), values, algorithm);
  }
  const stripes = gray([0, 255, 0, 255, 0, 255, 0, 255]);
  for (const algorithm of ['bilinear', 'bicubic', 'lanczos3', 'area']) {
    assert.equal(resampleRGBA(stripes, { width: 1, height: 1, algorithm }).data[0], 128, algorithm);
  }
  assert.equal(resampleRGBA(stripes, { width: 1, height: 1 }).data[0], 0, 'nearest intentionally remains an unfiltered sample');
});

test('area is exact footprint coverage in both axes, including fractional crops and enlargement', () => {
  const source = image(3, 2, [0, 40, 80, 120, 160, 200].flatMap(value => [value, value, value, 255]));
  const result = resampleRGBA(source, {
    width: 1, height: 1, algorithm: 'area', sourceRect: { x: 0.5, y: 0.25, width: 2, height: 1.5 },
  });
  assert.deepEqual(pixel(result, 0), [100, 100, 100, 255]);
  assert.deepEqual(redValues(resampleRGBA(gray([0, 120]), { width: 3, height: 1, algorithm: 'area' })), [0, 60, 120]);
  assert.deepEqual(redValues(resampleRGBA(gray([0, 120]), { width: 4, height: 1, algorithm: 'area' })), [0, 0, 120, 120]);
});

test('premultiplied filtering ignores transparent RGB and retains faint colored edges rather than producing black fringes', () => {
  for (const algorithm of ['bilinear', 'bicubic', 'lanczos3', 'area']) {
    const options = { width: 1, height: 1, algorithm };
    assert.deepEqual(pixel(resampleRGBA(image(2, 1, [250, 10, 20, 255, 0, 255, 255, 0]), options), 0), [250, 10, 20, 128], algorithm);
    assert.deepEqual(pixel(resampleRGBA(image(2, 1, [255, 0, 0, 1, 0, 255, 255, 0]), options), 0), [255, 0, 0, 1], algorithm + ' alpha=1');
    assert.deepEqual(pixel(resampleRGBA(image(2, 1, [255, 0, 0, 1, 0, 0, 255, 2]), options), 0), [85, 0, 170, 2], algorithm + ' alpha-weighted mean');
    const clear = resampleRGBA(image(2, 1, [255, 0, 255, 0, 0, 255, 255, 0]), { width: 7, height: 2, algorithm });
    assert.ok(clear.data.every(value => value === 0), algorithm + ' fully transparent');
  }
});

test('negative-lobe filters retain constant hue at varying alpha and bound all output channels', () => {
  const source = image(5, 1, [0, 1, 255, 1, 0].flatMap(alpha => [255, 80, 20, alpha]));
  for (const algorithm of ['bicubic', 'lanczos3']) {
    const result = resampleRGBA(source, { width: 21, height: 1, algorithm });
    let visible = 0, clear = 0;
    for (let x = 0; x < result.width; x++) {
      const rgba = pixel(result, x);
      if (rgba[3]) { assert.deepEqual(rgba.slice(0, 3), [255, 80, 20], algorithm); visible++; }
      else { assert.deepEqual(rgba, [0, 0, 0, 0]); clear++; }
    }
    assert.ok(visible > 0 && clear > 0);
  }
});

test('fractional cover windows sample directly in source coordinates without constructing a scaled intermediate image', () => {
  const source = gray([0, 40, 120, 240]);
  const crop = { x: 0.5, y: 0, width: 2.5, height: 1 };
  const fixtures = { nearest: [40, 120], bilinear: [23, 111], area: [24, 104] };
  for (const [algorithm, values] of Object.entries(fixtures)) {
    assert.deepEqual(redValues(resampleRGBA(source, { width: 2, height: 1, algorithm, sourceRect: crop })), values, algorithm);
  }
  const long = gray(new Array(8192).fill(90));
  const result = resampleRGBA(long, {
    width: 8192, height: 1, algorithm: 'lanczos3', sourceRect: { x: 4095.5, y: 0, width: 1, height: 1 },
  });
  assert.equal(result.data.length, 8192 * 4);
  assert.ok(result.data.every((value, i) => value === (i % 4 === 3 ? 255 : 90)),
    'an equivalent full-image intermediate would be 67,108,864 pixels wide; it is never allocated');
});

test('async fallback produces identical pixels for all five algorithms and yields before and during long work', async () => {
  const source = image(97, 83, Array.from({ length: 97 * 83 }, (_, i) => [i % 256, (i * 7) % 256, (i * 13) % 256, i % 3 ? 255 : 1]).flat());
  for (const algorithm of RESAMPLING_ALGORITHMS) {
    const options = { width: 211, height: 127, algorithm, sourceRect: { x: 0.25, y: 1.5, width: 96, height: 80 } };
    let yields = 0;
    const result = await resampleRGBAAsync(source, options, { yieldTask: () => { yields++; } });
    assert.deepEqual(result.data, resampleRGBA(source, options).data, algorithm);
    assert.ok(yields >= 1);
    if (algorithm !== 'nearest') assert.ok(yields > 1, algorithm + ' splits long filtering');
  }
});

test('async cancellation during filtering or a blocked yield immediately rejects without changing source pixels', async () => {
  const source = gray(new Array(512).fill(90)), original = source.data.slice();
  const controller = new AbortController();
  let yields = 0;
  await assert.rejects(resampleRGBAAsync(source, { width: 8192, height: 7, algorithm: 'lanczos3' }, {
    signal: controller.signal,
    yieldTask: () => { if (++yields === 2) controller.abort(); },
  }), { name: 'AbortError' });
  assert.equal(yields, 2);
  assert.deepEqual(source.data, original);
  const blocked = new AbortController();
  const task = resampleRGBAAsync(source, { width: 64, height: 1, algorithm: 'area' }, {
    signal: blocked.signal, yieldTask: () => new Promise(() => {}),
  });
  blocked.abort();
  await assert.rejects(task, { name: 'AbortError' });
  await assert.rejects(resampleRGBAAsync(source, { width: 64, height: 1 }, { signal: blocked.signal }), { name: 'AbortError' });
});
