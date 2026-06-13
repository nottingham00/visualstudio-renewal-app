const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vsApi', {
  getLicenseStatus: () => ipcRenderer.invoke('get-license-status'),
  renewLicense: (version) => ipcRenderer.invoke('renew-license', version),
  getTaskStatus: () => ipcRenderer.invoke('get-task-status'),
  installTask: (opts) => ipcRenderer.invoke('install-task', opts),
  uninstallTask: () => ipcRenderer.invoke('uninstall-task'),
  readLog: () => ipcRenderer.invoke('read-log'),
  clearLog: () => ipcRenderer.invoke('clear-log'),
  checkAdmin: () => ipcRenderer.invoke('check-admin'),
  openLogFile: () => ipcRenderer.invoke('open-log-file'),

  // Window controls
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),
});
