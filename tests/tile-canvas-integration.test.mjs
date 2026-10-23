import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { localPointToWorld } from '../dist/composition-slots.js';
import { bounds } from '../dist/composition-geometry.js';
import { DEFAULT_TILE_CANVAS, CANVAS_PRESETS } from '../dist/tile-canvas-core.js';
import { PaintDocument, composite } from '../dist/core.js';
import { downloadBlob, saveWorkspace, loadWorkspace } from '../dist/io.js';

const require = createRequire(import.meta.url);
const nativePath = require.resolve('@napi-rs/canvas', { paths: [process.cwd(), process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES].filter(Boolean) });
const { createCanvas, loadImage, Image, ImageData } = require(nativePath);
let pausePNG = null, downloadEvents = [];
const objectURLs = new Map(), downloadTimers = new Set();
const nativeCreateObjectURL = URL.createObjectURL.bind(URL), nativeRevokeObjectURL = URL.revokeObjectURL.bind(URL);
URL.createObjectURL = blob => { const url = nativeCreateObjectURL(blob); objectURLs.set(url, blob); return url; };
URL.revokeObjectURL = url => { objectURLs.delete(url); nativeRevokeObjectURL(url); };
const nativeSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (callback, delay, ...args) => {
  const timer = nativeSetTimeout(callback, delay, ...args);
  if (delay >= 60_000) { timer.unref?.(); downloadTimers.add(timer); }
  return timer;
};

