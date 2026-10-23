import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_CONVERSION_OPTIONS, normalizeConversionOptions, convertPixels, conversionToSvg } from '../dist/conversion-core.js';

function image(width, height, color) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(color(x, y), (y * width + x) * 4);
  return { width, height, data };
}
const pixel = (result, x, y) => Array.from(result.data.slice((y * result.width + x) * 4, (y * result.width + x) * 4 + 4));
const base = { pixelSize: 2, colorCount: 256, gridAlign: false };

test('normalization bounds numeric inputs and keeps transparent defaults', () => {
  assert.deepEqual(normalizeConversionOptions(), DEFAULT_CONVERSION_OPTIONS);
  assert.deepEqual(normalizeConversionOptions({ pixelSize: 100, colorCount: 0, outputSize: '42.6', sampling: 'bad', gridAlign: false }), {
    pixelSize: 32, colorCount: 2, outputSize: 43, sampling: 'dominant', gridAlign: false, preserveAlpha: true,
  });
  assert.equal(normalizeConversionOptions({ pixelSize: NaN }).pixelSize, 8);
});

test('odd dimensions include the last row and column without mutating source', () => {
  const source = image(5, 3, (x, y) => x === 4 || y === 2 ? [0, 0, 255, 255] : [255, 0, 0, 255]);
  const snapshot = source.data.slice();
  for (const sampling of ['dominant', 'mean', 'median']) {
    const result = convertPixels(source, { ...base, sampling });
    assert.deepEqual([result.width, result.height, result.outputWidth, result.outputHeight], [3, 2, 5, 3]);
    assert.deepEqual(pixel(result, 2, 0), [0, 0, 255, 255]);
    assert.deepEqual(pixel(result, 0, 1), [0, 0, 255, 255]);
    assert.deepEqual(pixel(result, 2, 1), [0, 0, 255, 255]);
  }
  assert.deepEqual(source.data, snapshot);
  const aligned = convertPixels(source, { ...base, gridAlign: true });
  assert.deepEqual([aligned.outputWidth, aligned.outputHeight], [6, 4]);
});

test('transparent RGB is ignored and coverage controls alpha for every sampling method', () => {
  const source = image(2, 2, (x, y) => x === 0 && y === 0 ? [240, 50, 20, 255] : [0, 200, 255, 0]);
  for (const sampling of ['dominant', 'mean', 'median']) {
    const result = convertPixels(source, { ...base, sampling });
    assert.deepEqual(pixel(result, 0, 0), [240, 50, 20, 64]);
    assert.equal(result.colors, 1);
    assert.deepEqual(result.palette, [{ r: 240, g: 50, b: 20 }]);
  }
});

test('semi-transparent colors use alpha weighting and dominant and median favor visible coverage', () => {
  const source = image(2, 1, x => x === 0 ? [255, 0, 0, 255] : [0, 0, 255, 85]);
  assert.deepEqual(pixel(convertPixels(source, { ...base, sampling: 'mean' }), 0, 0), [191, 0, 64, 170]);
  for (const sampling of ['dominant', 'median']) assert.deepEqual(pixel(convertPixels(source, { ...base, sampling }), 0, 0), [255, 0, 0, 170]);
});

test('whole transparent images stay transparent; white compositing is explicit', () => {
  const source = image(3, 5, () => [230, 20, 190, 0]);
  const result = convertPixels(source, base);
  assert.ok(result.data.every(value => value === 0));
  assert.deepEqual(result.palette, []);
  assert.equal(result.colors, 0);
  assert.ok(!conversionToSvg(result).includes('<rect'));
  const white = convertPixels(source, { ...base, preserveAlpha: false });
  assert.deepEqual(pixel(white, 0, 0), [255, 255, 255, 255]);
  const half = image(1, 1, () => [255, 0, 0, 128]);
  assert.deepEqual(pixel(convertPixels(half, { ...base, preserveAlpha: false }), 0, 0), [255, 127, 127, 255]);
});

test('three sampling modes select meaningful block colors without out-of-range channels', () => {
  const source = image(2, 2, (x, y) => [x === 0 && y === 0 ? 255 : 80, 255, 255, 255]);
  assert.deepEqual(pixel(convertPixels(source, { ...base, sampling: 'mean' }), 0, 0), [124, 255, 255, 255]);
  for (const sampling of ['dominant', 'median']) assert.deepEqual(pixel(convertPixels(source, { ...base, sampling }), 0, 0), [80, 255, 255, 255]);
});

