import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createCanvas, ImageData } = require(require.resolve('@napi-rs/canvas', {
  paths: [process.cwd(), process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES].filter(Boolean),
}));

// Component integration only: selectors, event dispatch and pointer capture are
// a small DOM adapter. Raster copying and document/history use the real code.
// This cannot verify browser layout, native focus or real pointer delivery.
function element(tag = 'div', data = {}) {
  const listeners = new Map(), children = new Map(), node = tag === 'canvas' ? createCanvas(256, 144) : {};
  let value = '';
  Object.assign(node, {
    tagName: tag, dataset: data, style: {}, hidden: false, checked: false, disabled: false, open: false,
    addEventListener(type, callback) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(callback); },
    emit(type, event = {}) { for (const callback of listeners.get(type) || []) callback({ type, target: this, preventDefault() {}, ...event }); },
    setAttribute() {}, append() {}, showModal() { this.open = true; }, close() { this.open = false; },
    closest(selector) { return selector === 'button' ? tag === 'button' ? this : null : selector === '[data-capture]' ? data.capture ? this : null : selector === '[data-preview]' && data.preview ? this : null; },
    querySelector(selector) { if (!children.has(selector)) throw Error(`Unhandled test selector: ${selector}`); return children.get(selector); },
    register(selector, child) { children.set(selector, child); return child; },
  });
  Object.defineProperty(node, 'value', { get: () => value, set: next => { value = String(next); } });
  if (tag === 'dialog') { node.register('canvas', element('canvas')); node.register('.capture-preview-meta', element()); }
  return node;
}

globalThis.ImageData = ImageData;
globalThis.document = { createElement: element, body: element('body') };
const { PaintDocument, composite } = await import('../dist/core.js');
const { createRegionCapture } = await import('../dist/region-capture.js');
const pixels = canvas => [...canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data];

function harness() {
  const frames = new Map(); let frameId = 0;
  globalThis.requestAnimationFrame = callback => { const id = ++frameId; frames.set(id, callback); return id; };
  globalThis.window = element('window');
  const host = element('section'), board = element('canvas'), captures = new Set(), dialogs = [];
  document.body.append = node => dialogs.push(node);
  document.activeElement = null;
  const fields = ['x', 'y', 'w', 'h'].map(key => host.register(`#capture-${key}`, element('input', { coordinate: key })));
  const actionButtons = new Map();
  host.querySelectorAll = selector => {
    if (selector === '[data-coordinate]') return fields;
    if (actionButtons.has(selector)) return actionButtons.get(selector);
    throw Error(`Unhandled test selector: ${selector}`);
  };
  for (const id of ['name', 'open', 'note', 'preview-label']) host.register(`#capture-${id}`, element(id === 'name' || id === 'open' ? 'input' : 'span'));
  for (const action of ['save', 'all', 'reset', 'preview', 'exit', 'open-last']) {
    const selector = `[data-capture="${action}"]`, button = host.register(selector, element('button', { capture: action }));
    actionButtons.set(selector, action === 'preview' ? [button, element('button', { capture: action })] : [button]);
  }
  host.register('.capture-result', element()); host.register('.capture-result span', element('span'));
  host.register('.capture-preview canvas', element('canvas'));
  board.setPointerCapture = id => captures.add(id);
  board.hasPointerCapture = id => captures.has(id);
  board.releasePointerCapture = id => { if (captures.delete(id)) board.emit('lostpointercapture', { pointerId: id }); };
  const original = new PaintDocument({ name: '素材.png', width: 12, height: 9 });
  const rgba = new Uint8ClampedArray(12 * 9 * 4);
  for (let i = 0; i < rgba.length / 4; i++) rgba.set([(i * 31) % 256, (i * 7) % 256, 210, [0, 1, 128, 255][i % 4]], i * 4);
  original.activeLayer.canvas.getContext('2d').putImageData(new ImageData(rgba, 12, 9), 0, 0);
  original.activeLayer.locked = true; original.resetHistory('来源');
  const documents = [original], state = { tool: 'capture', mode: 'paint', showRulers: true, selection: null }, messages = [], revealed = [];
  const view = { x: 42, y: 60, z: 12 }; let current = original, tool, failAdd = false, clipboard = null;
  const api = {
    board, viewport: { clientWidth: 800, clientHeight: 500 }, getDoc: () => current, getDocs: () => documents, getState: () => state,
    getComposite: () => composite(current), getView: () => view, requestRender() {}, renderSelectionStatus() {},
    toast: (message, error) => messages.push({ message, error }), revealAsset: result => revealed.push(result),
    setClipboard: canvas => { clipboard = canvas; },
    addDocument(result, { switchTo }) {
      if (failAdd) throw Error('工作区容量已满');
      documents.push(result); if (switchTo) current = result;
      tool.refresh(); // Real addDocument calls renderUI before returning.
      return result;
    },
    setTool(name) { if (state.tool === 'capture' && name !== 'capture') tool.cancel(); state.tool = name; tool.refresh(); },
    switchDoc(id) { current = documents.find(item => item.id === id); tool.refresh(); },
  };
  tool = createRegionCapture(api, host); tool.activate();
  const point = (x, y) => ({ x, y, sx: view.x + x * view.z, sy: view.y + y * view.z });
  const event = { pointerId: 7, button: 0 };
  return {
    tool, host, board, state, original, documents, messages, revealed, captures, dialogs, api,
    current: () => current, clipboard: () => clipboard, failAdd: value => { failAdd = value; },
    click(action) { host.emit('click', { target: host.querySelector(`[data-capture="${action}"]`) }); },
    change(key, value) { const input = host.querySelector(`#capture-${key}`); input.value = value; host.emit('change', { target: input }); },
    input(key, value) { const input = host.querySelector(`#capture-${key}`); document.activeElement = input; input.value = value; host.emit('input', { target: input }); },
    down(x, y) { board.setPointerCapture(event.pointerId); tool.pointerDown(event, point(x, y)); },
    move(x, y) { tool.pointerMove(event, point(x, y)); },
    up(x, y) { tool.pointerUp(event, point(x, y)); },
    key(key, extra = {}) { const e = { key, target: board, preventDefault() { this.prevented = true; }, ...extra }; return { handled: tool.handleKey(e), event: e }; },
    flushPreview() { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(); },
  };
}

