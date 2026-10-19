'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_BYTES = 32 * 1024 * 1024;
const MAX_PIXELS = 64 * 1024 * 1024;
const VIEWS = ['tilt', 'topdown', 'image'];
const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');
const JPEG_SIGNATURE = Buffer.from('ffd8', 'hex');
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg'];

function regularFile(root, relative) {
  if (typeof relative !== 'string' || !relative || /[\\\x00-\x1f:]/.test(relative)
      || relative.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('资源路径非法');
  let ancestor = path.parse(path.resolve(root)).root;
  for (const part of path.relative(ancestor, path.resolve(root)).split(path.sep).filter(Boolean)) {
    ancestor = path.join(ancestor, part);
    if (fs.lstatSync(ancestor).isSymbolicLink()) throw new Error('资源父目录不能为符号链接或目录联接');
  }
  const realRoot = fs.realpathSync(root);
  let current = realRoot;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`资源不能为符号链接或目录联接：${relative}`);
  }
  const real = fs.realpathSync(current);
  const rel = path.relative(realRoot, real);
  if (rel.startsWith('..') || path.isAbsolute(rel) || !fs.statSync(real).isFile()) throw new Error('资源超出允许目录');
  return real;
}

function resourceFile(workspaces, id, resource, extension) {
  const ws = workspaces.current(id);
  if (typeof resource !== 'string' || !resource.startsWith('res://') || !resource.toLowerCase().endsWith(extension)) {
    throw new Error(`资源必须为 res:// 路径且扩展名为 ${extension}`);
  }
  const relative = resource.slice(6);
  if (!(relative.startsWith('data/') || relative.startsWith('assets/'))) throw new Error('资源只允许位于 data/ 或 assets/');
  const prefix = ws.resPrefix.replace(/\/?$/, '/');
  if (resource.startsWith(prefix)) return workspaces.file(id, resource.slice(prefix.length), { mustExist: true });
  return regularFile(ws.projectRoot, relative);
}

function readJson(file) {
  if (fs.statSync(file).size > MAX_BYTES) throw new Error('JSON 超过 32 MiB 上限');
  const raw = fs.readFileSync(file, 'utf8');
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\ufeff\ufffe\uffff]/.test(raw)) throw new Error('JSON 含非法控制字符');
  const value = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('JSON 根节点必须为对象');
  return value;
}

function jpegDimensions(bytes) {
  if (bytes.length < 4 || !bytes.subarray(0, 2).equals(JPEG_SIGNATURE)) throw new Error('JPEG 文件头无效');
  let offset = 2;
  while (offset < bytes.length) {
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) break;
    const marker = bytes[offset++];
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) break;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) break;
    const sof = (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7)
      || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf);
    if (sof) {
      if (length < 7) break;
      return { width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3) };
    }
    offset += length;
  }
  throw new Error('JPEG 尺寸信息无效');
}

function imageInfo(file, nativeImage, preview = false) {
  const stat = fs.lstatSync(file);
  const extension = path.extname(file).toLowerCase();
  if (!IMAGE_EXTENSIONS.includes(extension)) throw new Error('图片仅支持 PNG、JPG 或 JPEG');
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_BYTES) throw new Error('图片必须为普通 PNG/JPG/JPEG 文件且不超过 32 MiB');
  const bytes = fs.readFileSync(file);
  let width;
  let height;
  if (extension === '.png') {
    if (bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.toString('ascii', 12, 16) !== 'IHDR') throw new Error('PNG 文件头无效');
    width = bytes.readUInt32BE(16);
    height = bytes.readUInt32BE(20);
  } else {
    ({ width, height } = jpegDimensions(bytes));
  }
  if (!width || !height || width > 16384 || height > 16384 || width * height > MAX_PIXELS) throw new Error('图片尺寸超限（单边 16384、总像素 64M）');
  const decoded = nativeImage.createFromBuffer(bytes);
  if (decoded.isEmpty()) throw new Error(`${extension === '.png' ? 'PNG' : 'JPEG'} 解码失败`);
  const actual = decoded.getSize();
  if (actual.width !== width || actual.height !== height) throw new Error(`${extension === '.png' ? 'PNG' : 'JPEG'} 尺寸不一致`);
  const result = { width, height, size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  if (preview) {
    const ratio = Math.min(1, 2048 / width, 2048 / height);
    result.dataUrl = (ratio < 1 ? decoded.resize({ width: Math.max(1, Math.round(width * ratio)), height: Math.max(1, Math.round(height * ratio)), quality: 'good' }) : decoded).toDataURL();
  }
  return result;
}

function pngInfo(file, nativeImage, preview = false) {
  if (path.extname(file).toLowerCase() !== '.png') throw new Error('仅支持 PNG 图片');
  return imageInfo(file, nativeImage, preview);
}

function imageResourceFile(workspaces, id, resource) {
  const extension = path.extname(String(resource || '')).toLowerCase();
  if (!IMAGE_EXTENSIONS.includes(extension)) throw new Error('资源必须为 PNG、JPG 或 JPEG 路径');
  return resourceFile(workspaces, id, resource, extension);
}

