import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { PaintDocument, composite } from '../dist/core.js';
import { createSlicePlan } from '../dist/slice-core.js';
import { prepareWorkspaceDocuments } from '../dist/workspace-documents.js';

const require = createRequire(import.meta.url);
const canvasPath = require.resolve('@napi-rs/canvas', {
  paths: [process.cwd(), process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES].filter(Boolean),
});
const { createCanvas, ImageData } = require(canvasPath);

// Component integration using the minimal DOM pattern in
// tile-canvas-integration.test.mjs. The actual createSlicer event handlers,
// geometry, RGBA copies, PaintDocument histories and workspace batch validator
// run unchanged on native canvases. This is not browser E2E: CSS, real browser
// layout, focus behavior and platform pointer capture are outside this harness.
const decode = value => String(value).replace(/&(quot|amp|lt|gt|#39);/g,
  (_, key) => ({ quot: '"', amp: '&', lt: '<', gt: '>', '#39': "'" }[key]));
const dataKey = name => name.slice(5).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
function matches(node, selector) {
  const tag = selector.match(/^[a-z][\w-]*/i)?.[0];
  if (tag && node.tagName !== tag.toUpperCase()) return false;
  for (const [, name] of selector.matchAll(/\.([\w-]+)/g)) {
    if (!node.className.split(/\s+/).includes(name)) return false;
  }
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
    listeners: new Map(), captures: new Set(), hidden: false, disabled: false, checked: false,
    clientWidth: 800, clientHeight: 500, _className: '', _value: '', _html: '', _text: '',
    append(...children) {
      for (const child of children) if (child && typeof child === 'object') {
        child.parentNode = this; this.children.push(child);
      }
    },
    replaceChildren(...children) {
      for (const child of this.children) child.parentNode = null;
      this.children = []; this.append(...children);
    },
    setAttribute(name, value) {
      this.attributes[name] = String(value);
      if (name.startsWith('data-')) this.dataset[dataKey(name)] = String(value);
      else if (name === 'class') this.className = value;
      else if (['hidden', 'disabled', 'checked'].includes(name)) this[name] = true;
      else this[name] = String(value);
    },
    getAttribute(name) { return this.attributes[name] ?? null; },
    addEventListener(type, handler) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(handler);
    },
    async emit(type, properties = {}) {
      const event = {
        type, target: this, currentTarget: this, button: 0, pointerId: 1,
        preventDefault() {}, stopPropagation() {}, ...properties,
      };
      for (const handler of this.listeners.get(type) || []) await handler(event);
      if (typeof this['on' + type] === 'function') await this['on' + type](event);
    },
    click() { if (!this.disabled) return this.emit('click'); },
    querySelectorAll(selector) {
      const selectors = selector.split(','), result = [];
      const visit = parent => {
        for (const child of parent.children) {
          if (selectors.some(part => descendantMatches(child, part))) result.push(child);
          visit(child);
        }
      };
      visit(this); return result;
    },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
    getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight, right: this.clientWidth, bottom: this.clientHeight }; },
    focus() {}, setPointerCapture(id) { this.captures.add(id); },
    hasPointerCapture(id) { return this.captures.has(id); }, releasePointerCapture(id) { this.captures.delete(id); },
  });
  Object.defineProperties(node, {
    className: { get() { return this._className; }, set(value) { this._className = String(value); } },
    value: { get() { return this._value; }, set(value) { this._value = String(value); } },
    textContent: {
      get() { return this._text + this.children.map(child => child.textContent).join(''); },
      set(value) { this._text = String(value); this.replaceChildren(); },
    },
    innerHTML: {
      get() { return this._html; },
      set(value) {
        this._html = String(value); this._text = ''; this.replaceChildren();
        const stack = [this];
        for (const token of this._html.matchAll(/<\/?[a-z][^>]*>|[^<]+/gi)) {
          const text = token[0];
          if (text.startsWith('</')) { if (stack.length > 1) stack.pop(); continue; }
          if (!text.startsWith('<')) { stack.at(-1)._text += decode(text); continue; }
          const tagName = text.match(/^<([\w-]+)/)[1].toLowerCase(), child = makeElement(tagName);
          const attributes = text.slice(tagName.length + 1, -1).replace(/\/$/, '');
          for (const [, name, quoted, single, bare] of attributes.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
            child.setAttribute(name, decode(quoted ?? single ?? bare ?? ''));
          }
          stack.at(-1).append(child);
          if (!voidTags.has(child.tagName) && !text.endsWith('/>')) stack.push(child);
        }
      },
    },
  });
  node.classList = {
    add(...names) { node.className = [...new Set([...node.className.split(/\s+/).filter(Boolean), ...names])].join(' '); },
    remove(...names) { node.className = node.className.split(/\s+/).filter(name => !names.includes(name)).join(' '); },
    contains(name) { return node.className.split(/\s+/).includes(name); },
    toggle(name, force) { const next = force ?? !this.contains(name); next ? this.add(name) : this.remove(name); return next; },
  };
  return node;
}

