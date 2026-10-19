import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { featureSchemaForMap } from "../../src/renderer/map-feature-schema.ts";
import { defaultsAtPath } from "../../src/renderer/schema-templates.ts";
import { setAtPath } from "../../src/renderer/field-path.ts";

const buildings = JSON.parse(fs.readFileSync(new URL("../../../project-rts/data/buildings.json", import.meta.url), "utf8"));
const units = JSON.parse(fs.readFileSync(new URL("../../../project-rts/data/units.json", import.meta.url), "utf8"));
const defaults = (schema, ...path) => defaultsAtPath(schema, path);

test("map placements use the actual building's complete line table, including each resource type", () => {
  const keys = ["mine", "research_establishment", "energy_core", "tank_plant_s", "radar"];
  // Derive representative keys from live definitions so the regression covers
  // renamed buildings and every current line family without a copied spec.
  const families = ["income", "research", "speed_up", "unit"];
  for (const family of families) {
    const def = buildings.buildings.find((row) => row.lines?.some((line) => Object.hasOwn(line, family)));
    assert(def, `missing ${family} definition`);
    keys.push(def.key);
  }
  const rows = keys.filter((key) => buildings.buildings.some((def) => def.key === key)).map((key) => ({ key, x: 0, y: 0, w: 2, h: 2, team: 0, lines: [] }));
  const doc = { buildings: rows };
  const before = structuredClone(doc);
  const schema = featureSchemaForMap(doc, { buildings });
  for (let i = 0; i < rows.length; i++) {
    const def = buildings.buildings.find((row) => row.key === rows[i].key);
    if (def.lines?.length) assert.deepEqual(defaults(schema, "buildings", i).lines, def.lines, def.key);
    assert.equal(defaults(schema, "buildings", i).hp, def.hp);
    assert.equal(defaults(schema, "buildings", i).repair_rate, undefined);
  }
  assert.deepEqual(defaults(schema, "buildings", rows.findIndex((row) => row.key === "mine")).lines, [{ income: 1 }, { income: 2 }, { income: 3 }]);
  assert.deepEqual(doc, before, "opening the schema must not create overrides");
});

test("map config lines replace def arrays and cannot leak between placement indexes", () => {
  const doc = { buildings: [{ key: "mine", lines: [{ income: 90 }] }, { key: "tank_plant_s" }], config: { buildings: { mine: { lines: [{ income: 11 }, { income: 13 }], hp: 777 } } } };
  const schema = featureSchemaForMap(doc, { buildings });
  assert.deepEqual(defaults(schema, "buildings", 0).lines, [{ income: 11 }, { income: 13 }]);
  assert.equal(defaults(schema, "buildings", 0).hp, 777);
  assert.equal(defaults(schema, "buildings", 0).unlocked_lines, 1, "map inheritance must not use the new-entity template's zero unlocks");
  const factory = buildings.buildings.find((row) => row.key === "tank_plant_s");
  assert.deepEqual(defaults(schema, "buildings", 1).lines, factory.lines);
  assert.deepEqual(defaults(schema, "config", "buildings", "mine").lines, [{ income: 11 }, { income: 13 }]);
  assert.equal(defaults(schema, "buildings", 0, "lines", 0).income, 1);
});

test("map root, placements, config definitions and nested fields each expose their own template", () => {
  const doc = { buildings: [{ key: "mine" }], config: {} };
  const schema = featureSchemaForMap(doc, { buildings, units, rules: { _note: "skip", version: 1, neutral_start_hp_percent: 50, fog: true } });
  assert.deepEqual(schema.root.init, {});
  assert.equal(schema.root.repair_rate, undefined);
  assert.deepEqual(defaults(schema, "config").buildings, {});
  assert.deepEqual(defaults(schema, "config", "buildings").mine, {});
  assert.equal(defaults(schema, "config", "buildings", "mine").repair_rate, 6);
  assert.equal(defaults(schema, "config", "buildings", "mine").key, undefined);
  assert.equal(defaults(schema, "config", "buildings", "mine").damage, undefined, "map overrides cannot enable a field missing from its definition");
  assert.equal(defaults(schema, "config", "units", units.units[0].key).id, undefined);
  assert.equal(defaults(schema, "config", "units", units.units[0].key, "tiers", 0).texture, "");
  for (const effect of ["income", "research", "speed_up"]) assert.equal(defaults(schema, "buildings", 0, "lines", 0)[effect], 1);
  assert.equal(defaults(schema, "spawns", 0).kind, 0);
  assert.equal(defaults(schema, "spawns", 0).hp, undefined);
  assert.deepEqual(defaults(schema, "config", "rules"), { neutral_start_hp_percent: 50, fog: true });
});

