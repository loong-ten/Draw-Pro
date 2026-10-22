/**
 * Browser/Worker-safe pixel-art processing. No DOM, network, or dependencies.
 * Grid detection is a heuristic suggestion, never proof of an original grid.
 */

const MAX_PIXELS = 16_777_216;
const MAX_SIDE = 32_768;
const PALETTE_PREVIEW_LIMIT = 256;

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function integer(value, fallback, minimum, maximum) {
  return clamp(Number.isFinite(Number(value)) ? Math.round(Number(value)) : fallback, minimum, maximum);
}

function validateImage(image) {
  if (!image || !Number.isInteger(image.width) || !Number.isInteger(image.height) ||
      image.width < 1 || image.height < 1 || image.width > MAX_SIDE || image.height > MAX_SIDE ||
      image.width * image.height > MAX_PIXELS || !image.data ||
      image.data.length < image.width * image.height * 4) {
    throw new Error('图片尺寸或像素数据无效。单张图片最多支持 1677 万像素。');
  }
}

function edgeEnergy(data, a, b) {
  const aa = data[a + 3];
  const ba = data[b + 3];
  return (Math.abs(data[a] * aa - data[b] * ba) +
    Math.abs(data[a + 1] * aa - data[b + 1] * ba) +
    Math.abs(data[a + 2] * aa - data[b + 2] * ba)) / 765 + Math.abs(aa - ba);
}

function edgeProfiles(image) {
  const { width, height, data } = image;
  const x = new Float64Array(width);
  const y = new Float64Array(height);
  const rowStep = Math.max(1, Math.ceil(height / 192));
  const columnStep = Math.max(1, Math.ceil(width / 192));
  // Sampling entire rows/columns preserves the original pixel coordinates.
  for (let row = 0; row < height; row += rowStep) {
    let at = (row * width + 1) * 4;
    for (let column = 1; column < width; column++, at += 4) x[column] += edgeEnergy(data, at, at - 4);
  }
  for (let column = 0; column < width; column += columnStep) {
    for (let row = 1; row < height; row++) {
      const at = (row * width + column) * 4;
      y[row] += edgeEnergy(data, at, at - width * 4);
    }
  }
  return { x, y };
}

function profilePeriod(profile, gridSize) {
  const bins = new Float64Array(gridSize);
  let total = 0;
  let maximum = 0;
  for (let index = 1; index < profile.length; index++) {
    const value = profile[index];
    total += value;
    maximum = Math.max(maximum, value);
    bins[index % gridSize] += value;
  }
  if (total <= 0.001) return { active: false, strength: 0, offset: 0, support: 0 };
  let offset = 0;
  for (let index = 1; index < bins.length; index++) if (bins[index] > bins[offset]) offset = index;
  const concentration = bins[offset] / total;
  const strength = clamp((concentration - 1 / gridSize) / (1 - 1 / gridSize), 0, 1);
  let support = 0;
  const threshold = Math.max(0.001, maximum * 0.04);
  for (let index = 1; index < profile.length; index++) {
    if (index % gridSize === offset && profile[index] >= threshold) support++;
  }
  return { active: true, strength, offset, support };
}

