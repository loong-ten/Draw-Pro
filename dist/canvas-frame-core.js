import { makeCanvas } from './core.js';

const MAX_SIDE = 8192;
const MAX_AREA = 32 * 1024 * 1024;
const DEFAULT_WORKSPACE_PIXELS = 128 * 1024 * 1024;
const HANDLES = new Set(['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw']);
const COMMIT_FIELDS = ['width', 'height', 'layers', 'history', 'historyIndex', 'dirty', 'revision', '_composite', '_thumb'];

function dimensions(width, height) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
      width < 1 || height < 1 || width > MAX_SIDE || height > MAX_SIDE ||
      width * height > MAX_AREA) {
    throw new RangeError('画幅尺寸须为 1–8192 整数像素，且面积不超过 32 Mi 像素。');
  }
  return { width, height };
}

function integerOffset(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new RangeError('拖动偏移必须是有限数值。');
  // Symmetric nearest-pixel rounding: moving -0.5px and +0.5px gives -1 and +1.
  const result = Math.sign(value) * Math.round(Math.abs(value));
  if (!Number.isSafeInteger(result)) throw new RangeError('拖动偏移超出可用范围。');
  return result === 0 ? 0 : result;
}

function validateFrame(frame) {
  if (!frame || typeof frame !== 'object') throw new TypeError('缺少有效的画幅边界。');
  dimensions(frame.width, frame.height);
  if (!Number.isSafeInteger(frame.x) || !Number.isSafeInteger(frame.y) ||
      !Number.isSafeInteger(frame.x + frame.width) || !Number.isSafeInteger(frame.y + frame.height)) {
    throw new RangeError('画幅位置必须是安全范围内的整数像素。');
  }
  return { x: frame.x === 0 ? 0 : frame.x, y: frame.y === 0 ? 0 : frame.y, width: frame.width, height: frame.height };
}

/**
 * Frame coordinates are measured in the original document: original pixel (a,b)
 * becomes result pixel (a-frame.x,b-frame.y), with no scaling or interpolation.
 *
 * dx/dy are cumulative document-coordinate offsets from pointerdown. Only the
 * axes named by handle move. Each opposite edge stays at its original position.
 * Corner area overflow follows the original-to-requested size segment to the
 * 32 Mi-pixel boundary; edge overflow clamps only the moving dimension.
 */
export function canvasFrameFromDrag(size, handle, dx, dy) {
  if (!size || typeof size !== 'object') throw new TypeError('缺少原始画布尺寸。');
  const { width, height } = dimensions(size.width, size.height);
  if (!HANDLES.has(handle)) throw new RangeError('画幅手柄必须是 n/ne/e/se/s/sw/w/nw。');
  dx = integerOffset(dx); dy = integerOffset(dy);
  const west = handle.includes('w'), east = handle.includes('e');
  const north = handle.includes('n'), south = handle.includes('s');
  const horizontal = west || east, vertical = north || south;
  const clampSide = value => Math.max(1, Math.min(MAX_SIDE, value));
  let nextWidth = horizontal ? clampSide(width + (west ? -dx : dx)) : width;
  let nextHeight = vertical ? clampSide(height + (north ? -dy : dy)) : height;
  if (nextWidth * nextHeight > MAX_AREA) {
    if (!vertical) nextWidth = Math.floor(MAX_AREA / nextHeight);
    else if (!horizontal) nextHeight = Math.floor(MAX_AREA / nextWidth);
    else {
      const dw = nextWidth - width, dh = nextHeight - height;
      let low = 0, high = 1;
      for (let step = 0; step < 60; step++) {
        const t = (low + high) / 2;
        if ((width + dw * t) * (height + dh * t) <= MAX_AREA) low = t;
        else high = t;
      }
      // Flooring positive dimensions is conservative, including mixed grow/shrink.
      nextWidth = Math.max(1, Math.floor(width + dw * low));
      nextHeight = Math.max(1, Math.floor(height + dh * low));
    }
  }
  return {
    x: west ? width - nextWidth : 0,
    y: north ? height - nextHeight : 0,
    width: nextWidth,
    height: nextHeight,
  };
}

function validateDocument(doc) {
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.layers) || !doc.layers.length) {
    throw new TypeError('当前素材没有可处理的图层。');
  }
  dimensions(doc.width, doc.height);
  for (const layer of doc.layers) {
    if (!layer || !layer.canvas || typeof layer.canvas.getContext !== 'function' ||
        layer.canvas.width !== doc.width || layer.canvas.height !== doc.height) {
      throw new RangeError('图层画布尺寸与当前素材不一致，未调整画幅。');
    }
  }
}

function workspacePixels(doc, frame, options) {
  const maxPixels = options.maxPixels === undefined ? DEFAULT_WORKSPACE_PIXELS : options.maxPixels;
  if (!Number.isSafeInteger(maxPixels) || maxPixels < 1) throw new RangeError('工作区像素容量须为正整数。');
  const documents = options.documents === undefined ? [doc] : options.documents;
  if (!Array.isArray(documents) || !documents.includes(doc)) throw new Error('素材已不在当前工作区，未调整画幅。');
  let total = frame.width * frame.height * doc.layers.length;
  for (const other of new Set(documents)) {
    if (other === doc) continue;
    if (!other || !Array.isArray(other.layers)) throw new TypeError('工作区素材信息无效。');
    dimensions(other.width, other.height);
    total += other.width * other.height * other.layers.length;
    if (!Number.isSafeInteger(total)) throw new RangeError('工作区图层像素总量超出安全范围。');
  }
  return { total, maxPixels };
}

