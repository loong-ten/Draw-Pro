/** Pixelroom's alpha-aware four-neighbour sharpen, kept independent of the UI. */
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

export function sharpenRgba(source, width, height, amount = .6) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || source.length !== width * height * 4) throw new Error('锐化像素数据无效。');
  amount = clamp(Number(amount) || 0, 0, 2);
  const output = new Uint8ClampedArray(source.length);
  if (!amount) { output.set(source); return output; }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      output[p + 3] = source[p + 3];
      if (!source[p + 3]) continue;
      const left = (y * width + Math.max(0, x - 1)) * 4;
      const right = (y * width + Math.min(width - 1, x + 1)) * 4;
      const top = (Math.max(0, y - 1) * width + x) * 4;
      const bottom = (Math.min(height - 1, y + 1) * width + x) * 4;
      for (let c = 0; c < 3; c++) {
        const value = source[p + c];
        const difference = (value - source[left + c]) * source[left + 3] / 255
          + (value - source[right + c]) * source[right + 3] / 255
          + (value - source[top + c]) * source[top + 3] / 255
          + (value - source[bottom + c]) * source[bottom + 3] / 255;
        output[p + c] = clamp(Math.round(value + difference * amount), 0, 255);
      }
    }
  }
  return output;
}

export function sharpenCanvas(canvas, amount = .6) {
  const source = canvas.getContext('2d', {willReadFrequently:true}).getImageData(0, 0, canvas.width, canvas.height);
  const result = document.createElement('canvas');
  result.width = canvas.width; result.height = canvas.height;
  const ctx = result.getContext('2d');
  const pixels = ctx.createImageData(result.width, result.height);
  pixels.data.set(sharpenRgba(source.data, canvas.width, canvas.height, amount));
  ctx.putImageData(pixels, 0, 0);
  return result;
}
