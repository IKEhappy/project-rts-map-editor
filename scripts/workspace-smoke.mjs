import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { deflateSync } from "node:zlib";
import CDP from "chrome-remote-interface";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

export async function evaluate(client, expression) {
  const result = await client.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}

export function apiCall(client, method, ...args) {
  return evaluate(client, `window.meApi[${JSON.stringify(method)}](...${JSON.stringify(args)})`);
}

export async function waitFor(client, expression, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await evaluate(client, expression)) return;
    await sleep(100);
  }
  throw new Error(`Timed out: ${label}`);
}

export async function click(client, testId) {
  const point = await evaluate(client, `(() => {
    const element = document.querySelector(${JSON.stringify(`[data-testid="${testId}"]`)});
    if (!element) throw new Error("Control missing: " + ${JSON.stringify(testId)});
    element.scrollIntoView({block:"nearest",inline:"nearest"});
    const r = element.getBoundingClientRect();
    const x = r.x + r.width / 2, y = r.y + r.height / 2;
    if (element.disabled || !(element === document.elementFromPoint(x,y) || element.contains(document.elementFromPoint(x,y)))) throw new Error("Control blocked: " + ${JSON.stringify(testId)});
    return {x,y};
  })()`);
  await client.Input.dispatchMouseEvent({ type: "mouseMoved", ...point });
  await client.Input.dispatchMouseEvent({ type: "mousePressed", button: "left", clickCount: 1, ...point });
  await client.Input.dispatchMouseEvent({ type: "mouseReleased", button: "left", clickCount: 1, ...point });
}

export async function setInput(client, testId, value) {
  await evaluate(client, `(() => {
    const input = document.querySelector(${JSON.stringify(`[data-testid="${testId}"]`)});
    if (!input) throw new Error("Input missing: " + ${JSON.stringify(testId)});
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,${JSON.stringify(String(value))});
    input.dispatchEvent(new Event("input",{bubbles:true}));
    input.dispatchEvent(new Event("change",{bubbles:true}));
  })()`);
  await sleep(100);
  await evaluate(client, `(() => {
    const input = document.querySelector(${JSON.stringify(`[data-testid="${testId}"]`)});
    input.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}));
    input.blur();
  })()`);
  await sleep(100);
}

export async function reload(client) {
  await client.Page.reload({ ignoreCache: true });
  await waitFor(client, "document.readyState === 'complete' && !!window.meApi && !!document.querySelector('[data-testid=workspace-start], [data-testid=workspace-bar]')", "application ready");
}

async function requireFreePort(port) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => server.close(resolve));
  });
}

export async function launchEditor({ executable, args = [], cwd, port, env = {} }) {
  await requireFreePort(port);
  const childEnv = { ...process.env, ...env, ME_CDP: "1", ME_CDP_PORT: String(port) };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  delete childEnv.ME_RENDERER_URL;
  const child = spawn(executable, args, { cwd, env: childEnv, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const output = [];
  child.stdout.on("data", (chunk) => output.push(String(chunk)));
  child.stderr.on("data", (chunk) => output.push(String(chunk)));
  let launchError;
  child.once("error", (error) => { launchError = error; });
  let client;
  const close = async () => {
    if (client) await client.close().catch(() => {});
    if (child.exitCode === null && child.pid) {
      if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      else child.kill();
    }
  };
  try {
    let page;
    for (let i = 0; i < 100 && !page; i += 1) {
      if (launchError) throw launchError;
      if (child.exitCode !== null) throw new Error(`Editor exited ${child.exitCode}: ${output.join("")}`);
      try {
        const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
        page = targets.find((target) => target.type === "page" && target.url.includes("index.html"));
      } catch { /* CDP starts after the main process. */ }
      if (!page) await sleep(200);
    }
    if (!page) throw new Error(`Editor CDP unavailable: ${output.join("")}`);
    client = await CDP({ target: page.webSocketDebuggerUrl, port });
    await client.Runtime.enable();
    await client.Page.enable();
    return { client, close, output };
  } catch (error) {
    await close();
    throw error;
  }
}

export function treeDigest(root) {
  const result = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      assert(!entry.isSymbolicLink(), `Unexpected fixture link: ${relative}`);
      if (entry.isDirectory()) { result.push({ path: relative, kind: "directory" }); walk(absolute); }
      else result.push({ path: relative, kind: "file", sha256: sha(fs.readFileSync(absolute)) });
    }
  };
  walk(root);
  return result;
}

