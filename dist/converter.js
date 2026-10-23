import { PaintDocument, makeCanvas, cloneCanvas } from './core.js';
import { downloadBlob, createFileZip } from './io.js';
import { DEFAULT_CONVERSION_OPTIONS, normalizeConversionOptions, conversionToSvg } from './conversion-core.js';

const MAX_INPUT_PIXELS = 16_777_216;
const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
const stem = name => String(name || '素材').replace(/\.[^.]+$/, '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').slice(0, 100) || '素材';
const sizeText = (w, h) => `${w} × ${h}`;
const cancelledError = () => Object.assign(new Error('像素转换已停止。'), { cancelled: true });

function outputCanvas(result) {
  const grid = makeCanvas(result.width, result.height);
  grid.getContext('2d').putImageData(new ImageData(result.data, result.width, result.height), 0, 0);
  const canvas = makeCanvas(result.outputWidth, result.outputHeight);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(grid, 0, 0, result.width * result.pixelSize, result.height * result.pixelSize);
  return canvas;
}

function encodePNG(canvas) {
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('PNG 编码失败，请缩小输出尺寸后重试。')), 'image/png'));
}

// Each job owns its worker and input. Termination also rejects the pending promise.
function conversionJob(source, options) {
  const width = Math.max(1, Math.round(source.width * options.outputSize / 100));
  const height = Math.max(1, Math.round(source.height * options.outputSize / 100));
  if (width * height > MAX_INPUT_PIXELS) throw new Error('缩放后的图像最多支持 1677 万像素，请调低「输出缩放」。');
  const scaled = makeCanvas(width, height);
  const context = scaled.getContext('2d', { willReadFrequently: true });
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(source, 0, 0, width, height);
  const pixels = context.getImageData(0, 0, width, height);
  const worker = new Worker(new URL('./conversion-worker.js', import.meta.url), { type: 'module' });
  let settled = false, rejectJob, timeout;
  const finish = () => { settled = true; clearTimeout(timeout); worker.terminate(); };
  const promise = new Promise((resolve, reject) => {
    rejectJob = reject;
    worker.onmessage = ({ data }) => {
      if (settled || data.id !== 1) return;
      finish();
      if (data.error) reject(new Error(data.error)); else resolve(data.result);
    };
    worker.onerror = () => { if (!settled) { finish(); reject(new Error('像素转换未能运行，请重新读取素材或刷新页面。')); } };
    timeout = setTimeout(() => { if (!settled) { finish(); reject(new Error('这张图片处理时间较长，请提高像素块大小或调低输出缩放后重试。')); } }, 90_000);
    worker.postMessage({ id: 1, image: { width, height, data: pixels.data }, options }, [pixels.data.buffer]);
  });
  return { promise, cancel() { if (!settled) { finish(); rejectJob(cancelledError()); } } };
}

