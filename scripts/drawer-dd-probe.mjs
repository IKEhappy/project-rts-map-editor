// 抽屉内下拉验证探针（R26）：真实复现"折叠"场景——画 box → 开 JSON 抽屉 → 展开
// 抽屉内 box_mode 的 access 下拉 → 截图 + 量菜单完整高度/裁剪状态/Portal 归属。
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
    env: { ...process.env, ME_MAPS_DIR: sandboxMaps, ME_CDP: "1", ME_CDP_PORT: "9231" },
  });
  let client = null;
  try {
    let page = null;
    for (let i = 0; i < 60 && page === null; i += 1) {
      await sleep(500);
      try {
        const list = await (await fetch("http://127.0.0.1:9231/json/list")).json();
        page = list.find((t) => t.type === "page" && t.url.includes("index.html")) ?? null;
      } catch {
        /* not up */
      }
    }
    client = await CDP({ target: page.webSocketDebuggerUrl, port: 9231 });
    await client.Runtime.enable();
    await client.Page.enable();
    await ev(client, `localStorage.clear()`);
    await ev(client, `location.reload()`);
    await sleep(2500);
    await ev(client, `document.querySelector('[data-testid="tab-maps"]').click()`);
    await sleep(400);
    await ev(client, `document.querySelector('[data-testid="map-item-p0_corridor-json"]').click()`);
    await sleep(600);

    // 画一个 box（让抽屉内 box_mode 条目有 access 枚举下拉）
    await ev(client, `document.querySelector('[data-testid="map-tool-box"]').click()`);
    await sleep(200);
    await ev(
      client,
      `(() => {
    const c = document.querySelector('[data-testid="map-canvas"] canvas');
    const rect = c.getBoundingClientRect();
    const ppc = parseFloat(c.getAttribute("data-ppc"));
    const ox = parseFloat(c.getAttribute("data-ox"));
    const oy = parseFloat(c.getAttribute("data-oy"));
    const scale = rect.width / (parseFloat(c.getAttribute("data-css-w")) || c.width);
    const px0 = rect.left + (4 - ox + 0.5) * ppc * scale;
    const py0 = rect.top + (3 - oy + 0.5) * ppc * scale;
    const px1 = rect.left + (8 - ox + 0.5) * ppc * scale;
    const py1 = rect.top + (5 - oy + 0.5) * ppc * scale;
    c.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: px0, clientY: py0 }));
    c.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, cancelable: true, clientX: px1, clientY: py1 }));
    c.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, clientX: px1, clientY: py1 }));
    return "ok";
  })()`,
    );
    await sleep(200);
    await ev(client, `document.querySelector('[data-testid="map-tool-none"]').click()`);
    await sleep(200);

    // 开 JSON 抽屉 → 点 box_mode-0-access 下拉
    await ev(client, `document.querySelector('[data-testid="map-json-toggle"]').click()`);
    await sleep(500);
    let triggerInfo = await ev(
      client,
      `!!document.querySelector('[data-testid="field-box_mode-0-access"]')`,
    );
    if (!triggerInfo) {
      // 滚动抽屉让 box_mode 可见
      await ev(
        client,
        `(() => {
    const tree = document.querySelector('.map-json-tree');
    if (tree) tree.scrollTop = tree.scrollHeight;
    return "ok";
  })()`,
      );
      await sleep(300);
    }
    await ev(client, `document.querySelector('[data-testid="field-box_mode-0-access"]')?.click(); "ok"`);
    await sleep(500);

    // 量菜单（Portal 后在 body 直属）
    const menuInfo = await ev(
      client,
      `(() => {
    const menus = [...document.querySelectorAll('body > .dd-menu')];
    if (menus.length === 0) return JSON.stringify({ error: "no body-level menu", allMenus: document.querySelectorAll(".dd-menu").length });
    const m = menus[menus.length - 1];
    const b = m.getBoundingClientRect();
    const cs = getComputedStyle(m);
    return JSON.stringify({
      menuRect: { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) },
      cssPos: cs.position,
      parentIsBody: m.parentElement === document.body,
      optCount: m.querySelectorAll(".dd-option").length,
      winH: window.innerHeight,
      winW: window.innerWidth,
      exceedsWin: b.bottom > window.innerHeight + 2,
    });
  })()`,
    );
    console.log("抽屉内菜单（Portal 后）:", menuInfo);
    const shot = await client.Page.captureScreenshot({ format: "png" });
    fs.writeFileSync(path.join(root, ".smoke-artifacts", "drawer-dd-fixed.png"), Buffer.from(shot.data, "base64"));
    console.log("截图: .smoke-artifacts/drawer-dd-fixed.png");
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
