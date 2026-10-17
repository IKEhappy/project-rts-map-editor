import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { WorkspaceService } = require('../../src/main/workspace.cjs');
const { importMap } = require('../../src/main/map-import.cjs');
const { MAX_BYTES } = require('../../src/main/assets.cjs');

function png(marker = 0, padding = 0) {
  const bytes = Buffer.alloc(33 + padding);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(2, 16);
  bytes.writeUInt32BE(3, 20);
  bytes[32] = marker;
  return bytes;
}

function jpeg(width = 2, height = 3) {
  return Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, height, 0, width, 3, 1, 17, 0, 0, 0xff, 0xd9]);
}

const nativeImage = { createFromBuffer: () => ({ isEmpty: () => false, getSize: () => ({ width: 2, height: 3 }) }) };

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'map-import-'));
  const target = path.join(root, 'target');
  const source = path.join(root, 'source');
  const maps = path.join(target, 'data', 'maps');
  fs.mkdirSync(maps, { recursive: true });
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(target, 'project.godot'), 'config_version=5\n');
  const workspaces = new WorkspaceService({ backupRoot: path.join(root, 'backups'), defaultProject: target });
  const session = workspaces.open({ path: maps });
  t.after(() => { workspaces.releaseAll(); fs.rmSync(root, { recursive: true, force: true }); });
  const write = (base, relative, data) => {
    const file = path.join(base, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.isBuffer(data) || typeof data === 'string' ? data : JSON.stringify(data));
    return file;
  };
  const readResource = (ref) => path.join(target, ref.slice(6));
  let captured;
  const saveMap = (payload) => {
    captured = payload;
    write(maps, payload.name, payload.data);
    return { ok: true, written: true, hash: 'saved' };
  };
  const run = (sourcePath, extra = {}) => importMap({ workspaces, id: session.id, sourcePath, nativeImage, saveMap, ...extra });
  return { root, target, source, maps, write, readResource, run, captured: () => captured };
}

test('imports relative dual-view images, preserves map semantics and chooses a fresh JSON name', (t) => {
  const f = fixture(t);
  f.write(f.source, 'tilt.png', png(1));
  f.write(f.source, 'topdown.png', png(2));
  const source = f.write(f.source, 'my.map.json', { width: 10, height: 12, background: { tilt: 'tilt.png', topdown: 'topdown.png', image: '' }, weather: { kind: 'rain' }, render: { box_mode: true } });
  f.write(f.maps, 'my.map.json', { original: true });
  const result = f.run(source);
  assert.equal(result.ok, true, result.errors?.join('\n'));
  assert.equal(result.name, 'my.map_1.json');
  assert.equal(result.hash, 'saved');
  const payload = f.captured();
  assert.equal(payload.expectCreate, true);
  assert.deepEqual(payload.data.weather, { kind: 'rain' });
  assert.deepEqual(payload.data.render, { box_mode: true });
  assert.equal(payload.data.background.image, '');
  assert.notEqual(payload.data.background.tilt, payload.data.background.topdown);
  assert.deepEqual(fs.readFileSync(f.readResource(payload.data.background.tilt)), png(1));
  assert.deepEqual(fs.readFileSync(f.readResource(payload.data.background.topdown)), png(2));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.maps, 'my.map.json'))), { original: true });
});

test('imports JPG background dependencies and keeps the JPG extension in the package', (t) => {
  const f = fixture(t);
  f.write(f.source, 'background.jpeg', jpeg());
  const source = f.write(f.source, 'jpg-map.json', { width: 10, height: 12, background: { image: 'background.jpeg' } });
  const result = f.run(source);
  assert.equal(result.ok, true, result.errors?.join('\n'));
  const ref = f.captured().data.background.image;
  assert.match(ref, /\.jpeg$/);
  assert.deepEqual(fs.readFileSync(f.readResource(ref)), jpeg());
});

