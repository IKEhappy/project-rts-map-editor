import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { WorkspaceService } = require('../../src/main/workspace.cjs');
const storeFile = require.resolve('../../src/main/store.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'config-store-'));
  const target = path.join(root, 'external');
  const trusted = path.join(root, 'trusted');
  const dataDir = path.join(target, 'data');
  const maps = path.join(dataDir, 'maps');
  fs.mkdirSync(maps, { recursive: true });
  const write = (file, bytes) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); };
  write(path.join(target, 'project.godot'), 'config_version=5');
  write(path.join(target, 'src/data/match_config.gd'), 'untrusted external code');
  write(path.join(trusted, 'src/data/match_config.gd'), 'trusted code');
  for (const kind of ['units', 'buildings', 'rules']) write(path.join(dataDir, `${kind}.json`), `${JSON.stringify({ version: 1, value: 1 })}\n`);
  const workspaces = new WorkspaceService({ backupRoot: path.join(root, 'backups'), defaultProject: trusted });
  const session = workspaces.open({ path: maps });
  const calls = [];
  let onGate = () => {};
  let badImport = false;
  const fakeSpawn = (_exe, args, options) => {
    const sandbox = args[args.indexOf('--path') + 1];
    calls.push({ args, options, sandbox });
    assert.notEqual(sandbox, target);
    assert.notEqual(sandbox, trusted);
    assert.equal(fs.readFileSync(path.join(sandbox, 'src/data/match_config.gd'), 'utf8'), 'trusted code');
    assert.ok(options.env.APPDATA.startsWith(sandbox + path.sep));
    assert.ok(fs.readFileSync(path.join(sandbox, 'project.godot'), 'utf8').includes('res://.gate_session.gd'));
    assert.ok(fs.readFileSync(path.join(sandbox, '.gate_session.gd'), 'utf8').includes('func _ready()'));
    for (const kind of ['units', 'buildings', 'rules']) assert.ok(fs.existsSync(path.join(sandbox, 'data', `${kind}.json`)));
    if (args.includes('--import')) return { status: 0, stdout: '', stderr: badImport ? 'SCRIPT ERROR: import failed' : '' };
    onGate();
    const candidate = JSON.parse(fs.readFileSync(args[args.indexOf('--candidate') + 1], 'utf8'));
    const ok = candidate.value >= 0;
    return { status: ok ? 0 : 2, stdout: `GATE_RESULT ${JSON.stringify({ ok, errors: ok ? [] : ['negative value'] })}\n`, stderr: '' };
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(storeFile, 'utf8'), {
    module, exports: module.exports, __dirname: path.dirname(storeFile), Buffer,
    require: (name) => name === 'node:child_process' ? { spawnSync: fakeSpawn } : require(name.startsWith('./') ? path.join(path.dirname(storeFile), name) : name),
    process: { env: { ...process.env, ME_GODOT_PROJECT: trusted, GODOT_EXE: process.execPath } },
  }, { filename: storeFile });
  const store = module.exports;
  store.configureWorkspace(workspaces, null);
  t.after(() => { workspaces.releaseAll(); fs.rmSync(root, { recursive: true, force: true }); });
  const read = (kind = 'rules') => store.readKind(kind, session.id);
  const save = (kind = 'rules', data = { version: 1, value: 2 }, extra = {}) => store.saveKind({ kind, data, baseHash: read(kind).hash, workspaceId: session.id, ...extra });
  return { root, target, trusted, dataDir, maps, workspaces, session, store, calls, read, save, write,
    onGate: (fn) => { onGate = fn; }, badImport: () => { badImport = true; } };
}

test('config reads and writes require the current workspace and never accept arbitrary data directories', (t) => {
  const f = fixture(t);
  assert.throws(() => f.store.readKind('rules'), /选择地图/);
  assert.throws(() => f.store.readKind('rules', 'expired'), /expired/);
  assert.throws(() => f.store.readKind('../rules', f.session.id), /未知/);
  const rejected = f.save('rules', { value: 2 }, { dataDir: f.trusted });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'usage');
  assert.equal(f.calls.length, 0);
});

