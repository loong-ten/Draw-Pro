import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { createFileZip, exportAllZip } from '../dist/io.js';

const require = createRequire(import.meta.url);
const JSZip = require(require.resolve('jszip', {
  paths: [process.cwd(), process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES].filter(Boolean),
}));

// Verify the produced archive with an independent ZIP reader, including CRCs.
async function readZip(blob) {
  const bytes = Buffer.from(await blob.arrayBuffer());
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
  return Promise.all(Object.values(zip.files).map(async entry => ({
    name: entry.name, data: await entry.async('base64'),
  })));
}

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="1" height="1" fill="#f00" fill-opacity="0.5"/></svg>';

test('PNG/SVG bytes, UTF-8 names, path removal and case-insensitive duplicate names survive ZIP reading', async () => {
  const archive = await createFileZip([
    { name: '../素材.png', blob: new Blob([png], { type: 'image/png' }) },
    { name: '素材.png', blob: new Blob([png], { type: 'image/png' }) },
    { name: 'Muzzle.svg', blob: new Blob([svg], { type: 'image/svg+xml' }) },
    { name: 'muzzle.SVG', blob: new Blob([svg]) },
    { name: 'dir\\bad:name?.svg', blob: new Blob([svg]) },
  ]);
  assert.equal(archive.type, 'application/zip');
  const rows = await readZip(archive);
  assert.deepEqual(rows.map(r => r.name), ['素材.png', '素材 (1).png', 'Muzzle.svg', 'muzzle (1).SVG', 'bad_name_.svg']);
  assert.equal(rows[0].data, png.toString('base64'));
  assert.equal(rows[1].data, png.toString('base64'));
  assert.equal(Buffer.from(rows[2].data, 'base64').toString(), svg);
});

test('async iterable is consumed in order and preserves individual SVG contents', async () => {
  const visited = [];
  async function* files() {
    for (const index of [1, 2]) {
      visited.push(index);
      await Promise.resolve();
      yield { name: `像素-${index}.svg`, blob: new Blob([`${svg}\n<!-- ${index} -->`]) };
    }
  }
  const rows = await readZip(await createFileZip(files()));
  assert.deepEqual(visited, [1, 2]);
  assert.deepEqual(rows.map(r => r.name), ['像素-1.svg', '像素-2.svg']);
  assert.equal(Buffer.from(rows[1].data, 'base64').toString(), `${svg}\n<!-- 2 -->`);
});

test('initial cancellation avoids requesting files, while mid-read cancellation closes an async generator', async () => {
  let requested = false;
  async function* unused() { requested = true; yield { name: 'unused.png', blob: new Blob([png]) }; }
  await assert.rejects(createFileZip(unused(), { isCancelled: () => true }), error => error.cancelled === true && error.name === 'AbortError');
  assert.equal(requested, false);

  let cancelled = false, closed = false, secondRequested = false;
  class CancelDuringRead extends Blob {
    async arrayBuffer() { cancelled = true; return super.arrayBuffer(); }
  }
  async function* interrupted() {
    try {
      yield { name: 'first.png', blob: new CancelDuringRead([png]) };
      secondRequested = true;
      yield { name: 'second.svg', blob: new Blob([svg]) };
    } finally { closed = true; }
  }
  await assert.rejects(createFileZip(interrupted(), { isCancelled: () => cancelled }), error => error.cancelled === true);
  assert.equal(closed, true);
  assert.equal(secondRequested, false);
});

test('500 entries are accepted, and the next entry is rejected', async () => {
  const entries = Array.from({ length: 500 }, (_, i) => ({ name: `素材-${i}.svg`, blob: new Blob([svg]) }));
  assert.equal((await readZip(await createFileZip(entries))).length, 500);
  async function* tooMany() { yield* entries; yield { name: 'extra.svg', blob: new Blob([svg]) }; }
  await assert.rejects(createFileZip(tooMany()), /500/);
});

test('size budget is checked before reading a large entry, including ZIP metadata', async () => {
  let read = false;
  // Model a Blob's size without allocating 300 MiB solely to exercise a guard.
  class LargeBlob extends Blob {
    get size() { return 300 * 1024 * 1024; }
    async arrayBuffer() { read = true; return super.arrayBuffer(); }
  }
  await assert.rejects(createFileZip([{ name: 'big.png', blob: new LargeBlob() }]), error => error.code === 'EXPORT_TOO_LARGE');
  assert.equal(read, false);
});

test('invalid entries are rejected and existing workspace ZIP input validation remains intact', async () => {
  await assert.rejects(createFileZip([]), /没有可打包/);
  await assert.rejects(createFileZip(null), /列表无效/);
  await assert.rejects(createFileZip([{ name: 'fake.png', blob: 'not a blob' }]), /Blob/);
  await assert.rejects(exportAllZip([], 'png'), /工作区没有/);
  await assert.rejects(exportAllZip([], 'svg'), error => error.code === 'UNSUPPORTED_FORMAT');
});
