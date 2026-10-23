/** Browser/Worker-safe conversion of photographs and artwork to a fixed pixel grid. */
const MAX_INPUT_PIXELS = 16_777_216;
const MAX_OUTPUT_PIXELS = 32 * 1024 * 1024;
const MAX_SIDE = 8192;
const MAX_SVG_RECTS = 100_000;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

export const DEFAULT_CONVERSION_OPTIONS = Object.freeze({
  pixelSize: 8, colorCount: 128, outputSize: 100, sampling: 'dominant',
  gridAlign: true, preserveAlpha: true,
});

function optionInteger(value, fallback, lo, hi) {
  const number = Number(value);
  return value == null || !Number.isFinite(number) ? fallback : clamp(Math.round(number), lo, hi);
}

export function normalizeConversionOptions(input = {}) {
  if (!input || typeof input !== 'object') input = {};
  return {
    pixelSize: optionInteger(input.pixelSize, 8, 2, 32),
    colorCount: optionInteger(input.colorCount, 128, 2, 256),
    outputSize: optionInteger(input.outputSize, 100, 10, 100),
    sampling: ['dominant', 'mean', 'median'].includes(input.sampling) ? input.sampling : 'dominant',
    gridAlign: typeof input.gridAlign === 'boolean' ? input.gridAlign : true,
    preserveAlpha: typeof input.preserveAlpha === 'boolean' ? input.preserveAlpha : true,
  };
}

function validateDimensions(width, height, budget, label) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
      width < 1 || height < 1 || width > MAX_SIDE || height > MAX_SIDE || width * height > budget) {
    throw new RangeError(`${label}尺寸无效：每边最多 8192 px，总像素最多 ${budget.toLocaleString('en-US')}。请减小输出缩放。`);
  }
}

function pixelData(image) {
  const data = image?.data;
  if ((!ArrayBuffer.isView(data) && !Array.isArray(data)) || data.length !== image.width * image.height * 4) {
    throw new TypeError('图片必须包含与宽高一致的 RGBA 像素数据。');
  }
  return data instanceof Uint8ClampedArray || data instanceof Uint8Array ? data : new Uint8ClampedArray(data);
}

/** Weighted quickselect, reusing small per-block buffers; transparent colors have zero weight. */
function weightedMedian(values, weights, length, total) {
  let low = 0, high = length - 1, target = total / 2;
  const swap = (a, b) => {
    const value = values[a], weight = weights[a];
    values[a] = values[b]; weights[a] = weights[b]; values[b] = value; weights[b] = weight;
  };
  while (low < high) {
    const pivot = values[(low + high) >> 1];
    let left = low, current = low, right = high;
    while (current <= right) {
      if (values[current] < pivot) swap(current++, left++);
      else if (values[current] > pivot) swap(current, right--);
      else current++;
    }
    let below = 0, equal = 0;
    for (let i = low; i < left; i++) below += weights[i];
    for (let i = left; i <= right; i++) equal += weights[i];
    if (target < below) high = left - 1;
    else if (target < below + equal) return pivot;
    else { target -= below + equal; low = right + 1; }
  }
  return values[low];
}

