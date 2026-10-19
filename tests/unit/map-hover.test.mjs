import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapHoverDetails } from '../../src/renderer/map-hover.ts';

const map = (extra = {}) => ({ width: 8, height: 8, ...extra });
const sources = {
  buildings: { buildings: [
    { key: 'mine', name_cn: '金矿', w: 6, h: 6 },
    { key: 'turret_guard', name_cn: '守卫炮台', w: 1, h: 1 },
  ] },
  units: { units: [
    { id: 0, key: 'cougar', name_cn: '美洲狮' },
    { id: 4, key: 'advancer', name_cn: '飞碟' },
  ] },
};
const renderConfig = {
  materials: {
    grass: { textures: ['res://assets/grass.png'], transition: { dirt: 'res://assets/grass/t_dirt/', snow: 'res://assets/grass/t_snow/' } },
    dirt: { textures: ['res://assets/dirt.png'] },
    snow: { textures: ['res://assets/snow.png'], cliff: 'res://assets/cliff_snow/', water: 'res://assets/water_ice/' },
  },
  scatter: { grass_tuft: { kind: 'grass_tuft', density: 1, variants: 1, materials_on: ['grass'], hash_salt: 101, hide_when_snow: true } },
  weather: ['rain', 'snow'],
};
const effectsAt = (doc, x = 0, y = 0, terrain = 0, rc = renderConfig) => mapHoverDetails(doc, x, y, terrain, { renderConfig: rc }).effects;

test('building inspection uses placement footprint and never expands it to the definition dimensions', () => {
  const doc = map({ buildings: [{ key: 'mine', x: 1, y: 1, w: 2, h: 3 }] });
  const original = structuredClone(doc);
  assert.deepEqual(mapHoverDetails(doc, 2, 3, 0, sources).objects, ['建筑 mine - 金矿']);
  assert.deepEqual(mapHoverDetails(doc, 3, 3, 0, sources).objects, [], 'right footprint edge is exclusive');
  assert.deepEqual(mapHoverDetails(doc, 2, 4, 0, sources).objects, [], 'bottom footprint edge is exclusive');
  assert.deepEqual(doc, original, 'inspection cannot mutate the map');
});

test('turrets and UFOs show keys and names with per-map definition overrides', () => {
  const doc = map({
    buildings: [{ key: 'turret_guard', x: 1, y: 1, w: 1, h: 1 }],
    spawns: [{ kind: 4, x: 1, y: 1 }],
    config: { buildings: { turret_guard: { name_cn: '任务防御塔' } }, units: { advancer: { name_cn: '任务飞碟' } } },
  });
  const details = mapHoverDetails(doc, 1, 1, 0, sources);
  assert.deepEqual(details.objects, ['炮台 turret_guard - 任务防御塔', '飞碟 advancer - 任务飞碟（spawns）']);
});

test('all visible spawn lists are inspected and unknown kinds retain their original identity', () => {
  const doc = map({
    spawns: [{ kind: 0, x: 2, y: 2 }, { kind: 999, x: 2, y: 2 }],
    init: { spawns: [{ kind: 4, x: 2, y: 2 }] },
  });
  const objects = mapHoverDetails(doc, 2, 2, 0, sources).objects;
  assert.equal(objects.length, 3);
  assert.match(objects.join('\n'), /单位 cougar - 美洲狮（spawns）/);
  assert.match(objects.join('\n'), /单位 kind=999 - 名称未配置（spawns）/);
  assert.match(objects.join('\n'), /飞碟 advancer - 飞碟（init\.spawns）/);
  assert.deepEqual(mapHoverDetails(doc, 3, 2, 0, sources).objects, []);
});

test('box_mode includes both endpoints and the last matching entry replaces both access and build', () => {
  const doc = map({ box_mode: [
    { start: { w: 1, h: 1 }, end: { w: 4, h: 4 }, access: 3, build: 1 },
    { start: { w: 3, h: 3 }, end: { w: 4, h: 4 }, access: 0, build: 0 },
  ] });
  assert.match(mapHoverDetails(doc, 1, 1, 0).box, /box_mode\[0\].*access=3.*build=1/);
  assert.match(mapHoverDetails(doc, 4, 4, 0).box, /box_mode\[1\].*access=0.*build=0/);
  assert.match(mapHoverDetails(doc, 5, 4, 3).box, /box_mode（默认）.*access=0.*build=0/, 'water terrain never supplies blocking rules');
});

