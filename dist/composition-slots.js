/* Source-relative assembly anchors. Positions use the same center/rotate/flip
 * transform as the compositor, while a connection only constrains translation. */
import { clamp, rotateVector } from './composition-geometry.js';

export const MAX_SLOTS = 6;
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 200;
const validPoint = point => point && typeof point.u === 'number' && Number.isFinite(point.u) && typeof point.v === 'number' && Number.isFinite(point.v);
const normalizedPoint = point => validPoint(point) ? { u: clamp(point.u, 0, 1), v: clamp(point.v, 0, 1) } : { u: .5, v: .5 };
const validAttachment = value => value && validId(value.parentId) && validId(value.slotId);

export function normalizeAssemblyFields(raw = {}) {
  const ids = new Set(), slots = [];
  for (const slot of Array.isArray(raw?.slots) ? raw.slots : []) {
    if (slots.length >= MAX_SLOTS) break;
    if (!slot || !validId(slot.id) || ids.has(slot.id) || !validPoint(slot)) continue;
    ids.add(slot.id);
    const name = typeof slot.name === 'string' ? slot.name.trim().slice(0, 40) : '';
    slots.push({ id: slot.id, name: name || '卡槽 ' + (slots.length + 1), ...normalizedPoint(slot) });
  }
  return {
    slots,
    dock: normalizedPoint(raw?.dock),
    attachment: validAttachment(raw?.attachment) ? { parentId: raw.attachment.parentId, slotId: raw.attachment.slotId } : null,
  };
}

export function cloneAssemblyLayer(layer) {
  return { ...layer, ...normalizeAssemblyFields(layer) };
}

export function localPointToWorld(layer, point = { u: .5, v: .5 }) {
  const p = rotateVector((point.u - .5) * layer.w * (layer.flipX ? -1 : 1), (point.v - .5) * layer.h * (layer.flipY ? -1 : 1), layer.rotation || 0);
  return { x: layer.x + layer.w / 2 + p.x, y: layer.y + layer.h / 2 + p.y };
}

export function worldPointToLocal(layer, point) {
  const p = rotateVector(point.x - layer.x - layer.w / 2, point.y - layer.y - layer.h / 2, -(layer.rotation || 0));
  return { u: .5 + p.x * (layer.flipX ? -1 : 1) / layer.w, v: .5 + p.y * (layer.flipY ? -1 : 1) / layer.h };
}

export function slotOccupant(layers, parentId, slotId, exceptId) {
  return layers.find(layer => layer.id !== exceptId && layer.attachment?.parentId === parentId && layer.attachment?.slotId === slotId) || null;
}

export function canAttach(layers, childId, parentId, slotId, { replace = false } = {}) {
  const byId = new Map(layers.map(layer => [layer.id, layer]));
  const child = byId.get(childId), parent = byId.get(parentId);
  if (!child || child.locked || !parent || childId === parentId || !parent.slots?.some(slot => slot.id === slotId && validPoint(slot))) return false;
  // Walking the prospective parent's ancestry also rejects already-corrupt
  // cycles, rather than allowing a new connection into an invalid graph.
  const seen = new Set([childId]);
  let cursor = parent;
  while (cursor) {
    if (seen.has(cursor.id)) return false;
    seen.add(cursor.id);
    cursor = byId.get(cursor.attachment?.parentId);
  }
  const occupant = slotOccupant(layers, parentId, slotId, childId);
  return !occupant || (replace && !occupant.locked);
}

export function detachLayer(layer) {
  if (layer) layer.attachment = null;
  return layer;
}

export function attachLayer(layers, childId, parentId, slotId, options = {}) {
  if (!canAttach(layers, childId, parentId, slotId, options)) return false;
  const child = layers.find(layer => layer.id === childId);
  const occupant = slotOccupant(layers, parentId, slotId, childId);
  if (occupant) detachLayer(occupant);
  child.attachment = { parentId, slotId };
  resolveAttachments(layers);
  return true;
}

