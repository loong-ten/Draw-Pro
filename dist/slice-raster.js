import { PaintDocument, makeCanvas } from './core.js';
import { SLICE_LIMITS, createSlicePlan } from './slice-core.js';

function assertActive(signal) {
  if (signal?.aborted) throw new DOMException('已取消切图。', 'AbortError');
}

// Rebuild and compare the geometry before allocating, so stale or edited plans
// cannot crop pixels silently, overlap regions, or bypass the resource limits.
function checkedPlan(sourceCanvas, plan) {
  if (!sourceCanvas || typeof sourceCanvas.getContext !== 'function') {
    throw new TypeError('请先选择可读取的源图画布。');
  }
  if (!plan || typeof plan !== 'object' || !Array.isArray(plan.rects)) {
    throw new TypeError('切图方案无效，请重新预览。');
  }
  if (sourceCanvas.width !== plan.width || sourceCanvas.height !== plan.height) {
    throw new RangeError('源图尺寸已变化，请重新生成切图预览。');
  }
  if (!Number.isInteger(plan.rows) || !Number.isInteger(plan.columns) ||
      plan.rows < 1 || plan.columns < 1 || plan.rows > SLICE_LIMITS.axisFrames ||
      plan.columns > SLICE_LIMITS.axisFrames || plan.total !== plan.rows * plan.columns ||
      plan.total !== plan.rects.length || plan.total > SLICE_LIMITS.previewCount) {
    throw new RangeError('切图方案的行列数量无效，请重新预览。');
  }
  if (plan.total > SLICE_LIMITS.documents) {
    throw new RangeError(`一次最多生成 ${SLICE_LIMITS.documents} 张图片，请减少分割线或行列数。`);
  }
  let options;
  if (plan.mode === 'manual') {
    options = {
      mode: 'manual',
      vLines: Array.from({ length: plan.columns - 1 }, (_, index) => plan.rects[index + 1]?.x / plan.width),
      hLines: Array.from({ length: plan.rows - 1 }, (_, index) => plan.rects[(index + 1) * plan.columns]?.y / plan.height),
    };
  } else if (plan.mode === 'sprite') {
    options = { mode: 'sprite', rows: plan.rows, columns: plan.columns, padFrames: true };
  } else {
    throw new RangeError('切图模式无效，请重新预览。');
  }
  const expected = createSlicePlan(plan.width, plan.height, options);
  const fields = ['mode', 'width', 'height', 'outputWidth', 'outputHeight', 'rows', 'columns', 'total',
    'frameWidth', 'frameHeight', 'paddedX', 'paddedY'];
  if (fields.some(field => plan[field] !== expected[field]) ||
      (plan.outputPixels !== undefined && plan.outputPixels !== expected.outputPixels)) {
    throw new RangeError('切图方案尺寸不一致，请重新预览。');
  }
  const rectFields = ['row', 'column', 'x', 'y', 'w', 'h', 'copyWidth', 'copyHeight'];
  for (let index = 0; index < expected.total; index++) {
    const rect = plan.rects[index];
    if (!rect || rectFields.some(field => rect[field] !== expected.rects[index][field])) {
      throw new RangeError('切图范围无效，请重新预览以完整保留源图像素。');
    }
  }
  if (expected.outputPixels > SLICE_LIMITS.outputPixels) {
    throw new RangeError('整组切图累计面积不能超过 64 Mi 像素，请减少补齐或分割数量。');
  }
  return expected;
}

function baseName(name) {
  const cleaned = String(name || '素材').trim().replace(/\.[^./\\]+$/, '')
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_').trim().slice(0, 120);
  return cleaned || '素材';
}

function usedNames(existingNames) {
  if (existingNames === undefined || existingNames === null) return new Set();
  if (typeof existingNames === 'string' || typeof existingNames[Symbol.iterator] !== 'function') {
    throw new TypeError('现有图片名称须为数组或集合。');
  }
  return new Set(Array.from(existingNames, item => String(typeof item === 'string' ? item : item?.name || '').toLowerCase()));
}

function reserveName(stem, used) {
  let result = `${stem}.png`, number = 2;
  while (used.has(result.toLowerCase())) result = `${stem} (${number++}).png`;
  used.add(result.toLowerCase());
  return result;
}

function releaseDocuments(documents) {
  for (const doc of documents) {
    for (const layer of doc.layers) {
      layer.canvas.width = 1;
      layer.canvas.height = 1;
    }
    doc.history.length = 0;
    doc.historyIndex = -1;
  }
  documents.length = 0;
}

export async function buildSliceDocuments(sourceCanvas, plan, {
  name = '素材', existingNames, signal, onProgress,
} = {}) {
  assertActive(signal);
  const geometry = checkedPlan(sourceCanvas, plan);
  const sourceContext = sourceCanvas.getContext('2d', { willReadFrequently: true });
  if (!sourceContext) throw new Error('无法读取源图像素。');
  const used = usedNames(existingNames), base = baseName(name);
  const documents = [];
  let completed = 0, pixels = 0;
  try {
    onProgress?.({ completed, total: geometry.total, pixels });
    assertActive(signal);
    // Give the progress UI a paint opportunity before the first pixel read.
    await new Promise(resolve => setTimeout(resolve, 0));
    assertActive(signal);
    for (const rect of geometry.rects) {
      assertActive(signal);
      const coordinates = `r${String(rect.row + 1).padStart(2, '0')}c${String(rect.column + 1).padStart(2, '0')}`;
      const stem = geometry.mode === 'sprite'
        ? `${base}_帧_${String(completed + 1).padStart(3, '0')}_${coordinates}`
        : `${base}_切图_${coordinates}`;
      // Start with a one-pixel document to avoid a full blank history snapshot.
      const doc = new PaintDocument({ name: reserveName(stem, used), width: 1, height: 1 });
      documents.push(doc);
      const layer = doc.activeLayer;
      layer.canvas = makeCanvas(rect.w, rect.h);
      doc.width = rect.w;
      doc.height = rect.h;
      layer.name = geometry.mode === 'sprite' ? `帧 ${String(completed + 1).padStart(3, '0')}` : '切图片段';
      const context = layer.canvas.getContext('2d');
      if (!context) throw new Error('无法创建切图画布。');
      if (rect.copyWidth > 0 && rect.copyHeight > 0) {
        const rgba = sourceContext.getImageData(rect.x, rect.y, rect.copyWidth, rect.copyHeight);
        context.putImageData(rgba, 0, 0);
      }
      doc.resetHistory(geometry.mode === 'sprite' ? '精灵表切帧' : '手动切图');
      doc.dirty = true;
      doc.isDemo = false;
      doc.revision = 1;
      completed++;
      pixels += rect.w * rect.h;
      onProgress?.({ completed, total: geometry.total, pixels });
      assertActive(signal);
      // Yield between every frame, including the last, so cancellation is atomic.
      await new Promise(resolve => setTimeout(resolve, 0));
      assertActive(signal);
    }
    return documents;
  } catch (error) {
    releaseDocuments(documents);
    throw error;
  }
}
