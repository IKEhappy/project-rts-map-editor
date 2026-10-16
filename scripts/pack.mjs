// Portable Windows package plus the same disposable-workspace smoke used in development.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createWorkspaceFixture, launchEditor, runWorkspaceSmoke } from "./workspace-smoke.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gameDir = path.resolve(process.env.ME_GAME_DIR || path.join(root, "..", "project-rts"));
const godotDir = process.env.GODOT_DIR || "D:\\envir\\GodotEngine";
const godotNames = ["Godot_v4.7.2-stable_win64_console.exe", "Godot_v4.7.2-stable_win64.exe"];
const releaseDir = path.join(root, "release");
const outDir = path.join(releaseDir, "WosMapEditor-win64");
const artifacts = path.join(root, ".smoke-artifacts");
const noVerify = process.argv.includes("--no-verify");
const doZip = process.argv.includes("--zip");
const require = createRequire(import.meta.url);

function required(file) {
  assert(fs.existsSync(file), `Required package input missing: ${file}`);
  return file;
}

function run(file, args, options = {}) {
  return execFileSync(file, args, { cwd: root, windowsHide: true, timeout: 300000, maxBuffer: 32 * 1024 * 1024, ...options });
}

function runGodot(file, args, logName) {
  const result = spawnSync(file, args, { cwd: root, windowsHide: true, encoding: "utf8", timeout: 300000, maxBuffer: 32 * 1024 * 1024 });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  fs.writeFileSync(path.join(artifacts, logName), output);
  assert(!result.error && result.status === 0 && !/SCRIPT ERROR|^ERROR:/m.test(output), `Godot failed (${result.status}): ${result.error?.message || output.slice(-4000)}; see ${logName}`);
  return output;
}

function copyRuntimePackage(name, destination, copied = new Set()) {
  if (copied.has(name)) return;
  copied.add(name);
  const packageJson = require.resolve(`${name}/package.json`);
  const source = path.dirname(packageJson);
  fs.cpSync(source, path.join(destination, name), { recursive: true });
  const metadata = JSON.parse(fs.readFileSync(packageJson, "utf8"));
  for (const dependency of Object.keys(metadata.dependencies || {})) copyRuntimePackage(dependency, destination, copied);
}

console.log("[pack] 1/7 build renderer");
run(process.execPath, [required(path.join(root, "node_modules", "vite", "bin", "vite.js")), "build"], { stdio: "inherit" });

