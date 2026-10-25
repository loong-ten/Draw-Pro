import { makeCanvas, PaintDocument, uid } from './core.js';
import { resampleRGBA, resampleRGBAAsync, validateResamplePlan } from './image-resampling.js';

const MAX_LAYER_PIXELS = 128 * 1024 * 1024;
const COMMIT_FIELDS = ['layers', 'width', 'height', 'activeLayerId', 'history', 'historyIndex', 'revision', 'dirty', '_composite', '_thumb', 'isDemo'];

function abortError() {
  const error = new Error('已取消图像缩放。');
  error.name = 'AbortError';
  return error;
}
function checkAbort(signal) { if (signal?.aborted) throw abortError(); }

function releaseCanvas(canvas) {
  try { canvas.width = 1; canvas.height = 1; } catch { /* Keep the original failure. */ }
}
function releaseLayers(layers) { for (const layer of layers) releaseCanvas(layer.canvas); }

function copyLayer(layer, canvas, newId = false) {
  const descriptors = Object.getOwnPropertyDescriptors(layer);
  for (const [key, value] of [['canvas', canvas], ...(newId ? [['id', uid()]] : [])]) {
    const previous = descriptors[key];
    descriptors[key] = {
      value, writable: previous && 'value' in previous ? previous.writable : true,
      enumerable: previous ? previous.enumerable : true, configurable: previous ? previous.configurable : true,
    };
  }
  return Object.create(Object.getPrototypeOf(layer), descriptors);
}

function normalizePlan(source, plan) {
  if (!source || typeof source.getContext !== 'function') throw new TypeError('缺少有效的原图画布。');
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new RangeError('缺少有效的扩边或缩放参数。');
  const resize = plan.operation === 'resize';
  const crop = plan.operation === 'crop';
  const contentWidth = resize ? plan.contentWidth : source.width;
  const contentHeight = resize ? plan.contentHeight : source.height;
  // Both outer canvas and inner content limits are checked before getImageData,
  // canvas allocation, Worker creation or any potentially large pixel buffers.
  validateResamplePlan(source.width, source.height, { width: plan.width, height: plan.height });
  const sampling = validateResamplePlan(source.width, source.height, {
    width: contentWidth, height: contentHeight,
    algorithm: resize ? plan.algorithm : 'nearest', sourceRect: resize ? plan.sourceRect : undefined,
  });
  if (!Number.isSafeInteger(plan.offsetX) || !Number.isSafeInteger(plan.offsetY) ||
      (crop ? Math.abs(plan.offsetX) > 8192 || Math.abs(plan.offsetY) > 8192 :
        plan.offsetX < 0 || plan.offsetY < 0 ||
        contentWidth + plan.offsetX > plan.width || contentHeight + plan.offsetY > plan.height)) {
    throw new RangeError('结果不能裁切内容画布，且尺寸与偏移必须是整数像素。');
  }
  const rect = sampling.sourceRect;
  const needsSampling = resize && (contentWidth !== source.width || contentHeight !== source.height ||
    rect.x !== 0 || rect.y !== 0 || rect.width !== source.width || rect.height !== source.height);
  return {
    ...plan, contentWidth, contentHeight, algorithm: sampling.algorithm, sourceRect: rect,
    sampling, needsSampling,
  };
}

function validateLayers(source, plan) {
  if (!source || !Array.isArray(source.layers) || !source.layers.length || source.layers.length > 50) {
    throw new RangeError('当前素材须包含 1–50 个有效图层。');
  }
  const normalized = normalizePlan(source.layers[0]?.canvas, plan);
  if (source.width !== source.layers[0].canvas.width || source.height !== source.layers[0].canvas.height) {
    throw new RangeError('原图尺寸与图层画布不一致。');
  }
  for (const layer of source.layers) {
    if (!layer?.canvas || typeof layer.canvas.getContext !== 'function' ||
        layer.canvas.width !== source.width || layer.canvas.height !== source.height) {
      throw new RangeError('所有图层必须与原图画布尺寸一致。');
    }
  }
  if (source.width * source.height * source.layers.length > MAX_LAYER_PIXELS ||
      normalized.width * normalized.height * source.layers.length > MAX_LAYER_PIXELS) {
    throw new RangeError('缩放前后图层总量不能超过 128 Mi 像素，请减小尺寸或减少图层。');
  }
  return normalized;
}

