import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { click, evaluate, setInput, waitFor } from "./workspace-smoke.mjs";

/** Scalar-array edits use real dropdown clicks and the normal configuration gate. */
export async function runFlagsSmoke({ client, fixture, artifacts }) {
  const checks = [], runtimeErrors = [];
  const unitsFile = path.join(fixture.project, "data", "units.json");
  const original = fs.readFileSync(unitsFile);
  client.Runtime.exceptionThrown(({ exceptionDetails }) => runtimeErrors.push(exceptionDetails.exception?.description || exceptionDetails.text));
  client.Runtime.consoleAPICalled(({ type, args }) => { if (type === "error") runtimeErrors.push(args.map((arg) => arg.value ?? arg.description).join(" ")); });
  const check = (name, condition) => {
    assert(condition, name);
    checks.push(name);
    console.log(`  ok: ${name}`);
  };
  const value = (testId) => evaluate(client, `document.querySelector(${JSON.stringify(`[data-testid="${testId}"]`)})?.dataset.value`);
  const choose = async (testId, next) => {
    await click(client, testId);
    await click(client, `${testId}-opt-${next}`);
    await waitFor(client, `document.querySelector(${JSON.stringify(`[data-testid="${testId}"]`)})?.dataset.value === ${JSON.stringify(next)}`, `${testId} changes to ${next}`);
  };
  const select = async (key) => {
    await setInput(client, "entity-search", key);
    await waitFor(client, "document.querySelectorAll('[data-testid=entity-item]').length === 1", `${key} list item`);
    await click(client, "entity-item");
    await waitFor(client, `document.querySelector('[data-testid=field-key]')?.textContent === ${JSON.stringify(key)}`, `${key} selected`);
  };
  try {
    await click(client, "tab-units");
    await waitFor(client, "!!document.querySelector('[data-testid=entity-search]')", "unit editor for scalar-array checks");
    await select("tactical_warp");
    const initial = JSON.parse(original).units.find((unit) => unit.key === "tactical_warp").flags.length;
    const addedId = `field-flags-${initial}`;
    await click(client, "array-add-flags");
    check("new tactical warp flag clones strike and remains selectable", await value(addedId) === "strike");
    await choose(addedId, "anti_air");
    // ConfigsPanel coalesces consecutive "field" edits within 600 ms. Give
    // the next intentional edit a separate undo step even with a warm UI.
    await new Promise((resolve) => setTimeout(resolve, 650));
    await choose(addedId, "friendly_fire");
    check("new flag supports repeated dropdown changes", await value(addedId) === "friendly_fire");
    await click(client, "config-undo-btn");
    await waitFor(client, `document.querySelector('[data-testid=${addedId}]')?.dataset.value === 'anti_air'`, "flag undo");
    await click(client, "config-redo-btn");
    await waitFor(client, `document.querySelector('[data-testid=${addedId}]')?.dataset.value === 'friendly_fire'`, "flag redo");
    check("flag edits participate in configuration undo and redo", true);
    await click(client, "array-add-auto_attack_targets");
    await choose("field-auto_attack_targets-0", "buildings");
    check("another top-level enum array remains editable", await value("field-auto_attack_targets-0") === "buildings");

    await select("cougar");
    await click(client, "array-add-flags");
    await choose("field-flags-0", "anti_air");
    check("an initially empty normal-unit flag array is editable", await value("field-flags-0") === "anti_air");
    await click(client, "save-btn");
    await waitFor(client, "!!document.querySelector('[data-testid=save-ok], [data-testid=save-errors]')", "scalar-array configuration save", 180000);
    const saveError = await evaluate(client, "document.querySelector('[data-testid=save-errors]')?.innerText");
    assert(!saveError, `Scalar-array save rejected: ${saveError}`);
    const saved = JSON.parse(fs.readFileSync(unitsFile));
    const warp = saved.units.find((unit) => unit.key === "tactical_warp");
    check("edited flags and target enum persist through the Godot save gate", warp.flags[initial] === "friendly_fire" && warp.auto_attack_targets[0] === "buildings" && saved.units.find((unit) => unit.key === "cougar").flags[0] === "anti_air");
    await click(client, "config-reload-btn");
    await waitFor(client, "document.querySelector('[data-testid=configs-panel]')?.getAttribute('aria-busy') === 'false' && !document.querySelector('[data-testid=save-ok]')", "scalar-array reload");
    await select("tactical_warp");
    check("saved flag values survive a configuration reload", await value(addedId) === "friendly_fire");

    warp.flags.push("future_custom_flag");
    fs.writeFileSync(unitsFile, JSON.stringify(saved, null, 2) + "\n");
    await click(client, "config-reload-btn");
    const unknownId = `field-flags-${initial + 1}`;
    await waitFor(client, `document.querySelector('[data-testid=${unknownId}]')?.dataset.value === 'future_custom_flag'`, "future flag fallback");
    await click(client, "array-add-flags");
    await choose(`field-flags-${initial + 2}`, "anti_air");
    check("editing a cloned future flag preserves the existing unknown value", await value(unknownId) === "future_custom_flag");
    await choose(unknownId, "aa_immune");
    check("an existing unrecognized flag can switch to a known option", await value(unknownId) === "aa_immune");
    const screenshot = await client.Page.captureScreenshot({ format: "png" });
    fs.mkdirSync(artifacts, { recursive: true });
    fs.writeFileSync(path.join(artifacts, "flags-fixed.png"), Buffer.from(screenshot.data, "base64"));
    check("scalar-array interactions produce no JavaScript errors", runtimeErrors.length === 0);
    fs.writeFileSync(path.join(artifacts, "flags-report.json"), JSON.stringify({ ok: true, checks, runtimeErrors }, null, 2) + "\n");
    return { checks, runtimeErrors };
  } finally {
    // Only the disposable fixture changes, and subsequent smoke stages get the
    // exact configuration bytes they started with.
    fs.writeFileSync(unitsFile, original);
  }
}
