import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { WorkspaceService } = require('../../src/main/workspace.cjs');
const AdmZip = require('adm-zip');

function fixture(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'map-editor-workspace-'));
  const maps = path.join(temporary, 'maps');
  const backups = path.join(temporary, 'backups');
  fs.mkdirSync(maps);
  const services = [];
  const service = (extra = {}) => {
    const instance = new WorkspaceService({ backupRoot: backups, ...extra });
    services.push(instance);
    return instance;
  };
  t.after(() => {
    for (const instance of services) instance.releaseAll();
    fs.rmSync(temporary, { recursive: true, force: true });
  });
  return { temporary, maps, backups, service };
}

function write(root, relative, bytes) {
  const full = path.join(root, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, bytes);
}

test('a workspace is required and every open creates a separate immutable ZIP', (t) => {
  const f = fixture(t);
  write(f.maps, '中文地图.json', '{ "width": 16 }\r\n');
  write(f.maps, 'old.json.bak', 'original backup');
  write(f.maps, '_assets/ground.png.import', 'import metadata');
  fs.mkdirSync(path.join(f.maps, 'empty'));
  const service = f.service();
  assert.throws(() => service.current(), /Select a map folder/);
  const first = service.open({ path: f.maps });
  const bytes = fs.readFileSync(first.baseline.zipPath);
  assert.equal(first.baseline.fileCount, 3);
  assert.equal(first.offline, true);
  assert.equal(first.resPrefix, 'res://data/maps/');
  assert.ok(!first.baseline.zipPath.startsWith(f.maps + path.sep));
  write(f.maps, 'new.json', '{}');
  const second = service.open({ path: f.maps });
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.baseline.id, second.baseline.id);
  assert.deepEqual(fs.readFileSync(first.baseline.zipPath), bytes);
  assert.equal(second.baseline.fileCount, 4);
  assert.throws(() => service.current(first.id), /expired/);
});

test('compare and restore cover added, removed and changed files, directories and original bytes', (t) => {
  const f = fixture(t);
  const original = Buffer.from([0, 255, 3, 19, 128]);
  write(f.maps, 'map.json', '{ "x": 1.0 }\r\n');
  write(f.maps, '_assets/a.bin', original);
  write(f.maps, 'gone.txt', 'put me back');
  write(f.maps, '.original', 'hidden file');
  fs.mkdirSync(path.join(f.maps, 'empty'));
  const service = f.service();
  const session = service.open({ path: f.maps });
  write(f.maps, 'map.json', '{"x":1}\n');
  write(f.maps, 'new.json', '{}');
  write(f.maps, '_assets/new.png', 'new image');
  fs.unlinkSync(path.join(f.maps, 'gone.txt'));
  fs.rmdirSync(path.join(f.maps, 'empty'));
  const comparison = service.compare(session.id);
  assert.equal(comparison.entries.find((entry) => entry.path === 'map.json').status, 'changed');
  assert.equal(comparison.entries.find((entry) => entry.path === 'gone.txt').status, 'removed');
  assert.equal(comparison.entries.find((entry) => entry.path === '_assets/new.png').status, 'added');
  assert.equal(comparison.entries.find((entry) => entry.path === '_assets/a.bin').status, 'unchanged');
  const restored = service.restore(session.id);
  assert.equal(restored.id, session.id);
  assert.equal(restored.generation, session.generation + 1);
  assert.equal(fs.readFileSync(path.join(f.maps, 'map.json'), 'utf8'), '{ "x": 1.0 }\r\n');
  assert.deepEqual(fs.readFileSync(path.join(f.maps, '_assets/a.bin')), original);
  assert.equal(fs.existsSync(path.join(f.maps, 'new.json')), false);
  assert.equal(fs.existsSync(path.join(f.maps, '_assets/new.png')), false);
  assert.ok(fs.statSync(path.join(f.maps, 'empty')).isDirectory());
  assert.equal(fs.readFileSync(path.join(f.maps, 'gone.txt'), 'utf8'), 'put me back');
  assert.equal(fs.readFileSync(path.join(f.maps, '.original'), 'utf8'), 'hidden file');
  assert.deepEqual(service.compare(session.id).counts, { added: 0, removed: 0, changed: 0, unchanged: 6 });
});

test('folder lock prevents two services editing one root and close releases it', (t) => {
  const f = fixture(t);
  const one = f.service();
  const two = f.service();
  const current = one.open({ path: f.maps });
  assert.throws(() => two.open({ path: f.maps }), /already open|locked/);
  one.close(current.id);
  assert.doesNotThrow(() => two.open({ path: f.maps }));
  assert.throws(() => one.current(current.id), /Select a map folder/);
});

