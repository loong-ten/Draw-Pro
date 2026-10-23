import { makeCanvas } from './core.js';
import { TILE_LIMITS, validateTileCanvas, tilePlan, tileRects } from './tile-canvas-core.js';

let crcTable;
async function crc32(bytes, signal) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let value = n;
      for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      crcTable[n] = value >>> 0;
    }
  }
  let value = 0xffffffff;
  const chunkSize = 1024 * 1024;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const end = Math.min(bytes.length, offset + chunkSize);
    for (let i = offset; i < end; i++) value = crcTable[(value ^ bytes[i]) & 255] ^ (value >>> 8);
    if (end < bytes.length) { await yieldUI(); checkAbort(signal); }
  }
  return (value ^ 0xffffffff) >>> 0;
}

function checkAbort(signal) {
  if (signal?.aborted) throw new DOMException('已取消瓦片导出。', 'AbortError');
}
const yieldUI = () => new Promise(resolve => setTimeout(resolve, 0));
const allTransparent = data => {
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) return false;
  return true;
};
const pngBlob = canvas => new Promise((resolve, reject) => canvas.toBlob(blob => {
  if (!blob || blob.type !== 'image/png') reject(new Error('浏览器无法生成 PNG 瓦片，请减小瓦片尺寸后重试。'));
  else resolve(blob);
}, 'image/png'));

/** Builds a standard UTF-8 store ZIP; only encoded PNGs remain in memory. */
function zipWriter(signal) {
  const encoder = new TextEncoder(), localParts = [], centralParts = [];
  let localSize = 0, centralSize = 0, count = 0;
  const now = new Date(), year = Math.max(1980, Math.min(2107, now.getFullYear()));
  const date = ((year - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >>> 1);
  return {
    async add(filename, blob) {
      checkAbort(signal);
      const name = encoder.encode(filename);
      const extraLocal = 30 + name.length + blob.size, extraCentral = 46 + name.length;
      if (localSize + centralSize + extraLocal + extraCentral + 22 > TILE_LIMITS.zipBytes) throw new RangeError('瓦片 ZIP 超过 200 MB，请减小画布或分批导出。');
      const bytes = new Uint8Array(await blob.arrayBuffer()); checkAbort(signal);
      const crc = await crc32(bytes, signal); checkAbort(signal);
      const local = new Uint8Array(30), lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true);
      lv.setUint16(10, time, true); lv.setUint16(12, date, true); lv.setUint32(14, crc, true);
      lv.setUint32(18, bytes.length, true); lv.setUint32(22, bytes.length, true); lv.setUint16(26, name.length, true);
      const central = new Uint8Array(46), cv = new DataView(central.buffer);
      cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true);
      cv.setUint16(12, time, true); cv.setUint16(14, date, true); cv.setUint32(16, crc, true);
      cv.setUint32(20, bytes.length, true); cv.setUint32(24, bytes.length, true); cv.setUint16(28, name.length, true); cv.setUint32(42, localSize, true);
      localParts.push(local, name, bytes); centralParts.push(central, name);
      localSize += extraLocal; centralSize += extraCentral; count++;
    },
    finish() {
      checkAbort(signal);
      const end = new Uint8Array(22), view = new DataView(end.buffer);
      view.setUint32(0, 0x06054b50, true); view.setUint16(8, count, true); view.setUint16(10, count, true);
      view.setUint32(12, centralSize, true); view.setUint32(16, localSize, true);
      return new Blob([...localParts, ...centralParts, end], { type: 'application/zip' });
    },
  };
}

/** The caller supplies a frozen composition raster, never the live viewport. */
export async function exportTileArchive(sourceCanvas, settings, { name = '瓦片画布', onProgress, signal } = {}) {
  checkAbort(signal);
  const s = validateTileCanvas(settings), plan = tilePlan(s);
  if (!plan.exportable) throw new RangeError(plan.error);
  if (!sourceCanvas || sourceCanvas.width !== s.width || sourceCanvas.height !== s.height || typeof sourceCanvas.getContext !== 'function') throw new RangeError('导出快照尺寸与画布设置不一致，请重新导出。');
  const source = sourceCanvas.getContext('2d', { willReadFrequently: true });
  if (!source) throw new Error('无法读取画布像素。');
  const manifest = {
    format: 'art-workbench-tiles', version: 1, name: String(name || '瓦片画布').slice(0, 150),
    width: s.width, height: s.height, tileWidth: s.tileWidth, tileHeight: s.tileHeight,
    edge: s.edge, rows: plan.rows, columns: plan.columns, total: plan.total,
    order: 'row-major', indexBase: 0, skipEmpty: s.skipEmpty, count: 0, skipped: 0, tiles: [],
  };
  const zip = zipWriter(signal), tile = makeCanvas(1, 1);
  let completed = 0, count = 0, skipped = 0;
  const report = () => onProgress?.({ completed, total: plan.total, count, skipped });
  report(); checkAbort(signal);
  try {
    for (const rect of tileRects(plan)) {
      checkAbort(signal);
      const pixels = source.getImageData(rect.x, rect.y, rect.copyWidth, rect.copyHeight);
      if (s.skipEmpty && allTransparent(pixels.data)) skipped++;
      else {
        if (tile.width !== rect.width) tile.width = rect.width;
        if (tile.height !== rect.height) tile.height = rect.height;
        const context = tile.getContext('2d');
        context.clearRect(0, 0, rect.width, rect.height); context.putImageData(pixels, 0, 0);
        const blob = await pngBlob(tile); checkAbort(signal);
        const filename = 'tile_r' + String(rect.row).padStart(3, '0') + '_c' + String(rect.column).padStart(3, '0') + '.png';
        await zip.add(filename, blob);
        manifest.tiles.push({ filename, ...rect }); count++;
      }
      completed++; report(); checkAbort(signal);
      // Empty cells also yield, so a mostly transparent atlas stays cancellable.
      if (completed % 8 === 0) { await yieldUI(); checkAbort(signal); }
    }
    manifest.count = count; manifest.skipped = skipped;
    await zip.add('layout.json', new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' }));
    checkAbort(signal);
    return { blob: zip.finish(), manifest, count, skipped };
  } finally {
    tile.width = 1; tile.height = 1;
  }
}
