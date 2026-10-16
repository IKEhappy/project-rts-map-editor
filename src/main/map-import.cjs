'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assets = require('./assets.cjs');

const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const serialize = (data) => `${JSON.stringify(data, null, 2)}\n`;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const sameFile = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

function safeRelative(value, directory = false) {
  const relative = directory && typeof value === 'string' ? value.replace(/\/$/, '') : value;
  if (typeof relative !== 'string' || !relative || /[\\\x00-\x1f\x7f:]/.test(relative)
      || relative.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('导入资源路径非法');
  return relative;
}

function regularDirectory(root, relative) {
  const safe = safeRelative(relative, true);
  let current = path.parse(path.resolve(root)).root;
  for (const part of path.relative(current, path.resolve(root)).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('资源父目录不能为符号链接或目录联接');
  }
  for (const part of safe.split('/')) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('资源不能为符号链接或目录联接');
  }
  if (!fs.statSync(current).isDirectory()) throw new Error('资源目录不存在');
  return fs.realpathSync(current);
}

function projectOf(file) {
  let current = path.dirname(file);
  while (!fs.existsSync(path.join(current, 'project.godot'))) {
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return current;
}

function readDocument(file) {
  if (fs.statSync(file).size > assets.MAX_BYTES) throw new Error('JSON 超过 32 MiB 上限');
  const before = fs.readFileSync(file);
  const data = assets.readJson(file);
  if (!before.equals(fs.readFileSync(file))) throw new Error('读取期间源 JSON 被外部修改');
  return { data, size: before.length };
}

function auditDependencies(value, allowed, field = 'root') {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => auditDependencies(entry, allowed, `${field}[${index}]`));
  } else if (object(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (/^(?:script|script_path|shader|shader_path|scene|scene_path)$/i.test(key)) throw new Error(`导入不支持可执行资源字段：${field}.${key}`);
      if (typeof entry === 'string' && (key === '_note' || /^(?:name|description|title|label|briefing|hint|text)$/.test(key))) continue;
      auditDependencies(entry, allowed, `${field}.${key}`);
    }
  } else if (typeof value === 'string' && !allowed.has(value)
      && (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || /\.(?:png|json|gd|gdc|tscn|scn|tres|res|gdshader|svg|jpg|jpeg|webp|zip)\/?$/i.test(value))) {
    throw new Error(`未支持的外部资源字段：${field}`);
  }
}

function hasRelativeResources(rc) {
  const refs = [];
  if (object(rc.background)) refs.push(...Object.values(rc.background));
  if (object(rc.materials)) for (const material of Object.values(rc.materials)) {
    if (!object(material)) continue;
    if (Array.isArray(material.textures)) refs.push(...material.textures);
    if (object(material.transition)) refs.push(...Object.values(material.transition));
    refs.push(material.cliff, material.water);
  }
  if (object(rc.scatter)) for (const item of Object.values(rc.scatter)) {
    if (!object(item)) continue;
    for (const key of ['textures', 'variants']) if (Array.isArray(item[key])) refs.push(...item[key]);
    refs.push(item.texture);
  }
  return refs.some((ref) => typeof ref === 'string' && ref !== '' && !ref.startsWith('res://'));
}

