'use strict';
// map-editor 数据存储层（T-164）：读/原子写/单代 .bak/哈希守卫/gate 子进程。
// 落盘铁律：序列化文本必须先过 Godot gate（config_gate.gd → MatchConfig.validate）
// 且 exit 0 才允许写盘；无改动不写盘（硬条件①）。
// 环境变量（供测试/沙盒覆盖）：ME_DATA_DIR、ME_GODOT_PROJECT、ME_GATE_SCRIPT、GODOT_EXE。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const assets = require('./assets.cjs');
let workspaceService = null;
let imageDecoder = null;
function configureWorkspace(service, nativeImage) { workspaceService = service; imageDecoder = nativeImage; }
function workspace(id) {
  if (!workspaceService || !id) throw new Error('请先选择地图文件夹');
  return workspaceService.current(id);
}

const TOOL_ROOT = path.resolve(__dirname, '..', '..'); // map-editor/
const REPO_ROOT = path.resolve(TOOL_ROOT, '..'); // 仓库根（WarOfState-Remake/）
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
  // Portable resources mirror the development layout; retain the legacy fallback.
  const repoRoot = path.resolve(TOOL_ROOT, '..');
  const bundledGodot = path.join(repoRoot, 'godot', 'Godot_v4.7.2-stable_win64_console.exe');
  const legacyProject = path.join(repoRoot, 'war-of-state');
  const dev2dProject = path.join(repoRoot, 'project-rts');
  const defaultProject = fs.existsSync(path.join(dev2dProject, 'src')) ? dev2dProject : legacyProject;
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

function readKind(kind, workspaceId) {
  if (!isKind(kind)) throw new Error('未知配置表');
  const file = assets.regularFile(workspace(workspaceId).dataDir, FILES[kind]);
  assets.readJson(file);
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

// Optional editor-only schemas. Missing/corrupt files fall back to renderer RAM.
function readEditorTemplates() {
  const file = path.join(TOOL_ROOT, 'entity-templates.json');
  try { return { ok: true, data: assets.readJson(assets.regularFile(TOOL_ROOT, 'entity-templates.json')), path: file }; }
  catch (error) { return { ok: false, error: String(error.message || error), path: file }; }
}

function configPath(workspaceId, relative, { optional = false } = {}) {
  const dir = workspace(workspaceId).dataDir;
  // Resolve a required sibling first to verify every ancestor of the bound data directory.
  assets.regularFile(dir, 'rules.json');
  const full = path.join(dir, relative);
  try { fs.lstatSync(full); return assets.regularFile(dir, relative); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!optional) throw new Error(`配置文件不存在：${relative}`);
  return full;
}

function configText(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('配置根节点必须为对象');
  const text = JSON.stringify(data, (key, value) => {
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\ufeff\ufffe\uffff]/.test(key)
        || (typeof value === 'string' && /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\ufeff\ufffe\uffff]/.test(value))) throw new Error('配置包含非法控制字符');
    if ((typeof value === 'number' && !Number.isFinite(value)) || value === undefined || ['bigint', 'function', 'symbol'].includes(typeof value)) throw new Error('配置含非 JSON 值');
    return value;
  }, 2) + '\n';
  if (Buffer.byteLength(text, 'utf8') > assets.MAX_BYTES) throw new Error('配置超过 32 MiB 上限');
  return text;
}

function writeDurable(file, bytes) {
  const fd = fs.openSync(file, 'wx');
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}

