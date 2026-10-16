'use strict';
// 预加载：唯一桥。渲染层只能看到这三个方法（contextIsolation + sandbox）。
const { contextBridge, ipcRenderer } = require('electron');
let workspaceId = null;
const sessionCall = async (channel, payload) => {
  const result = await ipcRenderer.invoke(channel, payload);
  if (result.ok) workspaceId = result.workspace?.id ?? null;
  return result;
};

contextBridge.exposeInMainWorld('meApi', {
  openWorkspace: (payload) => sessionCall('workspace:open', payload),
  getWorkspace: () => sessionCall('workspace:status'),
  closeWorkspace: () => sessionCall('workspace:close', workspaceId),
  compareWorkspace: () => ipcRenderer.invoke('workspace:compare', workspaceId),
  diffFile: (relative) => ipcRenderer.invoke('workspace:diff-file', relative, workspaceId),
  restoreWorkspace: () => sessionCall('workspace:restore', workspaceId),
  readWorkspaceConfig: (kind) => ipcRenderer.invoke('workspace:config', kind, workspaceId),
  backgroundInfo: (doc) => ipcRenderer.invoke('assets:background', doc, workspaceId),
  importImage: (payload) => ipcRenderer.invoke('assets:import-image', { ...payload, workspaceId }),
  importMap: (payload) => ipcRenderer.invoke('maps:import', { ...payload, workspaceId }),
  meta: () => ipcRenderer.invoke('app:meta'),
  labels: () => ipcRenderer.invoke('labels:read'),
  editorTemplates: () => ipcRenderer.invoke('templates:read'),
  read: (kind) => ipcRenderer.invoke('config:read', kind, workspaceId),
  save: (payload) => ipcRenderer.invoke('config:save', { ...payload, workspaceId: payload.workspaceId ?? workspaceId }),
  listMaps: () => ipcRenderer.invoke('maps:list', workspaceId),
  readMap: (name, explicitId) => ipcRenderer.invoke('maps:read', name, explicitId ?? workspaceId),
  saveMap: (payload) => ipcRenderer.invoke('maps:save', { ...payload, workspaceId: payload.workspaceId ?? workspaceId }),
  renameMap: (payload) => ipcRenderer.invoke('maps:rename', { ...payload, workspaceId }),
  openMapFile: (name) => ipcRenderer.invoke('maps:open-file', name, workspaceId),
  openMapFolder: (name) => ipcRenderer.invoke('maps:open-folder', name, workspaceId),
  readIcon: (name) => ipcRenderer.invoke('assets:read-icon', name, workspaceId),
  pickFolder: () => ipcRenderer.invoke('dialog:pick-folder'),
  windowCtl: (action) => ipcRenderer.invoke('window:ctl', action),
  onWindowState: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('window:maximized', listener);
    return () => ipcRenderer.removeListener('window:maximized', listener);
  },
  onCloseRequest: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('window:close-requested', listener);
    return () => ipcRenderer.removeListener('window:close-requested', listener);
  },
});
