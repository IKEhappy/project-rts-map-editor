'use strict';
// 预加载：唯一桥。渲染层只能看到这三个方法（contextIsolation + sandbox）。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('meApi', {
  meta: () => ipcRenderer.invoke('app:meta'),
  labels: () => ipcRenderer.invoke('labels:read'),
  read: (kind, dataDir) => ipcRenderer.invoke('config:read', kind, dataDir ?? null),
  save: (payload) => ipcRenderer.invoke('config:save', payload),
  pickFolder: () => ipcRenderer.invoke('dialog:pick-folder'),
});
