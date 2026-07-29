const childProcess = require("child_process");
const electron = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");
const util = require("util");
const { AsyncLocalStorage } = require("async_hooks");
const { EventEmitter } = require("events");
const {
  AUTH_CONFIG_PATH,
  CODEX_HOME,
  DEBUG_LOGS,
  HOST,
  MESSAGE_FOR_VIEW_CHANNEL,
  MESSAGE_FROM_VIEW_CHANNEL,
  PORT,
  PROJECT_ROOT,
  REPORTS_DIR,
  RUNTIME_DIR,
  TARGETED_MESSAGE_TYPES,
  UNKNOWN_IPC_PATH,
  WEB_SHELL_DIR,
  ensureDir,
  exists,
  officialDataDir,
  officialRuntimeUserDataDir,
  officialRuntimeTempDir,
  workspaceRootsFromEnv,
} = require("../core/config.cjs");
const { persistedAtomSnapshotForRenderer } = require("../state/desktop-state.cjs");
const { diagnosticLog, diagnosticWarn, shortId } = require("../core/diagnostics.cjs");
const { resolveOpenCodexI18n } = require("../../../shared/i18n/index.cjs");
const { withPluginI18nMessages } = require("../core/plugin-assets.cjs");
const {
  handleOfficialNotificationEvent,
  installOfficialNotificationHook,
  officialNotificationHookStatus,
} = require("../electron/official-notification-hook.cjs");
const { hiddenTrayHookStatus, installOfficialTrayHook } = require("../electron/official-tray-hook.cjs");
const { createOfficialLiveObserver } = require("./official-live-observer.cjs");

const { app, ipcMain } = electron;

// 这个模块把官方 Electron main 当作“隐藏后台 runtime”加载，并拦截它注册的 IPC 能力。
// AsyncLocalStorage 用来把 HTTP 请求的 clientId 传给异步 IPC 回包路由。
const requestContext = new AsyncLocalStorage();
// requestRoutes 保存 requestId -> clientId，解决流式响应跨异步回调后仍要回到同一个浏览器连接的问题。
const requestRoutes = new Map();
// requestRouteSummaries 保存 requestId 对应的入站摘要，让出站 fetch-response 日志也能带上原始 URL。
const requestRouteSummaries = new Map();
let officialBundle = null;
let wsHub = null;
let appServerChildDecorator = null;
let removeWsClientReadyListener = null;
// 官方 runtime 会把自身 TMPDIR 改到隔离目录；observer 必须在此之前记住原始 fallback socket。
const ORIGINAL_SYSTEM_TMPDIR = os.tmpdir();

function officialDesktopIpcSocketPaths(platform = process.platform) {
  // Windows 的 Node IPC 使用 named pipe；Unix socket 路径在该平台不会建立连接。
  if (platform === "win32") return ["\\\\.\\pipe\\codex-ipc"];
  const uid =
    typeof process.getuid === "function"
      ? String(process.getuid())
      : String(os.userInfo().username || "user");
  return [
    path.join(CODEX_HOME, "ipc", "ipc.sock"),
    path.join(ORIGINAL_SYSTEM_TMPDIR, "codex-ipc", `ipc-${uid}.sock`),
  ];
}

const officialLiveObserver = createOfficialLiveObserver({
  socketPaths: officialDesktopIpcSocketPaths(),
  publish(payload) {
    if (wsHub) wsHub.broadcast(payload, { suppressDiagnostic: true });
  },
  onError(error) {
    diagnosticWarn("official-live-observer", "observer_error", {
      error: error instanceof Error ? error.message : String(error),
    });
  },
});

const officialIpc = {
  // 官方 main 调 ipcMain.handle/on 注册的 handler 会被这里记录，再由 HTTP IPC invoke 复用。
  handlers: new Map(),
  listeners: new Map(),
  hiddenWindow: null,
  hiddenWebContents: null,
};

const appServerSpawnHook = {
  installed: false,
  patchedModules: 0,
  interceptCount: 0,
  lastInterceptAt: null,
  lastLauncher: null,
  lastCommand: null,
  lastArgs: null,
  replacementBinaryPath: null,
  decoratedCount: 0,
  decoratorError: null,
  lastError: null,
};

const COMPUTER_USE_AUTH_URLS = new Set([
  "computer-use-background-auth-read",
  "computer-use-background-auth-write",
]);
const CHUNKED_MESSAGE_ACK_CHANNEL = "codex_desktop:chunked-message-ack";
const CHUNKED_MESSAGE_MARKER = "codex-host-chunked-message-v1";
const INITIAL_SIDEBAR_BOOTSTRAP_CHANNEL = "codex_desktop:get-initial-sidebar-bootstrap";
let lastInitialSidebarBootstrap = null;
let hasWarnedInitialSidebarBootstrapFailure = false;
const COMPUTER_USE_INSTALLER_RELATIVE_PATH = [
  "computer-use",
  "Codex Computer Use.app",
  "Contents",
  "SharedSupport",
  "Codex Computer Use Installer.app",
  "Contents",
  "MacOS",
  "Codex Computer Use Installer",
];

function realpathSafeLocal(filePath) {
  try {
    return fs.realpathSync.native ? fs.realpathSync.native(filePath) : fs.realpathSync(filePath);
  } catch {
    return null;
  }
}

function sameRealpath(left, right) {
  const leftReal = realpathSafeLocal(left);
  const rightReal = realpathSafeLocal(right);
  return !!leftReal && !!rightReal && leftReal === rightReal;
}