test('drag through save retains the source and creates independent correctly-sized pixels on each save', () => {
  const h = harness(), before = pixels(h.original.activeLayer.canvas), history = h.original.history;
  h.down(2, 2); h.move(7, 6);
  assert.equal(h.host.querySelector('[data-capture="save"]').disabled, true);
  h.up(7, 6);
  assert.equal(h.captures.size, 0, 'releasing capture must not roll back the completed rectangle');
  assert.deepEqual(h.tool.getRect(), { x: 2, y: 2, w: 5, h: 4 });
  h.flushPreview(); h.click('save');
  assert.equal(h.documents.length, 2);
  assert.equal(h.current(), h.original);
  const saved = h.documents[1], source = composite(h.original);
  assert.deepEqual([saved.width, saved.height, saved.name], [5, 4, '素材_截图_01.png']);
  assert.deepEqual(pixels(saved.activeLayer.canvas), [...source.getContext('2d').getImageData(2, 2, 5, 4).data]);
  assert.equal(h.revealed[0], saved);
  h.key('Enter', { repeat: true }); assert.equal(h.documents.length, 2);
  h.key('Enter'); assert.equal(h.documents[2].name, '素材_截图_02.png');
  assert.equal(h.state.selection, null);
  assert.deepEqual(pixels(h.original.activeLayer.canvas), before);
  assert.equal(h.original.history, history); assert.equal(h.original.revision, 0); assert.equal(h.original.dirty, false);
});

test('failed save leaves the rectangle and original intact; save-after-open uses the selected crop before refreshing', () => {
  const h = harness(); h.tool.activate({ x: 3, y: 2, w: 4, h: 3 });
  h.failAdd(true); h.click('save');
  assert.equal(h.documents.length, 1); assert.equal(h.revealed.length, 0);
  assert.equal(h.messages.at(-1).error, true);
  assert.deepEqual(h.tool.getRect(), { x: 3, y: 2, w: 4, h: 3 });
  h.failAdd(false); h.host.querySelector('#capture-open').checked = true;
  h.change('name', '部件.webp'); h.click('save');
  assert.equal(h.documents.length, 2); assert.equal(h.current(), h.documents[1]);
  assert.equal(h.current().name, '部件.png'); assert.equal(h.current().width, 4); assert.equal(h.current().height, 3);
  assert.equal(h.state.tool, 'select'); assert.equal(h.tool.getRect(), null); assert.equal(h.host.hidden, true);
});

