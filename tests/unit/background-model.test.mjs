import { test } from "node:test";
import assert from "node:assert/strict";
import { backgroundForView, withBackgroundSlot, withoutBackground } from "../../src/renderer/background-model.ts";
import { validateMapTree } from "../../src/renderer/light-validation.ts";

const image = (path) => ({ path, dataUrl: `data:${path}`, width: 64, height: 64 });
test("view fallback follows the runtime and skips failed image loads", () => {
  const info = { images: { tilt: image("tilt"), image: image("shared"), topdown: { path: "bad", error: "missing" } } };
  assert.equal(backgroundForView(info, "topdown").path, "shared");
  assert.equal(backgroundForView(info, "tilt").path, "tilt");
  assert.equal(backgroundForView({ images: { tilt: image("tilt") } }, "topdown").path, "tilt");
  assert.equal(backgroundForView({ images: { topdown: { error: "bad" } } }, "topdown"), null);
});
test("import changes only the requested map background slot", () => {
  const doc = { renderer: "res://data/render/default.json", background: { tilt: "old" }, box_mode: [] };
  const next = withBackgroundSlot(doc, "topdown", "new");
  assert.deepEqual(next.background, { tilt: "old", topdown: "new" });
  assert.deepEqual(doc.background, { tilt: "old" });
  assert.equal(next.renderer, doc.renderer);
  assert.equal(next.box_mode, doc.box_mode);
  assert.deepEqual(withoutBackground(next), { renderer: doc.renderer, box_mode: [] });
  assert.equal(next.background.topdown, "new");
});
test("background feedback rejects bad shapes and traversal while keeping empty objects valid", () => {
  assert.equal(validateMapTree({ width: 8, height: 8, background: {} }).size, 0);
  assert.ok(validateMapTree({ width: 8, height: 8, background: [] }).has("background"));
  assert.ok(validateMapTree({ width: 8, height: 8, background: { topdown: "res://assets/../bad.png" } }).has("background-topdown"));
  assert.equal(validateMapTree({ width: 8, height: 8, background: { tilt: "res://assets/map.png", image: "" } }).size, 0);
});
test("malformed placement rows are reported without crashing the map workspace", () => {
  const errors = validateMapTree({ width: 8, height: 8, buildings: [null, [], { key: "a", x: 1, y: 1, w: 2, h: 2 }, { key: "b", x: 1, y: 1, w: 2, h: 2 }], spawns: [null, { x: 1, y: 1 }] });
  assert.ok(errors.has("buildings-0"));
  assert.ok(errors.has("buildings-1"));
  assert.ok(errors.has("buildings-2-overlap"));
  assert.ok(errors.has("spawns-0"));
  assert.ok(errors.has("spawns-1-overlap"));
  const shapes = validateMapTree({ width: 8, height: 8, terrain_patches: [null, []], box_mode: false, decor: [null] });
  assert.ok(shapes.has("terrain_patches-0"));
  assert.ok(shapes.has("terrain_patches-1"));
  assert.ok(shapes.has("box_mode"));
  assert.ok(shapes.has("decor-0"));
});
