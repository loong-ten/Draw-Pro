/* Deterministic RGBA resampling, independent of browser canvas smoothing.
 * Pixel centers are i + 0.5. The crop is a continuous source-space rectangle.
 * Triangle / Catmull-Rom / Lanczos kernels widen for reduction and normalize at
 * image edges. Area integrates the exact source-pixel overlap of each footprint.
 * Filtering uses premultiplied alpha; RGB is not converted to linear light.
 */
export const RESAMPLING_ALGORITHMS = Object.freeze(['nearest', 'bilinear', 'bicubic', 'lanczos3', 'area']);
const MAX_SIDE = 8192;
const MAX_PIXELS = 32 * 1024 * 1024;
const ROW_CACHE_BYTES = 16 * 1024 * 1024;
const WORK_CHUNK = 32768;

function dimensions(width, height, label) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 ||
      width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS) {
    throw new RangeError(`${label}尺寸须为 1–8192 整数像素，且面积不超过 32 Mi 像素。`);
  }
}

/** Validate geometry without allocating pixels. Returned objects are detached. */
export function validateResamplePlan(sourceWidth, sourceHeight, options = {}) {
  dimensions(sourceWidth, sourceHeight, '原图');
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('缩放参数无效。');
  const { width, height } = options;
  dimensions(width, height, '缩放结果');
  const algorithm = options.algorithm ?? 'nearest';
  if (!RESAMPLING_ALGORITHMS.includes(algorithm)) throw new RangeError('请选择最近邻、双线性、双三次、Lanczos 3 或面积均值采样。');
  const rect = options.sourceRect ?? { x: 0, y: 0, width: sourceWidth, height: sourceHeight };
  if (!rect || typeof rect !== 'object' || Array.isArray(rect) ||
      !['x', 'y', 'width', 'height'].every(key => typeof rect[key] === 'number' && Number.isFinite(rect[key])) ||
      rect.x < 0 || rect.y < 0 || rect.width <= 0 || rect.height <= 0 ||
      rect.x >= sourceWidth || rect.y >= sourceHeight) {
    throw new RangeError('原图裁切范围必须是原画布内的有限正尺寸矩形。');
  }
  const right = rect.x + rect.width, bottom = rect.y + rect.height;
  const epsilon = Number.EPSILON * Math.max(sourceWidth, sourceHeight) * 8;
  if (right <= rect.x || bottom <= rect.y || right > sourceWidth + epsilon || bottom > sourceHeight + epsilon) {
    throw new RangeError('原图裁切范围不能超出原画布。');
  }
  const sourceRect = {
    x: rect.x, y: rect.y,
    width: Math.min(sourceWidth, right) - rect.x,
    height: Math.min(sourceHeight, bottom) - rect.y,
  };
  if (!(sourceRect.width / width > 0) || !(sourceRect.height / height > 0) ||
      sourceRect.x + sourceRect.width / width <= sourceRect.x ||
      sourceRect.y + sourceRect.height / height <= sourceRect.y) {
    throw new RangeError('原图裁切范围过小，无法可靠计算像素位置。');
  }
  return { width, height, algorithm, sourceRect };
}

function validateImage(image, options) {
  if (!image || typeof image !== 'object') throw new TypeError('缺少原图 RGBA 像素。');
  const plan = validateResamplePlan(image.width, image.height, options);
  const kind = Object.prototype.toString.call(image.data);
  if (!['[object Uint8Array]', '[object Uint8ClampedArray]'].includes(kind) ||
      image.data.length !== image.width * image.height * 4) {
    throw new TypeError('原图必须包含与宽高一致的 8 位 RGBA 像素数据。');
  }
  return plan;
}

function abortError() {
  const error = new Error('已取消图像缩放。');
  error.name = 'AbortError';
  return error;
}

function checkAbort(signal) { if (signal?.aborted) throw abortError(); }