globalThis.ImageData = ImageData;
globalThis.devicePixelRatio = 1;
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
const frames = new Map();
let frameSequence = 0;
globalThis.requestAnimationFrame = callback => { const id = ++frameSequence; frames.set(id, callback); return id; };
globalThis.cancelAnimationFrame = id => frames.delete(id);
const { createSlicer } = await import('../dist/slicer.js');

async function flushFrames() {
  const pending = [...frames]; frames.clear();
  for (const [, callback] of pending) callback(performance.now());
  await Promise.resolve();
}
async function until(predicate, label) {
  const deadline = performance.now() + 3000;
  while (!predicate() && performance.now() < deadline) {
    await flushFrames(); await new Promise(setImmediate);
  }
  assert.ok(predicate(), label);
}
const pixels = canvas => canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
function sourceDocument(width = 8, height = 6, name = '像素源.png') {
  const doc = new PaintDocument({ name, width, height });
  const rgba = new Uint8ClampedArray(width * height * 4), alphas = [0, 1, 2, 17, 64, 127, 128, 192, 254, 255];
  for (let index = 0; index < width * height; index++) {
    rgba.set([(index * 47 + 13) % 256, (index * 79 + 31) % 256, (index * 37 + 109) % 256, alphas[index % alphas.length]], index * 4);
  }
  doc.activeLayer.canvas.getContext('2d').putImageData(new ImageData(rgba, width, height), 0, 0);
  doc.resetHistory('测试原图');
  return doc;
}
function inspectDocument(doc) {
  return {
    id: doc.id, name: doc.name, width: doc.width, height: doc.height, revision: doc.revision,
    dirty: doc.dirty, activeLayerId: doc.activeLayerId, historyIndex: doc.historyIndex,
    layers: doc.layers.map(layer => ({ id: layer.id, name: layer.name, visible: layer.visible, opacity: layer.opacity, pixels: [...pixels(layer.canvas)] })),
  };
}
function assertSlicePixels(sourcePixels, sourceWidth, sourceHeight, doc, rect) {
  assert.equal(doc.width, rect.w); assert.equal(doc.height, rect.h);
  const actual = pixels(doc.activeLayer.canvas);
  for (let y = 0; y < rect.h; y++) for (let x = 0; x < rect.w; x++) {
    const sourceX = rect.x + x, sourceY = rect.y + y;
    for (let channel = 0; channel < 4; channel++) {
      const expected = sourceX < sourceWidth && sourceY < sourceHeight
        ? sourcePixels[(sourceY * sourceWidth + sourceX) * 4 + channel] : 0;
      assert.equal(actual[(y * rect.w + x) * 4 + channel], expected,
        `R${rect.row + 1} C${rect.column + 1} (${x},${y}) RGBA channel ${channel}`);
    }
  }
}