test('migrates renderer closure including background, material PNG directories and scatter PNG variants', (t) => {
  const f = fixture(t);
  f.write(f.source, 'project.godot', 'config_version=5\n');
  f.write(f.source, 'assets/tilt.png', png(1));
  f.write(f.source, 'assets/topdown.png', png(2));
  f.write(f.source, 'assets/tiles/base.png', png(3));
  for (const file of ['transition/m000.png', 'cliff/base_v0.png', 'water/m000_f0.png', 'water/m001_f0.png']) f.write(f.source, `assets/${file}`, png(4));
  f.write(f.source, 'assets/water/m000_f0.png.import', '[remap]');
  const weather = { rain: { tint: '#FFFFFF', ground_wet_darken: 0.2, lines_per_screen: 80 } };
  const config = { version: 1, background: { tilt: 'res://assets/tilt.png', topdown: 'res://assets/topdown.png' }, materials: { grass: { textures: ['res://assets/tiles/base.png'], transition: { dirt: 'res://assets/transition/' }, cliff: 'res://assets/cliff/', water: 'res://assets/water/' } }, scatter: { tuft: { variants: ['res://assets/tilt.png', 'res://assets/topdown.png'], density: 0.1 } }, weather };
  f.write(f.source, 'data/render/theme.json', config);
  const source = f.write(f.source, 'data/maps/map.json', { width: 10, height: 12, renderer: 'res://data/render/theme.json', background: { image: 'res://assets/topdown.png' } });
  const result = f.run(source);
  assert.equal(result.ok, true, result.errors?.join('\n'));
  const doc = f.captured().data;
  const rc = JSON.parse(fs.readFileSync(f.readResource(doc.renderer), 'utf8'));
  assert.deepEqual(rc.weather, weather);
  assert.equal(rc.background.topdown, doc.background.image);
  assert.equal(rc.scatter.tuft.variants[0], rc.background.tilt);
  assert.deepEqual(fs.readFileSync(f.readResource(rc.materials.grass.textures[0])), png(3));
  for (const [key, file] of [['cliff', 'base_v0.png'], ['water', 'm000_f0.png']]) assert.ok(fs.existsSync(path.join(f.readResource(rc.materials.grass[key]), file)));
  assert.ok(fs.existsSync(path.join(f.readResource(rc.materials.grass.transition.dirt), 'm000.png')));
  assert.equal(fs.existsSync(path.join(f.readResource(rc.materials.grass.water), 'm000_f0.png.import')), false);
});

test('relative renderer dependencies resolve from the renderer directory and keep empty map background', (t) => {
  const f = fixture(t);
  f.write(f.source, 'render/image.png', png());
  f.write(f.source, 'render/renderer.json', { version: 1, background: { image: 'image.png' } });
  const source = f.write(f.source, 'map.json', { renderer: 'render/renderer.json', background: {} });
  const result = f.run(source);
  assert.equal(result.ok, true, result.errors?.join('\n'));
  assert.deepEqual(f.captured().data.background, {});
  assert.deepEqual(fs.readFileSync(f.readResource(JSON.parse(fs.readFileSync(f.readResource(f.captured().data.renderer))).background.image)), png());
});

test('known display and note fields retain literal resource-like text without being treated as dependencies', (t) => {
  const f = fixture(t);
  const text = { name: 'my.map.json', _note: 'preview image.png', description: 'https://example.com', briefing: 'Visit res://assets/icon.png' };
  f.write(f.source, 'renderer.json', { version: 1, _note: 'preview image.png', name: 'theme.json' });
  const source = f.write(f.source, 'map.json', { ...text, renderer: 'renderer.json' });
  const result = f.run(source);
  assert.equal(result.ok, true, result.errors?.join('\n'));
  for (const [key, value] of Object.entries(text)) assert.equal(f.captured().data[key], value);
  const rc = JSON.parse(fs.readFileSync(f.readResource(f.captured().data.renderer)));
  assert.equal(rc._note, 'preview image.png');
  assert.equal(rc.name, 'theme.json');
});

test('a renderer already in the trusted target retains its reference without creating an asset package', (t) => {
  const f = fixture(t);
  f.write(f.target, 'assets/image.png', png());
  f.write(f.target, 'data/render/theme.json', { version: 1, background: { image: 'res://assets/image.png' } });
  const source = f.write(f.source, 'map.json', { renderer: 'res://data/render/theme.json' });
  const result = f.run(source);
  assert.equal(result.ok, true, result.errors?.join('\n'));
  assert.equal(f.captured().data.renderer, 'res://data/render/theme.json');
  assert.equal(fs.existsSync(path.join(f.maps, '_assets')), false);
});

test('a target renderer with relative resources is migrated to absolute res references', (t) => {
  const f = fixture(t);
  f.write(f.target, 'data/render/image.png', png());
  f.write(f.target, 'data/render/theme.json', { version: 1, background: { image: 'image.png' }, weather: { rain: { tint: '#FFFFFF' } } });
  const source = f.write(f.source, 'map.json', { renderer: 'res://data/render/theme.json' });
  const result = f.run(source);
  assert.equal(result.ok, true, result.errors?.join('\n'));
  assert.notEqual(f.captured().data.renderer, 'res://data/render/theme.json');
  const config = JSON.parse(fs.readFileSync(f.readResource(f.captured().data.renderer)));
  assert.ok(config.background.image.startsWith('res://data/maps/_assets/'));
  assert.deepEqual(fs.readFileSync(f.readResource(config.background.image)), png());
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.target, 'data/render/theme.json'))).background.image, 'image.png');
});

test('a declared missing renderer rejects even when a valid map-level background exists and cleans copied PNGs', (t) => {
  const f = fixture(t);
  f.write(f.source, 'image.png', png());
  const source = f.write(f.source, 'map.json', { background: { image: 'image.png' }, renderer: 'missing.json' });
  const result = f.run(source);
  assert.equal(result.ok, false);
  assert.deepEqual(fs.readdirSync(f.maps), []);
  assert.equal(f.captured(), undefined);
});

