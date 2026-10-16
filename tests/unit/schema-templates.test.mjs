import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { builtinTemplate, defaultsAtPath, featureSchemaForDocument, templatesForDocument } from "../../src/renderer/schema-templates.ts";
import { instantiateTemplate } from "../../src/renderer/templates.ts";

test("RAM fallback creates unit/building without optional capability keys", () => {
  const unit = instantiateTemplate(templatesForDocument("units")[0], []);
  const building = instantiateTemplate(templatesForDocument("buildings", {})[0], []);
  assert.equal(unit.id, 0);
  assert.equal(unit.key, "new_unit_1");
  assert.equal(unit.name_cn, "新单位");
  assert.equal(unit.hp, 100);
  for (const key of ["laser", "strike", "chain", "meteor", "warp", "tiers"]) assert.equal(Object.hasOwn(unit, key), false, key);
  for (const key of ["lines", "summon", "produce_options", "damage", "income", "research"]) assert.equal(Object.hasOwn(building, key), false, key);
  assert.equal(building.key, "new_building_1");
  assert.equal(building.w, 1);
});

test("project templates override tool config while missing config keeps RAM standard", () => {
  const custom = { key: "standard", name_cn: "Custom", entity: { hp: 777 } };
  assert.equal(templatesForDocument("units", undefined, { units: [custom] })[0].entity.hp, 777);
  const project = { templates: [{ ...custom, entity: { hp: 888 } }] };
  assert.equal(templatesForDocument("units", project, { units: [custom] })[0].entity.hp, 888);
  assert.equal(templatesForDocument("units", { templates: "bad" }, { units: null })[0].entity.hp, 100);
});

test("feature scan picks future fields recursively across entities and array rows", () => {
  const doc = { units: [
    { key: "a", id: 0, hp: 10, new_feature: { amount: 4, modes: [{ enabled: true }] }, tiers: [{ hp: 12 }] },
    { key: "b", id: 1, hp: 20, new_feature: { duration: 60, modes: [{ radius: 3 }] }, tiers: [{ future_tier_field: 9 }] },
  ] };
  const schema = featureSchemaForDocument("units", doc);
  assert.equal(schema.root.new_feature.amount, 4);
  assert.equal(defaultsAtPath(schema, ["new_feature"]).duration, 60);
  assert.deepEqual(defaultsAtPath(schema, ["new_feature", "modes", 1]), { enabled: true, radius: 3 });
  assert.equal(defaultsAtPath(schema, ["tiers", 0]).future_tier_field, 9);
  assert.equal(defaultsAtPath(schema, ["tiers", 0]).color.length, 3);
  assert.equal(schema.root.id, undefined);
  schema.root.new_feature.amount = 999;
  assert.equal(doc.units[0].new_feature.amount, 4);
});

test("explicit future feature defaults work without any live entity example", () => {
  const doc = { units: [], templates: [{ key: "future", entity: {}, fields: { future: { count: 6, entries: [{ weight: 2 }] } } }] };
  const schema = featureSchemaForDocument("units", doc);
  assert.deepEqual(schema.root.future, { count: 6, entries: [{ weight: 2 }] });
  assert.deepEqual(defaultsAtPath(schema, ["future", "entries", 0]), { weight: 2 });
  assert.equal(defaultsAtPath(schema, ["lines", 0]).income, 1);
});

test("project nested defaults override RAM while nested identity-named fields remain ordinary fields", () => {
  const doc = { units: [], templates: [{ key: "standard", entity: {}, fields: {
    strike: { line_cells: 99 },
    warp: { templates: [{ weight: 9, slots: { "1": "test" } }] },
    future: { key: "nested", id: 7 },
  } }] };
  const schema = featureSchemaForDocument("units", doc);
  assert.equal(defaultsAtPath(schema, ["strike"]).line_cells, 99);
  assert.equal(defaultsAtPath(schema, ["warp"]).templates[0].weight, 9);
  assert.equal(defaultsAtPath(schema, ["warp", "templates", 0]).weight, 9);
  assert.deepEqual(defaultsAtPath(schema, ["future"]), { key: "nested", id: 7 });
});

test("nested field metadata is complete, layered and never instantiated as capabilities", () => {
  const tool = { buildings: [{ key: "standard", entity: {}, nested_fields: { "/lines": { upgrade: false, future_option: 4 } } }] };
  const doc = { buildings: [], templates: [{ key: "standard", entity: {}, nested_fields: {
    "/lines": { future_option: 9 },
    "/future~1name/options": { enabled: true },
  } }] };
  const schema = featureSchemaForDocument("buildings", doc, tool);
  assert.equal(defaultsAtPath(schema, ["lines", 0]).upgrade, false);
  assert.equal(defaultsAtPath(schema, ["lines", 0]).income, 1);
  assert.equal(defaultsAtPath(schema, ["lines", 0]).future_option, 9);
  assert.deepEqual(defaultsAtPath(schema, ["future/name", "options", 0]), { enabled: true });
  const base = builtinTemplate("buildings");
  assert.equal(base.fields.lines[0].income, undefined);
  assert.equal(instantiateTemplate(base, []).nested_fields, undefined);
  assert.deepEqual(builtinTemplate("units").nested_fields["/tiers"].color, [1, 1, 1]);
});

test("project field defaults win across different template keys", () => {
  const tool = { buildings: [{ key: "tool_custom", entity: {}, fields: { vision: 4 }, nested_fields: { "/lines": { income: 4 } } }] };
  const doc = { buildings: [], templates: [{ key: "standard", entity: {}, fields: { vision: 9 }, nested_fields: { "/lines": { income: 9 } } }] };
  const schema = featureSchemaForDocument("buildings", doc, tool);
  assert.equal(schema.root.vision, 9);
  assert.equal(defaultsAtPath(schema, ["lines", 0]).income, 9);
});

test("project/tool template metadata matches RAM and covers every current entity field", () => {
  const tool = JSON.parse(fs.readFileSync(new URL("../../entity-templates.json", import.meta.url), "utf8"));
  for (const kind of ["units", "buildings"]) {
    const file = JSON.parse(fs.readFileSync(new URL(`../../../project-rts/data/${kind}.json`, import.meta.url), "utf8"));
    const standard = builtinTemplate(kind);
    assert.deepEqual(tool[kind], [standard]);
    assert.deepEqual(file.templates, [standard]);
    const covered = new Set([...Object.keys(standard.entity), ...Object.keys(standard.fields)]);
    for (const entity of file[kind]) for (const key of Object.keys(entity)) assert(covered.has(key), `${kind}.${key}`);
    const first = builtinTemplate(kind);
    first.entity.hp = 9999;
    assert.notEqual(first.entity.hp, builtinTemplate(kind).entity.hp);
  }
});
