import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_MAP_BUILDINGS, buildingCapacityError } from '../../src/renderer/map-limits.ts';
import { validateMapTree } from '../../src/renderer/light-validation.ts';
import { addBuilding, addSpawn } from '../../src/renderer/map-edit-ops.ts';

function map(count) {
  return {
    width: 128, height: 128,
    buildings: Array.from({ length: count }, (_, i) => ({
      key: i % 2 ? 'turret_guard' : 'mine', team: 0,
      x: i % 64, y: Math.floor(i / 64), w: 1, h: 1,
    })),
    spawns: [],
  };
}

test('map light validation permits the full 1024 shared building/turret slots', () => {
  assert.equal(MAX_MAP_BUILDINGS, 1024);
  for (const count of [0, 256, 257, 1023, 1024]) {
    assert.equal(validateMapTree(map(count)).size, 0, `count=${count}`);
    assert.equal(buildingCapacityError(count), null);
  }
});

test('the 1025th mixed building/turret is an explicit capacity error, not a truncated map', () => {
  const errors = validateMapTree(map(1025));
  assert.equal(errors.size, 1);
  assert.match(errors.get('buildings'), /1025.*1024/);
});

test('unit spawns do not consume building capacity', () => {
  const doc = map(1024);
  doc.spawns = Array.from({ length: 128 }, (_, x) => ({ kind: 0, x, y: 64, team: 1 }));
  doc.init = { spawns: Array.from({ length: 128 }, (_, x) => ({ kind: 0, x, y: 66, team: 1 })) };
  assert.equal(validateMapTree(doc).size, 0);
  const withSpawn = addSpawn(doc, 127, 65, 0, 1, 1);
  assert.equal(withSpawn.buildings, doc.buildings);
  assert.equal(withSpawn.spawns.length, 129);
});

test('map building line overrides accept radar units and functional resource lines', () => {
  const units = new Set(['tactical_fire', 'tactical_bomber']);
  const doc = {
    width: 16, height: 16,
    buildings: [
      { key: 'radar', x: 0, y: 0, w: 2, h: 2, lines: [{ unit: 'tactical_fire', tier: 1, produce_ticks: 300 }] },
      { key: 'mine', x: 4, y: 0, w: 2, h: 2, lines: [{ income: 1 }, { income: 2 }, { income: 3 }] },
    ],
  };
  assert.equal(validateMapTree(doc, units).size, 0);
});

test('map line feedback rejects an empty unit row before the Godot gate', () => {
  const errors = validateMapTree({
    width: 8, height: 8,
    buildings: [{ key: 'mine', x: 0, y: 0, w: 2, h: 2, lines: [{ unit: '', tier: 2, ticks: 60 }] }],
  }, new Set(['tactical_fire']));
  assert.match(errors.get('buildings-0-lines-0'), /有效 unit|income/);
});

test('map line feedback rejects unknown units and accepts blank unit with an effect', () => {
  const unknown = validateMapTree({
    width: 8, height: 8,
    buildings: [{ key: 'radar', x: 0, y: 0, w: 2, h: 2, lines: [{ unit: 'future_unit', ticks: 60 }] }],
  }, new Set(['tactical_fire']));
  assert.match(unknown.get('buildings-0-lines-0-unit'), /未定义/);
  const effect = validateMapTree({
    width: 8, height: 8,
    buildings: [{ key: 'mine', x: 0, y: 0, w: 2, h: 2, lines: [{ unit: '', income: 1 }] }],
  }, new Set());
  assert.equal(effect.size, 0);
});

test('canvas placement reaches 1024 and never creates the 1025th building or turret', () => {
  const before = map(1023);
  const full = addBuilding(before, 80, 80, { key: 'turret_guard', w: 1, h: 1 }, 1);
  assert.equal(before.buildings.length, 1023);
  assert.equal(full.buildings.length, 1024);
  assert.equal(addBuilding(full, 82, 80, { key: 'mine', w: 2, h: 2 }, 1), full);
  assert.equal(addBuilding(map(1025), 82, 80, { key: 'mine', w: 2, h: 2 }, 1).buildings.length, 1025);
});