console.log("[pack] 2/7 prepare release directory");
assert(path.dirname(outDir) === releaseDir && path.basename(outDir) === "WosMapEditor-win64", "Unexpected release output path");
// Never kill another editor session; an occupied output directory must be closed explicitly.
fs.rmSync(outDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(artifacts, { recursive: true });

console.log("[pack] 3/7 copy Electron runtime");
const electronDist = path.join(root, "node_modules", "electron", "dist");
required(path.join(electronDist, "electron.exe"));
fs.cpSync(electronDist, outDir, { recursive: true, filter: (file) => path.basename(file) !== "default_app.asar" });
const executable = path.join(outDir, "WosMapEditor.exe");
fs.renameSync(path.join(outDir, "electron.exe"), executable);

console.log("[pack] 4/7 copy application and main-process dependencies");
const resources = path.join(outDir, "resources");
const appDir = path.join(resources, "app");
fs.mkdirSync(appDir, { recursive: true });
fs.writeFileSync(path.join(appDir, "package.json"), JSON.stringify({ name: "them-pixel-front-map-editor", version: "0.1.0", private: true, main: "src/main/main.cjs" }, null, 2) + "\n");
for (const directory of ["src/main", "src/preload", "dist", "gate"]) fs.cpSync(path.join(root, directory), path.join(appDir, directory), { recursive: true });
fs.copyFileSync(path.join(root, "labels.json"), path.join(appDir, "labels.json"));
fs.copyFileSync(path.join(root, "entity-templates.json"), path.join(appDir, "entity-templates.json"));
copyRuntimePackage("adm-zip", path.join(appDir, "node_modules"));

console.log("[pack] 5/7 copy Godot validation project and image resources");
const lite = path.join(resources, "project-rts");
fs.mkdirSync(lite, { recursive: true });
for (const directory of ["src", "data", "assets"]) {
  required(path.join(gameDir, directory));
  fs.cpSync(path.join(gameDir, directory), path.join(lite, directory), {
    recursive: true,
    filter: (file) => ![".mimosa", ".git", ".godot"].includes(path.basename(file)),
  });
}
// Preserve static APIs while suppressing game startup settings and cursor side effects.
fs.copyFileSync(path.join(root, "gate", "session_stub.gd"), path.join(lite, ".gate_session.gd"));
fs.copyFileSync(path.join(root, "gate", "console_stub.gd"), path.join(lite, ".gate_console.gd"));
fs.writeFileSync(path.join(lite, "project.godot"), [
  "; map-editor validation project; no editor plugins or game main scene",
  "config_version=5", "", "[application]", 'config/name="Them Pixel Front map gate"', "",
  "[autoload]", 'GameSession="*res://.gate_session.gd"', 'DebugConsole="*res://.gate_console.gd"', "",
  "[rendering]", 'renderer/rendering_method="gl_compatibility"', "",
].join("\n"));

console.log("[pack] 6/7 copy Godot executables");
const godotOut = path.join(resources, "godot");
fs.mkdirSync(godotOut, { recursive: true });
for (const name of godotNames) fs.copyFileSync(required(path.join(godotDir, name)), path.join(godotOut, name));
const consoleExe = path.join(godotOut, godotNames[0]);

console.log("[pack] 7/7 import classes and validate bundled configuration");
runGodot(consoleExe, ["--headless", "--path", lite, "--import"], "pack-import.log");
const gate = runGodot(consoleExe, ["--headless", "--path", lite, "--script", path.join(appDir, "gate", "config_gate.gd"), "--", "lint-project"], "pack-gate.log");
const resultLine = gate.split(/\r?\n/).find((line) => line.startsWith("GATE_RESULT "));
assert(resultLine && JSON.parse(resultLine.slice("GATE_RESULT ".length)).ok && !/SCRIPT ERROR|^ERROR:/m.test(gate), "Bundled config gate failed; see pack-gate.log");

if (!noVerify) {
  console.log("[pack-verify] disposable maps workspace with bundled Godot");
  const fixture = createWorkspaceFixture({ parent: path.join(root, ".smoke-data"), project: lite });
  let editor;
  try {
    // Avoid inherited development overrides so this proves bundled default discovery.
    editor = await launchEditor({ executable, cwd: outDir, port: 9224, env: {
      ME_DATA_DIR: "", ME_MAPS_DIR: "", ME_MAP_PROJECT: "", ME_GODOT_PROJECT: "", ME_GATE_SCRIPT: "", ME_MAP_GATE_SCRIPT: "", GODOT_EXE: "",
    } });
    const report = await runWorkspaceSmoke({ client: editor.client, fixture, artifacts, prefix: "pack-workspace" });
    console.log(`PACK_VERIFY_OK checks=${report.checks.length}`);
  } finally {
    if (editor) await editor.close();
  }
}

if (doZip) {
  const zipPath = path.join(releaseDir, "WosMapEditor-win64.zip");
  const quotePs = (value) => `'${value.replace(/'/g, "''")}'`;
  const script = [
    "$ErrorActionPreference='Stop'",
    "Add-Type -AssemblyName System.IO.Compression.FileSystem",
    `if(Test-Path -LiteralPath ${quotePs(zipPath)}){Remove-Item -LiteralPath ${quotePs(zipPath)} -Force}`,
    `[System.IO.Compression.ZipFile]::CreateFromDirectory(${quotePs(outDir)},${quotePs(zipPath)},'Optimal',$true)`,
    `if(-not(Test-Path -LiteralPath ${quotePs(zipPath)})){throw 'ZIP not created'}`,
  ].join("\n");
  run("powershell", ["-NoProfile", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { stdio: "inherit", timeout: 1800000 });
  console.log(`[pack] ZIP: ${zipPath}`);
}
console.log(`[pack] complete: ${outDir}`);
