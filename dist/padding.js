import { composite } from './core.js';
import { downloadBlob, exportAllZip } from './io.js';
import { findAlphaBounds, planPadding } from './padding-core.js';
import { paddedCanvas, paddedLayersAsync, applyPaddingSnapshot, duplicateWithPadding } from './padding-raster.js';
import { drawTransparencyBackground } from './transparency-background.js';

const MAX_LAYER_PIXELS = 128 * 1024 * 1024;
const DEFAULTS = { mode: 'ratio', ratioWidth: 1, ratioHeight: 1, scale: 1.5, targetWidth: 400, targetHeight: 200, resizeWidth: 48, resizeHeight: 48, resizeFit: 'stretch', resizeSizeMode: 'dimensions', resizePercent: 100, resizeLongEdge: 256, resizeAlgorithm: 'nearest', center: 'content', margin: 0 };
const ALGORITHMS = {
  nearest: { name: '最近邻', label: '最近邻 · 像素画（默认）', hint: '直接选取原像素，不混合颜色。适合像素画、图块与精灵；整数倍放大更利落，缩小时可能丢失细线。' },
  area: { name: '面积平均', label: '面积平均 · 缩小与缩略图', hint: '按源像素覆盖面积求平均，适合缩略图和大幅缩小；会混合颜色，放大时不是细节增强算法。' },
  bilinear: { name: '双线性', label: '双线性 · 轻柔平滑', hint: '平滑相邻像素，边缘较柔和。适合快速预览和自然过渡，不适合需要保持硬边的像素素材。' },
  bicubic: { name: '双三次', label: '双三次 · 插画与通用缩放', hint: '使用三次插值，在平滑与锐度之间折中。适合插画、UI 和一般图片，强对比边缘可能出现轻微光晕。' },
  lanczos3: { name: 'Lanczos 3', label: 'Lanczos 3 · 细节优先', hint: '使用三叶 Lanczos 滤波，适合照片和精细缩小；计算较多，强对比边缘可能出现振铃或光晕。' },
};
const SIZE_MODES = { dimensions: '指定宽高', percent: '百分比 / 倍率', width: '固定宽度 · 等比', height: '固定高度 · 等比', 'long-edge': '固定长边 · 等比' };
const FITS = {
  stretch: { label: '直接拉伸 · 填满尺寸', hint: '输出严格等于输入宽高；原图与目标比例不同时会拉伸。' },
  contain: { label: '等比完整 · 居中补透明', hint: '完整保留原图，等比缩放后居中放入目标画布，空余区域补透明。' },
  cover: { label: '等比填满 · 居中裁切', hint: '保持比例并填满目标画布，超出目标比例的两侧或上下部分会被裁掉。' },
  inside: { label: '等比适应 · 不补边', hint: '把输入宽高作为边界框，输出实际等比尺寸；不额外补透明边。' },
};
const RATIOS = [[1,1],[4,3],[3,2],[16,9],[2,1],[3,1],[4,1],[1,2],[3,4],[9,16]];
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const escapeHTML = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const filename = name => String(name || '素材').replace(/\.[^.]+$/, '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').slice(0, 100);
const planKey = plan => {
  const geometry = `${plan.width},${plan.height},${plan.offsetX},${plan.offsetY},${plan.contentWidth ?? plan.width-plan.left-plan.right},${plan.contentHeight ?? plan.height-plan.top-plan.bottom}`;
  return plan.operation === 'resize' && plan.changed ? `${geometry}|${plan.algorithm || 'nearest'}|${plan.sourceRect ? JSON.stringify(plan.sourceRect) : 'full'}` : geometry;
};
const identityKey = (width, height) => `${width},${height},0,0,${width},${height}`;
const yieldUI = () => new Promise(resolve => setTimeout(resolve, 0));

