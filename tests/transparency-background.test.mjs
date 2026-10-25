import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { drawTransparencyBackground, normalizeCanvasBackground } from '../dist/transparency-background.js';
import { importGuides, writeGuides } from '../dist/io.js';

const require = createRequire(import.meta.url);
const { createCanvas, Path2D } = require(require.resolve('@napi-rs/canvas', {
  paths: [process.cwd(), process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES].filter(Boolean),
}));
globalThis.Path2D = Path2D;
const data = canvas => canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
const pixel = (canvas, x, y) => [...data(canvas).slice((y * canvas.width + x) * 4, (y * canvas.width + x) * 4 + 4)];
const rectangle = { x: 7, y: 6, width: 29, height: 23 };
function filledCanvas() {
  const canvas = createCanvas(48, 40), ctx = canvas.getContext('2d');
  ctx.fillStyle = '#e34a72'; ctx.fillRect(0, 0, 48, 40);
  return { canvas, ctx };
}
function assertOutsideUnchanged(canvas, before, rect = rectangle) {
  const after = data(canvas);
  for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
    if (x >= rect.x && y >= rect.y && x < rect.x + rect.width && y < rect.y + rect.height) continue;
    const index = (y * canvas.width + x) * 4;
    assert.deepEqual([...after.slice(index, index + 4)], [...before.slice(index, index + 4)], `outside (${x}, ${y})`);
  }
}

test('checker keeps the existing white/gray screen grid and clips every cell to the requested rectangle', () => {
  const { canvas, ctx } = filledCanvas(), before = data(canvas).slice();
  drawTransparencyBackground(ctx, rectangle, 'checker');
  assert.deepEqual(pixel(canvas, 8, 8), [229, 231, 233, 255]);
  assert.deepEqual(pixel(canvas, 12, 8), [255, 255, 255, 255]);
  assert.deepEqual(pixel(canvas, 12, 12), [229, 231, 233, 255]);
  assertOutsideUnchanged(canvas, before);
});

test('studio is an opaque dark gradient and cannot paint outside its rectangle', () => {
  const { canvas, ctx } = filledCanvas(), before = data(canvas).slice();
  drawTransparencyBackground(ctx, rectangle, 'studio');
  const center = pixel(canvas, 21, 15), corner = pixel(canvas, 8, 7);
  assert.equal(center[3], 255); assert.equal(corner[3], 255);
  assert.ok(center.slice(0, 3).every(channel => channel < 90));
  assert.ok(center[0] > corner[0], 'studio has a soft central light');
  assertOutsideUnchanged(canvas, before);
});

test('transparent removes the earlier white shadow fill only inside the rectangle and restores context state/path', () => {
  const { canvas, ctx } = filledCanvas();
  ctx.save(); ctx.shadowColor = '#000000'; ctx.shadowBlur = 4; ctx.shadowOffsetY = 2;
  ctx.fillStyle = '#ffffff'; ctx.fillRect(rectangle.x, rectangle.y, rectangle.width, rectangle.height); ctx.restore();
  const before = data(canvas).slice();
  ctx.globalAlpha = .37; ctx.globalCompositeOperation = 'multiply';
  ctx.shadowColor = '#123456'; ctx.shadowBlur = 3; ctx.shadowOffsetX = 2; ctx.shadowOffsetY = 1;
  ctx.fillStyle = '#abcdef'; ctx.beginPath(); ctx.rect(1, 1, 2, 2);
  const saved = { alpha: ctx.globalAlpha, composite: ctx.globalCompositeOperation, fill: ctx.fillStyle,
    shadow: ctx.shadowColor, blur: ctx.shadowBlur, x: ctx.shadowOffsetX, y: ctx.shadowOffsetY };
  drawTransparencyBackground(ctx, rectangle, 'transparent');
  const after = data(canvas);
  for (let y = rectangle.y; y < rectangle.y + rectangle.height; y++) for (let x = rectangle.x; x < rectangle.x + rectangle.width; x++) {
    assert.equal(after[(y * canvas.width + x) * 4 + 3], 0, `clear alpha at (${x}, ${y})`);
  }
  assertOutsideUnchanged(canvas, before);
  assert.deepEqual({ alpha: ctx.globalAlpha, composite: ctx.globalCompositeOperation, fill: ctx.fillStyle,
    shadow: ctx.shadowColor, blur: ctx.shadowBlur, x: ctx.shadowOffsetX, y: ctx.shadowOffsetY }, saved);
  assert.equal(ctx.isPointInPath(2, 2), true); assert.equal(ctx.isPointInPath(15, 15), false);
});

