'use strict';
// map-editor 数据存储层（T-164）：读/原子写/单代 .bak/哈希守卫/gate 子进程。
// 落盘铁律：序列化文本必须先过 Godot gate（config_gate.gd → MatchConfig.validate）
// 且 exit 0 才允许写盘；无改动不写盘（硬条件①）。
// 环境变量（供测试/沙盒覆盖）：ME_DATA_DIR、ME_GODOT_PROJECT、ME_GATE_SCRIPT、GODOT_EXE。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const TOOL_ROOT = path.resolve(__dirname, '..', '..'); // map-editor/
const REPO_ROOT = path.resolve(TOOL_ROOT, '..'); // 仓库根（WarOfState-Remake/）
const GATE_CANDIDATE_DIR = path.join(TOOL_ROOT, '.gate');
const GATE_PROJECTS_DIR = path.join(TOOL_ROOT, '.gate-projects'); // 导入目录的 gate 沙盒
const GATE_RESULT_PREFIX = 'GATE_RESULT ';
const DEFAULT_GODOT = 'D:\\envir\\GodotEngine\\Godot_v4.7.2-stable_win64_console.exe';
const DATA_FILES = ['units.json', 'buildings.json', 'rules.json'];

const FILES = {
  units: 'units.json',
  buildings: 'buildings.json',
  rules: 'rules.json',
};

// 序列化格式契约：2 空格缩进 + 尾部换行，与 war-of-state/data/*.json 现状一致。
// JS 数字 1.0 → "1" 会重排浮点字面量，canonical() 归一化后语义不变（已在 README 披露）。
function serialize(data) {
  return JSON.stringify(data, null, 2) + '\n';
}

function env() {
  // 打包成品布局：resources/app（本脚本）/ resources/war-of-state（gate 工程子集）/
  // resources/godot（内置 Godot）——与开发态 map-editor/../war-of-state 同构，
  // TOOL_ROOT/REPO_ROOT 相对解析无需分叉，仅 godotExe 需优先找内置副本。
  // 2026-09-17（T-164 R7）：默认工程按存在性解析——姊妹检出 war-of-state 优先
  //（打包/旧布局），否则本工作区 dev-2d（project-rts，数据与校验权威同源）。
  const repoRoot = path.resolve(TOOL_ROOT, '..');
  const bundledGodot = path.join(repoRoot, 'godot', 'Godot_v4.7.2-stable_win64_console.exe');
  const legacyProject = path.join(repoRoot, 'war-of-state');
  const dev2dProject = path.join(repoRoot, 'project-rts');
  const defaultProject = fs.existsSync(path.join(legacyProject, 'src')) ? legacyProject : dev2dProject;
  return {
    dataDir: process.env.ME_DATA_DIR || path.join(defaultProject, 'data'),
    godotProject: process.env.ME_GODOT_PROJECT || defaultProject,
    gateScript: process.env.ME_GATE_SCRIPT || path.join(TOOL_ROOT, 'gate', 'config_gate.gd'),
    godotExe:
      process.env.GODOT_EXE ||
      (fs.existsSync(bundledGodot) ? bundledGodot : DEFAULT_GODOT),
  };
}

function isKind(kind) {
  return Object.prototype.hasOwnProperty.call(FILES, kind);
}

// —— 数据目录解析（T-164 R4：支持导入外部 data 级文件夹）——
function samePath(a, b) {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

function resolveDataDir(explicit) {
  return explicit && String(explicit).trim().length > 0 ? path.resolve(String(explicit).trim()) : env().dataDir;
}

function validateDataDir(explicit) {
  const resolved = path.resolve(String(explicit || '').trim());
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    return { ok: false, errors: [`目录不存在：${resolved}`] };
  }
  const missing = DATA_FILES.filter((name) => !fs.existsSync(path.join(resolved, name)));
  if (missing.length > 0) {
    return { ok: false, errors: [`数据目录缺少配置文件（需同时含 units/buildings/rules.json）：缺 ${missing.join(', ')}`] };
  }
  return { ok: true, dataDir: resolved };
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function meta() {
  const e = env();
  const godotResolved = fs.existsSync(e.godotExe) ? e.godotExe : 'godot (PATH)';
  const m = mapEnv();
  return {
    dataDir: e.dataDir,
    godotExe: godotResolved,
    godotProject: e.godotProject,
    gateScript: e.gateScript,
    files: FILES,
    mapsDir: m.mapsDir,
    mapProject: m.mapProject,
    mapGateScript: m.mapGateScript,
  };
}

function readKind(kind, dataDir) {
  const file = path.join(resolveDataDir(dataDir), FILES[kind]);
  const text = fs.readFileSync(file, 'utf8');
  return {
    ok: true,
    kind,
    data: JSON.parse(text),
    text,
    hash: sha256(text),
    path: file,
    mtimeMs: fs.statSync(file).mtimeMs,
  };
}

// 显示层标签（labels.json）：只影响 UI，坏了缺了都不阻断数据回路。
function readLabels() {
  const file = path.join(TOOL_ROOT, 'labels.json');
  if (!fs.existsSync(file)) return { ok: true, data: {}, path: file };
  try {
    return { ok: true, data: JSON.parse(fs.readFileSync(file, 'utf8')), path: file };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err), data: {}, path: file };
  }
}

