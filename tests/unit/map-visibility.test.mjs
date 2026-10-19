import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MAP_VISIBILITY, mapObjectVisible } from '../../src/renderer/map-visibility.ts';
import { deleteAt } from '../../src/renderer/map-edit-ops.ts';

const visibility = (extra = {}) => ({
  ...structuredClone(DEFAULT_MAP_VISIBILITY),
  ...extra,
});
const objects = [
  ['building', { key: 'mine' }, 'buildings'],
  ['building', { key: 'turret_guard' }, 'turrets'],
  ['spawn', { kind: 0 }, 'units'],
  ['spawn', { key: 'advancer', kind: 4 }, 'units'],
];

test('the initial view shows all teams, objects and existing layers', () => {
  assert.deepEqual(DEFAULT_MAP_VISIBILITY, {
    teams: { own: true, enemy: true, neutral: true },
    kinds: { buildings: true, turrets: true, units: true },
    hideBackground: false,
    hideRender: false,
    hideObjects: false,
    hideGrid: false,
    hideBoxes: false,
  });
  for (const [kind, entity] of objects) {
    for (const team of [0, 1, 2, 4, 9]) {
      assert.equal(mapObjectVisible(DEFAULT_MAP_VISIBILITY, kind, { ...entity, team }), true);
    }
  }
});

test('each team group and each kind form an intersection, including UFO units', () => {
  for (const group of ['own', 'enemy', 'neutral']) {
    for (const selectedKind of ['buildings', 'turrets', 'units']) {
      const value = visibility({
        teams: { own: group === 'own', enemy: group === 'enemy', neutral: group === 'neutral' },
        kinds: { buildings: selectedKind === 'buildings', turrets: selectedKind === 'turrets', units: selectedKind === 'units' },
      });
      for (const [kind, entity, objectKind] of objects) {
        for (const [team, teamGroup] of [[0, 'neutral'], [1, 'own'], [2, 'enemy'], [9, 'enemy']]) {
          assert.equal(
            mapObjectVisible(value, kind, { ...entity, team }),
            teamGroup === group && objectKind === selectedKind,
            `${kind} ${entity.key ?? entity.kind}, team ${team}: ${group} / ${selectedKind}`,
          );
        }
      }
    }
  }
});

test('omitted building and spawn teams use their different game defaults', () => {
  const own = visibility({ teams: { own: true, enemy: false, neutral: false } });
  const neutral = visibility({ teams: { own: false, enemy: false, neutral: true } });
  assert.equal(mapObjectVisible(own, 'building', { key: 'mine' }), false);
  assert.equal(mapObjectVisible(neutral, 'building', { key: 'mine' }), true);
  assert.equal(mapObjectVisible(own, 'spawn', { kind: 0 }), true);
  assert.equal(mapObjectVisible(neutral, 'spawn', { kind: 0 }), false);
});

test('hideObjects overrides team and kind filters; other layer toggles preserve object visibility', () => {
  for (const [kind, entity] of objects) {
    assert.equal(mapObjectVisible(visibility({ hideObjects: true }), kind, entity), false);
    assert.equal(mapObjectVisible(visibility({ hideBackground: true, hideRender: true, hideGrid: true, hideBoxes: true }), kind, entity), true);
  }
});

test('unchecking every team or every kind hides all objects', () => {
  for (const [kind, entity] of objects) {
    assert.equal(mapObjectVisible(visibility({ teams: { own: false, enemy: false, neutral: false } }), kind, entity), false);
    assert.equal(mapObjectVisible(visibility({ kinds: { buildings: false, turrets: false, units: false } }), kind, entity), false);
  }
});

test('malformed teams remain discoverable unfiltered and never masquerade as a selected valid team', () => {
  for (const team of [null, -1, 1.5, '1', '', NaN, Infinity]) {
    assert.equal(mapObjectVisible(DEFAULT_MAP_VISIBILITY, 'building', { key: 'mine', team }), true);
    for (const group of ['own', 'enemy', 'neutral']) {
      assert.equal(mapObjectVisible(visibility({
        teams: { own: group === 'own', enemy: group === 'enemy', neutral: group === 'neutral' },
      }), 'building', { key: 'mine', team }), false);
    }
  }
});

