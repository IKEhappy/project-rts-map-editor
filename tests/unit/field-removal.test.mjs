import { test } from "node:test";
import assert from "node:assert/strict";
import { removeAtPath, setAtPath } from "../../src/renderer/field-path.ts";

test("deleting a production-line parameter retains its line, siblings, and immutable source", () => {
  const root = { buildings: [{ key: "mine", lines: [{ income: 1, upgrade: true }, { income: 2 }] }, { key: "hq" }], init: { resources: 200 } };
  const next = removeAtPath(root, ["buildings", 0, "lines", 0, "upgrade"]);
  assert.deepEqual(next.buildings[0].lines, [{ income: 1 }, { income: 2 }]);
  assert.equal(Object.hasOwn(next.buildings[0].lines[0], "upgrade"), false);
  assert.equal(root.buildings[0].lines[0].upgrade, true);
  assert.notEqual(next.buildings[0].lines[0], root.buildings[0].lines[0]);
  assert.equal(next.buildings[0].lines[1], root.buildings[0].lines[1]);
  assert.equal(next.buildings[1], root.buildings[1]);
  assert.equal(next.init, root.init);
  assert.deepEqual(JSON.parse(JSON.stringify(next)).buildings[0].lines[0], { income: 1 });
});

test("deleting the final line property leaves an explicit empty row for validation", () => {
  const root = { lines: [{ income: 1 }, { income: 2 }] };
  assert.deepEqual(removeAtPath(root, ["lines", 0, "income"]), { lines: [{}, { income: 2 }] });
  assert.deepEqual(root.lines, [{ income: 1 }, { income: 2 }]);
});

test("complex root fields, null fields, and numeric object keys can be removed and re-added", () => {
  for (const [root, path, value] of [
    [{ hp: 100, laser: { damage: 10 } }, ["laser"], { damage: 10 }],
    [{ nullable: null, hp: 100 }, ["nullable"], null],
    [{ warp: { slots: { "1": "cougar", "2": "puma" } } }, ["warp", "slots", "1"], "cougar"],
  ]) {
    const next = removeAtPath(root, path);
    assert.deepEqual(setAtPath(next, path, value), root);
  }
});

test("array removal compacts entries and missing paths leave the root untouched", () => {
  const root = { flags: ["strike", "anti_air", "friendly_fire"], nested: { enabled: true }, scalar: 2 };
  assert.deepEqual(removeAtPath(root, ["flags", 1]).flags, ["strike", "friendly_fire"]);
  for (const path of [["absent"], ["nested", "missing"], ["scalar", "missing"], ["flags", -1], ["flags", 1.5], ["flags", 3], ["flags", "1"], ["nested", 1]]) {
    assert.equal(removeAtPath(root, path), root, JSON.stringify(path));
  }
  assert.throws(() => removeAtPath(root, []), /field path/);
});

test("rules are deleted without changing other values or writing undefined", () => {
  const root = { version: 1, _note: "rules", optional_rule: false, retained_rule: 20 };
  const next = removeAtPath(root, ["optional_rule"]);
  assert.deepEqual(Object.keys(next), ["version", "_note", "retained_rule"]);
  assert.deepEqual(JSON.parse(JSON.stringify(next)), { version: 1, _note: "rules", retained_rule: 20 });
});
