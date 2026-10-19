import { test } from "node:test";
import assert from "node:assert/strict";
import { setAtPath } from "../../src/renderer/field-path.ts";

test("new tactical warp flag can change independently of the cloned strike flag", () => {
  const root = { key: "tactical_warp", flags: ["air", "strike", "strike"] };
  const next = setAtPath(root, ["flags", 2], "anti_air");
  assert.deepEqual(next.flags, ["air", "strike", "anti_air"]);
  assert.deepEqual(root.flags, ["air", "strike", "strike"]);
  assert.deepEqual(setAtPath(next, ["flags", 2], "friendly_fire").flags, ["air", "strike", "friendly_fire"]);
});

test("scalar arrays retain their element types and preserve unrecognized future flags", () => {
  for (const [root, path, value, expected] of [
    [{ flags: ["future_custom_flag", "strike"] }, ["flags", 1], "anti_air", { flags: ["future_custom_flag", "anti_air"] }],
    [{ auto_attack_targets: ["units", "buildings"] }, ["auto_attack_targets", 0], "turrets", { auto_attack_targets: ["turrets", "buildings"] }],
    [{ color: [0.1, 0.2, 0.3] }, ["color", 1], 0.8, { color: [0.1, 0.8, 0.3] }],
    [{ future_switches: [false, false] }, ["future_switches", 0], true, { future_switches: [true, false] }],
    [{ flags: ["strike"] }, ["flags", 0], "future_custom_flag", { flags: ["future_custom_flag"] }],
  ]) assert.deepEqual(setAtPath(root, path, value), expected);
});

test("nested objects and arrays replace only the path branches", () => {
  const root = { buildings: [{ key: "mine", lines: [{ income: 1 }, { income: 2 }] }, { key: "hq" }], box: { access: [0, 1] } };
  const next = setAtPath(root, ["buildings", 0, "lines", 1, "income"], 3);
  assert.equal(next.buildings[0].lines[1].income, 3);
  assert.equal(root.buildings[0].lines[1].income, 2);
  assert.notEqual(next, root);
  assert.notEqual(next.buildings, root.buildings);
  assert.notEqual(next.buildings[0], root.buildings[0]);
  assert.notEqual(next.buildings[0].lines, root.buildings[0].lines);
  assert.equal(next.buildings[0].lines[0], root.buildings[0].lines[0]);
  assert.equal(next.buildings[1], root.buildings[1]);
  assert.equal(next.box, root.box);
  assert.deepEqual(setAtPath(root, ["box", "access", 1], 3).box.access, [0, 3]);
});

test("root fields and added path prefixes use the expected containers", () => {
  const root = { hp: 200, warp: { templates: [] } };
  const hp = setAtPath(root, ["hp"], 300);
  assert.equal(hp.hp, 300);
  assert.equal(hp.warp, root.warp);
  assert.deepEqual(setAtPath({}, ["warp", "templates", 0, "slots", "1"], "cougar"), { warp: { templates: [{ slots: { "1": "cougar" } }] } });
  assert.throws(() => setAtPath(root, [], 300), /field path/);
});
