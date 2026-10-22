import { PaintDocument, makeCanvas, cloneCanvas } from './core.js';
import { downloadBlob } from './io.js';

const MAX_INPUT_PIXELS = 16_777_216;
const MAX_EXPORT_PIXELS = 33_554_432;
const ORIGINAL = { gridSize: 1, offsetX: 0, offsetY: 0, sampling: 'nearest', paletteSize: 0, alphaMode: 'preserve', alphaThreshold: 128, denoise: false };
const USER_PRESET = { gridSize: 1, offsetX: 0, offsetY: 0, sampling: 'dominant', paletteSize: 32, alphaMode: 'binary', alphaThreshold: 45, denoise: true };
const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));
const integer = (value, fallback, lo, hi) => clamp(Number.isFinite(Number(value)) ? Math.round(Number(value)) : fallback, lo, hi);
const baseName = name => String(name || '素材').replace(/\.[^.]+$/, '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').slice(0, 110);

function normalizeOptions(input = {}) {
  const gridSize = integer(input.gridSize, 1, 1, 64);
  return {
    gridSize,
    offsetX: integer(input.offsetX, 0, 0, gridSize - 1),
    offsetY: integer(input.offsetY, 0, 0, gridSize - 1),
    sampling: ['nearest', 'dominant', 'average'].includes(input.sampling) ? input.sampling : 'nearest',
    paletteSize: integer(input.paletteSize, 0, 0, 256),
    alphaMode: input.alphaMode === 'binary' ? 'binary' : 'preserve',
    alphaThreshold: integer(input.alphaThreshold, 128, 0, 255),
    denoise: Boolean(input.denoise),
  };
}

// One immutable source per worker. Termination rejects all unfinished requests.
function processor(image) {
  const worker = new Worker(new URL('./pixel-worker.js', import.meta.url), { type: 'module' });
  const pending = new Map();
  let sequence = 0;
  let stopped = false;
  const version = Date.now() + Math.random();
  function failAll(error) {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  }
  worker.onmessage = ({ data }) => {
    if (data.version !== version) return;
    const request = pending.get(data.id);
    if (!request) return;
    pending.delete(data.id);
    if (data.type === 'error') request.reject(new Error(data.message));
    else request.resolve(data);
  };
  worker.onerror = () => {
    stopped = true;
    failAll(new Error('像素处理模块未能运行，请重新读取图像或刷新页面。'));
    worker.terminate();
  };
  const pixels = new Uint8ClampedArray(image.data);
  worker.postMessage({ type: 'load', version, image: { width: image.width, height: image.height, data: pixels } }, [pixels.buffer]);
  return {
    run(type, options) {
      if (stopped) return Promise.reject(new Error('像素处理已取消。'));
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ type, version, id, options });
      });
    },
    stop() {
      stopped = true;
      worker.terminate();
      const error = new Error('像素处理已取消。');
      error.cancelled = true;
      failAll(error);
    },
  };
}

function resultToCanvas(result) {
  const canvas = makeCanvas(result.width, result.height);
  canvas.getContext('2d').putImageData(new ImageData(result.data, result.width, result.height), 0, 0);
  return canvas;
}

