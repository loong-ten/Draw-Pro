import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { localPointToWorld } from '../dist/composition-slots.js';

const require = createRequire(import.meta.url);
const nativePath = require.resolve('@napi-rs/canvas', { paths: [process.cwd(), process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES].filter(Boolean) });
const { createCanvas, Image, ImageData } = require(nativePath);

// This is a local component integration harness, not browser E2E. The tiny DOM
// below supplies the element properties, selectors and event delivery used by
// createComposer. Actual application handlers, image decoding, canvas drawing,
// assembly rules, history and project serialization are unmodified. Layout,
// focus/pointer capture and the native browser download affordance are not tested.
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
  const parts = selector.trim().split(/\s+/);
  if (!matches(node, parts.pop())) return false;
  let parent = node.parentNode;
  while (parts.length) {
    const part = parts.pop();
    while (parent && !matches(parent, part)) parent = parent.parentNode;
    if (!parent) return false;
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
    click() { return this.emit('click'); },
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

const source = (color, x, y) => { const canvas = createCanvas(4, 4); const ctx = canvas.getContext('2d'); ctx.fillStyle = color; ctx.fillRect(x, y, 1, 1); return canvas.toDataURL('image/png'); };
const assetData = [
  { id: 'red', name: '主体.png', src: source('#ff0000', 0, 0), w: 4, h: 4 },
  { id: 'blue', name: '配件.png', src: source('#0000ff', 3, 3), w: 4, h: 4 },
];
const layer = (id, extra = {}) => ({ id, assetId: id === 'host' ? 'red' : 'blue', name: id, x: 100, y: 100, w: 120, h: 80, rotation: 0, opacity: 1, visible: true, locked: false, flipX: false, flipY: false, ...extra });
const fixture = (attached = true) => ({
  format: 'art-workbench-composition', version: 1, name: '卡槽集成测试', assets: structuredClone(assetData),
  layers: [
    layer('host', { slots: [{ id: 'right', name: '右侧', u: 1, v: .5 }] }),
    layer('part', { x: 300, y: 120, w: 40, h: 40, dock: { u: 0, v: .5 }, attachment: attached ? { parentId: 'host', slotId: 'right' } : null }),
  ],
  view: { x: 0, y: 0, z: 1 }, settings: { background: 'transparent', pixel: true, snap: true, slotSnap: true, showSlots: true, showGuides: true },
});
async function harness(t, project = fixture()) {
  const root = makeElement('body'), mount = makeElement('section'), doc = makeElement('document'); root.append(mount);
  Object.assign(doc, { body: root, createElement: makeElement, querySelector: selector => root.querySelector(selector), getElementById: id => root.querySelectorAll('[id]').find(node => node.id === id) || null });
  globalThis.document = doc; globalThis.window = makeElement('window');
  const messages = [], documents = [], modes = [];
  let persistCount = 0;
  const api = {
    getDoc: () => null, getDocs: () => [], getState: () => ({ guides: [{ type: 'point', x: 4, y: 2, color: '#abcdef', label: '参考' }], showGuides: true }),
    getComposite: () => null, finishPending() {}, refresh() {}, persist() { persistCount++; },
    toast(message, error) { messages.push({ message, error }); },
    async addDocument(document) { documents.push(document); }, async setMode(mode) { modes.push(mode); },
  };
  const composer = createComposer(api, mount);
  await composer.restore(project); await composer.activate();
  t.after(() => { composer.deactivate(); frames.clear(); });
  const select = async (id, shiftKey = false) => {
    const row = mount.querySelector('[data-cmp-layer="' + id + '"]'); assert.ok(row, 'rendered layer row exists');
    await mount.emit('click', { target: row, shiftKey });
  };
  const setProp = async (name, value) => {
    const input = mount.querySelector('[data-cmp-prop="' + name + '"]'); assert.ok(input?.onchange, 'real input handler exists');
    input.value = value; await input.emit('change');
  };
  const pointer = async (type, x, y, extra = {}) => {
    const view = composer.serialize().view;
    await mount.querySelector('.cmp-canvas').emit(type, { clientX: view.x + x * view.z, clientY: view.y + y * view.z, ...extra });
  };
  return { composer, mount, api, messages, documents, modes, select, setProp, pointer, get persistCount() { return persistCount; } };
}
const getLayer = (h, id) => h.composer.serialize().layers.find(layer => layer.id === id);
const close = (a, b, text = '') => assert.ok(Math.abs(a - b) < 1e-7, `${text}: ${a} ≠ ${b}`);
const assertJoined = (h, childId = 'part', hostId = 'host') => {
  const parent = getLayer(h, hostId), child = getLayer(h, childId);
  const slot = parent.slots.find(slot => slot.id === child.attachment.slotId);
  const a = localPointToWorld(parent, slot), b = localPointToWorld(child, child.dock);
  close(a.x, b.x, 'connected X'); close(a.y, b.y, 'connected Y');
};

test('real composer restores legacy scenes, preserves assembly/settings and isolates serialized snapshots', async t => {
  const old = fixture(false); old.format = 'pinjing'; delete old.layers[0].slots; delete old.layers[1].dock; delete old.layers[1].attachment;
  const h = await harness(t, old);
  assert.deepEqual(getLayer(h, 'host').slots, []); assert.deepEqual(getLayer(h, 'part').dock, { u: .5, v: .5 });
  assert.equal(getLayer(h, 'part').attachment, null);
  const incoming = fixture(); incoming.settings.slotSnap = false; incoming.settings.showSlots = false;
  await h.composer.restore(incoming);
  const saved = h.composer.serialize();
  assertJoined(h); assert.equal(saved.settings.slotSnap, false); assert.equal(saved.settings.showSlots, false);
  assert.equal(saved.assets[0].src, incoming.assets[0].src);
  saved.layers[0].slots[0].u = 0; saved.layers[1].dock.v = 0; saved.layers[1].attachment.slotId = 'bad';
  assert.equal(getLayer(h, 'host').slots[0].u, 1); assert.equal(getLayer(h, 'part').dock.v, .5); assertJoined(h);
  const roundtrip = h.composer.serialize(); await h.composer.restore(roundtrip);
  assert.deepEqual(h.composer.serialize(), roundtrip); assert.equal(h.composer.getHistoryState().canUndo, false);
});

test('real transform input and flip actions retain docking while child shape stays independent', async t => {
  const h = await harness(t); await h.select('host');
  const part = getLayer(h, 'part');
  for (const [key, value] of [['x', 137], ['y', -20], ['rotation', 67], ['w', 180]]) { await h.setProp(key, value); assertJoined(h); }
  await h.composer.handleAction('flip-h'); await h.composer.handleAction('flip-v'); assertJoined(h);
  const changed = getLayer(h, 'part');
  for (const key of ['w', 'h', 'rotation', 'flipX', 'flipY']) assert.equal(changed[key], part[key]);
  assert.ok(h.persistCount >= 6);
  await h.composer.handleAction('undo'); assert.equal(getLayer(h, 'host').flipY, false); assertJoined(h);
  await h.composer.handleAction('redo'); assert.equal(getLayer(h, 'host').flipY, true); assertJoined(h);
});

test('copying an entire component remaps links, moves independently and participates in undo/redo', async t => {
  const h = await harness(t); const original = h.composer.serialize().layers;
  await h.composer.handleAction('select-all'); await h.composer.handleAction('duplicate');
  const copies = h.composer.serialize().layers.filter(layer => !['host', 'part'].includes(layer.id));
  const host = copies.find(layer => layer.slots.length), part = copies.find(layer => layer.attachment);
  assert.equal(copies.length, 2); assert.equal(part.attachment.parentId, host.id); assertJoined(h, part.id, host.id);
  close(host.x, original[0].x + 24); close(part.x, original[1].x + 24);
  await h.select(host.id); await h.setProp('x', host.x + 60); assertJoined(h, part.id, host.id);
  assert.deepEqual(h.composer.serialize().layers.slice(0, 2), original);
  await h.composer.handleAction('undo'); close(getLayer(h, host.id).x, host.x);
  await h.composer.handleAction('undo'); assert.equal(h.composer.serialize().layers.length, 2);
  await h.composer.handleAction('redo'); assert.equal(h.composer.serialize().layers.length, 4); assertJoined(h, part.id, host.id);
});

test('deleting a host detaches surviving children at the same world position, and undo restores connections', async t => {
  const h = await harness(t), before = getLayer(h, 'part');
  await h.select('host'); await h.composer.handleAction('delete');
  const after = getLayer(h, 'part'); assert.equal(after.attachment, null); close(after.x, before.x); close(after.y, before.y);
  await h.composer.handleAction('undo'); assertJoined(h);
  await h.composer.handleAction('redo'); assert.equal(getLayer(h, 'part').attachment, null);
});

test('pointer click preserves a connection and pointer cancellation restores the entire moved component', async t => {
  const h = await harness(t);
  await h.pointer('pointerdown', 240, 140); await h.pointer('pointerup', 240, 140);
  assertJoined(h); assert.equal(h.composer.getHistoryState().canUndo, false);
  await h.select('host'); const before = h.composer.serialize().layers;
  await h.pointer('pointerdown', 160, 140); await h.pointer('pointermove', 190, 170, { altKey: true });
  assert.notEqual(getLayer(h, 'host').x, before[0].x); assertJoined(h);
  await h.pointer('pointercancel', 190, 170);
  assert.deepEqual(h.composer.serialize().layers, before); assert.equal(h.composer.getHistoryState().canUndo, false);
});

test('real pointer drag connects nearby anchors; Alt bypasses both slot and ordinary snapping', async t => {
  const h = await harness(t, fixture(false));
  await h.pointer('pointerdown', 320, 140); await h.pointer('pointermove', 242, 140);
  assert.equal(h.mount.querySelector('.cmp-slot-hint').hidden, false);
  await h.pointer('pointerup', 242, 140); assertJoined(h);
  assert.equal(getLayer(h, 'part').x, 220);
  await h.composer.handleAction('undo'); assert.equal(getLayer(h, 'part').attachment, null); assert.equal(getLayer(h, 'part').x, 300);
  await h.composer.handleAction('redo'); assertJoined(h);
  await h.composer.restore(fixture(false));
  await h.pointer('pointerdown', 320, 140); await h.pointer('pointermove', 242, 140, { altKey: true }); await h.pointer('pointerup', 242, 140, { altKey: true });
  assert.equal(getLayer(h, 'part').attachment, null); assert.equal(getLayer(h, 'part').x, 222);
});

test('a precise child X edit explicitly detaches without being pulled back; size edits remain docked', async t => {
  const h = await harness(t); await h.select('part');
  await h.setProp('w', 64); assertJoined(h); assert.equal(getLayer(h, 'part').w, 64);
  await h.setProp('x', 400); assert.equal(getLayer(h, 'part').x, 400); assert.equal(getLayer(h, 'part').attachment, null);
  await h.composer.handleAction('undo'); assertJoined(h); assert.equal(getLayer(h, 'part').w, 64);
});

test('damaged imported links are cleaned without rejecting the rest of the project', async t => {
  const data = fixture();
  data.layers.push(layer('duplicate', { x: 700, attachment: { parentId: 'host', slotId: 'right' } }));
  data.layers.push(layer('missing', { x: 800, attachment: { parentId: 'gone', slotId: 'right' } }));
  data.layers.push(layer('loop', { x: 900, slots: [{ id: 'loop', name: '循环', u: .5, v: .5 }], attachment: { parentId: 'loop', slotId: 'loop' } }));
  const h = await harness(t, data); assertJoined(h);
  for (const id of ['duplicate', 'missing', 'loop']) assert.equal(getLayer(h, id).attachment, null);
  assert.equal(getLayer(h, 'duplicate').x, 700); assert.equal(getLayer(h, 'missing').x, 800); assert.equal(getLayer(h, 'loop').x, 900);
  assert.equal(h.messages.filter(message => message.error).length, 0);
});

test('the real anchor editor keeps drafts private, applies center slots and records one undoable change', async t => {
  const h = await harness(t); await h.select('host');
  const before = h.composer.serialize().layers;
  await h.composer.handleAction('edit-slots');
  const editor = h.mount.querySelector('.cmp-slot-editor');
  const action = async name => {
    const target = editor.querySelector('[data-slot-action="' + name + '"]');
    assert.ok(target); await editor.emit('click', { target });
  };
  assert.equal(editor.open, true);
  await action('add');
  assert.deepEqual(h.composer.serialize().layers, before, 'editing a draft does not mutate the scene');
  await action('save');
  assert.equal(editor.open, false);
  const slots = getLayer(h, 'host').slots;
  assert.equal(slots.length, 2); assert.equal(slots[0].id, 'right');
  assert.deepEqual([slots[1].u, slots[1].v], [.5, .5]); assertJoined(h);
  await h.composer.handleAction('undo');
  assert.deepEqual(h.composer.serialize().layers, before);
  const history = h.composer.getHistoryState();
  await h.composer.handleAction('edit-slots'); await action('add'); await action('close');
  assert.equal(editor.open, false);
  assert.deepEqual(h.composer.serialize().layers, before, 'cancel never applies a draft');
  assert.deepEqual(h.composer.getHistoryState(), history, 'cancel neither commits history nor discards redo');
  await h.composer.handleAction('redo'); assert.equal(getLayer(h, 'host').slots.length, 2); assertJoined(h);
});

test('sending assembly back to painting uses native source pixels and excludes slot markers and guides', async t => {
  const data = fixture(); data.layers[0] = { ...data.layers[0], x: 0, y: 0, w: 4, h: 4 }; data.layers[1] = { ...data.layers[1], w: 4, h: 4 };
  const h = await harness(t, data); await h.select('host');
  await h.composer.handleAction('send');
  assert.equal(h.documents.length, 1); assert.deepEqual(h.modes, ['paint']);
  const document = h.documents[0]; assert.deepEqual([document.width, document.height, document.layers.length], [8, 4, 2]);
  const expected = [[0, 0, 255, 0, 0, 255], [7, 3, 0, 0, 255, 255]];
  for (let i = 0; i < 2; i++) {
    const pixels = document.layers[i].canvas.getContext('2d').getImageData(0, 0, 8, 4).data;
    const [x, y, ...rgba] = expected[i]; assert.deepEqual([...pixels.slice((y * 8 + x) * 4, (y * 8 + x) * 4 + 4)], rgba);
    assert.equal([...pixels].filter((value, index) => index % 4 === 3 && value > 0).length, 1, 'only the one original source pixel is visible');
  }
  assertJoined(h); assert.equal(h.composer.serialize().settings.showSlots, true);
});
