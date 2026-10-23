/* Run before stylesheets so the first frame uses the saved or system appearance. */
(() => {
  const root = document.documentElement;
  const key = 'paint-workspace.liquid-appearance.v1';
  let preference = 'system', simpleEffects = false;
  try {
    const saved = JSON.parse(localStorage.getItem(key) || 'null');
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      if (['system', 'light', 'dark'].includes(saved.theme)) preference = saved.theme;
      simpleEffects = saved.simpleEffects === true;
    }
  } catch { /* Private or restricted storage still gets a complete default theme. */ }
  const matches = query => {
    try { return window.matchMedia(query).matches; } catch { return false; }
  };
  const contrast = matches('(prefers-contrast: more)') || matches('(forced-colors: active)');
  const reduceTransparency = matches('(prefers-reduced-transparency: reduce)');
  const reduceMotion = matches('(prefers-reduced-motion: reduce)');
  const lowPower = navigator.connection?.saveData === true ||
    Number.isFinite(navigator.hardwareConcurrency) && navigator.hardwareConcurrency > 0 && navigator.hardwareConcurrency <= 4;
  root.dataset.lgPreference = preference;
  root.dataset.lgTheme = preference === 'system' ? matches('(prefers-color-scheme: dark)') ? 'dark' : 'light' : preference;
  root.dataset.lgMaterial = simpleEffects || reduceTransparency || contrast ? 'solid' : 'glass';
  root.dataset.lgMotion = simpleEffects || reduceMotion ? 'reduced' : 'full';
  root.dataset.lgContrast = contrast ? 'more' : 'normal';
  root.dataset.lgQuality = lowPower || simpleEffects ? 'lite' : 'full';
  root.dataset.lgChrome = 'expanded';
})();
