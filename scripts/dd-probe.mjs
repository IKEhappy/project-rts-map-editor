// 下拉复现探针（R23）：建筑下拉打开态截图 + dd-menu/搜索框样式转储，定位截图里
// 右上白块与红区标注的问题。
import CDP from "chrome-remote-interface";
import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = path.join(root, ".probe-data");
const sandboxMaps = path.join(sandbox, "maps");
const mapsSrc = path.join(root, "..", "project-rts", "data", "maps");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function ev(client, expression) {
  const r = await client.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
  return r.result.value;
}

async function main() {
  fs.rmSync(sandbox, { recursive: true, force: true });
  fs.mkdirSync(sandboxMaps, { recursive: true });
  fs.copyFileSync(path.join(mapsSrc, "p0_corridor.json"), path.join(sandboxMaps, "p0_corridor.json"));
  execSync("npx vite build", { cwd: root, stdio: "inherit" });
  const app = spawn("npx", ["electron", "."], {
    cwd: root,
    shell: true,
    stdio: ["ignore", "ignore", "ignore"],
    env: { ...process.env, ME_MAPS_DIR: sandboxMaps, ME_CDP: "1", ME_CDP_PORT: "9228" },
  });
  let client = null;
  try {
    let page = null;
    for (let i = 0; i < 60 && page === null; i += 1) {
      await sleep(500);
      try {
        const list = await (await fetch("http://127.0.0.1:9228/json/list")).json();
        page = list.find((t) => t.type === "page" && t.url.includes("index.html")) ?? null;
      } catch {
        /* not up */
      }
    }
    client = await CDP({ target: page.webSocketDebuggerUrl, port: 9228 });
    await client.Runtime.enable();
    await client.Page.enable();
    await ev(client, `localStorage.clear()`);
    await ev(client, `location.reload()`);
    await sleep(2500);
    await ev(client, `document.querySelector('[data-testid="tab-maps"]').click()`);
    await sleep(400);
    await ev(client, `document.querySelector('[data-testid="map-item-p0_corridor-json"]').click()`);
    await sleep(800);
    // 打开建筑下拉（18 项 → 应出现搜索框）
    await ev(client, `document.querySelector('[data-testid="map-tool-building"]').click()`);
    await sleep(300);
    await ev(client, `document.querySelector('[data-testid="map-select-building"]').click()`);
    await sleep(400);
    const info = await ev(
      client,
      `(() => {
  const menu = document.querySelector('.dd-menu');
  const search = document.querySelector('[data-testid="map-select-building-search"]');
  const trigger = document.querySelector('[data-testid="map-select-building"]');
  const cs = (el) => (el ? JSON.stringify(getComputedStyle(el)) : "null");
  const rect = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
  const menuStyle = menu ? { background: getComputedStyle(menu).backgroundColor, zIndex: getComputedStyle(menu).zIndex, overflow: getComputedStyle(menu).overflow, maxHeight: getComputedStyle(menu).maxHeight } : null;
  return JSON.stringify({ menuRect: rect(menu), searchRect: rect(search), triggerRect: rect(trigger), menuStyle, optionCount: document.querySelectorAll('[data-testid^="map-select-building-opt-"]').length, searchExists: !!search, winH: window.innerHeight });
})()`,
    );
    console.log("下拉态:", info);
    const menuH = JSON.parse(info).menuRect.h;
    const optVisible = await ev(client, `[...document.querySelectorAll('[data-testid^="map-select-building-opt-"]')].filter((o) => o.offsetParent !== null).length`);
    console.log(`菜单高=${menuH}px（R25 裁定=330px） 可见选项=${optVisible}/18（≈10 项首屏，其余滚动）`);
    const shot = await client.Page.captureScreenshot({ format: "png" });
    fs.writeFileSync(path.join(root, ".smoke-artifacts", "dd-probe.png"), Buffer.from(shot.data, "base64"));
    console.log("截图: .smoke-artifacts/dd-probe.png");
    // 搜索过滤验证
    await ev(client, `(() => { const el = document.querySelector('[data-testid="map-select-building-search"]'); const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set; set.call(el, "tank"); el.dispatchEvent(new Event("input", { bubbles: true })); return "ok"; })()`);
    await sleep(300);
    const filtered = await ev(client, `document.querySelectorAll('[data-testid^="map-select-building-opt-"]:not([style*="display: none"])').length`);
    console.log("搜索 tank 后可见项(应为 6 个 tank_*):", filtered);
    const visible = await ev(client, `[...document.querySelectorAll('[data-testid^="map-select-building-opt-"]')].filter((o) => o.offsetParent !== null).map((o) => o.textContent).join(",")`);
    console.log("可见项:", visible);
  } finally {
    if (client) await client.close().catch(() => {});
    if (process.platform === "win32") execSync(`taskkill /PID ${app.pid} /T /F`, { stdio: "ignore" });
    else app.kill();
  }
}

main().catch((err) => {
  console.error("PROBE_ERROR", err);
  process.exit(1);
});
