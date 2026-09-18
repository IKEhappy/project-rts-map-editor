// 工具切换探针（R11，2026-09-18）：用户报"box_mode 等笔刷无法正常切换"——
// 真实鼠标（CDP Input 域）逐个点击 8 个工具按钮，断言：
//   ① 按钮获得 .active；② 画布 editing 光标类随工具变化；③ 工具参数下拉出现且可选。
// 独立端口 9224，不与 dev/smoke 冲突；沙盒数据，不动真仓库。
import CDP from "chrome-remote-interface";
import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = path.join(root, ".probe-data");
const mapsSrc = path.join(root, "..", "project-rts", "data", "maps");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`  ok: ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL: ${name} ${detail}`);
  }
};

async function ev(client, expression) {
  const r = await client.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
  return r.result.value;
}

async function realClick(client, testId) {
  const rect = await ev(
    client,
    `(() => { const el = document.querySelector('[data-testid="${testId}"]'); if (!el) return null; const r = el.getBoundingClientRect(); return JSON.stringify({x: r.left + r.width/2, y: r.top + r.height/2}); })()`,
  );
  if (!rect) throw new Error(`element not found: ${testId}`);
  const { x, y } = JSON.parse(rect);
  await client.Input.dispatchMouseEvent({ type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await client.Input.dispatchMouseEvent({ type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

async function main() {
  fs.rmSync(sandbox, { recursive: true, force: true });
  fs.mkdirSync(path.join(sandbox, "maps"), { recursive: true });
  fs.copyFileSync(path.join(mapsSrc, "p0_corridor.json"), path.join(sandbox, "maps", "p0_corridor.json"));
  fs.copyFileSync(path.join(mapsSrc, "test_buildings_map.json"), path.join(sandbox, "maps", "test_buildings_map.json"));
  execSync("npx vite build", { cwd: root, stdio: "inherit" });
  const app = spawn("npx", ["electron", "."], {
    cwd: root,
    shell: true,
    stdio: ["ignore", "ignore", "ignore"],
    env: { ...process.env, ME_MAPS_DIR: path.join(sandbox, "maps"), ME_CDP: "1", ME_CDP_PORT: "9224" },
  });
  let client = null;
  try {
    let page = null;
    for (let i = 0; i < 60 && page === null; i += 1) {
      await sleep(500);
      try {
        const list = await (await fetch("http://127.0.0.1:9224/json/list")).json();
        page = list.find((t) => t.type === "page" && t.url.includes("index.html")) ?? null;
      } catch {
        /* not up yet */
      }
    }
    if (!page) throw new Error("CDP page timeout");
    client = await CDP({ target: page.webSocketDebuggerUrl, port: 9224 });
    await client.Runtime.enable();
    await ev(client, `localStorage.clear()`);
    await ev(client, `location.reload()`);
    await sleep(2500);

    await realClick(client, "tab-maps");
    await ev(
      client,
      `(() => { const el = document.querySelector('[data-testid="map-item-p0_corridor-json"]'); el.click(); return "ok"; })()`,
    );
    await sleep(1500);

    const tools = [
      ["none", false, null],
      ["terrain", true, "map-select-terrain"],
      ["erase", true, null],
      ["box", true, "map-select-access"],
      ["building", true, "map-select-building"],
      ["tree", true, null],
      ["spawn", true, "map-select-spawn-kind"],
      ["delete", true, null],
    ];
    for (const [tool, editing, selectId] of tools) {
      await realClick(client, `map-tool-${tool}`);
      await sleep(250);
      const active = await ev(client, `document.querySelector('[data-testid="map-tool-${tool}"]').classList.contains("active")`);
      check(`${tool}：按钮 .active`, active === true);
      const canvasClass = await ev(client, `document.querySelector('[data-testid="map-canvas"] canvas').className`);
      check(`${tool}：画布 editing 类=${editing}`, canvasClass.includes("editing") === editing, canvasClass);
      if (selectId) {
        const hasSelect = await ev(client, `!!document.querySelector('[data-testid="${selectId}"]')`);
        check(`${tool}：参数下拉 ${selectId} 出现`, hasSelect === true);
        const changed = await ev(
          client,
          `(() => {
            const el = document.querySelector('[data-testid="${selectId}"]');
            if (!el || el.options.length < 2) return "few";
            const before = el.value;
            el.value = el.options[1].value;
            el.dispatchEvent(new Event("change", { bubbles: true }));
            return el.value !== before && el.value === el.options[1].value ? "ok" : "nochange";
          })()`,
        );
        check(`${tool}：下拉可切换参数`, changed === "ok", String(changed));
      }
      // 再点回预览，验证来回切换
      await realClick(client, "map-tool-none");
      await sleep(150);
      const backToNone = await ev(client, `document.querySelector('[data-testid="map-tool-none"]').classList.contains("active")`);
      check(`${tool} → none：可切回预览`, backToNone === true);
    }
  } finally {
    if (client) await client.close().catch(() => {});
    if (process.platform === "win32") execSync(`taskkill /PID ${app.pid} /T /F`, { stdio: "ignore" });
    else app.kill();
  }
  console.log(failures === 0 ? "PROBE_OK" : `PROBE_FAIL failures=${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("PROBE_ERROR", err);
  process.exit(1);
});
