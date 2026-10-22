import { makeCanvas, PaintDocument, uid } from './core.js';

/** Copy a raster on the integer grid. No resampling or compositing is involved. */
export function paddedCanvas(source, plan) {
  if (!Number.isInteger(plan.offsetX) || !Number.isInteger(plan.offsetY) ||
      plan.offsetX < 0 || plan.offsetY < 0 ||
      source.width + plan.offsetX > plan.width || source.height + plan.offsetY > plan.height) {
    throw new RangeError('扩边结果不能裁切原画布，且偏移必须是整数像素。');
  }
  const canvas = makeCanvas(plan.width, plan.height);
  const pixels = source.getContext('2d').getImageData(0, 0, source.width, source.height);
  canvas.getContext('2d').putImageData(pixels, plan.offsetX, plan.offsetY);
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
    doc.commit(`透明扩边 · ${plan.width} × ${plan.height}`);
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
  doc.resetHistory('创建透明扩边副本');
  doc.dirty = true;
  return doc;
}