function png(width, height, color) {
  const crc = (bytes) => {
    let value = 0xffffffff;
    for (const byte of bytes) {
      value ^= byte;
      for (let i = 0; i < 8; i += 1) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
    }
    return (value ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, bytes) => {
    const tag = Buffer.from(type);
    const result = Buffer.alloc(bytes.length + 12);
    result.writeUInt32BE(bytes.length);
    tag.copy(result, 4); bytes.copy(result, 8);
    result.writeUInt32BE(crc(Buffer.concat([tag, bytes])), bytes.length + 8);
    return result;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const pixels = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const offset = y * (width * 4 + 1) + 1 + x * 4;
    const factor = ((x >> 3) + (y >> 3)) % 2 ? 0.6 : 1;
    pixels[offset] = color[0] * factor; pixels[offset + 1] = color[1] * factor;
    pixels[offset + 2] = color[2] * factor; pixels[offset + 3] = 255;
  }
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
}

export function createWorkspaceFixture({ parent, project }) {
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, "workspace-"));
  const fixtureProject = path.join(root, "project");
  const maps = path.join(fixtureProject, "data", "maps");
  fs.mkdirSync(maps, { recursive: true });
  fs.writeFileSync(path.join(fixtureProject, "project.godot"), 'config_version=5\n\n[application]\nconfig/name="Map editor disposable fixture"\n');
  fs.cpSync(path.join(project, "src"), path.join(fixtureProject, "src"), { recursive: true });
  fs.cpSync(path.join(project, "data"), path.join(fixtureProject, "data"), { recursive: true, filter: (file) => !["maps", ".mimosa"].includes(path.basename(file)) });
  const icons = path.join(project, "assets", "ui", "icons");
  if (fs.existsSync(icons)) fs.cpSync(icons, path.join(fixtureProject, "assets", "ui", "icons"), { recursive: true });
  const source = JSON.parse(fs.readFileSync(path.join(project, "data", "maps", "p0_corridor.json"), "utf8"));
  source.seed = 1;
  for (const name of ["legacy.json", "deleted.json", "renamed.json"]) fs.writeFileSync(path.join(maps, name), JSON.stringify(source, null, 2) + "\n");
  fs.writeFileSync(path.join(maps, ".hidden"), Buffer.from([0, 1, 2, 255]));
  fs.writeFileSync(path.join(maps, "binary.bin"), Buffer.from([255, 0, 10, 128, 42]));
  fs.mkdirSync(path.join(maps, "empty"));
  const tilt = path.join(root, "tilt.png"), topdown = path.join(root, "topdown.png");
  fs.writeFileSync(tilt, png(64, 48, [88, 180, 96]));
  fs.writeFileSync(topdown, png(64, 64, [68, 142, 215]));
  const sourceConfigHashes = Object.fromEntries(["units", "buildings", "rules"].map((kind) => [kind, sha(fs.readFileSync(path.join(project, "data", `${kind}.json`)))]));
  return { root, maps, project: fixtureProject, sourceProject: project, sourceConfigHashes, source, tilt, topdown };
}

export async function captureLayout(client, artifacts, name, width, height) {
  await client.Page.bringToFront();
  await client.Emulation.setDeviceMetricsOverride({ width, height, deviceScaleFactor: 1, mobile: false, screenWidth: width, screenHeight: height });
  await waitFor(client, `innerWidth === ${width} && innerHeight === ${height}`, `${width}x${height} viewport`);
  await client.Page.captureScreenshot({ format: "png" });
  await waitFor(client, `(() => {
    const canvas = document.querySelector('[data-testid="map-canvas"] canvas');
    if (!canvas) return false;
    const frame = canvas.parentElement.getBoundingClientRect(), r = canvas.getBoundingClientRect();
    return r.width > 100 && r.height > 100 && Math.abs(r.height - frame.height) < 4 && r.bottom <= innerHeight;
  })()`, "canvas resize observer settled", 5000);
  await sleep(100);
  const layout = await evaluate(client, `(() => {
    const canvas = document.querySelector('[data-testid="map-canvas"] canvas');
    if (!canvas) throw new Error('Map canvas missing');
    const rect = canvas.getBoundingClientRect();
    const controls = ['workspace-compare','workspace-restore','save-btn','map-json-toggle'].map(id => {
      const element = document.querySelector('[data-testid="'+id+'"]');
      const r = element.getBoundingClientRect();
      return {id,visible:r.width>0&&r.height>0&&r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight};
    });
    const data = canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
    const colors = new Set(); let opaque = 0, green = 0, blue = 0;
    for(let i=0;i<data.length;i+=4*37){
      if(data[i+3])opaque++;
      colors.add(data[i]+','+data[i+1]+','+data[i+2]);
      if(data[i+1]>data[i]*1.3&&data[i+1]>data[i+2]*1.3)green++;
      if(data[i+2]>data[i]*1.3&&data[i+2]>data[i+1]*1.3)blue++;
    }
    return {width:innerWidth,height:innerHeight,projection:canvas.dataset.projection,rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height,right:rect.right,bottom:rect.bottom},controls,opaque,colors:colors.size,green,blue};
  })()`);
  assert(layout.rect.width > 200 && layout.rect.height > 150, `Canvas too small: ${JSON.stringify(layout)}`);
  assert(layout.rect.x >= 0 && layout.rect.y >= 0 && layout.rect.right <= width + 1 && layout.rect.bottom <= height + 1, `Canvas outside viewport: ${JSON.stringify(layout)}`);
  assert(layout.controls.every((control) => control.visible), `Controls outside viewport: ${JSON.stringify(layout)}`);
  assert(layout.opaque > 100 && layout.colors > 4, `Blank canvas: ${JSON.stringify(layout)}`);
  assert((layout.projection === "tilt" ? layout.green : layout.blue) > 100, `Expected image pixels missing: ${JSON.stringify(layout)}`);
  const screenshot = await client.Page.captureScreenshot({ format: "png" });
  fs.writeFileSync(path.join(artifacts, `${name}-${width}x${height}.png`), Buffer.from(screenshot.data, "base64"));
  return layout;
}