// Hover metadata is a projection of the render schema, never a generic JSON
// read API. In particular, do not return notes, unrelated objects or texture
// bytes from the resource selected by the map's renderer reference.
function renderConfigSummary(config) {
  const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const resource = (value) => {
    if (typeof value !== 'string' || !/^res:\/\/(data|assets)\//.test(value)) return false;
    const relative = value.slice(6).replace(/\/$/, '');
    return !/[\\\x00-\x1f:]/.test(relative) && !relative.split('/').some((part) => !part || part === '.' || part === '..');
  };
  const result = {};
  if (object(config.materials)) {
    result.materials = Object.fromEntries(Object.entries(config.materials).filter(([, value]) => object(value)).map(([key, value]) => {
      const material = {};
      if (Array.isArray(value.textures)) material.textures = value.textures.filter(resource);
      for (const field of ['cliff', 'water']) if (resource(value[field])) material[field] = value[field];
      if (object(value.transition)) material.transition = Object.fromEntries(Object.entries(value.transition).filter(([, ref]) => resource(ref)));
      return [key, material];
    }));
  }
  if (object(config.scatter)) {
    result.scatter = Object.fromEntries(Object.entries(config.scatter).filter(([, value]) => object(value)).map(([key, value]) => {
      const scatter = {};
      if (typeof value.kind === 'string') scatter.kind = value.kind;
      if (Array.isArray(value.materials_on)) scatter.materials_on = value.materials_on.filter((entry) => typeof entry === 'string');
      for (const field of ['density', 'hash_salt', 'variants']) if (typeof value[field] === 'number' && Number.isFinite(value[field])) scatter[field] = value[field];
      if (typeof value.hide_when_snow === 'boolean') scatter.hide_when_snow = value.hide_when_snow;
      return [key, scatter];
    }));
  }
  // Other weather names are reserved by the game and have no visual effect.
  if (object(config.weather)) result.weather = ['rain', 'snow'].filter((kind) => object(config.weather[kind]));
  return result;
}

function backgroundInfo(workspaces, id, doc, nativeImage, preview = true) {
  workspaces.current(id);
  const result = { ok: true, source: 'none', background: {}, images: {}, errors: [] };
  let renderer;
  // The game treats an absent renderer as a legal empty configuration; it
  // does not implicitly load data/render/default.json.
  if (doc.renderer) {
    try {
      renderer = readJson(resourceFile(workspaces, id, doc.renderer, '.json'));
      result.renderConfig = renderConfigSummary(renderer);
    } catch (error) { result.errors.push(`renderer：${error.message}`); }
  }
  let source = doc.background;
  if (source != null && (typeof source !== 'object' || Array.isArray(source))) {
    result.errors.push('background 必须为对象');
    result.source = 'map';
  } else if (source && Object.keys(source).length) result.source = 'map';
  else if (renderer) {
    source = renderer.background;
    if (source && typeof source === 'object' && !Array.isArray(source) && Object.keys(source).length === 0) source = null;
    if (source != null) result.source = 'renderer';
  }
  if (source != null) {
    if (typeof source !== 'object' || Array.isArray(source)) result.errors.push('整图配置必须为对象');
    else {
      for (const key of Object.keys(source)) if (!VIEWS.includes(key)) result.errors.push(`未知 background 字段：${key}`);
      let totalBytes = Buffer.byteLength(JSON.stringify(doc), 'utf8');
      const counted = new Set();
      for (const view of VIEWS) {
        const ref = source[view];
        if (ref === undefined || ref === '') continue;
        if (typeof ref !== 'string') { result.errors.push(`background.${view} 必须为路径字符串`); continue; }
        result.background[view] = ref;
        try {
          const info = imageInfo(imageResourceFile(workspaces, id, ref), nativeImage, preview);
          if (!counted.has(info.sha256)) { totalBytes += info.size; counted.add(info.sha256); }
          result.images[view] = { path: ref, ...info };
        }
        catch (error) {
          result.images[view] = { path: ref, error: error.message };
          result.errors.push(`${view}：${error.message}`);
        }
      }
      if (totalBytes > MAX_BYTES) result.errors.push('地图与整图资源合计超过 32 MiB');
      if (result.source !== 'none' && !VIEWS.some((view) => result.images[view] && !result.images[view].error)) result.errors.push('整图声明没有可用图片');
    }
  }
  result.ok = result.errors.length === 0;
  return result;
}

function importImage(workspaces, id, { mapId, view, sourcePath }, nativeImage) {
  if (!VIEWS.includes(view)) throw new Error('未知图片视角');
  const ws = workspaces.current(id);
  const source = path.resolve(String(sourcePath || ''));
  const extension = path.extname(source).toLowerCase();
  if (!IMAGE_EXTENSIONS.includes(extension)) throw new Error('仅支持 PNG、JPG 或 JPEG 图片');
  regularFile(path.dirname(source), path.basename(source));
  const info = imageInfo(source, nativeImage);
  const slug = String(mapId || 'map').replace(/[^\p{L}\p{N}_-]/gu, '_').slice(0, 80) || 'map';
  const relative = `_assets/${slug}/${view}-${info.sha256.slice(0, 20)}${extension}`;
  const destination = workspaces.file(id, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (!fs.existsSync(destination)) {
    const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
    try {
      fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
      if (crypto.createHash('sha256').update(fs.readFileSync(temporary)).digest('hex') !== info.sha256) throw new Error('复制期间源图片被外部修改');
      fs.renameSync(temporary, destination);
    }
    finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  } else if (crypto.createHash('sha256').update(fs.readFileSync(destination)).digest('hex') !== info.sha256) throw new Error('目标资源内容冲突');
  return { ok: true, path: `${ws.resPrefix.replace(/\/?$/, '/')}${relative}`, width: info.width, height: info.height };
}

module.exports = { MAX_BYTES, VIEWS, IMAGE_EXTENSIONS, regularFile, resourceFile, imageResourceFile, readJson, imageInfo, pngInfo, backgroundInfo, importImage };