test('current files exceeding snapshot capacity remain comparable and can be completely restored', (t) => {
  const f = fixture(t);
  write(f.maps, 'map.json', 'original');
  const service = f.service();
  const session = service.open({ path: f.maps });
  const oversized = path.join(f.maps, 'oversized.bin');
  fs.writeFileSync(oversized, 'new current content');
  const lstat = fs.lstatSync;
  fs.lstatSync = function (file, ...args) {
    const stat = lstat.call(fs, file, ...args);
    return path.resolve(file) === oversized ? Object.create(stat, { size: { value: 3 * 1024 * 1024 * 1024 } }) : stat;
  };
  try {
    assert.equal(service.compare(session.id).entries.find((entry) => entry.path === 'oversized.bin').status, 'added');
    assert.throws(() => service.open({ path: f.maps }), /2 GiB/);
    assert.equal(service.current().id, session.id);
    assert.doesNotThrow(() => service.restore(session.id));
    assert.equal(fs.existsSync(oversized), false);
    assert.equal(fs.readFileSync(path.join(f.maps, 'map.json'), 'utf8'), 'original');
    assert.equal(service.compare(session.id).counts.added, 0);
  } finally { fs.lstatSync = lstat; }
});

test('project validation fails before backup publication and preserves the previous session', (t) => {
  const f = fixture(t);
  const other = path.join(f.temporary, 'other-maps');
  fs.mkdirSync(other);
  const service = f.service({ validateProject: (project) => {
    if (project.projectRoot === f.temporary) throw new Error('invalid project data');
  } });
  const first = service.open({ path: f.maps });
  fs.writeFileSync(path.join(f.temporary, 'project.godot'), 'config_version=5\n');
  assert.throws(() => service.open({ path: other }), /invalid project data/);
  assert.equal(service.current().id, first.id);
  assert.equal(fs.existsSync(path.join(service._bucket(other), 'workspace.lock')), false);
  assert.deepEqual(fs.readdirSync(service._bucket(other)), []);
});

test('baseline reads return original file bytes, reject invalid paths and verify the complete ZIP', (t) => {
  const f = fixture(t);
  const original = Buffer.from([255, 0, 128, 1]);
  write(f.maps, '_assets/original.bin', original);
  fs.mkdirSync(path.join(f.maps, 'empty'));
  const service = f.service();
  const session = service.open({ path: f.maps });
  fs.unlinkSync(path.join(f.maps, '_assets/original.bin'));
  assert.deepEqual(service.readBaseline(session.id, '_assets/original.bin'), original);
  assert.equal(service.readBaseline(session.id, 'missing.json'), null);
  assert.equal(service.readBaseline(session.id, 'empty'), null);
  assert.throws(() => service.readBaseline(session.id, '../outside'), /Invalid/);
  assert.throws(() => service.readBaseline('expired', '_assets/original.bin'), /expired/);
  fs.appendFileSync(session.baseline.zipPath, Buffer.from('corrupt'));
  assert.throws(() => service.readBaseline(session.id, '_assets/original.bin'), /checksum/);
});

