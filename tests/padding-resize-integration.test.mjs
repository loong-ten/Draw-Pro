import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { PaintDocument, composite } from '../dist/core.js';
import { paddedCanvas } from '../dist/padding-raster.js';
import { downloadBlob } from '../dist/io.js';

const require = createRequire(import.meta.url);
const canvasPath = require.resolve('@napi-rs/canvas', {
  paths: [process.cwd(), process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES].filter(Boolean),
});
const { createCanvas, ImageData, Path2D, loadImage } = require(canvasPath);
const nativeSetTimeout = globalThis.setTimeout;
const nativeClearTimeout = globalThis.clearTimeout;
const nativeCreateObjectURL = URL.createObjectURL.bind(URL), nativeRevokeObjectURL = URL.revokeObjectURL.bind(URL);
const objectURLs = new Map(), downloadTimers = new Set(), downloads = [];
let taskGate = null;
URL.createObjectURL = blob => { const url = nativeCreateObjectURL(blob); objectURLs.set(url, blob); return url; };
URL.revokeObjectURL = url => { objectURLs.delete(url); nativeRevokeObjectURL(url); };
globalThis.setTimeout = (callback, delay, ...args) => {
  if (delay === 0 && taskGate) {
    const task = { callback, args, cancelled: false, released: false, paddingTestTask: true };
    taskGate.tasks.push(task); return task;
  }
  const timer = nativeSetTimeout(callback, delay, ...args);
  if (delay >= 60000) { timer.unref?.(); downloadTimers.add(timer); }
  return timer;
};
globalThis.clearTimeout = timer => {
  if (timer?.paddingTestTask) { timer.cancelled = true; return; }
  downloadTimers.delete(timer); nativeClearTimeout(timer);
};

// Component integration follows slicer-integration.test.mjs's minimal DOM.
// Real createPadding event handlers, plans, all sampling algorithms and
// PaintDocument histories run unchanged on native canvases. Timer gating only
// controls scheduling; it never replaces computed pixels. UI drawImage inputs
// are observed while native drawing still runs, and PNGs use native encoding.
// This is not browser E2E: CSS, browser layout/focus and download delivery are
// outside this harness. Test expectations are independent pixel-coordinate
// checks. New algorithm cases check agreement across real UI operations;
// standalone numerical sampling oracles live in the core/raster test suites.
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
    remove() {
      if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this);
      this.parentNode = null;
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
    click() {
      if (this.disabled) return;
      if (this.tagName === 'A' && this.download && objectURLs.has(this.href)) {
        downloads.push({ filename: this.download, blob: objectURLs.get(this.href) });
      }
      return this.emit('click');
    },
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
    matches(selector) { return selector.split(',').some(part => matches(this, part.trim())); },
    closest(selector) { let current = this; while (current) { if (current.matches(selector)) return current; current = current.parentNode; } return null; },
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
  if (tag === 'canvas') {
    const context = node.getContext('2d'), nativeDraw = context.drawImage.bind(context);
    context.drawImage = (source, ...args) => {
      node.lastDrawImage = { source, args };
      return nativeDraw(source, ...args);
    };
    node.toBlob = (callback, mime = 'image/png') => callback(new Blob([node.toBuffer(mime)], { type: mime }));
  }
  return node;
}

globalThis.ImageData = ImageData;
globalThis.Path2D = Path2D;
globalThis.devicePixelRatio = 1;
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
const frames = new Map(); let frameSequence = 0;
globalThis.requestAnimationFrame = callback => { const id = ++frameSequence; frames.set(id, callback); return id; };
globalThis.cancelAnimationFrame = id => frames.delete(id);
const { createPadding } = await import('../dist/padding.js');

async function microtasks() { for (let index = 0; index < 12; index++) await Promise.resolve(); }
function gatedTasks(t) {
  assert.equal(taskGate, null, 'only one scheduler gate at a time');
  const gate = { tasks: [] };
  taskGate = gate;
  const deliver = (task, evenIfCancelled = false) => {
    if (!task || task.released || task.cancelled && !evenIfCancelled) return false;
    task.released = true; task.callback(...task.args); return true;
  };
  const pending = () => gate.tasks.filter(task => !task.released && !task.cancelled);
  async function until(predicate, label = 'gated operation') {
    const deadline = performance.now() + 5000;
    while (!predicate()) {
      await microtasks();
      if (predicate()) return;
      if (!deliver(pending()[0])) await new Promise(resolve => nativeSetTimeout(resolve, 0));
      assert.ok(performance.now() < deadline, `${label} completed before timeout`);
    }
    await microtasks();
  }
  function close() {
    if (taskGate === gate) taskGate = null;
    for (const task of pending()) nativeSetTimeout(() => deliver(task), 0);
  }
  t.after(close);
  return { ...gate, pending, deliver, until, close };
}

