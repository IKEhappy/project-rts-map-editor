import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const childProcess = require('node:child_process');
let inspectGate;
const spawnSync = childProcess.spawnSync;
childProcess.spawnSync = (_exe, args) => {
  inspectGate?.(args);
  return { status: 0, stdout: args.includes('--import') ? '' : 'GATE_RESULT {"ok":true,"errors":[]}\n', stderr: '' };
};
const store = require('../../src/main/store.cjs');
childProcess.spawnSync = spawnSync;
const { WorkspaceService } = require('../../src/main/workspace.cjs');
const { PNG } = require('pngjs');
const decoder = require('../../src/main/image-decoder.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'map-store-'));
  const project = path.join(root, 'project');
  const maps = path.join(project, 'data/maps');
  fs.mkdirSync(maps, { recursive: true });
  fs.mkdirSync(path.join(project, 'src/sim'), { recursive: true });
  fs.writeFileSync(path.join(project, 'src/sim/game_map.gd'), 'extends RefCounted\n');
  fs.writeFileSync(path.join(project, 'project.godot'), 'config_version=5\n');
  for (const kind of ['units', 'buildings', 'rules']) fs.writeFileSync(path.join(project, `data/${kind}.json`), '{}');
  const previous = process.env.ME_GODOT_PROJECT;
  process.env.ME_GODOT_PROJECT = project;
  const workspaces = new WorkspaceService({ backupRoot: path.join(root, 'backups'), defaultProject: project });
  const session = workspaces.open({ path: maps });
  store.configureWorkspace(workspaces, decoder);
  t.after(() => {
    inspectGate = undefined;
    if (previous === undefined) delete process.env.ME_GODOT_PROJECT; else process.env.ME_GODOT_PROJECT = previous;
    workspaces.releaseAll(); fs.rmSync(root, { recursive: true, force: true });
  });
  const write = (relative, bytes) => { const file = path.join(project, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); return file; };
  const payload = { workspaceId: session.id, name: 'map.json', expectCreate: true, data: { width: 8, height: 8 } };
  return { project, maps, payload, write };
}

test('map gate stages only three tables, renderer and effective images, including mounted workspace resources', (t) => {
  const f = fixture(t);
  const png = PNG.sync.write({ width: 2, height: 2, data: Buffer.alloc(16, 255) });
  f.write('data/maps/_assets/used.png', png);
  f.write('data/maps/_assets/unused.png', png);
  f.write('assets/unrelated.png', png);
  f.write('data/render/theme.json', JSON.stringify({ background: { image: 'res://data/maps/_assets/used.png' } }));
  f.write('data/unused.json', '{}');
  f.payload.data.renderer = 'res://data/render/theme.json';
  let calls = 0;
  inspectGate = (args) => {
    calls += 1;
    const stage = args[args.indexOf('--path') + 1];
    for (const file of ['data/units.json', 'data/buildings.json', 'data/rules.json', 'data/render/theme.json', 'data/maps/_assets/used.png']) assert.ok(fs.existsSync(path.join(stage, file)), file);
    for (const file of ['data/maps/_assets/unused.png', 'assets/unrelated.png', 'data/unused.json']) assert.equal(fs.existsSync(path.join(stage, file)), false, file);
  };
  const result = store.saveMap(f.payload);
  assert.equal(result.ok, true, result.errors?.join('\n'));
  assert.equal(calls, 2);
});

test('sibling config changes during map validation reject without publishing map or backup', (t) => {
  const f = fixture(t);
  inspectGate = (args) => { if (!args.includes('--import')) f.write('data/rules.json', '{"changed":true}'); };
  const result = store.saveMap(f.payload);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'conflict');
  assert.equal(fs.existsSync(path.join(f.maps, 'map.json')), false);
  assert.equal(fs.existsSync(path.join(f.maps, 'map.json.bak')), false);
});

for (const changed of ['renderer', 'image']) {
  test(`referenced ${changed} changes during validation reject before map publication`, (t) => {
    const f = fixture(t);
    const png = PNG.sync.write({ width: 2, height: 2, data: Buffer.alloc(16, 255) });
    f.write('data/maps/_assets/used.png', png);
    f.write('data/render/theme.json', JSON.stringify({ background: { image: 'res://data/maps/_assets/used.png' } }));
    f.payload.data.renderer = 'res://data/render/theme.json';
    inspectGate = (args) => {
      if (args.includes('--import')) return;
      if (changed === 'renderer') f.write('data/render/theme.json', '{"background":{},"version":1}');
      else f.write('data/maps/_assets/used.png', Buffer.concat([png, Buffer.from('external change')]));
    };
    const result = store.saveMap(f.payload);
    assert.equal(result.code, 'conflict');
    assert.equal(fs.existsSync(path.join(f.maps, 'map.json')), false);
  });
}

test('map saves retain hash conflicts, no-op detection, backups and atomic cleanup', (t) => {
  const f = fixture(t);
  assert.equal(store.saveMap(f.payload).ok, true);
  const original = fs.readFileSync(path.join(f.maps, 'map.json'), 'utf8');
  const baseHash = store.sha256(original);
  assert.equal(store.saveMap({ ...f.payload, expectCreate: false, baseHash }).written, false);
  assert.equal(store.saveMap({ ...f.payload, expectCreate: false, baseHash: 'stale' }).code, 'conflict');
  const next = store.saveMap({ ...f.payload, expectCreate: false, baseHash, data: { width: 9, height: 8 } });
  assert.equal(next.ok, true);
  assert.equal(fs.readFileSync(path.join(f.maps, 'map.json.bak'), 'utf8'), original);
  assert.deepEqual(fs.readdirSync(f.maps).sort(), ['map.json', 'map.json.bak']);
});
