import { PaintDocument, makeCanvas, composite } from './core.js';

// All image and project data stays in the browser. A directory is written only
// after the user explicitly opens it and invokes one of the save functions.
const IMAGE_EXTENSIONS = /\.(?:png|jpe?g|webp|gif|bmp|svg|avif)$/i;
const MAX_IMAGE_PIXELS = 32 * 1024 * 1024;
const MAX_WORKSPACE_LAYER_PIXELS = 128 * 1024 * 1024;
const MAX_PROJECT_BYTES = 256 * 1024 * 1024;
const MIME_TYPES = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', bmp: 'image/bmp', gif: 'image/gif' };
const EXTENSIONS = { png: '.png', jpeg: '.jpg', webp: '.webp', bmp: '.bmp', gif: '.gif' };
const PROJECT_KIND = 'paint-studio-workspace';
const GUIDE_KIND = 'paint-studio-guides';

function userError(message, code = 'INVALID_FILE') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isAbort(error) {
  return error?.name === 'AbortError';
}

function dimensionCheck(width, height, label = '图片') {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 8192 || height > 8192 || width * height > MAX_IMAGE_PIXELS) {
    throw userError(`${label}尺寸超出范围：每边须为 1–8192 像素，总像素不超过 3200 万。`, 'IMAGE_TOO_LARGE');
  }
}

function normalizeFormat(format, fallback = 'png') {
  const normalized = String(format || fallback).toLowerCase().replace(/^image\//, '').replace(/^\./, '');
  return normalized === 'jpg' ? 'jpeg' : normalized;
}

function fileFormat(name) {
  const extension = String(name || '').split('.').pop().toLowerCase();
  return normalizeFormat(extension);
}

function safeName(name, fallback = '未命名.png') {
  const cleaned = String(name || fallback).split(/[\\/]/).pop().replace(/[<>:"|?*\u0000-\u001f]/g, '_').replace(/[.\s]+$/g, '').slice(0, 180);
  return cleaned || fallback;
}

function withExtension(name, format) {
  const clean = safeName(name);
  if (fileFormat(clean) === format) return clean;
  const stem = clean.replace(/\.[^.]+$/, '') || '未命名';
  return `${stem}${EXTENSIONS[format]}`;
}

async function decodeImage(blob) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(blob, { imageOrientation: 'from-image' });
    } catch (error) {
      // Some engines can draw SVG/GIF in <img> but cannot create a bitmap of it.
      if (isAbort(error)) throw error;
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.decoding = 'async';
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(userError('浏览器无法解码此图片。'));
      image.src = url;
    });
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function decodedDimensions(image) {
  return { width: image.naturalWidth || image.width, height: image.naturalHeight || image.height };
}

async function canvasFromBlob(blob, label) {
  const image = await decodeImage(blob);
  try {
    const { width, height } = decodedDimensions(image);
    dimensionCheck(width, height, label);
    const canvas = makeCanvas(width, height);
    canvas.getContext('2d', { willReadFrequently: true }).drawImage(image, 0, 0);
    // Check that an imported SVG cannot leave an unexportable tainted canvas.
    canvas.getContext('2d').getImageData(0, 0, 1, 1);
    return canvas;
  } finally {
    image.close?.();
  }
}

/** Accepts File objects, or { file, handle, path } entries from pickDirectory. */
export async function importFiles(files, options = {}) {
  const docs = [];
  const errors = [];
  const requestedLimit = options.limit === undefined ? 100 : Number(options.limit);
  const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(Math.floor(requestedLimit), 0), 100) : 100;
  const requestedBudget = options.pixelBudget === undefined ? 64 * 1024 * 1024 : Number(options.pixelBudget);
  const pixelBudget = Number.isFinite(requestedBudget) && requestedBudget >= 0 ? Math.floor(requestedBudget) : 64 * 1024 * 1024;
  const entries = Array.from(files || []);
  let supported = 0;
  let pixelsUsed = 0;
  for (const entry of entries) {
    const file = entry?.file || entry;
    if (!(file instanceof Blob)) {
      errors.push({ name: String(file?.name || '未知文件'), message: '文件内容不可读取。' });
      continue;
    }
    const name = String(file.name || '导入图片.png');
    if (!IMAGE_EXTENSIONS.test(name) && !/^image\/(?:png|jpeg|webp|gif|bmp|svg\+xml|avif)$/i.test(file.type)) continue;
    if (++supported > limit) {
      errors.push({ name, message: limit ? `本次最多打开 ${limit} 张图片，其余图片未导入。` : '当前工作区已达到图片数量上限，其余图片未导入。' });
      break;
    }
    try {
      const canvas = await canvasFromBlob(file, name);
      if (pixelsUsed + canvas.width * canvas.height > pixelBudget) {
        errors.push({ name, message: '导入图片的总像素已达到工作区内存预算，此图片及其余图片未导入。请先关闭部分素材。' });
        canvas.width = canvas.height = 1;
        break;
      }
      pixelsUsed += canvas.width * canvas.height;
      const doc = new PaintDocument({ name, canvas, width: canvas.width, height: canvas.height });
      doc.path = entry?.path || file.webkitRelativePath || name;
      doc.fileHandle = entry?.handle || null;
      doc.sourceType = file.type;
      doc.dirty = false;
      if (/\.gif$/i.test(name) || file.type === 'image/gif') doc.importNote = 'GIF 以第一帧打开，导出 GIF 也为静态单帧；使用 PNG 可保留完整颜色与透明度。';
      docs.push(doc);
    } catch (error) {
      errors.push({ name, message: error?.message || '图片打开失败。' });
    }
  }
  return { docs, errors };
}