export function createPadding(api, mount) {
  mount.innerHTML = `
    <div class="pad-root">
      <section class="pad-workspace" aria-label="透明扩边预览">
        <header class="pad-heading"><div><span class="pad-eyebrow">TRANSPARENT PADDING & RESIZE</span><h2><span data-pad="heading">给像素留一点空间</span><span class="pad-auto-badge" data-pad="badge">自动居中</span></h2><p data-pad="filename">选择左侧素材开始</p></div><button class="pad-btn" data-pad-action="reload" title="以当前素材重新建立原图快照">↻ 重新读取</button></header>
        <div class="pad-toolbar"><div class="pad-segment" aria-label="扩边预览方式"><button data-pad-view="compare" aria-pressed="true">前后对比</button><button data-pad-view="result" aria-pressed="false">仅结果</button></div><label class="pad-background">背景<select data-pad="background" aria-label="扩边预览背景" title="只改变预览背景，不写入素材或导出图片"><option value="studio">深色摄影棚</option><option value="checker">透明棋盘格</option><option value="transparent">透明背景</option></select></label><div class="pad-zoom"><button class="pad-btn" data-pad-action="zoom-out" aria-label="缩小扩边预览">−</button><span data-pad="zoom">100%</span><button class="pad-btn" data-pad-action="zoom-in" aria-label="放大扩边预览">＋</button><button class="pad-btn" data-pad-action="fit">适合</button><button class="pad-btn" data-pad-action="actual">1:1</button></div><label class="pad-check"><input type="checkbox" data-pad="guides" checked>辅助标记</label></div>
        <div class="pad-notice" data-pad="notice" role="status">正在识别素材中的可见像素…</div>
        <div class="pad-stage" data-pad="stage">
          <div class="pad-pane" data-pad="before-pane"><div class="pad-pane-label"><span>原始素材</span><b data-pad="before-label">—</b></div><canvas data-pad="before" aria-label="扩边前的素材预览"></canvas></div>
          <div class="pad-pane" data-pad="after-pane"><div class="pad-pane-label"><span data-pad="result-label">扩边结果</span><b data-pad="after-label">—</b></div><canvas data-pad="after" aria-label="透明扩边与缩放结果预览"></canvas></div>
          <div class="pad-stage-error" data-pad="error" hidden role="alert"></div>
        </div>
        <div class="pad-legend"><span><i class="pad-key pad-key-bounds"></i>可见像素边界</span><span><i class="pad-key pad-key-source"></i><span data-pad="source-legend">原画布范围</span></span><span><i class="pad-key pad-key-center"></i>目标中心</span><small>滚轮缩放 · 拖动平移 · 标记仅供预览</small></div>
        <div class="pad-summary"><div><span>读取尺寸</span><strong data-pad="source-size">—</strong></div><div><span>目标画布</span><strong data-pad="target-size" class="pad-accent">—</strong></div><div><span data-pad="detail-label">可见像素范围</span><strong data-pad="bounds-size">—</strong></div><div><span>新增透明像素</span><strong data-pad="added">—</strong></div></div>
        <div class="pad-edges"><span><span data-pad="edges-label">四边新增</span> <small>px</small></span><span>左 <b data-pad="left">—</b></span><span>右 <b data-pad="right">—</b></span><span>上 <b data-pad="top">—</b></span><span>下 <b data-pad="bottom">—</b></span></div>
        <details class="pad-batch-details" data-pad="batch-details"><summary>工作区批量预览 <span data-pad="batch-count"></span></summary><div class="pad-table-wrap"><table><thead><tr><th>素材</th><th>原始尺寸</th><th>输出尺寸</th><th>状态</th></tr></thead><tbody data-pad="batch-rows"><tr><td colspan="4">点击右侧「预览工作区」查看逐张结果。</td></tr></tbody></table></div></details>
      </section>
      <aside class="pad-settings" aria-label="透明扩边参数">
        <section class="pad-section"><h3><span>01</span>扩边与缩放</h3><div class="pad-mode-switch" aria-label="扩边与缩放方式"><button data-pad-mode="ratio" aria-pressed="true">宽高比</button><button data-pad-mode="scale" aria-pressed="false">画布倍率</button><button data-pad-mode="size" aria-pressed="false">像素尺寸</button><button data-pad-mode="resize" aria-pressed="false">图像缩放</button></div>
          <div data-pad="ratio-fields"><div class="pad-ratios">${RATIOS.map(([w,h]) => `<button data-pad-ratio="${w}:${h}" aria-pressed="${w===1&&h===1}" title="目标画布宽高比 ${w}:${h}"><i style="--ratio:${w}/${h}"></i>${w}:${h}</button>`).join('')}</div><div class="pad-two"><label class="pad-field">宽度比例<input type="number" min="1" max="10000" step="1" data-pad-option="ratioWidth" aria-label="自定义宽度比例" value="1"></label><label class="pad-field">高度比例<input type="number" min="1" max="10000" step="1" data-pad-option="ratioHeight" aria-label="自定义高度比例" value="1"></label></div><p class="pad-hint">计算符合比例的最小画布。3:1、4:1 适合横向武器素材。</p></div>
          <div data-pad="scale-fields" hidden><div class="pad-quick">${[1.25,1.5,2,3,4].map(n => `<button data-pad-scale="${n}">${n}×</button>`).join('')}</div><label class="pad-field">画布宽高至少扩大至<input type="number" min="1" max="32" step="0.05" data-pad-option="scale" value="1.5"><span class="pad-inline">倍 · 素材本身保持原像素尺寸</span></label><p class="pad-hint">需要更多空间才能自动居中时，会继续补足透明边。参数切换始终基于本次读取的原图。</p></div>
          <div data-pad="size-fields" hidden><div class="pad-two"><label class="pad-field">目标宽度 · px<input type="number" min="1" max="8192" step="1" data-pad-option="targetWidth" value="400"></label><label class="pad-field">目标高度 · px<input type="number" min="1" max="8192" step="1" data-pad-option="targetHeight" value="200"></label></div><div class="pad-quick" role="group" aria-label="常用分辨率"><button type="button" data-pad-size="1280:720" aria-pressed="false" title="720p：1280 × 720 像素">720p · 1280×720</button><button type="button" data-pad-size="1920:1080" aria-pressed="false" title="1080p：1920 × 1080 像素">1080p · 1920×1080</button><button type="button" data-pad-size="2560:1440" aria-pressed="false" title="2K：2560 × 1440 像素">2K · 2560×1440</button></div><div class="pad-quick">${[[48,48],[64,64],[128,128],[256,256],[400,200],[200,400],[512,512]].map(([w,h]) => `<button data-pad-size="${w}:${h}">${w}×${h}</button>`).join('')}</div><p class="pad-hint">尺寸不足时会提示所需空间，不裁去原图或缩小素材。</p></div>
          <div data-pad="resize-fields" hidden>
            <label class="pad-field">尺寸方式<select data-pad-option="resizeSizeMode" aria-label="缩放尺寸方式">${Object.entries(SIZE_MODES).map(([value,label])=>`<option value="${value}">${label}</option>`).join('')}</select></label>
            <div class="pad-two pad-resize-dimensions" data-pad="resize-dimensions"><label class="pad-field" data-pad="resize-width-field">缩放宽度 · px<input type="number" min="1" max="8192" step="1" data-pad-option="resizeWidth" aria-label="自定义缩放宽度" value="48"></label><label class="pad-field" data-pad="resize-height-field">缩放高度 · px<input type="number" min="1" max="8192" step="1" data-pad-option="resizeHeight" aria-label="自定义缩放高度" value="48"></label></div>
            <div data-pad="resize-percent-fields" hidden><label class="pad-field">缩放比例 · %<input type="number" min="0.1" max="3200" step="0.1" data-pad-option="resizePercent" aria-label="自定义缩放百分比" value="100"><span class="pad-inline">100% 为原尺寸 · 200% 为 2 倍</span></label><div class="pad-quick" role="group" aria-label="常用缩放百分比">${[25,50,100,200,400,800].map(n=>`<button data-pad-percent="${n}" aria-pressed="false">${n}%</button>`).join('')}</div></div>
            <label class="pad-field pad-resize-long-edge" data-pad="resize-long-edge-field" hidden>最长边 · px<input type="number" min="1" max="8192" step="1" data-pad-option="resizeLongEdge" aria-label="自定义缩放长边" value="256"></label>
            <div class="pad-quick" data-pad="resize-presets" role="group" aria-label="常用缩放尺寸">${[16,32,48,64,128,256].map(n => `<button data-pad-resize="${n}:${n}" aria-pressed="false">${n}×${n}</button>`).join('')}</div>
            <label class="pad-field" data-pad="resize-fit-field">缩放方式<select data-pad-option="resizeFit" aria-label="缩放方式">${Object.entries(FITS).map(([value,info])=>`<option value="${value}">${info.label}</option>`).join('')}</select></label><p class="pad-hint" data-pad="resize-hint"></p>
            <label class="pad-field pad-algorithm-field">缩放算法<select data-pad-option="resizeAlgorithm" aria-label="缩放算法">${Object.entries(ALGORITHMS).map(([value,info])=>`<option value="${value}">${info.label}</option>`).join('')}</select></label><p class="pad-hint pad-algorithm-hint" data-pad="algorithm-hint" aria-live="polite"></p>
            <details class="pad-reference"><summary>如何选择算法与缩放方式</summary><dl>${Object.entries(ALGORITHMS).map(([,info])=>`<dt>${info.name}</dt><dd>${info.hint}</dd>`).join('')}</dl><p>像素画建议先试最近邻整数倍；缩略图可比较面积平均与 Lanczos 3。缩放不会补回原图中不存在的细节。</p><p>需要统一图标画布选「居中补透明」；需要铺满目标选「居中裁切」；仅限制最大宽高选「等比适应」。切换参数会从本次读取的原图重新预览。</p><p>平滑算法按透明度加权，避免透明像素中的隐藏颜色污染边缘。所有图层分别缩放后合成预览。</p><div class="pad-reference-links"><a href="https://pillow.readthedocs.io/en/stable/handbook/concepts.html#filters" target="_blank" rel="noopener noreferrer">Pillow 滤波参考 ↗</a><a href="https://usage.imagemagick.org/filter/" target="_blank" rel="noopener noreferrer">ImageMagick 采样参考 ↗</a></div></details>
          </div>
        </section>
        <section class="pad-section" data-pad="position-section"><h3><span>02</span>自动定位</h3><div data-pad="padding-position"><label class="pad-field">居中依据<select data-pad-option="center"><option value="content">可见像素包围盒 · 自动识别</option><option value="canvas">原画布中心 · 自动计算</option></select></label><label class="pad-field pad-margin-field">主体每边最少留白 · px<input type="number" min="0" max="4096" step="1" data-pad-option="margin" value="0"></label><p class="pad-hint">包含半透明边缘。按整数像素放置，奇偶尺寸的中心误差最多半个像素。完整保留原画布，包括已有透明边。</p></div><div data-pad="resize-position" hidden><p class="pad-hint" data-pad="resize-position-hint">以完整原画布为缩放范围，包含已有透明边。所有图层使用相同缩放与偏移。</p></div><div class="pad-detection"><span class="pad-detection-icon">⌖</span><div><strong data-pad="detection">自动识别中</strong><small data-pad="center-readout">无需点击或选择中心点</small></div></div></section>
        <section class="pad-section"><h3><span>03</span>应用与导出</h3><div class="pad-actions"><button class="pad-btn pad-primary" data-pad-action="apply" disabled>应用到当前素材</button><div class="pad-two"><button class="pad-btn" data-pad-action="duplicate" disabled>创建扩边副本</button><button class="pad-btn" data-pad-action="export" disabled>导出透明 PNG</button></div></div><p class="pad-hint" data-pad="apply-note">全部图层一起扩边，可撤销。共享参考按工作区坐标保留。</p></section>
        <section class="pad-section"><h3><span>04</span>工作区批量应用<b data-pad="doc-count">0 张</b></h3><label class="pad-check"><input type="checkbox" data-pad="uniform">全部统一为相同像素尺寸</label><p class="pad-hint" data-pad="batch-hint">每张素材独立识别中心，应用相同比例，输出尺寸可不同。</p><div class="pad-two"><button class="pad-btn" data-pad-action="preview-batch">预览工作区</button><button class="pad-btn pad-outline" data-pad-action="batch">批量应用扩边</button></div><button class="pad-btn pad-wide" data-pad-action="export-workspace">导出工作区 PNG ZIP</button><button class="pad-btn pad-wide" data-pad-action="cancel" hidden>停止批处理</button><progress data-pad="progress" value="0" max="1" hidden></progress><p class="pad-report" data-pad="report" aria-live="polite"></p><p class="pad-hint">批量应用修改工作区内的素材；每张各自支持撤销。ZIP 导出已应用的工作区结果。</p></section>
      </aside>
    </div>`;
  const $ = name => mount.querySelector(`[data-pad="${name}"]`);
  const actionButton = name => mount.querySelector(`[data-pad-action="${name}"]`);
  const state = {
    active: false, options: { ...DEFAULTS }, uniform: false, view: 'compare', guides: true,
    source: null, plan: null, expectedRevision: null, expectedWidth: 0, expectedHeight: 0,
    currentKey: '', overridePlan: null, preview: null, previewPending: false, previewAbort: null, previewGeneration: 0, operationAbort: null, zoom: 1, beforeZoomRatio: 1, panX: 0, panY: 0, frame: null, drag: null,
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
  function previewReady() {
    return !!state.plan && (state.plan.operation !== 'resize' || (state.preview?.source === state.source?.canvas && state.preview.key === planKey(state.plan)));
  }
  function cancelPreview(clear = false) {
    state.previewAbort?.abort(); state.previewAbort = null;
    state.previewPending = false; state.previewGeneration++;
    if (clear) state.preview = null;
  }
  function updateActions() {
    const ready = !!state.source && !!state.plan && matchesCurrent() && !state.busy && !state.previewPending && previewReady();
    mount.setAttribute('aria-busy', String(state.busy || state.previewPending));
    const same = ready && planKey(state.plan) === state.currentKey;
    actionButton('apply').disabled = !ready || same;
    actionButton('apply').textContent = same ? '当前素材已符合预览' : '应用到当前素材';
    actionButton('duplicate').disabled = !ready || api.getDocs().length >= 100;
    actionButton('export').disabled = !ready;
    actionButton('reload').disabled = state.busy;
    actionButton('batch').disabled = state.busy || !api.getDocs().length || state.lastBatchStamp === workspaceStamp();
    actionButton('batch').textContent = state.lastBatchStamp === workspaceStamp() ? '本批次已应用' : state.options.mode === 'resize' ? '批量应用缩放' : '批量应用扩边';
    actionButton('duplicate').textContent = state.options.mode === 'resize' ? '创建缩放副本' : '创建扩边副本';
    actionButton('preview-batch').disabled = state.busy || !api.getDocs().length;
    actionButton('export-workspace').disabled = state.busy || !api.getDocs().length;
    $('doc-count').textContent = `${api.getDocs().length} 张`;
  }
  function syncFields(preserveInputs = false) {
    if (!preserveInputs) mount.querySelectorAll('[data-pad-option]').forEach(input => { input.value = state.options[input.dataset.padOption]; });
    mount.querySelectorAll('[data-pad-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.padMode === state.options.mode)));
    for (const mode of ['ratio', 'scale', 'size', 'resize']) $(mode + '-fields').hidden = state.options.mode !== mode;
    mount.querySelectorAll('[data-pad-ratio]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.padRatio === `${state.options.ratioWidth}:${state.options.ratioHeight}`)));
    mount.querySelectorAll('[data-pad-scale]').forEach(button => button.setAttribute('aria-pressed', String(Number(button.dataset.padScale) === state.options.scale)));
    mount.querySelectorAll('[data-pad-size]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.padSize === `${state.options.targetWidth}:${state.options.targetHeight}`)));
    mount.querySelectorAll('[data-pad-resize]').forEach(button => button.setAttribute('aria-pressed', String(state.options.resizeSizeMode === 'dimensions' && button.dataset.padResize === `${state.options.resizeWidth}:${state.options.resizeHeight}`)));
    mount.querySelectorAll('[data-pad-percent]').forEach(button => button.setAttribute('aria-pressed', String(Number(button.dataset.padPercent) === state.options.resizePercent)));
    mount.querySelectorAll('[data-pad-view]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.padView === state.view)));
    $('before-pane').hidden = state.view !== 'compare';
    $('stage').classList.toggle('pad-result-only', state.view === 'result');
    const resizing = state.options.mode === 'resize';
    const sizeMode = state.options.resizeSizeMode;
    const fixedOutput = sizeMode === 'dimensions' && state.options.resizeFit !== 'inside';
    $('uniform').checked = resizing ? fixedOutput : state.uniform; $('uniform').disabled = resizing || state.busy;
    $('guides').checked = state.guides;
    $('background').value = api.getState().canvasBackground || 'checker';
    $('resize-dimensions').hidden = !['dimensions','width','height'].includes(sizeMode);
    $('resize-dimensions').classList.toggle('pad-single-field', sizeMode !== 'dimensions');
    $('resize-width-field').hidden = sizeMode === 'height';
    $('resize-height-field').hidden = sizeMode === 'width';
    $('resize-percent-fields').hidden = sizeMode !== 'percent';
    $('resize-long-edge-field').hidden = sizeMode !== 'long-edge';
    $('resize-presets').hidden = $('resize-fit-field').hidden = sizeMode !== 'dimensions';
    $('padding-position').hidden = resizing; $('resize-position').hidden = !resizing;
    $('heading').textContent = resizing ? '把像素缩放到合适尺寸' : '给像素留一点空间';
    $('badge').textContent = resizing ? ALGORITHMS[state.options.resizeAlgorithm].name : '自动居中';
    $('result-label').textContent = resizing ? '缩放结果' : '扩边结果';
    $('source-legend').textContent = resizing ? '缩放后原画布' : '原画布范围';
    $('detail-label').textContent = resizing ? '缩放后图像' : '可见像素范围';
    $('edges-label').textContent = resizing ? '透明补边' : '四边新增';
    $('resize-hint').textContent = sizeMode === 'dimensions' ? FITS[state.options.resizeFit].hint : sizeMode === 'percent' ? '按每张原图的宽高分别计算比例，可放大或缩小；输出取整到像素，最小为 1 px。' : sizeMode === 'width' ? '只指定宽度，高度按每张原图的比例自动计算，不额外补边。' : sizeMode === 'height' ? '只指定高度，宽度按每张原图的比例自动计算，不额外补边。' : '将每张原图的最长边调整到指定尺寸，另一边等比计算，不额外补边。';
    $('algorithm-hint').textContent = ALGORITHMS[state.options.resizeAlgorithm].hint;
    $('resize-position-hint').textContent = sizeMode === 'dimensions' && state.options.resizeFit === 'cover' ? '按目标比例从原画布中心裁切，再等比缩放；被裁去的边缘不会出现在结果中。所有图层使用相同裁切范围。' : '以完整原画布为缩放范围，包含已有透明边。所有图层使用相同缩放与偏移。';
    $('batch-hint').textContent = resizing ? fixedOutput ? `每张素材输出为指定宽高，使用「${FITS[state.options.resizeFit].label}」与${ALGORITHMS[state.options.resizeAlgorithm].name}；可先预览逐张尺寸。` : `每张素材按「${SIZE_MODES[sizeMode]}${sizeMode === 'dimensions' ? ' · 等比适应' : ''}」独立计算，输出尺寸可不同；使用${ALGORITHMS[state.options.resizeAlgorithm].name}。` : state.options.mode === 'size' ? '全部使用指定像素尺寸；无法完整容纳的素材会标出原因并跳过。' : state.uniform ? '先计算各张所需空间，再把有效素材统一为相同的画布尺寸。' : `每张素材独立识别中心，使用相同${state.options.mode === 'ratio' ? '宽高比' : '倍率'}。`;
  }
  function renderPreviewError(error) {
    $('error').textContent = error.message; $('error').hidden = false;
    $('notice').textContent = '请调整参数，预览有效后才能应用。'; $('notice').classList.add('pad-warning');
  }
  function preparePreview(s, p) {
    const key = planKey(p), controller = new AbortController(), generation = state.previewGeneration;
    state.previewAbort = controller; state.previewPending = true;
    $('notice').textContent = `正在使用${ALGORITHMS[p.algorithm || 'nearest'].name}处理 ${s.layers.length} 个图层…`;
    paddedLayersAsync(s, p, { signal:controller.signal }).then(layers => {
      if (controller.signal.aborted || generation !== state.previewGeneration || state.source !== s || !state.active) return;
      if (!matchesCurrent()) { cancelPreview(true); capture(true); updateActions(); return; }
      const canvas = composite({ width:p.width, height:p.height, layers });
      const bounds = findAlphaBounds(canvas.getContext('2d').getImageData(0,0,p.width,p.height));
      state.preview = { source:s.canvas, key, canvas, bounds, layers };
      state.previewPending = false; state.previewAbort = null;
      calculate();
    }).catch(error => {
      if (controller.signal.aborted || generation !== state.previewGeneration) return;
      state.previewPending = false; state.previewAbort = null; state.plan = null;
      renderPreviewError(error); updateActions(); render();
    });
  }
  function calculate(shouldFit = false) {
    if (!state.source) return;
    cancelPreview();
    const s = state.source;
    $('filename').textContent = s.name;
    $('source-size').textContent = `${s.width} × ${s.height}`;
    $('before-label').textContent = `${s.width} × ${s.height} px`;
    $('bounds-size').textContent = state.options.mode === 'resize' ? '—' : s.bounds ? `${s.bounds.width} × ${s.bounds.height}` : '全透明';
    $('detection').textContent = s.bounds ? '已识别可见像素边界' : '未发现可见像素';
    $('error').hidden = true;
    state.plan = null;
    try {
      const p = state.overridePlan || planPadding(s, state.options);
      if (p.operation === 'resize') checkBudget(api.getDoc(), s, p);
      else state.preview = null;
      state.plan = p;
      $('target-size').textContent = `${p.width} × ${p.height}`;
      $('after-label').textContent = `${p.width} × ${p.height} px`;
      $('added').textContent = (p.width * p.height - (p.contentWidth ?? s.width) * (p.contentHeight ?? s.height)).toLocaleString();
      for (const side of ['left','right','top','bottom']) $(side).textContent = p[side];
      if (p.operation === 'resize') {
        $('bounds-size').textContent = `${p.contentWidth} × ${p.contentHeight}`;
        $('detection').textContent = p.resizeFit === 'contain' ? '等比缩放后自动居中' : p.resizeFit === 'cover' ? '从原画布中心裁切' : p.resizeFit === 'inside' ? '等比缩放，不补边' : '图像填满目标画布';
        $('center-readout').textContent = `图像 ${p.contentWidth} × ${p.contentHeight} px · 偏移 X ${p.offsetX} / Y ${p.offsetY}`;
        $('notice').textContent = `${ALGORITHMS[p.algorithm || 'nearest'].name} · ${p.resizeFit === 'cover' ? '等比填满并裁去超出部分' : p.resizeFit === 'contain' ? '等比完整显示，空余区域保持透明' : p.resizeFit === 'inside' ? '按原画布比例计算实际输出尺寸' : '直接缩放至指定宽高'} · 全部图层保留透明度`;
      } else {
        $('center-readout').textContent = `原图中心位置 X ${p.centerX} · Y ${p.centerY}`;
        $('notice').textContent = !s.bounds ? '全透明素材：自动采用画布中心；设置留白时以整个原画布计算。' : state.options.center === 'canvas' ? '自动采用原画布中心 · 全部图层保持相对位置' : '自动检测非透明像素并居中 · 无需手动选择中心点';
      }
      $('notice').classList.remove('pad-warning');
      $('apply-note').textContent = state.currentKey !== identityKey(s.width, s.height) ? '已应用。修改参数仍基于本次读取的原图，避免重复处理损失细节；重新读取后可继续。每张素材可撤销。' : p.operation === 'resize' ? '全部图层一起缩放，保留图层属性，可一次撤销。共享参考按工作区坐标保留。' : '全部图层一起扩边，可撤销。共享参考按工作区坐标保留。';
      if (p.operation === 'resize' && !previewReady() && state.active && !state.busy) preparePreview(s, p);
    } catch (error) {
      state.plan = null; renderPreviewError(error);
      $('target-size').textContent = $('after-label').textContent = '尺寸不可用';
      $('added').textContent = '—';
      for (const side of ['left','right','top','bottom']) $(side).textContent = '—';
    }
    updateActions();
    if (shouldFit) fit(); else render();
  }
  function capture(force = false) {
    if (state.busy || state.capturing || !api.getDoc()) return;
    if (!force && matchesCurrent()) { if (state.plan?.operation === 'resize' && !previewReady() && !state.previewPending) calculate(); else updateActions(); return; }
    state.capturing = true;
    cancelPreview(true);
    try {
      const d = api.getDoc();
      state.source = snapshot(d);
      state.overridePlan = null;
      rememberCurrent(d, identityKey(d.width, d.height));
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
    syncFields(fromInput);
    calculate(true); api.persist();
  }

  function fit() {
    if (!state.source || !state.active) return;
    const rect = $('after-pane').getBoundingClientRect();
    const p = state.plan || state.source;
    state.panX = state.panY = 0;
    const fitZoom = (r, image) => clamp(Math.min((Math.max(80, r.width) - 64) / image.width, (Math.max(120, r.height) - 78) / image.height), .01, 16);
    const z = fitZoom(rect, p);
    state.beforeZoomRatio = state.options.mode === 'resize' && state.view === 'compare' ? fitZoom($('before-pane').getBoundingClientRect(), state.source) / z : 1;
    setZoom(z);
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
    const z = state.zoom * (after ? 1 : state.beforeZoomRatio), x = Math.round(rect.width / 2 - p.width * z / 2 + state.panX), y = Math.round(rect.height / 2 - p.height * z / 2 + state.panY);
    const dx = after ? p.offsetX : 0, dy = after ? p.offsetY : 0;
    const resized = after && p.operation === 'resize';
    const contentWidth = resized ? p.contentWidth : s.width, contentHeight = resized ? p.contentHeight : s.height;
    ctx.save(); ctx.beginPath(); ctx.rect(x, y, p.width*z, p.height*z); ctx.clip();
    drawTransparencyBackground(ctx, { x, y, width:p.width*z, height:p.height*z }, api.getState().canvasBackground || 'checker');
    ctx.imageSmoothingEnabled = false;
    const pending = resized && !previewReady();
    if (pending) {
      ctx.fillStyle = '#121922d9'; ctx.fillRect(x,y,p.width*z,p.height*z);
      ctx.fillStyle = '#d1dce8'; ctx.textAlign = 'center'; ctx.font = '12px sans-serif';
      ctx.fillText(state.previewPending ? '正在生成缩放预览…' : '准备缩放预览…', x+p.width*z/2, y+p.height*z/2);
    }
    else if (resized) ctx.drawImage(state.preview.canvas, x, y, p.width*z, p.height*z);
    else ctx.drawImage(s.canvas, x+dx*z, y+dy*z, s.width*z, s.height*z);
    if (state.guides && !pending) {
      ctx.lineWidth = 1;
      if (after) {
        ctx.strokeStyle = '#8eabc7cc'; ctx.setLineDash([5,4]);
        ctx.strokeRect(x+dx*z+.5, y+dy*z+.5, contentWidth*z-1, contentHeight*z-1);
      }
      const b = resized ? state.preview.bounds : s.bounds && { ...s.bounds, x: s.bounds.x+dx, y: s.bounds.y+dy };
      if (b) {
        ctx.strokeStyle = '#f5b180'; ctx.setLineDash([]);
        ctx.strokeRect(x+b.x*z, y+b.y*z, b.width*z, b.height*z);
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
    if (!state.plan || !state.source) throw new Error('请先设置有效的扩边或缩放尺寸。');
    if (!matchesCurrent()) { capture(true); throw new Error('素材已有编辑，已重新读取，请核对更新后的预览。'); }
    if (state.previewPending || !previewReady()) throw new Error('缩放预览正在生成，请完成后再应用或导出。');
  }
  function checkBudget(doc, source, plan, duplicate = false) {
    const total = api.getDocs().reduce((sum, d) => sum + d.width*d.height*d.layers.length, 0);
    const next = total + plan.width*plan.height*source.layers.length - (duplicate ? 0 : doc.width*doc.height*doc.layers.length);
    if (next > MAX_LAYER_PIXELS) throw new Error('处理后的工作区图层像素总量过大，请减小目标尺寸或拆分工作区。');
  }
  function applyCurrent() {
    assertReady();
    const d = api.getDoc(), p = state.plan;
    if (planKey(p) === state.currentKey) return;
    checkBudget(d, state.source, p);
    applyPaddingSnapshot(d, state.source, p, p.operation === 'resize' ? state.preview.layers : undefined);
    rememberCurrent(d, planKey(p));
    api.getState().selection = null; api.getState().lastAction = 'image';
    state.lastBatchStamp = ''; state.batchRows = null;
    calculate(); api.refresh(); api.persist();
    api.toast(`已${p.operation === 'resize' ? '缩放' : '扩边'}至 ${p.width} × ${p.height} px，全部 ${d.layers.length} 个图层已保留，可撤销。`);
  }
  function duplicate() {
    assertReady();
    if (api.getDocs().length >= 100) throw new Error('工作区最多 100 张素材，请先关闭部分图片。');
    checkBudget(api.getDoc(), state.source, state.plan, true);
    const resizing = state.plan.operation === 'resize';
    const d = duplicateWithPadding(state.source, state.plan, `${filename(state.source.name)}-${resizing ? 'resized' : 'padding'}.png`, resizing ? state.preview.layers : undefined);
    api.addDocument(d, { switchTo: true });
    capture(true); api.toast(`已创建保留全部图层的${resizing ? '缩放' : '扩边'}副本。`);
  }
  async function exportPNG() {
    assertReady();
    const p = state.plan, s = state.source;
    const canvas = state.preview?.source === s.canvas && state.preview.key === planKey(p) ? state.preview.canvas : paddedCanvas(s.canvas, p);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('PNG 编码失败，请降低目标尺寸后重试。');
    downloadBlob(blob, `${filename(s.name)}-${p.operation === 'resize' ? 'resized' : 'padding'}-${p.width}x${p.height}.png`);
    api.toast(`已生成 ${p.width} × ${p.height} 透明 PNG，辅助标记不会写入图片。`);
  }

  function busy(value, cancellable = true) {
    if (value) cancelPreview();
    state.busy = value;
    mount.querySelectorAll('[data-pad-option],[data-pad-mode],[data-pad-ratio],[data-pad-scale],[data-pad-size],[data-pad-resize],[data-pad-percent],[data-pad="uniform"]').forEach(control => { control.disabled = value; });
    $('uniform').disabled = value || state.options.mode === 'resize';
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
          row.currentKey = identityKey(d.width, d.height);
        }
        row.plan = planPadding(row, options);
      } catch (error) { row.error = error.message; }
      rows.push(row);
      $('report').textContent = `正在分析 ${i+1} / ${docs.length} · ${d.name}`;
      $('progress').value = i+1;
      await yieldUI();
    }
    if (state.uniform && options.mode !== 'resize' && rows.length && !state.cancel) {
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
      $('report').textContent = state.cancel ? '已停止分析；尚未修改素材。' : `预览完成：${rows.filter(row=>!row.error).length} 张可应用，${rows.filter(row=>row.error).length} 张尺寸不适用。`;
    } finally { if(state.cancel) state.batchStamp=''; busy(false); calculate(); }
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
      if (projected > MAX_LAYER_PIXELS) throw new Error('批量处理会超过工作区像素容量，请减小目标尺寸或分批处理。尚未应用本批次。');
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
              state.operationAbort = new AbortController();
              const layers = row.plan.operation === 'resize' ? await paddedLayersAsync(source, row.plan, { signal:state.operationAbort.signal }) : undefined;
              if (state.cancel || state.operationAbort.signal.aborted) break;
              if (!api.getDocs().includes(d) || d.revision !== row.revision || d.width !== row.currentWidth || d.height !== row.currentHeight) throw new Error('素材在处理过程中发生变化，请重新预览');
              checkBudget(d, source, row.plan);
              applyPaddingSnapshot(d, source, row.plan, layers);
              // Keep the original read snapshot so a stopped batch can resume
              // without applying a scale multiplier again to completed items.
              row.source = source;
              row.revision = d.revision; row.currentWidth = d.width; row.currentHeight = d.height;
              row.currentKey = planKey(row.plan);
              row.applied = true; row.status = '已应用'; completed++;
            }
          } catch (error) { if (state.cancel && error.name === 'AbortError') break; row.error = error.message; }
          finally { state.operationAbort = null; }
        }
        $('report').textContent = `正在应用 ${i+1} / ${rows.length} · 已完成 ${completed} 张`;
        $('progress').value = i+1;
        await yieldUI();
      }
      if (!state.cancel) state.lastBatchStamp = workspaceStamp();
    } finally {
      state.operationAbort = null;
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
      if (completed) api.toast(`已为 ${completed} 张素材应用${state.options.mode === 'resize' ? '图像缩放' : '透明扩边'}；全部图层保留，每张可撤销。`);
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
    if (event.target === $('background')) {
      if (api.setCanvasBackground) api.setCanvasBackground(event.target.value);
      else { api.getState().canvasBackground=event.target.value; api.persist(); }
      render();
    }
  });
  const actions = {
    reload:()=>{state.lastBatchStamp='';state.batchRows=null;state.batchStamp='';capture(true);},
    apply:applyCurrent, duplicate, export:exportPNG, 'preview-batch':previewBatch, batch:applyBatch,
    cancel:()=>{state.cancel=true;state.operationAbort?.abort();}, fit, actual:()=>{state.beforeZoomRatio=1;setZoom(1);}, 'zoom-in':()=>setZoom(state.zoom*1.25), 'zoom-out':()=>setZoom(state.zoom/1.25),
    'export-workspace':async()=>{busy(true,false);try{await exportAllZip(api.getDocs(),'png');api.toast('工作区 PNG 已打包，下载内容为当前已应用的素材。');}finally{busy(false);calculate();}},
  };
  mount.addEventListener('click', async event => {
    const button=event.target.closest('button');
    if (!button || button.disabled) return;
    try {
      if (button.dataset.padMode) changeOptions({mode:button.dataset.padMode});
      if (button.dataset.padRatio) {const [ratioWidth,ratioHeight]=button.dataset.padRatio.split(':').map(Number);changeOptions({ratioWidth,ratioHeight});}
      if (button.dataset.padScale) changeOptions({scale:Number(button.dataset.padScale)});
      if (button.dataset.padSize) {const [targetWidth,targetHeight]=button.dataset.padSize.split(':').map(Number);changeOptions({targetWidth,targetHeight});}
      if (button.dataset.padResize) {const [resizeWidth,resizeHeight]=button.dataset.padResize.split(':').map(Number);changeOptions({resizeSizeMode:'dimensions',resizeWidth,resizeHeight});}
      if (button.dataset.padPercent) changeOptions({resizeSizeMode:'percent',resizePercent:Number(button.dataset.padPercent)});
      if (button.dataset.padView) {state.view=button.dataset.padView;syncFields();fit();api.persist();}
      if (button.dataset.padAction && (!state.busy || ['cancel','fit','actual','zoom-in','zoom-out'].includes(button.dataset.padAction))) await actions[button.dataset.padAction]?.();
    } catch(error) {api.toast(error.message || '扩边或缩放未能完成，请重试。',true);}
  });
  new ResizeObserver(()=>{if(state.active)fit();}).observe($('after-pane'));
  syncFields();
  return {
    activate() { state.active=true;capture();fit(); },
    deactivate() { state.active=false;state.drag=null;cancelPreview();updateActions();if(state.frame!==null){cancelAnimationFrame(state.frame);state.frame=null;} },
    refresh() { if(state.active && !state.busy) capture(); },
    refreshBackground() { $('background').value=api.getState().canvasBackground || 'checker'; render(); },
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
      if(!['ratio','scale','size','resize'].includes(options.mode))options.mode='ratio';
      if(!['content','canvas'].includes(options.center))options.center='content';
      if(!Object.hasOwn(FITS,options.resizeFit))options.resizeFit='stretch';
      if(!Object.hasOwn(SIZE_MODES,options.resizeSizeMode))options.resizeSizeMode='dimensions';
      if(!Object.hasOwn(ALGORITHMS,options.resizeAlgorithm))options.resizeAlgorithm='nearest';
      cancelPreview(true);
      state.options=options;state.uniform=Boolean(saved?.uniform);state.view=saved?.view==='result'?'result':'compare';state.guides=saved?.guides!==false;
      state.source=null;state.plan=null;state.overridePlan=null;state.preview=null;state.batchRows=null;state.batchStamp='';state.lastBatchStamp='';syncFields();
    },
  };
}