async function harness(t, { width = 8, height = 6, existingCount = 1, source: suppliedSource, saved, collision = false } = {}) {
  const root = makeElement('body'), mount = makeElement('section'), document = makeElement('document'); root.append(mount);
  Object.assign(document, { body: root, createElement: makeElement, querySelector: selector => root.querySelector(selector) });
  globalThis.document = document; globalThis.window = makeElement('window');
  const source = suppliedSource || sourceDocument(width, height), docs = [source];
  for (let index = 1; index < existingCount; index++) docs.push(new PaintDocument({ name: `已有素材${index}.png`, width: 1, height: 1 }));
  if (collision) docs.push(new PaintDocument({ name: '像素源_切图_r01c01.png', width: 1, height: 1 }));
  const batches = [], messages = [], actions = [];
  let active = source, persistCount = 0, writes = 0, compositeReads = 0;
  const api = {
    getDoc: () => active, getDocs: () => docs,
    getComposite(doc) { compositeReads++; return composite(doc); },
    persist() { persistCount++; }, toast(message, error) { messages.push({ message, error }); },
    action(name) { actions.push(name); },
    addDocuments(incoming, options = {}) {
      const { entries } = prepareWorkspaceDocuments(docs, incoming);
      for (const { document, id } of entries) { document.id = id; document.dirty = true; document.isDemo = false; }
      const added = entries.map(entry => entry.document);
      // Like the app host, commit only after validating the entire batch.
      docs.push(...added); writes++;
      batches.push({ documents: added, options, lengthAfter: docs.length });
      if (options.switchTo) active = added[0];
      return added;
    },
  };
  const slicer = createSlicer(api, mount);
  if (saved !== undefined) await slicer.restore(saved);
  await slicer.activate(); await flushFrames();
  t.after(() => { slicer.deactivate(); frames.clear(); });
  const node = selector => {
    const result = mount.querySelector(selector); assert.ok(result, 'rendered control exists: ' + selector); return result;
  };
  const field = name => node(`[data-slice="${name}"]`);
  const click = async selector => { await node(selector).click(); await flushFrames(); };
  const action = name => click(`[data-slice-action="${name}"]`);
  const input = async (selector, value, event = 'change') => {
    const element = node(selector);
    if (element.type === 'checkbox') element.checked = value; else element.value = value;
    await element.emit(event); await flushFrames();
  };
  const lineInputs = axis => mount.querySelectorAll(`[data-slice-line][data-slice-axis="${axis}"]`);
  const option = (key, value) => input(`[data-slice-option="${key}"]`, value, 'input');
  return {
    slicer, root, mount, document, source, docs, batches, messages, actions, api,
    node, field, click, action, input, option, lineInputs,
    get active() { return active; }, get persistCount() { return persistCount; }, get writes() { return writes; },
    get compositeReads() { return compositeReads; },
  };
}

test('slicer starts with four real preview regions and does not alter its selected source', async t => {
  const h = await harness(t), before = inspectDocument(h.source), history = h.source.history;
  assert.equal(h.slicer.serialize().mode, 'manual');
  assert.deepEqual(h.slicer.serialize().vLines, [0.5]);
  assert.deepEqual(h.slicer.serialize().hLines, [0.5]);
  assert.equal(h.field('layout').textContent, '2 行 × 2 列');
  assert.equal(h.field('count').textContent, '4 张');
  assert.equal(h.field('frame-size').textContent, '4 × 3 px');
  assert.equal(h.mount.querySelectorAll('[data-slice-preview]').length, 4);
  assert.equal(h.node('[data-slice-action="confirm"]').disabled, false);
  assert.equal(h.field('sprite-controls').hidden, true);
  await h.click('[data-slice-preview="2"]');
  assert.match(h.field('selection').textContent, /R2 C1.*X 0 Y 3.*4 × 3/);
  assert.deepEqual(inspectDocument(h.source), before);
  assert.equal(h.source.history, history); assert.equal(h.active, h.source);
  assert.equal(h.writes, 0);
});