/** Must be called directly from a user gesture. */
export async function pickDirectory() {
  if (!('showDirectoryPicker' in window)) throw userError('此浏览器不支持直接读写文件夹。请使用文件夹导入；保存时将下载文件。', 'UNSUPPORTED');
  const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
  const files = [];
  const errors = [];
  let truncated = false;
  async function walk(directory, prefix = '', depth = 0) {
    if (depth > 20) {
      errors.push({ name: prefix, message: '子文件夹超过 20 层，已跳过。' });
      return;
    }
    for await (const [name, entry] of directory.entries()) {
      if (files.length >= 500) { truncated = true; return; }
      const path = prefix ? `${prefix}/${name}` : name;
      if (entry.kind === 'directory') {
        await walk(entry, path, depth + 1);
      } else if (entry.kind === 'file' && IMAGE_EXTENSIONS.test(name)) {
        try {
          files.push({ file: await entry.getFile(), handle: entry, path });
        } catch (error) {
          errors.push({ name: path, message: error?.message || '文件读取失败。' });
        }
      }
    }
  }
  await walk(handle);
  files.sort((a, b) => a.path.localeCompare(b.path, 'zh-CN', { numeric: true }));
  if (truncated) errors.push({ name: handle.name, message: '文件夹包含较多图片，本次最多打开 500 张。' });
  return { handle, name: handle.name, files, fallback: false, errors, truncated };
}

function canvasToBlob(canvas, mime, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(userError('图片编码失败，请尝试 PNG 格式。', 'ENCODE_FAILED')), mime, quality);
  });
}

function encodeBitmap(canvas) {
  const { width, height } = canvas;
  const stride = Math.ceil(width * 3 / 4) * 4;
  const size = 54 + stride * height;
  const buffer = new ArrayBuffer(size);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  view.setUint16(0, 0x4d42, true);
  view.setUint32(2, size, true);
  view.setUint32(10, 54, true);
  view.setUint32(14, 40, true);
  view.setInt32(18, width, true);
  view.setInt32(22, height, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, 24, true);
  view.setUint32(34, stride * height, true);
  view.setInt32(38, 3780, true);
  view.setInt32(42, 3780, true);
  const pixels = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, width, height).data;
  for (let y = 0; y < height; y++) {
    let offset = 54 + (height - y - 1) * stride;
    for (let x = 0; x < width; x++) {
      const source = (y * width + x) * 4;
      bytes[offset++] = pixels[source + 2];
      bytes[offset++] = pixels[source + 1];
      bytes[offset++] = pixels[source];
    }
  }
  return new Blob([buffer], { type: MIME_TYPES.bmp });
}