// Component integration using the minimal DOM from composer-assembly.test.mjs.
// Product event handlers, history, scene transforms, native raster composition
// and PNG encoding run unchanged. This is not browser E2E: CSS/layout, browser
// focus/pointer capture and the download affordance are outside this harness.
// Only PNG callback scheduling and download capture are controllable so a real
// in-flight export can be inspected and cancelled deterministically.
const decode = text => String(text).replace(/&(quot|amp|lt|gt|#39);/g, (_, key) => ({ quot: '"', amp: '&', lt: '<', gt: '>', '#39': "'" }[key]));
const dataKey = name => name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
function matches(node, selector) {
  const tag = selector.match(/^[a-z][\w-]*/i)?.[0];
  if (tag && node.tagName !== tag.toUpperCase()) return false;
  for (const [, name] of selector.matchAll(/\.([\w-]+)/g)) if (!node.className.split(/\s+/).includes(name)) return false;
  for (const [, name, value] of selector.matchAll(/\[([^\]=]+)(?:="([^"]*)")?\]/g)) {
    const actual = name.startsWith('data-') ? node.dataset[dataKey(name)] : name in node ? node[name] : node.attributes[name];
    if (actual === undefined || actual === null || actual === false) return false;
    if (value !== undefined && String(actual) !== value) return false;
  }
  return true;
}
function descendantMatches(node, selector) {
  const parts = selector.trim().replace(/\s*>\s*/g, ' > ').split(/\s+/);
  if (!matches(node, parts.pop())) return false;
  let parent = node.parentNode;
  while (parts.length) {
    const direct = parts.at(-1) === '>';
    if (direct) parts.pop();
    const part = parts.pop();
    if (direct) { if (!parent || !matches(parent, part)) return false; }
    else { while (parent && !matches(parent, part)) parent = parent.parentNode; if (!parent) return false; }
    parent = parent.parentNode;
  }
  return true;
}
const voidTags = new Set(['INPUT', 'IMG', 'BR', 'HR', 'META', 'LINK']);
function makeElement(tag) {
  const node = tag === 'canvas' ? createCanvas(1, 1) : {};
  Object.assign(node, {
    tagName: tag.toUpperCase(), attributes: {}, dataset: {}, style: {}, children: [], parentNode: null,
    listeners: new Map(), captures: new Set(), hidden: false, checked: false, disabled: false, open: false,
    clientWidth: 800, clientHeight: 500, offsetWidth: 800, offsetHeight: 500, scrollLeft: 0, scrollTop: 0,
    _className: '', _value: '', _html: '', _text: '',
    append(...children) { for (const child of children) { if (child && typeof child === 'object') { child.parentNode = this; this.children.push(child); } } },
    prepend(...children) { for (const child of [...children].reverse()) { if (child && typeof child === 'object') { child.parentNode = this; this.children.unshift(child); } } },
    remove() { if (!this.parentNode) return; this.parentNode.children = this.parentNode.children.filter(child => child !== this); this.parentNode = null; },
    getAttribute(name) { return this.attributes[name] ?? null; },
    replaceChildren(...children) { for (const child of this.children) child.parentNode = null; this.children = []; this.append(...children); },
    setAttribute(name, value) { this.attributes[name] = String(value); if (name.startsWith('data-')) this.dataset[dataKey(name)] = String(value); else if (name === 'class') this.className = value; else if (['hidden', 'checked', 'disabled', 'open', 'selected'].includes(name)) this[name] = true; else this[name] = String(value); },
    removeAttribute(name) { delete this.attributes[name]; if (name.startsWith('data-')) delete this.dataset[dataKey(name)]; else delete this[name]; },
    addEventListener(type, handler) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(handler); },
    async emit(type, properties = {}) {
      const event = { type, target: this, currentTarget: this, button: 0, pointerId: 1, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {}, ...properties };
      for (const handler of this.listeners.get(type) || []) await handler(event);
      if (typeof this['on' + type] === 'function') await this['on' + type](event);
    },
    querySelectorAll(selector) {
      const selectors = selector.split(','), result = [];
      const visit = parent => { for (const child of parent.children) { if (selectors.some(s => descendantMatches(child, s))) result.push(child); visit(child); } };
      visit(this); return result;
    },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
    closest(selector) { let cursor = this; while (cursor) { if (selector.split(',').some(s => matches(cursor, s.trim()))) return cursor; cursor = cursor.parentNode; } return null; },
    getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight, right: this.clientWidth, bottom: this.clientHeight }; },
    focus() {}, setPointerCapture(id) { this.captures.add(id); }, hasPointerCapture(id) { return this.captures.has(id); }, releasePointerCapture(id) { this.captures.delete(id); },
    showModal() { this.open = true; }, close() { this.open = false; this.emit('close'); },
    click() {
      if (this.disabled) return;
      if (this.tagName === 'A' && this.download && objectURLs.has(this.href)) downloadEvents.push({ filename: this.download, blob: objectURLs.get(this.href) });
      return this.emit('click');
    },
  });
  Object.defineProperties(node, {
    className: { get() { return this._className; }, set(value) { this._className = String(value); } },
    value: { get() { return this._value; }, set(value) { const text = String(value); this._value = this.tagName === 'SELECT' && !this.querySelectorAll('option').some(option => option.value === text) ? '' : text; } },
    textContent: { get() { return this._text + this.children.map(child => child.textContent).join(''); }, set(value) { this._text = String(value); this.replaceChildren(); } },
    innerHTML: {
      get() { return this._html; },
      set(value) {
        this._html = String(value); this._text = ''; this.replaceChildren(); const stack = [this];
        for (const token of this._html.matchAll(/<\/?[a-z][^>]*>|[^<]+/gi)) {
          const text = token[0];
          if (text.startsWith('</')) { if (stack.length > 1) stack.pop(); continue; }
          if (!text.startsWith('<')) { stack.at(-1)._text += decode(text); continue; }
          const tag = text.match(/^<([\w-]+)/)[1].toLowerCase(), child = makeElement(tag);
          const attributes = text.slice(tag.length + 1, -1).replace(/\/$/, '');
          for (const [, name, quoted, single, bare] of attributes.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) child.setAttribute(name, decode(quoted ?? single ?? bare ?? ''));
          stack.at(-1).append(child);
          if (!voidTags.has(child.tagName) && !text.endsWith('/>')) stack.push(child);
        }
        for (const select of [this, ...this.querySelectorAll('select')].filter(n => n.tagName === 'SELECT')) {
          const options = select.querySelectorAll('option'); select.value = (options.find(option => option.selected) || options[0])?.value || '';
        }
      },
    },
  });
  node.classList = {
    add(...names) { node.className = [...new Set([...node.className.split(/\s+/).filter(Boolean), ...names])].join(' '); },
    remove(...names) { node.className = node.className.split(/\s+/).filter(name => !names.includes(name)).join(' '); },
    toggle(name, force) { const has = node.className.split(/\s+/).includes(name), next = force ?? !has; next ? this.add(name) : this.remove(name); return next; },
    contains(name) { return node.className.split(/\s+/).includes(name); },
  };
  if (tag === 'canvas') node.toBlob = (callback, mime = 'image/png') => {
    const blob = new Blob([node.toBuffer(mime)], { type: mime });
    const deliver = () => callback(blob), pause = pausePNG;
    if (mime === 'image/png' && pause) { pausePNG = null; pause(deliver); } else deliver();
  };
  return node;
}

globalThis.Image = Image; globalThis.ImageData = ImageData;
globalThis.devicePixelRatio = 1;
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
let frameSequence = 0;
const frames = new Map();
globalThis.requestAnimationFrame = callback => { const id = ++frameSequence; frames.set(id, callback); return id; };
globalThis.cancelAnimationFrame = id => frames.delete(id);
const { createComposer } = await import('../dist/composer.js');