test('adding cuts chooses the largest gap while pixel edits and deletion target the correct line ID', async t => {
  const h = await harness(t, { width: 12, height: 8 });
  const originalV = h.lineInputs('v')[0].dataset.sliceLine, originalH = h.lineInputs('h')[0].dataset.sliceLine;
  await h.click('[data-slice-adjust="v:1"]');
  assert.deepEqual(h.slicer.serialize().vLines, [0.5, 0.25]);
  const addedV = h.lineInputs('v').find(input => input.dataset.sliceLine !== originalV).dataset.sliceLine;
  assert.notEqual(addedV, originalH);
  await h.input(`[data-slice-line="${originalV}"]`, 9);
  assert.deepEqual(h.slicer.serialize().vLines, [0.75, 0.25]);
  assert.equal(h.node(`[data-slice-line="${addedV}"]`).value, '3');
  await h.click('[data-slice-adjust="h:1"]');
  const addedH = h.lineInputs('h').find(input => input.dataset.sliceLine !== originalH).dataset.sliceLine;
  await h.input(`[data-slice-line="${addedH}"]`, 1);
  assert.deepEqual(h.slicer.serialize().hLines, [0.5, 0.125]);
  await h.click(`[data-slice-delete="${originalV}"]`);
  assert.deepEqual(h.slicer.serialize().vLines, [0.25]);
  assert.equal(h.lineInputs('v')[0].dataset.sliceLine, addedV);
  assert.deepEqual(h.slicer.serialize().hLines, [0.5, 0.125]);
  await h.click(`[data-slice-delete="${addedH}"]`);
  assert.deepEqual(h.slicer.serialize().hLines, [0.5]);
  assert.equal(h.lineInputs('h')[0].dataset.sliceLine, originalH);
  await h.input(`[data-slice-line="${addedV}"]`, 2.5);
  assert.match(h.field('error').textContent, /整数像素/);
  assert.equal(h.node('[data-slice-action="confirm"]').disabled, true);
  assert.deepEqual(h.slicer.serialize().vLines, [0.25], 'invalid edits preserve the last valid coordinate');
  await h.input(`[data-slice-line="${addedV}"]`, 2);
  assert.deepEqual(h.slicer.serialize().vLines, [1 / 6]);
  assert.equal(h.node('[data-slice-action="confirm"]').disabled, false);
});

test('coincident and edge cuts show the actual nonempty count instead of the raw line count', async t => {
  const h = await harness(t, { width: 5, height: 3 });
  await h.input('[data-slice-count="v"]', 3);
  const ids = h.lineInputs('v').map(input => input.dataset.sliceLine);
  for (const [index, value] of [0, 2, 2].entries()) await h.input(`[data-slice-line="${ids[index]}"]`, value);
  const horizontal = h.lineInputs('h')[0].dataset.sliceLine;
  await h.input(`[data-slice-line="${horizontal}"]`, 3);
  assert.equal(h.node('[data-slice-count="v"]').value, '3');
  assert.equal(h.field('layout').textContent, '1 行 × 2 列');
  assert.equal(h.field('count').textContent, '2 张');
  assert.equal(h.mount.querySelectorAll('[data-slice-preview]').length, 2);
  await h.action('clear-lines');
  assert.equal(h.field('count').textContent, '1 张');
  assert.equal(h.field('frame-size').textContent, '5 × 3 px');
  assert.equal(h.lineInputs('v').length + h.lineInputs('h').length, 0);
});

test('a 5 by 3 preview hits and drags the actual rounded 3 by 2 cut boundaries', async t => {
  const h = await harness(t, { width: 5, height: 3 }), before = inspectDocument(h.source);
  assert.deepEqual(h.lineInputs('v').map(input => input.value), ['3']);
  assert.deepEqual(h.lineInputs('h').map(input => input.value), ['2']);
  assert.match(h.node('[data-slice-preview="3"]').title, /X 3, Y 2.*2 × 1/);
  const canvas = h.field('canvas'), rect = canvas.getBoundingClientRect();
  const scale = Number.parseFloat(h.field('zoom').textContent) / 100;
  assert.equal(scale, 32, 'large preview separates the integer edge from the fractional midpoint by more than the hit tolerance');
  const origin = {
    x: 24 + (rect.width - 24 - 5 * scale) / 2,
    y: 24 + (rect.height - 24 - 3 * scale) / 2,
  };
  const point = (x, y) => ({ clientX: origin.x + x * scale, clientY: origin.y + y * scale, pointerId: 7 });
  await canvas.emit('pointerdown', point(3, 0.5));
  assert.equal(canvas.hasPointerCapture(7), true);
  await canvas.emit('pointermove', point(4, 0.5));
  await canvas.emit('pointerup', point(4, 0.5));
  await flushFrames();
  assert.deepEqual(h.slicer.serialize().vLines, [4 / 5], 'integer X=3 hits the vertical line rather than panning');
  assert.equal(canvas.hasPointerCapture(7), false);
  await canvas.emit('pointerdown', point(0.5, 2));
  await canvas.emit('pointermove', point(0.5, 1));
  await canvas.emit('pointerup', point(0.5, 1));
  await flushFrames();
  assert.deepEqual(h.slicer.serialize().hLines, [1 / 3], 'integer Y=2 hits the horizontal line rather than panning');
  assert.deepEqual(h.lineInputs('v').map(input => input.value), ['4']);
  assert.deepEqual(h.lineInputs('h').map(input => input.value), ['1']);
  assert.deepEqual(inspectDocument(h.source), before);
});

