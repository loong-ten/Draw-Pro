/* Integer-only slicing geometry. No canvas or workspace state is changed here. */
export const SLICE_LIMITS = Object.freeze({
  side: 8192,
  pixels: 32 * 1024 * 1024,
  lines: 40,
  axisFrames: 100,
  previewCount: 10000,
  documents: 100,
  outputPixels: 64 * 1024 * 1024,
});

export function defaultSliceOptions() {
  return { mode: 'manual', vLines: [], hLines: [], rows: 1, columns: 1, padFrames: false };
}

function integer(value, label, maximum) {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${label}须为 1–${maximum} 的整数。`);
  }
  return value;
}

function sourceDimensions(width, height) {
  integer(width, '源图宽度', SLICE_LIMITS.side);
  integer(height, '源图高度', SLICE_LIMITS.side);
  if (width * height > SLICE_LIMITS.pixels) {
    throw new RangeError('源图总面积不能超过 32 Mi 像素。');
  }
}

function cutLines(value, label = '分割线') {
  if (!Array.isArray(value)) throw new TypeError(`${label}须为位置数组。`);
  if (value.length > SLICE_LIMITS.lines) {
    throw new RangeError(`每个方向最多添加 ${SLICE_LIMITS.lines} 条分割线。`);
  }
  for (const position of value) {
    if (typeof position !== 'number' || !Number.isFinite(position) || position < 0 || position > 1) {
      throw new RangeError(`${label}位置须为 0–1 之间的有限数值。`);
    }
  }
  return [...new Set(value)].sort((a, b) => a - b);
}

export function normalizeSliceOptions(input = {}, width, height) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('切图设置须为对象。');
  }
  const defaults = defaultSliceOptions();
  const mode = input.mode === undefined ? defaults.mode : input.mode;
  if (mode !== 'manual' && mode !== 'sprite') throw new RangeError('请选择手动切图或精灵表切帧。');
  const rows = integer(input.rows === undefined ? defaults.rows : input.rows, '行数', SLICE_LIMITS.axisFrames);
  const columns = integer(input.columns === undefined ? defaults.columns : input.columns, '列数', SLICE_LIMITS.axisFrames);
  const padFrames = input.padFrames === undefined ? defaults.padFrames : input.padFrames;
  if (typeof padFrames !== 'boolean') throw new TypeError('补齐透明边缘设置须为布尔值。');
  if (width !== undefined || height !== undefined) {
    sourceDimensions(width, height);
    if (mode === 'sprite' && (columns > width || rows > height)) {
      throw new RangeError('精灵表列数不能超过源图宽度，行数不能超过源图高度；每帧至少保留 1 像素。');
    }
  }
  return {
    mode,
    vLines: cutLines(input.vLines === undefined ? defaults.vLines : input.vLines, '竖向分割线'),
    hLines: cutLines(input.hLines === undefined ? defaults.hLines : input.hLines, '横向分割线'),
    rows, columns, padFrames,
  };
}

// count is the number of cuts, so n cuts make n + 1 equally spaced regions.
export function evenCutLines(count) {
  if (!Number.isInteger(count) || count < 0 || count > SLICE_LIMITS.lines) {
    throw new RangeError(`分割线数量须为 0–${SLICE_LIMITS.lines} 的整数。`);
  }
  return Array.from({ length: count }, (_, index) => (index + 1) / (count + 1));
}

export function addCutLine(lines = []) {
  const sorted = cutLines(lines);
  if (sorted.length >= SLICE_LIMITS.lines) {
    throw new RangeError(`每个方向最多添加 ${SLICE_LIMITS.lines} 条分割线。`);
  }
  const edges = [0, ...sorted.filter(value => value > 0 && value < 1), 1];
  let start = 0, size = -1;
  for (let index = 1; index < edges.length; index++) {
    const gap = edges[index] - edges[index - 1];
    if (gap > size) { start = edges[index - 1]; size = gap; }
  }
  return [...sorted, start + size / 2].sort((a, b) => a - b);
}

function manualEdges(lines, extent) {
  return [...new Set([0, ...lines.map(position => Math.round(position * extent)), extent])].sort((a, b) => a - b);
}

export function createSlicePlan(width, height, input = {}) {
  sourceDimensions(width, height);
  const options = normalizeSliceOptions(input, width, height);
  let xEdges, yEdges, frameWidth = null, frameHeight = null;
  if (options.mode === 'sprite') {
    if (!options.padFrames && (width % options.columns !== 0 || height % options.rows !== 0)) {
      throw new RangeError(`源图 ${width} × ${height} 不能被 ${options.columns} 列 × ${options.rows} 行整除。请调整行列数，或开启“补透明边缘后等分”。`);
    }
    frameWidth = Math.ceil(width / options.columns);
    frameHeight = Math.ceil(height / options.rows);
    xEdges = Array.from({ length: options.columns + 1 }, (_, index) => index * frameWidth);
    yEdges = Array.from({ length: options.rows + 1 }, (_, index) => index * frameHeight);
  } else {
    xEdges = manualEdges(options.vLines, width);
    yEdges = manualEdges(options.hLines, height);
  }
  const columns = xEdges.length - 1, rows = yEdges.length - 1, total = columns * rows;
  if (total > SLICE_LIMITS.previewCount) {
    throw new RangeError(`切图预览最多支持 ${SLICE_LIMITS.previewCount} 块。`);
  }
  const outputWidth = xEdges[columns], outputHeight = yEdges[rows];
  const rects = [];
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const x = xEdges[column], y = yEdges[row];
      const w = xEdges[column + 1] - x, h = yEdges[row + 1] - y;
      rects.push({
        row, column, x, y, w, h,
        copyWidth: Math.max(0, Math.min(w, width - x)),
        copyHeight: Math.max(0, Math.min(h, height - y)),
      });
    }
  }
  return {
    mode: options.mode, width, height, outputWidth, outputHeight,
    rows, columns, total, frameWidth, frameHeight, rects,
    paddedX: outputWidth - width, paddedY: outputHeight - height,
    xEdges, yEdges, outputPixels: outputWidth * outputHeight,
  };
}