test('gate failure removes only the fresh import folder and leaves existing assets and map bytes intact', (t) => {
  const f = fixture(t);
  f.write(f.maps, '_assets/existing.png', png(7));
  f.write(f.maps, 'existing.json', '{ "keep": true }\r\n');
  f.write(f.source, 'image.png', png());
  const source = f.write(f.source, 'map.json', { background: { image: 'image.png' } });
  const result = f.run(source, { saveMap: () => ({ ok: false, errors: ['gate rejected'] }) });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /gate rejected/);
  assert.deepEqual(fs.readdirSync(f.maps).sort(), ['_assets', 'existing.json']);
  assert.deepEqual(fs.readdirSync(path.join(f.maps, '_assets')), ['existing.png']);
  assert.equal(fs.readFileSync(path.join(f.maps, 'existing.json'), 'utf8'), '{ "keep": true }\r\n');
});

test('rejects source traversal, unsupported script dependencies, symlinks and non-PNG directory files', (t) => {
  const f = fixture(t);
  const outside = f.write(f.root, 'outside.png', png());
  const cases = [
    { background: { image: '../outside.png' } },
    { background: { image: 'res://src/evil.png' } },
    { script: 'evil.gd' },
    { unknown: 'assets/unused.png' },
  ];
  for (const doc of cases) {
    const result = f.run(f.write(f.source, 'map.json', doc));
    assert.equal(result.ok, false, JSON.stringify(doc));
    assert.deepEqual(fs.readdirSync(f.maps), []);
  }
  const linked = path.join(f.source, 'linked.png');
  fs.symlinkSync(outside, linked, 'file');
  assert.equal(f.run(f.write(f.source, 'map.json', { background: { image: 'linked.png' } })).ok, false);
  f.write(f.source, 'tiles/m000.png', png());
  f.write(f.source, 'tiles/evil.gd', 'extends Node');
  f.write(f.source, 'renderer.json', { materials: { grass: { textures: ['tiles/m000.png'], cliff: 'tiles/' } } });
  assert.equal(f.run(f.write(f.source, 'map.json', { renderer: 'renderer.json' })).ok, false);
  assert.deepEqual(fs.readdirSync(f.maps), []);
});

test('enforces aggregate 32 MiB across distinct PNGs and cleans partial package copies', (t) => {
  const f = fixture(t);
  f.write(f.source, 'one.png', png(1, MAX_BYTES / 2));
  f.write(f.source, 'two.png', png(2, MAX_BYTES / 2));
  const result = f.run(f.write(f.source, 'map.json', { background: { tilt: 'one.png', topdown: 'two.png' } }));
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /32 MiB/);
  assert.deepEqual(fs.readdirSync(f.maps), []);
});

test('directory imports count actual copied bytes even for identical tile content', (t) => {
  const f = fixture(t);
  const bytes = png(1, MAX_BYTES / 2);
  f.write(f.source, 'tiles/one.png', bytes);
  f.write(f.source, 'tiles/two.png', bytes);
  f.write(f.source, 'renderer.json', { materials: { grass: { textures: ['tiles/one.png'], cliff: 'tiles/' } } });
  const result = f.run(f.write(f.source, 'map.json', { renderer: 'renderer.json' }));
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /32 MiB/);
  assert.deepEqual(fs.readdirSync(f.maps), []);
});

test('independent material resource arrays are subject to the 100000 reference limit', (t) => {
  const f = fixture(t);
  f.write(f.source, 'renderer.json', { materials: { grass: { textures: Array(100001).fill('image.png') } } });
  const result = f.run(f.write(f.source, 'map.json', { renderer: 'renderer.json' }));
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /资源引用过多/);
  assert.deepEqual(fs.readdirSync(f.maps), []);
});

test('cleanup revalidates the selected root before deleting a package after an external link replacement', (t) => {
  const f = fixture(t);
  const protectedDirectory = path.join(f.root, 'protected');
  f.write(protectedDirectory, 'keep.txt', 'protected');
  f.write(f.source, 'image.png', png());
  const source = f.write(f.source, 'map.json', { background: { image: 'image.png' } });
  const result = f.run(source, { saveMap: () => {
    fs.renameSync(path.join(f.maps, '_assets'), path.join(f.root, 'preserved-import'));
    fs.symlinkSync(protectedDirectory, path.join(f.maps, '_assets'), process.platform === 'win32' ? 'junction' : 'dir');
    return { ok: false, errors: ['gate rejected'] };
  } });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /残留需要检查/);
  assert.equal(fs.readFileSync(path.join(protectedDirectory, 'keep.txt'), 'utf8'), 'protected');
  fs.unlinkSync(path.join(f.maps, '_assets'));
});

test('a PNG changed by the decoder before copy is rejected and publishes no map or asset directory', (t) => {
  const f = fixture(t);
  const image = f.write(f.source, 'image.png', png(1));
  const source = f.write(f.source, 'map.json', { background: { image: 'image.png' } });
  let changed = false;
  const changingDecoder = { createFromBuffer() {
    if (!changed) { changed = true; fs.writeFileSync(image, png(2)); }
    return nativeImage.createFromBuffer();
  } };
  const result = f.run(source, { nativeImage: changingDecoder });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /外部修改/);
  assert.deepEqual(fs.readdirSync(f.maps), []);
});