async function flushFrames() {
  const pending = [...frames]; frames.clear();
  for (const [, callback] of pending) callback(performance.now());
  await Promise.resolve();
}
const pixels = canvas => canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
const metadata = layer => Object.fromEntries(['id','name','visible','locked','opacity','blend'].map(key => [key, layer[key]]));
function sourceDocument(width, height, name, layered = true) {
  const doc = new PaintDocument({ name, width, height });
  const putPattern = (canvas, seed) => {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const index = y * width + x;
      data.set([(index*47+seed*31+13)%256, (index*79+seed*17+29)%256, (index*37+seed*23+71)%256,
        x===0&&y===0 ? 0 : x===width-1&&y===height-1 ? 128 : 255], index*4);
    }
    canvas.getContext('2d').putImageData(new ImageData(data,width,height),0,0);
  };
  const base = doc.activeLayer;
  base.name = '可见像素'; base.opacity = .8;
  putPattern(base.canvas, 0);
  if (layered) {
    const hidden = doc.addLayer('隐藏且锁定的像素层');
    hidden.visible = false; hidden.locked = true; hidden.opacity = .37; hidden.blend = 'multiply';
    putPattern(hidden.canvas, 1);
    doc.activeLayerId = base.id;
  }
  doc.resetHistory('原始像素'); doc.dirty = false;
  return doc;
}
function snapshot(doc) {
  return { id:doc.id, name:doc.name, width:doc.width, height:doc.height, activeLayerId:doc.activeLayerId,
    layers:doc.layers.map(layer=>({...metadata(layer), pixels:[...pixels(layer.canvas)]})) };
}
// Independent Pillow 12.3.0 RGBA/NEAREST fixtures. Generated from a one-row
// RGBA image whose red channel equals its source column. Keep these constants:
// rounding at some fractional steps (notably 4→6) differs from pointwise
// floor((x + .5) * source / target), so that formula is not a valid oracle.
const pillowIndices = {
  '6:3': [1,3,5], '4:8': [0,0,1,1,2,2,3,3],
  '4:6': [0,1,1,2,2,3], '2:3': [0,1,1],
  '5:4': [0,1,3,4], '3:3': [0,1,2], '3:2': [0,2],
  '8:2': [2,6], '4:1': [2], '8:8': [0,1,2,3,4,5,6,7],
  '4:4': [0,1,2,3], '12:4': [1,4,7,10], '6:2': [1,4],
  '8:4': [1,3,5,7], '4:2': [1,3],
};
function assertResizePixels(source, actual, { width, height, contentWidth=width, contentHeight=height, offsetX=0, offsetY=0 }) {
  assert.equal(actual.width,width);assert.equal(actual.height,height);
  assert.equal(actual.layers.length,source.layers.length);
  const xIndices=pillowIndices[`${source.width}:${contentWidth}`],yIndices=pillowIndices[`${source.height}:${contentHeight}`];
  assert.ok(xIndices,`independent Pillow fixture for X ${source.width}→${contentWidth}`);
  assert.ok(yIndices,`independent Pillow fixture for Y ${source.height}→${contentHeight}`);
  source.layers.forEach((saved,index)=>{
    const output=actual.layers[index], expectedMetadata={...saved};delete expectedMetadata.pixels;
    assert.deepEqual(metadata(output),expectedMetadata,`layer ${index} keeps metadata`);
    const data=pixels(output.canvas);
    for(let y=0;y<height;y++)for(let x=0;x<width;x++){
      const inside=x>=offsetX&&y>=offsetY&&x<offsetX+contentWidth&&y<offsetY+contentHeight;
      const sx=inside?xIndices[x-offsetX]:0;
      const sy=inside?yIndices[y-offsetY]:0;
      for(let channel=0;channel<4;channel++) {
        const expected=inside?saved.pixels[(sy*source.width+sx)*4+channel]:0;
        assert.equal(data[(y*width+x)*4+channel],expected,`layer ${index}, (${x},${y}), channel ${channel}: nearest original pixel or transparent letterbox`);
      }
    }
  });
}

