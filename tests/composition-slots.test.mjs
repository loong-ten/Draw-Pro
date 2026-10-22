import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_SLOTS, normalizeAssemblyFields, cloneAssemblyLayer,
  localPointToWorld, worldPointToLocal, slotOccupant, canAttach, attachLayer,
  detachLayer, resolveAttachments, nearestSlot, attachmentDescendants,
  movementRoots, cloneAssemblySelection,
} from '../dist/composition-slots.js';

const make = (id, extra = {}) => ({ id, name: id, x: 10, y: 20, w: 100, h: 80, rotation: 0, flipX: false, flipY: false, visible: true, locked: false, slots: [], dock: { u: .5, v: .5 }, attachment: null, ...extra });
const slot = (id = 's', u = .8, v = .2) => ({ id, name: id, u, v });
const close = (a, b, message = '') => assert.ok(Math.abs(a - b) < 1e-8, `${message}: ${a} ≠ ${b}`);
const joined = (parent, child, id = 's') => {
  const a = localPointToWorld(parent, parent.slots.find(s => s.id === id));
  const b = localPointToWorld(child, child.dock);
  close(a.x, b.x, 'dock X'); close(a.y, b.y, 'dock Y');
};

test('points match the compositor center/rotate/flip transform and invert without clipping', () => {
  const layer = make('a', { x: -30, y: 15, w: 80, h: 20, rotation: 90, flipX: true });
  const point = localPointToWorld(layer, { u: 0, v: 0 });
  close(point.x, 20); close(point.y, 65);
  let scenarios = 0;
  for (const rotation of [0, 15, 90, 180, 237, 359]) for (const flipX of [false, true]) for (const flipY of [false, true]) {
    for (const [u, v] of [[0, 0], [1, 1], [.125, .875], [-.2, 1.3]]) {
      const l = make('a', { x: -71.125, y: 20.4, w: 373, h: 11.7, rotation, flipX, flipY });
      const restored = worldPointToLocal(l, localPointToWorld(l, { u, v }));
      close(restored.u, u); close(restored.v, v); scenarios++;
    }
  }
  assert.equal(scenarios, 96);
});

test('normalization preserves stable IDs, filters malformed slots and deep-copies fields', () => {
  const raw = {
    slots: [null, slot('a'), slot('a'), { ...slot('bad'), u: '0.3' }, { ...slot('bad2'), v: Infinity }, { ...slot('b'), u: -1, v: 2, name: '  ' }, ...Array.from({ length: 10 }, (_, i) => slot('x' + i))],
    dock: { u: .25, v: .75 }, attachment: { parentId: 'p', slotId: 'a', extra: true },
  };
  const normalized = normalizeAssemblyFields(raw);
  assert.equal(normalized.slots.length, MAX_SLOTS);
  assert.equal(normalized.slots[0].id, 'a');
  assert.deepEqual(normalized.slots[1], { id: 'b', name: '卡槽 2', u: 0, v: 1 });
  assert.deepEqual(normalized.attachment, { parentId: 'p', slotId: 'a' });
  normalized.slots[0].u = 0; normalized.dock.u = 1; normalized.attachment.parentId = 'other';
  assert.equal(raw.slots[1].u, .8); assert.equal(raw.dock.u, .25); assert.equal(raw.attachment.parentId, 'p');
  assert.deepEqual(normalizeAssemblyFields({ slots: {}, dock: { u: NaN, v: .2 }, attachment: { parentId: 'p' } }), { slots: [], dock: { u: .5, v: .5 }, attachment: null });
  assert.deepEqual(normalizeAssemblyFields(null), { slots: [], dock: { u: .5, v: .5 }, attachment: null });
  const original = make('a', { slots: [slot()], dock: { u: 0, v: .1 }, attachment: { parentId: 'p', slotId: 's' } });
  const copy = cloneAssemblyLayer(original);
  copy.slots[0].name = 'changed'; copy.dock.u = 1; copy.attachment.slotId = 'changed';
  assert.equal(original.slots[0].name, 's'); assert.equal(original.dock.u, 0); assert.equal(original.attachment.slotId, 's');
});

