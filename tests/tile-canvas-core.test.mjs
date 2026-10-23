import assert from 'node:assert/strict';
import test from 'node:test';
import { CANVAS_PRESETS, TILE_SIZES, TILE_LIMITS, DEFAULT_TILE_CANVAS, validateTileCanvas, frameBounds, tilePlan, tileRects, snapGridPoint, tileAtPoint } from '../dist/tile-canvas-core.js';

test('canvas presets spell out exact dimensions and settings round-trip independently', () => {
  assert.deepEqual(CANVAS_PRESETS.map(p => [p.id, p.width, p.height]), [['720p', 1280, 720], ['1080p', 1920, 1080], ['2k', 2560, 1440]]);
  assert.deepEqual(TILE_SIZES, [16, 32, 48, 64, 128, 256]);
  for (const preset of CANVAS_PRESETS) {
    const settings = validateTileCanvas({ ...preset, anchor: 'bl', showNumbers: false });
    assert.deepEqual(validateTileCanvas(JSON.parse(JSON.stringify(settings))), settings);
    assert.deepEqual(frameBounds(settings), { x: 0, y: 0, w: preset.width, h: preset.height, right: preset.width, bottom: preset.height });
  }
  const settings = validateTileCanvas(); settings.width = 1;
  assert.equal(DEFAULT_TILE_CANVAS.width, 1920);
});

test('invalid dimensions and unsupported options fail before allocating a raster', () => {
  for (const key of ['width', 'height', 'tileWidth', 'tileHeight']) {
    for (const value of [0, -1, .5, NaN, Infinity, '32', null, TILE_LIMITS.side + 1]) assert.throws(() => validateTileCanvas({ [key]: value }), RangeError);
  }
  assert.throws(() => validateTileCanvas({ width: 8192, height: 8192 }), /面积/);
  assert.throws(() => validateTileCanvas({ tileWidth: 8192, tileHeight: 8192 }), /面积/);
  assert.throws(() => validateTileCanvas({ edge: 'discard' }), /边缘/);
  assert.throws(() => validateTileCanvas({ anchor: 'outside' }), /锚点/);
  assert.throws(() => validateTileCanvas(null), TypeError);
  const s = validateTileCanvas({ showGrid: 'false', snapGrid: false, skipEmpty: 1 });
  assert.equal(s.showGrid, true); assert.equal(s.snapGrid, false); assert.equal(s.skipEmpty, false);
});

test('1080P at 64px reports integer rows, bottom remainder and transparent padding', () => {
  const plan = tilePlan(DEFAULT_TILE_CANVAS);
  assert.deepEqual([plan.columns, plan.rows, plan.total], [30, 17, 510]);
  assert.deepEqual([plan.remainderWidth, plan.remainderHeight, plan.paddedWidth, plan.paddedHeight], [0, 56, 1920, 1088]);
  const last = [...tileRects(plan)].at(-1);
  assert.deepEqual(last, { row: 16, column: 29, x: 1856, y: 1024, width: 64, height: 64, copyWidth: 64, copyHeight: 56 });
});

test('row-major rectangles cover every pixel exactly once across exact, partial and oversized cells', () => {
  for (const edge of ['pad', 'keep']) for (const [width, height, tileWidth, tileHeight] of [[6, 4, 3, 2], [7, 4, 3, 2], [6, 5, 3, 2], [7, 5, 3, 2], [2, 1, 8, 8], [1, 1, 1, 1]]) {
    const settings = { width, height, tileWidth, tileHeight, edge }, plan = tilePlan(settings), tiles = [...tileRects(plan)], coverage = new Uint8Array(width * height);
    assert.equal(tiles.length, plan.total);
    tiles.forEach((tile, index) => {
      assert.equal(tile.row, Math.floor(index / plan.columns)); assert.equal(tile.column, index % plan.columns);
      assert.equal(tile.width, edge === 'pad' ? tileWidth : tile.copyWidth);
      assert.equal(tile.height, edge === 'pad' ? tileHeight : tile.copyHeight);
      for (const value of Object.values(tile)) assert.ok(Number.isInteger(value));
      for (let y = tile.y; y < tile.y + tile.copyHeight; y++) for (let x = tile.x; x < tile.x + tile.copyWidth; x++) coverage[y * width + x]++;
    });
    assert.ok([...coverage].every(count => count === 1), 'no omitted or duplicate source pixels');
  }
});

test('grid intersection snapping includes partial right/bottom boundaries and never leaves the canvas', () => {
  const s = { width: 10, height: 7, tileWidth: 4, tileHeight: 3 };
  assert.deepEqual(snapGridPoint(s, { x: 9.6, y: 6.6 }), { x: 10, y: 7, column: 3, row: 3 });
  assert.deepEqual(snapGridPoint(s, { x: -200, y: 200 }), { x: 0, y: 7, column: 0, row: 3 });
  assert.deepEqual(snapGridPoint(s, { x: 2, y: 1.5 }), { x: 0, y: 0, column: 0, row: 0 }, 'ties choose the preceding intersection');
  assert.deepEqual(snapGridPoint({ width: 2, height: 1, tileWidth: 8, tileHeight: 8 }, { x: 1.8, y: .8 }), { x: 2, y: 1, column: 1, row: 1 });
});

test('tile hit lookup is half-open and agrees with exported edge rectangles', () => {
  const s = { width: 10, height: 7, tileWidth: 4, tileHeight: 3, edge: 'keep' };
  assert.deepEqual(tileAtPoint(s, { x: 9.99, y: 6.99 }), [...tileRects(s)].at(-1));
  assert.deepEqual(tileAtPoint(s, { x: 4, y: 3 }), { row: 1, column: 1, x: 4, y: 3, width: 4, height: 3, copyWidth: 4, copyHeight: 3 });
  for (const p of [{ x: -1, y: 0 }, { x: 0, y: -1 }, { x: 10, y: 0 }, { x: 0, y: 7 }, { x: NaN, y: 1 }]) assert.equal(tileAtPoint(s, p), null);
});

test('tiny tile previews are inexpensive while export limits are explicit', () => {
  assert.equal(tilePlan({ width: 100, height: 100, tileWidth: 1, tileHeight: 1 }).exportable, true);
  const plan = tilePlan({ width: 8192, height: 4096, tileWidth: 1, tileHeight: 1 });
  assert.equal(plan.total, TILE_LIMITS.pixels); assert.equal(plan.exportable, false); assert.match(plan.error, /10,000/);
  assert.equal(Object.values(plan).some(Array.isArray), false);
  assert.equal(tileRects(plan).next().value.copyWidth, 1, 'rectangles remain lazy for over-limit previews');
});