function disposeCanvases(layers) {
  for (const layer of layers) {
    try { layer.canvas.width = 1; layer.canvas.height = 1; } catch { /* Preserve the original failure. */ }
  }
}

function copyLayerWithCanvas(layer, canvas) {
  const descriptors = Object.getOwnPropertyDescriptors(layer);
  const previous = descriptors.canvas;
  descriptors.canvas = {
    value: canvas,
    writable: previous && 'value' in previous ? previous.writable : true,
    enumerable: previous ? previous.enumerable : true,
    configurable: previous ? previous.configurable : true,
  };
  // Retain own metadata, symbols and descriptors, not only the known UI fields.
  return Object.create(Object.getPrototypeOf(layer), descriptors);
}

/**
 * Validate the entire operation before allocating any output canvas, then stage
 * transparent canvases and integer RGBA copies for ALL layers (hidden/locked too).
 * Nothing in doc, its canvases or its history is mutated. The caller owns the
 * returned canvases; applyCanvasFrame stages and consumes its own result.
 */
export function prepareCanvasFrame(doc, requestedFrame, options = {}) {
  if (!options || typeof options !== 'object') throw new TypeError('画幅选项无效。');
  validateDocument(doc);
  const frame = validateFrame(requestedFrame);
  const changed = frame.x !== 0 || frame.y !== 0 || frame.width !== doc.width || frame.height !== doc.height;
  const budget = workspacePixels(doc, frame, options);
  if (!changed) return { changed: false, frame, width: doc.width, height: doc.height, layers: doc.layers, workspacePixels: budget.total };
  if (budget.total > budget.maxPixels) {
    throw new RangeError('调整后工作区图层像素总量超限，请缩小画幅或先关闭部分素材。');
  }

  const left = Math.max(0, frame.x), top = Math.max(0, frame.y);
  const right = Math.min(doc.width, frame.x + frame.width);
  const bottom = Math.min(doc.height, frame.y + frame.height);
  const copyWidth = Math.max(0, right - left), copyHeight = Math.max(0, bottom - top);
  const layers = [];
  let pending = null;
  try {
    for (const layer of doc.layers) {
      pending = makeCanvas(frame.width, frame.height);
      const targetContext = pending.getContext('2d');
      if (!targetContext) throw new Error('无法分配画幅画布，当前素材保持不变。');
      if (copyWidth && copyHeight) {
        const sourceContext = layer.canvas.getContext('2d');
        if (!sourceContext) throw new Error('无法读取图层像素，当前素材保持不变。');
        const pixels = sourceContext.getImageData(left, top, copyWidth, copyHeight);
        targetContext.putImageData(pixels, left - frame.x, top - frame.y);
      }
      layers.push(copyLayerWithCanvas(layer, pending));
      pending = null;
    }
    return { changed: true, frame, width: frame.width, height: frame.height, layers, workspacePixels: budget.total };
  } catch (error) {
    if (pending) disposeCanvases([{ canvas: pending }]);
    disposeCanvases(layers);
    throw error;
  }
}

// PaintDocument uses writable own data properties. Check that contract before
// expensive work so the final, synchronous property swap has no setter callbacks.
function assertWritableCommitFields(doc) {
  const extensible = Object.isExtensible(doc);
  for (const key of COMMIT_FIELDS) {
    const descriptor = Object.getOwnPropertyDescriptor(doc, key);
    if (descriptor ? !('value' in descriptor) || !descriptor.writable : !extensible) {
      throw new TypeError('当前素材的 ' + key + ' 不可写，未调整画幅。');
    }
  }
}

function swapCommittedFields(doc, candidate) {
  const descriptors = {};
  for (const key of COMMIT_FIELDS) {
    const previous = Object.getOwnPropertyDescriptor(doc, key);
    descriptors[key] = previous ? { ...previous, value: candidate[key] } : {
      value: candidate[key], writable: true, enumerable: true, configurable: true,
    };
  }
  Object.defineProperties(doc, descriptors);
}

/**
 * Apply atomically with exactly one existing PaintDocument history commit.
 * Canvas allocation/copying and history capture all run on a detached candidate.
 * A failure leaves original dimensions/layers/pixels/history/revision untouched.
 * Returns false for a true no-op; a shifted frame of equal size is still a change.
 */
export function applyCanvasFrame(doc, frame, options = {}) {
  validateDocument(doc);
  const normalized = validateFrame(frame);
  const changed = normalized.x !== 0 || normalized.y !== 0 || normalized.width !== doc.width || normalized.height !== doc.height;
  if (!changed) {
    prepareCanvasFrame(doc, normalized, options); // Validate options, but allocate and commit nothing.
    return false;
  }
  if (typeof doc.commit !== 'function' || !Array.isArray(doc.history)) throw new TypeError('当前素材不支持可撤销的画幅编辑。');
  assertWritableCommitFields(doc);
  const stage = prepareCanvasFrame(doc, normalized, options);
  try {
    const candidate = Object.create(Object.getPrototypeOf(doc), Object.getOwnPropertyDescriptors(doc));
    candidate.width = stage.width; candidate.height = stage.height; candidate.layers = stage.layers;
    // Existing history entries are immutable in core.commit(); detach the array so
    // even a failed commit after truncation cannot change the original history.
    candidate.history = doc.history.slice();
    candidate.commit('调整画幅');
    candidate._composite = null; candidate._thumb = null;
    assertWritableCommitFields(doc);
    swapCommittedFields(doc, candidate);
    return true;
  } catch (error) {
    disposeCanvases(stage.layers);
    throw error;
  }
}