/** Suggest a square source grid using repeated, alpha-aware edge locations. */
export function analyzeGrid(image) {
  validateImage(image);
  const profiles = edgeProfiles(image);
  const maximum = Math.min(32, Math.floor(Math.max(image.width, image.height) / 4));
  const candidates = [];
  for (let gridSize = 2; gridSize <= maximum; gridSize++) {
    const x = profilePeriod(profiles.x, gridSize);
    const y = profilePeriod(profiles.y, gridSize);
    const active = Number(x.active) + Number(y.active);
    if (!active) continue;
    const strength = active === 2 ? Math.sqrt(x.strength * y.strength) : (x.active ? x.strength : y.strength);
    const support = Math.min(1, (x.support + y.support) / (active === 2 ? 10 : 6));
    const score = clamp(strength * support * (active === 2 ? 1 : 0.7), 0, 1);
    candidates.push({ gridSize, score, offsetX: x.offset, offsetY: y.offset });
  }
  candidates.sort((a, b) => Math.abs(a.score - b.score) < 0.015 ? b.gridSize - a.gridSize : b.score - a.score);
  const best = candidates[0];
  const reliable = best && best.score >= 0.5;
  return {
    gridSize: reliable ? best.gridSize : 1,
    offsetX: reliable ? best.offsetX : 0,
    offsetY: reliable ? best.offsetY : 0,
    confidence: best ? best.score : 0,
    candidates: candidates.slice(0, 5).map(({ gridSize, score }) => ({ gridSize, score })),
    reason: reliable
      ? `检测到约 ${best.gridSize} px 的重复边缘，建议放大核对网格位置。`
      : '未发现足够稳定的重复网格，建议先按 1 px 检查，再手动调整。',
  };
}

function copyPixel(source, from, target, to) {
  target[to] = source[from];
  target[to + 1] = source[from + 1];
  target[to + 2] = source[from + 2];
  target[to + 3] = source[from + 3];
}

function dominantKey(data, at) {
  // Ignore arbitrary hidden RGB in fully transparent pixels.
  if (data[at + 3] === 0) return -1;
  return ((data[at + 3] >> 4) << 15) | ((data[at] >> 3) << 10) | ((data[at + 1] >> 3) << 5) | (data[at + 2] >> 3);
}

function sampleCell(image, x0, y0, x1, y1, sampling, target, to) {
  const { width, data } = image;
  const centerX = (x0 + x1 - 1) / 2;
  const centerY = (y0 + y1 - 1) / 2;
  if (sampling === 'nearest' || (x1 - x0) * (y1 - y0) === 1) {
    const at = (Math.floor((y0 + y1) / 2) * width + Math.floor((x0 + x1) / 2)) * 4;
    copyPixel(data, at, target, to);
    return;
  }
  if (sampling === 'average') {
    let alpha = 0;
    let red = 0;
    let green = 0;
    let blue = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const at = (y * width + x) * 4;
        const a = data[at + 3];
        alpha += a;
        red += data[at] * a;
        green += data[at + 1] * a;
        blue += data[at + 2] * a;
      }
    }
    if (alpha > 0) {
      target[to] = Math.round(red / alpha);
      target[to + 1] = Math.round(green / alpha);
      target[to + 2] = Math.round(blue / alpha);
      target[to + 3] = Math.round(alpha / ((x1 - x0) * (y1 - y0)));
    }
    return;
  }
  const histogram = new Map();
  let winner = null;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const at = (y * width + x) * 4;
      const key = dominantKey(data, at);
      const distance = (x - centerX) ** 2 + (y - centerY) ** 2;
      let entry = histogram.get(key);
      if (!entry) {
        entry = { count: 0, at, distance };
        histogram.set(key, entry);
      }
      entry.count++;
      if (distance < entry.distance) { entry.at = at; entry.distance = distance; }
      if (!winner || entry.count > winner.count || (entry.count === winner.count && entry.distance < winner.distance)) winner = entry;
    }
  }
  // Return a real source pixel, so dominant sampling adds no blended colors.
  copyPixel(data, winner.at, target, to);
}

function binaryAlpha(data, threshold) {
  for (let at = 0; at < data.length; at += 4) {
    if (data[at + 3] === 0 || data[at + 3] < threshold) {
      data[at] = data[at + 1] = data[at + 2] = data[at + 3] = 0;
    } else data[at + 3] = 255;
  }
}

function samePixel(data, a, b) {
  return data[a] === data[b] && data[a + 1] === data[b + 1] &&
    data[a + 2] === data[b + 2] && data[a + 3] === data[b + 3];
}

