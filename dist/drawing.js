import { makeCanvas } from './core.js';

const TAU = Math.PI * 2;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const point = value => ({ x: Number(value?.x ?? value?.[0] ?? 0), y: Number(value?.y ?? value?.[1] ?? 0) });

function settings(options = {}) {
  const pressure = clamp(Number(options.pressure ?? 1) || 0.1, 0.1, 1.5);
  return {
    ...options,
    color: options.color || '#202124',
    secondary: options.secondary || '#ffffff',
    size: clamp(Number(options.size ?? 4) || 1, 1, 1024),
    opacity: clamp(Number(options.opacity ?? 1), 0, 1),
    brush: options.brush || 'round',
    eraser: Boolean(options.eraser),
    pressure,
  };
}

function strokeLine(ctx, from, to, width, cap = 'round') {
  ctx.lineWidth = width;
  ctx.lineCap = cap;
  ctx.lineJoin = 'round';
  if (from.x === to.x && from.y === to.y) {
    ctx.beginPath();
    if (cap === 'round') ctx.arc(from.x, from.y, width / 2, 0, TAU);
    else ctx.rect(from.x - width / 2, from.y - width / 2, width, width);
    ctx.fill();
    return;
  }
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
}

function stamps(from, to, spacing, visit) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const count = Math.max(1, Math.min(8192, Math.ceil(Math.hypot(dx, dy) / Math.max(0.5, spacing))));
  for (let i = 0; i <= count; i++) visit(from.x + dx * i / count, from.y + dy * i / count, i);
}

function hardPencil(ctx, from, to, size) {
  let x = Math.floor(from.x);
  let y = Math.floor(from.y);
  const endX = Math.floor(to.x);
  const endY = Math.floor(to.y);
  const dx = Math.abs(endX - x);
  const dy = -Math.abs(endY - y);
  const sx = x < endX ? 1 : -1;
  const sy = y < endY ? 1 : -1;
  let error = dx + dy;
  const diameter = Math.max(1, Math.round(size));
  const offset = Math.floor(diameter / 2);
  // A pixel-aligned square nib produces no gray antialiasing fringe.
  for (let guard = 0; guard < 65536; guard++) {
    ctx.fillRect(x - offset, y - offset, diameter, diameter);
    if (x === endX && y === endY) break;
    const doubled = error * 2;
    if (doubled >= dy) { error += dy; x += sx; }
    if (doubled <= dx) { error += dx; y += sy; }
  }
}