export function createOptimizer(api, mount) {
  mount.innerHTML = `
    <div class="opt-root">
      <section class="opt-preview" aria-label="像素优化预览">
        <div class="opt-preview-header"><div class="opt-file-info"><div class="opt-file-name" data-opt="filename">像素优化实验室</div><div class="opt-source-note" data-opt="source-note">共享工作区素材 · 独立原图快照</div></div><button class="opt-btn" data-opt-action="reload">↻ 重新读取</button></div>
        <p class="opt-stale" data-opt="stale" hidden>原图已有编辑。当前对比保留读取时的快照；重新读取后才能应用到原图。</p>
        <div class="opt-preview-toolbar"><div class="opt-segment" aria-label="对比方式"><button class="opt-btn" data-opt-view="split" aria-pressed="true">滑杆对比</button><button class="opt-btn" data-opt-view="side" aria-pressed="false">并排</button><button class="opt-btn" data-opt-view="result" aria-pressed="false">结果</button></div><div class="opt-group"><button class="opt-btn" data-opt-action="zoom-out" title="缩小">−</button><span class="opt-key" data-opt="zoom">100%</span><button class="opt-btn" data-opt-action="zoom-in" title="放大">+</button><button class="opt-btn" data-opt-action="fit">适合</button><button class="opt-btn" data-opt-action="actual">1:1</button></div><div class="opt-group"><button class="opt-btn" data-opt-action="grid" aria-pressed="false" title="叠加采样网格，导出不包含网格">网格</button><button class="opt-btn" data-opt-action="background" title="切换透明棋盘格、浅色、深色预览背景">底色</button></div></div>
        <div class="opt-canvas-area" data-opt="area"><div class="opt-pane" data-opt="main-pane"><canvas data-opt="main-canvas" aria-label="原图与优化结果预览"></canvas><span class="opt-label" data-opt="left-label">原图</span><span class="opt-label opt-label-right" data-opt="right-label">优化结果</span><div class="opt-split" data-opt="split" tabindex="0" role="slider" aria-label="原图与优化结果分界" aria-valuemin="0" aria-valuemax="100" aria-valuenow="50"></div></div><div class="opt-pane" data-opt="second-pane" hidden><canvas data-opt="second-canvas" aria-label="优化结果预览"></canvas><span class="opt-label">优化结果</span></div><div class="opt-stage-message" data-opt="stage-message" hidden></div></div>
        <div class="opt-preview-stats"><div>原图尺寸<strong class="opt-stat-value" data-opt="original-size">—</strong></div><div>基础像素<strong class="opt-stat-value" data-opt="result-size">—</strong></div><div>结果颜色<strong class="opt-stat-value" data-opt="colors">—</strong></div><div class="opt-status" data-opt="status"><span class="opt-live-dot"></span>准备就绪</div></div>
        <div class="opt-preview-footer"><span class="opt-pixel-readout" data-opt="pixel">移动指针查看 RGBA 像素值</span><span>滚轮缩放 · 拖动画布平移</span></div>
      </section>
      <aside class="opt-settings" aria-label="像素优化参数">
        <section class="opt-section opt-controls"><h3 class="opt-section-title">输入与预设<span class="opt-section-number">01</span></h3><label class="opt-field">优化来源<select data-opt="source"><option value="composite">当前素材 · 可见图层合成</option><option value="layer">当前活动图层 · 原始像素</option></select></label><div class="opt-two"><button class="opt-btn" data-opt-action="preset-original">原像素</button><button class="opt-btn" data-opt-action="preset-user">像素清理</button></div><p class="opt-hint">像素清理：1 px / 主色 / 32 色 / 透明阈值 45 / 去孤点。始终对输入快照处理。</p></section>
        <section class="opt-section opt-controls"><h3 class="opt-section-title">重建像素网格<span class="opt-section-number">02</span></h3><div class="opt-row"><label class="opt-field">单格大小 · px<input data-opt="grid-size" type="number" value="1" min="1" max="64"></label><button class="opt-btn" data-opt-action="analyze" style="margin-top:18px">估计网格</button></div><p class="opt-hint" data-opt="analysis">自动估计仅作建议，请放大核对边缘。</p><div class="opt-row" style="margin-top:11px"><label class="opt-field">水平偏移<input data-opt="offset-x" type="number" min="0" max="0" value="0"></label><label class="opt-field">垂直偏移<input data-opt="offset-y" type="number" min="0" max="0" value="0"></label></div><label class="opt-field" style="margin-top:11px">每格取色<select data-opt="sampling"><option value="nearest">中心取样 · 保留颜色</option><option value="dominant">区域主色 · 去细碎杂色</option><option value="average">透明度加权平均</option></select></label><p class="opt-hint" data-opt="grid-hint">1 × 1 原图像素 → 1 个基础像素</p></section>
        <section class="opt-section opt-controls"><h3 class="opt-section-title">色板与边缘<span class="opt-section-number">03</span></h3><label class="opt-field">最多 RGB 颜色<input data-opt="palette-size" type="number" min="0" max="256" step="1" value="0"><span class="opt-inline-note">0 为不限色 · 不影响保留模式的透明度</span></label><label class="opt-check"><input data-opt="binary" type="checkbox">清理半透明边缘</label><div class="opt-alpha" data-opt="alpha-row" hidden><label class="opt-field">透明阈值 <span data-opt="alpha-label">128</span><input data-opt="alpha-threshold" type="range" min="0" max="255" value="128"></label></div><label class="opt-check"><input data-opt="denoise" type="checkbox">清理单个孤立杂点</label><p class="opt-hint">仅替换与周围 8 个相同邻点不同的单点；可关闭以保留孤立细节。</p><div class="opt-palette" data-opt="palette" aria-label="结果色板"></div></section>
        <section class="opt-section"><h3 class="opt-section-title">应用与导出<span class="opt-section-number">04</span></h3><div class="opt-buttons-stack"><button class="opt-btn opt-primary opt-wide" data-opt-action="new-document" disabled>创建基础像素素材</button><button class="opt-btn opt-wide" data-opt-action="apply-layer" disabled>按原坐标铺回新图层</button></div><p class="opt-hint">铺回保留原画布尺寸；原图层会隐藏并保留，可在图层面板恢复或撤销。基础素材采用重建后的像素尺寸。</p><div class="opt-row" style="margin-top:11px"><select class="opt-export-select" data-opt="export-scale" aria-label="PNG 导出整数倍率"><option value="1">1×</option><option value="2">2×</option><option value="4">4×</option><option value="8">8×</option></select><button class="opt-btn opt-wide" data-opt-action="export" disabled>导出透明 PNG</button></div><p class="opt-hint" data-opt="export-size">最近邻整数放大 · 不导出网格和参考</p></section>
        <section class="opt-section"><h3 class="opt-section-title">工作区批处理<span class="opt-section-number">05</span></h3><p class="opt-hint" data-opt="batch-scope">将工作区素材逐张优化为新素材，保留全部原图。</p><button class="opt-btn opt-wide" data-opt-action="batch" style="margin-top:10px">批量创建优化素材</button><button class="opt-btn opt-wide opt-batch-cancel" data-opt-action="cancel-batch" style="margin-top:7px" hidden>停止批处理</button><progress class="opt-batch-progress" data-opt="batch-progress" value="0" max="1" hidden></progress><p class="opt-batch-report" data-opt="batch-report" aria-live="polite"></p><p class="opt-hint">使用当前参数和来源方式；按队列逐张处理。单张最多 1677 万像素，工作区最多 100 张。</p></section>
      </aside>
    </div>`;
  const $ = name => mount.querySelector(`[data-opt="${name}"]`);
  const button = name => mount.querySelector(`[data-opt-action="${name}"]`);
  const root = mount.querySelector('.opt-root');
  const main = $('main-canvas');
  const second = $('second-canvas');
  const state = {
    active: false, options: { ...ORIGINAL }, sourceMode: 'composite', view: 'split', split: 0.5,
    zoom: 1, panX: 0, panY: 0, grid: false, background: 'checker', exportScale: 1,
    source: null, sourcePixels: null, meta: null, result: null, resultCanvas: null,
    worker: null, revision: 0, renderedRevision: -1, inFlight: false, analyzing: false,
    timer: null, frame: null, drag: null, capturing: false, optionRevision: 0, batch: null,
  };
  function saveSettings() { api.persist?.(); }
  function stale() {
    const d = api.getDoc();
    return !d || !state.meta || d.id !== state.meta.id || d.revision !== state.meta.revision ||
      d.width !== state.meta.width || d.height !== state.meta.height ||
      (state.sourceMode === 'layer' && d.activeLayerId !== state.meta.layerId);
  }
  function ready() { return !!state.result && state.renderedRevision === state.revision && !state.batch; }
  function updateActions() {
    const valid = ready();
    button('new-document').disabled = !valid;
    button('apply-layer').disabled = !valid || stale();
    const w = state.result ? state.result.width * state.exportScale : 0;
    const h = state.result ? state.result.height * state.exportScale : 0;
    const withinLimit = w <= 16384 && h <= 16384 && w * h <= MAX_EXPORT_PIXELS;
    button('export').disabled = !valid || !withinLimit;
    button('analyze').disabled = !state.worker || state.analyzing || !!state.batch;
    button('reload').disabled = !!state.batch;
    button('batch').disabled = !!state.batch || !api.getDocs().length;
    $('stale').hidden = !state.meta || !stale();
    $('export-size').textContent = state.result ? (withinLimit ? `${w} × ${h} px · ${state.exportScale}× 最近邻 · 透明 PNG` : '导出尺寸超过上限，请降低倍率。') : '最近邻整数放大 · 不导出网格和参考';
    const count = api.getDocs().length;
    $('batch-scope').textContent = `工作区 ${count} 张素材，按${state.sourceMode === 'layer' ? '各自活动图层' : '可见图层合成'}处理；结果新增为基础像素素材。`;
  }
  function status(text, busy = false) {
    $('status').textContent = text;
    $('status').dataset.busy = String(busy);
    updateActions();
  }
  function syncFields() {
    const o = state.options;
    $('source').value = state.sourceMode;
    $('grid-size').value = o.gridSize;
    $('offset-x').value = o.offsetX;
    $('offset-y').value = o.offsetY;
    for (const key of ['offset-x', 'offset-y']) { $(key).max = o.gridSize - 1; $(key).disabled = o.gridSize === 1; }
    $('sampling').value = o.sampling;
    $('palette-size').value = o.paletteSize;
    $('binary').checked = o.alphaMode === 'binary';
    $('alpha-row').hidden = o.alphaMode !== 'binary';
    $('alpha-threshold').value = o.alphaThreshold;
    $('alpha-label').textContent = o.alphaThreshold;
    $('denoise').checked = o.denoise;
    $('export-scale').value = state.exportScale;
    $('grid-hint').textContent = `${o.gridSize} × ${o.gridSize} 原图像素 → 1 个基础像素`;
    button('grid').setAttribute('aria-pressed', String(state.grid));
    button('preset-original').classList.toggle('opt-selected', JSON.stringify(o) === JSON.stringify(ORIGINAL));
    button('preset-user').classList.toggle('opt-selected', JSON.stringify(o) === JSON.stringify(USER_PRESET));
  }
  function readFields() {
    state.options = normalizeOptions({ gridSize: $('grid-size').value, offsetX: $('offset-x').value, offsetY: $('offset-y').value,
      sampling: $('sampling').value, paletteSize: $('palette-size').value, alphaMode: $('binary').checked ? 'binary' : 'preserve',
      alphaThreshold: $('alpha-threshold').value, denoise: $('denoise').checked });
    state.optionRevision++;
    syncFields();
    schedule();
    saveSettings();
  }
  function updatePalette() {
    $('palette').replaceChildren();
    for (const color of state.result?.palette.slice(0, 28) || []) {
      const swatch = document.createElement('button');
      swatch.className = 'opt-swatch';
      swatch.style.background = color.hex;
      swatch.title = `${color.hex} · ${color.count} 像素`;
      swatch.setAttribute('aria-label', `复制颜色 ${color.hex}`);
      swatch.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(color.hex); api.toast(`已复制 ${color.hex}`); }
        catch { api.toast(`颜色值：${color.hex}`); }
      });
      $('palette').append(swatch);
    }
  }
  async function processPreview() {
    if (!state.worker || state.inFlight || state.batch) return;
    const worker = state.worker;
    const revision = state.revision;
    const options = { ...state.options };
    state.inFlight = true;
    try {
      const message = await worker.run('process', options);
      if (worker !== state.worker) return;
      state.inFlight = false;
      if (revision !== state.revision) { processPreview(); return; }
      state.result = message.result;
      state.resultCanvas = resultToCanvas(message.result);
      state.renderedRevision = revision;
      $('result-size').textContent = `${state.result.width} × ${state.result.height}`;
      $('colors').textContent = state.result.stats.visibleColors.toLocaleString();
      $('stage-message').hidden = true;
      updatePalette();
      status(`预览已更新 · ${Math.max(1, Math.round(message.elapsed))} ms`);
      render();
    } catch (error) {
      if (worker !== state.worker || error.cancelled) return;
      state.inFlight = false;
      status('预览未完成');
      $('stage-message').textContent = error.message;
      $('stage-message').hidden = false;
      api.toast(error.message, true);
    }
  }
  function schedule(immediate = false) {
    state.revision++;
    clearTimeout(state.timer);
    if (!state.worker) return;
    status('正在更新预览…', true);
    if (!state.result) { $('stage-message').textContent = '正在生成像素预览…'; $('stage-message').hidden = false; }
    state.timer = setTimeout(processPreview, immediate ? 0 : 140);
    render();
  }
  function capture() {
    if (state.capturing || state.batch) return;
    state.capturing = true;
    try {
      api.finishPending();
      const d = api.getDoc();
      if (!d) return;
      if (d.width * d.height > MAX_INPUT_PIXELS) throw new Error('像素优化单张最多支持 1677 万像素，请先缩小图像或选用较小素材。');
      const canvas = state.sourceMode === 'layer' ? cloneCanvas(d.activeLayer.canvas) : cloneCanvas(api.getComposite(d));
      const pixels = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
      state.worker?.stop();
      state.worker = processor(pixels);
      state.source = canvas;
      state.sourcePixels = pixels;
      state.meta = { id: d.id, revision: d.revision, layerId: d.activeLayerId, width: d.width, height: d.height, name: d.name, layerName: d.activeLayer.name };
      state.result = null;
      state.resultCanvas = null;
      state.inFlight = false;
      state.analyzing = false;
      state.renderedRevision = -1;
      $('filename').textContent = d.name;
      $('source-note').textContent = state.sourceMode === 'layer' ? `活动图层：${d.activeLayer.name} · 原始像素快照` : '全部可见图层合成 · 原图快照已固定';
      $('original-size').textContent = `${canvas.width} × ${canvas.height}`;
      $('result-size').textContent = '计算中';
      $('colors').textContent = '—';
      $('palette').replaceChildren();
      $('analysis').textContent = '自动估计仅作建议，请放大核对边缘。';
      fit();
      schedule(true);
    } catch (error) {
      state.worker?.stop();
      state.worker = null;
      state.source = null; state.sourcePixels = null; state.meta = null;
      state.result = null; state.resultCanvas = null; state.inFlight = false;
      $('stage-message').textContent = error.message;
      $('stage-message').hidden = false;
      $('filename').textContent = api.getDoc()?.name || '未读取图像';
      status('无法读取当前素材');
      render();
      api.toast(error.message, true);
    } finally { state.capturing = false; }
  }
  async function analyze() {
    if (!state.worker || state.analyzing || state.batch) return;
    const worker = state.worker;
    const optionRevision = state.optionRevision;
    state.analyzing = true;
    status('正在估计重复网格…', true);
    try {
      const { analysis } = await worker.run('analyze');
      if (worker !== state.worker) return;
      state.analyzing = false;
      if (optionRevision !== state.optionRevision) { status('参数已手动修改，保留当前设置'); return; }
      state.options = normalizeOptions({ ...state.options, gridSize: analysis.gridSize, offsetX: analysis.offsetX, offsetY: analysis.offsetY });
      $('analysis').textContent = analysis.reason;
      $('analysis').classList.toggle('opt-warning', analysis.gridSize === 1);
      syncFields();
      schedule(true);
      saveSettings();
    } catch (error) {
      if (worker !== state.worker || error.cancelled) return;
      state.analyzing = false;
      status('网格估计未完成');
      api.toast(error.message, true);
    }
  }
  function view(mode) {
    state.view = ['split', 'side', 'result'].includes(mode) ? mode : 'split';
    $('area').classList.toggle('opt-side', state.view === 'side');
    $('second-pane').hidden = state.view !== 'side';
    $('split').hidden = state.view !== 'split';
    $('left-label').textContent = state.view === 'result' ? '优化结果' : '原图';
    $('right-label').hidden = state.view !== 'split';
    mount.querySelectorAll('[data-opt-view]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.optView === state.view)));
    render();
  }
  function setSplit(value) {
    state.split = clamp(value, 0, 1);
    $('split').style.left = `${state.split * 100}%`;
    $('split').setAttribute('aria-valuenow', Math.round(state.split * 100));
    $('split').setAttribute('aria-valuetext', `原图 ${Math.round(state.split * 100)}%，优化结果 ${Math.round((1 - state.split) * 100)}%`);
    render();
  }
  function zoom(value, canvas = main, point = null) {
    const old = state.zoom;
    state.zoom = clamp(value, 0.02, 64);
    if (point) {
      const rect = canvas.getBoundingClientRect();
      const x = point.x - rect.width / 2;
      const y = point.y - rect.height / 2;
      state.panX = x - (x - state.panX) * state.zoom / old;
      state.panY = y - (y - state.panY) * state.zoom / old;
    } else { state.panX *= state.zoom / old; state.panY *= state.zoom / old; }
    $('zoom').textContent = `${Math.round(state.zoom * 100)}%`;
    render();
  }
  function fit() {
    if (!state.source) return;
    const rect = $('main-pane').getBoundingClientRect();
    state.panX = state.panY = 0;
    zoom(Math.min(Math.max(50, rect.width - 90) / state.source.width, Math.max(50, rect.height - 80) / state.source.height));
  }
  function render() {
    if (!state.active || state.frame !== null) return;
    state.frame = requestAnimationFrame(() => {
      state.frame = null;
      draw(main, state.view === 'side' ? 'original' : state.view);
      if (state.view === 'side') draw(second, 'result');
    });
  }
  function draw(canvas, kind) {
    const rect = canvas.parentElement.getBoundingClientRect();
    const width = rect.width, height = rect.height;
    if (width < 1 || height < 1) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pw = Math.round(width * dpr), ph = Math.round(height * dpr);
    if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = state.background === 'light' ? '#e5e9ea' : '#151b21';
    ctx.fillRect(0, 0, width, height);
    if (state.background === 'checker') {
      ctx.fillStyle = '#1c242c';
      for (let y = 0; y < height; y += 12) for (let x = 0; x < width; x += 12) if ((x / 12 + y / 12) % 2 === 0) ctx.fillRect(x, y, 12, 12);
    }
    if (!state.source) return;
    const z = state.zoom;
    const left = Math.round(width / 2 + state.panX - state.source.width * z / 2);
    const top = Math.round(height / 2 + state.panY - state.source.height * z / 2);
    ctx.imageSmoothingEnabled = false;
    const original = () => ctx.drawImage(state.source, left, top, state.source.width * z, state.source.height * z);
    const result = () => {
      if (!state.resultCanvas) { original(); return; }
      const m = state.result.mapping;
      ctx.drawImage(state.resultCanvas, left + m.originX * z, top + m.originY * z, state.result.width * m.scaleX * z, state.result.height * m.scaleY * z);
    };
    if (kind === 'split') {
      ctx.save(); ctx.beginPath(); ctx.rect(0, 0, width * state.split, height); ctx.clip(); original(); ctx.restore();
      ctx.save(); ctx.beginPath(); ctx.rect(width * state.split, 0, width * (1 - state.split), height); ctx.clip(); result(); ctx.restore();
    } else if (kind === 'original') original(); else result();
    ctx.strokeStyle = state.background === 'light' ? '#83939d77' : '#74818c40';
    ctx.lineWidth = 1 / dpr;
    ctx.strokeRect(left, top, state.source.width * z, state.source.height * z);
    if (state.grid && state.options.gridSize * z >= 5) {
      const g = state.options.gridSize;
      const ox = state.options.offsetX > 0 ? state.options.offsetX - g : 0;
      const oy = state.options.offsetY > 0 ? state.options.offsetY - g : 0;
      const sx = left + ox * z, sy = top + oy * z, step = g * z;
      const nx = Math.ceil((state.source.width - ox) / g), ny = Math.ceil((state.source.height - oy) / g);
      ctx.save(); ctx.beginPath(); ctx.rect(sx, sy, nx * step, ny * step); ctx.clip();
      ctx.beginPath(); ctx.strokeStyle = state.background === 'light' ? '#315b6c50' : '#bddad733';
      for (let x = Math.max(0, Math.ceil(-sx / step)); x <= Math.min(nx, Math.ceil((width - sx) / step)); x++) { ctx.moveTo(Math.round(sx + x * step) + .5 / dpr, sy); ctx.lineTo(Math.round(sx + x * step) + .5 / dpr, sy + ny * step); }
      for (let y = Math.max(0, Math.ceil(-sy / step)); y <= Math.min(ny, Math.ceil((height - sy) / step)); y++) { ctx.moveTo(sx, Math.round(sy + y * step) + .5 / dpr); ctx.lineTo(sx + nx * step, Math.round(sy + y * step) + .5 / dpr); }
      ctx.stroke(); ctx.restore();
    }
  }
  function pixel(event, canvas) {
    if (!state.sourcePixels) return;
    const r = canvas.getBoundingClientRect();
    const px = event.clientX - r.left, py = event.clientY - r.top;
    const left = Math.round(r.width / 2 + state.panX - state.source.width * state.zoom / 2);
    const top = Math.round(r.height / 2 + state.panY - state.source.height * state.zoom / 2);
    let x = (px - left) / state.zoom, y = (py - top) / state.zoom;
    const isResult = canvas === second || state.view === 'result' || (state.view === 'split' && px > r.width * state.split);
    let image = state.sourcePixels;
    if (isResult && state.result) { const m = state.result.mapping; x = (x - m.originX) / m.scaleX; y = (y - m.originY) / m.scaleY; image = state.result; }
    x = Math.floor(x); y = Math.floor(y);
    if (x < 0 || y < 0 || x >= image.width || y >= image.height) { $('pixel').textContent = '移动指针查看 RGBA 像素值'; return; }
    const offset = (y * image.width + x) * 4;
    const rgba = [...image.data.subarray(offset, offset + 4)];
    const hex = '#' + rgba.slice(0, 3).map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase();
    $('pixel').textContent = `${isResult && state.result ? '结果' : '原图'} ${x}, ${y} · ${hex} · α ${rgba[3]}`;
  }
  for (const canvas of [main, second]) {
    canvas.addEventListener('wheel', event => {
      event.preventDefault(); event.stopPropagation();
      const r = canvas.getBoundingClientRect();
      zoom(state.zoom * Math.exp(-event.deltaY * .0015), canvas, { x: event.clientX - r.left, y: event.clientY - r.top });
    }, { passive: false });
    canvas.addEventListener('pointerdown', event => {
      if (event.button !== 0 && event.button !== 1) return;
      event.preventDefault(); event.stopPropagation(); canvas.setPointerCapture(event.pointerId);
      state.drag = { id: event.pointerId, canvas, x: event.clientX, y: event.clientY, panX: state.panX, panY: state.panY };
    });
    canvas.addEventListener('pointermove', event => {
      if (state.drag?.canvas === canvas && state.drag.id === event.pointerId) {
        state.panX = state.drag.panX + event.clientX - state.drag.x;
        state.panY = state.drag.panY + event.clientY - state.drag.y;
        render();
      }
      pixel(event, canvas);
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) canvas.addEventListener(type, event => { if (state.drag?.id === event.pointerId) state.drag = null; });
  }
  let splitDrag = null;
  $('split').addEventListener('pointerdown', event => { event.preventDefault(); event.stopPropagation(); splitDrag = event.pointerId; $('split').setPointerCapture(event.pointerId); });
  $('split').addEventListener('pointermove', event => { if (splitDrag !== event.pointerId) return; const r = $('main-pane').getBoundingClientRect(); setSplit((event.clientX - r.left) / r.width); });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) $('split').addEventListener(type, () => { splitDrag = null; });
  $('split').addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    setSplit(event.key === 'Home' ? 0 : event.key === 'End' ? 1 : state.split + (event.key === 'ArrowRight' ? .02 : -.02));
  });
  function newDocument() {
    if (!ready()) return;
    if (api.getDocs().length >= 100) throw new Error('工作区已达 100 张，请先关闭部分素材。');
    const canvas = cloneCanvas(state.resultCanvas);
    const d = new PaintDocument({ canvas, name: `${baseName(state.meta.name)}-pixel.png` });
    d.dirty = true;
    api.addDocument(d, { switchTo: true });
    api.setMode('paint');
    api.toast(`已创建 ${d.width} × ${d.height} 基础像素素材，原图已保留。`);
  }
  function applyLayer() {
    if (!ready() || stale()) { api.toast('当前图像已变更，请先重新读取，再应用优化结果。', true); return; }
    const d = api.getDoc();
    const canvas = makeCanvas(d.width, d.height);
    const ctx = canvas.getContext('2d');
    const m = state.result.mapping;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(state.resultCanvas, m.originX, m.originY, state.result.width * m.scaleX, state.result.height * m.scaleY);
    const options = state.sourceMode === 'layer' ? { hideLayerIds: [state.meta.layerId] } : { hideOriginals: true };
    api.applyLayer(canvas, `像素优化 · ${state.options.gridSize}px`, options);
    api.setMode('paint');
    api.toast('优化结果已放入新图层，源图层已隐藏并保留；可撤销或重新显示。');
  }
  async function exportPNG() {
    if (!ready()) return;
    const scale = state.exportScale;
    const source = state.resultCanvas;
    const width = source.width * scale, height = source.height * scale;
    if (width > 16384 || height > 16384 || width * height > MAX_EXPORT_PIXELS) throw new Error('导出尺寸过大，请降低整数倍率。');
    // Export may be larger than the editor's document side limit.
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(source, 0, 0, width, height);
    const name = `${baseName(state.meta.name)}-pixel-${scale}x.png`;
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('PNG 编码未完成，请降低导出倍率后重试。');
    downloadBlob(blob, name);
    api.toast(`已生成 ${width} × ${height} 透明 PNG。`);
  }
  async function batch() {
    if (state.batch) return;
    api.finishPending();
    const docs = [...api.getDocs()];
    if (api.getDocs().length >= 100) throw new Error('工作区已达 100 张，请先关闭部分素材再批处理。');
    const options = { ...state.options };
    const sourceMode = state.sourceMode;
    const job = { cancelled: false, worker: null, completed: 0, failures: [], disabledControls: new Map() };
    state.batch = job;
    root.classList.add('opt-batching');
    root.querySelectorAll('.opt-controls input,.opt-controls select,.opt-controls button').forEach(control => {
      job.disabledControls.set(control, control.disabled);
      control.disabled = true;
    });
    button('cancel-batch').hidden = false;
    $('batch-progress').hidden = false;
    $('batch-progress').max = docs.length;
    $('batch-progress').value = 0;
    $('batch-report').textContent = `准备处理 ${docs.length} 张素材…`;
    updateActions();
    try {
      for (let i = 0; i < docs.length; i++) {
        if (job.cancelled) break;
        if (api.getDocs().length >= 100) { job.failures.push('已达到 100 张工作区上限，剩余素材未处理。'); break; }
        const d = docs[i];
        status(`批量处理 ${i + 1} / ${docs.length}`, true);
        $('batch-report').textContent = `${i + 1} / ${docs.length} · ${d.name}\n已新增 ${job.completed} 张优化素材`;
        try {
          if (d.width * d.height > MAX_INPUT_PIXELS) throw new Error('超过单张 1677 万像素上限');
          if (!api.getDocs().includes(d)) throw new Error('该素材已关闭或工作区已切换');
          const source = sourceMode === 'layer' ? d.activeLayer.canvas : api.getComposite(d);
          const image = source.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, source.width, source.height);
          job.worker = processor(image);
          const { result } = await job.worker.run('process', options);
          job.worker.stop(); job.worker = null;
          if (job.cancelled) break;
          if (!api.getDocs().includes(d)) throw new Error('处理期间素材已关闭或工作区已切换，已跳过结果');
          const output = new PaintDocument({ canvas: resultToCanvas(result), name: `${baseName(d.name)}-pixel.png` });
          output.dirty = true;
          api.addDocument(output, { switchTo: false });
          job.completed++;
        } catch (error) {
          job.worker?.stop(); job.worker = null;
          if (job.cancelled || error.cancelled) break;
          job.failures.push(`${d.name}：${error.message}`);
          if (/预算|内存|像素总量|工作区.*上限|最多100/.test(error.message)) break;
        }
        $('batch-progress').value = i + 1;
      }
    } finally {
      job.worker?.stop();
      state.batch = null;
      root.classList.remove('opt-batching');
      for (const [control, wasDisabled] of job.disabledControls) control.disabled = wasDisabled;
      syncFields();
      button('cancel-batch').hidden = true;
      const title = `${job.cancelled ? '已停止' : '处理完成'}：新增 ${job.completed} 张优化素材，原图全部保留。`;
      $('batch-report').textContent = title + (job.failures.length ? '\n' + job.failures.slice(0, 10).join('\n') + (job.failures.length > 10 ? `\n另有 ${job.failures.length - 10} 项未完成` : '') : '');
      status(job.cancelled ? '批处理已停止' : '批处理完成');
      api.persist();
      api.toast(title, job.completed === 0 && job.failures.length > 0);
      if (state.active && state.meta?.id !== api.getDoc()?.id) capture();
      else if (state.renderedRevision !== state.revision && state.worker) processPreview();
    }
  }
  const actions = {
    reload: capture,
    analyze,
    'preset-original': () => { state.options = { ...ORIGINAL }; state.optionRevision++; syncFields(); schedule(true); saveSettings(); },
    'preset-user': () => { state.options = { ...USER_PRESET }; state.optionRevision++; syncFields(); schedule(true); saveSettings(); },
    'zoom-in': () => zoom(state.zoom * 1.25), 'zoom-out': () => zoom(state.zoom / 1.25), fit,
    actual: () => { state.panX = state.panY = 0; zoom(1); },
    grid: () => { state.grid = !state.grid; syncFields(); render(); saveSettings(); },
    background: () => { const modes = ['checker', 'light', 'dark']; state.background = modes[(modes.indexOf(state.background) + 1) % modes.length]; render(); saveSettings(); },
    'new-document': newDocument, 'apply-layer': applyLayer, export: exportPNG, batch,
    'cancel-batch': () => { if (state.batch) { state.batch.cancelled = true; state.batch.worker?.stop(); } },
  };
  mount.addEventListener('click', event => {
    const action = event.target.closest('[data-opt-action]');
    if (action && !action.disabled) { event.stopPropagation(); Promise.resolve().then(() => actions[action.dataset.optAction]?.()).catch(error => api.toast(error.message, true)); }
    const mode = event.target.closest('[data-opt-view]');
    if (mode) { view(mode.dataset.optView); saveSettings(); }
  });
  for (const name of ['grid-size', 'offset-x', 'offset-y', 'palette-size']) $(name).addEventListener('input', readFields);
  for (const name of ['sampling', 'binary', 'denoise']) $(name).addEventListener('change', readFields);
  $('alpha-threshold').addEventListener('input', readFields);
  $('source').addEventListener('change', () => { state.sourceMode = $('source').value; capture(); saveSettings(); });
  $('export-scale').addEventListener('change', () => { state.exportScale = integer($('export-scale').value, 1, 1, 8); updateActions(); saveSettings(); });
  const observer = new ResizeObserver(render);
  observer.observe($('area'));
  syncFields(); view(state.view); updateActions();
  return {
    activate() { state.active = true; if (!state.source || state.meta?.id !== api.getDoc()?.id) capture(); else { updateActions(); render(); } },
    deactivate() { state.active = false; state.drag = null; },
    refresh() {
      if (state.capturing) return;
      if (state.active && !state.batch && state.meta?.id !== api.getDoc()?.id) capture();
      else { updateActions(); render(); }
    },
    handleAction(name) {
      const aliases = { 'export-result': 'export', 'export-dialog': 'export' };
      const action = aliases[name] || name;
      if (!['export', 'fit', 'actual', 'zoom-in', 'zoom-out'].includes(action)) return false;
      Promise.resolve().then(() => actions[action]()).catch(error => api.toast(error.message, true));
      return true;
    },
    exportResult: exportPNG,
    serialize() { return { options: { ...state.options }, sourceMode: state.sourceMode, view: state.view, grid: state.grid, background: state.background, exportScale: state.exportScale }; },
    restore(data = {}) {
      data = data && typeof data === 'object' ? data : {};
      // Workspace restoration installs documents after restoring module settings.
      // Drop the previous workspace's snapshot and wait for activate() so even
      // a reopened document with the same id cannot reuse old pixels.
      state.active = false;
      clearTimeout(state.timer);
      state.worker?.stop();
      state.worker = null;
      state.source = null; state.sourcePixels = null; state.meta = null;
      state.result = null; state.resultCanvas = null;
      state.inFlight = false; state.analyzing = false; state.renderedRevision = -1;
      if (state.batch) { state.batch.cancelled = true; state.batch.worker?.stop(); }
      state.options = normalizeOptions(data.options || ORIGINAL);
      state.sourceMode = data.sourceMode === 'layer' ? 'layer' : 'composite';
      state.grid = Boolean(data.grid);
      state.background = ['checker', 'light', 'dark'].includes(data.background) ? data.background : 'checker';
      state.exportScale = [1, 2, 4, 8].includes(data.exportScale) ? data.exportScale : 1;
      syncFields(); view(data.view); updateActions();
    },
  };
}
