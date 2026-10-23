import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const canvasPath = require.resolve('@napi-rs/canvas', { paths: [process.cwd(), process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES].filter(Boolean) });
const { createCanvas, loadImage, ImageData } = require(canvasPath);
const nativeCanvas = (w = 1, h = 1) => {
  const canvas = createCanvas(w, h);
  if (!canvas.toBlob) canvas.toBlob = (callback, mime) => callback(new Blob([canvas.toBuffer('image/png')], { type: mime }));
  return canvas;
};
globalThis.document = { createElement: tag => { assert.equal(tag, 'canvas'); return nativeCanvas(); } };
const { exportTileArchive } = await import('../dist/tile-canvas-export.js');
const { TILE_LIMITS } = await import('../dist/tile-canvas-core.js');

function sourceCanvas(width = 5, height = 3) {
  const c = nativeCanvas(width, height), data = new Uint8ClampedArray(width * height * 4);
  const colors = [[255, 0, 0, 1], [0, 255, 0, 64], [0, 0, 255, 127], [255, 255, 255, 255], [0, 0, 0, 0]];
  for (let i = 0; i < width * height; i++) data.set(colors[i % colors.length], i * 4);
  c.getContext('2d').putImageData(new ImageData(data, width, height), 0, 0); return c;
}
const rgba = canvas => canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
function slowCRC(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1; }
  return (crc ^ 0xffffffff) >>> 0;
}
async function readZip(blob) {
  assert.equal(blob.type, 'application/zip');
  const buffer = Buffer.from(await blob.arrayBuffer()), end = buffer.length - 22;
  assert.equal(buffer.readUInt32LE(end), 0x06054b50);
  const count = buffer.readUInt16LE(end + 10), centralLength = buffer.readUInt32LE(end + 12), centralStart = buffer.readUInt32LE(end + 16);
  assert.equal(centralStart + centralLength, end); assert.equal(buffer.readUInt16LE(end + 8), count);
  const entries = new Map(); let position = centralStart;
  for (let i = 0; i < count; i++) {
    assert.equal(buffer.readUInt32LE(position), 0x02014b50); assert.equal(buffer.readUInt16LE(position + 8), 0x800); assert.equal(buffer.readUInt16LE(position + 10), 0);
    const crc = buffer.readUInt32LE(position + 16), length = buffer.readUInt32LE(position + 20), nameLength = buffer.readUInt16LE(position + 28), offset = buffer.readUInt32LE(position + 42);
    const name = buffer.toString('utf8', position + 46, position + 46 + nameLength);
    assert.equal(buffer.readUInt32LE(offset), 0x04034b50); assert.equal(buffer.readUInt16LE(offset + 6), 0x800); assert.equal(buffer.readUInt16LE(offset + 8), 0);
    assert.equal(buffer.readUInt32LE(offset + 14), crc); assert.equal(buffer.readUInt32LE(offset + 18), length); assert.equal(buffer.readUInt32LE(offset + 22), length);
    const localNameLength = buffer.readUInt16LE(offset + 26), extra = buffer.readUInt16LE(offset + 28);
    assert.equal(buffer.toString('utf8', offset + 30, offset + 30 + localNameLength), name);
    const data = buffer.subarray(offset + 30 + localNameLength + extra, offset + 30 + localNameLength + extra + length);
    assert.equal(slowCRC(data), crc, 'every local payload matches the central CRC');
    assert.equal(entries.has(name), false); entries.set(name, data);
    position += 46 + nameLength + buffer.readUInt16LE(position + 30) + buffer.readUInt16LE(position + 32);
  }
  assert.equal(position, end); return entries;
}
async function decodedCanvas(data) {
  const image = await loadImage(data), canvas = nativeCanvas(image.width, image.height);
  canvas.getContext('2d').drawImage(image, 0, 0); return canvas;
}

