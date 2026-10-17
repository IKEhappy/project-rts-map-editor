import test from "node:test";
import assert from "node:assert/strict";
import { buildingAbbreviationsOf, buildingDefsOf } from "../../src/renderer/map-edit-ops.ts";

test("building definitions retain display names for map pickers", () => {
  const defs = buildingDefsOf({ buildings: [{ key: "hq", name_cn: "总部", w: 4, h: 4 }] });
  assert.deepEqual(defs[0], { key: "hq", name_cn: "总部", w: 4, h: 4, hp: undefined });
});

test("duplicate building prefixes receive unique three-character labels", () => {
  const labels = buildingAbbreviationsOf([
    { key: "hq" },
    { key: "turret_guard" },
    { key: "turret_aa" },
    { key: "turret_ion" },
    { key: "tank_factory_m" },
    { key: "tank_factory_l" },
  ]);
  assert.equal(labels.hq, "hq");
  assert.equal(labels.turret_guard, "tug");
  assert.equal(labels.turret_aa, "tua");
  assert.equal(labels.turret_ion, "tui");
  assert.equal(labels.tank_factory_m, "tam");
  assert.equal(labels.tank_factory_l, "tal");
  assert.ok(Object.values(labels).every((label) => label.length <= 3));
  assert.equal(new Set(Object.values(labels)).size, Object.keys(labels).length);
});