function encodeGif(canvas) {
  const { width, height } = canvas;
  const pixels = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, width, height).data;
  const pixelCount = width * height;
  // A fixed 6×6×6 RGB palette leaves index 255 for binary transparency. Literal
  // LZW codes reset every 250 pixels, keeping the code width at exactly 9 bits;
  // this is standard GIF LZW with a bounded, allocation-free coding loop.
  const codes = new Uint8Array(Math.ceil((pixelCount + Math.ceil(pixelCount / 250) + 2) * 9 / 8));
  let offset = 0, bits = 0, bitCount = 0, run = 0, hasTransparency = false;
  function code(value) {
    bits |= value << bitCount;
    bitCount += 9;
    while (bitCount >= 8) {
      codes[offset++] = bits & 255;
      bits >>>= 8;
      bitCount -= 8;
    }
  }
  code(256); // Clear code for minimum LZW code size 8.
  for (let pixel = 0; pixel < pixels.length; pixel += 4) {
    if (run === 250) { code(256); run = 0; }
    if (pixels[pixel + 3] < 128) { code(255); hasTransparency = true; }
    else code(Math.round(pixels[pixel] / 51) * 36 + Math.round(pixels[pixel + 1] / 51) * 6 + Math.round(pixels[pixel + 2] / 51));
    run++;
  }
  code(257); // End of information.
  if (bitCount) codes[offset++] = bits & 255;
  const header = new Uint8Array(800);
  const view = new DataView(header.buffer);
  header.set(new TextEncoder().encode('GIF89a'), 0);
  view.setUint16(6, width, true);
  view.setUint16(8, height, true);
  header[10] = 0xf7; // Global 256-entry color table, 8-bit color resolution.
  header[11] = hasTransparency ? 255 : 0;
  for (let index = 0; index < 216; index++) {
    header[13 + index * 3] = Math.floor(index / 36) * 51;
    header[14 + index * 3] = Math.floor(index / 6) % 6 * 51;
    header[15 + index * 3] = index % 6 * 51;
  }
  header.set([0x21, 0xf9, 0x04, hasTransparency ? 0x05 : 0x04, 0, 0, 255, 0], 781);
  header[789] = 0x2c; // Image descriptor; left and top are zero.
  view.setUint16(794, width, true);
  view.setUint16(796, height, true);
  header[799] = 8;
  const parts = [header];
  for (let start = 0; start < offset; start += 255) {
    const count = Math.min(255, offset - start);
    parts.push(new Uint8Array([count]), codes.subarray(start, start + count));
  }
  parts.push(new Uint8Array([0, 0x3b]));
  return new Blob(parts, { type: MIME_TYPES.gif });
}