function removeIsolatedPixels(data, width, height) {
  const original = data.slice();
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const at = (y * width + x) * 4;
      const reference = ((y - 1) * width + x - 1) * 4;
      if (samePixel(original, at, reference)) continue;
      let uniform = true;
      for (let dy = -1; dy <= 1 && uniform; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          if (!samePixel(original, reference, ((y + dy) * width + x + dx) * 4)) { uniform = false; break; }
        }
      }
      // All eight neighbors must agree. Diagonal lines therefore survive.
      if (uniform) copyPixel(original, reference, data, at);
    }
  }
}

function rgbKey(data, at) {
  return (data[at] << 16) | (data[at + 1] << 8) | data[at + 2];
}

function colorBin(data, at) {
  return ((data[at] >> 3) << 10) | ((data[at + 1] >> 3) << 5) | (data[at + 2] >> 3);
}

function describeBox(entries) {
  let weight = 0;
  const minimum = [255, 255, 255];
  const maximum = [0, 0, 0];
  for (const entry of entries) {
    weight += entry.weight;
    for (let c = 0; c < 3; c++) {
      minimum[c] = Math.min(minimum[c], entry.rgb[c]);
      maximum[c] = Math.max(maximum[c], entry.rgb[c]);
    }
  }
  const ranges = maximum.map((value, c) => value - minimum[c]);
  let channel = 0;
  for (let c = 1; c < 3; c++) if (ranges[c] > ranges[channel]) channel = c;
  return { entries, weight, channel, score: entries.length > 1 ? ranges[channel] ** 2 * weight : -1 };
}

function reducePalette(data, paletteSize) {
  if (!paletteSize) return;
  const distinct = new Set();
  for (let at = 0; at < data.length; at += 4) {
    if (data[at + 3] === 0) continue;
    distinct.add(rgbKey(data, at));
    if (distinct.size > paletteSize) break;
  }
  // An already small palette is kept byte-for-byte.
  if (distinct.size <= paletteSize) return;
  const weights = new Float64Array(32768);
  const red = new Float64Array(32768);
  const green = new Float64Array(32768);
  const blue = new Float64Array(32768);
  const used = [];
  for (let at = 0; at < data.length; at += 4) {
    const alpha = data[at + 3];
    if (!alpha) continue;
    const bin = colorBin(data, at);
    if (!weights[bin]) used.push(bin);
    weights[bin] += alpha;
    red[bin] += data[at] * alpha;
    green[bin] += data[at + 1] * alpha;
    blue[bin] += data[at + 2] * alpha;
  }
  const entries = used.map(bin => ({ bin, weight: weights[bin], rgb: [red[bin] / weights[bin], green[bin] / weights[bin], blue[bin] / weights[bin]] }));
  const boxes = [describeBox(entries)];
  while (boxes.length < paletteSize) {
    let index = -1;
    for (let i = 0; i < boxes.length; i++) if (boxes[i].score >= 0 && (index < 0 || boxes[i].score > boxes[index].score)) index = i;
    if (index < 0) break;
    const box = boxes[index];
    box.entries.sort((a, b) => a.rgb[box.channel] - b.rgb[box.channel] || a.bin - b.bin);
    let cumulative = 0;
    let cut = 1;
    for (let i = 0; i < box.entries.length - 1; i++) {
      cumulative += box.entries[i].weight;
      cut = i + 1;
      if (cumulative >= box.weight / 2) break;
    }
    boxes[index] = describeBox(box.entries.slice(0, cut));
    boxes.push(describeBox(box.entries.slice(cut)));
  }
  const colors = boxes.map(box => {
    const sums = [0, 0, 0];
    for (const entry of box.entries) for (let c = 0; c < 3; c++) sums[c] += entry.rgb[c] * entry.weight;
    return sums.map(sum => Math.round(sum / box.weight));
  });
  const lookup = new Uint32Array(32768);
  for (const entry of entries) {
    let minimumDistance = Infinity;
    let selected = colors[0];
    for (const color of colors) {
      const distance = 3 * (entry.rgb[0] - color[0]) ** 2 + 4 * (entry.rgb[1] - color[1]) ** 2 + 2 * (entry.rgb[2] - color[2]) ** 2;
      if (distance < minimumDistance) { minimumDistance = distance; selected = color; }
    }
    lookup[entry.bin] = (selected[0] << 16) | (selected[1] << 8) | selected[2];
  }
  for (let at = 0; at < data.length; at += 4) {
    if (data[at + 3] === 0) continue;
    const rgb = lookup[colorBin(data, at)];
    data[at] = (rgb >> 16) & 255;
    data[at + 1] = (rgb >> 8) & 255;
    data[at + 2] = rgb & 255;
  }
}

