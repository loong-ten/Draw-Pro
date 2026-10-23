import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createCanvas, ImageData } = require(require.resolve('@napi-rs/canvas', {
  paths: [process.cwd(), process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES].filter(Boolean),
}));
globalThis.ImageData = ImageData;
globalThis.document = { createElement(tag) { assert.equal(tag, 'canvas'); return createCanvas(1, 1); } };

const { PaintDocument, composite } = await import('../dist/core.js');
const { createLayerMove } = await import('../dist/layer-move.js');
const rgba = canvas => [...canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data];
const docPixels = d => d.layers.map(layer => rgba(layer.canvas));

// Only event delivery, pointer capture and the app callbacks are adapted. Raster
// operations, layering, history and alpha conversion run on the real modules.
function eventTarget() {
  const listeners = new Map();
  return {
    style: {}, closest() { return null; },
    addEventListener(name, callback) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(callback); },
    emit(name, event = {}) { for (const callback of listeners.get(name) || []) callback({ target: this, preventDefault() {}, ...event }); },
  };
}

function fixture() {
  const d = new PaintDocument({ name: '分层像素.png', width: 32, height: 24 });
  const bottom = d.activeLayer;
  bottom.name = '背景'; bottom.canvas.getContext('2d').fillStyle = '#799ab3'; bottom.canvas.getContext('2d').fillRect(2, 2, 20, 16);
  const middle = d.addLayer('半透明部件');
  middle.canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray([
    255, 0, 0, 255, 0, 0, 255, 128, 255, 255, 255, 1,
    0, 0, 0, 0, 0, 255, 0, 64, 255, 0, 255, 192,
  ]), 3, 2), 5, 6);
  middle.opacity = .65; middle.blend = 'multiply';
  const top = d.addLayer('前景细节');
  top.canvas.getContext('2d').fillStyle = '#e3be55'; top.canvas.getContext('2d').fillRect(7, 7, 1, 1);
  d.activeLayerId = middle.id; d.resetHistory('三层原图'); d.dirty = false;
  return d;
}

function harness(original = fixture()) {
  const board = eventTarget(), captures = new Set(), messages = [], labels = [], view = { x: 38, y: 51, z: 3.25 };
  globalThis.window = eventTarget();
  const windowTarget = window;
  board.setPointerCapture = id => captures.add(id);
  board.hasPointerCapture = id => captures.has(id);
  board.releasePointerCapture = id => { if (captures.delete(id)) board.emit('lostpointercapture', { pointerId: id }); };
  const state = { tool: 'move', mode: 'paint', selection: null }, stats = { renders: 0, ui: 0, status: '', commits: 0 };
  let current = original, tool;
  const api = {
    board, getDoc: () => current, getState: () => state, getView: () => view,
    requestRender() { stats.renders++; },
    renderUI() { stats.ui++; tool?.refresh(); api.renderSelectionStatus(); },
    renderSelectionStatus() { stats.status = tool?.getStatus() || ''; },
    changed(label) { labels.push(label); stats.commits++; current.commit(label); current._composite = null; current._thumb = null; api.renderUI(); },
    toast(message, error = false) { messages.push({ message, error }); },
  };
  tool = createLayerMove(api); tool.refresh();
  const point = (x, y) => ({ x, y, sx: view.x + x * view.z, sy: view.y + y * view.z });
  const event = extra => ({ pointerId: 7, button: 0, target: board, preventDefault() { this.prevented = true; }, ...extra });
  return {
    tool, api, board, window: windowTarget, state, original, captures, messages, labels, stats, view,
    current: () => current,
    setDoc(d) { current = d; tool.refresh(); },
    down(x, y, extra) { return tool.pointerDown(event(extra), point(x, y)); },
    move(x, y, extra) { return tool.pointerMove(event(extra), point(x, y)); },
    up(x, y, extra) { return tool.pointerUp(event(extra), point(x, y)); },
    key(key, extra) { const e = event({ key, ...extra }); return { handled: tool.handleKey(e), event: e }; },
  };
}