export async function encodeDocument(doc, format = 'png', quality = 0.92) {
  format = normalizeFormat(format);
  if (!MIME_TYPES[format]) throw userError('保存格式须为 PNG、JPEG、WebP、BMP 或 GIF。', 'UNSUPPORTED_FORMAT');
  dimensionCheck(doc.width, doc.height);
  const canvas = composite(doc, { background: format === 'jpeg' || format === 'bmp' ? '#ffffff' : null });
  if (format === 'bmp') return encodeBitmap(canvas);
  if (format === 'gif') return encodeGif(canvas);
  const blob = await canvasToBlob(canvas, MIME_TYPES[format], Math.min(1, Math.max(0.05, Number(quality) || 0.92)));
  // HTMLCanvasElement can silently fall back to PNG for unsupported encoders.
  if (blob.type !== MIME_TYPES[format]) throw userError(`当前浏览器不支持 ${format.toUpperCase()} 编码，请选择 PNG。`, 'UNSUPPORTED_FORMAT');
  return blob;
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const name = safeName(filename);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.style.display = 'none';
  document.body.append(anchor);
  try { anchor.click(); }
  catch { /* The visible link below offers a fresh, explicit user click. */ }
  finally { anchor.remove(); }

  const previous = downloadBlob.pending;
  if (previous) {
    clearTimeout(previous.timer);
    // The previous link has been replaced, but allow an already-started
    // download a grace period before releasing its object URL.
    setTimeout(() => URL.revokeObjectURL(previous.url), 60_000);
  }
  let tray = document.getElementById('download-ready');
  if (!tray) {
    tray = document.createElement('div');
    tray.id = 'download-ready';
    tray.setAttribute('role', 'status');
    document.body.append(tray);
  }
  const message = document.createElement('span');
  message.textContent = '文件已生成';
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.textContent = `下载 ${name}`;
  link.title = '如果下载未开始，请点击此链接';
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = '×';
  close.setAttribute('aria-label', '关闭下载提示');
  close.title = '关闭下载提示';
  close.onclick = () => tray.remove();
  tray.replaceChildren(message, link, close);
  tray.hidden = false;
  const timer = setTimeout(() => {
    URL.revokeObjectURL(url);
    if (downloadBlob.pending?.url === url) {
      tray.remove();
      downloadBlob.pending = null;
    }
  }, 10 * 60_000);
  downloadBlob.pending = { url, timer };
}

async function ensureWritePermission(handle) {
  if (!handle?.createWritable && handle?.kind !== 'directory') throw userError('文件没有写入权限。', 'PERMISSION_DENIED');
  if (!handle.queryPermission) return true;
  const options = { mode: 'readwrite' };
  if (await handle.queryPermission(options) === 'granted') return true;
  if (handle.requestPermission && await handle.requestPermission(options) === 'granted') return true;
  throw userError('未授予文件写入权限。', 'PERMISSION_DENIED');
}

async function writeBlob(handle, blob) {
  await ensureWritePermission(handle);
  const writable = await handle.createWritable();
  try {
    await writable.write(blob);
    await writable.close();
  } catch (error) {
    try { await writable.abort(); } catch { /* The stream may already be closed. */ }
    throw error;
  }
}

async function unusedFile(directory, name) {
  const stem = name.replace(/\.[^.]+$/, '');
  const extension = name.slice(stem.length);
  for (let index = 0; index < 10_000; index++) {
    const candidate = index ? `${stem} (${index})${extension}` : name;
    try {
      await directory.getFileHandle(candidate, { create: false });
    } catch (error) {
      if (error?.name === 'NotFoundError') return { handle: await directory.getFileHandle(candidate, { create: true }), name: candidate };
      // A directory with this name is also a collision, not a writable image.
      if (error?.name !== 'TypeMismatchError') throw error;
    }
  }
  throw userError('同名文件过多，请改用“另存为”。', 'NAME_COLLISION');
}

function recordSave(doc, name, handle, savedRevision) {
  doc.name = name;
  if (doc.revision === savedRevision) doc.dirty = false;
  if (handle) doc.fileHandle = handle;
}

/**
 * Returns method:'download' if the browser cannot write directly. A cancelled
 * native picker throws AbortError instead of starting an unexpected download.
 */
