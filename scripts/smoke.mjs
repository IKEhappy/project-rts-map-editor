// E2E 冒烟（T-164 验收）：在沙盒数据目录（.smoke-data，不动真仓库数据）上驱动真实
// Electron 窗口跑完整回路：非法保存被 gate 拒绝且文件不动 → 合法保存写盘 + .bak →
// 重新加载回读 → （store 层）无改动不写盘。CDP 驱动（9222），末尾截图留档。
import CDP from "chrome-remote-interface";
import { execSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = path.join(root, ".smoke-artifacts");
const sandbox = path.join(root, ".smoke-data");
const dataSrc = path.join(root, "..", "war-of-state", "data");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha = (text) => crypto.createHash("sha256").update(text, "utf8").digest("hex");

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) {
    console.log(`  ok: ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL: ${name} ${detail}`);
  }
}

async function ev(client, expression) {
  const r = await client.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    throw new Error(`eval exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  }
  return r.result.value;
}

async function waitForEval(client, expression, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const value = await ev(client, expression);
      if (value) return value;
    } catch {
      /* 导航期间执行上下文销毁属预期，继续轮询 */
    }
    if (Date.now() > deadline) throw new Error(`timeout waiting for: ${label}`);
    await sleep(250);
  }
}

const setInput = (client, testId, value) =>
  ev(client, `(() => {
    const el = document.querySelector('[data-testid="${testId}"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(el, "${String(value).replace(/\\/g, "\\\\")}");
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  })()`);

const click = (client, testId) => ev(client, `document.querySelector('[data-testid="${testId}"]').click()`);

/** 真实鼠标点击（CDP Input 域，走完整命中测试——程序化 el.click() 绕过命中测试，
 *  测不出 app-region 拖拽区吞点击这类 bug，2026-09-14 用户实测窗口按钮失灵的教训） */
const realClick = async (client, testId) => {
  const rect = await ev(
    client,
    `(() => { const r = document.querySelector('[data-testid="${testId}"]').getBoundingClientRect(); return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 }); })()`,
  );
  const { x, y } = JSON.parse(String(rect));
  await client.Input.dispatchMouseEvent({ type: "mouseMoved", x, y });
  await client.Input.dispatchMouseEvent({ type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await client.Input.dispatchMouseEvent({ type: "mouseReleased", x, y, button: "left", clickCount: 1 });
};

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  try {
    execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: "ignore" });
  } catch {
    /* best effort */
  }
}

async function waitForCdpPage(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const targets = await fetch("http://127.0.0.1:9223/json/list").then((r) => r.json());
      const page = targets.find((t) => t.type === "page");
      if (page) return page;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error("timeout waiting for CDP page target");
    await sleep(300);
  }
}

const sandboxUnits = path.join(sandbox, "units.json");

/** 9223（smoke 专用 CDP 端口，与 dev 的 9222 互不干扰）被占时中止——防止连到残留窗口跑旧构建 */
async function assertCdpPortFree() {
  try {
    const response = await fetch("http://127.0.0.1:9223/json/list");
    if (Array.isArray(await response.json())) {
      throw new Error("端口 9223 已被占用（残留的冒烟窗口？）——请先关闭后重跑");
    }
  } catch (err) {
    if (err instanceof TypeError) return; // 连接失败 = 端口空闲
    throw err;
  }
}

async function main() {
  fs.rmSync(artifacts, { recursive: true, force: true });
  fs.rmSync(sandbox, { recursive: true, force: true });
  fs.mkdirSync(artifacts, { recursive: true });
  fs.mkdirSync(sandbox, { recursive: true });
  for (const name of ["units.json", "buildings.json", "rules.json"]) {
    fs.copyFileSync(path.join(dataSrc, name), path.join(sandbox, name));
  }

  console.log("[smoke] vite build");
  execSync("npx vite build", { cwd: root, stdio: "inherit" });
  await assertCdpPortFree();

  console.log("[smoke] launch electron (sandbox data dir)");
  const app = spawn("npx", ["electron", "."], {
    cwd: root,
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ME_DATA_DIR: sandbox, ME_CDP: "1", ME_CDP_PORT: "9223" },
  });
  app.stdout.on("data", (chunk) => process.stdout.write(`[electron] ${chunk}`));
  app.stderr.on("data", (chunk) => process.stderr.write(`[electron:err] ${chunk}`));

  let client = null;
  try {
    const page = await waitForCdpPage(30000);
    client = await CDP({ target: page.webSocketDebuggerUrl, port: 9223 });
    await client.Runtime.enable();
    await client.Page.enable();

    // dataDir 覆盖经 localStorage 跨实例持久化（用户特性），冒烟必须清掉上次的残留，
    // 否则一启动就在读上次的外部目录（2026-09-14 踩坑：步骤间数据来源错乱）。
    // 清掉后 reload，并等待新导航真正完成（旧页面与新页面的判定靠 navigation type）。
    await ev(client, `localStorage.clear()`);
    await ev(client, `location.reload()`);
    await waitForEval(
      client,
      `document.readyState === "complete" && performance.getEntriesByType("navigation")[0]?.type === "reload"`,
      20000,
      "page reload complete",
    );

    console.log("[smoke] 1. units 左侧实体列表 21 项 + 首实体选中");
    const itemCount = await waitForEval(
      client,
      `document.querySelectorAll('[data-testid="entity-item"]').length === 21`,
      20000,
      "entity items",
    );
    check("units 实体列表 21 项", itemCount === true);
    await click(client, "entity-item");
    const workspaceBar = await ev(client, `!!document.querySelector('[data-testid="workspace-bar"]')`);
    check("工作区选项卡行（第二行 panel）存在", workspaceBar === true);
    const winButtons = await ev(
      client,
      `["win-min-btn", "win-max-btn", "win-close-btn"].every((id) => !!document.querySelector('[data-testid="' + id + '"]'))`,
    );
    check("无框窗口控制按钮齐全（最小化/最大化/关闭）", winButtons === true);

    const labelsOn = await ev(client, `document.body.textContent.includes("攻击间隔")`);
    check("字段中文标签已加载（攻击间隔）", labelsOn === true);

    const initialHp = await ev(client, `document.querySelector('[data-testid="field-hp"]').value`);
    check("首个单位 hp 初值 200", initialHp === "200", `got ${initialHp}`);

    console.log("[smoke] 2. 非法保存（hp=-5）必须被 gate 拒绝且文件不动");
    const hashBefore = sha(fs.readFileSync(sandboxUnits, "utf8"));
    await setInput(client, "field-hp", "-5");
    await click(client, "save-btn");
    const rejectText = await waitForEval(
      client,
      `(() => { const el = document.querySelector('[data-testid="save-errors"]'); return el ? el.textContent : ""; })()`,
      45000,
      "save-errors banner",
    );
    check("gate 拒绝横幅出现", typeof rejectText === "string" && rejectText.length > 0, String(rejectText).slice(0, 200));
    check(
      "拒绝文案含 nonnegative/HP 语义",
      /nonnegative|HP/i.test(String(rejectText)),
      String(rejectText).slice(0, 200),
    );
    check("文件未被改动", sha(fs.readFileSync(sandboxUnits, "utf8")) === hashBefore);
    check(".bak 未产生", !fs.existsSync(`${sandboxUnits}.bak`));

    console.log("[smoke] 3. 合法保存（hp=210）写盘 + .bak");
    await setInput(client, "field-hp", "210");
    await click(client, "save-btn");
    const okText = await waitForEval(
      client,
      `(() => { const el = document.querySelector('[data-testid="save-ok"]'); return el ? el.textContent : ""; })()`,
      45000,
      "save-ok banner",
    );
    check("保存成功横幅", /已保存/.test(String(okText)), String(okText));
    const saved = JSON.parse(fs.readFileSync(sandboxUnits, "utf8"));
    check("沙盒文件 hp=210", saved.units[0].hp === 210, `got ${saved.units[0].hp}`);
    check("保存后文件为 2 空格缩进 + 尾行换行", fs.readFileSync(sandboxUnits, "utf8").endsWith("}\n"));
    const bak = JSON.parse(fs.readFileSync(`${sandboxUnits}.bak`, "utf8"));
    check(".bak 备份 hp=200", bak.units[0].hp === 200, `got ${bak.units[0].hp}`);

    console.log("[smoke] 4. 重新加载回读 210");
    await click(client, "reload-btn");
    const reloadedHp = await waitForEval(
      client,
      `document.querySelector('[data-testid="field-hp"]').value === "210"`,
      20000,
      "reloaded hp",
    );
    check("重载后 hp 输入框为 210", reloadedHp === true);

    console.log("[smoke] 4.1 选项卡切换不弹窗不丢编辑（切建筑再切回，222 应保留）");
    await setInput(client, "field-hp", "222");
    await click(client, "tab-buildings");
    await waitForEval(
      client,
      `document.querySelectorAll('[data-testid="entity-item"]').length === 18`,
      20000,
      "buildings loaded",
    );
    await click(client, "tab-units");
    const retainedEdit = await waitForEval(
      client,
      `document.querySelector('[data-testid="field-hp"]')?.value === "222"`,
      20000,
      "retained 222",
    );
    check("切换选项卡后未保存编辑保留（222）", retainedEdit === true);
    const tabDirtyMark = await ev(client, `!!document.querySelector('[data-testid="tab-units"] .tab-dirty')`);
    check("选项卡上有未保存标记（黄点）", tabDirtyMark === true);
    await setInput(client, "field-hp", "210");
    await sleep(300);

    console.log("[smoke] 4.5 树形数组元素排序（auto_attack_targets 第 2 项上移一次）");
    const moveUp = (testId) =>
      ev(
        client,
        `document.querySelector('[data-testid="${testId}"]').closest('.tree-row').querySelector('button[title="上移"]').click()`,
      );
    await moveUp("field-auto_attack_targets-1");
    await click(client, "save-btn");
    const expectedOrder = JSON.stringify(["turrets", "units", "buildings"]);
    let savedOrder = null;
    for (let waited = 0; waited < 45000; waited += 500) {
      const current = JSON.parse(fs.readFileSync(sandboxUnits, "utf8")).units[0].auto_attack_targets;
      if (JSON.stringify(current) === expectedOrder) {
        savedOrder = current;
        break;
      }
      await sleep(500);
    }
    check("数组元素排序经 gate 写盘 [turrets,units,buildings]", savedOrder !== null, JSON.stringify(savedOrder));
    await click(client, "reload-btn");
    const firstTarget = await waitForEval(
      client,
      `document.querySelector('[data-testid="field-auto_attack_targets-0"]')?.value === "turrets"`,
      20000,
      "reloaded first target",
    );
    check("重载后首元素下拉=turrets", firstTarget === true);

    console.log("[smoke] 4.7 建筑表 radar：lines.unit 固定下拉（role=summon 组，严格限定）");
    await click(client, "tab-buildings");
    await waitForEval(
      client,
      `document.querySelectorAll('[data-testid="entity-item"]').length === 18`,
      20000,
      "buildings items",
    );
    await setInput(client, "entity-search", "radar");
    await waitForEval(
      client,
      `document.querySelectorAll('[data-testid="entity-item"]').length === 1`,
      10000,
      "radar filtered",
    );
    await click(client, "entity-item");
    const unitTag = await waitForEval(
      client,
      `(() => { const el = document.querySelector('[data-testid="field-lines-0-unit"]'); return el ? el.tagName : null; })()`,
      10000,
      "lines unit select",
    );
    check("lines.unit 为固定下拉 SELECT", unitTag === "SELECT", String(unitTag));
    const optionCount = await ev(client, `document.querySelectorAll('[data-testid="field-lines-0-unit"] option').length`);
    check("选项恰为 summon 组 5 项", optionCount === 5, `got ${optionCount}`);
    const firstOption = await ev(client, `document.querySelector('[data-testid="field-lines-0-unit"] option')?.value`);
    check("首项为 transport", firstOption === "transport", String(firstOption));
    const optionText = await ev(client, `document.querySelector('[data-testid="field-lines-0-unit"] option')?.text`);
    check("选项文本含中文名", typeof optionText === "string" && optionText.includes("（"), String(optionText));
    const hasVehicle = await ev(
      client,
      `[...document.querySelectorAll('[data-testid="field-lines-0-unit"] option')].some((o) => o.value === "flamer")`,
    );
    check("组外单位不可选（无 flamer）", hasVehicle === false);

    console.log("[smoke] 4.8 lines.unit 选择变更经 gate 写盘（fighter → bomber）");
    await ev(
      client,
      `(() => { const el = document.querySelector('[data-testid="field-lines-0-unit"]'); const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set; setter.call(el, "bomber"); el.dispatchEvent(new Event("change", { bubbles: true })); })()`,
    );
    await click(client, "save-btn");
    let savedLineUnit = null;
    for (let waited = 0; waited < 45000; waited += 500) {
      const current = JSON.parse(fs.readFileSync(path.join(sandbox, "buildings.json"), "utf8"))
        .buildings.find((b) => b.key === "radar").lines[0].unit;
      if (current === "bomber") {
        savedLineUnit = current;
        break;
      }
      await sleep(500);
    }
    check("选择变更经 gate 写盘 lines[0].unit=bomber", savedLineUnit === "bomber", String(savedLineUnit));
    await click(client, "reload-btn");
    const reloadedUnit = await waitForEval(
      client,
      `document.querySelector('[data-testid="field-lines-0-unit"]')?.value === "bomber"`,
      20000,
      "reloaded line unit",
    );
    check("重载后下拉选中 bomber", reloadedUnit === true);

    console.log("[smoke] 4.9 导入外部数据目录（.smoke-data2，预置 hp=222）");
    await click(client, "tab-units");
    let unitsBack = null;
    for (let i = 0; i < 40 && unitsBack === null; i += 1) {
      unitsBack = await ev(
        client,
        `document.querySelectorAll('[data-testid="entity-item"]').length === 21 ? true : JSON.stringify({ count: document.querySelectorAll('[data-testid="entity-item"]').length, tabUnits: document.querySelector('[data-testid="tab-units"]')?.className, banner: document.querySelector(".banner")?.textContent?.slice(0, 120), saveDisabled: document.querySelector('[data-testid="save-btn"]')?.disabled })`,
      );
      if (unitsBack === true) break;
      await sleep(500);
    }
    if (unitsBack !== true) {
      console.error(`  诊断：${String(unitsBack).slice(0, 300)}`);
      throw new Error("timeout waiting for: units items back");
    }
    const dataDir2 = path.join(root, ".smoke-data2");
    fs.rmSync(dataDir2, { recursive: true, force: true });
    fs.mkdirSync(dataDir2, { recursive: true });
    for (const name of ["units.json", "buildings.json", "rules.json"]) {
      fs.copyFileSync(path.join(dataSrc, name), path.join(dataDir2, name));
    }
    const external = JSON.parse(fs.readFileSync(path.join(dataDir2, "units.json"), "utf8"));
    external.units[0].hp = 222;
    fs.writeFileSync(path.join(dataDir2, "units.json"), JSON.stringify(external, null, 2) + "\n", "utf8");
    await setInput(client, "data-dir-input", dataDir2);
    await click(client, "dir-apply-btn");
    const externalHp = await waitForEval(
      client,
      `document.querySelector('[data-testid="field-hp"]')?.value === "222"`,
      20000,
      "external hp 222",
    );
    check("外部目录读取生效（hp=222）", externalHp === true);
    await setInput(client, "field-hp", "333");
    await click(client, "save-btn");
    let externalSaved = null;
    for (let waited = 0; waited < 60000; waited += 500) {
      const current = JSON.parse(fs.readFileSync(path.join(dataDir2, "units.json"), "utf8")).units[0].hp;
      if (current === 333) {
        externalSaved = current;
        break;
      }
      await sleep(500);
    }
    if (externalSaved === null) {
      const banner = await ev(
        client,
        `(() => { const el = document.querySelector('[data-testid="save-errors"]') || document.querySelector('[data-testid="save-ok"]'); return el ? el.textContent : "(no banner)"; })()`,
      );
      const hpValue = await ev(client, `document.querySelector('[data-testid="field-hp"]')?.value`);
      console.error(`  诊断：hp 输入框=${hpValue}，横幅=${String(banner).slice(0, 300)}`);
    }
    check("外部目录经 gate 沙盒写盘 hp=333", externalSaved === 333);
    check("gate 沙盒工程已生成（.gate-projects/）", fs.existsSync(path.join(root, ".gate-projects")));
    await click(client, "dir-reset-btn");
    const backHp = await waitForEval(
      client,
      `document.querySelector('[data-testid="field-hp"]')?.value === "210"`,
      20000,
      "default hp back",
    );
    check("恢复默认目录后 hp 回到 210", backHp === true);

    console.log("[smoke] 4.95 无框窗口最大化/还原切换（真实鼠标点击，验证命中测试）");
    await realClick(client, "win-max-btn");
    const maximizedState = await waitForEval(
      client,
      `document.querySelector('[data-testid="win-max-btn"]')?.getAttribute("data-maximized") === "true"`,
      10000,
      "maximized state",
    );
    check("真实鼠标点击最大化生效", maximizedState === true);
    await realClick(client, "win-max-btn");
    const restoredState = await waitForEval(
      client,
      `document.querySelector('[data-testid="win-max-btn"]')?.getAttribute("data-maximized") === "false"`,
      10000,
      "restored state",
    );
    check("真实鼠标再次点击还原窗口", restoredState === true);

    console.log("[smoke] 5. 截图留档");
    const shot = await client.Page.captureScreenshot({ format: "png" });
    fs.writeFileSync(path.join(artifacts, "smoke-final.png"), Buffer.from(shot.data, "base64"));
    check("截图写入 .smoke-artifacts/smoke-final.png", fs.existsSync(path.join(artifacts, "smoke-final.png")));

    console.log("[smoke] 6. store 层：无改动不写盘");
    const noOp = execSync(`node scripts/no-op-check.cjs "${sandboxUnits}"`, {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, ME_DATA_DIR: sandbox },
    });
    const noOpResult = JSON.parse(noOp.trim().split(/\r?\n/).pop());
    check("无改动返回 written=false", noOpResult.ok === true && noOpResult.written === false, noOp);
  } finally {
    if (client) {
      try {
        await client.close();
      } catch {
        /* ignore */
      }
    }
    killTree(app);
  }

  console.log(failures === 0 ? "SMOKE_OK" : `SMOKE_FAIL failures=${failures}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error("SMOKE_ERROR", err);
  process.exitCode = 1;
});