async function harness(t, { sizes=[[8,4]], layered=true, saved, configure } = {}) {
  const root=makeElement('body'),mount=makeElement('section'),document=makeElement('document');root.append(mount);
  Object.assign(document,{body:root,createElement:makeElement,querySelector:selector=>root.querySelector(selector),
    getElementById:id=>root.querySelector(`[id="${id}"]`)});
  globalThis.document=document;globalThis.window=makeElement('window');
  const docs=sizes.map(([width,height],index)=>sourceDocument(width,height,`源图-${index+1}.png`,layered));
  docs.forEach((doc,index)=>{if(configure){configure(doc,index);doc.resetHistory('原始像素');doc.dirty=false;}});
  let active=docs[0],padding,persists=0,refreshes=0;
  const messages=[],hostState={selection:{test:true},lastAction:'guide',canvasBackground:'checker'};
  const downloadStart=downloads.length;
  const api={
    getDoc:()=>active,getDocs:()=>docs,getState:()=>hostState,
    refresh(){refreshes++;padding?.refresh();},persist(){persists++;},
    toast(message,error=false){messages.push({message,error});},
    addDocument(doc,{switchTo=true}={}){docs.push(doc);if(switchTo)active=doc;},
  };
  async function settle() {
    const deadline = performance.now() + 5000;
    do {
      await flushFrames();
      if (mount.getAttribute('aria-busy') !== 'true') {
        await flushFrames();
        if (mount.getAttribute('aria-busy') !== 'true') return;
      }
      await new Promise(resolve => nativeSetTimeout(resolve, 0));
    } while (performance.now() < deadline);
    assert.fail('padding preview did not settle: ' + mount.querySelector('[data-pad="notice"]')?.textContent);
  }
  padding=createPadding(api,mount);
  if(saved!==undefined)padding.restore(saved);
  padding.activate();await settle();
  t.after(()=>{
    padding.deactivate();frames.clear();
    for(const timer of downloadTimers)nativeClearTimeout(timer);downloadTimers.clear();
    for(const url of [...objectURLs.keys()])URL.revokeObjectURL(url);
    downloadBlob.pending=null;
  });
  const node=selector=>{const element=mount.querySelector(selector);assert.ok(element,'control exists: '+selector);return element;};
  const field=name=>node(`[data-pad="${name}"]`);
  const click=async(selector,{wait=true}={})=>{const target=node(selector);assert.equal(target.disabled,false,'control enabled: '+selector);await mount.emit('click',{target});if(wait)await settle();else await flushFrames();};
  const option=async(key,value,{wait=true}={})=>{const target=node(`[data-pad-option="${key}"]`);assert.equal(target.disabled,false,'option enabled: '+key);target.value=value;await mount.emit(target.tagName==='SELECT'?'change':'input',{target});if(wait)await settle();else await flushFrames();};
  const check=async(name,value)=>{const target=field(name);assert.equal(target.disabled,false,'checkbox enabled: '+name);target.checked=value;await mount.emit('change',{target});await settle();};
  const action=(name,options)=>click(`[data-pad-action="${name}"]`,options);
  const mode=(name,options)=>click(`[data-pad-mode="${name}"]`,options);
  const preview=()=>{const canvas=field('after').lastDrawImage?.source;assert.ok(canvas,'real result canvas was drawn');return canvas;};
  const background=async value=>{const target=field('background');target.value=value;await mount.emit('change',{target});await settle();};
  return {padding,mount,api,docs,node,field,click,option,check,action,mode,messages,hostState,settle,preview,background,
    get active(){return active;},get persists(){return persists;},get refreshes(){return refreshes;},
    get downloads(){return downloads.slice(downloadStart);},
    async select(index,{wait=true}={}){active=docs[index];padding.refresh();if(wait)await settle();else await flushFrames();},
    async undo(){assert.equal(active.undo(),true,'real PaintDocument undo succeeds');padding.refresh();await settle();}
  };
}

// Contracts are exercised through rendered controls, not a patched test-only
// action surface.
test('resize controls default to 48×48 and custom dimensions change only the preview until apply',async t=>{
  const h=await harness(t),before=snapshot(h.active),history=h.active.history;
  assert.equal(h.padding.serialize().options.resizeWidth,48);
  assert.equal(h.padding.serialize().options.resizeHeight,48);
  assert.equal(h.padding.serialize().options.resizeFit,'stretch');
  await h.mode('resize');
  assert.equal(h.field('resize-fields').hidden,false);
  for(const name of ['ratio','scale','size'])assert.equal(h.field(name+'-fields').hidden,true);
  await h.option('resizeWidth',37);await h.option('resizeHeight',19);
  assert.equal(h.padding.serialize().options.mode,'resize');
  assert.equal(h.field('target-size').textContent,'37 × 19');
  assert.equal(h.node('[data-pad-action="apply"]').disabled,false);
  assert.deepEqual(snapshot(h.active),before,'preview leaves all source pixels and dimensions unchanged');
  assert.equal(h.active.history,history,'preview does not allocate a document history entry');
  assert.ok(h.persists>0,'the host is asked to persist resize controls');
  assert.equal(h.messages.some(message=>message.error),false);
});

test('stretch apply resamples all layers once and a real undo restores dimensions, pixels and metadata',async t=>{
  const h=await harness(t,{sizes:[[6,4]]}),before=snapshot(h.active),index=h.active.historyIndex;
  await h.mode('resize');await h.option('resizeWidth',3);await h.option('resizeHeight',8);
  await h.action('apply');
  assertResizePixels(before,h.active,{width:3,height:8});
  assert.equal(h.active.historyIndex,index+1,'one application is exactly one history step');
  assert.equal(h.node('[data-pad-action="apply"]').disabled,true,'the current plan is marked applied');
  assert.equal(h.hostState.selection,null);assert.equal(h.hostState.lastAction,'image');
  await h.undo();
  assert.deepEqual(snapshot(h.active),before,'undo restores hidden/locked layers as well as visible pixels');
  assert.equal(h.node('[data-pad-action="apply"]').disabled,false,'undo makes the resize applicable again');
  assert.equal(h.messages.some(message=>message.error),false);
});

