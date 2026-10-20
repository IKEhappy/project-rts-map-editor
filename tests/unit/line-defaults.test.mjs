import { test } from "node:test";
import assert from "node:assert/strict";
import { isUsableProductionLine, productionLineForAppend } from "../../src/renderer/line-defaults.ts";

test("production line validity accepts unit or functional effect rows", () => {
  assert.equal(isUsableProductionLine({ unit: "tactical_fire", tier: 1 }), true);
  assert.equal(isUsableProductionLine({ income: 1 }), true);
  assert.equal(isUsableProductionLine({ research: 2 }), true);
  assert.equal(isUsableProductionLine({ speed_up: 3 }), true);
  assert.equal(isUsableProductionLine({ unit: "" }), false);
  assert.equal(isUsableProductionLine({ unit: "", ticks: 60 }), false);
  assert.equal(isUsableProductionLine({ income: 0 }), false);
  assert.equal(isUsableProductionLine({}), false);
});

test("appending lines skips invalid placeholders and uses the definition defaults", () => {
  const mine = productionLineForAppend(
    [{ unit: "", tier: 2, ticks: 60 }],
    [{ income: 1 }, { income: 2 }, { income: 3 }],
    [],
  );
  assert.deepEqual(mine, { income: 1 });

  const radar = productionLineForAppend(
    [],
    [{ unit: "tactical_fire", produce_ticks: 300 }],
    [],
  );
  assert.deepEqual(radar, { unit: "tactical_fire", produce_ticks: 300 });
});

test("appending lines falls back to a known unit when no definition row exists", () => {
  assert.deepEqual(
    productionLineForAppend([], [], [{ key: "new_unit", label: "new_unit" }]),
    { unit: "new_unit", tier: 1, ticks: 60 },
  );
  assert.deepEqual(productionLineForAppend([], [], []), { unit: "cougar", tier: 1, ticks: 60 });
});

test("appending does not mutate source rows or defaults", () => {
  const existing = [{ income: 1 }];
  const defaults = [{ unit: "tactical_fire", produce_ticks: 300 }];
  const next = productionLineForAppend(existing, defaults);
  next.income = 9;
  assert.deepEqual(existing, [{ income: 1 }]);
  assert.deepEqual(defaults, [{ unit: "tactical_fire", produce_ticks: 300 }]);
});
