const STORAGE_KEY = 'paint-workspace.mode-order.v1';
const HOLD_MS = 380;
const MOVE_SLOP = 8;

/** Navigation preferences are independent of artwork, history and the active mode. */
export function installModeOrder(nav, { toast = () => {} } = {}) {
  if (!nav) return;
  const buttons = () => [...nav.querySelectorAll(':scope > button[data-mode-switch]')];
  const defaults = buttons();
  const label = button => [...button.childNodes].filter(node => node.nodeType === 3).map(node => node.textContent).join('').trim();
  const buttonFrom = target => {
    const button = target?.closest?.('button[data-mode-switch]');
    return button?.parentElement === nav ? button : null;
  };
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (Array.isArray(saved)) {
      const byId = new Map(defaults.map(button => [button.dataset.modeSwitch, button]));
      for (const id of new Set(saved)) {
        if (byId.has(id)) { nav.append(byId.get(id)); byId.delete(id); }
      }
      for (const button of byId.values()) nav.append(button);
    }
  } catch { /* A missing or unavailable preference store keeps the default order. */ }

  const status = document.createElement('span');
  status.className = 'mode-order-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  nav.after(status);
  defaults.forEach(button => {
    button.title = `${label(button)} · 长按后拖动交换位置（Alt + ← / →）`;
    button.setAttribute('aria-description', '点击切换功能；长按后拖动到另一功能上交换位置。也可按 Alt 加左右方向键调整顺序。');
    button.setAttribute('aria-keyshortcuts', 'Alt+ArrowLeft Alt+ArrowRight');
    button.draggable = false;
  });

  let gesture = null;
  let blockedClick = false;
  let animation = 0;
  const suppressClick = () => {
    // Keep this until release/click or a fresh press, even after a long Esc hold.
    blockedClick = true;
  };

  function swap(first, second) {
    const order = buttons(), a = order.indexOf(first), b = order.indexOf(second);
    if (a < 0 || b < 0 || a === b) return;
    [order[a], order[b]] = [order[b], order[a]];
    nav.append(...order);
    first.focus({ preventScroll: true });
    first.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    let saved = true;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(order.map(button => button.dataset.modeSwitch))); }
    catch { saved = false; }
    const message = `已交换“${label(first)}”与“${label(second)}”的位置`;
    status.textContent = message;
    toast(message + (saved ? '，顺序已记住。' : '；当前浏览器无法记住顺序。'));
  }

  function updateTarget() {
    const g = gesture;
    if (g?.phase !== 'drag') return;
    const bounds = nav.getBoundingClientRect();
    let target = null;
    if (g.x >= bounds.left && g.x <= bounds.right && g.y >= bounds.top - 12 && g.y <= bounds.bottom + 12) {
      target = buttons().find(button => {
        const rect = button.getBoundingClientRect();
        return g.x >= rect.left - 2 && g.x <= rect.right + 2;
      }) || null;
      if (target === g.button) target = null;
    }
    if (target !== g.target) {
      g.target?.classList.remove('mode-drop-target');
      target?.classList.add('mode-drop-target');
      g.target = target;
      const message = target ? `松开，与“${label(target)}”交换` : '拖到其他功能上交换 · Esc 取消';
      g.hint.textContent = message;
      status.textContent = message;
    }
    g.ghost.style.transform = `translate(${g.x - g.offsetX}px, ${g.y - g.offsetY}px)`;
    const hintWidth = g.hint.getBoundingClientRect().width;
    g.hint.style.left = Math.max(8, Math.min(g.x - hintWidth / 2, window.innerWidth - hintWidth - 8)) + 'px';
    g.hint.style.top = bounds.bottom + 9 + 'px';
  }

  function autoScroll(time) {
    const g = gesture;
    if (g?.phase !== 'drag') return;
    const bounds = nav.getBoundingClientRect();
    const edge = Math.min(38, bounds.width / 4);
    const elapsed = Math.min(32, time - (g.lastFrame || time));
    g.lastFrame = time;
    if (g.moved && g.y >= bounds.top - 12 && g.y <= bounds.bottom + 12 && g.x >= bounds.left - 12 && g.x <= bounds.right + 12) {
      const speed = g.x < bounds.left + edge ? -Math.min(1, (bounds.left + edge - g.x) / edge)
        : g.x > bounds.right - edge ? Math.min(1, (g.x - bounds.right + edge) / edge) : 0;
      nav.scrollLeft += speed * elapsed * .5;
      updateTarget();
    }
    animation = requestAnimationFrame(autoScroll);
  }

  function beginDrag(g) {
    if (gesture !== g || g.phase !== 'pending') return;
    g.phase = 'drag';
    g.button.classList.remove('mode-pressing');
    g.button.classList.add('mode-drag-source');
    nav.classList.add('mode-reordering');
    document.body.classList.add('reordering-modes');
    const rect = g.button.getBoundingClientRect();
    g.offsetX = g.startX - rect.left;
    g.offsetY = g.startY - rect.top;
    g.ghost = document.createElement('div');
    g.ghost.className = 'mode-tab-ghost';
    g.ghost.setAttribute('aria-hidden', 'true');
    g.ghost.style.width = rect.width + 'px';
    g.ghost.style.height = rect.height + 'px';
    const icon = g.button.querySelector('svg');
    if (icon) g.ghost.append(icon.cloneNode(true));
    g.ghost.append(document.createTextNode(label(g.button)));
    g.hint = document.createElement('div');
    g.hint.className = 'mode-drag-hint';
    g.hint.setAttribute('aria-hidden', 'true');
    g.hint.textContent = '拖到其他功能上交换 · Esc 取消';
    document.body.append(g.ghost, g.hint);
    status.textContent = `已拿起“${label(g.button)}”，拖到其他功能上交换位置；按 Esc 取消。`;
    updateTarget();
    animation = requestAnimationFrame(autoScroll);
  }

  function finish(commit = false) {
    const g = gesture;
    if (!g) return;
    gesture = null;
    clearTimeout(g.timer);
    cancelAnimationFrame(animation);
    g.button.classList.remove('mode-pressing', 'mode-drag-source');
    g.target?.classList.remove('mode-drop-target');
    nav.classList.remove('mode-reordering');
    document.body.classList.remove('reordering-modes');
    g.ghost?.remove();
    g.hint?.remove();
    try { if (g.button.hasPointerCapture(g.pointerId)) g.button.releasePointerCapture(g.pointerId); } catch {}
    if (!commit || g.phase !== 'pending') suppressClick();
    if (commit && g.phase === 'drag' && g.target) swap(g.button, g.target);
    else if (g.phase === 'drag') status.textContent = '已取消交换，功能顺序未变。';
  }

  nav.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0) return;
    const button = buttonFrom(event.target);
    if (!button || button.disabled || gesture) return;
    blockedClick = false;
    const g = gesture = {
      button, pointerId: event.pointerId, pointerType: event.pointerType,
      startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY,
      startScroll: nav.scrollLeft, phase: 'pending', target: null, moved: false
    };
    button.classList.add('mode-pressing');
    // Keep short clicks targeted at the actual button; reparent only after release.
    try { button.setPointerCapture(event.pointerId); } catch {}
    g.timer = setTimeout(() => beginDrag(g), HOLD_MS);
  });

  window.addEventListener('pointermove', event => {
    const g = gesture;
    if (!g || event.pointerId !== g.pointerId) return;
    g.x = event.clientX; g.y = event.clientY;
    if (Math.hypot(g.x - g.startX, g.y - g.startY) > MOVE_SLOP) {
      g.moved = true;
      if (g.phase === 'pending') {
        clearTimeout(g.timer);
        g.button.classList.remove('mode-pressing');
        g.phase = g.pointerType === 'mouse' ? 'cancelled' : 'scroll';
      }
    }
    if (g.phase === 'scroll') { event.preventDefault(); nav.scrollLeft = g.startScroll - (g.x - g.startX); }
    if (g.phase === 'drag') { event.preventDefault(); updateTarget(); }
  }, { passive: false });

  window.addEventListener('pointerup', event => {
    if (event.pointerId !== gesture?.pointerId) return;
    gesture.x = event.clientX; gesture.y = event.clientY;
    updateTarget();
    if (gesture.phase !== 'pending') event.preventDefault();
    finish(true);
  });
  window.addEventListener('pointercancel', event => { if (event.pointerId === gesture?.pointerId) finish(); });
  nav.addEventListener('lostpointercapture', event => { if (event.pointerId === gesture?.pointerId) finish(); });
  window.addEventListener('pointerdown', event => { if (gesture && event.pointerId !== gesture.pointerId) finish(); }, true);
  window.addEventListener('blur', () => finish());
  window.addEventListener('resize', () => finish());
  document.addEventListener('visibilitychange', () => { if (document.hidden) finish(); });
  nav.addEventListener('contextmenu', event => { if (gesture) event.preventDefault(); });
  nav.addEventListener('dragstart', event => event.preventDefault());
  nav.addEventListener('click', event => {
    if (!blockedClick || event.detail === 0) return;
    event.preventDefault(); event.stopImmediatePropagation();
    blockedClick = false;
  }, true);

  // Run before the drawing/composition shortcuts registered on document capture.
  window.addEventListener('keydown', event => {
    if (gesture && event.key === 'Escape') {
      event.preventDefault(); event.stopImmediatePropagation(); finish(); return;
    }
    if (gesture && (event.key === 'Enter' || event.code === 'Space')) {
      event.preventDefault(); event.stopImmediatePropagation(); return;
    }
    const button = buttonFrom(event.target);
    if (!button || event.ctrlKey || event.metaKey) return;
    event.stopPropagation();
    const order = buttons(), index = order.indexOf(button);
    const direction = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
    if (event.altKey && direction) {
      event.preventDefault();
      if (!gesture && order[index + direction]) swap(button, order[index + direction]);
    } else if (!event.altKey && (direction || event.key === 'Home' || event.key === 'End')) {
      event.preventDefault();
      const next = event.key === 'Home' ? order[0] : event.key === 'End' ? order.at(-1) : order[(index + direction + order.length) % order.length];
      next.focus({ preventScroll: true });
      next.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    }
    // Native Enter / Space activation still produces the normal button click.
  }, true);
}
