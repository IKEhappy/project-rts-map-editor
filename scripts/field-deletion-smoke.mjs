import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { apiCall, click, createWorkspaceFixture, evaluate, launchEditor, reload, setInput, waitFor } from "./workspace-smoke.mjs";

/** Exercise every editing surface through CDP mouse input. All changes are
 * confined to a disposable workspace; both config and map saves use Godot. */
export async function runFieldDeletionSmoke({ client, fixture, artifacts }) {
  const checks = [], layouts = [], errors = [];
  const check = (name, condition, detail) => {
    assert(condition, `${name}: ${JSON.stringify(detail)}`);
    checks.push(name); console.log(`  ok: ${name}`);
  };
  const buildingsFile = path.join(fixture.project, "data", "buildings.json");
  const originalBuildings = fs.readFileSync(buildingsFile);
  const buildings = JSON.parse(originalBuildings);
  buildings.buildings.find((row) => row.key === "mine").lines[0].upgrade = true;
  fs.writeFileSync(buildingsFile, JSON.stringify(buildings, null, 2) + "\n");
  const mapFile = path.join(fixture.maps, "field_deletion.json");
  fs.writeFileSync(mapFile, JSON.stringify({
    version: 1, name: "field_deletion", width: 20, height: 18, default_terrain: 0, seed: 1,
    box_mode: [], terrain_patches: [], decor: [], init: {}, spawns: [],
    buildings: [{ key: "mine", x: 3, y: 3, w: 2, h: 2, team: 1, hp: 620, lines: [{ income: 1, upgrade: true }, { income: 2 }, { income: 3 }] }],
  }, null, 2));
  client.Runtime.exceptionThrown(({ exceptionDetails }) => errors.push(exceptionDetails.exception?.description || exceptionDetails.text));
  const pause = () => evaluate(client, "new Promise(r=>setTimeout(r,100))");
  const press = async (selector) => {
    const point = await evaluate(client, `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('Missing '+${JSON.stringify(selector)});e.scrollIntoView({block:'nearest',inline:'nearest'});const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;if(e.disabled||!e.contains(document.elementFromPoint(x,y)))throw new Error('Blocked '+${JSON.stringify(selector)});return{x,y}})()`);
    await client.Input.dispatchMouseEvent({ type: "mouseMoved", ...point });
    await client.Input.dispatchMouseEvent({ type: "mousePressed", button: "left", clickCount: 1, ...point });
    await client.Input.dispatchMouseEvent({ type: "mouseReleased", button: "left", clickCount: 1, ...point });
    await pause();
  };
  const object = (id) => `[data-testid=map-object-inspector] [data-testid="${id}"]`;
  const addStandard = async (field, parent = "", scope = "") => {
    await press(`${scope}[data-testid="add-field-btn-${parent}"]`);
    await evaluate(client, `(()=>{const s=document.querySelector(${JSON.stringify(`${scope}[data-testid="add-field-select-${parent}"]`)});if(![...s.options].some(o=>o.value===${JSON.stringify(field)}))throw new Error('Missing standard field');s.value=${JSON.stringify(field)};s.dispatchEvent(new Event('change',{bubbles:true}))})()`);
    await pause();
  };
  const chooseEntity = async (key) => {
    await setInput(client, "entity-search", key);
    await waitFor(client, "document.querySelectorAll('[data-testid=entity-item]').length === 1", `${key} search`);
    await click(client, "entity-item"); await pause();
  };
  try {
    await client.Page.bringToFront();
    await client.Emulation.setDeviceMetricsOverride({ width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
    await reload(client); await click(client, "tab-units");
    await waitFor(client, "!!document.querySelector('[data-testid=field-remove-hp]')", "unit field deletion controls");
    await chooseEntity("cougar");
    check("unit identity fields retain deletion protection", await evaluate(client, "document.querySelector('[data-testid=field-remove-id]').disabled && document.querySelector('[data-testid=field-remove-key]').disabled"));
    await addStandard("vision");
    await click(client, "field-remove-vision"); await pause();
    check("a newly added unit parameter can be removed", await evaluate(client, "!document.querySelector('[data-testid=field-vision]')"));
    await click(client, "config-undo-btn"); await pause();
    check("deletion undo restores only the deleted field after an immediate add", await evaluate(client, "!!document.querySelector('[data-testid=field-vision]')"));
    await click(client, "config-redo-btn"); await pause();
    await addStandard("vision"); await click(client, "field-remove-vision"); await pause();
    check("deleted unit fields can be re-added from the standard template", await evaluate(client, "!document.querySelector('[data-testid=field-vision]')"));

    await click(client, "tab-buildings");
    await waitFor(client, "!!document.querySelector('[data-kind=buildings] [data-testid=entity-search]')", "building editor ready");
    await chooseEntity("mine");
    await click(client, "field-remove-lines-0-upgrade"); await pause();
    check("building line parameter deletion preserves the resource line", await evaluate(client, "!document.querySelector('[data-testid=field-lines-0-upgrade]') && document.querySelector('[data-testid=field-lines-0-income]')?.value==='1' && !!document.querySelector('[data-testid=array-remove-lines-0]')"));
    await click(client, "config-save-btn");
    await waitFor(client, "!!document.querySelector('[data-testid=save-ok],[data-testid=save-errors]')", "deleted building parameter save", 180000);
    const configError = await evaluate(client, "document.querySelector('[data-testid=save-errors]')?.textContent"); assert(!configError, configError);
    const savedMine = JSON.parse(fs.readFileSync(buildingsFile)).buildings.find((row) => row.key === "mine");
    check("config save physically removes the field without removing its line", savedMine.lines.length === 3 && savedMine.lines[0].income === 1 && !Object.hasOwn(savedMine.lines[0], "upgrade"));

    await click(client, "tab-rules"); await waitFor(client, "!!document.querySelector('[data-testid^=rule-remove-]')", "rule deletion controls");
    const ruleId = await evaluate(client, "document.querySelector('[data-testid^=rule-remove-]').dataset.testid");
    await click(client, ruleId); await pause();
    check("independent rules table supports field deletion", await evaluate(client, `!document.querySelector('[data-testid="${ruleId}"]')`));
    await click(client, "config-undo-btn"); await pause();
    check("rule deletion participates in undo", await evaluate(client, `!!document.querySelector('[data-testid="${ruleId}"]')`));

    await click(client, "tab-maps"); await click(client, "map-item-field_deletion-json"); await click(client, "map-tool-none");
    await click(client, "map-view-reset"); await pause(); await client.Page.captureScreenshot({ format: "png" });
    await waitFor(client, "(()=>{const c=document.querySelector('[data-testid=map-canvas] canvas');return Math.abs(Number(c.dataset.cssW)-c.parentElement.clientWidth)<2})()", "map canvas resize");
    const point = await evaluate(client, "(()=>{const c=document.querySelector('[data-testid=map-canvas] canvas'),r=c.getBoundingClientRect();return{x:r.x+(3.5-Number(c.dataset.ox))*Number(c.dataset.ppc),y:r.y+(3.5-Number(c.dataset.oy))*Number(c.dataset.ppc)}})()");
    await client.Input.dispatchMouseEvent({ type: "mouseMoved", ...point });
    await client.Input.dispatchMouseEvent({ type: "mousePressed", button: "left", clickCount: 1, ...point });
    await client.Input.dispatchMouseEvent({ type: "mouseReleased", button: "left", clickCount: 1, ...point });
    await waitFor(client, "document.querySelector('[data-testid=map-object-inspector]')?.dataset.objectPath==='buildings-0'", "selected Object");
    await press(object("field-remove-lines-0-upgrade"));
    check("Object property grid deletes individual nested line parameters", await evaluate(client, `!document.querySelector('${object("field-lines-0-upgrade")}') && document.querySelector('${object("field-lines-0-income")}')?.value==='1'`));
    await click(client, "map-undo-btn"); await pause();
    check("Object field deletion supports undo", await evaluate(client, `!!document.querySelector('${object("field-lines-0-upgrade")}')`));
    await click(client, "map-redo-btn"); await pause();
    await addStandard("upgrade", "lines-0", "[data-testid=map-object-inspector] ");
    check("Object deleted fields can be re-added from their line template", await evaluate(client, `!!document.querySelector('${object("field-lines-0-upgrade")}')`));
    await press(object("field-remove-lines-0-upgrade"));
    await click(client, "map-json-toggle"); await pause();
    await click(client, "field-remove-buildings-0-hp"); await pause();
    check("whole-map JSON deletes a placement parameter while retaining its Object", await evaluate(client, "!document.querySelector('[data-testid=field-buildings-0-hp]') && !!document.querySelector('[data-testid=field-buildings-0-x]')"));
    await click(client, "field-remove-buildings-0-lines-0-income"); await pause();
    check("deleting the last line field leaves the row for explicit validation", await evaluate(client, "!document.querySelector('[data-testid=field-buildings-0-lines-0-income]') && !!document.querySelector('[data-testid=array-remove-buildings-0-lines-0]') && !!document.querySelector('[data-testid=field-buildings-0-lines-1-income]')"));
    await click(client, "map-undo-btn"); await pause(); await click(client, "map-json-toggle");
    await click(client, "map-save-btn");
    await waitFor(client, "!!document.querySelector('[data-testid=map-save-ok],[data-testid=map-save-errors]')", "deleted map fields save", 180000);
    const mapError = await evaluate(client, "document.querySelector('[data-testid=map-save-errors]')?.textContent"); assert(!mapError, mapError);
    const saved = JSON.parse(fs.readFileSync(mapFile));
    check("map save preserves resource lines and omits removed overrides", saved.buildings.length === 1 && saved.buildings[0].lines.length === 3 && saved.buildings[0].lines[0].income === 1 && !Object.hasOwn(saved.buildings[0], "hp") && !Object.hasOwn(saved.buildings[0].lines[0], "upgrade"));
    for (const [width, height] of [[1920, 1080], [1280, 720]]) {
      await client.Emulation.setDeviceMetricsOverride({ width, height, deviceScaleFactor: 1, mobile: false }); await client.Page.captureScreenshot({ format: "png" }); await pause();
      const layout = await evaluate(client, "(()=>{const p=document.querySelector('[data-testid=map-inspector]'),r=p.getBoundingClientRect();return{width:innerWidth,height:innerHeight,inside:r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight,overflow:p.scrollWidth>p.clientWidth+1,buttons:[...p.querySelectorAll('.field-remove')].length}})()");
      check(`deletion controls fit Object grid at ${width}x${height}`, layout.inside && !layout.overflow && layout.buttons > 0, layout); layouts.push(layout);
      fs.writeFileSync(path.join(artifacts, `field-deletion-${width}x${height}.png`), Buffer.from((await client.Page.captureScreenshot({ format: "png" })).data, "base64"));
    }
    check("field deletions produce no JavaScript exceptions", errors.length === 0, errors);
    fs.writeFileSync(path.join(artifacts, "field-deletion-report.json"), JSON.stringify({ checks, layouts, errors }, null, 2) + "\n");
    return { checks, layouts, errors };
  } finally {
    fs.writeFileSync(buildingsFile, originalBuildings);
    fs.rmSync(mapFile, { force: true });
  }
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const project = path.resolve(process.env.ME_GAME_DIR || path.join(root, "../project-rts"));
  const fixture = createWorkspaceFixture({ parent: path.join(os.tmpdir(), "field-deletion-smoke"), project });
  const artifacts = path.join(root, ".smoke-artifacts"); fs.mkdirSync(artifacts, { recursive: true });
  const editor = await launchEditor({ executable: path.join(root, "node_modules/electron/dist/electron.exe"), args: [root, `--user-data-dir=${path.join(fixture.root, "profile")}`, "--force-device-scale-factor=1", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"], cwd: root, port: 9237,
    env: { ME_MAP_PROJECT: fixture.project, ME_GODOT_PROJECT: project, ME_DATA_DIR: path.join(fixture.project, "data") } });
  try {
    await waitFor(editor.client, "!!window.meApi", "API");
    const opened = await apiCall(editor.client, "openWorkspace", { path: fixture.maps, projectRoot: fixture.project }); assert(opened.ok, opened.error);
    const report = await runFieldDeletionSmoke({ client: editor.client, fixture, artifacts }); console.log(`FIELD_DELETION_OK checks=${report.checks.length}`);
  } catch (error) {
    fs.writeFileSync(path.join(artifacts, "field-deletion-failure.png"), Buffer.from((await editor.client.Page.captureScreenshot({ format: "png" })).data, "base64")); throw error;
  } finally { await editor.close(); }
}