function translated(source, width, height, dx, dy) {
  const result = new Array(width * height * 4).fill(0);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const sourceX = x - dx, sourceY = y - dy;
    if (sourceX < 0 || sourceY < 0 || sourceX >= width || sourceY >= height) continue;
    const from = (sourceY * width + sourceX) * 4, to = (y * width + x) * 4;
    for (let c = 0; c < 4; c++) result[to + c] = source[from + c];
  }
  return result;
}

test('moving the active middle layer previews independently, commits once using final pointer coordinates, and undoes/redoes exactly', () => {
  const h = harness(), d = h.original, before = docPixels(d), ids = d.layers.map(l => l.id), canvases = d.layers.map(l => l.canvas);
  const active = d.activeLayer, metadata = { opacity: active.opacity, blend: active.blend, name: active.name };
  const originalHistory = d.history;
  // With auto-selection off, a blank canvas point still moves the active layer.
  h.down(25, 20); h.move(27.2, 21.4);
  const first = h.tool.getPreview();
  assert.deepEqual({ docId: first.docId, layerId: first.layerId, revision: first.revision }, { docId: d.id, layerId: active.id, revision: 0 });
  assert.deepEqual(rgba(first.canvas), translated(before[1], d.width, d.height, 2, 1));
  h.move(26.2, 19.4);
  assert.strictEqual(h.tool.getPreview(), first, 'the preview is cached across draws');
  assert.deepEqual(rgba(first.canvas), translated(before[1], d.width, d.height, 1, -1), 'each preview starts from original pixels');
  assert.deepEqual(docPixels(d), before, 'no document raster may change during a drag');
  assert.strictEqual(d.history, originalHistory); assert.equal(d.revision, 0); assert.equal(d.dirty, false);
  // A browser can omit the last move event; pointerup is authoritative.
  h.up(28.1, 22.3);
  const after = [before[0], translated(before[1], d.width, d.height, 3, 2), before[2]];
  assert.deepEqual(docPixels(d), after); assert.deepEqual(d.layers.map(l => l.id), ids);
  assert.ok(d.layers.every((l, i) => l.canvas === canvases[i]));
  assert.deepEqual({ opacity: active.opacity, blend: active.blend, name: active.name }, metadata);
  assert.equal(h.stats.commits, 1); assert.deepEqual(h.labels, ['移动图层']); assert.equal(d.history.length, 2);
  assert.equal(h.captures.size, 0, 'lostcapture on a completed drag must not cancel the commit');
  assert.equal(h.tool.getPreview(), null); assert.match(h.tool.getStatus(), /位移 \+3 \/ \+2 px/);
  const finalComposite = rgba(composite(d));
  assert.equal(d.undo(), true); h.tool.refresh(); assert.deepEqual(docPixels(d), before); assert.equal(d.canUndo, false);
  assert.equal(d.redo(), true); h.tool.refresh(); assert.deepEqual(docPixels(d), after); assert.deepEqual(rgba(composite(d)), finalComposite);
  assert.equal(d.canRedo, false);
});

test('transparent holes, alpha=1 edges and semi-transparent pixels survive repeated previews without accumulating opacity', () => {
  const h = harness(), d = h.original, source = rgba(d.activeLayer.canvas), layer = d.activeLayer;
  assert.deepEqual(h.tool.getBounds(), { x: 5, y: 6, width: 3, height: 2 });
  h.down(10, 10);
  for (let i = 0; i < 18; i++) {
    const dx = i % 7 - 2, dy = i % 5 - 2;
    h.move(10 + dx, 10 + dy);
    const preview = h.tool.getPreview();
    assert.deepEqual(preview ? rgba(preview.canvas) : rgba(layer.canvas), translated(source, d.width, d.height, dx, dy));
  }
  h.up(12, 11);
  assert.deepEqual(rgba(layer.canvas), translated(source, d.width, d.height, 2, 1));
  assert.equal(layer.opacity, .65); assert.equal(layer.blend, 'multiply');
  const alphas = rgba(layer.canvas).filter((_, i) => i % 4 === 3);
  for (const alpha of [1, 64, 128, 192, 255]) assert.equal(alphas.filter(a => a === alpha).length, 1);
});

