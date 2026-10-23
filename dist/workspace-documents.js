import { PaintDocument, makeCanvas, uid } from './core.js';

const MAX_SIDE = 8192;
const MAX_DOCUMENT_PIXELS = 32 * 1024 * 1024;
const usableId = value => typeof value === 'string' && value.trim().length > 0;

function documentPixels(document) {
  if (!(document instanceof PaintDocument)) throw new TypeError('新增素材须为有效的绘画文档。');
  if (!usableId(document.id)) throw new TypeError('素材标识无效。');
  const { width, height, layers } = document;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_DOCUMENT_PIXELS) {
    throw new RangeError('素材尺寸须为 1–8192 像素，且单张面积不超过 3200 万像素。');
  }
  if (!Array.isArray(layers) || layers.length < 1 || layers.length > 50) throw new RangeError('每张图片须包含 1–50 个图层。');
  const layerIds = new Set();
  for (const layer of layers) {
    if (!layer || !usableId(layer.id) || layerIds.has(layer.id)) throw new TypeError('素材包含无效或重复的图层标识。');
    layerIds.add(layer.id);
    const canvas = layer.canvas;
    if (!canvas || canvas.width !== width || canvas.height !== height || typeof canvas.getContext !== 'function' || typeof canvas.toDataURL !== 'function') {
      throw new TypeError('素材图层画布无效，或尺寸与素材不一致。');
    }
    let context;
    try { context = canvas.getContext('2d'); } catch { /* Report one consistent validation error. */ }
    if (!context || typeof context.drawImage !== 'function' || typeof context.getImageData !== 'function') throw new TypeError('无法读取素材图层画布。');
    if (layer.opacity !== undefined && (!Number.isFinite(layer.opacity) || layer.opacity < 0 || layer.opacity > 1)) throw new RangeError('图层不透明度须为 0–1 之间的数值。');
  }
  if (!layerIds.has(document.activeLayerId)) throw new TypeError('素材的活动图层不存在。');
  return width * height * layers.length;
}

/** A new editable asset, with independent pixels/history and no source-file binding. */
export function createDocumentCopy(source, existingDocs, { maxPixels = 128 * 1024 * 1024 } = {}) {
  if (!existingDocs.includes(source)) throw new Error('素材已关闭，请重新选择。');
  if (existingDocs.length >= 100) throw new RangeError('工作区最多支持 100 张图片，请先移除部分素材。');
  const sourcePixels = documentPixels(source);
  if (existingDocs.reduce((total, item) => total + documentPixels(item), sourcePixels) > maxPixels) {
    throw new RangeError('创建副本会超过工作区图层像素容量，请先保存并拆分项目。');
  }
  const original = String(source.name || '未命名.png');
  const split = original.lastIndexOf('.');
  const extension = split > 0 ? original.slice(split) : '.png';
  const stem = (split > 0 ? original.slice(0, split) : original).replace(/ 副本(?: \d+)?$/, '');
  const used = new Set(existingDocs.map(item => item.name.toLocaleLowerCase()));
  let name = `${stem} 副本${extension}`, number = 2;
  while (used.has(name.toLocaleLowerCase())) name = `${stem} 副本 ${number++}${extension}`;
  const result = new PaintDocument({ name, width: source.width, height: source.height });
  result.layers = source.layers.map(layer => {
    const canvas = makeCanvas(source.width, source.height);
    canvas.getContext('2d').putImageData(layer.canvas.getContext('2d').getImageData(0, 0, source.width, source.height), 0, 0);
    return { ...layer, id: uid(), canvas };
  });
  const activeIndex = Math.max(0, source.layers.findIndex(layer => layer.id === source.activeLayerId));
  result.activeLayerId = result.layers[activeIndex].id;
  result.fileHandle = null; result.path = ''; result.isDemo = false;
  result.resetHistory('创建素材副本'); result.dirty = true;
  return result;
}

/** Validate the whole batch and plan IDs without changing any supplied object. */
export function prepareWorkspaceDocuments(existingDocs, incomingDocs, { maxDocuments = 100, maxPixels = 64 * 1024 * 1024, makeId = uid } = {}) {
  if (!Array.isArray(existingDocs) || !Array.isArray(incomingDocs)) throw new TypeError('工作区素材列表格式无效。');
  if (!incomingDocs.length) throw new RangeError('没有可加入工作区的素材。');
  if (!Number.isSafeInteger(maxDocuments) || maxDocuments < 1 || !Number.isSafeInteger(maxPixels) || maxPixels < 1 || typeof makeId !== 'function') throw new TypeError('工作区容量设置无效。');
  if (existingDocs.length + incomingDocs.length > maxDocuments) throw new RangeError('工作区最多支持 ' + maxDocuments + ' 张图片，请先移除部分素材。');

  const objects = new Set(existingDocs), usedIds = new Set();
  let totalPixels = 0;
  for (const document of existingDocs) {
    totalPixels += documentPixels(document);
    if (usedIds.has(document.id)) throw new TypeError('工作区已有重复的素材标识，请重新打开工程。');
    usedIds.add(document.id);
  }
  for (const document of incomingDocs) {
    if (objects.has(document)) throw new TypeError('同一素材对象不能重复加入工作区，请先创建独立副本。');
    objects.add(document);
    totalPixels += documentPixels(document);
  }
  if (totalPixels > maxPixels) throw new RangeError('当前工作区的图层像素总量超过容量，请保存并拆分项目后继续。');

  // Reserve original IDs up front so a generated ID cannot take the identity
  // of a later, otherwise unique incoming document.
  const reservedIds = new Set([...usedIds, ...incomingDocs.map(document => document.id)]);
  const entries = incomingDocs.map(document => {
    let id = document.id;
    if (usedIds.has(id)) {
      id = null;
      for (let attempt = 0; attempt < 128; attempt++) {
        const candidate = makeId();
        if (usableId(candidate) && !reservedIds.has(candidate)) { id = candidate; break; }
      }
      if (id === null) throw new Error('无法生成唯一的素材标识，请重试。');
    }
    usedIds.add(id); reservedIds.add(id);
    return { document, id };
  });
  return { entries, totalPixels };
}