test('weighted median agrees with an independently sorted weighted reference', () => {
  let seed = 37;
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed >>> 24; };
  const source = image(16, 16, () => [random(), random(), random(), random()]);
  const result = convertPixels(source, { ...base, pixelSize: 16, sampling: 'median' });
  const expected = [];
  let total = 0;
  for (let at = 3; at < source.data.length; at += 4) total += source.data[at];
  for (let c = 0; c < 3; c++) {
    const values = [];
    for (let at = 0; at < source.data.length; at += 4) if (source.data[at + 3]) values.push([source.data[at + c], source.data[at + 3]]);
    values.sort((a, b) => a[0] - b[0]);
    let weight = 0;
    for (const [value, alpha] of values) { weight += alpha; if (weight > total / 2) { expected.push(value); break; } }
  }
  expected.push(Math.round(total / 256));
  assert.deepEqual(pixel(result, 0, 0), expected);
});

test('palette limit is honored, actual color count is accurate, and low-color art is unchanged', () => {
  const source = image(64, 48, (x, y) => [Math.floor(x / 2) * 8, Math.floor(y / 2) * 10, (Math.floor(x / 2) * 17 + Math.floor(y / 2) * 29) % 256, 255]);
  const result = convertPixels(source, { ...base, colorCount: 8 });
  const unique = new Set();
  for (let at = 0; at < result.data.length; at += 4) if (result.data[at + 3]) unique.add(Array.from(result.data.slice(at, at + 3)).join(','));
  assert.ok(unique.size <= 8);
  assert.equal(result.colors, unique.size);
  assert.equal(result.palette.length, unique.size);
  assert.ok(unique.size > 1);
  const sprite = image(6, 2, x => x < 2 ? [240, 10, 20, 255] : x < 4 ? [10, 200, 20, 255] : [240, 10, 20, 0]);
  assert.deepEqual(pixel(convertPixels(sprite, { ...base, colorCount: 2 }), 0, 0), [240, 10, 20, 255]);
});

test('separate input sizes remain independent and outputSize does not apply scaling twice', () => {
  const first = convertPixels(image(17, 9, () => [1, 2, 3, 255]), { ...base, outputSize: 10 });
  const second = convertPixels(image(7, 13, () => [4, 5, 6, 255]), { ...base, outputSize: 50 });
  assert.deepEqual([first.sourceWidth, first.sourceHeight, first.outputWidth, first.outputHeight], [17, 9, 17, 9]);
  assert.deepEqual([second.sourceWidth, second.sourceHeight, second.outputWidth, second.outputHeight], [7, 13, 7, 13]);
});

test('SVG combines horizontal runs, preserves alpha, clips edge cells and stays inside dimensions', () => {
  const source = image(5, 3, (x, y) => y < 2 ? (x < 4 ? [255, 0, 0, 128] : [0, 255, 0, 255]) : [0, 0, 0, 0]);
  const svg = conversionToSvg(convertPixels(source, base));
  assert.ok(svg.includes('width="5" height="3" viewBox="0 0 5 3"'));
  assert.ok(svg.includes('shape-rendering="crispEdges"'));
  assert.ok(svg.includes('fill-opacity="0.501961"'));
  const rects = [...svg.matchAll(/<rect x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)"/g)].map(match => match.slice(1).map(Number));
  assert.deepEqual(rects, [[0, 0, 4, 2], [4, 0, 1, 2]]);
  for (const [x, y, width, height] of rects) { assert.ok(x + width <= 5); assert.ok(y + height <= 3); }
  const alignedSvg = conversionToSvg(convertPixels(source, { ...base, gridAlign: true }));
  assert.ok(alignedSvg.includes('width="6" height="4" viewBox="0 0 6 4"'));
  assert.ok(alignedSvg.includes('<rect x="4" y="0" width="2" height="2"'));
});

test('malformed pixels, large allocations, output overflow and oversized SVGs fail clearly', () => {
  assert.throws(() => convertPixels({ width: 0, height: 3, data: [] }), /尺寸/);
  assert.throws(() => convertPixels({ width: 4097, height: 4097, data: [] }), /总像素/);
  assert.throws(() => convertPixels({ width: 2, height: 2, data: [0] }), /RGBA/);
  assert.throws(() => convertPixels(image(8192, 1, () => [0, 0, 0, 255]), { pixelSize: 3, gridAlign: true }), /输出图片/);
  const source = image(800, 600, (x, y) => [(Math.floor(x / 2) + Math.floor(y / 2)) % 2 ? 255 : 0, 0, 0, 255]);
  assert.throws(() => conversionToSvg(convertPixels(source, base)), /100,000/);
});