export async function saveDocument(doc, { format = null, quality = 0.92, saveAs = false, directory = null, filename = null } = {}) {
  const inferred = fileFormat(filename || doc.name);
  format = normalizeFormat(format || (MIME_TYPES[inferred] ? inferred : 'png'));
  if (!MIME_TYPES[format]) throw userError('保存格式须为 PNG、JPEG、WebP、BMP 或 GIF。', 'UNSUPPORTED_FORMAT');
  let name = withExtension(filename || doc.name || '未命名.png', format);
  let handle = null;
  let fallbackReason = null;
  // Open a save picker before awaiting image encoding so user activation is kept.
  if (saveAs && typeof window.showSaveFilePicker === 'function') {
    try {
      handle = await window.showSaveFilePicker({
        suggestedName: name,
        types: [{ description: `${format.toUpperCase()} 图片`, accept: { [MIME_TYPES[format]]: format === 'jpeg' ? ['.jpg', '.jpeg'] : [EXTENSIONS[format]] } }],
        excludeAcceptAllOption: true,
      });
      name = handle.name;
      if (fileFormat(name) !== format) {
        throw userError('文件扩展名与所选格式不一致，请使用匹配的扩展名。', 'FORMAT_MISMATCH');
      }
    } catch (error) {
      if (isAbort(error) || error?.code === 'FORMAT_MISMATCH') throw error;
      fallbackReason = error?.message || '浏览器限制直接保存。';
    }
  } else if (!saveAs && doc.fileHandle && fileFormat(doc.fileHandle.name || doc.name) === format && (!filename || safeName(filename) === doc.fileHandle.name)) {
    handle = doc.fileHandle;
    name = handle.name || name;
  } else if (!saveAs && directory) {
    try {
      await ensureWritePermission(directory);
      const target = await unusedFile(directory, name);
      handle = target.handle;
      name = target.name;
    } catch (error) {
      if (isAbort(error)) throw error;
      fallbackReason = error?.message || '工作目录暂不可写入。';
    }
  }
  // Ask while the Save click still carries user activation, before encoding a
  // large canvas. Permission may otherwise expire during image compression.
  if (handle) {
    try { await ensureWritePermission(handle); }
    catch (error) {
      if (isAbort(error)) throw error;
      fallbackReason = error?.message || '没有写入权限，已转为下载。';
      handle = null;
    }
  }
  const savedRevision = doc.revision;
  const blob = await encodeDocument(doc, format, quality);
  if (handle) {
    try {
      await writeBlob(handle, blob);
      recordSave(doc, name, handle, savedRevision);
      return { method: 'file', name, size: blob.size, format };
    } catch (error) {
      if (isAbort(error)) throw error;
      fallbackReason = error?.message || '写入失败，已转为下载。';
    }
  }
  downloadBlob(blob, name);
  // A download is a new copy; never retain a handle pointing at a different file.
  if (saveAs || doc.fileHandle && fileFormat(doc.fileHandle.name) !== format) doc.fileHandle = null;
  recordSave(doc, name, null, savedRevision);
  return { method: 'download', name, size: blob.size, format, fallbackReason };
}

function validateGuides(input) {
  if (!Array.isArray(input) || input.length > 1000) throw userError('参考数据无效，最多支持 1000 个参考点或参考线。');
  const ids = new Set();
  return input.map((guide, index) => {
    if (!guide || !['h', 'v', 'point'].includes(guide.type) || !Number.isFinite(guide.x ?? 0) || !Number.isFinite(guide.y ?? 0) || Math.abs(guide.x || 0) > 1e8 || Math.abs(guide.y || 0) > 1e8) throw userError(`第 ${index + 1} 个参考标记无效。`);
    let id = String(guide.id || `reference-${index + 1}`).slice(0, 100);
    if (ids.has(id)) id = `${id}-${index}`;
    ids.add(id);
    const color = typeof guide.color === 'string' && guide.color.length < 64 && (!globalThis.CSS?.supports || CSS.supports('color', guide.color)) ? guide.color : '#ea7544';
    return {
      id, type: guide.type, x: Number(guide.x || 0), y: Number(guide.y || 0),
      label: String(guide.label || '').slice(0, 120), color,
      locked: Boolean(guide.locked), visible: guide.visible !== false,
    };
  });
}

