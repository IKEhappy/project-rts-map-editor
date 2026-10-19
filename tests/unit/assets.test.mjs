import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { WorkspaceService } = require('../../src/main/workspace.cjs');
const assets = require('../../src/main/assets.cjs');

function png(width = 2, height = 3, extraBytes = 0) {
  const output = Buffer.alloc(33 + extraBytes);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(output, 0);
  output.write('IHDR', 12, 'ascii');
  output.writeUInt32BE(width, 16);
  output.writeUInt32BE(height, 20);
  // A decoder is supplied by each test; this fixture is intentionally only a header.
  return output;
}

function jpeg(width = 4, height = 5) {
  const output = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, height, 0, width, 3, 1, 17, 0, 0, 0xff, 0xd9]);
  return output;
}

function decoder(width, height, empty = false) {
  return {
    createFromBuffer() {
      return {
        isEmpty: () => empty,
        getSize: () => ({ width, height }),
        resize: () => ({ toDataURL: () => 'data:image/png;base64,preview' }),
        toDataURL: () => 'data:image/png;base64,preview',
      };
    },
  };
}

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'map-editor-assets-'));
  const maps = path.join(root, 'maps');
  const source = path.join(root, 'source');
  const backups = path.join(root, 'backups');
  fs.mkdirSync(maps);
  fs.mkdirSync(source);
  const workspaces = new WorkspaceService({ backupRoot: backups });
  t.after(() => {
    workspaces.releaseAll();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const session = workspaces.open({ path: maps });
  const write = (directory, relative, bytes) => {
    const full = path.join(directory, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, bytes);
    return full;
  };
  return { root, maps, source, workspaces, session, write };
}

test('pngInfo enforces PNG signature, dimensions, decoded dimensions, size and pixel limits', (t) => {
  const f = setup(t);
  const good = f.write(f.source, 'good.png', png(2, 3));
  assert.deepEqual(assets.pngInfo(good, decoder(2, 3), true), {
    width: 2,
    height: 3,
    size: 33,
    sha256: crypto.createHash('sha256').update(png(2, 3)).digest('hex'),
    dataUrl: 'data:image/png;base64,preview',
  });

  const badSignature = f.write(f.source, 'signature.png', Buffer.alloc(33));
  assert.throws(() => assets.pngInfo(badSignature, decoder(2, 3)), /PNG 文件头无效/);
  const mismatch = f.write(f.source, 'mismatch.png', png(2, 3));
  assert.throws(() => assets.pngInfo(mismatch, decoder(3, 2)), /尺寸不一致/);
  const empty = f.write(f.source, 'empty.png', png(2, 3));
  assert.throws(() => assets.pngInfo(empty, decoder(2, 3, true)), /解码失败/);
  const hugePixels = f.write(f.source, 'pixels.png', png(16384, 16384));
  assert.throws(() => assets.pngInfo(hugePixels, decoder(16384, 16384)), /总像素/);
  const tooLarge = f.write(f.source, 'size.png', png(2, 3, assets.MAX_BYTES));
  assert.throws(() => assets.pngInfo(tooLarge, decoder(2, 3)), /32 MiB/);
});

test('imageInfo accepts JPG/JPEG dimensions and importImage retains the source extension', (t) => {
  const f = setup(t);
  const bytes = jpeg(4, 5);
  const source = f.write(f.source, 'view.jpg', bytes);
  assert.deepEqual(assets.imageInfo(source, decoder(4, 5)), { width: 4, height: 5, size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
  const result = assets.importImage(f.workspaces, f.session.id, { mapId: 'jpg-map', view: 'image', sourcePath: source }, decoder(4, 5));
  assert.equal(result.ok, true);
  assert.match(result.path, /\/image-[a-f0-9]{20}\.jpg$/);
  assert.deepEqual(fs.readFileSync(f.workspaces.file(f.session.id, result.path.slice(f.session.resPrefix.length))), bytes);
});

test('backgroundInfo gives a valid map background precedence over renderer config and reports missing views', (t) => {
  const f = setup(t);
  const renderer = f.write(f.maps, 'renderer.json', JSON.stringify({ background: { tilt: 'res://data/maps/renderer.png' }, materials: { snow: { water: 'res://assets/water_ice/' } } }));
  f.write(f.maps, 'renderer.png', png(8, 8));
  f.write(f.maps, 'map.png', png(2, 3));
  const map = {
    renderer: 'res://data/maps/renderer.json',
    background: { topdown: 'res://data/maps/map.png', unknown: 'res://data/maps/map.png' },
  };
  const result = assets.backgroundInfo(f.workspaces, f.session.id, map, decoder(2, 3));
  assert.equal(result.source, 'map');
  assert.equal(result.ok, false, 'unknown key is a schema error');
  assert.equal(result.images.topdown.width, 2);
  assert.equal(result.images.tilt, undefined, 'map block is whole-block precedence; renderer tilt is not merged');
  assert.deepEqual(result.renderConfig, { materials: { snow: { water: 'res://assets/water_ice/' } } }, 'map background precedence does not hide renderer metadata');
  assert.match(result.errors.join('\n'), /未知 background 字段/);
  assert.equal(fs.existsSync(renderer), true);
});

test('backgroundInfo exposes only typed render fields and permitted resource paths', (t) => {
  const f = setup(t);
  f.write(f.maps, 'renderer.json', JSON.stringify({
    version: 1,
    private_notes: 'must not reach the renderer',
    scripts: ['res://scripts/unsafe.gd'],
    materials: {
      snow: {
        textures: ['res://assets/snow.png', 'file:///private.txt', 'res://data/../private.txt', 42],
        cliff: 'res://assets/cliff_snow/',
        water: 'res://assets/water_ice/',
        transition: { grass: 'res://assets/snow/t_grass/', secret: 'private file contents' },
        private_notes: 'material secret',
      },
      malformed: 'material must be an object',
    },
    scatter: {
      grass: { kind: 'grass_tuft', density: 0.08, materials_on: ['snow', 2], hash_salt: 101, variants: 3, hide_when_snow: true, private_notes: 'scatter secret' },
      malformed: [],
    },
    weather: { rain: { tint: '#112233' }, snow: { tint: '#ffffff' }, river: {}, reflection: {}, malformed: 'secret' },
  }));
  const result = assets.backgroundInfo(f.workspaces, f.session.id, { renderer: 'res://data/maps/renderer.json' }, decoder(2, 3));
  assert.equal(result.ok, true);
  assert.equal(result.source, 'none');
  assert.deepEqual(result.renderConfig, {
    materials: { snow: { textures: ['res://assets/snow.png'], cliff: 'res://assets/cliff_snow/', water: 'res://assets/water_ice/', transition: { grass: 'res://assets/snow/t_grass/' } } },
    scatter: { grass: { kind: 'grass_tuft', density: 0.08, materials_on: ['snow'], hash_salt: 101, variants: 3, hide_when_snow: true } },
    weather: ['rain', 'snow'],
  });
  assert.doesNotMatch(JSON.stringify(result), /private|secret|scripts|unsafe/);
});

test('backgroundInfo keeps an absent renderer empty and cannot become a generic JSON read', (t) => {
  const f = setup(t);
  const absent = assets.backgroundInfo(f.workspaces, f.session.id, {}, decoder(2, 3));
  assert.equal(absent.ok, true);
  assert.equal(absent.renderConfig, undefined, 'no implicit default.json renderer exists in the game');
  f.write(f.maps, 'unrelated.json', JSON.stringify({ password: 'private-content', nested: { data: 'private-content' } }));
  const unrelated = assets.backgroundInfo(f.workspaces, f.session.id, { renderer: 'res://data/maps/unrelated.json' }, decoder(2, 3));
  assert.deepEqual(unrelated.renderConfig, {});
  assert.doesNotMatch(JSON.stringify(unrelated), /password|private-content|nested/);
});

test('renderer metadata failures remain visible even with an explicit usable map background', (t) => {
  const f = setup(t);
  f.write(f.maps, 'map.png', png(2, 3));
  f.write(f.maps, 'bad.json', '{invalid JSON');
  f.write(f.maps, 'large.json', Buffer.alloc(assets.MAX_BYTES + 1, 32));
  for (const ref of ['file:///outside.json', 'res://scripts/outside.json', 'res://data/maps/../outside.json', 'res://data/maps/missing.json', 'res://data/maps/bad.json', 'res://data/maps/large.json']) {
    const result = assets.backgroundInfo(f.workspaces, f.session.id, { renderer: ref, background: { image: 'res://data/maps/map.png' } }, decoder(2, 3));
    assert.equal(result.ok, false, ref);
    assert.equal(result.source, 'map');
    assert.equal(result.images.image.width, 2);
    assert.equal(result.renderConfig, undefined);
    assert.match(result.errors.join('\n'), /renderer：/);
  }
});

test('renderer background is used only when map background is absent, and empty renderer background is a valid no-image result', (t) => {
  const f = setup(t);
  f.write(f.maps, 'renderer.json', JSON.stringify({ background: { tilt: 'res://data/maps/renderer.png' } }));
  f.write(f.maps, 'renderer.png', png(8, 8));
  const rendererResult = assets.backgroundInfo(f.workspaces, f.session.id, { renderer: 'res://data/maps/renderer.json' }, decoder(8, 8));
  assert.equal(rendererResult.source, 'renderer');
  assert.equal(rendererResult.ok, true);
  assert.equal(rendererResult.images.tilt.width, 8);

  f.write(f.maps, 'empty-renderer.json', JSON.stringify({ background: {} }));
  const emptyResult = assets.backgroundInfo(f.workspaces, f.session.id, { renderer: 'res://data/maps/empty-renderer.json' }, decoder(8, 8));
  assert.equal(emptyResult.source, 'none', 'an empty renderer background does not force whole-image mode');
  assert.equal(emptyResult.ok, true);
  assert.deepEqual(emptyResult.images, {});
});

test('resourceFile accepts only whitelisted res paths and maps workspace resPrefix to the selected folder', (t) => {
  const f = setup(t);
  f.write(f.maps, 'inside.json', '{}');
  assert.equal(assets.resourceFile(f.workspaces, f.session.id, 'res://data/maps/inside.json', '.json'), path.join(f.maps, 'inside.json'));
  for (const ref of ['file:///outside.json', 'res://user/x.json', 'res://data/maps/../outside.json', 'res://data/maps/no.json']) {
    assert.throws(() => assets.resourceFile(f.workspaces, f.session.id, ref, '.json'), /资源|outside|does not exist|Invalid/);
  }
});

test('renderer fallback reads trusted project resources while map block prevents fallback for malformed declarations', (t) => {
  const f = setup(t);
  const project = path.join(f.root, 'project');
  f.write(project, 'project.godot', 'config_version=5\n');
  f.write(project, 'data/render/shared.json', JSON.stringify({ background: { image: 'res://assets/shared.png' } }));
  f.write(project, 'assets/shared.png', png(8, 9));
  f.workspaces.releaseAll();
  const workspaces = new WorkspaceService({ backupRoot: path.join(f.root, 'other-backups'), defaultProject: project });
  t.after(() => workspaces.releaseAll());
  const session = workspaces.open({ path: f.maps });
  const valid = assets.backgroundInfo(workspaces, session.id, { renderer: 'res://data/render/shared.json' }, decoder(8, 9));
  assert.equal(valid.ok, true);
  assert.equal(valid.source, 'renderer');
  assert.equal(valid.images.image.height, 9);
  const malformed = assets.backgroundInfo(workspaces, session.id, { renderer: 'res://data/render/shared.json', background: ['bad'] }, decoder(8, 9));
  assert.equal(malformed.ok, false);
  assert.equal(malformed.source, 'map');
  assert.deepEqual(malformed.images, {}, 'a malformed explicit map block never falls through to renderer');
});

test('background byte budget counts distinct images and deduplicates shared view files', (t) => {
  const f = setup(t);
  const largeA = png(1, 1, 17 * 1024 * 1024);
  const largeB = png(1, 1, 17 * 1024 * 1024);
  largeB[largeB.length - 1] = 1;
  f.write(f.maps, 'a.png', largeA);
  f.write(f.maps, 'b.png', largeB);
  const distinct = assets.backgroundInfo(f.workspaces, f.session.id, { background: { tilt: 'res://data/maps/a.png', topdown: 'res://data/maps/b.png' } }, decoder(1, 1), false);
  assert.equal(distinct.ok, false);
  assert.match(distinct.errors.join('\n'), /合计超过 32 MiB/);
  const shared = assets.backgroundInfo(f.workspaces, f.session.id, { background: { tilt: 'res://data/maps/a.png', topdown: 'res://data/maps/a.png' } }, decoder(1, 1), false);
  assert.equal(shared.ok, true, 'two references to identical content count once');
});

test('readJson rejects non-object roots, BOM and oversized external JSON', (t) => {
  const f = setup(t);
  for (const [name, text] of [['array.json', '[]'], ['null.json', 'null'], ['bom.json', '\ufeff{}']]) {
    const full = f.write(f.source, name, text);
    assert.throws(() => assets.readJson(full), /对象|控制字符/);
  }
  const full = f.write(f.source, 'large.json', Buffer.alloc(assets.MAX_BYTES + 1, 32));
  assert.throws(() => assets.readJson(full), /32 MiB/);
});

test('importImage hashes content into a workspace-local _assets path and deduplicates imports', (t) => {
  const f = setup(t);
  const bytes = png(4, 5);
  const source = f.write(f.source, 'view.png', bytes);
  const first = assets.importImage(f.workspaces, f.session.id, { mapId: '湖/地图', view: 'topdown', sourcePath: source }, decoder(4, 5));
  assert.equal(first.ok, true);
  assert.match(first.path, /^res:\/\/data\/maps\/_assets\/湖_地图\/topdown-[a-f0-9]{20}\.png$/);
  const relative = first.path.slice(f.session.resPrefix.length);
  const destination = f.workspaces.file(f.session.id, relative, { mustExist: true });
  assert.deepEqual(fs.readFileSync(destination), bytes);
  const second = assets.importImage(f.workspaces, f.session.id, { mapId: '湖/地图', view: 'topdown', sourcePath: source }, decoder(4, 5));
  assert.equal(second.path, first.path);
  assert.deepEqual(f.workspaces.compare(f.session.id).counts, { added: 3, removed: 0, changed: 0, unchanged: 0 });
});

test('importImage rejects non-PNG and source links before writing the workspace', (t) => {
  const f = setup(t);
  const text = f.write(f.source, 'text.txt', 'not an image');
  assert.throws(() => assets.importImage(f.workspaces, f.session.id, { mapId: 'map', view: 'tilt', sourcePath: text }, decoder(1, 1)), /PNG/);
  const outside = path.join(f.root, 'outside.png');
  fs.writeFileSync(outside, png(2, 2));
  fs.symlinkSync(outside, path.join(f.source, 'linked.png'), process.platform === 'win32' ? 'file' : undefined);
  assert.throws(() => assets.importImage(f.workspaces, f.session.id, { mapId: 'map', view: 'tilt', sourcePath: path.join(f.source, 'linked.png') }, decoder(2, 2)), /符号链接|联接/);
  assert.deepEqual(fs.readdirSync(f.maps), []);
});

test('importImage verifies the copied source bytes before publishing their hash-derived file name', (t) => {
  const f = setup(t);
  const source = f.write(f.source, 'changing.png', png(2, 2));
  const fake = decoder(2, 2);
  const normalDecode = fake.createFromBuffer;
  fake.createFromBuffer = (bytes) => {
    fs.writeFileSync(source, 'source changed while being decoded');
    return normalDecode(bytes);
  };
  assert.throws(() => assets.importImage(f.workspaces, f.session.id, { mapId: 'map', view: 'tilt', sourcePath: source }, fake), /changed|变化|修改|不一致|冲突/);
  const published = f.workspaces.compare(f.session.id).entries.filter((entry) => entry.kind === 'file');
  assert.deepEqual(published, [], 'a changed source cannot leave an imported image in maps');
});

test('backgroundInfo rejects malformed JSON and invalid resource references without touching map files', (t) => {
  const f = setup(t);
  f.write(f.maps, 'bad.json', Buffer.from([0, 1, 2]));
  assert.throws(() => assets.readJson(path.join(f.maps, 'bad.json')), /控制字符/);
  const result = assets.backgroundInfo(f.workspaces, f.session.id, { background: { image: 'res://data/maps/missing.png' } }, decoder(2, 2));
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /不可用|不存在|does not exist/);
  assert.equal(fs.existsSync(path.join(f.maps, 'missing.png')), false);
});
