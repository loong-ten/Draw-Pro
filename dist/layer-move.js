import { makeCanvas } from './core.js';
import { findAlphaBounds } from './padding-core.js';

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const signed = value => value >= 0 ? `+${value}` : String(value);
const boundaryMessage = '已到达画布边界，已保留全部图层像素。可先扩展画布，或关闭“保持内容在画布内”后移动（超出部分会裁切）。';

// Every preview starts from one immutable ImageData snapshot. The document is
// untouched until release, so cancellation and automatic drafts stay safe.
export function createLayerMove(api) {
  let cached = null, drag = null, lastMove = null;
  const active = () => api.getState().tool === 'move' && ['paint', 'retouch'].includes(api.getState().mode);
  const keepInside = () => api.getState().moveKeepInside === true;
  const repaint = () => { api.renderSelectionStatus(); api.requestRender(); };

  function releaseDrag() {
    const previous = drag;
    drag = null; // releasePointerCapture can synchronously emit lostpointercapture.
    if (previous && api.board.hasPointerCapture?.(previous.pointerId)) {
      try { api.board.releasePointerCapture(previous.pointerId); } catch (_) { /* Already released by the browser. */ }
    }
    return previous;
  }

  function validTarget(item) {
    const d = api.getDoc(), state = api.getState();
    return active() && d === item.doc && d.activeLayer === item.layer && d.layers.includes(item.layer)
      && d.revision === item.revision && d.width === item.width && d.height === item.height
      && item.layer.canvas === item.sourceCanvas && !item.layer.locked && item.layer.visible && item.layer.opacity > 0
      && state.mode === item.mode && state.tool === item.tool && keepInside() === item.keepInside;
  }

  function refresh() {
    const enabled = active(), d = api.getDoc(), layer = d?.activeLayer, state = api.getState();
    const cancelled = !!drag && !validTarget(drag);
    if (cancelled) { releaseDrag(); lastMove = null; }
    if (!enabled || !d || !layer) {
      cached = null; lastMove = null;
    } else if (!cached || cached.doc !== d || cached.layer !== layer || cached.canvas !== layer.canvas
      || cached.revision !== d.revision || cached.width !== d.width || cached.height !== d.height
      || cached.mode !== state.mode || cached.tool !== state.tool || cached.locked !== layer.locked
      || cached.visible !== layer.visible || cached.opacity !== layer.opacity) {
      const pixels = layer.canvas.getContext('2d').getImageData(0, 0, d.width, d.height);
      cached = { doc: d, layer, canvas: layer.canvas, revision: d.revision, width: d.width, height: d.height,
        mode: state.mode, tool: state.tool, locked: layer.locked, visible: layer.visible, opacity: layer.opacity,
        pixels, bounds: findAlphaBounds(pixels) };
      if (lastMove && (lastMove.doc !== d || lastMove.layer !== layer || lastMove.revision !== d.revision)) lastMove = null;
    }
    if (cancelled) repaint();
  }

  function editable() {
    const layer = cached?.layer;
    if (!layer) { api.toast('请先选择要移动的图层。', true); return false; }
    if (layer.locked) { api.toast('当前图层已锁定，请先解锁后移动。', true); return false; }
    if (!layer.visible || layer.opacity <= 0) { api.toast('当前图层不可见，请先显示图层并提高不透明度。', true); return false; }
    if (!cached.bounds) { api.toast('当前图层为空，没有可移动的像素。'); return false; }
    return true;
  }

  function hitLayer(d, p) {
    const x = Math.floor(p.x), y = Math.floor(p.y);
    for (let i = d.layers.length - 1; i >= 0; i--) {
      const layer = d.layers[i];
      if (!layer.visible || layer.opacity <= 0) continue;
      // Locked content is still a hit: never silently move a layer underneath it.
      if (layer.canvas.getContext('2d').getImageData(x, y, 1, 1).data[3] > 0) return layer;
    }
    return null;
  }

  function snapshot() {
    const state = api.getState();
    return { doc: cached.doc, layer: cached.layer, sourceCanvas: cached.canvas, revision: cached.revision,
      width: cached.width, height: cached.height, source: cached.pixels, bounds: { ...cached.bounds },
      mode: state.mode, tool: state.tool, keepInside: keepInside(), dx: 0, dy: 0, warned: false,
      preview: null, previewBounds: { ...cached.bounds } };
  }

  function constrain(item, dx, dy) {
    let x = Math.round(dx), y = Math.round(dy);
    if (item.keepInside) {
      const b = item.bounds;
      x = clamp(x, -b.x, item.width - b.x - b.width);
      y = clamp(y, -b.y, item.height - b.y - b.height);
      if ((x !== Math.round(dx) || y !== Math.round(dy)) && !item.warned) {
        item.warned = true; api.toast(boundaryMessage);
      }
    }
    return { dx: x || 0, dy: y || 0 };
  }

  function translate(canvas, source, dx, dy) {
    const context = canvas.getContext('2d');
    context.save();
    try {
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, canvas.width, canvas.height);
      // putImageData ignores alpha, blending and transforms; each pixel moves
      // once, including alpha=1 edge pixels and semi-transparent colors.
      context.putImageData(source, dx, dy);
    } finally { context.restore(); }
  }

  function translatedBounds(item) {
    const b = item.bounds, x = b.x + item.dx, y = b.y + item.dy;
    if (x >= 0 && y >= 0 && x + b.width <= item.width && y + b.height <= item.height) return { ...b, x, y };
    // Clipping is the default; derive the actual remaining alpha box
    // from the snapshot without another canvas readback.
    const left = Math.max(b.x, -item.dx), top = Math.max(b.y, -item.dy);
    const right = Math.min(b.x + b.width, item.width - item.dx), bottom = Math.min(b.y + b.height, item.height - item.dy);
    if (left >= right || top >= bottom) return null;
    let minX = right, minY = bottom, maxX = -1, maxY = -1;
    for (let sy = top; sy < bottom; sy++) for (let sx = left; sx < right; sx++) {
      if (!item.source.data[(sy * item.width + sx) * 4 + 3]) continue;
      minX = Math.min(minX, sx); minY = Math.min(minY, sy); maxX = Math.max(maxX, sx); maxY = Math.max(maxY, sy);
    }
    return maxX < minX || maxY < minY ? null : { x: minX + item.dx, y: minY + item.dy, width: maxX - minX + 1, height: maxY - minY + 1 };
  }

  function updateDrag(event, p) {
    if (!drag || !Number.isFinite(p?.x) || !Number.isFinite(p?.y)) return;
    let dx = p.x - drag.start.x, dy = p.y - drag.start.y;
    if (event.shiftKey) { if (Math.abs(dx) >= Math.abs(dy)) dy = 0; else dx = 0; }
    const next = constrain(drag, dx, dy);
    if (next.dx === drag.dx && next.dy === drag.dy) return;
    Object.assign(drag, next);
    if (!drag.preview) drag.preview = { docId: drag.doc.id, revision: drag.revision, layerId: drag.layer.id, canvas: makeCanvas(drag.width, drag.height) };
    translate(drag.preview.canvas, drag.source, drag.dx, drag.dy);
    drag.previewBounds = translatedBounds(drag);
    repaint();
  }

  function commit(item) {
    if ((!item.dx && !item.dy) || !validTarget(item)) return false;
    const d = item.doc, previous = { history: d.history, historyIndex: d.historyIndex, revision: d.revision,
      dirty: d.dirty, composite: d._composite, thumb: d._thumb, lastAction: api.getState().lastAction };
    translate(item.layer.canvas, item.source, item.dx, item.dy);
    d._composite = null; d._thumb = null;
    try { api.changed('移动图层'); }
    catch (error) {
      translate(item.layer.canvas, item.source, 0, 0);
      Object.assign(d, { history: previous.history, historyIndex: previous.historyIndex, revision: previous.revision,
        dirty: previous.dirty, _composite: previous.composite, _thumb: previous.thumb });
      api.getState().lastAction = previous.lastAction;
      cached = null; lastMove = null; refresh(); repaint();
      throw error;
    }
    refresh();
    lastMove = { doc: d, layer: item.layer, revision: d.revision, dx: item.dx, dy: item.dy };
    repaint();
    return true;
  }

  function pointerDown(event, p) {
    refresh();
    if (!active()) return false;
    // An active Move tool consumes non-left clicks without entering a paint
    // fallback. The app handles Space, middle-button pan, rulers and Alt first.
    if (event.button !== 0 || drag) return true;
    const d = api.getDoc();
    if (!d || !Number.isFinite(p?.x) || !Number.isFinite(p?.y) || p.x < 0 || p.y < 0 || p.x >= d.width || p.y >= d.height) return true;
    if (api.getState().moveAutoSelect || event.ctrlKey || event.metaKey) {
      const layer = hitLayer(d, p);
      if (!layer) { api.toast('此处没有可选择的图层内容。'); return true; }
      if (layer !== d.activeLayer) { d.activeLayerId = layer.id; refresh(); api.renderUI(); }
    }
    refresh();
    if (!editable()) return true;
    lastMove = null;
    drag = { ...snapshot(), pointerId: event.pointerId, start: { x: p.x, y: p.y } };
    try { if (!api.board.hasPointerCapture?.(event.pointerId)) api.board.setPointerCapture?.(event.pointerId); } catch (_) { /* The app may already own capture. */ }
    api.board.style.cursor = 'move'; repaint();
    return true;
  }

  function pointerMove(event, p) {
    const hadDrag = !!drag;
    refresh();
    if (!active()) return hadDrag;
    if (drag && event.pointerId === drag.pointerId) updateDrag(event, p);
    api.board.style.cursor = api.getState().space ? 'grab' : 'move';
    return true;
  }

  function pointerUp(event, p) {
    if (!drag || event.pointerId !== drag.pointerId) return false;
    refresh();
    if (!drag) return true;
    updateDrag(event, p);
    const completed = releaseDrag();
    if (!commit(completed)) repaint();
    return true;
  }

  function cancel() {
    if (!drag) return false;
    releaseDrag(); lastMove = null; repaint();
    return true;
  }

  function getPreview() {
    refresh();
    return drag && (drag.dx || drag.dy) ? drag.preview : null;
  }

  function getBounds() {
    refresh();
    const bounds = drag ? drag.previewBounds : cached?.bounds;
    return bounds ? { ...bounds } : null;
  }

  function getStatus() {
    refresh();
    if (!active()) return '';
    if (!cached) return '请选择要移动的图层';
    if (cached.layer.locked) return '图层已锁定 · 解锁后可移动';
    if (!cached.layer.visible || cached.layer.opacity <= 0) return '图层不可见 · 显示图层并提高不透明度后移动';
    const bounds = drag ? drag.bounds : cached.bounds;
    if (!bounds) return '当前图层为空 · 添加图像后可移动';
    const delta = drag || lastMove || { dx: 0, dy: 0 };
    return `图层 ${bounds.width} × ${bounds.height} px · 位移 ${signed(delta.dx)} / ${signed(delta.dy)} px`;
  }

  function draw(context, view = api.getView()) {
    refresh();
    if (!active() || !cached?.layer.visible || cached.layer.opacity <= 0) return;
    const b = drag ? drag.previewBounds : cached.bounds;
    if (!b) return;
    context.save();
    try {
      context.setLineDash([6, 4]); context.lineWidth = 2; context.strokeStyle = '#171b20';
      context.strokeRect(view.x + b.x * view.z, view.y + b.y * view.z, b.width * view.z, b.height * view.z);
      context.lineWidth = 1; context.strokeStyle = cached.layer.locked ? '#a8adb7' : '#f2bc7b';
      context.strokeRect(view.x + b.x * view.z, view.y + b.y * view.z, b.width * view.z, b.height * view.z);
    } finally { context.restore(); }
  }

  function handleKey(event) {
    refresh();
    if (!active()) return false;
    const key = event.key.toLowerCase();
    if (key === 'escape' && drag) { event.preventDefault(); cancel(); return true; }
    if (event.ctrlKey || event.metaKey || event.altKey || !['arrowleft', 'arrowright', 'arrowup', 'arrowdown'].includes(key)) return false;
    if (event.target?.closest?.('input,textarea,select,[contenteditable]:not([contenteditable=false])')) return false;
    event.preventDefault();
    if (drag || !editable()) return true;
    lastMove = null;
    const item = snapshot(), step = event.shiftKey ? 10 : 1;
    Object.assign(item, constrain(item, key === 'arrowleft' ? -step : key === 'arrowright' ? step : 0,
      key === 'arrowup' ? -step : key === 'arrowdown' ? step : 0));
    if (!commit(item)) repaint();
    return true;
  }

  api.board.addEventListener('lostpointercapture', event => { if (drag?.pointerId === event.pointerId) cancel(); });
  api.board.addEventListener('pointercancel', event => { if (drag?.pointerId === event.pointerId) cancel(); });
  globalThis.window?.addEventListener('blur', cancel);

  return { pointerDown, pointerMove, pointerUp, draw, cancel, refresh, getPreview, getBounds, getStatus, handleKey };
}