function validateSettings(input = {}) {
  const result = {};
  // Preserve simple UI preferences without allowing prototype-bearing objects.
  for (const key of ['referenceMode', 'baseWidth', 'baseHeight', 'activeDocId', 'showGuides', 'snapToGuides', 'showGrid', 'gridSize', 'workspaceName', 'zoom', 'theme']) {
    const value = input?.[key];
    if (typeof value === 'boolean' || typeof value === 'string' && value.length < 500 || typeof value === 'number' && Number.isFinite(value)) result[key] = value;
  }
  result.referenceMode = result.referenceMode === 'relative' ? 'relative' : 'pixel';
  const validWidth = typeof result.baseWidth === 'number' && Number.isFinite(result.baseWidth) && result.baseWidth > 0 && result.baseWidth <= 8192;
  const validHeight = typeof result.baseHeight === 'number' && Number.isFinite(result.baseHeight) && result.baseHeight > 0 && result.baseHeight <= 8192;
  if (!validWidth) result.baseWidth = 960;
  if (!validHeight) result.baseHeight = 640;
  if (!validWidth || !validHeight) result.referenceMode = 'pixel';
  result.gridSize = typeof result.gridSize === 'number' && Number.isFinite(result.gridSize) && result.gridSize >= 1 && result.gridSize <= 1024 ? Math.round(result.gridSize) : 1;
  return result;
}

function jsonBlob(value) {
  return new Blob([JSON.stringify(value)], { type: 'application/json;charset=utf-8' });
}

export async function saveWorkspace(docs, guides, settings = {}) {
  if (!Array.isArray(docs) || docs.length < 1 || docs.length > 100) throw userError('工作区项目须包含 1–100 张图片，请先移除多余图片。');
  let totalPixels = 0;
  for (const doc of docs) {
    dimensionCheck(doc.width, doc.height);
    if (!doc.layers?.length || doc.layers.length > 50) throw userError('每张图片须包含 1–50 个图层。');
    totalPixels += doc.width * doc.height * doc.layers.length;
  }
  if (totalPixels > MAX_WORKSPACE_LAYER_PIXELS) throw userError('工作区图层像素总量过大，请拆分为多个项目保存。');
  const project = {
    kind: PROJECT_KIND, version: 1, createdAt: new Date().toISOString(),
    guides: validateGuides(guides || []), settings: validateSettings(settings),
    docs: docs.map(doc => ({
      id: doc.id, name: doc.name, path: doc.path || '', width: doc.width, height: doc.height,
      activeLayerId: doc.activeLayerId,
      layers: doc.layers.map(layer => ({
        id: layer.id, name: layer.name, visible: layer.visible !== false, opacity: Number.isFinite(layer.opacity) ? layer.opacity : 1,
        locked: Boolean(layer.locked), data: layer.canvas.toDataURL('image/png'),
      })),
    })),
  };
  const blob = jsonBlob(project);
  if (blob.size > MAX_PROJECT_BYTES) throw userError('项目超过 256 MB，请拆分后保存。');
  const name = `${safeName(settings.workspaceName || '画境工作区').replace(/\.paintspace$/i, '')}.paintspace`;
  downloadBlob(blob, name);
  return { name, size: blob.size };
}

async function readJsonFile(file) {
  if (!(file instanceof Blob)) throw userError('请选择有效文件。');
  if (file.size > MAX_PROJECT_BYTES) throw userError('文件超过 256 MB，无法打开。');
  try { return JSON.parse(await file.text()); }
  catch { throw userError('文件不是有效的 JSON 项目。'); }
}