async function editConfigSmoke({ client, fixture, check, artifacts, prefix }) {
  const files = Object.fromEntries(["units", "buildings", "rules"].map((kind) => [kind, path.join(fixture.project, "data", `${kind}.json`)]));
  const original = Object.fromEntries(Object.entries(files).map(([kind, file]) => [kind, fs.readFileSync(file)]));
  const parsed = Object.fromEntries(Object.entries(original).map(([kind, bytes]) => [kind, JSON.parse(bytes.toString("utf8"))]));
  const baseHp = parsed.units.units[0].hp;
  const selectTab = async (kind, testId) => {
    await click(client, `tab-${kind}`);
    await waitFor(client, `!!document.querySelector(${JSON.stringify(`[data-testid="${testId}"]`)})`, `${kind} editor`);
  };
  const save = async (expectSuccess) => {
    await click(client, "save-btn");
    await waitFor(client, "!!document.querySelector('[data-testid=save-ok], [data-testid=save-errors]')", "configuration gate result", 180000);
    const error = await evaluate(client, "document.querySelector('[data-testid=save-errors]')?.innerText");
    if (expectSuccess) assert(!error, `Configuration save rejected: ${error}`);
    else assert(error, "Expected configuration save rejection");
    return error;
  };
  const addField = async (field, objectPath = "") => {
    await click(client, `add-field-btn-${objectPath}`);
    const selectId = `add-field-select-${objectPath}`;
    await waitFor(client, `!!document.querySelector(${JSON.stringify(`[data-testid="${selectId}"]`)})`, "available feature fields");
    await evaluate(client, `(() => {
      const select = document.querySelector(${JSON.stringify(`[data-testid="${selectId}"]`)});
      if (![...select.options].some(option => option.value === ${JSON.stringify(field)})) throw new Error("Feature field unavailable: " + ${JSON.stringify(field)});
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,"value").set.call(select,${JSON.stringify(field)});
      select.dispatchEvent(new Event("change",{bubbles:true}));
    })()`);
    await waitFor(client, `!document.querySelector(${JSON.stringify(`[data-testid="${selectId}"]`)})`, "feature field inserted");
  };
  const createStandard = async (kind, label, key) => {
    await selectTab(kind, "entity-search");
    await setInput(client, "entity-search", "");
    await click(client, "add-entity");
    await waitFor(client, "!!document.querySelector('[data-testid=add-entity-opt-standard]')", `${kind} standard template`);
    check(`${kind} standard template is available`, await evaluate(client, `document.querySelector('[data-testid=add-entity-opt-standard]').innerText.includes(${JSON.stringify(label)})`));
    await click(client, "add-entity-opt-standard");
    await waitFor(client, `document.querySelector('[data-testid=field-key]')?.value === ${JSON.stringify(key)}`, `${kind} template entity created`);
    check(`${kind} template creates editable unique identity`, await evaluate(client, `document.querySelector('[data-testid=field-key]') instanceof HTMLInputElement && document.querySelectorAll('[data-testid=entity-item]').length === ${parsed[kind][kind].length + 1}`));
  };
  await selectTab("units", "field-hp");
  check("units original entity list and field tree restored", await evaluate(client, `document.querySelectorAll('[data-testid=entity-item]').length === ${parsed.units.units.length} && !!document.querySelector('[data-testid=entity-search]')`));
  await setInput(client, "field-hp", -5);
  await save(false);
  check("invalid unit save rejected without bytes or backup change", fs.readFileSync(files.units).equals(original.units) && !fs.existsSync(`${files.units}.bak`));
  await setInput(client, "field-hp", baseHp + 11);
  await save(true);
  check("unit save passes gate and creates exact previous-byte backup", JSON.parse(fs.readFileSync(files.units)).units[0].hp === baseHp + 11 && fs.readFileSync(`${files.units}.bak`).equals(original.units));
  await setInput(client, "field-hp", baseHp + 22);
  await click(client, "config-undo-btn");
  await waitFor(client, `document.querySelector('[data-testid=field-hp]')?.value === '${baseHp + 11}'`, "configuration undo");
  await click(client, "config-redo-btn");
  await waitFor(client, `document.querySelector('[data-testid=field-hp]')?.value === '${baseHp + 22}'`, "configuration redo");
  check("configuration undo and redo restore edited values", true);
  await selectTab("buildings", "entity-search");
  check("buildings original list and fields restored", await evaluate(client, `document.querySelectorAll('[data-testid=entity-item]').length === ${parsed.buildings.buildings.length}`));
  await setInput(client, "entity-search", "hq");
  await waitFor(client, "document.querySelectorAll('[data-testid=entity-item]').length === 1", "headquarters selection");
  await click(client, "entity-item");
  await waitFor(client, "!!document.querySelector('[data-testid=field-w]')", "headquarters width");
  const originalWidth = parsed.buildings.buildings.find((building) => building.key === "hq").w;
  await setInput(client, "field-w", originalWidth + 1);
  await save(true);
  check("building save passes gate and preserves original backup", JSON.parse(fs.readFileSync(files.buildings)).buildings.find((building) => building.key === "hq").w === originalWidth + 1 && fs.readFileSync(`${files.buildings}.bak`).equals(original.buildings));
  await selectTab("units", "field-hp");
  check("switching between configuration tabs preserves unsaved edits", await evaluate(client, `document.querySelector('[data-testid=field-hp]').value === '${baseHp + 22}'`));
  await setInput(client, "field-hp", baseHp + 11);
  await selectTab("rules", "rule-input-economy_div");
  check("rules original editable table restored", await evaluate(client, "!!document.querySelector('table.rules') && !document.querySelector('.workspace-config pre')"));
  await setInput(client, "rule-input-economy_div", parsed.rules.economy_div + 1);
  await save(true);
  check("rules save passes gate and preserves original backup", JSON.parse(fs.readFileSync(files.rules)).economy_div === parsed.rules.economy_div + 1 && fs.readFileSync(`${files.rules}.bak`).equals(original.rules));

  await createStandard("units", "通用单位", "new_unit_1");
  check("standard unit starts without optional capabilities", await evaluate(client, "!document.querySelector('[data-testid=field-attackable]') && !document.querySelector('[data-testid=field-respawn_seconds]') && !document.querySelector('[data-testid=field-tiers-0-hp]')"));
  await addField("attackable");
  await addField("respawn_seconds");
  check("unit optional fields use typed defaults", await evaluate(client, "document.querySelector('[data-testid=field-attackable]')?.checked === true && document.querySelector('[data-testid=field-respawn_seconds]')?.value === '0'"));
  await click(client, "field-attackable");
  await setInput(client, "field-respawn_seconds", 12);
  await addField("tiers");
  await addField("color", "tiers-0");
  await setInput(client, "field-tiers-0-color-0", 0.5);
  const unitBeforeTemplateSave = fs.readFileSync(files.units);
  await save(true);
  const unitAfterTemplateSave = JSON.parse(fs.readFileSync(files.units)).units;
  const templateUnit = unitAfterTemplateSave.find((unit) => unit.key === "new_unit_1");
  check("new unit with root and nested optional fields passes Godot gate", unitAfterTemplateSave.length === parsed.units.units.length + 1 && templateUnit?.attackable === false && templateUnit.respawn_seconds === 12 && templateUnit.tiers?.[0]?.color?.[0] === 0.5 && fs.readFileSync(`${files.units}.bak`).equals(unitBeforeTemplateSave));
  await click(client, "config-reload-btn");
  await waitFor(client, "document.querySelector('[data-testid=configs-panel]')?.getAttribute('aria-busy') === 'false' && !document.querySelector('[data-testid=save-ok]') && document.querySelector('[data-testid=field-key]')?.textContent === 'new_unit_1'", "saved unit identity locked after reload");
  check("saved template unit reloads nested field values", await evaluate(client, "document.querySelector('[data-testid=field-tiers-0-color-0]')?.value === '0.5' && document.querySelector('[data-testid=field-respawn_seconds]')?.value === '12'"));

  await createStandard("buildings", "通用建筑", "new_building_1");
  check("standard building starts without factory or turret capabilities", await evaluate(client, "!document.querySelector('[data-testid=field-lines-0-tier]') && !document.querySelector('[data-testid=field-damage]')"));
  await addField("lines");
  await addField("upgrade", "lines-0");
  const buildingBeforeTemplateSave = fs.readFileSync(files.buildings);
  await save(true);
  const buildingAfterTemplateSave = JSON.parse(fs.readFileSync(files.buildings)).buildings;
  const templateBuilding = buildingAfterTemplateSave.find((building) => building.key === "new_building_1");
  check("new building with nested production field passes Godot gate", buildingAfterTemplateSave.length === parsed.buildings.buildings.length + 1 && templateBuilding?.lines?.[0]?.unit === "cougar" && templateBuilding.lines[0].upgrade === true && fs.readFileSync(`${files.buildings}.bak`).equals(buildingBeforeTemplateSave));
  await click(client, "config-reload-btn");
  await waitFor(client, "document.querySelector('[data-testid=configs-panel]')?.getAttribute('aria-busy') === 'false' && !document.querySelector('[data-testid=save-ok]') && document.querySelector('[data-testid=field-key]')?.textContent === 'new_building_1'", "saved building identity locked after reload");
  check("saved template building reloads nested field values", await evaluate(client, "document.querySelector('[data-testid=field-lines-0-upgrade]')?.checked === true"));

  await selectTab("units", "field-hp");
  await setInput(client, "entity-search", parsed.units.units[0].key);
  await waitFor(client, `document.querySelector('[data-testid=entity-item]')?.innerText.includes(${JSON.stringify(parsed.units.units[0].key)})`, "original unit selection restored");
  await click(client, "entity-item");
  await waitFor(client, `document.querySelector('[data-testid=field-key]')?.textContent === ${JSON.stringify(parsed.units.units[0].key)}`, "original unit editor restored");
  await setInput(client, "entity-search", "");
  await setInput(client, "field-hp", baseHp + 33);
  const external = JSON.parse(fs.readFileSync(files.units));
  external.units[0].hp = baseHp + 44;
  const externalBytes = Buffer.from(JSON.stringify(external, null, 2) + "\n");
  fs.writeFileSync(files.units, externalBytes);
  const conflict = await save(false);
  check("external configuration hash conflict preserves external bytes", /外部|重新加载|conflict/i.test(conflict) && fs.readFileSync(files.units).equals(externalBytes));
  await click(client, "config-reload-btn");
  await waitFor(client, `document.querySelector('[data-testid=field-hp]')?.value === '${baseHp + 44}'`, "external configuration reload");
  await setInput(client, "field-hp", baseHp + 55);
  await click(client, "win-close-btn");
  await waitFor(client, "!!document.querySelector('[data-testid=close-modal]')", "configuration dirty close prompt");
  await click(client, "close-cancel-btn");
  await waitFor(client, "!document.querySelector('[data-testid=close-modal]')", "continue configuration editing");
  check("dirty configuration close prompts and cancel keeps edits", await evaluate(client, `document.querySelector('[data-testid=field-hp]')?.value === '${baseHp + 55}'`));
  await client.Page.bringToFront();
  await client.Emulation.setDeviceMetricsOverride({ width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  const screenshot = await client.Page.captureScreenshot({ format: "png" });
  fs.writeFileSync(path.join(artifacts, `${prefix}-config-units-1280x720.png`), Buffer.from(screenshot.data, "base64"));
  await click(client, "tab-maps");
  await waitFor(client, "!!document.querySelector('[data-testid=map-tool-building]')", "maps retained after config edits");
  await click(client, "map-tool-building");
  await click(client, "map-select-building");
  await waitFor(client, "!!document.querySelector('[data-testid=map-select-building-opt-hq]')", "map building dependency options");
  check("saved building definitions refresh map dependency cache", await evaluate(client, `document.querySelector('[data-testid=map-select-building-opt-hq]')?.innerText.includes('hq - 总部 [${originalWidth + 1}×')`));
  await click(client, "map-select-building-opt-hq");
  // 选中列表末项后重新打开，长下拉应自动把当前选项滚入可视区。
  await click(client, "map-select-building");
  await waitFor(client, "!!document.querySelector('[data-testid=map-select-building-opt-super_factory]')", "map building long option");
  await click(client, "map-select-building-opt-super_factory");
  await click(client, "map-select-building");
  check("building dropdown scrolls to selected option", await evaluate(client, `(() => {
    const menu = document.querySelector('.dd-menu');
    const option = document.querySelector('[data-testid=map-select-building-opt-super_factory]');
    if (!menu || !option) return false;
    const mr = menu.getBoundingClientRect();
    const or = option.getBoundingClientRect();
    return or.top >= mr.top - 1 && or.bottom <= mr.bottom + 1;
  })()`));
  await click(client, "map-select-building-opt-super_factory");
  await click(client, "map-tool-none");
  const hashes = Object.fromEntries(Object.entries(files).map(([kind, file]) => [kind, sha(fs.readFileSync(file))]));
  return { files, hashes, pendingHp: baseHp + 55 };
}

export async function runWorkspaceSmoke({ client, fixture, artifacts, prefix = "workspace" }) {
  fs.mkdirSync(artifacts, { recursive: true });
  const checks = [], runtimeErrors = [];
  // Native confirm() dialogs pause the renderer and otherwise leave CDP waiting
  // forever during automated dirty-reload/close checks. The smoke fixture always
  // exercises the affirmative path, so accept dialogs explicitly.
  client.Page.javascriptDialogOpening(async () => {
    await client.Page.handleJavaScriptDialog({ accept: true }).catch(() => {});
  });
  client.Runtime.exceptionThrown(({ exceptionDetails }) => runtimeErrors.push(exceptionDetails.exception?.description || exceptionDetails.text));
  client.Runtime.consoleAPICalled(({ type, args }) => { if (type === "error") runtimeErrors.push(args.map((arg) => arg.value ?? arg.description).join(" ")); });
  const check = (name, condition, detail = "") => {
    assert(condition, `${name}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
    checks.push(name); console.log(`  ok: ${name}`);
  };
  const checkedApi = async (method, ...args) => {
    const result = await apiCall(client, method, ...args);
    assert(result?.ok, `${method}: ${JSON.stringify(result)}`);
    return result;
  };
  await waitFor(client, "!!window.meApi", "preload API");
  await evaluate(client, "localStorage.clear()");
  await reload(client);
  const initial = await checkedApi("getWorkspace");
  check("startup requires explicit maps selection", initial.workspace == null);
  const before = treeDigest(fixture.maps);
  const original = fs.readFileSync(path.join(fixture.maps, "legacy.json"));
  const first = (await checkedApi("openWorkspace", { path: fixture.maps, projectRoot: fixture.project })).workspace;
  const backupRelative = path.relative(fixture.maps, first.baseline.zipPath);
  const backupOutside = path.isAbsolute(backupRelative) || backupRelative === ".." || backupRelative.startsWith(`..${path.sep}`);
  check("open creates ZIP outside maps", fs.existsSync(first.baseline.zipPath) && backupOutside, first);
  check("ZIP baseline preserves maps bytes", JSON.stringify(treeDigest(fixture.maps)) === JSON.stringify(before));
  await reload(client);
  await waitFor(client, "!!document.querySelector('[data-testid=" + '"map-item-legacy-json"' + "]')", "legacy map list");
  await click(client, "map-item-legacy-json");
  await waitFor(client, "!!document.querySelector('[data-testid=" + '"map-canvas"' + "] canvas')", "legacy canvas");
  await click(client, "map-json-toggle");
  await waitFor(client, "!!document.querySelector('[data-testid=" + '"field-width"' + "]')", "JSON width field");
  await setInput(client, "field-width", "0");
  await click(client, "map-save-btn");
  await waitFor(client, "!!document.querySelector('[data-testid=" + '"map-save-errors"' + "]')", "invalid save rejection", 180000);
  check("invalid UI save leaves original bytes intact", fs.readFileSync(path.join(fixture.maps, "legacy.json")).equals(original));
  await setInput(client, "field-width", fixture.source.width);
  await setInput(client, "field-seed", "24680");
  await click(client, "map-save-btn");
  await waitFor(client, "!!document.querySelector('[data-testid=map-save-ok], [data-testid=map-save-errors]')", "valid map save", 180000);
  const saveError = await evaluate(client, "document.querySelector('[data-testid=map-save-errors]')?.innerText");
  assert(!saveError, `Valid save rejected: ${saveError}`);
  const saved = await checkedApi("readMap", "legacy.json");
  check("valid save passes gate and content hash", saved.data.seed === 24680 && saved.hash === sha(fs.readFileSync(saved.path)), saved);

  // 地图页右键建筑→产线回归：空产线由字段树创建后，嵌套 unit/tier/ticks
  // 必须保持可编辑并能通过地图保存落盘。这个路径与配置表 buildings 的
  // lines 测试不同，专门锁住地图条目内的数组写入。
  await evaluate(client, `(() => {
    const canvas = document.querySelector('[data-testid="map-canvas"] canvas');
    if (!canvas) throw new Error('Map canvas missing for building context test');
    const rect = canvas.getBoundingClientRect();
    const ppc = parseFloat(canvas.getAttribute('data-ppc'));
    const ox = parseFloat(canvas.getAttribute('data-ox'));
    const oy = parseFloat(canvas.getAttribute('data-oy'));
    const scale = rect.width / (parseFloat(canvas.getAttribute('data-css-w')) || canvas.width);
    // p0_corridor 的第一座建筑 mine 位于 (7,6)。
    canvas.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true,
      clientX: rect.left + (7 - ox + 0.5) * ppc * scale,
      clientY: rect.top + (6 - oy + 0.5) * ppc * scale,
    }));
    return true;
  })()`);
  await waitFor(client, "!!document.querySelector('[data-testid=building-ctx-menu]')", "building context menu for production line");
  await click(client, "ctx-field-lines");
  await waitFor(client, `!![...document.querySelectorAll('.field-row')].find((row) => row.querySelector('.field-label code')?.textContent === 'lines' && row.querySelector('button.add'))`, "map building lines field");
  await evaluate(client, `(() => {
    const row = [...document.querySelectorAll('.field-row')].find((candidate) => candidate.querySelector('.field-label code')?.textContent === 'lines');
    const add = row?.querySelector('button.add');
    if (!add) throw new Error('Map building lines add button missing');
    add.click();
  })()`);
  await waitFor(client, "!!document.querySelector('[data-testid=field-buildings-0-lines-0-unit]')", "map production line row");
  // lines[].unit is a custom dropdown in the map field tree (the numeric
  // fields remain regular inputs). Open it and choose the unit option rather
  // than invoking HTMLInputElement.value on a button.
  await click(client, "field-buildings-0-lines-0-unit");
  await waitFor(client, "!!document.querySelector('[data-testid=field-buildings-0-lines-0-unit-opt-cougar]')", "map production unit options");
  await click(client, "field-buildings-0-lines-0-unit-opt-cougar");
  await setInput(client, "field-buildings-0-lines-0-tier", "2");
  await setInput(client, "field-buildings-0-lines-0-ticks", "90");
  check("map production line nested fields remain editable", await evaluate(client, `
    document.querySelector('[data-testid=field-buildings-0-lines-0-unit]')?.getAttribute('data-value') === 'cougar' &&
    document.querySelector('[data-testid=field-buildings-0-lines-0-tier]')?.value === '2' &&
    document.querySelector('[data-testid=field-buildings-0-lines-0-ticks]')?.value === '90'
  `));
  await click(client, "map-save-btn");
  await waitFor(client, `window.meApi.readMap('legacy.json').then((result) => result.ok && result.data?.buildings?.[0]?.lines?.[0]?.unit === 'cougar' && result.data.buildings[0].lines[0].tier === 2 && result.data.buildings[0].lines[0].ticks === 90)`, "map production line save", 180000);
  check("map production line nested fields persist after save", true);
  await click(client, "map-json-toggle");
  const configurations = await editConfigSmoke({ client, fixture, check, artifacts, prefix });
  const tilt = await checkedApi("importImage", { mapId: "whole_smoke", view: "tilt", sourcePath: fixture.tilt });
  const topdown = await checkedApi("importImage", { mapId: "whole_smoke", view: "topdown", sourcePath: fixture.topdown });
  check("both PNG views imported", tilt.width === 64 && tilt.height === 48 && topdown.width === 64 && topdown.height === 64);
  const whole = { version: 1, name: "whole_smoke", width: 16, height: 12, seed: 7, background: { tilt: tilt.path, topdown: topdown.path }, box_mode: [], buildings: [], spawns: [], decor: [], init: {} };
  const broken = await apiCall(client, "saveMap", { name: "broken_smoke.json", data: { ...whole, background: { image: `${first.resPrefix}_assets/missing.png` } }, expectCreate: true });
  check("missing image rejected before write", broken.ok === false && !fs.existsSync(path.join(fixture.maps, "broken_smoke.json")), broken);
  await checkedApi("saveMap", { name: "whole_smoke.json", data: whole, expectCreate: true });
  const background = await checkedApi("backgroundInfo", whole);
  check("whole-image map saves and resolves both PNGs", background.images?.tilt?.width === 64 && background.images?.topdown?.height === 64, background);
  const importFile = path.join(fixture.root, "external_whole.json");
  fs.writeFileSync(importFile, JSON.stringify({ ...whole, name: "external_whole", background: { tilt: "tilt.png", topdown: "topdown.png" } }));
  const imported = await checkedApi("importMap", { sourcePath: importFile });
  const importedMap = await checkedApi("readMap", imported.name);
  const importedInfo = await checkedApi("backgroundInfo", importedMap.data);
  check("external whole-image JSON imports self-contained PNG references", importedInfo.images?.tilt?.width === 64 && importedInfo.images?.topdown?.height === 64 && importedMap.data.background.tilt.startsWith(first.resPrefix), importedInfo);
  await click(client, "map-reload-btn");
  await waitFor(client, "!!document.querySelector('[data-testid=" + '"map-item-whole_smoke-json"' + "]')", "whole-image map list");
  await click(client, "map-item-whole_smoke-json");
  await waitFor(client, "document.querySelector('[data-testid=map-canvas] canvas')?.dataset.background === 'true'", "whole-image preview decoded");
  await click(client, "map-view-tilt");
  await waitFor(client, "document.querySelector('[data-testid=map-canvas] canvas')?.dataset.projection === 'tilt'", "tilt projection");
  const layouts = [];
  for (const [width, height] of [[1920, 1080], [1280, 720]]) layouts.push(await captureLayout(client, artifacts, prefix, width, height));
  await click(client, "map-view-topdown");
  await waitFor(client, "document.querySelector('[data-testid=map-canvas] canvas')?.dataset.projection === 'topdown'", "topdown projection");
  layouts.push(await captureLayout(client, artifacts, `${prefix}-topdown`, 1280, 720));
  check("both views desktop and minimum layout plus canvas pixels", layouts.length === 3);
  fs.unlinkSync(path.join(fixture.maps, "deleted.json"));
  fs.renameSync(path.join(fixture.maps, "renamed.json"), path.join(fixture.maps, "renamed-later.json"));
  fs.writeFileSync(path.join(fixture.maps, ".hidden"), "changed hidden");
  fs.writeFileSync(path.join(fixture.maps, "binary.bin"), Buffer.from([99, 0, 33]));
  fs.mkdirSync(path.join(fixture.maps, "new-empty"));
  const diff = await checkedApi("compareWorkspace");
  check("compare reports added changed removed", ["added", "changed", "removed"].every((status) => diff.entries.some((entry) => entry.status === status)), diff);
  await click(client, "workspace-compare");
  await waitFor(client, "!!document.querySelector('[data-testid=" + '"workspace-diff"' + "]')", "directory comparison dialog");
  await client.Input.dispatchKeyEvent({ type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await client.Input.dispatchKeyEvent({ type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await click(client, "workspace-restore");
  await waitFor(client, "!!document.querySelector('[data-testid=workspace-restore-confirm]')", "restore confirmation");
  await click(client, "workspace-restore-confirm");
  await waitFor(client, "!document.querySelector('[data-testid=workspace-restore-confirm]')", "restore completion", 30000);
  const restored = (await checkedApi("getWorkspace")).workspace;
  check("restore recreates exact files hidden binary and empty directories", JSON.stringify(treeDigest(fixture.maps)) === JSON.stringify(before));
  check("restore refreshes generation", restored.id === first.id && restored.generation > first.generation);
  check("maps ZIP restore leaves saved configuration files unchanged", Object.entries(configurations.files).every(([kind, file]) => sha(fs.readFileSync(file)) === configurations.hashes[kind]));
  await click(client, "tab-units");
  await waitFor(client, "!!document.querySelector('[data-testid=field-hp]')", "configuration draft after maps restore");
  check("maps restore preserves unsaved configuration draft", await evaluate(client, `document.querySelector('[data-testid=field-hp]')?.value === '${configurations.pendingHp}'`));
  await click(client, "tab-maps");
  const clean = await checkedApi("compareWorkspace");
  check("restored workspace comparison is clean", clean.entries.every((entry) => entry.status === "unchanged"));
  fs.writeFileSync(path.join(fixture.maps, ".hidden"), "second opening baseline");
  const secondBefore = treeDigest(fixture.maps);
  const second = (await checkedApi("openWorkspace", { path: fixture.maps, projectRoot: fixture.project })).workspace;
  check("reopening creates fresh session and ZIP", second.id !== first.id && second.baseline.zipPath !== first.baseline.zipPath);
  const stale = await apiCall(client, "readMap", "legacy.json", first.id);
  check("old session reads rejected", stale.ok === false, stale);
  fs.writeFileSync(path.join(fixture.maps, ".hidden"), "changed after second opening");
  await checkedApi("restoreWorkspace");
  check("second restore uses second opening baseline", JSON.stringify(treeDigest(fixture.maps)) === JSON.stringify(secondBefore));
  await reload(client);
  await waitFor(client, "!!document.querySelector('[data-testid=" + '"map-item-legacy-json"' + "]')", "restored UI refresh");
  check("JavaScript runtime and console errors zero", runtimeErrors.length === 0, runtimeErrors);
  check("source project configurations remain byte-identical", Object.entries(fixture.sourceConfigHashes).every(([kind, expected]) => sha(fs.readFileSync(path.join(fixture.sourceProject, "data", `${kind}.json`))) === expected));
  const report = { ok: true, checks, layouts, runtimeErrors, maps: fixture.maps, firstBaseline: first.baseline, secondBaseline: second.baseline };
  fs.writeFileSync(path.join(artifacts, `${prefix}-report.json`), JSON.stringify(report, null, 2) + "\n");
  return report;
}
