import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { LIQUID_APPEARANCE_KEY, readLiquidAppearance, resolveLiquidAppearance, installLiquidGlass } from '../dist/liquid-glass.js';

// Runs the real preference/interaction controller with deterministic DOM events
// and animation clocks. This is not browser layout, rendering or optical QA.
function eventTarget() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener(name, callback, options) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push({ callback, capture: options === true || options?.capture === true });
    },
    removeEventListener(name, callback) { listeners.set(name, (listeners.get(name) || []).filter(item => item.callback !== callback)); },
    emit(name, event = {}) { for (const { callback } of [...listeners.get(name) || []]) callback(event); },
  };
}
function matches(el, selector) {
  if (selector.startsWith('#')) return el.id === selector.slice(1);
  if (selector.startsWith('.')) return el.className.split(/\s+/).includes(selector.slice(1));
  const attribute = selector.match(/^(?:([a-z]+))?\[([^=\]]+)(?:="([^"]+)")?\]$/);
  if (attribute) {
    const [, tag, key, value] = attribute;
    if (tag && el.tagName !== tag.toUpperCase()) return false;
    const actual = key.startsWith('data-') ? el.dataset[key.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] : el.attributes[key];
    return actual !== undefined && (value === undefined || actual === value);
  }
  return el.tagName === selector.toUpperCase();
}
function harness({ theme = 'system', simpleEffects = false, dark = false, cores = 8, storageDenied = false } = {}) {
  const data = new Map([[LIQUID_APPEARANCE_KEY, JSON.stringify({ theme, simpleEffects })]]);
  const storage = {
    getItem: key => { if (storageDenied) throw new Error('denied'); return data.get(key) ?? null; },
    setItem: (key, value) => { if (storageDenied) throw new Error('denied'); data.set(key, value); },
  };
  let clock = 0, frameSequence = 0;
  const frames = new Map(), nodes = [], queries = new Map();
  const doc = Object.assign(eventTarget(), { hidden: false, activeElement: null });
  function element(tag = 'div', { id = '', className = '', dataset = {}, parent = null, hidden = false } = {}) {
    const properties = new Map();
    const el = Object.assign(eventTarget(), {
      tagName: tag.toUpperCase(), id, className, dataset: { ...dataset }, attributes: {}, hidden, parentElement: parent,
      children: [], textContent: '', checked: false, tabIndex: 0, isConnected: true, scrollTop: 0, scrollLeft: 0,
      scrollHeight: 1000, clientHeight: 200,
      style: { setProperty: (key, value) => properties.set(key, value), removeProperty: key => properties.delete(key), getPropertyValue: key => properties.get(key) || '' },
      matches(selector) { return selector.split(',').some(s => matches(this, s.trim())); },
      closest(selector) { let node = this; while (node) { if (node.matches(selector)) return node; node = node.parentElement; } return null; },
      contains(target) { let node = target; while (node) { if (node === this) return true; node = node.parentElement; } return false; },
      setAttribute(key, value) { this.attributes[key] = String(value); },
      getAttribute(key) { return this.attributes[key] ?? null; },
      focus() { doc.activeElement = this; dispatch(this, 'focusin'); },
      getBoundingClientRect() { return { left: 10, top: 20, width: 200, height: 100 }; },
      click() { return dispatch(this, 'click'); },
    });
    parent?.children.push(el); nodes.push(el); return el;
  }
  const root = element('html'), body = element('body', { parent: root }); doc.documentElement = root; doc.body = body; doc.activeElement = body;
  const topbar = element('header', { className: 'topbar', dataset: { lgLight: '' }, parent: body });
  const toggle = element('button', { id: 'lg-appearance-toggle', parent: topbar });
  const panel = element('div', { id: 'lg-appearance-panel', parent: body, hidden: true });
  const choices = ['system', 'light', 'dark'].map(theme => element('button', { dataset: { lgThemeChoice: theme }, parent: panel }));
  const simple = element('input', { id: 'lg-simple-effects', parent: panel });
  const status = element('p', { id: 'lg-appearance-status', parent: panel });
  const meta = element('meta'); meta.attributes.name = 'theme-color';
  const settings = element('aside', { className: 'slice-settings', parent: body });
  const modeTabs = element('nav', { className: 'mode-tabs', parent: body });
  const canvas = element('canvas', { parent: body });
  doc.querySelector = selector => nodes.find(node => node.matches(selector)) || null;
  doc.querySelectorAll = selector => nodes.filter(node => node.matches(selector));
  const win = Object.assign(eventTarget(), {
    document: doc, localStorage: storage, navigator: { hardwareConcurrency: cores, connection: Object.assign(eventTarget(), { saveData: false }) },
    performance: { now: () => clock },
    requestAnimationFrame: callback => { const id = ++frameSequence; frames.set(id, callback); return id; },
    cancelAnimationFrame: id => frames.delete(id),
    matchMedia(query) {
      if (!queries.has(query)) queries.set(query, Object.assign(eventTarget(), { matches: query.includes('pointer: fine') || query.includes('color-scheme: dark') && dark }));
      return queries.get(query);
    },
  });
  function dispatch(target, name, props = {}) {
    const event = {
      target, relatedTarget: null, buttons: 0, clientX: 80, clientY: 60,
      defaultPrevented: false, stopped: false, immediate: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.stopped = true; },
      stopImmediatePropagation() { this.stopped = this.immediate = true; },
      ...props,
    };
    const path = []; let node = target;
    while (node) { path.push(node); node = node.parentElement; }
    path.push(doc, win);
    const run = (item, capture) => {
      for (const { callback } of [...item.listeners.get(name) || []].filter(item => item.capture === capture)) {
        callback(event); if (event.immediate) break;
      }
    };
    for (const item of [...path].reverse()) { run(item, true); if (event.stopped) return event; }
    for (const item of path) { run(item, false); if (event.stopped) return event; }
    return event;
  }
  function tick(milliseconds = 16) {
    clock += milliseconds;
    const pending = [...frames]; frames.clear();
    for (const [, callback] of pending) callback(clock);
  }
  function changeMedia(query, matches) { const matcher = win.matchMedia(query); matcher.matches = matches; matcher.emit('change', { matches }); }
  return { win, doc, root, topbar, toggle, panel, choices, simple, status, meta, settings, modeTabs, canvas, dispatch, tick, changeMedia, frames, data, storage, element };
}

