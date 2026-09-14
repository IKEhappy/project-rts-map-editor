'use strict';
// map-editor 主进程（T-164）：窗口 + IPC。文件读写与 gate 调用全部收口在 store.cjs，
// 渲染进程纯 web 不碰 Electron API（硬条件④——保留撤壳/玩家版迁移路径）。
// 环境变量：ME_RENDERER_URL（dev 时由 scripts/dev.mjs 注入）、ME_CDP=1 开 9222 调试端口、
//           ME_DATA_DIR / GODOT_EXE 见 store.cjs。

const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('node:path');
const store = require('./store.cjs');

if (process.env.ME_CDP === '1') {
  // 端口可配置（ME_CDP_PORT）：默认 9222 给 dev；smoke 用 9223，与用户开着的 dev 互不干扰
  app.commandLine.appendSwitch('remote-debugging-port', process.env.ME_CDP_PORT || '9222');
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1480,
    height: 940,
    title: 'WarOfState map-editor',
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
  ipcMain.handle('app:meta', () => store.meta());

  ipcMain.handle('labels:read', () => store.readLabels());

  ipcMain.handle('config:read', (_event, kind, dataDir) => {
    if (!store.isKind(kind)) {
      return { ok: false, error: `unknown kind: ${kind}` };
    }
    try {
      return store.readKind(kind, dataDir);
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  });

  ipcMain.handle('config:save', (_event, payload) => {
    if (!payload || !store.isKind(payload.kind)) {
      return { ok: false, code: 'usage', errors: [`unknown kind: ${payload && payload.kind}`] };
    }
    if (!payload.data || typeof payload.data !== 'object') {
      return { ok: false, code: 'usage', errors: ['payload.data must be an object'] };
    }
    if (payload.dataDir) {
      const check = store.validateDataDir(payload.dataDir);
      if (!check.ok) {
        return { ok: false, code: 'usage', errors: check.errors };
      }
    }
    try {
      return store.saveKind(payload);
    } catch (err) {
      return { ok: false, code: 'io', errors: [String(err && err.message ? err.message : err)] };
    }
  });

  ipcMain.handle('dialog:pick-folder', async () => {
    const win = BrowserWindow.getFocusedWindow();
    const options = { properties: ['openDirectory'], title: '选择数据目录（须含 units/buildings/rules.json）' };
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
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => app.quit());
