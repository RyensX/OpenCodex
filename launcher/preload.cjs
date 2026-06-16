const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("openCodexLauncher", {
  getState: () => ipcRenderer.invoke("launcher:get-state"),
  start: () => ipcRenderer.invoke("launcher:start"),
  restart: () => ipcRenderer.invoke("launcher:restart"),
  openUrl: () => ipcRenderer.invoke("launcher:open-url"),
  openLogs: () => ipcRenderer.invoke("launcher:open-logs"),
  revealPath: (targetPath) => ipcRenderer.invoke("launcher:reveal-path", targetPath),
  copy: (value) => ipcRenderer.invoke("launcher:copy", value),
  updateHostMode: (hostMode) => ipcRenderer.invoke("launcher:update-host-mode", hostMode),
  updatePort: (port) => ipcRenderer.invoke("launcher:update-port", port),
  updatePassword: (password) => ipcRenderer.invoke("launcher:update-password", password),
  updatePluginDirs: (pluginDirs) => ipcRenderer.invoke("launcher:update-plugin-dirs", pluginDirs),
  choosePluginDir: () => ipcRenderer.invoke("launcher:choose-plugin-dir"),
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("launcher:state", listener);
    return () => ipcRenderer.removeListener("launcher:state", listener);
  },
});