test('a separate Node process respects an active folder lock', (t) => {
  const f = fixture(t);
  f.service().open({ path: f.maps });
  const program = `const {WorkspaceService}=require(process.argv[1]);try{new WorkspaceService({backupRoot:process.argv[2]}).open({path:process.argv[3]});process.exit(1)}catch(e){if(!/locked by process/.test(e.message)){console.error(e);process.exit(2)}}`;
  const child = spawnSync(process.execPath, ['-e', program, require.resolve('../../src/main/workspace.cjs'), f.backups, f.maps], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
});

test('a lock left by a terminated process can be safely reclaimed', (t) => {
  const f = fixture(t);
  const service = f.service();
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  assert.equal(dead.status, 0);
  const key = crypto.createHash('sha256').update(process.platform === 'win32' ? f.maps.toLowerCase() : f.maps).digest('hex');
  const bucket = path.join(f.backups, key);
  fs.mkdirSync(bucket, { recursive: true });
  fs.writeFileSync(path.join(bucket, 'workspace.lock'), JSON.stringify({ pid: Number(dead.stdout), root: f.maps, nonce: 'dead-process' }));
  assert.doesNotThrow(() => service.open({ path: f.maps }));
});

test('workspace file resolution rejects traversal, absolute paths, links and stale session IDs', (t) => {
  const f = fixture(t);
  const service = f.service();
  const current = service.open({ path: f.maps });
  assert.equal(service.file(current.id, '_assets/test.png'), path.join(f.maps, '_assets', 'test.png'));
  for (const input of ['../escape.json', '/absolute.json', 'C:\\outside.json', 'x/../escape.json', 'x//y.json']) {
    assert.throws(() => service.file(current.id, input), /Invalid|outside/);
  }
  assert.throws(() => service.file('wrong-session', 'map.json'), /expired/);
  assert.throws(() => service.file(current.id, 'missing.json', { mustExist: true }), /does not exist/);
  const outside = path.join(f.temporary, 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(f.maps, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => service.file(current.id, 'linked/asset.png'), /links|junctions/);
  assert.throws(() => service.compare(current.id), /links|junctions/);
});

test('opening a linked tree or a backup directory inside maps is rejected before editing', (t) => {
  const f = fixture(t);
  const outside = path.join(f.temporary, 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(f.maps, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => f.service().open({ path: f.maps }), /links|junctions/);
  const nested = f.service({ backupRoot: path.join(f.maps, 'my-backups') });
  assert.throws(() => nested.open({ path: f.maps }), /outside/);
});

test('a dangling directory link is rejected rather than followed on a later write', (t) => {
  const f = fixture(t);
  const service = f.service();
  const current = service.open({ path: f.maps });
  fs.symlinkSync(path.join(f.temporary, 'missing-target'), path.join(f.maps, 'dangling'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => service.file(current.id, 'dangling/asset.png'), /links|junctions/);
});

test('project mapping is derived from the selected root and outside projects remain offline', (t) => {
  const f = fixture(t);
  const project = path.join(f.temporary, 'project');
  const maps = path.join(project, 'data', 'maps');
  fs.mkdirSync(maps, { recursive: true });
  write(project, 'project.godot', 'config_version=5\n');
  const service = f.service({ defaultProject: project });
  const online = service.open({ path: maps });
  assert.equal(online.projectRoot, project);
  assert.equal(online.dataDir, path.join(project, 'data'));
  assert.equal(online.resPrefix, 'res://data/maps/');
  assert.equal(online.offline, false);
  const offline = service.open({ path: f.maps });
  assert.equal(offline.projectRoot, project);
  assert.equal(offline.offline, true);
  assert.equal(offline.resPrefix, 'res://data/maps/');
});

test('corrupt backup is rejected without changing the current map directory', (t) => {
  const f = fixture(t);
  write(f.maps, 'map.json', 'original');
  const service = f.service();
  const current = service.open({ path: f.maps });
  write(f.maps, 'map.json', 'current');
  fs.appendFileSync(current.baseline.zipPath, Buffer.from('corruption'));
  assert.throws(() => service.restore(current.id), /checksum/);
  assert.equal(fs.readFileSync(path.join(f.maps, 'map.json'), 'utf8'), 'current');
  assert.deepEqual(fs.readdirSync(f.maps), ['map.json']);
});

test('an older baseline can be selected without changing or overwriting newer backups', (t) => {
  const f = fixture(t);
  write(f.maps, 'map.json', 'first');
  const service = f.service();
  const first = service.open({ path: f.maps });
  write(f.maps, 'map.json', 'second');
  const second = service.open({ path: f.maps });
  const laterZip = fs.readFileSync(second.baseline.zipPath);
  service.restore(second.id, { backupId: first.baseline.id });
  assert.equal(fs.readFileSync(path.join(f.maps, 'map.json'), 'utf8'), 'first');
  assert.equal(service.current(second.id).baseline.id, first.baseline.id);
  assert.deepEqual(fs.readFileSync(second.baseline.zipPath), laterZip);
});

for (const invalid of ['content/../escape.txt', 'content/other.json']) {
  test(`ZIP entry validation rejects unsafe or duplicate paths: ${invalid}`, (t) => {
    const f = fixture(t);
    write(f.maps, 'map.json', 'baseline');
    write(f.maps, 'other.json', 'other');
    const service = f.service();
    const current = service.open({ path: f.maps });
    write(f.maps, 'map.json', 'current');
    const zip = new AdmZip(current.baseline.zipPath);
    zip.getEntry('content/map.json').entryName = invalid;
    zip.writeZip(current.baseline.zipPath);
    const recordPath = current.baseline.zipPath.replace(/\.zip$/, '.json');
    const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    record.zipSha256 = crypto.createHash('sha256').update(fs.readFileSync(current.baseline.zipPath)).digest('hex');
    fs.writeFileSync(recordPath, JSON.stringify(record));
    assert.throws(() => service.restore(current.id), /Invalid|Duplicate|structure/);
    assert.equal(fs.readFileSync(path.join(f.maps, 'map.json'), 'utf8'), 'current');
    assert.equal(fs.existsSync(path.join(f.temporary, 'escape.txt')), false);
  });
}

test('restore rolls back the original folder when installing the staging tree fails', (t) => {
  const f = fixture(t);
  write(f.maps, 'map.json', 'baseline');
  const service = f.service();
  const current = service.open({ path: f.maps });
  write(f.maps, 'map.json', 'current');
  write(f.maps, 'new.txt', 'keep when restore fails');
  const rename = fs.renameSync;
  let injected = false;
  fs.renameSync = (from, to) => {
    if (!injected && String(from).includes('.map-editor-stage-') && to === f.maps) {
      injected = true;
      throw Object.assign(new Error('injected Windows lock'), { code: 'EPERM' });
    }
    return rename(from, to);
  };
  try {
    assert.throws(() => service.restore(current.id), /injected Windows lock/);
  } finally {
    fs.renameSync = rename;
  }
  assert.equal(injected, true);
  assert.equal(fs.readFileSync(path.join(f.maps, 'map.json'), 'utf8'), 'current');
  assert.equal(fs.readFileSync(path.join(f.maps, 'new.txt'), 'utf8'), 'keep when restore fails');
  assert.equal(service.current(current.id).generation, current.generation);
  assert.equal(fs.existsSync(path.join(path.dirname(current.baseline.zipPath), 'restore.json')), false);
  assert.deepEqual(fs.readdirSync(f.temporary).sort(), ['backups', 'maps']);
});

test('reopening repairs an interruption after original directory rename', (t) => {
  const f = fixture(t);
  write(f.maps, 'map.json', 'baseline');
  const first = f.service();
  const original = first.open({ path: f.maps });
  write(f.maps, 'map.json', 'unsaved before crash');
  first.releaseAll();
  const transactionId = crypto.randomUUID();
  const stage = path.join(f.temporary, `.maps.map-editor-stage-${transactionId}`);
  const quarantine = path.join(f.temporary, `.maps.map-editor-old-${transactionId}`);
  fs.mkdirSync(stage);
  write(stage, 'map.json', 'baseline');
  fs.renameSync(f.maps, quarantine);
  fs.writeFileSync(path.join(path.dirname(original.baseline.zipPath), 'restore.json'), JSON.stringify({
    schema: 1, transactionId, root: f.maps, stage, quarantine,
    backupId: original.baseline.id, phase: 'root-moved',
  }));
  const second = f.service();
  const reopened = second.open({ path: f.maps });
  assert.equal(fs.readFileSync(path.join(f.maps, 'map.json'), 'utf8'), 'unsaved before crash');
  assert.equal(fs.existsSync(stage), false);
  assert.equal(fs.existsSync(quarantine), false);
  assert.notEqual(reopened.baseline.id, original.baseline.id);
});

test('reopening removes incomplete staging without touching the current directory', (t) => {
  const f = fixture(t);
  write(f.maps, 'map.json', 'baseline');
  const first = f.service();
  const original = first.open({ path: f.maps });
  write(f.maps, 'map.json', 'edited');
  first.releaseAll();
  const transactionId = crypto.randomUUID();
  const stage = path.join(f.temporary, `.maps.map-editor-stage-${transactionId}`);
  const quarantine = path.join(f.temporary, `.maps.map-editor-old-${transactionId}`);
  fs.mkdirSync(stage);
  write(stage, 'partial.bin', 'incomplete extraction');
  fs.writeFileSync(path.join(path.dirname(original.baseline.zipPath), 'restore.json'), JSON.stringify({
    schema: 1, transactionId, root: f.maps, stage, quarantine,
    backupId: original.baseline.id, phase: 'staging',
  }));
  f.service().open({ path: f.maps });
  assert.equal(fs.readFileSync(path.join(f.maps, 'map.json'), 'utf8'), 'edited');
  assert.equal(fs.existsSync(stage), false);
});

test('reopening completes a verified installed tree after an interrupted commit', (t) => {
  const f = fixture(t);
  write(f.maps, 'map.json', 'baseline');
  const first = f.service();
  const original = first.open({ path: f.maps });
  first.releaseAll();
  const transactionId = crypto.randomUUID();
  const stage = path.join(f.temporary, `.maps.map-editor-stage-${transactionId}`);
  const quarantine = path.join(f.temporary, `.maps.map-editor-old-${transactionId}`);
  fs.mkdirSync(quarantine);
  write(quarantine, 'map.json', 'edited');
  fs.writeFileSync(path.join(path.dirname(original.baseline.zipPath), 'restore.json'), JSON.stringify({
    schema: 1, transactionId, root: f.maps, stage, quarantine,
    backupId: original.baseline.id, phase: 'installed',
  }));
  f.service().open({ path: f.maps });
  assert.equal(fs.readFileSync(path.join(f.maps, 'map.json'), 'utf8'), 'baseline');
  assert.equal(fs.existsSync(quarantine), false);
});