function readPixels(source) {
  const context = source.getContext('2d');
  if (!context) throw new Error('无法读取图层像素，原素材保持不变。');
  return context.getImageData(0, 0, source.width, source.height);
}

function canvasFromPixels(pixels, plan) {
  const canvas = makeCanvas(plan.width, plan.height);
  try {
    const context = canvas.getContext('2d');
    if (!context) throw new Error('无法分配结果画布，原素材保持不变。');
    let image;
    if (typeof ImageData === 'function') image = new ImageData(pixels.data, pixels.width, pixels.height);
    else { image = context.createImageData(pixels.width, pixels.height); image.data.set(pixels.data); }
    context.putImageData(image, plan.offsetX, plan.offsetY);
    return canvas;
  } catch (error) { releaseCanvas(canvas); throw error; }
}

/** Integer padding or exact selected sampling; never uses browser smoothing. */
export function paddedCanvas(source, plan) {
  const normalized = normalizePlan(source, plan);
  const input = readPixels(source);
  const result = normalized.needsSampling ? resampleRGBA(input, normalized.sampling) : input;
  return canvasFromPixels(result, normalized);
}

function nextTask(signal) {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(abortError()); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, 0);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

// One lazily-created module Worker serves all layers of an operation in order.
// A failed Worker is an explicit error; it never substitutes another algorithm.
function workerSession(signal) {
  let worker = null, pending = null, sequence = 0, closed = false;
  const stop = () => { if (worker) { worker.terminate(); worker = null; } };
  const fail = error => {
    closed = true; stop();
    if (pending) { const waiting = pending; pending = null; waiting.reject(error); }
  };
  const abort = () => fail(abortError());
  signal?.addEventListener('abort', abort, { once: true });
  function start() {
    if (worker) return;
    try { worker = new Worker(new URL('./padding-resize-worker.js', import.meta.url), { type: 'module' }); }
    catch (error) { throw new Error(`无法启动图像缩放计算线程：${error?.message || '浏览器限制了后台计算'}。`); }
    worker.onmessage = ({ data }) => {
      if (!pending || data?.id !== pending.id) return;
      const waiting = pending; pending = null;
      if (data.error) {
        const error = new Error(`图像缩放计算失败：${data.error.message || '后台计算未完成。'}`);
        error.name = data.error.name || 'Error';
        closed = true; stop(); waiting.reject(error);
        return;
      }
      const result = data.result;
      if (result?.width !== waiting.width || result?.height !== waiting.height ||
          Object.prototype.toString.call(result?.data) !== '[object Uint8ClampedArray]' ||
          result.data.length !== waiting.width * waiting.height * 4) {
        closed = true; stop(); waiting.reject(new Error('图像缩放计算返回了无效的像素结果。'));
        return;
      }
      waiting.resolve(result);
    };
    worker.onerror = event => {
      event.preventDefault?.();
      fail(new Error(`图像缩放计算线程失败：${event.message || '请重试当前操作。'}`));
    };
    worker.onmessageerror = () => fail(new Error('无法读取图像缩放计算线程返回的数据。'));
  }
  return {
    run(image, options) {
      checkAbort(signal);
      if (closed || pending) throw new Error('图像缩放计算线程已关闭或仍在处理上一图层。');
      start();
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        pending = { id, resolve, reject, width: options.width, height: options.height };
        try {
          worker.postMessage({ id, image: { width: image.width, height: image.height, data: image.data }, options }, [image.data.buffer]);
        } catch (error) { fail(new Error(`无法传递图层像素至缩放计算线程：${error?.message || '数据传递失败'}。`)); }
      });
    },
    dispose() {
      signal?.removeEventListener('abort', abort);
      if (pending) fail(abortError());
      closed = true; stop();
    },
  };
}

