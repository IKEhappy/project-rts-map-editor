'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const AdmZip = require('adm-zip');

const SCHEMA = 1;
const MAX_ENTRIES = 100000;
const MAX_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;
const processLocks = new Map();
const crcTable = Array.from({ length: 256 }, (_, value) => {
  let result = value;
  for (let bit = 0; bit < 8; bit += 1) result = (result >>> 1) ^ ((result & 1) ? 0xedb88320 : 0);
  return result >>> 0;
});

function hash(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function identity(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function samePath(a, b) {
  return identity(a) === identity(b);
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function relativeName(value, allowEmpty = false) {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f:]/.test(value) || path.isAbsolute(value) || /^[\\/]/.test(value)) {
    throw new Error('Invalid workspace relative path');
  }
  const normalized = value.replace(/\\/g, '/');
  if (normalized === '' && allowEmpty) return '';
  if (normalized === '' || normalized.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error('Invalid workspace relative path');
  }
  return normalized;
}

function assertNoLinks(absolute) {
  const parsed = path.parse(path.resolve(absolute));
  let current = parsed.root;
  for (const part of path.relative(parsed.root, absolute).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) {
      if (error.code === 'ENOENT') break;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`Symbolic links and junctions are not supported: ${current}`);
  }
}

function fileHash(full) {
  const fd = fs.openSync(full, 'r');
  const digest = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let count;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) digest.update(buffer.subarray(0, count));
    return digest.digest('hex');
  } finally {
    fs.closeSync(fd);
  }
}

function scan(root, { limits = true, hashFiles = true } = {}) {
  assertNoLinks(root);
  if (!fs.statSync(root).isDirectory()) throw new Error(`Not a directory: ${root}`);
  const entries = [];
  let totalBytes = 0;
  function walk(directory, prefix) {
    for (const item of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = relativeName(prefix ? `${prefix}/${item.name}` : item.name);
      const full = path.join(directory, item.name);
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) throw new Error(`Symbolic links and junctions are not supported: ${full}`);
      if (stat.isDirectory()) {
        entries.push({ path: relative, kind: 'directory' });
        walk(full, relative);
      } else if (stat.isFile()) {
        totalBytes += stat.size;
        if (limits && totalBytes > MAX_BYTES) throw new Error('Workspace snapshot exceeds the 2 GiB safety limit');
        const entry = { path: relative, kind: 'file', size: stat.size };
        if (hashFiles) entry.sha256 = fileHash(full);
        entries.push(entry);
      } else {
        throw new Error(`Only regular files and directories are supported: ${full}`);
      }
      if (limits && entries.length > MAX_ENTRIES) throw new Error('Workspace has too many files and directories');
    }
  }
  walk(root, '');
  return { entries: entries.sort((a, b) => a.path.localeCompare(b.path)), totalBytes };
}

function equalTree(a, b) {
  if (a.entries.length !== b.entries.length) return false;
  const byPath = new Map(b.entries.map((entry) => [entry.path, entry]));
  return a.entries.every((entry) => {
    const other = byPath.get(entry.path);
    return other && entry.kind === other.kind && entry.size === other.size && entry.sha256 === other.sha256;
  });
}