function saveKind({ kind, data, baseHash, dataDir }) {
  const dir = resolveDataDir(dataDir);
  const file = path.join(dir, FILES[kind]);
  const current = fs.readFileSync(file, 'utf8');
  if (sha256(current) !== baseHash) {
    return { ok: false, code: 'conflict', errors: ['文件在加载后被外部修改，请点「重新加载」后再编辑'] };
  }
  const text = serialize(data);
  if (text === current) {
    return { ok: true, written: false, reason: 'unchanged', hash: baseHash, errors: [] };
  }
  const gate = runGate(['check', '--kind', kind, '--candidate', writeCandidate(kind, text)], dir);
  if (!gate.ok) {
    return { ok: false, code: 'gate', errors: gate.errors };
  }
  fs.copyFileSync(file, `${file}.bak`);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
  return { ok: true, written: true, hash: sha256(text), errors: [] };
}

function writeCandidate(kind, text) {
  fs.mkdirSync(GATE_CANDIDATE_DIR, { recursive: true });
  const candidate = path.join(GATE_CANDIDATE_DIR, `candidate-${kind}.json`);
  fs.writeFileSync(candidate, text, 'utf8');
  return candidate;
}

// —— 导入目录的 gate 沙盒工程（T-164 R4）——
// gate 校验语义是"候选 vs 同目录其余数据"：外部目录若仍用默认工程对照，键集错位会假报
// 增删实体。为每个导入目录生成独立最小工程（project.godot + src 副本 + --import 类缓存），
// 每次校验前刷新三个 json 副本；src 变化（文件数+字节数标记）自动重建。
const MINIMAL_PROJECT_GODOT = [
  '; map-editor gate 沙盒工程（自动生成，仅供 config_gate.gd 校验，勿手动改动）',
  'config_version=5',
  '',
  '[application]',
  '',
  'config/name="wos-gate"',
  '',
].join('\n');

function dirSlug(dataDir) {
  return crypto.createHash('sha1').update(path.resolve(dataDir).toLowerCase()).digest('hex').slice(0, 12);
}

function treeMarker(dir) {
  let count = 0;
  let size = 0;
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        count += 1;
        size += fs.statSync(full).size;
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return `${count}:${size}`;
}

function gateProjectFor(dataDir) {
  const e = env();
  const dir = resolveDataDir(dataDir);
  if (samePath(dir, e.dataDir)) return e.godotProject;
  // 目录名含 src 标记哈希：src 变化即换新沙盒目录，绝不删除活动/刚用过的沙盒——
  // Windows 下删刚写过的树会撞杀毒扫描锁（ENOTEMPTY/EPERM，实测重试也扛不过分钟级窗口）；
  // 旧版本目录在新沙盒建好后惰性清扫，锁着就留到下一轮。
  const srcSource = path.join(e.godotProject, 'src');
  const marker = treeMarker(srcSource);
  const markerHash = crypto.createHash('sha1').update(marker).digest('hex').slice(0, 8);
  const sandbox = path.join(GATE_PROJECTS_DIR, `${dirSlug(dir)}-${markerHash}`);
  const cacheFile = path.join(sandbox, '.godot', 'global_script_class_cache.cfg');
  if (!fs.existsSync(cacheFile)) {
    fs.mkdirSync(path.join(sandbox, 'data'), { recursive: true });
    fs.writeFileSync(path.join(sandbox, 'project.godot'), MINIMAL_PROJECT_GODOT);
    fs.cpSync(srcSource, path.join(sandbox, 'src'), { recursive: true });
    const exe = fs.existsSync(e.godotExe) ? e.godotExe : 'godot';
    spawnSync(exe, ['--headless', '--path', sandbox, '--import'], { encoding: 'utf8', timeout: 300000 });
    sweepStaleSandboxes(dirSlug(dir), sandbox);
  }
  for (const name of DATA_FILES) {
    fs.copyFileSync(path.join(dir, name), path.join(sandbox, 'data', name));
  }
  return sandbox;
}