function saveKind({ kind, data, baseHash, workspaceId, dataDir }) {
  if (!isKind(kind)) return { ok: false, code: 'usage', errors: ['未知配置表'] };
  const ws = workspace(workspaceId);
  if (dataDir != null) return { ok: false, code: 'usage', errors: ['配置目录由当前地图工作区绑定，不可另选 dataDir'] };
  let text;
  try { text = configText(data); }
  catch (error) { return { ok: false, code: 'usage', errors: [error.message] }; }
  const file = configPath(workspaceId, FILES[kind]);
  assets.readJson(file);
  const current = fs.readFileSync(file, 'utf8');
  if (sha256(current) !== baseHash) {
    return { ok: false, code: 'conflict', errors: ['文件在加载后被外部修改，请点「重新加载」后再编辑'] };
  }
  if (text === current) {
    return { ok: true, written: false, reason: 'unchanged', hash: baseHash, errors: [] };
  }
  const siblingHashes = new Map(DATA_FILES.map((name) => [name, sha256(fs.readFileSync(configPath(workspaceId, name)))]));
  const candidateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-config-candidate-'));
  const candidate = path.join(candidateDir, `${crypto.randomUUID()}.json`);
  let gate;
  try {
    writeDurable(candidate, text);
    gate = runGate(['check', '--kind', kind, '--candidate', candidate], workspaceId);
  } finally { fs.rmSync(candidateDir, { recursive: true, force: true }); }
  if (!gate.ok) {
    return { ok: false, code: 'gate', errors: gate.errors };
  }
  if (workspace(workspaceId).dataDir !== ws.dataDir || DATA_FILES.some((name) => sha256(fs.readFileSync(configPath(workspaceId, name))) !== siblingHashes.get(name))) {
    return { ok: false, code: 'conflict', errors: ['校验期间配置文件被外部修改，未保存，请重新加载'] };
  }
  const backup = configPath(workspaceId, `${FILES[kind]}.bak`, { optional: true });
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  const backupTmp = `${backup}.${crypto.randomUUID()}.tmp`;
  try {
    writeDurable(tmp, text);
    writeDurable(backupTmp, current);
    configPath(workspaceId, FILES[kind]);
    configPath(workspaceId, `${FILES[kind]}.bak`, { optional: true });
    if (sha256(fs.readFileSync(file, 'utf8')) !== baseHash) return { ok: false, code: 'conflict', errors: ['落盘前配置被外部修改，未保存'] };
    fs.renameSync(backupTmp, backup);
    fs.renameSync(tmp, file);
  } finally {
    for (const temporary of [tmp, backupTmp]) if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  return { ok: true, written: true, hash: sha256(text), errors: [] };
}

// 每次校验使用一次性工程：可信源码、当前工作区三表、无界面 autoload 和独立用户目录。
const MINIMAL_PROJECT_GODOT = [
  '; map-editor gate 沙盒工程（自动生成，仅供 config_gate.gd 校验，勿手动改动）',
  'config_version=5',
  '',
  '[application]',
  '',
  'config/name="wos-gate"',
  '',
].join('\n');

// gate 协议见 gate/config_gate.gd 头注释：stdout 单行 GATE_RESULT {json}，exit 0/2/3。
function runGate(args, workspaceId) {
  const e = env();
  workspace(workspaceId);
  const exe = fs.existsSync(e.godotExe) ? e.godotExe : 'godot';
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-config-gate-'));
  const options = { encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, APPDATA: path.join(sandbox, 'user-data'), XDG_DATA_HOME: path.join(sandbox, 'user-data') } };
  try {
    fs.writeFileSync(path.join(sandbox, 'project.godot'), MINIMAL_PROJECT_GODOT + '\n[autoload]\nGameSession="*res://.gate_session.gd"\nDebugConsole="*res://.gate_console.gd"\n', 'utf8');
    for (const [source, target] of [['session_stub.gd', '.gate_session.gd'], ['console_stub.gd', '.gate_console.gd']]) {
      fs.copyFileSync(path.join(TOOL_ROOT, 'gate', source), path.join(sandbox, target));
    }
    assets.regularFile(e.godotProject, 'src/data/match_config.gd');
    fs.cpSync(path.join(e.godotProject, 'src'), path.join(sandbox, 'src'), { recursive: true, filter: (file) => {
      if (fs.lstatSync(file).isSymbolicLink()) throw new Error('可信校验源码不允许符号链接');
      return true;
    } });
    fs.mkdirSync(path.join(sandbox, 'data'));
    for (const name of DATA_FILES) {
      const source = configPath(workspaceId, name);
      assets.readJson(source);
      fs.copyFileSync(source, path.join(sandbox, 'data', name));
    }
    const imported = spawnSync(exe, ['--headless', '--path', sandbox, '--import'], options);
    if (imported.error || imported.status !== 0 || /SCRIPT ERROR|^ERROR:/m.test(`${imported.stdout}\n${imported.stderr}`)) {
      return { ok: false, errors: [`Godot 配置隔离导入失败：${String(imported.error?.message || imported.stderr || imported.stdout).slice(0, 2500)}`] };
    }
    return parseGateOutput(spawnSync(exe, ['--headless', '--path', sandbox, '--script', e.gateScript, '--', ...args], options));
  } finally { fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 3 }); }
}

