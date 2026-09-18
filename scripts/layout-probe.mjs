// 布局探针（R21）：起应用 → 地图页 → 截图 + 量画布视口实际尺寸与窗口比例。
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
    env: { ...process.env, ME_MAPS_DIR: sandboxMaps, ME_CDP: "1", ME_CDP_PORT: "9227" },
  });
  let client = null;
  try {
    let page = null;
    for (let i = 0; i < 60 && page === null; i += 1) {
      await sleep(500);
      try {
        const list = await (await fetch("http://127.0.0.1:9227/json/list")).json();
        page = list.find((t) => t.type === "page" && t.url.includes("index.html")) ?? null;
      } catch {
        /* not up */
      }
    }
    client = await CDP({ target: page.webSocketDebuggerUrl, port: 9227 });
    await client.Runtime.enable();
    await client.Page.enable();
    await ev(client, `localStorage.clear()`);
    await ev(client, `location.reload()`);
    await sleep(2500);
    await ev(client, `document.querySelector('[data-testid="tab-maps"]').click()`);
    await sleep(500);
    await ev(client, `document.querySelector('[data-testid="map-item-p0_corridor-json"]').click()`);
    await sleep(1200);
    const metrics = await ev(
      client,
      `(() => {
  const vp = document.querySelector('.map-canvas-viewport');
  const canvas = document.querySelector('[data-testid="map-canvas"] canvas');
  const work = document.querySelector('.map-workarea');
  const body = document.querySelector('.maps-body');
  const notes = document.querySelector('.map-notes');
  const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
  return JSON.stringify({ win: { w: window.innerWidth, h: window.innerHeight }, vp: r(vp), canvas: r(canvas), work: r(work), body: r(body), notes: r(notes), canvasPx: canvas ? { w: canvas.width, h: canvas.height } : null });
})()`,
    );
    console.log("布局实测:", metrics);
    const shot = await client.Page.captureScreenshot({ format: "png" });
    fs.writeFileSync(path.join(root, ".smoke-artifacts", "layout-probe.png"), Buffer.from(shot.data, "base64"));
    console.log("截图: .smoke-artifacts/layout-probe.png");
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