async function prepareCanvasAsync(source, plan, signal, session) {
  checkAbort(signal);
  const normalized = normalizePlan(source, plan);
  await nextTask(signal); // Give the UI an immediate chance to cancel, also in tests without Worker.
  checkAbort(signal);
  const input = readPixels(source);
  const result = !normalized.needsSampling ? input : session ?
    await session.run(input, normalized.sampling) : await resampleRGBAAsync(input, normalized.sampling, { signal });
  checkAbort(signal);
  return canvasFromPixels(result, normalized);
}

/** Cancellable browser Worker path, with the same yielding algorithm when Worker is absent. */
export async function paddedCanvasAsync(source, plan, { signal } = {}) {
  checkAbort(signal);
  const normalized = normalizePlan(source, plan);
  const session = typeof Worker === 'function' ? workerSession(signal) : null;
  let result = null;
  try {
    result = await prepareCanvasAsync(source, normalized, signal, session);
    checkAbort(signal);
    return result;
  } catch (error) { if (result) releaseCanvas(result); throw error; }
  finally { session?.dispose(); }
}

/** Includes hidden / locked layers and all own metadata, symbols and descriptors. */
export function paddedLayers(source, plan, newIds = false) {
  const normalized = validateLayers(source, plan), result = [];
  let pendingCanvas = null;
  try {
    for (const layer of source.layers) {
      pendingCanvas = paddedCanvas(layer.canvas, normalized);
      result.push(copyLayer(layer, pendingCanvas, newIds)); pendingCanvas = null;
    }
    return result;
  } catch (error) {
    if (pendingCanvas) releaseCanvas(pendingCanvas);
    releaseLayers(result); throw error;
  }
}

/** Sequentially stage every layer. Cancel/failure disposes only staged canvases. */
export async function paddedLayersAsync(source, plan, { signal } = {}) {
  checkAbort(signal);
  const normalized = validateLayers(source, plan);
  const input = source.layers.map(layer => copyLayer(layer, layer.canvas));
  const result = [], session = typeof Worker === 'function' ? workerSession(signal) : null;
  let pendingCanvas = null;
  try {
    for (const layer of input) {
      checkAbort(signal);
      pendingCanvas = await prepareCanvasAsync(layer.canvas, normalized, signal, session);
      checkAbort(signal);
      result.push(copyLayer(layer, pendingCanvas)); pendingCanvas = null;
    }
    return result;
  } catch (error) {
    if (pendingCanvas) releaseCanvas(pendingCanvas);
    releaseLayers(result); throw error;
  } finally { session?.dispose(); }
}

function usePreparedLayers(source, plan, prepared) {
  if (!Array.isArray(prepared) || prepared.length !== source.layers.length) throw new RangeError('已准备的图层数量与原素材不一致。');
  const originals = new Set(source.layers.map(layer => layer.canvas)), seen = new Set();
  for (let i = 0; i < prepared.length; i++) {
    const layer = prepared[i];
    if (!layer || layer.id !== source.layers[i].id || !layer.canvas || typeof layer.canvas.getContext !== 'function' ||
        layer.canvas.width !== plan.width || layer.canvas.height !== plan.height ||
        originals.has(layer.canvas) || seen.has(layer.canvas)) {
      throw new RangeError('已准备的图层顺序、尺寸或独立像素画布无效，请重新生成预览。');
    }
    seen.add(layer.canvas);
  }
  return prepared.map((layer, index) => copyLayer(source.layers[index], layer.canvas));
}

