'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('seb', {
  info: () => ipcRenderer.invoke('app:info'),
  start: (data) => ipcRenderer.invoke('session:start', data),
  promptExit: () => ipcRenderer.invoke('session:promptExit'),
  cancelExit: () => ipcRenderer.invoke('session:cancelExit'),
  confirmExit: (code) => ipcRenderer.invoke('session:exit', code),
  nav: (cmd) => ipcRenderer.invoke('nav', cmd),
  quit: () => ipcRenderer.invoke('app:quit'),
  onUi: (cb) => ipcRenderer.on('ui', (_e, msg) => cb(msg)),
});