async function flushFrames() {
  const pending = [...frames]; frames.clear();
  for (const [, callback] of pending) callback(performance.now());
  await Promise.resolve();
}
async function until(predicate, label) {
  const deadline = performance.now() + 3_000;
  while (!predicate() && performance.now() < deadline) { await flushFrames(); await new Promise(setImmediate); }
  assert.ok(predicate(), label);
}
async function finish(promise) {
  let done = false, error, value;
  Promise.resolve(promise).then(result => { value = result; done = true; }, reason => { error = reason; done = true; });
  await until(() => done, 'component action completes');
  if (error) throw error;
  return value;
}
function holdNextPNG() {
  let entered = false, deliver;
  pausePNG = callback => { entered = true; deliver = callback; };
  return { get entered() { return entered; }, release() { deliver?.(); } };
}
function asset(id, width, height, draw) {
  const canvas = createCanvas(width, height); draw(canvas.getContext('2d'));
  return { id, name: id + '.png', src: canvas.toDataURL('image/png'), w: width, h: height };
}
const assetData = [
  asset('red', 4, 4, ctx => { ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, 1, 1); }),
  asset('blue', 4, 4, ctx => { ctx.fillStyle = '#0000ff'; ctx.fillRect(3, 3, 1, 1); }),
  asset('green', 4, 4, ctx => { ctx.fillStyle = '#00ff00'; ctx.fillRect(0, 0, 4, 4); }),
];
const layer = (id, assetId = 'red', extra = {}) => ({
  id, assetId, name: id, x: 0, y: 0, w: 4, h: 4, rotation: 0, opacity: 1,
  visible: true, locked: false, flipX: false, flipY: false, ...extra,
});
function fixture({ canvas = {}, layers = [], settings = {}, assets = layers.length ? assetData : [] } = {}) {
  return {
    format: 'art-workbench-composition', version: 1, name: '瓦片组件测试',
    canvas: { ...DEFAULT_TILE_CANVAS, width: 100, height: 80, tileWidth: 16, tileHeight: 16, ...canvas },
    assets: structuredClone(assets), layers: structuredClone(layers), view: { x: 0, y: 0, z: 1 },
    settings: { background: 'transparent', pixel: true, snap: false, slotSnap: false, showSlots: true, showGuides: true, ...settings },
  };
}
function sourceDoc(id, width = 12, height = 8) {
  const canvas = createCanvas(width, height), context = canvas.getContext('2d');
  context.fillStyle = '#ff0000'; context.fillRect(1, 1, 1, 1);
  return { id, name: id + '.png', width, height, revision: 0, canvas, layers: [{ canvas }] };
}
async function harness(t, project = fixture(), { sources = [], canvasMode = true } = {}) {
  const root = makeElement('body'), mount = makeElement('section'), document = makeElement('document'); root.append(mount);
  Object.assign(document, {
    body: root, createElement: makeElement, querySelector: selector => root.querySelector(selector),
    getElementById: id => root.querySelectorAll('[id]').find(node => node.id === id) || null,
  });
  globalThis.document = document; globalThis.window = makeElement('window');
  const messages = [], documents = [], modes = [], busyAtModeChange = [], downloads = [];
  downloadEvents = downloads; pausePNG = null;
  let persistCount = 0;
  const api = {
    getDoc: () => sources[0] || null, getDocs: () => sources,
    getState: () => ({ guides: [{ type: 'point', x: 4, y: 2, color: '#abcdef', label: '参考' }], showGuides: true }),
    getComposite: doc => doc.canvas, finishPending() {}, refresh() {}, persist() { persistCount++; },
    toast(message, error) { messages.push({ message, error }); },
    async addDocument(doc) { documents.push(doc); },
    async setMode(mode) { modes.push(mode); busyAtModeChange.push(composer.isBusy?.() || false); },
  };
  const composer = createComposer(api, mount, { canvasMode });
  await composer.restore(project); await composer.activate(); await flushFrames();
  t.after(() => {
    composer.deactivate(); frames.clear(); pausePNG = null;
    for (const timer of downloadTimers) clearTimeout(timer); downloadTimers.clear();
    for (const url of objectURLs.keys()) URL.revokeObjectURL(url);
    downloadBlob.pending = null;
  });
  const select = async (id, shiftKey = false) => {
    const row = mount.querySelector('[data-cmp-layer="' + id + '"]'); assert.ok(row, 'layer row is rendered');
    await mount.emit('click', { target: row, shiftKey });
  };
  const setProp = async (key, value) => {
    const input = mount.querySelector('[data-cmp-prop="' + key + '"]'); assert.ok(input?.onchange, 'real transform handler exists');
    input.value = value; await input.emit('change');
  };
  const pointer = async (type, x, y, extra = {}) => {
    const view = composer.serialize().view;
    await mount.querySelector('.cmp-canvas').emit(type, { clientX: view.x + x * view.z, clientY: view.y + y * view.z, ...extra });
  };
  const control = async selector => {
    const target = mount.querySelector(selector); assert.ok(target, 'tile control exists: ' + selector);
    await mount.querySelector('.tc-controls').emit('click', { target: target.querySelector('strong') || target });
  };
  const tc = name => control('[data-tc-action="' + name + '"]');
  const setting = async (key, value) => {
    const input = mount.querySelector('[data-tc-setting="' + key + '"]'); assert.ok(input, 'tile setting exists');
    if (input.type === 'checkbox') input.checked = value; else input.value = value;
    await input.emit('change');
  };
  return { composer, mount, document, root, api, messages, documents, modes, busyAtModeChange, downloads, select, setProp, pointer, control, tc, setting, get persistCount() { return persistCount; } };
}
const getLayer = (h, id) => h.composer.serialize().layers.find(item => item.id === id);
const close = (actual, expected, label = '') => assert.ok(Math.abs(actual - expected) < 1e-7, label + ': ' + actual + ' ≠ ' + expected);
function assertJoined(h) {
  const host = getLayer(h, 'host'), part = getLayer(h, 'part');
  const slot = host.slots.find(item => item.id === part.attachment?.slotId); assert.ok(slot, 'parent slot is retained');
  const a = localPointToWorld(host, slot), b = localPointToWorld(part, part.dock);
  close(a.x, b.x, 'joined X'); close(a.y, b.y, 'joined Y');
}
function assertPixels(canvas, points) {
  const expected = new Uint8ClampedArray(canvas.width * canvas.height * 4);
  for (const [x, y, ...rgba] of points) expected.set(rgba, (y * canvas.width + x) * 4);
  assert.deepEqual(canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data, expected, 'output contains only source pixels, transparent margins and frame clipping');
}
async function decodedCanvas(blobOrBytes) {
  const bytes = blobOrBytes instanceof Blob ? Buffer.from(await blobOrBytes.arrayBuffer()) : blobOrBytes;
  const image = await loadImage(bytes), canvas = createCanvas(image.width, image.height);
  canvas.getContext('2d').drawImage(image, 0, 0); return canvas;
}
// Only extract stored ZIP entries here. ZIP structure/CRC and generic tile edge
// behavior are already independently tested in tile-canvas-export.test.mjs.
async function zipEntries(blob) {
  const bytes = Buffer.from(await blob.arrayBuffer()), entries = new Map(); let at = 0;
  while (bytes.readUInt32LE(at) === 0x04034b50) {
    const size = bytes.readUInt32LE(at + 18), nameLength = bytes.readUInt16LE(at + 26), extraLength = bytes.readUInt16LE(at + 28);
    const name = bytes.toString('utf8', at + 30, at + 30 + nameLength), start = at + 30 + nameLength + extraLength;
    entries.set(name, bytes.subarray(start, start + size)); at = start + size;
  }
  return entries;
}