function pngDataBlob(data) {
  if (typeof data !== 'string' || !/^data:image\/png;base64,/.test(data)) throw userError('图层缺少有效的 PNG 像素数据。');
  let raw;
  try { raw = atob(data.slice(data.indexOf(',') + 1)); }
  catch { throw userError('图层 PNG 数据已损坏。'); }
  if (raw.length < 24 || raw.length > MAX_PROJECT_BYTES) throw userError('图层 PNG 数据大小无效。');
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index);
  const view = new DataView(bytes.buffer);
  if (view.getUint32(0) !== 0x89504e47 || view.getUint32(4) !== 0x0d0a1a0a) throw userError('图层 PNG 文件头无效。');
  dimensionCheck(view.getUint32(16), view.getUint32(20), '图层');
  return new Blob([bytes], { type: 'image/png' });
}

export async function loadWorkspace(file) {
  const project = await readJsonFile(file);
  if (!project || project.kind !== PROJECT_KIND || project.version !== 1 || !Array.isArray(project.docs) || project.docs.length < 1 || project.docs.length > 100) throw userError('这不是受支持的画境工作区文件，项目须包含 1–100 张图片。');
  const guides = validateGuides(project.guides || []);
  const settings = validateSettings(project.settings || {});
  let totalPixels = 0;
  for (const doc of project.docs) {
    dimensionCheck(doc.width, doc.height, '工作区图片');
    if (!Array.isArray(doc.layers) || doc.layers.length < 1 || doc.layers.length > 50) throw userError('工作区图层数量无效。');
    totalPixels += doc.width * doc.height * doc.layers.length;
  }
  if (totalPixels > MAX_WORKSPACE_LAYER_PIXELS) throw userError('工作区图层像素总量过大，请使用较小的项目。');
  const docs = [];
  const docIds = new Set();
  for (const saved of project.docs) {
    const layers = [];
    const layerIds = new Set();
    for (const [index, layer] of saved.layers.entries()) {
      const canvas = await canvasFromBlob(pngDataBlob(layer.data), '图层');
      if (canvas.width !== saved.width || canvas.height !== saved.height) throw userError('图层尺寸与画布不一致，项目无法打开。');
      const id = String(layer.id || `layer-${index}`).slice(0, 100);
      if (layerIds.has(id)) throw userError('项目包含重复图层标识。');
      layerIds.add(id);
      layers.push({
        id, name: String(layer.name || `图层 ${index + 1}`).slice(0, 120), canvas,
        visible: layer.visible !== false, locked: Boolean(layer.locked),
        opacity: Number.isFinite(layer.opacity) ? Math.min(1, Math.max(0, layer.opacity)) : 1,
      });
    }
    const id = String(saved.id || `doc-${docs.length}`).slice(0, 100);
    if (docIds.has(id)) throw userError('项目包含重复图片标识。');
    docIds.add(id);
    const doc = new PaintDocument({ id, name: safeName(saved.name), width: saved.width, height: saved.height, canvas: layers[0].canvas });
    doc.layers = layers;
    doc.activeLayerId = layerIds.has(saved.activeLayerId) ? saved.activeLayerId : layers[layers.length - 1].id;
    doc.path = String(saved.path || '').slice(0, 1000);
    doc.fileHandle = null;
    // Reset history after replacing the initial layer so Undo cannot expose an
    // unrelated initial canvas. commit() records the complete restored document.
    doc.history = [];
    doc.historyIndex = -1;
    doc.commit('打开工作区');
    doc.dirty = false;
    docs.push(doc);
  }
  return { docs, guides, settings };
}

function guidePayload(guides, settings) {
  return { kind: GUIDE_KIND, version: 1, guides: validateGuides(guides || []), settings: validateSettings(settings) };
}

function parseGuidePayload(data) {
  if (!data || data.kind !== GUIDE_KIND || data.version !== 1) throw userError('这不是受支持的共享参考文件。');
  return { guides: validateGuides(data.guides || []), settings: validateSettings(data.settings) };
}

export async function writeGuides(directory, guides, settings = {}) {
  if (!directory?.getFileHandle) throw userError('请先选择可写入的工作文件夹。', 'NO_DIRECTORY');
  await ensureWritePermission(directory);
  const handle = await directory.getFileHandle('.paint-guides.json', { create: true });
  const blob = jsonBlob(guidePayload(guides, settings));
  await writeBlob(handle, blob);
  return { name: '.paint-guides.json', method: 'file', size: blob.size };
}

