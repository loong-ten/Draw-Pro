import { makeCanvas, PaintDocument, uid } from './core.js';

// Pillow NEAREST walks pixel centers by repeated floating-point addition.
// Computing (x + 0.5) * step independently can choose a different boundary
// pixel (for example 4 -> 7 at x = 3). Keep the walk deterministic on both axes.
function nearestIndices(sourceSize, targetSize) {
  const indices = new Uint32Array(targetSize);
  const step = sourceSize / targetSize;
  let position = step / 2;
  for (let index = 0; index < targetSize; index++, position += step) {
    indices[index] = Math.min(sourceSize - 1, Math.floor(position));
  }
  return indices;
}

/** Copy integer RGBA pixels; resize uses nearest neighbors without alpha blending. */
export function paddedCanvas(source, plan) {
  const resize = plan?.operation === 'resize';
  const contentWidth = resize ? plan.contentWidth : source.width;
  const contentHeight = resize ? plan.contentHeight : source.height;
  if (!plan || !Number.isSafeInteger(plan.width) || !Number.isSafeInteger(plan.height) ||
      !Number.isSafeInteger(contentWidth) || !Number.isSafeInteger(contentHeight) ||
      contentWidth < 1 || contentHeight < 1 ||
      !Number.isInteger(plan.offsetX) || !Number.isInteger(plan.offsetY) ||
      plan.offsetX < 0 || plan.offsetY < 0 ||
      contentWidth + plan.offsetX > plan.width || contentHeight + plan.offsetY > plan.height) {
    throw new RangeError('结果不能裁切内容画布，且尺寸与偏移必须是整数像素。');
  }
  const canvas = makeCanvas(plan.width, plan.height);
  const pixels = source.getContext('2d').getImageData(0, 0, source.width, source.height);
  const context = canvas.getContext('2d');
  if (!resize || (contentWidth === source.width && contentHeight === source.height)) {
    context.putImageData(pixels, plan.offsetX, plan.offsetY);
    return canvas;
  }
  const output = context.createImageData(contentWidth, contentHeight);
  // Both views use the same native byte order; each word copies all RGBA bytes
  // together, including alpha=0 and low-alpha pixels. No interpolation or mask.
  const inputWords = new Uint32Array(pixels.data.buffer, pixels.data.byteOffset, pixels.data.length / 4);
  const outputWords = new Uint32Array(output.data.buffer, output.data.byteOffset, output.data.length / 4);
  const sourceX = nearestIndices(source.width, contentWidth);
  const sourceY = nearestIndices(source.height, contentHeight);
  for (let y = 0; y < contentHeight; y++) {
    const inputRow = sourceY[y] * source.width;
    const outputRow = y * contentWidth;
    for (let x = 0; x < contentWidth; x++) {
      outputWords[outputRow + x] = inputWords[inputRow + sourceX[x]];
    }
  }
  context.putImageData(output, plan.offsetX, plan.offsetY);
  return canvas;
}

/** Includes hidden and locked layers, retaining their metadata and relative positions. */
export function paddedLayers(source, plan, newIds = false) {
  return source.layers.map(layer => ({
    ...layer, id: newIds ? uid() : layer.id, canvas: paddedCanvas(layer.canvas, plan),
  }));
}

export function applyPaddingSnapshot(doc, source, plan) {
  const layers = paddedLayers(source, plan);
  const previous = {
    layers: doc.layers, width: doc.width, height: doc.height, activeLayerId: doc.activeLayerId,
    history: doc.history, historyIndex: doc.historyIndex, revision: doc.revision, dirty: doc.dirty,
  };
  try {
    doc.layers = layers;
    doc.width = plan.width; doc.height = plan.height;
    doc.activeLayerId = layers.some(layer => layer.id === previous.activeLayerId) ? previous.activeLayerId : source.activeLayerId;
    doc.commit(`${plan.operation === 'resize' ? '宽高缩放' : '透明扩边'} · ${plan.width} × ${plan.height}`);
  } catch (error) {
    Object.assign(doc, previous);
    throw error;
  }
  doc._composite = null; doc._thumb = null; doc.isDemo = false;
  if (doc.view) doc.view.fit = true;
  return doc;
}

export function duplicateWithPadding(source, plan, name) {
  const layers = paddedLayers(source, plan, true);
  const doc = new PaintDocument({ name, width: plan.width, height: plan.height });
  doc.layers = layers;
  const index = source.layers.findIndex(layer => layer.id === source.activeLayerId);
  doc.activeLayerId = layers[Math.max(0, index)].id;
  doc.resetHistory(plan.operation === 'resize' ? '创建宽高缩放副本' : '创建透明扩边副本');
  doc.dirty = true;
  return doc;
}