test('contain scales the entire source canvas and floors odd transparent centering offsets',async t=>{
  const h=await harness(t,{sizes:[[4,2]]}),before=snapshot(h.active);
  await h.mode('resize');await h.option('resizeWidth',6);await h.option('resizeHeight',6);await h.option('resizeFit','contain');
  await h.action('apply');
  assertResizePixels(before,h.active,{width:6,height:6,contentWidth:6,contentHeight:3,offsetY:1});
  for(const layer of h.active.layers){const data=pixels(layer.canvas);for(const row of [0,4,5])for(let x=0;x<6;x++)assert.equal(data[(row*6+x)*4+3],0,'odd spare row stays on bottom');}
  assert.equal(h.padding.serialize().options.resizeFit,'contain');
});

test('stretch and contain plans with equal canvas size and offsets never collide in applied-state detection',async t=>{
  const h=await harness(t,{sizes:[[5,3]]}),original=snapshot(h.active);
  await h.mode('resize');await h.option('resizeWidth',4);await h.option('resizeHeight',3);
  await h.action('apply');
  assertResizePixels(original,h.active,{width:4,height:3});
  const stretched=snapshot(h.active),afterStretchIndex=h.active.historyIndex;
  await h.option('resizeFit','contain');
  assert.equal(h.node('[data-pad-action="apply"]').disabled,false,'4×2 content differs even when target4×3 and offset0,0 match stretch');
  await h.action('apply');
  assertResizePixels(original,h.active,{width:4,height:3,contentWidth:4,contentHeight:2});
  assert.equal(h.active.historyIndex,afterStretchIndex+1);
  await h.option('resizeFit','stretch');
  assert.equal(h.node('[data-pad-action="apply"]').disabled,false,'returning to stretch must restore source detail');
  await h.action('apply');
  assert.deepEqual(snapshot(h.active),stretched,'parameter changes keep reading original5×3 rather than already resized4×3');
  assert.equal(h.field('source-size').textContent,'5 × 3');
});

test('downscale then restore original dimensions uses the immutable original snapshot instead of enlarging the reduced result',async t=>{
  const h=await harness(t,{sizes:[[8,4]]}),original=snapshot(h.active);
  await h.mode('resize');await h.option('resizeWidth',2);await h.option('resizeHeight',1);await h.action('apply');
  assertResizePixels(original,h.active,{width:2,height:1});
  await h.option('resizeWidth',8);await h.option('resizeHeight',4);
  assert.equal(h.node('[data-pad-action="apply"]').disabled,false);
  await h.action('apply');
  assert.deepEqual(snapshot(h.active),original,'full original detail returns after downscale');
  assert.equal(h.node('[data-pad-action="apply"]').disabled,true);
});

test('identity resize does not add a redundant history state and leaving resize restores the remembered uniform preference',async t=>{
  const h=await harness(t,{sizes:[[8,4]],saved:{options:{mode:'resize',resizeWidth:8,resizeHeight:4,resizeFit:'stretch'},uniform:false}});
  const before=snapshot(h.active),historyLength=h.active.history.length;
  assert.equal(h.node('[data-pad-action="apply"]').disabled,true,'identity pixels are already applied');
  assert.equal(h.field('uniform').checked,true,'resize always uses specified output dimensions');
  assert.equal(h.field('uniform').disabled,true,'uniform cannot override resize geometry');
  assert.equal(h.padding.serialize().uniform,false,'visual enforced-uniform does not erase the previous padding preference');
  await h.mode('ratio');
  assert.equal(h.field('uniform').checked,false);assert.equal(h.field('uniform').disabled,false);
  await h.mode('resize');
  assert.deepEqual(snapshot(h.active),before);assert.equal(h.active.history.length,historyLength);
});

test('batch resize still scales every document when persisted uniform=true and keeps the resize lock after completion',async t=>{
  const h=await harness(t,{sizes:[[12,6],[6,12]],saved:{options:{mode:'resize',resizeWidth:4,resizeHeight:4,resizeFit:'contain',center:'content',margin:100},uniform:true}});
  const original=h.docs.map(snapshot);
  await h.action('preview-batch');
  assert.equal(h.messages.some(message=>message.error),false,'large originals may shrink and padding margin must not reject them');
  assert.match(h.field('report').textContent,/2 张可应用/);
  await h.action('batch');
  assertResizePixels(original[0],h.docs[0],{width:4,height:4,contentWidth:4,contentHeight:2,offsetY:1});
  assertResizePixels(original[1],h.docs[1],{width:4,height:4,contentWidth:2,contentHeight:4,offsetX:1});
  assert.match(h.field('report').textContent,/应用 2 张/);
  assert.match(h.field('report').textContent,/失败 0 张/);
  assert.equal(h.field('uniform').checked,true);assert.equal(h.field('uniform').disabled,true,'busy(false) must not re-enable resize uniform');
  assert.equal(h.node('[data-pad-action="batch"]').disabled,true,'the exact completed batch is not reapplied');
  assert.equal(h.docs[0].historyIndex,1);assert.equal(h.docs[1].historyIndex,1);
  await h.undo();assert.deepEqual(snapshot(h.docs[0]),original[0]);
  assert.deepEqual([h.docs[1].width,h.docs[1].height],[4,4],'undo is per-document');
});