test("future templates, recursive observed fields and RAM fallback work in map JSON", () => {
  const toolTemplates = { buildings: [{ key: "standard", entity: {}, nested_fields: { "/lines": { future_line: { strength: 8 } } } }] };
  const custom = { buildings: [{ key: "future", hp: 400, future_feature: { enabled: true, modes: [{ weight: 2 }] } }], templates: [{ key: "standard", entity: {}, nested_fields: { "/lines": { future_line: { strength: 9 } } } }] };
  const doc = { future_map: { options: [{ radius: 7 }, { duration: 20 }] }, buildings: [{ key: "future", future_placement: { enabled: true } }] };
  const schema = featureSchemaForMap(doc, { buildings: custom, toolTemplates });
  assert.deepEqual(defaults(schema, "future_map", "options", 0), { radius: 7, duration: 20 });
  assert.deepEqual(defaults(schema, "buildings", 0).future_placement, { enabled: true });
  assert.deepEqual(defaults(schema, "config", "buildings", "future").future_feature, { enabled: true, modes: [{ weight: 2 }] });
  assert.equal(defaults(schema, "config", "buildings", "future", "future_feature", "modes", 0).weight, 2);
  assert.equal(defaults(schema, "buildings", 0, "lines", 0).future_line.strength, 9);
  const ram = featureSchemaForMap({ buildings: [{ key: "unknown" }] });
  assert.equal(defaults(ram, "buildings", 0).hp, 500);
  assert.equal(defaults(ram, "buildings", 0, "lines", 0).income, 1);
  assert.equal(defaults(ram, "config", "buildings", "unknown").repair_rate, 5);
});

test("schema defaults are detached from project data, templates and map config", () => {
  const doc = { buildings: [{ key: "mine" }], config: { buildings: { mine: { lines: [{ income: 7 }] } } } };
  const before = structuredClone(buildings);
  const schema = featureSchemaForMap(doc, { buildings });
  defaults(schema, "buildings", 0).lines[0].income = 99;
  schema.root.init.changed = true;
  assert.equal(doc.config.buildings.mine.lines[0].income, 7);
  assert.deepEqual(buildings, before);
  assert.deepEqual(featureSchemaForMap({}).root.init, {});
});

test("constructing the schema does not inspect an unopened map field picker", () => {
  let reads = 0;
  const doc = { buildings: [] };
  Object.defineProperty(doc, "future_map", { enumerable: true, get() { reads++; return { enabled: true }; } });
  const schema = featureSchemaForMap(doc, { buildings, units });
  assert.equal(reads, 0);
  assert.equal(defaults(schema, "future_map").enabled, true);
  assert.equal(reads, 1);
});

test("immutable leaf edits, added fields, row reorder and removal refresh discovered defaults", () => {
  const doc = { future_map: { rows: [{ radius: 7 }, { duration: 20 }] } };
  const initial = featureSchemaForMap(doc);
  assert.deepEqual(defaults(initial, "future_map", "rows", 0), { radius: 7, duration: 20 });
  const edited = setAtPath(doc, ["future_map", "rows", 1, "duration"], 33);
  assert.deepEqual(defaults(featureSchemaForMap(edited), "future_map", "rows", 0), { radius: 7, duration: 33 });
  const extended = setAtPath(edited, ["future_map", "rows", 1, "future_option"], { power: 8 });
  assert.equal(defaults(featureSchemaForMap(extended), "future_map", "rows", 0, "future_option").power, 8);
  const removed = setAtPath(extended, ["future_map", "rows"], [extended.future_map.rows[0]]);
  assert.deepEqual(defaults(featureSchemaForMap(removed), "future_map", "rows", 0), { radius: 7 });
  const reordered = { future_map: { rows: [{ radius: 9 }, doc.future_map.rows[0]] } };
  assert.equal(defaults(featureSchemaForMap(reordered), "future_map", "rows", 0).radius, 9);
  assert.equal(defaults(initial, "future_map", "rows", 0).duration, 20);
});

test("cached discoveries are detached between schema instances and sources reload independently", () => {
  const doc = { buildings: [{ key: "custom" }], future_map: { options: [{ radius: 7 }] } };
  const source = { buildings: [{ key: "custom", hp: 10, lines: [{ income: 1 }] }] };
  const first = featureSchemaForMap(doc, { buildings: source });
  defaults(first, "future_map").options[0].radius = 99;
  first.root.future_map.options[0].radius = 88;
  const second = featureSchemaForMap(doc, { buildings: source });
  assert.equal(defaults(second, "future_map").options[0].radius, 7);
  assert.equal(second.root.future_map.options[0].radius, 7);
  const reloaded = { buildings: [{ ...source.buildings[0], hp: 50, lines: [{ income: 3 }] }] };
  assert.equal(defaults(featureSchemaForMap(doc, { buildings: reloaded }), "buildings", 0).hp, 50);
  assert.deepEqual(defaults(second, "buildings", 0).lines, [{ income: 1 }]);
  const configured = { ...doc, config: { buildings: { custom: { hp: 70, lines: [] } } } };
  const configuredSchema = featureSchemaForMap(configured, { buildings: reloaded });
  assert.equal(defaults(configuredSchema, "buildings", 0).hp, 70);
  assert.deepEqual(defaults(configuredSchema, "buildings", 0).lines, []);
  const tool = { buildings: [{ key: "standard", entity: {}, nested_fields: { "/lines": { future_line: 1 } } }] };
  const updatedTool = { buildings: [{ key: "standard", entity: {}, nested_fields: { "/lines": { future_line: 2 } } }] };
  assert.equal(defaults(featureSchemaForMap(doc, { buildings: source, toolTemplates: tool }), "buildings", 0, "lines", 0).future_line, 1);
  assert.equal(defaults(featureSchemaForMap(doc, { buildings: source, toolTemplates: updatedTool }), "buildings", 0, "lines", 0).future_line, 2);
});
