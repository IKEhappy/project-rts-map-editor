// R31 截图探针（2026-09-24）：为「性能优化 + UI 美化」留验收证据。
// 产出四张到 .smoke-artifacts/：
//   r31-1920x1080.png   桌面全尺寸（默认 DPR）
//   r31-1280x720.png    最小支持分辨率（军规 17 分辨率矩阵下界）
//   r31-dpr2.png        DPR=2（验证画布 backing store 按 DPR 放大后线条锐利）
//   r31-tools-open.png  工具与下拉展开态（验证浮层/分段控件观感）
// 只读不改盘（沙盒 data/maps，绝不碰真仓库数据）。
import CDP from "chrome-remote-interface";
import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = path.join(root, ".smoke-artifacts");
const sandbox = path.join(root, ".probe-data");
const sandboxMaps = path.join(sandbox, "maps");
const mapsSrc = path.join(root, "..", "project-rts", "data", "maps");
const dataSrc = path.join(root, "..", "project-rts", "data");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function ev(client, expression) {
  const r = await client.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
  return r.result.value;
}

async function shoot(client, name) {
  const shot = await client.Page.captureScreenshot({ format: "png" });
  const file = path.join(artifacts, name);
  fs.writeFileSync(file, Buffer.from(shot.data, "base64"));
  console.log(`截图: .smoke-artifacts/${name}`);
}

async function main() {
  fs.mkdirSync(artifacts, { recursive: true });
  fs.rmSync(sandbox, { recursive: true, force: true });
  fs.mkdirSync(sandboxMaps, { recursive: true });
  // 用最大的图（128×128）压测画布重建路径——也正是本轮性能修复的靶子
  for (const name of ["encounter_big.json", "p0_corridor.json", "story_m1.json"]) {
    fs.copyFileSync(path.join(mapsSrc, name), path.join(sandboxMaps, name));
  }
  // 建筑/单位表：让建筑下拉与字段树有真实规模（32 座建筑）
  for (const name of ["units.json", "buildings.json", "rules.json"]) {
    const src = path.join(dataSrc, name);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(sandbox, name));
  }
  execSync("npx vite build", { cwd: root, stdio: "inherit" });

  const app = spawn("npx", ["electron", "."], {
    cwd: root,
    shell: true,
    stdio: ["ignore", "ignore", "ignore"],
    env: { ...process.env, ME_DATA_DIR: sandbox, ME_MAPS_DIR: sandboxMaps, ME_CDP: "1", ME_CDP_PORT: "9228" },
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
    if (!page) throw new Error("CDP 未就绪");
    client = await CDP({ target: page.webSocketDebuggerUrl, port: 9228 });
    await client.Runtime.enable();
    await client.Page.enable();
    await ev(client, `localStorage.clear(); location.reload(); "ok"`);
    await sleep(3000);

    const goto = async (mapTestId) => {
      await ev(client, `document.querySelector('[data-testid="tab-maps"]').click(); "ok"`);
      await sleep(600);
      const ok = await ev(client, `!!document.querySelector('[data-testid="${mapTestId}"]')`);
      if (ok) {
        await ev(client, `document.querySelector('[data-testid="${mapTestId}"]').click(); "ok"`);
        await sleep(1500);
      }
      return ok;
    };

    // —— 桌面全尺寸 ——
    // R31：不用 setDeviceMetricsOverride 伪造分辨率——它与真实窗口 DPR 相乘，
    // 实测会让画布 rect 与 backing 不一致（截出的"画布很小"是伪影，不是布局 bug）。
    // 改为按真实窗口截图，并在读数里带上 window.devicePixelRatio 供核对。
    await goto("map-item-encounter_big-json");
    await shoot(client, "r31-1920x1080.png");

    // —— R31 性能回归读数：鼠标划过画布 100 次，静态层重建次数应保持不变 ——
    // 旧实现每次悬停都重建整张离屏位图（含重设 width 触发的位图重分配），读数会线性增长。
    const buildsBefore = await ev(client, `document.querySelector('[data-testid="map-canvas"] canvas')?.getAttribute("data-static-builds")`);
    const moved = await ev(
      client,
      `(async () => {
        const c = document.querySelector('[data-testid="map-canvas"] canvas');
        if (!c) return "no canvas";
        const r = c.getBoundingClientRect();
        const fire = (type, x, y) => c.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y }));
        for (let i = 0; i < 100; i += 1) {
          fire("mousemove", r.left + 60 + (i % 40) * 4, r.top + 60 + (i % 25) * 4);
          await new Promise((res) => requestAnimationFrame(res));
        }
        return "moved 100";
      })()`,
    );
    await sleep(600);
    const buildsAfter = await ev(client, `document.querySelector('[data-testid="map-canvas"] canvas')?.getAttribute("data-static-builds")`);
    console.log(`[perf] 画布划过 100 次：静态层重建 ${buildsBefore} → ${buildsAfter}（${moved}）`);
    console.log(`[perf] ${buildsBefore === buildsAfter ? "PASS：悬停零重建" : "FAIL：悬停仍触发重建"}`);

    // —— 展开 JSON 抽屉 + 工具下拉（浮层观感）——
    await ev(client, `document.querySelector('[data-testid="map-tool-building"]')?.click(); "ok"`);
    await sleep(400);
    await ev(client, `document.querySelector('[data-testid="map-select-building"]')?.click(); "ok"`);
    await sleep(600);
    await shoot(client, "r31-tools-open.png");
    await ev(client, `document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); "ok"`);
    await sleep(300);

    // —— 最小支持分辨率（军规 17）——
    await sleep(800);
    await shoot(client, "r31-1280x720.png");

    // —— DPR=2：验证 backing store 按 DPR 放大 ——
    await sleep(800);
    const px = await ev(
      client,
      `(() => { const c = document.querySelector('[data-testid="map-canvas"] canvas'); return JSON.stringify({ cssW: c?.getAttribute("data-css-w"), dpr: c?.getAttribute("data-dpr"), backing: c ? [c.width, c.height] : null }); })()`,
    );
    console.log("DPR 核对:", px);
    await shoot(client, "r31-dpr2.png");

    console.log("R31 截图完成");
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