test('all three tables save via an isolated trusted gate and retain individual original-byte backups', (t) => {
  const f = fixture(t);
  for (const kind of ['units', 'buildings', 'rules']) {
    const before = f.read(kind);
    const result = f.save(kind, { version: 1, value: 2 });
    assert.equal(result.ok, true, result.errors?.join('\n'));
    assert.equal(result.written, true);
    assert.equal(fs.readFileSync(path.join(f.dataDir, `${kind}.json.bak`), 'utf8'), before.text);
    assert.equal(f.read(kind).hash, result.hash);
    assert.equal(f.read(kind).data.value, 2);
  }
  assert.equal(f.calls.length, 6);
  for (const call of f.calls) assert.equal(fs.existsSync(call.sandbox), false);
  assert.equal(fs.readdirSync(f.dataDir).some((name) => name.endsWith('.tmp')), false);
  assert.equal(f.workspaces.compare(f.session.id).counts.changed, 0, 'maps-only baseline does not claim to back up project config');
});

test('unchanged config bytes do not invoke Godot or create a backup', (t) => {
  const f = fixture(t);
  f.write(path.join(f.dataDir, 'rules.json'), f.store.serialize({ version: 1, value: 1 }));
  const result = f.save('rules', f.read().data);
  assert.equal(result.ok, true);
  assert.equal(result.written, false);
  assert.equal(f.calls.length, 0);
  assert.equal(fs.existsSync(path.join(f.dataDir, 'rules.json.bak')), false);
});

test('stale hashes and rejected gate results never overwrite config or backups', (t) => {
  const f = fixture(t);
  const before = f.read().text;
  assert.equal(f.save('rules', { value: 2 }, { baseHash: 'stale' }).code, 'conflict');
  assert.equal(f.calls.length, 0);
  assert.equal(f.save('rules', { value: -1 }).code, 'gate');
  assert.equal(f.read().text, before);
  assert.equal(fs.existsSync(path.join(f.dataDir, 'rules.json.bak')), false);
  for (const call of f.calls) assert.equal(fs.existsSync(call.sandbox), false);
});

test('changes to any sibling table during validation reject the candidate before publish', (t) => {
  const f = fixture(t);
  const before = f.read().text;
  f.onGate(() => f.write(path.join(f.dataDir, 'units.json'), '{"external":true}\n'));
  const result = f.save();
  assert.equal(result.ok, false);
  assert.equal(result.code, 'conflict');
  assert.equal(f.read().text, before);
  assert.equal(fs.existsSync(path.join(f.dataDir, 'rules.json.bak')), false);
});

test('changing the selected workspace during validation invalidates an old save', (t) => {
  const f = fixture(t);
  const before = f.read().text;
  f.onGate(() => f.workspaces.open({ path: f.maps }));
  assert.throws(() => f.save(), /expired/);
  assert.equal(fs.readFileSync(path.join(f.dataDir, 'rules.json'), 'utf8'), before);
});

test('malformed, oversized and non-JSON config input is rejected before running Godot', (t) => {
  const f = fixture(t);
  for (const data of [[], null, { value: NaN }, { value: undefined }, { value: 'bad\0text' }, { value: 'x'.repeat(32 * 1024 * 1024) }]) {
    const result = f.save('rules', data);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'usage');
  }
  assert.equal(f.calls.length, 0);
  assert.equal(f.store.saveKind({ kind: '__proto__', workspaceId: f.session.id }).code, 'usage');
});

test('script errors during staging import reject save and remove its sandbox', (t) => {
  const f = fixture(t);
  f.badImport();
  const result = f.save();
  assert.equal(result.code, 'gate');
  assert.equal(f.calls.length, 1);
  assert.equal(fs.existsSync(f.calls[0].sandbox), false);
  assert.equal(f.read().data.value, 1);
});

test('config backup paths reject links instead of writing their targets', (t) => {
  const f = fixture(t);
  const outside = path.join(f.root, 'outside.txt');
  f.write(outside, 'protected');
  fs.symlinkSync(outside, path.join(f.dataDir, 'rules.json.bak'), 'file');
  assert.throws(() => f.save(), /符号链接/);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'protected');
  assert.equal(f.read().data.value, 1);
});