test('bootstrap and controller agree on saved appearance before styles load, including reduced modes', async () => {
  const code = await readFile(new URL('../dist/liquid-theme-init.js', import.meta.url), 'utf8');
  for (const theme of ['system', 'light', 'dark']) {
    const h = harness({ theme, dark: true, simpleEffects: theme === 'light' });
    vm.runInNewContext(code, { document: h.doc, window: h.win, localStorage: h.storage, navigator: h.win.navigator });
    const firstFrame = { ...h.root.dataset };
    const controller = installLiquidGlass(h.win);
    assert.deepEqual(h.root.dataset, firstFrame);
    assert.equal(h.root.dataset.lgTheme, theme === 'light' ? 'light' : 'dark');
    controller.destroy();
  }
  assert.deepEqual(readLiquidAppearance({ getItem() { throw new Error('denied'); } }), { theme: 'system', simpleEffects: false });
  assert.deepEqual(readLiquidAppearance({ getItem: () => '{"theme":"invalid","simpleEffects":"false"}' }), { theme: 'system', simpleEffects: false });
});

test('system theme follows OS changes while an explicit choice stays fixed and persists separately', () => {
  const h = harness(), controller = installLiquidGlass(h.win);
  assert.equal(h.root.dataset.lgTheme, 'light');
  h.changeMedia('(prefers-color-scheme: dark)', true);
  assert.equal(h.root.dataset.lgTheme, 'dark');
  assert.equal(h.meta.attributes.content, '#101722');
  controller.setPreference('light');
  h.changeMedia('(prefers-color-scheme: dark)', false); h.changeMedia('(prefers-color-scheme: dark)', true);
  assert.equal(h.root.dataset.lgTheme, 'light');
  assert.equal(h.meta.attributes.content, '#edf2f8');
  assert.deepEqual(JSON.parse(h.data.get(LIQUID_APPEARANCE_KEY)), { theme: 'light', simpleEffects: false });
  assert.equal(h.choices[1].getAttribute('aria-checked'), 'true');
  assert.equal(h.choices[1].tabIndex, 0);
  controller.setPreference('system'); assert.equal(h.root.dataset.lgTheme, 'dark');
  controller.destroy();
});

