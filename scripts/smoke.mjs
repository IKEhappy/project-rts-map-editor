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
// 数据源：优先姊妹检出（war-of-state，配置段用例的数据形态基线）；本工作区
//（them-pixel-front）无它时跳过配置段，只跑地图段（地图权威=project-rts/data/maps）。
const legacyDataSrc = path.join(root, "..", "war-of-state", "data");
const dataSrc = fs.existsSync(path.join(legacyDataSrc, "units.json")) ? legacyDataSrc : null;
const configFlow = dataSrc !== null;
const mapsSrc = path.join(root, "..", "project-rts", "data", "maps");
const sandboxMaps = path.join(sandbox, "maps");

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
    const detail = r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "";
    const at = String(detail).split("\n").slice(0, 4).join(" | ");
    throw new Error(`eval exception: ${at} <<<EXPR>>> ${expression.slice(0, 160)}`);
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

const setInput = async (client, testId, value) => {
  // 元素可能处于重载窗口（目录切换的清空/重载交错）——absent 时小退避重试
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const result = await ev(
      client,
      `(() => {
    const el = document.querySelector('[data-testid="${testId}"]');
    if (!el || !(el instanceof window.HTMLInputElement)) return "absent";
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(el, "${String(value).replace(/\\/g, "\\\\")}");
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    return "ok";
  })()`,
    );
    if (result === "ok") return;
    await sleep(300);
  }
  throw new Error(`setInput timeout: ${testId}`);
};

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

