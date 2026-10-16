import { test } from "node:test";
import assert from "node:assert/strict";
import { FIELD_CREATABLE } from "../../src/renderer/field-defaults.ts";

test("FieldTree common field defaults cover unit/building additions", () => {
  assert.deepEqual(FIELD_CREATABLE, {
    lines: [],
    unlocked_lines: 1,
    income: 1,
    research: 1,
    speed_up: 1,
    level: 1,
    hp: 500,
    team: 1,
    count: 1,
  });
});

test("FieldTree lines default is a fresh array for each insertion", () => {
  const first = structuredClone(FIELD_CREATABLE.lines);
  const second = structuredClone(FIELD_CREATABLE.lines);
  assert.deepEqual(first, []);
  assert.deepEqual(second, []);
  assert.notEqual(first, second);
});

