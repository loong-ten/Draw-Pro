import { cloneCanvas, normalizeBlend, uid } from './core.js';

const MAX_WORKSPACE_LAYER_PIXELS = 128 * 1024 * 1024;

export function snapshotOptimizationTarget(target) {
  return {
    revision: target.revision, width: target.width, height: target.height, layerId: target.activeLayerId,
    layers: target.layers.map(layer => ({ layer, canvas: layer.canvas, visible: layer.visible, opacity: layer.opacity, blend: layer.blend, locked: layer.locked })),
  };
}

/** Validate the exact queued document before reading or applying its pixels. */
export function validateOptimizationSource(target, documents, expected, sourceMode = 'composite') {
  if (!documents.includes(target)) throw new Error('素材已关闭或工作区已切换，已跳过');
  const layerChanged = expected?.layers && (target.layers.length !== expected.layers.length || expected.layers.some((saved, index) => {
    const layer = target.layers[index];
    return layer !== saved.layer || layer.canvas !== saved.canvas || ['visible','opacity','blend','locked'].some(key => layer[key] !== saved[key]);
  }));
  if (expected && (target.revision !== expected.revision || target.width !== expected.width || target.height !== expected.height ||
    layerChanged || (sourceMode === 'layer' && target.activeLayerId !== expected.layerId))) {
    throw new Error('素材在处理期间已修改，请重新优化');
  }
  if (sourceMode === 'layer' && !target.layers.some(layer => layer.id === expected?.layerId)) {
    throw new Error('原活动图层已不存在，请重新读取');
  }
}

export function validateOptimizationTarget(target, documents, expected, sourceMode = 'composite') {
  validateOptimizationSource(target, documents, expected, sourceMode);
  if (target.layers.length >= 50) throw new Error('该素材已达到 50 个图层上限');
  const total = documents.reduce((n, d) => n + d.width * d.height * d.layers.length, 0) + target.width * target.height;
  if (total > MAX_WORKSPACE_LAYER_PIXELS) throw new Error('工作区图层像素总量已达上限，请保存并拆分项目');
}

/** Apply to an explicit document, preserving source layers and one undo step. */
export function applyOptimizationResult(target, canvas, { documents, expected, sourceMode = 'composite', label = '应用像素优化' }) {
  validateOptimizationTarget(target, documents, expected, sourceMode);
  if (canvas.width !== target.width || canvas.height !== target.height) throw new Error('优化结果尺寸与原画布不一致');
  const source = sourceMode === 'layer' ? target.layers.find(layer => layer.id === expected.layerId) : null;
  const result = {
    id: uid(), name: label, canvas: cloneCanvas(canvas),
    visible: source ? source.visible !== false : true,
    opacity: source ? source.opacity : 1,
    blend: source ? normalizeBlend(source.blend) : 'source-over', locked: false,
  };
  const before = {
    layers: target.layers, activeLayerId: target.activeLayerId, dirty: target.dirty,
    revision: target.revision, history: target.history, historyIndex: target.historyIndex,
  };
  const layers = target.layers.map(layer => !source || layer.id === source.id ? { ...layer, visible: false } : layer);
  const insertion = source ? layers.findIndex(layer => layer.id === source.id) + 1 : layers.length;
  layers.splice(insertion, 0, result);
  try {
    target.layers = layers;
    target.activeLayerId = result.id;
    target.commit(label);
  } catch (error) {
    Object.assign(target, before);
    throw error;
  }
  target.isDemo = false;
  target._composite = null;
  target._thumb = null;
  return result;
}