// 同一数据目录的旧版本沙盒：尽力删除，失败（被扫描锁）留到下次
function sweepStaleSandboxes(slug, keepPath) {
  try {
    for (const entry of fs.readdirSync(GATE_PROJECTS_DIR)) {
      if (!entry.startsWith(`${slug}-`)) continue;
      const full = path.join(GATE_PROJECTS_DIR, entry);
      if (samePath(full, keepPath)) continue;
      try {
        fs.rmSync(full, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      } catch {
        /* 被锁，留待下轮 */
      }
    }
  } catch {
    /* 目录不存在等，忽略 */
  }
}

// gate 协议见 gate/config_gate.gd 头注释：stdout 单行 GATE_RESULT {json}，exit 0/2/3。
function runGate(args, dataDir) {
  const e = env();
  const project = gateProjectFor(dataDir);
  const exe = fs.existsSync(e.godotExe) ? e.godotExe : 'godot';
  const proc = spawnSync(
    exe,
    ['--headless', '--path', project, '--script', e.gateScript, '--', ...args],
    { encoding: 'utf8', timeout: 60000 },
  );
  return parseGateOutput(proc);
}

function parseGateOutput(proc) {
  const line = String(proc.stdout || '').split(/\r?\n/).find((l) => l.startsWith(GATE_RESULT_PREFIX));
  if (!line) {
    const stderr = String(proc.stderr || '').slice(0, 400);
    return { ok: false, errors: [`gate 无输出（exit=${proc.status}）${stderr}`] };
  }
  try {
    return JSON.parse(line.slice(GATE_RESULT_PREFIX.length));
  } catch (err) {
    return { ok: false, errors: [`gate 输出不可解析：${line}`] };
  }
}

// —— 地图编辑（T-164 R7，2026-09-17）：dev-2d（project-rts）data/maps/*.json 多文件编辑 ——
// 与三表同一铁律：哈希守卫 → 无改动不写盘 → 先过 Godot 地图门禁（真实构建链路）→
// 单代 .bak → 临时文件原子改名。地图目录独立于 data 目录（单位/建筑/规则仍走 dataDir）。
function mapEnv() {
  return {
    mapsDir: process.env.ME_MAPS_DIR || path.join(REPO_ROOT, 'project-rts', 'data', 'maps'),
    mapProject: process.env.ME_MAP_PROJECT || path.join(REPO_ROOT, 'project-rts'),
    mapGateScript: process.env.ME_MAP_GATE_SCRIPT || path.join(TOOL_ROOT, 'gate', 'map_gate.gd'),
  };
}

function resolveMapsDir(explicit) {
  return explicit && String(explicit).trim().length > 0 ? path.resolve(String(explicit).trim()) : mapEnv().mapsDir;
}

/** 地图文件名安全校验：与 map-edit-ops sanitizeFileBase 同口径（保留中文/CJK，
 *  仅拒路径非法字符与目录穿越），白名单外的旧图仍可读 */
function safeMapName(name) {
  const file = String(name || '');
  if (!/^[^\\/:*?"<>|\r\n]+\.json$/.test(file) || file.includes('..') || file.startsWith('.')) return null;
  return file;
}

function listMaps(mapsDir) {
  const dir = resolveMapsDir(mapsDir);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return { ok: false, error: `地图目录不存在：${dir}（可用环境变量 ME_MAPS_DIR 覆盖）`, maps: [], mapsDir: dir };
  }
  const maps = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.json') && !name.endsWith('.bak') && !name.endsWith('.tmp') && !name.startsWith('.'))
    .map((name) => {
      const full = path.join(dir, name);
      return { name, path: full, mtimeMs: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  return { ok: true, maps, mapsDir: dir };
}

function readMap(name, mapsDir) {
  const file = safeMapName(name);
  if (!file) return { ok: false, error: `非法地图文件名：${name}` };
  const full = path.join(resolveMapsDir(mapsDir), file);
  const text = fs.readFileSync(full, 'utf8');
  return {
    ok: true,
    kind: 'maps',
    name: file,
    data: JSON.parse(text),
    text,
    hash: sha256(text),
    path: full,
    mtimeMs: fs.statSync(full).mtimeMs,
  };
}

function runMapGate(candidatePath) {
  const m = mapEnv();
  const e = env();
  const exe = fs.existsSync(e.godotExe) ? e.godotExe : 'godot';
  const proc = spawnSync(
    exe,
    ['--headless', '--path', m.mapProject, '--script', m.mapGateScript, '--', 'check', '--candidate', candidatePath],
    { encoding: 'utf8', timeout: 120000 },
  );
  return parseGateOutput(proc);
}

/** 地图文件全路径（供 shell 打开；不校验存在性） */
function mapFilePath(name) {
  const file = safeMapName(name);
  if (!file) return null;
  return path.join(resolveMapsDir(null), file);
}

/** 读游戏侧 UI 图标 SVG 文本（R19：box_mode 与游戏同款标志，主进程文件系统访问） */
function iconText(name) {
  const safe = /^[A-Za-z0-9_-]+$/.test(String(name)) ? String(name) : null;
  if (!safe) return { ok: false, error: `bad icon name: ${name}` };
  const file = path.join(mapEnv().mapProject, 'assets', 'ui', 'icons', `${safe}.svg`);
  if (!fs.existsSync(file)) return { ok: false, error: `icon missing: ${file}` };
  return { ok: true, text: fs.readFileSync(file, 'utf8') };
}

/** 文件重命名（R17）：真·改名文件（含 .bak 跟随）；不改内容不过 gate（字节不变语义不变） */
function renameMap({ from, to }) {
  const oldFile = safeMapName(from);
  const newFile = safeMapName(to);
  if (!oldFile || !newFile) {
    return { ok: false, code: 'usage', errors: [`非法地图文件名：${from} → ${to}`] };
  }
  const dir = resolveMapsDir(null);
  const oldFull = path.join(dir, oldFile);
  const newFull = path.join(dir, newFile);
  if (!fs.existsSync(oldFull)) {
    return { ok: false, code: 'usage', errors: [`地图不存在：${oldFile}`] };
  }
  if (fs.existsSync(newFull)) {
    return { ok: false, code: 'usage', errors: [`目标名称已存在：${newFile}`] };
  }
  fs.renameSync(oldFull, newFull);
  if (fs.existsSync(`${oldFull}.bak`)) fs.renameSync(`${oldFull}.bak`, `${newFull}.bak`);
  return { ok: true, name: newFile, path: newFull };
}

function saveMap({ name, data, baseHash, mapsDir, expectCreate }) {
  const dir = resolveMapsDir(mapsDir);
  const file = safeMapName(name);
  if (!file) return { ok: false, code: 'usage', errors: [`非法地图文件名：${name}（仅字母数字_-. ）`] };
  const full = path.join(dir, file);
  const exists = fs.existsSync(full);
  if (exists && expectCreate) {
    return { ok: false, code: 'usage', errors: [`地图已存在：${file}（改名请改文档 name 字段后另存）`] };
  }
  if (!exists && !expectCreate) {
    return { ok: false, code: 'usage', errors: [`地图不存在（可能已被外部删除）：${file}`] };
  }
  if (exists) {
    const current = fs.readFileSync(full, 'utf8');
    if (sha256(current) !== baseHash) {
      return { ok: false, code: 'conflict', errors: ['文件在加载后被外部修改，请点「重新加载」后再编辑'] };
    }
    const text = serialize(data);
    if (text === current) {
      return { ok: true, written: false, reason: 'unchanged', hash: baseHash, errors: [] };
    }
  }
  const text = serialize(data);
  fs.mkdirSync(GATE_CANDIDATE_DIR, { recursive: true });
  const candidate = path.join(GATE_CANDIDATE_DIR, 'candidate-map.json');
  fs.writeFileSync(candidate, text, 'utf8');
  const gate = runMapGate(candidate);
  if (!gate.ok) {
    return { ok: false, code: 'gate', errors: gate.errors };
  }
  if (exists) fs.copyFileSync(full, `${full}.bak`);
  const tmp = `${full}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, full);
  return { ok: true, written: true, hash: sha256(text), errors: [], name: file, path: full };
}

module.exports = {
  FILES,
  isKind,
  meta,
  readKind,
  readLabels,
  saveKind,
  runGate,
  serialize,
  sha256,
  validateDataDir,
  listMaps,
  readMap,
  saveMap,
  renameMap,
  mapFilePath,
  iconText,
};