test('batch skips a currently applied identical resize but scales the other originals and preserves the active snapshot',async t=>{
  const h=await harness(t,{sizes:[[8,4],[4,8]]}),original=h.docs.map(snapshot);
  await h.mode('resize');await h.option('resizeWidth',4);await h.option('resizeHeight',4);await h.action('apply');
  const firstHistory=h.docs[0].history.length;
  await h.action('batch');
  assert.match(h.field('report').textContent,/应用 1 张/);assert.match(h.field('report').textContent,/已符合 1 张/);
  assert.equal(h.docs[0].history.length,firstHistory,'skip keeps first document history unchanged');
  assertResizePixels(original[0],h.docs[0],{width:4,height:4});
  assertResizePixels(original[1],h.docs[1],{width:4,height:4});
  await h.option('resizeFit','contain');await h.action('apply');
  assertResizePixels(original[0],h.active,{width:4,height:4,contentWidth:4,contentHeight:2,offsetY:1});
  assert.equal(h.field('source-size').textContent,'8 × 4','batch reconciliation keeps the original active source');
});

test('serialized resize parameters survive restore and invalid fit values normalize without damaging pixels',async t=>{
  const first=await harness(t,{sizes:[[9,6]]});
  await first.mode('resize');await first.option('resizeWidth',13);await first.option('resizeHeight',17);await first.option('resizeFit','contain');
  const saved=JSON.parse(JSON.stringify(first.padding.serialize()));first.padding.deactivate();
  const restored=await harness(t,{sizes:[[9,6]],saved});
  assert.deepEqual(restored.padding.serialize(),saved);
  assert.equal(restored.node('[data-pad-option="resizeWidth"]').value,'13');
  assert.equal(restored.node('[data-pad-option="resizeHeight"]').value,'17');
  assert.equal(restored.node('[data-pad-option="resizeFit"]').value,'contain');
  assert.equal(restored.field('target-size').textContent,'13 × 17');
  assert.equal(restored.field('resize-fields').hidden,false);
  const before=snapshot(restored.active);
  await restored.option('resizeWidth',0);
  assert.equal(restored.field('error').hidden,false);
  assert.equal(restored.node('[data-pad-action="apply"]').disabled,true);
  assert.deepEqual(snapshot(restored.active),before,'invalid dimensions cannot mutate image pixels');
  restored.padding.restore({...saved,options:{...saved.options,resizeFit:'crop'}});restored.padding.activate();await restored.settle();
  assert.equal(restored.padding.serialize().options.resizeFit,'stretch','unsupported saved fit cannot become implicit crop');
  assert.equal(restored.field('error').hidden,true);
});

const resizeSettings = (options = {}) => ({ options: { mode:'resize', resizeWidth:4, resizeHeight:3,
  resizeFit:'stretch', resizeSizeMode:'dimensions', resizeAlgorithm:'nearest', ...options } });
const imageSnapshot = canvas => ({ width:canvas.width, height:canvas.height, pixels:[...pixels(canvas)] });
function layerResult(doc) {
  return { width:doc.width, height:doc.height, activeIndex:doc.layers.findIndex(layer=>layer.id===doc.activeLayerId),
    layers:doc.layers.map(layer=>{const {id,...attributes}=metadata(layer);return {...attributes,pixels:[...pixels(layer.canvas)]};}) };
}
function visibleBlendFixture(doc) {
  const first=doc.layers[0],second=doc.layers[1];
  second.name='半透明叠底层';second.visible=true;second.opacity=.55;second.blend='multiply';
  doc.activeLayerId=second.id;
  const hidden=doc.addLayer('隐藏锁定层');hidden.visible=false;hidden.locked=true;hidden.opacity=.31;hidden.blend='screen';
  hidden.canvas.getContext('2d').fillStyle='#12e4a9';hidden.canvas.getContext('2d').fillRect(1,0,doc.width-1,doc.height);
  doc.activeLayerId=first.id;
}
async function decodedPNG(download) {
  assert.ok(download?.blob,'PNG download was generated');assert.equal(download.blob.type,'image/png');
  const image=await loadImage(Buffer.from(await download.blob.arrayBuffer()));
  const canvas=createCanvas(image.width,image.height);canvas.getContext('2d').drawImage(image,0,0);return canvas;
}
function observeReads(t,canvas) {
  const context=canvas.getContext('2d'),original=context.getImageData.bind(context);let reads=0;
  t.mock.method(context,'getImageData',(...args)=>{reads++;return original(...args);});
  return ()=>reads;
}

