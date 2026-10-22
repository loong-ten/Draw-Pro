import { PaintDocument, makeCanvas, uid } from './core.js';

const DATABASE = 'paintstudio-workspace-v1';
const STORE = 'drafts';
const KEY = 'latest';
const MAX_BYTES = 150 * 1024 * 1024;
const MAX_PIXELS = 32 * 1024 * 1024;
const MAX_LAYER_PIXELS = 128 * 1024 * 1024;
let databasePromise = null;
let generation = 0;

function failure(message, code = 'DRAFT_ERROR', cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function storageFailure(error) {
  if (error?.code?.startsWith?.('DRAFT_')) return error;
  if (error?.name === 'QuotaExceededError') return failure('浏览器的本地存储空间不足，自动恢复草稿未更新。请保存工作区文件或释放存储空间。', 'DRAFT_QUOTA', error);
  if (error?.name === 'SecurityError' || error?.name === 'InvalidStateError') return failure('浏览器限制了本地草稿存储，请手动保存工作区文件。', 'DRAFT_UNAVAILABLE', error);
  return failure(`本地恢复草稿操作失败：${error?.message || '无法访问浏览器存储。'}`, 'DRAFT_STORAGE', error);
}

function openDatabase() {
  if (databasePromise) return databasePromise;
  if (!globalThis.indexedDB) return Promise.reject(failure('此浏览器不支持本地恢复草稿。', 'DRAFT_UNAVAILABLE'));
  databasePromise = new Promise((resolve, reject) => {
    let settled = false;
    let request;
    try { request = indexedDB.open(DATABASE, 1); }
    catch (error) { reject(storageFailure(error)); return; }
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onerror = () => { settled = true; reject(storageFailure(request.error)); };
    request.onblocked = () => {
      settled = true;
      reject(failure('另一标签页暂时阻塞了草稿数据库，请关闭旧标签页后重试。', 'DRAFT_BLOCKED'));
    };
    request.onsuccess = () => {
      const db = request.result;
      if (settled) { db.close(); return; }
      db.onversionchange = () => { db.close(); databasePromise = null; };
      db.onclose = () => { databasePromise = null; };
      resolve(db);
    };
  }).catch(error => { databasePromise = null; throw error; });
  return databasePromise;
}

function dimensions(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 8192 || height > 8192 || width * height > MAX_PIXELS) {
    throw failure('草稿画布尺寸无效：每边最多 8192 像素，总面积最多 3200 万像素。', 'DRAFT_INVALID');
  }
}

function plainSettings(settings = {}) {
  // JSON copying intentionally excludes handles, functions, prototypes and UI
  // references, while allowing the host to add ordinary view preferences.
  let copy;
  try {
    const text = JSON.stringify(settings, (key, value) => {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) return undefined;
      if (typeof value === 'number' && !Number.isFinite(value)) return null;
      return value;
    });
    if (text.length > 256 * 1024) throw new Error('设置数据过大');
    copy = JSON.parse(text);
  } catch (error) {
    throw failure('工作区设置无法保存为恢复草稿。', 'DRAFT_INVALID', error);
  }
  if (!copy || Array.isArray(copy) || typeof copy !== 'object') return {};
  return copy;
}

function copyGuides(guides) {
  if (!Array.isArray(guides) || guides.length > 1000) throw failure('恢复草稿最多支持 1000 个参考标记。', 'DRAFT_INVALID');
  return guides.map((guide, index) => {
    if (!guide || !['h', 'v', 'point'].includes(guide.type) || !Number.isFinite(guide.x ?? 0) || !Number.isFinite(guide.y ?? 0)) throw failure('参考标记数据无效，草稿未更新。', 'DRAFT_INVALID');
    return {
      id: String(guide.id || `guide-${index}`).slice(0, 100),
      type: guide.type, x: Number(guide.x || 0), y: Number(guide.y || 0),
      label: String(guide.label || '').slice(0, 120), color: String(guide.color || '#ea7544').slice(0, 64),
      locked: Boolean(guide.locked), visible: guide.visible !== false,
    };
  });
}

function snapshotBlob(canvas) {
  // The browser snapshots the canvas when toBlob is invoked, even though PNG
  // encoding and this callback complete asynchronously.
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob(blob => {
        if (!blob || blob.type !== 'image/png') reject(failure('图层像素无法编码，恢复草稿未更新。', 'DRAFT_ENCODE'));
        else resolve(blob);
      }, 'image/png');
    } catch (error) {
      reject(failure('图层像素无法读取，恢复草稿未更新。', 'DRAFT_ENCODE', error));
    }
  });
}