test('an attached accessory follows its slot through independent transforms and nested assembly', () => {
  const parent = make('parent', { slots: [slot()], rotation: 47, flipY: true });
  const child = make('child', { w: 30, h: 17, x: -200, rotation: 112, flipX: true, dock: { u: 0, v: .9 }, slots: [slot('c', .1, .4)] });
  const leaf = make('leaf', { w: 9, h: 15, dock: { u: .1, v: .2 } });
  const layers = [leaf, child, parent];
  assert.equal(attachLayer(layers, 'child', 'parent', 's'), true);
  assert.equal(attachLayer(layers, 'leaf', 'child', 'c'), true);
  joined(parent, child); joined(child, leaf, 'c');
  parent.x += 53; parent.y -= 19; parent.rotation += 90; parent.w *= 1.8; parent.h *= .4; parent.flipX = true;
  child.w = 59; child.rotation = 291; child.flipY = true;
  const childIndependent = [child.w, child.h, child.rotation, child.flipX, child.flipY];
  resolveAttachments(layers);
  joined(parent, child); joined(child, leaf, 'c');
  assert.deepEqual([child.w, child.h, child.rotation, child.flipX, child.flipY], childIndependent);
  const positions = layers.map(l => [l.x, l.y]);
  for (let i = 0; i < 20; i++) resolveAttachments(layers);
  assert.deepEqual(layers.map(l => [l.x, l.y]), positions, 'resolution has no repeated drift');
});

test('one occupant per slot, explicit replacement, locking, self and cycle rejection', () => {
  const p = make('p', { locked: true, slots: [slot()] });
  const a = make('a', { slots: [slot()] }), b = make('b', { x: 999 });
  const layers = [p, a, b];
  assert.equal(attachLayer(layers, 'a', 'p', 's'), true, 'locked host can receive parts');
  assert.equal(slotOccupant(layers, 'p', 's').id, 'a');
  assert.equal(slotOccupant(layers, 'p', 's', 'a'), null);
  assert.equal(canAttach(layers, 'b', 'p', 's'), false);
  const old = [a.x, a.y];
  a.locked = true;
  assert.equal(attachLayer(layers, 'b', 'p', 's', { replace: true }), false);
  a.locked = false;
  assert.equal(attachLayer(layers, 'b', 'p', 's', { replace: true }), true);
  assert.equal(a.attachment, null); assert.deepEqual([a.x, a.y], old);
  assert.equal(b.attachment.parentId, 'p'); joined(p, b);
  assert.equal(canAttach(layers, 'a', 'a', 's'), false);
  assert.equal(canAttach(layers, 'a', 'missing', 's'), false);
  assert.equal(canAttach(layers, 'a', 'p', 'missing'), false);
  b.slots = [slot()]; a.attachment = { parentId: 'b', slotId: 's' };
  assert.equal(canAttach(layers, 'b', 'a', 's'), false, 'descendant cannot become parent');
  p.locked = false;
  assert.equal(canAttach(layers, 'p', 'a', 's'), false, 'nested ancestry is checked');
  a.locked = true;
  assert.equal(canAttach(layers, 'a', 'p', 's', { replace: true }), false);
});

test('detaching, removed parents and removed slots preserve last world positions', () => {
  const p = make('p', { slots: [slot()] }), c = make('c');
  attachLayer([p, c], 'c', 'p', 's');
  const last = [c.x, c.y];
  detachLayer(c); assert.deepEqual([c.x, c.y], last); assert.equal(c.attachment, null);
  attachLayer([p, c], 'c', 'p', 's'); resolveAttachments([c]);
  assert.deepEqual([c.x, c.y], last); assert.equal(c.attachment, null);
  attachLayer([p, c], 'c', 'p', 's'); p.slots = []; resolveAttachments([p, c]);
  assert.deepEqual([c.x, c.y], last); assert.equal(c.attachment, null);
});