export function resolveAttachments(layers) {
  const byId = new Map(layers.map(layer => [layer.id, layer]));
  // Missing layers/slots and malformed imports detach without moving anything.
  for (const layer of layers) {
    const link = layer.attachment, parent = byId.get(link?.parentId);
    if (link && (!validAttachment(link) || !parent || parent.id === layer.id || !parent.slots?.some(slot => slot.id === link.slotId && validPoint(slot)))) detachLayer(layer);
  }
  // Remove every edge inside a cycle. Children outside the cycle can still
  // follow their now-independent parents.
  const checked = new Set();
  for (const start of layers) {
    const path = [], index = new Map();
    let cursor = start;
    while (cursor && !checked.has(cursor.id)) {
      if (index.has(cursor.id)) {
        for (const layer of path.slice(index.get(cursor.id))) detachLayer(layer);
        break;
      }
      index.set(cursor.id, path.length); path.push(cursor);
      cursor = byId.get(cursor.attachment?.parentId);
    }
    for (const layer of path) checked.add(layer.id);
  }
  // Layer order gives duplicate imported claims a deterministic first winner.
  const occupied = new Map();
  for (const layer of layers) {
    if (!layer.attachment) continue;
    const { parentId, slotId } = layer.attachment;
    let slots = occupied.get(parentId);
    if (!slots) { slots = new Set(); occupied.set(parentId, slots); }
    if (slots.has(slotId)) detachLayer(layer);
    else slots.add(slotId);
  }
  const resolved = new Set();
  function resolve(layer) {
    if (resolved.has(layer.id)) return;
    resolved.add(layer.id);
    const link = layer.attachment;
    if (!link) return;
    const parent = byId.get(link.parentId);
    resolve(parent);
    const slot = parent.slots.find(item => item.id === link.slotId);
    const target = localPointToWorld(parent, slot);
    const offset = localPointToWorld({ ...layer, x: 0, y: 0 }, normalizedPoint(layer.dock));
    if (![target.x, target.y, offset.x, offset.y].every(Number.isFinite)) { detachLayer(layer); return; }
    layer.x = target.x - offset.x; layer.y = target.y - offset.y;
  }
  for (const layer of layers) resolve(layer);
  return layers;
}

export function nearestSlot(layers, childId, threshold, { excludeIds = [] } = {}) {
  const child = layers.find(layer => layer.id === childId);
  if (!child || child.locked || child.visible === false || !Number.isFinite(threshold) || threshold < 0) return null;
  const excluded = new Set(excludeIds), anchor = localPointToWorld(child, normalizedPoint(child.dock));
  let nearest = null;
  for (const parent of layers) {
    if (parent.visible === false || excluded.has(parent.id)) continue;
    for (const slot of parent.slots || []) {
      if (!canAttach(layers, childId, parent.id, slot.id)) continue;
      const point = localPointToWorld(parent, slot), distance = Math.hypot(point.x - anchor.x, point.y - anchor.y);
      if (distance <= threshold && (!nearest || distance < nearest.distance)) nearest = { parentId: parent.id, slotId: slot.id, point, distance };
    }
  }
  return nearest;
}

export function attachmentDescendants(layers, ids) {
  const result = new Set(ids);
  let changed = true;
  while (changed) {
    changed = false;
    for (const layer of layers) if (!result.has(layer.id) && result.has(layer.attachment?.parentId)) { result.add(layer.id); changed = true; }
  }
  return result;
}

export function movementRoots(layers, ids) {
  const selected = new Set(ids), byId = new Map(layers.map(layer => [layer.id, layer])), result = new Set();
  for (const id of selected) {
    let parentId = byId.get(id)?.attachment?.parentId, selectedAncestor = false;
    const visited = new Set([id]);
    while (parentId && !visited.has(parentId)) {
      if (selected.has(parentId)) { selectedAncestor = true; break; }
      visited.add(parentId); parentId = byId.get(parentId)?.attachment?.parentId;
    }
    if (!selectedAncestor && byId.has(id)) result.add(id);
  }
  return result;
}

let copySequence = 0;
const defaultId = () => globalThis.crypto?.randomUUID?.() || 'assembly-' + Date.now().toString(36) + '-' + (++copySequence).toString(36);
export function cloneAssemblySelection(layers, { makeId = defaultId, offsetX = 24, offsetY = 24 } = {}) {
  const ids = new Map(), generated = new Set(layers.map(layer => layer.id));
  for (const layer of layers) {
    const id = makeId();
    if (!validId(id) || generated.has(id)) throw new Error('复制图层时生成了重复或无效的 ID。');
    ids.set(layer.id, id); generated.add(id);
  }
  const copies = layers.map(layer => {
    const copy = cloneAssemblyLayer(layer);
    copy.id = ids.get(layer.id); copy.name = (layer.name || '图层') + ' 副本'; copy.locked = false;
    copy.x += Number.isFinite(offsetX) ? offsetX : 24; copy.y += Number.isFinite(offsetY) ? offsetY : 24;
    if (copy.attachment) copy.attachment = ids.has(copy.attachment.parentId) ? { parentId: ids.get(copy.attachment.parentId), slotId: copy.attachment.slotId } : null;
    return copy;
  });
  return resolveAttachments(copies);
}
