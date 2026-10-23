import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createCanvas, ImageData } = require(require.resolve('@napi-rs/canvas', {
  paths: [process.cwd(), process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES].filter(Boolean),
}));
globalThis.ImageData = ImageData;
globalThis.document = { createElement(tag) { assert.equal(tag, 'canvas'); return createCanvas(1, 1); } };
const { makeCanvas, PaintDocument, composite } = await import('../dist/core.js');
const { clampCaptureRect, createCaptureRect, moveCaptureRect, resizeCaptureRect, captureRegion, createCaptureDocument, captureFileName } = await import('../dist/capture-core.js');

const pixels = canvas => canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;

function fillPixels(canvas) {
  const data = new Uint8ClampedArray(canvas.width * canvas.height * 4);
  const alphas = [0, 1, 2, 17, 64, 127, 128, 192, 254, 255];
  for (let i = 0; i < data.length / 4; i++) {
    data.set([(i * 47) % 256, (i * 71 + 9) % 256, (i * 31 + 3) % 256, alphas[i % alphas.length]], i * 4);
  }
  canvas.getContext('2d').putImageData(new ImageData(data, canvas.width, canvas.height), 0, 0);
}

function expectedRegion(source, rect) {
  const before = pixels(source), expected = [];
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      expected.push(...before.slice((y * source.width + x) * 4, (y * source.width + x) * 4 + 4));
    }
  }
  return expected;
}

test('reverse drags, fractional coordinates and outside endpoints stay pixel-aligned and permit one pixel', () => {
  assert.deepEqual(createCaptureRect({ x: 9.2, y: 7.8 }, { x: 2.2, y: 1.2 }, 10, 10), { x: 2, y: 1, w: 7, h: 7 });
  assert.deepEqual(createCaptureRect({ x: -50, y: -50 }, { x: 30, y: 30 }, 10, 8), { x: 0, y: 0, w: 10, h: 8 });
  assert.deepEqual(createCaptureRect({ x: 10, y: 8 }, { x: 10, y: 8 }, 10, 8), { x: 9, y: 7, w: 1, h: 1 });
  assert.deepEqual(clampCaptureRect({ x: NaN, y: Infinity, w: -4, h: '' }, 10, 8), { x: 0, y: 0, w: 1, h: 1 });
  assert.deepEqual(clampCaptureRect({ x: 8, y: 6, w: 30, h: 30 }, 10, 8), { x: 8, y: 6, w: 2, h: 2 });
});

test('moving keeps dimensions while resize preserves the opposite edge and cannot cross it', () => {
  const rect = { x: 2, y: 3, w: 5, h: 4 };
  assert.deepEqual(moveCaptureRect(rect, 999, -999, 10, 10), { x: 5, y: 0, w: 5, h: 4 });
  assert.deepEqual(resizeCaptureRect(rect, 'nw', 999, 999, 10, 10), { x: 6, y: 6, w: 1, h: 1 });
  assert.deepEqual(resizeCaptureRect(rect, 'se', -999, -999, 10, 10), { x: 2, y: 3, w: 1, h: 1 });
  assert.deepEqual(resizeCaptureRect(rect, 'w', -999, 999, 10, 10), { x: 0, y: 3, w: 7, h: 4 });
  assert.deepEqual(resizeCaptureRect(rect, 's', 999, 999, 10, 10), { x: 2, y: 3, w: 5, h: 7 });
  assert.deepEqual(rect, { x: 2, y: 3, w: 5, h: 4 }, 'geometry functions never mutate the starting rectangle');
});

test('capture copies exact native RGBA bytes including transparency, without changing the source', () => {
  const source = makeCanvas(7, 6);
  fillPixels(source);
  const before = [...pixels(source)], rect = { x: 1, y: 1, w: 5, h: 4 };
  const output = captureRegion(source, rect);
  assert.equal(output.width, 5);
  assert.equal(output.height, 4);
  assert.deepEqual([...pixels(output)], expectedRegion(source, rect));
  assert.deepEqual([...pixels(source)], before);
  const single = captureRegion(source, { x: 6, y: 5, w: 1, h: 1 });
  assert.deepEqual([...pixels(single)], before.slice(-4));
  const transparent = captureRegion(makeCanvas(2, 2), { x: 0, y: 0, w: 2, h: 2 });
  assert.ok(pixels(transparent).every(byte => byte === 0), 'transparent source does not acquire a checkerboard or background');
});

test('capture uses the supplied visible-layer composition and makes an editable independent document', () => {
  const original = new PaintDocument({ name: '源图.png', width: 7, height: 6 });
  fillPixels(original.activeLayer.canvas);
  const hidden = original.addLayer('隐藏');
  hidden.canvas.getContext('2d').fillRect(0, 0, 7, 6);
  hidden.visible = false;
  const highlight = original.addLayer('高光');
  highlight.canvas.getContext('2d').fillStyle = '#c03080';
  highlight.canvas.getContext('2d').fillRect(2, 1, 3, 3);
  highlight.opacity = .35;
  highlight.blend = 'screen';
  highlight.locked = true;
  original.fileHandle = { sentinel: true };
  original.path = '/source/源图.png';
  original.resetHistory('源图历史');
  const before = original.layers.map(layer => [...pixels(layer.canvas)]);
  const source = composite(original), rect = { x: 1, y: 1, w: 5, h: 4 };
  const expected = expectedRegion(source, rect);
  const created = createCaptureDocument(source, rect, '源图_截图_01.png');
  assert.deepEqual([...pixels(created.activeLayer.canvas)], expected);
  assert.notEqual(created.id, original.id);
  assert.equal(created.layers.length, 1);
  assert.equal(created.activeLayer.name, '区域截图');
  assert.equal(created.history.length, 1);
  assert.equal(created.canUndo, false);
  assert.equal(created.dirty, true);
  assert.equal(created.fileHandle, undefined);
  assert.equal(created.path, undefined);
  created.activeLayer.canvas.getContext('2d').clearRect(0, 0, 5, 4);
  created.commit('独立编辑');
  assert.equal(created.undo(), true);
  assert.deepEqual([...pixels(created.activeLayer.canvas)], expected);
  assert.deepEqual(original.layers.map(layer => [...pixels(layer.canvas)]), before);
  assert.equal(original.history.length, 1);
  assert.equal(original.revision, 0);
  assert.equal(original.dirty, false);
});

test('automatic and custom PNG names remain safe and unique across repeated captures', () => {
  assert.equal(captureFileName('枪械.png', '', []), '枪械_截图_01.png');
  assert.equal(captureFileName('枪械.jpg', '', ['枪械_截图_01.png', '枪械_截图_02.PNG']), '枪械_截图_03.png');
  assert.equal(captureFileName('源.png', '握把.jpg', []), '握把.png');
  assert.equal(captureFileName('源.png', 'Grip.png', ['grip.PNG', 'Grip_02.png']), 'Grip_03.png');
  assert.equal(captureFileName('', '', []), '素材_截图_01.png');
  const safe = captureFileName('源.png', '../test:piece?.webp', []);
  assert.equal(safe, '_test_piece_.png');
  assert.equal(/[<>:"/\\|?*\u0000-\u001f]/.test(safe), false);
});
