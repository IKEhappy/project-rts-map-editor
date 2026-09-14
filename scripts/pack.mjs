// T-164 R3 打包：产出可移植成品 release/WosMapEditor-win64/（纯净 Win x64 环境可直接运行）。
// 内置全部运行依赖：Electron 运行时（node_modules/electron/dist）、Godot 4.7.2 双 exe
// （console 启动器 + 主程序——spawn 输出捕获依赖 console 版）、gate 工程子集
// （project.godot 精简版 + src + data，打包时 --import 生成 class_name 解析缓存）。
// 零新增 npm 依赖；zip 用 PowerShell Compress-Archive（--zip 开启）。
// 用法：node scripts/pack.mjs [--zip] [--no-verify]
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import CDP from "chrome-remote-interface";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repo = path.resolve(root, "..");
const gameDir = process.env.ME_GAME_DIR || path.join(repo, "war-of-state");
const godotDir = process.env.GODOT_DIR || "D:\\envir\\GodotEngine";
const GODOT_CONSOLE = "Godot_v4.7.2-stable_win64_console.exe";
const GODOT_MAIN = "Godot_v4.7.2-stable_win64.exe";
const outDir = path.join(root, "release", "WosMapEditor-win64");
const VERIFY_PORT = 9224;

const doZip = process.argv.includes("--zip");
const noVerify = process.argv.includes("--no-verify");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha = (text) => crypto.createHash("sha256").update(text, "utf8").digest("hex");

function requireFile(file, what) {
  if (!existsSync(file)) {
    console.error(`缺少 ${what}：${file}`);
    process.exit(1);
  }
}

console.log("[pack] 1/7 vite build 渲染层");
execSync("npx vite build", { cwd: root, stdio: "inherit" });

console.log("[pack] 2/7 清空输出目录");
// Windows 目录占用防御（2026-09-14 两次实测踩坑）：
// ① 先杀残留成品进程；② 整轮重试约 1 分钟——杀毒/索引对新写入 exe 的扫描会短暂锁定文件；
// ③ default_app.asar 单独容忍：Electron 兜底演示应用（resources/app 存在时无用，electron-builder
//    产物也不含它），曾被系统侧进程长期锁定；本包不复制它，清不掉就跳过。
try {
  execSync("taskkill /IM WosMapEditor.exe /T /F", { stdio: "ignore" });
  console.log("  已结束残留的 WosMapEditor 进程");
} catch {
  /* 无残留进程，正常 */
}
const STALE_TOLERATED = new Set(["default_app.asar"]);
function listRemaining(dir) {
  const names = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else names.push(path.relative(dir, full));
    }
  };
  if (existsSync(dir)) walk(dir);
  return names;
}
async function cleanupOutDir() {
  // 逐文件容忍式清理（2026-09-14 定位）：node rmSync 递归删除遇单个锁定文件会整批中止，
  // 未尝试的文件会被误报为"被锁"——必须逐文件删、真锁的跳过（多为杀毒/索引扫描新 exe 的
  // 瞬时锁，实测数分钟内自动释放；default_app.asar 曾被长锁，已在 STALE_TOLERATED）。
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const failedFiles = [];
    if (existsSync(outDir)) {
      const files = [];
      const dirs = [];
      const walk = (current) => {
        for (const entry of readdirSync(current, { withFileTypes: true })) {
          const full = path.join(current, entry.name);
          if (entry.isDirectory()) {
            walk(full);
            dirs.push(full);
          } else {
            files.push(full);
          }
        }
      };
      walk(outDir);
      for (const file of files) {
        try {
          rmSync(file, { force: true, maxRetries: 2, retryDelay: 200 });
        } catch {
          failedFiles.push(path.relative(outDir, file));
        }
      }
      for (const dir of dirs.reverse()) {
        try {
          rmSync(dir, { force: true });
        } catch {
          /* 目录非空或被锁（含残留锁定文件），留在原地 */
        }
      }
      try {
        rmSync(outDir, { force: true });
      } catch {
        /* 同上 */
      }
    }
    const blocking = failedFiles.filter((name) => !STALE_TOLERATED.has(path.basename(name)));
    if (blocking.length === 0) return { ok: true, tolerated: failedFiles };
    if (attempt < 3) {
      console.log(`  第 ${attempt} 次清理余 ${blocking.length} 个锁定文件（多为杀毒扫描瞬时锁，数分钟内自动释放），15 秒后重试…`);
      await sleep(15000);
    } else {
      return { ok: false, blocking };
    }
  }
  return { ok: false, blocking: [] };
}
const cleanup = await cleanupOutDir();
if (!cleanup.ok) {
  console.error(
    [
      `清空输出目录失败：${outDir}`,
      `被锁定且不可跳过的文件（前 10 个）：${cleanup.blocking.slice(0, 10).join(", ")}${cleanup.blocking.length > 10 ? " …" : ""}`,
      "常见占用来源：成品在运行（taskkill /IM WosMapEditor.exe /T /F 或任务管理器结束）、资源管理器开着该目录、杀毒软件扫描中（稍等重试）",
    ].join("\n"),
  );
  process.exit(1);
}
if (cleanup.tolerated.length > 0) {
  console.log(`  警告：${cleanup.tolerated.join(", ")} 被其他进程锁定，跳过清理（不影响成品）`);
}
mkdirSync(outDir, { recursive: true });