export async function readGuides(directory) {
  if (!directory?.getFileHandle) return null;
  let handle;
  try { handle = await directory.getFileHandle('.paint-guides.json', { create: false }); }
  catch (error) { if (error?.name === 'NotFoundError') return null; throw error; }
  return parseGuidePayload(await readJsonFile(await handle.getFile()));
}

export async function exportGuides(guides, settings = {}) {
  const blob = jsonBlob(guidePayload(guides, settings));
  downloadBlob(blob, '共享参考.json');
  return { name: '共享参考.json', size: blob.size };
}

export async function importGuides(file) {
  return parseGuidePayload(await readJsonFile(file));
}

let zipCrcTable;
function zipCrc32(bytes) {
  if (!zipCrcTable) {
    zipCrcTable = new Uint32Array(256);
    for (let index = 0; index < 256; index++) {
      let value = index;
      for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      zipCrcTable[index] = value >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = zipCrcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** One download for every open image; ZIP uses standard uncompressed entries. */
export async function exportAllZip(docs, format = 'png', quality = 0.92) {
  format = normalizeFormat(format);
  if (!MIME_TYPES[format]) throw userError('导出格式须为 PNG、JPEG、WebP、BMP 或 GIF。', 'UNSUPPORTED_FORMAT');
  if (!Array.isArray(docs) || docs.length < 1) throw userError('工作区没有可导出的图片。');
  if (docs.length > 500) throw userError('一次最多打包 500 张图片。');
  const encoder = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  const usedNames = new Set();
  const now = new Date();
  const year = Math.min(2107, Math.max(1980, now.getFullYear()));
  const dosDate = ((year - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >>> 1);
  let localOffset = 0;
  let centralSize = 0;
  for (const doc of docs) {
    let filename = withExtension(doc.name, format);
    const stem = filename.replace(/\.[^.]+$/, '');
    const extension = filename.slice(stem.length);
    let duplicate = 1;
    while (usedNames.has(filename.toLowerCase())) filename = `${stem} (${duplicate++})${extension}`;
    usedNames.add(filename.toLowerCase());
    const filenameBytes = encoder.encode(filename);
    const blob = await encodeDocument(doc, format, quality);
    if (localOffset + blob.size > 300 * 1024 * 1024) throw userError('素材 ZIP 超过 300 MB，请分批导出或直接保存到工作目录。', 'EXPORT_TOO_LARGE');
    const data = new Uint8Array(await blob.arrayBuffer());
    const crc = zipCrc32(data);
    const local = new Uint8Array(30);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true); // Unicode file names encoded as UTF-8.
    localView.setUint16(8, 0, true); // Stored, without compression.
    localView.setUint16(10, dosTime, true);
    localView.setUint16(12, dosDate, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, data.length, true);
    localView.setUint32(22, data.length, true);
    localView.setUint16(26, filenameBytes.length, true);
    localParts.push(local, filenameBytes, data);

    const central = new Uint8Array(46);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, dosTime, true);
    centralView.setUint16(14, dosDate, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, data.length, true);
    centralView.setUint32(24, data.length, true);
    centralView.setUint16(28, filenameBytes.length, true);
    centralView.setUint32(42, localOffset, true);
    centralParts.push(central, filenameBytes);
    localOffset += local.length + filenameBytes.length + data.length;
    centralSize += central.length + filenameBytes.length;
  }
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, docs.length, true);
  endView.setUint16(10, docs.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, localOffset, true);
  const zip = new Blob([...localParts, ...centralParts, end], { type: 'application/zip' });
  const name = `画境素材-${format.toUpperCase()}.zip`;
  downloadBlob(zip, name);
  return { name, size: zip.size, count: docs.length, format };
}
