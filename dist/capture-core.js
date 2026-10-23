import { makeCanvas, PaintDocument } from './core.js';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const integer = (value, fallback = 0) => Number.isFinite(Number(value)) ? Math.round(Number(value)) : fallback;

function bounds(width, height) {
  const w = integer(width), h = integer(height);
  if (w < 1 || h < 1) throw new RangeError('截图来源必须有有效的像素尺寸。');
  return { width: w, height: h };
}

/** Every rectangle uses original image pixels, never display or device pixels. */
export function clampCaptureRect(rect = {}, width, height) {
  const size = bounds(width, height);
  const x = clamp(integer(rect.x), 0, size.width - 1);
  const y = clamp(integer(rect.y), 0, size.height - 1);
  return {
    x, y,
    w: clamp(integer(rect.w, 1), 1, size.width - x),
    h: clamp(integer(rect.h, 1), 1, size.height - y),
  };
}

export function createCaptureRect(start, end, width, height) {
  const size = bounds(width, height);
  const ax = clamp(integer(start.x), 0, size.width);
  const ay = clamp(integer(start.y), 0, size.height);
  const bx = clamp(integer(end.x), 0, size.width);
  const by = clamp(integer(end.y), 0, size.height);
  return clampCaptureRect({ x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) }, size.width, size.height);
}

export function moveCaptureRect(rect, dx, dy, width, height) {
  const r = clampCaptureRect(rect, width, height);
  return { ...r, x: clamp(r.x + integer(dx), 0, width - r.w), y: clamp(r.y + integer(dy), 0, height - r.h) };
}

/** Keep the opposite edge fixed; a resize handle cannot cross that edge. */
export function resizeCaptureRect(rect, handle, dx, dy, width, height) {
  const r = clampCaptureRect(rect, width, height);
  if (!['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].includes(handle)) return r;
  let left = r.x, top = r.y, right = r.x + r.w, bottom = r.y + r.h;
  if (handle.includes('w')) left = clamp(left + integer(dx), 0, right - 1);
  if (handle.includes('e')) right = clamp(right + integer(dx), left + 1, width);
  if (handle.includes('n')) top = clamp(top + integer(dy), 0, bottom - 1);
  if (handle.includes('s')) bottom = clamp(bottom + integer(dy), top + 1, height);
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/** Copy RGBA bytes from a clean, original-resolution image composition. */
export function captureRegion(sourceCanvas, rect) {
  const r = clampCaptureRect(rect, sourceCanvas.width, sourceCanvas.height);
  const result = makeCanvas(r.w, r.h);
  const pixels = sourceCanvas.getContext('2d').getImageData(r.x, r.y, r.w, r.h);
  result.getContext('2d').putImageData(pixels, 0, 0);
  return result;
}

export function createCaptureDocument(sourceCanvas, rect, name) {
  const canvas = captureRegion(sourceCanvas, rect);
  const result = new PaintDocument({ name: name || '区域截图.png', width: canvas.width, height: canvas.height });
  // Assign the pixel copy directly; no drawImage resampling or source metadata.
  result.activeLayer.canvas = canvas;
  result.activeLayer.name = '区域截图';
  result.resetHistory('区域截图');
  result.dirty = true;
  result.isDemo = false;
  return result;
}

function filenameStem(value, fallback) {
  let stem = String(value || '').trim().replace(/\.[^.\\/]+$/, '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[.\s]+$/g, '').replace(/^\.+/, '').trim();
  if (!stem) stem = fallback;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)) stem = '_' + stem;
  return [...stem].slice(0, 120).join('');
}

export function captureFileName(sourceName, requestedName, existingNames = []) {
  const used = new Set(Array.from(existingNames, value => String(value).toLowerCase()));
  const custom = typeof requestedName === 'string' && requestedName.trim();
  const base = custom ? filenameStem(requestedName, '区域截图') : filenameStem(sourceName, '素材') + '_截图';
  if (custom && !used.has(base.toLowerCase() + '.png')) return base + '.png';
  let number = custom ? 2 : 1;
  let candidate;
  do { candidate = `${base}_${String(number++).padStart(2, '0')}.png`; } while (used.has(candidate.toLowerCase()));
  return candidate;
}