function computerUseAuthActionFromUrl(url) {
  if (typeof url !== "string" || !url) return "";
  try {
    const parsed = new URL(url, "http://opencodex.local");
    const action = parsed.pathname.replace(/^\/+/, "");
    return COMPUTER_USE_AUTH_URLS.has(action) ? action : "";
  } catch {
    const match = String(url).match(/computer-use-background-auth-(?:read|write)(?:[/?#]|$)/);
    return match ? match[0].replace(/[/?#]$/g, "") : "";
  }
}

function computerUseInstallerPath() {
  // 官方 read/write handler 也是从 CODEX_HOME/computer-use 下找 Installer；诊断必须走同一条路径。
  return path.join(process.env.CODEX_HOME || CODEX_HOME, ...COMPUTER_USE_INSTALLER_RELATIVE_PATH);
}

function readComputerUseInstallerStatusForDiagnostics() {
  if (process.platform !== "darwin") {
    return { installerStatusSupported: false, installerStatusReason: "unsupported_platform" };
  }
  const installerPath = computerUseInstallerPath();
  if (!exists(installerPath)) {
    return {
      installerStatusSupported: true,
      installerPath,
      installerStatusReason: "missing_installer",
      installerInstalled: false,
    };
  }
  const startedAt = Date.now();
  try {
    const result = childProcess.spawnSync(installerPath, ["status"], {
      encoding: "utf8",
      env: { ...process.env },
      timeout: 120_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = String(result.stdout || "").trim();
    const stderr = String(result.stderr || "").trim();
    return {
      installerStatusSupported: true,
      installerPath,
      installerExitCode: result.status,
      installerSignal: result.signal || "",
      installerStdout: stdout,
      installerStderr: stderr,
      installerError: result.error ? result.error.message : "",
      installerInstalled: stdout === "OK: installed",
      installerElapsedMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      installerStatusSupported: true,
      installerPath,
      installerStatusReason: "status_failed",
      installerError: error instanceof Error ? error.message : String(error),
      installerInstalled: false,
      installerElapsedMs: Date.now() - startedAt,
    };
  }
}

function spawnOptionsFromArgs(args, options) {
  return Array.isArray(args) ? options : args;
}

function spawnArgList(args) {
  return Array.isArray(args) ? args.map((item) => String(item)) : [];
}

function shouldInterceptRemoteFileManagerStore(store) {
  return !!store && store.isLoopbackBrowserHost === false && store.openFileTarget === "fileManager";
}

function currentRequestStore() {
  return (requestContext && typeof requestContext.getStore === "function" && requestContext.getStore()) || {};
}

function sendCurrentClientGatewayEvent(channel, payload, diagnosticSummary = {}) {
  const store = currentRequestStore();
  if (!wsHub || !store.clientId) {
    diagnosticWarn("official-runtime", "remote_file_manager_download_client_missing", {
      channel,
      clientId: store.clientId ? shortId(store.clientId) : "",
      ...diagnosticSummary,
    });
    return false;
  }
  return wsHub.sendTo(
    store.clientId,
    { channel, payload },
    {
      diagnosticSummary: {
        channel,
        clientId: shortId(store.clientId),
        ...diagnosticSummary,
      },
      suppressDiagnostic: true,
    }
  );
}

function emitRemoteFileDownloadError(reason, filePath) {
  // 远端浏览器无法打开服务端文件管理器，失败时也要阻止原生打开并给前端一个 toast 入口。
  return sendCurrentClientGatewayEvent(
    "codex-web:download-file-error",
    {
      name: filePath ? path.basename(filePath) : "",
      reason,
    },
    { reason }
  );
}

function createSuccessfulSpawnStub() {
  const child = new EventEmitter();
  child.stdin = null;
  child.stdout = null;
  child.stderr = null;
  child.pid = 0;
  child.killed = false;
  child.kill = () => false;
  // 被拦截的系统打开动作等价于“已经处理完成”，避免官方 handler 继续等待子进程。
  process.nextTick(() => {
    child.emit("exit", 0, null);
    child.emit("close", 0, null);
  });
  return child;
}

function fileManagerPathFromSpawn(command, normalizedArgs) {
  const commandName = path.basename(String(command || "")).toLowerCase();
  const args = Array.isArray(normalizedArgs) ? normalizedArgs.map((item) => String(item)) : [];
  if (!commandName || args.length === 0) return "";
  if (commandName === "open") {
    const revealIndex = args.indexOf("-R");
    return revealIndex >= 0 ? args[revealIndex + 1] || "" : "";
  }
  if (
    commandName === "xdg-open" ||
    commandName === "gio" ||
    commandName === "explorer" ||
    commandName === "explorer.exe"
  ) {
    return args.find((item) => item && !item.startsWith("-")) || "";
  }
  return "";
}

function maybeInterceptRemoteFileManagerOpen(filePath) {
  const store = currentRequestStore();
  if (!shouldInterceptRemoteFileManagerStore(store)) return false;
  const normalizedPath = typeof filePath === "string" ? filePath : String(filePath || "");
  if (!normalizedPath) {
    emitRemoteFileDownloadError("empty_path", "");
    return true;
  }
  try {
    const stats = fs.statSync(normalizedPath);
    if (!stats.isFile()) {
      emitRemoteFileDownloadError("not_file", normalizedPath);
      return true;
    }
  } catch {
    emitRemoteFileDownloadError("not_found", normalizedPath);
    return true;
  }
  if (typeof store.createLocalFileDownload !== "function") {
    emitRemoteFileDownloadError("download_unavailable", normalizedPath);
    return true;
  }
  try {
    const payload = store.createLocalFileDownload(normalizedPath);
    sendCurrentClientGatewayEvent("codex-web:download-file", payload, {
      fileName: path.basename(normalizedPath),
      remoteBrowserHost: store.browserHostname || "",
    });
    diagnosticLog("official-runtime", "remote_file_manager_open_intercepted", {
      clientId: shortId(store.clientId || ""),
      fileName: path.basename(normalizedPath),
      remoteBrowserHost: store.browserHostname || "",
    });
  } catch (error) {
    diagnosticWarn("official-runtime", "remote_file_manager_download_failed", {
      error: error instanceof Error ? error.message : String(error),
      fileName: path.basename(normalizedPath),
    });
    emitRemoteFileDownloadError("download_failed", normalizedPath);
  }
  return true;
}

function execFileOptionsFromArgs(args, options) {
  if (Array.isArray(args)) return typeof options === "function" ? undefined : options;
  return typeof args === "function" ? undefined : args;
}

function execFileCallbackFromArgs(args, options, callback) {
  if (Array.isArray(args)) return typeof options === "function" ? options : callback;
  if (typeof args === "function") return args;
  if (typeof options === "function") return options;
  return callback;
}

function looksLikeOfficialCodexBinary(command, bundle, spawnOptions) {
  if (!bundle || typeof command !== "string" || !bundle.codexBinaryPath) return false;
  if (sameRealpath(command, bundle.codexBinaryPath)) return true;

  const cwd = spawnOptions && typeof spawnOptions.cwd === "string" ? spawnOptions.cwd : process.cwd();
  // 官方实现可能传绝对路径、相对路径或裸命令；只在 app-server 参数命中时才替换，避免误伤其他子进程。
  if (sameRealpath(path.resolve(cwd, command), bundle.codexBinaryPath)) return true;
  return path.basename(command) === path.basename(bundle.codexBinaryPath);
}

function isHiddenOfficialAppServerArgs(args) {
  /**
   * 官方新版会在子命令前追加 `-c key=value` 等全局配置，因此不能假设 app-server 固定在第一个参数。
   * 命令本身已经通过官方 codex 二进制校验，这里只定位独立参数，避免配置值中的普通文本误命中。
   */
  return Array.isArray(args) && args.some((argument) => argument === "app-server");
}

function looksLikeComputerUseInstaller(command) {
  if (typeof command !== "string" || !command) return false;
  const normalized = command.replace(/\\/g, "/");
  return normalized.includes("/computer-use/") && path.basename(command) === "Codex Computer Use Installer";
}

function summarizeInstallerOutput(value) {
  if (Buffer.isBuffer(value)) return value.toString("utf8").trim();
  return String(value || "").trim();
}

function wrapComputerUseInstallerExecCallback(command, normalizedArgs, callback) {
  if (typeof callback !== "function") return callback;
  const startedAt = Date.now();
  // 官方 read/write 会吞掉部分异常；这里把真实 Installer 子进程结果单独打出来，便于定位授权状态误判。
  diagnosticLog("computer-use-auth", "installer_execfile_start", {
    command,
    args: normalizedArgs,
  });
  return (error, stdout, stderr) => {
    diagnosticLog("computer-use-auth", "installer_execfile_end", {
      command,
      args: normalizedArgs,
      elapsedMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : error ? String(error) : "",
      stdout: summarizeInstallerOutput(stdout),
      stderr: summarizeInstallerOutput(stderr),
    });
    return callback(error, stdout, stderr);
  };
}

function recordHiddenAppServerRedirect(launcher, command, normalizedArgs, replacementBinaryPath) {
  appServerSpawnHook.interceptCount += 1;
  appServerSpawnHook.lastInterceptAt = new Date().toISOString();
  appServerSpawnHook.lastLauncher = launcher;
  appServerSpawnHook.lastCommand = command;
  appServerSpawnHook.lastArgs = normalizedArgs;
  appServerSpawnHook.replacementBinaryPath = replacementBinaryPath;
  appServerSpawnHook.lastError = null;
  diagnosticLog("official-runtime", "app_server_spawn_hook_redirected", {
    launcher,
    command,
    args: normalizedArgs,
    replacementBinaryPath,
  });
}

function decorateHiddenAppServerChild(child) {
  if (typeof appServerChildDecorator !== "function") return child;
  try {
    const decorated = appServerChildDecorator(child) || child;
    appServerSpawnHook.decoratedCount += 1;
    appServerSpawnHook.decoratorError = null;
    return decorated;
  } catch (error) {
    // 装饰失败时保留官方原始连接，避免可选 Auto 能力影响 Codex 的基础可用性。
    appServerSpawnHook.decoratorError = error instanceof Error ? error.message : String(error);
    diagnosticWarn("official-runtime", "app_server_decorator_failed", { error: appServerSpawnHook.decoratorError });
    return child;
  }
}

function redirectHiddenAppServerSpawn(originalSpawn, bundle, self, command, args, options, rawArguments) {
  const spawnOptions = spawnOptionsFromArgs(args, options);
  const normalizedArgs = spawnArgList(args);
  if (looksLikeOfficialCodexBinary(command, bundle, spawnOptions) && isHiddenOfficialAppServerArgs(normalizedArgs)) {
    recordHiddenAppServerRedirect("spawn", command, normalizedArgs, bundle.codexBinaryPath);
    return decorateHiddenAppServerChild(originalSpawn.call(self, bundle.codexBinaryPath, normalizedArgs, spawnOptions));
  }
  const fileManagerPath = fileManagerPathFromSpawn(command, normalizedArgs);
  if (fileManagerPath && maybeInterceptRemoteFileManagerOpen(fileManagerPath)) {
    return createSuccessfulSpawnStub();
  }
  return originalSpawn.apply(self, rawArguments);
}

function redirectHiddenAppServerExecFile(originalExecFile, bundle, self, command, args, options, callback, rawArguments) {
  const execOptions = execFileOptionsFromArgs(args, options);
  const normalizedArgs = spawnArgList(args);
  if (looksLikeOfficialCodexBinary(command, bundle, execOptions) && isHiddenOfficialAppServerArgs(normalizedArgs)) {
    const execCallback = execFileCallbackFromArgs(args, options, callback);
    recordHiddenAppServerRedirect("execFile", command, normalizedArgs, bundle.codexBinaryPath);
    return decorateHiddenAppServerChild(
      originalExecFile.call(self, bundle.codexBinaryPath, normalizedArgs, execOptions, execCallback)
    );
  }
  if (looksLikeComputerUseInstaller(command)) {
    const execCallback = execFileCallbackFromArgs(args, options, callback);
    const wrappedCallback = wrapComputerUseInstallerExecCallback(command, normalizedArgs, execCallback);
    if (wrappedCallback) {
      return originalExecFile.call(self, command, normalizedArgs, execOptions, wrappedCallback);
    }
  }
  return originalExecFile.apply(self, rawArguments);
}

function patchChildProcessModule(moduleRef, bundle) {
  if (!moduleRef || typeof moduleRef.spawn !== "function") return false;
  if (moduleRef.__opencodexAppServerSpawnHookPatched) return false;

  const originalSpawn = moduleRef.spawn;
  moduleRef.spawn = function opencodexAppServerSpawnHook(command, args, options) {
    return redirectHiddenAppServerSpawn(originalSpawn, bundle, this, command, args, options, arguments);
  };
  if (typeof moduleRef.execFile === "function") {
    const originalExecFile = moduleRef.execFile;
    const wrappedExecFile = function opencodexAppServerExecFileHook(command, args, options, callback) {
      return redirectHiddenAppServerExecFile(originalExecFile, bundle, this, command, args, options, callback, arguments);
    };
    wrappedExecFile[util.promisify.custom] = function opencodexPromisifiedExecFile(command, args, options) {
      /**
       * 官方 main 大量使用 promisify(child_process.execFile)，并依赖返回值是 { stdout, stderr }。
       * 如果只替换 execFile 而不补回 custom promisify，Node 会退化成“只返回第一个成功参数”，
       * 进而让官方 Computer Use 的 status 结果从 OK 误判成 false。
       */
      let child = null;
      const promise = new Promise((resolve, reject) => {
        child = wrappedExecFile.call(this, command, args, options, (error, stdout, stderr) => {
          if (error) {
            error.stdout = stdout;
            error.stderr = stderr;
            reject(error);
            return;
          }
          resolve({ stdout, stderr });
        });
      });
      promise.child = child;
      return promise;
    };
    moduleRef.execFile = wrappedExecFile;
  }
  moduleRef.__opencodexAppServerSpawnHookPatched = true;
  return true;
}

function installAppServerSpawnHook(bundle) {
  try {
    const modules = new Set([childProcess]);
    try {
      modules.add(require("node:child_process"));
    } catch {}
    let patched = 0;
    for (const moduleRef of modules) {
      if (patchChildProcessModule(moduleRef, bundle)) patched += 1;
    }
    appServerSpawnHook.installed = true;
    appServerSpawnHook.patchedModules += patched;
    appServerSpawnHook.replacementBinaryPath = bundle.codexBinaryPath;
    appServerSpawnHook.lastError = null;
    diagnosticLog("official-runtime", "app_server_spawn_hook_ready", {
      codexBinaryPath: bundle.codexBinaryPath,
      patchedModules: appServerSpawnHook.patchedModules,
    });
  } catch (error) {
    appServerSpawnHook.lastError = error instanceof Error ? error.message : String(error);
    diagnosticWarn("official-runtime", "app_server_spawn_hook_failed", { error: appServerSpawnHook.lastError });
    throw error;
  }
}

function appServerSpawnHookStatus() {
  return {
    installed: appServerSpawnHook.installed,
    patchedModules: appServerSpawnHook.patchedModules,
    interceptCount: appServerSpawnHook.interceptCount,
    lastInterceptAt: appServerSpawnHook.lastInterceptAt,
    lastLauncher: appServerSpawnHook.lastLauncher,
    lastCommand: appServerSpawnHook.lastCommand,
    lastArgs: appServerSpawnHook.lastArgs,
    replacementBinaryPath: appServerSpawnHook.replacementBinaryPath,
    decoratedCount: appServerSpawnHook.decoratedCount,
    decoratorError: appServerSpawnHook.decoratorError,
    lastError: appServerSpawnHook.lastError,
  };
}

function setWsHub(nextWsHub) {
  // server.cjs 创建 WebSocket hub 后再注入，避免 runtime 层反向依赖 HTTP server。
  removeWsClientReadyListener?.();
  wsHub = nextWsHub;
  // Web config 首次加载可能早于浏览器 WS hello；页面真正注册后再重发一次 following，确保快照不丢。
  removeWsClientReadyListener =
    typeof nextWsHub?.onClientReady === "function"
      ? nextWsHub.onClientReady(() => officialLiveObserver.refresh())
      : null;
}

function getOfficialBundle() {
  return officialBundle;
}

function requireOfficialBundleProvider() {
  // provider 是 TypeScript build 产物；缺失时直接提示先 build gateway。
  const providerPath = path.join(PROJECT_ROOT, "gateway", "dist", "official", "LocalCodexBundleProvider.js");
  if (!exists(providerPath)) {
    throw new Error(`Missing gateway build: ${providerPath}. Run pnpm run build:gateway first.`);
  }
  return require(providerPath);
}

function setProcessResourcesPath(resourcesPath) {
  if (!resourcesPath) return;
  try {
    // 官方代码会读取 process.resourcesPath 拼接二进制和资源路径，这里对齐到桌面应用的 Resources。
    Object.defineProperty(process, "resourcesPath", {
      configurable: true,
      enumerable: true,
      value: resourcesPath,
    });
  } catch {
    process.resourcesPath = resourcesPath;
  }
}

function setOfficialAppPath(bundleDir) {
  if (!bundleDir) return;
  try {
    // 官方 bootstrap 会通过 app.getAppPath() 读取 package metadata，这里指回抽取后的官方 bundle。
    app.getAppPath = () => bundleDir;
  } catch {}
}

function setOfficialPackagedMode() {
  try {
    // gateway 复用的是已安装 Codex/ChatGPT Desktop 的生产资源，不能让官方 main 走 localhost dev server。
    Object.defineProperty(app, "isPackaged", {
      configurable: true,
      get: () => true,
    });
  } catch {}
}

function alignOfficialElectronEnvironment(bundle) {
  /**
   * 官方 main 认为自己运行在已打包桌面应用中。
   * gateway 需要把 app path、resourcesPath、userData 和 build flavor 都伪装成官方生产环境，
   * 否则官方 bootstrap 会尝试连接开发服务器或找不到内置 codex 二进制。
   */
  const runtimeUserDataDir = officialRuntimeUserDataDir();
  const runtimeTempDir = officialRuntimeTempDir();
  // CODEX_HOME 才是需要共享的核心数据；Electron profile 只保存运行态缓存，不能和官方桌面端抢同一把锁。
  ensureDir(runtimeUserDataDir);
  // 官方跨进程 live IPC bus 基于 os.tmpdir() 建 socket；这里必须和官方 Desktop 隔离，避免抢会话 owner。
  ensureDir(runtimeTempDir);
  try {
    fs.chmodSync(runtimeTempDir, 0o700);
  } catch {}
  process.env.CODEX_ELECTRON_USER_DATA_PATH = process.env.CODEX_ELECTRON_USER_DATA_PATH || runtimeUserDataDir;
  process.env.CODEX_HOME = process.env.CODEX_HOME || CODEX_HOME;
  process.env.TMPDIR = runtimeTempDir;
  process.env.TMP = runtimeTempDir;
  process.env.TEMP = runtimeTempDir;
  process.env.NODE_ENV = process.env.NODE_ENV || "production";
  // 官方 main 在开发态会从环境/package metadata 推导 build flavor；gateway 明确按 prod 对齐。
  process.env.BUILD_FLAVOR = process.env.BUILD_FLAVOR || "prod";
  process.env.npm_package_codexBuildFlavor = process.env.npm_package_codexBuildFlavor || "prod";
  if (bundle.build && bundle.build !== "unknown") {
    process.env.npm_package_codexBuildNumber = process.env.npm_package_codexBuildNumber || String(bundle.build);
  }
  const officialResourcesPath = bundle.sourceResourcesPath || path.dirname(bundle.sourceAsarPath || "");
  if (officialResourcesPath) {
    /**
     * 官方 bundled plugin 管理器支持这个 env 作为资源源目录。
     * 这里指回已安装桌面应用的 Resources/plugins，保持“复用官方资源”，不把插件复制进 OpenCodex cache/dist。
     */
    process.env.CODEX_ELECTRON_BUNDLED_PLUGINS_RESOURCES_PATH =
      process.env.CODEX_ELECTRON_BUNDLED_PLUGINS_RESOURCES_PATH || officialResourcesPath;
  }
  app.setName("Codex");
  if (bundle.version && bundle.version !== "unknown") app.setVersion(bundle.version);
  setOfficialPackagedMode();
  try {
    app.setPath("userData", runtimeUserDataDir);
  } catch {}
  diagnosticLog("official-runtime", "official_runtime_temp_dir_configured", {
    runtimeTempDir,
    reason: "isolate official live ipc bus from Codex Desktop",
  });
  diagnosticLog("official-runtime", "official_runtime_resources_configured", {
    resourcesPath: officialResourcesPath,
    bundledPluginsMarketplacePath: path.join(
      officialResourcesPath || "",
      "plugins",
      "openai-bundled",
      ".agents",
      "plugins",
      "marketplace.json"
    ),
    bundledPluginsMarketplaceExists: exists(
      path.join(officialResourcesPath || "", "plugins", "openai-bundled", ".agents", "plugins", "marketplace.json")
    ),
  });
  setProcessResourcesPath(officialResourcesPath);
  setOfficialAppPath(bundle.bundleDir);
}

function addOfficialListener(channel, listener) {
  const set = officialIpc.listeners.get(channel) || new Set();
  set.add(listener);
  officialIpc.listeners.set(channel, set);
}

function removeOfficialListener(channel, listener) {
  const set = officialIpc.listeners.get(channel);
  if (!set) return;
  set.delete(listener);
  if (set.size === 0) officialIpc.listeners.delete(channel);
}

function listenerCount() {
  return Array.from(officialIpc.listeners.values()).reduce((sum, set) => sum + set.size, 0);
}

function installIpcMainHooks() {
  /**
   * 官方 bootstrap 会在加载时调用 ipcMain.handle/on 注册能力。
   * 我们不改官方源码，只 monkey patch 注册入口，把 handler/listener 复制一份到 officialIpc。
   */
  if (ipcMain.__opencodexOfficialGatewayPatched) return;
  ipcMain.__opencodexOfficialGatewayPatched = true;

  // 先保存原生方法，记录官方 handler 的同时仍让 Electron 自己保持原有注册语义。
  const originalHandle = ipcMain.handle.bind(ipcMain);
  const originalHandleOnce = typeof ipcMain.handleOnce === "function" ? ipcMain.handleOnce.bind(ipcMain) : null;
  const originalRemoveHandler = ipcMain.removeHandler.bind(ipcMain);
  const originalOn = ipcMain.on.bind(ipcMain);
  const originalAddListener = typeof ipcMain.addListener === "function" ? ipcMain.addListener.bind(ipcMain) : null;
  const originalOnce = ipcMain.once.bind(ipcMain);
  const originalPrependListener =
    typeof ipcMain.prependListener === "function" ? ipcMain.prependListener.bind(ipcMain) : null;
  const originalPrependOnceListener =
    typeof ipcMain.prependOnceListener === "function" ? ipcMain.prependOnceListener.bind(ipcMain) : null;
  const originalRemoveListener = ipcMain.removeListener.bind(ipcMain);
  const originalOff = typeof ipcMain.off === "function" ? ipcMain.off.bind(ipcMain) : null;
  const originalRemoveAllListeners = ipcMain.removeAllListeners.bind(ipcMain);

  ipcMain.handle = (channel, listener) => {
    officialIpc.handlers.set(String(channel), listener);
    return originalHandle(channel, listener);
  };
  if (originalHandleOnce) {
    ipcMain.handleOnce = (channel, listener) => {
      const wrapped = async (...args) => {
        officialIpc.handlers.delete(String(channel));
        return listener(...args);
      };
      officialIpc.handlers.set(String(channel), wrapped);
      return originalHandleOnce(channel, wrapped);
    };
  }
  ipcMain.removeHandler = (channel) => {
    officialIpc.handlers.delete(String(channel));
    return originalRemoveHandler(channel);
  };
  ipcMain.on = (channel, listener) => {
    addOfficialListener(String(channel), listener);
    return originalOn(channel, listener);
  };
  if (originalAddListener) {
    ipcMain.addListener = (channel, listener) => {
      addOfficialListener(String(channel), listener);
      return originalAddListener(channel, listener);
    };
  }
  ipcMain.once = (channel, listener) => {
    const wrapped = (...args) => {
      removeOfficialListener(String(channel), wrapped);
      return listener(...args);
    };
    addOfficialListener(String(channel), wrapped);
    return originalOnce(channel, wrapped);
  };
  if (originalPrependListener) {
    ipcMain.prependListener = (channel, listener) => {
      addOfficialListener(String(channel), listener);
      return originalPrependListener(channel, listener);
    };
  }
  if (originalPrependOnceListener) {
    ipcMain.prependOnceListener = (channel, listener) => {
      const wrapped = (...args) => {
        removeOfficialListener(String(channel), wrapped);
        return listener(...args);
      };
      addOfficialListener(String(channel), wrapped);
      return originalPrependOnceListener(channel, wrapped);
    };
  }
  ipcMain.removeListener = (channel, listener) => {
    removeOfficialListener(String(channel), listener);
    return originalRemoveListener(channel, listener);
  };
  if (originalOff) {
    ipcMain.off = (channel, listener) => {
      removeOfficialListener(String(channel), listener);
      return originalOff(channel, listener);
    };
  }
  ipcMain.removeAllListeners = (channel) => {
    if (typeof channel === "string") {
      officialIpc.listeners.delete(channel);
    } else {
      officialIpc.listeners.clear();
    }
    return originalRemoveAllListeners(channel);
  };
}

function hideOfficialWindow(win) {
  // 官方窗口仍要真实创建，因为官方 renderer 会初始化 app-server 连接；这里只把它从用户视野里移走。
  try {
    win.setOpacity(0);
  } catch {}
  try {
    win.setPosition(-32000, -32000, false);
  } catch {}
  try {
    win.hide();
  } catch {}
  try {
    win.setSkipTaskbar(true);
  } catch {}
}

function sameWebContents(left, right) {
  if (!left || !right) return false;
  if (left === right) return true;
  return typeof left.id === "number" && typeof right.id === "number" && left.id === right.id;
}

function isOfficialHiddenWebContents(webContents) {
  return sameWebContents(webContents, officialIpc.hiddenWebContents);
}

function isHiddenOfficialDialogParent(parent) {
  // 官方新版会把目录选择器挂到 event.sender 对应窗口；OpenCodex 的官方窗口是隐藏后台窗口，不能作为可见弹窗 parent。
  if (!parent) return false;
  if (parent === officialIpc.hiddenWindow || parent.__opencodexOfficialGatewayRegistered === true) return true;
  if (
    officialIpc.hiddenWindow &&
    typeof parent.id === "number" &&
    typeof officialIpc.hiddenWindow.id === "number" &&
    parent.id === officialIpc.hiddenWindow.id
  ) {
    return true;
  }
  return isOfficialHiddenWebContents(parent.webContents);
}

function dialogOptionsSummary(options) {
  return {
    title: options && typeof options.title === "string" ? options.title : "",
    properties:
      options && Array.isArray(options.properties)
        ? options.properties.filter((item) => typeof item === "string").join(",")
        : "",
  };
}

function dialogParentSummary(parent) {
  const parentWebContents = parent && parent.webContents ? parent.webContents : null;
  let parentVisible = null;
  try {
    parentVisible = parent && typeof parent.isVisible === "function" ? parent.isVisible() : null;
  } catch {}
  return {
    hasParent: !!parent,
    parentId: parent && typeof parent.id === "number" ? parent.id : null,
    parentWebContentsId: parentWebContents && typeof parentWebContents.id === "number" ? parentWebContents.id : null,
    hiddenWindowId:
      officialIpc.hiddenWindow && typeof officialIpc.hiddenWindow.id === "number" ? officialIpc.hiddenWindow.id : null,
    hiddenWebContentsId:
      officialIpc.hiddenWebContents && typeof officialIpc.hiddenWebContents.id === "number"
        ? officialIpc.hiddenWebContents.id
        : null,
    parentRegistered: !!(parent && parent.__opencodexOfficialGatewayRegistered),
    parentVisible,
  };
}

function dialogProperties(options) {
  return options && Array.isArray(options.properties) ? options.properties : [];
}

function canUseAppleScriptOpenDirectoryDialog(options) {
  if (process.platform !== "darwin") return false;
  const properties = dialogProperties(options);
  return properties.includes("openDirectory") && !properties.includes("openFile");
}

function appleScriptOpenDirectoryArgs(options) {
  const title = options && typeof options.title === "string" && options.title.trim() ? options.title : "Select Folder";
  const allowMultiple = dialogProperties(options).includes("multiSelections");
  const body = allowMultiple
    ? [
        "set pickedFolders to choose folder with prompt promptText with multiple selections allowed",
        'set outputText to ""',
        "repeat with pickedFolder in pickedFolders",
        "set outputText to outputText & POSIX path of pickedFolder & linefeed",
        "end repeat",
        "return outputText",
      ]
    : ["set pickedFolder to choose folder with prompt promptText", "return POSIX path of pickedFolder"];
  const script = ["on run argv", "set promptText to item 1 of argv", ...body, "end run"];
  return {
    allowMultiple,
    args: script.flatMap((line) => ["-e", line]).concat(title),
    title,
  };
}

function normalizeAppleScriptFolderPath(filePath) {
  const normalized = String(filePath || "").trim();
  return normalized.length > 1 ? normalized.replace(/\/+$/g, "") : normalized;
}

function isAppleScriptUserCanceled(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  const stderr = error && typeof error === "object" && typeof error.stderr === "string" ? error.stderr : "";
  return /User canceled|-128/.test(`${message}\n${stderr}`);
}

function execFileForDialog(command, args, options) {
  return new Promise((resolve, reject) => {
    childProcess.execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function showOpenDirectoryDialogViaAppleScript(options) {
  const script = appleScriptOpenDirectoryArgs(options);
  try {
    // LSBackgroundOnly 的 gateway 进程不适合作为原生目录选择器宿主；用 osascript 让系统直接显示可见选择器。
    const result = await execFileForDialog("/usr/bin/osascript", script.args, {
      encoding: "utf8",
      maxBuffer: 64 * 1024,
    });
    const filePaths = String(result.stdout || "")
      .split(/\r?\n/)
      .map(normalizeAppleScriptFolderPath)
      .filter(Boolean);
    diagnosticLog("official-runtime", "dialog_applescript_open_directory_end", {
      ...dialogOptionsSummary(options),
      allowMultiple: script.allowMultiple,
      count: filePaths.length,
    });
    return filePaths.length > 0 ? { canceled: false, filePaths } : { canceled: true, filePaths: [] };
  } catch (error) {
    if (isAppleScriptUserCanceled(error)) {
      diagnosticLog("official-runtime", "dialog_applescript_open_directory_canceled", dialogOptionsSummary(options));
      return { canceled: true, filePaths: [] };
    }
    diagnosticWarn("official-runtime", "dialog_applescript_open_directory_failed", {
      ...dialogOptionsSummary(options),
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

function installDialogHooks() {
  if (electron.dialog.__opencodexOfficialGatewayDialogPatched) return;
  electron.dialog.__opencodexOfficialGatewayDialogPatched = true;
  const originalShowOpenDialog = electron.dialog.showOpenDialog.bind(electron.dialog);
  diagnosticLog("official-runtime", "dialog_hook_installed");

  electron.dialog.showOpenDialog = function patchedShowOpenDialog(parentOrOptions, maybeOptions) {
    if (isHiddenOfficialDialogParent(parentOrOptions)) {
      const options = maybeOptions || {};
      const mode = canUseAppleScriptOpenDirectoryDialog(options) ? "osascript_open_directory" : "electron_unparented";
      diagnosticLog("official-runtime", "dialog_hidden_parent_detached", {
        ...dialogParentSummary(parentOrOptions),
        ...dialogOptionsSummary(options),
        mode,
      });
      if (canUseAppleScriptOpenDirectoryDialog(options)) return showOpenDirectoryDialogViaAppleScript(options);
      // 非目录选择器继续去掉隐藏 parent，恢复 2.0.0 时无 parent 的系统弹窗行为。
      return originalShowOpenDialog(options);
    }
    if (arguments.length <= 1) return originalShowOpenDialog(parentOrOptions);
    return originalShowOpenDialog(parentOrOptions, maybeOptions);
  };
}

function installRemoteFileManagerOpenHooks() {
  const shell = electron && electron.shell;
  if (!shell || shell.__opencodexRemoteFileManagerOpenPatched) return;
  shell.__opencodexRemoteFileManagerOpenPatched = true;
  if (typeof shell.showItemInFolder === "function") {
    const originalShowItemInFolder = shell.showItemInFolder.bind(shell);
    shell.showItemInFolder = function patchedShowItemInFolder(targetPath) {
      if (maybeInterceptRemoteFileManagerOpen(String(targetPath || ""))) return undefined;
      return originalShowItemInFolder(targetPath);
    };
  }
  if (typeof shell.openPath === "function") {
    const originalOpenPath = shell.openPath.bind(shell);
    shell.openPath = function patchedOpenPath(targetPath) {
      if (maybeInterceptRemoteFileManagerOpen(String(targetPath || ""))) return Promise.resolve("");
      return originalOpenPath(targetPath);
    };
  }
}

function payloadFromArgs(args) {
  return args.length <= 1 ? (args[0] ?? null) : args;
}

function isOfficialChunkToken(token) {
  if (!token || typeof token !== "object" || typeof token.type !== "string") return false;
  if (["array-start", "object-start", "container-end", "string-end"].includes(token.type)) return true;
  if (token.type === "string-start") return token.target === "key" || token.target === "value";
  if (token.type === "key" || token.type === "string-chunk") return typeof token.value === "string";
  if (token.type === "value") {
    // 官方序列化器用省略 value 字段表达 undefined，不能把这类合法 token 当成协议损坏。
    if (!("value" in token)) return true;
    return (
      token.value == null ||
      typeof token.value === "boolean" ||
      typeof token.value === "number" ||
      typeof token.value === "string"
    );
  }
  return false;
}

function isOfficialChunkedMessage(value) {
  if (!value || typeof value !== "object") return false;
  if (value.marker !== CHUNKED_MESSAGE_MARKER) return false;
  if (typeof value.transferId !== "string") return false;
  if (!Number.isSafeInteger(value.sequence) || typeof value.kind !== "string") return false;
  if (value.kind === "start" || value.kind === "end") return true;
  return value.kind === "chunk" && Array.isArray(value.tokens) && value.tokens.every(isOfficialChunkToken);
}

class OfficialChunkAssembler {
  constructor() {
    this.stack = [];
    this.root = OfficialChunkAssembler.UNSET;
    this.stringChunks = null;
    this.stringTarget = null;
  }

  consume(tokens) {
    for (const token of tokens) {
      switch (token.type) {
        case "array-start": {
          const value = [];
          this.saveValue(value);
          this.stack.push({ type: "array", value });
          break;
        }
        case "object-start": {
          const value = {};
          this.saveValue(value);
          this.stack.push({ key: null, type: "object", value });
          break;
        }
        case "container-end":
          if (!this.stack.pop()) throw new Error("Chunked message contained an unmatched container end");
          break;
        case "key":
          this.setKey(token.value);
          break;
        case "value":
          this.saveValue(token.value);
          break;
        case "string-start":
          if (this.stringChunks) throw new Error("Chunked message contained nested string chunks");
          this.stringChunks = [];
          this.stringTarget = token.target;
          break;
        case "string-chunk":
          if (!this.stringChunks) throw new Error("Chunked message string chunk had no start token");
          this.stringChunks.push(token.value);
          break;
        case "string-end": {
          if (!this.stringChunks || !this.stringTarget) {
            throw new Error("Chunked message string end had no start token");
          }
          const value = this.stringChunks.join("");
          const target = this.stringTarget;
          this.stringChunks = null;
          this.stringTarget = null;
          if (target === "key") this.setKey(value);
          else this.saveValue(value);
          break;
        }
      }
    }
  }

  finish() {
    if (
      this.root === OfficialChunkAssembler.UNSET ||
      this.stack.length > 0 ||
      this.stringChunks != null
    ) {
      throw new Error("Chunked message ended before its value was complete");
    }
    return this.root;
  }

  setKey(key) {
    const current = this.stack.at(-1);
    if (!current || current.type !== "object" || current.key != null) {
      throw new Error("Chunked message key was outside an object");
    }
    current.key = key;
  }

  saveValue(value) {
    const current = this.stack.at(-1);
    if (!current) {
      if (this.root !== OfficialChunkAssembler.UNSET) {
        throw new Error("Chunked message contained multiple root values");
      }
      this.root = value;
      return;
    }
    if (current.type === "array") {
      current.value.push(value);
      return;
    }
    if (current.key == null) throw new Error("Chunked message object value had no key");
    // defineProperty 避免 "__proto__" 这类合法数据键改变组装对象的原型。
    Object.defineProperty(current.value, current.key, {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    });
    current.key = null;
  }
}

OfficialChunkAssembler.UNSET = Symbol("official-chunk-unset");

class OfficialChunkedMessageReceiver {
  constructor() {
    this.transfers = new Map();
  }

  receive(message) {
    if (!isOfficialChunkedMessage(message)) return { type: "passthrough", message };
    if (message.kind === "start") {
      // 官方 preload 同一时刻只保留一条传输；新 start 到来时丢弃未完成的旧传输。
      this.transfers.clear();
      this.transfers.set(message.transferId, {
        assembler: new OfficialChunkAssembler(),
        nextSequence: message.sequence + 1,
      });
      return { type: "pending", acknowledgement: chunkAcknowledgement(message) };
    }

    const transfer = this.transfers.get(message.transferId);
    if (!transfer || message.sequence !== transfer.nextSequence) {
      this.transfers.delete(message.transferId);
      return { type: "pending", acknowledgement: null };
    }
    transfer.nextSequence += 1;
    if (message.kind === "chunk") {
      transfer.assembler.consume(message.tokens);
      return { type: "pending", acknowledgement: chunkAcknowledgement(message) };
    }

    this.transfers.delete(message.transferId);
    return {
      type: "complete",
      acknowledgement: chunkAcknowledgement(message),
      message: transfer.assembler.finish(),
    };
  }
}

function chunkAcknowledgement(message) {
  return {
    transferId: message.transferId,
    sequence: message.sequence,
  };
}

const officialChunkedMessageReceivers = new WeakMap();
const fallbackOfficialChunkedMessageReceiver = new OfficialChunkedMessageReceiver();

function officialChunkedMessageReceiverFor(sourceWebContents) {
  if (!sourceWebContents || (typeof sourceWebContents !== "object" && typeof sourceWebContents !== "function")) {
    return fallbackOfficialChunkedMessageReceiver;
  }
  let receiver = officialChunkedMessageReceivers.get(sourceWebContents);
  if (!receiver) {
    receiver = new OfficialChunkedMessageReceiver();
    officialChunkedMessageReceivers.set(sourceWebContents, receiver);
  }
  return receiver;
}

function normalizeIpcArgs(args) {
  return Array.isArray(args) ? args : [args];
}

function stringRouteId(value) {
  if (typeof value === "string" && value) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function routeIdFromValue(value, depth = 0, seen = new Set()) {
  if (value == null || depth > 5) return "";
  if (typeof value !== "object") return "";
  if (seen.has(value)) return "";
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = routeIdFromValue(item, depth + 1, seen);
      if (nested) return nested;
    }
    return "";
  }

  // 协议升级时优先按 shape 找 requestId / JSON-RPC id，而不是按固定 type 白名单判断。
  const requestId = stringRouteId(value.requestId);
  if (requestId) return requestId;
  for (const key of ["request", "message", "response", "payload", "body"]) {
    const nested = routeIdFromValue(value[key], depth + 1, seen);
    if (nested) return nested;
  }
  if (value.id != null && (depth > 0 || value.method || value.jsonrpc || value.type)) {
    return stringRouteId(value.id);
  }
  return "";
}

function requestRouteIdFromIncoming(_channel, args) {
  // 浏览器发来的任意 IPC 参数都可能带 requestId；用通用 shape 提取提升官方升级适配性。
  return routeIdFromValue(args);
}

function responseRouteIdFromOutgoing(_channel, args) {
  // 官方出站消息可能是 message-for-view 包裹，也可能是直接 channel；统一从 args 里找 id。
  return routeIdFromValue(args);
}

function responsePayloadType(channel, args) {
  const payload = payloadFromArgs(args);
  if (payload && typeof payload === "object" && typeof payload.type === "string") return payload.type;
  return channel;
}

function incomingIpcDiagnosticSummary(channel, payload) {
  const message = payloadFromArgs(payload);
  const summary = {
    channel,
  };
  if (message && typeof message === "object") {
    // invokeArgs 常是单元素数组；摘要要先拆出真实 payload，出站回包才能带上原始 URL。
    if (typeof message.type === "string") summary.sourceType = message.type;
    if (typeof message.url === "string") summary.url = message.url;
    if (typeof message.method === "string") summary.method = message.method;
    if (message.request && typeof message.request === "object") {
      if (message.request.id != null) summary.requestId = String(message.request.id);
      if (typeof message.request.method === "string") summary.requestMethod = message.request.method;
    }
  }
  return summary;
}

function fetchMessageFromIpcArgs(args) {
  const payload = payloadFromArgs(args);
  if (!payload || typeof payload !== "object") return null;
  if (payload.type !== "fetch") return null;
  return typeof payload.url === "string" ? payload : null;
}

function parseJsonLike(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function desiredComputerUseAuthEnabled(message) {
  const body = parseJsonLike(message && message.body) || parseJsonLike(message && message.bodyJsonString);
  return body && typeof body.enabled === "boolean" ? body.enabled : null;
}

function logComputerUseAuthRequest(channel, args) {
  if (channel !== MESSAGE_FROM_VIEW_CHANNEL) return;
  const message = fetchMessageFromIpcArgs(args);
  const action = message ? computerUseAuthActionFromUrl(message.url) : "";
  if (!action) return;
  diagnosticLog("computer-use-auth", "official_fetch_request", {
    action,
    requestId: shortId(stringRouteId(message.requestId)),
    method: message.method || "",
    url: message.url,
    ...readComputerUseInstallerStatusForDiagnostics(),
  });
}

function sendComputerUseAuthWriteNoopResponse(message, enabled) {
  const requestId = stringRouteId(message && message.requestId);
  if (!requestId) return false;
  routeOfficialWebContentsSend(MESSAGE_FOR_VIEW_CHANNEL, [
    {
      type: "fetch-response",
      responseType: "success",
      requestId,
      status: 200,
      headers: { "content-type": "application/json" },
      bodyJsonString: JSON.stringify({ enabled }),
    },
  ]);
  return true;
}

function maybeHandleComputerUseAuthWriteNoop(channel, args) {
  if (channel !== MESSAGE_FROM_VIEW_CHANNEL) return false;
  const message = fetchMessageFromIpcArgs(args);
  if (!message || computerUseAuthActionFromUrl(message.url) !== "computer-use-background-auth-write") return false;
  const desiredEnabled = desiredComputerUseAuthEnabled(message);
  if (typeof desiredEnabled !== "boolean") return false;

  const status = readComputerUseInstallerStatusForDiagnostics();
  if (typeof status.installerInstalled !== "boolean" || status.installerInstalled !== desiredEnabled) return false;

  /**
   * 官方 write 会无条件调用 install/uninstall。OpenCodex runner 是临时签名进程，macOS 授权启动
   * 可能返回 -60006；当 Installer status 已经和目标一致时，直接返回官方 fetch-response 形状即可。
   */
  diagnosticLog("computer-use-auth", "write_noop_current_status", {
    desiredEnabled,
    requestId: shortId(stringRouteId(message.requestId)),
    installerInstalled: status.installerInstalled,
    installerStdout: status.installerStdout || "",
    installerError: status.installerError || "",
  });
  return sendComputerUseAuthWriteNoopResponse(message, desiredEnabled);
}

function logDesktopFeatureAvailability(channel, args) {
  if (channel !== MESSAGE_FROM_VIEW_CHANNEL) return;
  const message = payloadFromArgs(args);
  if (!message || typeof message !== "object" || message.type !== "electron-desktop-features-changed") return;
  /**
   * bundled plugins 和 Computer Use 管理器都依赖这组 feature 位。
   * 这里只记录关键布尔值，避免把整份 renderer 状态刷进日志。
   */
  diagnosticLog("desktop-features", "electron_desktop_features_changed", {
    ambientSuggestions: message.ambientSuggestions,
    browserPane: message.browserPane,
    inAppBrowserUse: message.inAppBrowserUse,
    inAppBrowserUseAllowed: message.inAppBrowserUseAllowed,
    externalBrowserUse: message.externalBrowserUse,
    externalBrowserUseAllowed: message.externalBrowserUseAllowed,
    computerUse: message.computerUse,
    computerUseNodeRepl: message.computerUseNodeRepl,
    sites: message.sites,
    control: message.control,
    deviceAttestation: message.deviceAttestation,
    multiWindow: message.multiWindow,
  });
}

function parseFetchResponseBodyJson(payload) {
  if (!payload || typeof payload !== "object") return null;
  const raw = typeof payload.bodyJsonString === "string" ? payload.bodyJsonString : "";
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function getI18nSnapshot() {
  // OpenCodex 自有文案统一由 shared/i18n 解析，gateway 只负责发布解析后的快照。
  return resolveOpenCodexI18n();
}

function logComputerUseAuthResponse(routeBase, payload) {
  const action = computerUseAuthActionFromUrl(routeBase && routeBase.url);
  if (!action || !payload || typeof payload !== "object") return;
  const body = parseFetchResponseBodyJson(payload);
  diagnosticLog("computer-use-auth", "official_fetch_response", {
    action,
    requestId: shortId(routeBase.requestId),
    responseType: payload.responseType || "",
    status: payload.status,
    enabled: body && typeof body.enabled === "boolean" ? body.enabled : null,
    bodyKeys: body && typeof body === "object" ? Object.keys(body).sort().join(",") : "",
    mapped: !!routeBase.mapped,
    route: routeBase.targetClientId ? "target" : "broadcast",
  });
}

function outgoingIpcDiagnosticSummary(channel, args, requestSummary = null) {
  const payload = payloadFromArgs(args);
  const summary = {
    ...(requestSummary && typeof requestSummary === "object" ? requestSummary : {}),
    channel,
    payloadType: payload && typeof payload === "object" ? `object(${Object.keys(payload).length})` : typeof payload,
    requestId: responseRouteIdFromOutgoing(channel, args),
  };
  if (payload && typeof payload === "object") {
    if (typeof payload.type === "string") summary.type = payload.type;
    if (payload.request && typeof payload.request === "object") {
      if (payload.request.id != null) summary.requestId = String(payload.request.id);
      if (typeof payload.request.method === "string") summary.requestMethod = payload.request.method;
    }
    if (typeof payload.url === "string") summary.url = payload.url;
    if (typeof payload.method === "string") summary.method = payload.method;
  }
  return summary;
}

function isConnectorLogoUrl(url) {
  if (typeof url !== "string") return false;
  try {
    const parsed = new URL(url, "http://opencodex.local");
    return /^\/aip\/connectors\/[^/]+\/logo\/?$/.test(parsed.pathname);
  } catch {
    return /^\/aip\/connectors\/[^/?#]+\/logo(?:[?#]|$)/.test(url);
  }
}

function shouldSuppressRoutineRouteDiagnostic(summary) {
  // connector logo 的 fetch-response 数量很大，常规路由日志默认压下去；慢 IPC 仍会在 server.cjs 侧暴露。
  return summary && summary.type === "fetch-response" && isConnectorLogoUrl(summary.url);
}

function shouldKeepRequestRoute(channel, args) {
  const type = responsePayloadType(channel, args);
  // 只有流式中间事件保留路由；complete/error 或普通响应到达后即可释放映射。
  return /(?:^|[-/:])stream[-/:](?:event|chunk|delta|data)$/i.test(type) || /fetch-stream-event/i.test(type);
}

function summarizeIpcValue(value) {
  try {
    const json = JSON.stringify(value, (_key, nextValue) => {
      if (typeof nextValue === "string" && nextValue.length > 400) return `${nextValue.slice(0, 400)}...`;
      return nextValue;
    });
    return json && json.length > 2000 ? `${json.slice(0, 2000)}...` : json;
  } catch {
    return "[unserializable]";
  }
}

function isTargetedOutgoing(channel, payload) {
  // 这类消息如果找不到 requestId，也应该优先发回当前 HTTP IPC 对应的 client。
  if (channel === MESSAGE_FOR_VIEW_CHANNEL && payload && typeof payload === "object") {
    return TARGETED_MESSAGE_TYPES.has(String(payload.type || ""));
  }
  return TARGETED_MESSAGE_TYPES.has(channel);
}

function rememberRequestRoute(channel, payload, clientId) {
  if (!clientId) return;
  const requestId = requestRouteIdFromIncoming(channel, payload);
  if (requestId) {
    requestRoutes.set(requestId, clientId);
    requestRouteSummaries.set(requestId, incomingIpcDiagnosticSummary(channel, payload));
  }
}

function logUnknownIpc(kind, details) {
  try {
    ensureDir(REPORTS_DIR);
    fs.appendFileSync(
      UNKNOWN_IPC_PATH,
      `${JSON.stringify({
        at: new Date().toISOString(),
        kind,
        ...details,
      })}\n`,
      "utf-8"
    );
  } catch {}
}

function acknowledgeOfficialChunkSoon(acknowledgement, sourceWebContents) {
  if (!acknowledgement) return;
  /**
   * 官方 sender 会在 webContents.send 返回后才把当前分块标记为 delivered。
  * ACK 必须排到下一轮事件循环，否则同步回调会因为 delivered 尚未置位而被忽略。
  */
  setImmediate(() => {
    void invokeOfficialIpc(
      CHUNKED_MESSAGE_ACK_CHANNEL,
      [acknowledgement.transferId, acknowledgement.sequence],
      {
        // ChunkedMessageSender 以 webContents 为队列键，ACK 必须带回产生该分块的同一个 sender。
        sender: sourceWebContents,
      }
    ).catch((error) => {
      diagnosticWarn("official-ipc-route", "chunk_ack_failed", {
        error: error instanceof Error ? error.message : String(error),
        sequence: acknowledgement.sequence,
        transferId: shortId(acknowledgement.transferId),
      });
    });
  });
}

function routeOfficialWebContentsSend(channel, args, sourceWebContents = officialIpc.hiddenWebContents) {
  /**
   * 官方代码以为自己在给 Electron renderer 发消息。
   * gateway 需要把这些 webContents.send 拦下来，并转换成浏览器 WebSocket 消息。
   */
  let routedArgs = args;
  let payload = payloadFromArgs(routedArgs);
  if (channel === MESSAGE_FOR_VIEW_CHANNEL) {
    // 每个隐藏窗口都对应独立的官方 preload 接收器，不能让辅助窗口的新传输清空主窗口状态。
    const chunked = officialChunkedMessageReceiverFor(sourceWebContents).receive(payload);
    if (chunked.type !== "passthrough") {
      acknowledgeOfficialChunkSoon(chunked.acknowledgement, sourceWebContents);
      // 分块未完整前不能让 renderer 看到协议外壳；完成后再按原始消息参与 requestId 路由。
      if (chunked.type === "pending") return true;
      payload = chunked.message;
      routedArgs = [payload];
    }
  }
  if (!wsHub) {
    diagnosticWarn("official-ipc-route", "before_ws_ready", outgoingIpcDiagnosticSummary(channel, routedArgs));
    logUnknownIpc("webcontents-send-before-ws-ready", {
      channel,
      requestId: responseRouteIdFromOutgoing(channel, routedArgs),
      args: summarizeIpcValue(routedArgs),
    });
    return false;
  }

  // 先按 requestId 找历史路由；没有 requestId 时再退回当前 AsyncLocalStorage 的 clientId。
  const requestId = responseRouteIdFromOutgoing(channel, routedArgs);
  const mappedClientId = requestId ? requestRoutes.get(requestId) : "";
  const requestSummary = requestId ? requestRouteSummaries.get(requestId) : null;
  const store = (requestContext && requestContext.getStore && requestContext.getStore()) || {};
  const targetClientId = mappedClientId || (isTargetedOutgoing(channel, payload) ? store.clientId : "");
  const routeBase = {
    ...outgoingIpcDiagnosticSummary(channel, routedArgs, requestSummary),
    mapped: !!mappedClientId,
    targetClientId: shortId(targetClientId),
  };
  // 只对锁屏授权相关回包做结构化摘要，避免把大图标 dataURL 打进日志。
  logComputerUseAuthResponse(routeBase, payload);
  const suppressRouteDiagnostic = shouldSuppressRoutineRouteDiagnostic(routeBase);
  if (requestId && mappedClientId && !shouldKeepRequestRoute(channel, routedArgs)) {
    // 流式中间事件在 complete/error 前可能有多次分片，不能提前删除路由。
    requestRoutes.delete(requestId);
    requestRouteSummaries.delete(requestId);
  }
  const wsDiagnosticOptions = {
    suppressDiagnostic: suppressRouteDiagnostic,
    diagnosticSummary: routeBase,
  };
  if (targetClientId && wsHub.sendTo(targetClientId, { channel, payload, args: routedArgs }, wsDiagnosticOptions)) {
    if (DEBUG_LOGS && !suppressRouteDiagnostic) {
      // 官方 IPC 定向成功投递会随每个请求回包出现，默认不落盘；DEBUG 时用于确认 requestId/clientId 路由。
      diagnosticLog("official-ipc-route", "send_to_client", { ...routeBase, route: "target" });
    }
    return true;
  }
  // 没有 requestId 或 clientId 的通知类消息广播给所有在线浏览器。
  const broadcastCount = wsHub.broadcast({ channel, payload, args: routedArgs }, wsDiagnosticOptions);
  if (DEBUG_LOGS && !suppressRouteDiagnostic) {
    // 成功广播只是常规路由摘要，数量会随会话状态同步放大；默认压下，DEBUG 时用于追路由。
    diagnosticLog("official-ipc-route", "broadcast", {
      ...routeBase,
      broadcastCount,
      route: targetClientId ? "target_fallback_broadcast" : "broadcast",
    });
  }
  if (targetClientId && broadcastCount === 0) {
    // 定向回包没有命中任何 WS 客户端时要打日志，这通常表示前端过早发送 IPC 或 WS 已断开。
    diagnosticWarn("official-ipc-route", "ws_target_missing_for_ipc_response", {
      channel,
      requestId,
      targetClientId: shortId(targetClientId),
      payloadType: payload && typeof payload === "object" ? payload.type : typeof payload,
    });
  }
  return true;
}

function shouldSuppressHiddenRendererSend(channel, args) {
  const payload = payloadFromArgs(args);
  // 浏览器代理的消息已经通过 WS 转发，继续送进隐藏 renderer 会造成重复消费。
  return channel === MESSAGE_FOR_VIEW_CHANNEL && payload && typeof payload === "object";
}

function patchOfficialWebContents(webContents) {
  // patch send 是异步事件转发的核心：官方 main -> hidden webContents -> WebSocket -> 浏览器。
  if (!webContents || webContents.__opencodexOfficialGatewayPatched) return;
  webContents.__opencodexOfficialGatewayPatched = true;
  const originalSend = webContents.send.bind(webContents);
  webContents.send = (channel, ...args) => {
    routeOfficialWebContentsSend(String(channel), args, webContents);
    // 官方隐藏 renderer 不需要消费这些消息，避免 Web 发起的 requestId 再回到隐藏页。
    if (shouldSuppressHiddenRendererSend(String(channel), args)) return true;
    return originalSend(channel, ...args);
  };
  if (typeof webContents.postMessage === "function") {
    const originalPostMessage = webContents.postMessage.bind(webContents);
    webContents.postMessage = (channel, message, transfer) => {
      routeOfficialWebContentsSend(String(channel), [message], webContents);
      if (shouldSuppressHiddenRendererSend(String(channel), [message])) return true;
      return originalPostMessage(channel, message, transfer);
    };
  }
  if (typeof webContents.sendToFrame === "function") {
    const originalSendToFrame = webContents.sendToFrame.bind(webContents);
    webContents.sendToFrame = (frameId, channel, ...args) => {
      routeOfficialWebContentsSend(String(channel), args, webContents);
      if (shouldSuppressHiddenRendererSend(String(channel), args)) return true;
      return originalSendToFrame(frameId, channel, ...args);
    };
  }
  if (webContents.mainFrame && typeof webContents.mainFrame.postMessage === "function") {
    const originalFramePostMessage = webContents.mainFrame.postMessage.bind(webContents.mainFrame);
    webContents.mainFrame.postMessage = (channel, message, transfer) => {
      routeOfficialWebContentsSend(String(channel), [message], webContents);
      if (shouldSuppressHiddenRendererSend(String(channel), [message])) return true;
      return originalFramePostMessage(channel, message, transfer);
    };
  }
}

function registerOfficialWindow(win) {
  if (!win || win.__opencodexOfficialGatewayRegistered) return;
  win.__opencodexOfficialGatewayRegistered = true;
  // 第一扇官方窗口作为 IPC event.sender；后续窗口仍统一隐藏，避免桌面上弹出界面。
  if (!officialIpc.hiddenWindow || officialIpc.hiddenWindow.isDestroyed()) {
    officialIpc.hiddenWindow = win;
    officialIpc.hiddenWebContents = win.webContents;
  }
  hideOfficialWindow(win);
  patchOfficialWebContents(win.webContents);
  win.on("show", () => hideOfficialWindow(win));
  win.on("ready-to-show", () => hideOfficialWindow(win));
  win.on("closed", () => {
    if (officialIpc.hiddenWindow === win) {
      officialIpc.hiddenWindow = null;
      officialIpc.hiddenWebContents = null;
    }
  });
}

function installBrowserWindowHooks() {
  /**
   * 不能禁止官方 BrowserWindow 创建：
   * 官方 renderer 会在窗口加载后初始化 app-server、注册状态同步和 IPC 桥。
   * 因此这里让窗口真实存在，但不可见、屏幕外、跳过任务栏。
   */
  if (electron.__opencodexOfficialGatewayBrowserWindowPatched) return;
  electron.__opencodexOfficialGatewayBrowserWindowPatched = true;
  const NativeBrowserWindow = electron.BrowserWindow;

  function GatewayBrowserWindow(options = {}) {
    // 官方 main 仍创建真实 BrowserWindow，但默认不可见并放到屏幕外。
    const win = new NativeBrowserWindow({
      ...options,
      show: false,
      opacity: 0,
      x: -32000,
      y: -32000,
    });
    registerOfficialWindow(win);
    return win;
  }

  if (typeof NativeBrowserWindow.fromWebContents === "function") {
    GatewayBrowserWindow.fromWebContents = (webContents) => {
      const win = NativeBrowserWindow.fromWebContents(webContents);
      if (win && isOfficialHiddenWebContents(webContents)) {
        // fromWebContents 可能返回新的 JS 包装对象，重新打标后 dialog hook 才能稳定识别隐藏 parent。
        win.__opencodexOfficialGatewayRegistered = true;
      }
      return win;
    };
  }

  Object.setPrototypeOf(GatewayBrowserWindow, NativeBrowserWindow);
  GatewayBrowserWindow.prototype = NativeBrowserWindow.prototype;
  try {
    // 替换 electron.BrowserWindow 后，官方 bootstrap 里 new BrowserWindow 会自动进入隐藏模式。
    electron.BrowserWindow = GatewayBrowserWindow;
  } catch (error) {
    diagnosticWarn("official-runtime", "browser_window_patch_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  app.on("browser-window-created", (_event, win) => registerOfficialWindow(win));
}

function patchOfficialAppSingleton() {
  if (app.__opencodexOfficialGatewaySingletonPatched) return;
  app.__opencodexOfficialGatewaySingletonPatched = true;
  const originalRequestSingleInstanceLock = app.requestSingleInstanceLock.bind(app);
  app.requestSingleInstanceLock = (...args) => {
    try {
      originalRequestSingleInstanceLock(...args);
    } catch {}
    // gateway 需要能和真实 Codex Desktop 并存，因此不让官方单例锁退出当前进程。
    return true;
  };
}

function createOfficialIpcEvent(context = {}) {
  const sender = context.sender || officialIpc.hiddenWebContents;
  if (!sender || sender.isDestroyed()) {
    throw new Error("Official BrowserWindow is not ready yet");
  }
  // 模拟 Electron IpcMainInvokeEvent 的关键字段，保证官方 handler 能按桌面端路径执行。
  return {
    sender,
    senderFrame: sender.mainFrame || null,
    processId: typeof sender.getOSProcessId === "function" ? sender.getOSProcessId() : 0,
    frameId: 0,
    returnValue: undefined,
    reply(channel, ...args) {
      // ipcMain.on 风格的 handler 会调用 event.reply，这里也统一接到 WebSocket 转发链路。
      routeOfficialWebContentsSend(String(channel), args, sender);
    },
    // MessagePort 类 IPC 需要保留官方 event.ports 语义，app-host RPC 首屏握手依赖它。
    ports: Array.isArray(context.ports) ? context.ports : [],
    remoteAddress: context.remoteAddress || "",
  };
}

async function waitForOfficialBridgeReady(timeoutMs = 20_000) {
  // 官方 renderer 加载和 app-server 初始化是异步的，IPC 调用前必须等任意官方 IPC 注册完成。
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (
      officialIpc.hiddenWebContents &&
      !officialIpc.hiddenWebContents.isDestroyed() &&
      (officialIpc.handlers.size > 0 || listenerCount() > 0)
    ) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Official IPC bridge was not ready before timeout");
}

async function invokeOfficialIpc(channel, args = [], context = {}) {
  await waitForOfficialBridgeReady();
  const event = createOfficialIpcEvent(context);
  const invokeArgs = normalizeIpcArgs(args);
  // 先记录请求归属，再调用官方 handler，这样同步和异步回包都能找到目标 client。
  rememberRequestRoute(channel, invokeArgs, context.clientId || "");
  // Computer Use 锁屏授权由官方 Installer 决定；这里额外记录同进程直接 status，方便和官方回包对照。
  logComputerUseAuthRequest(channel, invokeArgs);
  if (maybeHandleComputerUseAuthWriteNoop(channel, invokeArgs)) return true;
  logDesktopFeatureAvailability(channel, invokeArgs);
  const handler = officialIpc.handlers.get(channel);
  if (handler) {
    return handler(event, ...invokeArgs);
  }
  const listeners = officialIpc.listeners.get(channel);
  if (listeners && listeners.size > 0) {
    for (const listener of [...listeners]) {
      await listener(event, ...invokeArgs);
    }
    return event.returnValue === undefined ? true : event.returnValue;
  }
  logUnknownIpc("missing-ipc-handler", {
    channel,
    requestId: requestRouteIdFromIncoming(channel, invokeArgs),
    args: summarizeIpcValue(invokeArgs),
    registeredHandlers: Array.from(officialIpc.handlers.keys()).sort(),
    registeredListeners: Array.from(officialIpc.listeners.keys()).sort(),
  });
  throw new Error(`No official Electron IPC handler for ${channel}`);
}

async function connectOfficialAppHostPort(port, context = {}) {
  /**
   * 官方新版 renderer 启动时不再只走 electronBridge.invoke，而是通过 MessageChannel
   * 建立 app-host RPC。这里只补齐官方 preload 的转发动作，把 MessagePort 原样交给
   * 官方 main listener，服务对象和 RPC 协议仍完全由官方 bundle 负责。
   */
  await waitForOfficialBridgeReady();
  const listeners = officialIpc.listeners.get("codex_desktop:connect-app-host");
  if (!listeners || listeners.size === 0) {
    throw new Error("No official Electron IPC listener for codex_desktop:connect-app-host");
  }
  // 等价于官方 preload 的 ipcRenderer.postMessage(channel, undefined, [port])。
  const event = createOfficialIpcEvent({ ...context, ports: [port] });
  for (const listener of [...listeners]) {
    await listener(event);
  }
  return true;
}

/**
 * 在 gateway 进程里创建一条“浏览器 MessagePort <-> 官方 MessagePort”的透明中继。
 * 这里不解析 app-host RPC 的 JSON 内容，只保证字符串帧和关闭信号按顺序穿过边界。
 */
function createOfficialAppHostRelay(options = {}) {
  const { clientId = "", onClose, onError, onMessage, portId = "", remoteAddress = "" } = options;
  if (typeof electron.MessageChannelMain !== "function") {
    throw new Error("Electron MessageChannelMain is unavailable");
  }

  // port1 交给官方 IPC listener；port2 留在 gateway，用来和浏览器 WebSocket 互转消息。
  const { port1, port2 } = new electron.MessageChannelMain();
  let closed = false;

  function close(reason = "closed") {
    if (closed) return;
    closed = true;
    try {
      port1.close();
    } catch {}
    try {
      port2.close();
    } catch {}
    try {
      onClose && onClose(reason);
    } catch {}
  }

  port2.on("message", (event) => {
    // Electron MessageEvent.data 可能挂在原型 getter 上，必须直接读取，不能用 hasOwnProperty 判断。
    const data = event ? event.data : undefined;
    if (data == null) {
      // app-host 约定 null 表示端口关闭，收到后要同步释放两端资源。
      close("official_closed");
      return;
    }
    if (typeof data !== "string") {
      diagnosticWarn("official-app-host", "non_string_message_from_official", {
        clientId: shortId(clientId),
        payloadType: typeof data,
        portId: shortId(portId),
      });
      return;
    }
    try {
      onMessage && onMessage(data);
    } catch (error) {
      diagnosticWarn("official-app-host", "forward_to_browser_failed", {
        clientId: shortId(clientId),
        error: error instanceof Error ? error.message : String(error),
        portId: shortId(portId),
      });
    }
  });
  port2.on("close", () => close("official_port_closed"));
  port2.start();

  connectOfficialAppHostPort(port1, { clientId, portId, remoteAddress }).then(
    () => {
      if (DEBUG_LOGS) {
        // app-host 正常连接只是生命周期事件；失败仍保持常规日志，方便排查终端/侧栏能力不可用。
        diagnosticLog("official-app-host", "connected", {
          clientId: shortId(clientId),
          portId: shortId(portId),
        });
      }
    },
    (error) => {
      diagnosticWarn("official-app-host", "connect_failed", {
        clientId: shortId(clientId),
        error: error instanceof Error ? error.message : String(error),
        portId: shortId(portId),
      });
      try {
        onError && onError(error);
      } catch {}
      close("connect_failed");
    }
  );

  return {
    close,
    postMessage(data) {
      if (closed) return false;
      try {
        // 浏览器侧也用 null 作为关闭信号；其它 payload 必须保持官方 RPC 字符串原样。
        port2.postMessage(data);
        if (data == null) close("browser_closed");
        return true;
      } catch (error) {
        diagnosticWarn("official-app-host", "forward_to_official_failed", {
          clientId: shortId(clientId),
          error: error instanceof Error ? error.message : String(error),
          portId: shortId(portId),
        });
        try {
          onError && onError(error);
        } catch {}
        close("forward_to_official_failed");
        return false;
      }
    },
  };
}

function officialIpcStatus() {
  // health 接口暴露 handler/listener 列表，方便判断官方 bundle 是否成功启动。
  return {
    ready:
      !!officialIpc.hiddenWebContents &&
      !officialIpc.hiddenWebContents.isDestroyed() &&
      officialIpc.handlers.has(MESSAGE_FROM_VIEW_CHANNEL),
    hiddenWebContentsId: officialIpc.hiddenWebContents ? officialIpc.hiddenWebContents.id : null,
    handlerCount: officialIpc.handlers.size,
    listenerCount: listenerCount(),
    handlers: Array.from(officialIpc.handlers.keys()).sort(),
    listeners: Array.from(officialIpc.listeners.keys()).sort(),
  };
}

function officialBundleStatus() {
  // 只返回路径和版本等诊断信息，不读取或暴露官方 bundle 的具体源码内容。
  return officialBundle
    ? {
        version: officialBundle.version,
        build: officialBundle.build,
        sourceAppPath: officialBundle.sourceAppPath,
        sourceAsarPath: officialBundle.sourceAsarPath,
        sourceResourcesPath: officialBundle.sourceResourcesPath,
        codexBinaryPath: officialBundle.codexBinaryPath,
        bundleDir: officialBundle.bundleDir,
        webviewDir: officialBundle.webviewDir,
        bootstrapPath: officialBundle.bootstrapPath,
        cacheProcessedAt: officialBundle.manifest && officialBundle.manifest.processedAt ? officialBundle.manifest.processedAt : null,
      }
    : null;
}

function buildGatewayStatus() {
  const listenUrl = `http://${HOST}:${PORT}`;
  const localUrl = `http://127.0.0.1:${PORT}`;
  return {
    ok: true,
    gateway: {
      kind: "official",
      host: HOST,
      port: PORT,
      listenUrl,
      localUrl,
      pid: process.pid,
      projectRoot: PROJECT_ROOT,
      webShellDir: WEB_SHELL_DIR,
      nodeVersion: process.version,
      electronVersion: process.versions && process.versions.electron ? process.versions.electron : null,
    },
    runtime: {
      runtimeDir: RUNTIME_DIR,
      configPath: AUTH_CONFIG_PATH,
      reportsDir: REPORTS_DIR,
      unknownIpcPath: UNKNOWN_IPC_PATH,
      officialUserDataPath: officialRuntimeUserDataDir(),
      officialTempPath: officialRuntimeTempDir(),
      officialCodexUserDataPath: officialDataDir(),
      codexHome: CODEX_HOME,
    },
    officialBundle: officialBundleStatus(),
    officialIpc: officialIpcStatus(),
    officialAppServer: appServerSpawnHookStatus(),
    officialNotification: officialNotificationHookStatus(),
    officialTray: hiddenTrayHookStatus(),
    i18n: getI18nSnapshot(),
    workspaceRoots: workspaceRootsFromEnv(),
  };
}

async function webConfigScript() {
  // 这个脚本由浏览器入口动态加载，避免把本机路径和端口写死到 web-shell 构建产物里。
  const i18n = withPluginI18nMessages(getI18nSnapshot());
  const initialSidebarBootstrap = await initialSidebarBootstrapForRenderer();
  return `(() => {
  window.__CODEX_WEB_CONFIG__ = {
    gatewayBaseUrl: location.origin,
    gatewayWsUrl: location.origin.replace(/^http/, "ws") + "/ws",
    workspaceRoots: ${JSON.stringify(workspaceRootsFromEnv())},
    homeDir: ${JSON.stringify(os.homedir())},
    locale: ${JSON.stringify(i18n.locale)},
    localeSource: ${JSON.stringify(i18n.source || "")},
    localeMode: ${JSON.stringify(i18n.mode || "")},
    messages: ${JSON.stringify(i18n.messages)},
    // debugWs 只控制浏览器侧诊断采集，不控制 WS 压缩；压缩属于 gateway 传输层优化。
    // OPENCODEX_DEBUG_WS=1 时才开启 WS 大包/慢解析诊断，平时不采集。
    debugWs: ${JSON.stringify(process.env.OPENCODEX_DEBUG_WS === "1")},
    appServer: ${JSON.stringify({ kind: "official-electron-ipc", spawnHook: appServerSpawnHookStatus() })},
    sharedObjectSnapshot: ${JSON.stringify({ host_config: { id: "local", kind: "local" } })},
    // persistedAtomSnapshot 用于首屏同步：renderer 会很早请求它，此时 WebSocket 可能还没连上。
    persistedAtomSnapshot: ${JSON.stringify(persistedAtomSnapshotForRenderer())},
    // 刷新页面时官方的一次性启动广播已经结束，必须把 main 的同步侧栏快照直接交给 preload bridge。
    initialSidebarBootstrap: ${JSON.stringify(initialSidebarBootstrap)}
  };
})();`;
}

/** 只接受最新版 renderer 能安全同步消费的 sidebar bootstrap 结构。 */
function normalizeInitialSidebarBootstrap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  // renderer 会直接遍历 globalStateEntries；形态不完整时宁可回退 null，也不能再次触发首屏崩溃。
  if (!Array.isArray(value.globalStateEntries)) return null;
  return value;
}

/** 通过官方同步 IPC listener 读取首屏快照，并在短暂不可用时沿用最近一次有效结果。 */
async function initialSidebarBootstrapForRenderer() {
  try {
    const bootstrap = normalizeInitialSidebarBootstrap(
      await invokeOfficialIpc(INITIAL_SIDEBAR_BOOTSTRAP_CHANNEL)
    );
    if (bootstrap) {
      lastInitialSidebarBootstrap = bootstrap;
      hasWarnedInitialSidebarBootstrapFailure = false;
    }
    const effectiveBootstrap = bootstrap || lastInitialSidebarBootstrap;
    if (effectiveBootstrap) {
      // 只从 Web 首屏侧栏已知条目订阅，避免 observer 读取或跟踪用户不可见的 thread。
      officialLiveObserver.observeSidebarBootstrap(effectiveBootstrap);
    }
    return effectiveBootstrap;
  } catch (error) {
    if (!hasWarnedInitialSidebarBootstrapFailure) {
      hasWarnedInitialSidebarBootstrapFailure = true;
      diagnosticWarn("official-runtime", "initial_sidebar_bootstrap_unavailable", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return lastInitialSidebarBootstrap;
  }
}

function startOfficialRuntime(options = {}) {
  /**
   * 官方 runtime 启动点：
   * - ensureOfficialBundle 负责从已安装 Codex/ChatGPT Desktop 抽取白名单资源。
   * - 环境伪装必须发生在 require(bootstrapPath) 之前。
   * - hook 必须先安装，才能捕获 bootstrap 注册的 IPC handler、官方 app-server 子进程，并隐藏官方 UI。
   */
  const { ensureOfficialBundle } = requireOfficialBundleProvider();
  appServerChildDecorator =
    typeof options.decorateAppServerChild === "function" ? options.decorateAppServerChild : null;
  officialBundle = ensureOfficialBundle({ projectRoot: PROJECT_ROOT });
  alignOfficialElectronEnvironment(officialBundle);
  officialLiveObserver.start();
  installAppServerSpawnHook(officialBundle);
  installIpcMainHooks();
  installBrowserWindowHooks();
  installDialogHooks();
  installRemoteFileManagerOpenHooks();
  installOfficialNotificationHook(electron, {
    publishNotification: (payload) => (wsHub ? wsHub.broadcast(payload, { suppressDiagnostic: true }) : 0),
  });
  installOfficialTrayHook(electron);
  patchOfficialAppSingleton();

  // 官方 bootstrap 负责注册 IPC handler、创建隐藏 BrowserWindow 和启动自己的 app-server 连接。
  require(officialBundle.bootstrapPath);
}

function rejectPendingInternalResponses(error) {
  // 当前没有 gateway 自己发起的官方 IPC 请求；保留出口让 shutdown 路径无需关心内部实现。
  void error;
  officialLiveObserver.stop();
}

function listOfficialIpcChannels() {
  return {
    handlers: Array.from(officialIpc.handlers.keys()).sort(),
    listeners: Array.from(officialIpc.listeners.keys()).sort(),
  };
}

module.exports = {
  buildGatewayStatus,
  createOfficialAppHostRelay,
  getI18nSnapshot,
  getOfficialBundle,
  handleOfficialNotificationEvent,
  invokeOfficialIpc,
  listOfficialIpcChannels,
  rejectPendingInternalResponses,
  requestContext,
  setWsHub,
  startOfficialRuntime,
  webConfigScript,
  __test: {
    fileManagerPathFromSpawn,
    normalizeInitialSidebarBootstrap,
    OfficialChunkedMessageReceiver,
    officialDesktopIpcSocketPaths,
    isHiddenOfficialAppServerArgs,
    shouldInterceptRemoteFileManagerStore,
  },
};