function sampleGrid(source, width, height, options) {
  const ps = options.pixelSize, gridWidth = Math.ceil(width / ps), gridHeight = Math.ceil(height / ps);
  const out = new Uint8ClampedArray(gridWidth * gridHeight * 4);
  const dominant = options.sampling === 'dominant', median = options.sampling === 'median';
  const binWeight = dominant ? new Float64Array(4096) : null;
  const binR = dominant ? new Float64Array(4096) : null;
  const binG = dominant ? new Float64Array(4096) : null;
  const binB = dominant ? new Float64Array(4096) : null;
  const touched = dominant ? new Uint16Array(ps * ps) : null;
  const channels = median ? Array.from({ length: 3 }, () => new Uint8Array(ps * ps)) : null;
  const weights = median ? Array.from({ length: 3 }, () => new Float64Array(ps * ps)) : null;
  for (let gy = 0; gy < gridHeight; gy++) {
    const y0 = gy * ps, y1 = Math.min(y0 + ps, height);
    for (let gx = 0; gx < gridWidth; gx++) {
      const x0 = gx * ps, x1 = Math.min(x0 + ps, width);
      let alpha = 0, sr = 0, sg = 0, sb = 0, seen = 0, count = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0, at = (y * width + x0) * 4; x < x1; x++, at += 4) {
          let r = source[at], g = source[at + 1], b = source[at + 2], a = source[at + 3];
          if (!options.preserveAlpha) {
            r = Math.round((r * a + 255 * (255 - a)) / 255);
            g = Math.round((g * a + 255 * (255 - a)) / 255);
            b = Math.round((b * a + 255 * (255 - a)) / 255);
            a = 255;
          }
          alpha += a;
          if (!a) continue;
          sr += r * a; sg += g * a; sb += b * a;
          if (dominant) {
            const key = (r >> 4) * 256 + (g >> 4) * 16 + (b >> 4);
            if (!binWeight[key]) touched[seen++] = key;
            binWeight[key] += a; binR[key] += r * a; binG[key] += g * a; binB[key] += b * a;
          } else if (median) {
            channels[0][count] = r; channels[1][count] = g; channels[2][count] = b;
            weights[0][count] = weights[1][count] = weights[2][count] = a;
            count++;
          }
        }
      }
      const at = (gy * gridWidth + gx) * 4;
      const outAlpha = Math.round(alpha / ((x1 - x0) * (y1 - y0)));
      if (outAlpha) {
        if (dominant) {
          let best = touched[0];
          for (let i = 1; i < seen; i++) if (binWeight[touched[i]] > binWeight[best]) best = touched[i];
          out[at] = Math.round(binR[best] / binWeight[best]);
          out[at + 1] = Math.round(binG[best] / binWeight[best]);
          out[at + 2] = Math.round(binB[best] / binWeight[best]);
        } else if (median) {
          for (let channel = 0; channel < 3; channel++) out[at + channel] = weightedMedian(channels[channel], weights[channel], count, alpha);
        } else {
          out[at] = Math.round(sr / alpha); out[at + 1] = Math.round(sg / alpha); out[at + 2] = Math.round(sb / alpha);
        }
        out[at + 3] = outAlpha;
      }
      if (dominant) for (let i = 0; i < seen; i++) {
        const key = touched[i]; binWeight[key] = binR[key] = binG[key] = binB[key] = 0;
      }
    }
  }
  return { width: gridWidth, height: gridHeight, data: out };
}

const rgbKey = (r, g, b) => r * 65536 + g * 256 + b;
const binKey = (r, g, b) => (r >> 3) * 1024 + (g >> 3) * 32 + (b >> 3);

function colorBox(entries) {
  let weight = 0;
  const min = [255, 255, 255], max = [0, 0, 0];
  for (const entry of entries) {
    weight += entry.weight;
    for (let c = 0; c < 3; c++) {
      min[c] = Math.min(min[c], entry.rgb[c]); max[c] = Math.max(max[c], entry.rgb[c]);
    }
  }
  const ranges = max.map((value, c) => (value - min[c]) ** 2 * [0.3, 0.59, 0.11][c]);
  const axis = ranges.indexOf(Math.max(...ranges));
  return { entries, weight, axis, score: entries.length > 1 ? weight * ranges.reduce((a, b) => a + b, 0) : 0 };
}

function medianCut(entries, maximum) {
  const boxes = [colorBox(entries)];
  while (boxes.length < maximum) {
    let best = -1;
    for (let i = 0; i < boxes.length; i++) if (boxes[i].score > 0 && (best < 0 || boxes[i].score > boxes[best].score)) best = i;
    if (best < 0) break;
    const box = boxes[best], list = box.entries.sort((a, b) => a.rgb[box.axis] - b.rgb[box.axis]);
    let sum = 0, split = 1;
    for (let i = 0; i < list.length - 1; i++) {
      sum += list[i].weight; split = i + 1;
      if (sum >= box.weight / 2) break;
    }
    boxes[best] = colorBox(list.slice(0, split));
    boxes.push(colorBox(list.slice(split)));
  }
  const unique = new Map();
  for (const box of boxes) {
    const rgb = [0, 0, 0];
    for (const entry of box.entries) for (let c = 0; c < 3; c++) rgb[c] += entry.rgb[c] * entry.weight;
    const [r, g, b] = rgb.map(value => Math.round(value / box.weight));
    unique.set(rgbKey(r, g, b), { r, g, b });
  }
  return [...unique.values()];
}