function importMap({ workspaces, id, sourcePath, nativeImage, saveMap }) {
  let folder;
  let relativeFolder;
  let assetsRoot;
  let hadAssetsRoot;
  try {
    const ws = workspaces.current(id);
    const absolute = path.resolve(String(sourcePath || ''));
    if (path.extname(absolute).toLowerCase() !== '.json') throw new Error('仅支持地图 JSON');
    const source = assets.regularFile(path.dirname(absolute), path.basename(absolute));
    const sourceProject = projectOf(source);
    const document = readDocument(source);
    const doc = document.data;
    relativeFolder = `_assets/import-${crypto.randomUUID()}`;
    folder = workspaces.file(id, relativeFolder);
    assetsRoot = workspaces.file(id, '_assets');
    hadAssetsRoot = fs.existsSync(assetsRoot);
    const prefix = ws.resPrefix.replace(/\/?$/, '/');
    const allowed = new Set();
    const copied = new Map();
    const directories = new Map();
    const counted = new Set();
    const published = new Set(['_assets', relativeFolder]);
    let directoryEntries = 0;
    let resourceReferences = 0;
    let totalBytes = document.size;
    const reference = () => {
      resourceReferences += 1;
      if (resourceReferences > 100000) throw new Error('导入资源引用过多');
    };
    const referenceArray = (items) => {
      if (items.length > 100000 - resourceReferences) throw new Error('导入资源引用过多');
      return items;
    };
    const publishPath = (relative) => {
      const parts = relative.split('/');
      for (let index = 1; index <= parts.length; index += 1) published.add(parts.slice(0, index).join('/'));
      if (published.size > 99999) throw new Error('导入文件和目录过多');
    };
    const budget = (bytes) => {
      totalBytes += bytes;
      if (totalBytes > assets.MAX_BYTES) throw new Error('地图、renderer 与图片合计超过 32 MiB');
    };
    const resource = (relative) => {
      const ref = `${prefix}${relativeFolder}/${relative}`;
      allowed.add(ref);
      return ref;
    };
    const locate = (ref, base, directory = false) => {
      if (typeof ref !== 'string' || !ref) throw new Error('资源引用必须为非空路径');
      const resolve = directory ? regularDirectory : assets.regularFile;
      if (ref.startsWith('res://')) {
        const relative = safeRelative(ref.slice(6), directory);
        if (!(relative.startsWith('data/') || relative.startsWith('assets/'))) throw new Error('res 资源只允许位于 data/ 或 assets/');
        if (sourceProject) return resolve(sourceProject, relative);
        if (ref.startsWith(prefix)) {
          const selected = workspaces.file(id, safeRelative(ref.slice(prefix.length), directory), { mustExist: true });
          return directory ? regularDirectory(path.dirname(selected), path.basename(selected)) : assets.regularFile(path.dirname(selected), path.basename(selected));
        }
        if (!ws.projectRoot) throw new Error(`无法定位源工程资源：${ref}`);
        return resolve(ws.projectRoot, relative);
      }
      return resolve(base, safeRelative(ref, directory));
    };
    const copyPng = (file, relative, publish, checkedInfo) => {
      if (path.extname(file).toLowerCase() !== '.png') throw new Error('导入依赖仅支持 PNG 图片');
      const info = checkedInfo || assets.pngInfo(file, nativeImage);
      if (publish || !counted.has(info.sha256)) budget(info.size);
      counted.add(info.sha256);
      if (!publish) return;
      publishPath(`${relativeFolder}/${relative}`);
      const destination = workspaces.file(id, `${relativeFolder}/${relative}`);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(file, destination, fs.constants.COPYFILE_EXCL);
      if (digest(fs.readFileSync(destination)) !== info.sha256) throw new Error('复制期间源图片被外部修改');
      return info;
    };
    const image = (ref, base, publish = true) => {
      reference();
      const file = locate(ref, base);
      if (!publish) { copyPng(file, '', false); allowed.add(ref); return ref; }
      const info = assets.pngInfo(file, nativeImage);
      if (!copied.has(info.sha256)) {
        const relative = `${info.sha256}.png`;
        copyPng(file, relative, true, info);
        copied.set(info.sha256, resource(relative));
      }
      return copied.get(info.sha256);
    };
    const directory = (ref, base, publish = true) => {
      reference();
      const sourceDirectory = locate(ref, base, true);
      const key = `${publish}:${sourceDirectory}`;
      if (directories.has(key)) return directories.get(key);
      const relativeDirectory = `tiles-${crypto.randomUUID()}`;
      let fileCount = 0;
      const walk = (current, relative = '') => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
          directoryEntries += 1;
          if (directoryEntries > 100000) throw new Error('导入资源文件和目录过多');
          const full = path.join(current, entry.name);
          const stat = fs.lstatSync(full);
          if (stat.isSymbolicLink()) throw new Error('资源不能为符号链接或目录联接');
          const child = relative ? `${relative}/${entry.name}` : entry.name;
          safeRelative(child);
          if (stat.isDirectory()) walk(full, child);
          else if (stat.isFile() && entry.name.endsWith('.png.import')) continue;
          else if (stat.isFile() && path.extname(entry.name).toLowerCase() === '.png') {
            fileCount += 1;
            if (fileCount > 100000) throw new Error('导入资源文件过多');
            copyPng(assets.regularFile(sourceDirectory, child), `${relativeDirectory}/${child}`, publish);
          } else throw new Error(`资源目录包含不支持的非 PNG 文件：${child}`);
        }
      };
      walk(sourceDirectory);
      if (!fileCount) throw new Error('资源目录不包含 PNG 图片');
      const result = publish ? `${resource(relativeDirectory)}/` : ref;
      allowed.add(result);
      directories.set(key, result);
      return result;
    };
    const background = (node, base, publish = true) => {
      if (node == null) return node;
      if (!object(node)) throw new Error('background 必须为对象');
      for (const [view, ref] of Object.entries(node)) {
        if (!assets.VIEWS.includes(view) || typeof ref !== 'string') throw new Error(`非法 background 字段：${view}`);
        if (ref) node[view] = image(ref, base, publish);
      }
      return node;
    };
    if (Object.hasOwn(doc, 'background')) doc.background = background(doc.background, path.dirname(source));
    if (doc.renderer !== undefined && doc.renderer !== '') {
      if (typeof doc.renderer !== 'string') throw new Error('renderer 必须为路径字符串');
      const renderer = locate(doc.renderer, path.dirname(source));
      if (path.extname(renderer).toLowerCase() !== '.json') throw new Error('renderer 必须为 JSON');
      let target;
      try { target = assets.resourceFile(workspaces, id, doc.renderer, '.json'); } catch { /* External renderer needs migration. */ }
      const rc = readDocument(renderer).data;
      const publish = !target || !sameFile(renderer, target) || hasRelativeResources(rc);
      const base = path.dirname(renderer);
      if (Object.hasOwn(rc, 'background')) rc.background = background(rc.background, base, publish);
      if (rc.materials !== undefined) {
        if (!object(rc.materials)) throw new Error('renderer.materials 必须为对象');
        for (const material of Object.values(rc.materials)) {
          if (!object(material) || !Array.isArray(material.textures)) throw new Error('材质 textures 必须为数组');
          material.textures = referenceArray(material.textures).map((ref) => image(ref, base, publish));
          if (material.transition !== undefined) {
            if (!object(material.transition)) throw new Error('材质 transition 必须为对象');
            for (const [key, ref] of Object.entries(material.transition)) material.transition[key] = directory(ref, base, publish);
          }
          for (const key of ['cliff', 'water']) if (material[key]) material[key] = directory(material[key], base, publish);
        }
      }
      if (rc.scatter !== undefined) {
        if (!object(rc.scatter)) throw new Error('renderer.scatter 必须为对象');
        for (const item of Object.values(rc.scatter)) {
          if (!object(item)) throw new Error('scatter 定义必须为对象');
          for (const key of ['textures', 'variants']) if (Array.isArray(item[key])) item[key] = referenceArray(item[key]).map((ref) => image(ref, base, publish));
          if (typeof item.texture === 'string' && item.texture) item.texture = image(item.texture, base, publish);
        }
      }
      auditDependencies(rc, allowed, 'renderer');
      const text = serialize(rc);
      budget(Buffer.byteLength(text));
      if (publish) {
        publishPath(`${relativeFolder}/renderer.json`);
        fs.mkdirSync(folder, { recursive: true });
        fs.writeFileSync(workspaces.file(id, `${relativeFolder}/renderer.json`), text, { encoding: 'utf8', flag: 'wx' });
        doc.renderer = resource('renderer.json');
      } else allowed.add(doc.renderer);
    }
    auditDependencies(doc, allowed, 'map');
    budget(Buffer.byteLength(serialize(doc)) - document.size);
    const baseName = path.basename(source, path.extname(source)).replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, '_').replace(/\.{2,}/g, '_').replace(/^\.+/, '') || 'imported_map';
    let name = `${baseName}.json`;
    for (let index = 1; fs.existsSync(workspaces.file(id, name)); index += 1) name = `${baseName}_${index}.json`;
    const result = saveMap({ name, data: doc, baseHash: '', workspaceId: id, expectCreate: true });
    if (!result || !result.ok) throw new Error((result?.errors || ['地图导入失败']).join('\n'));
    folder = null;
    return { ...result, ok: true, name };
  } catch (error) {
    const errors = [String(error?.message || error)];
    try {
      if (folder) {
        const safeFolder = workspaces.file(id, relativeFolder);
        if (!sameFile(path.resolve(safeFolder), path.resolve(folder))) throw new Error('导入清理路径已变化');
        if (fs.existsSync(safeFolder)) fs.rmSync(safeFolder, { recursive: true, force: true });
      }
      if (!hadAssetsRoot && assetsRoot) {
        const safeRoot = workspaces.file(id, '_assets');
        if (!sameFile(path.resolve(safeRoot), path.resolve(assetsRoot))) throw new Error('资源清理路径已变化');
        if (fs.existsSync(safeRoot) && fs.readdirSync(safeRoot).length === 0) fs.rmdirSync(safeRoot);
      }
    } catch (cleanup) { errors.push(`导入残留需要检查：${cleanup.message}`); }
    return { ok: false, errors };
  }
}

module.exports = { importMap };