function validateDocuments(docs, live = false) {
  if (!Array.isArray(docs) || docs.length > 500) throw failure('恢复草稿最多支持 500 张图片。', 'DRAFT_INVALID');
  let totalPixels = 0;
  const ids = new Set();
  for (const doc of docs) {
    dimensions(doc?.width, doc?.height);
    if (!Array.isArray(doc.layers) || doc.layers.length < 1 || doc.layers.length > 50) throw failure('每张图片最多支持 50 个图层。', 'DRAFT_INVALID');
    const id = String(doc.id || '');
    if (!id || ids.has(id)) throw failure('图片标识缺失或重复，恢复草稿未更新。', 'DRAFT_INVALID');
    ids.add(id);
    const layerIds = new Set();
    for (const layer of doc.layers) {
      const layerId = String(layer?.id || '');
      if (!layerId || layerIds.has(layerId)) throw failure('图层标识缺失或重复，恢复草稿未更新。', 'DRAFT_INVALID');
      layerIds.add(layerId);
      if (live && (!layer.canvas || layer.canvas.width !== doc.width || layer.canvas.height !== doc.height || typeof layer.canvas.toBlob !== 'function')) throw failure('图层与画布尺寸不一致，恢复草稿未更新。', 'DRAFT_INVALID');
    }
    totalPixels += doc.width * doc.height * doc.layers.length;
  }
  if (totalPixels > MAX_LAYER_PIXELS) throw failure('当前工作区图层像素过多，无法创建完整恢复草稿。请手动保存并拆分工作区。', 'DRAFT_TOO_LARGE');
}

function writeRecord(db, payload) {
  return new Promise((resolve, reject) => {
    let transaction;
    try {
      transaction = db.transaction(STORE, 'readwrite');
      transaction.objectStore(STORE).put(payload, KEY);
    } catch (error) { reject(storageFailure(error)); return; }
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(storageFailure(transaction.error));
    transaction.onerror = () => { /* onabort reports failure after atomic rollback */ };
  });
}

/** Atomically replaces the last complete snapshot; never writes partial layers. */
export async function saveDraft(docs, guides, settings = {}) {
  const currentGeneration = ++generation;
  validateDocuments(docs, true);
  const guideSnapshot = copyGuides(guides || []);
  const settingsSnapshot = plainSettings(settings);
  const savedAt = new Date().toISOString();
  const pending = [];
  const documentSnapshots = docs.map(doc => ({
    id: String(doc.id), name: String(doc.name || '未命名.png').slice(0, 180),
    path: String(doc.path || '').slice(0, 1000), width: doc.width, height: doc.height,
    activeLayerId: String(doc.activeLayerId || ''), dirty: Boolean(doc.dirty), isDemo: Boolean(doc.isDemo),
    revision: Number.isFinite(doc.revision) ? doc.revision : 0,
    layers: doc.layers.map(layer => {
      const snapshot = {
        id: String(layer.id), name: String(layer.name || '图层').slice(0, 120),
        visible: layer.visible !== false, locked: Boolean(layer.locked),
        opacity: Number.isFinite(layer.opacity) ? Math.max(0, Math.min(1, layer.opacity)) : 1,
        blob: null,
      };
      // Invoke for every layer now, before the first await in saveDraft.
      pending.push(snapshotBlob(layer.canvas).then(blob => { snapshot.blob = blob; }));
      return snapshot;
    }),
  }));
  await Promise.all(pending);
  if (currentGeneration !== generation) return { skipped: true };
  const bytes = documentSnapshots.reduce((sum, doc) => sum + doc.layers.reduce((layerSum, layer) => layerSum + layer.blob.size, 0), 0);
  if (bytes > MAX_BYTES) throw failure('完整恢复草稿超过 150 MB，未替换上一次草稿。请手动保存并拆分工作区。', 'DRAFT_TOO_LARGE');
  const payload = { kind: 'paintstudio-draft', version: 1, savedAt, bytes, docs: documentSnapshots, guides: guideSnapshot, settings: settingsSnapshot };
  const db = await openDatabase();
  if (currentGeneration !== generation) return { skipped: true };
  // No await between generation verification and starting the transaction. IDB
  // serializes readwrite transactions, so a newer save will always follow it.
  await writeRecord(db, payload);
  return { savedAt, bytes, documents: documentSnapshots.length, skipped: false };
}