test('arrow nudges use one or ten pixels, Shift constrains a drag, and no-op movement creates no history', () => {
  const h = harness(), d = h.original, source = rgba(d.activeLayer.canvas);
  let result = h.key('ArrowRight'); assert.equal(result.handled, true); assert.equal(result.event.prevented, true);
  h.key('ArrowDown', { shiftKey: true });
  assert.deepEqual(rgba(d.activeLayer.canvas), translated(source, d.width, d.height, 1, 10));
  assert.equal(h.stats.commits, 2); assert.equal(d.history.length, 3);
  h.down(10, 10); h.move(15, 12, { shiftKey: true }); h.up(15, 12, { shiftKey: true });
  assert.deepEqual(rgba(d.activeLayer.canvas), translated(source, d.width, d.height, 6, 10));
  h.down(15, 15); h.move(17, 11, { shiftKey: true }); h.up(17, 11, { shiftKey: true });
  assert.deepEqual(rgba(d.activeLayer.canvas), translated(source, d.width, d.height, 6, 6));
  const count = h.stats.commits;
  h.down(10, 10); h.move(10.3, 10.4); h.up(10.3, 10.4);
  h.down(10, 10); h.move(11, 11); h.move(10, 10); h.up(10, 10);
  assert.equal(h.stats.commits, count);
  assert.equal(h.key('ArrowLeft', { ctrlKey: true }).handled, false);
  assert.equal(h.key('ArrowLeft', { target: { closest: () => ({}) } }).handled, false);
});

test('locked, hidden, zero-opacity and empty layers cannot move or acquire history', () => {
  for (const kind of ['locked', 'hidden', 'zero-opacity', 'empty']) {
    const h = harness(), d = h.original, layer = d.activeLayer;
    if (kind === 'locked') layer.locked = true;
    if (kind === 'hidden') layer.visible = false;
    if (kind === 'zero-opacity') layer.opacity = 0;
    if (kind === 'empty') layer.canvas.getContext('2d').clearRect(0, 0, d.width, d.height);
    d.resetHistory(kind); d.revision++; h.tool.refresh();
    const before = docPixels(d);
    h.down(10, 10); h.move(11, 11); h.up(11, 11); h.key('ArrowRight');
    assert.equal(h.tool.getPreview(), null, kind); assert.equal(h.stats.commits, 0, kind);
    assert.deepEqual(docPixels(d), before, kind); assert.ok(h.messages.length >= 2, kind);
    assert.match(h.messages.at(-1).message, kind === 'locked' ? /锁定/ : kind === 'empty' ? /为空/ : /不可见/);
  }
});

test('auto-selection and Ctrl/Meta pick the top alpha hit; locked content blocks lower layers and blank space keeps the selection', () => {
  const h = harness(), d = h.original, [bottom, middle, top] = d.layers;
  h.state.moveAutoSelect = true;
  h.down(7.4, 7.2); assert.equal(d.activeLayerId, top.id); h.tool.cancel();
  // A transparent hole in the middle layer exposes the background.
  h.down(5.2, 7.2); assert.equal(d.activeLayerId, bottom.id); h.tool.cancel();
  // Even alpha=1 is selectable.
  h.down(7.2, 6.2); assert.equal(d.activeLayerId, middle.id); h.tool.cancel();
  h.down(31, 23); assert.equal(d.activeLayerId, middle.id); assert.equal(h.tool.getPreview(), null);
  top.locked = true;
  h.down(7.2, 7.2); assert.equal(d.activeLayerId, top.id); h.move(8.2, 8.2); h.up(8.2, 8.2);
  assert.match(h.messages.at(-1).message, /锁定/); assert.equal(h.stats.commits, 0);
  top.visible = false;
  h.down(7.2, 7.2); assert.equal(d.activeLayerId, middle.id); h.tool.cancel();
  top.visible = true; top.opacity = 0;
  h.down(7.2, 7.2); assert.equal(d.activeLayerId, middle.id); h.tool.cancel();
  h.state.moveAutoSelect = false; top.opacity = 1; top.locked = false;
  for (const modifier of ['ctrlKey', 'metaKey']) {
    d.activeLayerId = bottom.id; h.tool.refresh();
    h.down(6.2, 6.2, { [modifier]: true }); assert.equal(d.activeLayerId, middle.id); h.tool.cancel();
  }
  assert.equal(h.stats.commits, 0);
});

