import { makeCanvas } from './core.js';
import { createSlicePlan, addCutLine, evenCutLines } from './slice-core.js';
import { buildSliceDocuments } from './slice-raster.js';

const MAX_DOCS = 100;
const MAX_WORKSPACE_PIXELS = 64 * 1024 * 1024;
const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
const isInput = target => /^(INPUT|SELECT|TEXTAREA)$/.test(target?.tagName) || target?.isContentEditable;

/** Cut the current document's visible composite into independent workspace assets. */
export function createSlicer(api, mount) {
  mount.innerHTML = `
    <div class="slice-root">
      <section class="slice-workspace" aria-label="切图预览">
        <header class="slice-heading"><div><span class="slice-eyebrow">IMAGE SLICER</span><h2>把一张图，变成一组素材 <span class="slice-badge">透明像素保留</span></h2><p data-slice="filename">在左侧选择要切割的素材</p></div><button class="slice-btn" data-slice-action="import">＋ 导入图片</button></header>
        <div class="slice-toolbar"><div class="slice-segment" role="group" aria-label="切图模式"><button data-slice-mode="manual" aria-pressed="true">自由切线</button><button data-slice-mode="sprite" aria-pressed="false">精灵帧切图</button></div><div class="slice-zoom"><button class="slice-btn" data-slice-action="zoom-out" aria-label="缩小切图预览">−</button><span data-slice="zoom">100%</span><button class="slice-btn" data-slice-action="zoom-in" aria-label="放大切图预览">＋</button><button class="slice-btn" data-slice-action="fit">适合</button><button class="slice-btn" data-slice-action="actual">1:1</button></div><button class="slice-btn slice-hand" data-slice-action="hand" aria-pressed="false" title="平移视图；也可按住空格拖动或使用中键">平移</button></div>
        <div class="slice-stage" data-slice="stage"><canvas data-slice="canvas" tabindex="0" aria-label="图片切线预览，可拖动横竖切线；也可用右侧像素坐标输入精确调整"></canvas><div class="slice-empty" data-slice="empty" hidden>从左侧选择素材，或导入一张图片开始切图。</div><div class="slice-stage-label"><span data-slice="stage-mode">拖动切线调整位置</span><b data-slice="source-size">—</b></div></div>
        <div class="slice-statusbar"><span data-slice="pointer">X — · Y —</span><span>滚轮缩放 · 空格 / 中键拖动平移</span><strong data-slice="selection">整数像素切割</strong></div>
        <div class="slice-summary"><div><span>原始素材</span><strong data-slice="source-summary">—</strong></div><div><span>切图布局</span><strong data-slice="layout">—</strong></div><div><span data-slice="size-label">切块尺寸</span><strong data-slice="frame-size">—</strong></div><div><span>新增素材</span><strong class="slice-accent" data-slice="count">—</strong></div></div>
        <section class="slice-results" aria-label="切块预览"><header><h3>切块预览 <span data-slice="preview-count">0 张</span></h3><span data-slice="preview-note">从左到右、从上到下编号</span></header><div class="slice-thumbnails" data-slice="thumbnails"></div></section>
      </section>
      <aside class="slice-settings" aria-label="切图参数">
        <section class="slice-section"><h3><span>01</span>当前来源<button class="slice-text-btn" data-slice-action="reload">重新读取</button></h3><div class="slice-source"><i></i><span data-slice="source-name">未选择素材</span></div><p class="slice-hint">读取当前素材的可见图层。切出的每一块会成为独立素材。</p></section>
        <section class="slice-section" data-slice="manual-controls"><h3><span>02</span>横竖切线<b>每方向最多 40 条</b></h3>
          <div class="slice-axis"><label for="slice-v-count"><i class="slice-axis-v"></i>竖向切线 <small>分出列</small></label><div class="slice-stepper"><button data-slice-adjust="v:-1" aria-label="减少一条竖向切线">−</button><input id="slice-v-count" data-slice-count="v" type="number" min="0" max="40" step="1" value="1" aria-label="竖向切线数量"><button data-slice-adjust="v:1" aria-label="增加一条竖向切线">＋</button></div><button class="slice-btn" data-slice-even="v">均分</button></div>
          <div class="slice-axis"><label for="slice-h-count"><i class="slice-axis-h"></i>横向切线 <small>分出行</small></label><div class="slice-stepper"><button data-slice-adjust="h:-1" aria-label="减少一条横向切线">−</button><input id="slice-h-count" data-slice-count="h" type="number" min="0" max="40" step="1" value="1" aria-label="横向切线数量"><button data-slice-adjust="h:1" aria-label="增加一条横向切线">＋</button></div><button class="slice-btn" data-slice-even="h">均分</button></div>
          <label class="slice-check"><input type="checkbox" data-slice="snap" checked>拖动时吸附整数像素</label><div class="slice-two slice-line-actions"><button class="slice-btn" data-slice-action="even-all">全部均分</button><button class="slice-btn" data-slice-action="clear-lines">清空切线</button></div>
          <p class="slice-hint">拖动预览中的切线，或输入下方坐标。重合与边缘切线会自动合并，按实际有效区域生成素材。</p>
          <div class="slice-lines" data-slice="lines" aria-label="切线像素坐标"></div>
        </section>
        <section class="slice-section" data-slice="sprite-controls" hidden><h3><span>02</span>精灵帧网格<b>等距切割</b></h3><div class="slice-two"><label class="slice-field">行数<input data-slice-option="rows" type="number" min="1" max="100" step="1" value="4" aria-label="精灵帧行数"></label><label class="slice-field">列数<input data-slice-option="columns" type="number" min="1" max="100" step="1" value="4" aria-label="精灵帧列数"></label></div><div class="slice-presets" aria-label="精灵帧常用布局">${[[1,4],[1,8],[2,2],[4,4],[8,8]].map(([r,c]) => `<button data-slice-grid="${r}:${c}">${r} × ${c}</button>`).join('')}</div><p class="slice-hint">行 × 列 = 帧数。每帧宽高一致，默认要求图片宽高可被列数、行数整除。</p><label class="slice-check"><input type="checkbox" data-slice="pad-frames">补透明边缘后等分</label><p class="slice-hint">不能整除时，向右侧、底部补透明像素再等分；原像素尺寸保持不变，可能产生全透明的末帧。</p><div class="slice-frame-info" data-slice="frame-info">设置行列后预览帧尺寸。</div></section>
        <section class="slice-section slice-commit"><h3><span>03</span>加入工作区<b data-slice="workspace-count">— / 100</b></h3><div class="slice-error" data-slice="error" role="alert" hidden></div><p class="slice-hint slice-capacity" data-slice="capacity">等待素材…</p><button class="slice-btn slice-primary" data-slice-action="confirm" disabled>确认切图并加入工作区</button><button class="slice-btn slice-cancel" data-slice-action="cancel" hidden>取消本次切图</button><progress data-slice="progress" hidden max="1" value="0"></progress><p class="slice-report" data-slice="report" role="status" aria-live="polite"></p><p class="slice-hint">新素材按行列命名并保留透明度，可继续绘画、拼接或导出。保存工作区项目可保留本次切图设置。</p></section>
      </aside>
    </div>`;

  const $ = name => mount.querySelector(`[data-slice="${name}"]`);
  const button = action => mount.querySelector(`[data-slice-action="${action}"]`);
  let sequence = 0;
  const makeLines = values => values.map(value => ({ id: `cut-${++sequence}`, value }));
  const state = {
    active: false, source: null, plan: null, mode: 'manual', rows: 4, columns: 4, padFrames: false, snap: true,
    lines: { v: makeLines([.5]), h: makeLines([.5]) }, savedSourceId: null,
    zoom: 1, panX: 0, panY: 0, fitMode: true, frame: null, previewFrame: null,
    hand: false, space: false, drag: null, selected: -1, busy: false, controller: null,
    planError: '', inputError: '', sourceError: '',
  };
  const canvas = $('canvas');
  const options = () => ({ mode: state.mode, rows: state.mode === 'sprite' ? state.rows : 1, columns: state.mode === 'sprite' ? state.columns : 1, padFrames: state.padFrames, vLines: state.lines.v.map(line => line.value), hLines: state.lines.h.map(line => line.value) });
  function sourceMatches() {
    const d = api.getDoc(), s = state.source;
    return !!s && d === s.document && d.id === s.id && d.revision === s.revision && d.width === s.width && d.height === s.height && d.name === s.name;
  }
  function releaseSource() {
    if (state.source?.canvas) state.source.canvas.width = state.source.canvas.height = 1;
    state.source = null;
  }
  function setReport(text, error = false) {
    $('report').textContent = text;
    $('report').classList.toggle('slice-report-error', error);
  }
  function capacityError() {
    if (!state.plan) return '';
    const docs = api.getDocs();
    const remaining = Math.max(0, MAX_DOCS - docs.length);
    if (state.plan.total > remaining) return `本次将新增 ${state.plan.total} 张素材，工作区还可加入 ${remaining} 张。请减少切块数量，或保存并关闭部分素材后再切图。`;
    const pixels = docs.reduce((sum, d) => sum + d.width * d.height * d.layers.length, 0);
    if (pixels + state.plan.outputPixels > MAX_WORKSPACE_PIXELS) return '新增切块后，工作区总图层像素将超过批量加入的 6,710 万像素容量。请保存并关闭部分素材后重试。';
    return '';
  }
  function syncActions() {
    const docs = api.getDocs(), remaining = Math.max(0, MAX_DOCS - docs.length);
    const error = state.sourceError || state.inputError || state.planError || capacityError();
    $('error').textContent = error; $('error').hidden = !error;
    $('workspace-count').textContent = `${docs.length} / ${MAX_DOCS}`;
    $('capacity').textContent = state.plan ? `${state.plan.total} 张新素材 · 工作区剩余 ${remaining} 个位置` : `工作区剩余 ${remaining} 个素材位置`;
    mount.querySelectorAll('button,input').forEach(el => { el.disabled = state.busy; });
    button('confirm').disabled = state.busy || !!error || !state.plan || !sourceMatches();
    button('confirm').textContent = state.busy ? '正在生成素材…' : '确认切图并加入工作区';
    button('cancel').disabled = !state.busy || state.controller?.signal.aborted;
    button('cancel').hidden = !state.busy;
    $('progress').hidden = !state.busy;
    for (const axis of ['v','h']) {
      mount.querySelector(`[data-slice-adjust="${axis}:-1"]`).disabled = state.busy || state.lines[axis].length === 0;
      mount.querySelector(`[data-slice-adjust="${axis}:1"]`).disabled = state.busy || state.lines[axis].length === 40;
    }
    canvas.setAttribute('aria-busy', String(state.busy));
  }
  function syncFields() {
    mount.querySelectorAll('[data-slice-mode]').forEach(el => el.setAttribute('aria-pressed', String(el.dataset.sliceMode === state.mode)));
    $('manual-controls').hidden = state.mode !== 'manual'; $('sprite-controls').hidden = state.mode !== 'sprite';
    for (const axis of ['v','h']) mount.querySelector(`[data-slice-count="${axis}"]`).value = state.lines[axis].length;
    for (const key of ['rows','columns']) mount.querySelector(`[data-slice-option="${key}"]`).value = state[key];
    $('snap').checked = state.snap; $('pad-frames').checked = state.padFrames;
    button('hand').setAttribute('aria-pressed', String(state.hand));
    $('stage-mode').textContent = state.mode === 'manual' ? '拖动切线调整位置' : '等距网格 · 按行编号';
    $('size-label').textContent = state.mode === 'manual' ? '切块尺寸' : '每帧尺寸';
    mount.querySelectorAll('[data-slice-grid]').forEach(el => el.setAttribute('aria-pressed', String(el.dataset.sliceGrid === `${state.rows}:${state.columns}`)));
    renderLines(); syncActions();
  }
  function renderLines() {
    const source = state.source;
    $('lines').innerHTML = ['v','h'].map(axis => {
      const size = source ? source[axis === 'v' ? 'width' : 'height'] : 1;
      return state.lines[axis].map((line, index) => `<div class="slice-line-chip ${axis === 'v' ? 'slice-vertical' : 'slice-horizontal'}"><label><span>${axis.toUpperCase()}${index + 1}</span><input data-slice-line="${line.id}" data-slice-axis="${axis}" type="number" min="0" max="${size}" step="1" value="${Math.round(line.value * size)}" aria-label="${axis === 'v' ? '竖向' : '横向'}切线 ${index + 1} 的${axis === 'v' ? '横' : '纵'}坐标"><small>px</small></label><button data-slice-delete="${line.id}" data-slice-axis="${axis}" aria-label="删除${axis === 'v' ? '竖向' : '横向'}切线 ${index + 1}">×</button></div>`).join('');
    }).join('') || '<p class="slice-hint">没有内部切线，将生成一张完整素材。</p>';
    $('lines').querySelectorAll('[data-slice-delete]').forEach(el => el.addEventListener('click', () => {
      if (state.busy) return;
      const axis = el.dataset.sliceAxis;
      state.lines[axis] = state.lines[axis].filter(line => line.id !== el.dataset.sliceDelete);
      changed();
    }));
    $('lines').querySelectorAll('[data-slice-line]').forEach(el => el.addEventListener('change', () => {
      if (state.busy || !state.source) return;
      const axis = el.dataset.sliceAxis, size = state.source[axis === 'v' ? 'width' : 'height'];
      const value = Number(el.value), line = state.lines[axis].find(item => item.id === el.dataset.sliceLine);
      if (el.value.trim() === '' || !Number.isInteger(value) || value < 0 || value > size) {
        state.inputError = `切线坐标请输入 0–${size} 之间的整数像素。`; syncActions(); return;
      }
      if (line) line.value = value / size;
      changed();
    }));
  }
  function changed({ fields = true, fit = false } = {}) {
    if (state.busy) return;
    state.inputError = ''; state.selected = -1; setReport('');
    calculate();
    if (fields) syncFields();
    if (fit) fitView();
    api.persist();
  }
  function calculate() {
    state.plan = null; state.planError = '';
    const source = state.source;
    if (source) {
      try { state.plan = createSlicePlan(source.width, source.height, options()); }
      catch (error) { state.planError = error.message; }
    }
    const p = state.plan;
    $('layout').textContent = p ? `${p.rows} 行 × ${p.columns} 列` : '—';
    $('count').textContent = p ? `${p.total} 张` : '—';
    if (p && state.mode === 'sprite') $('frame-size').textContent = `${p.frameWidth} × ${p.frameHeight} px`;
    else if (p) {
      const widths = p.rects.map(rect => rect.w), heights = p.rects.map(rect => rect.h);
      const range = values => Math.min(...values) === Math.max(...values) ? String(values[0]) : `${Math.min(...values)}–${Math.max(...values)}`;
      $('frame-size').textContent = `${range(widths)} × ${range(heights)} px`;
    } else $('frame-size').textContent = '—';
    $('frame-info').textContent = p && state.mode === 'sprite'
      ? `每帧 ${p.frameWidth} × ${p.frameHeight} px · 共 ${p.total} 帧${p.paddedX || p.paddedY ? `\n右侧 +${p.paddedX} px · 底部 +${p.paddedY} px\n补齐画布 ${p.outputWidth} × ${p.outputHeight} px` : '\n图片尺寸可整除，无需补边'}`
      : '设置行列后预览帧尺寸。';
    $('selection').textContent = state.selected >= 0 ? $('selection').textContent : '整数像素切割';
    scheduleThumbnails(); syncActions(); render();
  }
  function capture(force = false) {
    if (state.busy) { if (!sourceMatches()) state.controller?.abort(); return; }
    const d = api.getDoc();
    if (!force && sourceMatches()) { syncActions(); return; }
    cancelGesture();
    const previousId = state.source?.id ?? state.savedSourceId;
    releaseSource(); state.plan = null; state.sourceError = ''; state.inputError = '';
    state.selected = -1; setReport('');
    if (!d) {
      $('empty').hidden = false; $('filename').textContent = '在左侧选择要切割的素材'; $('source-name').textContent = '未选择素材';
      $('source-size').textContent = $('source-summary').textContent = '—'; calculate(); return;
    }
    try {
      const composite = api.getComposite(d);
      const snapshot = makeCanvas(d.width, d.height);
      snapshot.getContext('2d').putImageData(composite.getContext('2d').getImageData(0, 0, d.width, d.height), 0, 0);
      state.source = { document: d, id: d.id, revision: d.revision, width: d.width, height: d.height, name: d.name, canvas: snapshot };
      if (previousId && previousId !== d.id) state.lines = { v: makeLines([.5]), h: makeLines([.5]) };
      if (!previousId || previousId !== d.id) { state.rows = Math.min(state.rows, d.height); state.columns = Math.min(state.columns, d.width); }
      state.savedSourceId = d.id;
      $('filename').textContent = d.name; $('source-name').textContent = d.name;
      $('source-size').textContent = `${d.width} × ${d.height} px`; $('source-summary').textContent = `${d.width} × ${d.height} px`;
      $('empty').hidden = true;
      calculate(); syncFields(); fitView();
    } catch (error) {
      state.sourceError = error.message || '未能读取当前素材，请重新读取。';
      $('empty').hidden = false; syncActions(); render();
    }
  }
  function scheduleThumbnails() {
    if (state.previewFrame !== null) return;
    state.previewFrame = requestAnimationFrame(() => { state.previewFrame = null; renderThumbnails(); });
  }
  function renderThumbnails() {
    $('thumbnails').replaceChildren();
    const p = state.plan, source = state.source;
    $('preview-count').textContent = p ? `${p.total} 张` : '0 张';
    $('preview-note').textContent = p?.total > 100 ? '显示前 100 张 · 请减少切块后加入工作区' : '从左到右、从上到下编号';
    if (!p || !source) return;
    p.rects.slice(0, 100).forEach((rect, index) => {
      const cell = document.createElement('button'); cell.className = 'slice-thumbnail';
      cell.setAttribute('data-slice-preview', String(index)); cell.setAttribute('aria-pressed', String(state.selected === index));
      cell.setAttribute('aria-label', `第 ${rect.row + 1} 行第 ${rect.column + 1} 列，${rect.w} × ${rect.h} 像素`);
      cell.title = `R${rect.row + 1} C${rect.column + 1} · X ${rect.x}, Y ${rect.y} · ${rect.w} × ${rect.h} px`;
      const thumb = makeCanvas(112, 72), context = thumb.getContext('2d'); context.imageSmoothingEnabled = false;
      const scale = Math.min(104 / rect.w, 64 / rect.h, 8), dx = (112 - rect.w * scale) / 2, dy = (72 - rect.h * scale) / 2;
      if (rect.copyWidth > 0 && rect.copyHeight > 0) context.drawImage(source.canvas, rect.x, rect.y, rect.copyWidth, rect.copyHeight, dx, dy, rect.copyWidth * scale, rect.copyHeight * scale);
      const label = document.createElement('span'); label.textContent = state.mode === 'sprite' ? `${String(index + 1).padStart(3, '0')} · R${rect.row + 1} C${rect.column + 1}` : `R${rect.row + 1} C${rect.column + 1}`;
      const size = document.createElement('small'); size.textContent = `${rect.w} × ${rect.h}`;
      cell.append(thumb, label, size); cell.disabled = state.busy;
      cell.addEventListener('click', () => {
        if (state.busy) return;
        state.selected = state.selected === index ? -1 : index;
        $('thumbnails').querySelectorAll('[data-slice-preview]').forEach(el => el.setAttribute('aria-pressed', String(Number(el.dataset.slicePreview) === state.selected)));
        $('selection').textContent = state.selected < 0 ? '整数像素切割' : `R${rect.row + 1} C${rect.column + 1} · X ${rect.x} Y ${rect.y} · ${rect.w} × ${rect.h}`;
        render();
      });
      $('thumbnails').append(cell);
    });
  }

  function metrics() {
    const rect = canvas.getBoundingClientRect(), p = state.plan || state.source;
    const w = p?.outputWidth || p?.width || 1, h = p?.outputHeight || p?.height || 1;
    return { rect, w, h, x: 24 + (rect.width - 24 - w * state.zoom) / 2 + state.panX, y: 24 + (rect.height - 24 - h * state.zoom) / 2 + state.panY, z: state.zoom };
  }
  function fitView() {
    if (!state.source || !state.active) return;
    const { rect, w, h } = metrics();
    state.zoom = clamp(Math.min((Math.max(rect.width, 120) - 84) / w, (Math.max(rect.height, 120) - 84) / h), .01, 32);
    state.panX = state.panY = 0; state.fitMode = true; updateZoom();
  }
  function setZoom(value, point) {
    const old = metrics(), next = clamp(value, .01, 128);
    state.zoom = next; state.fitMode = false;
    if (point) {
      const after = metrics(); state.panX += point.x - after.x - (point.x - old.x) / old.z * next; state.panY += point.y - after.y - (point.y - old.y) / old.z * next;
    } else { state.panX *= next / old.z; state.panY *= next / old.z; }
    updateZoom();
  }
  function updateZoom() { $('zoom').textContent = `${Math.round(state.zoom * 1000) / 10}%`; render(); }
  function render() {
    if (!state.active || state.frame !== null) return;
    state.frame = requestAnimationFrame(() => { state.frame = null; draw(); });
  }
  function draw() {
    if (!state.active) return;
    const { rect, x, y, w, h, z } = metrics();
    if (rect.width < 1 || rect.height < 1) return;
    const dpr = Math.min(globalThis.devicePixelRatio || 1, 2), width = Math.round(rect.width * dpr), height = Math.round(rect.height * dpr);
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    const ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.fillStyle = '#171d25'; ctx.fillRect(0, 0, rect.width, rect.height);
    if (!state.source) return;
    ctx.save(); ctx.beginPath(); ctx.rect(24, 24, rect.width - 24, rect.height - 24); ctx.clip();
    ctx.save(); ctx.beginPath(); ctx.rect(x, y, w * z, h * z); ctx.clip();
    ctx.fillStyle = '#25303d'; ctx.fillRect(x, y, w * z, h * z);
    const left = Math.max(x, 24), top = Math.max(y, 24), right = Math.min(rect.width, x + w * z), bottom = Math.min(rect.height, y + h * z);
    ctx.fillStyle = '#2e3a49';
    for (let row = Math.floor(top / 12); row <= Math.ceil(bottom / 12); row++) for (let col = Math.floor(left / 12); col <= Math.ceil(right / 12); col++) if ((col + row) % 2 === 0) ctx.fillRect(col * 12, row * 12, 12, 12);
    ctx.imageSmoothingEnabled = false; ctx.drawImage(state.source.canvas, x, y, state.source.width * z, state.source.height * z);
    ctx.restore();
    ctx.strokeStyle = '#8a9bb16e'; ctx.lineWidth = 1; ctx.strokeRect(x, y, w * z, h * z);
    const plan = state.plan;
    if (plan?.paddedX || plan?.paddedY) { ctx.setLineDash([4, 3]); ctx.strokeStyle = '#a0bba3'; ctx.strokeRect(x, y, state.source.width * z, state.source.height * z); ctx.setLineDash([]); }
    if (plan && state.selected >= 0 && plan.rects[state.selected]) {
      const tile = plan.rects[state.selected]; ctx.fillStyle = '#efb1812e'; ctx.fillRect(x + tile.x * z, y + tile.y * z, tile.w * z, tile.h * z);
      ctx.strokeStyle = '#ffd09f'; ctx.lineWidth = 2; ctx.strokeRect(x + tile.x * z, y + tile.y * z, tile.w * z, tile.h * z);
    }
    const drawLine = (axis, value, label, active) => {
      const px = axis === 'v' ? x + value * z : y + value * z;
      if (axis === 'v' && (px < 24 || px > rect.width) || axis === 'h' && (px < 24 || px > rect.height)) return;
      ctx.lineWidth = active ? 2 : 1; ctx.strokeStyle = axis === 'v' ? '#eda76f' : '#91c5bd';
      ctx.beginPath(); if (axis === 'v') { ctx.moveTo(px, y); ctx.lineTo(px, y + h * z); } else { ctx.moveTo(x, px); ctx.lineTo(x + w * z, px); } ctx.stroke();
      if (label) {
        ctx.font = '10px ui-monospace, monospace'; const textWidth = ctx.measureText(label).width + 10;
        const bx = axis === 'v' ? clamp(px - textWidth / 2, 27, Math.max(27, rect.width - textWidth - 3)) : Math.max(27, x + 4);
        const by = axis === 'v' ? Math.max(28, y + 4) : clamp(px - 9, 27, Math.max(27, rect.height - 21));
        ctx.fillStyle = axis === 'v' ? '#754a2df2' : '#2b5c57f2'; ctx.fillRect(bx, by, textWidth, 18); ctx.fillStyle = '#f5e9dd'; ctx.fillText(label, bx + 5, by + 12);
      }
    };
    if (state.mode === 'manual') {
      for (const axis of ['v', 'h']) state.lines[axis].forEach((line, index) => {
        const pos = Math.round(line.value * state.source[axis === 'v' ? 'width' : 'height']);
        drawLine(axis, pos, state.lines[axis].length <= 12 || state.drag?.id === line.id ? `${axis.toUpperCase()}${index + 1} · ${Math.round(pos)}` : '', state.drag?.id === line.id);
      });
    } else if (plan) {
      plan.xEdges.slice(1, -1).forEach(value => drawLine('v', value)); plan.yEdges.slice(1, -1).forEach(value => drawLine('h', value));
    }
    if (plan && plan.total <= 100) {
      ctx.font = '10px ui-monospace, monospace';
      plan.rects.forEach((tile, index) => {
        if (tile.w * z < 38 || tile.h * z < 32) return;
        const tx = x + (tile.x + tile.w / 2) * z, ty = y + (tile.y + tile.h / 2) * z;
        if (tx < 24 || ty < 24 || tx > rect.width || ty > rect.height) return;
        const label = String(index + 1).padStart(state.mode === 'sprite' ? 3 : 2, '0');
        const sw = ctx.measureText(label).width + 10; ctx.fillStyle = '#15202acb'; ctx.fillRect(tx - sw / 2, ty - 9, sw, 18); ctx.fillStyle = '#d7e2ed'; ctx.fillText(label, tx - sw / 2 + 5, ty + 3);
      });
    }
    ctx.restore();
    // View-space rulers stay legible at any zoom; markers are never copied to assets.
    ctx.fillStyle = '#222c38'; ctx.fillRect(0, 0, rect.width, 24); ctx.fillRect(0, 0, 24, rect.height);
    const rawStep = 55 / z, power = 10 ** Math.floor(Math.log10(rawStep)), step = [1,2,5,10].find(n => n * power >= rawStep) * power;
    ctx.font = '9px ui-monospace, monospace'; ctx.fillStyle = '#8b9db5'; ctx.strokeStyle = '#526176'; ctx.lineWidth = 1;
    for (let v = Math.max(0, Math.ceil((24 - x) / z / step) * step); v <= Math.min(w, (rect.width - x) / z); v += step) {
      const px = x + v * z; ctx.beginPath(); ctx.moveTo(px, 18); ctx.lineTo(px, 24); ctx.stroke(); ctx.fillText(String(Math.round(v)), px + 3, 12);
    }
    for (let v = Math.max(0, Math.ceil((24 - y) / z / step) * step); v <= Math.min(h, (rect.height - y) / z); v += step) {
      const py = y + v * z; ctx.beginPath(); ctx.moveTo(18, py); ctx.lineTo(24, py); ctx.stroke(); ctx.save(); ctx.translate(11, py - 3); ctx.rotate(-Math.PI / 2); ctx.fillText(String(Math.round(v)), 0, 0); ctx.restore();
    }
    ctx.fillStyle = '#334252'; ctx.fillRect(0, 0, 24, 24); ctx.fillStyle = '#adbacb'; ctx.fillText('px', 6, 15);
  }

  function localPoint(event) { const rect = canvas.getBoundingClientRect(); return { x: event.clientX - rect.left, y: event.clientY - rect.top }; }
  function hitLine(point) {
    if (!state.source || state.mode !== 'manual') return null;
    const { x, y, w, h, z } = metrics();
    if (point.x < 24 || point.y < 24 || point.x < x - 12 || point.x > x + w * z + 12 || point.y < y - 12 || point.y > y + h * z + 12) return null;
    let found = null, distance = 10;
    for (const axis of ['v','h']) for (const line of state.lines[axis]) {
      const delta = Math.abs((axis === 'v' ? point.x - x : point.y - y) - Math.round(line.value * state.source[axis === 'v' ? 'width' : 'height']) * z);
      if (delta < distance) { found = { axis, id: line.id }; distance = delta; }
    }
    return found;
  }
  function finishGesture(cancel = false) {
    const drag = state.drag;
    if (!drag) return;
    state.drag = null;
    if (cancel) {
      if (drag.type === 'line') { const line = state.lines[drag.axis].find(line => line.id === drag.id); if (line) line.value = drag.original; calculate(); }
      else { state.panX = drag.panX; state.panY = drag.panY; state.fitMode = drag.fitMode; }
    } else if (drag.type === 'line') api.persist();
    try { if (canvas.hasPointerCapture?.(drag.pointerId)) canvas.releasePointerCapture(drag.pointerId); } catch {}
    renderLines(); syncActions(); render();
  }
  function cancelGesture() { finishGesture(true); }
  canvas.addEventListener('pointerdown', event => {
    if (state.busy || !state.source || ![0,1].includes(event.button)) return;
    if (state.drag) { cancelGesture(); return; }
    const point = localPoint(event), hit = !state.hand && !state.space && event.button !== 1 ? hitLine(point) : null;
    event.preventDefault(); canvas.focus({ preventScroll: true });
    state.drag = hit ? { ...hit, type: 'line', original: state.lines[hit.axis].find(line => line.id === hit.id).value, pointerId: event.pointerId }
      : { type: 'pan', start: point, panX: state.panX, panY: state.panY, fitMode: state.fitMode, pointerId: event.pointerId };
    canvas.setPointerCapture(event.pointerId); render();
  });
  canvas.addEventListener('pointermove', event => {
    if (!state.source || state.busy) return;
    const point = localPoint(event), view = metrics(), sourceX = (point.x - view.x) / view.z, sourceY = (point.y - view.y) / view.z;
    $('pointer').textContent = sourceX >= 0 && sourceY >= 0 && sourceX <= view.w && sourceY <= view.h ? `X ${Math.floor(sourceX)} · Y ${Math.floor(sourceY)}` : 'X — · Y —';
    const drag = state.drag;
    if (!drag) { const hit = !state.hand && !state.space && hitLine(point); canvas.style.cursor = hit ? hit.axis === 'v' ? 'col-resize' : 'row-resize' : 'grab'; return; }
    if (drag.pointerId !== event.pointerId) return;
    if (drag.type === 'pan') { state.panX = drag.panX + point.x - drag.start.x; state.panY = drag.panY + point.y - drag.start.y; state.fitMode = false; canvas.style.cursor = 'grabbing'; render(); return; }
    const size = state.source[drag.axis === 'v' ? 'width' : 'height'], raw = drag.axis === 'v' ? sourceX : sourceY;
    const coordinate = clamp(state.snap ? Math.round(raw) : raw, 0, size), line = state.lines[drag.axis].find(line => line.id === drag.id);
    if (line) line.value = coordinate / size;
    state.inputError = ''; state.selected = -1; setReport('');
    const input = $('lines').querySelector(`[data-slice-line="${drag.id}"]`); if (input) input.value = Math.round(coordinate);
    calculate();
  });
  canvas.addEventListener('pointerup', event => { if (state.drag?.pointerId === event.pointerId) finishGesture(); });
  canvas.addEventListener('pointercancel', event => { if (state.drag?.pointerId === event.pointerId) cancelGesture(); });
  canvas.addEventListener('lostpointercapture', event => { if (state.drag?.pointerId === event.pointerId) cancelGesture(); });
  canvas.addEventListener('pointerleave', () => { if (!state.drag) $('pointer').textContent = 'X — · Y —'; });
  canvas.addEventListener('wheel', event => { if (!state.active || state.busy || !state.source) return; event.preventDefault(); cancelGesture(); setZoom(state.zoom * Math.exp(-clamp(event.deltaY, -150, 150) * .002), localPoint(event)); }, { passive: false });
  canvas.addEventListener('contextmenu', event => event.preventDefault());
  document.addEventListener('keydown', event => {
    if (!state.active) return;
    if (event.key === 'Escape' && state.busy) { state.controller?.abort(); return; }
    if (isInput(event.target)) return;
    if (event.key === 'Escape') { cancelGesture(); return; }
    if (event.target?.closest?.('button,a,dialog,[role="button"]')) return;
    if (event.code === 'Space') { event.preventDefault(); state.space = true; canvas.style.cursor = 'grab'; }
  });
  document.addEventListener('keyup', event => { if (event.code === 'Space') { state.space = false; if (state.active) canvas.style.cursor = 'grab'; } });
  window.addEventListener('blur', () => { state.space = false; cancelGesture(); });
  new ResizeObserver(() => { if (!state.active) return; if (state.fitMode) fitView(); else render(); }).observe($('stage'));

  function setLineCount(axis, count) {
    if (!Number.isInteger(count) || count < 0 || count > 40) { state.inputError = '切线数量请输入 0–40 之间的整数。'; syncActions(); return; }
    while (state.lines[axis].length < count) {
      const existing = state.lines[axis].map(line => line.value), next = addCutLine(existing);
      state.lines[axis].push({ id: `cut-${++sequence}`, value: next.find(value => !existing.includes(value)) });
    }
    state.lines[axis] = state.lines[axis].slice(0, count); changed();
  }
  mount.querySelectorAll('[data-slice-mode]').forEach(el => el.addEventListener('click', () => {
    if (state.busy) return; cancelGesture(); state.mode = el.dataset.sliceMode; changed({ fit: true });
  }));
  mount.querySelectorAll('[data-slice-count]').forEach(el => el.addEventListener('change', () => { if (!state.busy) setLineCount(el.dataset.sliceCount, el.value.trim() === '' ? NaN : Number(el.value)); }));
  mount.querySelectorAll('[data-slice-adjust]').forEach(el => el.addEventListener('click', () => {
    if (state.busy) return; const [axis, delta] = el.dataset.sliceAdjust.split(':'); setLineCount(axis, state.lines[axis].length + Number(delta));
  }));
  mount.querySelectorAll('[data-slice-even]').forEach(el => el.addEventListener('click', () => {
    if (state.busy) return; const axis = el.dataset.sliceEven; state.lines[axis] = makeLines(evenCutLines(state.lines[axis].length)); changed();
  }));
  mount.querySelectorAll('[data-slice-option]').forEach(el => el.addEventListener('input', () => {
    if (state.busy) return;
    state[el.dataset.sliceOption] = el.value.trim() === '' ? NaN : Number(el.value); changed({ fields: false, fit: true });
  }));
  mount.querySelectorAll('[data-slice-grid]').forEach(el => el.addEventListener('click', () => {
    if (state.busy) return; [state.rows, state.columns] = el.dataset.sliceGrid.split(':').map(Number); changed({ fit: true });
  }));
  $('snap').addEventListener('change', event => { if (!state.busy) { state.snap = event.target.checked; api.persist(); } });
  $('pad-frames').addEventListener('change', event => { if (!state.busy) { state.padFrames = event.target.checked; changed({ fit: true }); } });

  function disposeDocuments(documents) {
    const accepted = new Set(api.getDocs());
    for (const d of documents || []) { if (accepted.has(d)) continue; for (const layer of d.layers || []) layer.canvas.width = layer.canvas.height = 1; d.history = []; d.historyIndex = -1; }
  }
  async function confirm() {
    if (state.busy || !state.active) return;
    if (!sourceMatches()) { capture(); setReport('来源已更新，请检查新的切图预览后再次确认。'); return; }
    calculate();
    const error = state.inputError || state.planError || capacityError();
    if (error || !state.plan) { syncActions(); return; }
    cancelGesture();
    const source = state.source, plan = state.plan, controller = new AbortController();
    let documents = [], committed = false;
    state.busy = true; state.controller = controller; $('progress').value = 0; $('progress').max = plan.total;
    setReport(`正在生成 ${plan.total} 张素材…`); syncActions();
    try {
      documents = await buildSliceDocuments(source.canvas, plan, {
        name: source.name, existingNames: api.getDocs().map(d => d.name), signal: controller.signal,
        onProgress({ completed, total }) { $('progress').value = completed; setReport(`正在生成素材 ${completed} / ${total}`); },
      });
      if (controller.signal.aborted) throw new DOMException('切图已取消。', 'AbortError');
      if (!sourceMatches()) throw new Error('源素材已发生变化，本次切图未加入工作区。请重新读取并确认。');
      // The host preflights the complete batch and pushes it in one transaction.
      api.addDocuments(documents, { switchTo: false }); committed = true;
      const message = `已将 ${documents.length} 张新素材加入左侧工作区。可选择任一切块继续绘画、拼接或导出。`;
      setReport(message); api.toast(`切图完成，已加入 ${documents.length} 张新素材。`);
    } catch (error) {
      if (!committed) disposeDocuments(documents);
      if (error.name === 'AbortError') setReport('已取消本次切图，工作区未添加素材。');
      else { setReport(error.message || '切图失败，请重试。', true); api.toast(error.message || '切图失败，请重试。', true); }
    } finally {
      state.busy = false; state.controller = null; syncActions();
      if (state.active && !sourceMatches()) capture();
    }
  }
  function handleAction(action) {
    if (action === 'cancel') { state.controller?.abort(); syncActions(); return; }
    if (state.busy) return;
    if (action === 'confirm') return confirm();
    if (action === 'import') return api.action('open');
    if (action === 'reload') { capture(true); return; }
    if (action === 'fit') { cancelGesture(); fitView(); return; }
    if (action === 'actual') { cancelGesture(); state.panX = state.panY = 0; setZoom(1); return; }
    if (action === 'zoom-in' || action === 'zoom-out') { cancelGesture(); setZoom(state.zoom * (action === 'zoom-in' ? 1.25 : .8)); return; }
    if (action === 'hand') { cancelGesture(); state.hand = !state.hand; syncFields(); return; }
    if (action === 'clear-lines') { state.lines = { v: [], h: [] }; changed(); return; }
    if (action === 'even-all') { for (const axis of ['v','h']) state.lines[axis] = makeLines(evenCutLines(state.lines[axis].length)); changed(); }
  }
  mount.querySelectorAll('[data-slice-action]').forEach(el => el.addEventListener('click', () => handleAction(el.dataset.sliceAction)));

  function serialize() {
    const positiveInteger = (value, fallback) => Number.isInteger(value) && value >= 1 && value <= 100 ? value : fallback;
    return { version: 1, mode: state.mode, sourceId: state.source?.id || state.savedSourceId, vLines: state.lines.v.map(line => line.value), hLines: state.lines.h.map(line => line.value), rows: positiveInteger(state.rows, 4), columns: positiveInteger(state.columns, 4), padFrames: state.padFrames, snap: state.snap };
  }
  function restore(saved) {
    state.controller?.abort(); cancelGesture(); releaseSource();
    const values = value => Array.isArray(value) && value.length <= 40 && value.every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1) ? value : [.5];
    const count = value => Number.isInteger(value) && value >= 1 && value <= 100 ? value : 4;
    state.mode = saved?.mode === 'sprite' ? 'sprite' : 'manual'; state.rows = count(saved?.rows); state.columns = count(saved?.columns);
    state.padFrames = saved?.padFrames === true; state.snap = saved?.snap !== false;
    state.lines = { v: makeLines(values(saved?.vLines)), h: makeLines(values(saved?.hLines)) };
    state.savedSourceId = typeof saved?.sourceId === 'string' ? saved.sourceId : null;
    state.plan = null; state.inputError = state.planError = state.sourceError = ''; state.selected = -1; state.hand = state.space = false; setReport(''); syncFields();
  }
  return {
    activate() { state.active = true; capture(); render(); },
    deactivate() { state.active = false; state.space = false; state.controller?.abort(); cancelGesture(); if (state.frame !== null) { cancelAnimationFrame(state.frame); state.frame = null; } if (state.previewFrame !== null) { cancelAnimationFrame(state.previewFrame); state.previewFrame = null; } releaseSource(); state.plan = null; },
    refresh() { if (state.active) capture(); }, serialize, restore, handleAction, isBusy: () => state.busy,
  };
}
