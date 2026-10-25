import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createCanvas, ImageData } = require(require.resolve('@napi-rs/canvas', {
  paths: [process.cwd(), process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES].filter(Boolean),
}));
globalThis.ImageData = ImageData;
const { PaintDocument, cloneCanvas } = await import('../dist/core.js');
const { createCanvasFrame } = await import('../dist/canvas-frame.js');

// Like layer-move.test.mjs, adapt DOM events and host callbacks only. Geometry,
// integer RGBA copies, complete document history and undo/redo are production
// code on native canvases. This is not browser layout/hit-testing coverage.
const dataKey = name => name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
function matches(node, selector) {
  if (selector.startsWith('.')) return node.classList.contains(selector.slice(1));
  const data = selector.match(/^\[(data-[\w-]+)(?:="([^"]*)")?\]$/);
  if (data) return dataKey(data[1]) in node.dataset && (data[2] === undefined || node.dataset[dataKey(data[1])] === data[2]);
  return node.tagName === selector.toUpperCase();
}
function dispatch(target, type, properties = {}) {
  const event = {
    type, target, button: 0, pointerId: 7, isPrimary: true,
    ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
    prevented: false, stopped: false, immediate: false,
    preventDefault() { this.prevented = true; },
    stopPropagation() { this.stopped = true; },
    stopImmediatePropagation() { this.immediate = this.stopped = true; },
    ...properties,
  };
  const path = [];
  for (let node = target; node; node = node.parentNode) path.push(node);
  const invoke = (node, capture) => {
    event.currentTarget = node;
    for (const listener of node.listeners.get(type) || []) {
      if (listener.capture !== capture) continue;
      listener.callback(event);
      if (event.immediate) break;
    }
  };
  for (const node of [...path].reverse()) { invoke(node, true); if (event.stopped) return event; }
  for (const node of path) { invoke(node, false); if (event.stopped) break; }
  return event;
}
function element(tag) {
  const node = {
    tagName: tag.toUpperCase(), parentNode: null, children: [], dataset: {},
    className: '', hidden: false, textContent: '', listeners: new Map(), captures: new Set(),
    style: { setProperty(key, value) { this[key] = value; }, removeProperty(key) { delete this[key]; } },
    clientWidth: 820, clientHeight: 580,
    append(child) { child.parentNode = this; this.children.push(child); },
    addEventListener(type, callback, options) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push({ callback, capture: options === true || options?.capture === true });
    },
    emit(type, properties = {}) { return dispatch(properties.target || this, type, properties); },
    closest(selector) { for (let item = this; item; item = item.parentNode) if (matches(item, selector)) return item; return null; },
    querySelectorAll(selector) {
      const result = [];
      const visit = item => { for (const child of item.children) { if (matches(child, selector)) result.push(child); visit(child); } };
      visit(this); return result;
    },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
    setAttribute(name, value) {
      if (name.startsWith('data-')) this.dataset[dataKey(name)] = String(value);
      else if (name === 'class') this.className = String(value);
      else if (name === 'hidden') this.hidden = true;
      else this[name] = String(value);
    },
    focus() { globalThis.document.activeElement = this; },
    setPointerCapture(id) { this.captures.add(id); },
    hasPointerCapture(id) { return this.captures.has(id); },
    releasePointerCapture(id) {
      if (this.captures.delete(id)) dispatch(this, 'lostpointercapture', { pointerId: id });
    },
  };
  node.classList = {
    contains(name) { return node.className.split(/\s+/).includes(name); },
    add(...names) { node.className = [...new Set([...node.className.split(/\s+/).filter(Boolean), ...names])].join(' '); },
    remove(...names) { node.className = node.className.split(/\s+/).filter(name => !names.includes(name)).join(' '); },
    toggle(name, force) { const value = force ?? !this.contains(name); value ? this.add(name) : this.remove(name); return value; },
  };
  Object.defineProperty(node, 'innerHTML', {
    set(html) {
      this.children = [];
      const stack = [this];
      for (const [token] of String(html).matchAll(/<\/?[a-z][^>]*>/gi)) {
        if (token.startsWith('</')) { stack.pop(); continue; }
        const name = token.match(/^<([\w-]+)/)[1], child = element(name);
        for (const [, key, value] of token.slice(name.length + 1, -1).matchAll(/([^\s=/>]+)(?:="([^"]*)")?/g)) child.setAttribute(key, value ?? '');
        stack.at(-1).append(child); stack.push(child);
      }
    },
  });
  return node;
}

const rgba = canvas => [...canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data];
const metadata = layer => Object.fromEntries(['id', 'name', 'visible', 'locked', 'opacity', 'blend'].map(key => [key, layer[key]]));
const inspect = doc => ({ width: doc.width, height: doc.height, activeLayerId: doc.activeLayerId,
  layers: doc.layers.map(layer => ({ ...metadata(layer), pixels: rgba(layer.canvas) })) });
function fixture() {
  const d = new PaintDocument({ name: '画幅测试.png', width: 12, height: 9 });
  for (let n = 0; n < 3; n++) {
    const layer = n ? d.addLayer('图层 ' + n) : d.activeLayer;
    Object.assign(layer, { visible: n !== 2, locked: n === 2, opacity: [1, .65, .3][n], blend: ['source-over', 'multiply', 'screen'][n] });
    const data = new Uint8ClampedArray(d.width * d.height * 4), alpha = [0, 1, 64, 128, 192, 255];
    for (let p = 0; p < d.width * d.height; p++) data.set([(p*31+n*17)%256, (p*79+n*13)%256, (p*47+n*23)%256, alpha[(p+n)%alpha.length]], p*4);
    layer.canvas.getContext('2d').putImageData(new ImageData(data, d.width, d.height), 0, 0);
  }
  d.activeLayerId = d.layers[1].id; d.resetHistory('原图'); d.dirty = false;
  return d;
}
function harness(t, { view = { x: 38, y: 51, z: 2.5, fit: true }, prepare, onCommit } = {}) {
  const document = element('document'), body = element('body'), viewport = element('div'), host = element('div');
  document.append(body); body.append(viewport); viewport.append(host);
  document.createElement = tag => tag === 'canvas' ? createCanvas(1, 1) : element(tag);
  globalThis.document = document; globalThis.window = element('window');
  const window = globalThis.window, original = fixture(), docs = [original];
  original.view = { ...view };
  let current = original, controller, blocked = false;
  const state = { mode: 'paint', tool: 'brush', space: false, selection: null, gesture: null, showRulers: true, lastAction: 'guide' };
  const stats = { renders: 0, prepares: 0, commits: 0, pans: 0 }, messages = [];
  const api = {
    viewport, getDoc: () => current, getDocs: () => docs, getState: () => state, getView: () => current.view,
    requestRender() { stats.renders++; }, toast(message, error = false) { messages.push({ message, error }); },
    assertIdle() { if (blocked) throw new Error('工作区正在处理'); },
    prepare() { api.assertIdle(); controller.cancel(); stats.prepares++; prepare?.(current); },
    pan() { stats.pans++; },
    onCommit() { stats.commits++; state.lastAction = 'image'; onCommit?.(current); controller.refresh(); },
  };
  controller = createCanvasFrame(api, host); controller.refresh();
  t.after(() => controller.cancel());
  const button = handle => { const node = host.querySelector(`[data-frame-handle="${handle}"]`); assert.ok(node); return node; };
  let target = button('se');
  return { controller, original, docs, host, viewport, document, window, state, stats, messages, button,
    setDoc(doc) { if (!docs.includes(doc)) docs.push(doc); current = doc; controller.refresh(); },
    block(value = true) { blocked = value; },
    down(handle, x = 180, y = 140, extra = {}) { target = button(handle); return host.emit('pointerdown', { target, clientX: x, clientY: y, ...extra }); },
    move(x, y, extra = {}) { return host.emit('pointermove', { target, clientX: x, clientY: y, ...extra }); },
    up(x, y, extra = {}) { return host.emit('pointerup', { target, clientX: x, clientY: y, ...extra }); },
    key(handle, key, extra = {}) { return host.emit('keydown', { target: button(handle), key, ...extra }); },
    captured() { return host.querySelectorAll('[data-frame-handle]').reduce((sum, node) => sum + node.captures.size, 0); },
  };
}
function assertFramePixels(before, doc, frame) {
  assert.equal(doc.width, frame.width); assert.equal(doc.height, frame.height);
  assert.equal(doc.activeLayerId, before.activeLayerId); assert.equal(doc.layers.length, before.layers.length);
  doc.layers.forEach((layer, index) => {
    const source = before.layers[index], expectedMetadata = { ...source }; delete expectedMetadata.pixels;
    assert.deepEqual(metadata(layer), expectedMetadata);
    const actual = rgba(layer.canvas), expected = new Array(frame.width * frame.height * 4).fill(0);
    for (let y = 0; y < frame.height; y++) for (let x = 0; x < frame.width; x++) {
      const sx = x + frame.x, sy = y + frame.y;
      if (sx < 0 || sy < 0 || sx >= before.width || sy >= before.height) continue;
      for (let c = 0; c < 4; c++) expected[(y*frame.width+x)*4+c] = source.pixels[(sy*before.width+sx)*4+c];
    }
    assert.deepEqual(actual, expected, `layer ${index}: exact translation/crop, with transparent new pixels`);
  });
}

test('dragging only previews; final pointerup coordinates commit exactly once and undo/redo restore all layer pixels', t => {
  const h = harness(t), d = h.original, before = inspect(d), history = d.history, canvases = d.layers.map(l => l.canvas);
  h.down('se'); h.move(185, 145);
  assert.deepEqual(h.controller.getPreview(), { x: 0, y: 0, width: 14, height: 11 });
  h.move(182.5, 137.5);
  assert.deepEqual(h.controller.getPreview(), { x: 0, y: 0, width: 13, height: 8 });
  assert.deepEqual(inspect(d), before); assert.strictEqual(d.history, history);
  assert.ok(d.layers.every((layer, i) => layer.canvas === canvases[i]));
  assert.equal(d.revision, 0); assert.equal(d.dirty, false); assert.equal(d.view.fit, false);
  h.up(190, 147.5); // No final pointermove: release must use +4/+3 image pixels.
  assertFramePixels(before, d, { x: 0, y: 0, width: 16, height: 12 });
  const after = inspect(d);
  assert.equal(h.stats.commits, 1); assert.equal(d.history.length, 2); assert.equal(d.revision, 1);
  assert.equal(h.captured(), 0); assert.equal(h.controller.getPreview(), null);
  h.up(190, 147.5); assert.equal(h.stats.commits, 1);
  assert.equal(d.undo(), true); h.controller.refresh(); assert.deepEqual(inspect(d), before);
  assert.equal(d.redo(), true); h.controller.refresh(); assert.deepEqual(inspect(d), after);
  assert.equal(h.messages.some(message => message.error), false);
});

test('Escape, pointercancel, capture loss, blur and window resize discard preview and restore the starting view', t => {
  for (const reason of ['escape', 'pointercancel', 'lostpointercapture', 'blur', 'resize']) {
    const h = harness(t), d = h.original, before = inspect(d), history = d.history, view = { ...d.view };
    h.down('nw'); h.move(172.5, 135);
    assert.ok(h.controller.isDragging()); assert.equal(d.view.fit, false);
    if (reason === 'escape') { const event = h.key('nw', 'Escape'); assert.equal(event.prevented, true); assert.equal(event.immediate, true); }
    if (reason === 'pointercancel') h.host.emit('pointercancel', { target: h.button('nw'), pointerId: 7 });
    if (reason === 'lostpointercapture') h.button('nw').releasePointerCapture(7);
    if (reason === 'blur' || reason === 'resize') h.window.emit(reason);
    h.up(172.5, 135);
    assert.deepEqual(inspect(d), before, reason); assert.strictEqual(d.history, history, reason);
    assert.deepEqual(d.view, view, reason); assert.equal(h.stats.commits, 0, reason); assert.equal(d.revision, 0, reason);
    assert.equal(h.controller.getPreview(), null, reason); assert.equal(h.captured(), 0, reason);
    assert.equal(h.viewport.classList.contains('is-resizing-frame'), false, reason);
    assert.equal(h.host.querySelector('.canvas-frame-readout').hidden, true, reason);
  }
});

test('changing the source, revision or layer canvas cannot apply a stale drag to either document', t => {
  for (const change of ['source', 'revision', 'canvas']) {
    const h = harness(t), d = h.original, before = inspect(d), initialView = { ...d.view };
    const other = fixture(); other.view = { x: 102, y: 87, z: 1.75, fit: false }; const otherBefore = inspect(other);
    h.down('e'); h.move(195, 140);
    if (change === 'source') h.setDoc(other);
    if (change === 'revision') d.commit('外部编辑');
    if (change === 'canvas') d.layers[0].canvas = cloneCanvas(d.layers[0].canvas);
    const revision = d.revision, history = d.history;
    // A release must revalidate even when no render/refresh ran after the change.
    h.up(200, 140);
    assert.deepEqual(inspect(d), before, change); assert.deepEqual(inspect(other), otherBefore, change);
    assert.equal(d.revision, revision, change); assert.strictEqual(d.history, history, change);
    assert.deepEqual(d.view, initialView, change); assert.equal(h.stats.commits, 0, change); assert.equal(h.captured(), 0, change);
  }
});

test('non-unit zoom freezes fit and left/top resizing keeps surviving original pixels at the same screen position', t => {
  for (const z of [.5, 3.25]) {
    const h = harness(t, { view: { x: 71, y: 83, z, fit: true } }), d = h.original, before = inspect(d), view = { ...d.view };
    h.down('nw', 200, 160);
    assert.deepEqual(d.view, { ...view, fit: false });
    h.move(200 + 2*z, 160 - z); h.controller.refresh();
    assert.deepEqual(d.view, { ...view, fit: false }, 'preview must not pan/zoom or restore fit');
    h.up(200 + 3*z, 160 - 2*z);
    const frame = { x: 3, y: -2, width: 9, height: 11 };
    assertFramePixels(before, d, frame);
    assert.deepEqual(d.view, { x: view.x + 3*z, y: view.y - 2*z, z, fit: false });
    for (const [x, y] of [[3, 0], [4, 4], [11, 8]]) {
      assert.equal(d.view.x + (x-frame.x)*z, view.x + x*z);
      assert.equal(d.view.y + (y-frame.y)*z, view.y + y*z);
    }
    assert.equal(h.stats.commits, 1);
  }
});

test('focused handle arrow keys move only its allowed edges, including Shift 10px, and consume the event', t => {
  const cases = [
    ['n', 'ArrowUp', false, { x: 0, y: -1, width: 12, height: 10 }],
    ['ne', 'ArrowRight', false, { x: 0, y: 0, width: 13, height: 9 }],
    ['e', 'ArrowLeft', false, { x: 0, y: 0, width: 11, height: 9 }],
    ['se', 'ArrowDown', true, { x: 0, y: 0, width: 12, height: 19 }],
    ['s', 'ArrowUp', false, { x: 0, y: 0, width: 12, height: 8 }],
    ['sw', 'ArrowLeft', true, { x: -10, y: 0, width: 22, height: 9 }],
    ['w', 'ArrowRight', false, { x: 1, y: 0, width: 11, height: 9 }],
    ['nw', 'ArrowDown', false, { x: 0, y: 1, width: 12, height: 8 }],
  ];
  for (const [handle, key, shiftKey, frame] of cases) {
    const h = harness(t), d = h.original, before = inspect(d), event = h.key(handle, key, { shiftKey });
    assert.equal(event.prevented, true); assert.equal(event.stopped, true);
    assertFramePixels(before, d, frame); assert.equal(h.stats.commits, 1); assert.equal(d.history.length, 2);
  }
  const h = harness(t), before = inspect(h.original), history = h.original.history;
  h.key('n', 'ArrowLeft'); h.key('e', 'ArrowUp'); h.key('e', 'ArrowRight', { ctrlKey: true });
  assert.deepEqual(inspect(h.original), before); assert.strictEqual(h.original.history, history); assert.equal(h.stats.commits, 0);
});

test('no-op drag, unrelated pointer events and late busy rejection cannot allocate an extra document history state', t => {
  const h = harness(t), d = h.original, before = inspect(d), history = d.history, view = { ...d.view };
  h.down('se'); h.up(180, 140);
  h.down('se'); h.move(190, 150); h.up(180, 140);
  assert.strictEqual(d.history, history); assert.deepEqual(d.view, view); assert.equal(h.stats.commits, 0);
  h.down('se'); h.move(185, 145);
  const preview = h.controller.getPreview();
  h.move(210, 175, { pointerId: 99 }); h.up(210, 175, { pointerId: 99 });
  h.host.emit('pointercancel', { target: h.button('se'), pointerId: 99 });
  assert.deepEqual(h.controller.getPreview(), preview); assert.equal(h.stats.commits, 0);
  h.block(); h.up(190, 150);
  assert.deepEqual(inspect(d), before); assert.strictEqual(d.history, history); assert.deepEqual(d.view, view);
  assert.equal(h.captured(), 0); assert.equal(h.controller.isDragging(), false); assert.equal(h.stats.commits, 0);
  assert.match(h.messages.at(-1).message, /正在处理/); assert.equal(h.messages.at(-1).error, true);
});

test('a post-commit UI callback failure preserves the successful pixels, history and anchored view', t => {
  const logged = t.mock.method(console, 'error', () => {});
  const h = harness(t, { onCommit() { throw new Error('fixture UI refresh failure'); } });
  const d = h.original, before = inspect(d), view = { ...d.view };
  h.down('w'); h.up(185, 140);
  assertFramePixels(before, d, { x: 2, y: 0, width: 10, height: 9 });
  assert.equal(d.history.length, 2); assert.equal(d.revision, 1); assert.equal(h.stats.commits, 1);
  assert.deepEqual(d.view, { ...view, x: view.x + 2*view.z, fit: false });
  assert.equal(h.captured(), 0); assert.equal(h.controller.isDragging(), false);
  assert.match(h.messages.at(-1).message, /画幅已调整.*可撤销/);
  assert.doesNotMatch(h.messages.at(-1).message, /未更改/);
  assert.equal(logged.mock.callCount(), 1);
  assert.equal(d.undo(), true); assert.deepEqual(inspect(d), before);
});
