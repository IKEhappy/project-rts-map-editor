import { test } from "node:test";
import assert from "node:assert/strict";
import { validateMapTree } from "../../src/renderer/light-validation.ts";
import { setAtPath } from "../../src/renderer/field-path.ts";

const map = () => ({
  width: 32, height: 32,
  buildings: [{ key: "a", x: 1, y: 1, w: 2, h: 2, hp: 100 }, { key: "b", x: 2, y: 2, w: 2, h: 2 }],
  spawns: [{ x: 1, y: 1 }, { x: 1, y: 1 }],
});

test("non-geometric edits preserve collision warnings without sharing mutable result maps", () => {
  const doc = map();
  const warnings = validateMapTree(doc);
  assert.ok(warnings.has("buildings-0-overlap"));
  assert.ok(warnings.has("spawns-0-overlap"));
  assert.ok(warnings.has("spawns-0-dup"));
  const edited = setAtPath(doc, ["buildings", 0, "hp"], 200);
  assert.deepEqual(validateMapTree(edited), warnings);
  warnings.clear();
  assert.equal(validateMapTree(edited).size, 4);
});

test("geometry, display key and original row index invalidate the appropriate collision messages", () => {
  const doc = map();
  validateMapTree(doc);
  const renamed = setAtPath(doc, ["buildings", 1, "key"], "new_b");
  assert.match(validateMapTree(renamed).get("buildings-0-overlap"), /new_b/);
  const moved = setAtPath(renamed, ["buildings", 1, "x"], 10);
  assert.equal(validateMapTree(moved).has("buildings-0-overlap"), false);
  const reordered = { ...doc, buildings: [null, doc.buildings[1], doc.buildings[0]] };
  const reorderedErrors = validateMapTree(reordered);
  assert.ok(reorderedErrors.has("buildings-0"));
  assert.match(reorderedErrors.get("buildings-1-overlap"), /b 与 a/);
  const removed = { ...doc, buildings: [doc.buildings[0]], spawns: [] };
  assert.equal(validateMapTree(removed).size, 0);
});

test("spawn movement, duplicate occupancy and building size changes refresh warnings", () => {
  const doc = map();
  validateMapTree(doc);
  const moved = setAtPath(doc, ["spawns", 0, "x"], 8);
  const movedErrors = validateMapTree(moved);
  assert.equal(movedErrors.has("spawns-0-overlap"), false);
  assert.equal(movedErrors.has("spawns-0-dup"), false);
  const widened = setAtPath(moved, ["buildings", 0, "w"], 10);
  assert.ok(validateMapTree(widened).has("spawns-0-overlap"));
  const rowChange = { ...moved, spawns: [{ x: 8, y: 1, count: 3 }, moved.spawns[1]] };
  assert.deepEqual(validateMapTree(rowChange), movedErrors);
});

test("numeric coercion and non-finite geometry retain the original comparison behavior", () => {
  const doc = { width: 32, height: 32, buildings: [{ key: "a", x: "1", y: 1, w: "2", h: 2 }, { key: "b", x: 2, y: 1, w: 1, h: 1 }] };
  assert.ok(validateMapTree(doc).has("buildings-0-overlap"));
  const invalid = setAtPath(doc, ["buildings", 0, "w"], NaN);
  assert.equal(validateMapTree(invalid).has("buildings-0-overlap"), false);
  const infinite = setAtPath(invalid, ["buildings", 0, "w"], Infinity);
  assert.ok(validateMapTree(infinite).has("buildings-0-overlap"));
  assert.equal(validateMapTree(invalid).has("buildings-0-overlap"), false);
});
