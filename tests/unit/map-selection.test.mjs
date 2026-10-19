import { test } from "node:test";
import assert from "node:assert/strict";
import { remapMapSelections } from "../../src/renderer/map-selection.ts";

const building = (index) => ({ kind: "building", index });
const spawn = (index) => ({ kind: "spawn", index });

test("deleting the selected row clears selection while deleting a preceding row follows its identity", () => {
  const a = { key: "mine", x: 1 };
  const b = { key: "mine", x: 3 };
  const c = { key: "mine", x: 5 };
  const before = { buildings: [a, b, c] };
  assert.deepEqual(remapMapSelections(before, { buildings: [a, c] }, [building(1)]), []);
  assert.deepEqual(remapMapSelections(before, { buildings: [a, c] }, [building(2)]), [building(1)]);
});

test("reordering follows references and preserves mixed building/spawn selection order", () => {
  const a = { key: "mine" }, b = { key: "mine" };
  const s1 = { kind: 1 }, s2 = { kind: 1 };
  const before = { buildings: [a, b], spawns: [s1, s2] };
  const after = { buildings: [b, a], spawns: [s2, s1] };
  assert.deepEqual(remapMapSelections(before, after, [spawn(1), building(0), building(1)]), [spawn(0), building(1), building(0)]);
});

test("same-length scalar edits and cloned undo snapshots retain the selected index", () => {
  const doc = { buildings: [{ key: "mine", hp: 100 }, { key: "mine", hp: 200 }] };
  const changed = { buildings: [{ ...doc.buildings[0], hp: 101 }, doc.buildings[1]] };
  assert.deepEqual(remapMapSelections(doc, changed, [building(0)]), [building(0)]);
  assert.deepEqual(remapMapSelections(changed, structuredClone(doc), [building(1)]), [building(1)]);
  assert.deepEqual(remapMapSelections(doc, { ...doc, name: "renamed" }, [building(0)]), [building(0)]);
});

test("a same-length delete/insert does not select a different surviving old row", () => {
  const a = { key: "mine" }, b = { key: "mine" }, inserted = { key: "mine" };
  const before = { buildings: [a, b] };
  assert.deepEqual(remapMapSelections(before, { buildings: [b, inserted] }, [building(0), building(1)]), [building(0)]);
});

test("changed-length replacements, missing arrays and malformed row selections clear safely", () => {
  const a = { key: "mine" };
  const doc = { buildings: [a, null], spawns: [{ kind: 1 }] };
  assert.deepEqual(remapMapSelections(doc, { buildings: [{ ...a }] }, [building(0), building(1), spawn(0)]), []);
  assert.deepEqual(remapMapSelections(doc, {}, [building(0), spawn(0)]), []);
  assert.deepEqual(remapMapSelections(doc, { buildings: false, spawns: [] }, [building(0), spawn(0)]), []);
  assert.deepEqual(remapMapSelections(doc, doc, [building(-1), building(4), building(0.5), building(NaN)]), []);
});

test("repeated references map by occurrence without merging selections", () => {
  const row = { key: "mine" }, other = { key: "hq" };
  const before = { buildings: [row, other, row] };
  const after = { buildings: [row, row, other] };
  assert.deepEqual(remapMapSelections(before, after, [building(0), building(2), building(1)]), [building(0), building(1), building(2)]);
});
