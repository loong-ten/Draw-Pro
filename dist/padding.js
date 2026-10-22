import { composite } from './core.js';
import { downloadBlob, exportAllZip } from './io.js';
import { findAlphaBounds, planPadding } from './padding-core.js';
import { paddedCanvas, applyPaddingSnapshot, duplicateWithPadding } from './padding-raster.js';

const MAX_LAYER_PIXELS = 128 * 1024 * 1024;
const DEFAULTS = { mode: 'ratio', ratioWidth: 1, ratioHeight: 1, scale: 1.5, targetWidth: 400, targetHeight: 200, center: 'content', margin: 0 };
const RATIOS = [[1,1],[4,3],[3,2],[16,9],[2,1],[3,1],[4,1],[1,2],[3,4],[9,16]];
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const escapeHTML = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const filename = name => String(name || '素材').replace(/\.[^.]+$/, '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').slice(0, 100);
const planKey = plan => `${plan.width},${plan.height},${plan.offsetX},${plan.offsetY}`;
const yieldUI = () => new Promise(resolve => setTimeout(resolve, 0));

export function createPadding(api, mount) {
  mount.innerHTML = `
    <div class="pad-root">
      <section class="pad-workspace" aria-label="透明扩边预览">
        <header class="pad-heading"><div><span class="pad-eyebrow">TRANSPARENT PADDING</span><h2>给像素留一点空间<span class="pad-auto-badge">自动居中</span></h2><p data-pad="filename">选择左侧素材开始</p></div><button class="pad-btn" data-pad-action="reload" title="以当前素材重新建立原图快照">↻ 重新读取</button></header>
        <div class="pad-toolbar"><div class="pad-segment" aria-label="扩边预览方式"><button data-pad-view="compare" aria-pressed="true">前后对比</button><button data-pad-view="result" aria-pressed="false">仅结果</button></div><div class="pad-zoom"><button class="pad-btn" data-pad-action="zoom-out" aria-label="缩小扩边预览">−</button><span data-pad="zoom">100%</span><button class="pad-btn" data-pad-action="zoom-in" aria-label="放大扩边预览">＋</button><button class="pad-btn" data-pad-action="fit">适合</button><button class="pad-btn" data-pad-action="actual">1:1</button></div><label class="pad-check"><input type="checkbox" data-pad="guides" checked>辅助标记</label></div>
        <div class="pad-notice" data-pad="notice" role="status">正在识别素材中的可见像素…</div>
        <div class="pad-stage" data-pad="stage">
          <div class="pad-pane" data-pad="before-pane"><div class="pad-pane-label"><span>原始素材</span><b data-pad="before-label">—</b></div><canvas data-pad="before" aria-label="扩边前的素材预览"></canvas></div>
          <div class="pad-pane" data-pad="after-pane"><div class="pad-pane-label"><span>扩边结果</span><b data-pad="after-label">—</b></div><canvas data-pad="after" aria-label="自动居中后的透明扩边预览"></canvas></div>
          <div class="pad-stage-error" data-pad="error" hidden role="alert"></div>
        </div>
        <div class="pad-legend"><span><i class="pad-key pad-key-bounds"></i>可见像素边界</span><span><i class="pad-key pad-key-source"></i>原画布范围</span><span><i class="pad-key pad-key-center"></i>目标中心</span><small>滚轮缩放 · 拖动平移 · 标记仅供预览</small></div>
        <div class="pad-summary"><div><span>读取尺寸</span><strong data-pad="source-size">—</strong></div><div><span>目标画布</span><strong data-pad="target-size" class="pad-accent">—</strong></div><div><span>可见像素范围</span><strong data-pad="bounds-size">—</strong></div><div><span>新增透明像素</span><strong data-pad="added">—</strong></div></div>
        <div class="pad-edges"><span>四边新增 <small>px</small></span><span>左 <b data-pad="left">—</b></span><span>右 <b data-pad="right">—</b></span><span>上 <b data-pad="top">—</b></span><span>下 <b data-pad="bottom">—</b></span></div>
        <details class="pad-batch-details" data-pad="batch-details"><summary>工作区批量预览 <span data-pad="batch-count"></span></summary><div class="pad-table-wrap"><table><thead><tr><th>素材</th><th>原始尺寸</th><th>扩边尺寸</th><th>状态</th></tr></thead><tbody data-pad="batch-rows"><tr><td colspan="4">点击右侧「预览工作区」查看逐张结果。</td></tr></tbody></table></div></details>
      </section>
      <aside class="pad-settings" aria-label="透明扩边参数">
        <section class="pad-section"><h3><span>01</span>扩边方式</h3><div class="pad-mode-switch" aria-label="扩边尺寸方式"><button data-pad-mode="ratio" aria-pressed="true">宽高比</button><button data-pad-mode="scale" aria-pressed="false">画布倍率</button><button data-pad-mode="size" aria-pressed="false">像素尺寸</button></div>
          <div data-pad="ratio-fields"><div class="pad-ratios">${RATIOS.map(([w,h]) => `<button data-pad-ratio="${w}:${h}" aria-pressed="${w===1&&h===1}" title="目标画布宽高比 ${w}:${h}"><i style="--ratio:${w}/${h}"></i>${w}:${h}</button>`).join('')}</div><div class="pad-two"><label class="pad-field">宽度比例<input type="number" min="1" max="10000" step="1" data-pad-option="ratioWidth" aria-label="自定义宽度比例" value="1"></label><label class="pad-field">高度比例<input type="number" min="1" max="10000" step="1" data-pad-option="ratioHeight" aria-label="自定义高度比例" value="1"></label></div><p class="pad-hint">计算符合比例的最小画布。3:1、4:1 适合横向武器素材。</p></div>
          <div data-pad="scale-fields" hidden><div class="pad-quick">${[1.25,1.5,2,3,4].map(n => `<button data-pad-scale="${n}">${n}×</button>`).join('')}</div><label class="pad-field">画布宽高至少扩大至<input type="number" min="1" max="32" step="0.05" data-pad-option="scale" value="1.5"><span class="pad-inline">倍 · 素材本身保持原像素尺寸</span></label><p class="pad-hint">需要更多空间才能自动居中时，会继续补足透明边。参数切换始终基于本次读取的原图。</p></div>
          <div data-pad="size-fields" hidden><div class="pad-two"><label class="pad-field">目标宽度 · px<input type="number" min="1" max="8192" step="1" data-pad-option="targetWidth" value="400"></label><label class="pad-field">目标高度 · px<input type="number" min="1" max="8192" step="1" data-pad-option="targetHeight" value="200"></label></div><div class="pad-quick">${[[48,48],[64,64],[128,128],[256,256],[400,200],[200,400],[512,512]].map(([w,h]) => `<button data-pad-size="${w}:${h}">${w}×${h}</button>`).join('')}</div><p class="pad-hint">尺寸不足时会提示所需空间，不裁去原图或缩小素材。</p></div>
        </section>
        <section class="pad-section"><h3><span>02</span>自动定位</h3><label class="pad-field">居中依据<select data-pad-option="center"><option value="content">可见像素包围盒 · 自动识别</option><option value="canvas">原画布中心 · 自动计算</option></select></label><div class="pad-detection"><span class="pad-detection-icon">⌖</span><div><strong data-pad="detection">自动识别中</strong><small data-pad="center-readout">无需点击或选择中心点</small></div></div><label class="pad-field">主体每边最少留白 · px<input type="number" min="0" max="4096" step="1" data-pad-option="margin" value="0"></label><p class="pad-hint">包含半透明边缘。按整数像素放置，奇偶尺寸的中心误差最多半个像素。完整保留原画布，包括已有透明边。</p></section>
        <section class="pad-section"><h3><span>03</span>应用与导出</h3><div class="pad-actions"><button class="pad-btn pad-primary" data-pad-action="apply" disabled>应用到当前素材</button><div class="pad-two"><button class="pad-btn" data-pad-action="duplicate" disabled>创建扩边副本</button><button class="pad-btn" data-pad-action="export" disabled>导出透明 PNG</button></div></div><p class="pad-hint" data-pad="apply-note">全部图层一起扩边，可撤销。共享参考按工作区坐标保留。</p></section>
        <section class="pad-section"><h3><span>04</span>工作区批量应用<b data-pad="doc-count">0 张</b></h3><label class="pad-check"><input type="checkbox" data-pad="uniform">全部统一为相同像素尺寸</label><p class="pad-hint" data-pad="batch-hint">每张素材独立识别中心，应用相同比例，输出尺寸可不同。</p><div class="pad-two"><button class="pad-btn" data-pad-action="preview-batch">预览工作区</button><button class="pad-btn pad-outline" data-pad-action="batch">批量应用扩边</button></div><button class="pad-btn pad-wide" data-pad-action="export-workspace">导出工作区 PNG ZIP</button><button class="pad-btn pad-wide" data-pad-action="cancel" hidden>停止批处理</button><progress data-pad="progress" value="0" max="1" hidden></progress><p class="pad-report" data-pad="report" aria-live="polite"></p><p class="pad-hint">批量应用修改工作区内的素材；每张各自支持撤销。ZIP 导出已应用的工作区结果。</p></section>
      </aside>
    </div>`;
  const $ = name => mount.querySelector(`[data-pad="${name}"]`);
  const actionButton = name => mount.querySelector(`[data-pad-action="${name}"]`);
  const state = {
    active: false, options: { ...DEFAULTS }, uniform: false, view: 'compare', guides: true,
    source: null, plan: null, expectedRevision: null, expectedWidth: 0, expectedHeight: 0,
    currentKey: '', overridePlan: null, zoom: 1, panX: 0, panY: 0, frame: null, drag: null,
    busy: false, cancel: false, batchRows: null, batchStamp: '', lastBatchStamp: '', capturing: false,
  };

  function docSignature(d) { return `${d.id}:${d.revision}:${d.width}:${d.height}`; }
  function workspaceStamp() { return `${JSON.stringify(state.options)}|${state.uniform}|${api.getDocs().map(docSignature).join('|')}`; }
  function matchesCurrent() {
    const d = api.getDoc();
    return !!state.source && d?.id === state.source.id && d.revision === state.expectedRevision && d.width === state.expectedWidth && d.height === state.expectedHeight && d.activeLayerId === state.source.activeLayerId;
  }
  function snapshot(d) {
    const canvas = composite(d);
    const bounds = findAlphaBounds(canvas.getContext('2d').getImageData(0, 0, d.width, d.height));
    return { id: d.id, name: d.name, revision: d.revision, width: d.width, height: d.height,
      bounds, canvas, layers: d.layers.map(layer => ({ ...layer })), activeLayerId: d.activeLayerId };
  }
  function rememberCurrent(d, key) {
    state.expectedRevision = d.revision; state.expectedWidth = d.width; state.expectedHeight = d.height;
    state.currentKey = key;
  }
  function updateActions() {
    const ready = !!state.source && !!state.plan && matchesCurrent() && !state.busy;
    const same = ready && planKey(state.plan) === state.currentKey;
    actionButton('apply').disabled = !ready || same;
    actionButton('apply').textContent = same ? '当前素材已符合预览' : '应用到当前素材';
    actionButton('duplicate').disabled = !ready || api.getDocs().length >= 100;
    actionButton('export').disabled = !ready;
    actionButton('reload').disabled = state.busy;
    actionButton('batch').disabled = state.busy || !api.getDocs().length || state.lastBatchStamp === workspaceStamp();
    actionButton('batch').textContent = state.lastBatchStamp === workspaceStamp() ? '本批次已应用' : '批量应用扩边';
    actionButton('preview-batch').disabled = state.busy || !api.getDocs().length;
    actionButton('export-workspace').disabled = state.busy || !api.getDocs().length;
    $('doc-count').textContent = `${api.getDocs().length} 张`;
  }
  function syncFields() {
    mount.querySelectorAll('[data-pad-option]').forEach(input => { input.value = state.options[input.dataset.padOption]; });
    mount.querySelectorAll('[data-pad-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.padMode === state.options.mode)));
    for (const mode of ['ratio', 'scale', 'size']) $(mode + '-fields').hidden = state.options.mode !== mode;
    mount.querySelectorAll('[data-pad-ratio]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.padRatio === `${state.options.ratioWidth}:${state.options.ratioHeight}`)));
    mount.querySelectorAll('[data-pad-scale]').forEach(button => button.setAttribute('aria-pressed', String(Number(button.dataset.padScale) === state.options.scale)));
    mount.querySelectorAll('[data-pad-size]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.padSize === `${state.options.targetWidth}:${state.options.targetHeight}`)));
    mount.querySelectorAll('[data-pad-view]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.padView === state.view)));
    $('before-pane').hidden = state.view !== 'compare';
    $('stage').classList.toggle('pad-result-only', state.view === 'result');
    $('uniform').checked = state.uniform; $('guides').checked = state.guides;
    $('batch-hint').textContent = state.options.mode === 'size' ? '全部使用指定像素尺寸；无法完整容纳的素材会标出原因并跳过。' : state.uniform ? '先计算各张所需空间，再把有效素材统一为相同的画布尺寸。' : `每张素材独立识别中心，使用相同${state.options.mode === 'ratio' ? '宽高比' : '倍率'}。`;
  }
  function calculate(shouldFit = false) {
    if (!state.source) return;
    const s = state.source;
    $('filename').textContent = s.name;
    $('source-size').textContent = `${s.width} × ${s.height}`;
    $('before-label').textContent = `${s.width} × ${s.height} px`;
    $('bounds-size').textContent = s.bounds ? `${s.bounds.width} × ${s.bounds.height}` : '全透明';
    $('detection').textContent = s.bounds ? '已识别可见像素边界' : '未发现可见像素';
    $('error').hidden = true;
    state.plan = null;
    try {
      const p = state.overridePlan || planPadding(s, state.options);
      state.plan = p;
      $('target-size').textContent = `${p.width} × ${p.height}`;
      $('after-label').textContent = `${p.width} × ${p.height} px`;
      $('added').textContent = (p.width * p.height - s.width * s.height).toLocaleString();
      for (const side of ['left','right','top','bottom']) $(side).textContent = p[side];
      $('center-readout').textContent = `原图中心位置 X ${p.centerX} · Y ${p.centerY}`;
      $('notice').textContent = !s.bounds ? '全透明素材：自动采用画布中心；设置留白时以整个原画布计算。' : state.options.center === 'canvas' ? '自动采用原画布中心 · 全部图层保持相对位置' : '自动检测非透明像素并居中 · 无需手动选择中心点';
      $('notice').classList.remove('pad-warning');
      $('apply-note').textContent = state.currentKey !== `${s.width},${s.height},0,0` ? '已应用。修改参数仍基于本次读取的原图；重新读取后可继续扩边。每张素材可撤销。' : '全部图层一起扩边，可撤销。共享参考按工作区坐标保留。';
    } catch (error) {
      $('error').textContent = error.message; $('error').hidden = false;
      $('notice').textContent = '请调整参数，预览有效后才能应用。'; $('notice').classList.add('pad-warning');
      $('target-size').textContent = $('after-label').textContent = '尺寸不可用';
      $('added').textContent = '—';
      for (const side of ['left','right','top','bottom']) $(side).textContent = '—';
    }
    updateActions();
    if (shouldFit) fit(); else render();
  }
  function capture(force = false) {
    if (state.busy || state.capturing || !api.getDoc()) return;
    if (!force && matchesCurrent()) { updateActions(); return; }
    state.capturing = true;
    try {
      const d = api.getDoc();
      state.source = snapshot(d);
      state.overridePlan = null;
      rememberCurrent(d, `${d.width},${d.height},0,0`);
      calculate(true);
    } catch (error) {
      state.source = null; state.plan = null;
      $('error').textContent = error.message; $('error').hidden = false;
      updateActions();
    } finally { state.capturing = false; }
  }
  function changeOptions(patch, fromInput = false) {
    if (state.busy) return;
    Object.assign(state.options, patch);
    state.overridePlan = null;
    state.batchRows = null; state.batchStamp = '';
    $('batch-count').textContent = '参数已更新';
    $('batch-rows').innerHTML = '<tr><td colspan="4">参数已更新，请重新预览工作区。</td></tr>';
    if (!fromInput) syncFields();
    else {
      mount.querySelectorAll('[data-pad-ratio]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.padRatio === `${state.options.ratioWidth}:${state.options.ratioHeight}`)));
      mount.querySelectorAll('[data-pad-scale]').forEach(button => button.setAttribute('aria-pressed', String(Number(button.dataset.padScale) === state.options.scale)));
    }
    calculate(true); api.persist();
  }

  function fit() {
    if (!state.source || !state.active) return;
    const rect = $('after-pane').getBoundingClientRect();
    const p = state.plan || state.source;
    state.panX = state.panY = 0;
    setZoom(clamp(Math.min((Math.max(80, rect.width) - 64) / p.width, (Math.max(120, rect.height) - 78) / p.height), .01, 16));
  }
  function setZoom(z, point) {
    const previous = state.zoom;
    state.zoom = clamp(z, .01, 64);
    if (point) {
      state.panX = point.x - (point.x - state.panX) * state.zoom / previous;
      state.panY = point.y - (point.y - state.panY) * state.zoom / previous;
    } else { state.panX *= state.zoom / previous; state.panY *= state.zoom / previous; }
    $('zoom').textContent = `${Math.round(state.zoom * 100)}%`;
    render();
  }
  function render() {
    if (!state.active || state.frame !== null) return;
    state.frame = requestAnimationFrame(() => {
      state.frame = null;
      if (state.view === 'compare') draw($('before'), false);
      draw($('after'), true);
    });
  }
  function draw(canvas, after) {
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.round(rect.width * dpr), height = Math.round(rect.height * dpr);
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#171c22'; ctx.fillRect(0, 0, rect.width, rect.height);
    const s = state.source, p = after ? state.plan : s;
    if (!s || !p) return;
    const z = state.zoom, x = Math.round(rect.width / 2 - p.width * z / 2 + state.panX), y = Math.round(rect.height / 2 - p.height * z / 2 + state.panY);
    const dx = after ? p.offsetX : 0, dy = after ? p.offsetY : 0;
    ctx.save(); ctx.beginPath(); ctx.rect(x, y, p.width*z, p.height*z); ctx.clip();
    ctx.fillStyle = '#29313a'; ctx.fillRect(x, y, p.width*z, p.height*z);
    ctx.fillStyle = '#333d48';
    for (let yy = Math.max(y, y + Math.floor(-y/12)*12); yy < Math.min(rect.height, y+p.height*z); yy += 12) {
      for (let xx = Math.max(x, x + Math.floor(-x/12)*12); xx < Math.min(rect.width, x+p.width*z); xx += 12) {
        if ((Math.round((xx-x)/12) + Math.round((yy-y)/12)) % 2 === 0) ctx.fillRect(xx, yy, 12, 12);
      }
    }
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(s.canvas, x+dx*z, y+dy*z, s.width*z, s.height*z);
    if (state.guides) {
      ctx.lineWidth = 1;
      if (after) {
        ctx.strokeStyle = '#8eabc7cc'; ctx.setLineDash([5,4]);
        ctx.strokeRect(x+dx*z+.5, y+dy*z+.5, s.width*z-1, s.height*z-1);
      }
      if (s.bounds) {
        const b = s.bounds;
        ctx.strokeStyle = '#f5b180'; ctx.setLineDash([]);
        ctx.strokeRect(x+(dx+b.x)*z, y+(dy+b.y)*z, b.width*z, b.height*z);
      }
      if (after) {
        ctx.strokeStyle = '#9ad8ba'; ctx.setLineDash([3,5]);
        ctx.beginPath(); ctx.moveTo(x+p.width*z/2, y); ctx.lineTo(x+p.width*z/2,y+p.height*z);
        ctx.moveTo(x, y+p.height*z/2); ctx.lineTo(x+p.width*z,y+p.height*z/2); ctx.stroke();
        ctx.setLineDash([]); ctx.beginPath(); ctx.arc(x+p.width*z/2,y+p.height*z/2,4,0,Math.PI*2); ctx.stroke();
      }
    }
    ctx.restore(); ctx.strokeStyle = after ? '#728b81' : '#627182'; ctx.lineWidth = 1; ctx.setLineDash([]);
    ctx.strokeRect(x-.5,y-.5,p.width*z+1,p.height*z+1);
  }

  function assertReady() {
    if (!state.plan || !state.source) throw new Error('请先设置有效的扩边尺寸。');
    if (!matchesCurrent()) { capture(true); throw new Error('素材已有编辑，已重新读取，请核对更新后的预览。'); }
  }
  function checkBudget(doc, source, plan, duplicate = false) {
    const total = api.getDocs().reduce((sum, d) => sum + d.width*d.height*d.layers.length, 0);
    const next = total + plan.width*plan.height*source.layers.length - (duplicate ? 0 : doc.width*doc.height*doc.layers.length);
    if (next > MAX_LAYER_PIXELS) throw new Error('扩边后的工作区图层像素总量过大，请减小目标尺寸或拆分工作区。');
  }
  function applyCurrent() {
    assertReady();
    const d = api.getDoc(), p = state.plan;
    if (planKey(p) === state.currentKey) return;
    checkBudget(d, state.source, p);
    applyPaddingSnapshot(d, state.source, p);
    rememberCurrent(d, planKey(p));
    api.getState().selection = null; api.getState().lastAction = 'image';
    state.lastBatchStamp = ''; state.batchRows = null;
    calculate(); api.refresh(); api.persist();
    api.toast(`已扩边至 ${p.width} × ${p.height} px，全部 ${d.layers.length} 个图层已保留，可撤销。`);
  }
  function duplicate() {
    assertReady();
    if (api.getDocs().length >= 100) throw new Error('工作区最多 100 张素材，请先关闭部分图片。');
    checkBudget(api.getDoc(), state.source, state.plan, true);
    const d = duplicateWithPadding(state.source, state.plan, `${filename(state.source.name)}-padding.png`);
    api.addDocument(d, { switchTo: true });
    capture(true); api.toast('已创建保留全部图层的扩边副本。');
  }
  async function exportPNG() {
    assertReady();
    const p = state.plan, s = state.source;
    const canvas = paddedCanvas(s.canvas, p);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('PNG 编码失败，请降低目标尺寸后重试。');
    downloadBlob(blob, `${filename(s.name)}-padding-${p.width}x${p.height}.png`);
    api.toast(`已生成 ${p.width} × ${p.height} 透明 PNG，辅助标记不会写入图片。`);
  }

  function busy(value, cancellable = true) {
    state.busy = value;
    mount.setAttribute('aria-busy', String(value));
    mount.querySelectorAll('[data-pad-option],[data-pad-mode],[data-pad-ratio],[data-pad-scale],[data-pad-size],[data-pad="uniform"]').forEach(control => { control.disabled = value; });
    actionButton('cancel').hidden = !value || !cancellable; $('progress').hidden = !value;
    updateActions();
  }
  function renderBatchRows() {
    const rows = state.batchRows || [];
    $('batch-count').textContent = `${rows.length} 张`;
    $('batch-rows').innerHTML = rows.map(row => `<tr><td title="${escapeHTML(row.name)}">${escapeHTML(row.name)}</td><td>${row.width} × ${row.height}</td><td>${row.plan ? `${row.plan.width} × ${row.plan.height}` : '—'}</td><td class="${row.error ? 'pad-error-text' : row.applied ? 'pad-success-text' : ''}">${escapeHTML(row.error || row.status || (row.bounds ? '可应用' : '画布中心'))}</td></tr>`).join('');
    $('batch-details').open = true;
  }
  async function prepareBatch() {
    const stamp = workspaceStamp();
    if (state.batchRows && state.batchStamp === stamp) return state.batchRows;
    const docs = [...api.getDocs()];
    const options = { ...state.options };
    const rows = [];
    $('progress').max = docs.length; $('progress').value = 0;
    for (let i=0;i<docs.length;i++) {
      if (state.cancel) break;
      const d = docs[i];
      const row = { doc: d, id: d.id, name: d.name, revision: d.revision, currentWidth: d.width, currentHeight: d.height, width: d.width, height: d.height, layerCount: d.layers.length, bounds: null, plan: null, error: '' };
      try {
        // The active preview uses its immutable read snapshot, including after applying it.
        const existing = matchesCurrent() && d.id === state.source.id ? state.source : null;
        if (existing) {
          row.width = existing.width; row.height = existing.height; row.bounds = existing.bounds;
          row.source = existing; row.currentKey = state.currentKey;
        } else {
          const image = composite(d);
          row.bounds = findAlphaBounds(image.getContext('2d').getImageData(0,0,d.width,d.height));
          row.currentKey = `${d.width},${d.height},0,0`;
        }
        row.plan = planPadding(row, options);
      } catch (error) { row.error = error.message; }
      rows.push(row);
      $('report').textContent = `正在分析 ${i+1} / ${docs.length} · ${d.name}`;
      $('progress').value = i+1;
      await yieldUI();
    }
    if (state.uniform && rows.length && !state.cancel) {
      const valid = rows.filter(row => row.plan && !row.error);
      if (valid.length) {
        const targetWidth = Math.max(...valid.map(row => row.plan.width));
        const targetHeight = Math.max(...valid.map(row => row.plan.height));
        for (const row of valid) {
          try { row.plan = planPadding(row, { ...options, mode:'size', targetWidth, targetHeight }); }
          catch (error) { row.plan = null; row.error = error.message; }
        }
      }
    }
    state.batchRows = rows; state.batchStamp = state.cancel ? '' : stamp;
    renderBatchRows();
    return rows;
  }
  async function previewBatch() {
    state.cancel = false; busy(true);
    try {
      const rows = await prepareBatch();
      $('report').textContent = state.cancel ? '已停止分析；尚未应用扩边。' : `预览完成：${rows.filter(row=>!row.error).length} 张可应用，${rows.filter(row=>row.error).length} 张尺寸不适用。`;
    } finally { if(state.cancel) state.batchStamp=''; busy(false); }
  }
  async function applyBatch() {
    state.cancel = false; busy(true);
    let completed = 0, unchanged = 0, prepared = false;
    try {
      const rows = await prepareBatch();
      if (state.cancel) return;
      prepared = true;
      const docsNow = api.getDocs();
      let projected = docsNow.reduce((sum,d)=>sum+d.width*d.height*d.layers.length,0);
      for (const row of rows) if (!row.error && row.plan && docsNow.includes(row.doc)) projected += row.plan.width*row.plan.height*row.layerCount-row.doc.width*row.doc.height*row.doc.layers.length;
      if (projected > MAX_LAYER_PIXELS) throw new Error('批量扩边会超过工作区像素容量，请减小目标尺寸或分批处理。尚未应用本批次。');
      $('progress').max = rows.length; $('progress').value = 0;
      for (let i=0;i<rows.length;i++) {
        if (state.cancel) break;
        const row = rows[i], d = row.doc;
        if (!row.error && row.plan) {
          try {
            if (!api.getDocs().includes(d) || d.revision !== row.revision || d.width !== row.currentWidth || d.height !== row.currentHeight) throw new Error('素材在预览后发生变化，请重新预览');
            const source = row.source || { width:row.width, height:row.height, layers:d.layers.map(layer=>({...layer})), activeLayerId:d.activeLayerId };
            if (planKey(row.plan) === row.currentKey) { unchanged++; row.status = '已符合'; }
            else {
              checkBudget(d, source, row.plan);
              applyPaddingSnapshot(d, source, row.plan);
              // Keep the original read snapshot so a stopped batch can resume
              // without applying a scale multiplier again to completed items.
              row.source = source;
              row.revision = d.revision; row.currentWidth = d.width; row.currentHeight = d.height;
              row.currentKey = planKey(row.plan);
              row.applied = true; row.status = '已应用'; completed++;
            }
          } catch (error) { row.error = error.message; }
        }
        $('report').textContent = `正在应用 ${i+1} / ${rows.length} · 已完成 ${completed} 张`;
        $('progress').value = i+1;
        await yieldUI();
      }
      if (!state.cancel) state.lastBatchStamp = workspaceStamp();
    } finally {
      const rows = state.batchRows || [];
      const failed = rows.filter(row=>row.error).length;
      const pending = rows.filter(row=>!row.error && !row.status).length;
      $('report').textContent = `${state.cancel?'已停止':'处理结束'}：应用 ${completed} 张，已符合 ${unchanged} 张，未处理 ${pending} 张，失败 ${failed} 张。${completed ? '可切换到各素材分别撤销。' : ''}`;
      renderBatchRows();
      // A partial application retains a resumable plan only while every source
      // still matches. Analysis cancellation and external changes rebuild it.
      state.batchStamp = prepared && rows.length === api.getDocs().length && rows.every(row=>api.getDocs().includes(row.doc) && row.doc.revision===row.revision && row.doc.width===row.currentWidth && row.doc.height===row.currentHeight) ? workspaceStamp() : '';
      // Selection can change during any yielded step, including after its row
      // was processed. Reconcile the selected document once, at the end.
      const selected = rows.find(row=>row.doc===api.getDoc());
      if (prepared && selected && !selected.error && selected.plan && selected.doc.revision===selected.revision && selected.doc.width===selected.currentWidth && selected.doc.height===selected.currentHeight) {
        try {
          const source = selected.source || snapshot(selected.doc);
          state.source = { ...source, id:selected.id, name:selected.name, width:selected.width, height:selected.height,
            bounds:selected.bounds, activeLayerId:selected.doc.activeLayerId, canvas:source.canvas || composite(source) };
          rememberCurrent(selected.doc, selected.currentKey);
          state.overridePlan = selected.plan;
        } catch { state.source=null;state.plan=null;state.overridePlan=null; }
      }
      api.getState().selection = null; api.getState().lastAction = 'image';
      busy(false); syncFields(); calculate(); api.refresh(); api.persist();
      if (completed) api.toast(`已为 ${completed} 张素材应用透明扩边；全部图层保留，每张可撤销。`);
    }
  }

  for (const canvas of [$('before'),$('after')]) {
    canvas.addEventListener('wheel', event => {
      event.preventDefault(); event.stopPropagation();
      const r = canvas.getBoundingClientRect();
      setZoom(state.zoom*Math.exp(-event.deltaY*.0015), {x:event.clientX-r.left-r.width/2,y:event.clientY-r.top-r.height/2});
    }, { passive:false });
    canvas.addEventListener('pointerdown', event => {
      if (![0,1].includes(event.button)) return;
      event.preventDefault(); canvas.setPointerCapture(event.pointerId);
      state.drag = {id:event.pointerId,x:event.clientX,y:event.clientY,panX:state.panX,panY:state.panY};
    });
    canvas.addEventListener('pointermove', event => {
      if (state.drag?.id !== event.pointerId) return;
      state.panX=state.drag.panX+event.clientX-state.drag.x; state.panY=state.drag.panY+event.clientY-state.drag.y; render();
    });
    for (const name of ['pointerup','pointercancel','lostpointercapture']) canvas.addEventListener(name,()=>{state.drag=null;});
  }
  mount.addEventListener('input', event => {
    const input = event.target.closest('[data-pad-option]');
    if (!input || input.tagName === 'SELECT') return;
    const value = input.value === '' ? NaN : Number(input.value);
    changeOptions({[input.dataset.padOption]:value},true);
  });
  mount.addEventListener('change', event => {
    if (event.target.matches('select[data-pad-option]')) changeOptions({[event.target.dataset.padOption]:event.target.value});
    if (event.target === $('uniform')) { state.uniform=event.target.checked;changeOptions({}); }
    if (event.target === $('guides')) {state.guides=event.target.checked;render();api.persist();}
  });
  const actions = {
    reload:()=>{state.lastBatchStamp='';state.batchRows=null;state.batchStamp='';capture(true);},
    apply:applyCurrent, duplicate, export:exportPNG, 'preview-batch':previewBatch, batch:applyBatch,
    cancel:()=>{state.cancel=true;}, fit, actual:()=>setZoom(1), 'zoom-in':()=>setZoom(state.zoom*1.25), 'zoom-out':()=>setZoom(state.zoom/1.25),
    'export-workspace':async()=>{busy(true,false);try{await exportAllZip(api.getDocs(),'png');api.toast('工作区 PNG 已打包，下载内容为当前已应用的素材。');}finally{busy(false);}},
  };
  mount.addEventListener('click', async event => {
    const button=event.target.closest('button');
    if (!button || button.disabled) return;
    try {
      if (button.dataset.padMode) changeOptions({mode:button.dataset.padMode});
      if (button.dataset.padRatio) {const [ratioWidth,ratioHeight]=button.dataset.padRatio.split(':').map(Number);changeOptions({ratioWidth,ratioHeight});}
      if (button.dataset.padScale) changeOptions({scale:Number(button.dataset.padScale)});
      if (button.dataset.padSize) {const [targetWidth,targetHeight]=button.dataset.padSize.split(':').map(Number);changeOptions({targetWidth,targetHeight});}
      if (button.dataset.padView) {state.view=button.dataset.padView;syncFields();fit();api.persist();}
      if (button.dataset.padAction && (!state.busy || ['cancel','fit','actual','zoom-in','zoom-out'].includes(button.dataset.padAction))) await actions[button.dataset.padAction]?.();
    } catch(error) {api.toast(error.message || '透明扩边未能完成，请重试。',true);}
  });
  new ResizeObserver(()=>{if(state.active)fit();}).observe($('after-pane'));
  syncFields();
  return {
    activate() { state.active=true;capture();fit(); },
    deactivate() { state.active=false;state.drag=null;if(state.frame!==null){cancelAnimationFrame(state.frame);state.frame=null;} },
    refresh() { if(state.active && !state.busy) capture(); },
    isBusy:()=>state.busy,
    handleAction(name) { if(!state.busy)return actions[name]?.(); },
    serialize:()=>({options:{...state.options},uniform:state.uniform,view:state.view,guides:state.guides}),
    restore(saved) {
      const options = {...DEFAULTS};
      for (const key of Object.keys(DEFAULTS)) {
        const value=saved?.options?.[key];
        if (typeof DEFAULTS[key] === 'number') {if(typeof value==='number'&&Number.isFinite(value))options[key]=value;}
        else if(typeof value==='string')options[key]=value;
      }
      if(!['ratio','scale','size'].includes(options.mode))options.mode='ratio';
      if(!['content','canvas'].includes(options.center))options.center='content';
      state.options=options;state.uniform=Boolean(saved?.uniform);state.view=saved?.view==='result'?'result':'compare';state.guides=saved?.guides!==false;
      state.source=null;state.plan=null;state.overridePlan=null;state.batchRows=null;state.batchStamp='';state.lastBatchStamp='';syncFields();
    },
  };
}
