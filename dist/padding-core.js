/* Integer geometry for transparent padding and nearest-neighbor resizing. */
const MAX_SIDE = 8192;
const MAX_PIXELS = 32 * 1024 * 1024;
const MAX_RATIO = 10000;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

function integer(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label}必须是 ${minimum}～${maximum} 之间的整数。`);
  }
  return value;
}

function dimensions(width, height, label) {
  integer(width, `${label}宽度`, 1, MAX_SIDE);
  integer(height, `${label}高度`, 1, MAX_SIDE);
  if (width * height > MAX_PIXELS) {
    throw new RangeError(`${label}总像素不能超过 32 × 1024 × 1024；请减小目标尺寸或留白。`);
  }
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label}必须是有效对象。`);
  }
}

function validBounds(bounds, width, height) {
  if (bounds == null) return null;
  object(bounds, '可见像素边界');
  integer(bounds.x, '边界 X', 0, width - 1);
  integer(bounds.y, '边界 Y', 0, height - 1);
  integer(bounds.width, '边界宽度', 1, width);
  integer(bounds.height, '边界高度', 1, height);
  if (bounds.x + bounds.width > width || bounds.y + bounds.height > height) {
    throw new RangeError('可见像素边界不能超出原画布。');
  }
  return bounds;
}

function gcd(a, b) {
  while (b) [a, b] = [b, a % b];
  return a;
}

// Python's round uses ties-to-even. Math.round would make e.g. 2.5 into 3,
// changing a contained sprite's size and its transparent border by one pixel.
function roundEven(value) {
  const lower = Math.floor(value);
  return value - lower === 0.5 ? lower + lower % 2 : Math.round(value);
}

/**
 * Find the bounding box of every alpha > 0 pixel, including faint edge pixels.
 * x + width and y + height are exclusive right/bottom boundaries.
 * A fully transparent image returns null. Input pixels are never modified.
 */
