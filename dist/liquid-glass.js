/** Appearance is a browser preference, independent of artwork and project data. */
export const LIQUID_APPEARANCE_KEY = 'paint-workspace.liquid-appearance.v1';
const THEMES = ['system', 'light', 'dark'];
const THEME_NAMES = { system: '跟随系统', light: '浅色', dark: '深色' };
const MEDIA = {
  dark: '(prefers-color-scheme: dark)',
  motion: '(prefers-reduced-motion: reduce)',
  transparency: '(prefers-reduced-transparency: reduce)',
  contrast: '(prefers-contrast: more)',
  forcedColors: '(forced-colors: active)',
  finePointer: '(hover: hover) and (pointer: fine)',
};
const CHROME = '.topbar,.modebar,.menubar,.ribbon,.optionsbar,#lg-appearance-panel';
const SCROLL_SURFACES = '#asset-list,.assets-panel,.inspector-panel,#retouch-panel,#guides-panel,.fine-history-list,.cmp-inspector,.cmp-source-panel,.cmp-layer-list,.cmp-slot-list,.opt-settings,.pad-settings,.conv-settings,.slice-settings,.mode-host,.conv-root,.slice-root,.pad-root,[data-lg-scroll]';
const installations = new WeakMap();
const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

export function readLiquidAppearance(storage) {
  try {
    const saved = JSON.parse(storage?.getItem(LIQUID_APPEARANCE_KEY) || 'null');
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      return { theme: THEMES.includes(saved.theme) ? saved.theme : 'system', simpleEffects: saved.simpleEffects === true };
    }
  } catch { /* An unavailable preference store must not block the workbench. */ }
  return { theme: 'system', simpleEffects: false };
}

export function resolveLiquidAppearance(preference, environment = {}) {
  const theme = THEMES.includes(preference?.theme) ? preference.theme : 'system';
  const simple = preference?.simpleEffects === true;
  const contrast = !!(environment.contrast || environment.forcedColors);
  return {
    preference: theme,
    theme: theme === 'system' ? environment.dark ? 'dark' : 'light' : theme,
    material: simple || environment.transparency || contrast ? 'solid' : 'glass',
    motion: simple || environment.motion ? 'reduced' : 'full',
    contrast: contrast ? 'more' : 'normal',
    quality: simple || environment.lowPower || environment.adaptiveLite ? 'lite' : 'full',
  };
}

