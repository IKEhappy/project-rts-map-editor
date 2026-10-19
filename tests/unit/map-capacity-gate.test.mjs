import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { MAX_MAP_BUILDINGS } from '../../src/renderer/map-limits.ts';

const require = createRequire(import.meta.url);
const store = require('../../src/main/store.cjs');
const { WorkspaceService } = require('../../src/main/workspace.cjs');
const configured = store.env();
const currentProject = path.resolve(import.meta.dirname, '../../../project-rts');
const available = fs.existsSync(configured.godotExe)
  && fs.existsSync(path.join(currentProject, 'src/sim/sim_core.gd'));

// Uses the current trusted project's actual source through store's isolated
// staging path. Never substitutes a committed validator or writes game maps.
test('real map save gate supports 1024 buildings and rejects 1025 before silent truncation', { skip: !available, timeout: 180000 }, (t) => {
  const previousProject = process.env.ME_GODOT_PROJECT;
  process.env.ME_GODOT_PROJECT = currentProject;
  t.after(() => { if (previousProject === undefined) delete process.env.ME_GODOT_PROJECT; else process.env.ME_GODOT_PROJECT = previousProject; });
  const source = fs.readFileSync(path.join(currentProject, 'src/sim/sim_core.gd'), 'utf8');
  const capacity = Number(source.match(/const MAX_BUILDINGS:\s*int\s*=\s*(\d+)/)?.[1]);
  assert.equal(capacity, MAX_MAP_BUILDINGS, 'editor capacity must match the actual game implementation');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'map-capacity-gate-'));
  const maps = path.join(root, 'maps');
  fs.mkdirSync(maps);
  const file = path.join(maps, 'capacity.json');
  const initial = JSON.stringify({ name: 'original bytes retained until gate passes' });
  const previousBackup = 'previous backup must survive any rejected save\n';
  fs.writeFileSync(file, initial);
  fs.writeFileSync(`${file}.bak`, previousBackup);
  const workspaces = new WorkspaceService({ backupRoot: path.join(root, 'backups'), defaultProject: currentProject });
  const workspace = workspaces.open({ path: maps });
  store.configureWorkspace(workspaces, require('../../src/main/image-decoder.cjs'));
  t.after(() => { workspaces.releaseAll(); fs.rmSync(root, { recursive: true, force: true }); });
  const doc = {
    version: 1, name: 'capacity', width: 128, height: 128, seed: 1,
    default_terrain: 0, ai_teams: [], terrain_patches: [], box_mode: [], decor: [],
    buildings: Array.from({ length: capacity }, (_, i) => ({
      key: i % 2 ? 'turret_guard' : 'mine', team: 0,
      x: i % 64, y: Math.floor(i / 64), w: 1, h: 1,
    })),
    spawns: [{ kind: 0, team: 1, x: 100, y: 100, count: 1 }],
    init: {},
  };
  const saved = store.saveMap({ name: 'capacity.json', workspaceId: workspace.id, baseHash: store.sha256(initial), data: doc });
  assert.equal(saved.ok, true, saved.errors?.join('\n'));
  assert.equal(saved.written, true);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).buildings.length, 1024);
  assert.equal(fs.readFileSync(`${file}.bak`, 'utf8'), initial);
  const acceptedBytes = fs.readFileSync(file);
  const overLimit = structuredClone(doc);
  // Unknown key would be diagnosed after build_level: the sole capacity error
  // proves preflight rejection before game assembly can silently skip it.
  overLimit.buildings.push({ key: 'unknown_over_limit_building', team: 0, x: 80, y: 80, w: 1, h: 1 });
  const rejected = store.saveMap({ name: 'capacity.json', workspaceId: workspace.id, baseHash: saved.hash, data: overLimit });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'gate');
  assert.equal(rejected.errors.length, 1);
  assert.match(rejected.errors[0], /1025.*1024.*SimCore.MAX_BUILDINGS/);
  assert.deepEqual(fs.readFileSync(file), acceptedBytes);
  assert.equal(fs.readFileSync(`${file}.bak`, 'utf8'), initial);
  assert.deepEqual(fs.readdirSync(maps).filter((name) => !name.startsWith('.')), ['capacity.json', 'capacity.json.bak']);
});
