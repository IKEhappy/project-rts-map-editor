import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { builtinTemplate, templatesForDocument } from "../../src/renderer/schema-templates.ts";
import { instantiateTemplate } from "../../src/renderer/templates.ts";

const require = createRequire(import.meta.url);

function isolatedStore(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "map-editor-templates-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const main = path.join(root, "src", "main");
  fs.mkdirSync(main, { recursive: true });
  for (const name of ["store.cjs", "assets.cjs"]) {
    fs.copyFileSync(new URL(`../../src/main/${name}`, import.meta.url), path.join(main, name));
  }
  return { store: require(path.join(main, "store.cjs")), file: path.join(root, "entity-templates.json") };
}

function assertRamFallback(result) {
  assert.equal(result.ok, false);
  assert.equal(typeof result.error, "string");
  assert(result.error.length > 0);
  for (const kind of ["units", "buildings"]) {
    const standard = templatesForDocument(kind, undefined, result.data).find((template) => template.key === "standard");
    assert(standard, `${kind}: RAM standard unavailable after template read failure`);
    const entity = instantiateTemplate(standard, []);
    assert.equal(entity.key, kind === "units" ? "new_unit_1" : "new_building_1");
    assert.equal(entity.hp, kind === "units" ? 100 : 500);
    assert.equal(Object.hasOwn(entity, "lines"), false);
  }
}

test("readEditorTemplates reads optional file from the isolated tool root", (t) => {
  const { store, file } = isolatedStore(t);
  const config = { units: [builtinTemplate("units")], buildings: [builtinTemplate("buildings")] };
  config.units[0].entity.hp = 777;
  config.buildings[0].entity.hp = 888;
  fs.writeFileSync(file, JSON.stringify(config));
  const result = store.readEditorTemplates();
  assert.equal(result.ok, true);
  assert.equal(result.path, file);
  assert.deepEqual(result.data, config);
  for (const kind of ["units", "buildings"]) {
    const entity = instantiateTemplate(templatesForDocument(kind, undefined, result.data)[0], []);
    assert.equal(entity.hp, config[kind][0].entity.hp);
  }
});

test("missing optional template file returns a failure and retains usable RAM templates", (t) => {
  const { store, file } = isolatedStore(t);
  assert.equal(fs.existsSync(file), false);
  let result;
  assert.doesNotThrow(() => { result = store.readEditorTemplates(); });
  assert.equal(result.path, file);
  assertRamFallback(result);
});

test("invalid template JSON returns a failure and retains usable RAM templates", (t) => {
  const { store, file } = isolatedStore(t);
  const invalid = '{"units":[';
  fs.writeFileSync(file, invalid);
  let result;
  assert.doesNotThrow(() => { result = store.readEditorTemplates(); });
  assert.equal(result.path, file);
  assert.equal(fs.readFileSync(file, "utf8"), invalid);
  assertRamFallback(result);
});
