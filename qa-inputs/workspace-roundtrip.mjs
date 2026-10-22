import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const nativePath = require.resolve('@napi-rs/canvas', { paths: [process.cwd(), process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES].filter(Boolean) });
const { createCanvas, ImageData, loadImage } = require(nativePath);
globalThis.ImageData = ImageData;
globalThis.createImageBitmap = async blob => loadImage(Buffer.from(await blob.arrayBuffer()));

// Only the download affordance is mocked. PNG encoding, decoding, drawing,
// layer serialization and project reading below use real native canvas and the
// application's unmodified core.js / io.js modules.
const elements = [];
const objectURLs = new Map();
const downloads = [];
let urlSequence = 0;
URL.createObjectURL = blob => { const url = `blob:roundtrip-${++urlSequence}`; objectURLs.set(url, blob); return url; };
URL.revokeObjectURL = url => objectURLs.delete(url);
function element(tag) {
  const node = {
    tag, style: {}, children: [],
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    setAttribute(key, value) { this[key] = value; },
    remove() { this.removed = true; },
    click() { if (tag === 'a' && this.download) downloads.push({ name: this.download, blob: objectURLs.get(this.href) }); },
  };
  elements.push(node);
  return node;
}
globalThis.document = {
  body: element('body'),
  createElement(tag) { return tag === 'canvas' ? createCanvas(1, 1) : element(tag); },
  getElementById(id) { return elements.find(node => !node.removed && node.id === id) || null; },
};
const timeout = globalThis.setTimeout;
globalThis.setTimeout = (...args) => { const timer = timeout(...args); timer.unref?.(); return timer; };

const { PaintDocument, makeCanvas, composite } = await import('../dist/core.js');
const { saveWorkspace, loadWorkspace } = await import('../dist/io.js');
const pixelBytes = canvas => [...canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data];

const first = new PaintDocument({ name: '透明多图层.png', width: 4, height: 3 });
first.path = 'sprites/透明多图层.png';
first.layers[0].name = '基础像素';
const base = first.layers[0].canvas.getContext('2d');
base.fillStyle = '#e08020'; base.fillRect(0, 0, 2, 2);
base.fillStyle = '#2080c0'; base.fillRect(2, 2, 1, 1);
first.layers[0].opacity = .8;
const upper = first.addLayer('半透明叠色');
const upperImage = new ImageData(new Uint8ClampedArray([
  255,0,0,128, 0,255,0,64, 0,0,255,255, 0,0,0,0,
  255,255,255,255, 0,0,0,0, 255,0,255,192, 0,0,0,0,
  0,0,0,0, 0,255,255,128, 255,255,0,255, 0,0,0,0,
]), 4, 3);
upper.canvas.getContext('2d').putImageData(upperImage, 0, 0);
upper.opacity = .65; upper.blend = 'multiply'; upper.locked = true;
first.commit('设置混合图层');
const second = new PaintDocument({ name: '第二张.png', width: 3, height: 2 });
second.layers[0].canvas.getContext('2d').fillStyle = '#a0b0c0';
second.layers[0].canvas.getContext('2d').fillRect(1, 0, 1, 1);
second.layers[0].blend = 'screen';
second.layers[0].visible = false;
second.commit('设置隐藏图层');