test('an empty tile canvas saves isolated settings and restores its dimensions through undo/redo', async t => {
  const h = await harness(t, null), initial = h.composer.serialize();
  assert.ok(initial, 'empty fixed canvases remain saveable');
  assert.deepEqual(initial.canvas, DEFAULT_TILE_CANVAS); assert.deepEqual(initial.layers, []); assert.deepEqual(initial.assets, []);
  h.mount.querySelector('.tc-width').value = 333; h.mount.querySelector('.tc-height').value = 221;
  await h.tc('apply-size');
  h.mount.querySelector('.tc-tile-width').value = 37; h.mount.querySelector('.tc-tile-height').value = 19;
  await h.tc('apply-tiles'); await h.setting('edge', 'keep'); await h.setting('anchor', 'bl'); await h.setting('skipEmpty', true);
  const saved = h.composer.serialize(), canvas = { ...saved.canvas };
  assert.deepEqual([canvas.width, canvas.height, canvas.tileWidth, canvas.tileHeight, canvas.edge, canvas.anchor, canvas.skipEmpty], [333, 221, 37, 19, 'keep', 'bl', true]);
  saved.canvas.width = 1; assert.equal(h.composer.serialize().canvas.width, 333, 'serialized settings do not alias live state');
  await h.composer.handleAction('undo'); assert.equal(h.composer.serialize().canvas.skipEmpty, false);
  await h.composer.handleAction('redo'); assert.deepEqual(h.composer.serialize().canvas, canvas);
  const roundtrip = h.composer.serialize(); await h.composer.restore(roundtrip);
  assert.deepEqual(h.composer.serialize(), roundtrip); assert.equal(h.composer.getHistoryState().canUndo, false);
  await h.setting('showGrid', false); await h.composer.handleAction('undo'); assert.equal(h.composer.serialize().canvas.showGrid, true);
  assert.ok(h.persistCount >= 8);
});

test('preset and custom panel events commit valid sizes and leave invalid drafts out of history', async t => {
  const h = await harness(t);
  for (const preset of CANVAS_PRESETS) {
    await h.control('[data-tc-preset="' + preset.id + '"]');
    assert.deepEqual([h.composer.serialize().canvas.width, h.composer.serialize().canvas.height], [preset.width, preset.height]);
    assert.equal(h.mount.querySelector('[data-tc-preset="' + preset.id + '"]').getAttribute('aria-pressed'), 'true');
  }
  h.mount.querySelector('.tc-width').value = 101; h.mount.querySelector('.tc-height').value = 67;
  await h.mount.querySelector('.tc-height').emit('keydown', { key: 'Enter' });
  assert.deepEqual([h.composer.serialize().canvas.width, h.composer.serialize().canvas.height], [101, 67]);
  await h.tc('swap-size'); assert.deepEqual([h.composer.serialize().canvas.width, h.composer.serialize().canvas.height], [67, 101]);
  await h.control('[data-tc-tile-size="32"]');
  h.mount.querySelector('.tc-tile-width').value = 15; h.mount.querySelector('.tc-tile-height').value = 9;
  await h.mount.querySelector('.tc-tile-width').emit('keydown', { key: 'Enter' });
  assert.deepEqual([h.composer.serialize().canvas.tileWidth, h.composer.serialize().canvas.tileHeight], [15, 9]);
  const before = h.composer.serialize(), history = h.composer.getHistoryState();
  for (const [width, height] of [['', 10], ['1.5', 10], [8193, 10], [8192, 8192]]) {
    h.mount.querySelector('.tc-width').value = width; h.mount.querySelector('.tc-height').value = height;
    await h.tc('apply-size');
    assert.deepEqual(h.composer.serialize(), before); assert.deepEqual(h.composer.getHistoryState(), history);
    assert.equal(h.mount.querySelector('.tc-error').hidden, false);
  }
  assert.equal(h.messages.filter(item => item.error).length, 4);
  await h.composer.handleAction('undo'); assert.deepEqual([h.composer.serialize().canvas.tileWidth, h.composer.serialize().canvas.tileHeight], [32, 32], 'invalid attempts never create undo entries');
});

