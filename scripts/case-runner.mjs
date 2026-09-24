// A/B 对比 Case 运行器（R26 用户裁定）：
//   tests/cases/<case>/A.json（测试基板地图） + B.json（期望结果） + ops.json（操作序列）
//   运行器在沙盒 maps 目录放 A → 起 Electron → 按 ops 驱动 UI → 读回磁盘文件 C → 与 B 深比对。
//   不碰真实工程配置（沙盒 + 专用测试地图 + 专用端口 9230）。
//
// ops.json 指令集（全部走真实 UI 事件）：
//   { tool: "terrain|erase|box|building|spawn|delete|none" }                    切工具
//   { select: "<testId>", value: "<选项 value>" }                                自绘下拉选值
//   { key: "<字符>" }                                                            数字/B 热键
//   { clickCell: [x, y] }                                                        画布点格
//   { dragCell: [[x0,y0],[x1,y1]] }                                              画布拖格
//   { rclickCell: [x, y] }                                                       画布右键格
//   { menu: "<testId>" }                                                         点菜单项
//   { save: true }                                                               保存（过门禁）
//   { sleep: ms }                                                                等待
import CDP from "chrome-remote-interface";
import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const casesDir = path.join(root, "tests", "cases");
const sandbox = path.join(root, ".case-data");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`    ok: ${name}`);
  else {
    failures += 1;
    console.error(`    FAIL: ${name} ${detail}`);
  }
}

async function ev(client, expression) {
  const r = await client.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
  return r.result.value;
}

const click = (client, testId) => ev(client, `document.querySelector('[data-testid="${testId}"]').click(); "ok"`);
const waitFor = async (client, expression, timeoutMs, label) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await ev(client, expression)) return true;
    } catch {
      /* ignore */
    }
    if (Date.now() > deadline) throw new Error(`timeout: ${label}`);
    await sleep(250);
  }
};

function deepDiff(a, b, pathStr = "$", out = []) {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) out.push(`${pathStr}: 数组长度 ${a.length} ≠ ${b.length}`);
    for (let i = 0; i < Math.min(a.length, b.length); i += 1) deepDiff(a[i], b[i], `${pathStr}[${i}]`, out);
    return out;
  }
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      if (!(k in a)) out.push(`${pathStr}.${k}: B 有 A 无`);
      else if (!(k in b)) out.push(`${pathStr}.${k}: A 有 B 无`);
      else deepDiff(a[k], b[k], `${pathStr}.${k}`, out);
    }
    return out;
  }
  if (a !== b) out.push(`${pathStr}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`);
  return out;
}

async function runOps(client, ops) {
  for (const op of ops) {
    if (op.sleep) {
      await sleep(op.sleep);
    } else if (op.tool) {
      await click(client, `map-tool-${op.tool}`);
      await sleep(200);
    } else if (op.select) {
      await click(client, op.select);
      await waitFor(client, `!!document.querySelector('[data-testid="${op.select}-opt-${op.value}"]')`, 4000, `选项 ${op.value}`);
      await click(client, `${op.select}-opt-${op.value}`);
      await sleep(200);
    } else if (op.key) {
      const mod = op.ctrl ? "ctrlKey: true, " : "";
      await ev(client, `window.dispatchEvent(new KeyboardEvent("keydown", { key: "${op.key}", ${mod}bubbles: true, cancelable: true })); "ok"`);
      await sleep(200);
    } else if (op.clickCell) {
      const [cx, cy] = op.clickCell;
      await ev(
        client,
        `(() => {
    const c = document.querySelector('[data-testid="map-canvas"] canvas');
    const rect = c.getBoundingClientRect();
    const ppc = parseFloat(c.getAttribute("data-ppc"));
    const ox = parseFloat(c.getAttribute("data-ox"));
    const oy = parseFloat(c.getAttribute("data-oy"));
    const scale = rect.width / (parseFloat(c.getAttribute("data-css-w")) || c.width);
    const px = rect.left + (${cx} - ox + 0.5) * ppc * scale;
    const py = rect.top + (${cy} - oy + 0.5) * ppc * scale;
    for (const t of ["mousedown", "mouseup", "click"]) c.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, clientX: px, clientY: py }));
    return "ok";
  })()`,
      );
      await sleep(200);
    } else if (op.dragCell) {
      const [[x0, y0], [x1, y1]] = op.dragCell;
      const pt = (cx, cy) =>
        `rect.left + (${cx} - ox + 0.5) * ppc * scale, rect.top + (${cy} - oy + 0.5) * ppc * scale`;
      await ev(
        client,
        `(() => {
    const c = document.querySelector('[data-testid="map-canvas"] canvas');
    const rect = c.getBoundingClientRect();
    const ppc = parseFloat(c.getAttribute("data-ppc"));
    const ox = parseFloat(c.getAttribute("data-ox"));
    const oy = parseFloat(c.getAttribute("data-oy"));
    const scale = rect.width / (parseFloat(c.getAttribute("data-css-w")) || c.width);
    const [px0, py0] = [${pt(x0, y0)}];
    const [px1, py1] = [${pt(x1, y1)}];
    c.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: px0, clientY: py0 }));
    c.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, cancelable: true, clientX: px1, clientY: py1 }));
    c.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, clientX: px1, clientY: py1 }));
    return "ok";
  })()`,
      );
      await sleep(250);
    } else if (op.rclickCell) {
      const [cx, cy] = op.rclickCell;
      await ev(
        client,
        `(() => {
    const c = document.querySelector('[data-testid="map-canvas"] canvas');
    const rect = c.getBoundingClientRect();
    const ppc = parseFloat(c.getAttribute("data-ppc"));
    const ox = parseFloat(c.getAttribute("data-ox"));
    const oy = parseFloat(c.getAttribute("data-oy"));
    const scale = rect.width / (parseFloat(c.getAttribute("data-css-w")) || c.width);
    c.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: rect.left + (${cx} - ox + 0.5) * ppc * scale, clientY: rect.top + (${cy} - oy + 0.5) * ppc * scale }));
    return "ok";
  })()`,
      );
      await sleep(250);
    } else if (op.menu) {
      await click(client, op.menu);
      await sleep(250);
    } else if (op.save) {
      await click(client, "map-save-btn");
      await waitFor(client, `!!document.querySelector('[data-testid="map-save-ok"], [data-testid="map-save-errors"]')`, 60000, "save banner");
      await sleep(500);
    }
  }
}