test('algorithm changes invalidate both prepared preview and applied keys while retaining the original source',async t=>{
  const h=await harness(t,{sizes:[[6,4]],saved:resizeSettings({resizeWidth:3,resizeHeight:8})});
  const original=snapshot(h.active),nearestPreview=imageSnapshot(h.preview());
  await h.action('apply');const nearest=snapshot(h.active),firstHistory=h.active.historyIndex;
  await h.option('resizeAlgorithm','bilinear');
  assert.equal(h.node('[data-pad-action="apply"]').disabled,false,'same geometry with another algorithm is a new result');
  assert.notDeepEqual(imageSnapshot(h.preview()),nearestPreview,'the cached nearest image was replaced');
  await h.action('apply');assert.equal(h.active.historyIndex,firstHistory+1);
  assert.deepEqual(imageSnapshot(h.preview()),imageSnapshot(composite(h.active)));
  await h.option('resizeAlgorithm','nearest');await h.action('apply');
  assert.deepEqual(snapshot(h.active),nearest,'returning to nearest rereads the immutable original pixels');
  assertResizePixels(original,h.active,{width:3,height:8});
  assert.equal(h.field('source-size').textContent,'6 × 4');
});

test('stretch and cover with identical six geometry fields have distinct preview/applied keys because sourceRect differs',async t=>{
  const h=await harness(t,{sizes:[[8,4]],saved:resizeSettings({resizeWidth:4,resizeHeight:4})});
  const original=snapshot(h.active),stretchPreview=imageSnapshot(h.preview());
  await h.action('apply');const stretched=snapshot(h.active);
  await h.option('resizeFit','cover');
  assert.equal(h.node('[data-pad-action="apply"]').disabled,false);
  assert.notDeepEqual(imageSnapshot(h.preview()),stretchPreview,'cover replaces full-image sampling with centered source crop');
  await h.action('apply');
  original.layers.forEach((layer,index)=>{
    const output=pixels(h.active.layers[index].canvas);
    for(let y=0;y<4;y++)for(let x=0;x<4;x++){
      assert.deepEqual([...output.slice((y*4+x)*4,(y*4+x)*4+4)],layer.pixels.slice((y*8+x+2)*4,(y*8+x+2)*4+4),
        '8×4 to square cover takes original columns 2–5 without stretching');
    }
  });
  await h.option('resizeFit','stretch');await h.action('apply');
  assert.deepEqual(snapshot(h.active),stretched);
});

for(const algorithm of ['nearest','bilinear','bicubic','lanczos3','area']) {
  test(`${algorithm}: per-layer preview, PNG, current apply, batch and independent duplicate agree`,async t=>{
    const h=await harness(t,{sizes:[[7,5],[7,5]],configure:visibleBlendFixture,saved:resizeSettings({resizeAlgorithm:algorithm})});
    const original=snapshot(h.active),flatOriginal=composite(h.active),preview=imageSnapshot(h.preview());
    assert.equal(h.active.historyIndex,0);assert.deepEqual(snapshot(h.active),original,'preview stages all layers without mutating the document');
    await h.action('export');
    assert.deepEqual(imageSnapshot(await decodedPNG(h.downloads.at(-1))),preview,'PNG excludes UI backgrounds and overlays');
    await h.action('apply');
    const expected=layerResult(h.active);
    assert.deepEqual(imageSnapshot(composite(h.active)),preview,'preview composites the scaled layers with real blend/opacity');
    assert.equal(h.active.layers[1].visible,true);assert.equal(h.active.layers[1].blend,'multiply');
    assert.equal(h.active.layers[2].visible,false);assert.equal(h.active.layers[2].locked,true);
    if(algorithm!=='nearest') {
      const wrong=paddedCanvas(flatOriginal,{operation:'resize',width:4,height:3,contentWidth:4,contentHeight:3,offsetX:0,offsetY:0,algorithm});
      assert.notDeepEqual(imageSnapshot(wrong),preview,'the fixture distinguishes flatten-before-resize from per-layer resizing');
    }
    await h.action('batch');
    assert.deepEqual(layerResult(h.docs[1]),expected,'batch uses the same per-layer algorithm');
    assert.equal(h.docs[0].historyIndex,1,'batch skips the already-applied current result');
    assert.equal(h.docs[1].historyIndex,1);
    const source=h.active,sourceCanvases=source.layers.map(layer=>layer.canvas);
    await h.action('duplicate');const copy=h.active;
    assert.notEqual(copy.id,source.id);assert.deepEqual(layerResult(copy),expected);
    copy.layers.forEach((layer,index)=>{assert.notEqual(layer.id,source.layers[index].id);assert.notEqual(layer.canvas,sourceCanvases[index]);});
    assert.notEqual(copy.history,source.history);assert.equal(copy.historyIndex,0);
    assert.deepEqual(layerResult(source),expected,'duplicate preparation never alters the applied source');
    assert.equal(h.messages.some(message=>message.error),false);
  });
}