console.log("[pack] 3/7 复制 Electron 运行时并改名主程序");
const electronDist = path.join(root, "node_modules", "electron", "dist");
requireFile(path.join(electronDist, "electron.exe"), "Electron 运行时（node_modules/electron/dist）");
cpSync(electronDist, outDir, {
  recursive: true,
  // default_app.asar 为 Electron 兜底演示应用，resources/app 存在时无用且易被系统进程锁定
  filter: (source) => path.basename(source) !== "default_app.asar",
});
renameSync(path.join(outDir, "electron.exe"), path.join(outDir, "WosMapEditor.exe"));

console.log("[pack] 4/7 组装应用 payload → resources/app");
const resDir = path.join(outDir, "resources");
const appDir = path.join(resDir, "app");
mkdirSync(appDir, { recursive: true });
writeFileSync(
  path.join(appDir, "package.json"),
  JSON.stringify(
    {
      name: "wos-map-editor",
      version: "0.1.0",
      private: true,
      description: "WarOfState-Remake 外置数据工具（打包版）",
      main: "src/main/main.cjs",
    },
    null,
    2,
  ),
);
cpSync(path.join(root, "src", "main"), path.join(appDir, "src", "main"), { recursive: true });
cpSync(path.join(root, "src", "preload"), path.join(appDir, "src", "preload"), { recursive: true });
cpSync(path.join(root, "dist"), path.join(appDir, "dist"), { recursive: true });
cpSync(path.join(root, "gate"), path.join(appDir, "gate"), { recursive: true });
copyFileSync(path.join(root, "labels.json"), path.join(appDir, "labels.json"));

console.log("[pack] 5/7 gate 工程子集 → resources/war-of-state");
const lite = path.join(resDir, "war-of-state");
mkdirSync(lite, { recursive: true });
// 精简 project.godot：gate 只需类解析与 res:// 访问，剥掉 autoload/main_scene/editor_plugins
writeFileSync(
  path.join(lite, "project.godot"),
  [
    "; WosMapEditor 打包用 Godot 工程子集（仅供 config_gate.gd 校验，勿用于跑游戏）",
    "config_version=5",
    "",
    "[application]",
    "",
    'config/name="wos-gate"',
    "",
  ].join("\n"),
);
cpSync(path.join(gameDir, "src"), path.join(lite, "src"), { recursive: true });
cpSync(path.join(gameDir, "data"), path.join(lite, "data"), {
  recursive: true,
  // 剔除会话安全钩子的状态文件（不应进入成品）
  filter: (source) => !source.split(path.sep).includes(".mimosa"),
});

console.log("[pack] 6/7 内置 Godot 4.7.2（console 启动器 + 主程序）");
const godotOut = path.join(resDir, "godot");
mkdirSync(godotOut, { recursive: true });
for (const name of [GODOT_CONSOLE, GODOT_MAIN]) {
  const source = path.join(godotDir, name);
  requireFile(source, `Godot 可执行（${name}）`);
  copyFileSync(source, path.join(godotOut, name));
}

console.log("[pack] 7/7 生成 class_name 解析缓存（--import）+ gate 自检");
const consoleExe = path.join(godotOut, GODOT_CONSOLE);
execSync(`"${consoleExe}" --headless --path "${lite}" --import`, { stdio: "inherit", timeout: 300000 });
const gateSelfCheck = execSync(
  `"${consoleExe}" --headless --path "${lite}" --script "${path.join(appDir, "gate", "config_gate.gd")}" -- lint-project`,
  { encoding: "utf8", timeout: 120000 },
);
const gateLine = gateSelfCheck.split(/\r?\n/).find((line) => line.startsWith("GATE_RESULT "));
if (!gateLine || !JSON.parse(gateLine.slice("GATE_RESULT ".length)).ok) {
  console.error(`gate 自检失败：${gateLine}`);
  process.exit(1);
}
console.log("  gate 自检通过");

