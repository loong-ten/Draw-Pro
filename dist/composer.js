import { PaintDocument, makeCanvas, uid } from './core.js';
import { icon } from './icons.js';
import { downloadBlob } from './io.js';
import { clamp, radians, rotateVector, corners, bounds, exportBounds, scaleProportionally, layoutLayers, alignLayers, hitLayer, snapTranslation } from './composition-geometry.js';
import { MAX_SLOTS, cloneAssemblyLayer, normalizeAssemblyFields, localPointToWorld, slotOccupant, canAttach, attachLayer, detachLayer, resolveAttachments, nearestSlot, attachmentDescendants, movementRoots, cloneAssemblySelection } from './composition-slots.js';
import { createSlotEditor } from './composition-slot-editor.js';

const LIMIT = { layers: 80, pixels: 32 * 1024 * 1024, side: 8192, assets: 48 * 1024 * 1024, bytes: 36 * 1024 * 1024 };
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const round = n => Math.round(n * 100) / 100;
const finite = (n, fallback = 0) => Number.isFinite(Number(n)) ? Number(n) : fallback;
const safeName = name => String(name || '拼接作品').replace(/[\\/:*?"<>|]/g, '_').slice(0, 100);
const cloneLayer = cloneAssemblyLayer;
const button = (action, name, title, extra = '') => '<button type="button" data-cmp-action="' + action + '" title="' + title + '" aria-label="' + title + '" ' + extra + '>' + icon(name) + '</button>';

export function createComposer(api, mount) {
  const assets = new Map();
  const state = { name: '拼接画布', layers: [], selected: new Set(), view: { x: 0, y: 0, z: 1 }, pixel: true, snap: true, slotSnap: true, showSlots: true, background: 'transparent', gap: 24, columns: 3, normalize: false, ratio: true, tool: 'select', padding: 0 };
  let active = false, initialized = false, busy = false, restoring = false, width = 1, height = 1, dpr = 1, raf = 0;
  let history = [], historyIndex = -1, gesture = null, space = false, transientGuides = [], revision = 0;
  let sourceSelection = new Set(), sourceSignature = '', localClipboard = [];
  let slotTargetLayer = '', slotTargetBinding = '';
  const pointers = new Map();
  const $ = selector => mount.querySelector(selector);
  const $$ = selector => [...mount.querySelectorAll(selector)];
  const notify = (message, error = false) => api.toast(message, error);
  const run = callback => async (...args) => { try { await callback(...args); } catch (error) { notify(error.message || String(error), true); } };

  mount.classList.add('cmp-root');
  mount.innerHTML = [
    '<div class="cmp-main">',
    '<header class="cmp-topbar"><div class="cmp-name"><span class="cmp-mode-dot"></span><input class="cmp-name-input" aria-label="拼接画布名称" maxlength="60" value="拼接画布"><span class="cmp-badge">无限画布</span></div>',
    '<div class="cmp-top-actions">',
    button('undo', 'undo', '撤销拼接操作 · Ctrl+Z'), button('redo', 'redo', '重做拼接操作 · Ctrl+Shift+Z'),
    '<span class="cmp-separator"></span><button type="button" data-cmp-action="add-current">' + icon('plus') + '<span>加入当前素材</span></button>',
    '<button type="button" class="cmp-primary-soft" data-cmp-action="send">' + icon('brush') + '<span>送回绘画</span></button>',
    '<button type="button" class="cmp-primary" data-cmp-action="export">' + icon('download') + '<span>导出拼图</span></button></div></header>',
    '<div class="cmp-viewport" tabindex="0" aria-label="拼接无限画布。拖动图片移动，角点缩放，圆点旋转，Shift多选，空格平移。"><canvas class="cmp-canvas" aria-label="拼接场景"></canvas>',
    '<div class="cmp-empty"><div class="cmp-empty-mark">' + icon('layers') + '</div><h2>让素材，组成完整画面。</h2><p>从下方素材带选择图片，开始你的场景、分镜或素材图集。</p><button type="button" class="cmp-primary" data-cmp-action="add-current">' + icon('plus') + '加入当前素材</button><small>每张素材都是独立副本，可随时送回绘画继续编辑</small></div>',
    '<div class="cmp-viewtools">' + button('select-tool', 'select', '选择与变换 · V') + button('hand-tool', 'hand', '平移画布 · H') + '<span class="cmp-separator"></span>' + button('snap', 'target', '边缘与参考线吸附') + button('pixel', 'grid', '像素清晰显示') + button('fit', 'fit', '适应全部 · 0') + '</div>',
    '<div class="cmp-zoombar">' + button('zoom-out', 'search', '缩小') + '<button type="button" data-cmp-action="actual" class="cmp-zoom-value">100%</button><button type="button" data-cmp-action="zoom-in" title="放大" aria-label="放大">+</button></div>',
    '<div class="cmp-canvas-help"><kbd>Shift</kbd> 多选 <span>·</span> <kbd>Alt</kbd> 暂停吸附 <span>·</span> <kbd>空格</kbd> 平移</div><div class="cmp-slot-hint" role="status" hidden></div>',
    '<div class="cmp-ref-indicator">' + icon('guides') + '<span>共享参考已同步</span></div></div>',
    '<footer class="cmp-status"><span class="cmp-selection-status">就绪</span><span class="cmp-coords">X 0 · Y 0</span><span class="cmp-dimensions">自由场景</span></footer>',
    '<section class="cmp-source-panel" aria-label="共享工作区素材"><header><span>' + icon('folder') + '工作区素材 <small class="cmp-source-count"></small></span><div><button type="button" data-cmp-action="add-selected">加入所选</button><button type="button" data-cmp-action="add-all">加入全部</button></div></header><div class="cmp-sources"></div></section>',
    '</div>',
    '<aside class="cmp-inspector"><section class="cmp-inspector-section cmp-layer-section"><div class="cmp-section-title"><h3>场景图层</h3><span class="cmp-layer-count">0</span></div><div class="cmp-layer-list" aria-label="拼接图层列表"></div>',
    '<div class="cmp-layer-tools">' + button('up', 'chevronUp', '选中图层上移') + button('down', 'chevronDown', '选中图层下移') + button('duplicate', 'copy', '复制选中图层 · Ctrl+D') + button('delete', 'trash', '删除选中图层 · Delete') + '<span></span>' + button('import-project', 'folderOpen', '导入旧版 .pinjing 工程') + '</div></section>',
    '<section class="cmp-inspector-section cmp-assembly"><div class="cmp-section-title"><h3>' + icon('link') + '卡槽组装</h3><span>最多 6 槽 / 层</span></div>',
    '<div class="cmp-assembly-switches"><label class="cmp-check"><input class="cmp-slot-snap" type="checkbox" checked>卡槽吸附</label><label class="cmp-check"><input class="cmp-show-slots" type="checkbox" checked>显示标记</label></div>',
    '<p class="cmp-assembly-empty cmp-small-note">选择主体添加卡槽，或选择配件连接已有卡槽。</p><div class="cmp-assembly-properties" hidden>',
    '<div class="cmp-assembly-edit"><button type="button" class="cmp-primary-soft" data-cmp-action="edit-slots">' + icon('target') + '编辑卡槽</button><button type="button" data-cmp-action="edit-dock">' + icon('select') + '对接点</button></div>',
    '<p class="cmp-assembly-summary"></p><div class="cmp-slot-list" aria-label="当前图层卡槽"></div>',
    '<label class="cmp-attach-label">配件对接到<select class="cmp-attach-target" aria-label="选择目标卡槽"><option value="">选择主体 / 卡槽…</option></select></label>',
    '<p class="cmp-attach-status" role="status"></p><div class="cmp-attach-actions"><button type="button" class="cmp-primary-soft" data-cmp-action="attach-slot">对接到卡槽</button><button type="button" data-cmp-action="detach-slot">解除对接</button></div>',
    '<button type="button" class="cmp-text-link" data-cmp-action="select-assembly">选中整个组件</button>',
    '</div><p class="cmp-small-note cmp-assembly-help">拖近空闲卡槽即可对接。对接点跟随主体，配件尺寸与角度可独立调整。</p></section>',
    '<section class="cmp-inspector-section cmp-transform"><div class="cmp-section-title"><h3>精确变换</h3>' + button('ratio', 'link', '锁定宽高比') + '</div><div class="cmp-no-selection">选择一个图层，调整位置与尺寸。</div><div class="cmp-properties">',
    '<div class="cmp-field-grid"><label><span>X</span><input data-cmp-prop="x" type="number" step="1" aria-label="图层 X 坐标"></label><label><span>Y</span><input data-cmp-prop="y" type="number" step="1" aria-label="图层 Y 坐标"></label><label><span>W</span><input data-cmp-prop="w" type="number" min="1" max="30000" step="1" aria-label="图层宽度"></label><label><span>H</span><input data-cmp-prop="h" type="number" min="1" max="30000" step="1" aria-label="图层高度"></label></div>',
    '<div class="cmp-field-grid"><label><span>角度</span><input data-cmp-prop="rotation" type="number" step="1" aria-label="图层旋转角度"><small>°</small></label><div class="cmp-flips">' + button('flip-h', 'flip', '水平翻转') + button('flip-v', 'flip', '垂直翻转') + '</div></div>',
    '<label class="cmp-range-label">不透明度 <output class="cmp-opacity-value">100%</output><input class="cmp-opacity" type="range" min="0" max="100" value="100" aria-label="拼接图层不透明度"></label>',
    '<button type="button" class="cmp-text-link" data-cmp-action="original">恢复原始尺寸</button><div class="cmp-locked-note" hidden>图层已锁定，请先在上方解锁。</div></div></section>',
    '<section class="cmp-inspector-section"><div class="cmp-section-title"><h3>对齐与排列</h3><span class="cmp-arrange-scope">全部图层</span></div>',
    '<div class="cmp-aligns"><button type="button" data-cmp-align="left" title="左对齐" aria-label="左对齐">⫷</button><button type="button" data-cmp-align="center" title="水平居中" aria-label="水平居中">↔</button><button type="button" data-cmp-align="right" title="右对齐" aria-label="右对齐">⫸</button><button type="button" data-cmp-align="top" title="顶部对齐" aria-label="顶部对齐">↥</button><button type="button" data-cmp-align="middle" title="垂直居中" aria-label="垂直居中">↕</button><button type="button" data-cmp-align="bottom" title="底部对齐" aria-label="底部对齐">↧</button></div>',
    '<div class="cmp-layouts"><button type="button" data-cmp-arrange="row">' + icon('hline') + '横向</button><button type="button" data-cmp-arrange="column">' + icon('vline') + '纵向</button><button type="button" data-cmp-arrange="grid">' + icon('grid') + '网格</button></div>',
    '<div class="cmp-field-grid"><label><span>间距</span><input class="cmp-gap" type="number" min="0" max="2000" value="24" aria-label="拼接间距"><small>px</small></label><label><span>列数</span><input class="cmp-columns" type="number" min="1" max="30" value="3" aria-label="网格列数"></label></div>',
    '<label class="cmp-check"><input class="cmp-normalize" type="checkbox">统一尺寸，保持宽高比</label><p class="cmp-small-note">对齐与排列会解除所选配件的对接；排列同时将旋转归零。</p></section>',
    '<section class="cmp-inspector-section"><div class="cmp-section-title"><h3>画布与参考</h3><span>全工作区共用</span></div>',
    '<label class="cmp-check"><input class="cmp-transparent" type="checkbox" checked>透明背景<input class="cmp-background" type="color" value="#ffffff" aria-label="拼接背景颜色"></label>',
    '<label class="cmp-check"><input class="cmp-guides-toggle" type="checkbox" checked>显示共享参考线与参考点</label><p class="cmp-guide-note cmp-small-note">像素坐标参考以场景原点为基准；相对参考按内容边界映射。</p>',
    '<button type="button" class="cmp-text-link" data-cmp-action="clear">清空拼接场景</button></section></aside>',
    '<input class="cmp-project-input" type="file" accept=".pinjing,.json,application/json" hidden>',
    '<dialog class="cmp-export-dialog"><form method="dialog" class="cmp-dialog-header"><div><span>EXPORT COMPOSITION</span><h2>导出拼接作品</h2></div><button aria-label="关闭导出面板">' + icon('close') + '</button></form>',
    '<div class="cmp-export-body"><div class="cmp-export-preview"><canvas></canvas></div><div class="cmp-export-fields"><label>文件名称<input class="cmp-export-name" maxlength="100"></label><label>格式<select class="cmp-export-format"><option value="png">PNG · 无损透明</option><option value="jpeg">JPEG · 通用图片</option><option value="webp">WebP · 轻量图片</option></select></label><label>导出范围<select class="cmp-export-scope"><option value="all">全部可见图层</option><option value="selected">仅选中图层</option></select></label><div class="cmp-field-grid"><label>倍率<select class="cmp-export-scale"><option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="2">2×</option><option value="4">4×</option><option value="8">8×</option></select></label><label>四周留白<input class="cmp-export-padding" type="number" min="0" max="2000" value="0"></label></div><label class="cmp-check"><input class="cmp-export-transparent" type="checkbox" checked>透明背景</label><p class="cmp-export-output"></p><p class="cmp-export-error" role="alert"></p></div></div>',
    '<div class="cmp-dialog-footer"><span>按实际内容边界导出 · 卡槽、参考与选框不写入图片</span><button type="button" class="cmp-primary cmp-export-download">下载图片</button></div></dialog>',
    '<dialog class="cmp-confirm-dialog"><h2>清空拼接场景？</h2><p>仅清空当前场景，工作区中的源素材会保留。你可以撤销此操作。</p><div><button type="button" class="cmp-confirm-cancel">取消</button><button type="button" class="cmp-primary cmp-confirm-yes">清空场景</button></div></dialog>'
  ].join('');
  const viewport = $('.cmp-viewport'), canvas = $('.cmp-canvas'), context = canvas.getContext('2d');
  const exportDialog = $('.cmp-export-dialog');
  const visible = () => state.layers.filter(l => l.visible);
  const selected = () => state.layers.filter(l => state.selected.has(l.id));
  const editable = () => selected().filter(l => l.visible && !l.locked);
  const local = e => { const r = viewport.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const world = p => ({ x: (p.x - state.view.x) / state.view.z, y: (p.y - state.view.y) / state.view.z });
  const screen = p => ({ x: p.x * state.view.z + state.view.x, y: p.y * state.view.z + state.view.y });
  const snapshot = () => ({ name: state.name, layers: state.layers.map(cloneLayer), background: state.background, pixel: state.pixel, snap: state.snap, slotSnap: state.slotSnap, showSlots: state.showSlots });
  const slotEditor = createSlotEditor({
    mount, getLayer: id => state.layers.find(l => l.id === id), getAsset: id => assets.get(id), notify,
    onApply(id, values) {
      const l = state.layers.find(item => item.id === id);
      if (!l || l.locked || !l.visible) return;
      const fields = normalizeAssemblyFields({ ...l, ...values });
      Object.assign(l, fields); commit('编辑卡槽与对接点');
    },
  });
  const guidesVisible = () => $('.cmp-guides-toggle').checked && api.getState()?.showGuides !== false;
  function sharedGuides() {
    const outer = api.getState();
    if (!outer || !guidesVisible()) return [];
    const b = bounds(visible()) || { x: 0, y: 0, w: outer.baseWidth || 960, h: outer.baseHeight || 640 };
    return (outer.guides || []).filter(g => g.visible !== false).map(g => ({
      ...g, x: outer.referenceMode === 'relative' ? b.x + g.x / (outer.baseWidth || 960) * b.w : g.x,
      y: outer.referenceMode === 'relative' ? b.y + g.y / (outer.baseHeight || 640) * b.h : g.y,
    }));
  }
  function pruneAssets() {
    const used = new Set(state.layers.map(l => l.assetId));
    for (const entry of history) for (const l of entry.layers) used.add(l.assetId);
    for (const l of localClipboard) used.add(l.assetId);
    for (const key of assets.keys()) if (!used.has(key)) assets.delete(key);
  }
  function commit(label) {
    resolveAttachments(state.layers);
    const current = snapshot();
    if (historyIndex >= 0 && JSON.stringify(current) === JSON.stringify(history[historyIndex])) { refresh(); return; }
    history = history.slice(0, historyIndex + 1);
    history.push(current);
    if (history.length > 60) history.shift();
    historyIndex = history.length - 1;
    pruneAssets(); revision++; refresh(); api.refresh?.(); api.persist();
    $('.cmp-selection-status').title = label;
  }
  function resetHistory() { history = [snapshot()]; historyIndex = 0; }
  function undo() {
    if (historyIndex <= 0 || busy) return;
    Object.assign(state, history[--historyIndex], { layers: history[historyIndex].layers.map(cloneLayer) });
    state.selected = new Set([...state.selected].filter(id => state.layers.some(l => l.id === id)));
    revision++; refresh(); api.refresh?.(); api.persist();
  }
  function redo() {
    if (historyIndex >= history.length - 1 || busy) return;
    Object.assign(state, history[++historyIndex], { layers: history[historyIndex].layers.map(cloneLayer) });
    state.selected = new Set([...state.selected].filter(id => state.layers.some(l => l.id === id)));
    revision++; refresh(); api.refresh?.(); api.persist();
  }
  function requestDraw() {
    if (!active || raf) return;
    raf = requestAnimationFrame(() => { raf = 0; if (active) draw(); });
  }
  function drawLayer(ctx, l, { opacity = true, force = false } = {}) {
    const a = assets.get(l.assetId);
    if (!a || (!l.visible && !force)) return;
    ctx.save(); ctx.globalAlpha = opacity ? l.opacity : 1;
    ctx.translate(l.x + l.w / 2, l.y + l.h / 2);
    ctx.rotate(radians(l.rotation));
    ctx.scale(l.flipX ? -1 : 1, l.flipY ? -1 : 1);
    ctx.drawImage(a.image, -l.w / 2, -l.h / 2, l.w, l.h); ctx.restore();
  }
  function rotationHandle(l) {
    const p = rotateVector(0, -l.h / 2 - 28 / state.view.z, l.rotation);
    return screen({ x: l.x + l.w / 2 + p.x, y: l.y + l.h / 2 + p.y });
  }
  function hitHandle(p) {
    const list = selected().filter(l => l.visible);
    if (list.length !== 1 || list[0].locked) return null;
    const l = list[0], r = rotationHandle(l);
    if (Math.hypot(p.x - r.x, p.y - r.y) < 12) return { type: 'rotate', layer: l };
    const cs = corners(l).map(screen);
    for (let i = 0; i < cs.length; i++) if (Math.hypot(p.x - cs[i].x, p.y - cs[i].y) < 10) return { type: 'resize', layer: l, corner: i };
    return null;
  }
  function draw() {
    const z = state.view.z;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);
    const b = exportBounds(visible());
    if (b) {
      const p = screen(b), w = b.w * z, h = b.h * z;
      context.save(); context.beginPath(); context.rect(p.x, p.y, w, h); context.clip();
      if (state.background !== 'transparent') { context.fillStyle = state.background; context.fillRect(p.x, p.y, w, h); }
      else {
        context.fillStyle = '#252830'; context.fillRect(p.x, p.y, w, h);
        context.fillStyle = '#2b2f38';
        const left = Math.max(0, p.x), top = Math.max(0, p.y), right = Math.min(width, p.x + w), bottom = Math.min(height, p.y + h), step = 12;
        for (let y = Math.floor(top / step); y <= Math.ceil(bottom / step); y++) for (let x = Math.floor(left / step); x <= Math.ceil(right / step); x++) if ((x + y) % 2 === 0) context.fillRect(x * step, y * step, step, step);
      }
      context.restore();
      context.strokeStyle = '#50545d'; context.lineWidth = 1; context.strokeRect(p.x, p.y, w, h);
    }
    context.save(); context.translate(state.view.x, state.view.y); context.scale(z, z); context.imageSmoothingEnabled = !state.pixel; context.imageSmoothingQuality = 'high';
    for (const l of state.layers) drawLayer(context, l); context.restore();
    if (state.pixel && z >= 8 && b) {
      const a = world({ x: 0, y: 0 }), d = world({ x: width, y: height });
      context.save(); const p = screen(b); context.beginPath(); context.rect(p.x, p.y, b.w * z, b.h * z); context.clip();
      context.strokeStyle = '#ffffff20'; context.lineWidth = .5; context.beginPath();
      for (let x = Math.max(Math.floor(a.x), b.x); x <= Math.min(Math.ceil(d.x), b.right); x++) { const sx = screen({ x, y: 0 }).x; context.moveTo(sx, 0); context.lineTo(sx, height); }
      for (let y = Math.max(Math.floor(a.y), b.y); y <= Math.min(Math.ceil(d.y), b.bottom); y++) { const sy = screen({ x: 0, y }).y; context.moveTo(0, sy); context.lineTo(width, sy); }
      context.stroke(); context.restore();
    }
    for (const g of sharedGuides()) {
      const p = screen(g); context.save(); context.strokeStyle = /^#[\da-f]{6}$/i.test(g.color || '') ? g.color : '#c0a1ff'; context.fillStyle = context.strokeStyle; context.globalAlpha = .7; context.lineWidth = 1; context.setLineDash([5, 5]); context.beginPath();
      if (g.type === 'h') { context.moveTo(0, p.y); context.lineTo(width, p.y); }
      else if (g.type === 'v') { context.moveTo(p.x, 0); context.lineTo(p.x, height); }
      else { context.setLineDash([]); context.arc(p.x, p.y, 5, 0, Math.PI * 2); context.moveTo(p.x - 10, p.y); context.lineTo(p.x + 10, p.y); context.moveTo(p.x, p.y - 10); context.lineTo(p.x, p.y + 10); }
      context.stroke(); context.font = '10px system-ui'; context.fillText(g.label || '共享参考', g.type === 'h' ? 14 : p.x + 9, g.type === 'v' ? 24 : p.y - 8); context.restore();
    }
    const list = selected().filter(l => l.visible);
    for (const l of list) {
      const cs = corners(l).map(screen); context.strokeStyle = l.locked ? '#888c98' : '#a899ff'; context.lineWidth = 1.4; context.beginPath(); cs.forEach((p, i) => i ? context.lineTo(p.x, p.y) : context.moveTo(p.x, p.y)); context.closePath(); context.stroke();
    }
    if (list.length === 1 && !list[0].locked) {
      const l = list[0], cs = corners(l).map(screen), r = rotationHandle(l);
      context.strokeStyle = '#b1a4ff'; context.fillStyle = '#f2edff'; context.lineWidth = 1.3;
      for (const p of cs) { context.fillRect(p.x - 3.5, p.y - 3.5, 7, 7); context.strokeRect(p.x - 3.5, p.y - 3.5, 7, 7); }
      context.beginPath(); context.moveTo((cs[0].x + cs[1].x) / 2, (cs[0].y + cs[1].y) / 2); context.lineTo(r.x, r.y); context.stroke(); context.beginPath(); context.arc(r.x, r.y, 4, 0, Math.PI * 2); context.fill(); context.stroke();
    }
    if (list.length > 1) { const sb = bounds(list), p = screen(sb); context.strokeStyle = '#b1a4ff'; context.setLineDash([5, 5]); context.strokeRect(p.x, p.y, sb.w * z, sb.h * z); context.setLineDash([]); }
    if (gesture?.type === 'marquee') { const a = screen(gesture.start), end = screen(gesture.end); context.fillStyle = '#a899ff20'; context.strokeStyle = '#a899ff'; context.fillRect(a.x, a.y, end.x - a.x, end.y - a.y); context.strokeRect(a.x, a.y, end.x - a.x, end.y - a.y); }
    context.strokeStyle = '#efb77d'; context.setLineDash([4, 3]); context.lineWidth = 1;
    for (const g of transientGuides) { context.beginPath(); if (g.axis === 'x') { const p = screen({ x: g.value, y: 0 }); context.moveTo(p.x, 0); context.lineTo(p.x, height); } else { const p = screen({ x: 0, y: g.value }); context.moveTo(0, p.y); context.lineTo(width, p.y); } context.stroke(); }
    context.setLineDash([]);
    drawSlotMarkers();
  }
  function drawSlotMarkers() {
    const candidate = gesture?.slotCandidate;
    if (!state.showSlots && !candidate) return;
    context.save(); context.lineWidth = 1.5; context.font = '10px system-ui';
    for (const host of visible()) for (const [i, slot] of (host.slots || []).entries()) {
      const isCandidate = candidate?.parentId === host.id && candidate?.slotId === slot.id;
      if (!state.showSlots && !isCandidate) continue;
      const p = screen(localPointToWorld(host, slot)), occupant = slotOccupant(state.layers, host.id, slot.id);
      const color = isCandidate ? '#ffd38a' : occupant ? '#82dfb7' : '#78cfe2';
      context.strokeStyle = color; context.fillStyle = '#151b26'; context.beginPath(); context.arc(p.x, p.y, isCandidate ? 10 : 7, 0, Math.PI * 2); context.fill(); context.stroke();
      context.fillStyle = color; context.textAlign = 'center'; context.fillText(String(i + 1), p.x, p.y + 3.5); context.textAlign = 'left';
      if (isCandidate || state.selected.has(host.id) || (occupant && state.selected.has(occupant.id))) {
        const label = slot.name + (occupant ? ' · 已对接' : '');
        context.fillStyle = '#151b26e6'; context.fillRect(p.x + 11, p.y - 12, context.measureText(label).width + 9, 19);
        context.fillStyle = color; context.fillText(label, p.x + 15, p.y + 1);
      }
    }
    const list = selected();
    if (state.showSlots && list.length === 1 && list[0].visible) {
      const l = list[0], p = screen(localPointToWorld(l, l.dock || { u: .5, v: .5 }));
      context.strokeStyle = '#ccbaff'; context.fillStyle = '#ccbaff30'; context.beginPath();
      context.moveTo(p.x, p.y - 5); context.lineTo(p.x + 5, p.y); context.lineTo(p.x, p.y + 5); context.lineTo(p.x - 5, p.y); context.closePath(); context.fill(); context.stroke();
      if (!l.attachment && !candidate) { context.fillStyle = '#d3c3ff'; context.fillText('对接点', p.x + 10, p.y + 15); }
    }
    context.restore();
  }
  function updateSlotHint() {
    const target = gesture?.slotCandidate, host = target && state.layers.find(l => l.id === target.parentId), slot = host?.slots?.find(s => s.id === target.slotId);
    $('.cmp-slot-hint').hidden = !slot;
    if (slot) $('.cmp-slot-hint').textContent = '松开以对接：' + host.name + ' / ' + slot.name;
  }
  function updateView(persist = false) {
    const { x, y, z } = state.view, step = 24 * Math.pow(2, Math.ceil(Math.log2(z)));
    viewport.style.backgroundSize = step + 'px ' + step + 'px'; viewport.style.backgroundPosition = x + 'px ' + y + 'px';
    $('.cmp-zoom-value').textContent = Math.round(z * 100) + '%'; requestDraw();
    if (persist) api.persist();
  }
  function fit() {
    if (!width || !height) return;
    const b = bounds(visible());
    state.view.z = b ? clamp(Math.min((width - 120) / b.w, (height - 110) / b.h), .015, 2) : 1;
    state.view.x = b ? width / 2 - (b.x + b.w / 2) * state.view.z : width / 2;
    state.view.y = b ? height / 2 - (b.y + b.h / 2) * state.view.z : height / 2;
    updateView();
  }
  function zoomAt(factor, point = { x: width / 2, y: height / 2 }, absolute = false) {
    const p = world(point); state.view.z = clamp(absolute ? factor : state.view.z * factor, .015, 32);
    state.view.x = point.x - p.x * state.view.z; state.view.y = point.y - p.y * state.view.z; updateView(true);
  }
  function thumbnailFor(asset) {
    if (!asset) return '';
    if (asset.thumb) return asset.thumb;
    const c = document.createElement('canvas'); c.width = 76; c.height = 76;
    const z = Math.min(72 / asset.w, 72 / asset.h), ctx = c.getContext('2d'); ctx.imageSmoothingEnabled = false;
    ctx.drawImage(asset.image, (76 - asset.w * z) / 2, (76 - asset.h * z) / 2, asset.w * z, asset.h * z);
    asset.thumb = c.toDataURL('image/png'); return asset.thumb;
  }
  function renderLayers() {
    $('.cmp-layer-list').innerHTML = [...state.layers].reverse().map(l => '<div class="cmp-layer' + (state.selected.has(l.id) ? ' is-selected' : '') + (!l.visible ? ' is-hidden' : '') + '" data-cmp-layer="' + esc(l.id) + '" tabindex="0" role="button" aria-pressed="' + state.selected.has(l.id) + '" aria-label="' + esc(l.name) + '"><img src="' + esc(thumbnailFor(assets.get(l.assetId))) + '" alt="" draggable="false"><div class="cmp-layer-name"><strong>' + esc(l.name) + '</strong><small title="' + esc(assemblyLabel(l)) + '">' + esc(assemblyLabel(l) || Math.round(l.w) + ' × ' + Math.round(l.h)) + '</small></div><button type="button" data-cmp-eye="' + esc(l.id) + '" aria-label="' + (l.visible ? '隐藏' : '显示') + esc(l.name) + '">' + icon(l.visible ? 'eye' : 'eyeOff') + '</button><button type="button" data-cmp-lock="' + esc(l.id) + '" aria-label="' + (l.locked ? '解锁' : '锁定') + esc(l.name) + '">' + icon(l.locked ? 'lock' : 'unlock') + '</button></div>').join('') || '<p class="cmp-layer-empty">添加素材后，图层会显示在这里</p>';
  }
  function assemblyLabel(l) {
    const parent = l.attachment && state.layers.find(item => item.id === l.attachment.parentId);
    const slot = parent?.slots?.find(s => s.id === l.attachment.slotId);
    return slot ? '↳ ' + parent.name + ' / ' + slot.name : l.slots?.length ? l.slots.length + ' 个卡槽' : '';
  }
  function chosenSlot() {
    try { const [parentId, slotId] = JSON.parse($('.cmp-attach-target').value); return { parentId, slotId }; } catch { return null; }
  }
  function refreshAttachmentAction() {
    const list = selected(), l = list.length === 1 ? list[0] : null, choice = chosenSlot();
    const occupant = choice && slotOccupant(state.layers, choice.parentId, choice.slotId, l?.id);
    const current = l?.attachment && choice?.parentId === l.attachment.parentId && choice?.slotId === l.attachment.slotId;
    const can = l?.visible && choice && canAttach(state.layers, l.id, choice.parentId, choice.slotId, { replace: true });
    $('[data-cmp-action="attach-slot"]').disabled = !can || current;
    $('[data-cmp-action="attach-slot"]').textContent = current ? '已对接' : occupant ? '替换槽内配件' : '对接到卡槽';
    $('[data-cmp-action="detach-slot"]').disabled = !l?.attachment || l.locked || !l.visible;
    const note = $('.cmp-attach-status');
    if (occupant) note.textContent = occupant.locked ? '此卡槽的配件已锁定，请先解锁后替换。' : '替换「' + occupant.name + '」的连接，原配件会保留在画布上。';
    else if (l?.attachment) note.textContent = '当前对接：' + assemblyLabel(l).replace('↳ ', '');
    else note.textContent = choice ? '将此配件的对接点与目标卡槽精确重合。' : '选择目标卡槽，或直接拖近空闲卡槽。';
    note.classList.toggle('is-replacing', !!occupant);
  }
  function refreshAssembly() {
    const list = selected(), l = list.length === 1 ? list[0] : null;
    $('.cmp-slot-snap').checked = state.slotSnap; $('.cmp-show-slots').checked = state.showSlots;
    $('.cmp-assembly-empty').hidden = !!l; $('.cmp-assembly-properties').hidden = !l;
    $('.cmp-assembly-empty').textContent = list.length > 1 ? '已选择多个图层。选择单个主体编辑卡槽，或选择配件进行对接。' : '选择主体添加卡槽，或选择配件连接已有卡槽。';
    if (!l) { slotTargetLayer = ''; slotTargetBinding = ''; return; }
    for (const name of ['edit-slots', 'edit-dock']) $('[data-cmp-action="' + name + '"]').disabled = l.locked || !l.visible;
    const a = assets.get(l.assetId), dock = l.dock || { u: .5, v: .5 };
    $('.cmp-assembly-summary').textContent = (l.slots?.length || 0) + ' / ' + MAX_SLOTS + ' 个卡槽 · 对接点 ' + round(dock.u * (a?.w || l.w)) + ', ' + round(dock.v * (a?.h || l.h)) + ' px';
    $('.cmp-slot-list').innerHTML = (l.slots || []).map((slot, i) => {
      const occupant = slotOccupant(state.layers, l.id, slot.id);
      return '<div class="cmp-slot-row' + (occupant ? ' is-occupied' : '') + '"><span>' + (i + 1) + '</span><div><strong>' + esc(slot.name) + '</strong><small>' + (occupant ? esc(occupant.name) : '空闲卡槽') + '</small></div>' + (occupant ? '<button type="button" data-cmp-occupant="' + esc(occupant.id) + '" title="选择已对接配件" aria-label="选择配件 ' + esc(occupant.name) + '">选择</button>' : '<small>空闲</small>') + '</div>';
    }).join('');
    const target = $('.cmp-attach-target'), binding = l.attachment ? JSON.stringify([l.attachment.parentId, l.attachment.slotId]) : '';
    const previous = slotTargetLayer === l.id && slotTargetBinding === binding ? target.value : binding;
    const excluded = attachmentDescendants(state.layers, [l.id]);
    const choices = [];
    for (const host of state.layers) {
      if (excluded.has(host.id) || (!host.visible && l.attachment?.parentId !== host.id)) continue;
      for (const slot of host.slots || []) {
        const occupant = slotOccupant(state.layers, host.id, slot.id, l.id), can = canAttach(state.layers, l.id, host.id, slot.id, { replace: true });
        const value = JSON.stringify([host.id, slot.id]);
        const current = l.attachment?.parentId === host.id && l.attachment?.slotId === slot.id;
        choices.push('<option value="' + esc(value) + '"' + (!can ? ' disabled' : '') + '>' + esc(host.name + ' / ' + slot.name + (current ? ' · 当前对接' : occupant ? ' · ' + (occupant.locked ? '已锁定' : '替换 ' + occupant.name) : ' · 空闲')) + '</option>');
      }
    }
    target.innerHTML = '<option value="">' + (choices.length ? '选择主体 / 卡槽…' : '先为主体添加卡槽') + '</option>' + choices.join('');
    target.value = previous; if (!target.value) target.value = '';
    target.disabled = l.locked || !l.visible || !choices.length; slotTargetLayer = l.id; slotTargetBinding = binding;
    refreshAttachmentAction();
  }
  function attachSelected() {
    const list = editable(), l = list.length === 1 ? list[0] : null, target = chosenSlot();
    if (!l || !target) return;
    const replaced = slotOccupant(state.layers, target.parentId, target.slotId, l.id);
    if (!attachLayer(state.layers, l.id, target.parentId, target.slotId, { replace: true })) { notify('此卡槽暂时无法对接，请检查图层锁定或连接关系。', true); return; }
    commit(replaced ? '替换卡槽配件' : '卡槽对接');
    notify(replaced ? '已替换连接，原配件「' + replaced.name + '」仍保留在画布上。' : '已对接，配件对接点将随卡槽位置移动。');
  }
  function selectAssembly() {
    const l = selected()[0]; if (!l) return;
    let root = l; const visited = new Set();
    while (root.attachment && !visited.has(root.id)) { visited.add(root.id); const parent = state.layers.find(item => item.id === root.attachment.parentId); if (!parent) break; root = parent; }
    state.selected = attachmentDescendants(state.layers, [root.id]); refresh();
  }
  function refreshSources(force = false) {
    const docs = api.getDocs() || [];
    const signature = docs.map(d => d.id + ':' + d.revision + ':' + d.name).join('|');
    if (!force && signature === sourceSignature) return;
    sourceSignature = signature;
    const ids = new Set(docs.map(d => d.id)); sourceSelection = new Set([...sourceSelection].filter(id => ids.has(id)));
    if (!sourceSelection.size && api.getDoc()) sourceSelection.add(api.getDoc().id);
    $('.cmp-source-count').textContent = docs.length + ' 张';
    const list = $('.cmp-sources'); list.replaceChildren();
    for (const doc of docs) {
      const card = document.createElement('label'); card.className = 'cmp-source'; card.title = doc.name; card.dataset.cmpSource = doc.id;
      const check = document.createElement('input'); check.type = 'checkbox'; check.checked = sourceSelection.has(doc.id); check.setAttribute('aria-label', '选择素材 ' + doc.name);
      check.onchange = () => { if (check.checked) sourceSelection.add(doc.id); else sourceSelection.delete(doc.id); refreshSourceSelection(); };
      const thumb = document.createElement('canvas'); thumb.width = 112; thumb.height = 72;
      const picture = api.getComposite(doc), scale = Math.min(104 / picture.width, 64 / picture.height);
      thumb.getContext('2d').drawImage(picture, (112 - picture.width * scale) / 2, (72 - picture.height * scale) / 2, picture.width * scale, picture.height * scale);
      const name = document.createElement('span'); name.textContent = doc.name;
      card.append(check, thumb, name); list.append(card);
    }
    refreshSourceSelection();
  }
  function refreshSourceSelection() {
    for (const card of $$('.cmp-source')) card.classList.toggle('is-selected', sourceSelection.has(card.dataset.cmpSource));
    const control = $('[data-cmp-action="add-selected"]'); control.textContent = '加入所选' + (sourceSelection.size ? ' · ' + sourceSelection.size : ''); control.disabled = !sourceSelection.size;
  }
  function refreshProperties() {
    const list = selected(), l = list.length === 1 ? list[0] : null;
    $('.cmp-properties').hidden = !l; $('.cmp-no-selection').hidden = !!l;
    $('.cmp-no-selection').textContent = list.length > 1 ? '已选中 ' + list.length + ' 个图层，可一起移动、对齐与排列。' : '选择一个图层，调整位置与尺寸。';
    for (const input of $$('[data-cmp-prop]')) { if (l) input.value = round(l[input.dataset.cmpProp]); input.disabled = !l || l.locked; }
    $('.cmp-opacity').disabled = !l || l.locked;
    if (l) { $('.cmp-opacity').value = Math.round(l.opacity * 100); $('.cmp-opacity-value').textContent = Math.round(l.opacity * 100) + '%'; }
    $('.cmp-locked-note').hidden = !l?.locked;
    $('[data-cmp-action="original"]').disabled = !l || l.locked;
    $('[data-cmp-action="ratio"]').classList.toggle('is-active', state.ratio);
    for (const name of ['flip-h', 'flip-v']) $('[data-cmp-action="' + name + '"]').disabled = !editable().length;
    $('.cmp-arrange-scope').textContent = selected().length > 1 ? '所选 ' + editable().length + ' 层' : '全部可编辑图层';
    for (const el of $$('[data-cmp-align]')) el.disabled = editable().length < 2;
  }
  function refresh() {
    resolveAttachments(state.layers);
    $('.cmp-name-input').value = state.name; $('.cmp-layer-count').textContent = state.layers.length;
    $('.cmp-empty').hidden = state.layers.length > 0;
    $('[data-cmp-action="undo"]').disabled = historyIndex <= 0;
    $('[data-cmp-action="redo"]').disabled = historyIndex >= history.length - 1;
    for (const name of ['delete', 'duplicate', 'up', 'down']) $('[data-cmp-action="' + name + '"]').disabled = !editable().length;
    for (const name of ['export', 'send']) $('[data-cmp-action="' + name + '"]').disabled = !visible().length;
    $('[data-cmp-action="snap"]').classList.toggle('is-active', state.snap);
    $('[data-cmp-action="pixel"]').classList.toggle('is-active', state.pixel);
    $('[data-cmp-action="select-tool"]').classList.toggle('is-active', state.tool === 'select');
    $('[data-cmp-action="hand-tool"]').classList.toggle('is-active', state.tool === 'hand');
    $('.cmp-transparent').checked = state.background === 'transparent';
    if (state.background !== 'transparent') $('.cmp-background').value = state.background;
    $('.cmp-gap').value = state.gap; $('.cmp-columns').value = state.columns; $('.cmp-normalize').checked = state.normalize;
    const attachedCount = state.layers.filter(l => l.attachment).length;
    $('.cmp-selection-status').textContent = selected().length ? '已选择 ' + selected().length + ' 个图层' : state.layers.length + ' 个图层' + (attachedCount ? ' · ' + attachedCount + ' 个配件已对接' : ' · 源图保持不变');
    const b = exportBounds(visible()); $('.cmp-dimensions').textContent = b ? b.w.toLocaleString() + ' × ' + b.h.toLocaleString() + ' px' : '自由场景';
    const refs = sharedGuides(); $('.cmp-ref-indicator').hidden = !refs.length; $('.cmp-ref-indicator span').textContent = refs.length + ' 个共享参考';
    renderLayers(); refreshProperties(); refreshAssembly(); updateSlotHint(); if (active) refreshSources(); updateView();
  }
  function assetTotals(extra = []) {
    const used = [...assets.values(), ...extra];
    return { pixels: used.reduce((n, a) => n + a.w * a.h, 0), bytes: used.reduce((n, a) => n + a.src.length, 0) };
  }
  async function addDocs(docs, { quiet = false } = {}) {
    if (busy || restoring) return;
    const unique = [...new Map(docs.filter(Boolean).map(d => [d.id, d])).values()];
    if (!unique.length) { notify('请先在下方选择素材。'); return; }
    if (state.layers.length + unique.length > LIMIT.layers) throw Error('拼接场景最多支持 80 个图层，请先整理图层。');
    busy = true;
    try {
      api.finishPending();
      const additions = [];
      for (const doc of unique) {
        const srcCanvas = api.getComposite(doc);
        if (srcCanvas.width * srcCanvas.height > LIMIT.pixels) throw Error('素材尺寸过大，请先调整尺寸。');
        const source = document.createElement('canvas'); source.width = srcCanvas.width; source.height = srcCanvas.height; source.getContext('2d').drawImage(srcCanvas, 0, 0);
        const a = { id: uid(), name: doc.name, src: source.toDataURL('image/png'), image: source, w: source.width, h: source.height };
        additions.push(a);
        const total = assetTotals(additions);
        if (total.pixels > LIMIT.assets || total.bytes > LIMIT.bytes) throw Error('拼接源图总量过大（最多 4800 万像素或约 36 MB 工程数据），请分批拼接。');
      }
      const b = bounds(visible()), origin = b ? { x: b.right + state.gap, y: b.y } : { x: 0, y: 0 };
      const newLayers = additions.map(a => ({ id: uid(), assetId: a.id, name: a.name.replace(/\.[^.]+$/, ''), x: origin.x, y: origin.y, w: a.w, h: a.h, rotation: 0, opacity: 1, visible: true, locked: false, flipX: false, flipY: false, ...normalizeAssemblyFields({}) }));
      const arranged = layoutLayers(newLayers, { mode: 'row', gap: state.gap, normalize: false });
      additions.forEach(a => assets.set(a.id, a)); state.layers.push(...arranged); state.selected = new Set(arranged.map(l => l.id));
      initialized = true; commit('加入工作区素材'); fit(); if (!quiet) notify('已加入 ' + additions.length + ' 张素材副本，原图不受拼接编辑影响。');
    } finally { busy = false; }
  }
  function patchLayers(patches, label) {
    // Explicit align/layout commands place every chosen layer independently.
    const map = new Map(patches.map(l => [l.id, { ...cloneLayer(l), attachment: null }]));
    state.layers = state.layers.map(l => map.get(l.id) || l); commit(label);
  }
  function arrange(mode) {
    const list = selected().length > 1 ? editable() : visible().filter(l => !l.locked);
    if (list.length < 2) { notify('需要至少两个可编辑图层。'); return; }
    state.gap = clamp(finite($('.cmp-gap').value, 24), 0, 2000); state.columns = clamp(Math.floor(finite($('.cmp-columns').value, 3)), 1, 30); state.normalize = $('.cmp-normalize').checked;
    state.selected = new Set(list.map(l => l.id));
    patchLayers(layoutLayers(list, { mode, gap: state.gap, columns: state.columns, normalize: state.normalize }), '自动拼接');
    fit();
  }
  function duplicate(list = editable()) {
    if (!list.length) return;
    if (state.layers.length + list.length > LIMIT.layers) throw Error('超过 80 个拼接图层上限。');
    const copies = cloneAssemblySelection(list, { makeId: uid });
    state.layers.push(...copies); state.selected = new Set(copies.map(l => l.id)); commit('复制图层');
  }
  function deleteSelected() {
    const ids = new Set(editable().map(l => l.id));
    if (!ids.size) return;
    state.layers = state.layers.filter(l => !ids.has(l.id)); state.selected = new Set([...state.selected].filter(id => !ids.has(id))); commit('删除图层');
  }
  function reorder(direction) {
    const ids = new Set(editable().map(l => l.id));
    if (direction > 0) { for (let i = state.layers.length - 2; i >= 0; i--) if (ids.has(state.layers[i].id) && !ids.has(state.layers[i + 1].id)) [state.layers[i], state.layers[i + 1]] = [state.layers[i + 1], state.layers[i]]; }
    else { for (let i = 1; i < state.layers.length; i++) if (ids.has(state.layers[i].id) && !ids.has(state.layers[i - 1].id)) [state.layers[i], state.layers[i - 1]] = [state.layers[i - 1], state.layers[i]]; }
    commit('调整图层顺序');
  }
  function exportData() {
    resolveAttachments(state.layers);
    const layers = ($('.cmp-export-scope').value === 'selected' ? selected() : state.layers).filter(l => l.visible);
    const scale = clamp(finite($('.cmp-export-scale').value, 1), .125, 8), padding = clamp(Math.floor(finite($('.cmp-export-padding').value)), 0, 2000), b = exportBounds(layers, padding);
    if (!b) return { layers, b, error: '没有可导出的可见图层。' };
    const w = Math.max(1, Math.ceil(b.w * scale)), h = Math.max(1, Math.ceil(b.h * scale));
    return { layers, b, scale, w, h, error: w > LIMIT.side || h > LIMIT.side || w * h > LIMIT.pixels ? '输出超过 8192px 单边或 3200 万像素，请降低倍率或减少导出范围。' : '' };
  }
  function paintExport(ctx, data, scale, transparent) {
    ctx.save(); if (!transparent) { ctx.fillStyle = state.background === 'transparent' ? $('.cmp-background').value : state.background; ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height); }
    ctx.scale(scale, scale); ctx.translate(-data.b.x, -data.b.y); ctx.imageSmoothingEnabled = !state.pixel; ctx.imageSmoothingQuality = 'high';
    data.layers.forEach(l => drawLayer(ctx, l)); ctx.restore();
  }
  function refreshExport() {
    const data = exportData(), format = $('.cmp-export-format').value;
    $('.cmp-export-transparent').disabled = format === 'jpeg';
    const transparent = $('.cmp-export-transparent').checked && format !== 'jpeg';
    $('.cmp-export-output').textContent = data.b ? data.w.toLocaleString() + ' × ' + data.h.toLocaleString() + ' px · ' + (data.w * data.h / 1e6).toFixed(2) + ' MP' : '';
    $('.cmp-export-error').textContent = data.error; $('.cmp-export-download').disabled = !!data.error;
    const preview = $('.cmp-export-preview canvas'), box = $('.cmp-export-preview');
    if (!data.b) { preview.width = 1; preview.height = 1; return; }
    const s = Math.min(Math.max(100, box.clientWidth - 48) / data.b.w, Math.max(100, box.clientHeight - 48) / data.b.h);
    preview.width = Math.max(1, Math.round(data.b.w * s * 2)); preview.height = Math.max(1, Math.round(data.b.h * s * 2)); preview.style.width = preview.width / 2 + 'px'; preview.style.height = preview.height / 2 + 'px';
    paintExport(preview.getContext('2d'), data, s * 2, transparent);
  }
  function openExport() {
    if (!visible().length) { notify('先加入素材，再导出拼图。'); return; }
    $('.cmp-export-name').value = state.name; $('.cmp-export-padding').value = state.padding; $('.cmp-export-transparent').checked = state.background === 'transparent';
    $('.cmp-export-scope').value = 'all'; $('.cmp-export-scope option[value="selected"]').disabled = !selected().some(l => l.visible);
    exportDialog.showModal(); refreshExport();
  }
  async function exportImage() {
    const data = exportData(); if (data.error) throw Error(data.error);
    const button = $('.cmp-export-download'); button.disabled = true; button.textContent = '生成中…';
    let output;
    try {
      await new Promise(resolve => requestAnimationFrame(resolve));
      output = makeCanvas(data.w, data.h); const format = $('.cmp-export-format').value, mime = 'image/' + format;
      paintExport(output.getContext('2d'), data, data.scale, $('.cmp-export-transparent').checked && format !== 'jpeg');
      const blob = await new Promise((resolve, reject) => output.toBlob(b => b ? resolve(b) : reject(Error('浏览器无法编码图片，请降低尺寸重试。')), mime, .95));
      if (blob.type !== mime) throw Error('当前浏览器不支持此格式，请选择 PNG。');
      downloadBlob(blob, safeName($('.cmp-export-name').value) + '.' + (format === 'jpeg' ? 'jpg' : format));
      exportDialog.close(); notify('已导出 ' + data.w + ' × ' + data.h + ' 像素拼图。');
    } finally { if (output) { output.width = 1; output.height = 1; } button.disabled = false; button.textContent = '下载图片'; }
  }
  async function sendToPaint() {
    if (busy || !state.layers.length) return;
    api.finishPending();
    resolveAttachments(state.layers);
    const b = exportBounds(state.layers), layerCount = state.layers.length + (state.background === 'transparent' ? 0 : 1);
    if (!b || b.w > LIMIT.side || b.h > LIMIT.side || b.w * b.h > LIMIT.pixels) throw Error('场景过大，暂不能送回绘画。请缩小素材或减少图层后重试。');
    const currentPixels = (api.getDocs() || []).reduce((n, d) => n + d.width * d.height * d.layers.length, 0);
    if (b.w * b.h * layerCount + currentPixels > 64 * 1024 * 1024) throw Error('保留所有图层需要的像素内存过大，请先减少图层、缩小场景或导出 PNG。');
    busy = true;
    try {
      const result = new PaintDocument({ name: state.name + '.png', width: b.w, height: b.h });
      result.layers = []; result.history = [];
      if (state.background !== 'transparent') {
        const bg = makeCanvas(b.w, b.h), ctx = bg.getContext('2d'); ctx.fillStyle = state.background; ctx.fillRect(0, 0, b.w, b.h);
        result.layers.push({ id: uid(), name: '拼接背景', canvas: bg, visible: true, locked: false, opacity: 1 });
      }
      for (const l of state.layers) {
        const c = makeCanvas(b.w, b.h), ctx = c.getContext('2d'); ctx.imageSmoothingEnabled = !state.pixel; ctx.translate(-b.x, -b.y); drawLayer(ctx, l, { opacity: false, force: true });
        result.layers.push({ id: uid(), name: l.name, canvas: c, visible: l.visible, opacity: l.opacity, locked: l.locked });
      }
      result.activeLayerId = result.layers[result.layers.length - 1].id; result.dirty = true; result.revision = 1; result.resetHistory('从拼接场景创建');
      await api.addDocument(result, { switchTo: true }); await api.setMode('paint');
      notify('已创建 ' + result.layers.length + ' 个独立图层，可继续绘画；拼接场景仍然保留。');
    } finally { busy = false; }
  }
  function serialize() {
    if (!state.layers.length) return null;
    resolveAttachments(state.layers);
    const used = new Set(state.layers.map(l => l.assetId));
    return {
      format: 'art-workbench-composition', version: 1, name: state.name,
      layers: state.layers.map(cloneLayer), assets: [...assets.values()].filter(a => used.has(a.id)).map(a => ({ id: a.id, name: a.name, src: a.src, w: a.w, h: a.h })),
      view: { ...state.view }, settings: { background: state.background, pixel: state.pixel, snap: state.snap, slotSnap: state.slotSnap, showSlots: state.showSlots, gap: state.gap, columns: state.columns, normalize: state.normalize, padding: state.padding, showGuides: $('.cmp-guides-toggle').checked },
    };
  }
  async function parseProject(data) {
    const legacy = data?.format === 'pinjing';
    if (!data || (!legacy && data.format !== 'art-workbench-composition') || data.version !== 1 || !Array.isArray(data.layers) || !Array.isArray(data.assets) || data.layers.length > LIMIT.layers || data.assets.length > LIMIT.layers) throw Error('无法识别拼接工程，或图层数量超过 80。');
    const incoming = new Map(); let pixels = 0, bytes = 0;
    for (const raw of data.assets) {
      if (!raw || typeof raw.id !== 'string' || incoming.has(raw.id) || typeof raw.src !== 'string' || !/^data:image\/(?:png|jpeg|webp|gif|svg\+xml|avif|bmp)[;,]/i.test(raw.src)) throw Error('工程含无效的内嵌图片。');
      bytes += raw.src.length; if (bytes > LIMIT.bytes) throw Error('拼接工程图片数据超过 36 MB 限制。');
      const image = await new Promise((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = () => reject(Error('工程图片解码失败，当前场景保持不变。')); img.src = raw.src; });
      const w = image.naturalWidth, h = image.naturalHeight; pixels += w * h;
      if (!w || !h || w > 16384 || h > 16384 || w * h > LIMIT.pixels || pixels > LIMIT.assets) throw Error('工程源图尺寸超过可处理范围。');
      let src = raw.src, bitmap = image;
      if (!/^data:image\/(?:png|jpeg)/i.test(src)) { const c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d').drawImage(image, 0, 0); src = c.toDataURL('image/png'); bitmap = c; bytes += src.length - raw.src.length; }
      if (bytes > LIMIT.bytes) throw Error('规范化后的图片数据超过 36 MB 限制。');
      incoming.set(raw.id, { id: raw.id, name: String(raw.name || '图片').slice(0, 200), src, image: bitmap, w, h });
    }
    const ids = new Set();
    const layers = data.layers.map(raw => {
      if (!raw || typeof raw.id !== 'string' || ids.has(raw.id) || !incoming.has(raw.assetId)) throw Error('工程中的图层关联无效。');
      ids.add(raw.id);
      for (const key of ['x', 'y', 'w', 'h', 'rotation', 'opacity']) if (typeof raw[key] !== 'number' || !Number.isFinite(raw[key])) throw Error('工程包含无效坐标或变换。');
      if (Math.abs(raw.x) > 1000000 || Math.abs(raw.y) > 1000000 || raw.w < 1 || raw.h < 1 || raw.w > 30000 || raw.h > 30000) throw Error('工程坐标或尺寸超限。');
      return { id: raw.id, assetId: raw.assetId, name: String(raw.name || '图层').slice(0, 200), x: raw.x, y: raw.y, w: raw.w, h: raw.h, rotation: ((raw.rotation % 360) + 360) % 360, opacity: clamp(raw.opacity, 0, 1), visible: raw.visible !== false, locked: !!raw.locked, flipX: !!raw.flipX, flipY: !!raw.flipY, ...normalizeAssemblyFields(raw) };
    });
    resolveAttachments(layers);
    const input = data.settings || {}, background = input.background === 'transparent' || /^#[0-9a-f]{6}$/i.test(input.background || '') ? input.background : 'transparent';
    return { assets: incoming, layers, name: String(data.name || '拼接画布').slice(0, 60), background, pixel: input.pixel !== false, snap: input.snap !== false, slotSnap: input.slotSnap !== false, showSlots: input.showSlots !== false, gap: clamp(finite(input.gap, 24), 0, 2000), columns: clamp(Math.floor(finite(input.columns, 3)), 1, 30), normalize: !!input.normalize, padding: clamp(Math.floor(finite(input.padding)), 0, 2000), showGuides: input.showGuides !== false, view: data.view };
  }
  async function applyParsedProject(parsed) {
    cancelGesture(); slotEditor.close(); assets.clear(); parsed.assets.forEach((a, id) => assets.set(id, a));
    const { assets: ignored, showGuides, view, ...rest } = parsed;
    Object.assign(state, rest); state.selected.clear(); localClipboard = []; initialized = true;
    $('.cmp-guides-toggle').checked = showGuides;
    if (view && [view.x, view.y, view.z].every(Number.isFinite)) state.view = { x: clamp(view.x, -32000000, 32000000), y: clamp(view.y, -32000000, 32000000), z: clamp(view.z, .015, 32) };
    else fit();
    resetHistory(); revision++; refresh();
  }
  async function restore(data) {
    restoring = true;
    try {
      if (!data) {
        cancelGesture(); slotEditor.close(); Object.assign(state, { name: '拼接画布', layers: [], view: { x: width / 2, y: height / 2, z: 1 }, background: 'transparent', pixel: true, snap: true, slotSnap: true, showSlots: true, gap: 24, columns: 3, normalize: false, padding: 0 }); state.selected.clear(); assets.clear(); localClipboard = []; initialized = true; resetHistory(); refresh(); return;
      }
      await applyParsedProject(await parseProject(data));
    } finally { restoring = false; }
  }
  async function openLegacyProject(file) {
    if (!file) return;
    if (file.size > 48 * 1024 * 1024) throw Error('拼接工程过大，请使用小于 48 MB 的工程。');
    const data = JSON.parse(await file.text());
    // Fully decode first; cancellation or failure must never destroy the existing scene.
    const parsed = await parseProject(data);
    if (state.layers.length && api.ask) {
      const answer = await api.ask('打开拼接工程', '<p>打开工程会替换当前拼接场景。请先保存完整工作区项目以保留现有布局。</p><p>工作区中的源素材会保留。</p>', { submit: '打开工程' });
      if (!answer) return;
    }
    await applyParsedProject(parsed); api.persist(); fit(); notify('已恢复拼接工程：' + parsed.layers.length + ' 个图层。');
  }
  function selectLayer(id, extend) {
    if (extend) { if (state.selected.has(id)) state.selected.delete(id); else state.selected.add(id); }
    else state.selected = new Set([id]);
    refresh();
  }
  function cancelGesture() {
    if (gesture?.before) state.layers = gesture.before.map(cloneLayer);
    else if (gesture?.originals) for (const old of gesture.originals) { const l = state.layers.find(l => l.id === old.id); if (l) Object.assign(l, cloneLayer(old)); }
    else if (gesture?.original && gesture.layer) Object.assign(gesture.layer, gesture.original);
    resolveAttachments(state.layers);
    gesture = null; pointers.clear(); transientGuides = []; viewport.classList.remove('is-panning'); updateSlotHint(); requestDraw();
  }
  function finishTransform(event) {
    const target = gesture?.slotCandidate, childId = gesture?.originals?.length === 1 ? gesture.originals[0].id : null;
    if (target && childId && !event?.altKey && attachLayer(state.layers, childId, target.parentId, target.slotId)) return '卡槽对接';
    return '变换图层';
  }
  function nudgeSelection(dx, dy) {
    const roots = movementRoots(state.layers, editable().map(l => l.id));
    for (const l of state.layers) if (roots.has(l.id)) { detachLayer(l); l.x += dx; l.y += dy; }
    commit('微调位置');
  }
  canvas.addEventListener('pointerdown', event => {
    if (!active || busy || event.button > 1 || restoring) return;
    event.preventDefault(); viewport.focus({ preventScroll: true }); canvas.setPointerCapture(event.pointerId);
    const p = local(event), w = world(p); pointers.set(event.pointerId, p);
    if (pointers.size === 2) {
      if (gesture && ['move', 'resize', 'rotate'].includes(gesture.type)) commit(finishTransform());
      const [a, b] = [...pointers.values()], center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      gesture = { type: 'pinch', distance: Math.hypot(a.x - b.x, a.y - b.y), z: state.view.z, anchor: world(center) }; updateSlotHint(); return;
    }
    if (space || event.button === 1 || state.tool === 'hand') { gesture = { type: 'pan', start: p, view: { ...state.view } }; viewport.classList.add('is-panning'); return; }
    const handle = hitHandle(p);
    if (handle) {
      const original = cloneLayer(handle.layer); gesture = { ...handle, original, start: w, before: state.layers.map(cloneLayer) };
      if (handle.type === 'resize') gesture.anchor = corners(original)[(handle.corner + 2) % 4];
      else gesture.angle = Math.atan2(w.y - original.y - original.h / 2, w.x - original.x - original.w / 2);
      return;
    }
    const hit = hitLayer(state.layers, w);
    if (hit) {
      if (event.shiftKey) { selectLayer(hit.id, true); if (!state.selected.has(hit.id)) return; }
      else if (!state.selected.has(hit.id)) selectLayer(hit.id, false);
      const roots = movementRoots(state.layers, editable().map(l => l.id));
      gesture = { type: 'move', start: w, originals: state.layers.filter(l => roots.has(l.id)).map(cloneLayer), before: state.layers.map(cloneLayer), moved: false, slotCandidate: null };
    } else {
      const previous = event.shiftKey ? new Set(state.selected) : new Set();
      if (!event.shiftKey) state.selected.clear(); gesture = { type: 'marquee', start: w, end: w, previous }; refresh();
    }
  });
  canvas.addEventListener('pointermove', event => {
    if (!active) return;
    const p = local(event), w = world(p);
    $('.cmp-coords').textContent = 'X ' + Math.round(w.x) + ' · Y ' + Math.round(w.y);
    if (pointers.has(event.pointerId)) pointers.set(event.pointerId, p);
    if (!gesture) {
      const handle = hitHandle(p);
      canvas.style.cursor = space || state.tool === 'hand' ? 'grab' : handle ? (handle.type === 'rotate' ? 'crosshair' : handle.corner % 2 ? 'nesw-resize' : 'nwse-resize') : hitLayer(state.layers, w) ? 'move' : 'default'; return;
    }
    if (gesture.type === 'pinch') {
      if (pointers.size < 2) return;
      const [a, b] = [...pointers.values()], center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      state.view.z = clamp(gesture.z * Math.hypot(a.x - b.x, a.y - b.y) / Math.max(1, gesture.distance), .015, 32);
      state.view.x = center.x - gesture.anchor.x * state.view.z; state.view.y = center.y - gesture.anchor.y * state.view.z; updateView(); return;
    }
    if (gesture.type === 'pan') { state.view.x = gesture.view.x + p.x - gesture.start.x; state.view.y = gesture.view.y + p.y - gesture.start.y; updateView(); return; }
    if (gesture.type === 'move') {
      let dx = w.x - gesture.start.x, dy = w.y - gesture.start.y;
      if (!gesture.moved && Math.hypot(dx, dy) < 2 / state.view.z) return;
      if (event.shiftKey && Math.hypot(dx, dy) > 4 / state.view.z) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      for (const original of gesture.originals) { const l = state.layers.find(item => item.id === original.id); if (l) { detachLayer(l); l.x = Math.round(original.x + dx); l.y = Math.round(original.y + dy); } }
      resolveAttachments(state.layers);
      transientGuides = []; gesture.slotCandidate = null;
      const movingIds = attachmentDescendants(state.layers, gesture.originals.map(l => l.id));
      const moving = visible().filter(l => movingIds.has(l.id));
      if (!event.altKey && state.slotSnap && gesture.originals.length === 1) {
        const childId = gesture.originals[0].id, child = state.layers.find(l => l.id === childId);
        const candidate = nearestSlot(state.layers, childId, 22 / state.view.z, { excludeIds: movingIds });
        if (candidate) {
          const dock = localPointToWorld(child, child.dock || { u: .5, v: .5 });
          child.x += candidate.point.x - dock.x; child.y += candidate.point.y - dock.y;
          gesture.slotCandidate = candidate; resolveAttachments(state.layers);
        }
      }
      if (!gesture.slotCandidate && !event.altKey && state.snap) {
        const snap = snapTranslation(moving, visible().filter(l => !movingIds.has(l.id)), 7 / state.view.z, api.getState()?.snapToGuides !== false ? sharedGuides() : []);
        for (const original of gesture.originals) { const l = state.layers.find(item => item.id === original.id); l.x += snap.dx; l.y += snap.dy; }
        resolveAttachments(state.layers); transientGuides = snap.guides;
      }
      gesture.moved = true; updateSlotHint();
    } else if (gesture.type === 'resize') {
      const { original: o, anchor: a, corner, layer: l } = gesture, signs = [[-1, -1], [1, -1], [1, 1], [-1, 1]][corner];
      const v = rotateVector(w.x - a.x, w.y - a.y, -o.rotation); let nw, nh;
      if (state.ratio !== event.shiftKey) { const f = clamp((v.x * signs[0] * o.w + v.y * signs[1] * o.h) / (o.w * o.w + o.h * o.h), Math.max(1 / o.w, 1 / o.h), Math.min(30000 / o.w, 30000 / o.h)); nw = o.w * f; nh = o.h * f; }
      else { nw = clamp(v.x * signs[0], 1, 30000); nh = clamp(v.y * signs[1], 1, 30000); }
      const c = rotateVector(signs[0] * nw / 2, signs[1] * nh / 2, o.rotation);
      l.x = a.x + c.x - nw / 2; l.y = a.y + c.y - nh / 2; l.w = nw; l.h = nh;
    } else if (gesture.type === 'rotate') {
      const { original: o, layer: l } = gesture, angle = Math.atan2(w.y - o.y - o.h / 2, w.x - o.x - o.w / 2);
      let rotation = o.rotation + (angle - gesture.angle) * 180 / Math.PI; if (event.shiftKey) rotation = Math.round(rotation / 15) * 15;
      l.rotation = round(((rotation % 360) + 360) % 360);
    } else if (gesture.type === 'marquee') {
      gesture.end = w; const box = { x: Math.min(w.x, gesture.start.x), y: Math.min(w.y, gesture.start.y), right: Math.max(w.x, gesture.start.x), bottom: Math.max(w.y, gesture.start.y) };
      state.selected = new Set(gesture.previous);
      for (const l of visible().filter(l => !l.locked)) { const b = bounds([l]); if (b.right >= box.x && b.x <= box.right && b.bottom >= box.y && b.y <= box.bottom) state.selected.add(l.id); }
    }
    resolveAttachments(state.layers); requestDraw(); refreshProperties();
  });
  function finishPointer(event) {
    pointers.delete(event.pointerId); if (!gesture) return;
    if (gesture.type === 'pinch') {
      if (pointers.size === 1) gesture = { type: 'pan', start: [...pointers.values()][0], view: { ...state.view } };
      else { gesture = null; api.persist(); } return;
    }
    const type = gesture.type, label = ['move', 'resize', 'rotate'].includes(type) ? finishTransform(event) : '';
    gesture = null; transientGuides = []; viewport.classList.remove('is-panning'); updateSlotHint();
    if (label) commit(label); else { refresh(); api.persist(); }
  }
  canvas.addEventListener('pointerup', finishPointer);
  canvas.addEventListener('pointercancel', () => { cancelGesture(); refresh(); });
  canvas.addEventListener('lostpointercapture', event => { if (pointers.has(event.pointerId)) finishPointer(event); });
  canvas.addEventListener('wheel', event => { if (!active) return; event.preventDefault(); if (!gesture) zoomAt(Math.exp(-clamp(event.deltaY * (event.deltaMode === 1 ? 16 : 1), -200, 200) * .0015), local(event)); }, { passive: false });
  canvas.addEventListener('contextmenu', event => event.preventDefault());
  canvas.addEventListener('dblclick', event => { const l = hitLayer(state.layers, world(local(event))); if (!l) return; state.selected = new Set([l.id]); const b = bounds([l]); state.view.z = clamp(Math.min((width - 120) / b.w, (height - 110) / b.h), .015, 4); state.view.x = width / 2 - (b.x + b.w / 2) * state.view.z; state.view.y = height / 2 - (b.y + b.h / 2) * state.view.z; refresh(); });

  async function handleAction(name) {
    switch (name) {
      case 'undo': undo(); break;
      case 'redo': redo(); break;
      case 'add-current': await addDocs([api.getDoc()]); break;
      case 'add-all': await addDocs(api.getDocs()); break;
      case 'add-selected': await addDocs(api.getDocs().filter(d => sourceSelection.has(d.id))); break;
      case 'fit': fit(); break;
      case 'actual': zoomAt(1, undefined, true); break;
      case 'zoom-in': zoomAt(1.25); break;
      case 'zoom-out': zoomAt(.8); break;
      case 'select-tool': state.tool = 'select'; refresh(); break;
      case 'hand-tool': state.tool = 'hand'; refresh(); break;
      case 'snap': state.snap = !state.snap; refresh(); api.persist(); break;
      case 'pixel': state.pixel = !state.pixel; refresh(); api.persist(); break;
      case 'ratio': state.ratio = !state.ratio; refreshProperties(); break;
      case 'delete': deleteSelected(); break;
      case 'duplicate': duplicate(); break;
      case 'up': reorder(1); break;
      case 'down': reorder(-1); break;
      case 'select-all': state.selected = new Set(visible().filter(l => !l.locked).map(l => l.id)); refresh(); break;
      case 'deselect': state.selected.clear(); refresh(); break;
      case 'edit-slots': if (selected().length === 1) slotEditor.open(selected()[0].id, 'slots'); break;
      case 'edit-dock': if (selected().length === 1) slotEditor.open(selected()[0].id, 'dock'); break;
      case 'attach-slot': attachSelected(); break;
      case 'detach-slot': for (const l of editable()) detachLayer(l); commit('解除卡槽对接'); break;
      case 'select-assembly': selectAssembly(); break;
      case 'flip-h': for (const l of editable()) l.flipX = !l.flipX; commit('水平翻转'); break;
      case 'flip-v': for (const l of editable()) l.flipY = !l.flipY; commit('垂直翻转'); break;
      case 'original': for (const l of editable()) { const a = assets.get(l.assetId); l.w = a.w; l.h = a.h; } commit('恢复原始尺寸'); break;
      case 'export': openExport(); break;
      case 'send': await sendToPaint(); break;
      case 'import-project': $('.cmp-project-input').click(); break;
      case 'clear': $('.cmp-confirm-dialog').showModal(); break;
      default: return false;
    }
    return true;
  }
  mount.addEventListener('click', run(async event => {
    const action = event.target.closest('[data-cmp-action]'); if (action) { await handleAction(action.dataset.cmpAction); return; }
    const align = event.target.closest('[data-cmp-align]'); if (align) { if (editable().length > 1) patchLayers(alignLayers(editable(), align.dataset.cmpAlign), '对齐图层'); return; }
    const layout = event.target.closest('[data-cmp-arrange]'); if (layout) { arrange(layout.dataset.cmpArrange); return; }
    const occupant = event.target.closest('[data-cmp-occupant]'); if (occupant) { selectLayer(occupant.dataset.cmpOccupant, false); return; }
    const eye = event.target.closest('[data-cmp-eye]'); if (eye) { const l = state.layers.find(l => l.id === eye.dataset.cmpEye); if (l) { l.visible = !l.visible; commit('图层可见性'); } return; }
    const lock = event.target.closest('[data-cmp-lock]'); if (lock) { const l = state.layers.find(l => l.id === lock.dataset.cmpLock); if (l) { l.locked = !l.locked; commit('锁定图层'); } return; }
    const row = event.target.closest('[data-cmp-layer]'); if (row) selectLayer(row.dataset.cmpLayer, event.shiftKey);
  }));
  $('.cmp-layer-list').addEventListener('keydown', event => { const row = event.target.closest('[data-cmp-layer]'); if (row && event.target === row && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); event.stopPropagation(); selectLayer(row.dataset.cmpLayer, event.shiftKey); } });
  $('.cmp-name-input').onchange = event => { state.name = event.target.value.trim() || '拼接画布'; commit('重命名拼接场景'); };
  for (const input of $$('[data-cmp-prop]')) input.onchange = event => {
    const l = selected()[0]; if (!l || l.locked) return;
    const key = input.dataset.cmpProp; let value = finite(event.target.value, l[key]);
    if (key === 'w' || key === 'h') { value = clamp(value, 1, 30000); if (state.ratio) scaleProportionally(l, value / l[key]); else l[key] = value; }
    else if (key === 'rotation') l.rotation = ((value % 360) + 360) % 360;
    else { detachLayer(l); l[key] = clamp(value, -1000000, 1000000); }
    commit('精确变换');
  };
  $('.cmp-opacity').oninput = event => { const l = selected()[0]; if (!l || l.locked) return; l.opacity = Number(event.target.value) / 100; $('.cmp-opacity-value').textContent = event.target.value + '%'; requestDraw(); };
  $('.cmp-opacity').onchange = () => commit('不透明度');
  $('.cmp-transparent').onchange = event => { state.background = event.target.checked ? 'transparent' : $('.cmp-background').value; commit('背景设置'); };
  $('.cmp-background').onchange = event => { state.background = event.target.value; commit('背景设置'); };
  $('.cmp-guides-toggle').onchange = () => { refresh(); api.persist(); };
  $('.cmp-slot-snap').onchange = event => { state.slotSnap = event.target.checked; refresh(); api.persist(); };
  $('.cmp-show-slots').onchange = event => { state.showSlots = event.target.checked; refresh(); api.persist(); };
  $('.cmp-attach-target').onchange = refreshAttachmentAction;
  for (const field of ['gap', 'columns', 'normalize']) $('.cmp-' + field).onchange = () => { state.gap = clamp(finite($('.cmp-gap').value, 24), 0, 2000); state.columns = clamp(Math.floor(finite($('.cmp-columns').value, 3)), 1, 30); state.normalize = $('.cmp-normalize').checked; api.persist(); };
  $('.cmp-project-input').onchange = run(async event => { const file = event.target.files[0]; event.target.value = ''; await openLegacyProject(file); });
  for (const input of $$('.cmp-export-fields select,.cmp-export-padding,.cmp-export-transparent')) input.onchange = refreshExport;
  $('.cmp-export-download').onclick = run(exportImage);
  $('.cmp-confirm-cancel').onclick = () => $('.cmp-confirm-dialog').close();
  $('.cmp-confirm-yes').onclick = () => { state.layers = []; state.selected.clear(); initialized = true; commit('清空场景'); $('.cmp-confirm-dialog').close(); };
  document.addEventListener('keydown', run(async event => {
    if (!active || event.target.closest('input,textarea,select,[contenteditable="true"]') || document.querySelector('dialog[open]')) return;
    const mod = event.ctrlKey || event.metaKey, key = event.key.toLowerCase();
    let action = null;
    if (mod && key === 'z') action = event.shiftKey ? 'redo' : 'undo';
    else if (mod && key === 'y') action = 'redo';
    else if (mod && key === 'a') action = 'select-all';
    else if (mod && key === 'd') action = 'duplicate';
    else if (mod && event.shiftKey && key === 'e') action = 'export';
    else if (!mod && (key === 'delete' || key === 'backspace')) action = 'delete';
    else if (!mod && key === '0') action = 'fit';
    else if (!mod && key === '1') action = 'actual';
    else if (!mod && key === 'v') action = 'select-tool';
    else if (!mod && key === 'h') action = 'hand-tool';
    if (action) { event.preventDefault(); event.stopImmediatePropagation(); await handleAction(action); return; }
    if (event.code === 'Space' && event.target.closest('button,[role="button"]')) return;
    if (event.code === 'Space') { event.preventDefault(); event.stopImmediatePropagation(); space = true; canvas.style.cursor = 'grab'; return; }
    if (key === 'escape') { event.preventDefault(); event.stopImmediatePropagation(); if (gesture) cancelGesture(); else state.selected.clear(); refresh(); return; }
    if (mod && (key === 'c' || key === 'x')) { event.preventDefault(); event.stopImmediatePropagation(); localClipboard = editable().map(cloneLayer); if (key === 'x') deleteSelected(); else notify('已复制 ' + localClipboard.length + ' 个拼接图层。'); return; }
    if (mod && key === 'v' && localClipboard.length) { event.preventDefault(); event.stopImmediatePropagation(); duplicate(localClipboard); return; }
    if (!mod && key.startsWith('arrow')) { event.preventDefault(); event.stopImmediatePropagation(); const n = event.shiftKey ? 10 : 1; nudgeSelection(key === 'arrowleft' ? -n : key === 'arrowright' ? n : 0, key === 'arrowup' ? -n : key === 'arrowdown' ? n : 0); }
  }), true);
  document.addEventListener('keyup', event => { if (event.code === 'Space') { space = false; if (active) canvas.style.cursor = state.tool === 'hand' ? 'grab' : 'default'; } });
  window.addEventListener('blur', () => { space = false; if (gesture) { cancelGesture(); refresh(); } });
  function resizeViewport() {
    if (!viewport.clientWidth || !viewport.clientHeight) return;
    const oldW = width, oldH = height; width = viewport.clientWidth; height = viewport.clientHeight; dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
    state.view.x += (width - oldW) / 2; state.view.y += (height - oldH) / 2; updateView();
    if (exportDialog.open) refreshExport();
  }
  new ResizeObserver(resizeViewport).observe(viewport);
  resetHistory(); refresh();
  return {
    async activate() {
      active = true; mount.hidden = false; api.finishPending(); resizeViewport(); refreshSources(true);
      requestAnimationFrame(() => { if (active) { refresh(); viewport.focus({ preventScroll: true }); } });
      if (!initialized && !restoring && !state.layers.length) {
        initialized = true;
        const docs = api.getDocs(), seed = docs.length && docs.every(d => d.isDemo) ? docs.slice(0, 3) : [api.getDoc()];
        try { await addDocs(seed, { quiet: true }); } catch (error) { notify(error.message, true); }
      }
      requestDraw();
    },
    deactivate() { if (gesture) cancelGesture(); slotEditor.close(); active = false; space = false; mount.hidden = true; if (raf) cancelAnimationFrame(raf); raf = 0; },
    refresh, serialize, restore, handleAction,
    getHistoryState: () => ({ canUndo: historyIndex > 0, canRedo: historyIndex < history.length - 1 }),
  };
}