function getRecord(db) {
  return new Promise((resolve, reject) => {
    let transaction;
    let request;
    try {
      transaction = db.transaction(STORE, 'readonly');
      request = transaction.objectStore(STORE).get(KEY);
    } catch (error) { reject(storageFailure(error)); return; }
    transaction.oncomplete = () => resolve(request.result ?? null);
    transaction.onabort = () => reject(storageFailure(transaction.error || request.error));
    transaction.onerror = () => { /* handled by onabort */ };
  });
}

async function restoreCanvas(blob, width, height) {
  if (!(blob instanceof Blob) || blob.type !== 'image/png') throw failure('恢复草稿的图层像素数据无效。', 'DRAFT_CORRUPT');
  let image;
  let url;
  try {
    if (typeof createImageBitmap === 'function') image = await createImageBitmap(blob);
    else {
      url = URL.createObjectURL(blob);
      image = new Image();
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = reject;
        image.src = url;
      });
    }
    if ((image.naturalWidth || image.width) !== width || (image.naturalHeight || image.height) !== height) throw failure('恢复草稿的图层尺寸不一致。', 'DRAFT_CORRUPT');
    const canvas = makeCanvas(width, height);
    canvas.getContext('2d').drawImage(image, 0, 0);
    return canvas;
  } catch (error) {
    if (error?.code?.startsWith?.('DRAFT_')) throw error;
    throw failure('恢复草稿的图层像素无法解码。', 'DRAFT_CORRUPT', error);
  } finally {
    image?.close?.();
    if (url) URL.revokeObjectURL(url);
  }
}

/** Reads a complete local snapshot without accessing or requesting file handles. */
export async function readDraft() {
  const record = await getRecord(await openDatabase());
  if (!record) return null;
  if (record.kind !== 'paintstudio-draft' || record.version !== 1 || !Number.isFinite(Date.parse(record.savedAt))) throw failure('本地恢复草稿的格式无效。', 'DRAFT_CORRUPT');
  validateDocuments(record.docs);
  const guides = copyGuides(record.guides || []);
  const settings = plainSettings(record.settings || {});
  let bytes = 0;
  for (const doc of record.docs) for (const layer of doc.layers) {
    if (!(layer.blob instanceof Blob)) throw failure('本地恢复草稿缺少图层像素。', 'DRAFT_CORRUPT');
    bytes += layer.blob.size;
  }
  if (bytes > MAX_BYTES) throw failure('本地恢复草稿超过 150 MB，无法恢复。', 'DRAFT_TOO_LARGE');
  const docs = [];
  for (const saved of record.docs) {
    const layers = [];
    for (const layer of saved.layers) {
      layers.push({
        id: String(layer.id || uid()), name: String(layer.name || '图层').slice(0, 120),
        visible: layer.visible !== false, locked: Boolean(layer.locked),
        opacity: Number.isFinite(layer.opacity) ? Math.min(1, Math.max(0, layer.opacity)) : 1,
        canvas: await restoreCanvas(layer.blob, saved.width, saved.height),
      });
    }
    const doc = new PaintDocument({ id: String(saved.id), name: String(saved.name || '未命名.png'), width: saved.width, height: saved.height, canvas: layers[0].canvas });
    doc.layers = layers;
    doc.activeLayerId = layers.some(layer => layer.id === saved.activeLayerId) ? saved.activeLayerId : layers[layers.length - 1].id;
    doc.path = String(saved.path || '').slice(0, 1000);
    doc.fileHandle = null;
    doc.isDemo = Boolean(saved.isDemo);
    if (typeof doc.resetHistory === 'function') doc.resetHistory('恢复工作区');
    else { doc.history = []; doc.historyIndex = -1; doc.commit('恢复工作区'); }
    doc.dirty = Boolean(saved.dirty);
    doc.revision = Number.isFinite(saved.revision) ? saved.revision : 0;
    docs.push(doc);
  }
  return { docs, guides, settings, savedAt: record.savedAt };
}

/** Invalidates pending older encodes, then deletes the recovery record. */
export async function clearDraft() {
  const currentGeneration = ++generation;
  const db = await openDatabase();
  if (currentGeneration !== generation) return { skipped: true };
  await new Promise((resolve, reject) => {
    let transaction;
    try {
      transaction = db.transaction(STORE, 'readwrite');
      transaction.objectStore(STORE).delete(KEY);
    } catch (error) { reject(storageFailure(error)); return; }
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(storageFailure(transaction.error));
    transaction.onerror = () => { /* handled by onabort */ };
  });
  return { cleared: true };
}