test('DPR keeps ten CSS-pixel checker cells and huge offscreen images remain bounded by the display canvas', () => {
  const canvas = createCanvas(80, 60), ctx = canvas.getContext('2d');
  ctx.setTransform(2, 0, 0, 2, 0, 0);
  const originalFill = ctx.fillRect.bind(ctx); let fills = 0;
  ctx.fillRect = (...args) => { fills++; return originalFill(...args); };
  drawTransparencyBackground(ctx, { x: -100000, y: -100000, width: 200000, height: 200000 }, 'checker');
  assert.deepEqual(pixel(canvas, 10, 10), [229, 231, 233, 255]);
  assert.deepEqual(pixel(canvas, 25, 10), [255, 255, 255, 255]);
  assert.ok(fills < 30, `draws ${fills} visible fills, not the whole zoomed image`);
  assert.equal(ctx.getTransform().a, 2); assert.equal(ctx.getTransform().d, 2);
});

test('the real app background setter synchronizes both previews and saves a view preference without changing the document', () => {
  const source = readFileSync(new URL('../dist/app.js', import.meta.url), 'utf8');
  const names = ['renderCanvasBackgroundControl', 'setCanvasBackground', 'settings'];
  const code = names.map(name => source.match(new RegExp(`^function ${name}\\([^\\n]*$`, 'm'))?.[0]).join('\n');
  assert.ok(names.every(name => code.includes(`function ${name}(`)));
  const { canvas } = filledCanvas(), original = [...data(canvas)], history = [{ label: '打开图像' }];
  const doc = { canvas, dirty: false, revision: 3, history, historyIndex: 0 };
  const state = { canvasBackground: 'checker', docs: [doc], workspaceDirty: false };
  const select = { value: 'checker' }, calls = { render: 0, padding: 0, persist: [] };
  const api = runInNewContext(`${code}\n({setCanvasBackground,settings})`, {
    state, normalizeCanvasBackground, $: selector => { assert.equal(selector, '#canvas-background'); return select; },
    requestRender: () => calls.render++, persist: options => calls.persist.push(options),
    workbench: { padding: { refreshBackground: () => calls.padding++ }, serialize: () => ({ mode: 'paint' }) },
  });
  for (const kind of ['studio', 'transparent', 'checker', 'invalid']) {
    api.setCanvasBackground(kind);
    const expected = kind === 'invalid' ? 'checker' : kind;
    assert.equal(state.canvasBackground, expected); assert.equal(select.value, expected);
    assert.equal(api.settings().canvasBackground, expected);
  }
  assert.equal(calls.render, 4); assert.equal(calls.padding, 4);
  assert.ok(calls.persist.every(options => options.sync === false));
  assert.equal(doc.history, history); assert.equal(doc.historyIndex, 0); assert.equal(doc.revision, 3);
  assert.equal(doc.dirty, false); assert.equal(state.workspaceDirty, false); assert.deepEqual([...data(canvas)], original);
});

test('real settings validation persists all three backgrounds and defaults old/invalid files to checker', async () => {
  for (const kind of ['studio', 'checker', 'transparent', undefined, 'white', true, 42]) {
    assert.equal(normalizeCanvasBackground(kind), ['studio', 'checker', 'transparent'].includes(kind) ? kind : 'checker');
    let written;
    const directory = { kind: 'directory', queryPermission: async () => 'granted', requestPermission: async () => 'granted', getFileHandle: async () => ({
      createWritable: async () => ({ write: async blob => { written = blob; }, close: async () => {} }),
    }) };
    await writeGuides(directory, [], { canvasBackground: kind });
    const saved = JSON.parse(await written.text());
    const expected = ['studio', 'checker', 'transparent'].includes(kind) ? kind : 'checker';
    assert.equal(saved.settings.canvasBackground, expected);
    const restored = await importGuides(new File([JSON.stringify({ kind: 'paint-studio-guides', version: 1,
      guides: [], settings: { canvasBackground: kind } })], 'references.json', { type: 'application/json' }));
    assert.equal(restored.settings.canvasBackground, expected);
  }
});