/** A bounded 5-bit histogram avoids allocating millions of unique-color objects. */
function limitColors(data, maximum) {
  const exact = new Map();
  let hasManyColors = false;
  const weight = new Float64Array(32768), red = new Float64Array(32768), green = new Float64Array(32768), blue = new Float64Array(32768);
  for (let at = 0; at < data.length; at += 4) {
    const alpha = data[at + 3];
    if (!alpha) continue;
    const r = data[at], g = data[at + 1], b = data[at + 2];
    if (!hasManyColors) {
      exact.set(rgbKey(r, g, b), { r, g, b });
      if (exact.size > maximum) { hasManyColors = true; exact.clear(); }
    }
    const key = binKey(r, g, b);
    weight[key] += alpha; red[key] += r * alpha; green[key] += g * alpha; blue[key] += b * alpha;
  }
  if (!hasManyColors) return [...exact.values()];
  const entries = [];
  for (let key = 0; key < weight.length; key++) if (weight[key]) {
    entries.push({ key, weight: weight[key], rgb: [red[key] / weight[key], green[key] / weight[key], blue[key] / weight[key]] });
  }
  const palette = medianCut(entries, maximum);
  const lookup = new Uint16Array(32768);
  for (const entry of entries) {
    let nearest = 0, distance = Infinity;
    for (let i = 0; i < palette.length; i++) {
      const color = palette[i];
      const d = (entry.rgb[0] - color.r) ** 2 * 0.3 + (entry.rgb[1] - color.g) ** 2 * 0.59 + (entry.rgb[2] - color.b) ** 2 * 0.11;
      if (d < distance) { distance = d; nearest = i; }
    }
    lookup[entry.key] = nearest;
  }
  const used = new Map();
  for (let at = 0; at < data.length; at += 4) if (data[at + 3]) {
    const color = palette[lookup[binKey(data[at], data[at + 1], data[at + 2])]];
    data[at] = color.r; data[at + 1] = color.g; data[at + 2] = color.b;
    used.set(rgbKey(color.r, color.g, color.b), color);
  }
  return [...used.values()];
}

/**
 * Input is already scaled by the UI. outputSize is metadata only here.
 * Grid-aligned output extends the final cell; otherwise its last row/column is clipped.
 */
export function convertPixels(image, inputOptions = {}) {
  if (!image || typeof image !== 'object') throw new TypeError('请选择有效图片。');
  validateDimensions(image.width, image.height, MAX_INPUT_PIXELS, '输入图片');
  const source = pixelData(image), options = normalizeConversionOptions(inputOptions);
  const outputWidth = options.gridAlign ? Math.ceil(image.width / options.pixelSize) * options.pixelSize : image.width;
  const outputHeight = options.gridAlign ? Math.ceil(image.height / options.pixelSize) * options.pixelSize : image.height;
  validateDimensions(outputWidth, outputHeight, MAX_OUTPUT_PIXELS, '输出图片');
  const result = sampleGrid(source, image.width, image.height, options);
  const palette = limitColors(result.data, options.colorCount);
  return { ...result, outputWidth, outputHeight, sourceWidth: image.width, sourceHeight: image.height,
    pixelSize: options.pixelSize, colors: palette.length, palette };
}

/** Integer SVG rectangles match the PNG cell geometry and preserve independent alpha. */
export function conversionToSvg(result) {
  if (!result || typeof result !== 'object') throw new TypeError('请先生成转换结果。');
  validateDimensions(result.outputWidth, result.outputHeight, MAX_OUTPUT_PIXELS, 'SVG 输出');
  validateDimensions(result.width, result.height, MAX_INPUT_PIXELS, '像素网格');
  const data = pixelData(result), ps = result.pixelSize;
  if (!Number.isSafeInteger(ps) || ps < 2 || ps > 32 ||
      Math.ceil(result.outputWidth / ps) !== result.width || Math.ceil(result.outputHeight / ps) !== result.height) {
    throw new RangeError('SVG 网格与输出尺寸不一致，请重新转换。');
  }
  const rectangles = [];
  const colorHex = (r, g, b) => '#' + [r, g, b].map(value => value.toString(16).padStart(2, '0')).join('');
  for (let y = 0; y < result.height; y++) {
    for (let x = 0; x < result.width;) {
      const at = (y * result.width + x) * 4, alpha = data[at + 3];
      if (!alpha) { x++; continue; }
      const start = x, r = data[at], g = data[at + 1], b = data[at + 2];
      x++;
      while (x < result.width) {
        const next = (y * result.width + x) * 4;
        if (data[next] !== r || data[next + 1] !== g || data[next + 2] !== b || data[next + 3] !== alpha) break;
        x++;
      }
      if (rectangles.length >= MAX_SVG_RECTS) {
        throw new RangeError('SVG 色块超过 100,000 个，请增大像素块或改用 PNG 导出。');
      }
      const width = Math.min(x * ps, result.outputWidth) - start * ps;
      const height = Math.min(ps, result.outputHeight - y * ps);
      const opacity = alpha === 255 ? '' : ` fill-opacity="${Number((alpha / 255).toFixed(6))}"`;
      rectangles.push(`<rect x="${start * ps}" y="${y * ps}" width="${width}" height="${height}" fill="${colorHex(r, g, b)}"${opacity}/>`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${result.outputWidth}" height="${result.outputHeight}" viewBox="0 0 ${result.outputWidth} ${result.outputHeight}" shape-rendering="crispEdges">${rectangles.join('')}</svg>`;
}