export function createConverter(api, mount) {
  mount.innerHTML = `
    <div class="conv-root">
      <section class="conv-preview" aria-label="图片像素转换预览">
        <header class="conv-heading"><div><span class="conv-eyebrow">IMAGE TO PIXEL ART</span><h2>把灵感变成像素<span class="conv-badge">本地转换</span></h2><p data-conv="filename">选择左侧素材，或导入一张图片</p></div><button class="conv-btn" data-conv-action="reload" title="重新读取当前素材的可见图层">↻ 重新读取</button></header>
        <div class="conv-toolbar"><div class="conv-segment" role="group" aria-label="转换预览方式"><button data-conv-view="compare" aria-pressed="true">前后对比</button><button data-conv-view="result" aria-pressed="false">仅结果</button><button data-conv-view="original" aria-pressed="false">原图</button></div><div class="conv-zoom"><button class="conv-btn" data-conv-action="zoom-out" aria-label="缩小转换预览">−</button><span data-conv="zoom">100%</span><button class="conv-btn" data-conv-action="zoom-in" aria-label="放大转换预览">＋</button><button class="conv-btn" data-conv-action="fit">适合</button><button class="conv-btn" data-conv-action="actual">1:1</button></div><button class="conv-btn" data-conv-action="grid" aria-pressed="false" title="只在预览中显示像素块边界">网格</button></div>
        <div class="conv-stage" data-conv="stage">
          <div class="conv-pane" data-conv="original-pane"><div class="conv-pane-label"><span>原始素材</span><b data-conv="original-label">—</b></div><canvas data-conv="original" aria-label="像素转换原图预览"></canvas></div>
          <div class="conv-pane" data-conv="result-pane"><div class="conv-pane-label"><span>像素转换</span><b data-conv="result-label">—</b></div><canvas data-conv="result" aria-label="像素转换结果预览"></canvas></div>
          <div class="conv-message" data-conv="message" role="status" hidden></div>
        </div>
        <div class="conv-summary"><div><span>原图尺寸</span><strong data-conv="source-size">—</strong></div><div><span>输出尺寸</span><strong class="conv-accent" data-conv="output-size">—</strong></div><div><span>像素网格</span><strong data-conv="grid-size">—</strong></div><div><span>实际颜色</span><strong data-conv="colors">—</strong></div></div>
        <div class="conv-preview-footer"><span data-conv="status" role="status" aria-live="polite">选择素材开始转换</span><span>原图按输出比例对照 · 滚轮缩放 · 拖动平移</span></div>
      </section>
      <aside class="conv-settings" aria-label="像素转换参数">
        <section class="conv-section"><h3><span>01</span>输入素材</h3><div class="conv-two"><button class="conv-btn" data-conv-action="import">导入图片</button><button class="conv-btn" data-conv-action="folder">导入文件夹</button></div><p class="conv-hint">使用左侧当前素材的可见图层。支持多图导入，也可直接拖入图片。</p><div class="conv-source-chip"><span class="conv-dot"></span><span data-conv="source-name">尚未选择素材</span></div></section>
        <section class="conv-section"><h3><span>02</span>转换参数<button class="conv-reset" data-conv-action="reset">重置</button></h3>
          <div class="conv-control"><div class="conv-control-title"><label for="conv-pixel-range">像素块大小</label><span><b data-conv-value="pixelSize">8</b> px</span></div><div class="conv-range"><input id="conv-pixel-range" type="range" min="2" max="32" value="8" data-conv-option="pixelSize" aria-label="像素块大小滑杆"><input type="number" min="2" max="32" value="8" step="1" data-conv-option="pixelSize" aria-label="像素块大小"></div><div class="conv-range-note"><span>2 px · 精细</span><span>32 px · 粗颗粒</span></div></div>
          <div class="conv-control"><div class="conv-control-title"><label for="conv-color-range">最大颜色数</label><span><b data-conv-value="colorCount">128</b> 色</span></div><div class="conv-range"><input id="conv-color-range" type="range" min="2" max="256" value="128" data-conv-option="colorCount" aria-label="最大颜色数滑杆"><input type="number" min="2" max="256" value="128" step="1" data-conv-option="colorCount" aria-label="最大颜色数"></div><div class="conv-range-note"><span>2 色</span><span>256 色</span></div></div>
          <div class="conv-control"><div class="conv-control-title"><label for="conv-size-range">输出缩放</label><span><b data-conv-value="outputSize">100</b>%</span></div><div class="conv-range"><input id="conv-size-range" type="range" min="10" max="100" value="100" data-conv-option="outputSize" aria-label="输出缩放滑杆"><input type="number" min="10" max="100" value="100" step="1" data-conv-option="outputSize" aria-label="输出缩放百分比"></div><div class="conv-range-note"><span>10%</span><span>100%</span></div></div>
          <label class="conv-field">采样方法<select data-conv-option="sampling"><option value="dominant">主色调 · 保留主要色块</option><option value="mean">平均值 · 过渡柔和</option><option value="median">中位数 · 减少极端杂色</option></select></label>
          <label class="conv-check"><input type="checkbox" data-conv-option="gridAlign" checked>网格对齐</label><p class="conv-hint conv-check-hint">输出补齐为完整像素块，末格边缘延展；关闭时保留缩放后尺寸。</p>
          <label class="conv-check"><input type="checkbox" data-conv-option="preserveAlpha" checked>保留透明背景</label><p class="conv-hint conv-check-hint">保留透明与半透明区域；关闭时将透明部分合成到白底。</p>
          <div class="conv-palette" data-conv="palette" aria-label="转换结果色板"></div>
        </section>
        <section class="conv-section"><h3><span>03</span>继续创作与导出</h3><div class="conv-actions"><button class="conv-btn conv-primary" data-conv-action="save-edit" disabled>保存新素材并进入绘画 <span>→</span></button><button class="conv-btn" data-conv-action="save" disabled>保存为工作区新素材</button><div class="conv-export-row"><select data-conv="format" aria-label="像素转换导出格式"><option value="png">PNG</option><option value="svg">SVG</option></select><button class="conv-btn" data-conv-action="export" disabled>下载 PNG</button></div></div><p class="conv-hint" data-conv="save-note">转换结果另存为新素材，原图保留。SVG 使用矩形像素块并保留透明度。</p></section>
        <section class="conv-section"><h3><span>04</span>工作区批量转换<b data-conv="doc-count">0 张</b></h3><p class="conv-hint" data-conv="batch-scope">使用同一组参数，各张素材独立计算尺寸。</p><div class="conv-actions"><button class="conv-btn" data-conv-action="batch-save">批量保存新素材</button><button class="conv-btn conv-outline" data-conv-action="batch-zip">转换并打包 ZIP</button><button class="conv-btn" data-conv-action="cancel" hidden>停止批量转换</button></div><progress data-conv="progress" value="0" max="1" hidden></progress><p class="conv-report" data-conv="report" aria-live="polite"></p><p class="conv-hint">范围固定为开始时的工作区。离开此面板会停止后续转换；已保存的新素材保留。</p></section>
      </aside>
    </div>`;

  const $ = name => mount.querySelector(`[data-conv="${name}"]`);
  const button = name => mount.querySelector(`[data-conv-action="${name}"]`);
  const state = {
    active: false, options: { ...DEFAULT_CONVERSION_OPTIONS }, view: 'compare', format: 'png', grid: false,
    source: null, meta: null, result: null, resultCanvas: null, epoch: 0, resultEpoch: -1,
    timer: null, job: null, processing: false, capturing: false, saving: false, batch: null,
    zoom: 1, panX: 0, panY: 0, drag: null, frame: null, autoFit: true,
  };

  function matchesSource() {
    const doc = api.getDoc(), meta = state.meta;
    return !!meta && doc === meta.document && doc?.revision === meta.revision && doc?.width === meta.width && doc?.height === meta.height;
  }
  function ready() { return !!state.result && state.resultEpoch === state.epoch && !state.processing && !state.batch && !state.saving && matchesSource(); }
  function status(message) { $('status').textContent = message; }
  function updateActions() {
    const ok = ready(), busy = !!state.batch || state.saving;
    const count = api.getDocs().length;
    for (const name of ['save', 'save-edit']) button(name).disabled = !ok || count >= 100;
    button('export').disabled = !ok;
    for (const name of ['reload', 'reset', 'import', 'folder']) button(name).disabled = busy;
    mount.querySelectorAll('[data-conv-option]').forEach(input => { input.disabled = busy; });
    $('format').disabled = busy;
    button('export').textContent = `下载 ${state.format.toUpperCase()}`;
    button('batch-save').disabled = busy || count < 1 || count * 2 > 100;
    button('batch-zip').disabled = busy || count < 1;
    button('cancel').hidden = !state.batch;
    $('progress').hidden = !state.batch;
    $('doc-count').textContent = `${count} 张`;
    $('batch-scope').textContent = count * 2 > 100
      ? `当前 ${count} 张，新增位置剩余 ${Math.max(0, 100 - count)} 个。请关闭部分素材后批量保存，或直接导出 ZIP。`
      : `将开始时的 ${count} 张素材按当前参数逐张转换，各自保留独立输出尺寸。ZIP 使用 ${state.format.toUpperCase()}。`;
    $('save-note').textContent = count >= 100 ? '工作区已达 100 张上限，可先关闭不需要的素材或直接下载结果。' : '转换结果另存为新素材，原图保留。SVG 使用矩形像素块并保留透明度。';
  }
  function syncOptions() {
    mount.querySelectorAll('[data-conv-option]').forEach(input => {
      const value = state.options[input.dataset.convOption];
      if (input.type === 'checkbox') input.checked = value; else input.value = value;
    });
    mount.querySelectorAll('[data-conv-value]').forEach(label => { label.textContent = state.options[label.dataset.convValue]; });
    $('format').value = state.format;
  }
  function setView(value) {
    state.view = ['compare', 'result', 'original'].includes(value) ? value : 'compare';
    $('original-pane').hidden = state.view === 'result';
    $('result-pane').hidden = state.view === 'original';
    $('stage').classList.toggle('conv-single', state.view !== 'compare');
    mount.querySelectorAll('[data-conv-view]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.convView === state.view)));
    requestAnimationFrame(() => { if (state.active) fit(); });
  }
  function clearPreviewJob() {
    clearTimeout(state.timer); state.timer = null;
    state.job?.cancel(); state.job = null;
    state.processing = false;
  }
  function capture() {
    if (state.capturing || state.saving || state.batch || !state.active) return;
    state.capturing = true;
    try {
      api.finishPending();
      clearPreviewJob();
      state.epoch++;
      state.result = null; state.resultCanvas = null; state.resultEpoch = -1;
      const doc = api.getDoc();
      if (!doc) { state.source = null; state.meta = null; status('选择或导入图片后开始转换'); return; }
      state.source = cloneCanvas(api.getComposite(doc));
      state.meta = { document: doc, name: doc.name, revision: doc.revision, width: doc.width, height: doc.height };
      state.autoFit = true;
      $('filename').textContent = doc.name;
      $('source-name').textContent = doc.name;
      $('original-label').textContent = `${sizeText(doc.width, doc.height)} px`;
      $('source-size').textContent = sizeText(doc.width, doc.height);
      for (const name of ['output-size', 'grid-size', 'colors', 'result-label']) $(name).textContent = '—';
      $('palette').replaceChildren();
      schedule(true);
    } catch (error) { showError(error); }
    finally { state.capturing = false; updateActions(); render(); }
  }
  function showError(error) {
    if (error?.cancelled) return;
    state.processing = false;
    $('message').textContent = error.message || '转换未完成，请重试。';
    $('message').hidden = false;
    $('message').classList.add('conv-error');
    status(error.message || '转换未完成');
    updateActions();
  }
  function schedule(immediate = false) {
    state.epoch++;
    clearPreviewJob();
    if (!state.source || !state.active || state.batch) return;
    state.processing = true;
    $('message').textContent = '正在生成像素预览…';
    $('message').classList.remove('conv-error');
    $('message').hidden = false;
    status('正在更新预览…');
    updateActions();
    state.timer = setTimeout(processPreview, immediate ? 0 : 180);
  }
  async function processPreview() {
    const epoch = state.epoch, source = state.source, options = { ...state.options };
    let job;
    try {
      job = conversionJob(source, options); state.job = job;
      const result = await job.promise;
      if (!state.active || state.epoch !== epoch || state.source !== source || state.batch) return;
      state.result = result; state.resultCanvas = outputCanvas(result); state.resultEpoch = epoch;
      state.processing = false;
      $('message').hidden = true;
      $('output-size').textContent = sizeText(result.outputWidth, result.outputHeight);
      $('result-label').textContent = `${sizeText(result.outputWidth, result.outputHeight)} px`;
      $('grid-size').textContent = sizeText(result.width, result.height);
      $('colors').textContent = `${result.colors} 色`;
      $('palette').replaceChildren(...result.palette.slice(0, 64).map(color => {
        const item = document.createElement('span');
        const hex = '#' + [color.r, color.g, color.b].map(v => v.toString(16).padStart(2, '0')).join('');
        item.style.background = hex; item.title = hex.toUpperCase();
        return item;
      }));
      $('palette').title = `${result.colors} 种 RGB 颜色${result.colors > 64 ? '，展示前 64 色' : ''}`;
      status(result.colors ? `转换完成 · ${options.pixelSize} px 色块 · ${options.preserveAlpha ? '透明度保留' : '白色背景'}` : '转换完成 · 素材为全透明');
      if (state.autoFit) { fit(); state.autoFit = false; }
      render();
    } catch (error) { if (epoch === state.epoch && state.active && !error.cancelled) showError(error); }
    finally { if (state.job === job) state.job = null; if (epoch === state.epoch) { state.processing = false; updateActions(); } }
  }
  function outputName(name, format, pixelSize = state.options.pixelSize) { return `${stem(name)}_像素化_${pixelSize}px.${format}`; }
  function unusedName(name) {
    const used = new Set(api.getDocs().map(d => d.name.toLowerCase()));
    const base = name.replace(/\.png$/i, '');
    let candidate = name, suffix = 2;
    while (used.has(candidate.toLowerCase())) candidate = `${base}_${suffix++}.png`;
    return candidate;
  }
  function createDocument(canvas, name, pixelSize) {
    const doc = new PaintDocument({ name: unusedName(outputName(name, 'png', pixelSize)), canvas });
    doc.activeLayer.name = '像素转换结果';
    doc.resetHistory('像素转换');
    return doc;
  }
  async function saveResult(goToPaint) {
    if (!ready()) return;
    state.saving = true; updateActions();
    try {
      const next = createDocument(state.resultCanvas, state.meta.name, state.options.pixelSize);
      api.addDocument(next, { switchTo: goToPaint });
      if (goToPaint) await api.setMode('paint');
      api.toast(goToPaint ? '已保存像素素材，可以继续分层绘画。' : '已保存为工作区新素材，当前原图继续保留。');
    } finally { state.saving = false; updateActions(); }
  }
  async function exportResult() {
    if (!ready()) return;
    const result = state.result, format = state.format, name = outputName(state.meta.name, format);
    const blob = format === 'svg' ? new Blob([conversionToSvg(result)], { type: 'image/svg+xml;charset=utf-8' }) : await encodePNG(state.resultCanvas);
    downloadBlob(blob, name);
    api.toast(`${format.toUpperCase()} 已生成，包含转换后的尺寸与透明度。`);
  }

  function cancelBatch() {
    if (!state.batch) return;
    state.batch.cancelled = true; state.batch.job?.cancel();
    $('report').textContent = '正在停止；已保存的新素材将保留。';
  }
  async function batchConvert(destination) {
    if (state.batch || state.saving) return;
    api.finishPending();
    const docs = api.getDocs().map(doc => ({ document: doc, revision: doc.revision, name: doc.name, width: doc.width, height: doc.height }));
    if (!docs.length) return;
    if (destination === 'workspace' && api.getDocs().length + docs.length > 100) throw new Error('批量新增后将超过 100 张素材，请关闭部分素材或直接导出 ZIP。');
    const options = { ...state.options }, format = state.format;
    const batch = { cancelled: false, job: null, completed: 0, errors: [], index: 0, total: docs.length, zipReady: false, fatalError: '' };
    clearPreviewJob(); state.epoch++;
    state.batch = batch;
    const files = [];
    let bytes = 0;
    updateActions();
    $('progress').max = docs.length; $('progress').value = 0;
    status('批量转换中 · 参数与处理范围已固定');
    $('message').hidden = true;
    const current = item => api.getDocs().includes(item.document) && item.document.revision === item.revision && item.document.width === item.width && item.document.height === item.height;
    const cancelled = () => batch.cancelled || state.batch !== batch || !state.active;
    try {
      for (const item of docs) {
        if (cancelled()) break;
        $('report').textContent = `正在处理 ${batch.index + 1} / ${docs.length}：${item.name}`;
        try {
          if (!current(item)) throw new Error('原素材已修改或关闭，已跳过');
          const source = cloneCanvas(api.getComposite(item.document));
          batch.job = conversionJob(source, options);
          const result = await batch.job.promise;
          batch.job = null;
          if (cancelled()) break;
          if (!current(item)) throw new Error('原素材已修改或关闭，已跳过');
          if (destination === 'workspace') {
            const canvas = outputCanvas(result);
            api.addDocument(createDocument(canvas, item.name, options.pixelSize), { switchTo: false });
          } else {
            const blob = format === 'svg' ? new Blob([conversionToSvg(result)], { type: 'image/svg+xml;charset=utf-8' }) : await encodePNG(outputCanvas(result));
            if (cancelled()) break;
            if (!current(item)) throw new Error('原素材已修改或关闭，已跳过');
            if (bytes + blob.size > 256 * 1024 * 1024) throw new Error('本批 ZIP 已达 256 MB，请分批处理');
            files.push({ name: outputName(item.name, format, options.pixelSize), blob }); bytes += blob.size;
          }
          batch.completed++;
        } catch (error) {
          if (error.cancelled || cancelled()) break;
          batch.errors.push(`${item.name}：${error.message}`);
        }
        batch.index++;
        $('progress').value = batch.index;
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      if (destination === 'zip' && files.length && !cancelled()) {
        $('report').textContent = `正在打包 ${files.length} 张 ${format.toUpperCase()}…`;
        const zip = await createFileZip(files, { isCancelled: cancelled });
        if (!cancelled()) { downloadBlob(zip, `画境-像素转换-${format.toUpperCase()}.zip`); batch.zipReady = true; }
      }
    } catch (error) { if (!error.cancelled && !cancelled()) batch.fatalError = error.message; }
    finally {
      batch.job?.cancel();
      if (state.batch !== batch) return;
      const stopped = cancelled();
      state.batch = null;
      const verb = destination === 'workspace' ? '新增' : batch.zipReady ? '已打包' : '已处理';
      $('report').textContent = `${stopped ? '已停止' : batch.fatalError ? '打包未完成' : '批量转换完成'} · ${verb} ${batch.completed} / ${docs.length} 张${batch.errors.length ? ` · 失败或跳过 ${batch.errors.length} 张\n${batch.errors.slice(0, 5).join('\n')}` : ''}${batch.fatalError ? `\n${batch.fatalError}` : ''}${stopped && destination === 'zip' ? '\n已取消 ZIP 下载。' : ''}`;
      api.persist();
      if (state.active) { if (!matchesSource()) capture(); else schedule(true); }
      updateActions();
    }
  }

  function virtualSize(original) {
    if (!state.source) return { width: 1, height: 1 };
    if (!original && state.result) return { width: state.result.outputWidth, height: state.result.outputHeight };
    return { width: Math.max(1, Math.round(state.source.width * state.options.outputSize / 100)), height: Math.max(1, Math.round(state.source.height * state.options.outputSize / 100)) };
  }
  function zoom(value, canvas = null, point = null) {
    const old = state.zoom;
    state.zoom = clamp(value, 0.01, 64);
    if (canvas && point) {
      const bounds = canvas.getBoundingClientRect(), x = point.x - bounds.width / 2, y = point.y - bounds.height / 2;
      state.panX = x - (x - state.panX) * state.zoom / old;
      state.panY = y - (y - state.panY) * state.zoom / old;
    } else { state.panX *= state.zoom / old; state.panY *= state.zoom / old; }
    $('zoom').textContent = `${Math.round(state.zoom * 100)}%`;
    render();
  }
  function fit() {
    if (!state.source || !state.active) return;
    const pane = $(state.view === 'original' ? 'original-pane' : 'result-pane');
    const rect = pane.getBoundingClientRect(), a = virtualSize(true), b = virtualSize(false);
    state.panX = state.panY = 0;
    zoom(Math.min(Math.max(24, rect.width - 60) / Math.max(a.width, b.width), Math.max(24, rect.height - 80) / Math.max(a.height, b.height), 16));
  }
  function render() {
    if (!state.active || state.frame !== null) return;
    state.frame = requestAnimationFrame(() => {
      state.frame = null;
      if (!state.active) return;
      if (state.view !== 'result') draw($('original'), true);
      if (state.view !== 'original') draw($('result'), false);
    });
  }
  function draw(canvas, original) {
    const rect = canvas.parentElement.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2), w = rect.width, h = rect.height;
    const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
    if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#181d24'; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#202731';
    for (let y = 0; y < h; y += 12) for (let x = 0; x < w; x += 12) if ((x / 12 + y / 12) % 2 === 0) ctx.fillRect(x, y, 12, 12);
    const image = original ? state.source : state.resultCanvas;
    if (!image) return;
    const size = virtualSize(original), z = state.zoom;
    const left = Math.round(w / 2 + state.panX - size.width * z / 2), top = Math.round(h / 2 + state.panY - size.height * z / 2);
    ctx.imageSmoothingEnabled = original;
    ctx.drawImage(image, left, top, size.width * z, size.height * z);
    ctx.strokeStyle = '#8797ad55'; ctx.lineWidth = 1 / dpr;
    ctx.strokeRect(left, top, size.width * z, size.height * z);
    const ps = state.result?.pixelSize || state.options.pixelSize, step = ps * z;
    if (state.grid && step >= 6) {
      ctx.save(); ctx.beginPath(); ctx.rect(left, top, size.width * z, size.height * z); ctx.clip();
      ctx.beginPath(); ctx.strokeStyle = '#bed3e344';
      const nx = Math.ceil(size.width / ps), ny = Math.ceil(size.height / ps);
      for (let x = Math.max(0, Math.ceil(-left / step)); x <= Math.min(nx, Math.ceil((w - left) / step)); x++) { ctx.moveTo(left + x * step, top); ctx.lineTo(left + x * step, top + size.height * z); }
      for (let y = Math.max(0, Math.ceil(-top / step)); y <= Math.min(ny, Math.ceil((h - top) / step)); y++) { ctx.moveTo(left, top + y * step); ctx.lineTo(left + size.width * z, top + y * step); }
      ctx.stroke(); ctx.restore();
    }
  }
  for (const canvas of [$('original'), $('result')]) {
    canvas.addEventListener('wheel', event => {
      event.preventDefault(); event.stopPropagation();
      const rect = canvas.getBoundingClientRect();
      zoom(state.zoom * Math.exp(-event.deltaY * .0015), canvas, { x: event.clientX - rect.left, y: event.clientY - rect.top });
    }, { passive: false });
    canvas.addEventListener('pointerdown', event => {
      if (event.button !== 0 && event.button !== 1) return;
      event.preventDefault(); canvas.setPointerCapture(event.pointerId);
      state.drag = { id: event.pointerId, x: event.clientX, y: event.clientY, panX: state.panX, panY: state.panY };
    });
    canvas.addEventListener('pointermove', event => {
      if (!state.drag || state.drag.id !== event.pointerId) return;
      state.panX = state.drag.panX + event.clientX - state.drag.x; state.panY = state.drag.panY + event.clientY - state.drag.y; render();
    });
    for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) canvas.addEventListener(name, () => { state.drag = null; });
  }
  const actions = {
    import: () => api.action('open'), folder: () => api.action('folder'), reload: capture,
    reset: () => { state.options = { ...DEFAULT_CONVERSION_OPTIONS }; state.autoFit = true; syncOptions(); schedule(); api.persist(); },
    save: () => saveResult(false), 'save-edit': () => saveResult(true), export: exportResult,
    'batch-save': () => batchConvert('workspace'), 'batch-zip': () => batchConvert('zip'), cancel: cancelBatch,
    fit, actual: () => { state.panX = state.panY = 0; zoom(1); }, 'zoom-in': () => zoom(state.zoom * 1.25), 'zoom-out': () => zoom(state.zoom / 1.25),
    grid: () => { state.grid = !state.grid; button('grid').setAttribute('aria-pressed', String(state.grid)); render(); api.persist(); },
  };
  mount.addEventListener('click', event => {
    const view = event.target.closest('[data-conv-view]');
    if (view) { setView(view.dataset.convView); api.persist(); return; }
    const item = event.target.closest('[data-conv-action]');
    if (item && !item.disabled && actions[item.dataset.convAction]) Promise.resolve().then(() => actions[item.dataset.convAction]()).catch(error => api.toast(error.message, true));
  });
  mount.querySelectorAll('[data-conv-option]').forEach(input => {
    const eventName = input.type === 'checkbox' || input.tagName === 'SELECT' ? 'change' : 'input';
    input.addEventListener(eventName, () => {
      if (state.batch) return;
      // Keep incomplete values such as the first digit of 16 or 50 editable.
      if (input.type === 'number' && (!input.value || !Number.isFinite(Number(input.value)) || Number(input.value) < Number(input.min) || Number(input.value) > Number(input.max))) return;
      const key = input.dataset.convOption, value = input.type === 'checkbox' ? input.checked : input.value;
      state.options = normalizeConversionOptions({ ...state.options, [key]: value });
      if (key === 'outputSize' || key === 'gridAlign') state.autoFit = true;
      syncOptions(); schedule(); api.persist();
    });
    if (input.type === 'number') input.addEventListener('blur', syncOptions);
  });
  $('format').addEventListener('change', () => { state.format = $('format').value === 'svg' ? 'svg' : 'png'; updateActions(); api.persist(); });
  new ResizeObserver(() => { render(); }).observe($('stage'));
  syncOptions(); setView(state.view); updateActions();
  return {
    activate() { state.active = true; if (!matchesSource() || !state.result) capture(); else if (state.resultEpoch !== state.epoch) schedule(true); else { updateActions(); render(); } },
    deactivate() { state.active = false; state.drag = null; clearPreviewJob(); cancelBatch(); },
    refresh() { if (!state.active || state.capturing || state.saving) return; if (!state.batch && !matchesSource()) capture(); else { updateActions(); render(); } },
    handleAction(name) { const action = name === 'toggle-grid' ? 'grid' : name; if (!actions[action]) return false; Promise.resolve().then(() => actions[action]()).catch(error => api.toast(error.message, true)); return true; },
    serialize() { return { options: { ...state.options }, view: state.view, format: state.format, grid: state.grid }; },
    restore(saved) {
      state.active = false; state.epoch++; clearPreviewJob(); cancelBatch(); state.batch = null;
      state.source = null; state.meta = null; state.result = null; state.resultCanvas = null; state.resultEpoch = -1; state.drag = null;
      saved = saved && typeof saved === 'object' ? saved : {};
      state.options = normalizeConversionOptions(saved.options || DEFAULT_CONVERSION_OPTIONS);
      state.format = saved.format === 'svg' ? 'svg' : 'png'; state.grid = !!saved.grid;
      button('grid').setAttribute('aria-pressed', String(state.grid));
      $('report').textContent = ''; $('message').hidden = true;
      syncOptions(); setView(saved.view); updateActions();
    },
  };
}