test('invalid box entries are rejected and do not change the source index or effective rules', () => {
  const doc = map({ box_mode: [
    null,
    { start: { w: 0, h: 0 }, end: { w: 2, h: 2 }, access: 2, build: 1 },
    { start: { w: 0, h: 0 }, end: { w: 2, h: 2 } },
    { start: { w: 0, h: 0 }, end: { w: 8, h: 2 }, access: 0, build: 0 },
    { start: { w: 0, h: 0 }, end: { w: 2, h: 2 }, access: 7, build: 0 },
  ] });
  assert.match(mapHoverDetails(doc, 1, 1, 0).box, /box_mode\[1\].*access=2.*build=1/);
});

test('ground patches use last-write precedence and exclusive rectangle edges', () => {
  const doc = map({ ground: { default_material: 'grass', patches: [
    { x: 1, y: 1, w: 4, h: 4, material: 'dirt' },
    { x: 2, y: 2, w: 2, h: 2, material: 'snow' },
  ] } });
  assert.match(mapHoverDetails(doc, 2, 2, 0, { renderConfig }).texture.join(';'), /材质 snow/);
  assert.match(mapHoverDetails(doc, 4, 3, 0, { renderConfig }).texture.join(';'), /材质 dirt/);
  assert.match(mapHoverDetails(doc, 5, 3, 0, { renderConfig }).texture.join(';'), /材质 grass/);
});

test('ground rectangles allow omitted x and y with the game default of zero', () => {
  const doc = map({ ground: { default_material: 'grass', patches: [{ w: 2, h: 2, material: 'snow' }] } });
  assert.match(mapHoverDetails(doc, 0, 0, 2, { renderConfig }).texture.join(';'), /材质 snow/);
  assert.match(effectsAt(doc, 0, 0, 2).join(';'), /cliff_snow/);
});

test('the effective material selects the water and cliff themes', () => {
  const snow = map({ ground: { default_material: 'snow' } });
  assert.deepEqual(effectsAt(snow, 2, 2, 2), ['悬崖 · res://assets/cliff_snow/']);
  assert.deepEqual(effectsAt(snow, 2, 2, 3), ['水面 · res://assets/water_ice/']);
  assert.deepEqual(effectsAt(map(), 2, 2, 2), ['悬崖（程序绘制）']);
  assert.deepEqual(effectsAt(map(), 2, 2, 3), ['水面（程序绘制）']);
});

test('material transitions target the first different neighbor in N NE E SE S SW W NW order', () => {
  const doc = map({ ground: { default_material: 'grass', patches: [
    { x: 3, y: 2, w: 1, h: 1, material: 'dirt' },
    { x: 4, y: 2, w: 1, h: 1, material: 'snow' },
  ] } });
  assert.deepEqual(effectsAt(doc, 3, 3), ['材质过渡 grass → dirt · res://assets/grass/t_dirt/']);
  const noDirtTransition = structuredClone(renderConfig);
  delete noDirtTransition.materials.grass.transition.dirt;
  assert.deepEqual(effectsAt(doc, 3, 3, 0, noDirtTransition), [], 'do not skip the first neighbor to find a different available transition');
  assert.deepEqual(effectsAt(map({ ground: { default_material: 'grass' } }), 0, 0), [], 'out-of-map neighbors do not create transitions');
});

test('whole-image mode hides terrain, material and scatter effects while retaining weather and objects', () => {
  const doc = map({
    ground: { default_material: 'snow', scatter_regions: [{ x: 0, y: 0, w: 8, h: 8 }] },
    weather: { type: 'rain' },
    buildings: [{ key: 'mine', x: 0, y: 0, w: 2, h: 2 }],
  });
  const details = mapHoverDetails(doc, 0, 0, 2, { ...sources, renderConfig, backgroundPath: 'res://assets/map.JPG' });
  assert.deepEqual(details.texture, ['整图 JPG · res://assets/map.JPG']);
  assert.deepEqual(details.effects, ['天气 rain']);
  assert.deepEqual(details.objects, ['建筑 mine - 金矿']);
  assert.match(details.box, /box_mode（默认）/);
});