test('Escape, cancellation, capture loss and blur discard previews without writing source pixels or history', () => {
  for (const cancel of ['escape', 'pointercancel', 'lostpointercapture', 'blur', 'explicit']) {
    const h = harness(), d = h.original, before = docPixels(d), history = d.history;
    h.down(10, 10); h.move(13, 12); assert.ok(h.tool.getPreview());
    if (cancel === 'escape') assert.equal(h.key('Escape').handled, true);
    if (cancel === 'pointercancel') h.board.emit('pointercancel', { pointerId: 7 });
    if (cancel === 'lostpointercapture') h.board.releasePointerCapture(7);
    if (cancel === 'blur') h.window.emit('blur');
    if (cancel === 'explicit') h.tool.cancel();
    h.up(13, 12);
    assert.equal(h.tool.getPreview(), null, cancel); assert.equal(h.captures.size, 0, cancel);
    assert.deepEqual(docPixels(d), before, cancel); assert.strictEqual(d.history, history, cancel);
    assert.equal(d.revision, 0, cancel); assert.equal(d.dirty, false, cancel); assert.equal(h.stats.commits, 0, cancel);
  }
});

test('target, revision, layer object, tool, mode and boundary changes invalidate an in-flight drag before it can commit', () => {
  for (const change of ['document', 'layer', 'revision', 'layer-object', 'tool', 'mode', 'boundary', 'lock', 'hidden']) {
    const h = harness(), d = h.original, before = docPixels(d), other = fixture();
    h.down(10, 10); h.move(13, 12);
    if (change === 'document') h.setDoc(other);
    if (change === 'layer') d.activeLayerId = d.layers[0].id;
    if (change === 'revision') d.commit('外部修改');
    if (change === 'layer-object') d.layers[1] = { ...d.layers[1] };
    if (change === 'tool') h.state.tool = 'select';
    if (change === 'mode') h.state.mode = 'retouch';
    if (change === 'boundary') h.state.moveKeepInside = false;
    if (change === 'lock') d.activeLayer.locked = true;
    if (change === 'hidden') d.activeLayer.visible = false;
    h.tool.refresh(); h.up(13, 12);
    assert.equal(h.tool.getPreview(), null, change); assert.equal(h.captures.size, 0, change);
    assert.deepEqual(docPixels(d), before, change); assert.equal(h.stats.commits, 0, change);
    assert.equal(other.history.length, 1, change);
  }
  const h = harness(); h.state.mode = 'convert'; h.tool.refresh();
  assert.equal(h.down(10, 10), false); assert.equal(h.key('ArrowRight').handled, false); assert.equal(h.tool.getStatus(), '');
});

test('secondary pointers and non-left clicks cannot steal or finish a move; Space hover keeps the pan cursor', () => {
  const h = harness(), d = h.original, source = rgba(d.activeLayer.canvas);
  h.down(10, 10, { button: 2 }); h.move(12, 11); h.up(12, 11); assert.equal(h.stats.commits, 0);
  h.down(-1, 4); assert.equal(h.tool.getPreview(), null);
  h.down(10, 10); h.move(12, 11);
  const before = rgba(h.tool.getPreview().canvas);
  h.down(10, 10, { pointerId: 11 }); h.move(15, 15, { pointerId: 11 }); h.up(15, 15, { pointerId: 11 });
  h.board.emit('pointercancel', { pointerId: 11 }); h.board.emit('lostpointercapture', { pointerId: 11 });
  assert.deepEqual(rgba(h.tool.getPreview().canvas), before); assert.equal(h.stats.commits, 0);
  // Keyboard nudging must not mutate the document under an active pointer preview.
  h.key('ArrowRight'); assert.deepEqual(rgba(d.activeLayer.canvas), source);
  h.up(12, 11); assert.equal(h.stats.commits, 1);
  assert.deepEqual(rgba(d.activeLayer.canvas), translated(source, d.width, d.height, 2, 1));
  h.state.space = true; h.move(15, 15); assert.equal(h.board.style.cursor, 'grab');
});