test('sprite controls reject unequal integer frames, transparent padding repairs the plan, and manual settings survive', async t => {
  const h = await harness(t, { width: 7, height: 5 });
  await h.input(`[data-slice-line="${h.lineInputs('v')[0].dataset.sliceLine}"]`, 2);
  await h.input(`[data-slice-line="${h.lineInputs('h')[0].dataset.sliceLine}"]`, 1);
  const manual = h.slicer.serialize();
  await h.click('[data-slice-mode="sprite"]');
  await h.option('rows', 2); await h.option('columns', 3);
  assert.match(h.field('error').textContent, /不能被.*整除/);
  assert.equal(h.node('[data-slice-action="confirm"]').disabled, true);
  assert.equal(h.mount.querySelectorAll('[data-slice-preview]').length, 0);
  await h.input('[data-slice="pad-frames"]', true);
  assert.equal(h.field('error').hidden, true);
  assert.equal(h.field('count').textContent, '6 张');
  assert.equal(h.field('frame-size').textContent, '3 × 3 px');
  assert.match(h.field('frame-info').textContent, /右侧 \+2 px.*底部 \+1 px/s);
  assert.match(h.field('frame-info').textContent, /补齐画布 9 × 6 px/);
  await h.click('[data-slice-mode="manual"]');
  assert.deepEqual(h.slicer.serialize().vLines, manual.vLines);
  assert.deepEqual(h.slicer.serialize().hLines, manual.hLines);
  assert.equal(h.field('count').textContent, '4 张');
  await h.click('[data-slice-mode="sprite"]');
  assert.deepEqual([h.slicer.serialize().rows, h.slicer.serialize().columns, h.slicer.serialize().padFrames], [2, 3, true]);
  await h.option('columns', 8);
  assert.match(h.field('error').textContent, /不能超过源图/);
  await h.option('rows', '');
  assert.equal(h.node('[data-slice-action="confirm"]').disabled, true);
  await h.click('[data-slice-mode="manual"]');
  assert.equal(h.field('error').hidden, true, 'an invalid inactive sprite draft cannot block free cuts');
  assert.equal(h.node('[data-slice-action="confirm"]').disabled, false);
});

test('confirm adds one complete batch with exact RGBA, unique names, independent history, and unchanged source selection', async t => {
  const h = await harness(t, { collision: true });
  const sourceBefore = inspectDocument(h.source), sourceHistory = h.source.history, existing = [...h.docs];
  const expectedComposite = composite(h.source), expected = pixels(expectedComposite).slice();
  const plan = createSlicePlan(h.source.width, h.source.height, { vLines: [0.5], hLines: [0.5] });
  await h.action('confirm');
  assert.equal(h.writes, 1); assert.equal(h.batches.length, 1);
  const { documents, options } = h.batches[0];
  assert.deepEqual(options, { switchTo: false });
  assert.equal(documents.length, 4); assert.equal(h.docs.length, existing.length + 4);
  assert.deepEqual(h.docs.slice(0, existing.length), existing);
  assert.equal(h.active, h.source); assert.deepEqual(inspectDocument(h.source), sourceBefore);
  assert.equal(h.source.history, sourceHistory);
  assert.equal(documents[0].name, '像素源_切图_r01c01 (2).png');
  assert.equal(new Set(h.docs.map(doc => doc.name)).size, h.docs.length);
  assert.equal(new Set(h.docs.map(doc => doc.id)).size, h.docs.length);
  for (const [index, doc] of documents.entries()) {
    assertSlicePixels(expected, h.source.width, h.source.height, doc, plan.rects[index]);
    assert.equal(doc.dirty, true); assert.equal(doc.history.length, 1); assert.equal(doc.canUndo, false);
    assert.notEqual(doc.history, sourceHistory);
  }
  assert.ok(expected.filter((_, index) => index % 4 === 3).includes(1), 'real source contains alpha 1');
  assert.match(h.field('report').textContent, /已将 4 张新素材加入/);
  assert.equal(h.slicer.isBusy(), false);
});

