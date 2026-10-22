/* Geometry shared by the composition viewport, arrangements and raster exports. */
export const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
export const radians = degrees => degrees * Math.PI / 180;
export function rotateVector(x, y, degrees) {
  const c = Math.cos(radians(degrees)), s = Math.sin(radians(degrees));
  return { x: x * c - y * s, y: x * s + y * c };
}
export function corners(layer) {
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => {
    const p = rotateVector(sx * layer.w / 2, sy * layer.h / 2, layer.rotation || 0);
    return { x: layer.x + layer.w / 2 + p.x, y: layer.y + layer.h / 2 + p.y };
  });
}
export function bounds(layers) {
  if (!layers.length) return null;
  let x = Infinity, y = Infinity, right = -Infinity, bottom = -Infinity;
  for (const layer of layers) for (const p of corners(layer)) {
    x = Math.min(x, p.x); y = Math.min(y, p.y);
    right = Math.max(right, p.x); bottom = Math.max(bottom, p.y);
  }
  return { x, y, right, bottom, w: right - x, h: bottom - y };
}
export function exportBounds(layers, padding = 0) {
  const b = bounds(layers);
  if (!b) return null;
  const pad = clamp(Math.round(Number(padding) || 0), 0, 2000);
  const x = Math.floor(b.x + 1e-7) - pad, y = Math.floor(b.y + 1e-7) - pad;
  const right = Math.ceil(b.right - 1e-7) + pad, bottom = Math.ceil(b.bottom - 1e-7) + pad;
  return { x, y, right, bottom, w: Math.max(1, right - x), h: Math.max(1, bottom - y) };
}
export function scaleProportionally(layer, factor) {
  const safe = clamp(factor, Math.max(1 / layer.w, 1 / layer.h), Math.min(30000 / layer.w, 30000 / layer.h));
  layer.w *= safe; layer.h *= safe;
  return layer;
}
export function layoutLayers(layers, { mode = 'row', gap = 24, columns = 3, normalize = false } = {}) {
  if (!layers.length) return [];
  const output = layers.map(layer => ({ ...layer })), b = bounds(output);
  gap = clamp(Number(gap) || 0, 0, 2000);
  const cols = clamp(Math.floor(Number(columns) || 1), 1, Math.min(30, output.length));
  const targetW = output[0].w, targetH = output[0].h;
  for (const layer of output) {
    layer.rotation = 0;
    if (normalize) scaleProportionally(layer, mode === 'row' ? targetH / layer.h : targetW / layer.w);
  }
  let x = Math.round(b.x), y = Math.round(b.y);
  if (mode === 'row') for (const l of output) { l.x = x; l.y = y; x += l.w + gap; }
  else if (mode === 'column') for (const l of output) { l.x = x; l.y = y; y += l.h + gap; }
  else {
    const widths = Array(cols).fill(0), heights = [];
    output.forEach((l, i) => { widths[i % cols] = Math.max(widths[i % cols], l.w); heights[Math.floor(i / cols)] = Math.max(heights[Math.floor(i / cols)] || 0, l.h); });
    output.forEach((l, i) => {
      l.x = x + widths.slice(0, i % cols).reduce((s, v) => s + v + gap, 0);
      l.y = y + heights.slice(0, Math.floor(i / cols)).reduce((s, v) => s + v + gap, 0);
    });
  }
  return output;
}
export function alignLayers(layers, mode) {
  const b = bounds(layers);
  if (!b) return [];
  return layers.map(layer => {
    const l = { ...layer }, lb = bounds([l]);
    if (mode === 'left') l.x += b.x - lb.x;
    if (mode === 'center') l.x += b.x + b.w / 2 - lb.x - lb.w / 2;
    if (mode === 'right') l.x += b.right - lb.right;
    if (mode === 'top') l.y += b.y - lb.y;
    if (mode === 'middle') l.y += b.y + b.h / 2 - lb.y - lb.h / 2;
    if (mode === 'bottom') l.y += b.bottom - lb.bottom;
    return l;
  });
}
export function hitLayer(layers, p) {
  for (const layer of [...layers].reverse()) {
    if (!layer.visible || layer.locked) continue;
    const r = rotateVector(p.x - layer.x - layer.w / 2, p.y - layer.y - layer.h / 2, -(layer.rotation || 0));
    if (Math.abs(r.x) <= layer.w / 2 && Math.abs(r.y) <= layer.h / 2) return layer;
  }
  return null;
}
export function snapTranslation(movingLayers, otherLayers, threshold, referenceGuides = []) {
  const moving = bounds(movingLayers);
  if (!moving) return { dx: 0, dy: 0, guides: [] };
  const tx = [], ty = [];
  for (const other of otherLayers) {
    const b = bounds([other]);
    tx.push(b.x, b.x + b.w / 2, b.right); ty.push(b.y, b.y + b.h / 2, b.bottom);
  }
  for (const g of referenceGuides) {
    if (g.type === 'v' || g.type === 'point') tx.push(g.x);
    if (g.type === 'h' || g.type === 'point') ty.push(g.y);
  }
  let bestX = threshold, bestY = threshold, dx = 0, dy = 0, gx, gy;
  for (const target of tx) for (const n of [moving.x, moving.x + moving.w / 2, moving.right]) {
    const d = target - n; if (Math.abs(d) < bestX) { bestX = Math.abs(d); dx = d; gx = target; }
  }
  for (const target of ty) for (const n of [moving.y, moving.y + moving.h / 2, moving.bottom]) {
    const d = target - n; if (Math.abs(d) < bestY) { bestY = Math.abs(d); dy = d; gy = target; }
  }
  const guides = [];
  if (gx !== undefined) guides.push({ axis: 'x', value: gx });
  if (gy !== undefined) guides.push({ axis: 'y', value: gy });
  return { dx, dy, guides };
}