function summarizePixels(data) {
  // A bitset gives an exact distinct RGB count in a bounded 2 MiB allocation.
  const seen = new Uint8Array(1 << 21);
  const preview = new Map();
  let visibleColors = 0;
  let transparentPixels = 0;
  let translucentPixels = 0;
  for (let at = 0; at < data.length; at += 4) {
    const alpha = data[at + 3];
    if (!alpha) { transparentPixels++; continue; }
    if (alpha < 255) translucentPixels++;
    const rgb = rgbKey(data, at);
    const byte = rgb >> 3;
    const mask = 1 << (rgb & 7);
    if (!(seen[byte] & mask)) {
      seen[byte] |= mask;
      visibleColors++;
      if (preview.size < PALETTE_PREVIEW_LIMIT) preview.set(rgb, 0);
    }
    if (preview.has(rgb)) preview.set(rgb, preview.get(rgb) + 1);
  }
  return {
    palette: [...preview].map(([rgb, count]) => ({ hex: '#' + rgb.toString(16).padStart(6, '0'), count })).sort((a, b) => b.count - a.count || a.hex.localeCompare(b.hex)),
    stats: { visibleColors, transparentPixels, translucentPixels, paletteTruncated: visibleColors > PALETTE_PREVIEW_LIMIT },
  };
}

/**
 * Reconstruct one output pixel per source grid cell, then optionally simplify
 * its RGB palette and alpha. Input is never mutated. Partial edge cells remain.
 */
export function processPixels(image, options = {}) {
  validateImage(image);
  const gridSize = integer(options.gridSize, 1, 1, 64);
  const offsetX = integer(options.offsetX, 0, 0, gridSize - 1);
  const offsetY = integer(options.offsetY, 0, 0, gridSize - 1);
  const originX = offsetX > 0 ? offsetX - gridSize : 0;
  const originY = offsetY > 0 ? offsetY - gridSize : 0;
  const width = Math.ceil((image.width - originX) / gridSize);
  const height = Math.ceil((image.height - originY) / gridSize);
  if (width * height > MAX_PIXELS) throw new Error('输出尺寸过大，请增大像素网格。');
  const data = new Uint8ClampedArray(width * height * 4);
  const sampling = ['dominant', 'nearest', 'average'].includes(options.sampling) ? options.sampling : 'dominant';
  if (gridSize === 1) {
    data.set(image.data.subarray ? image.data.subarray(0, data.length) : image.data.slice(0, data.length));
  } else {
    for (let y = 0; y < height; y++) {
      const y0 = Math.max(0, originY + y * gridSize);
      const y1 = Math.min(image.height, originY + (y + 1) * gridSize);
      for (let x = 0; x < width; x++) {
        const x0 = Math.max(0, originX + x * gridSize);
        const x1 = Math.min(image.width, originX + (x + 1) * gridSize);
        sampleCell(image, x0, y0, x1, y1, sampling, data, (y * width + x) * 4);
      }
    }
  }
  if (options.alphaMode === 'binary') binaryAlpha(data, integer(options.alphaThreshold, 128, 0, 255));
  const paletteSize = integer(options.paletteSize, 0, 0, 256);
  reducePalette(data, paletteSize);
  if (options.denoise) removeIsolatedPixels(data, width, height);
  return {
    width, height, data,
    ...summarizePixels(data),
    mapping: { originX, originY, scaleX: gridSize, scaleY: gridSize },
  };
}
