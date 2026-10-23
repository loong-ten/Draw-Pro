import { icon } from './icons.js';
import { CANVAS_PRESETS, TILE_SIZES, validateTileCanvas, tilePlan } from './tile-canvas-core.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const countText = value => Number(value || 0).toLocaleString('zh-CN');
const coordinateText = value => Math.round(Number(value || 0) * 100) / 100;

/** Settings are a draft until the composer accepts them into its own history. */
export function createTileCanvasControls({ mount, getSettings, onApply, onAction, onTransform, notify }) {
  const section = document.createElement('section');
  section.className = 'tc-controls';
  section.setAttribute('aria-label', '瓦片画布设置');
  section.innerHTML = [
    '<header class="tc-heading"><div>' + icon('grid') + '<h3>画布与瓦片</h3></div><span>CANVAS</span></header>',
    '<div class="tc-section tc-transform-section"><div class="tc-subheading"><h4>素材操作</h4><span class="tc-transform-state">未选择素材</span></div>',
    '<div class="tc-transform-tools" role="group" aria-label="素材操作模式"><button type="button" data-tc-action="select-tool" aria-pressed="true">' + icon('move') + '移动素材 · V</button><button type="button" data-tc-action="rotate-tool" aria-pressed="false">' + icon('rotate') + '旋转素材 · R</button></div>',
    '<p class="tc-transform-selection">点击画布中的素材，或从场景图层中选择。</p>',
    '<div class="tc-transform-fields"><label><span>X · px</span><input data-tc-transform="x" type="number" step="any" aria-label="素材 X 坐标" disabled></label><label><span>Y · px</span><input data-tc-transform="y" type="number" step="any" aria-label="素材 Y 坐标" disabled></label><label><span>角度 · °</span><input data-tc-transform="rotation" type="number" step="any" aria-label="素材旋转角度" disabled></label></div>',
    '<div class="tc-rotate-actions" role="group" aria-label="素材旋转快捷操作"><button type="button" data-tc-action="rotate-left" title="逆时针旋转 90°" aria-label="逆时针旋转 90 度" disabled>−90°</button><button type="button" data-tc-action="rotate-right" title="顺时针旋转 90°" aria-label="顺时针旋转 90 度" disabled>+90°</button><button type="button" data-tc-action="rotate-reset" title="旋转角度归零" disabled>角度归零</button></div>',
    '<p class="tc-note tc-transform-help">直接拖动素材移动，Alt 临时自由移动；拖动圆环也可旋转。</p><p class="tc-transform-error" role="alert" hidden></p></div>',
    '<div class="tc-section"><div class="tc-subheading"><h4>画布尺寸</h4><span>px</span></div>',
    '<div class="tc-presets" aria-label="常用画布尺寸">',
    ...CANVAS_PRESETS.map(p => '<button type="button" class="tc-preset" data-tc-preset="' + esc(p.id) + '" title="' + esc(p.label + ' · ' + p.width + ' × ' + p.height) + '" aria-label="使用 ' + esc(p.label + '，' + p.width + ' × ' + p.height + ' 像素画布') + '" aria-pressed="false"><strong>' + esc(p.id === '2k' ? '2K' : p.label) + '</strong><small>' + p.width + '×' + p.height + '</small></button>'),
    '</div><div class="tc-size-fields"><label><span>宽度</span><input class="tc-width" type="number" min="1" max="8192" step="1" inputmode="numeric" aria-label="瓦片画布宽度"></label><label><span>高度</span><input class="tc-height" type="number" min="1" max="8192" step="1" inputmode="numeric" aria-label="瓦片画布高度"></label><button type="button" class="tc-swap" data-tc-action="swap-size" title="交换宽度与高度" aria-label="交换画布宽度与高度">' + icon('swap') + '</button></div>',
    '<button type="button" class="tc-apply" data-tc-action="apply-size">应用画布大小</button><p class="tc-note">调整画布边界，素材保持原有尺寸。</p>',
    '<div class="tc-content-actions"><button type="button" data-tc-action="center-canvas">' + icon('target') + '居中素材</button><button type="button" data-tc-action="fit-canvas-content">' + icon('fit') + '适配画布</button></div></div>',
    '<div class="tc-section"><div class="tc-subheading"><h4>瓦片分割</h4><span>每块像素大小</span></div>',
    '<div class="tc-tile-presets" aria-label="常用瓦片边长">',
    ...TILE_SIZES.map(size => '<button type="button" data-tc-tile-size="' + size + '" title="每块 ' + size + ' × ' + size + ' 像素" aria-label="使用 ' + size + ' × ' + size + ' 像素瓦片" aria-pressed="false">' + size + '</button>'),
    '</div><div class="tc-tile-fields"><label><span>块宽 · px</span><input class="tc-tile-width" type="number" min="1" max="8192" step="1" inputmode="numeric" aria-label="瓦片宽度，像素"></label><label><span>块高 · px</span><input class="tc-tile-height" type="number" min="1" max="8192" step="1" inputmode="numeric" aria-label="瓦片高度，像素"></label></div>',
    '<button type="button" class="tc-apply" data-tc-action="apply-tiles">应用分割大小</button>',
    '<div class="tc-grid-options"><label class="tc-check"><input type="checkbox" data-tc-setting="showGrid">网格线</label><label class="tc-check"><input type="checkbox" data-tc-setting="showNumbers">格号</label><label class="tc-check"><input type="checkbox" data-tc-setting="snapGrid">网格吸附</label></div>',
    '<label class="tc-select-label">放置与拖动锚点<select class="tc-anchor" data-tc-setting="anchor" aria-label="素材网格吸附锚点"><option value="tl">左上角</option><option value="bl">左下角</option><option value="center">中心</option></select></label>',
    '<label class="tc-select-label">不足一块的边缘<select class="tc-edge" data-tc-setting="edge" aria-label="瓦片边缘处理方式"><option value="pad">补透明，统一块尺寸</option><option value="keep">保留边缘实际尺寸</option></select></label>',
    '<label class="tc-check tc-skip"><input type="checkbox" data-tc-setting="skipEmpty">跳过全透明瓦片</label>',
    '<div class="tc-plan" aria-live="polite"><div><strong class="tc-plan-grid"></strong><span class="tc-plan-count"></span></div><p class="tc-plan-edge"></p></div>',
    '<p class="tc-error" role="alert" hidden></p></div>',
    '<div class="tc-section tc-measure-section"><div class="tc-subheading"><h4>选点与测量</h4><span>网格交点</span></div><div class="tc-measure-actions"><button type="button" data-tc-action="measure-grid" aria-pressed="false">' + icon('crosshair') + '<span class="tc-measure-button-label">开启选点</span></button><button type="button" data-tc-action="clear-measure" aria-label="清除选点与测量结果">清除</button></div>',
    '<div class="tc-measure-output" role="status"><div class="tc-measure-points" hidden><div><span class="tc-point-tag tc-point-one">P1</span><output class="tc-measure-p1"></output></div><div><span class="tc-point-tag tc-point-two">P2</span><output class="tc-measure-p2"></output></div></div><div class="tc-measure-summary" hidden><div><span>宽 × 高</span><strong class="tc-measure-size"></strong></div><div class="tc-measure-grid-row"><span>跨越网格</span><strong class="tc-measure-grid"></strong></div></div><p class="tc-measure-status"></p></div><p class="tc-note tc-measure-hint">可直接在图片区域选点，自动吸附最近网格交点。</p></div>',
    '<div class="tc-export"><button type="button" class="tc-export-png" data-tc-action="canvas-png">' + icon('image') + '导出整张 PNG</button><button type="button" class="tc-export-zip" data-tc-action="tile-export">' + icon('download') + '分割并导出 ZIP</button><p class="tc-note">独立 PNG 瓦片 + 坐标清单 layout.json</p></div>',
    '<div class="tc-progress" role="status" aria-live="polite" hidden><div class="tc-progress-heading"><strong>正在分割瓦片</strong><span class="tc-progress-numbers"></span></div><progress class="tc-progress-bar" max="1" value="0" aria-label="瓦片导出进度"></progress><div class="tc-progress-footer"><span class="tc-progress-detail"></span><button type="button" data-tc-action="tile-cancel">取消导出</button></div></div>',
  ].join('');
  const inspector = mount.querySelector('.cmp-inspector');
  if (!inspector) throw new Error('瓦片画布设置面板未能初始化。');
  inspector.prepend(section);

  const $ = selector => section.querySelector(selector);
  const $$ = selector => [...section.querySelectorAll(selector)];
  let canvasSignature = '', tileSignature = '', localError = '', plan = null;
  let progress = null, measurement = null, transform = null, transformError = '';
  const transformInputs = $$('[data-tc-transform]');
  const rotationActions = ['rotate-left', 'rotate-right', 'rotate-reset'];
  const isBusy = () => !!progress || !!transform?.busy;
  const canTransform = () => transform?.selectedCount === 1 && !!transform.layer && !transform.layer.locked && transform.layer.visible !== false;

  function showError(error) {
    localError = error?.message || String(error || '');
    renderError();
    if (localError) notify?.(localError, true);
  }
  function renderError() {
    const message = localError || plan?.error || '';
    $('.tc-error').textContent = message;
    $('.tc-error').hidden = !message;
  }
  function readNumber(selector, name) {
    const raw = $(selector).value.trim(), value = Number(raw);
    if (!raw || !Number.isFinite(value) || !Number.isInteger(value) || value < 1) throw new Error(name + '必须为大于 0 的整数。');
    return value;
  }
  function apply(patch, label) {
    if (isBusy()) return;
    const next = validateTileCanvas({ ...getSettings(), ...patch });
    localError = '';
    if ('width' in patch || 'height' in patch) canvasSignature = '';
    if ('tileWidth' in patch || 'tileHeight' in patch) tileSignature = '';
    onApply(next, label);
    refresh();
  }
  function applySize() {
    apply({ width: readNumber('.tc-width', '画布宽度'), height: readNumber('.tc-height', '画布高度') }, '调整瓦片画布尺寸');
  }
  function applyTiles() {
    apply({ tileWidth: readNumber('.tc-tile-width', '瓦片宽度'), tileHeight: readNumber('.tc-tile-height', '瓦片高度') }, '调整瓦片分割大小');
  }
  function renderPlan(settings) {
    plan = tilePlan(settings);
    $('.tc-plan-grid').textContent = countText(plan.columns) + ' 列 × ' + countText(plan.rows) + ' 行';
    $('.tc-plan-count').textContent = countText(plan.total) + ' 块';
    const tailX = plan.remainderWidth, tailY = plan.remainderHeight;
    let detail;
    if (!tailX && !tailY) detail = '完整分割，每块 ' + settings.tileWidth + ' × ' + settings.tileHeight + ' px。';
    else if (settings.edge === 'pad') {
      const parts = [];
      if (tailX) parts.push('右侧补 ' + (plan.paddedWidth - settings.width) + ' px');
      if (tailY) parts.push('底部补 ' + (plan.paddedHeight - settings.height) + ' px');
      detail = parts.join('，') + ' 透明像素。';
    } else {
      const parts = [];
      if (tailX) parts.push('末列宽 ' + tailX + ' px');
      if (tailY) parts.push('末行高 ' + tailY + ' px');
      detail = parts.join('，') + '，保留实际边缘。';
    }
    $('.tc-plan-edge').textContent = detail;
    $('.tc-plan').classList.toggle('tc-plan-over-limit', !plan.exportable);
    renderError();
  }
  function updateDisabled() {
    const busy = isBusy();
    for (const control of $$('input,select,button')) control.disabled = busy;
    $('[data-tc-action="tile-cancel"]').disabled = !progress;
    $('[data-tc-action="tile-export"]').disabled = busy || !plan?.exportable;
    $('[data-tc-action="clear-measure"]').disabled = busy || !measurement?.points?.length;
    for (const input of transformInputs) input.disabled = busy || !canTransform() || typeof onTransform !== 'function';
    for (const action of rotationActions) $('[data-tc-action="' + action + '"]').disabled = busy || !canTransform();
  }
  function renderTransform(forceInputs = false) {
    const count = transform?.selectedCount || 0, layer = count === 1 ? transform.layer : null, tool = transform?.tool || 'select';
    for (const [action, activeTool] of [['select-tool', 'select'], ['rotate-tool', 'rotate']]) {
      const control = $('[data-tc-action="' + action + '"]'), selected = tool === activeTool;
      control.setAttribute('aria-pressed', String(selected)); control.classList.toggle('tc-active', selected);
    }
    $('.tc-transform-state').textContent = layer?.locked ? '素材已锁定' : layer?.visible === false ? '素材已隐藏' : count ? countText(count) + ' 个素材' : '未选择素材';
    $('.tc-transform-selection').textContent = layer ? layer.name || '未命名素材' : count > 1 ? '已多选，可一起移动；选择单个素材以旋转或精确定位。' : '点击画布中的素材，或从场景图层中选择。';
    $('.tc-transform-selection').title = layer?.name || '';
    $('.tc-transform-help').textContent = layer?.locked ? '先在场景图层中解锁，再移动或旋转素材。' : layer?.visible === false ? '先显示当前图层，再移动或旋转素材。' : tool === 'rotate' ? '左右拖动素材旋转，Shift 按 15° 吸附；拖动圆环也可旋转。' : tool === 'measure' ? '当前为选点测量。点击“移动素材”或“旋转素材”继续编辑，测量结果会保留。' : tool === 'hand' ? '当前为平移画布。点击“移动素材”后可直接拖动素材。' : '直接拖动素材移动，Alt 临时自由移动；拖动圆环也可旋转。';
    for (const input of transformInputs) {
      if (forceInputs || document.activeElement !== input) input.value = layer && Number.isFinite(layer[input.dataset.tcTransform]) ? coordinateText(layer[input.dataset.tcTransform]) : '';
    }
    $('.tc-transform-error').textContent = transformError;
    $('.tc-transform-error').hidden = !transformError;
    updateDisabled();
  }
  async function applyTransform(input) {
    if (isBusy() || !canTransform() || typeof onTransform !== 'function') return;
    const key = input.dataset.tcTransform, raw = input.value.trim(), value = Number(raw), id = transform.layer.id;
    try {
      if (!raw || !Number.isFinite(value)) throw new Error((key === 'rotation' ? '角度' : key.toUpperCase() + ' 坐标') + '须为有效数字。');
      transformError = '';
      if (value !== transform.layer[key]) await onTransform({ [key]: value });
      if (transform?.layer?.id === id) input.value = coordinateText(transform.layer[key]);
      renderTransform();
    } catch (error) {
      transformError = error?.message || String(error);
      renderTransform(); notify?.(transformError, true);
    }
  }
  function renderMeasurement() {
    const active = !!measurement?.active, points = measurement?.points || [];
    const button = $('[data-tc-action="measure-grid"]');
    button.setAttribute('aria-pressed', String(active));
    button.classList.toggle('tc-active', active);
    $('.tc-measure-button-label').textContent = active ? '退出选点' : '开启选点';
    $('.tc-measure-points').hidden = !points.length;
    $('.tc-measure-summary').hidden = points.length < 2;
    for (const [index, selector] of ['.tc-measure-p1', '.tc-measure-p2'].entries()) {
      const point = points[index];
      $(selector).textContent = point ? '(' + coordinateText(point.x) + ', ' + coordinateText(point.y) + ') px' : '尚未选取';
      $(selector).classList.toggle('tc-point-empty', !point);
    }
    let text = active ? '点击选取 P1，再点击选取 P2。' : '开启选点，查看两点坐标与区域尺寸。';
    if (points.length === 1) text = active ? 'P1 已确定，请点击选取 P2。' : '选点已关闭，P1 坐标已保留。';
    if (points.length >= 2) {
      const w = measurement.width ?? Math.abs(points[1].x - points[0].x), h = measurement.height ?? Math.abs(points[1].y - points[0].y);
      $('.tc-measure-size').textContent = coordinateText(w) + ' × ' + coordinateText(h) + ' px';
      const hasGridSize = Number.isFinite(measurement.columns) && Number.isFinite(measurement.rows);
      $('.tc-measure-grid-row').hidden = !hasGridSize;
      $('.tc-measure-grid').textContent = hasGridSize ? countText(measurement.columns) + ' 列 × ' + countText(measurement.rows) + ' 行' : '';
      text = active ? '再次点击从 P1 重新开始。' : '选点已关闭，测量结果已保留。';
    }
    $('.tc-measure-status').textContent = text;
    updateDisabled();
  }
  function refresh() {
    const settings = validateTileCanvas(getSettings());
    const nextCanvasSignature = settings.width + ':' + settings.height;
    if (nextCanvasSignature !== canvasSignature) {
      $('.tc-width').value = settings.width; $('.tc-height').value = settings.height; canvasSignature = nextCanvasSignature;
    }
    const nextTileSignature = settings.tileWidth + ':' + settings.tileHeight;
    if (nextTileSignature !== tileSignature) {
      $('.tc-tile-width').value = settings.tileWidth; $('.tc-tile-height').value = settings.tileHeight; tileSignature = nextTileSignature;
    }
    for (const button of $$('[data-tc-preset]')) {
      const preset = CANVAS_PRESETS.find(item => item.id === button.dataset.tcPreset);
      const selected = preset?.width === settings.width && preset?.height === settings.height;
      button.classList.toggle('tc-active', selected); button.setAttribute('aria-pressed', String(selected));
    }
    for (const button of $$('[data-tc-tile-size]')) {
      const selected = settings.tileWidth === Number(button.dataset.tcTileSize) && settings.tileHeight === Number(button.dataset.tcTileSize);
      button.classList.toggle('tc-active', selected); button.setAttribute('aria-pressed', String(selected));
    }
    for (const input of $$('[data-tc-setting]')) {
      const value = settings[input.dataset.tcSetting];
      if (input.type === 'checkbox') input.checked = !!value;
      else input.value = value;
    }
    renderPlan(settings); renderMeasurement(); renderTransform();
  }
  section.addEventListener('click', async event => {
    try {
      const presetButton = event.target.closest('[data-tc-preset]');
      if (presetButton) {
        if (isBusy()) return;
        const preset = CANVAS_PRESETS.find(item => item.id === presetButton.dataset.tcPreset);
        if (preset) apply({ width: preset.width, height: preset.height }, '使用 ' + preset.label + ' 画布');
        return;
      }
      const sizeButton = event.target.closest('[data-tc-tile-size]');
      if (sizeButton) {
        if (isBusy()) return;
        const size = Number(sizeButton.dataset.tcTileSize);
        apply({ tileWidth: size, tileHeight: size }, '使用 ' + size + ' 像素瓦片'); return;
      }
      const control = event.target.closest('[data-tc-action]'), action = control?.dataset.tcAction;
      if (!action || control.disabled || (isBusy() && action !== 'tile-cancel')) return;
      if (action === 'apply-size') applySize();
      else if (action === 'apply-tiles') applyTiles();
      else if (action === 'swap-size') {
        const width = readNumber('.tc-width', '画布宽度'), height = readNumber('.tc-height', '画布高度');
        apply({ width: height, height: width }, '交换瓦片画布宽高');
      } else {
        localError = ''; renderError();
        if (rotationActions.includes(action) || action === 'select-tool' || action === 'rotate-tool') transformError = '';
        await onAction(action);
      }
    } catch (error) { showError(error); }
  });
  for (const input of $$('[data-tc-setting]')) input.addEventListener('change', () => {
    try {
      const key = input.dataset.tcSetting, labels = { showGrid: '网格显示', showNumbers: '格号显示', snapGrid: '网格吸附', anchor: '网格锚点', edge: '瓦片边缘处理', skipEmpty: '跳过透明瓦片' };
      apply({ [key]: input.type === 'checkbox' ? input.checked : input.value }, labels[key]);
    } catch (error) { showError(error); refresh(); }
  });
  for (const selector of ['.tc-width', '.tc-height', '.tc-tile-width', '.tc-tile-height']) $(selector).addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    event.preventDefault(); event.stopPropagation();
    try { selector.includes('tile-') ? applyTiles() : applySize(); } catch (error) { showError(error); }
  });
  for (const input of transformInputs) {
    input.addEventListener('change', () => applyTransform(input));
    input.addEventListener('keydown', event => {
      if (event.key !== 'Enter') return;
      event.preventDefault(); event.stopPropagation(); return applyTransform(input);
    });
    input.addEventListener('blur', () => { if (!transformError) renderTransform(true); });
  }
  refresh();
  return {
    refresh,
    setTransform(value) {
      const previousId = transform?.layer?.id, nextId = value?.layer?.id;
      transform = value == null ? null : { ...value, layer: value.layer ? { ...value.layer } : null };
      if (previousId !== nextId) transformError = '';
      renderTransform(previousId !== nextId);
    },
    setProgress(value) {
      progress = value == null ? null : { ...value };
      $('.tc-progress').hidden = !progress;
      if (progress) {
        const total = Math.max(0, Number(progress.total) || 0), completed = Math.min(total, Math.max(0, Number(progress.completed) || 0));
        $('.tc-progress-numbers').textContent = countText(completed) + ' / ' + countText(total);
        $('.tc-progress-bar').max = Math.max(1, total); $('.tc-progress-bar').value = completed;
        $('.tc-progress-detail').textContent = '已生成 ' + countText(progress.count) + ' 块' + (progress.skipped ? ' · 跳过 ' + countText(progress.skipped) : '');
      }
      updateDisabled();
    },
    setMeasurement(value) {
      measurement = value == null ? null : { ...value, points: (value.points || []).map(point => ({ ...point })) };
      renderMeasurement();
    },
  };
}
