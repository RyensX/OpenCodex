const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("openCodexLauncher", {
  getState: () => ipcRenderer.invoke("launcher:get-state"),
  start: () => ipcRenderer.invoke("launcher:start"),
  restart: () => ipcRenderer.invoke("launcher:restart"),
  openUrl: () => ipcRenderer.invoke("launcher:open-url"),
  openLogs: () => ipcRenderer.invoke("launcher:open-logs"),
  openGitHub: () => ipcRenderer.invoke("launcher:open-github"),
  openAuthor: () => ipcRenderer.invoke("launcher:open-author"),
  // 更新入口不接收渲染进程传参，由主进程打开已校验的 latest release 链接。
  openLatestRelease: () => ipcRenderer.invoke("launcher:open-latest-release"),
  revealPath: (targetPath) => ipcRenderer.invoke("launcher:reveal-path", targetPath),
  copy: (value) => ipcRenderer.invoke("launcher:copy", value),
  updateHostMode: (hostMode) => ipcRenderer.invoke("launcher:update-host-mode", hostMode),
  updatePort: (port) => ipcRenderer.invoke("launcher:update-port", port),
  updatePassword: (password) => ipcRenderer.invoke("launcher:update-password", password),
  updatePluginDirs: (pluginDirs) => ipcRenderer.invoke("launcher:update-plugin-dirs", pluginDirs),
  updatePreventSleep: (preventSleep) => ipcRenderer.invoke("launcher:update-prevent-sleep", preventSleep),
  choosePluginDir: () => ipcRenderer.invoke("launcher:choose-plugin-dir"),
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("launcher:state", listener);
    return () => ipcRenderer.removeListener("launcher:state", listener);
  },
});