function durableJson(file, data) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temporary, 'wx');
    try {
      fs.writeFileSync(fd, JSON.stringify(data, null, 2) + '\n', 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}

function publicSession(session) {
  return structuredClone({
    id: session.id,
    generation: session.generation,
    root: session.root,
    projectRoot: session.projectRoot,
    dataDir: session.dataDir,
    resPrefix: session.resPrefix,
    offline: session.offline,
    baseline: session.baseline,
  });
}

function checkedRoot(session, id) {
  if (id !== undefined && id !== session.id) throw new Error('Workspace session has expired');
  assertNoLinks(session.root);
  if (!fs.existsSync(session.root) || !samePath(fs.realpathSync.native(session.root), session.root)) throw new Error('Workspace folder was moved or replaced');
  return session;
}

function workspaceFile(session, relative, { mustExist = false } = {}) {
  const safe = relativeName(relative);
  const full = path.join(session.root, ...safe.split('/'));
  if (!inside(session.root, full)) throw new Error('Path is outside the selected map folder');
  assertNoLinks(full);
  if (mustExist && !fs.existsSync(full)) throw new Error(`Workspace file does not exist: ${safe}`);
  if (fs.existsSync(full) && !inside(session.root, fs.realpathSync.native(full))) throw new Error('Workspace path escapes its root');
  return full;
}

// Only the main process creates this descriptor, after checking its live session.
// Workers share the main process's lock and cannot open, restore or switch folders.
function createBoundWorkspace(descriptor) {
  const session = publicSession(descriptor);
  for (const key of ['root', 'projectRoot', 'dataDir']) {
    if (typeof session[key] !== 'string' || !path.isAbsolute(session[key])) throw new Error('Invalid bound workspace');
  }
  if (!session.id || !Number.isSafeInteger(session.generation) || !/^res:\/\/(data|assets)\/.+/.test(session.resPrefix)) throw new Error('Invalid bound workspace');
  checkedRoot(session);
  return {
    current(id) { return publicSession(checkedRoot(session, id)); },
    file(id, relative, options) { return workspaceFile(checkedRoot(session, id), relative, options); },
  };
}

class WorkspaceService {
  constructor({ backupRoot, defaultProject, validateProject } = {}) {
    if (!backupRoot) throw new Error('backupRoot is required');
    this.backupRoot = path.resolve(backupRoot);
    this.defaultProject = defaultProject ? path.resolve(defaultProject) : null;
    this.validateProject = validateProject;
    this._session = null;
    fs.mkdirSync(this.backupRoot, { recursive: true });
    assertNoLinks(this.backupRoot);
    this.backupRoot = fs.realpathSync.native(this.backupRoot);
  }

  _bucket(root) {
    return path.join(this.backupRoot, hash(identity(root)));
  }

  _acquire(root) {
    const key = identity(root);
    if (processLocks.has(key)) throw new Error('This map folder is already open in another editor instance');
    const bucket = this._bucket(root);
    fs.mkdirSync(bucket, { recursive: true });
    assertNoLinks(bucket);
    const lockFile = path.join(bucket, 'workspace.lock');
    const lock = { pid: process.pid, nonce: crypto.randomUUID(), root, createdAt: new Date().toISOString() };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const fd = fs.openSync(lockFile, 'wx');
        try {
          fs.writeFileSync(fd, JSON.stringify(lock), 'utf8');
          fs.fsyncSync(fd);
        } catch (error) {
          fs.closeSync(fd);
          fs.unlinkSync(lockFile);
          throw error;
        } finally {
          try { fs.closeSync(fd); } catch { /* already closed on write failure */ }
        }
        const held = { key, file: lockFile, nonce: lock.nonce, bucket };
        processLocks.set(key, held);
        return held;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let existing;
        let text;
        try {
          assertNoLinks(lockFile);
          text = fs.readFileSync(lockFile, 'utf8');
          existing = JSON.parse(text);
        } catch {
          throw new Error(`Workspace lock is unreadable; inspect it before removing: ${lockFile}`);
        }
        if (!Number.isInteger(existing.pid) || existing.pid <= 0 || !samePath(existing.root || '', root)) throw new Error(`Workspace lock is invalid: ${lockFile}`);
        let alive = true;
        try {
          process.kill(existing.pid, 0);
        } catch (probe) {
          alive = probe.code !== 'ESRCH';
        }
        if (alive) throw new Error(`This map folder is locked by process ${existing.pid}`);
        if (fs.readFileSync(lockFile, 'utf8') === text) fs.unlinkSync(lockFile);
      }
    }
    throw new Error('Could not acquire workspace lock');
  }

  _release(lock) {
    if (!lock) return;
    try {
      if (fs.existsSync(lock.file)) {
        const current = JSON.parse(fs.readFileSync(lock.file, 'utf8'));
        if (current.nonce === lock.nonce) fs.unlinkSync(lock.file);
      }
    } finally {
      if (processLocks.get(lock.key) === lock) processLocks.delete(lock.key);
    }
  }

  _project(root, explicit) {
    let project = explicit ? path.resolve(explicit) : null;
    if (project) {
      assertNoLinks(project);
      if (!fs.existsSync(path.join(project, 'project.godot'))) throw new Error('Selected projectRoot does not contain project.godot');
      project = fs.realpathSync.native(project);
    } else {
      let candidate = root;
      while (true) {
        if (fs.existsSync(path.join(candidate, 'project.godot'))) {
          project = candidate;
          break;
        }
        const parent = path.dirname(candidate);
        if (parent === candidate) break;
        candidate = parent;
      }
    }
    const offline = !project || !inside(project, root);
    project = project || this.defaultProject;
    if (project) assertNoLinks(project);
    const relative = !offline ? path.relative(project, root).split(path.sep).join('/') : 'data/maps';
    return {
      projectRoot: project,
      dataDir: project ? path.join(project, 'data') : null,
      resPrefix: `res://${relative ? `${relative}/` : ''}`,
      offline,
    };
  }

  _snapshot(root, bucket) {
    const tree = scan(root);
    const id = `${Date.now()}-${crypto.randomUUID()}`;
    const createdAt = new Date().toISOString();
    const manifest = { schema: SCHEMA, id, root, createdAt, entries: tree.entries, totalBytes: tree.totalBytes };
    const zipPath = path.join(bucket, `${id}.zip`);
    const temporary = `${zipPath}.tmp`;
    const zip = new AdmZip();
    zip.addFile('content/', Buffer.alloc(0));
    for (const entry of tree.entries) {
      if (entry.kind === 'directory') {
        zip.addFile(`content/${entry.path}/`, Buffer.alloc(0));
      } else {
        const full = path.join(root, ...entry.path.split('/'));
        assertNoLinks(full);
        const bytes = fs.readFileSync(full);
        if (bytes.length !== entry.size || hash(bytes) !== entry.sha256) throw new Error('Workspace changed while creating its backup; reopen the folder');
        zip.addFile(`content/${entry.path}`, bytes);
      }
    }
    if (!equalTree(tree, scan(root))) throw new Error('Workspace changed while creating its backup; reopen the folder');
    const manifestText = JSON.stringify(manifest);
    if (Buffer.byteLength(manifestText) > MAX_MANIFEST_BYTES) throw new Error('Workspace manifest exceeds the 32 MiB safety limit');
    zip.addFile('snapshot/manifest.json', Buffer.from(manifestText, 'utf8'));
    try {
      zip.writeZip(temporary);
      const fd = fs.openSync(temporary, 'r+');
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      const record = { manifest, manifestSha256: hash(manifestText), zipSha256: fileHash(temporary) };
      this._validateZip(temporary, record);
      fs.renameSync(temporary, zipPath);
      durableJson(path.join(bucket, `${id}.json`), record);
      return {
        manifest,
        baseline: { id, createdAt, zipPath, fileCount: tree.entries.filter((entry) => entry.kind === 'file').length, totalBytes: tree.totalBytes },
      };
    } catch (error) {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
      if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
      throw error;
    }
  }

  _record(bucket, backupId, root) {
    if (typeof backupId !== 'string' || !/^\d+-[a-f0-9-]{36}$/.test(backupId)) throw new Error('Invalid backup ID');
    const file = path.join(bucket, `${backupId}.json`);
    assertNoLinks(file);
    if (fs.statSync(file).size > MAX_MANIFEST_BYTES) throw new Error('Backup manifest is too large');
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    const manifest = record.manifest;
    if (!manifest || manifest.schema !== SCHEMA || manifest.id !== backupId || !samePath(manifest.root, root)
      || !Array.isArray(manifest.entries) || manifest.entries.length > MAX_ENTRIES) throw new Error('Invalid backup manifest');
    if (hash(JSON.stringify(manifest)) !== record.manifestSha256) throw new Error('Backup manifest checksum does not match');
    return record;
  }

  _validateZip(zipPath, record) {
    assertNoLinks(zipPath);
    if (fileHash(zipPath) !== record.zipSha256) throw new Error('Backup ZIP checksum does not match');
    const zip = new AdmZip(zipPath);
    const zipEntries = zip.getEntries();
    if (zipEntries.length !== record.manifest.entries.length + 2 || zipEntries.length > MAX_ENTRIES + 2) throw new Error('Backup ZIP entry count does not match');
    const expected = new Map(record.manifest.entries.map((entry) => [relativeName(entry.path), entry]));
    if (expected.size !== record.manifest.entries.length) throw new Error('Duplicate manifest paths');
    let declaredBytes = 0;
    for (const item of expected.values()) {
      if (item.kind === 'file') {
        if (!Number.isSafeInteger(item.size) || item.size < 0 || !/^[a-f0-9]{64}$/.test(item.sha256 || '')) throw new Error('Invalid backup file manifest');
        declaredBytes += item.size;
      } else if (item.kind !== 'directory') throw new Error('Invalid backup entry kind');
      if (declaredBytes > MAX_BYTES) throw new Error('Backup ZIP exceeds the 2 GiB safety limit');
    }
    if (declaredBytes !== record.manifest.totalBytes) throw new Error('Backup manifest size does not match');
    const seen = new Set();
    const outputs = [];
    let totalBytes = 0;
    for (const entry of zipEntries) {
      const name = entry.entryName;
      if (name.includes('\\')) throw new Error('Invalid ZIP path separator');
      const normalized = relativeName(entry.isDirectory ? name.replace(/\/$/, '') : name);
      const key = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
      if (seen.has(key)) throw new Error('Duplicate ZIP paths');
      seen.add(key);
      const unixType = ((entry.header.attr >>> 16) & 0o170000);
      if (unixType !== 0 && unixType !== 0o100000 && unixType !== 0o040000) throw new Error('Unsupported ZIP entry type');
      if (normalized === 'content' && entry.isDirectory) {
        if (entry.header.size !== 0) throw new Error('Invalid ZIP root directory');
        continue;
      }
      if (normalized === 'snapshot/manifest.json' && !entry.isDirectory) {
        if (entry.header.size > MAX_MANIFEST_BYTES) throw new Error('Backup ZIP manifest is too large');
        const bytes = entry.getData();
        if ((entry.header.crc >>> 0) !== crc32(bytes)) throw new Error('Backup ZIP CRC does not match');
        if (hash(bytes) !== record.manifestSha256) throw new Error('Backup ZIP manifest does not match');
        continue;
      }
      if (!normalized.startsWith('content/')) throw new Error('Unexpected ZIP entry');
      const relative = normalized.slice('content/'.length);
      const item = expected.get(relative);
      if (!item || (item.kind === 'directory') !== entry.isDirectory) throw new Error('Backup ZIP structure does not match');
      if (entry.header.size !== (item.kind === 'file' ? item.size : 0)) throw new Error('Backup ZIP declared size does not match');
      const bytes = entry.getData();
      if ((entry.header.crc >>> 0) !== crc32(bytes)) throw new Error('Backup ZIP CRC does not match');
      if (item.kind === 'file') {
        totalBytes += bytes.length;
        if (!Number.isSafeInteger(item.size) || item.size < 0 || bytes.length !== item.size || hash(bytes) !== item.sha256) throw new Error('Backup file checksum does not match');
      } else if (item.kind !== 'directory' || bytes.length !== 0) {
        throw new Error('Invalid backup directory');
      }
      if (totalBytes > MAX_BYTES) throw new Error('Backup ZIP exceeds the 2 GiB safety limit');
      outputs.push({ item, entry });
      expected.delete(relative);
    }
    if (expected.size !== 0 || totalBytes !== record.manifest.totalBytes || !seen.has('content') || !seen.has('snapshot/manifest.json')) throw new Error('Backup ZIP is incomplete');
    return outputs;
  }

  _journalPaths(journal, root) {
    const token = journal.transactionId;
    if (journal.schema !== SCHEMA || !['staging', 'prepared', 'root-moved', 'installed', 'committed'].includes(journal.phase)
      || typeof token !== 'string' || !/^[a-f0-9-]{36}$/.test(token) || !samePath(journal.root, root)) throw new Error('Invalid restore journal');
    const parent = path.dirname(root);
    const base = path.basename(root);
    const stage = path.join(parent, `.${base}.map-editor-stage-${token}`);
    const quarantine = path.join(parent, `.${base}.map-editor-old-${token}`);
    if (!samePath(journal.stage, stage) || !samePath(journal.quarantine, quarantine)) throw new Error('Restore journal paths do not match');
    assertNoLinks(stage);
    assertNoLinks(quarantine);
    return { stage, quarantine };
  }

  _recover(root, bucket) {
    const journalFile = path.join(bucket, 'restore.json');
    if (!fs.existsSync(journalFile)) return;
    assertNoLinks(journalFile);
    const journal = JSON.parse(fs.readFileSync(journalFile, 'utf8'));
    const { stage, quarantine } = this._journalPaths(journal, root);
    const record = this._record(bucket, journal.backupId, root);
    if (journal.phase === 'committed') {
      if (!fs.existsSync(root)) throw new Error('Committed restore is missing its map folder');
      if (fs.existsSync(quarantine)) fs.rmSync(quarantine, { recursive: true });
    } else if (fs.existsSync(quarantine)) {
      let installed = false;
      if (fs.existsSync(root)) {
        assertNoLinks(root);
        installed = equalTree(scan(root, { limits: false }), record.manifest);
      }
      if (installed) {
        fs.rmSync(quarantine, { recursive: true });
      } else {
        if (fs.existsSync(root)) {
          const preserved = path.join(path.dirname(root), `.${path.basename(root)}.map-editor-interrupted-${crypto.randomUUID()}`);
          fs.renameSync(root, preserved);
        }
        fs.renameSync(quarantine, root);
      }
    } else if (!fs.existsSync(root)) {
      throw new Error(`Interrupted restore needs manual recovery; map folder is missing: ${root}`);
    }
    if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true });
    fs.unlinkSync(journalFile);
  }

  open({ path: selected, projectRoot } = {}) {
    if (typeof selected !== 'string' || selected.trim() === '') throw new Error('Select a map folder first');
    const requested = path.resolve(selected.trim());
    assertNoLinks(requested);
    // A restore may have been interrupted between the two directory renames.
    const root = fs.existsSync(requested) ? fs.realpathSync.native(requested) : requested;
    if (inside(root, this.backupRoot) || inside(this.backupRoot, root)) throw new Error('Backup storage must be outside the selected map folder');
    const previous = this._session;
    const reuse = previous && samePath(previous.root, root);
    const lock = reuse ? previous.lock : this._acquire(root);
    try {
      this._recover(root, lock.bucket);
      if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`Map folder does not exist: ${root}`);
      const project = this._project(root, projectRoot);
      this.validateProject?.(project);
      const snapshot = this._snapshot(root, lock.bucket);
      const session = {
        id: crypto.randomUUID(),
        generation: previous ? previous.generation + 1 : 1,
        root,
        ...project,
        ...snapshot,
        lock,
      };
      this._session = session;
      if (previous && !reuse) this._release(previous.lock);
      return publicSession(session);
    } catch (error) {
      if (!reuse) this._release(lock);
      throw error;
    }
  }

  _current(id) {
    if (!this._session) throw new Error('Select a map folder first');
    return checkedRoot(this._session, id);
  }

  current(id) {
    return publicSession(this._current(id));
  }

  file(id, relative, { mustExist = false } = {}) {
    return workspaceFile(this._current(id), relative, { mustExist });
  }

  compare(id) {
    const session = this._current(id);
    const before = new Map(session.manifest.entries.map((entry) => [entry.path, entry]));
    const after = new Map(scan(session.root, { limits: false }).entries.map((entry) => [entry.path, entry]));
    const entries = [];
    const counts = { added: 0, removed: 0, changed: 0, unchanged: 0 };
    for (const relative of [...new Set([...before.keys(), ...after.keys()])].sort((a, b) => a.localeCompare(b))) {
      const old = before.get(relative);
      const current = after.get(relative);
      const status = !old ? 'added' : !current ? 'removed'
        : old.kind !== current.kind || old.sha256 !== current.sha256 || old.size !== current.size ? 'changed' : 'unchanged';
      entries.push({ path: relative, status, kind: (current || old).kind });
      counts[status] += 1;
    }
    return { entries, counts };
  }

  readBaseline(id, relative) {
    const session = this._current(id);
    const safe = relativeName(relative);
    const record = this._record(session.lock.bucket, session.baseline.id, session.root);
    const outputs = this._validateZip(session.baseline.zipPath, record);
    const output = outputs.find(({ item }) => item.path === safe && item.kind === 'file');
    return output ? output.entry.getData() : null;
  }

  restore(id, { backupId } = {}) {
    const session = this._current(id);
    const selected = backupId || session.baseline.id;
    const record = this._record(session.lock.bucket, selected, session.root);
    const zipPath = path.join(session.lock.bucket, `${selected}.zip`);
    const outputs = this._validateZip(zipPath, record);
    scan(session.root, { limits: false, hashFiles: false });
    const transactionId = crypto.randomUUID();
    const root = session.root;
    const stage = path.join(path.dirname(root), `.${path.basename(root)}.map-editor-stage-${transactionId}`);
    const quarantine = path.join(path.dirname(root), `.${path.basename(root)}.map-editor-old-${transactionId}`);
    const journalFile = path.join(session.lock.bucket, 'restore.json');
    if (fs.existsSync(journalFile)) this._recover(root, session.lock.bucket);
    const journal = { schema: SCHEMA, transactionId, root, stage, quarantine, backupId: selected, phase: 'staging' };
    let moved = false;
    let installed = false;
    let committed = false;
    try {
      durableJson(journalFile, journal);
      fs.mkdirSync(stage);
      assertNoLinks(stage);
      for (const { item, entry } of outputs) {
        const full = path.join(stage, ...item.path.split('/'));
        if (item.kind === 'directory') fs.mkdirSync(full, { recursive: true });
        else {
          fs.mkdirSync(path.dirname(full), { recursive: true });
          const fd = fs.openSync(full, 'wx');
          try {
            fs.writeFileSync(fd, entry.getData());
            fs.fsyncSync(fd);
          } finally { fs.closeSync(fd); }
        }
      }
      if (!equalTree(scan(stage), record.manifest)) throw new Error('Restored staging tree does not match the backup');
      journal.phase = 'prepared';
      durableJson(journalFile, journal);
      fs.renameSync(root, quarantine);
      moved = true;
      journal.phase = 'root-moved';
      durableJson(journalFile, journal);
      fs.renameSync(stage, root);
      installed = true;
      journal.phase = 'installed';
      durableJson(journalFile, journal);
      if (!equalTree(scan(root), record.manifest)) throw new Error('Restored map folder does not match the backup');
      journal.phase = 'committed';
      durableJson(journalFile, journal);
      committed = true;
    } catch (error) {
      try {
        if (installed && fs.existsSync(root)) fs.rmSync(root, { recursive: true });
        if (moved && fs.existsSync(quarantine)) fs.renameSync(quarantine, root);
        if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true });
        if (fs.existsSync(journalFile)) fs.unlinkSync(journalFile);
      } catch (rollback) {
        throw new Error(`Restore failed (${error.message}); rollback needs recovery on reopen (${rollback.message})`);
      }
      throw error;
    }
    if (committed) {
      // A locked old tree is harmless; the committed journal retries its cleanup on reopen.
      try {
        fs.rmSync(quarantine, { recursive: true });
        fs.unlinkSync(journalFile);
      } catch { /* keep the journal and old tree for recovery */ }
    }
    session.manifest = record.manifest;
    session.baseline = {
      id: selected,
      createdAt: record.manifest.createdAt,
      zipPath,
      fileCount: record.manifest.entries.filter((entry) => entry.kind === 'file').length,
      totalBytes: record.manifest.totalBytes,
    };
    session.generation += 1;
    return publicSession(session);
  }

  close(id) {
    const session = this._current(id);
    this._release(session.lock);
    this._session = null;
  }

  releaseAll() {
    if (this._session) {
      this._release(this._session.lock);
      this._session = null;
    }
  }
}

module.exports = { WorkspaceService, createBoundWorkspace };
