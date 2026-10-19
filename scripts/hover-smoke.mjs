import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { apiCall, click, evaluate, reload, setInput, waitFor } from "./workspace-smoke.mjs";

/** Inspect disposable maps through the canvas's real pointer-event path. */
export async function runHoverSmoke({ client, fixture, artifacts }) {
  const checks = [], layouts = [], runtimeErrors = [];
  const name = "hover_ui_smoke.json";
  const mapFile = path.join(fixture.maps, name);
  const rendererFile = path.join(fixture.project, "data", "render", "hover_ui_smoke.json");
  const assetDirectory = path.resolve(fixture.maps, "_assets", "hover_ui_smoke");
  assert(!fs.existsSync(mapFile) && !fs.existsSync(rendererFile) && !fs.existsSync(assetDirectory), "Hover fixture filenames must be unused");
  const units = JSON.parse(fs.readFileSync(path.join(fixture.project, "data", "units.json"))).units;
  const advancer = units.find((unit) => unit.key === "advancer"), cougar = units.find((unit) => unit.key === "cougar");
  assert(advancer && cougar, "Hover fixture unit definitions are available");
  const doc = {
    version: 1, name: "hover_ui_smoke", width: 16, height: 12, default_terrain: 0, seed: 1,
    renderer: "res://data/render/hover_ui_smoke.json",
    ground: { default_material: "grass", patches: [{ x: 5, y: 5, w: 1, h: 1, material: "dirt" }], scatter_regions: [{ x: 0, y: 0, w: 16, h: 12 }] },
    weather: { type: "rain" },
    terrain_patches: [{ x: 2, y: 5, w: 1, h: 1, terrain: 2 }, { x: 3, y: 5, w: 1, h: 1, terrain: 3 }],
    buildings: [{ key: "mine", team: 1, x: 2, y: 2, w: 2, h: 2 }, { key: "turret_guard", team: 1, x: 5, y: 2, w: 1, h: 1 }],
    spawns: [{ kind: advancer.id, team: 1, x: 7, y: 2, count: 1 }, { kind: cougar.id, team: 1, x: 8, y: 2, count: 1 }],
    init: { spawns: [{ kind: cougar.id, team: 2, x: 9, y: 2, count: 1 }] },
    decor: [{ kind: "tree", x: 4, y: 5 }],
    box_mode: [{ start: { w: 0, h: 0 }, end: { w: 15, h: 11 }, access: 1, build: 0 }, { start: { w: 2, h: 2 }, end: { w: 3, h: 3 }, access: 3, build: 1 }],
    config: { buildings: { mine: { name_cn: "金矿 · 地图覆盖" } } },
  };
  const renderer = {
    version: 1,
    materials: {
      grass: { textures: ["res://assets/hover-grass.png"], cliff: "res://assets/hover-cliff/", water: "res://assets/hover-water/", transition: { dirt: "res://assets/hover-transition/" } },
      dirt: { textures: ["res://assets/hover-dirt.png"] },
    },
    scatter: { grass_tuft: { kind: "grass_tuft", density: 1, variants: 1, materials_on: ["grass"], hash_salt: 1, hide_when_snow: false } },
    weather: { rain: {} },
  };
  const check = (label, condition, detail) => {
    assert(condition, `${label}${detail ? `: ${JSON.stringify(detail)}` : ""}`);
    checks.push(label); console.log(`  ok: ${label}`);
  };
  client.Runtime.exceptionThrown(({ exceptionDetails }) => runtimeErrors.push(exceptionDetails.exception?.description || exceptionDetails.text));
  client.Runtime.consoleAPICalled(({ type, args }) => { if (type === "error") runtimeErrors.push(args.map((arg) => arg.value ?? arg.description).join(" ")); });
  const read = () => evaluate(client, `(() => {
    const text = id => document.querySelector('[data-testid="map-hover-'+id+'"]')?.textContent || '';
    return { coordinates: text('coordinates'), texture: text('texture'), effects: text('effects'), objects: text('objects'), box: text('box'), builds: Number(document.querySelector('[data-testid=map-canvas] canvas')?.dataset.staticBuilds) };
  })()`);
  const pointAt = (x, y) => evaluate(client, `(() => {
      const canvas = document.querySelector('[data-testid=map-canvas] canvas');
      const r = canvas.getBoundingClientRect(), scale = r.width / Number(canvas.dataset.cssW), ppc = Number(canvas.dataset.ppc);
      const point = {x:r.left + (${x} + 0.5 - Number(canvas.dataset.ox)) * ppc * scale,
        y:r.top + (${y} + 0.5 - Number(canvas.dataset.oy)) * ppc * scale * (canvas.dataset.projection === 'tilt' ? 0.75 : 1)};
      if (point.x < r.left || point.x > r.right || point.y < r.top || point.y > r.bottom) throw new Error('Hover test cell is outside visible canvas');
      return point;
    })()`);
  const move = async (x, y) => {
    const point = await pointAt(x, y);
    await client.Input.dispatchMouseEvent({ type: "mouseMoved", ...point });
    await waitFor(client, `document.querySelector('[data-testid=map-hover-coordinates]')?.textContent === '(${x},${y})'`, `hover cell (${x},${y})`);
    return read();
  };
  const open = async () => {
    await click(client, "tab-maps");
    await click(client, "map-reload-btn");
    await waitFor(client, "!!document.querySelector('[data-testid=map-item-hover_ui_smoke-json]')", "hover fixture in map list");
    await click(client, "map-item-hover_ui_smoke-json");
    await waitFor(client, "document.querySelector('[data-testid=map-item-hover_ui_smoke-json]')?.classList.contains('active') && !!document.querySelector('[data-testid=map-canvas] canvas')", "hover fixture canvas");
  };
  const layout = async (width, height, image) => {
    await client.Page.bringToFront();
    await client.Emulation.setDeviceMetricsOverride({ width, height, deviceScaleFactor: 1, mobile: false, screenWidth: width, screenHeight: height });
    await waitFor(client, `innerWidth === ${width} && innerHeight === ${height}`, "hover layout viewport");
    await client.Page.captureScreenshot({ format: "png" });
    await waitFor(client, `(() => {
      const canvas=document.querySelector('[data-testid=map-canvas] canvas'), frame=canvas.parentElement;
      return Math.abs(Number(canvas.dataset.cssW)-frame.clientWidth)<2 && Math.abs(Number(canvas.dataset.cssH)-frame.clientHeight)<2;
    })()`, "hover canvas ResizeObserver settled");
    await move(2, 2);
    const data = await evaluate(client, `(() => {
      const inspector = document.querySelector('.map-hover-inspector'), r = inspector.getBoundingClientRect();
      const canvas = document.querySelector('[data-testid=map-canvas] canvas').getBoundingClientRect();
      return { width: innerWidth, height: innerHeight, rect:{left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height},
        visible:r.width>100&&r.height>50&&r.left>=0&&r.top>=0&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1,
        belowCanvas:r.top>=canvas.bottom-1, horizontalOverflow:inspector.scrollWidth>inspector.clientWidth+1,
        text:inspector.textContent, accessibleOverflow:['auto','scroll','visible'].includes(getComputedStyle(inspector).overflowY),
        ellipsis:[...inspector.querySelectorAll('span')].some(el=>getComputedStyle(el).textOverflow==='ellipsis') };
    })()`);
    check(`${image ? "whole image" : "tile"} hover details remain visible at ${width}x${height}`, data.visible && data.belowCanvas && !data.horizontalOverflow && !data.ellipsis && data.accessibleOverflow, data);
    const shot = await client.Page.captureScreenshot({ format: "png" });
    fs.writeFileSync(path.join(artifacts, `hover-${image ? "image" : "tile"}-${width}x${height}.png`), Buffer.from(shot.data, "base64"));
    layouts.push(data);
  };
  try {
    fs.mkdirSync(path.dirname(rendererFile), { recursive: true });
    fs.mkdirSync(artifacts, { recursive: true });
    fs.writeFileSync(rendererFile, JSON.stringify(renderer, null, 2) + "\n");
    fs.writeFileSync(mapFile, JSON.stringify(doc, null, 2) + "\n");
    await client.Emulation.setDeviceMetricsOverride({ width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false, screenWidth: 1920, screenHeight: 1080 });
    await open();
    await click(client, "map-view-topdown");
    await waitFor(client, "document.querySelector('[data-testid=map-canvas] canvas')?.dataset.projection === 'topdown'", "editable topdown hover");
    for (const tool of ["none", "terrain", "erase", "box", "building", "tree", "spawn", "delete", "move-unit", "move-shape", "move-render"]) {
      await click(client, `map-tool-${tool}`);
      const info = await move(2, 2);
      check(`${tool} tool shows coordinates, texture, effect, object and effective box`, info.coordinates === "(2,2)" && info.texture.includes("grass") && info.effects.includes("rain") && info.objects.includes("mine - 金矿") && info.box.includes("access=3") && info.box.includes("build=1"), info);
    }
    await click(client, "map-tool-none");
    await move(2, 2);
    const inspectorPoint = await evaluate(client, "(() => { const r=document.querySelector('.map-hover-inspector').getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()");
    await client.Input.dispatchMouseEvent({ type: "mouseMoved", ...inspectorPoint });
    check("moving into the hover inspector retains its readable details", (await read()).coordinates === "(2,2)" && (await read()).objects.includes("mine - 金矿"));
    await client.Input.dispatchMouseEvent({ type: "mouseMoved", x: 5, y: 5 });
    await waitFor(client, "!document.querySelector('[data-testid=map-hover]')", "leaving the map wrap clears stale hover");
    check("leaving the complete map surface clears hover details", true);
    check("hover inspects the full building footprint", (await move(3, 3)).objects.includes("mine - 金矿"));
    check("hover resolves turret key and Chinese name", (await move(5, 2)).objects.includes("炮台 turret_guard - 防护大炮"));
    check("hover resolves advancer as a flying saucer", (await move(7, 2)).objects.includes(`飞碟 advancer - ${advancer.name_cn}`));
    check("hover resolves normal unit key and Chinese name", (await move(8, 2)).objects.includes(`单位 cougar - ${cougar.name_cn}`));
    check("hover inspects init.spawns as well", (await move(9, 2)).objects.includes("init.spawns"));
    check("hover identifies cliff effect", (await move(2, 5)).effects.includes("悬崖"));
    check("hover identifies water effect", (await move(3, 5)).effects.includes("水面"));
    check("hover identifies scatter effect", (await move(1, 1)).effects.includes("grass_tuft"));

    await move(2, 2);
    await evaluate(client, "document.querySelector('[data-testid=map-json-toggle]').click()");
    await waitFor(client, "!!document.querySelector('[data-testid=field-config-buildings-mine-name_cn]')", "map definition name field");
    await setInput(client, "field-config-buildings-mine-name_cn", "金矿 · hover 实时更新");
    await waitFor(client, "document.querySelector('[data-testid=map-hover-objects]')?.textContent.includes('hover 实时更新')", "same-cell document edit refreshes hover");
    check("hover updates at the same cell after editing the document", true);
    await evaluate(client, "document.querySelector('[data-testid=map-json-toggle]').click()");
    await move(1, 1);
    const before = (await read()).builds;
    for (let x = 2; x < 10; x += 1) await move(x, 1);
    check("hover movement does not rebuild the static canvas layer", (await read()).builds === before);

    const panStart = await pointAt(10, 9);
    const cellSize = await evaluate(client, "Number(document.querySelector('[data-testid=map-canvas] canvas').dataset.ppc)");
    const panEnd = { x: panStart.x + cellSize, y: panStart.y + cellSize };
    await client.Input.dispatchMouseEvent({ type: "mouseMoved", ...panStart });
    await client.Input.dispatchMouseEvent({ type: "mousePressed", button: "middle", buttons: 4, clickCount: 1, ...panStart });
    await client.Input.dispatchMouseEvent({ type: "mouseMoved", button: "middle", buttons: 4, ...panEnd });
    await waitFor(client, "Number(document.querySelector('[data-testid=map-canvas] canvas').dataset.ox) !== 0", "middle-button panned viewport");
    const panned = await evaluate(client, `(() => {
      const canvas=document.querySelector('[data-testid=map-canvas] canvas'),r=canvas.getBoundingClientRect(),ppc=Number(canvas.dataset.ppc);
      return '('+Math.floor((${panEnd.x}-r.left)/ppc+Number(canvas.dataset.ox))+','+Math.floor((${panEnd.y}-r.top)/ppc+Number(canvas.dataset.oy))+')';
    })()`);
    await waitFor(client, `document.querySelector('[data-testid=map-hover-coordinates]')?.textContent === ${JSON.stringify(panned)}`, "hover coordinates follow the panned viewport");
    check("middle-button panning keeps hover coordinates aligned with the new viewport", (await read()).coordinates === panned);
    await client.Input.dispatchMouseEvent({ type: "mouseReleased", button: "middle", buttons: 0, clickCount: 1, ...panEnd });
    await click(client, "map-view-reset");
    await waitFor(client, "Number(document.querySelector('[data-testid=map-canvas] canvas').dataset.ox) === 0 && Number(document.querySelector('[data-testid=map-canvas] canvas').dataset.oy) === 0", "pan test resets viewport");

    await click(client, "map-tool-move-unit");
    const dragStart = await pointAt(2, 2), dragEnd = await pointAt(10, 7);
    await client.Input.dispatchMouseEvent({ type: "mouseMoved", ...dragStart });
    await client.Input.dispatchMouseEvent({ type: "mousePressed", button: "left", buttons: 1, clickCount: 1, ...dragStart });
    await client.Input.dispatchMouseEvent({ type: "mouseMoved", button: "left", buttons: 1, ...dragEnd });
    await waitFor(client, "document.querySelector('[data-testid=map-hover-coordinates]')?.textContent === '(10,7)'", "hover updates while dragging a building");
    check("object dragging refreshes hover coordinates before mouse release", (await read()).coordinates === "(10,7)");
    await client.Input.dispatchMouseEvent({ type: "mouseReleased", button: "left", buttons: 0, clickCount: 1, ...dragEnd });
    await waitFor(client, "document.querySelector('[data-testid=map-hover-objects]')?.textContent.includes('mine - 金矿')", "dragged building settles at target");
    await click(client, "map-undo-btn");
    check("dragging test can undo the building placement", (await move(2, 2)).objects.includes("mine - 金矿"));
    await click(client, "map-tool-none");
    for (const [w, h] of [[1920, 1080], [1280, 720], [960, 720]]) await layout(w, h, false);
    await click(client, "map-inspector-tab-map");
    await click(client, "map-view-tilt");
    await waitFor(client, "document.querySelector('[data-testid=map-canvas] canvas')?.dataset.readonly === 'true'", "read-only tilt view");
    check("tilt read-only mode still exposes map hover details", (await move(2, 2)).objects.includes("mine - 金矿"));

    const imported = await apiCall(client, "importImage", { mapId: "hover_ui_smoke", view: "topdown", sourcePath: fixture.topdown });
    assert(imported.ok, imported.error);
    doc.background = { image: imported.path };
    fs.writeFileSync(mapFile, JSON.stringify(doc, null, 2) + "\n");
    await reload(client);
    await open();
    await waitFor(client, "document.querySelector('[data-testid=map-canvas] canvas')?.dataset.background === 'true'", "whole image hover decoded");
    const image = await move(2, 5);
    check("whole-image hover shows the active image path and suppresses terrain effects", image.texture.includes("整图") && image.texture.includes(imported.path) && !image.texture.includes("地形") && !/悬崖|水面|散布|材质过渡/.test(image.effects), image);
    for (const [w, h] of [[1920, 1080], [1280, 720], [960, 720]]) await layout(w, h, true);
    check("map hover interactions produce no JavaScript errors", runtimeErrors.length === 0, runtimeErrors);
    fs.writeFileSync(path.join(artifacts, "hover-report.json"), JSON.stringify({ ok: true, checks, layouts, runtimeErrors }, null, 2) + "\n");
    return { checks, layouts, runtimeErrors };
  } finally {
    if (fs.existsSync(mapFile)) fs.unlinkSync(mapFile);
    if (fs.existsSync(rendererFile)) fs.unlinkSync(rendererFile);
    if (fs.existsSync(assetDirectory)) {
      const relative = path.relative(fs.realpathSync(fixture.maps), fs.realpathSync(assetDirectory));
      assert(relative === path.join("_assets", "hover_ui_smoke"), "Only the imported hover-fixture directory may be removed");
      fs.rmSync(assetDirectory, { recursive: true });
    }
  }
}