test('all size modes expose the right fields, calculate independent geometry and preserve settings across restore',async t=>{
  const h=await harness(t,{sizes:[[12,8]],saved:resizeSettings({resizeWidth:7,resizeHeight:7,resizeFit:'inside',resizeAlgorithm:'area'})});
  assert.equal(h.field('target-size').textContent,'7 × 5');assert.equal(h.field('uniform').checked,false);
  await h.option('resizeSizeMode','percent');await h.option('resizePercent',50);
  assert.equal(h.field('target-size').textContent,'6 × 4');assert.equal(h.field('resize-percent-fields').hidden,false);
  assert.equal(h.field('resize-fit-field').hidden,true);
  await h.option('resizeSizeMode','width');await h.option('resizeWidth',9);
  assert.equal(h.field('target-size').textContent,'9 × 6');assert.equal(h.field('resize-height-field').hidden,true);
  await h.option('resizeSizeMode','height');await h.option('resizeHeight',4);
  assert.equal(h.field('target-size').textContent,'6 × 4');assert.equal(h.field('resize-width-field').hidden,true);
  await h.option('resizeSizeMode','long-edge');await h.option('resizeLongEdge',3);
  assert.equal(h.field('target-size').textContent,'3 × 2');assert.equal(h.field('resize-long-edge-field').hidden,false);
  const saved=JSON.parse(JSON.stringify(h.padding.serialize()));h.padding.deactivate();
  const restored=await harness(t,{sizes:[[12,8]],saved});
  assert.deepEqual(restored.padding.serialize(),saved);assert.equal(restored.field('target-size').textContent,'3 × 2');
  assert.equal(restored.node('[data-pad-option="resizeAlgorithm"]').value,'area');
  const before=snapshot(restored.active);
  restored.padding.restore({...saved,options:{...saved.options,resizeAlgorithm:'unknown',resizeSizeMode:'unknown',resizeFit:'unknown'}});
  restored.padding.activate();await restored.settle();
  const normalized=restored.padding.serialize().options;
  assert.equal(normalized.resizeAlgorithm,'nearest');assert.equal(normalized.resizeSizeMode,'dimensions');assert.equal(normalized.resizeFit,'stretch');
  assert.deepEqual(snapshot(restored.active),before);
});

test('percentage batch ignores the remembered uniform preference and leaves per-image output dimensions distinct',async t=>{
  const saved={...resizeSettings({resizeSizeMode:'percent',resizePercent:50,resizeFit:'cover',resizeAlgorithm:'area'}),uniform:true};
  const h=await harness(t,{sizes:[[12,6],[6,12]],saved});
  assert.equal(h.field('uniform').checked,false);assert.equal(h.field('uniform').disabled,true);
  await h.action('batch');
  assert.deepEqual(h.docs.map(doc=>[doc.width,doc.height]),[[6,3],[3,6]]);
  assert.deepEqual(h.docs.map(doc=>doc.historyIndex),[1,1]);
  assert.equal(h.padding.serialize().uniform,true,'switching back to padding still remembers the previous preference');
  assert.equal(h.field('uniform').checked,false);
});

test('changing algorithm and dimensions while a preview is queued cancels stale work before it can replace the latest result',async t=>{
  const h=await harness(t,{sizes:[[6,4]],saved:resizeSettings()}),before=snapshot(h.active);
  const gate=gatedTasks(t);
  await h.option('resizeAlgorithm','bilinear',{wait:false});const old=gate.pending()[0];
  assert.ok(old);assert.equal(h.mount.getAttribute('aria-busy'),'true');
  for(const action of ['apply','duplicate','export'])assert.equal(h.node(`[data-pad-action="${action}"]`).disabled,true);
  await h.option('resizeWidth',3,{wait:false});await h.option('resizeHeight',8,{wait:false});await h.option('resizeAlgorithm','nearest',{wait:false});
  assert.equal(old.cancelled,true,'the old signal cancels its pending scheduler task');
  await gate.until(()=>h.mount.getAttribute('aria-busy')==='false','latest preview');await h.settle();
  const latest=imageSnapshot(h.preview());assert.deepEqual([latest.width,latest.height],[3,8]);
  gate.deliver(old,true);await microtasks();await flushFrames();
  assert.deepEqual(imageSnapshot(h.preview()),latest,'a late callback cannot resurrect the old algorithm/size');
  assert.deepEqual(snapshot(h.active),before);assert.equal(h.active.historyIndex,0);
  gate.close();await h.action('apply');assertResizePixels(before,h.active,{width:3,height:8});
  assert.equal(h.messages.some(message=>message.error),false,'normal cancellation is not surfaced as an error');
});

test('source changes and deactivate/reactivate invalidate queued previews without committing to either old or new source',async t=>{
  const h=await harness(t,{sizes:[[8,4],[4,8]],saved:resizeSettings({resizeWidth:4,resizeHeight:4})});
  const before=h.docs.map(snapshot),gate=gatedTasks(t);
  await h.option('resizeAlgorithm','bicubic',{wait:false});const old=gate.pending()[0];
  await h.select(1,{wait:false});assert.equal(old.cancelled,true);
  const switched=gate.pending()[0];h.padding.deactivate();assert.equal(switched.cancelled,true);
  assert.equal(h.mount.getAttribute('aria-busy'),'false');
  h.padding.activate();
  await gate.until(()=>h.mount.getAttribute('aria-busy')==='false','reactivated preview');await h.settle();
  assert.equal(h.field('filename').textContent,h.docs[1].name);assert.equal(h.field('source-size').textContent,'4 × 8');
  const latest=imageSnapshot(h.preview());
  gate.deliver(old,true);gate.deliver(switched,true);await microtasks();await flushFrames();
  assert.deepEqual(imageSnapshot(h.preview()),latest);assert.deepEqual(h.docs.map(snapshot),before);
  gate.close();await h.action('apply');
  assert.deepEqual(snapshot(h.docs[0]),before[0]);assert.equal(h.docs[0].historyIndex,0);assert.equal(h.docs[1].historyIndex,1);
  assert.deepEqual(imageSnapshot(composite(h.docs[1])),latest);
});