function parseGateOutput(proc) {
  if (proc.error || proc.status !== 0 || /SCRIPT ERROR|^ERROR:/m.test(`${proc.stdout || ''}\n${proc.stderr || ''}`)) {
    return { ok: false, errors: [`Godot 校验失败（exit=${proc.status}）：${String(proc.error?.message || proc.stderr || proc.stdout || '').slice(0, 2000)}`] };
  }
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
  return workspace(explicit).root;
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
      const full = workspaceService.file(mapsDir, name, { mustExist: true });
      return { name, path: full, mtimeMs: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  return { ok: true, maps, mapsDir: dir };
}

function readMap(name, mapsDir) {
  const file = safeMapName(name);
  if (!file) return { ok: false, error: `非法地图文件名：${name}` };
  workspace(mapsDir);
  const full = workspaceService.file(mapsDir, file, { mustExist: true });
  assets.readJson(full);
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

function runMapGate(candidatePath, workspaceId) {
  const m = mapEnv();
  const e = env();
  const exe = fs.existsSync(e.godotExe) ? e.godotExe : 'godot';
  const ws = workspace(workspaceId);
  const sandbox = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'pixel-map-gate-'));
  const gateOptions = { encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, APPDATA: path.join(sandbox, 'user-data'), XDG_DATA_HOME: path.join(sandbox, 'user-data') } };
  try {
    fs.writeFileSync(path.join(sandbox, 'project.godot'), MINIMAL_PROJECT_GODOT + '\n[autoload]\nGameSession="*res://.gate_session.gd"\nDebugConsole="*res://.gate_console.gd"\n', 'utf8');
    fs.copyFileSync(path.join(TOOL_ROOT, 'gate', 'session_stub.gd'), path.join(sandbox, '.gate_session.gd'));
    fs.copyFileSync(path.join(TOOL_ROOT, 'gate', 'console_stub.gd'), path.join(sandbox, '.gate_console.gd'));
    // The gate always runs on a copy. It must never create candidates/import caches in the game project.
    for (const directory of ['src', 'data']) {
      // Executable code is always the tool's trusted game implementation, never an imported package.
      const source = path.join(directory === 'src' ? e.godotProject : ws.projectRoot, directory);
      if (fs.existsSync(source)) fs.cpSync(source, path.join(sandbox, directory), {
        recursive: true,
        filter: (file) => {
          if (['maps', '.godot', '.git'].includes(path.basename(file)) || file.endsWith('.import')) return false;
          const stat = fs.lstatSync(file);
          if (stat.isSymbolicLink()) throw new Error('校验依赖不允许符号链接');
          return directory === 'src' || stat.isDirectory() || /\.(json|png|jpe?g)$/i.test(file);
        },
      });
    }
    const background = assets.backgroundInfo(workspaceService, workspaceId, assets.readJson(candidatePath), imageDecoder, false);
    for (const image of Object.values(background.images)) {
      if (image.error) continue;
      const target = path.join(sandbox, image.path.slice(6));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(assets.imageResourceFile(workspaceService, workspaceId, image.path), target);
    }
    const mount = path.join(sandbox, ws.resPrefix.slice(6));
    fs.mkdirSync(path.dirname(mount), { recursive: true });
    fs.mkdirSync(mount, { recursive: true });
    const copyData = (folder, relative = '') => {
      for (const item of fs.readdirSync(folder, { withFileTypes: true })) {
        const rel = relative ? `${relative}/${item.name}` : item.name;
        const source = workspaceService.file(workspaceId, rel, { mustExist: true });
        if (item.isDirectory()) copyData(source, rel);
        else if (item.isFile() && /\.(json|png|jpe?g)$/i.test(item.name)) {
          const target = path.join(mount, rel);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.copyFileSync(source, target);
        }
      }
    };
    copyData(ws.root);
    const imported = spawnSync(exe, ['--headless', '--path', sandbox, '--import'], gateOptions);
    if (imported.error || imported.status !== 0 || /SCRIPT ERROR|^ERROR:/m.test(`${imported.stdout}\n${imported.stderr}`)) {
      return { ok: false, errors: [`Godot staging 导入失败：${String(imported.error?.message || imported.stderr || imported.stdout).slice(0, 2500)}`] };
    }
    const proc = spawnSync(exe,
      ['--headless', '--path', sandbox, '--script', m.mapGateScript, '--', 'check', '--candidate', candidatePath],
      gateOptions);
    return parseGateOutput(proc);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 3 });
  }
}

/** 地图文件全路径（供 shell 打开；不校验存在性） */
function mapFilePath(name, workspaceId) {
  const file = safeMapName(name);
  if (!file) return null;
  workspace(workspaceId);
  return workspaceService.file(workspaceId, file, { mustExist: true });
}