/** One optional controller per window; no app document, canvas or history access. */
export function installLiquidGlass(win = window) {
  if (installations.has(win)) return installations.get(win);
  const doc = win.document, root = doc.documentElement;
  const toggle = doc.querySelector('#lg-appearance-toggle');
  const panel = doc.querySelector('#lg-appearance-panel');
  const simpleInput = doc.querySelector('#lg-simple-effects');
  const status = doc.querySelector('#lg-appearance-status');
  const choices = [...doc.querySelectorAll('[data-lg-theme-choice]')];
  const cleanups = [];
  let storage;
  try { storage = win.localStorage; } catch { /* Storage can be denied at the property getter. */ }
  let preference = readLiquidAppearance(storage), appearance;
  let adaptiveLite = false, keyboardNavigation = false, storageAvailable = true;
  let highlightFrame = null, activeSurface = null, pendingPoint = null;
  let probeFrame = null, probeStart = 0, probePrevious = 0, lastInteraction = 0;
  let frameCount = 0, slowCount = 0, slowWindows = 0;
  let scrollTracks = new WeakMap();
  const now = () => win.performance?.now?.() ?? Date.now();
  const requestFrame = callback => win.requestAnimationFrame(callback);
  const cancelFrame = id => { if (id !== null) win.cancelAnimationFrame(id); };
  const media = Object.fromEntries(Object.entries(MEDIA).map(([name, query]) => {
    let matcher;
    try { matcher = win.matchMedia(query); } catch { matcher = { matches: false }; }
    return [name, matcher];
  }));
  const on = (target, name, handler, options) => {
    if (!target?.addEventListener) return;
    target.addEventListener(name, handler, options);
    cleanups.push(() => target.removeEventListener(name, handler, options));
  };
  function environment() {
    const navigator = win.navigator || {};
    const cores = navigator.hardwareConcurrency;
    return {
      ...Object.fromEntries(Object.entries(media).map(([name, matcher]) => [name, matcher.matches])),
      lowPower: navigator.connection?.saveData === true || Number.isFinite(cores) && cores > 0 && cores <= 4,
      adaptiveLite,
    };
  }
  function clearSurface(surface) {
    if (!surface) return;
    for (const property of ['--lg-light-x', '--lg-light-y', '--lg-light-angle']) surface.style.removeProperty(property);
  }
  function clearHighlight() {
    cancelFrame(highlightFrame); highlightFrame = null; pendingPoint = null;
    clearSurface(activeSurface); activeSurface = null;
  }
  function stopProbe() {
    cancelFrame(probeFrame); probeFrame = null; probePrevious = 0;
  }
  function expandChrome() {
    root.dataset.lgChrome = 'expanded';
    scrollTracks = new WeakMap();
  }
  function updateControls() {
    for (const choice of choices) {
      const selected = choice.dataset.lgThemeChoice === preference.theme;
      choice.setAttribute('aria-checked', String(selected));
      choice.tabIndex = selected ? 0 : -1;
    }
    if (simpleInput) simpleInput.checked = preference.simpleEffects;
    if (toggle) {
      const current = preference.theme === 'system' ? `跟随系统 · ${THEME_NAMES[appearance.theme]}` : THEME_NAMES[appearance.theme];
      toggle.setAttribute('aria-label', `外观设置，当前${current}`);
      toggle.title = `外观 · ${current}`;
    }
    if (status) {
      const current = preference.theme === 'system' ? `跟随系统 · 当前${THEME_NAMES[appearance.theme]}` : `${THEME_NAMES[appearance.theme]}外观`;
      const material = appearance.contrast === 'more' ? '增强对比度' : appearance.material === 'solid' ? '简约实色表面' : appearance.quality === 'lite' ? '轻量玻璃效果' : '通透玻璃效果';
      const motion = appearance.motion === 'reduced' ? ' · 减少动态' : '';
      status.textContent = `${current} · ${material}${motion}${storageAvailable ? '' : ' · 仅本次会话'}`;
    }
  }
  function apply() {
    appearance = resolveLiquidAppearance(preference, environment());
    root.dataset.lgTheme = appearance.theme;
    root.dataset.lgPreference = appearance.preference;
    root.dataset.lgMaterial = appearance.material;
    root.dataset.lgMotion = appearance.motion;
    root.dataset.lgContrast = appearance.contrast;
    root.dataset.lgQuality = appearance.quality;
    if (!root.dataset.lgChrome || appearance.motion === 'reduced') expandChrome();
    const meta = doc.querySelector('meta[name="theme-color"]');
    meta?.setAttribute('content', appearance.theme === 'dark' ? '#101722' : '#edf2f8');
    if (appearance.motion === 'reduced' || appearance.material === 'solid' || appearance.quality === 'lite' || !media.finePointer.matches) clearHighlight();
    if (appearance.motion === 'reduced' || appearance.material === 'solid' || appearance.quality === 'lite') stopProbe();
    updateControls();
  }
  function savePreference() {
    try {
      if (!storage) throw new Error('Storage unavailable');
      storage.setItem(LIQUID_APPEARANCE_KEY, JSON.stringify(preference));
      storageAvailable = true;
    } catch { storageAvailable = false; }
  }
  function setPreference(theme) {
    if (!THEMES.includes(theme)) return;
    preference = { ...preference, theme };
    savePreference(); apply();
  }
  function setSimpleEffects(enabled) {
    preference = { ...preference, simpleEffects: enabled === true };
    savePreference(); apply();
  }
  function closePanel(returnFocus = false) {
    if (!panel || panel.hidden) return;
    panel.hidden = true; toggle?.setAttribute('aria-expanded', 'false');
    clearHighlight();
    if (returnFocus) toggle?.focus({ preventScroll: true });
  }
  function openPanel() {
    if (!panel || !toggle) return;
    panel.hidden = false; toggle.setAttribute('aria-expanded', 'true'); expandChrome();
    (choices.find(choice => choice.dataset.lgThemeChoice === preference.theme) || choices[0] || simpleInput)?.focus({ preventScroll: true });
  }
  const isAppearanceTarget = target => !!(target && (target === toggle || toggle?.contains(target) || panel?.contains(target)));
  const isChromeTarget = target => !!target?.closest?.(CHROME);
  on(toggle, 'click', () => panel?.hidden ? openPanel() : closePanel(true));
  for (const choice of choices) on(choice, 'click', () => setPreference(choice.dataset.lgThemeChoice));
  on(simpleInput, 'change', () => setSimpleEffects(simpleInput.checked));
  on(doc, 'click', event => { if (panel && !panel.hidden && !isAppearanceTarget(event.target)) closePanel(); });
  on(doc, 'focusin', event => {
    if (isChromeTarget(event.target)) expandChrome();
    if (panel && !panel.hidden && !isAppearanceTarget(event.target)) closePanel();
  });
  // Capture before Paint's global hotkeys. Native Space/Enter activation is kept.
  on(win, 'keydown', event => {
    keyboardNavigation = true;
    const related = isAppearanceTarget(event.target);
    if (event.key === 'Escape' && panel && !panel.hidden) {
      event.preventDefault(); event.stopImmediatePropagation(); closePanel(true); return;
    }
    if (!related) return;
    event.stopImmediatePropagation();
    if (isChromeTarget(event.target)) expandChrome();
    const choice = event.target?.closest?.('[data-lg-theme-choice]');
    if (!choice || !['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(event.key)) return;
    event.preventDefault();
    const index = choices.indexOf(choice);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1 : (index + (['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1) + choices.length) % choices.length;
    const target = choices[next];
    if (target) { setPreference(target.dataset.lgThemeChoice); target.focus({ preventScroll: true }); }
  }, true);
  on(win, 'pointerdown', event => {
    keyboardNavigation = false; clearHighlight();
    if (panel && !panel.hidden && !isAppearanceTarget(event.target)) closePanel();
  }, { passive: true, capture: true });

  function canHighlight() {
    return !doc.hidden && media.finePointer.matches && appearance.motion === 'full' && appearance.material === 'glass' && appearance.quality === 'full';
  }
  function drawHighlight() {
    highlightFrame = null;
    const point = pendingPoint; pendingPoint = null;
    if (!point || !canHighlight() || point.surface.isConnected === false) { clearHighlight(); return; }
    if (activeSurface !== point.surface) { clearSurface(activeSurface); activeSurface = point.surface; }
    const rect = activeSurface.getBoundingClientRect();
    if (!rect.width || !rect.height) { clearHighlight(); return; }
    const x = clamp((point.x - rect.left) / rect.width * 100, 0, 100), y = clamp((point.y - rect.top) / rect.height * 100, 0, 100);
    const angle = Math.atan2(y - 50, x - 50) * 180 / Math.PI + 90;
    activeSurface.style.setProperty('--lg-light-x', `${x.toFixed(2)}%`);
    activeSurface.style.setProperty('--lg-light-y', `${y.toFixed(2)}%`);
    activeSurface.style.setProperty('--lg-light-angle', `${angle.toFixed(1)}deg`);
  }
  function finishProbeWindow() {
    if (frameCount >= 12) {
      slowWindows = slowCount / frameCount >= .5 ? slowWindows + 1 : 0;
      if (slowWindows >= 2) { adaptiveLite = true; apply(); }
    }
  }
  function sampleFrame(time) {
    probeFrame = null;
    if (doc.hidden || appearance.material === 'solid' || appearance.motion === 'reduced' || appearance.quality === 'lite') { probePrevious = 0; return; }
    if (probePrevious) {
      const elapsed = time - probePrevious;
      // A large one-off stall is not evidence that glass itself is too expensive.
      if (elapsed > 0 && elapsed < 160) { frameCount++; if (elapsed > 32) slowCount++; }
    }
    probePrevious = time;
    const active = time - lastInteraction <= 220;
    if (!active || time - probeStart >= 1200) { finishProbeWindow(); probePrevious = 0; return; }
    probeFrame = requestFrame(sampleFrame);
  }
  function sampleInteraction() {
    if (doc.hidden || appearance.material !== 'glass' || appearance.motion !== 'full' || appearance.quality !== 'full') return;
    lastInteraction = now();
    if (probeFrame !== null) return;
    probeStart = lastInteraction; probePrevious = 0; frameCount = slowCount = 0;
    probeFrame = requestFrame(sampleFrame);
  }
  on(doc, 'pointermove', event => {
    if (!canHighlight() || event.buttons || event.target?.closest?.('canvas')) { clearHighlight(); return; }
    const surface = event.target?.closest?.('[data-lg-light]');
    if (!surface || surface.hidden || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) { clearHighlight(); return; }
    pendingPoint = { surface, x: event.clientX, y: event.clientY };
    if (highlightFrame === null) highlightFrame = requestFrame(drawHighlight);
    sampleInteraction();
  }, { passive: true });
  on(doc, 'pointerout', event => {
    if (!activeSurface && !pendingPoint) return;
    const surface = pendingPoint?.surface || activeSurface;
    if (!event.relatedTarget || !surface?.contains(event.relatedTarget)) clearHighlight();
  }, { passive: true });
  on(doc, 'scroll', event => {
    const target = event.target;
    if (!target?.matches?.(SCROLL_SURFACES) || target.scrollHeight <= target.clientHeight + 1) return;
    const top = Math.max(0, target.scrollTop), previous = scrollTracks.get(target) || { top: 0, direction: 0, distance: 0 };
    const delta = top - previous.top;
    previous.top = top; scrollTracks.set(target, previous);
    if (Math.abs(delta) < 2) return; // Horizontal scrolling and layout jitter do not compact chrome.
    sampleInteraction();
    if (appearance.motion === 'reduced' || panel && !panel.hidden || keyboardNavigation && isChromeTarget(doc.activeElement)) { expandChrome(); return; }
    if (top < 8) { expandChrome(); return; }
    const direction = Math.sign(delta);
    previous.distance = direction === previous.direction ? previous.distance + Math.abs(delta) : Math.abs(delta);
    previous.direction = direction;
    if (direction > 0 && previous.distance >= 36) { root.dataset.lgChrome = 'compact'; previous.distance = 0; }
    else if (direction < 0 && previous.distance >= 20) { root.dataset.lgChrome = 'expanded'; previous.distance = 0; }
  }, { passive: true, capture: true });

  for (const matcher of Object.values(media)) {
    if (matcher.addEventListener) on(matcher, 'change', apply);
    else if (matcher.addListener) { matcher.addListener(apply); cleanups.push(() => matcher.removeListener(apply)); }
  }
  on(win.navigator?.connection, 'change', apply);
  on(win, 'storage', event => {
    if (event.key !== LIQUID_APPEARANCE_KEY && event.key !== null) return;
    preference = readLiquidAppearance(storage); storageAvailable = true; apply();
  });
  on(doc, 'visibilitychange', () => { if (doc.hidden) { clearHighlight(); stopProbe(); } });
  on(win, 'blur', () => { clearHighlight(); stopProbe(); closePanel(); });
  apply();
  const controller = {
    setPreference, setSimpleEffects, close: closePanel,
    getState: () => ({ ...appearance, simpleEffects: preference.simpleEffects, adaptiveLite }),
    destroy() {
      clearHighlight(); stopProbe(); closePanel();
      cleanups.forEach(cleanup => cleanup()); installations.delete(win);
    },
  };
  installations.set(win, controller);
  return controller;
}

if (typeof window !== 'undefined' && window.document) installLiquidGlass(window);
