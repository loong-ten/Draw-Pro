import { uid } from './core.js';
import { icon } from './icons.js';
import { MAX_SLOTS } from './composition-slots.js';

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const pointCopy = point => ({ u: point.u, v: point.v });
const readableNumber = value => Math.round(value * 1000) / 1000;

/** Edit source-image anchors in a draft. Applying the draft is owned by the composer. */
export function createSlotEditor({ mount, getLayer, getAsset, onApply, notify }) {
  const prefix = 'cmp-slot-' + uid();
  const dialog = document.createElement('dialog');
  dialog.className = 'cmp-slot-editor';
  dialog.setAttribute('aria-labelledby', prefix + '-title');
  dialog.innerHTML = [
    '<header class="cmp-dialog-header"><div><span>ASSEMBLY ANCHORS</span><h2 id="' + prefix + '-title">编辑卡槽与对接点</h2></div><button type="button" data-slot-action="close" aria-label="关闭锚点编辑器">' + icon('close') + '</button></header>',
    '<div class="cmp-slot-tabs" role="tablist" aria-label="锚点类型"><button type="button" role="tab" data-slot-mode="slots" id="' + prefix + '-slots-tab" aria-controls="' + prefix + '-panel">' + icon('target') + '主体卡槽<span class="cmp-slot-tab-count">0 / 6</span></button><button type="button" role="tab" data-slot-mode="dock" id="' + prefix + '-dock-tab" aria-controls="' + prefix + '-panel">' + icon('link') + '配件对接点</button></div>',
    '<div class="cmp-slot-editor-body" role="tabpanel" id="' + prefix + '-panel">',
    '<div class="cmp-slot-preview"><div class="cmp-slot-preview-toolbar"><div><strong class="cmp-slot-source-name"></strong><span class="cmp-slot-source-size"></span></div><div><button type="button" data-slot-action="zoom-out" aria-label="缩小素材预览">−</button><span class="cmp-slot-zoom" aria-live="polite">100%</span><button type="button" data-slot-action="zoom-in" aria-label="放大素材预览">+</button><button type="button" data-slot-action="fit" title="适应预览">' + icon('fit') + '适应</button><button type="button" data-slot-action="actual" title="原始像素尺寸">1:1</button></div></div>',
    '<div class="cmp-slot-preview-scroll" tabindex="0" aria-label="素材锚点编辑预览"><div class="cmp-slot-preview-surface"><img class="cmp-slot-source-image" alt="当前素材的原始图像" draggable="false"><div class="cmp-slot-markers"></div></div></div>',
    '<div class="cmp-slot-preview-caption"><span class="cmp-slot-preview-instruction"></span><span class="cmp-slot-preview-coordinates"></span></div></div>',
    '<aside class="cmp-slot-editor-controls"><div class="cmp-slot-control-heading"><h3 class="cmp-slot-mode-title">主体卡槽</h3><span class="cmp-slot-mode-count"></span></div><p class="cmp-slot-mode-description"></p>',
    '<div class="cmp-slot-list" role="group" aria-label="卡槽列表"></div><button type="button" data-slot-action="add" class="cmp-primary-soft cmp-slot-add">' + icon('plus') + '添加中心卡槽</button>',
    '<div class="cmp-slot-point-fields"><label class="cmp-slot-name-label">卡槽名称<input class="cmp-slot-point-name" maxlength="40" aria-label="卡槽名称" placeholder="例如：顶部、左侧、手持点"></label><div class="cmp-slot-point-heading"><span class="cmp-slot-current-point"></span><span>原图像素</span></div>',
    '<div class="cmp-field-grid"><label><span>X</span><input class="cmp-slot-point-x" type="number" min="0" step="1" aria-label="锚点原图 X 坐标"><small>px</small></label><label><span>Y</span><input class="cmp-slot-point-y" type="number" min="0" step="1" aria-label="锚点原图 Y 坐标"><small>px</small></label></div>',
    '<div class="cmp-slot-point-actions"><button type="button" data-slot-action="center">' + icon('crosshair') + '重置到中心</button><button type="button" data-slot-action="delete" class="cmp-slot-delete">' + icon('trash') + '删除卡槽</button></div></div>',
    '<div class="cmp-slot-empty-tip">点击素材上的位置添加卡槽，或先添加中心卡槽，再输入精确坐标。</div><p class="cmp-slot-editor-note">卡槽与对接点会随素材的位置、尺寸和翻转更新。标记不会出现在导出图片中。</p></aside></div>',
    '<footer class="cmp-dialog-footer"><span>保存后，已连接配件的对接位置会同步更新。</span><div><button type="button" data-slot-action="close">取消</button><button type="button" data-slot-action="save" class="cmp-primary">' + icon('check') + '保存锚点</button></div></footer>',
  ].join('');
  mount.append(dialog);

  const $ = selector => dialog.querySelector(selector);
  const $$ = selector => [...dialog.querySelectorAll(selector)];
  const scroll = $('.cmp-slot-preview-scroll');
  const surface = $('.cmp-slot-preview-surface');
  const image = $('.cmp-slot-source-image');
  const markers = $('.cmp-slot-markers');
  let layerId = null, assetId = null, asset = null, mode = 'slots', selectedId = null;
  let slots = [], dock = { u: .5, v: .5 }, zoom = 1, fitMode = true, drag = null;
  let origin = { x: 24, y: 24 };

  function currentPoint() { return mode === 'dock' ? dock : slots.find(slot => slot.id === selectedId) || null; }
  function minimumZoom() { return Math.min(.02, fitZoom()); }
  function maximumZoom() { return asset ? Math.min(32, 32768 / Math.max(asset.w, asset.h)) : 32; }
  function fitZoom() {
    if (!asset) return 1;
    return Math.max(.0001, Math.min(8, (Math.max(80, scroll.clientWidth) - 48) / asset.w, (Math.max(80, scroll.clientHeight) - 48) / asset.h));
  }
  function imagePoint(event) {
    const rect = surface.getBoundingClientRect();
    return { x: (event.clientX - rect.left - origin.x) / zoom, y: (event.clientY - rect.top - origin.y) / zoom };
  }
  function markerPosition(element, point) {
    element.style.left = (origin.x + point.u * asset.w * zoom) + 'px';
    element.style.top = (origin.y + point.v * asset.h * zoom) + 'px';
    const label = element.querySelector('.cmp-slot-marker-label');
    if (label) {
      label.style.top = point.v * asset.h * zoom < 24 ? '26px' : '-23px';
      label.style.left = point.u < .15 ? '0' : point.u > .85 ? '100%' : '50%';
      label.style.transform = 'translateX(' + (point.u < .15 ? '0' : point.u > .85 ? '-100%' : '-50%') + ')';
    }
  }
  function renderMarkerPositions() {
    if (!asset) return;
    for (const element of markers.children) {
      const point = element.dataset.slotKind === 'dock' ? dock : slots.find(slot => slot.id === element.dataset.slotPoint);
      if (point) markerPosition(element, point);
    }
  }
  function renderMarkers() {
    markers.replaceChildren();
    if (!asset) return;
    slots.forEach((slot, index) => {
      const marker = document.createElement('button'); marker.type = 'button';
      marker.className = 'cmp-slot-marker' + (mode === 'slots' && slot.id === selectedId ? ' is-selected' : '') + (mode === 'dock' ? ' is-reference' : '');
      marker.dataset.slotPoint = slot.id; marker.dataset.slotKind = 'slots';
      marker.textContent = String(index + 1);
      marker.setAttribute('aria-label', slot.name + '，拖动或使用方向键调整');
      marker.setAttribute('aria-pressed', String(mode === 'slots' && slot.id === selectedId));
      marker.tabIndex = mode === 'slots' ? 0 : -1;
      marker.title = slot.name;
      const label = document.createElement('span'); label.className = 'cmp-slot-marker-label'; label.textContent = slot.name; marker.append(label);
      markers.append(marker);
    });
    const point = document.createElement('button'); point.type = 'button';
    point.className = 'cmp-slot-marker is-dock' + (mode === 'dock' ? ' is-selected' : ' is-reference');
    point.dataset.slotPoint = ''; point.dataset.slotKind = 'dock'; point.innerHTML = icon('crosshair');
    point.tabIndex = mode === 'dock' ? 0 : -1;
    point.setAttribute('aria-label', '配件对接点，拖动或使用方向键调整');
    point.setAttribute('aria-pressed', String(mode === 'dock'));
    const label = document.createElement('span'); label.className = 'cmp-slot-marker-label'; label.textContent = '对接点'; point.append(label);
    markers.append(point); renderMarkerPositions();
  }
  function renderSurface() {
    if (!asset) return;
    const w = asset.w * zoom, h = asset.h * zoom;
    const stageWidth = Math.max(scroll.clientWidth, w + 48), stageHeight = Math.max(scroll.clientHeight, h + 48);
    origin = { x: (stageWidth - w) / 2, y: (stageHeight - h) / 2 };
    surface.style.width = stageWidth + 'px'; surface.style.height = stageHeight + 'px';
    image.style.width = w + 'px'; image.style.height = h + 'px'; image.style.left = origin.x + 'px'; image.style.top = origin.y + 'px';
    $('.cmp-slot-zoom').textContent = readableNumber(zoom * 100) + '%';
    $('[data-slot-action="zoom-out"]').disabled = zoom <= minimumZoom() * 1.001;
    $('[data-slot-action="zoom-in"]').disabled = zoom >= maximumZoom() / 1.001;
    renderMarkerPositions();
  }
  function fit() {
    if (!asset) return;
    fitMode = true; zoom = clamp(fitZoom(), .0001, maximumZoom()); renderSurface();
    scroll.scrollLeft = (surface.offsetWidth - scroll.clientWidth) / 2;
    scroll.scrollTop = (surface.offsetHeight - scroll.clientHeight) / 2;
  }
  function setZoom(value) {
    if (!asset) return;
    const anchor = { x: (scroll.scrollLeft + scroll.clientWidth / 2 - origin.x) / zoom, y: (scroll.scrollTop + scroll.clientHeight / 2 - origin.y) / zoom };
    fitMode = false; zoom = clamp(value, minimumZoom(), maximumZoom()); renderSurface();
    scroll.scrollLeft = origin.x + anchor.x * zoom - scroll.clientWidth / 2;
    scroll.scrollTop = origin.y + anchor.y * zoom - scroll.clientHeight / 2;
  }
  function renderPointFields() {
    const point = currentPoint();
    $('.cmp-slot-point-fields').hidden = !point;
    $('.cmp-slot-empty-tip').hidden = !!point;
    $('.cmp-slot-name-label').hidden = mode === 'dock';
    $('[data-slot-action="delete"]').hidden = mode === 'dock';
    $('.cmp-slot-current-point').textContent = mode === 'dock' ? '对接点坐标' : point?.name || '卡槽坐标';
    if (!point || !asset) return;
    $('.cmp-slot-point-name').value = point.name || '';
    $('.cmp-slot-point-x').max = asset.w; $('.cmp-slot-point-y').max = asset.h;
    $('.cmp-slot-point-x').value = readableNumber(point.u * asset.w);
    $('.cmp-slot-point-y').value = readableNumber(point.v * asset.h);
  }
  function renderControls() {
    $('.cmp-slot-tab-count').textContent = slots.length + ' / ' + MAX_SLOTS;
    for (const tab of $$('[data-slot-mode]')) {
      const selected = tab.dataset.slotMode === mode;
      tab.classList.toggle('is-active', selected); tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1;
    }
    $('.cmp-slot-editor-body').setAttribute('aria-labelledby', prefix + '-' + mode + '-tab');
    $('.cmp-slot-mode-title').textContent = mode === 'slots' ? '主体卡槽' : '配件对接点';
    $('.cmp-slot-mode-count').textContent = mode === 'slots' ? slots.length + ' / 6' : '1 个';
    $('.cmp-slot-mode-description').textContent = mode === 'slots' ? '在主体上标记配件的安装位置。可为卡槽命名，方便选择和替换配件。' : '这个点会与主体卡槽重合。默认位于素材中心，也可点击素材指定位置。';
    $('.cmp-slot-preview-instruction').textContent = mode === 'slots' ? '点击添加 · 拖动卡槽微调' : '点击或拖动设置对接点';
    $('.cmp-slot-preview-coordinates').textContent = '';
    $('.cmp-slot-list').hidden = mode === 'dock';
    $('.cmp-slot-add').hidden = mode === 'dock'; $('.cmp-slot-add').disabled = slots.length >= MAX_SLOTS;
    const list = $('.cmp-slot-list'); list.replaceChildren();
    for (const [index, slot] of slots.entries()) {
      const button = document.createElement('button'); button.type = 'button';
      button.className = 'cmp-slot-list-item' + (slot.id === selectedId ? ' is-selected' : '');
      button.dataset.slotSelect = slot.id; button.setAttribute('aria-pressed', String(slot.id === selectedId));
      const number = document.createElement('span'); number.textContent = String(index + 1);
      const name = document.createElement('strong'); name.textContent = slot.name;
      const coords = document.createElement('small'); coords.textContent = readableNumber(slot.u * asset.w) + ', ' + readableNumber(slot.v * asset.h);
      button.append(number, name, coords); list.append(button);
    }
    renderPointFields();
  }
  function render() { renderControls(); renderMarkers(); }
  function updatePoint(point, x, y) {
    point.u = clamp(x, 0, asset.w) / asset.w; point.v = clamp(y, 0, asset.h) / asset.h;
    renderMarkerPositions(); renderPointFields();
    const row = [...$('.cmp-slot-list').children].find(element => element.dataset.slotSelect === selectedId);
    if (row && mode === 'slots') row.querySelector('small').textContent = readableNumber(point.u * asset.w) + ', ' + readableNumber(point.v * asset.h);
  }
  function newSlot(x, y) {
    if (slots.length >= MAX_SLOTS) { notify?.('每个主体最多设置 6 个卡槽。可拖动已有卡槽，或删除后重新添加。'); return null; }
    const names = new Set(slots.map(slot => slot.name)); let number = 1;
    while (names.has('卡槽 ' + number)) number++;
    const slot = { id: uid(), name: '卡槽 ' + number, u: clamp(x, 0, asset.w) / asset.w, v: clamp(y, 0, asset.h) / asset.h };
    slots.push(slot); selectedId = slot.id; render(); return slot;
  }
  function endDrag(cancel = false) {
    if (!drag) return;
    const current = drag; drag = null;
    if (cancel) { slots = current.before.slots; dock = current.before.dock; selectedId = current.before.selectedId; render(); }
    surface.classList.remove('is-dragging');
    if (surface.hasPointerCapture(current.pointerId)) surface.releasePointerCapture(current.pointerId);
  }
  function close() { endDrag(true); if (dialog.open) dialog.close(); }
  function validLayer() {
    const layer = layerId && getLayer(layerId);
    return layer && layer.assetId === assetId && !layer.locked && layer.visible !== false ? layer : null;
  }
  function save() {
    endDrag(false);
    if (!validLayer()) { notify?.('当前图层已删除、隐藏或锁定，请重新选择可编辑图层。', true); close(); return; }
    try {
      onApply(layerId, { slots: slots.map(slot => ({ ...slot })), dock: pointCopy(dock) });
      dialog.close();
    } catch (error) { notify?.(error.message || String(error), true); }
  }
  function changeMode(next) { endDrag(true); mode = next === 'dock' ? 'dock' : 'slots'; render(); }

  dialog.addEventListener('click', event => {
    const tab = event.target.closest('[data-slot-mode]');
    if (tab) { changeMode(tab.dataset.slotMode); return; }
    const selection = event.target.closest('[data-slot-select]');
    if (selection) { selectedId = selection.dataset.slotSelect; render(); return; }
    const action = event.target.closest('[data-slot-action]')?.dataset.slotAction;
    if (!action) return;
    if (action === 'close') { close(); return; }
    if (action === 'save') { save(); return; }
    if (!asset) return;
    if (action === 'fit') fit();
    else if (action === 'actual') setZoom(1);
    else if (action === 'zoom-in') setZoom(zoom * 1.5);
    else if (action === 'zoom-out') setZoom(zoom / 1.5);
    else if (action === 'add') newSlot(asset.w / 2, asset.h / 2);
    else if (action === 'center') { const point = currentPoint(); if (point) updatePoint(point, asset.w / 2, asset.h / 2); }
    else if (action === 'delete' && mode === 'slots') {
      const index = slots.findIndex(slot => slot.id === selectedId);
      if (index >= 0) slots.splice(index, 1);
      selectedId = slots[Math.min(index, slots.length - 1)]?.id || null; render();
    }
  });
  $('.cmp-slot-tabs').addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 'slots' : event.key === 'End' ? 'dock' : mode === 'slots' ? 'dock' : 'slots';
    changeMode(next); $('[data-slot-mode="' + next + '"]').focus();
  });
  $('.cmp-slot-point-name').addEventListener('change', event => {
    const point = currentPoint(); if (!point || mode !== 'slots') return;
    point.name = event.target.value.trim().slice(0, 40) || '卡槽 ' + (slots.indexOf(point) + 1); render();
  });
  for (const axis of ['x', 'y']) $('.cmp-slot-point-' + axis).addEventListener('change', event => {
    const point = currentPoint(); if (!point || !asset) return;
    const raw = event.target.value.trim(), value = Number(raw);
    if (!raw || !Number.isFinite(value)) { renderPointFields(); return; }
    updatePoint(point, axis === 'x' ? value : point.u * asset.w, axis === 'y' ? value : point.v * asset.h);
  });
  surface.addEventListener('pointerdown', event => {
    if (!asset || event.button !== 0 || drag) return;
    const marker = event.target.closest('[data-slot-point]');
    const position = imagePoint(event);
    const before = { slots: slots.map(slot => ({ ...slot })), dock: pointCopy(dock), selectedId };
    let point;
    if (marker && marker.dataset.slotKind === mode) {
      if (mode === 'slots') selectedId = marker.dataset.slotPoint;
      point = currentPoint(); render();
    } else {
      if (position.x < 0 || position.y < 0 || position.x > asset.w || position.y > asset.h) return;
      if (mode === 'slots') point = newSlot(Math.round(position.x), Math.round(position.y));
      else { point = dock; updatePoint(dock, Math.round(position.x), Math.round(position.y)); }
    }
    if (!point) return;
    event.preventDefault(); surface.setPointerCapture(event.pointerId);
    drag = { pointerId: event.pointerId, pointId: mode === 'dock' ? null : point.id, pointKind: mode, before, offsetX: position.x - point.u * asset.w, offsetY: position.y - point.v * asset.h };
    surface.classList.add('is-dragging');
  });
  surface.addEventListener('pointermove', event => {
    if (!asset) return;
    const position = imagePoint(event);
    $('.cmp-slot-preview-coordinates').textContent = position.x >= 0 && position.y >= 0 && position.x <= asset.w && position.y <= asset.h ? 'X ' + Math.round(position.x) + ' · Y ' + Math.round(position.y) : '';
    if (!drag || drag.pointerId !== event.pointerId) return;
    const point = drag.pointKind === 'dock' ? dock : slots.find(slot => slot.id === drag.pointId);
    if (point) updatePoint(point, Math.round(position.x - drag.offsetX), Math.round(position.y - drag.offsetY));
  });
  surface.addEventListener('pointerleave', () => { if (!drag) $('.cmp-slot-preview-coordinates').textContent = ''; });
  surface.addEventListener('pointerup', event => { if (drag?.pointerId === event.pointerId) endDrag(); });
  surface.addEventListener('pointercancel', event => { if (drag?.pointerId === event.pointerId) endDrag(true); });
  surface.addEventListener('lostpointercapture', event => { if (drag?.pointerId === event.pointerId) endDrag(true); });
  markers.addEventListener('keydown', event => {
    const marker = event.target.closest('[data-slot-point]');
    if (!asset || !marker || marker.dataset.slotKind !== mode) return;
    const id = marker.dataset.slotPoint;
    if (mode === 'slots' && selectedId !== id) {
      selectedId = id; renderControls();
      for (const el of markers.children) if (el.dataset.slotKind === 'slots') {
        const active = el.dataset.slotPoint === selectedId;
        el.classList.toggle('is-selected', active); el.setAttribute('aria-pressed', String(active));
      }
    }
    const point = currentPoint(); if (!point) return;
    const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    if (delta) {
      event.preventDefault(); event.stopPropagation(); const amount = event.shiftKey ? 10 : 1;
      updatePoint(point, point.u * asset.w + delta[0] * amount, point.v * asset.h + delta[1] * amount);
    } else if ((event.key === 'Enter' || event.key === ' ') && mode === 'slots') {
      event.preventDefault(); renderControls();
      for (const el of markers.children) { const active = el.dataset.slotPoint === selectedId; if (el.dataset.slotKind === 'slots') { el.classList.toggle('is-selected', active); el.setAttribute('aria-pressed', String(active)); } }
    }
  });
  dialog.addEventListener('cancel', () => endDrag(true));
  dialog.addEventListener('close', () => {
    if (dialog.open) return;
    endDrag(true); layerId = null; assetId = null; asset = null; slots = []; selectedId = null; markers.replaceChildren(); image.removeAttribute('src');
  });
  window.addEventListener('blur', () => { if (dialog.open) endDrag(true); });
  new ResizeObserver(() => { if (dialog.open && asset) fitMode ? fit() : renderSurface(); }).observe(scroll);

  return {
    open(id, nextMode = 'slots') {
      const layer = getLayer(id);
      if (!layer || layer.locked || layer.visible === false) { notify?.('请选择一个可见且未锁定的图层，再编辑卡槽。', true); return; }
      const nextAsset = getAsset(layer.assetId);
      if (!nextAsset?.image || !Number.isFinite(nextAsset.w) || !Number.isFinite(nextAsset.h) || nextAsset.w <= 0 || nextAsset.h <= 0) { notify?.('当前素材无法预览，请重新加入素材。', true); return; }
      let src = nextAsset.src || nextAsset.image.currentSrc || nextAsset.image.src;
      if (!src && typeof nextAsset.image.toDataURL === 'function') src = nextAsset.image.toDataURL('image/png');
      if (!src) { notify?.('当前素材无法预览，请重新加入素材。', true); return; }
      endDrag(true); layerId = id; assetId = layer.assetId; asset = nextAsset; mode = nextMode === 'dock' ? 'dock' : 'slots';
      const ids = new Set();
      slots = (Array.isArray(layer.slots) ? layer.slots : []).filter(slot => slot && Number.isFinite(slot.u) && Number.isFinite(slot.v)).slice(0, MAX_SLOTS).map((slot, index) => {
        const id = typeof slot.id === 'string' && slot.id && !ids.has(slot.id) ? slot.id : uid(); ids.add(id);
        return { id, name: String(slot.name || '卡槽 ' + (index + 1)).slice(0, 40), u: clamp(slot.u, 0, 1), v: clamp(slot.v, 0, 1) };
      });
      dock = layer.dock && Number.isFinite(layer.dock.u) && Number.isFinite(layer.dock.v) ? { u: clamp(layer.dock.u, 0, 1), v: clamp(layer.dock.v, 0, 1) } : { u: .5, v: .5 };
      selectedId = slots[0]?.id || null;
      image.src = src; image.alt = String(layer.name || asset.name || '素材') + '，原始图像';
      $('.cmp-slot-source-name').textContent = layer.name || asset.name || '素材';
      $('.cmp-slot-source-size').textContent = asset.w + ' × ' + asset.h + ' px';
      render(); fitMode = true;
      if (!dialog.open) dialog.showModal();
      requestAnimationFrame(() => { if (dialog.open && layerId === id) fit(); });
    },
    close,
    isOpen: () => dialog.open,
  };
}
