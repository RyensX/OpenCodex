const { POINT_DEFINITION_BY_ID } = require("../../dist/modification/catalog.js");

function requiredPoint(id) {
  const point = POINT_DEFINITION_BY_ID.get(id);
  if (!point) throw new Error(`Unknown typed modification point: ${id}`);
  return point;
}

// 稳定字符串只集中出现在目录绑定边界；业务模块通过下面的对象引用选择修改点。
const gateway = Object.freeze({
  officialAppEnvironment: requiredPoint("gateway.runtime.environment.official-app"),
  noAsarEnvironment: requiredPoint("gateway.runtime.environment.no-asar"),
  hiddenChromiumServices: requiredPoint("gateway.runtime.chromium.hidden-services"),
  gcmProfile: requiredPoint("gateway.runtime.chromium.gcm-profile"),
  electronModuleLoader: requiredPoint("gateway.runtime.node.electron-module-loader"),
  notification: requiredPoint("gateway.runtime.electron.notification"),
  tray: requiredPoint("gateway.runtime.electron.tray"),
  ipcMain: requiredPoint("gateway.runtime.electron.ipc-main"),
  ipcEvent: requiredPoint("gateway.runtime.electron.ipc-event"),
  browserWindow: requiredPoint("gateway.runtime.electron.browser-window"),
  webContentsSend: requiredPoint("gateway.runtime.electron.web-contents-send"),
  dialogOpen: requiredPoint("gateway.runtime.electron.dialog-open"),
  shellOpen: requiredPoint("gateway.runtime.electron.shell-open"),
  singleInstance: requiredPoint("gateway.runtime.electron.single-instance"),
  quitDialog: requiredPoint("gateway.runtime.electron.quit-dialog"),
  dockVisibility: requiredPoint("gateway.runtime.electron.dock-visibility"),
  appServerLaunch: requiredPoint("gateway.runtime.process.app-server-launch"),
  remoteFileManager: requiredPoint("gateway.runtime.process.remote-file-manager"),
  computerUseInstaller: requiredPoint("gateway.runtime.process.computer-use-installer"),
  appServerTransport: requiredPoint("gateway.runtime.app-server.transport"),
  virtualModel: requiredPoint("gateway.runtime.app-server.virtual-model"),
  turnRouter: requiredPoint("gateway.runtime.app-server.turn-router"),
  internalSession: requiredPoint("gateway.runtime.app-server.internal-session"),
  routeMetadata: requiredPoint("gateway.runtime.app-server.route-metadata"),
  historyContext: requiredPoint("gateway.runtime.app-server.history-context"),
  appHostRelay: requiredPoint("gateway.runtime.app-host.relay"),
  requestRoute: requiredPoint("gateway.runtime.ipc.request-route"),
  chunkedMessage: requiredPoint("gateway.runtime.ipc.chunked-message"),
  appCatalogCompaction: requiredPoint("gateway.runtime.ipc.app-catalog-compaction"),
  hiddenRendererSuppression: requiredPoint("gateway.runtime.ipc.hidden-renderer-suppression"),
  initialSidebarBootstrap: requiredPoint("gateway.runtime.ipc.initial-sidebar-bootstrap"),
  threadListInvalidation: requiredPoint("gateway.runtime.ipc.thread-list-invalidation"),
  liveObserver: requiredPoint("gateway.runtime.ipc.live-observer"),
  workspaceContext: requiredPoint("gateway.runtime.ipc.workspace-context"),
  openFileContext: requiredPoint("gateway.runtime.ipc.open-file-context"),
  computerUseAuth: requiredPoint("gateway.runtime.ipc.computer-use-auth"),
});

const staticMain = Object.freeze({
  nativePetFactory: requiredPoint("static.cache.main.native-pet.factory"),
  nativePetPrewarm: requiredPoint("static.cache.main.native-pet.prewarm"),
  nativePetRestore: requiredPoint("static.cache.main.native-pet.restore"),
  macosPushRegistration: requiredPoint("static.cache.main.macos-push-registration"),
  gitOriginResolver: requiredPoint("static.cache.main.git-origin-resolver"),
  gitLocalPrefilter: requiredPoint("static.cache.main.git-local-prefilter"),
  gitBackgroundCommand: requiredPoint("static.cache.main.git-background-command"),
  worktreeShellEnvironment: requiredPoint("static.cache.main.worktree-shell-environment"),
});

const staticRenderer = Object.freeze({
  htmlLang: requiredPoint("static.cache.renderer.html.lang"),
  htmlViewport: requiredPoint("static.cache.renderer.html.viewport"),
  iconPwa: requiredPoint("static.cache.renderer.html.icon-pwa"),
  assetPathMap: requiredPoint("static.cache.renderer.html.asset-path-map"),
  fontPreload: requiredPoint("static.cache.renderer.html.font-preload"),
  runtimeBootstrap: requiredPoint("static.cache.renderer.html.runtime-bootstrap"),
  startupPreload: requiredPoint("static.cache.renderer.html.startup-preload"),
  sidebarPreview: requiredPoint("static.cache.renderer.html.sidebar-preview"),
  loadingAnimation: requiredPoint("static.cache.renderer.html.loading-animation"),
  assetNamespace: requiredPoint("static.cache.renderer.asset-namespace"),
  cspUnsafeEval: requiredPoint("static.cache.renderer.csp.unsafe-eval"),
  cspManifestSrc: requiredPoint("static.cache.renderer.csp.manifest-src"),
  historyTurnSignals: requiredPoint("static.cache.renderer.history-turn-signals"),
  applicationMenu: requiredPoint("static.cache.renderer.application-menu"),
  appServerRequestScheduling: requiredPoint("static.cache.renderer.app-server-request-scheduling"),
  pluginImageLazyLoad: requiredPoint("static.cache.renderer.plugin-image-lazy-load"),
  openInFolderLocale: requiredPoint("static.cache.renderer.open-in-folder-locale"),
});

const runner = Object.freeze({
  macosBackgroundBundle: requiredPoint("static.cache.runner.macos-background-bundle"),
  macosEntrySignature: requiredPoint("static.cache.runner.macos-entry-signature"),
  portableLayout: requiredPoint("static.cache.runner.portable-layout"),
  gatewayAsar: requiredPoint("static.cache.runner.gateway-asar"),
  windowsAsarIntegrity: requiredPoint("static.cache.runner.windows-asar-integrity"),
});

module.exports = Object.freeze({ gateway, staticMain, staticRenderer, runner });