function writableFields(doc, fields) {
  for (const key of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(doc, key);
    if (descriptor ? !('value' in descriptor) || !descriptor.writable : !Object.isExtensible(doc)) {
      throw new TypeError(`当前素材的 ${key} 不可写，原素材保持不变。`);
    }
  }
}

/**
 * Commit the prepared pixels exactly once on a detached candidate. With prepared
 * layers, their canvases become the document's canvases: the caller must not
 * clear/dispose them afterwards. Failed commits leave caller-owned results valid.
 */
export function applyPaddingSnapshot(doc, source, plan, preparedLayers) {
  const normalized = validateLayers(source, plan);
  if (!doc || typeof doc.commit !== 'function' || !Array.isArray(doc.history)) throw new TypeError('当前素材不支持可撤销编辑。');
  const fields = doc.view ? [...COMMIT_FIELDS, 'view'] : COMMIT_FIELDS;
  writableFields(doc, fields);
  const ownsLayers = preparedLayers === undefined;
  const layers = ownsLayers ? paddedLayers(source, normalized) : usePreparedLayers(source, normalized, preparedLayers);
  try {
    const candidate = Object.create(Object.getPrototypeOf(doc), Object.getOwnPropertyDescriptors(doc));
    candidate.layers = layers; candidate.width = normalized.width; candidate.height = normalized.height;
    candidate.activeLayerId = layers.some(layer => layer.id === doc.activeLayerId) ? doc.activeLayerId :
      layers.some(layer => layer.id === source.activeLayerId) ? source.activeLayerId : layers[0].id;
    candidate.history = doc.history.slice();
    if (doc.view) candidate.view = { ...doc.view, fit: true };
    candidate.commit(`${plan.operation === 'resize' ? '宽高缩放' : plan.operation === 'crop' ? '画布裁剪' : '透明扩边'} · ${plan.width} × ${plan.height}`);
    candidate._composite = null; candidate._thumb = null; candidate.isDemo = false;
    writableFields(doc, fields);
    Object.defineProperties(doc, Object.fromEntries(fields.map(key => {
      const previous = Object.getOwnPropertyDescriptor(doc, key);
      return [key, previous ? { ...previous, value: candidate[key] } : {
        value: candidate[key], writable: true, enumerable: true, configurable: true,
      }];
    })));
    return doc;
  } catch (error) { if (ownsLayers) releaseLayers(layers); throw error; }
}

/** Always allocate independent canvases / new IDs, including for prepared results. */
export function duplicateWithPadding(source, plan, name, preparedLayers) {
  const normalized = validateLayers(source, plan);
  const prepared = preparedLayers === undefined ? null : usePreparedLayers(source, normalized, preparedLayers);
  const layers = [];
  let pendingCanvas = null;
  try {
    for (let i = 0; i < source.layers.length; i++) {
      pendingCanvas = prepared ? canvasFromPixels(readPixels(prepared[i].canvas), {
        width: normalized.width, height: normalized.height, offsetX: 0, offsetY: 0,
      }) : paddedCanvas(source.layers[i].canvas, normalized);
      layers.push(copyLayer(source.layers[i], pendingCanvas, true)); pendingCanvas = null;
    }
    // Avoid allocating a disposable full-size blank canvas + its history first.
    const doc = new PaintDocument({ name, width: 1, height: 1 });
    doc.width = normalized.width; doc.height = normalized.height; doc.layers = layers;
    const index = source.layers.findIndex(layer => layer.id === source.activeLayerId);
    doc.activeLayerId = layers[Math.max(0, index)].id;
    doc.resetHistory(plan.operation === 'resize' ? '创建宽高缩放副本' : plan.operation === 'crop' ? '创建画布裁剪副本' : '创建透明扩边副本');
    doc.dirty = true;
    return doc;
  } catch (error) {
    if (pendingCanvas) releaseCanvas(pendingCanvas);
    releaseLayers(layers); throw error;
  }
}
