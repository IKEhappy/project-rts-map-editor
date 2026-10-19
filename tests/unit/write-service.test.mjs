import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { WriteService } = require('../../src/main/write-service.cjs');
const { WorkspaceService, createBoundWorkspace } = require('../../src/main/workspace.cjs');
const { PNG } = require('pngjs');
const decoder = require('../../src/main/image-decoder.cjs');
const jpeg = require('jpeg-js');
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise((resolve) => setImmediate(resolve));

function queueFixture(runWorker) {
  const session = { id: 'session', generation: 1, root: '/maps', projectRoot: '/project', dataDir: '/data', resPrefix: 'res://data/maps/' };
  const workspaces = { current(id) { if (id !== session.id) throw new Error('expired'); return { ...session }; } };
  return { session, service: new WriteService(workspaces, runWorker) };
}

test('writes and workspace transitions are FIFO; restore invalidates an already queued save', async () => {
  const first = deferred();
  const events = [];
  const f = queueFixture(async ({ payload, session }) => {
    events.push(payload.name);
    assert.equal(session.root, '/maps');
    if (payload.name === 'first') await first.promise;
    return { ok: true };
  });
  const save = f.service.run('saveMap', { workspaceId: 'session', name: 'first', root: '/untrusted' });
  const restore = f.service.exclusive(() => { events.push('restore'); f.session.generation += 1; });
  const stale = f.service.run('saveMap', { workspaceId: 'session', name: 'stale' });
  const rejection = assert.rejects(stale, /切换或恢复/);
  await tick();
  assert.deepEqual(events, ['first']);
  first.resolve();
  await Promise.all([save, restore, rejection]);
  assert.deepEqual(events, ['first', 'restore']);
});

test('failed saves do not poison the queue; shutdown drains accepted work and rejects new work', async () => {
  const finish = deferred();
  const f = queueFixture(async ({ payload }) => {
    if (payload.name === 'fail') throw new Error('gate failed');
    await finish.promise;
    return { ok: true };
  });
  await assert.rejects(f.service.run('saveMap', { workspaceId: 'session', name: 'fail' }), /gate failed/);
  const pending = f.service.run('saveMap', { workspaceId: 'session', name: 'good' });
  let drained = false;
  const closing = f.service.close().then(() => { drained = true; });
  await tick();
  assert.equal(drained, false);
  await assert.rejects(f.service.run('saveMap', { workspaceId: 'session' }), /正在关闭/);
  finish.resolve();
  await Promise.all([pending, closing]);
  assert.equal(drained, true);
});

test('pure JS decoder reads PNG and JPEG pixel streams and rejects corrupt data', () => {
  const pixels = Buffer.alloc(3 * 2 * 4, 255);
  const png = PNG.sync.write({ width: 3, height: 2, data: pixels });
  assert.deepEqual(decoder.createFromBuffer(png).getSize(), { width: 3, height: 2 });
  const jpg = jpeg.encode({ width: 3, height: 2, data: pixels }, 80).data;
  assert.deepEqual(decoder.createFromBuffer(jpg).getSize(), { width: 3, height: 2 });
  assert.throws(() => decoder.createFromBuffer(png.subarray(0, 33)));
  assert.throws(() => decoder.createFromBuffer(jpg.subarray(0, 20)));
});

test('real worker imports an image and renames a map using only a main-bound workspace', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'write-worker-'));
  const project = path.join(root, 'project');
  const maps = path.join(project, 'data/maps');
  fs.mkdirSync(maps, { recursive: true });
  fs.writeFileSync(path.join(project, 'project.godot'), 'config_version=5\n');
  fs.writeFileSync(path.join(maps, 'old.json'), '{}');
  const image = path.join(root, 'image.png');
  fs.writeFileSync(image, PNG.sync.write({ width: 2, height: 3, data: Buffer.alloc(24, 255) }));
  const workspaces = new WorkspaceService({ backupRoot: path.join(root, 'backups'), defaultProject: project });
  const session = workspaces.open({ path: maps });
  const service = new WriteService(workspaces);
  t.after(async () => { await service.close(); workspaces.releaseAll(); fs.rmSync(root, { recursive: true, force: true }); });
  const bound = createBoundWorkspace(session);
  assert.throws(() => bound.file(session.id, '../escape.json'), /traversal|Invalid/i);
  let ticks = 0;
  const interval = setInterval(() => { ticks += 1; }, 5);
  try {
    const imported = await service.run('importImage', { workspaceId: session.id, mapId: 'map', view: 'image', sourcePath: image });
    assert.equal(imported.ok, true);
    assert.deepEqual([imported.width, imported.height], [2, 3]);
    assert.ok(fs.existsSync(path.join(project, imported.path.slice(6))));
    const renamed = await service.run('renameMap', { workspaceId: session.id, from: 'old.json', to: 'new.json' });
    assert.equal(renamed.ok, true);
    assert.equal(fs.readFileSync(path.join(maps, 'new.json'), 'utf8'), '{}');
    assert.ok(ticks > 0, 'worker startup and image decode must leave the main event loop responsive');
  } finally { clearInterval(interval); }
});
