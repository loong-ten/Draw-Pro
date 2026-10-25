const BACKGROUNDS = new Set(['studio', 'checker', 'dark-checker', 'transparent']);

export function normalizeCanvasBackground(value) {
  return BACKGROUNDS.has(value) ? value : 'checker';
}

// Find the visible canvas bounds in the caller's coordinates. The checker is
// sized in screen coordinates, not image pixels, and must stay cheap when a
// large image is zoomed far beyond the viewport.
function visibleBounds(ctx, rect) {
  const m = ctx.getTransform?.();
  if (!m) return rect;
  const determinant = m.a * m.d - m.b * m.c;
  if (!Number.isFinite(determinant) || determinant === 0) return { ...rect, width: 0, height: 0 };
  const points = [[0, 0], [ctx.canvas.width, 0], [0, ctx.canvas.height], [ctx.canvas.width, ctx.canvas.height]].map(([x, y]) => ({
    x: (m.d * (x - m.e) - m.c * (y - m.f)) / determinant,
    y: (-m.b * (x - m.e) + m.a * (y - m.f)) / determinant,
  }));
  const x = Math.max(rect.x, Math.min(...points.map(point => point.x)));
  const y = Math.max(rect.y, Math.min(...points.map(point => point.y)));
  return {
    x, y,
    width: Math.max(0, Math.min(rect.x + rect.width, Math.max(...points.map(point => point.x))) - x),
    height: Math.max(0, Math.min(rect.y + rect.height, Math.max(...points.map(point => point.y))) - y),
  };
}

/** Paint only a display canvas. Rect coordinates already include image zoom;
 * the caller may keep its device-pixel-ratio transform. Artwork is untouched. */
export function drawTransparencyBackground(ctx, { x, y, width, height }, kind = 'checker') {
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return;
  kind = normalizeCanvasBackground(kind);
  ctx.save();
  try {
    // Path2D keeps the caller's current drawing path intact in browser canvases.
    if (typeof Path2D === 'function') {
      const clip = new Path2D(); clip.rect(x, y, width, height); ctx.clip(clip);
    } else {
      ctx.beginPath(); ctx.rect(x, y, width, height); ctx.clip();
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.shadowColor = 'rgba(0,0,0,0)';
    ctx.shadowBlur = ctx.shadowOffsetX = ctx.shadowOffsetY = 0;
    if ('filter' in ctx) ctx.filter = 'none';
    if (kind === 'transparent') {
      // Remove earlier viewport/white shadow fills inside this rectangle so
      // transparent pixels really reveal the page underneath the canvas.
      ctx.clearRect(x, y, width, height);
    } else if (kind === 'studio') {
      const gradient = ctx.createRadialGradient(x + width * .5, y + height * .38, 0,
        x + width * .5, y + height * .38, Math.hypot(width, height) * .65);
      gradient.addColorStop(0, '#363e49');
      gradient.addColorStop(.6, '#242a33');
      gradient.addColorStop(1, '#15191f');
      ctx.fillStyle = gradient;
      ctx.fillRect(x, y, width, height);
    } else {
      ctx.fillStyle = kind === 'dark-checker' ? '#252B33' : '#ffffff'; ctx.fillRect(x, y, width, height);
      ctx.fillStyle = kind === 'dark-checker' ? '#3A424D' : '#e5e7e9';
      const cell = 10, visible = visibleBounds(ctx, { x, y, width, height });
      for (let gx = Math.floor(visible.x / cell) * cell; gx < visible.x + visible.width; gx += cell) {
        for (let gy = Math.floor(visible.y / cell) * cell; gy < visible.y + visible.height; gy += cell) {
          if ((Math.floor(gx / cell) + Math.floor(gy / cell)) % 2 === 0) ctx.fillRect(gx, gy, cell, cell);
        }
      }
    }
  } finally { ctx.restore(); }
}