test('accessibility preferences take priority over user glass settings and low power uses lite material', () => {
  const h = harness(), controller = installLiquidGlass(h.win);
  h.changeMedia('(prefers-reduced-transparency: reduce)', true);
  assert.equal(controller.getState().material, 'solid');
  controller.setSimpleEffects(false); assert.equal(controller.getState().material, 'solid');
  h.changeMedia('(prefers-reduced-transparency: reduce)', false);
  h.changeMedia('(prefers-reduced-motion: reduce)', true);
  assert.equal(controller.getState().motion, 'reduced'); assert.equal(h.root.dataset.lgChrome, 'expanded');
  h.changeMedia('(prefers-contrast: more)', true);
  assert.equal(controller.getState().contrast, 'more'); assert.equal(controller.getState().material, 'solid');
  h.changeMedia('(prefers-contrast: more)', false); h.changeMedia('(forced-colors: active)', true);
  assert.equal(controller.getState().contrast, 'more');
  h.changeMedia('(forced-colors: active)', false); h.changeMedia('(prefers-reduced-motion: reduce)', false);
  controller.setSimpleEffects(true);
  assert.deepEqual({ material: controller.getState().material, motion: controller.getState().motion, quality: controller.getState().quality }, { material: 'solid', motion: 'reduced', quality: 'lite' });
  controller.destroy();
  const low = harness({ cores: 4 }), lowController = installLiquidGlass(low.win);
  assert.equal(lowController.getState().quality, 'lite');
  low.dispatch(low.topbar, 'pointermove'); assert.equal(low.frames.size, 0);
  lowController.destroy();
});

test('appearance keyboard capture shields painting shortcuts while preserving native button activation', () => {
  const h = harness(), controller = installLiquidGlass(h.win); let paintKeys = 0;
  h.doc.addEventListener('keydown', () => paintKeys++);
  for (const key of [' ', 'Enter', 'b', 'ArrowLeft']) {
    const event = h.dispatch(h.toggle, 'keydown', { key, code: key === ' ' ? 'Space' : key });
    assert.equal(event.stopped, true); assert.equal(event.defaultPrevented, false);
  }
  assert.equal(paintKeys, 0);
  h.toggle.click(); assert.equal(h.panel.hidden, false); assert.equal(h.doc.activeElement, h.choices[0]);
  const next = h.dispatch(h.choices[0], 'keydown', { key: 'ArrowRight' });
  assert.equal(next.defaultPrevented, true); assert.equal(controller.getState().preference, 'light'); assert.equal(h.doc.activeElement, h.choices[1]);
  const escape = h.dispatch(h.choices[1], 'keydown', { key: 'Escape' });
  assert.equal(escape.stopped, true); assert.equal(escape.defaultPrevented, true); assert.equal(h.panel.hidden, true); assert.equal(h.doc.activeElement, h.toggle);
  assert.equal(paintKeys, 0);
  h.dispatch(h.canvas, 'keydown', { key: 'b' }); assert.equal(paintKeys, 1, 'unrelated canvas keys still reach Paint');
  controller.destroy();
});

test('outside clicks and focus close appearance without taking focus away from the work surface', () => {
  const h = harness(), controller = installLiquidGlass(h.win);
  h.toggle.click(); h.canvas.focus(); assert.equal(h.panel.hidden, true); assert.equal(h.doc.activeElement, h.canvas);
  h.toggle.click(); h.dispatch(h.canvas, 'pointerdown'); assert.equal(h.panel.hidden, true, 'a drawing drag closes appearance before any canvas keyboard action');
  h.toggle.click(); h.doc.activeElement = h.canvas; h.canvas.click();
  assert.equal(h.panel.hidden, true); assert.equal(h.doc.activeElement, h.canvas);
  h.toggle.click(); h.simple.checked = true; h.dispatch(h.simple, 'change');
  assert.equal(controller.getState().material, 'solid'); assert.equal(h.panel.hidden, false);
  controller.destroy();
});