test('water can show its underlying material transition while still excluding scatter', () => {
  const doc = map({ ground: {
    default_material: 'grass',
    patches: [{ x: 0, y: 0, w: 1, h: 1, material: 'dirt' }],
    scatter_regions: [{ x: 0, y: 0, w: 8, h: 8 }],
  } });
  const rc = structuredClone(renderConfig);
  rc.materials.grass.water = 'res://assets/water/';
  assert.deepEqual(effectsAt(doc, 1, 1, 3, rc), [
    '水面 · res://assets/water/',
    '材质过渡 grass → dirt · res://assets/grass/t_dirt/',
  ]);
});

test('scatter requires a declared region and matching material, and exclusion overrides regions', () => {
  const withGround = (ground) => map({ ground: { default_material: 'grass', ...ground } });
  assert.deepEqual(effectsAt(withGround({})), [], 'no regions means no scatter, even at density=1');
  const region = { x: 0, y: 0, w: 2, h: 2 };
  assert.deepEqual(effectsAt(withGround({ scatter_regions: [region] })), ['散布 grass_tuft']);
  assert.deepEqual(effectsAt(withGround({ scatter_regions: [region] }), 2, 0), [], 'scatter rectangle upper edge is exclusive');
  assert.deepEqual(effectsAt(withGround({ scatter_regions: [region], scatter_exclude: [{ x: 0, y: 0, w: 1, h: 1 }] })), []);
  assert.deepEqual(effectsAt(withGround({ default_material: 'snow', scatter_regions: [region] })), [], 'materials_on is a filter');
  assert.deepEqual(effectsAt(withGround({ scatter_regions: [region] }), 0, 0, 1), [], 'wall cells do not display scatter');
});

test('scatter density uses deterministic game coordinates instead of labeling a whole region', () => {
  const doc = map({ ground: { default_material: 'grass', scatter_regions: [{ x: 0, y: 0, w: 8, h: 8 }] } });
  const rc = structuredClone(renderConfig);
  rc.scatter.grass_tuft.density = 0.1;
  // Independent hash32 v2 reference values: (0,0,101)=325208784,
  // (1,0,101)=1567871645. Their probabilities straddle density 0.1.
  assert.deepEqual(effectsAt(doc, 0, 0, 0, rc), ['散布 grass_tuft']);
  assert.deepEqual(effectsAt(doc, 1, 0, 0, rc), []);
  rc.scatter.grass_tuft.density = 0;
  assert.deepEqual(effectsAt(doc, 0, 0, 0, rc), []);
  rc.scatter.grass_tuft.density = 1;
  rc.scatter.grass_tuft.variants = 3;
  assert.deepEqual(effectsAt(doc, 1, 0, 0, rc), [], 'a candidate without a matching variant pool stays absent');
});

test('snow hides only configured snow-sensitive scatter and leaves other kinds visible', () => {
  const doc = map({ ground: { default_material: 'grass', scatter_regions: [{ x: 0, y: 0, w: 8, h: 8 }] }, weather: { type: 'snow' } });
  assert.deepEqual(effectsAt(doc), ['天气 snow']);
  const rc = structuredClone(renderConfig);
  rc.scatter.pebble = { kind: 'pebble', density: 1, variants: 1, materials_on: ['grass'], hash_salt: 211, hide_when_snow: false };
  assert.deepEqual(effectsAt(doc, 0, 0, 0, rc), ['散布 pebble', '天气 snow']);
  rc.weather = [];
  assert.deepEqual(effectsAt(doc, 0, 0, 0, rc), ['散布 grass_tuft', '散布 pebble'], 'missing snow template cannot hide scatter');
});

test('weather intensity outside the game range does not activate an effect or hide scatter', () => {
  const ground = { default_material: 'grass', scatter_regions: [{ x: 0, y: 0, w: 8, h: 8 }] };
  for (const intensity of [-1, 2]) {
    assert.deepEqual(effectsAt(map({ ground, weather: { type: 'snow', intensity } })), ['散布 grass_tuft']);
  }
  assert.deepEqual(effectsAt(map({ ground, weather: { type: 'snow', intensity: 0 } })), ['天气 snow'], 'zero intensity is legal and the game still activates snow filtering');
});