// 建筑座数从沙盒建筑表动态推导（R31）：此前的断言把 18 写死，建筑表扩到 32 后
// 「清空搜索恢复全部 18 项」在**未改动的基线上也超时**（2026-09-24 用 git stash A/B 实测确认）。
// 改为读实际数据——建筑表再扩容也不会再制造假红。
function buildingCountOf(dir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, "buildings.json"), "utf8"));
    return Array.isArray(raw.buildings) ? raw.buildings.length : 0;
  } catch {
    return 0;
  }
}

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
  if (configFlow) {
    for (const name of ["units.json", "buildings.json", "rules.json"]) {
      fs.copyFileSync(path.join(dataSrc, name), path.join(sandbox, name));
    }
  } else {
    console.log("[smoke] 配置段跳过：本工作区无 war-of-state 数据（dev-2d 数据形态差异待专项适配）");
    // 地图面板依赖的基础配置仍需就位（ME_DATA_DIR 指向沙盒）：建筑定义（占地/血量默认）+ 单位表（出生点下拉）
    const projectData = path.join(root, "..", "project-rts", "data");
    for (const name of ["units.json", "buildings.json"]) {
      fs.copyFileSync(path.join(projectData, name), path.join(sandbox, name));
    }
  }
  fs.mkdirSync(sandboxMaps, { recursive: true });
  for (const name of ["p0_corridor.json", "test_buildings_map.json"]) {
    fs.copyFileSync(path.join(mapsSrc, name), path.join(sandboxMaps, name));
  }

  console.log("[smoke] vite build");
  execSync("npx vite build", { cwd: root, stdio: "inherit" });
  await assertCdpPortFree();

  console.log("[smoke] launch electron (sandbox data dir)");
  const app = spawn("npx", ["electron", "."], {
    cwd: root,
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ME_DATA_DIR: sandbox, ME_MAPS_DIR: sandboxMaps, ME_CDP: "1", ME_CDP_PORT: "9223" },
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

    if (configFlow) {
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
      `document.querySelectorAll('[data-testid="entity-item"]').length === ${buildingCountOf(sandbox)}`,
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
      `document.querySelector('[data-testid="field-auto_attack_targets-0"]')?.getAttribute("data-value") === "turrets"`,
      20000,
      "reloaded first target",
    );
    check("重载后首元素下拉=turrets", firstTarget === true);

    console.log("[smoke] 4.7 建筑表 radar：lines.unit 固定下拉（role=summon 组，严格限定）");
    await click(client, "tab-buildings");
    await waitForEval(
      client,
      `document.querySelectorAll('[data-testid="entity-item"]').length === ${buildingCountOf(sandbox)}`,
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
      `(() => { const el = document.querySelector('[data-testid="field-lines-0-unit"]'); return el ? el.tagName + ":" + (el.hasAttribute("data-value") ? "dd" : "raw") : null; })()`,
      10000,
      "lines unit dropdown",
    );
    check("lines.unit 为自绘下拉（BUTTON+data-value）", unitTag === "BUTTON:dd", String(unitTag));
    await click(client, "field-lines-0-unit"); // 打开菜单
    const optionCount = await ev(client, `document.querySelectorAll('[data-testid^="field-lines-0-unit-opt-"]').length`);
    check("选项恰为 summon 组 5 项", optionCount === 5, `got ${optionCount}`);
    const firstOption = await ev(client, `document.querySelector('[data-testid^="field-lines-0-unit-opt-"]')?.getAttribute("data-value")`);
    check("首项为 transport", firstOption === "transport", String(firstOption));
    const optionText = await ev(client, `document.querySelector('[data-testid^="field-lines-0-unit-opt-"]')?.textContent`);
    check("选项文本含中文名", typeof optionText === "string" && optionText.includes("（"), String(optionText));
    const hasVehicle = await ev(
      client,
      `[...document.querySelectorAll('[data-testid^="field-lines-0-unit-opt-"]')].some((o) => o.getAttribute("data-value") === "flamer")`,
    );
    check("组外单位不可选（无 flamer）", hasVehicle === false);
    await click(client, "field-lines-0-unit"); // 关闭菜单

    console.log("[smoke] 4.8 lines.unit 选择变更经 gate 写盘（fighter → bomber）");
    await click(client, "field-lines-0-unit");
    await click(client, "field-lines-0-unit-opt-bomber");
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
      `document.querySelector('[data-testid="field-lines-0-unit"]')?.getAttribute("data-value") === "bomber"`,
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

    console.log("[smoke] 4.96 从模板新建实体（字段序/key 可改/右键删除/保存过 gate）");
    await click(client, "add-entity");
    await click(client, "add-entity-opt-vehicle");
    const createdCount = await waitForEval(
      client,
      `document.querySelectorAll('[data-testid="entity-item"]').length === 22`,
      10000,
      "22 items after create",
    );
    check("新实体出现在列表（22 项）", createdCount === true);
    const firstFields = await ev(
      client,
      `JSON.stringify([...document.querySelectorAll('.field-row .field-label')].slice(0, 2).map((el) => el.textContent))`,
    );
    const fields = JSON.parse(String(firstFields));
    check("新实体字段序首列为 id/key（与既有实体一致）", fields[0]?.startsWith("id") === true && fields[1]?.startsWith("key") === true, String(firstFields));
    const keyEditable = await ev(client, `document.querySelector('[data-testid="field-key"]')?.tagName === "INPUT"`);
    check("新实体 key 可编辑（INPUT）", keyEditable === true);
    await ev(
      client,
      `document.querySelectorAll('[data-testid="entity-item"]')[21].dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 300, clientY: 400 }))`,
    );
    const menuVisible = await waitForEval(client, `!!document.querySelector('[data-testid="ctx-delete"]')`, 5000, "ctx menu");
    check("右键菜单出现（删除该项）", menuVisible === true);
    await click(client, "ctx-delete");
    const backTo21 = await waitForEval(
      client,
      `document.querySelectorAll('[data-testid="entity-item"]').length === 21`,
      5000,
      "21 items after delete",
    );
    check("删除新实体回到 21 项", backTo21 === true);
    const existingLocked = await ev(client, `document.querySelector('[data-testid="field-key"]')?.tagName === "SPAN"`);
    check("既有实体 key 仍锁定（SPAN 只读）", existingLocked === true);
    await click(client, "add-entity");
    await click(client, "add-entity-opt-vehicle");
    await waitForEval(
      client,
      `document.querySelectorAll('[data-testid="entity-item"]').length === 22`,
      10000,
      "22 items again",
    );
    const newHp = await ev(client, `document.querySelector('[data-testid="field-hp"]')?.value`);
    check("新实体已选中且模板默认 hp=200", newHp === "200", String(newHp));
    await click(client, "save-btn");
    let savedCount = null;
    for (let waited = 0; waited < 45000; waited += 500) {
      const units = JSON.parse(fs.readFileSync(sandboxUnits, "utf8")).units;
      if (units.length === 22 && units[21].key === "new_vehicle_1" && units[21].id === 21) {
        savedCount = units.length;
        break;
      }
      await sleep(500);
    }
    check("模板实体经 gate 写盘（id=21, key=new_vehicle_1）", savedCount === 22);
    await click(client, "reload-btn");
    const reloadedCount = await waitForEval(
      client,
      `document.querySelectorAll('[data-testid="entity-item"]').length === 22`,
      20000,
      "22 after reload",
    );
    check("重载后仍 22 项", reloadedCount === true);
    } // configFlow 结束（无 war-of-state 数据的工作区跳过整段）

    console.log("[smoke] 4.97 地图编辑：tab / 列表 / 画布预览 / 门禁双向 / 原子写");
    await click(client, "tab-maps");
    const mapListOk = await waitForEval(
      client,
      `document.querySelectorAll('[data-testid^="map-item-"]').length >= 2`,
      20000,
      "map list items",
    );
    check("地图列表加载（沙盒 ≥2 张）", mapListOk === true);
    await click(client, "map-item-p0_corridor-json");
    const jsonCollapsedByDefault = await waitForEval(
      client,
      `!document.querySelector('[data-testid="map-json-drawer"]') && !document.querySelector('[data-testid="field-width"]')`,
      8000,
      "json collapsed by default",
    );
    check("JSON 字段树默认折叠（研发入口，悬浮按钮呼出）", jsonCollapsedByDefault === true);
    await click(client, "map-json-toggle");
    const mapFieldsOk = await waitForEval(
      client,
      `!!document.querySelector('[data-testid="field-width"]')`,
      20000,
      "map field tree",
    );
    check("悬浮按钮展开 JSON 抽屉（width 字段可见）", mapFieldsOk === true);

    console.log("[smoke] 4.972 数字步进即时生效（自绘 −/+，无需回车/失焦）");
    const clickStep = (testId) =>
      ev(
        client,
        `(() => {
    const b = document.querySelector('[data-testid="${testId}"]');
    b.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    b.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    return "ok";
  })()`,
      );
    const wBefore = await ev(client, `document.querySelector('[data-testid="field-width"]').value`);
    await clickStep("field-width-step-up");
    const wStepped = await waitForEval(
      client,
      `document.querySelector('[data-testid="field-width"]').value === String(Number("${wBefore}") + 1)`,
      3000,
      "step up",
    );
    check("步进 +1 点击即生效（文档同步，画布随动）", wStepped === true);
    await clickStep("field-width-step-down");
    const wBack = await waitForEval(
      client,
      `document.querySelector('[data-testid="field-width"]').value === "${wBefore}"`,
      3000,
      "step down",
    );
    check("步进 −1 回原值", wBack === true);
    const canvasOk = await waitForEval(
      client,
      `(() => { const c = document.querySelector('[data-testid="map-canvas"] canvas'); return c ? c.width > 0 && c.height > 0 : false; })()`,
      20000,
      "map canvas",
    );
    check("画布预览渲染（尺寸>0）", canvasOk === true);

    console.log("[smoke] 4.971 视口：滚轮缩放 + 重置视图");
    await ev(
      client,
      `(() => {
    const c = document.querySelector('[data-testid="map-canvas"] canvas');
    const rect = c.getBoundingClientRect();
    c.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: rect.left + 60, clientY: rect.top + 60, deltaY: -240 }));
    return "ok";
  })()`,
    );
    const zoomedIn = await waitForEval(
      client,
      `parseFloat(document.querySelector('[data-testid="map-canvas"] canvas').getAttribute("data-zoom")) > 1.05`,
      5000,
      "zoom in",
    );
    check("滚轮缩放生效（zoom>1，光标锚定）", zoomedIn === true);
    await click(client, "map-view-reset");
    const zoomReset = await waitForEval(
      client,
      `parseFloat(document.querySelector('[data-testid="map-canvas"] canvas').getAttribute("data-zoom")) === 1`,
      5000,
      "zoom reset",
    );
    check("重置视图回到 100%", zoomReset === true);

    const mapZh = await ev(client, `document.body.textContent.includes("地形补丁")`);
    check("地图字段中文标签生效（地形补丁）", mapZh === true);

    const mapFile = path.join(sandboxMaps, "p0_corridor.json");
    const mapHashBefore = sha(fs.readFileSync(mapFile, "utf8"));
    await setInput(client, "field-width", "0");
    await click(client, "map-save-btn");
    const mapReject = await waitForEval(
      client,
      `(() => { const el = document.querySelector('[data-testid="map-save-errors"]'); return el ? el.textContent : ""; })()`,
      45000,
      "map gate reject banner",
    );
    check("地图门禁拒绝横幅（width=0）", /正数|width/i.test(String(mapReject)), String(mapReject).slice(0, 160));
    check("地图文件未被改动", sha(fs.readFileSync(mapFile, "utf8")) === mapHashBefore);
    check("地图 .bak 未产生", !fs.existsSync(`${mapFile}.bak`));

    await setInput(client, "field-width", "16");
    await setInput(client, "field-name", "p0_corridor_smoke");
    await click(client, "map-save-btn");
    const mapOk = await waitForEval(
      client,
      `(() => { const el = document.querySelector('[data-testid="map-save-ok"]'); return el ? el.textContent : ""; })()`,
      45000,
      "map save ok banner",
    );
    check("地图保存成功横幅", /已保存/.test(String(mapOk)), String(mapOk));
    const mapSaved = JSON.parse(fs.readFileSync(mapFile, "utf8"));
    check("地图写盘 name=p0_corridor_smoke（width 恢复 16）", mapSaved.name === "p0_corridor_smoke" && mapSaved.width === 16, JSON.stringify({ name: mapSaved.name, w: mapSaved.width }));
    check("地图 .bak 备份产生", fs.existsSync(`${mapFile}.bak`));

    console.log("[smoke] 4.98 画布直编：地形笔刷 + 删除工具 + 经门禁写盘");
    const mapDocNow = JSON.parse(fs.readFileSync(mapFile, "utf8"));
    // 视口化画布：点击坐标按画布 data-ox/oy/ppc 换算（地图只占画布左上起始区域）
    const cellClientPt = (cx, cy) =>
      ev(
        client,
        `(() => {
    const c = document.querySelector('[data-testid="map-canvas"] canvas');
    const rect = c.getBoundingClientRect();
    const ppc = parseFloat(c.getAttribute("data-ppc"));
    const ox = parseFloat(c.getAttribute("data-ox"));
    const oy = parseFloat(c.getAttribute("data-oy"));
    const scale = rect.width / (parseFloat(c.getAttribute("data-css-w")) || c.width);
    return JSON.stringify({ x: rect.left + (${cx} - ox + 0.5) * ppc * scale, y: rect.top + (${cy} - oy + 0.5) * ppc * scale });
  })()`,
      );
    const clickCell = async (cx, cy) => {
      const pt = JSON.parse(await cellClientPt(cx, cy));
      await ev(
        client,
        `(() => {
    const c = document.querySelector('[data-testid="map-canvas"] canvas');
    for (const type of ["mousedown", "mouseup", "click"]) {
      c.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: ${pt.x}, clientY: ${pt.y} }));
    }
    return "ok";
  })()`,
      );
    };
    const closePops = () =>
      ev(client, `document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); "ok"`);

    const selectOption = async (testId, value) => {
      await click(client, testId);
      await waitForEval(client, `!!document.querySelector('[data-testid="${testId}-opt-${value}"]')`, 4000, `option ${value}`);
      await click(client, `${testId}-opt-${value}`);
      return "ok";
    };
    const canvasEventAt = async (cx, cy, type) => {
      const pt = JSON.parse(await cellClientPt(cx, cy));
      await ev(
        client,
        `(() => {
    const c = document.querySelector('[data-testid="map-canvas"] canvas');
    c.dispatchEvent(new MouseEvent("${type}", { bubbles: true, cancelable: true, clientX: ${pt.x}, clientY: ${pt.y} }));
    return "ok";
  })()`,
      );
    };
    await click(client, "map-tool-terrain");
    await selectOption("map-select-terrain", "4");
    await ev(client, `window.dispatchEvent(new KeyboardEvent("keydown", { key: "2", bubbles: true, cancelable: true })); "ok"`);
    const hotkeyTerrain = await waitForEval(
      client,
      `document.querySelector('[data-testid="map-select-terrain"]').getAttribute("data-value") === "2"`,
      3000,
      "hotkey terrain 2",
    );
    check("数字键 2 直切地形码（0~4）", hotkeyTerrain === true);
    await selectOption("map-select-terrain", "4");
    await clickCell(2, 2);

    console.log("[smoke] 4.981 撤销/重做（Ctrl+Z / Ctrl+Y）");
    const keyEvent = (key, extra) =>
      ev(client, `window.dispatchEvent(new KeyboardEvent("keydown", { key: "${key}", bubbles: true, cancelable: true, ${extra} })); "ok"`);
    await keyEvent("z", "ctrlKey: true");
    const undone = await waitForEval(
      client,
      `document.querySelector('[data-testid="map-save-btn"]').disabled === true`,
      5000,
      "undo clean",
    );
    check("Ctrl+Z 撤销笔刷（回到已保存态，保存钮禁用）", undone === true);
    await keyEvent("y", "ctrlKey: true");
    const redone = await waitForEval(
      client,
      `document.querySelector('[data-testid="map-save-btn"]').disabled === false`,
      5000,
      "redo dirty",
    );
    check("Ctrl+Y 重做（笔刷恢复，保存钮可用）", redone === true);

    await click(client, "map-tool-delete");
    await clickCell(0, 0); // p0_corridor 建筑占 (0,0,2,2)
    await click(client, "map-tool-box");
    await selectOption("map-select-access", "3");
    await selectOption("map-select-build", "1");
    await canvasEventAt(4, 3, "mousedown");
    await canvasEventAt(7, 5, "mousemove");
    await canvasEventAt(7, 5, "mouseup");
    await click(client, "map-save-btn");
    const canvasSaveOk = await waitForEval(
      client,
      `(() => { const el = document.querySelector('[data-testid="map-save-ok"]'); return el ? el.textContent : ""; })()`,
      45000,
      "canvas edit save ok",
    );
    check("画布编辑经门禁保存成功", /已保存/.test(String(canvasSaveOk)), String(canvasSaveOk));
    const canvasSaved = JSON.parse(fs.readFileSync(mapFile, "utf8"));
    const paintPatch = (canvasSaved.terrain_patches || []).some(
      (p) => p.x === 2 && p.y === 2 && p.w === 1 && p.h === 1 && p.terrain === 4,
    );
    check("笔刷点刷落盘（(2,2) 地形4 补丁）", paintPatch === true, JSON.stringify(canvasSaved.terrain_patches));
    check("删除工具落盘（建筑 5→4，(0,0) 座移除）", canvasSaved.buildings.length === 4 && !canvasSaved.buildings.some((b) => b.x === 0 && b.y === 0), JSON.stringify(canvasSaved.buildings.map((b) => [b.key, b.x, b.y])));
    const boxEntry = (canvasSaved.box_mode || []).find(
      (b) => b.start && b.start.w === 4 && b.start.h === 3 && b.end && b.end.w === 7 && b.end.h === 5 && b.access === 3 && b.build === 1,
    );
    check("box 画框拖拽落盘（(4,3)-(7,5) access3/build1）", boxEntry !== undefined, JSON.stringify(canvasSaved.box_mode));

    console.log("[smoke] 4.985 box 覆盖语义：新配置刷过旧范围 = 覆盖（每格唯一归属）");
    await click(client, "map-tool-box");
    const buildBefore = await ev(client, `document.querySelector('[data-testid="map-select-build"]').getAttribute("data-value")`);
    await ev(client, `window.dispatchEvent(new KeyboardEvent("keydown", { key: "b", bubbles: true, cancelable: true })); "ok"`);
    const buildToggled = await waitForEval(
      client,
      `document.querySelector('[data-testid="map-select-build"]').getAttribute("data-value") !== "${buildBefore}"`,
      3000,
      "hotkey build toggle",
    );
    check("B 键切换禁建维度", buildToggled === true);
    await ev(client, `window.dispatchEvent(new KeyboardEvent("keydown", { key: "b", bubbles: true, cancelable: true })); "ok"`);
    await waitForEval(
      client,
      `document.querySelector('[data-testid="map-select-build"]').getAttribute("data-value") === "${buildBefore}"`,
      3000,
      "hotkey build back",
    );
    await selectOption("map-select-access", "1");
    await canvasEventAt(6, 4, "mousedown");
    await canvasEventAt(9, 6, "mousemove");
    await canvasEventAt(9, 6, "mouseup");
    await click(client, "map-save-btn");
    await waitForEval(
      client,
      `(() => { const el = document.querySelector('[data-testid="map-save-ok"]'); return el ? el.textContent : ""; })()`,
      45000,
      "overwrite save ok",
    );
    const overwritten = JSON.parse(fs.readFileSync(mapFile, "utf8"));
    const cellOwner = (cx, cy) =>
      (overwritten.box_mode || []).filter(
        (b) => cx >= b.start.w && cy >= b.start.h && cx <= b.end.w && cy <= b.end.h,
      );
    const overlapOwners = cellOwner(6, 4);
    check(
      "重叠格归属唯一（(6,4) 只属一个条目）且为新配置 access=1",
      overlapOwners.length === 1 && overlapOwners[0].access === 1,
      JSON.stringify(overlapOwners),
    );
    const oldKept = cellOwner(4, 3);
    check("旧条目保留未重叠部分（(4,3) 仍属 access=3 条目）", oldKept.length === 1 && oldKept[0].access === 3, JSON.stringify(oldKept));
    const newEntry = (overwritten.box_mode || []).find((b) => b.start.w === 6 && b.start.h === 4 && b.end.w === 9 && b.end.h === 6);
    check("新条目完整落盘（(6,4)-(9,6) access1）", newEntry !== undefined && newEntry.access === 1, JSON.stringify(overwritten.box_mode));

    console.log("[smoke] 4.99 地图重载 + 关闭三选弹窗");
    await setInput(client, "field-name", "should_be_discarded");
    await ev(client, `window.confirm = () => true; "ok"`);
    await click(client, "map-reload-doc-btn");
    const reloadedName = await waitForEval(
      client,
      `document.querySelector('[data-testid="field-name"]')?.value === "p0_corridor_smoke"`,
      10000,
      "reloaded name",
    );
    check("重新加载丢弃未保存编辑（name 回到已存值）", reloadedName === true);
    const reloadClean = await ev(client, `document.querySelector('[data-testid="map-save-btn"]').disabled === true`);
    check("重载后无脏（保存钮禁用）", reloadClean === true);

    await setInput(client, "field-name", "dirty_for_close_test");
    await click(client, "win-close-btn");
    const modalShown = await waitForEval(client, `!!document.querySelector('[data-testid="close-modal"]')`, 5000, "close modal");
    check("关闭时未保存 → 三选弹窗出现", modalShown === true);
    await click(client, "close-cancel-btn");
    const modalGone = await waitForEval(client, `!document.querySelector('[data-testid="close-modal"]')`, 5000, "modal closed");
    check("「继续编辑」关弹窗留在工具", modalGone === true);

    await click(client, "map-json-toggle");
    const jsonRecollapsed = await waitForEval(
      client,
      `!document.querySelector('[data-testid="map-json-drawer"]') && !document.querySelector('[data-testid="field-width"]')`,
      5000,
      "json recollapsed",
    );
    check("再次点击悬浮按钮折叠 JSON（回到纯地图视图）", jsonRecollapsed === true);

    console.log("[smoke] 4.995 新建地图：尺寸修改即时同步画布");
    await click(client, "map-new-btn");
    await waitForEval(client, `!!document.querySelector('[data-testid="map-item-new"]')`, 5000, "new map item");
    const ppc48 = await waitForEval(
      client,
      `document.querySelector('[data-testid="map-canvas"] canvas').getAttribute("data-ppc") === "10.00"`,
      8000,
      "skeleton ppc (48 wide → baseCell 10)",
    );
    check("新建骨架图 48×32（baseCell=10px/格）", ppc48 === true);
    await click(client, "map-json-toggle");
    await waitForEval(client, `!!document.querySelector('[data-testid="field-width"]')`, 5000, "drawer for new map");
    await setInput(client, "field-width", "64");
    const ppc64 = await waitForEval(
      client,
      `document.querySelector('[data-testid="map-canvas"] canvas').getAttribute("data-ppc") === "7.00"`,
      8000,
      "width 64 → baseCell 7",
    );
    check("width 48→64 画布即时同步（baseCell 10→7px/格）", ppc64 === true);
    const widthShown = await ev(client, `document.querySelector('[data-testid="field-width"]').value`);
    check("字段值已改 64", widthShown === "64", String(widthShown));

    console.log(`[smoke] 4.9955 下拉搜索（建筑 ${buildingCountOf(sandbox)} 项 → 搜 tank 得 6 项 tank_*）`);
    await click(client, "map-tool-building");
    await click(client, "map-select-building");
    const searchShown = await waitForEval(client, `!!document.querySelector('[data-testid="map-select-building-search"]')`, 4000, "search input");
    check("超阈值下拉自动显示搜索框（>8 项）", searchShown === true);
    await ev(
      client,
      `(() => {
    const el = document.querySelector('[data-testid="map-select-building-search"]');
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    set.call(el, "tank");
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return "ok";
  })()`,
    );
    const searchVisible = await waitForEval(
      client,
      `[...document.querySelectorAll('[data-testid^="map-select-building-opt-"]')].filter((o) => o.offsetParent !== null).length === 6`,
      4000,
      "filtered to 6",
    );
    const searchAllTank = await ev(
      client,
      `[...document.querySelectorAll('[data-testid^="map-select-building-opt-"]')].filter((o) => o.offsetParent !== null).every((o) => o.textContent.includes("tank"))`,
    );
    check("搜索 tank 过滤出 6 个 tank_* 且无杂项", searchVisible === true && searchAllTank === true);
    await ev(
      client,
      `(() => {
    const el = document.querySelector('[data-testid="map-select-building-search"]');
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    set.call(el, "");
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return "ok";
  })()`,
    );
    const searchCleared = await waitForEval(
      client,
      `[...document.querySelectorAll('[data-testid^="map-select-building-opt-"]')].filter((o) => o.offsetParent !== null).length === ${buildingCountOf(sandbox)}`,
      4000,
      "restored all buildings",
    );
    check(`清空搜索恢复全部建筑项（${buildingCountOf(sandbox)} 座）`, searchCleared === true);
    await click(client, "map-select-building"); // 关闭菜单

    console.log("[smoke] 4.996 建筑放置占地（裁定表 hq=4×4）+ 右键调参菜单跳转");
    await click(client, "map-tool-building");
    await selectOption("map-select-building", "hq");
    await clickCell(2, 2);
    const placedW = await waitForEval(
      client,
      `document.querySelector('[data-testid="field-buildings-0-w"]')?.value === "4"`,
      5000,
      "placed w",
    );
    check("放置 hq 占地 4×4（裁定表）", placedW === true);
    const placedH = await ev(client, `document.querySelector('[data-testid="field-buildings-0-h"]')?.value`);
    check("放置 hq 高 4", placedH === "4", String(placedH));
    const ctxPt = JSON.parse(await cellClientPt(2, 2));
    const ctxEvent = (cx, cy) =>
      ev(
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
    c.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: px, clientY: py }));
    return "ok";
  })()`,
      );
    // R16：工具激活时右键=取消工具回预览（不得触发调参菜单）
    await ctxEvent(2, 2);
    const toolCancelled = await waitForEval(
      client,
      `document.querySelector('[data-testid="map-tool-none"]').classList.contains("active")`,
      3000,
      "right-click cancels tool",
    );
    check("右键取消当前工具回预览（画布光标还原）", toolCancelled === true);
    const noMenuWhileTool = await ev(client, `!document.querySelector('[data-testid="building-ctx-menu"]')`);
    check("工具态右键不出调参菜单", noMenuWhileTool === true);
    // 预览态右键命中建筑 → 调参菜单（R14 行为保留）
    await ctxEvent(2, 2);
    const menuShown = await waitForEval(client, `!!document.querySelector('[data-testid="building-ctx-menu"]')`, 4000, "ctx menu");
    check("右键建筑弹出调参菜单（仅本图调参提示）", menuShown === true);
    await click(client, "ctx-field-level");
    const levelField = await waitForEval(
      client,
      `!!document.querySelector('[data-testid="field-buildings-0-level"]')`,
      4000,
      "level field",
    );
    check("菜单点「等级」自动创建字段并跳转 JSON", levelField === true);
    const levelVal = await ev(client, `document.querySelector('[data-testid="field-buildings-0-level"]')?.value`);
    check("level 新建默认 1", levelVal === "1", String(levelVal));

    console.log("[smoke] 4.9965 备注图例 / 占位防重叠 / 出生点右键菜单 / 菜单外点关闭");
    // R31：图例默认折叠（把垂直空间还给画布）——先展开再断言颜色含义，覆盖面不变
    await click(client, "map-notes-toggle");
    const notesOk = await waitForEval(
      client,
      `(() => { const t = document.querySelector('[data-testid="map-notes"]')?.textContent ?? ""; return (t.includes("红=禁建") && t.includes("黄=仅禁地面") && t.includes("蓝=仅禁飞碟") && t.includes("红=禁所有单位")) ? JSON.stringify({ frame: true, x: true }) : false; })()`,
      5000,
      "notes legend expanded",
    ).catch(() => "{}");
    const notes = JSON.parse(notesOk);
    check("备注条含框/X 颜色含义图例（展开后）", notes.frame === true && notes.x === true, notesOk);

    // 占位防重叠：空格 (1,1) 的 hq 足迹(1..4)与已放 hq(2..5) 重叠 → 拒绝 + 数量不变
    // （R22 后点上已有建筑=移动，放置重叠须从空白格触发）
    await click(client, "map-tool-building");
    await clickCell(1, 1);
    const overlapRejected = await waitForEval(
      client,
      `(() => { const el = document.querySelector('[data-testid="map-save-errors"]'); return el ? el.textContent : ""; })()`,
      5000,
      "overlap banner",
    );
    const bCount = await ev(client, `document.querySelectorAll('[data-testid^="field-buildings-"][data-testid$="-key"]').length`);
    check("建筑重叠放置被拒（横幅提示，条目数仍 1）", /重叠/.test(String(overlapRejected)) && bCount === 1, `${overlapRejected} count=${bCount}`);

    // 出生点放置 → 预览态右键 → 调参菜单 → 单位字段跳转
    await click(client, "map-tool-spawn");
    await clickCell(10, 8);
    await click(client, "map-tool-none");
    const spawnPt = JSON.parse(await cellClientPt(10, 8));
    const ctxAt = (pt) =>
      ev(
        client,
        `(() => {
    const c = document.querySelector('[data-testid="map-canvas"] canvas');
    c.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: ${pt.x}, clientY: ${pt.y} }));
    return "ok";
  })()`,
      );
    await ctxAt(spawnPt);
    const spawnMenu = await waitForEval(client, `!!document.querySelector('[data-testid="spawn-ctx-menu"]')`, 4000, "spawn menu");
    check("右键出生点弹出调参菜单", spawnMenu === true);
    await click(client, "spawn-ctx-kind");
    const spawnKindField = await waitForEval(client, `!!document.querySelector('[data-testid="field-spawns-0-kind"]')`, 4000, "spawn kind field");
    check("菜单点「单位」跳转 JSON（spawns-0-kind 可见）", spawnKindField === true);

    // 菜单外点关闭：重开菜单 → 外部 pointerdown → 消失
    await ctxAt(spawnPt);
    await waitForEval(client, `!!document.querySelector('[data-testid="spawn-ctx-menu"]')`, 4000, "menu reopen");
    await closePops();
    const menuClosed = await waitForEval(client, `!document.querySelector('[data-testid="spawn-ctx-menu"]')`, 4000, "menu closed by outside click");
    check("左键点击其他地方菜单正常消失", menuClosed === true);

    console.log("[smoke] 4.9966 预览点按选中切模式 + 拖动移动对象");
    // R28：预览点击仅选中不切工具（防建筑幽灵误触）
    await clickCell(3, 3);
    await sleep(300);
    const stillPreview = await ev(client, `document.querySelector('[data-testid="map-tool-none"]').classList.contains("active")`);
    check("预览点按建筑 → 仅选中不切工具（R28 防误触裁定）", stillPreview === true);
    // 切移动·单位模式 → 拖动建筑从 (3,3) 到 (8,10) → 锚点 = 8-1, 10-1 = (7,9)
    await click(client, "map-tool-move-unit");
    await canvasEventAt(3, 3, "mousedown");
    await canvasEventAt(8, 10, "mousemove");
    await canvasEventAt(8, 10, "mouseup");
    const movedX = await waitForEval(
      client,
      `document.querySelector('[data-testid="field-buildings-0-x"]')?.value === "7"`,
      5000,
      "building moved x",
    );
    const movedY = await ev(client, `document.querySelector('[data-testid="field-buildings-0-y"]')?.value`);
    check("拖动移动建筑落盘 doc（锚点 7,9）", movedX === true && movedY === "9", `x=${movedX} y=${movedY}`);
    // R28：移动·单位模式下拖出生点 (10,8) → (12,12)
    await canvasEventAt(10, 8, "mousedown");
    await canvasEventAt(12, 12, "mousemove");
    await canvasEventAt(12, 12, "mouseup");
    const spawnMoved = await waitForEval(
      client,
      `document.querySelector('[data-testid="field-spawns-0-x"]')?.value === "12"`,
      5000,
      "spawn moved",
    );
    const spawnMovedY = await ev(client, `document.querySelector('[data-testid="field-spawns-0-y"]')?.value`);
    check("拖动移动出生点（12,12）", spawnMoved === true && spawnMovedY === "12", `y=${spawnMovedY}`);
    await click(client, "map-tool-none");

    console.log("[smoke] 4.9968 地图级产线编辑（右键菜单→字段创建→添加行）");
    // 预览右键 hq（4.9966 已移到 (7,9) 4×4 → 点 (8,10) 命中）
    await click(client, "map-tool-none");
    const hqPt = JSON.parse(await cellClientPt(8, 10));
    await ev(
      client,
      `(() => {
    const c = document.querySelector('[data-testid="map-canvas"] canvas');
    c.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: ${hqPt.x}, clientY: ${hqPt.y} }));
    return "ok";
  })()`,
    );
    await waitForEval(client, `!!document.querySelector('[data-testid="building-ctx-menu"]')`, 4000, "menu");
    const hasLines = await ev(client, `!!document.querySelector('[data-testid="ctx-field-lines"]') && !!document.querySelector('[data-testid="ctx-field-unlocked"]')`);
    check("右键菜单含「产线 lines」与「解锁线数 unlocked_lines」", hasLines === true);
    await click(client, "ctx-field-lines");
    const linesField = await waitForEval(
      client,
      `(() => { const rows = [...document.querySelectorAll('.field-row')]; return rows.some((r) => r.textContent.includes("lines") && r.querySelector('.mini.add')); })()`,
      4000,
      "lines field row",
    );
    check("点「产线」自动创建 lines 数组并定位（军规：只改地图不改 buildings.json）", linesField === true);
    // 字段树里点 lines 数组的「＋ 添加」加一行产线（从含 lines 字样的行找 tree-node）
    await ev(
      client,
      `(() => {
    const rows = [...document.querySelectorAll('.field-row')];
    const linesRow = rows.find((r) => r.textContent.includes("lines") && r.textContent.includes("项"));
    const node = linesRow ? linesRow.closest('.tree-node') ?? linesRow : null;
    const btn = node ? node.querySelector('.mini.add') : null;
    if (btn) { btn.click(); return "clicked"; }
    return "no-btn: " + (node ? "node-ok" : "no-node");
  })()`,
    ).then((r) => console.log(`    [4.9968 添加按钮] ${r}`));
    await sleep(400);
    const lineRow = await waitForEval(
      client,
      `(() => {
    const rows = [...document.querySelectorAll('.field-row')];
    return rows.some((r) => r.textContent.includes("lines-0") || (r.textContent.includes("#0") && r.textContent.includes("unit")));
  })() || [...document.querySelectorAll('[data-testid^="field-buildings-0-lines-0"]')].length > 0`,
      4000,
      "line row",
    );
    check("lines 数组「＋ 添加」出一行产线（可继续编辑 unit 等）", lineRow === true);

    console.log("[smoke] 4.997 新建图改名保存全链路（防撞默认名 + 中文文件名）");
    const targetShown = await waitForEval(
      client,
      `document.querySelector('[data-testid="json-target-name"]')?.textContent.includes("new_map_1.json")`,
      4000,
      "target name preview",
    );
    check("抽屉头实时显示落盘文件名（new_map_1.json）", targetShown === true);
    await click(client, "map-save-btn");
    const created1 = await waitForEval(
      client,
      `(() => { const el = document.querySelector('[data-testid="map-save-ok"]'); return el ? el.textContent : ""; })()`,
      45000,
      "create new_map_1",
    );
    check("新图保存成功（new_map_1.json 创建）", /已保存/.test(String(created1)) && fs.existsSync(path.join(sandboxMaps, "new_map_1.json")), String(created1));
    await click(client, "map-new-btn");
    await sleep(400);
    const secondName = await waitForEval(
      client,
      `document.querySelector('[data-testid="json-target-name"]')?.textContent.includes("new_map_2.json")`,
      5000,
      "second default name skips collision",
    );
    check("第二张新图默认名防撞（new_map_2）", secondName === true);
    await setInput(client, "field-name", "测试图");
    const targetZh = await waitForEval(
      client,
      `document.querySelector('[data-testid="json-target-name"]')?.textContent.includes("测试图.json")`,
      4000,
      "chinese target name",
    );
    check("中文图名保留（落盘名 测试图.json）", targetZh === true);
    await click(client, "map-save-btn");
    const createdZh = await waitForEval(
      client,
      `(() => { const el = document.querySelector('[data-testid="map-save-ok"]'); return el ? el.textContent : ""; })()`,
      45000,
      "create chinese map",
    );
    check("中文图经门禁落盘（测试图.json）", /已保存/.test(String(createdZh)) && fs.existsSync(path.join(sandboxMaps, "测试图.json")), String(createdZh));

    console.log("[smoke] 4.998 一键地图边界 + 拖拽超界跟随 + 列表右键菜单/重命名");
    await click(client, "map-border-btn");
    await sleep(300);
    const borderCount = await ev(
      client,
      `document.querySelectorAll('[data-testid^="field-box_mode-"][data-testid$="-access"]').length`,
    );
    check("一键边界生成四条 box", borderCount === 4, String(borderCount));
    const cornerOwner = await ev(
      client,
      `(() => {
    const doc = null;
    const accesses = [...document.querySelectorAll('[data-testid^="field-box_mode-"][data-testid$="-access"]')].map((el) => el.value || el.getAttribute("data-value"));
    const builds = [...document.querySelectorAll('[data-testid^="field-box_mode-"][data-testid$="-build"]')].map((el) => el.value || el.getAttribute("data-value"));
    return JSON.stringify({ accesses, builds });
  })()`,
    );
    const borderVals = JSON.parse(cornerOwner);
    check("边界 box 全为 禁通行(3)+禁建(1)", borderVals.accesses.every((v) => String(v) === "3") && borderVals.builds.every((v) => String(v) === "1"), cornerOwner);

    // 拖拽超界跟随：从 (10,5) 拖到图外 raw(80,5) 松手 → 落点钳制到右边界 63
    await click(client, "map-tool-box");
    await canvasEventAt(10, 5, "mousedown");
    await canvasEventAt(80, 5, "mousemove");
    await canvasEventAt(80, 5, "mouseup");
    await sleep(300);
    const lastEndW = await ev(
      client,
      `(() => {
    const els = [...document.querySelectorAll('[data-testid^="field-box_mode-"][data-testid$="-end-w"]')];
    return els.length > 0 ? els[els.length - 1].value : "none";
  })()`,
    );
    check("超界拖拽跟随并钳制（测试图 48 宽 → end.w=47）", lastEndW === "47", String(lastEndW));
    await click(client, "map-tool-none");

    // 列表右键：菜单项齐全（不点打开类，避免冒烟弹资源管理器）
    await ev(
      client,
      `(() => {
    const el = document.querySelector('[data-testid="map-item-p0_corridor-json"]');
    el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 220, clientY: 300 }));
    return "ok";
  })()`,
    );
    const listMenuOk = await waitForEval(client, `!!document.querySelector('[data-testid="list-ctx-menu"]')`, 4000, "list menu");
    check("文件列表右键弹出菜单", listMenuOk === true);
    const menuItems = await ev(
      client,
      `["list-ctx-rename", "list-ctx-open-file", "list-ctx-open-folder"].every((id) => !!document.querySelector('[data-testid="' + id + '"]'))`,
    );
    check("菜单含 重命名/打开文件/打开文件夹", menuItems === true);
    await click(client, "list-ctx-rename");
    const renameModalOk = await waitForEval(client, `!!document.querySelector('[data-testid="rename-modal"]')`, 4000, "rename modal");
    check("重命名弹窗出现（预填原名）", renameModalOk === true);
    const renameDefault = await ev(client, `document.querySelector('[data-testid="rename-input"]')?.value`);
    check("预填文件名不含扩展名", renameDefault === "p0_corridor", String(renameDefault));
    await setInput(client, "rename-input", "renamed_map");
    // setInput 自带回车提交（模态输入框 onKeyDown Enter → doRename）；改名后重开选择器断言
    await waitForEval(client, `!!document.querySelector('[data-testid="map-item-renamed_map-json"]')`, 8000, "renamed item in list");
    check("文件已重命名（列表出现 renamed_map.json）", fs.existsSync(path.join(sandboxMaps, "renamed_map.json")) && !fs.existsSync(path.join(sandboxMaps, "p0_corridor.json")));

    console.log("[smoke] 4.999 Ctrl+S：地图页存当前打开的地图 / 无改动反馈");
    await waitForEval(client, `!!document.querySelector('[data-testid="map-item-renamed_map-json"]')`, 6000, "renamed item visible");
    await click(client, "map-item-renamed_map-json");
    await sleep(600);
    await waitForEval(client, `document.querySelector('[data-testid="field-name"]')?.value === "dirty_for_close_test"`, 8000, "switch to renamed_map（含 4.99 遗留的未保存编辑——重命名按设计保留）");
    const savedBefore = JSON.parse(fs.readFileSync(path.join(sandboxMaps, "renamed_map.json"), "utf8"));
    await setInput(client, "field-name", "renamed_map_ctrls");
    await ev(client, `window.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, cancelable: true })); "ok"`);
    const ctrlSaveOk = await waitForEval(
      client,
      `(() => { const el = document.querySelector('[data-testid="map-save-ok"]'); return el ? el.textContent : ""; })()`,
      45000,
      "ctrl+s map save",
    );
    check("地图页 Ctrl+S 保存当前地图（横幅+落盘 name=renamed_map_ctrls）",
      /已保存/.test(String(ctrlSaveOk)) && JSON.parse(fs.readFileSync(path.join(sandboxMaps, "renamed_map.json"), "utf8")).name === "renamed_map_ctrls",
      String(ctrlSaveOk));
    await ev(client, `window.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, cancelable: true })); "ok"`);
    const ctrlSaveNoop = await waitForEval(
      client,
      `(() => { const el = document.querySelector('[data-testid="map-save-ok"]'); return el ? el.textContent : ""; })()`,
      8000,
      "ctrl+s no-op banner",
    );
    check("无改动 Ctrl+S 有反馈（未写盘横幅）", /无改动/.test(String(ctrlSaveNoop)), String(ctrlSaveNoop));
    void savedBefore;

    console.log("[smoke] 5. 截图留档（地图面板）");
    const shot = await client.Page.captureScreenshot({ format: "png" });
    fs.writeFileSync(path.join(artifacts, "smoke-final.png"), Buffer.from(shot.data, "base64"));
    check("截图写入 .smoke-artifacts/smoke-final.png", fs.existsSync(path.join(artifacts, "smoke-final.png")));

    console.log("[smoke] 6. store 层：无改动不写盘");
    if (configFlow) {
      const noOp = execSync(`node scripts/no-op-check.cjs "${sandboxUnits}"`, {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, ME_DATA_DIR: sandbox },
      });
      const noOpResult = JSON.parse(noOp.trim().split(/\r?\n/).pop());
      check("无改动返回 written=false", noOpResult.ok === true && noOpResult.written === false, noOp);
    }
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