function kernel(algorithm, value) {
  const x = Math.abs(value);
  if (algorithm === 'bilinear') return x < 1 ? 1 - x : 0;
  if (algorithm === 'bicubic') {
    if (x < 1) return ((1.5 * x - 2.5) * x) * x + 1;
    if (x < 2) return ((-0.5 * x + 2.5) * x - 4) * x + 2;
    return 0;
  }
  if (x === 0) return 1;
  if (x >= 3) return 0;
  const piX = Math.PI * x;
  return Math.sin(piX) / piX * (Math.sin(piX / 3) / (piX / 3));
}

// NEAREST deliberately uses repeated addition, as Pillow does. Replacing this
// with (i + 0.5) * step changes exact boundary choices, e.g. 4 -> 7 at i = 3.
function nearestIndices(size, target, origin, span) {
  const result = new Uint32Array(target), step = span / target;
  let center = origin + step / 2;
  for (let i = 0; i < target; i++, center += step) result[i] = Math.max(0, Math.min(size - 1, Math.floor(center)));
  return result;
}

function axisWeights(size, target, origin, span, algorithm) {
  const step = span / target, filterScale = Math.max(1, step);
  const radius = (algorithm === 'bilinear' ? 1 : algorithm === 'bicubic' ? 2 : 3) * filterScale;
  const result = new Array(target);
  for (let out = 0; out < target; out++) {
    const center = origin + (out + 0.5) * step;
    const left = origin + out * step;
    const right = out === target - 1 ? origin + span : origin + (out + 1) * step;
    const start = Math.max(0, algorithm === 'area' ? Math.floor(left) : Math.ceil(center - radius - 0.5));
    const end = Math.min(size - 1, algorithm === 'area' ? Math.ceil(right) - 1 : Math.floor(center + radius - 0.5));
    const weights = new Float64Array(end - start + 1);
    let total = 0;
    for (let i = start; i <= end; i++) {
      const weight = algorithm === 'area' ? Math.max(0, Math.min(right, i + 1) - Math.max(left, i)) :
        kernel(algorithm, (i + 0.5 - center) / filterScale);
      weights[i - start] = weight;
      total += weight;
    }
    if (!Number.isFinite(total) || (algorithm === 'area' ? total <= 0 : Math.abs(total) < 1e-12)) {
      throw new RangeError('无法计算当前缩放范围的采样权重。');
    }
    for (let i = 0; i < weights.length; i++) weights[i] /= total;
    result[out] = { start, weights };
  }
  return result;
}

const byte = value => Math.max(0, Math.min(255, Math.round(value)));