test('directional highlights are frame-throttled, never inspect canvas and stop after leaving a control', () => {
  const h = harness(), controller = installLiquidGlass(h.win);
  for (let i = 0; i < 10; i++) h.dispatch(h.topbar, 'pointermove', { clientX: 20 + i * 10, clientY: 45 });
  assert.equal(h.frames.size, 2, 'one highlight frame plus one bounded performance sample');
  h.tick();
  assert.equal(h.topbar.style.getPropertyValue('--lg-light-x'), '50.00%');
  assert.equal(h.topbar.style.getPropertyValue('--lg-light-y'), '25.00%');
  h.dispatch(h.canvas, 'pointermove');
  assert.equal(h.topbar.style.getPropertyValue('--lg-light-x'), '');
  for (let i = 0; i < 20; i++) h.tick();
  assert.equal(h.frames.size, 0, 'no animation loop remains when interaction stops');
  h.dispatch(h.topbar, 'pointermove', { buttons: 1 }); assert.equal(h.frames.size, 0);
  h.dispatch(h.topbar, 'pointermove'); h.tick(); h.dispatch(h.topbar, 'pointerout');
  assert.equal(h.topbar.style.getPropertyValue('--lg-light-x'), '');
  h.changeMedia('(prefers-reduced-motion: reduce)', true);
  assert.equal(h.frames.size, 0); h.dispatch(h.topbar, 'pointermove'); assert.equal(h.frames.size, 0);
  controller.destroy();
});

test('vertical settings scroll uses hysteresis and respects reduced motion, chrome focus and horizontal tabs', () => {
  const h = harness(), controller = installLiquidGlass(h.win);
  h.settings.scrollTop = 25; h.dispatch(h.settings, 'scroll'); assert.equal(h.root.dataset.lgChrome, 'expanded');
  h.settings.scrollTop = 40; h.dispatch(h.settings, 'scroll'); assert.equal(h.root.dataset.lgChrome, 'compact');
  h.settings.scrollTop = 30; h.dispatch(h.settings, 'scroll'); assert.equal(h.root.dataset.lgChrome, 'compact');
  h.settings.scrollTop = 18; h.dispatch(h.settings, 'scroll'); assert.equal(h.root.dataset.lgChrome, 'expanded');
  h.modeTabs.scrollTop = 100; h.dispatch(h.modeTabs, 'scroll'); assert.equal(h.root.dataset.lgChrome, 'expanded');
  h.dispatch(h.toggle, 'keydown', { key: 'Tab' }); h.toggle.focus();
  h.settings.scrollTop = 140; h.dispatch(h.settings, 'scroll'); assert.equal(h.root.dataset.lgChrome, 'expanded');
  h.dispatch(h.settings, 'pointerdown'); h.settings.scrollTop = 200; h.dispatch(h.settings, 'scroll'); assert.equal(h.root.dataset.lgChrome, 'compact');
  h.changeMedia('(prefers-reduced-motion: reduce)', true); h.settings.scrollTop = 300; h.dispatch(h.settings, 'scroll');
  assert.equal(h.root.dataset.lgChrome, 'expanded'); assert.equal(h.frames.size, 0);
  controller.destroy();
});

test('sustained slow interaction falls back to lite and releases all visual frame work', () => {
  const h = harness(), controller = installLiquidGlass(h.win);
  for (let frame = 0; frame < 80; frame++) {
    h.dispatch(h.topbar, 'pointermove'); h.tick(40);
  }
  assert.equal(controller.getState().adaptiveLite, true); assert.equal(h.root.dataset.lgQuality, 'lite');
  assert.equal(h.topbar.style.getPropertyValue('--lg-light-x'), ''); assert.equal(h.frames.size, 0);
  assert.match(h.status.textContent, /轻量/);
  controller.destroy();
});

test('restricted storage remains usable, cross-tab changes update appearance and destroy clears listeners', () => {
  const denied = harness({ storageDenied: true }), deniedController = installLiquidGlass(denied.win);
  deniedController.setPreference('dark'); assert.equal(denied.root.dataset.lgTheme, 'dark'); assert.match(denied.status.textContent, /本次会话/);
  deniedController.destroy();
  const h = harness(), controller = installLiquidGlass(h.win);
  assert.equal(installLiquidGlass(h.win), controller);
  h.data.set(LIQUID_APPEARANCE_KEY, JSON.stringify({ theme: 'dark', simpleEffects: true }));
  h.win.emit('storage', { key: LIQUID_APPEARANCE_KEY }); assert.equal(controller.getState().theme, 'dark'); assert.equal(controller.getState().material, 'solid');
  controller.setSimpleEffects(false); h.dispatch(h.topbar, 'pointermove'); assert.ok(h.frames.size > 0);
  controller.destroy(); assert.equal(h.frames.size, 0);
  assert.equal([...h.win.listeners.values()].flat().length, 0); assert.equal([...h.doc.listeners.values()].flat().length, 0);
  assert.equal(resolveLiquidAppearance({ theme: 'invalid' }).theme, 'light');
});
