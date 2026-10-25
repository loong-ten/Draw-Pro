import { canvasFrameFromDrag, applyCanvasFrame } from './canvas-frame-core.js';

const HANDLES = { n: '上', ne: '右上', e: '右', se: '右下', s: '下', sw: '左下', w: '左', nw: '左上' };
const CURSORS = { n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize' };
const MAX_WORKSPACE_PIXELS = 128 * 1024 * 1024;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

/** Screen-space handles; only the final pointer release writes document pixels. */
export function createCanvasFrame(api, host) {
  host.innerHTML = `<div class="canvas-frame-outline" aria-hidden="true"></div>${Object.entries(HANDLES).map(([handle, label]) => `<button type="button" class="canvas-frame-handle frame-${handle}" data-frame-handle="${handle}" aria-label="拖动${label}边界调整画幅" title="${label}边界：拖动调整画幅 · 方向键 1px / Shift 10px"><span></span></button>`).join('')}<div class="canvas-frame-readout" role="status" aria-live="polite" hidden></div>`;
  const outline = host.querySelector('.canvas-frame-outline');
  const readout = host.querySelector('.canvas-frame-readout');
  const buttons = [...host.querySelectorAll('[data-frame-handle]')];
  let drag = null;

  function enabled() {
    const state = api.getState();
    return !!api.getDoc() && ['paint', 'retouch'].includes(state.mode)
      && !['capture', 'hand'].includes(state.tool) && !state.space && !state.selection && !state.gesture;
  }

  function targetValid(item) {
    const d = api.getDoc(), state = api.getState();
    return enabled() && d === item.doc && api.getDocs().includes(d) && d.revision === item.revision
      && d.width === item.width && d.height === item.height && state.mode === item.mode && state.tool === item.tool
      && d.layers.length === item.layers.length && d.layers.every((layer, i) => layer === item.layers[i] && layer.canvas === item.canvases[i]);
  }

  function release() {
    const previous = drag;
    drag = null;
    host.classList.remove('is-dragging');
    api.viewport.classList.remove('is-resizing-frame');
    api.viewport.style.removeProperty('--frame-cursor');
    if (previous?.button.hasPointerCapture?.(previous.pointerId)) {
      try { previous.button.releasePointerCapture(previous.pointerId); } catch (_) { /* Pointer already released. */ }
    }
    return previous;
  }

  function cancel() {
    if (!drag) return false;
    const previous = release();
    // A later explicit zoom/pan must not be overwritten by cancellation.
    const view = previous.doc.view;
    if (view && view.x === previous.view.x && view.y === previous.view.y && view.z === previous.view.z) {
      previous.doc.view = { ...previous.view };
    }
    readout.hidden = true;
    api.requestRender();
    return true;
  }

  function getPreview() {
    if (drag && !targetValid(drag)) cancel();
    return drag ? { ...drag.frame } : null;
  }

  function workspaceFits(item) {
    const total = api.getDocs().reduce((sum, d) => sum + (d === item.doc ? item.frame.width * item.frame.height : d.width * d.height) * d.layers.length, 0);
    return total <= MAX_WORKSPACE_PIXELS;
  }

  function refresh() {
    if (drag && !targetValid(drag)) cancel();
    host.hidden = !enabled();
    if (host.hidden) return;
    const d = api.getDoc(), v = api.getView(), frame = drag?.frame || { x: 0, y: 0, width: d.width, height: d.height };
    const x = v.x + frame.x * v.z, y = v.y + frame.y * v.z, w = frame.width * v.z, h = frame.height * v.z;
    const ruler = api.getState().showRulers ? 24 : 0;
    host.style.clipPath = `inset(${ruler}px 0 0 ${ruler}px)`;
    Object.assign(outline.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
    for (const button of buttons) {
      const key = button.dataset.frameHandle;
      const corner = key.length === 2;
      const horizontal = key === 'n' || key === 's';
      const vertical = key === 'e' || key === 'w';
      Object.assign(button.style, {
        left: `${x + (key.includes('e') ? w : key.includes('w') ? 0 : w / 2)}px`,
        top: `${y + (key.includes('s') ? h : key.includes('n') ? 0 : h / 2)}px`,
        width: `${horizontal ? Math.max(12, w - 16) : corner ? 20 : 12}px`,
        height: `${vertical ? Math.max(12, h - 16) : corner ? 20 : 12}px`,
      });
    }
    readout.hidden = !drag;
    if (drag) {
      const fits = workspaceFits(drag);
      host.classList.toggle('is-invalid', !fits);
      const cropping = frame.x > 0 || frame.y > 0 || frame.x + frame.width < drag.width || frame.y + frame.height < drag.height;
      readout.textContent = `${frame.width} × ${frame.height} px · ${!fits ? '超出工作区容量，请缩小' : cropping ? '收缩裁边' : '扩展透明'} · Esc 取消`;
      readout.style.left = `${clamp(x + w / 2, ruler + 145, Math.max(ruler + 145, api.viewport.clientWidth - 145))}px`;
      readout.style.top = `${clamp(y - 36, ruler + 6, Math.max(ruler + 6, api.viewport.clientHeight - 44))}px`;
    } else host.classList.remove('is-invalid');
  }

  function snapshot(button, handle) {
    const d = api.getDoc(), state = api.getState();
    return { doc: d, revision: d.revision, width: d.width, height: d.height,
      layers: [...d.layers], canvases: d.layers.map(layer => layer.canvas), view: { ...api.getView() },
      mode: state.mode, tool: state.tool, handle, button, frame: { x: 0, y: 0, width: d.width, height: d.height } };
  }

  function update(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (!targetValid(drag)) { cancel(); return; }
    drag.frame = canvasFrameFromDrag(drag, drag.handle,
      (event.clientX - drag.clientX) / drag.view.z, (event.clientY - drag.clientY) / drag.view.z);
    refresh(); api.requestRender();
  }

  function commit(item) {
    if (!targetValid(item)) return false;
    api.assertIdle();
    const applied = applyCanvasFrame(item.doc, item.frame, { documents: api.getDocs(), maxPixels: MAX_WORKSPACE_PIXELS });
    if (applied) {
      item.doc.view = { ...item.view, x: item.view.x + item.frame.x * item.view.z, y: item.view.y + item.frame.y * item.view.z, fit: false };
      // Raster/history commit has succeeded. A later UI error must never report
      // a failed edit or restore a view belonging to the old frame.
      try {
        api.onCommit();
        api.toast(`画幅已调整为 ${item.frame.width} × ${item.frame.height} px · 可撤销`);
      } catch (error) {
        console.error('画幅已调整，界面刷新未完成。', error);
        try { api.toast('画幅已调整，可撤销；请重新选择素材以刷新界面。', true); } catch (_) { /* The document remains committed. */ }
      }
    } else item.doc.view = { ...item.view };
    return applied;
  }

  host.addEventListener('pointerdown', event => {
    const button = event.target.closest('[data-frame-handle]');
    if (button && event.button === 1) { event.preventDefault(); event.stopPropagation(); cancel(); api.pan(event); return; }
    if (!button || event.button !== 0 || event.isPrimary === false || !enabled()) return;
    event.preventDefault(); event.stopPropagation();
    try {
      cancel(); api.prepare();
      if (!enabled()) return;
      button.focus({ preventScroll: true });
      drag = { ...snapshot(button, button.dataset.frameHandle), pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY };
      drag.doc.view = { ...drag.view, fit: false };
      button.setPointerCapture(event.pointerId);
      host.classList.add('is-dragging');
      api.viewport.classList.add('is-resizing-frame');
      api.viewport.style.setProperty('--frame-cursor', CURSORS[drag.handle]);
      refresh(); api.requestRender();
    } catch (error) { cancel(); api.toast(error.message || '无法调整画幅，请重试。', true); }
  });
  host.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault(); event.stopPropagation();
    try { update(event); } catch (error) { cancel(); api.toast(error.message, true); }
  });
  host.addEventListener('pointerup', event => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault(); event.stopPropagation();
    let completed = null;
    try {
      update(event);
      if (drag) { completed = release(); commit(completed); }
    } catch (error) {
      if (completed) completed.doc.view = { ...completed.view };
      cancel(); api.toast(error.message || '画幅未更改，请重试。', true);
    }
    readout.hidden = true; refresh(); api.requestRender();
  });
  for (const name of ['pointercancel', 'lostpointercapture']) host.addEventListener(name, event => {
    if (drag?.pointerId === event.pointerId) cancel();
  });
  host.addEventListener('click', event => { if (event.target.closest('[data-frame-handle]')) event.stopPropagation(); });
  host.addEventListener('contextmenu', event => event.preventDefault());
  host.addEventListener('keydown', event => {
    const button = event.target.closest('[data-frame-handle]');
    if (!button || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); return; }
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    if (drag || !enabled()) return;
    try {
      api.prepare();
      const item = snapshot(button, button.dataset.frameHandle), step = event.shiftKey ? 10 : 1;
      item.frame = canvasFrameFromDrag(item, item.handle,
        event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0,
        event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0);
      commit(item); refresh(); api.requestRender();
    } catch (error) { api.toast(error.message, true); }
  });
  document.addEventListener('keydown', event => {
    if (drag && event.key === 'Escape') {
      event.preventDefault(); event.stopImmediatePropagation(); cancel();
    }
  }, true);
  window.addEventListener('blur', cancel);
  window.addEventListener('resize', cancel);
  return { cancel, refresh, getPreview, isDragging: () => !!drag };
}
