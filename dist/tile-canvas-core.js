/* Integer tile boundaries shared by layout, snapping and image splitting. */
export const CANVAS_PRESETS = Object.freeze([
  Object.freeze({ id: '720p', label: '720P', width: 1280, height: 720 }),
  Object.freeze({ id: '1080p', label: '1080P', width: 1920, height: 1080 }),
  Object.freeze({ id: '2k', label: '2K / QHD', width: 2560, height: 1440 }),
]);
export const TILE_SIZES = Object.freeze([16, 32, 48, 64, 128, 256]);
export const TILE_LIMITS = Object.freeze({ side: 8192, pixels: 32 * 1024 * 1024, tiles: 10000, zipBytes: 200 * 1024 * 1024 });
export const DEFAULT_TILE_CANVAS = Object.freeze({
  width: 1920, height: 1080, tileWidth: 64, tileHeight: 64, edge: 'pad',
  showGrid: true, snapGrid: true, showNumbers: true, anchor: 'tl', skipEmpty: false,
});

function dimension(input, key, label) {
  const value = input[key] === undefined ? DEFAULT_TILE_CANVAS[key] : input[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > TILE_LIMITS.side) {
    throw new RangeError(label + '须为 1–8192 之间的整数像素。');
  }
  return value;
}

export function validateTileCanvas(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('画布设置格式无效。');
  const width = dimension(input, 'width', '画布宽度'), height = dimension(input, 'height', '画布高度');
  const tileWidth = dimension(input, 'tileWidth', '瓦片宽度'), tileHeight = dimension(input, 'tileHeight', '瓦片高度');
  if (width * height > TILE_LIMITS.pixels) throw new RangeError('画布总面积不能超过 3200 万像素。');
  if (tileWidth * tileHeight > TILE_LIMITS.pixels) throw new RangeError('单块瓦片总面积不能超过 3200 万像素。');
  const edge = input.edge === undefined ? DEFAULT_TILE_CANVAS.edge : input.edge;
  const anchor = input.anchor === undefined ? DEFAULT_TILE_CANVAS.anchor : input.anchor;
  if (!['pad', 'keep'].includes(edge)) throw new RangeError('边缘处理须选择补齐透明或保留实际尺寸。');
  if (!['tl', 'bl', 'center'].includes(anchor)) throw new RangeError('放置锚点须选择左上角、左下角或中心。');
  const result = { width, height, tileWidth, tileHeight, edge };
  for (const key of ['showGrid', 'snapGrid', 'showNumbers']) result[key] = typeof input[key] === 'boolean' ? input[key] : DEFAULT_TILE_CANVAS[key];
  result.anchor = anchor;
  result.skipEmpty = typeof input.skipEmpty === 'boolean' ? input.skipEmpty : DEFAULT_TILE_CANVAS.skipEmpty;
  return result;
}

export function frameBounds(settings) {
  const { width, height } = validateTileCanvas(settings);
  return { x: 0, y: 0, w: width, h: height, right: width, bottom: height };
}

export function tilePlan(settings) {
  const { width, height, tileWidth, tileHeight, edge } = validateTileCanvas(settings);
  const columns = Math.ceil(width / tileWidth), rows = Math.ceil(height / tileHeight), total = columns * rows;
  return {
    width, height, tileWidth, tileHeight, edge, columns, rows, total,
    remainderWidth: width % tileWidth, remainderHeight: height % tileHeight,
    paddedWidth: columns * tileWidth, paddedHeight: rows * tileHeight,
    exportable: total <= TILE_LIMITS.tiles,
    error: total > TILE_LIMITS.tiles ? '共 ' + total.toLocaleString() + ' 块，单次最多导出 10,000 块；请增大瓦片尺寸。' : '',
  };
}

function rectAt(plan, row, column) {
  const x = column * plan.tileWidth, y = row * plan.tileHeight;
  const copyWidth = Math.min(plan.tileWidth, plan.width - x), copyHeight = Math.min(plan.tileHeight, plan.height - y);
  return {
    row, column, x, y,
    width: plan.edge === 'keep' ? copyWidth : plan.tileWidth,
    height: plan.edge === 'keep' ? copyHeight : plan.tileHeight,
    copyWidth, copyHeight,
  };
}

/** Generates one rectangle at a time; previews need no large rectangle arrays. */
export function* tileRects(settings) {
  const plan = tilePlan(settings);
  for (let row = 0; row < plan.rows; row++) for (let column = 0; column < plan.columns; column++) yield rectAt(plan, row, column);
}

function snappedAxis(value, extent, step) {
  const position = Number.isFinite(value) ? Math.max(0, Math.min(extent, value)) : 0;
  const index = Math.floor(position / step), before = Math.min(index * step, extent), after = Math.min((index + 1) * step, extent);
  const point = position - before <= after - position ? before : after;
  return { point, index: point === extent ? Math.ceil(extent / step) : Math.round(point / step) };
}

export function snapGridPoint(settings, point = {}) {
  const s = validateTileCanvas(settings);
  const x = snappedAxis(point.x, s.width, s.tileWidth), y = snappedAxis(point.y, s.height, s.tileHeight);
  return { x: x.point, y: y.point, column: x.index, row: y.index };
}

export function tileAtPoint(settings, point = {}) {
  const plan = tilePlan(settings);
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.y < 0 || point.x >= plan.width || point.y >= plan.height) return null;
  return rectAt(plan, Math.floor(point.y / plan.tileHeight), Math.floor(point.x / plan.tileWidth));
}
