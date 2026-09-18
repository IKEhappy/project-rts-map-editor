// 新建地图改名/保存探针（R15 调试）：复刻用户路径——新建 → 抽屉改 name → 保存，
// 转储每步状态（字段值/脏态/保存按钮/横幅/沙盒目录落盘文件名）。
import CDP from "chrome-remote-interface";
import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sandboxMaps = path.join(root, ".probe-data", "maps");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function ev(client, expression) {
  const r = await client.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
  return r.result.value;
}

const setInput = async (client, testId, value) =>
  ev(
    client,
    `(() => {
  const el = document.querySelector('[data-testid="${testId}"]');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(el, "${value}");
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  return "ok";
})()`,
  );

async function main() {
  fs.rmSync(path.join(root, ".probe-data"), { recursive: true, force: true });
  fs.mkdirSync(sandboxMaps, { recursive: true });
  execSync("npx vite build", { cwd: root, stdio: "inherit" });
  const app = spawn("npx", ["electron", "."], {
    cwd: root,
    shell: true,
    stdio: ["ignore", "ignore", "ignore"],
    env: { ...process.env, ME_MAPS_DIR: sandboxMaps, ME_CDP: "1", ME_CDP_PORT: "9226" },
  });
  let client = null;
  try {
    let page = null;
    for (let i = 0; i < 60 && page === null; i += 1) {
      await sleep(500);
      try {
        const list = await (await fetch("http://127.0.0.1:9226/json/list")).json();
        page = list.find((t) => t.type === "page" && t.url.includes("index.html")) ?? null;
      } catch {
        /* not up */
      }
    }
    client = await CDP({ target: page.webSocketDebuggerUrl, port: 9226 });
    await client.Runtime.enable();
    await ev(client, `localStorage.clear()`);
    await ev(client, `location.reload()`);
    await sleep(2500);
    await ev(client, `document.querySelector('[data-testid="tab-maps"]').click()`);
    await sleep(500);
    await ev(client, `document.querySelector('[data-testid="map-new-btn"]').click()`);
    await sleep(500);
    await ev(client, `document.querySelector('[data-testid="map-json-toggle"]').click()`);
    await sleep(400);
    console.log("初始 name:", await ev(client, `document.querySelector('[data-testid="field-name"]')?.value`));
    console.log("改名前 save 按钮禁用:", await ev(client, `document.querySelector('[data-testid="map-save-btn"]').disabled`));
    await setInput(client, "field-name", "my_renamed_map");
    await sleep(300);
    console.log("改后 name 字段:", await ev(client, `document.querySelector('[data-testid="field-name"]')?.value`));
    console.log("列表新图项文本:", await ev(client, `document.querySelector('[data-testid="map-item-new"]')?.textContent`));
    console.log("save 按钮禁用(应 false):", await ev(client, `document.querySelector('[data-testid="map-save-btn"]').disabled`));
    await ev(client, `document.querySelector('[data-testid="map-save-btn"]').click()`);
    await sleep(6000);
    const banner = await ev(
      client,
      `document.querySelector('[data-testid="map-save-ok"]')?.textContent ?? document.querySelector('[data-testid="map-save-errors"]')?.textContent ?? "(无横幅)"`,
    );
    console.log("保存横幅:", banner);
    console.log("保存按钮禁用(保存后应 true):", await ev(client, `document.querySelector('[data-testid="map-save-btn"]').disabled`));
    console.log("沙盒目录:", fs.readdirSync(sandboxMaps));
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
