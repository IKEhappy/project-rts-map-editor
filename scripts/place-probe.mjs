// 放置探针（R14 调试）：新建地图 → 选 hq → 点格放置 → 转储中间态定位失败环节。
import CDP from "chrome-remote-interface";
import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = path.join(root, ".probe-data");
const mapsSrc = path.join(root, "..", "project-rts", "data", "maps");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function ev(client, expression) {
  const r = await client.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
  return r.result.value;
}

async function main() {
  fs.rmSync(sandbox, { recursive: true, force: true });
  fs.mkdirSync(path.join(sandbox, "maps"), { recursive: true });
  fs.copyFileSync(path.join(mapsSrc, "p0_corridor.json"), path.join(sandbox, "maps", "p0_corridor.json"));
  execSync("npx vite build", { cwd: root, stdio: "inherit" });
  const app = spawn("npx", ["electron", "."], {
    cwd: root,
    shell: true,
    stdio: ["ignore", "ignore", "ignore"],
    env: { ...process.env, ME_MAPS_DIR: path.join(sandbox, "maps"), ME_CDP: "1", ME_CDP_PORT: "9225" },
  });
  let client = null;
  try {
    let page = null;
    for (let i = 0; i < 60 && page === null; i += 1) {
      await sleep(500);
      try {
        const list = await (await fetch("http://127.0.0.1:9225/json/list")).json();
        page = list.find((t) => t.type === "page" && t.url.includes("index.html")) ?? null;
      } catch {
        /* not up yet */
      }
    }
    client = await CDP({ target: page.webSocketDebuggerUrl, port: 9225 });
    await client.Runtime.enable();
    await ev(client, `localStorage.clear()`);
    await ev(client, `location.reload()`);
    await sleep(2500);
    await ev(client, `document.querySelector('[data-testid="tab-maps"]').click()`);
    await sleep(600);
    await ev(client, `document.querySelector('[data-testid="map-new-btn"]').click()`);
    await sleep(600);
    // 复刻冒烟 4.995/4.996 路径：开抽屉 → width 64 → 等待 ppc 7 → 建筑工具
    await ev(client, `document.querySelector('[data-testid="map-json-toggle"]').click(); "ok"`);
    await sleep(300);
    await ev(client, `(() => {
      const el = document.querySelector('[data-testid="field-width"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(el, "64");
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      return "ok";
    })()`);
    await sleep(600);
    console.log("ppc after width64:", await ev(client, `document.querySelector('[data-testid="map-canvas"] canvas').getAttribute("data-ppc")`));
    console.log("tool building click:", await ev(client, `document.querySelector('[data-testid="map-tool-building"]')?.click(); "ok"`));
    await sleep(400);
    const selectInfo = await ev(
      client,
      `(() => { const s = document.querySelector('[data-testid="map-select-building"]'); return s ? JSON.stringify({count: s.options.length, first: s.options[0]?.value, value: s.value}) : "absent"; })()`,
    );
    console.log("building select:", selectInfo);
    console.log("set hq:", await ev(client, `(() => { const s = document.querySelector('[data-testid="map-select-building"]'); const set = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set; set.call(s, "hq"); s.dispatchEvent(new Event("change", {bubbles:true})); return s.value; })()`));
    await sleep(300);
    const clickCell = (cx, cy) =>
      ev(
        client,
        `(() => {
    const c = document.querySelector('[data-testid="map-canvas"] canvas');
    const rect = c.getBoundingClientRect();
    const ppc = parseFloat(c.getAttribute("data-ppc"));
    const ox = parseFloat(c.getAttribute("data-ox"));
    const oy = parseFloat(c.getAttribute("data-oy"));
    const scale = rect.width / c.width;
    const px = rect.left + (${cx} - ox + 0.5) * ppc * scale;
    const py = rect.top + (${cy} - oy + 0.5) * ppc * scale;
    for (const t of ["mousedown", "mouseup", "click"]) c.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, clientX: px, clientY: py }));
    return JSON.stringify({px, py, ppc, w: c.width, h: c.height, rectW: rect.width, rectH: rect.height});
  })()`,
      );
    console.log("click(2,2):", await clickCell(2, 2));
    await sleep(600);
    await sleep(400);
    const treeText = await ev(client, `document.querySelector(".map-json-tree")?.textContent?.slice(0, 260) ?? "(no tree)"`);
    console.log("json tree:", treeText);
    const wField = await ev(client, `document.querySelector('[data-testid="field-buildings-0-w"]')?.value ?? "absent"`);
    console.log("field-buildings-0-w:", wField);
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