export function findAlphaBounds(image) {
  object(image, '图片数据');
  const { width, height, data } = image;
  dimensions(width, height, '图片');
  if ((!ArrayBuffer.isView(data) && !Array.isArray(data)) || data.length !== width * height * 4) {
    throw new TypeError('图片必须包含与宽高一致的 RGBA 像素数据。');
  }
  let left = width, top = height, right = -1, bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0, alpha = (y * width) * 4 + 3; x < width; x++, alpha += 4) {
      if (data[alpha] > 0) {
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
  }
  return right < 0 ? null : { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

/**
 * Plan either a canvas expansion or an explicit resize with optional containment.
 * centerX/Y are source-space coordinates; offsetX/Y move the entire source.
 * A half-pixel center discrepancy is unavoidable for some odd/even dimensions.
 * margin is minimum visible-content whitespace, not extra whitespace per click.
 * For empty images the source canvas is the fallback subject and center.
 */
export function planPadding(source, options = {}) {
  object(source, '原图');
  object(options, '扩边参数');
  const { width: sourceWidth, height: sourceHeight } = source;
  dimensions(sourceWidth, sourceHeight, '原图');
  const bounds = validBounds(source.bounds, sourceWidth, sourceHeight);
  const mode = options.mode ?? 'ratio';
  if (mode === 'resize') {
    const width = options.resizeWidth ?? 48;
    const height = options.resizeHeight ?? 48;
    dimensions(width, height, '目标');
    const fit = options.resizeFit ?? 'stretch';
    if (!['stretch', 'contain'].includes(fit)) {
      throw new RangeError('缩放方式必须是直接拉伸或保持比例。');
    }
    let contentWidth = width, contentHeight = height;
    if (fit === 'contain') {
      const scale = Math.min(width / sourceWidth, height / sourceHeight);
      contentWidth = clamp(roundEven(sourceWidth * scale), 1, width);
      contentHeight = clamp(roundEven(sourceHeight * scale), 1, height);
    }
    const offsetX = Math.floor((width - contentWidth) / 2);
    const offsetY = Math.floor((height - contentHeight) / 2);
    return {
      operation: 'resize', width, height, contentWidth, contentHeight,
      scaleX: contentWidth / sourceWidth, scaleY: contentHeight / sourceHeight,
      offsetX, offsetY,
      left: offsetX, right: width - contentWidth - offsetX,
      top: offsetY, bottom: height - contentHeight - offsetY,
      centerX: sourceWidth / 2, centerY: sourceHeight / 2, empty: !bounds,
      changed: width !== sourceWidth || height !== sourceHeight ||
        contentWidth !== sourceWidth || contentHeight !== sourceHeight,
      minWidth: 1, minHeight: 1,
    };
  }
  const center = options.center ?? 'content';
  if (!['ratio', 'scale', 'size'].includes(mode)) throw new RangeError('请选择比例、倍数、指定尺寸扩边或宽高缩放模式。');
  if (!['content', 'canvas'].includes(center)) throw new RangeError('居中方式必须是主体中心或画布中心。');
  const margin = integer(options.margin ?? 0, '最少留白', 0, MAX_SIDE);
  const subject = bounds ?? { x: 0, y: 0, width: sourceWidth, height: sourceHeight };
  const centerX = center === 'content' && bounds ? bounds.x + bounds.width / 2 : sourceWidth / 2;
  const centerY = center === 'content' && bounds ? bounds.y + bounds.height / 2 : sourceHeight / 2;

  // Required padding considers existing transparent margins before adding pixels.
  const requiredLeft = Math.max(0, margin - subject.x);
  const requiredRight = Math.max(0, margin - (sourceWidth - subject.x - subject.width));
  const requiredTop = Math.max(0, margin - subject.y);
  const requiredBottom = Math.max(0, margin - (sourceHeight - subject.y - subject.height));
  // The -1 permits <= 0.5px discrete centering error. Without it an odd/even
  // mismatch can repeatedly grow an already-padded image by a ratio increment.
  const minWidth = Math.max(sourceWidth + requiredLeft + requiredRight,
    Math.ceil(2 * Math.max(centerX + requiredLeft, sourceWidth - centerX + requiredRight) - 1));
  const minHeight = Math.max(sourceHeight + requiredTop + requiredBottom,
    Math.ceil(2 * Math.max(centerY + requiredTop, sourceHeight - centerY + requiredBottom) - 1));
  let width, height;

  if (mode === 'ratio') {
    const ratioWidth = integer(options.ratioWidth ?? 1, '比例宽度', 1, MAX_RATIO);
    const ratioHeight = integer(options.ratioHeight ?? 1, '比例高度', 1, MAX_RATIO);
    const divisor = gcd(ratioWidth, ratioHeight);
    const p = ratioWidth / divisor, q = ratioHeight / divisor;
    const factor = Math.max(1, Math.ceil(minWidth / p), Math.ceil(minHeight / q));
    width = p * factor;
    height = q * factor;
  } else if (mode === 'scale') {
    const scale = options.scale ?? 1.5;
    if (typeof scale !== 'number' || !Number.isFinite(scale) || scale < 1) {
      throw new RangeError('画布扩充倍数必须是大于或等于 1 的有限数字。');
    }
    width = Math.max(minWidth, Math.ceil(sourceWidth * scale));
    height = Math.max(minHeight, Math.ceil(sourceHeight * scale));
  } else {
    width = options.targetWidth ?? 400;
    height = options.targetHeight ?? 200;
    dimensions(width, height, '目标');
    if (width < minWidth || height < minHeight) {
      throw new RangeError(`目标尺寸 ${width} × ${height} px 不足；至少需要 ${minWidth} × ${minHeight} px，才能完整保留原图、自动居中并满足留白。`);
    }
  }
  dimensions(width, height, '目标');
  const offsetX = clamp(Math.round(width / 2 - centerX), requiredLeft, width - sourceWidth - requiredRight);
  const offsetY = clamp(Math.round(height / 2 - centerY), requiredTop, height - sourceHeight - requiredBottom);
  return {
    width, height, offsetX, offsetY,
    left: offsetX, right: width - sourceWidth - offsetX,
    top: offsetY, bottom: height - sourceHeight - offsetY,
    centerX, centerY, empty: !bounds,
    changed: width !== sourceWidth || height !== sourceHeight || offsetX !== 0 || offsetY !== 0,
    minWidth, minHeight,
  };
}