for (const edge of ['pad', 'keep']) test('real PNG tiles preserve all source pixels and edge transparency (' + edge + ')', async () => {
  const source = sourceCanvas(), before = rgba(source).slice(), progress = [];
  const result = await exportTileArchive(source, { width: 5, height: 3, tileWidth: 3, tileHeight: 2, edge }, { name: '边缘验证', onProgress: value => progress.push({ ...value }) });
  assert.equal(result.count, 4); assert.equal(result.skipped, 0); assert.deepEqual(rgba(source), before, 'source snapshot is never modified');
  const entries = await readZip(result.blob), layout = JSON.parse(entries.get('layout.json').toString());
  assert.deepEqual(layout, result.manifest); assert.equal(layout.name, '边缘验证'); assert.equal(layout.indexBase, 0); assert.equal(layout.order, 'row-major');
  assert.deepEqual([...entries.keys()], ['tile_r000_c000.png', 'tile_r000_c001.png', 'tile_r001_c000.png', 'tile_r001_c001.png', 'layout.json']);
  const coverage = new Uint8Array(15);
  for (const tile of layout.tiles) {
    const output = await decodedCanvas(entries.get(tile.filename)), pixels = rgba(output);
    assert.deepEqual([output.width, output.height], [tile.width, tile.height]);
    for (let y = 0; y < output.height; y++) for (let x = 0; x < output.width; x++) {
      const inside = x < tile.copyWidth && y < tile.copyHeight, outputIndex = (y * output.width + x) * 4;
      const sourceIndex = ((tile.y + y) * source.width + tile.x + x) * 4;
      assert.deepEqual([...pixels.slice(outputIndex, outputIndex + 4)], inside ? [...before.slice(sourceIndex, sourceIndex + 4)] : [0, 0, 0, 0]);
      if (inside) coverage[(tile.y + y) * source.width + tile.x + x]++;
    }
  }
  assert.ok([...coverage].every(n => n === 1));
  assert.deepEqual(progress.map(p => p.completed), [0, 1, 2, 3, 4]);
  assert.deepEqual(progress.at(-1), { completed: 4, total: 4, count: 4, skipped: 0 });
});

test('a tile larger than the canvas pads to the requested dimensions without scaling', async () => {
  const source = sourceCanvas(2, 1), result = await exportTileArchive(source, { width: 2, height: 1, tileWidth: 8, tileHeight: 4 });
  const entries = await readZip(result.blob), output = await decodedCanvas(entries.get('tile_r000_c000.png'));
  assert.deepEqual([output.width, output.height], [8, 4]);
  const before = rgba(source), after = rgba(output);
  assert.deepEqual([...after.slice(0, 8)], [...before]); assert.ok([...after.slice(8)].every(value => value === 0));
});

test('skip-empty keeps row/column filenames and retains the faintest nonzero alpha', async () => {
  const source = nativeCanvas(4, 3), pixels = new Uint8ClampedArray(4 * 3 * 4); pixels.set([255, 0, 0, 1], (2 * 4 + 3) * 4);
  source.getContext('2d').putImageData(new ImageData(pixels, 4, 3), 0, 0);
  const result = await exportTileArchive(source, { width: 4, height: 3, tileWidth: 2, tileHeight: 2, skipEmpty: true });
  assert.deepEqual([result.count, result.skipped], [1, 3]);
  const entries = await readZip(result.blob); assert.deepEqual([...entries.keys()], ['tile_r001_c001.png', 'layout.json']);
  const tile = result.manifest.tiles[0]; assert.deepEqual([tile.row, tile.column, tile.x, tile.y], [1, 1, 2, 2]);
  const output = await decodedCanvas(entries.get(tile.filename)); assert.equal(rgba(output)[7], 1);
});

test('a fully transparent skipped atlas still produces a useful layout manifest', async () => {
  const result = await exportTileArchive(nativeCanvas(3, 2), { width: 3, height: 2, tileWidth: 2, tileHeight: 2, skipEmpty: true });
  assert.deepEqual([result.count, result.skipped], [0, 2]); assert.deepEqual(result.manifest.tiles, []);
  const entries = await readZip(result.blob); assert.deepEqual([...entries.keys()], ['layout.json']);
  assert.equal(JSON.parse(entries.get('layout.json').toString()).skipped, 2);
});

test('cancellation before and during export stops without returning a downloadable archive', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(exportTileArchive(sourceCanvas(), { width: 5, height: 3 }, { signal: controller.signal }), { name: 'AbortError' });
  const mid = new AbortController(), progress = [];
  await assert.rejects(exportTileArchive(sourceCanvas(), { width: 5, height: 3, tileWidth: 1, tileHeight: 1 }, {
    signal: mid.signal, onProgress: p => { progress.push(p.completed); if (p.completed === 2) mid.abort(); },
  }), { name: 'AbortError' });
  assert.deepEqual(progress, [0, 1, 2]);
});

test('dimension mismatches, too many tiles and ZIP byte budget fail explicitly', async () => {
  await assert.rejects(exportTileArchive(sourceCanvas(), { width: 6, height: 3 }), /尺寸.*不一致/);
  await assert.rejects(exportTileArchive(nativeCanvas(101, 100), { width: 101, height: 100, tileWidth: 1, tileHeight: 1 }), /10,000/);
  const source = sourceCanvas(1, 1), previous = document.createElement;
  document.createElement = () => {
    const c = nativeCanvas();
    c.toBlob = callback => callback({ type: 'image/png', size: TILE_LIMITS.zipBytes, arrayBuffer() { throw new Error('oversize encoding must be rejected before retaining bytes'); } });
    return c;
  };
  try { await assert.rejects(exportTileArchive(source, { width: 1, height: 1, tileWidth: 1, tileHeight: 1 }), /200 MB/); }
  finally { document.createElement = previous; }
});
