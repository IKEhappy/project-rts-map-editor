'use strict';
// map-editor 主进程（T-164）：窗口 + IPC。文件读写与 gate 调用全部收口在 store.cjs，
// 渲染进程纯 web 不碰 Electron API（硬条件④——保留撤壳/玩家版迁移路径）。
// 环境变量：ME_RENDERER_URL（dev 时由 scripts/dev.mjs 注入）、ME_CDP=1 开 9222 调试端口、
//           ME_DATA_DIR / GODOT_EXE 见 store.cjs。

const { app, BrowserWindow, dialog, ipcMain, shell, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const store = require('./store.cjs');
const { WorkspaceService } = require('./workspace.cjs');
const { WriteService } = require('./write-service.cjs');
const assets = require('./assets.cjs');
let workspaces;
let writes;

function validateProject(projectRoot) {
  for (const file of ['data/units.json', 'data/buildings.json', 'data/rules.json']) assets.readJson(assets.regularFile(projectRoot, file));
}

const errorText = (error) => String(error?.message || error);
const withWorkspace = (id) => {
  if (!id) throw new Error('请先选择地图文件夹');
  return workspaces.current(id);
};
async function pickFile(options) {
  const win = BrowserWindow.getFocusedWindow();
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
  return result.canceled ? null : result.filePaths[0];
}

// 渲染进程崩溃留证（R10，2026-09-17）：黑屏事故取证 + 自动重载自愈。
// 注意：硬崩溃会丢渲染层内存中的未保存编辑——重载是止血不是恢复，编辑请勤保存。
const crashLogPath = path.join(__dirname, '..', '..', '.crash.log');
function crashLog(line) {
  try {
    fs.appendFileSync(crashLogPath, `${new Date().toISOString()} ${line}\n`, 'utf8');
  } catch {
    /* 日志失败不再抛 */
  }
}

if (process.env.ME_CDP === '1') {
  // 端口可配置（ME_CDP_PORT）：默认 9222 给 dev；smoke 用 9223，与用户开着的 dev 互不干扰
  app.commandLine.appendSwitch('remote-debugging-port', process.env.ME_CDP_PORT || '9222');
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1480,
    height: 940,
    title: 'Them: Pixel Front - Map Editor',
    minWidth: 1000,
    minHeight: 640,
    frame: false, // 无系统标题栏（T-164 R5）：拖拽靠 CSS app-region，右上自绘控制按钮
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const sendState = () => {
    if (!win.isDestroyed()) win.webContents.send('window:maximized', win.isMaximized());
  };
  win.on('maximize', sendState);
  win.on('unmaximize', sendState);
  // 崩溃自愈（R10）：渲染进程挂掉（GPU 崩溃/OOM 等表现为黑屏）→ 记录原因并重载页面
  win.webContents.on('render-process-gone', (_event, details) => {
    crashLog(`render-process-gone reason=${details.reason} exitCode=${details.exitCode}`);
    if (!win.isDestroyed()) {
      try {
        win.webContents.reload();
      } catch {
        /* 已销毁 */
      }
    }
  });
  win.webContents.on('unresponsive', () => {
    crashLog('renderer unresponsive（长任务/死循环卡死——若伴随黑屏请查 .crash.log 与最近编辑）');
  });
  win.webContents.on('gpu-process-crash', () => {
    crashLog('gpu-process-crash');
  });
  // 关闭拦截（T-164 R6）：未保存修改的保存询问由渲染层决定；close-now 为确认后的强制关闭
  let allowClose = false;
  win.on('close', (event) => {
    if (!allowClose && !win.webContents.isDestroyed()) {
      event.preventDefault();
      win.webContents.send('window:close-requested');
    }
  });
  win.forceClose = () => {
    allowClose = true;
    win.close();
  };
  if (process.env.ME_RENDERER_URL) {
    win.loadURL(process.env.ME_RENDERER_URL);
  } else {
    win.loadFile(path.join(__dirname, '..', '..', 'dist', 'index.html'));
  }
  return win;
}

function registerIpc() {
  ipcMain.handle('workspace:status', () => {
    try { return { ok: true, workspace: workspaces.current() }; }
    catch { return { ok: true, workspace: null }; }
  });
  ipcMain.handle('workspace:open', async (_event, payload) => {
    try {
      const selected = payload?.path || await pickFile({ properties: ['openDirectory'], title: '选择地图 maps 文件夹' });
      if (!selected) return { ok: false, error: '已取消选择' };
      if (path.resolve(selected) === path.parse(path.resolve(selected)).root || fs.existsSync(path.join(selected, 'project.godot'))) throw new Error('请选择地图文件夹，不可选择磁盘根目录或整个 Godot 工程');
      assets.regularFile(store.env().godotProject, 'src/sim/game_map.gd');
      const session = await writes.exclusive(() => workspaces.open({ path: selected, projectRoot: payload?.projectRoot }));
      return { ok: true, workspace: session };
    } catch (error) { return { ok: false, error: errorText(error) }; }
  });
  ipcMain.handle('workspace:close', async (_event, id) => {
    try { await writes.exclusive(() => { withWorkspace(id); workspaces.close(id); }); return { ok: true }; }
    catch (error) { return { ok: false, error: errorText(error) }; }
  });
  ipcMain.handle('workspace:compare', (_event, id) => {
    try { withWorkspace(id); return { ok: true, ...workspaces.compare(id) }; }
    catch (error) { return { ok: false, error: errorText(error) }; }
  });
  ipcMain.handle('workspace:diff-file', (_event, relative, id) => {
    try {
      withWorkspace(id);
      if (typeof relative !== 'string' || !relative.endsWith('.json')) throw new Error('请选择 JSON 文件');
      const before = workspaces.readBaseline(id, relative);
      const current = workspaces.file(id, relative);
      if (fs.existsSync(current) && (!fs.statSync(current).isFile() || fs.statSync(current).size > assets.MAX_BYTES)) throw new Error('文件不是普通 JSON 或超过 32 MiB');
      const after = fs.existsSync(current) ? fs.readFileSync(current) : null;
      if ((before?.length || 0) > assets.MAX_BYTES || (after?.length || 0) > assets.MAX_BYTES) throw new Error('文件超过 32 MiB');
      return { ok: true, before: before?.toString('utf8') || '', after: after?.toString('utf8') || '' };
    } catch (error) { return { ok: false, error: errorText(error) }; }
  });
  ipcMain.handle('workspace:restore', async (_event, id) => {
    try { return { ok: true, workspace: await writes.exclusive(() => { withWorkspace(id); return workspaces.restore(id, {}); }) }; }
    catch (error) { return { ok: false, error: errorText(error) }; }
  });
  ipcMain.handle('workspace:config', (_event, kind, id) => {
    try {
      withWorkspace(id);
      if (!store.isKind(kind)) throw new Error('未知配置表');
      return store.readKind(kind, id);
    } catch (error) { return { ok: false, error: errorText(error) }; }
  });
  ipcMain.handle('assets:background', (_event, doc, id) => {
    try { withWorkspace(id); return assets.backgroundInfo(workspaces, id, doc, nativeImage); }
    catch (error) { return { ok: false, source: 'none', background: {}, images: {}, errors: [errorText(error)] }; }
  });
  ipcMain.handle('assets:import-image', async (_event, payload) => {
    try {
      const id = payload?.workspaceId;
      withWorkspace(id);
      const sourcePath = payload.sourcePath || await pickFile({ properties: ['openFile'], filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg'] }], title: '导入整图 PNG / JPG' });
      if (!sourcePath) return { ok: false, error: '已取消导入' };
      withWorkspace(id);
      return await writes.run('importImage', { workspaceId: id, mapId: payload.mapId, view: payload.view, sourcePath });
    } catch (error) { return { ok: false, error: errorText(error) }; }
  });
  ipcMain.handle('maps:import', async (_event, payload) => {
    try {
      const id = payload?.workspaceId;
      withWorkspace(id);
      const sourcePath = payload?.sourcePath || await pickFile({ properties: ['openFile'], filters: [{ name: '地图 JSON', extensions: ['json'] }], title: '导入地图 JSON 与整图资源' });
      if (!sourcePath) return { ok: false, errors: ['已取消导入'] };
      withWorkspace(id);
      return await writes.run('importMap', { workspaceId: id, sourcePath });
    } catch (error) {
      return { ok: false, errors: [errorText(error)] };
    }
  });
  ipcMain.handle('app:meta', () => store.meta());

  ipcMain.handle('labels:read', () => store.readLabels());
  ipcMain.handle('templates:read', () => store.readEditorTemplates());

  ipcMain.handle('config:read', (_event, kind, id) => {
    if (!store.isKind(kind)) {
      return { ok: false, error: `unknown kind: ${kind}` };
    }
    try {
      withWorkspace(id);
      return store.readKind(kind, id);
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  });

  ipcMain.handle('config:save', async (_event, payload) => {
    try {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('配置保存参数无效');
      withWorkspace(payload.workspaceId);
      return await writes.run('saveKind', payload);
    } catch (error) { return { ok: false, code: 'io', errors: [errorText(error)] }; }
  });

  ipcMain.handle('maps:list', (_event, id) => {
    try {
      return store.listMaps(id);
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err), maps: [] };
    }
  });

  ipcMain.handle('maps:read', (_event, name, id) => {
    try {
      return store.readMap(name, id);
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  });

  ipcMain.handle('maps:save', async (_event, payload) => {
    if (!payload || typeof payload.name !== 'string' || !payload.data || typeof payload.data !== 'object') {
      return { ok: false, code: 'usage', errors: ['payload.name/data must be valid'] };
    }
    try {
      return await writes.run('saveMap', {
        name: payload.name,
        data: payload.data,
        baseHash: String(payload.baseHash || ''),
        workspaceId: payload.workspaceId,
        expectCreate: Boolean(payload.expectCreate),
      });
    } catch (err) {
      return { ok: false, code: 'io', errors: [String(err && err.message ? err.message : err)] };
    }
  });

  ipcMain.handle('maps:rename', async (_event, payload) => {
    if (!payload || typeof payload.from !== 'string' || typeof payload.to !== 'string') {
      return { ok: false, code: 'usage', errors: ['payload.from/to must be strings'] };
    }
    try {
      return await writes.run('renameMap', payload);
    } catch (err) {
      return { ok: false, code: 'io', errors: [String(err && err.message ? err.message : err)] };
    }
  });

  ipcMain.handle('maps:open-file', (_event, name, id) => {
    let full;
    try { full = store.mapFilePath(String(name || ''), id); } catch (error) { return { ok: false, error: errorText(error) }; }
    if (!full || !fs.existsSync(full)) return { ok: false, error: `地图不存在：${name}` };
    return shell.openPath(full).then((message) => (message ? { ok: false, error: message } : { ok: true }));
  });

  ipcMain.handle('maps:open-folder', (_event, name, id) => {
    let full;
    try { full = store.mapFilePath(String(name || ''), id); } catch (error) { return { ok: false, error: errorText(error) }; }
    if (!full || !fs.existsSync(full)) return { ok: false, error: `地图不存在：${name}` };
    // 打开地图目录（若带文件名则定位并选中该文件）
    return shell.openPath(path.dirname(full)).then((message) => (message ? { ok: false, error: message } : { ok: true }));
  });

  ipcMain.handle('assets:read-icon', (_event, name, id) => {
    try {
      return store.iconText(name, id);
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  });

  ipcMain.handle('dialog:pick-folder', async () => {
    const win = BrowserWindow.getFocusedWindow();
    const options = { properties: ['openDirectory'], title: '选择地图 maps 文件夹' };
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false };
    }
    return { ok: true, path: result.filePaths[0] };
  });

  ipcMain.handle('window:ctl', (event, action) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return { ok: false, error: 'no window' };
    if (action === 'minimize') {
      win.minimize();
    } else if (action === 'maximize') {
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
    } else if (action === 'close') {
      win.close(); // 触发 close 拦截 → 渲染层决定是否保存
    } else if (action === 'close-now') {
      win.forceClose();
    } else {
      return { ok: false, error: `unknown action: ${action}` };
    }
    return { ok: true };
  });
}

app.whenReady().then(() => {
  workspaces = new WorkspaceService({
    backupRoot: path.join(app.getPath('userData'), 'backups'),
    defaultProject: store.env().godotProject,
    validateProject: (project) => {
      validateProject(project.projectRoot);
      if (!/^res:\/\/(data|assets)\//.test(project.resPrefix)) throw new Error('工程内地图目录必须位于 data/ 或 assets/ 下');
    },
  });
  store.configureWorkspace(workspaces, nativeImage);
  writes = new WriteService(workspaces);
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

let quitReady = false;
let shutdown;
app.on('before-quit', (event) => {
  if (!writes || quitReady) return;
  event.preventDefault();
  if (shutdown) return;
  shutdown = writes.close().then(() => {
    try { workspaces?.releaseAll(); }
    finally { quitReady = true; app.quit(); }
  });
});
app.on('will-quit', () => workspaces?.releaseAll());

app.on('window-all-closed', () => app.quit());
