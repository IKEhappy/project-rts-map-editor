'use strict';
// 预加载：唯一桥。渲染层只能看到这三个方法（contextIsolation + sandbox）。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('meApi', {
  meta: () => ipcRenderer.invoke('app:meta'),
  labels: () => ipcRenderer.invoke('labels:read'),
  read: (kind, dataDir) => ipcRenderer.invoke('config:read', kind, dataDir ?? null),
  save: (payload) => ipcRenderer.invoke('config:save', payload),
  listMaps: () => ipcRenderer.invoke('maps:list'),
  readMap: (name) => ipcRenderer.invoke('maps:read', name),
  saveMap: (payload) => ipcRenderer.invoke('maps:save', payload),
  renameMap: (payload) => ipcRenderer.invoke('maps:rename', payload),
  openMapFile: (name) => ipcRenderer.invoke('maps:open-file', name),
  openMapFolder: (name) => ipcRenderer.invoke('maps:open-folder', name),
  readIcon: (name) => ipcRenderer.invoke('assets:read-icon', name),
  pickFolder: () => ipcRenderer.invoke('dialog:pick-folder'),
  windowCtl: (action) => ipcRenderer.invoke('window:ctl', action),
  onWindowState: (callback) => {
    ipcRenderer.on('window:maximized', (_event, value) => callback(value));
  },
  onCloseRequest: (callback) => {
    ipcRenderer.on('window:close-requested', () => callback());
  },
});