test('repeated source imports land inside the fixed frame without resizing or mutating source pixels', async t => {
  const sources = [sourceDoc('source-a'), sourceDoc('source-b', 10, 6)], sourceBefore = sources.map(doc => doc.canvas.toDataURL());
  const h = await harness(t, fixture({ canvas: { width: 80, height: 48 } }), { sources });
  const assertReady = () => {
    for (const action of ['undo', 'export', 'send']) assert.equal(h.mount.querySelector('[data-cmp-action="' + action + '"]').disabled, false, action + ' is available when adding sources finishes');
  };
  for (let i = 0; i < 3; i++) { await h.composer.handleAction('add-all'); assertReady(); }
  await h.composer.handleAction('add-current'); assertReady();
  assert.equal(h.mount.querySelector('[data-cmp-prop="x"]').disabled, false, 'the newly added single source can immediately be edited');
  const scene = h.composer.serialize(); assert.equal(scene.layers.length, 7);
  for (const item of scene.layers) {
    const original = sources.find(doc => item.name === doc.name.replace(/\.[^.]+$/, ''));
    assert.deepEqual([item.w, item.h], [original.width, original.height]);
    assert.ok(item.x >= 0 && item.y >= 0 && item.x + item.w <= 80 && item.y + item.h <= 48, 'each imported item is placed within the visible frame');
  }
  assert.deepEqual(sources.map(doc => doc.canvas.toDataURL()), sourceBefore);
  await h.select(scene.layers[0].id); await h.setProp('x', 7); await h.composer.handleAction('flip-h');
  assert.deepEqual(sources.map(doc => doc.canvas.toDataURL()), sourceBefore, 'scene transforms never edit the original source');
  const savedSource = scene.assets.find(item => item.name === sources[0].name).src;
  sources[0].canvas.getContext('2d').clearRect(0, 0, sources[0].width, sources[0].height);
  assert.equal(h.composer.serialize().assets.find(item => item.id === scene.assets[0].id).src, savedSource, 'import captures an independent image snapshot');
});

test('tile mode preserves assembly links through host edits, centering, undo and fixed-frame fitting', async t => {
  const project = fixture({ canvas: { width: 160, height: 120 }, layers: [
    layer('host', 'red', { x: 10, y: 15, w: 40, h: 20, slots: [{ id: 'right', name: '右槽', u: 1, v: .5 }] }),
    layer('part', 'blue', { x: 80, y: 40, w: 10, h: 10, dock: { u: 0, v: .5 }, attachment: { parentId: 'host', slotId: 'right' } }),
  ], settings: { slotSnap: true } });
  const h = await harness(t, project); assertJoined(h); await h.select('host');
  await h.setProp('rotation', 30); await h.setProp('w', 60); await h.composer.handleAction('flip-h'); assertJoined(h);
  const childShape = getLayer(h, 'part');
  await h.tc('center-canvas'); assertJoined(h);
  const centered = bounds(h.composer.serialize().layers); close(centered.x + centered.w / 2, 80); close(centered.y + centered.h / 2, 60);
  const afterCenter = h.composer.serialize().layers;
  await h.composer.handleAction('undo'); assertJoined(h);
  await h.composer.handleAction('redo'); assert.deepEqual(h.composer.serialize().layers, afterCenter);
  for (const key of ['w', 'h', 'rotation', 'flipX', 'flipY']) assert.equal(getLayer(h, 'part')[key], childShape[key]);
  await h.composer.handleAction('select-all'); await h.tc('fit-canvas-content'); assertJoined(h);
  const fitted = bounds(h.composer.serialize().layers);
  assert.ok(fitted.x >= -1e-7 && fitted.y >= -1e-7 && fitted.right <= 160 + 1e-7 && fitted.bottom <= 120 + 1e-7);
  assert.deepEqual(h.composer.serialize().canvas, project.canvas);
});