test('sprite confirmation creates equal frames with true transparent right and bottom extensions', async t => {
  const h = await harness(t, { width: 5, height: 3 }), before = inspectDocument(h.source);
  const expected = pixels(composite(h.source)).slice();
  await h.click('[data-slice-mode="sprite"]');
  await h.option('rows', 2); await h.option('columns', 4);
  await h.input('[data-slice="pad-frames"]', true);
  const plan = createSlicePlan(5, 3, { mode: 'sprite', rows: 2, columns: 4, padFrames: true });
  await h.action('confirm');
  assert.equal(h.writes, 1); assert.equal(h.batches[0].documents.length, 8);
  h.batches[0].documents.forEach((doc, index) => assertSlicePixels(expected, 5, 3, doc, plan.rects[index]));
  assert.ok(pixels(h.batches[0].documents[7].activeLayer.canvas).every(value => value === 0));
  assert.equal(h.batches[0].documents[7].name, '像素源_帧_008_r02c04.png');
  assert.deepEqual(inspectDocument(h.source), before); assert.equal(h.active, h.source);
});

test('a busy build locks edits and cancellation leaves no partial workspace documents', async t => {
  const h = await harness(t), before = inspectDocument(h.source), settings = h.slicer.serialize();
  const pending = h.action('confirm');
  await until(() => h.slicer.isBusy() && Number(h.field('progress').value) >= 1, 'at least one real frame is built');
  assert.equal(h.writes, 0); assert.equal(h.docs.length, 1);
  assert.equal(h.node('[data-slice-action="confirm"]').disabled, true);
  assert.equal(h.node('[data-slice-action="cancel"]').hidden, false);
  assert.equal(h.node('[data-slice-adjust="v:1"]').disabled, true);
  await h.slicer.handleAction('clear-lines');
  assert.deepEqual(h.slicer.serialize(), settings);
  await h.action('cancel'); await pending;
  assert.equal(h.slicer.isBusy(), false); assert.equal(h.writes, 0); assert.equal(h.batches.length, 0);
  assert.equal(h.docs.length, 1); assert.equal(h.active, h.source);
  assert.deepEqual(inspectDocument(h.source), before);
  assert.match(h.field('report').textContent, /已取消.*未添加/);
});

test('source revisions are re-read before confirmation and reject a changed source during a build', async t => {
  const h = await harness(t);
  h.source.revision++;
  await h.slicer.handleAction('confirm'); await flushFrames();
  assert.equal(h.writes, 0); assert.equal(h.slicer.isBusy(), false);
  assert.match(h.field('report').textContent, /来源已更新.*再次确认/);
  const pending = h.action('confirm');
  await until(() => h.slicer.isBusy() && Number(h.field('progress').value) >= 1, 'source-change test enters a real build');
  h.source.revision++;
  await pending;
  assert.equal(h.writes, 0); assert.equal(h.docs.length, 1); assert.equal(h.active, h.source);
  assert.ok(h.messages.some(message => message.error && /源素材已发生变化/.test(message.message)));
  assert.equal(h.slicer.isBusy(), false);
  const cancelled = h.action('confirm');
  await until(() => h.slicer.isBusy() && Number(h.field('progress').value) >= 1, 'refresh test enters a real build');
  h.source.revision++; h.slicer.refresh();
  await cancelled;
  assert.equal(h.writes, 0); assert.equal(h.docs.length, 1); assert.equal(h.slicer.isBusy(), false);
});