const sceneCanvas = makeCanvas(2, 2);
sceneCanvas.getContext('2d').fillStyle = '#ff0';
sceneCanvas.getContext('2d').fillRect(0, 0, 1, 1);
const settings = {
  referenceMode: 'relative', baseWidth: 4, baseHeight: 3,
  activeDocId: second.id, showGuides: true, snapToGuides: true,
  showGrid: true, gridSize: 3, workspaceName: '融合工程往返校验', pixelDisplay: true,
  workbench: {
    version: 1, mode: 'optimize',
    composer: {
      format: 'art-workbench-composition', version: 1, name: '拼接场景校验',
      assets: [{ id: 'scene-asset-1', name: '透明拼接源图', src: sceneCanvas.toDataURL('image/png'), w: 2, h: 2 }],
      layers: [{ id: 'scene-layer-1', assetId: 'scene-asset-1', name: '图层', x: -7, y: 23, w: 12, h: 12, rotation: 30, opacity: .75, visible: true, locked: false, flipX: true, flipY: false }],
      view: { x: 29, y: 42, z: 2.5 },
      settings: { background: 'transparent', pixel: true, snap: true, gap: 8, columns: 3, normalize: false, padding: 0, showGuides: true },
    },
    optimizer: {
      options: { gridSize: 3, offsetX: 1, offsetY: 2, sampling: 'dominant', paletteSize: 32, alphaMode: 'binary', alphaThreshold: 45, denoise: true },
      sourceMode: 'layer', view: 'side', grid: true, background: 'checker', exportScale: 4,
    },
  },
};
const guides = [
  { id: 'h1', type: 'h', x: 0, y: 2, label: '基线', color: '#00aaff', visible: true, locked: true },
  { id: 'p1', type: 'point', x: 2, y: 1, label: '锚点', color: '#ffaa00', visible: true, locked: false },
];
const originals = [first, second];
const saved = await saveWorkspace(originals, guides, settings);
assert.equal(downloads.length, 1, 'The real downloadBlob must receive one full-project blob');
const { blob, name } = downloads[0];
assert(blob instanceof Blob);
assert.equal(name, '融合工程往返校验.paintspace');
assert.equal(saved.size, blob.size);
const raw = JSON.parse(await blob.text());
assert.equal(raw.kind, 'paint-studio-workspace');
assert.equal(raw.version, 1);
assert.equal(raw.docs.length, 2);
assert.equal(raw.docs[0].layers.length, 2);
assert.equal(raw.docs[0].layers[1].blend, 'multiply');
assert(raw.docs[0].layers[1].data.startsWith('data:image/png;base64,'));
assert.deepEqual(raw.settings.workbench, settings.workbench, 'Saved workbench object must preserve every field and embedded image');

const restored = await loadWorkspace(blob);
assert.equal(restored.docs.length, originals.length);
assert.deepEqual(restored.guides, guides);
assert.deepEqual(restored.settings, settings, 'Settings roundtrip must preserve workbench, optimizer and active document');
for (let i = 0; i < originals.length; i++) {
  const before = originals[i], after = restored.docs[i];
  assert.equal(after.id, before.id);
  assert.equal(after.name, before.name);
  assert.equal(after.path || '', before.path || '');
  assert.equal(after.width, before.width);
  assert.equal(after.height, before.height);
  assert.equal(after.activeLayerId, before.activeLayerId);
  assert.equal(after.layers.length, before.layers.length);
  assert.equal(after.fileHandle, null);
  assert.equal(after.dirty, false);
  assert.equal(after.canUndo, false, 'Opening must establish one history baseline');
  for (let j = 0; j < before.layers.length; j++) {
    const left = before.layers[j], right = after.layers[j];
    for (const key of ['id', 'name', 'visible', 'opacity', 'locked', 'blend']) assert.equal(right[key], left[key], `layer ${i}/${j} metadata ${key}`);
    assert.deepEqual(pixelBytes(right.canvas), pixelBytes(left.canvas), `layer ${i}/${j} RGBA must survive PNG encoding and decoding byte for byte`);
  }
  assert.deepEqual(pixelBytes(composite(after)), pixelBytes(composite(before)), `document ${i} blended appearance must survive exactly`);
}
const alpha = pixelBytes(restored.docs[0].layers[1].canvas).filter((_, index) => index % 4 === 3);
assert(alpha.includes(0) && alpha.includes(64) && alpha.includes(128) && alpha.includes(192) && alpha.includes(255));
const fixturePath = new URL('./workspace-roundtrip.paintspace', import.meta.url);
await writeFile(fixturePath, Buffer.from(await blob.arrayBuffer()));
console.log(JSON.stringify({ passed: true, bytes: blob.size, documents: restored.docs.length, layers: restored.docs.reduce((n, d) => n + d.layers.length, 0), checks: ['transparent and fractional-alpha RGBA bytes', 'multiply and screen blend metadata', 'composited output bytes', 'layer visibility/lock/opacity/order/id', 'active layer and active document', 'source paths and names', 'reference points and lines', 'embedded composition PNG and transforms', 'optimizer parameters and export settings', 'restored history baseline'], fixture: fixturePath.pathname, limitation: 'The DOM download click is a mock. This verifies the generated artifact and native PNG serialization, not the cloud browser download delivery.' }, null, 2));