test('PNG and send-to-paint use the fixed frame with transparent margins and clipped source pixels', async t => {
  const project = fixture({ canvas: { width: 10, height: 8, tileWidth: 3, tileHeight: 2 }, layers: [
    layer('host', 'red', { x: 2, y: 1, slots: [{ id: 'mark', name: '不导出的标记', u: 0, v: 0 }] }),
    layer('part', 'blue', { x: 5, y: 3 }), layer('edge', 'green', { x: -2, y: 6 }),
    layer('hidden', 'red', { x: 0, y: 0, visible: false }),
  ] });
  const h = await harness(t, project); await h.select('host'); await flushFrames();
  const pixels = [[2, 1, 255, 0, 0, 255], [8, 6, 0, 0, 255, 255], [0, 6, 0, 255, 0, 255], [1, 6, 0, 255, 0, 255], [0, 7, 0, 255, 0, 255], [1, 7, 0, 255, 0, 255]];
  await h.composer.handleAction('send');
  assert.equal(h.documents.length, 1); assert.deepEqual(h.modes, ['paint']); assert.deepEqual(h.busyAtModeChange, [false], 'send-to-paint does not report tile export busy');
  const output = h.documents[0]; assert.deepEqual([output.width, output.height, output.layers.length], [10, 8, 4]);
  assert.equal(output.layers[3].visible, false); assertPixels(composite(output), pixels);
  await finish(h.tc('canvas-png'));
  if (h.mount.querySelector('.cmp-export-dialog').open) await finish(h.mount.querySelector('.cmp-export-download').click());
  assert.equal(h.downloads.length, 1); assert.match(h.downloads[0].filename, /\.png$/);
  const png = await decodedCanvas(h.downloads[0].blob); assert.deepEqual([png.width, png.height], [10, 8]); assertPixels(png, pixels);
  const empty = fixture({ canvas: { width: 13, height: 9 } }); await h.composer.restore(empty);
  await h.composer.handleAction('send');
  const blank = h.documents.at(-1); assert.deepEqual([blank.width, blank.height], [13, 9]); assert.ok(blank.layers.length > 0); assertPixels(composite(blank), []);
});

test('real pointer drags snap all three anchors to grid intersections and exact partial-cell edges', async t => {
  const project = fixture({ canvas: { width: 100, height: 83, tileWidth: 32, tileHeight: 24 }, layers: [layer('moving', 'green', { x: 8, y: 8, w: 20, h: 16 })] });
  const h = await harness(t, project);
  for (const [anchor, dx, dy, x, y] of [['tl', 21, 17, 32, 24], ['bl', 21, 17, 32, 32], ['center', 21, 17, 22, 16]]) {
    await h.composer.restore({ ...project, canvas: { ...project.canvas, anchor } });
    await h.pointer('pointerdown', 18, 16); await h.pointer('pointermove', 18 + dx, 16 + dy); await h.pointer('pointerup', 18 + dx, 16 + dy);
    close(getLayer(h, 'moving').x, x, anchor + ' X'); close(getLayer(h, 'moving').y, y, anchor + ' Y');
    await h.composer.handleAction('undo'); close(getLayer(h, 'moving').x, 8); close(getLayer(h, 'moving').y, 8);
    await h.composer.handleAction('redo'); close(getLayer(h, 'moving').x, x); close(getLayer(h, 'moving').y, y);
  }
  await h.composer.restore({ ...project, canvas: { ...project.canvas, anchor: 'center' } });
  await h.pointer('pointerdown', 18, 16); await h.pointer('pointermove', 99, 82); await h.pointer('pointerup', 99, 82);
  close(getLayer(h, 'moving').x + 10, 100, 'right canvas edge'); close(getLayer(h, 'moving').y + 8, 83, 'bottom canvas edge');
  await h.composer.restore(project);
  await h.pointer('pointerdown', 18, 16); await h.pointer('pointermove', 39, 33, { altKey: true }); await h.pointer('pointerup', 39, 33, { altKey: true });
  close(getLayer(h, 'moving').x, 29, 'Alt bypass X'); close(getLayer(h, 'moving').y, 25, 'Alt bypass Y');
});

