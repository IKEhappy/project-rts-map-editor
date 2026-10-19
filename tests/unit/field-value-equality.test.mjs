import { test } from "node:test";
import assert from "node:assert/strict";
import { equalFieldValue } from "../../src/renderer/field-value-equality.ts";
import { setAtPath } from "../../src/renderer/field-path.ts";

test("dirty markers compare JSON values while ignoring object key order", () => {
  assert.equal(equalFieldValue({ hp: 100, lines: [{ unit: "cougar", ticks: 60 }] }, { lines: [{ ticks: 60, unit: "cougar" }], hp: 100 }), true);
  assert.equal(equalFieldValue({ hp: 100 }, { hp: "100" }), false);
  assert.equal(equalFieldValue({ value: null }, {}), false);
  assert.equal(equalFieldValue([], {}), false);
  assert.equal(equalFieldValue(undefined, undefined), true);
});

test("array edits and reordering remain dirty", () => {
  assert.equal(equalFieldValue(["ground", "air"], ["air", "ground"]), false);
  assert.equal(equalFieldValue([{ unit: "cougar", tier: 1 }], [{ unit: "cougar", tier: 2 }]), false);
  assert.equal(equalFieldValue([1, 2], [1]), false);
});

test("restoring a leaf through immutable writes clears the parent dirty marker", () => {
  const original = { buildings: [{ key: "mine", lines: [{ income: 1 }] }], flags: ["ground"] };
  const loaded = structuredClone(original);
  assert.equal(equalFieldValue(loaded, original), true);
  const changed = setAtPath(loaded, ["buildings", 0, "lines", 0, "income"], 9);
  assert.equal(equalFieldValue(changed, original), false);
  assert.strictEqual(changed.flags, loaded.flags);
  const restored = setAtPath(changed, ["buildings", 0, "lines", 0, "income"], 1);
  assert.notStrictEqual(restored, original);
  assert.equal(equalFieldValue(restored, original), true);
});