if (!noVerify) {
  console.log("[pack-verify] 启动打包成品（CDP " + VERIFY_PORT + "）做冒烟");
  const packagedUnits = path.join(lite, "data", "units.json");
  const hashBefore = sha(readFileSync(packagedUnits, "utf8"));
  const child = spawn(path.join(outDir, "WosMapEditor.exe"), [], {
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, ME_CDP: "1", ME_CDP_PORT: String(VERIFY_PORT) },
  });
  child.stderr.on("data", (chunk) => process.stderr.write(`[pkg:err] ${chunk}`));
  let failures = 0;
  const check = (name, cond, detail = "") => {
    if (cond) console.log(`  ok: ${name}`);
    else {
      failures += 1;
      console.error(`  FAIL: ${name} ${detail}`);
    }
  };
  try {
    let page = null;
    for (let i = 0; i < 60 && !page; i += 1) {
      try {
        const targets = await fetch(`http://127.0.0.1:${VERIFY_PORT}/json/list`).then((r) => r.json());
        page = targets.find((t) => t.type === "page");
      } catch {
        /* retry */
      }
      if (!page) await sleep(500);
    }
    if (!page) throw new Error("打包成品 CDP 未就绪");
    const client = await CDP({ target: page.webSocketDebuggerUrl, port: VERIFY_PORT });
    await client.Runtime.enable();
    const ev = async (expression) => {
      const r = await client.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
      return r.result.value;
    };
    for (let i = 0; i < 40; i += 1) {
      if ((await ev(`document.querySelectorAll('[data-testid="entity-item"]').length`)) === 21) break;
      await sleep(500);
    }
    check("打包成品加载 21 个单位", (await ev(`document.querySelectorAll('[data-testid="entity-item"]').length`)) === 21);
    await ev(
      `(() => { const el = document.querySelector('[data-testid="field-hp"]'); const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set; setter.call(el, "-5"); el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); })()`,
    );
    await ev(`document.querySelector('[data-testid="save-btn"]').click()`);
    let rejected = false;
    for (let i = 0; i < 90 && !rejected; i += 1) {
      await sleep(500);
      rejected = await ev(`!!document.querySelector('[data-testid="save-errors"]')`);
    }
    check("内置 Godot gate 拒绝非法保存", rejected === true);
    check(
      "包内数据文件未被改动",
      sha(readFileSync(packagedUnits, "utf8")) === hashBefore,
    );
    await client.Page.enable();
    const shot = await client.Page.captureScreenshot({ format: "png" });
    const artifacts = path.join(root, ".smoke-artifacts");
    mkdirSync(artifacts, { recursive: true });
    writeFileSync(path.join(artifacts, "pack-verify.png"), Buffer.from(shot.data, "base64"));
    await client.close();
  } finally {
    try {
      execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: "ignore" });
    } catch {
      /* best effort */
    }
  }
  if (failures > 0) {
    console.error(`PACK_VERIFY_FAIL failures=${failures}`);
    process.exit(1);
  }
  console.log("  打包成品冒烟通过（截图 .smoke-artifacts/pack-verify.png）");
}

console.log(`[pack] 完成：${outDir}`);
if (doZip) {
  const zipPath = path.join(root, "release", "WosMapEditor-win64.zip");
  console.log("[pack] 压缩 zip（.NET ZipFile，跳过被锁定的陈旧 default_app.asar）");
  // Compress-Archive 遇到被锁文件会报错却仍退出 0（假成功）——改用显式枚举 + 退出码校验
  const zipPs = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.IO.Compression.FileSystem",
    `if (Test-Path -LiteralPath '${zipPath}') { Remove-Item -LiteralPath '${zipPath}' -Force }`,
    `$zip = [System.IO.Compression.ZipFile]::Open('${zipPath}', 'Create')`,
    "try {",
    `  Get-ChildItem -LiteralPath '${outDir}' -Recurse -File | Where-Object { $_.Name -ne 'default_app.asar' } | ForEach-Object {`,
    `    $rel = $_.FullName.Substring('${outDir}'.Length + 1) -replace '\\\\', '/'`,
    `    [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, 'WosMapEditor-win64/' + $rel, [System.IO.Compression.CompressionLevel]::Optimal)`,
    "  }",
    "} finally { $zip.Dispose() }",
    `if (-not (Test-Path -LiteralPath '${zipPath}')) { throw 'zip 未生成' }`,
    `$size = (Get-Item -LiteralPath '${zipPath}').Length`,
    "if ($size -lt 100MB) { throw ('zip 体积异常：' + $size) }",
    "Write-Output ('ZIP_OK ' + [math]::Round($size / 1MB) + 'MB')",
  ].join("\n");
  // cmd.exe 会丢弃多行命令第一行之后的内容（实测踩坑）——用 -EncodedCommand 传完整脚本
  const encoded = Buffer.from(zipPs, "utf16le").toString("base64");
  execSync(`powershell -NoProfile -EncodedCommand ${encoded}`, {
    stdio: "inherit",
    timeout: 1800000,
  });
  console.log(`[pack] zip：${zipPath}`);
} else {
  console.log("[pack] 提示：加 --zip 可同时产出 zip 分发包");
}
