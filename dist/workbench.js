import { createComposer } from './composer.js';
import { createOptimizer } from './optimizer.js';
import { createInspections } from './inspections.js';

/** One workspace, one document collection. Mode modules never own a second app. */
export function installWorkbench(api) {
  const $ = s => document.querySelector(s);
  const state = api.getState();
  let preview = null;
  let switching = false;
  let modeToken = 0;
  let inspector = 'layers';
  let composer, optimizer, inspections;
  const setPreview = canvas => {
    const d = api.getDoc();
    preview = canvas ? { canvas, docId: d.id, layerId: d.activeLayerId, revision: d.revision } : null;
    api.requestRender();
  };
  const bridge = { ...api, setPreview, setMode };
  inspections = createInspections(bridge, $('#retouch-panel'));
  composer = createComposer(bridge, $('#composer-host'));
  optimizer = createOptimizer(bridge, $('#optimizer-host'));

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
    if (!['paint', 'retouch', 'compose', 'optimize'].includes(name)) return;
    if (name === state.mode && !force) return;
    const token = ++modeToken;
    api.finishPending();
    inspections.deactivate();
    composer.deactivate();
    optimizer.deactivate();
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
    $('#optimizer-host').hidden = name !== 'optimize';
    $('.inspector-panel').hidden = !painting;
    $('#mode-description').textContent = {
      paint: '分层绘画 · 多图工作区', retouch: '色彩调整 · 像素检查',
      compose: '无限画布 · 无损拼接', optimize: '网格采样 · 对比优化'
    }[name];
    setInspector(name === 'retouch' ? 'adjust' : name === 'paint' ? 'layers' : inspector);
    switching = true;
    try {
      if (name === 'compose') await composer.activate();
      else if (name === 'optimize') await optimizer.activate();
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
    if (!switching && state.mode === 'compose') {
      composer.refresh();
      const h=composer.getHistoryState?.();
      if(h){document.querySelectorAll('[data-action=undo]').forEach(b=>b.disabled=!h.canUndo);document.querySelectorAll('[data-action=redo]').forEach(b=>b.disabled=!h.canRedo)}
    }
    if (!switching && state.mode === 'optimize') optimizer.refresh();
  }

  function handleAction(name) {
    if ((state.mode === 'compose' || state.mode === 'optimize') && name === 'save') return api.action('save-project').then(() => true);
    if (state.mode === 'compose' && ['undo','redo','fit','actual','zoom-in','zoom-out','export','flip-h','flip-v','select-all','delete'].includes(name)) return Promise.resolve(composer.handleAction(name)).then(() => true);
    if (state.mode === 'optimize' && ['fit','actual','zoom-in','zoom-out','export'].includes(name)) return Promise.resolve(optimizer.handleAction?.(name) ?? (name === 'export' ? optimizer.exportResult?.() : undefined)).then(() => true);
    if (name === 'show-adjust') { setMode('retouch'); return true; }
    if (name === 'show-history') { if(!['paint','retouch'].includes(state.mode)) setMode('retouch').then(()=>setInspector('history')); else setInspector('history'); return true; }
    if (name === 'show-pixel') { if(!['paint','retouch'].includes(state.mode)) setMode('retouch').then(()=>setInspector('pixel')); else setInspector('pixel'); return true; }
    return false;
  }

  // Restoring a composition validates and decodes all its assets before swapping.
  async function restore(saved = {}) {
    inspections.deactivate(); preview = null;
    await composer.restore(saved.composer || null);
    await optimizer.restore(saved.optimizer || null);
  }
  document.body.dataset.mode = state.mode;
  setInspector('layers');
  return {
    composer, optimizer, inspections, setMode, setInspector, refresh, restore, handleAction,
    getPreview: () => preview,
    deactivate: () => { inspections.deactivate(); preview = null; },
    refreshView: () => inspections.refreshView(),
    inspect: point => inspections.inspect(point),
    serialize: () => ({ version: 1, mode: state.mode, composer: composer.serialize(), optimizer: optimizer.serialize() }),
  };
}