test('two-point grid measurement reports partial edges without moving layers or recording history', async t => {
  const h = await harness(t, fixture({ canvas: { width: 100, height: 83, tileWidth: 32, tileHeight: 24 }, layers: [layer('moving', 'green', { x: 8, y: 8, w: 50, h: 40 })] }));
  await h.select('moving'); const before = h.composer.serialize(), history = h.composer.getHistoryState();
  await h.tc('measure-grid');
  await h.pointer('pointerdown', 31, 25); await h.pointer('pointerup', 31, 25);
  assert.equal(h.mount.querySelector('.tc-measure-p1').textContent, '(32, 24) px');
  await h.pointer('pointerdown', 99, 82); await h.pointer('pointerup', 99, 82); await flushFrames();
  const assertMeasurement = () => {
    assert.equal(h.mount.querySelector('.tc-measure-p1').textContent, '(32, 24) px');
    assert.equal(h.mount.querySelector('.tc-measure-p2').textContent, '(100, 83) px');
    assert.equal(h.mount.querySelector('.tc-measure-size').textContent, '68 × 59 px');
    assert.equal(h.mount.querySelector('.tc-measure-grid').textContent, '3 列 × 3 行');
    assert.equal(h.mount.querySelector('.tc-measure-summary').hidden, false);
  };
  assertMeasurement();
  assert.deepEqual(h.composer.serialize(), before); assert.deepEqual(h.composer.getHistoryState(), history);
  await h.tc('measure-grid'); assert.equal(h.mount.querySelector('[data-tc-action="measure-grid"]').getAttribute('aria-pressed'), 'false'); assertMeasurement();
  await h.tc('measure-grid'); assert.equal(h.mount.querySelector('[data-tc-action="measure-grid"]').getAttribute('aria-pressed'), 'true'); assertMeasurement();
  assert.deepEqual(h.composer.serialize(), before); assert.deepEqual(h.composer.getHistoryState(), history, 'turning point selection off and on retains the result without recording history');
  await h.setting('showGrid', false); assertMeasurement();
  await h.setting('edge', 'keep'); assertMeasurement();
  assert.equal(h.composer.serialize().canvas.showGrid, false); assert.equal(h.composer.serialize().canvas.edge, 'keep');
  const settingsHistory = h.composer.getHistoryState();
  await h.pointer('pointerdown', 63, 47);
  assert.equal(h.mount.querySelector('.tc-measure-p1').textContent, '(64, 48) px');
  await h.pointer('pointercancel', 63, 47); assertMeasurement();
  assert.deepEqual(h.composer.getHistoryState(), settingsHistory, 'a cancelled third point restores both previous points without changing history');
  await h.pointer('pointerdown', 63, 47); await h.pointer('pointerup', 63, 47);
  assert.equal(h.mount.querySelector('.tc-measure-p1').textContent, '(64, 48) px');
  assert.equal(h.mount.querySelector('.tc-measure-summary').hidden, true, 'a third point starts a fresh measurement');
  await h.tc('clear-measure'); assert.equal(h.mount.querySelector('[data-tc-action="clear-measure"]').disabled, true);
  await h.tc('measure-grid'); assert.equal(h.mount.querySelector('[data-tc-action="measure-grid"]').getAttribute('aria-pressed'), 'false');
  assert.deepEqual(h.composer.serialize().layers, before.layers); assert.deepEqual(h.composer.getHistoryState(), settingsHistory, 'new points and clearing never add entries after the settings changes');
});

test('tile export captures a fixed source snapshot, blocks edits and writes frame metadata with clean pixels', async t => {
  const h = await harness(t, fixture({ canvas: { width: 7, height: 5, tileWidth: 3, tileHeight: 2 }, layers: [
    layer('host', 'red', { slots: [{ id: 'mark', name: '辅助点', u: .5, v: .5 }] }), layer('part', 'blue', { x: 3, y: 1 }),
  ] }));
  await h.select('host'); await flushFrames(); const before = h.composer.serialize();
  const gate = holdNextPNG(), pending = h.tc('tile-export');
  try {
    await until(() => gate.entered, 'the first real PNG has been encoded');
    assert.equal(h.composer.isBusy(), true); assert.equal(h.mount.querySelector('.tc-progress').hidden, false);
    assert.equal(h.mount.querySelector('.tc-width').disabled, true); assert.equal(h.mount.querySelector('[data-tc-action="tile-cancel"]').disabled, false);
    const exposed = h.composer.serialize(); exposed.canvas.width = 1; exposed.layers[0].x = 500; exposed.assets[0].src = assetData[2].src;
    await h.composer.handleAction('delete'); await h.setProp('x', 99); await h.control('[data-tc-preset="720p"]');
    await h.pointer('pointerdown', 2, 2); await h.pointer('pointermove', 4, 4); await h.pointer('pointerup', 4, 4);
    assert.deepEqual(h.composer.serialize(), before, 'in-flight output cannot be changed through scene controls or shared snapshot references');
  } finally { gate.release(); await finish(pending); }
  assert.equal(h.composer.isBusy(), false); assert.equal(h.mount.querySelector('.tc-progress').hidden, true); assert.equal(h.downloads.length, 1);
  assert.match(h.downloads[0].filename, /\.zip$/); const entries = await zipEntries(h.downloads[0].blob), layout = JSON.parse(entries.get('layout.json').toString());
  assert.deepEqual([layout.width, layout.height, layout.tileWidth, layout.tileHeight, layout.columns, layout.rows, layout.total, layout.count], [7, 5, 3, 2, 3, 3, 9, 9]);
  const rebuilt = createCanvas(7, 5), context = rebuilt.getContext('2d');
  for (const tile of layout.tiles) {
    const image = await decodedCanvas(entries.get(tile.filename)); assert.deepEqual([image.width, image.height], [3, 2]);
    context.drawImage(image, tile.x, tile.y);
    if (tile.row === 2 && tile.column === 2) assertPixels(image, [[0, 0, 0, 0, 255, 255]]);
  }
  assertPixels(rebuilt, [[0, 0, 255, 0, 0, 255], [6, 4, 0, 0, 255, 255]]);
  assert.deepEqual(h.composer.serialize(), before);
});