test('cancelling a batch during its second document keeps completed documents whole and leaves the in-flight multi-layer document untouched',async t=>{
  const h=await harness(t,{sizes:[[7,5],[7,5]],configure:visibleBlendFixture,saved:resizeSettings({resizeAlgorithm:'lanczos3'})});
  const original=h.docs.map(snapshot),canvases=h.docs[1].layers.map(layer=>layer.canvas),history=h.docs[1].history;
  await h.action('preview-batch');
  const secondLayerReads=observeReads(t,h.docs[1].layers[1].canvas),gate=gatedTasks(t);
  const batch=h.action('batch',{wait:false});
  await gate.until(()=>h.docs[0].historyIndex===1&&secondLayerReads()>0,'second document mid-layer work');
  assert.deepEqual(snapshot(h.docs[1]),original[1]);assert.equal(h.docs[1].history,history);
  await h.action('cancel',{wait:false});
  await gate.until(()=>!h.padding.isBusy(),'batch cancellation');await batch;gate.close();await h.settle();
  assert.deepEqual([h.docs[0].width,h.docs[0].height],[4,3]);assert.equal(h.docs[0].historyIndex,1);
  assert.deepEqual(snapshot(h.docs[1]),original[1]);assert.equal(h.docs[1].history,history);assert.equal(h.docs[1].historyIndex,0);
  h.docs[1].layers.forEach((layer,index)=>assert.equal(layer.canvas,canvases[index]));
  assert.match(h.field('report').textContent,/已停止.*应用 1 张/);assert.match(h.field('report').textContent,/失败 0 张/);
  await h.action('batch');
  assert.deepEqual(layerResult(h.docs[1]),layerResult(h.docs[0]));
  assert.equal(h.docs[0].historyIndex,1,'resuming never resizes a completed document twice');assert.equal(h.docs[1].historyIndex,1);
});

test('a document revision changed during async batch preparation is never overwritten by the staged result',async t=>{
  const h=await harness(t,{sizes:[[7,5]],configure:visibleBlendFixture,saved:resizeSettings({resizeAlgorithm:'bicubic'})});
  await h.action('preview-batch');
  const secondLayerReads=observeReads(t,h.active.layers[1].canvas),gate=gatedTasks(t);
  const batch=h.action('batch',{wait:false});await gate.until(()=>secondLayerReads()>0,'mid-layer preparation');
  const ctx=h.active.layers[0].canvas.getContext('2d');ctx.fillStyle='#ff7711';ctx.fillRect(2,1,1,1);h.active.commit('外部编辑');
  const external=snapshot(h.active),history=h.active.history;
  await gate.until(()=>h.mount.getAttribute('aria-busy')==='false','revision mismatch handling');await batch;gate.close();await h.settle();
  assert.deepEqual(snapshot(h.active),external);assert.equal(h.active.history,history);assert.equal(h.active.historyIndex,1);
  assert.match(h.field('report').textContent,/失败 1 张/);assert.equal(h.field('source-size').textContent,'7 × 5');
});

test('all three transparency backgrounds change only display pixels and keep PNG/export/source history identical',async t=>{
  const h=await harness(t,{sizes:[[4,2]],layered:false,saved:resizeSettings({resizeWidth:8,resizeHeight:8,resizeFit:'contain',resizeAlgorithm:'bilinear'})});
  const original=snapshot(h.active),history=h.active.history,preview=h.preview(),expected=imageSnapshot(preview),exported=[];
  await h.check('guides',false);await h.action('actual');
  for(const kind of ['checker','studio','transparent']){
    await h.background(kind);assert.equal(h.hostState.canvasBackground,kind);assert.equal(h.field('background').value,kind);
    assert.equal(h.preview(),preview,'background changes reuse the same prepared RGBA result');
    const [x,y]=h.field('after').lastDrawImage.args,display=pixels(h.field('after'));
    const alpha=display[((Math.floor(y)+1)*h.field('after').width+Math.floor(x)+4)*4+3];
    assert.equal(alpha,kind==='transparent'?0:255,'the transparent letterbox displays the selected background');
    await h.action('export');exported.push(imageSnapshot(await decodedPNG(h.downloads.at(-1))));
    assert.deepEqual(exported.at(-1),expected);assert.deepEqual(snapshot(h.active),original);assert.equal(h.active.history,history);
  }
  assert.deepEqual(exported[0],exported[1]);assert.deepEqual(exported[1],exported[2]);
  h.hostState.canvasBackground='studio';h.padding.refreshBackground();await h.settle();assert.equal(h.field('background').value,'studio');
  assert.equal(h.preview(),preview);assert.equal(h.active.dirty,false);assert.equal(h.active.historyIndex,0);
});