/** Draws one stroke segment. Call on an existing stroke surface, then composite once. */
export function drawSegment(ctx, start, end, options = {}) {
  const from = point(start);
  const to = point(end);
  const opts = settings(options);
  const size = clamp(Number(opts.size) * Math.sqrt(opts.pressure), 1, 1536);
  const opacity = clamp(Number(opts.opacity), 0, 1);
  if (![from.x, from.y, to.x, to.y, size, opacity].every(Number.isFinite)) return;
  ctx.save();
  ctx.globalCompositeOperation = opts.eraser ? 'destination-out' : 'source-over';
  ctx.globalAlpha = opacity;
  ctx.strokeStyle = opts.color;
  ctx.fillStyle = opts.color;

  if (opts.brush === 'pencil') {
    hardPencil(ctx, from, to, size);
  } else if (opts.brush === 'square') {
    strokeLine(ctx, from, to, size, 'square');
  } else if (opts.brush === 'marker') {
    ctx.globalAlpha = opacity * 0.65;
    strokeLine(ctx, from, to, size * 1.45, 'square');
  } else if (opts.brush === 'calligraphy') {
    // The fixed diagonal nib changes the apparent width with stroke direction.
    const a = size * 0.6;
    const b = size * 0.1;
    stamps(from, to, Math.max(0.8, size * 0.13), (x, y) => {
      ctx.beginPath();
      ctx.moveTo(x - a - b, y + a - b);
      ctx.lineTo(x + a - b, y - a - b);
      ctx.lineTo(x + a + b, y - a + b);
      ctx.lineTo(x - a + b, y + a + b);
      ctx.closePath();
      ctx.fill();
    });
  } else if (opts.brush === 'airbrush') {
    const radius = Math.max(2, size);
    const density = Math.min(120, Math.max(12, Math.round(radius * 2)));
    stamps(from, to, radius * 0.18, (x, y) => {
      for (let i = 0; i < density; i++) {
        const angle = Math.random() * TAU;
        const distance = Math.sqrt(Math.random()) * radius;
        ctx.globalAlpha = opacity * (0.07 + 0.2 * (1 - distance / radius));
        const dot = Math.max(0.7, size * 0.025);
        ctx.fillRect(x + Math.cos(angle) * distance, y + Math.sin(angle) * distance, dot, dot);
      }
    });
  } else if (opts.brush === 'crayon') {
    const radius = size / 2;
    const density = Math.min(96, Math.max(10, Math.round(size * 1.8)));
    stamps(from, to, Math.max(1, size * 0.13), (x, y) => {
      for (let i = 0; i < density; i++) {
        const angle = Math.random() * TAU;
        const distance = Math.sqrt(Math.random()) * radius;
        ctx.globalAlpha = opacity * (0.12 + Math.random() * 0.5);
        const grain = Math.max(0.8, size * 0.035);
        ctx.fillRect(Math.floor(x + Math.cos(angle) * distance), Math.floor(y + Math.sin(angle) * distance), grain, grain);
      }
    });
  } else if (opts.brush === 'oil') {
    ctx.globalAlpha = opacity * 0.65;
    strokeLine(ctx, from, to, size, 'round');
    const angle = Math.atan2(to.y - from.y, to.x - from.x) + Math.PI / 2;
    const fibers = Math.max(4, Math.min(28, Math.round(size / 2)));
    for (let i = 0; i < fibers; i++) {
      const distance = (i / Math.max(1, fibers - 1) - 0.5) * size * 0.86;
      const x = Math.cos(angle) * distance;
      const y = Math.sin(angle) * distance;
      ctx.globalAlpha = opacity * (i % 3 === 0 ? 0.4 : 0.12);
      strokeLine(ctx, { x: from.x + x, y: from.y + y }, { x: to.x + x, y: to.y + y }, Math.max(0.6, size / fibers * 0.6), 'round');
    }
  } else if (opts.brush === 'watercolor') {
    // Translucent concentric washes, with a faint pigment rim.
    const radius = Math.max(1.5, size * 0.7);
    stamps(from, to, radius * 0.5, (x, y) => {
      for (let ring = 3; ring >= 1; ring--) {
        ctx.globalAlpha = opacity * 0.055;
        ctx.beginPath();
        ctx.arc(x, y, radius * ring / 3, 0, TAU);
        ctx.fill();
      }
      ctx.globalAlpha = opacity * 0.035;
      ctx.lineWidth = Math.max(0.5, size * 0.025);
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, TAU);
      ctx.stroke();
    });
  } else {
    strokeLine(ctx, from, to, size, 'round');
  }
  ctx.restore();
}

function closedPolygon(ctx, points) {
  if (!points.length) return;
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
  ctx.closePath();
}

