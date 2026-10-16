import { test } from "node:test";
import assert from "node:assert/strict";
import { instantiateTemplate, templatesOf } from "../../src/renderer/templates.ts";

test("templatesOf keeps only usable unit/building templates", () => {
  const file = {
    templates: [
      { key: "unit", name_cn: "单位", entity: { hp: 10 } },
      { key: "building", name_cn: "建筑", key_prefix: "hq", entity: { hp: 100 } },
      null,
      { key: "missing-entity", name_cn: "坏模板" },
      { key: 7, name_cn: "坏 key", entity: {} },
      { key: "array-entity", name_cn: "坏实体", entity: [] },
    ],
  };
  assert.deepEqual(templatesOf(file).map((template) => template.key), ["unit", "building"]);
  assert.deepEqual(templatesOf({ templates: "bad" }), []);
});

test("instantiateTemplate deep-clones data and assigns stable unique key/id", () => {
  const template = {
    key: "tank",
    name_cn: "坦克",
    key_prefix: "custom",
    entity: { hp: 100, key: "ignored", id: 42, nested: { flags: ["air"] } },
  };
  const rows = [{ id: 4, key: "custom_1" }, { id: 12, key: "other" }];
  const created = instantiateTemplate(template, rows);
  assert.deepEqual(created, {
    id: 13,
    key: "custom_2",
    hp: 100,
    nested: { flags: ["air"] },
    name_cn: "坦克2",
  });
  created.nested.flags.push("strike");
  assert.deepEqual(template.entity.nested.flags, ["air"]);
  assert.deepEqual(rows, [{ id: 4, key: "custom_1" }, { id: 12, key: "other" }]);
});

test("instantiateTemplate preserves template without numeric id and uses default prefix/name", () => {
  const created = instantiateTemplate({ key: "turret", name_cn: "炮塔", entity: { key: "x", range: 5 } }, []);
  assert.deepEqual(created, { key: "new_turret_1", range: 5, name_cn: "炮塔" });
});