test('classification uses the turret key prefix and cannot mutate the original map entry or filters', () => {
  const value = visibility({ kinds: { buildings: true, turrets: false, units: false } });
  const entry = { key: 'turret_guard', team: 0, x: 3, y: 4, lines: [{ income: 1 }] };
  const original = structuredClone({ value, entry });
  assert.equal(mapObjectVisible(value, 'building', entry), false);
  assert.equal(mapObjectVisible(value, 'building', { key: 'guard_turret', damage: 10, team: 0 }), true);
  assert.deepEqual({ value, entry }, original);
});

test('filtered deletion retains original indices and skips hidden buildings and spawns', () => {
  const value = visibility({ teams: { own: true, enemy: false, neutral: false } });
  const allowed = (kind, entity) => kind === 'box' ? !value.hideBoxes : kind === 'decor' || mapObjectVisible(value, kind, entity);
  const doc = {
    buildings: [
      { key: 'mine', team: 1, x: 2, y: 2, w: 2, h: 2 },
      { key: 'mine', team: 2, x: 2, y: 2, w: 2, h: 2 },
    ],
    spawns: [{ kind: 0, team: 1, x: 6, y: 6 }, { kind: 4, team: 2, x: 6, y: 6 }],
  };
  const original = structuredClone(doc);
  const buildingDeleted = deleteAt(doc, 2, 2, allowed);
  assert.deepEqual(buildingDeleted.buildings, [doc.buildings[1]], 'visible lower-index building is removed, hidden upper entry stays');
  const spawnDeleted = deleteAt(doc, 6, 6, allowed);
  assert.deepEqual(spawnDeleted.spawns, [doc.spawns[1]], 'spawn deletion also uses original indices');
  assert.equal(deleteAt(buildingDeleted, 2, 2, allowed), buildingDeleted, 'only hidden objects remain, so deletion is a no-op');
  assert.equal(deleteAt(spawnDeleted, 6, 6, allowed), spawnDeleted);
  assert.deepEqual(doc, original);
});

test('hiding render and game objects preserves editable collision boxes', () => {
  const value = visibility({ hideObjects: true, hideRender: true });
  const allowed = (kind, entity) => kind === 'box' ? !value.hideBoxes : kind === 'decor' ? !value.hideRender : mapObjectVisible(value, kind, entity);
  const doc = {
    buildings: [{ key: 'mine', team: 1, x: 2, y: 2, w: 2, h: 2 }],
    decor: [{ kind: 'tree', x: 2, y: 2 }],
    spawns: [{ kind: 0, team: 1, x: 2, y: 2 }],
    box_mode: [{ start: { w: 2, h: 2 }, end: { w: 3, h: 3 }, access: 3, build: 1 }],
  };
  const original = structuredClone(doc);
  const next = deleteAt(doc, 2, 2, allowed);
  assert.deepEqual(next.box_mode, [], 'box is an independent editor layer and remains a valid delete target');
  assert.deepEqual(next.buildings, doc.buildings);
  assert.deepEqual(next.decor, doc.decor);
  assert.deepEqual(next.spawns, doc.spawns);
  assert.equal(deleteAt(next, 2, 2, allowed), next, 'hidden render and objects cannot be deleted after the box');
  assert.deepEqual(doc, original);
});

test('hiding collision boxes prevents their deletion independently of render and grid toggles', () => {
  const box = { start: { w: 2, h: 2 }, end: { w: 3, h: 3 }, access: 3, build: 1 };
  const doc = { box_mode: [box], spawns: [{ kind: 0, team: 1, x: 2, y: 2 }] };
  const original = structuredClone(doc);
  for (const hideRender of [false, true]) for (const hideGrid of [false, true]) {
    const value = visibility({ hideBoxes: true, hideObjects: true, hideRender, hideGrid });
    const allowed = (kind, entity) => kind === 'box' ? !value.hideBoxes : kind === 'decor' ? !value.hideRender : mapObjectVisible(value, kind, entity);
    assert.equal(deleteAt(doc, 2, 2, allowed), doc, 'hidden boxes and objects cannot be deleted');
    const visibleBoxes = { ...value, hideBoxes: false };
    const next = deleteAt(doc, 2, 2, (kind, entity) => kind === 'box' ? !visibleBoxes.hideBoxes : kind === 'decor' ? !visibleBoxes.hideRender : mapObjectVisible(visibleBoxes, kind, entity));
    assert.deepEqual(next.box_mode, [], 'showing boxes restores their delete target without changing other filters');
    assert.deepEqual(next.spawns, doc.spawns);
  }
  assert.deepEqual(doc, original);
});