async function main() {
  execSync("npx vite build", { cwd: root, stdio: "inherit" });
  const caseNames = process.argv.slice(2).length > 0 ? process.argv.slice(2) : fs.readdirSync(casesDir).filter((n) => fs.existsSync(path.join(casesDir, n, "A.json")));
  if (caseNames.length === 0) {
    console.log("无 Case（tests/cases/ 下需有 <case>/A.json）");
    process.exit(0);
  }

  fs.rmSync(sandbox, { recursive: true, force: true });
  fs.mkdirSync(path.join(sandbox, "maps"), { recursive: true });
  const projectData = path.join(root, "..", "project-rts", "data");
  for (const name of ["units.json", "buildings.json"]) {
    fs.copyFileSync(path.join(projectData, name), path.join(sandbox, name));
  }

  const app = spawn("npx", ["electron", "."], {
    cwd: root,
    shell: true,
    stdio: ["ignore", "ignore", "ignore"],
    env: { ...process.env, ME_MAPS_DIR: path.join(sandbox, "maps"), ME_CDP: "1", ME_CDP_PORT: "9230" },
  });
  let client = null;
  try {
    let page = null;
    for (let i = 0; i < 60 && page === null; i += 1) {
      await sleep(500);
      try {
        const list = await (await fetch("http://127.0.0.1:9230/json/list")).json();
        page = list.find((t) => t.type === "page" && t.url.includes("index.html")) ?? null;
      } catch {
        /* not up */
      }
    }
    client = await CDP({ target: page.webSocketDebuggerUrl, port: 9230 });
    await client.Runtime.enable();
    await ev(client, `localStorage.clear()`);
    await ev(client, `location.reload()`);
    await sleep(2500);

    let caseIndex = 0;
    for (const name of caseNames) {
      caseIndex += 1;
      const dir = path.join(casesDir, name);
      const A = JSON.parse(fs.readFileSync(path.join(dir, "A.json"), "utf8"));
      const B = JSON.parse(fs.readFileSync(path.join(dir, "B.json"), "utf8"));
      const ops = JSON.parse(fs.readFileSync(path.join(dir, "ops.json"), "utf8"));
      console.log(`[case ${caseIndex}/${caseNames.length}] ${name}（${ops.length} 步操作）`);
      const fileName = `${name}.json`;

      // 重置沙盒：写 A → UI 里新建同 A 内容地图（走新建→改内容→另存为 fileName）最麻烦；
      // 简化：直接把 A 写进沙盒 maps 目录 + 刷新列表 + 选中操作
      fs.writeFileSync(path.join(sandbox, "maps", fileName), JSON.stringify(A, null, 2) + "\n", "utf8");
      await click(client, "tab-maps");
      await click(client, "map-reload-btn"); // 刷新文件列表
      await sleep(500);
      await click(client, `map-item-${fileName.replace(/\./g, "-")}`);
      await sleep(600);

      await runOps(client, ops);

      // 读回 C
      const C = JSON.parse(fs.readFileSync(path.join(sandbox, "maps", fileName), "utf8"));
      const diffs = deepDiff(C, B);
      check(`A→操作→C 与 B 深比对一致（${diffs.length} 处差异）`, diffs.length === 0, diffs.slice(0, 8).join(" | "));
      if (diffs.length > 0) {
        fs.writeFileSync(path.join(root, ".smoke-artifacts", `case-${name}-C.json`), JSON.stringify(C, null, 2));
      }
    }
  } finally {
    if (client) await client.close().catch(() => {});
    if (process.platform === "win32") execSync(`taskkill /PID ${app.pid} /T /F`, { stdio: "ignore" });
    else app.kill();
  }
  console.log(failures === 0 ? "CASES_OK" : `CASES_FAIL failures=${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("CASES_ERROR", err);
  process.exit(1);
});