test('default bounds preserve every nontransparent pixel; full-frame layers explain blocked movement without a no-op history', () => {
  const h = harness(), d = h.original, source = rgba(d.activeLayer.canvas);
  h.down(10, 10); h.move(-90, -90); h.up(-90, -90);
  assert.deepEqual(rgba(d.activeLayer.canvas), translated(source, d.width, d.height, -5, -6));
  assert.deepEqual(h.tool.getBounds(), { x: 0, y: 0, width: 3, height: 2 });
  assert.match(h.messages[0].message, /扩展画布/); assert.match(h.messages[0].message, /保持内容在画布内/); assert.match(h.messages[0].message, /裁切/);
  const commits = h.stats.commits; h.key('ArrowLeft'); assert.equal(h.stats.commits, commits);
  const full = new PaintDocument({ width: 8, height: 6, fill: '#334455' }), lockedToCanvas = harness(full), before = rgba(full.activeLayer.canvas);
  lockedToCanvas.down(2, 2); lockedToCanvas.move(5, 4); lockedToCanvas.up(5, 4); lockedToCanvas.key('ArrowDown', { shiftKey: true });
  assert.deepEqual(rgba(full.activeLayer.canvas), before); assert.equal(lockedToCanvas.stats.commits, 0);
  assert.ok(lockedToCanvas.messages.every(m => /边界/.test(m.message)));
});

test('explicitly disabling the boundary allows clipping, including a fully out-of-frame move, and undo recovers all pixels', () => {
  const h = harness(), d = h.original, source = rgba(d.activeLayer.canvas);
  h.state.moveKeepInside = false;
  h.down(10, 10); h.move(4, 10);
  assert.deepEqual(h.tool.getBounds(), { x: 0, y: 6, width: 2, height: 2 });
  assert.deepEqual(rgba(h.tool.getPreview().canvas), translated(source, d.width, d.height, -6, 0));
  h.up(4, 10);
  assert.deepEqual(rgba(d.activeLayer.canvas), translated(source, d.width, d.height, -6, 0));
  assert.equal(d.undo(), true); h.tool.refresh(); assert.deepEqual(rgba(d.activeLayer.canvas), source);
  h.down(10, 10); h.move(100, 100); assert.equal(h.tool.getBounds(), null); h.up(100, 100);
  assert.ok(rgba(d.activeLayer.canvas).every(value => value === 0)); assert.equal(h.stats.commits, 2);
  assert.equal(d.undo(), true); h.tool.refresh(); assert.deepEqual(rgba(d.activeLayer.canvas), source);
});

test('cached bounds avoid repeated readbacks, drawing uses only an outline, and callback status refresh is reentrant-safe', () => {
  const h = harness(), d = h.original, context = d.activeLayer.canvas.getContext('2d'), originalRead = context.getImageData.bind(context);
  let reads = 0;
  context.getImageData = (...args) => { reads++; return originalRead(...args); };
  const drawing = createCanvas(300, 250).getContext('2d'), before = docPixels(d); reads = 0;
  for (let i = 0; i < 25; i++) { h.tool.refresh(); h.tool.getStatus(); h.tool.getPreview(); h.tool.getBounds(); h.tool.draw(drawing, h.view); }
  assert.equal(reads, 0, 'steady rendering must not rescan layer pixels');
  assert.deepEqual(docPixels(d), before);
  h.down(10, 10); h.move(12, 12); d.activeLayerId = d.layers[0].id;
  h.tool.refresh(); // renderSelectionStatus invokes getStatus, which invokes refresh.
  assert.equal(h.tool.getPreview(), null); assert.match(h.stats.status, /图层 20 × 16 px/);
});

test('a failed commit restores original pixels and history instead of leaving an untracked move', () => {
  const h = harness(), d = h.original, before = docPixels(d), history = d.history;
  h.api.changed = () => { d.commit('模拟失败'); throw Error('模拟保存失败'); };
  h.down(10, 10); h.move(12, 12);
  assert.throws(() => h.up(12, 12), /模拟保存失败/);
  assert.deepEqual(docPixels(d), before); assert.strictEqual(d.history, history); assert.equal(d.historyIndex, 0);
  assert.equal(d.revision, 0); assert.equal(d.dirty, false); assert.equal(h.tool.getPreview(), null); assert.equal(h.captures.size, 0);
});