test('lost capture and Escape restore the prior rectangle; empty Delete cannot erase the source', () => {
  const h = harness(), before = pixels(h.original.activeLayer.canvas), initial = { x: 2, y: 2, w: 6, h: 4 };
  h.tool.activate(initial); h.down(5, 4); h.move(10, 8);
  h.board.releasePointerCapture(7);
  assert.deepEqual(h.tool.getRect(), initial);
  h.down(2, 2); h.move(0, 0); const cancelled = h.key('Escape');
  assert.equal(cancelled.handled, true); assert.deepEqual(h.tool.getRect(), initial); assert.equal(h.captures.size, 0);
  h.click('reset'); assert.equal(h.tool.getRect(), null);
  for (const key of ['Delete', 'Backspace']) { const result = h.key(key); assert.equal(result.handled, true); assert.equal(result.event.prevented, true); }
  h.down(1, 1); h.move(3, 3); window.emit('blur'); assert.equal(h.tool.getRect(), null);
  assert.deepEqual(pixels(h.original.activeLayer.canvas), before); assert.equal(h.original.history.length, 1);
});

test('manual coordinates, pixel nudges and source changes keep the region bounded and reset stale selections', () => {
  const h = harness(); h.tool.activate({ x: 2, y: 2, w: 5, h: 4 });
  h.change('x', 99); assert.deepEqual(h.tool.getRect(), { x: 7, y: 2, w: 5, h: 4 });
  h.change('y', -99); h.change('w', 99); h.change('h', 2.7);
  assert.deepEqual(h.tool.getRect(), { x: 7, y: 0, w: 5, h: 3 });
  h.change('h', ''); assert.equal(h.tool.getRect().h, 3);
  h.key('ArrowLeft', { shiftKey: true }); h.key('ArrowDown');
  assert.deepEqual(h.tool.getRect(), { x: 0, y: 1, w: 5, h: 3 });
  h.down(2, 2); h.move(5, 4);
  const next = new PaintDocument({ width: 3, height: 2 }); h.documents.push(next); h.api.switchDoc(next.id);
  assert.equal(h.tool.getRect(), null); assert.equal(h.captures.size, 0);
  assert.equal(h.host.querySelector('[data-capture="save"]').disabled, true);
  h.click('all'); assert.deepEqual(h.tool.getRect(), { x: 0, y: 0, w: 3, h: 2 });
  assert.equal(h.tool.handleAction('cut'), true); assert.equal(h.clipboard().width, 3); assert.equal(next.history.length, 1);
});

test('input events update saved pixels before blur, while incomplete input preserves the region and both preview controls stay synchronized', () => {
  const h = harness(), previews = h.host.querySelectorAll('[data-capture="preview"]');
  assert.equal(previews.length, 2); assert.ok(previews.every(button => button.disabled));
  h.down(2, 2); h.move(6, 5); assert.ok(previews.every(button => button.disabled));
  h.up(6, 5); assert.ok(previews.every(button => !button.disabled));
  h.input('w', '5.6');
  assert.equal(h.tool.getRect().w, 6);
  assert.equal(h.host.querySelector('#capture-w').value, '5.6', 'a focused field keeps the unfinished user input');
  h.input('h', '2');
  h.click('save'); // Deliberately no change or blur event before clicking save.
  const result = h.documents[1];
  assert.deepEqual([result.width, result.height], [6, 2]);
  assert.deepEqual(pixels(result.activeLayer.canvas), [...composite(h.original).getContext('2d').getImageData(2, 2, 6, 2).data]);
  h.input('w', '');
  assert.equal(h.tool.getRect().w, 6); assert.equal(h.host.querySelector('#capture-w').value, '');
  h.click('save'); assert.equal(h.documents[2].width, 6, 'clearing a field mid-edit does not replace the selection with one pixel');
  h.change('w', ''); assert.equal(h.host.querySelector('#capture-w').value, '6', 'change normalizes the empty field back to the retained value');
  h.click('reset'); assert.ok(previews.every(button => button.disabled));
});
