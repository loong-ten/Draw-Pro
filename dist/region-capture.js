import { clampCaptureRect, createCaptureRect, moveCaptureRect, resizeCaptureRect, captureRegion, createCaptureDocument, captureFileName } from './capture-core.js';
import { icon } from './icons.js';

/** A read-only region tool. Its rectangle never becomes a floating paint selection. */
export function createRegionCapture(api, host) {
  let source = null, sourceWidth = 0, sourceHeight = 0, rect = null, drag = null;
  let lastSaved = null, previewSource = null, previewFrame = 0;
  const active = () => api.getState().tool === 'capture' && ['paint', 'retouch'].includes(api.getState().mode);
  const $ = selector => host.querySelector(selector);
  host.innerHTML = `
    <div class="capture-controls">
      <div class="capture-heading"><strong>${icon('capture')}区域截图</strong><span>原像素 · 保留透明</span><button type="button" data-capture="exit" title="退出区域截图" aria-label="退出区域截图">${icon('close')}</button></div>
      <div class="capture-coordinates">${[['x','X'],['y','Y'],['w','宽'],['h','高']].map(([key,label]) => `<label>${label}<input id="capture-${key}" data-coordinate="${key}" type="number" step="1" min="${key === 'w' || key === 'h' ? 1 : 0}" aria-label="截图${{x:'X坐标',y:'Y坐标',w:'宽度',h:'高度'}[key]}" disabled></label>`).join('')}<span>px</span><button type="button" data-capture="all" title="选中整张画布 Ctrl+A">整张画布</button><button type="button" data-capture="reset" disabled>重置选区</button></div>
      <div class="capture-save-row"><label class="capture-name">名称<input id="capture-name" type="text" maxlength="120" aria-label="截图素材名称" placeholder="自动命名"></label><label class="capture-open"><input id="capture-open" type="checkbox">保存后打开</label><button type="button" class="capture-preview-small" data-capture="preview" disabled>预览</button><button type="button" class="capture-save" data-capture="save" disabled>${icon('plus')}保存到工作区</button></div>
      <div class="capture-note" id="capture-note">在画布拖出矩形，拖动边框调整 · 方向键微调 · Enter 保存</div>
      <div class="capture-result" hidden><span role="status" aria-live="polite"></span><button type="button" data-capture="open-last">打开素材 ${icon('chevronRight')}</button></div>
    </div>
    <button type="button" class="capture-preview" data-capture="preview" disabled aria-label="预览截图大图"><canvas width="256" height="144" aria-label="截图实时预览"></canvas><span id="capture-preview-label">拖动选择区域</span></button>`;

  const modal = document.createElement('dialog');
  modal.id = 'capture-preview-dialog';
  modal.setAttribute('aria-labelledby', 'capture-preview-title');
  modal.innerHTML = `<div class="dialog-heading"><h2 id="capture-preview-title">区域截图预览</h2><button type="button" class="icon-button" data-preview="close" aria-label="关闭截图预览">${icon('close')}</button></div><div class="capture-preview-body"><div class="capture-preview-surface"><canvas aria-label="截图完整预览"></canvas></div><p class="capture-preview-meta"></p><p>按原始像素提取可见图层；透明区域随新素材保留。</p></div><div class="dialog-actions"><button type="button" class="button" data-preview="close">继续调整</button><button type="button" class="button primary" data-preview="save">保存到工作区</button></div>`;
  document.body.append(modal);

  function releasePointer() {
    if (!drag) return;
    const id = drag.pointerId;
    drag = null;
    if (api.board.hasPointerCapture?.(id)) api.board.releasePointerCapture(id);
  }

  function bindSource() {
    const d = api.getDoc();
    if (source === d && d?.width === sourceWidth && d?.height === sourceHeight) return;
    releasePointer();
    source = d; sourceWidth = d?.width || 0; sourceHeight = d?.height || 0;
    rect = null; previewSource = null;
    $('#capture-name').value = '';
    if (modal.open) modal.close();
  }

  function nextName() {
    return captureFileName(source?.name || '素材.png', $('#capture-name').value, api.getDocs().map(d => d.name));
  }

  function syncUI() {
    const enabled = !!rect && !!source;
    for (const input of host.querySelectorAll('[data-coordinate]')) {
      input.disabled = !enabled;
      if (document.activeElement !== input || drag) input.value = rect ? rect[input.dataset.coordinate] : '';
      input.max = input.dataset.coordinate === 'x' ? sourceWidth - (rect?.w || 1)
        : input.dataset.coordinate === 'y' ? sourceHeight - (rect?.h || 1)
        : input.dataset.coordinate === 'w' ? sourceWidth - (rect?.x || 0) : sourceHeight - (rect?.y || 0);
    }
    for (const action of ['save', 'reset', 'preview']) for (const button of host.querySelectorAll(`[data-capture="${action}"]`)) button.disabled = !enabled || !!drag;
    $('#capture-name').placeholder = captureFileName(source?.name || '素材.png', '', api.getDocs().map(d => d.name));
    $('#capture-preview-label').textContent = rect ? `${rect.w} × ${rect.h} px · 放大预览` : '拖动选择区域';
    $('#capture-note').textContent = rect
      ? `X ${rect.x} · Y ${rect.y} · ${rect.w} × ${rect.h} px　方向键 1px / Shift 10px · Enter 保存`
      : '在画布拖出矩形，拖动边框调整 · 方向键微调 · Enter 保存';
    const savedExists = lastSaved && api.getDocs().includes(lastSaved);
    $('.capture-result').hidden = !savedExists;
    if (savedExists) $('.capture-result span').textContent = `已新增：${lastSaved.name}`;
    api.renderSelectionStatus();
    schedulePreview();
  }

  function update(next) {
    rect = next;
    syncUI(); api.requestRender();
  }

  function schedulePreview() {
    if (previewFrame || !active()) return;
    previewFrame = requestAnimationFrame(() => {
      previewFrame = 0;
      const canvas = $('.capture-preview canvas'), context = canvas.getContext('2d');
      context.clearRect(0, 0, canvas.width, canvas.height);
      if (!rect || !source || !active()) return;
      previewSource = api.getComposite();
      const scale = Math.min((canvas.width - 12) / rect.w, (canvas.height - 12) / rect.h);
      const w = Math.max(1, Math.round(rect.w * scale)), h = Math.max(1, Math.round(rect.h * scale));
      context.imageSmoothingEnabled = false;
      context.drawImage(previewSource, rect.x, rect.y, rect.w, rect.h, Math.round((canvas.width - w) / 2), Math.round((canvas.height - h) / 2), w, h);
    });
  }

  function refresh() {
    bindSource();
    if (!active() && drag) cancel();
    host.hidden = !active();
    if (active()) syncUI();
  }

  function reset() { releasePointer(); update(null); }
  function selectAll() { bindSource(); if (source) update({ x: 0, y: 0, w: sourceWidth, h: sourceHeight }); }
  function getCanvas() {
    bindSource();
    if (!rect) throw Error('请先在画布上选择截图区域。');
    return captureRegion(api.getComposite(), rect);
  }

  function save() {
    try {
      bindSource();
      if (drag || !rect) { api.toast('请先在画布上选择并完成截图区域。'); return; }
      const result = createCaptureDocument(api.getComposite(), rect, nextName());
      const openAfter = $('#capture-open').checked;
      api.addDocument(result, { switchTo: openAfter });
      lastSaved = result;
      if (modal.open) modal.close();
      api.revealAsset(result);
      syncUI();
      api.toast(`已保存到工作区：${result.name} · ${result.width} × ${result.height} px`);
      if (openAfter) api.setTool('select');
    } catch (error) { api.toast(error.message || '截图未能保存，请重试。', true); }
  }

  function showPreview() {
    try {
      const cropped = getCanvas(), canvas = modal.querySelector('canvas');
      canvas.width = cropped.width; canvas.height = cropped.height;
      canvas.getContext('2d').putImageData(cropped.getContext('2d').getImageData(0, 0, cropped.width, cropped.height), 0, 0);
      const scale = Math.max(1, Math.min(8, Math.floor(640 / cropped.width), Math.floor(360 / cropped.height)));
      canvas.style.width = `${cropped.width * scale}px`;
      modal.querySelector('.capture-preview-meta').textContent = `${cropped.width} × ${cropped.height} px · ${nextName()}`;
      modal.showModal();
    } catch (error) { api.toast(error.message, true); }
  }

  function handles(view) {
    if (!rect) return [];
    const x = view.x + rect.x * view.z, y = view.y + rect.y * view.z, w = rect.w * view.z, h = rect.h * view.z;
    return [['nw',x,y],['n',x+w/2,y],['ne',x+w,y],['e',x+w,y+h/2],['se',x+w,y+h],['s',x+w/2,y+h],['sw',x,y+h],['w',x,y+h/2]];
  }

  function hitTest(p) {
    if (!rect) return null;
    const view = api.getView();
    const nearest = handles(view).map(([key,x,y]) => ({ key, distance: Math.hypot(p.sx-x, p.sy-y) })).sort((a,b) => a.distance-b.distance)[0];
    if (nearest?.distance <= 7) return nearest.key;
    if (p.x >= rect.x && p.x < rect.x + rect.w && p.y >= rect.y && p.y < rect.y + rect.h) return 'move';
    return null;
  }

  function pointerDown(event, p) {
    bindSource();
    if (!active() || !source || event.button !== 0 || drag) return;
    // The top/left ruler remains an interface surface, never a screenshot pixel.
    if (api.getState().showRulers && (p.sx < 24 || p.sy < 24)) return;
    const hit = hitTest(p);
    const previous = rect ? { ...rect } : null;
    if (!hit && (p.x < 0 || p.y < 0 || p.x >= sourceWidth || p.y >= sourceHeight)) return;
    drag = { pointerId: event.pointerId, kind: hit || 'create', start: { ...p }, previous };
    if (!hit) rect = createCaptureRect(p, p, sourceWidth, sourceHeight);
    syncUI(); api.requestRender();
  }

  function pointerMove(event, p) {
    if (!active()) return false;
    bindSource();
    if (drag) {
      if (event.pointerId !== drag.pointerId) return true;
      const dx = p.x - drag.start.x, dy = p.y - drag.start.y;
      if (drag.kind === 'create') rect = createCaptureRect(drag.start, p, sourceWidth, sourceHeight);
      else if (drag.kind === 'move') rect = moveCaptureRect(drag.previous, dx, dy, sourceWidth, sourceHeight);
      else rect = resizeCaptureRect(drag.previous, drag.kind, dx, dy, sourceWidth, sourceHeight);
      syncUI();
    }
    const hit = drag?.kind || hitTest(p);
    api.board.style.cursor = api.getState().space ? 'grab' : hit === 'move' ? 'move' : hit && hit !== 'create' ? `${hit}-resize` : 'crosshair';
    api.requestRender();
    return true;
  }

  function pointerUp(event, p) {
    if (!drag || drag.pointerId !== event.pointerId) return false;
    pointerMove(event, p);
    releasePointer(); syncUI(); api.requestRender();
    return true;
  }

  function cancel() {
    if (!drag) return;
    const previous = drag.previous;
    releasePointer(); update(previous);
  }

  function draw(context, view) {
    if (!active() || !source || !rect) return;
    const x = view.x + rect.x * view.z, y = view.y + rect.y * view.z, w = rect.w * view.z, h = rect.h * view.z;
    context.save();
    context.beginPath(); context.rect(view.x, view.y, sourceWidth * view.z, sourceHeight * view.z); context.clip();
    context.fillStyle = '#080c137d';
    context.fillRect(view.x, view.y, sourceWidth * view.z, y-view.y);
    context.fillRect(view.x, y+h, sourceWidth * view.z, (sourceHeight-rect.y-rect.h)*view.z);
    context.fillRect(view.x, y, x-view.x, h);
    context.fillRect(x+w, y, (sourceWidth-rect.x-rect.w)*view.z, h);
    context.restore(); context.save();
    context.strokeStyle = '#1a1e24'; context.lineWidth = 3; context.strokeRect(x,y,w,h);
    context.strokeStyle = '#ffc091'; context.lineWidth = 1.5; context.setLineDash([5,3]); context.strokeRect(x,y,w,h); context.setLineDash([]);
    context.fillStyle = '#ffd0ad'; context.strokeStyle = '#25282e'; context.lineWidth = 1;
    for (const [,hx,hy] of handles(view)) { context.fillRect(hx-3.5,hy-3.5,7,7); context.strokeRect(hx-3.5,hy-3.5,7,7); }
    const text = `${rect.w} × ${rect.h} px`;
    context.font = '11px system-ui, sans-serif';
    const width = context.measureText(text).width + 14;
    const ruler = api.getState().showRulers ? 24 : 0;
    const lx = Math.max(ruler + 4, Math.min(x, api.viewport.clientWidth - width - 5));
    const ly = y - 25 >= ruler ? y - 25 : Math.max(ruler + 4, Math.min(y+h+9, api.viewport.clientHeight-25));
    context.fillStyle = '#f2a76e'; context.fillRect(lx,ly,width,20);
    context.fillStyle = '#24201d'; context.fillText(text,lx+7,ly+14);
    context.restore();
    if (previewSource !== api.getComposite()) schedulePreview();
  }

  function handleAction(name) {
    if (!active()) return false;
    if (['delete','deselect'].includes(name)) { reset(); return true; }
    if (name === 'select-all') { selectAll(); return true; }
    if (name === 'copy' || name === 'cut') {
      try { api.setClipboard(getCanvas()); api.toast(name === 'cut' ? '截图工具保留原图，已复制截图区域。' : '截图区域已复制，可粘贴到工作区素材。'); }
      catch (error) { api.toast(error.message, true); }
      return true;
    }
    return false;
  }

  function handleKey(event) {
    if (!active()) return false;
    const key = event.key.toLowerCase();
    if (['delete','backspace','escape'].includes(key)) { event.preventDefault(); if (key === 'escape' && drag) cancel(); else reset(); return true; }
    if (event.ctrlKey || event.metaKey || event.altKey) return false;
    // Let native focused buttons keep Enter activation without a second save.
    if (key === 'enter' && event.target.closest?.('button')) return true;
    if (key === 'enter') { event.preventDefault(); if (!event.repeat) save(); return true; }
    if (['arrowleft','arrowright','arrowup','arrowdown'].includes(key)) {
      event.preventDefault();
      if (rect && !drag) { const step = event.shiftKey ? 10 : 1; update(moveCaptureRect(rect, key === 'arrowleft' ? -step : key === 'arrowright' ? step : 0, key === 'arrowup' ? -step : key === 'arrowdown' ? step : 0, sourceWidth, sourceHeight)); }
      return true;
    }
    return false;
  }

  function applyCoordinate(event) {
    const key = event.target.dataset.coordinate;
    if (!key || !rect) return;
    if (event.type === 'input' && (event.target.value.trim() === '' || !Number.isFinite(Number(event.target.value)))) return;
    const value = event.target.value.trim() === '' ? rect[key] : Number(event.target.value);
    if (key === 'x' || key === 'y') update(moveCaptureRect(rect, key === 'x' ? value-rect.x : 0, key === 'y' ? value-rect.y : 0, sourceWidth, sourceHeight));
    else update(clampCaptureRect({ ...rect, [key]: value }, sourceWidth, sourceHeight));
    if (event.type !== 'input') event.target.value = rect[key];
  }
  host.addEventListener('input', applyCoordinate);
  host.addEventListener('change', applyCoordinate);
  host.addEventListener('click', event => {
    const action = event.target.closest('[data-capture]')?.dataset.capture;
    if (action === 'save') save();
    else if (action === 'all') selectAll();
    else if (action === 'reset') reset();
    else if (action === 'preview') showPreview();
    else if (action === 'exit') api.setTool('select');
    else if (action === 'open-last' && api.getDocs().includes(lastSaved)) { api.switchDoc(lastSaved.id); api.setTool('select'); }
  });
  modal.addEventListener('click', event => {
    const action = event.target.closest('[data-preview]')?.dataset.preview;
    if (action === 'save') save();
    else if (action === 'close') modal.close();
  });
  api.board.addEventListener('lostpointercapture', event => { if (drag?.pointerId === event.pointerId) cancel(); });
  window.addEventListener('blur', cancel);
  return { refresh, draw, pointerDown, pointerMove, pointerUp, cancel, handleAction, handleKey,
    isPreviewOpen: () => modal.open,
    getRect: () => active() && source === api.getDoc() ? rect : null,
    activate(seed = null) { bindSource(); if (seed) rect = clampCaptureRect(seed, sourceWidth, sourceHeight); refresh(); api.requestRender(); },
  };
}
