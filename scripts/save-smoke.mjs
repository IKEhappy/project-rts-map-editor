import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { apiCall, click, createWorkspaceFixture, evaluate, launchEditor, reload, setInput, waitFor } from "./workspace-smoke.mjs";

export async function runSaveSmoke({ client, fixture, artifacts }) {
  const checks = [], heartbeat = [], errors = [];
  const file = path.join(fixture.maps, "save_smoke.json");
  const doc = { version: 1, name: "save_smoke", width: 40, height: 30, default_terrain: 0, seed: 1, box_mode: [], terrain_patches: [], buildings: [], spawns: [], decor: [], init: {} };
  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
  fs.mkdirSync(path.join(fixture.maps, '_assets'), { recursive: true });
  fs.copyFileSync(fixture.topdown, path.join(fixture.maps, '_assets', 'save-modes.png'));
  fs.writeFileSync(path.join(fixture.maps, 'save_modes.json'), JSON.stringify({ ...doc, name: 'save_modes', background: { topdown: 'res://data/maps/_assets/save-modes.png' } }, null, 2));
  const check = (name, condition, detail) => { assert(condition, `${name}: ${JSON.stringify(detail)}`); checks.push(name); console.log(`  ok: ${name}`); };
  client.Runtime.exceptionThrown(({ exceptionDetails }) => errors.push(exceptionDetails.exception?.description || exceptionDetails.text));
  client.Page.javascriptDialogOpening(async () => { await client.Page.handleJavaScriptDialog({ accept: true }).catch(() => {}); });
  const pause = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms));
  const saving = () => evaluate(client, "!!document.querySelector('[data-testid=map-saving]')");
  const dirty = () => evaluate(client, "document.querySelector('[data-testid=map-dirty-chip]')?.textContent.trim()==='未保存'");
  const input = (testId, value) => evaluate(client, `(()=>{const i=document.querySelector('[data-testid="${testId}"]');if(!i)throw new Error('Missing ${testId}');i.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,${JSON.stringify(String(value))});i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const ctrl = async (key, code, vk) => {
    await client.Input.dispatchKeyEvent({ type: "keyDown", key, code, windowsVirtualKeyCode: vk, modifiers: 2 });
    await client.Input.dispatchKeyEvent({ type: "keyUp", key, code, windowsVirtualKeyCode: vk, modifiers: 0 });
  };
  const saveKey = () => ctrl("s", "KeyS", 83);
  const done = async (label) => {
    await waitFor(client, "!document.querySelector('[data-testid=map-saving]') && !!document.querySelector('[data-testid=map-save-ok],[data-testid=map-save-errors]')", label, 240000);
    const error = await evaluate(client, "document.querySelector('[data-testid=map-save-errors]')?.textContent"); assert(!error, error);
  };
  const requireSaving = (label) => waitFor(client, "!!document.querySelector('[data-testid=map-saving]')", label, 10000);
  const read = (target = file) => JSON.parse(fs.readFileSync(target, "utf8"));
  let monitor = true;
  const heartbeats = async () => {
    while (monitor) {
      const start = performance.now();
      const result = await apiCall(client, "labels");
      heartbeat.push({ ms: Number((performance.now() - start).toFixed(1)), ok: result?.ok, saving: await saving() });
      if (monitor) await pause(100);
    }
  };
  let monitorPromise;
  try {
    await client.Page.bringToFront();
    await client.Emulation.setDeviceMetricsOverride({ width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
    await reload(client); await click(client, "tab-maps"); await click(client, "map-item-save_modes-json");
    await click(client, "map-json-toggle");
    await waitFor(client, "!!document.querySelector('[data-testid=field-background-topdown]')", "whole image mode fields");
    await click(client, "map-mode-tiles");
    await waitFor(client, "!document.querySelector('[data-testid=field-background-topdown]') && document.querySelector('[data-testid=map-mode-tiles]').classList.contains('active')", "mode change commits after its async resource check");
    check("switching from whole image to tiles applies the document change", await dirty());
    await click(client, "map-undo-btn");
    await waitFor(client, "!!document.querySelector('[data-testid=field-background-topdown]')", "mode change undo");
    check("mode changes retain ordinary undo and disk baseline", !await dirty());
    await click(client, "map-item-save_smoke-json");
    await waitFor(client, "!!document.querySelector('[data-testid=field-name]')", "save JSON editor");
    await input("field-name", "snapshot_A"); await saveKey(); await requireSaving("first background save begins");
    monitorPromise = heartbeats();
    await input("field-name", "snapshot_B"); await saveKey();
    await input("field-name", "snapshot_C"); await saveKey();
    check("latest edits remain editable while a save is active", await evaluate(client, "document.querySelector('[data-testid=field-name]')?.value==='snapshot_C' && !!document.querySelector('[data-testid=map-saving]')"));
    await click(client, "tab-units");
    await waitFor(client, "!!document.querySelector('[data-kind=units] [data-testid=entity-search]')", "unit tab opens during map save");
    check("other editing tabs remain usable during background map save", await evaluate(client, "document.querySelector('[data-testid=tab-units]')?.classList.contains('active')"));
    await click(client, "tab-maps"); await click(client, "map-json-toggle"); await client.Page.captureScreenshot({ format: "png" });
    const pan = await evaluate(client, "(()=>{const c=document.querySelector('[data-testid=map-canvas] canvas'),r=c.getBoundingClientRect();return{x:r.x+r.width*.55,y:r.y+r.height*.4,ox:Number(c.dataset.ox),oy:Number(c.dataset.oy)}})()");
    await client.Input.dispatchMouseEvent({ type: "mouseMoved", x: pan.x, y: pan.y });
    await client.Input.dispatchMouseEvent({ type: "mousePressed", button: "middle", buttons: 4, clickCount: 1, x: pan.x, y: pan.y });
    for (let i = 1; i <= 5; i++) await client.Input.dispatchMouseEvent({ type: "mouseMoved", button: "middle", buttons: 4, x: pan.x + i * 15, y: pan.y + i * 8 });
    await client.Input.dispatchMouseEvent({ type: "mouseReleased", button: "middle", buttons: 0, clickCount: 1, x: pan.x + 75, y: pan.y + 40 });
    await pause();
    check("canvas pan remains responsive during background saving", await evaluate(client, `(()=>{const c=document.querySelector('[data-testid=map-canvas] canvas');return Number(c.dataset.ox)!==${pan.ox} || Number(c.dataset.oy)!==${pan.oy}})()`));
    await done("coalesced saves finish"); monitor = false; await monitorPromise; monitorPromise = null;
    const activeHeartbeat = heartbeat.filter((row) => row.saving);
    check("main-process IPC stays responsive throughout Godot validation", activeHeartbeat.length >= 3 && activeHeartbeat.every((row) => row.ok && row.ms < 1000), heartbeat);
    check("A B C requests write only active A and newest pending C", read().name === "snapshot_C" && read(`${file}.bak`).name === "snapshot_A", { current: read().name, backup: read(`${file}.bak`).name });
    check("latest saved snapshot clears dirty only when memory matches", !await dirty());
    await click(client, "map-json-toggle"); await input("field-name", "snapshot_D"); await saveKey(); await requireSaving("second background save begins");
    await input("field-name", "unsaved_E"); await done("save without resubmission completes");
    check("edits after a submitted save survive and remain dirty", read().name === "snapshot_D" && await evaluate(client, "document.querySelector('[data-testid=field-name]')?.value==='unsaved_E'") && await dirty());
    await saveKey(); await done("unsaved latest edit commits");

    await click(client, "map-new-btn"); await waitFor(client, "!!document.querySelector('[data-testid=json-target-name]')", "new map editor");
    const unique = `save_new_${Date.now()}`;
    await setInput(client, "field-name", unique); await setInput(client, "field-seed", 201);
    // Separate prep from the first in-flight edit in the ordinary typing
    // history; no artificial delay is added to the actual save operation.
    await pause(700);
    await saveKey(); await requireSaving("new map first save begins");
    await input("field-seed", 301); await done("new map first save completes");
    const newFile = path.join(fixture.maps, `${unique}.json`);
    check("first save acquires a filename while preserving newer in-memory edits", fs.existsSync(newFile) && read(newFile).seed === 201 && await evaluate(client, "document.querySelector('[data-testid=field-seed]')?.value==='301'") && await dirty());
    await click(client, "map-undo-btn"); await pause();
    check("first-save key migration retains undo history", await evaluate(client, "document.querySelector('[data-testid=field-seed]')?.value==='201'") && !await dirty());
    await click(client, "map-redo-btn"); await pause();
    check("first-save key migration retains redo history", await evaluate(client, "document.querySelector('[data-testid=field-seed]')?.value==='301'") && await dirty());
    await click(client, "map-undo-btn"); await pause();
    await input("field-seed", 401); await saveKey(); await requireSaving("save before baseline undo");
    await click(client, "map-undo-btn"); await pause();
    check("undo to disk baseline still offers save during an active write", !await dirty() && await evaluate(client, "!document.querySelector('[data-testid=map-save-btn]').disabled"));
    await click(client, "map-save-btn"); await done("queued baseline undo saves");
    check("saving the undo snapshot prevents an older active write from winning", read(newFile).seed === 201 && read(`${newFile}.bak`).seed === 401 && !await dirty());

    await input("field-seed", 501);
    const external = read(newFile); external.seed = 777; fs.writeFileSync(newFile, JSON.stringify(external, null, 2) + "\n");
    await saveKey();
    await waitFor(client, "!document.querySelector('[data-testid=map-saving]') && !!document.querySelector('[data-testid=map-save-errors]')", "external conflict rejection", 240000);
    check("external conflict preserves both disk changes and local edits", read(newFile).seed === 777 && await evaluate(client, "document.querySelector('[data-testid=map-save-errors]')?.textContent.includes('文件冲突') && document.querySelector('[data-testid=field-seed]')?.value==='501'") && await dirty());
    await click(client, "map-reload-doc-btn");
    await waitFor(client, "document.querySelector('[data-testid=field-seed]')?.value==='777' && !document.querySelector('[data-testid=map-save-errors]')", "conflicted document reload");
    check("conflicted save can reload the new disk baseline", !await dirty());

    // The close dialog invokes saveAll. An earlier invalid document must stay
    // visible even when another document subsequently saves successfully.
    await input("field-seed", 888);
    await click(client, "map-item-save_smoke-json"); await setInput(client, "field-width", 0);
    await click(client, "win-close-btn"); await waitFor(client, "!!document.querySelector('[data-testid=close-modal]')", "close-save dialog");
    await click(client, "close-save-btn");
    await waitFor(client, "!document.querySelector('[data-testid=close-modal]') && !document.querySelector('[data-testid=map-saving]') && !!document.querySelector('[data-testid=map-save-errors]')", "saveAll returns invalid document", 240000);
    check("saveAll failure prevents closing and returns to the failed map", await evaluate(client, "document.querySelector('[data-testid=field-width]')?.value==='0' && document.querySelector('[data-testid=map-save-errors]')?.textContent.includes('save_smoke.json')"));
    check("saveAll still commits other valid documents", read(newFile).seed === 888);

    await setInput(client, "field-width", 40); await saveKey(); await done("invalid saveAll document repaired");
    await click(client, `map-item-${unique}-json`);
    const rename = async (from, to) => {
      const point = await evaluate(client, `(()=>{const e=document.querySelector('[data-testid="map-item-${from}-json"]');if(!e)throw new Error('Map to rename missing');e.scrollIntoView({block:'nearest',inline:'nearest'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      await client.Input.dispatchMouseEvent({ type: "mouseMoved", ...point });
      await client.Input.dispatchMouseEvent({ type: "mousePressed", button: "right", clickCount: 1, ...point });
      await client.Input.dispatchMouseEvent({ type: "mouseReleased", button: "right", clickCount: 1, ...point });
      await waitFor(client, "!!document.querySelector('[data-testid=list-ctx-rename]')", "map context rename");
      await click(client, "list-ctx-rename");
      await input("rename-input", to); await click(client, "rename-ok");
      await waitFor(client, `!document.querySelector('[data-testid=rename-modal]') && !!document.querySelector('[data-testid="map-item-${to}-json"]')`, `rename ${from} to ${to}`);
      await waitFor(client, "!document.querySelector('[data-testid=map-new-btn]').disabled", "rename mutation completes");
    };
    const renamed = `${unique}_renamed`;
    const renamedFile = path.join(fixture.maps, `${renamed}.json`);
    await rename(unique, renamed);
    check("first-saved map can rename its file and backup together", !fs.existsSync(newFile) && fs.existsSync(renamedFile) && fs.existsSync(`${renamedFile}.bak`));
    await input("field-seed", 999); await saveKey(); await done("renamed first-save map saves edited state");
    check("new edits save to renamed first-save map without stale queue aliases", read(renamedFile).seed === 999 && read(`${renamedFile}.bak`).seed === 888 && !fs.existsSync(newFile) && !await dirty());
    await click(client, "map-undo-btn"); await pause();
    check("file rename preserves existing undo history", await evaluate(client, "document.querySelector('[data-testid=field-seed]')?.value==='888'") && await dirty());
    await click(client, "map-redo-btn"); await pause();
    await rename(renamed, unique);
    await input("field-seed", 1001); await saveKey(); await done("renamed-back map saves edited state");
    check("renaming back to the previous filename does not create an alias cycle", read(newFile).seed === 1001 && read(`${newFile}.bak`).seed === 999 && !fs.existsSync(renamedFile) && !await dirty());

    await click(client, "map-item-save_smoke-json"); await input("field-seed", 1111);
    fs.unlinkSync(file);
    await click(client, "map-new-btn"); await input("field-name", "save_smoke"); await saveKey();
    await waitFor(client, "!document.querySelector('[data-testid=map-saving]') && !!document.querySelector('[data-testid=map-save-errors]')", "new save rejects an existing in-memory destination", 10000);
    check("first save cannot replace another open document after its disk file is removed", !fs.existsSync(file) && await evaluate(client, "document.querySelector('[data-testid=map-save-errors]')?.textContent.includes('工作副本')"));
    await click(client, `map-item-${unique}-json`);
    const collisionPoint = await evaluate(client, `(()=>{const e=document.querySelector('[data-testid="map-item-${unique}-json"]');e.scrollIntoView({block:'nearest',inline:'nearest'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await client.Input.dispatchMouseEvent({ type: "mouseMoved", ...collisionPoint });
    await client.Input.dispatchMouseEvent({ type: "mousePressed", button: "right", clickCount: 1, ...collisionPoint });
    await client.Input.dispatchMouseEvent({ type: "mouseReleased", button: "right", clickCount: 1, ...collisionPoint });
    await click(client, "list-ctx-rename"); await input("rename-input", "save_smoke"); await click(client, "rename-ok");
    await waitFor(client, "document.querySelector('[data-testid=rename-modal]')?.textContent.includes('工作副本')", "rename collision reports the open destination", 10000);
    check("file rename cannot overwrite an open working copy whose disk file was deleted", fs.existsSync(newFile) && !fs.existsSync(file) && await evaluate(client, "!!document.querySelector('[data-testid=rename-modal]')"));
    await click(client, "rename-cancel"); await click(client, "map-item-save_smoke-json");
    check("both rejected destination operations retain the original unsaved document", await evaluate(client, "document.querySelector('[data-testid=field-seed]')?.value==='1111'") && await dirty());
    check("background-save scenarios produce no JavaScript exceptions", errors.length === 0, errors);
    fs.writeFileSync(path.join(artifacts, "save-fixed.png"), Buffer.from((await client.Page.captureScreenshot({ format: "png" })).data, "base64"));
    fs.writeFileSync(path.join(artifacts, "save-report.json"), JSON.stringify({ checks, heartbeat, errors }, null, 2) + "\n");
    return { checks, heartbeat, errors };
  } finally {
    monitor = false;
    if (monitorPromise) await monitorPromise.catch(() => {});
  }
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const project = path.resolve(process.env.ME_GAME_DIR || path.join(root, "../project-rts"));
  const fixture = createWorkspaceFixture({ parent: path.join(os.tmpdir(), "save-smoke"), project });
  const artifacts = path.join(root, ".smoke-artifacts"); fs.mkdirSync(artifacts, { recursive: true });
  const editor = await launchEditor({ executable: path.join(root, "node_modules/electron/dist/electron.exe"), args: [root, `--user-data-dir=${path.join(fixture.root, "profile")}`, "--force-device-scale-factor=1", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"], cwd: root, port: 9239,
    env: { ME_MAP_PROJECT: fixture.project, ME_GODOT_PROJECT: project, ME_DATA_DIR: path.join(fixture.project, "data") } });
  try {
    await waitFor(editor.client, "!!window.meApi", "API");
    const opened = await apiCall(editor.client, "openWorkspace", { path: fixture.maps, projectRoot: fixture.project }); assert(opened.ok, opened.error);
    const report = await runSaveSmoke({ client: editor.client, fixture, artifacts }); console.log(`SAVE_OK checks=${report.checks.length}`);
  } catch (error) {
    fs.writeFileSync(path.join(artifacts, "save-failure.png"), Buffer.from((await editor.client.Page.captureScreenshot({ format: "png" })).data, "base64")); throw error;
  } finally { await editor.close(); }
}
