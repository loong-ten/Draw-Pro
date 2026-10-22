/* Paint Studio's dependency-free raster model. Layers are ordered bottom to top. */
const MAX_SIDE = 8192;
const MAX_PIXELS = 32 * 1024 * 1024;
const HISTORY_BYTES = 96 * 1024 * 1024;
const HISTORY_COUNT = 30;

export function uid() {
  return globalThis.crypto?.randomUUID?.() ?? `p${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

function dimensions(width, height) {
  const w = Math.round(Number(width));
  const h = Math.round(Number(height));
  if (!Number.isFinite(w) || !Number.isFinite(h) || w < 1 || h < 1 || w > MAX_SIDE || h > MAX_SIDE || w * h > MAX_PIXELS) {
    throw new RangeError('画布尺寸须为 1–8192 像素，且总面积不超过 3200 万像素。');
  }
  return [w, h];
}

export function makeCanvas(width, height) {
  const [w, h] = dimensions(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  return canvas;
}

export function cloneCanvas(canvas) {
  const result = makeCanvas(canvas.width, canvas.height);
  result.getContext('2d').drawImage(canvas, 0, 0);
  return result;
}

export function composite(doc, { background = null } = {}) {
  const output = makeCanvas(doc.width, doc.height);
  const context = output.getContext('2d');
  if (background) {
    context.fillStyle = background;
    context.fillRect(0, 0, output.width, output.height);
  }
  for (const layer of doc.layers) {
    if (!layer.visible || layer.opacity <= 0) continue;
    context.globalAlpha = layer.opacity;
    context.drawImage(layer.canvas, 0, 0);
  }
  context.globalAlpha = 1;
  return output;
}

function newLayer(width, height, name = '图层 1', canvas = null) {
  const result = { id: uid(), name, canvas: makeCanvas(width, height), visible: true, opacity: 1, locked: false };
  if (canvas) result.canvas.getContext('2d').drawImage(canvas, 0, 0);
  return result;
}

function anchorOffset(anchor, oldWidth, oldHeight, width, height) {
  const key = String(anchor || 'center').toLowerCase();
  const x = /left/.test(key) ? 0 : /right/.test(key) ? width - oldWidth : Math.floor((width - oldWidth) / 2);
  const y = /top/.test(key) ? 0 : /bottom/.test(key) ? height - oldHeight : Math.floor((height - oldHeight) / 2);
  return [x, y];
}

export class PaintDocument {
  constructor({ name = '未命名.png', width = 960, height = 640, fill = 'transparent', canvas = null, id = null } = {}) {
    if (canvas) { width = canvas.width; height = canvas.height; }
    [this.width, this.height] = dimensions(width, height);
    this.id = id || uid();
    this.name = name;
    this.layers = [newLayer(this.width, this.height, '背景', canvas)];
    if (!canvas && fill && fill !== 'transparent') {
      const ctx = this.layers[0].canvas.getContext('2d');
      ctx.fillStyle = fill;
      ctx.fillRect(0, 0, this.width, this.height);
    }
    this.activeLayerId = this.layers[0].id;
    this.dirty = false;
    this.revision = 0;
    this.history = [];
    this.historyIndex = -1;
    this.resetHistory('打开图像');
  }

  get activeLayer() {
    return this.layers.find(layer => layer.id === this.activeLayerId) || this.layers[this.layers.length - 1];
  }

  get canUndo() { return this.historyIndex > 0; }
  get canRedo() { return this.historyIndex < this.history.length - 1; }

  _capture(label) {
    const layers = this.layers.map(layer => ({
      id: layer.id, name: layer.name, visible: layer.visible, opacity: layer.opacity, locked: layer.locked,
      pixels: layer.canvas.getContext('2d').getImageData(0, 0, this.width, this.height),
    }));
    return {
      label, time: Date.now(), width: this.width, height: this.height,
      activeLayerId: this.activeLayerId, layers,
      bytes: this.width * this.height * 4 * layers.length,
    };
  }

  _restore(state) {
    this.width = state.width;
    this.height = state.height;
    this.layers = state.layers.map(saved => {
      const canvas = makeCanvas(state.width, state.height);
      canvas.getContext('2d').putImageData(saved.pixels, 0, 0);
      return { id: saved.id, name: saved.name, visible: saved.visible, opacity: saved.opacity, locked: saved.locked, canvas };
    });
    this.activeLayerId = state.activeLayerId;
    this.dirty = true;
    this.revision++;
  }

  resetHistory(label = '打开图像') {
    this.history = [this._capture(label)];
    this.historyIndex = 0;
  }

  commit(label = '编辑图像') {
    const state = this._capture(label);
    this.history = this.history.slice(0, this.historyIndex + 1);
    this.history.push(state);
    let bytes = this.history.reduce((total, entry) => total + entry.bytes, 0);
    while (this.history.length > 2 && (this.history.length > HISTORY_COUNT || bytes > HISTORY_BYTES)) {
      bytes -= this.history.shift().bytes;
    }
    this.historyIndex = this.history.length - 1;
    this.dirty = true;
    this.revision++;
    return this;
  }

  undo() {
    if (!this.canUndo) return false;
    this._restore(this.history[--this.historyIndex]);
    return true;
  }

  redo() {
    if (!this.canRedo) return false;
    this._restore(this.history[++this.historyIndex]);
    return true;
  }

  addLayer(name) {
    const layer = newLayer(this.width, this.height, name || `图层 ${this.layers.length + 1}`);
    const activeIndex = this.layers.findIndex(item => item.id === this.activeLayerId);
    this.layers.splice(activeIndex < 0 ? this.layers.length : activeIndex + 1, 0, layer);
    this.activeLayerId = layer.id;
    return layer;
  }

  removeLayer(id = this.activeLayerId) {
    const index = this.layers.findIndex(layer => layer.id === id);
    if (index < 0) return false;
    if (this.layers.length === 1) {
      this.layers[0].canvas.getContext('2d').clearRect(0, 0, this.width, this.height);
      return true;
    }
    this.layers.splice(index, 1);
    if (this.activeLayerId === id) this.activeLayerId = this.layers[Math.min(index, this.layers.length - 1)].id;
    return true;
  }

  duplicateLayer(id = this.activeLayerId) {
    const index = this.layers.findIndex(layer => layer.id === id);
    if (index < 0) return null;
    const original = this.layers[index];
    const duplicate = { ...original, id: uid(), name: `${original.name} 副本`, canvas: cloneCanvas(original.canvas), locked: false };
    this.layers.splice(index + 1, 0, duplicate);
    this.activeLayerId = duplicate.id;
    return duplicate;
  }

  mergeDown(id = this.activeLayerId) {
    const index = this.layers.findIndex(layer => layer.id === id);
    if (index < 1) return false;
    const upper = this.layers[index];
    const lower = this.layers[index - 1];
    const canvas = makeCanvas(this.width, this.height);
    const ctx = canvas.getContext('2d');
    if (lower.visible) { ctx.globalAlpha = lower.opacity; ctx.drawImage(lower.canvas, 0, 0); }
    if (upper.visible) { ctx.globalAlpha = upper.opacity; ctx.drawImage(upper.canvas, 0, 0); }
    lower.canvas = canvas;
    lower.opacity = 1;
    lower.visible = upper.visible || lower.visible;
    lower.locked = false;
    this.layers.splice(index, 1);
    this.activeLayerId = lower.id;
    return lower;
  }

  reorderLayer(id = this.activeLayerId, direction = 'up') {
    const index = this.layers.findIndex(layer => layer.id === id);
    if (index < 0) return false;
    let next = index;
    if (direction === 'top') next = this.layers.length - 1;
    else if (direction === 'bottom') next = 0;
    else next += (direction === 'up' || Number(direction) > 0) ? 1 : -1;
    next = Math.max(0, Math.min(this.layers.length - 1, next));
    if (next === index) return false;
    const [layer] = this.layers.splice(index, 1);
    this.layers.splice(next, 0, layer);
    return true;
  }

  setLayer(id, props = {}) {
    const layer = this.layers.find(item => item.id === id);
    if (!layer) return false;
    if ('name' in props) layer.name = String(props.name).trim() || '图层';
    if ('visible' in props) layer.visible = Boolean(props.visible);
    if ('locked' in props) layer.locked = Boolean(props.locked);
    if ('opacity' in props && Number.isFinite(Number(props.opacity))) layer.opacity = Math.max(0, Math.min(1, Number(props.opacity)));
    return layer;
  }

  _transform(width, height, draw) {
    [width, height] = dimensions(width, height);
    const oldWidth = this.width;
    const oldHeight = this.height;
    const transformed = this.layers.map(layer => {
      const canvas = makeCanvas(width, height);
      draw(canvas.getContext('2d'), layer.canvas, oldWidth, oldHeight, width, height);
      return { ...layer, canvas };
    });
    this.layers = transformed;
    this.width = width;
    this.height = height;
    return this;
  }

  resize(width, height, { resample = true, smooth = false, anchor = 'center' } = {}) {
    return this._transform(width, height, (ctx, original, oldWidth, oldHeight, newWidth, newHeight) => {
      ctx.imageSmoothingEnabled = Boolean(smooth);
      ctx.imageSmoothingQuality = 'high';
      if (resample) ctx.drawImage(original, 0, 0, newWidth, newHeight);
      else {
        const [x, y] = anchorOffset(anchor, oldWidth, oldHeight, newWidth, newHeight);
        ctx.drawImage(original, x, y);
      }
    });
  }

  Resize(width, height, options) { return this.resize(width, height, options); }

  rotate(angleDegrees = 90) {
    const value = Number(angleDegrees);
    if (!Number.isFinite(value)) throw new RangeError('请输入有效旋转角度。');
    const angle = ((value % 360) + 360) % 360;
    if (angle === 0) return this;
    const radians = angle * Math.PI / 180;
    const cosine = Math.abs(Math.cos(radians)) < 1e-10 ? 0 : Math.abs(Math.cos(radians));
    const sine = Math.abs(Math.sin(radians)) < 1e-10 ? 0 : Math.abs(Math.sin(radians));
    const width = Math.ceil(this.width * cosine + this.height * sine - 1e-8);
    const height = Math.ceil(this.width * sine + this.height * cosine - 1e-8);
    return this._transform(width, height, (ctx, original, oldWidth, oldHeight, newWidth, newHeight) => {
      ctx.imageSmoothingEnabled = angle % 90 !== 0;
      ctx.translate(newWidth / 2, newHeight / 2);
      ctx.rotate(radians);
      ctx.drawImage(original, -oldWidth / 2, -oldHeight / 2);
    });
  }

  flip(axis = 'horizontal') {
    const horizontal = axis === 'horizontal' || axis === 'x';
    return this._transform(this.width, this.height, (ctx, original, width, height) => {
      ctx.imageSmoothingEnabled = false;
      ctx.translate(horizontal ? width : 0, horizontal ? 0 : height);
      ctx.scale(horizontal ? -1 : 1, horizontal ? 1 : -1);
      ctx.drawImage(original, 0, 0);
    });
  }

  crop(x, y, width, height) {
    x = Math.max(0, Math.floor(Number(x)));
    y = Math.max(0, Math.floor(Number(y)));
    if (!Number.isFinite(x) || !Number.isFinite(y) || x >= this.width || y >= this.height) throw new RangeError('裁剪区域须位于画布内。');
    width = Math.min(Math.round(Number(width)), this.width - x);
    height = Math.min(Math.round(Number(height)), this.height - y);
    return this._transform(width, height, (ctx, original) => { ctx.drawImage(original, -x, -y); });
  }

  skew(horizontalDegrees = 0, verticalDegrees = 0) {
    const h = Number(horizontalDegrees);
    const v = Number(verticalDegrees);
    if (!Number.isFinite(h) || !Number.isFinite(v) || Math.abs(h) >= 85 || Math.abs(v) >= 85) {
      throw new RangeError('倾斜角度须大于 -85° 且小于 85°。');
    }
    const sx = Math.tan(h * Math.PI / 180);
    const sy = Math.tan(v * Math.PI / 180);
    if (Math.abs(1 - sx * sy) < 1e-8) throw new RangeError('此角度组合会将画布压为一条直线，请调整角度。');
    const corners = [[0, 0], [this.width, 0], [0, this.height], [this.width, this.height]].map(([x, y]) => [x + sx * y, y + sy * x]);
    const minX = Math.min(...corners.map(p => p[0]));
    const minY = Math.min(...corners.map(p => p[1]));
    const maxX = Math.max(...corners.map(p => p[0]));
    const maxY = Math.max(...corners.map(p => p[1]));
    return this._transform(Math.ceil(maxX - minX - 1e-8), Math.ceil(maxY - minY - 1e-8), (ctx, original) => {
      ctx.imageSmoothingEnabled = true;
      ctx.setTransform(1, sy, sx, 1, -minX, -minY);
      ctx.drawImage(original, 0, 0);
    });
  }

  invert() {
    const layer = this.activeLayer;
    if (!layer || layer.locked) return false;
    const ctx = layer.canvas.getContext('2d');
    const image = ctx.getImageData(0, 0, this.width, this.height);
    for (let i = 0; i < image.data.length; i += 4) {
      image.data[i] = 255 - image.data[i];
      image.data[i + 1] = 255 - image.data[i + 1];
      image.data[i + 2] = 255 - image.data[i + 2];
    }
    ctx.putImageData(image, 0, 0);
    return true;
  }

  clear() {
    const layer = this.activeLayer;
    if (!layer || layer.locked) return false;
    layer.canvas.getContext('2d').clearRect(0, 0, this.width, this.height);
    return true;
  }
}

export function getPixel(canvas, x, y) {
  x = Math.floor(Number(x));
  y = Math.floor(Number(y));
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return [0, 0, 0, 0];
  return Array.from(canvas.getContext('2d').getImageData(x, y, 1, 1).data);
}

function rgba(color) {
  if (Array.isArray(color) || color instanceof Uint8ClampedArray) {
    return [0, 1, 2, 3].map(i => Math.max(0, Math.min(255, Number(color[i] ?? (i === 3 ? 255 : 0)))));
  }
  if (typeof color === 'string' && /^#[\da-f]{6}([\da-f]{2})?$/i.test(color)) {
    return [parseInt(color.slice(1, 3), 16), parseInt(color.slice(3, 5), 16), parseInt(color.slice(5, 7), 16), color.length === 9 ? parseInt(color.slice(7, 9), 16) : 255];
  }
  const canvas = makeCanvas(1, 1);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = color || '#000000';
  ctx.fillRect(0, 0, 1, 1);
  return Array.from(ctx.getImageData(0, 0, 1, 1).data);
}

function matchesColor(data, index, target, tolerance) {
  const i = index * 4;
  if (Math.abs(data[i + 3] - target[3]) > tolerance) return false;
  // RGB in a fully transparent pixel has no visual meaning.
  if (data[i + 3] === 0 && target[3] === 0) return true;
  return Math.abs(data[i] - target[0]) <= tolerance && Math.abs(data[i + 1] - target[1]) <= tolerance && Math.abs(data[i + 2] - target[2]) <= tolerance;
}

function visitConnected(width, height, seeds, matches, write) {
  const visited = new Uint8Array(width * height);
  const stack = seeds;
  let count = 0;
  while (stack.length) {
    const seed = stack.pop();
    if (visited[seed] || !matches(seed)) continue;
    const y = Math.floor(seed / width);
    let x = seed % width;
    while (x > 0 && !visited[y * width + x - 1] && matches(y * width + x - 1)) x--;
    let above = false;
    let below = false;
    for (; x < width; x++) {
      const index = y * width + x;
      if (visited[index] || !matches(index)) break;
      visited[index] = 1;
      write(index);
      count++;
      if (y > 0) {
        const yes = !visited[index - width] && matches(index - width);
        if (yes && !above) stack.push(index - width);
        above = yes;
      }
      if (y + 1 < height) {
        const yes = !visited[index + width] && matches(index + width);
        if (yes && !below) stack.push(index + width);
        below = yes;
      }
    }
  }
  return count;
}

export function floodFill(canvas, x, y, color, tolerance = 24, { contiguous = true } = {}) {
  x = Math.floor(Number(x));
  y = Math.floor(Number(y));
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return 0;
  tolerance = Math.max(0, Math.min(255, Number(tolerance) || 0));
  const ctx = canvas.getContext('2d');
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = image.data;
  const start = y * canvas.width + x;
  const target = Array.from(data.slice(start * 4, start * 4 + 4));
  const replacement = rgba(color);
  if (tolerance === 0 && target.every((value, i) => value === replacement[i])) return 0;
  const matches = index => matchesColor(data, index, target, tolerance);
  let count = 0;
  const write = index => {
    const i = index * 4;
    if (data[i] !== replacement[0] || data[i + 1] !== replacement[1] || data[i + 2] !== replacement[2] || data[i + 3] !== replacement[3]) count++;
    data[i] = replacement[0]; data[i + 1] = replacement[1]; data[i + 2] = replacement[2]; data[i + 3] = replacement[3];
  };
  if (contiguous) visitConnected(canvas.width, canvas.height, [start], matches, write);
  else {
    for (let index = 0; index < canvas.width * canvas.height; index++) {
      if (matches(index)) write(index);
    }
  }
  if (count) ctx.putImageData(image, 0, 0);
  return count;
}

/** Removes only edge-connected colors sampled at the four corners; never an AI segmentation claim. */
export function removeBackground(canvas, tolerance = 30) {
  tolerance = Math.max(0, Math.min(255, Number(tolerance) || 0));
  const { width, height } = canvas;
  const ctx = canvas.getContext('2d');
  const image = ctx.getImageData(0, 0, width, height);
  const data = image.data;
  const corners = [0, width - 1, (height - 1) * width, width * height - 1].map(index => Array.from(data.slice(index * 4, index * 4 + 4)));
  const matches = index => corners.some(target => matchesColor(data, index, target, tolerance));
  const seeds = [];
  for (let x = 0; x < width; x++) { seeds.push(x); if (height > 1) seeds.push((height - 1) * width + x); }
  for (let y = 1; y < height - 1; y++) { seeds.push(y * width); if (width > 1) seeds.push(y * width + width - 1); }
  let changed = 0;
  visitConnected(width, height, seeds, matches, index => {
    const i = index * 4;
    if (data[i + 3]) { data[i + 3] = 0; changed++; }
  });
  if (changed) ctx.putImageData(image, 0, 0);
  return changed;
}
