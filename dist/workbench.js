import { createComposer } from './composer.js';
import { createOptimizer } from './optimizer.js';
import { createInspections } from './inspections.js';
import { createPadding } from './padding.js';
import { createConverter } from './converter.js';

/** One workspace, one document collection. Mode modules never own a second app. */
export function installWorkbench(api) {
  const $ = s => document.querySelector(s);
  const state = api.getState();
  let preview = null;
  let switching = false;
  let modeToken = 0;
  let inspector = 'layers';
  let composer, tileCanvas, optimizer, inspections, padding, converter;
  const setPreview = canvas => {
    const d = api.getDoc();
    preview = canvas ? { canvas, docId: d.id, layerId: d.activeLayerId, revision: d.revision } : null;
    api.requestRender();
  };
  const bridge = { ...api, setPreview, setMode };
  inspections = createInspections(bridge, $('#retouch-panel'));
  composer = createComposer(bridge, $('#composer-host'));
  tileCanvas = createComposer(bridge, $('#tile-canvas-host'), { canvasMode: true });
  optimizer = createOptimizer(bridge, $('#optimizer-host'));
  padding = createPadding(bridge, $('#padding-host'));
  converter = createConverter(bridge, $('#converter-host'));

  function setInspector(name) {
    inspector = name;
    document.querySelectorAll('[data-inspector]').forEach(button => button.classList.toggle('active', button.dataset.inspector === name));
    $('#guides-panel').hidden = name !== 'guides';
    $('#layers-panel').hidden = name !== 'layers';
    $('#retouch-panel').hidden = !['adjust', 'history', 'pixel'].includes(name);
    $('.inspector-panel').classList.remove('focus-layers');
    if (!['adjust', 'history', 'pixel'].includes(name)) { inspections.deactivate(); preview = null; }
    if (['adjust', 'history', 'pixel'].includes(name)) {
      inspections.activate(name);
      inspections.showSection(name);
    }
  }

  async function setMode(name, force = false) {
    if (!['convert', 'paint', 'retouch', 'compose', 'tile', 'optimize', 'padding'].includes(name)) return;
    if (padding?.isBusy()) { api.toast('透明扩边正在处理，请等待完成；批处理可在扩边面板中停止。'); return; }
    if (tileCanvas?.isBusy?.()) { api.toast('瓦片正在导出，请等待完成，或在瓦片面板中取消。'); return; }
    if (name === state.mode && !force) return;
    const token = ++modeToken;
    api.finishPending();
    inspections.deactivate();
    composer.deactivate();
    tileCanvas.deactivate();
    optimizer.deactivate();
    padding.deactivate();
    converter.deactivate();
    preview = null;
    state.mode = name;
    document.body.dataset.mode = name;
    document.querySelectorAll('[data-mode-switch]').forEach(button => {
      const selected = button.dataset.modeSwitch === name;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-selected', String(selected));
    });
    const painting = name === 'paint' || name === 'retouch';
    $('#paint-host').hidden = !painting;
    $('#composer-host').hidden = name !== 'compose';
    $('#tile-canvas-host').hidden = name !== 'tile';
    $('#optimizer-host').hidden = name !== 'optimize';
    $('#padding-host').hidden = name !== 'padding';
    $('#converter-host').hidden = name !== 'convert';
    $('.inspector-panel').hidden = !painting;
    $('#mode-description').textContent = {
      convert: '图片像素化 · 实时对比', paint: '分层绘画 · 多图工作区', retouch: '色彩调整 · 像素检查',
      compose: '无限画布 · 无损拼接', tile: '固定画布 · 网格布局 · 瓦片分割', optimize: '网格采样 · 对比优化',
      padding: '透明画布 · 自动居中'
    }[name];
    setInspector(name === 'retouch' ? 'adjust' : name === 'paint' ? 'layers' : inspector);
    switching = true;
    try {
      if (name === 'convert') await converter.activate();
      else if (name === 'compose') await composer.activate();
      else if (name === 'tile') await tileCanvas.activate();
      else if (name === 'optimize') await optimizer.activate();
      else if (name === 'padding') await padding.activate();
      else {
        inspections.activate(name === 'retouch' ? 'adjust' : inspector);
        api.requestRender();
      }
    } catch (error) { api.toast(error.message || '此工作模式暂时未能打开。', true); }
    finally { if (token === modeToken) switching = false; }
    if (token !== modeToken) return;
    api.refresh();
    api.persist();
  }

  document.querySelectorAll('[data-mode-switch]').forEach(button => button.addEventListener('click', () => setMode(button.dataset.modeSwitch)));
  document.querySelectorAll('[data-inspector]').forEach(button => button.addEventListener('click', () => setInspector(button.dataset.inspector)));
  $('#pixel-display').addEventListener('change', event => {
    state.pixelDisplay = event.target.checked;
    api.requestRender(); api.persist();
  });
  $('#grid-size').addEventListener('change', event => {
    state.gridSize = Math.max(1, Math.min(1024, Math.round(Number(event.target.value) || 1)));
    state.showGrid = true;
    api.requestRender(); api.persist();
  });
  $('#layer-blend').addEventListener('change', event => {
    api.finishPending(); inspections.deactivate();
    const d = api.getDoc();
    if (d.activeLayer.locked) { api.toast('请先解锁当前图层。', true); api.refresh(); return; }
    d.setLayer(d.activeLayerId, { blend: event.target.value });
    api.commit('图层混合模式');
  });
  $('#workspace-title').addEventListener('click', async () => {
    const form = await api.ask('工作区名称', '<div class="form-row"><label>项目名称</label><input name="name" maxlength="100" required placeholder="输入项目名称"></div>', { submit: '保存名称' });
    if (form?.name?.trim()) { state.workspaceName = form.name.trim(); api.refresh(); api.persist(); }
  });

  function refresh() {
    const d = api.getDoc();
    if (!d) return;
    $('#workspace-title').textContent = state.workspaceName;
    $('#layer-blend').value = d.activeLayer.blend || 'source-over';
    $('#pixel-display').checked = state.pixelDisplay !== false;
    $('#grid-size').value = state.gridSize || 1;
    if (['paint','retouch'].includes(state.mode) && ['adjust','history','pixel'].includes(inspector)) inspections.activate();
    else inspections.refresh();
    if (!switching && ['compose', 'tile'].includes(state.mode)) {
      const scene = state.mode === 'tile' ? tileCanvas : composer;
      scene.refresh();
      const h = scene.getHistoryState?.(), blocked = scene.isBusy?.();
      if(h){document.querySelectorAll('[data-action=undo]').forEach(b=>b.disabled=!!blocked||!h.canUndo);document.querySelectorAll('[data-action=redo]').forEach(b=>b.disabled=!!blocked||!h.canRedo)}
    }
    if (!switching && state.mode === 'optimize') optimizer.refresh();
    if (!switching && state.mode === 'padding') padding.refresh();
    if (!switching && state.mode === 'convert') converter.refresh();
  }

  function handleAction(name) {
    if (padding.isBusy()) { api.toast('透明扩边正在处理，请等待完成；批处理可在扩边面板中停止。'); return true; }
    if (tileCanvas.isBusy?.() && !['save', 'save-project'].includes(name)) { api.toast('瓦片正在导出，请等待完成，或在瓦片面板中取消。'); return true; }
    if (['convert', 'compose', 'tile', 'optimize', 'padding'].includes(state.mode) && name === 'save') return api.action('save-project').then(() => true);
    if (['compose', 'tile'].includes(state.mode) && ['undo','redo','fit','actual','zoom-in','zoom-out','export','flip-h','flip-v','select-all','delete','deselect'].includes(name)) return Promise.resolve((state.mode === 'tile' ? tileCanvas : composer).handleAction(name)).then(() => true);
    if (state.mode === 'convert' && ['fit','actual','zoom-in','zoom-out','export','toggle-grid'].includes(name)) return Promise.resolve(converter.handleAction(name)).then(() => true);
    if (name === 'show-converter') { setMode('convert'); return true; }
    if (state.mode === 'optimize' && ['fit','actual','zoom-in','zoom-out','export'].includes(name)) return Promise.resolve(optimizer.handleAction?.(name) ?? (name === 'export' ? optimizer.exportResult?.() : undefined)).then(() => true);
    if (state.mode === 'padding' && ['fit','actual','zoom-in','zoom-out','export'].includes(name)) return Promise.resolve(padding.handleAction(name)).then(() => true);
    if (name === 'show-padding') { setMode('padding'); return true; }
    if (name === 'show-tile') { setMode('tile'); return true; }
    if (name === 'show-adjust') { setMode('retouch'); return true; }
    if (name === 'show-history') { if(!['paint','retouch'].includes(state.mode)) setMode('retouch').then(()=>setInspector('history')); else setInspector('history'); return true; }
    if (name === 'show-pixel') { if(!['paint','retouch'].includes(state.mode)) setMode('retouch').then(()=>setInspector('pixel')); else setInspector('pixel'); return true; }
    return false;
  }

  // Restoring a composition validates and decodes all its assets before swapping.
  async function restore(saved = {}) {
    const converterSettings = converter.serialize();
    converter.deactivate();
    inspections.deactivate(); preview = null;
    try {
      await composer.restore(saved.composer || null);
      await tileCanvas.restore(saved.tileCanvas || null);
      await optimizer.restore(saved.optimizer || null);
      await padding.restore(saved.padding || null);
      converter.restore(saved.converter || null);
    } catch (error) {
      converter.restore(converterSettings);
      if (state.mode === 'convert') converter.activate();
      throw error;
    }
  }
  document.body.dataset.mode = state.mode;
  setInspector('layers');
  return {
    composer, tileCanvas, optimizer, inspections, padding, converter, setMode, setInspector, refresh, restore, handleAction,
    getPreview: () => preview,
    deactivate: () => { inspections.deactivate(); preview = null; },
    refreshView: () => inspections.refreshView(),
    inspect: point => inspections.inspect(point),
    serialize: () => ({ version: 1, mode: state.mode, composer: composer.serialize(), tileCanvas: tileCanvas.serialize(), optimizer: optimizer.serialize(), padding: padding.serialize(), converter: converter.serialize() }),
  };
}