/** 读游戏侧 UI 图标 SVG 文本（R19：box_mode 与游戏同款标志，主进程文件系统访问） */
function iconText(name, workspaceId) {
  const safe = /^[A-Za-z0-9_-]+$/.test(String(name)) ? String(name) : null;
  if (!safe) return { ok: false, error: `bad icon name: ${name}` };
  const file = assets.regularFile(workspace(workspaceId).projectRoot, `assets/ui/icons/${safe}.svg`);
  if (!fs.existsSync(file)) return { ok: false, error: `icon missing: ${file}` };
  return { ok: true, text: fs.readFileSync(file, 'utf8') };
}

/** 文件重命名（R17）：真·改名文件（含 .bak 跟随）；不改内容不过 gate（字节不变语义不变） */
function renameMap({ from, to, workspaceId, baseHash }) {
  const oldFile = safeMapName(from);
  const newFile = safeMapName(to);
  if (!oldFile || !newFile) {
    return { ok: false, code: 'usage', errors: [`非法地图文件名：${from} → ${to}`] };
  }
  workspace(workspaceId);
  const oldFull = workspaceService.file(workspaceId, oldFile, { mustExist: true });
  const newFull = workspaceService.file(workspaceId, newFile);
  if (!fs.existsSync(oldFull)) {
    return { ok: false, code: 'usage', errors: [`地图不存在：${oldFile}`] };
  }
  if (fs.existsSync(newFull)) {
    return { ok: false, code: 'usage', errors: [`目标名称已存在：${newFile}`] };
  }
  if (baseHash && sha256(fs.readFileSync(oldFull, 'utf8')) !== baseHash) return { ok: false, code: 'conflict', errors: ['地图被外部修改，请重新加载后改名'] };
  const oldBackup = workspaceService.file(workspaceId, `${oldFile}.bak`);
  const newBackup = workspaceService.file(workspaceId, `${newFile}.bak`);
  if (fs.existsSync(newBackup)) return { ok: false, code: 'usage', errors: ['目标备份文件已存在'] };
  fs.renameSync(oldFull, newFull);
  try { if (fs.existsSync(oldBackup)) fs.renameSync(oldBackup, newBackup); }
  catch (error) { fs.renameSync(newFull, oldFull); throw error; }
  return { ok: true, name: newFile, path: newFull };
}

function saveMap({ name, data, baseHash, workspaceId, expectCreate }) {
  workspace(workspaceId);
  const file = safeMapName(name);
  if (!file) return { ok: false, code: 'usage', errors: [`非法地图文件名：${name}（仅字母数字_-. ）`] };
  const full = workspaceService.file(workspaceId, file);
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
  if (Buffer.byteLength(text, 'utf8') > assets.MAX_BYTES) return { ok: false, code: 'usage', errors: ['地图超过 32 MiB 上限'] };
  const resources = assets.backgroundInfo(workspaceService, workspaceId, data, imageDecoder, false);
  if (!resources.ok) return { ok: false, code: 'assets', errors: resources.errors };
  const candidateDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'pixel-map-candidate-'));
  const candidate = path.join(candidateDir, `${crypto.randomUUID()}.json`);
  fs.writeFileSync(candidate, text, 'utf8');
  let gate;
  try { gate = runMapGate(candidate, workspaceId); }
  finally { fs.rmSync(candidateDir, { recursive: true, force: true }); }
  if (!gate.ok) {
    return { ok: false, code: 'gate', errors: gate.errors };
  }
  workspaceService.file(workspaceId, file);
  if (exists !== fs.existsSync(full) || (exists && sha256(fs.readFileSync(full, 'utf8')) !== baseHash)) {
    return { ok: false, code: 'conflict', errors: ['校验期间文件被外部修改，未保存，请重新加载'] };
  }
  if (exists) {
    const backup = workspaceService.file(workspaceId, `${file}.bak`);
    if (fs.existsSync(backup) && !fs.statSync(backup).isFile()) throw new Error('地图 .bak 目标不是普通文件');
    fs.copyFileSync(full, backup);
  }
  const tmp = `${full}.${crypto.randomUUID()}.tmp`;
  try { fs.writeFileSync(tmp, text, { encoding: 'utf8', flag: 'wx' }); fs.renameSync(tmp, full); }
  finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
  return { ok: true, written: true, hash: sha256(text), errors: [], name: file, path: full };
}

module.exports = {
  configureWorkspace,
  env,
  FILES,
  isKind,
  meta,
  readKind,
  readLabels,
  readEditorTemplates,
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