test('restoring malformed relations is bounded and deterministic', () => {
  const p = make('p', { slots: [slot()] });
  const a = make('a', { attachment: { parentId: 'p', slotId: 's' } });
  const b = make('b', { attachment: { parentId: 'p', slotId: 's' } });
  const c = make('c', { slots: [slot()], attachment: { parentId: 'd', slotId: 's' } });
  const d = make('d', { slots: [slot()], attachment: { parentId: 'c', slotId: 's' } });
  const e = make('e', { attachment: { parentId: 'c', slotId: 's' } });
  const f = make('f', { attachment: { parentId: 'missing', slotId: 's' } });
  const g = make('g', { attachment: { parentId: 'g', slotId: 's' }, slots: [slot()] });
  const h = make('h', { attachment: { parentId: 'p' } });
  resolveAttachments([e, b, p, a, c, d, f, g, h]);
  assert.equal(b.attachment.parentId, 'p'); assert.equal(a.attachment, null);
  assert.equal(c.attachment, null); assert.equal(d.attachment, null);
  assert.equal(e.attachment.parentId, 'c'); joined(c, e);
  assert.equal(f.attachment, null); assert.equal(g.attachment, null); assert.equal(h.attachment, null);
});

test('nearest slot uses transformed dock, screen-derived threshold, visibility and occupancy', () => {
  const p = make('p', { x: 0, y: 0, w: 100, h: 100, slots: [slot('a', .5, .5), slot('b', .6, .5)] });
  const c = make('c', { x: 42, y: 45, w: 10, h: 10 }), other = make('other');
  const layers = [p, c, other];
  assert.equal(nearestSlot(layers, 'c', 3).slotId, 'a', 'threshold includes exact edge');
  assert.equal(nearestSlot(layers, 'c', 2), null);
  attachLayer(layers, 'other', 'p', 'a');
  assert.equal(nearestSlot(layers, 'c', 20).slotId, 'b', 'occupied slots are skipped');
  assert.equal(nearestSlot(layers, 'c', 20, { excludeIds: new Set(['p']) }), null);
  p.visible = false; assert.equal(nearestSlot(layers, 'c', 20), null);
  p.visible = true; c.locked = true; assert.equal(nearestSlot(layers, 'c', 20), null);
  c.locked = false; assert.equal(nearestSlot(layers, 'c', NaN), null);
});

test('selection roots and descendants keep an assembled group from moving twice', () => {
  const p = make('p', { slots: [slot()] }), c = make('c', { slots: [slot()] }), l = make('l'), free = make('free');
  const layers = [l, free, c, p];
  attachLayer(layers, 'c', 'p', 's'); attachLayer(layers, 'l', 'c', 's');
  assert.deepEqual([...attachmentDescendants(layers, ['p'])].sort(), ['c', 'l', 'p']);
  assert.deepEqual([...movementRoots(layers, ['p', 'c', 'l', 'free'])].sort(), ['free', 'p']);
  assert.deepEqual([...movementRoots(layers, ['c', 'l'])], ['c']);
  assert.deepEqual([...movementRoots(layers, ['l'])], ['l']);
});

test('duplicated assemblies remap internal parents and deeply isolate anchors and history', () => {
  const p = make('p', { slots: [slot()] }), c = make('c', { dock: { u: .1, v: .8 } });
  attachLayer([p, c], 'c', 'p', 's');
  let next = 0;
  const copies = cloneAssemblySelection([c, p], { makeId: () => 'copy-' + (++next), offsetX: 10, offsetY: -7 });
  const [cc, pp] = copies;
  assert.equal(cc.attachment.parentId, pp.id); assert.equal(cc.attachment.slotId, 's'); joined(pp, cc);
  close(pp.x, p.x + 10); close(pp.y, p.y - 7); close(cc.x, c.x + 10); close(cc.y, c.y - 7);
  assert.equal(cc.name, 'c 副本'); assert.equal(cc.locked, false);
  pp.slots[0].u = 0; cc.dock.u = .9; cc.attachment.slotId = 'different';
  assert.equal(p.slots[0].u, .8); assert.equal(c.dock.u, .1); assert.equal(c.attachment.slotId, 's');
  const [alone] = cloneAssemblySelection([c], { makeId: () => 'alone' });
  assert.equal(alone.attachment, null); close(alone.x, c.x + 24); close(alone.y, c.y + 24);
  assert.throws(() => cloneAssemblySelection([p, c], { makeId: () => 'duplicate' }), /ID/);
});