test('a full 100-document workspace rejects confirmation before generating or committing any new assets', async t => {
  const h = await harness(t, { existingCount: 100 }), existing = [...h.docs], before = inspectDocument(h.source);
  assert.equal(h.field('workspace-count').textContent, '100 / 100');
  assert.match(h.field('error').textContent, /还可加入 0 张/);
  assert.equal(h.node('[data-slice-action="confirm"]').disabled, true);
  await h.slicer.handleAction('confirm');
  assert.equal(h.slicer.isBusy(), false); assert.equal(h.writes, 0);
  assert.deepEqual(h.docs, existing); assert.deepEqual(inspectDocument(h.source), before);
});

test('serialized slicing settings restore both modes and exact cut fractions without aliasing live state', async t => {
  const h = await harness(t, { width: 9, height: 7 });
  await h.input(`[data-slice-line="${h.lineInputs('v')[0].dataset.sliceLine}"]`, 2);
  await h.input('[data-slice-count="h"]', 2);
  await h.click('[data-slice-even="h"]');
  await h.input('[data-slice="snap"]', false);
  await h.click('[data-slice-mode="sprite"]');
  await h.option('rows', 2); await h.option('columns', 4);
  await h.input('[data-slice="pad-frames"]', true);
  const saved = h.slicer.serialize(), roundTrip = structuredClone(saved);
  assert.deepEqual(saved, {
    version: 1, mode: 'sprite', sourceId: h.source.id, vLines: [2 / 9], hLines: [1 / 3, 2 / 3],
    rows: 2, columns: 4, padFrames: true, snap: false,
  });
  saved.vLines[0] = 1; saved.hLines.length = 0;
  assert.deepEqual(h.slicer.serialize(), roundTrip);
  h.slicer.deactivate();
  const restored = await harness(t, { source: h.source, saved: roundTrip });
  assert.deepEqual(restored.slicer.serialize(), roundTrip);
  assert.equal(restored.field('count').textContent, '8 张');
  assert.equal(restored.field('frame-size').textContent, '3 × 4 px');
  assert.equal(restored.field('snap').checked, false);
  await restored.click('[data-slice-mode="manual"]');
  assert.deepEqual(restored.slicer.serialize().vLines, [2 / 9]);
  assert.deepEqual(restored.slicer.serialize().hLines, [1 / 3, 2 / 3]);
  assert.equal(restored.field('count').textContent, '6 张');
  assert.deepEqual(restored.lineInputs('h').map(input => input.value), ['2', '5']);
});

test('deactivation preserves source identity and cut settings while reactivation captures fresh source pixels', async t => {
  const h = await harness(t);
  await h.input(`[data-slice-line="${h.lineInputs('v')[0].dataset.sliceLine}"]`, 2);
  await h.input(`[data-slice-line="${h.lineInputs('h')[0].dataset.sliceLine}"]`, 1);
  const saved = h.slicer.serialize(), previousReads = h.compositeReads;
  h.slicer.deactivate();
  assert.deepEqual(h.slicer.serialize(), saved, 'releasing the snapshot retains savedSourceId and cut fractions');
  // Change native pixels while inactive without a revision bump to prove that
  // activation reads a new snapshot rather than reusing the released one.
  const context = h.source.activeLayer.canvas.getContext('2d');
  context.fillStyle = '#35c8f0'; context.fillRect(0, 0, h.source.width, h.source.height);
  const expected = pixels(composite(h.source)).slice();
  await h.slicer.activate(); await flushFrames();
  assert.equal(h.compositeReads, previousReads + 1);
  assert.deepEqual(h.slicer.serialize(), saved);
  assert.equal(h.field('count').textContent, '4 张');
  assert.equal(h.node('[data-slice-action="confirm"]').disabled, false);
  await h.action('confirm');
  const plan = createSlicePlan(8, 6, { vLines: saved.vLines, hLines: saved.hLines });
  h.batches[0].documents.forEach((doc, index) => assertSlicePixels(expected, 8, 6, doc, plan.rects[index]));
  assert.equal(h.active, h.source);
});