test('cancelling an in-flight tile export removes busy state, creates no download and allows a retry', async t => {
  const h = await harness(t, fixture({ canvas: { width: 5, height: 3, tileWidth: 3, tileHeight: 2 }, layers: [layer('host')] }));
  const before = h.composer.serialize(), gate = holdNextPNG(), pending = h.tc('tile-export');
  try {
    await until(() => gate.entered, 'tile export reaches asynchronous encoding');
    assert.equal(h.composer.isBusy(), true); await h.tc('tile-cancel');
  } finally { gate.release(); await finish(pending); }
  assert.equal(h.composer.isBusy(), false); assert.equal(h.downloads.length, 0); assert.equal(h.mount.querySelector('.tc-progress').hidden, true);
  assert.equal(h.mount.querySelector('.tc-width').disabled, false); assert.equal(h.mount.querySelector('[data-tc-action="tile-export"]').disabled, false);
  assert.deepEqual(h.composer.serialize(), before);
  await finish(h.tc('tile-export')); assert.equal(h.downloads.length, 1); assert.equal(h.composer.isBusy(), false);
});

test('a real paintspace save/load restores independent tile and composition scenes, settings, slots and source pixels', async t => {
  const project = fixture({
    canvas: { width: 19, height: 11, tileWidth: 7, tileHeight: 3, edge: 'keep', anchor: 'bl', showGrid: false, showNumbers: false, skipEmpty: true },
    layers: [
      layer('host', 'red', { x: 2, y: 3, slots: [{ id: 'right', name: '右槽', u: 1, v: .5 }] }),
      layer('part', 'blue', { x: 12, y: 4, dock: { u: 0, v: .5 }, attachment: { parentId: 'host', slotId: 'right' } }),
    ], settings: { slotSnap: true, showSlots: false },
  });
  const h = await harness(t, project); assertJoined(h);
  const otherMount = makeElement('section'); h.root.append(otherMount);
  const ordinary = createComposer(h.api, otherMount);
  const independent = fixture({ layers: [layer('independent', 'green', { x: -13, y: 27 })] }); independent.name = '独立拼接布局';
  await ordinary.restore(independent); t.after(() => ordinary.deactivate());
  const workbench = { version: 1, mode: 'tile', composer: ordinary.serialize(), tileCanvas: h.composer.serialize() };
  assert.equal(workbench.composer.canvas, undefined, 'ordinary composition has no fixed frame');
  const source = new PaintDocument({ id: 'workspace-source', name: 'source.png', width: 5, height: 3 });
  source.path = 'sprites/source.png'; source.activeLayer.canvas.getContext('2d').fillStyle = '#112233'; source.activeLayer.canvas.getContext('2d').fillRect(1, 1, 1, 1);
  const guides = [{ id: 'point-1', type: 'point', x: 2, y: 3, color: '#abcdef', label: '共享点', visible: true, locked: false }];
  const saved = await saveWorkspace([source], guides, { workspaceName: '画布往返', activeDocId: source.id, baseWidth: 19, baseHeight: 11, referenceMode: 'pixel', workbench });
  assert.equal(saved.name, '画布往返.paintspace'); assert.equal(h.downloads.length, 1); assert.equal(h.downloads[0].filename, saved.name);
  // Supply the browser bitmap-decoding API with real native PNG decoding. All
  // workspace JSON validation, layer reconstruction and scene restore run as-is.
  const previousBitmap = globalThis.createImageBitmap;
  globalThis.createImageBitmap = async blob => loadImage(Buffer.from(await blob.arrayBuffer()));
  let loaded;
  try { loaded = await loadWorkspace(h.downloads[0].blob); }
  finally { if (previousBitmap === undefined) delete globalThis.createImageBitmap; else globalThis.createImageBitmap = previousBitmap; }
  assert.deepEqual(loaded.settings.workbench, workbench); assert.deepEqual(loaded.guides, guides);
  assert.equal(loaded.docs.length, 1); const restoredSource = loaded.docs[0];
  assert.deepEqual([restoredSource.id, restoredSource.width, restoredSource.height, restoredSource.path], [source.id, 5, 3, source.path]);
  assertPixels(composite(restoredSource), [[1, 1, 17, 34, 51, 255]]);
  await h.composer.restore(null); await ordinary.restore(null);
  await h.composer.restore(loaded.settings.workbench.tileCanvas); await ordinary.restore(loaded.settings.workbench.composer);
  assert.deepEqual(h.composer.serialize(), workbench.tileCanvas); assert.deepEqual(ordinary.serialize(), workbench.composer); assertJoined(h);
  assert.deepEqual(h.composer.serialize().canvas, project.canvas);
  await h.composer.handleAction('send'); const restoredRaster = h.documents.at(-1);
  assert.deepEqual([restoredRaster.width, restoredRaster.height], [19, 11]);
  assertPixels(composite(restoredRaster), [[2, 3, 255, 0, 0, 255], [9, 6, 0, 0, 255, 255]]);
  assert.deepEqual(ordinary.serialize(), workbench.composer, 'restoring and rendering the tile canvas leaves the other scene untouched');
});