function roundedRect(ctx, x, y, width, height, radius) {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function regularPolygon(cx, cy, rx, ry, sides, star = false, innerRadius = 0.43) {
  const count = star ? sides * 2 : sides;
  return Array.from({ length: count }, (_, index) => {
    const angle = -Math.PI / 2 + TAU * index / count;
    const scale = star && index % 2 ? innerRadius : 1;
    return { x: cx + Math.cos(angle) * rx * scale, y: cy + Math.sin(angle) * ry * scale };
  });
}

export function drawShape(ctx, kind, start, finish, options = {}) {
  const from = point(start);
  const to = point(finish);
  const opts = settings(options);
  if (![from.x, from.y, to.x, to.y].every(Number.isFinite)) return;
  let dx = to.x - from.x;
  let dy = to.y - from.y;
  if (opts.shift) {
    if (kind === 'line' || kind === 'curve') {
      const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * Math.PI / 4;
      const length = Math.hypot(dx, dy);
      dx = Math.cos(angle) * length;
      dy = Math.sin(angle) * length;
    } else {
      const side = Math.max(Math.abs(dx), Math.abs(dy));
      dx = Math.sign(dx || 1) * side;
      dy = Math.sign(dy || 1) * side;
    }
    to.x = from.x + dx;
    to.y = from.y + dy;
  }
  const x = Math.min(from.x, to.x);
  const y = Math.min(from.y, to.y);
  const width = Math.abs(to.x - from.x);
  const height = Math.abs(to.y - from.y);
  const right = x + width;
  const bottom = y + height;
  const cx = x + width / 2;
  const cy = y + height / 2;
  ctx.save();
  ctx.globalCompositeOperation = opts.eraser ? 'destination-out' : 'source-over';
  ctx.globalAlpha = clamp(Number(opts.opacity), 0, 1);
  ctx.lineWidth = Math.max(1, Number(opts.size) || 1);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = opts.color;
  ctx.fillStyle = opts.fill === 'secondary' ? opts.secondary : opts.color;
  ctx.beginPath();

  if (kind === 'line') {
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
  } else if (kind === 'curve') {
    ctx.moveTo(from.x, from.y);
    const controls = opts.control;
    if (Array.isArray(controls) && controls.length >= 2 && typeof controls[0] === 'object') {
      const a = point(controls[0]);
      const b = point(controls[1]);
      ctx.bezierCurveTo(a.x, a.y, b.x, b.y, to.x, to.y);
    } else if (controls?.c1 && controls?.c2) {
      const a = point(controls.c1);
      const b = point(controls.c2);
      ctx.bezierCurveTo(a.x, a.y, b.x, b.y, to.x, to.y);
    } else {
      const control = controls ? point(controls) : { x: (from.x + to.x) / 2 - (to.y - from.y) * 0.45, y: (from.y + to.y) / 2 + (to.x - from.x) * 0.45 };
      ctx.quadraticCurveTo(control.x, control.y, to.x, to.y);
    }
  } else if (kind === 'rect') {
    ctx.rect(x, y, width, height);
  } else if (kind === 'roundrect') {
    roundedRect(ctx, x, y, width, height, Math.min(width, height) * 0.15);
  } else if (kind === 'ellipse') {
    ctx.ellipse(cx, cy, width / 2, height / 2, 0, 0, TAU);
  } else if (kind === 'triangle') {
    closedPolygon(ctx, [{ x: cx, y }, { x: right, y: bottom }, { x, y: bottom }]);
  } else if (kind === 'righttriangle') {
    closedPolygon(ctx, [{ x, y }, { x: right, y: bottom }, { x, y: bottom }]);
  } else if (kind === 'diamond') {
    closedPolygon(ctx, [{ x: cx, y }, { x: right, y: cy }, { x: cx, y: bottom }, { x, y: cy }]);
  } else if (kind === 'pentagon') {
    closedPolygon(ctx, regularPolygon(cx, cy, width / 2, height / 2, 5));
  } else if (kind === 'hexagon') {
    closedPolygon(ctx, [{ x: x + width * 0.25, y }, { x: x + width * 0.75, y }, { x: right, y: cy }, { x: x + width * 0.75, y: bottom }, { x: x + width * 0.25, y: bottom }, { x, y: cy }]);
  } else if (kind === 'star') {
    closedPolygon(ctx, regularPolygon(cx, cy, width / 2, height / 2, 5, true));
  } else if (kind === 'star4' || kind === 'star6') {
    closedPolygon(ctx, regularPolygon(cx, cy, width / 2, height / 2, kind === 'star4' ? 4 : 6, true, kind === 'star4' ? 0.27 : 0.5));
  } else if (kind === 'burst') {
    const depths = [0.55, 0.67, 0.58, 0.7, 0.56, 0.64];
    const burst = Array.from({ length: 24 }, (_, i) => {
      const angle = -Math.PI / 2 + i * TAU / 24;
      const radius = i % 2 ? depths[Math.floor(i / 2) % depths.length] : 1;
      return { x: cx + Math.cos(angle) * width / 2 * radius, y: cy + Math.sin(angle) * height / 2 * radius };
    });
    closedPolygon(ctx, burst);
  } else if (['arrow', 'leftarrow', 'uparrow', 'downarrow'].includes(kind)) {
    const arrow = [[0, 0.32], [0.56, 0.32], [0.56, 0], [1, 0.5], [0.56, 1], [0.56, 0.68], [0, 0.68]];
    closedPolygon(ctx, arrow.map(([px, py]) => {
      if (kind === 'leftarrow') px = 1 - px;
      else if (kind === 'uparrow') [px, py] = [py, 1 - px];
      else if (kind === 'downarrow') [px, py] = [py, px];
      return { x: x + px * width, y: y + py * height };
    }));
  } else if (kind === 'lightning') {
    closedPolygon(ctx, [[0.45, 0], [1, 0], [0.64, 0.4], [1, 0.4], [0.15, 1], [0.32, 0.6], [0, 0.6]].map(([px, py]) => ({ x: x + px * width, y: y + py * height })));
  } else if (kind === 'cloud') {
    // Each cubic control point stays inside the requested box, so every
    // scallop remains bounded even for narrow or tall cloud shapes.
    ctx.moveTo(x + width * 0.24, y + height * 0.8);
    ctx.bezierCurveTo(x + width * 0.09, y + height * 0.88, x, y + height * 0.64, x + width * 0.07, y + height * 0.49);
    ctx.bezierCurveTo(x, y + height * 0.24, x + width * 0.18, y + height * 0.1, x + width * 0.3, y + height * 0.23);
    ctx.bezierCurveTo(x + width * 0.32, y, x + width * 0.58, y, x + width * 0.66, y + height * 0.2);
    ctx.bezierCurveTo(x + width * 0.83, y + height * 0.05, right, y + height * 0.27, x + width * 0.91, y + height * 0.45);
    ctx.bezierCurveTo(right, y + height * 0.52, right, y + height * 0.82, x + width * 0.82, y + height * 0.8);
    ctx.bezierCurveTo(x + width * 0.76, bottom, x + width * 0.56, bottom, x + width * 0.48, y + height * 0.86);
    ctx.bezierCurveTo(x + width * 0.38, bottom, x + width * 0.19, y + height * 0.95, x + width * 0.24, y + height * 0.8);
    ctx.closePath();
  } else if (kind === 'ovalcallout') {
    // The tail replaces a short arc of the oval instead of being drawn over
    // it, preventing a visible seam through the speech bubble's interior.
    const angle = Math.PI * 0.72;
    ctx.moveTo(cx + Math.cos(angle) * width / 2, y + height * 0.4 + Math.sin(angle) * height * 0.4);
    ctx.ellipse(cx, y + height * 0.4, width / 2, height * 0.4, 0, angle, TAU + Math.PI * 0.53);
    ctx.lineTo(x + width * 0.14, bottom);
    ctx.closePath();
  } else if (kind === 'heart') {
    ctx.moveTo(cx, y + height * 0.23);
    ctx.bezierCurveTo(x + width * 0.12, y - height * 0.22, x - width * 0.22, y + height * 0.32, cx, bottom);
    ctx.bezierCurveTo(right + width * 0.22, y + height * 0.32, x + width * 0.88, y - height * 0.22, cx, y + height * 0.23);
    ctx.closePath();
  } else if (kind === 'speech') {
    const r = Math.min(width, height) * 0.1;
    const bodyBottom = y + height * 0.76;
    ctx.moveTo(x + r, y);
    ctx.lineTo(right - r, y);
    ctx.quadraticCurveTo(right, y, right, y + r);
    ctx.lineTo(right, bodyBottom - r);
    ctx.quadraticCurveTo(right, bodyBottom, right - r, bodyBottom);
    ctx.lineTo(x + width * 0.4, bodyBottom);
    ctx.lineTo(x + width * 0.2, bottom);
    ctx.lineTo(x + width * 0.23, bodyBottom);
    ctx.lineTo(x + r, bodyBottom);
    ctx.quadraticCurveTo(x, bodyBottom, x, bodyBottom - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  } else if (kind === 'polygon') {
    closedPolygon(ctx, opts.points?.length >= 3 ? opts.points.map(point) : regularPolygon(cx, cy, width / 2, height / 2, 6));
  } else {
    ctx.rect(x, y, width, height);
  }

  if (kind !== 'line' && kind !== 'curve' && opts.fill && opts.fill !== 'none') ctx.fill();
  if (opts.outline !== false || kind === 'line' || kind === 'curve') ctx.stroke();
  ctx.restore();
}

export function selectionMask(width, height, points = []) {
  const canvas = makeCanvas(width, height);
  if (points.length < 3) return canvas;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  closedPolygon(ctx, points.map(point));
  ctx.fill();
  return canvas;
}
