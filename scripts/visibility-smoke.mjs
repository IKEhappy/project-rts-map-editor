import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { apiCall, click, createWorkspaceFixture, evaluate, launchEditor, reload, waitFor } from "./workspace-smoke.mjs";

/** Visibility controls operate on a disposable map through real mouse events. */
export async function runVisibilitySmoke({ client, fixture, artifacts }) {
  const checks = [], layouts = [], runtimeErrors = [];
  const name = "visibility_ui_smoke.json", mapFile = path.join(fixture.maps, name);
  const assetDirectory = path.join(fixture.maps, "_assets", "visibility_ui_smoke");
  assert(!fs.existsSync(mapFile) && !fs.existsSync(assetDirectory), "Visibility fixture paths must be unused");
  const units = JSON.parse(fs.readFileSync(path.join(fixture.project, "data", "units.json"))).units;
  const cougar = units.find((entry) => entry.key === "cougar"), advancer = units.find((entry) => entry.key === "advancer");
  assert(cougar && advancer, "Visibility fixture unit definitions exist");
  const doc = {
    version: 1, name: "visibility_ui_smoke", width: 16, height: 12, default_terrain: 0, seed: 1,
    buildings: [], spawns: [], init: { spawns: [] }, decor: [{ kind: "tree", x: 10, y: 2 }],
    box_mode: [{ start: { w: 12, h: 7 }, end: { w: 12, h: 7 }, access: 3, build: 1 }],
  };
  const cells = [];
  for (const [team, y, group] of [[1, 1, "own"], [2, 4, "enemy"], [0, 7, "neutral"]]) {
    doc.buildings.push({ key: "mine", team, x: 1, y, w: 2, h: 2 });
    doc.buildings.push({ key: "turret_guard", team, x: 4, y, w: 1, h: 1 });
    doc.spawns.push({ kind: cougar.id, team, x: 6, y, count: 1 });
    doc.init.spawns.push({ kind: advancer.id, team, x: 8, y, count: 1 });
    cells.push(
      { x: 1, y, key: "mine", kind: "buildings", group },
      { x: 4, y, key: "turret_guard", kind: "turrets", group },
      { x: 6, y, key: "cougar", kind: "units", group },
      { x: 8, y, key: "advancer", kind: "units", group },
    );
  }
  const check = (label, condition, detail) => {
    assert(condition, `${label}${detail ? `: ${JSON.stringify(detail)}` : ""}`);
    checks.push(label); console.log(`  ok: ${label}`);
  };
  client.Runtime.exceptionThrown(({ exceptionDetails }) => runtimeErrors.push(exceptionDetails.exception?.description || exceptionDetails.text));
  client.Runtime.consoleAPICalled(({ type, args }) => { if (type === "error") runtimeErrors.push(args.map((arg) => arg.value ?? arg.description).join(" ")); });
  const checkbox = (id) => `[data-testid="map-visibility-${id}"]`;
  const checked = (id) => evaluate(client, `document.querySelector(${JSON.stringify(checkbox(id))})?.checked`);
  const state = () => evaluate(client, "JSON.parse(document.querySelector('[data-testid=map-canvas] canvas').dataset.visibility)");
  const settled = async () => {
    // Electron may throttle requestAnimationFrame for a background test window.
    // The bounded task delay still lets React effects and the compositor settle.
    await evaluate(client, "new Promise(resolve => setTimeout(resolve, 100))");
    await client.Page.captureScreenshot({ format: "png" });
  };
  const opened = () => evaluate(client, "document.querySelector('[data-testid=map-visibility-toggle]')?.getAttribute('aria-expanded') === 'true'");
  const panel = async (open = true) => {
    if (await opened() !== open) await click(client, "map-visibility-toggle");
    await waitFor(client, `document.querySelector('[data-testid=map-visibility-toggle]')?.getAttribute('aria-expanded') === '${open}'`, `visibility panel ${open ? "opens" : "closes"}`);
    // Captures drive Electron's compositor even when Windows backgrounds the
    // independent smoke window. Animation.finished alone can then stay pending.
    await client.Page.captureScreenshot({ format: "png" });
    await evaluate(client, "new Promise(resolve => setTimeout(resolve, 220))");
    await settled();
  };
  const change = async (id, next) => {
    await panel();
    if (await checked(id) !== next) await click(client, `map-visibility-${id}`);
    await waitFor(client, `document.querySelector(${JSON.stringify(checkbox(id))})?.checked === ${next}`, `${id} checkbox ${next}`);
    await settled();
  };
  const pointAt = (x, y) => evaluate(client, `(() => {
    const canvas=document.querySelector('[data-testid=map-canvas] canvas'),r=canvas.getBoundingClientRect();
    const scale=r.width/Number(canvas.dataset.cssW),ppc=Number(canvas.dataset.ppc),projection=canvas.dataset.projection==='tilt'?.75:1;
    const result={x:r.left+(${x}+.5-Number(canvas.dataset.ox))*ppc*scale,y:r.top+(${y}+.5-Number(canvas.dataset.oy))*ppc*scale*projection};
    if(result.x<r.left||result.x>r.right||result.y<r.top||result.y>r.bottom)throw new Error('Visibility fixture point is outside canvas');
    return result;
  })()`);
  const move = async (x, y) => {
    const point = await pointAt(x, y);
    await client.Input.dispatchMouseEvent({ type: "mouseMoved", ...point });
    await waitFor(client, `document.querySelector('[data-testid=map-hover-coordinates]')?.textContent === '(${x},${y})'`, `visibility hover (${x},${y})`);
    return evaluate(client, "document.querySelector('[data-testid=map-hover-objects]')?.textContent || ''");
  };
  const clearHover = async () => {
    await client.Input.dispatchMouseEvent({ type: "mouseMoved", x: 5, y: 5 });
    await settled();
  };
  const pixels = async (x, y, options = {}) => {
    await clearHover();
    return evaluate(client, `(() => {
      const canvas=document.querySelector('[data-testid=map-canvas] canvas'),ctx=canvas.getContext('2d');
      const ratio=canvas.width/Number(canvas.dataset.cssW),ppc=Number(canvas.dataset.ppc),projection=canvas.dataset.projection==='tilt'?.75:1;
      const pad=${options.edge ? 0 : 0.08};
      const left=Math.round((${x}+pad-Number(canvas.dataset.ox))*ppc*ratio),top=Math.round((${y}+pad-Number(canvas.dataset.oy))*ppc*ratio*projection);
      const w=Math.max(1,Math.round(ppc*(1-pad*2)*ratio)),h=Math.max(1,Math.round(ppc*(1-pad*2)*ratio*projection));
      const data=ctx.getImageData(left,top,w,h).data;let hash=2166136261,green=0;
      for(let i=0;i<data.length;i++){hash=Math.imul(hash^data[i],16777619);if(i%4===0&&data[i+1]>data[i]*1.3&&data[i+1]>data[i+2]*1.3)green++;}
      return {hash:hash>>>0,green,pixels:data.length/4,first:[...data.slice(0,4)]};
    })()`);
  };
  const open = async () => {
    await click(client, "tab-maps");
    await click(client, "map-reload-btn");
    await waitFor(client, "!!document.querySelector('[data-testid=map-item-visibility_ui_smoke-json]')", "visibility fixture list item");
    await click(client, "map-item-visibility_ui_smoke-json");
    await waitFor(client, "document.querySelector('[data-testid=map-item-visibility_ui_smoke-json]')?.classList.contains('active') && !!document.querySelector('[data-testid=map-canvas] canvas')", "visibility fixture canvas");
    await click(client, "map-inspector-tab-map");
    await click(client, "map-view-topdown");
    await click(client, "map-tool-none");
    await settled();
    await evaluate(client, `(() => {
      window.visibilityEventTrace=[];
      for(const type of ['pointerdown','pointerup','mousedown','mouseup','click'])for(const capture of [true,false])document.addEventListener(type,event=>{
        window.visibilityEventTrace.push({type,capture,target:event.target?.closest('[data-testid]')?.dataset.testid,prevented:event.defaultPrevented,x:event.clientX,y:event.clientY,time:performance.now()});
        window.visibilityEventTrace=window.visibilityEventTrace.slice(-80);
      },capture);
    })()`);
  };
  const allDefault = async () => {
    await change("all-teams", true);
    for (const id of ["buildings", "turrets", "units"]) await change(id, true);
    for (const id of ["background", "render", "objects", "grid", "boxes"]) await change(id, false);
    await panel(false);
  };
  const unchanged = async (bytes) => {
    assert(fs.readFileSync(mapFile).equals(bytes), "Visibility controls cannot rewrite map bytes");
    return evaluate(client, "!document.querySelector('[data-testid=map-dirty-chip]').classList.contains('dirty')");
  };
  const saveLayout = async (width, height, theme) => {
    await panel(false);
    await click(client, "theme-trigger");
    await click(client, `theme-${theme}`);
    await client.Emulation.setDeviceMetricsOverride({ width, height, deviceScaleFactor: 1, mobile: false, screenWidth: width, screenHeight: height });
    await waitFor(client, `innerWidth === ${width} && innerHeight === ${height} && document.documentElement.dataset.theme === '${theme}'`, "visibility layout viewport and theme");
    await waitFor(client, "(() => {const c=document.querySelector('[data-testid=map-canvas] canvas');return Math.abs(Number(c.dataset.cssW)-c.parentElement.clientWidth)<2&&Math.abs(Number(c.dataset.cssH)-c.parentElement.clientHeight)<2})()", "visibility layout canvas settled");
    await panel();
    const layout = await evaluate(client, `(() => {
      const p=document.querySelector('[data-testid=map-visibility-panel]'),r=p.getBoundingClientRect(),c=document.querySelector('[data-testid=map-canvas] canvas').getBoundingClientRect();
      const button=document.querySelector('[data-testid=map-visibility-toggle]').getBoundingClientRect();
      const controls=[...p.querySelectorAll('input[type=checkbox]')].map(input=>{const z=input.getBoundingClientRect();return {id:input.dataset.testid,inside:z.left>=r.left&&z.right<=r.right&&z.top>=r.top&&z.bottom<=r.bottom,clickable:input===document.elementFromPoint(z.left+z.width/2,z.top+z.height/2)}});
      return {width:innerWidth,height:innerHeight,theme:document.documentElement.dataset.theme,rect:{left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height},inside:r.left>=c.left-1&&r.top>=c.top-1&&r.right<=c.right+1&&r.bottom<=c.bottom+1,leftOfButton:r.right<=button.left+1,horizontalOverflow:p.scrollWidth>p.clientWidth+1,controls};
    })()`);
    check(`visibility panel remains reachable in ${theme} at ${width}x${height}`, layout.inside && layout.leftOfButton && !layout.horizontalOverflow && layout.controls.length === 12 && layout.controls.every((entry) => entry.inside && entry.clickable), layout);
    const screenshot = await client.Page.captureScreenshot({ format: "png" });
    fs.writeFileSync(path.join(artifacts, `visibility-${theme}-${width}x${height}.png`), Buffer.from(screenshot.data, "base64"));
    layouts.push(layout);
  };
  try {
    fs.mkdirSync(artifacts, { recursive: true });
    fs.writeFileSync(mapFile, JSON.stringify(doc, null, 2) + "\n");
    await waitFor(client, "!!window.meApi", "visibility preload API");
    const workspace = await apiCall(client, "getWorkspace");
    if (!workspace.workspace) {
      const result = await apiCall(client, "openWorkspace", { path: fixture.maps, projectRoot: fixture.project });
      assert(result.ok, result.error);
    }
    await reload(client);
    await client.Page.bringToFront();
    await client.Emulation.setDeviceMetricsOverride({ width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false, screenWidth: 1920, screenHeight: 1080 });
    await open();
    const original = fs.readFileSync(mapFile);
    const defaults = await state();
    check("visibility defaults retain all teams, kinds and layers", Object.values(defaults.teams).every(Boolean) && Object.values(defaults.kinds).every(Boolean) && !defaults.hideBackground && !defaults.hideRender && !defaults.hideObjects && !defaults.hideGrid && !defaults.hideBoxes, defaults);
    const builds = await evaluate(client, "Number(document.querySelector('[data-testid=map-canvas] canvas').dataset.staticBuilds)");
    await click(client, "map-visibility-toggle");
    const animation = await evaluate(client, `(() => {const p=document.querySelector('[data-testid=map-visibility-panel]'),s=getComputedStyle(p);return {duration:s.transitionDuration,animations:p.getAnimations().map(a=>({duration:a.effect.getTiming().duration,frames:a.effect.getKeyframes().map(f=>({transform:f.transform,opacity:f.opacity}))}))}})()`);
    await panel();
    const durations = animation.duration.split(",").map((item) => parseFloat(item) * (item.trim().endsWith("ms") ? 1 : 1000));
    check("visibility panel opens with a nonzero transition", durations.some((duration) => duration > 0) || animation.animations.some((entry) => entry.duration > 0), animation);
    check("opening a visibility panel does not rebuild the static map", await evaluate(client, "Number(document.querySelector('[data-testid=map-canvas] canvas').dataset.staticBuilds)") === builds);
    await panel(false);
    check("the side button closes its open panel", await opened() === false);
    await panel();
    await client.Input.dispatchKeyEvent({ type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await client.Input.dispatchKeyEvent({ type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await waitFor(client, "document.querySelector('[data-testid=map-visibility-toggle]')?.getAttribute('aria-expanded') === 'false'", "Escape closes visibility panel");
    check("Escape closes the floating visibility panel", true);
    for (const entry of cells) check(`default view shows ${entry.group} ${entry.key}`, (await move(entry.x, entry.y)).includes(entry.key));
    const baselinePixels = await Promise.all(cells.map((entry) => pixels(entry.x, entry.y)));
    for (const [group, id] of [["own", "own"], ["enemy", "enemy"], ["neutral", "neutral"]]) {
      await change(id, false);
      const master = await evaluate(client, "(() => {const c=document.querySelector('[data-testid=map-visibility-all-teams]');return {checked:c.checked,indeterminate:c.indeterminate}})()");
      check(`hiding ${group} sets the team master to mixed`, !master.checked && master.indeterminate, master);
      await panel(false);
      for (const [index, entry] of cells.entries()) {
        const visible = (await pixels(entry.x, entry.y)).hash === baselinePixels[index].hash;
        check(`${group} filter ${entry.group === group ? "hides" : "keeps"} ${entry.group} ${entry.key} pixels`, visible === (entry.group !== group));
      }
      const index = cells.findIndex((entry) => entry.group === group && entry.kind === "buildings");
      check(`${group} filter changes actual building pixels`, (await pixels(cells[index].x, cells[index].y)).hash !== baselinePixels[index].hash);
      await change(id, true);
    }
    await change("all-teams", false);
    check("the team master can uncheck every team", !Object.values((await state()).teams).some(Boolean));
    await panel(false);
    check("all teams unchecked hides actual objects", (await pixels(1, 1)).hash !== baselinePixels[0].hash);
    await change("all-teams", true);
    for (const kind of ["buildings", "turrets", "units"]) {
      await change(kind, false);
      await panel(false);
      for (const entry of cells.filter((entry) => entry.group === "own")) {
        const index = cells.indexOf(entry);
        check(`${kind} kind checkbox ${entry.kind === kind ? "hides" : "keeps"} ${entry.key} pixels`, ((await pixels(entry.x, entry.y)).hash === baselinePixels[index].hash) === (entry.kind !== kind));
      }
      const index = cells.findIndex((entry) => entry.kind === kind);
      check(`${kind} kind checkbox changes actual object pixels`, (await pixels(cells[index].x, cells[index].y)).hash !== baselinePixels[index].hash);
      await change(kind, true);
    }
    await change("own", false);
    await change("turrets", false);
    await panel(false);
    check("team and kind filters intersect in actual rendered pixels", (await pixels(1, 1)).hash !== baselinePixels[0].hash && (await pixels(1, 4)).hash === baselinePixels[4].hash && (await pixels(4, 4)).hash !== baselinePixels[5].hash && (await pixels(6, 4)).hash === baselinePixels[6].hash);
    await allDefault();

    const decor = await pixels(10, 2), box = await pixels(12, 7), grid = await pixels(11, 5, { edge: true }), plain = await pixels(11, 5);
    await change("background", true); await panel(false);
    const hiddenTerrain = await pixels(11, 5);
    check("tile background can be hidden without removing game overlays", hiddenTerrain.hash !== plain.hash && hiddenTerrain.green === 0 && (await move(1, 1)).includes("mine"));
    await change("background", false); await panel(false);
    check("restoring tile background restores exact terrain pixels", (await pixels(11, 5)).hash === plain.hash);
    await change("render", true); await panel(false);
    check("hide render removes actual decor pixels", (await pixels(10, 2)).hash !== decor.hash);
    check("hide render preserves collision box pixels", (await pixels(12, 7)).hash === box.hash);
    check("hide render preserves actual game objects", (await pixels(1, 1)).hash === baselinePixels[0].hash && (await move(1, 1)).includes("mine"));
    await change("render", false); await panel(false);
    check("restoring render restores exact decor pixels", (await pixels(10, 2)).hash === decor.hash);
    await change("grid", true); await panel(false);
    check("hide grid removes only grid-line pixels", (await pixels(11, 5, { edge: true })).hash !== grid.hash && (await pixels(11, 5)).hash === plain.hash);
    check("hide grid preserves collision boxes and objects", (await pixels(12, 7)).hash === box.hash && (await pixels(1, 1)).hash === baselinePixels[0].hash);
    await change("grid", false);
    await change("boxes", true); await panel(false);
    check("hide box_mode removes collision overlays independently of the grid", (await pixels(12, 7)).hash !== box.hash && (await pixels(11, 5, { edge: true })).hash === grid.hash);
    check("hide box_mode preserves render decorations and game objects", (await pixels(10, 2)).hash === decor.hash && (await pixels(1, 1)).hash === baselinePixels[0].hash);
    await move(12, 7);
    const hiddenBoxHint = await evaluate(client, "document.querySelector('[data-testid=map-hover-box]')?.textContent || ''");
    check("hover continues to inspect hidden box_mode source configuration", hiddenBoxHint.includes("box_mode[0]") && hiddenBoxHint.includes("access=3") && hiddenBoxHint.includes("build=1"), hiddenBoxHint);
    await click(client, "map-tool-move-shape");
    const boxTarget = await pointAt(12, 7), boxDragEnd = await pointAt(13, 9);
    await client.Input.dispatchMouseEvent({ type: "mouseMoved", ...boxTarget });
    await client.Input.dispatchMouseEvent({ type: "mousePressed", button: "left", buttons: 1, clickCount: 1, ...boxTarget });
    await client.Input.dispatchMouseEvent({ type: "mouseMoved", button: "left", buttons: 1, ...boxDragEnd });
    await client.Input.dispatchMouseEvent({ type: "mouseReleased", button: "left", buttons: 0, clickCount: 1, ...boxDragEnd });
    await settled();
    check("hidden box_mode cannot begin a shape move", await unchanged(original));
    await click(client, "map-tool-delete");
    await client.Input.dispatchMouseEvent({ type: "mouseMoved", ...boxTarget });
    await client.Input.dispatchMouseEvent({ type: "mousePressed", button: "left", buttons: 1, clickCount: 1, ...boxTarget });
    await client.Input.dispatchMouseEvent({ type: "mouseReleased", button: "left", buttons: 0, clickCount: 1, ...boxTarget });
    await settled();
    check("hidden box_mode cannot be deleted through the canvas", await unchanged(original));
    await click(client, "map-tool-none");
    await change("boxes", false); await panel(false);
    check("restoring box_mode restores its exact overlay pixels", (await pixels(12, 7)).hash === box.hash);
    await change("objects", true); await panel(false);
    check("hover retains true source information while objects are hidden", (await move(1, 1)).includes("mine") && (await move(6, 1)).includes("cougar") && (await move(8, 1)).includes("advancer"));
    check("hide objects changes actual object pixels", (await pixels(1, 1)).hash !== baselinePixels[0].hash && (await pixels(6, 1)).hash !== baselinePixels[2].hash);
    const target = await pointAt(1, 1);
    await client.Input.dispatchMouseEvent({ type: "mouseMoved", ...target });
    await client.Input.dispatchMouseEvent({ type: "mousePressed", button: "right", buttons: 2, clickCount: 1, ...target });
    await client.Input.dispatchMouseEvent({ type: "mouseReleased", button: "right", buttons: 0, clickCount: 1, ...target });
    await settled();
    check("hidden objects cannot open entity context menus", await evaluate(client, "!document.querySelector('[data-testid=building-ctx-menu], [data-testid=spawn-ctx-menu]')"));
    await client.Input.dispatchKeyEvent({ type: "keyDown", key: "2", code: "Digit2", windowsVirtualKeyCode: 50 });
    await client.Input.dispatchKeyEvent({ type: "keyUp", key: "2", code: "Digit2", windowsVirtualKeyCode: 50 });
    check("number-key team changes cannot mutate a hidden hovered object", await unchanged(original));
    await click(client, "map-tool-move-unit");
    const dragEnd = await pointAt(11, 9);
    await client.Input.dispatchMouseEvent({ type: "mouseMoved", ...target });
    await client.Input.dispatchMouseEvent({ type: "mousePressed", button: "left", buttons: 1, clickCount: 1, ...target });
    await client.Input.dispatchMouseEvent({ type: "mouseMoved", button: "left", buttons: 1, ...dragEnd });
    await client.Input.dispatchMouseEvent({ type: "mouseReleased", button: "left", buttons: 0, clickCount: 1, ...dragEnd });
    await settled();
    check("hidden objects cannot begin an object move", await unchanged(original));
    await click(client, "map-tool-delete");
    await client.Input.dispatchMouseEvent({ type: "mouseMoved", ...target });
    await client.Input.dispatchMouseEvent({ type: "mousePressed", button: "left", buttons: 1, clickCount: 1, ...target });
    await client.Input.dispatchMouseEvent({ type: "mouseReleased", button: "left", buttons: 0, clickCount: 1, ...target });
    await settled();
    check("hidden objects cannot be deleted through a filtered-out hit", await unchanged(original));
    await click(client, "map-tool-none");
    await change("objects", false); await panel(false);
    check("restoring objects restores the exact rendered pixels", (await pixels(1, 1)).hash === baselinePixels[0].hash);

    await click(client, "map-tool-building"); await panel();
    const outside = await pointAt(13, 9);
    await client.Input.dispatchMouseEvent({ type: "mouseMoved", ...outside });
    await client.Input.dispatchMouseEvent({ type: "mousePressed", button: "left", buttons: 1, clickCount: 1, ...outside });
    await client.Input.dispatchMouseEvent({ type: "mouseReleased", button: "left", buttons: 0, clickCount: 1, ...outside });
    await waitFor(client, "document.querySelector('[data-testid=map-visibility-toggle]')?.getAttribute('aria-expanded') === 'false'", "canvas click closes visibility panel");
    check("one outside click closes the panel without placing an accidental building", await unchanged(original));
    await click(client, "map-tool-none");
    for (const size of [[1920, 1080], [1280, 720]]) for (const theme of ["dark", "light"]) await saveLayout(...size, theme);
    await panel(false);
    await click(client, "map-inspector-tab-map");
    await click(client, "map-view-tilt");
    await waitFor(client, "document.querySelector('[data-testid=map-canvas] canvas')?.dataset.projection === 'tilt'", "visibility tilt view");
    const ownTilt = await pixels(1, 1), enemyTilt = await pixels(1, 4);
    await change("own", false); await panel(false);
    check("visibility controls remain usable in read-only tilt view", (await pixels(1, 1)).hash !== ownTilt.hash && (await pixels(1, 4)).hash === enemyTilt.hash);
    await allDefault();
    await click(client, "map-inspector-tab-map");
    await click(client, "map-view-topdown");
    check("every visibility-only interaction leaves the map clean and disk bytes intact", await unchanged(original));

    const imported = await apiCall(client, "importImage", { mapId: "visibility_ui_smoke", view: "topdown", sourcePath: fixture.topdown });
    assert(imported.ok, imported.error);
    doc.background = { image: imported.path };
    fs.writeFileSync(mapFile, JSON.stringify(doc, null, 2) + "\n");
    const imageBytes = fs.readFileSync(mapFile);
    await reload(client); await open();
    await waitFor(client, "document.querySelector('[data-testid=map-canvas] canvas')?.dataset.background === 'true'", "visibility whole image decoded");
    const image = await pixels(11, 5);
    await change("background", true); await panel(false);
    const hidden = await pixels(11, 5);
    check("hide background removes image pixels without exposing fallback green terrain", hidden.hash !== image.hash && hidden.green === 0, { image, hidden });
    check("background visibility preserves object and box overlays", (await move(1, 1)).includes("mine") && (await pixels(12, 7)).hash !== hidden.hash);
    await change("background", false); await panel(false);
    check("restoring the background restores its exact decoded image pixels", (await pixels(11, 5)).hash === image.hash);
    check("background visibility leaves source data and dirty state unchanged", await unchanged(imageBytes));
    check("visibility interactions produce no JavaScript errors", runtimeErrors.length === 0, runtimeErrors);
    fs.writeFileSync(path.join(artifacts, "visibility-report.json"), JSON.stringify({ ok: true, checks, layouts, runtimeErrors }, null, 2) + "\n");
    return { checks, layouts, runtimeErrors };
  } finally {
    if (fs.existsSync(mapFile)) fs.unlinkSync(mapFile);
    if (fs.existsSync(assetDirectory)) {
      assert(path.relative(fs.realpathSync(fixture.maps), fs.realpathSync(assetDirectory)) === path.join("_assets", "visibility_ui_smoke"), "Only visibility fixture assets can be removed");
      fs.rmSync(assetDirectory, { recursive: true });
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const sourceProject = path.resolve(process.env.ME_GAME_DIR || path.join(root, "..", "project-rts"));
  const fixture = createWorkspaceFixture({ parent: path.join(os.tmpdir(), "them-pixel-front-map-editor-visibility"), project: sourceProject });
  const artifacts = path.join(root, ".smoke-artifacts");
  let editor;
  try {
    editor = await launchEditor({ executable: path.join(root, "node_modules", "electron", "dist", "electron.exe"), args: [root, `--user-data-dir=${path.join(fixture.root, "electron-profile")}`, "--force-device-scale-factor=1", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"], cwd: root, port: 9235, env: { ME_MAP_PROJECT: fixture.project, ME_GODOT_PROJECT: sourceProject, ME_DATA_DIR: path.join(fixture.project, "data") } });
    const report = await runVisibilitySmoke({ client: editor.client, fixture, artifacts });
    console.log(`VISIBILITY_SMOKE_OK checks=${report.checks.length} screenshots=${report.layouts.length}`);
  } catch (error) {
    console.error("VISIBILITY_SMOKE_FAIL", error);
    fs.mkdirSync(artifacts, { recursive: true });
    fs.writeFileSync(path.join(artifacts, "visibility-failure.log"), `${error.stack}\n${editor?.output.join("") || ""}`);
    if (editor) {
      const debug = await evaluate(editor.client, `(() => {const b=document.querySelector('[data-testid=map-visibility-toggle]'),p=document.querySelector('[data-testid=map-visibility-panel]');return {button:{rect:b?.getBoundingClientRect().toJSON(),expanded:b?.getAttribute('aria-expanded'),disabled:b?.disabled,style:b?getComputedStyle(b).pointerEvents:null},panel:p?.getBoundingClientRect().toJSON(),active:{tag:document.activeElement?.tagName,testid:document.activeElement?.dataset.testid},events:window.visibilityEventTrace}})()`).catch(() => null);
      fs.writeFileSync(path.join(artifacts, "visibility-failure-events.json"), JSON.stringify(debug,null,2));
      const screenshot = await editor.client.Page.captureScreenshot({ format: "png" }).catch(() => null);
      if (screenshot) fs.writeFileSync(path.join(artifacts, "visibility-failure.png"), Buffer.from(screenshot.data, "base64"));
    }
    process.exitCode = 1;
  } finally { if (editor && !(process.exitCode && process.env.ME_VISIBILITY_KEEP_OPEN === "1")) await editor.close(); }
}