function* resamplingSteps(image, plan) {
  const { width, height, algorithm, sourceRect: rect } = plan;
  const input = image.data, output = new Uint8ClampedArray(width * height * 4);
  const result = { width, height, data: output };
  let work = 0;

  // Identity and integer, unit-scale crops preserve *every* observed RGBA byte,
  // including RGB hidden beneath alpha=0. No filtering is needed in this case.
  if (Number.isInteger(rect.x) && Number.isInteger(rect.y) && rect.width === width && rect.height === height) {
    for (let y = 0; y < height; y++) {
      const offset = ((rect.y + y) * image.width + rect.x) * 4;
      output.set(input.subarray(offset, offset + width * 4), y * width * 4);
      if ((work += width) >= WORK_CHUNK) { work = 0; yield; }
    }
    return result;
  }

  if (algorithm === 'nearest') {
    const xs = nearestIndices(image.width, width, rect.x, rect.width);
    const ys = nearestIndices(image.height, height, rect.y, rect.height);
    const aligned = input.byteOffset % 4 === 0;
    const inputWords = aligned ? new Uint32Array(input.buffer, input.byteOffset, input.length / 4) : null;
    const outputWords = new Uint32Array(output.buffer);
    for (let y = 0; y < height; y++) {
      const row = ys[y] * image.width;
      for (let x = 0; x < width; x++) {
        if (aligned) outputWords[y * width + x] = inputWords[row + xs[x]];
        else {
          const from = (row + xs[x]) * 4, to = (y * width + x) * 4;
          output[to] = input[from]; output[to + 1] = input[from + 1];
          output[to + 2] = input[from + 2]; output[to + 3] = input[from + 3];
        }
      }
      if ((work += width) >= WORK_CHUNK) { work = 0; yield; }
    }
    return result;
  }

  const xs = axisWeights(image.width, width, rect.x, rect.width, algorithm);
  const ys = axisWeights(image.height, height, rect.y, rect.height, algorithm);
  const cache = new Map();
  const maxRows = Math.max(1, Math.min(image.height, Math.floor(ROW_CACHE_BYTES / (width * 4 * Float64Array.BYTES_PER_ELEMENT))));
  const accumulated = new Float64Array(width * 4);

  function* horizontalRow(y) {
    let row = cache.get(y);
    if (row) { cache.delete(y); cache.set(y, row); return row; }
    if (cache.size >= maxRows) {
      const oldest = cache.keys().next().value;
      row = cache.get(oldest); cache.delete(oldest);
    } else row = new Float64Array(width * 4);
    for (let x = 0; x < width; x++) {
      const { start, weights } = xs[x];
      let red = 0, green = 0, blue = 0, alpha = 0;
      for (let i = 0; i < weights.length; i++) {
        const at = (y * image.width + start + i) * 4;
        const weightedAlpha = input[at + 3] * weights[i];
        red += input[at] * weightedAlpha;
        green += input[at + 1] * weightedAlpha;
        blue += input[at + 2] * weightedAlpha;
        alpha += weightedAlpha;
      }
      const to = x * 4;
      row[to] = red; row[to + 1] = green; row[to + 2] = blue; row[to + 3] = alpha;
      if ((work += weights.length) >= WORK_CHUNK) { work = 0; yield; }
    }
    cache.set(y, row);
    return row;
  }

  for (let y = 0; y < height; y++) {
    accumulated.fill(0);
    const { start, weights } = ys[y];
    for (let i = 0; i < weights.length; i++) {
      if (weights[i] === 0) continue;
      const row = yield* horizontalRow(start + i);
      const weight = weights[i];
      for (let x = 0; x < accumulated.length; x++) accumulated[x] += row[x] * weight;
      if ((work += width) >= WORK_CHUNK) { work = 0; yield; }
    }
    for (let x = 0; x < width; x++) {
      const from = x * 4, to = (y * width + x) * 4;
      const alpha = accumulated[from + 3], roundedAlpha = byte(alpha);
      if (roundedAlpha > 0 && alpha > 0) {
        output[to] = byte(accumulated[from] / alpha);
        output[to + 1] = byte(accumulated[from + 1] / alpha);
        output[to + 2] = byte(accumulated[from + 2] / alpha);
        output[to + 3] = roundedAlpha;
      }
      // When a negative-lobe filter rounds alpha to zero, leave transparent black.
    }
    if ((work += width) >= WORK_CHUNK) { work = 0; yield; }
  }
  return result;
}

/** Synchronous compatibility / Worker entry. Never modifies the input buffer. */
export function resampleRGBA(image, options) {
  const plan = validateImage(image, options);
  const iterator = resamplingSteps(image, plan);
  let step;
  do { step = iterator.next(); } while (!step.done);
  return step.value;
}

function yieldToTask(signal, yieldTask) {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(abortError()); };
    const cleanup = () => signal?.removeEventListener('abort', abort);
    signal?.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(yieldTask).then(() => { cleanup(); resolve(); }, error => { cleanup(); reject(error); });
  });
}

/** Identical pixels with cancellable task yields for environments without Worker. */
export async function resampleRGBAAsync(image, options, { signal, yieldTask = () => new Promise(resolve => setTimeout(resolve, 0)) } = {}) {
  checkAbort(signal);
  const plan = validateImage(image, options);
  if (typeof yieldTask !== 'function') throw new TypeError('异步缩放的让步函数无效。');
  await yieldToTask(signal, yieldTask);
  checkAbort(signal);
  const iterator = resamplingSteps(image, plan);
  try {
    while (true) {
      checkAbort(signal);
      const step = iterator.next();
      if (step.done) return step.value;
      await yieldToTask(signal, yieldTask);
    }
  } finally { iterator.return(); }
}
