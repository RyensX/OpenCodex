// @ts-nocheck
export {};

const path = require("path");
const os = require("os");
const {
  BRIDGE_MAP_ENTRIES,
  CODEX_ADDITIONAL_CHANNELS,
} = require("./channelRegistry");
const {
  STATSIG_DEFAULT_FEATURE_OVERRIDES,
  STATSIG_DEFAULT_FEATURES_CONFIG,
  filterUnsupportedFeatureEnablements,
  isPlainObject,
  patchCodexConfigResult,
  patchConfigRequirementsResult,
  patchStatsigDefaultFeatureSnapshot,
  patchStatsigDefaultFeatures,
} = require("./featurePatches");
const { createAutomationIpcHandlers } = require("./automations");
const { createTerminalIpcHandlers } = require("./terminal");
const { createWorkerIpcHandlers } = require("./worker");
const { createViewMessageHandlers } = require("./viewMessages");
const { createGitIpcHandlers } = require("./git");
const { createAppServerBridge } = require("./appServerBridge");
const { createChatgptBackendIpcHandlers } = require("./chatgptBackend");
const { createFetchIpcHandlers } = require("./fetchIpc");
const { createConversationIpcHandlers } = require("./conversation");
const { createSharedObjectIpcHandlers } = require("./sharedObjectIpc");
const { createFilePreviewIpcHandlers } = require("./filePreview");
const { createWorkspaceRuntime } = require("./workspaceRuntime");
const { createWorkspaceIpcHandlers } = require("./workspaceIpc");
const { createDesktopState } = require("./desktopState");
const { createLocalFileIpcHandlers } = require("./localFiles");
const { nativeDesktopAppByBundleId, nativeDesktopAppIcon } = require("./nativeApps");
const { createRecommendedSkillsIpcHandlers } = require("./recommendedSkills");
const { normalizeMcpCodexConfig } = require("./mcpConfig");
const { buildLocaleInfo, buildOsInfo, chroniclePermissionsStatus } = require("./environmentInfo");
const { createCodexDiagnostics } = require("./diagnostics");

const PROJECT_ROOT = path.resolve(__dirname, "../../../..");
const REPORTS_DIR = path.join(PROJECT_ROOT, "reports");
const DOCS_DIR = path.join(PROJECT_ROOT, "docs");
const UNKNOWN_IPC_PATH = path.join(REPORTS_DIR, "unknown-ipc.jsonl");
const CODEX_BRIDGE_MAP_PATH = path.join(DOCS_DIR, "codex-bridge-map.md");
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const CODEX_WEB_PICKED_FILES_DIR = path.join(CODEX_HOME, ".tmp", "web-picked-files");
const DESKTOP_GLOBAL_STATE_PATH = path.join(CODEX_HOME, ".codex-global-state.json");
const DESKTOP_PROJECT_ROOTS_KEY = "electron-saved-workspace-roots";
const DESKTOP_WORKSPACE_LABELS_KEY = "electron-workspace-root-labels";
const DESKTOP_PERSISTED_ATOMS_KEY = "electron-persisted-atom-state";
const DESKTOP_ARCHIVED_THREADS_KEY = "archivedThreads";
const CONFIGURATION_RAW_DESKTOP_KEYS = new Set([
  "browserAgent",
  "customCliExecutable",
  "customCliExecutablePath",
  "followUpQueueMode",
  "localeOverride",
  "remoteControlConnectionsEnabled",
]);
const CODEX_ASSET_ROOTS = [
  CODEX_WEB_PICKED_FILES_DIR,
  path.join(CODEX_HOME, ".tmp", "plugins"),
  path.join(CODEX_HOME, ".tmp", "bundled-marketplaces"),
  path.join(os.homedir(), ".cache", "codex-runtimes"),
];
const DEBUG_LOGS = process.env.CODEX_WEB_DEBUG === "1" || process.env.CODEX_WEB_DEBUG === "true";

// ===== Hover Card / Pinned Threads BEGIN: 持久化 key =====
// 官方首页 hover card 的 pin 状态通过 pinned-thread-ids 读写，Web 侧在 gateway 里桥接这组 Electron IPC。
const PINNED_THREAD_IDS_STATE_KEY = "pinned-thread-ids";
// ===== Hover Card / Pinned Threads END: 持久化 key =====

const WARNED_UNSUPPORTED_FEATURE_ENABLEMENTS = new Set();
const COMPOSER_PERMISSION_MODE_VISIBILITY_KEY = "composer-permission-mode-visibility";
const DEFAULT_COMPOSER_PERMISSION_MODE_VISIBILITY = {
  "guardian-approvals": true,
  "full-access": true,
};
const APP_SERVER_METHOD_ALIASES = new Map([
  ["mcpServer/list", "mcpServerStatus/list"],
]);
const SHARED_OBJECT_SNAPSHOT = new Map([
  ["host_config", { id: "local", kind: "local" }],
]);
const GLOBAL_STATE = new Map([
  ["QUEUED_FOLLOW_UPS", {}],
  ["THREAD_WORKSPACE_ROOT_HINTS", {}],
  ["projectless-thread-ids", []],
  ["use-copilot-auth-if-available", false],
  ["mac-menu-bar-enabled", false],
  ["selected-remote-host-id", null],
  ["remote-projects", []],
  ["active-remote-project-id", null],
  ["copilot-default-model", null],
  ["project-order", []],
  ["notifications-turn-mode", "unfocused"],
  ["notifications-permissions-enabled", false],
  ["notifications-questions-enabled", false],
]);
const PERSISTED_STATE = {};
// settings/configuration 只作为当前进程内的热缓存；真实持久化统一写回本机 Codex Desktop 状态。
const SETTINGS_STATE = {};
const REVIEW_PANE_SNAPSHOT_METRICS = new Map();
const OPEN_REVIEW_FILE_SOURCE_TABS = new Map();
const OPEN_FILE_TABS = new Map();
const DESKTOP_VIEW_NOOP_MESSAGE_TYPES = new Set([
  "app-shell-shortcut-state-changed",
  "avatar-overlay-open-state-request",
  "browser-sidebar-owner-sync",
  "browser-use-turn-route-capture",
  "browser-use-turn-route-release",
  "browser-use-non-local-sites-allowed-changed",
  "computer-use-turn-route-capture",
  "computer-use-turn-route-release",
  "codex-runtimes-config-changed",
  "desktop-notification-hide",
  "electron-desktop-features-changed",
  "electron-app-state-snapshot-trigger",
  "electron-avatar-overlay-restore-ready",
  "electron-set-badge-count",
  "electron-set-window-mode",
  "electron-window-focus-request",
  "global-dictation-enabled-changed",
  "heartbeat-automation-thread-state-changed",
  "heartbeat-automations-enabled-changed",
  "hotkey-window-enabled-changed",
  "keyboard-layout-map-changed",
  "local-thread-activity-changed",
  "mac-menu-bar-enabled-changed",
  "power-save-blocker-set",
  "query-cache-invalidate",
  "ready",
  "set-telemetry-user",
  "shared-object-unsubscribe",
  "thread-stream-state-changed",
  "tray-menu-threads-changed",
  "view-focused",
]);

/** 只有 statsig initialize 需要 patch，其他 ChatGPT 后端请求不能误改。 */
function shouldPatchStatsigInitialize(urlObject) {
  return (
    urlObject &&
    urlObject.hostname === "ab.chatgpt.com" &&
    urlObject.pathname.replace(/\/+$/, "") === "/v1/initialize"
  );
}

/** 生成注入到 web-shell 的运行时配置。 */
function buildGatewayConfig() {
  const workspaceRoots = workspaceIpc.parseWorkspaceRoots();
  return {
    gatewayBaseUrl: "http://127.0.0.1:3737",
    workspaceRoots,
    homeDir: os.homedir(),
    appServer: process.env.CODEX_APP_SERVER_URL ? "remote" : "local",
    sharedObjectSnapshot: desktopState.sharedObjectSnapshotObject(),
  };
}

/** 归一化 renderer 上报的打开文件 tab 列表，只保留后续刷新需要的最小字段。 */
function normalizeOpenFileTabs(openFiles) {
  if (!Array.isArray(openFiles)) return [];
  return openFiles
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const hostId = typeof entry.hostId === "string" && entry.hostId ? entry.hostId : "local";
      const filePath = typeof entry.path === "string" && entry.path ? entry.path : null;
      return filePath ? { hostId, path: filePath } : null;
    })
    .filter(Boolean);
}

/** 保存审查/文件侧栏状态；Web 暂不需要持久化，只要 ACK 并保留进程内快照。 */
function recordOpenFileTabs(store, payload) {
  const params = payload && typeof payload === "object" && payload.params ? payload.params : payload;
  const conversationId =
    params && typeof params === "object" && typeof params.conversationId === "string"
      ? params.conversationId
      : "";
  if (!conversationId) return { ok: true, openFiles: [] };
  const openFiles = normalizeOpenFileTabs(params.openFiles);
  store.set(conversationId, openFiles);
  return { ok: true, conversationId, openFiles };
}

/** 保存审查 diff 指标，兼容官方 host manager 的 setReviewPaneSnapshotMetrics 语义。 */
function recordReviewPaneSnapshotMetrics(payload) {
  const params = payload && typeof payload === "object" && payload.params ? payload.params : payload;
  const hostId =
    params && typeof params === "object" && typeof params.hostId === "string" && params.hostId
      ? params.hostId
      : "local";
  const metrics = {
    reviewDiffFilesTotal: Math.max(0, Number(params && params.reviewDiffFilesTotal) || 0),
    reviewDiffLinesTotal: Math.max(0, Number(params && params.reviewDiffLinesTotal) || 0),
    reviewDiffBytesEstimate: Math.max(0, Number(params && params.reviewDiffBytesEstimate) || 0),
  };
  REVIEW_PANE_SNAPSHOT_METRICS.set(hostId, metrics);
  return { ok: true, hostId, ...metrics };
}

const diagnostics = createCodexDiagnostics({
  reportsDir: REPORTS_DIR,
  docsDir: DOCS_DIR,
  unknownIpcPath: UNKNOWN_IPC_PATH,
  codexBridgeMapPath: CODEX_BRIDGE_MAP_PATH,
  bridgeMapEntries: BRIDGE_MAP_ENTRIES,
});

let workspaceIpc = null;
let workspaceRuntime = null;
const desktopState = createDesktopState({
  desktopGlobalStatePath: DESKTOP_GLOBAL_STATE_PATH,
  desktopProjectRootsKey: DESKTOP_PROJECT_ROOTS_KEY,
  desktopWorkspaceLabelsKey: DESKTOP_WORKSPACE_LABELS_KEY,
  desktopPersistedAtomsKey: DESKTOP_PERSISTED_ATOMS_KEY,
  desktopArchivedThreadsKey: DESKTOP_ARCHIVED_THREADS_KEY,
  configurationRawDesktopKeys: CONFIGURATION_RAW_DESKTOP_KEYS,
  pinnedThreadIdsStateKey: PINNED_THREAD_IDS_STATE_KEY,
  composerPermissionModeVisibilityKey: COMPOSER_PERMISSION_MODE_VISIBILITY_KEY,
  defaultComposerPermissionModeVisibility: DEFAULT_COMPOSER_PERMISSION_MODE_VISIBILITY,
  statsigDefaultFeaturesConfig: STATSIG_DEFAULT_FEATURES_CONFIG,
  globalState: GLOBAL_STATE,
  persistedState: PERSISTED_STATE,
  settingsState: SETTINGS_STATE,
  sharedObjectSnapshot: SHARED_OBJECT_SNAPSHOT,
  isPlainObject,
  patchStatsigDefaultFeatureSnapshot,
  workspaceIpc: {
    listWorkspaceRoots: () => workspaceIpc.listWorkspaceRoots(),
    workspaceRootOptions: () => workspaceIpc.workspaceRootOptions(),
    activeWorkspaceRootPaths: () => workspaceIpc.activeWorkspaceRootPaths(),
  },
  workspaceRuntime: {
    listArchivedThreads: () => workspaceRuntime.listArchivedThreads(),
  },
});
desktopState.loadPersistentState();
workspaceRuntime = createWorkspaceRuntime({
  projectRoot: PROJECT_ROOT,
  settingsState: SETTINGS_STATE,
  desktopArchivedThreadsKey: DESKTOP_ARCHIVED_THREADS_KEY,
  globalState: GLOBAL_STATE,
  getDesktopGlobalStateValue: desktopState.getDesktopGlobalStateValue,
  setDesktopGlobalStateValue: desktopState.setDesktopGlobalStateValue,
  listWorkspaceRoots: () => workspaceIpc.listWorkspaceRoots(),
  activeWorkspaceRootPaths: () => workspaceIpc.activeWorkspaceRootPaths(),
  parseWorkspaceRoots: () => workspaceIpc.parseWorkspaceRoots(),
  realpathSafe: (filePath) => workspaceIpc.realpathSafe(filePath),
  isWithinAllowedRoots: (filePath) => workspaceIpc.isWithinAllowedRoots(filePath),
});
workspaceIpc = createWorkspaceIpcHandlers({
  projectRoot: PROJECT_ROOT,
  codexAssetRoots: CODEX_ASSET_ROOTS,
  desktopProjectRootsKey: DESKTOP_PROJECT_ROOTS_KEY,
  desktopWorkspaceLabelsKey: DESKTOP_WORKSPACE_LABELS_KEY,
  globalState: GLOBAL_STATE,
  getDesktopGlobalStateValue: desktopState.getDesktopGlobalStateValue,
  setDesktopGlobalStateValue: desktopState.setDesktopGlobalStateValue,
  getGlobalStateValue: desktopState.getGlobalStateValue,
  normalizeWorkspacePath: workspaceRuntime.normalizeWorkspacePath,
});
const localFiles = createLocalFileIpcHandlers({
  codexHome: CODEX_HOME,
  codexWebPickedFilesDir: CODEX_WEB_PICKED_FILES_DIR,
  reportsDir: REPORTS_DIR,
  projectRoot: PROJECT_ROOT,
  parseWorkspaceRoots: workspaceIpc.parseWorkspaceRoots,
  activeWorkspaceRootPaths: workspaceIpc.activeWorkspaceRootPaths,
  realpathSafe: workspaceIpc.realpathSafe,
  isWithinAllowedRoots: workspaceIpc.isWithinAllowedRoots,
});
const recommendedSkills = createRecommendedSkillsIpcHandlers({
  codexHome: CODEX_HOME,
  projectRoot: PROJECT_ROOT,
  activeWorkspaceRootPaths: workspaceIpc.activeWorkspaceRootPaths,
  parseWorkspaceRoots: workspaceIpc.parseWorkspaceRoots,
  realpathSafe: workspaceIpc.realpathSafe,
});

/**
 * 构造 Codex 业务 IPC handler 集合。
 *
 * 这里是业务层核心：能本地处理的直接处理，需要真实 Codex 数据的转发给
 * app-server，需要浏览器响应的通过 broadcast 回 web-shell。
 */
function makeHandlers({ appServer, broadcast, logger, isClientConnected }) {
  const gitIpc = createGitIpcHandlers({
    realpathSafe: workspaceIpc.realpathSafe,
    isWithinAllowedRoots: workspaceIpc.isWithinAllowedRoots,
    parseWorkspaceRoots: workspaceIpc.parseWorkspaceRoots,
    activeWorkspaceRootPaths: workspaceIpc.activeWorkspaceRootPaths,
  });
  const workerIpc = createWorkerIpcHandlers({
    broadcast,
    logger,
    handleGitWorkerMethod: gitIpc.handleGitWorkerMethod,
  });
  const terminalIpc = createTerminalIpcHandlers({
    broadcast,
    logger,
    isClientConnected: typeof isClientConnected === "function" ? isClientConnected : () => false,
    resolveGatewayTerminalCwd: workspaceRuntime.resolveGatewayTerminalCwd,
    isWithinAllowedRoots: workspaceIpc.isWithinAllowedRoots,
    normalizeWorkspacePath: workspaceRuntime.normalizeWorkspacePath,
    shellQuote: workspaceRuntime.shellQuote,
  });

  const appServerBridge = createAppServerBridge({
    appServer,
    logger,
    appServerMethodAliases: APP_SERVER_METHOD_ALIASES,
    warnedUnsupportedFeatureEnablements: WARNED_UNSUPPORTED_FEATURE_ENABLEMENTS,
    filterUnsupportedFeatureEnablements,
    patchCodexConfigResult,
  });

  /** 官方 AppServerRequestClient 的 host bridge：renderer 发 channel，gateway 转 app-server。 */
  async function callAppServerForHost(payload, fallbackMethod = null, fallbackParams = null) {
    const input =
      payload &&
      typeof payload === "object" &&
      typeof payload.method !== "string" &&
      !Object.prototype.hasOwnProperty.call(payload, "hostId") &&
      payload.params &&
      typeof payload.params === "object"
        ? payload.params
        : payload;
    const method =
      input && typeof input === "object" && typeof input.method === "string" && input.method
        ? input.method
        : fallbackMethod;
    if (!method) return true;
    const params =
      input && typeof input === "object" && Object.prototype.hasOwnProperty.call(input, "params")
        ? input.params
        : fallbackParams;
    const result = await appServerBridge.callAppServer(method, params);
    if (method === "thread/start") {
      workspaceRuntime.recordThreadStartMetadata(result, params);
    }
    return result;
  }

  /** 从 invoke context 中取浏览器 clientId。 */
  function contextClientId(context) {
    return context && typeof context === "object" && typeof context.clientId === "string"
      ? context.clientId
      : "";
  }

  const automationIpc = createAutomationIpcHandlers({
    callAppServer: appServerBridge.callAppServer,
    permissionsForAppServer: workspaceRuntime.permissionsForAppServer,
    recordThreadWorkspaceRoot: workspaceRuntime.recordThreadWorkspaceRoot,
    normalizeWorkspacePath: workspaceRuntime.normalizeWorkspacePath,
    projectRoot: PROJECT_ROOT,
  });
  const chatgptBackend = createChatgptBackendIpcHandlers({
    callAppServer: appServerBridge.callAppServer,
    logger,
  });

  const fetchIpc = createFetchIpcHandlers({
    broadcast,
    logger,
    chatgptBackend,
    targetClientIdForContext,
    withTargetClient,
    invokeCodexChannel: (channel, payload, requestContext) => handle(channel, payload, requestContext),
    shouldPatchStatsigInitialize,
    patchStatsigDefaultFeatures,
    statsigDefaultFeatureOverrides: STATSIG_DEFAULT_FEATURE_OVERRIDES,
  });

  const viewMessages = createViewMessageHandlers({
    appServerBridge,
    broadcast,
    contextClientId,
    debugLogs: DEBUG_LOGS,
    desktopState,
    desktopViewNoopMessageTypes: DESKTOP_VIEW_NOOP_MESSAGE_TYPES,
    diagnostics,
    fetchIpc,
    logger,
    patchCodexConfigResult,
    patchConfigRequirementsResult,
    persistedState: PERSISTED_STATE,
    runDetached,
    sharedObjectSnapshot: SHARED_OBJECT_SNAPSHOT,
    statsigDefaultFeaturesConfig: STATSIG_DEFAULT_FEATURES_CONFIG,
    targetClientIdForContext,
    terminalIpc,
    withTargetClient,
    workspaceIpc,
    workspaceRuntime,
  });

  const conversationIpc = createConversationIpcHandlers({
    appServerBridge,
    workspaceRuntime,
  });
  const sharedObjectIpc = createSharedObjectIpcHandlers({
    broadcast,
    desktopState,
    sharedObjectSnapshot: SHARED_OBJECT_SNAPSHOT,
    statsigDefaultFeaturesConfig: STATSIG_DEFAULT_FEATURES_CONFIG,
  });
  const filePreviewIpc = createFilePreviewIpcHandlers({
    appServerBridge,
    workspaceIpc,
  });

  /** fetch/mcp 响应默认回到发起请求的浏览器。 */
  function targetClientIdForContext(context) {
    return contextClientId(context);
  }

  /** 给广播消息附加 targetClientId。 */
  function withTargetClient(message, targetClientId) {
    return targetClientId ? { ...message, targetClientId } : message;
  }

  // ===== Hover Card / Pinned Threads BEGIN: 缓存刷新广播 =====
  // pinned 状态变化后需要主动失效官方 query cache，否则 hover card 的置顶状态不会立即刷新。
  /** pinned threads 变更后通知官方 query 缓存失效，首页 hover/pin 状态会自然刷新。 */
  function broadcastPinnedThreadsChanged(threadIds) {
    if (typeof broadcast !== "function") return;
    broadcast({
      channel: "query-cache-invalidate",
      payload: { type: "query-cache-invalidate", queryKey: ["list-pinned-threads"] },
    });
    broadcast({ channel: "pinned-threads-changed", payload: { threadIds } });
  }
  // ===== Hover Card / Pinned Threads END: 缓存刷新广播 =====

  function runDetached(label, task) {
    Promise.resolve()
      .then(task)
      .catch((error) => {
        logger && logger.warn(`[ipc] detached ${label} failed`, error);
      });
    return true;
  }

  /** Codex 业务 IPC 总分发。未知 channel 必须抛错，不能再静默返回 null。 */
  const handle = async (channel, payload, context = {}) => {
    switch (channel) {
      case "app:getPlatform":
        return "web";
      case "app:getVersion":
        return "web-poc";
      case "app:getConfig":
        return buildGatewayConfig();
      case "codex-command-keymap-state":
        return { bindings: [] };
      case "workspace-root-options":
        return workspaceIpc.workspaceRootOptions();
      case "add-workspace-root-option": {
        const result = workspaceIpc.addWorkspaceRootOption(payload);
        if (typeof broadcast === "function") {
          broadcast({ channel: "workspace-root-options-updated", payload: {} });
          if (payload && typeof payload === "object" && payload.setActive) {
            broadcast({ channel: "active-workspace-roots-updated", payload: {} });
          }
        }
        return result;
      }
      case "paths-exist":
        return workspaceIpc.pathsExist(payload);
      case "workspace-directory-entries": {
        return workspaceIpc.listWorkspaceDirectoryEntries(payload);
      }
      case "get-global-state":
        if (DEBUG_LOGS && payload && typeof payload === "object") {
          console.log(`[gateway] get-global-state key=${String(payload.key || "")}`);
        }
        return { value: desktopState.getGlobalStateValue(payload && typeof payload === "object" ? payload.key : null) };
      case "set-global-state": {
        const key = payload && typeof payload === "object" ? String(payload.key || "") : "";
        const result = desktopState.setGlobalStateValue(payload);
        if (typeof broadcast === "function") {
          const normalized = key.toLowerCase();
          if (normalized.includes("remote-projects") || normalized.includes("workspace-root-options")) {
            broadcast({ channel: "workspace-root-options-updated", payload: { key } });
          }
          if (normalized.includes("active-workspace-roots")) {
            broadcast({ channel: "active-workspace-roots-updated", payload: { key } });
          }
        }
        return result;
      }
      // ===== Hover Card / Pinned Threads BEGIN: renderer IPC handler =====
      // 官方 renderer 在首页 hover card/pin 交互中调用这三路 IPC；gateway 本地完成读写并广播刷新。
      case "list-pinned-threads":
        return { threadIds: desktopState.readPinnedThreadIds() };
      case "set-thread-pinned": {
        const result = desktopState.setThreadPinnedValue(payload);
        broadcastPinnedThreadsChanged(result.threadIds);
        return result;
      }
      case "set-pinned-threads-order": {
        const result = desktopState.setPinnedThreadsOrderValue(payload);
        broadcastPinnedThreadsChanged(result.threadIds);
        return result;
      }
      // ===== Hover Card / Pinned Threads END: renderer IPC handler =====
      case "extension-info":
        return {
          available: false,
          installed: false,
          extensions: [],
          web: true,
        };
      case "os-info":
        return buildOsInfo();
      case "get-copilot-api-proxy-info":
        return null;
      case "is-copilot-api-available":
        return {
          available: false,
          isLoading: false,
        };
      case "mcp-codex-config": {
        const config = await appServerBridge.readCodexConfig(payload);
        const rawConfig = config && typeof config === "object" && "config" in config ? config.config : config;
        return { config: normalizeMcpCodexConfig(rawConfig) };
      }
      case "read-config":
      case "read-config-for-host":
        return appServerBridge.readCodexConfig(payload);
      case "list-models-for-host":
        return appServerBridge.listModelsForHost(payload);
      case "worktree-shell-environment-config":
        return { shellEnvironment: null };
      case "get-config-requirements-for-host":
        return patchConfigRequirementsResult(await appServerBridge.callAppServer("configRequirements/read", undefined));
      case "developer-instructions": {
        const params = payload && typeof payload === "object" && payload.params ? payload.params : payload;
        const baseInstructions =
          params && typeof params === "object" && typeof params.baseInstructions === "string"
            ? params.baseInstructions
            : null;
        return { instructions: baseInstructions };
      }
      case "experimentalFeature/list":
      case "list-experimental-features": {
        const params = payload && typeof payload === "object" && payload.params ? payload.params : payload;
        return appServerBridge.callAppServer("experimentalFeature/list", params || {});
      }
      case "chronicle-permissions":
        // Web环境没有 Electron Chronicle sidecar，返回稳定状态让官方设置页正常渲染。
        return chroniclePermissionsStatus();
      case "pick-files":
        // 文件选择由 web-shell 调浏览器 picker，gateway 负责落盘并返回官方 renderer 需要的 fsPath。
        return localFiles.pickFilesForWeb(payload);
      case "read-file":
        return localFiles.readFile(payload);
      case "read-file-metadata":
        return localFiles.readFileMetadata(payload);
      case "read-file-binary":
        return localFiles.readFileBinary(payload);
      case "set-open-review-file-source-tabs":
        return recordOpenFileTabs(OPEN_REVIEW_FILE_SOURCE_TABS, payload);
      case "set-open-file-tabs":
        return recordOpenFileTabs(OPEN_FILE_TABS, payload);
      case "set-review-pane-snapshot-metrics-for-host":
        return recordReviewPaneSnapshotMetrics(payload);
      case "list-automations":
        // 自动化列表直接读取 Desktop 的本机 TOML，不再返回空列表。
        return automationIpc.listAutomations();
      case "list-pending-automation-run-threads":
        return { threadIds: [] };
      case "load-recent-conversation-ids-for-host":
        // Web 目前不维护 automation run 历史，只给前端一个稳定空列表避免阻塞页面。
        return [];
      case "automation-run-now":
        // 立即运行是用户主动操作，可以通过 app-server 发起一次 turn；后台调度仍不在 Web 实现。
        return automationIpc.runAutomationNow(payload);
      case "automation-create":
      case "automation-update":
      case "automation-delete":
      case "automation-run-archive":
        // 创建、修改、删除和归档记录涉及 Desktop 的调度/状态管理，Web 明确报只读错误。
        return automationIpc.throwAutomationReadOnlyError();
      case "active-workspace-roots":
        return { roots: workspaceIpc.activeWorkspaceRootPaths() };
      case "local-environments":
        return { environments: [] };
      case "has-custom-cli-executable": {
        const executable =
          desktopState.getConfigurationValue({ key: "customCliExecutable" }) ||
          desktopState.getConfigurationValue({ key: "customCliExecutablePath" }) ||
          null;
        return { hasCustomCliExecutable: typeof executable === "string" && executable.trim().length > 0 };
      }
      case "open-in-targets":
        return { targets: [], targetInfos: [] };
      case "native-desktop-app-by-bundle-id":
        return nativeDesktopAppByBundleId(payload);
      case "native-desktop-app-icon":
        return nativeDesktopAppIcon(payload);
      case "open-file":
        return localFiles.openFileForPayload(payload, context);
      case "get-configuration":
        return { value: desktopState.getConfigurationValue(payload) };
      case "set-configuration":
        return desktopState.setConfigurationValue(payload);
      case "set-remote-control-connections-enabled":
        if (payload && typeof payload === "object" && Object.prototype.hasOwnProperty.call(payload, "enabled")) {
          desktopState.setConfigurationValue({
            key: "remoteControlConnectionsEnabled",
            value: !!payload.enabled,
          });
        }
        return true;
      case "git-origins":
        return { origins: [] };
      case "inbox-items":
        return { items: [] };
      case "ambient-suggestions":
        return {
          file: workspaceRuntime.buildEmptyAmbientSuggestionsFile(
            payload && typeof payload === "object" ? payload.projectRoot || "" : ""
          ),
        };
      case "ambient-suggestions-refresh":
        return true;
      case "ide-context":
        return workspaceRuntime.buildIdeContext(payload);
      case "projectless-workspace-root":
        return { workspaceRoot: workspaceRuntime.getProjectlessWorkspaceRoot() };
      case "projectless-thread-cwd":
        return workspaceRuntime.resolveProjectlessThreadContext();
      case "email-domain-mail-provider":
        return {
          provider: workspaceRuntime.guessMailProvider(payload && typeof payload === "object" ? payload.domain : null),
        };
      case "codex-agents-md": {
        // 读取工作区内的 CLAUDE.md / AGENTS.md 等 AI 指导文件供 renderer 使用。
        return localFiles.readAgentsMdForWorkspace(payload);
      }
      case "account-info": {
        return chatgptBackend.accountInfoFromCodexAccount(payload);
      }
      case "recommended-skills":
        return recommendedSkills.listRecommendedSkills(payload);
      case "install-recommended-skill": {
        const result = recommendedSkills.installRecommendedSkill(payload);
        try {
          await appServerBridge.callAppServer("skills/list", { cwds: workspaceIpc.activeWorkspaceRootPaths(), forceReload: true });
        } catch {}
        return result;
      }
      case "codex-home":
        return path.join(os.homedir(), ".codex");
      case "home-directory":
        return { homeDirectory: os.homedir() };
      case "custom-avatars":
        return { avatarDirectory: null, avatars: [] };
      case "external-agent-imported-connectors":
        return { connectors: [] };
      case "locale-info":
        return buildLocaleInfo();
      case "projects:list":
        return workspaceIpc.listProjects();
      case "projects:browse":
        return workspaceIpc.browseProjects(payload);
      case "threads:list":
      case "thread:list":
        return appServerBridge.callAppServer("thread/list", payload);
      case "start-conversation":
        return conversationIpc.startConversation(payload);
      case "start-thread-for-host": {
        const result = await appServerBridge.callAppServer("thread/start", payload);
        // 这个入口直接暴露 thread/start，必须同样记录真实 thread 的 Desktop 元数据。
        workspaceRuntime.recordThreadStartMetadata(result, payload);
        return result;
      }
      case "set-thread-title": {
        const params = payload && typeof payload === "object" ? payload : {};
        const threadId = params.threadId || params.conversationId || params.id || null;
        const name = typeof params.title === "string" ? params.title : params.name;
        if (!threadId || typeof name !== "string") return true;
        return appServerBridge.callAppServer("thread/name/set", { threadId, name });
      }
      case "generate-thread-title": {
        const params = payload && typeof payload === "object" && payload.params ? payload.params : payload;
        const prompt = params && typeof params === "object" && typeof params.prompt === "string" ? params.prompt : "";
        const title = prompt.replace(/\s+/g, " ").trim().slice(0, 60);
        return { title };
      }
      case "fast-mode-rollout-metrics":
        return null;
      case "native-desktop-apps":
        return { apps: [] };
      case "node-repl-active-execs-kill":
        // Web 环境没有 Node REPL 进程，直接确认即可。
        return true;
      case "terminal-shell-options":
        return { availableShells: process.platform === "win32" ? ["powershell", "commandPrompt"] : [] };
      case "settings:get":
        return desktopState.getSettingValue(payload, { readCodexConfig: appServerBridge.readCodexConfig });
      case "settings:set":
        return desktopState.setSettingValue(payload, { callAppServer: appServerBridge.callAppServer });
      case "list-archived-threads":
        return workspaceRuntime.listArchivedThreads();
      case "archive-conversation": {
        const archived = workspaceRuntime.listArchivedThreads();
        const conversationId =
          payload && typeof payload === "object"
            ? payload.conversationId || payload.threadId || payload.id || null
            : null;
        if (conversationId && !archived.some((item) => item && item.id === conversationId)) {
          archived.unshift({
            id: conversationId,
            name:
              (payload && typeof payload === "object" && (payload.name || payload.title || payload.preview)) ||
              null,
            preview: (payload && typeof payload === "object" && payload.preview) || null,
            cwd: (payload && typeof payload === "object" && payload.cwd) || null,
            path: (payload && typeof payload === "object" && payload.path) || null,
            hostId: (payload && typeof payload === "object" && payload.hostId) || null,
            createdAt: Math.floor(Date.now() / 1000),
            updatedAt: Math.floor(Date.now() / 1000),
          });
          workspaceRuntime.setArchivedThreads(archived);
        }
        return true;
      }
      case "unarchive-conversation": {
        const conversationId =
          payload && typeof payload === "object"
            ? payload.conversationId || payload.threadId || payload.id || null
            : null;
        if (!conversationId) return true;
        workspaceRuntime.setArchivedThreads(workspaceRuntime.listArchivedThreads().filter((item) => item && item.id !== conversationId));
        return true;
      }
      case "worktree-delete":
        return true;
      case "window:setTitle":
        if (typeof context.setTitle === "function") context.setTitle(payload);
        if (typeof broadcast === "function") broadcast({ channel: "window:setTitle", payload });
        return true;
      case "shell:openExternal":
        if (typeof context.openExternal === "function") return context.openExternal(payload);
        return true;
      case "codex:initialize":
        return appServerBridge.callAppServer("initialize", payload);
      case "transcribe":
        return chatgptBackend.transcribeAudioViaChatgpt(payload);
      case "codex_desktop:message-from-view":
        return viewMessages.handleViewMessage(payload, context);
      case "codex_desktop:get-shared-object-snapshot":
        return sharedObjectIpc.getSnapshot();
      case "shared-object-set":
        return sharedObjectIpc.setSharedObject(payload);
      case "shared-object-subscribe":
        return sharedObjectIpc.subscribeSharedObject(payload);
      case "thread:start": {
        const result = await appServerBridge.callAppServer("thread/start", payload);
        // 兼容旧式 thread:start channel，保持和 start-conversation 一样的刷新后归属信息。
        workspaceRuntime.recordThreadStartMetadata(result, payload);
        return result;
      }
      case "send-cli-request-for-host":
        return callAppServerForHost(payload);
      case "prewarm-thread-start-for-host": {
        const params = payload && typeof payload === "object" && payload.params ? payload.params : payload;
        return callAppServerForHost(payload, "thread/start", params && params.params);
      }
      case "refresh-recent-conversations-for-host": {
        const params = payload && typeof payload === "object" && payload.params ? payload.params : payload;
        return appServerBridge.callAppServer("thread/list", {
          archived: false,
          cursor: null,
          limit: null,
          sortKey:
            params && typeof params === "object" && typeof params.sortKey === "string"
              ? params.sortKey
              : "updated_at",
        });
      }
      case "unsubscribe-thread-for-host":
      case "broadcast-conversation-snapshot":
      case "capture-browser-use-turn-route":
      case "capture-computer-use-turn-route":
      case "start-windows-sandbox-setup-for-host":
      case "update-thread-git-branch":
        return true;
      case "turn:start":
        return appServerBridge.callAppServer("turn/start", payload);
      case "turn:interrupt":
        return appServerBridge.callAppServer("turn/interrupt", payload);
      case "approval:respond":
        if (payload && typeof payload === "object" && (payload.response || payload.message || payload.id)) {
          return appServerBridge.respondToAppServerRequest(payload);
        }
        return appServerBridge.callAppServer("approval/respond", payload);
      case "file:readPreview":
        return filePreviewIpc.readPreview(payload);
      case "file:stat":
        return filePreviewIpc.stat(payload);
      case "git:status":
        if (payload == null || (payload && typeof payload === "object")) {
          const localStatus = gitIpc.gitStatusForPayload(payload || {});
          if (localStatus != null) return localStatus;
        }
        return appServerBridge.callAppServer("git/status", payload);
      case "gh-cli-status":
        return gitIpc.ghCliStatus();
      case "stable-metadata":
        return gitIpc.gitStableMetadataForPayload(payload || {});
      case "apply-patch":
        return gitIpc.applyPatchForPayload(payload || {});
      case "current-branch":
        return gitIpc.currentBranchForPayload(payload || {});
      case "recent-branches":
      case "search-branches": {
        const result = gitIpc.recentBranchesForPayload(payload || {});
        const query =
          payload && typeof payload === "object" && typeof payload.query === "string"
            ? payload.query.trim().toLowerCase()
            : "";
        if (!query) return result;
        return {
          ...result,
          branches: result.branches.filter((branch) => branch.toLowerCase().includes(query)),
        };
      }
      case "git-create-branch":
        return gitIpc.createGitBranchForPayload(payload || {});
      case "git-checkout-branch":
        return gitIpc.checkoutGitBranchForPayload(payload || {});
      case "base-branch":
        return gitIpc.baseBranchForPayload(payload || {});
      default:
        if (channel.startsWith("codex_desktop:worker:") && channel.endsWith(":from-view")) {
          const handled = workerIpc.handleWorkerMessage(channel, payload);
          // worker 通道也要把未支持能力暴露给前端，避免只留 gateway 日志。
          if (!handled) throw new Error(`Unsupported Codex worker message: ${channel}`);
          return true;
        }
        // 业务层声明自己能处理的 channel 却没有 case 时，必须让前端看到明确错误。
        logger.warn(`[ipc] unknown channel: ${channel}`);
        diagnostics.appendUnknownIpc(channel, payload);
        throw new Error(`Unsupported Codex IPC channel: ${channel}`);
    }
  };

  return {
    handle,
    broadcast,
  };
}

/** Codex 业务 IPC 端口实现，只负责业务 channel，不实现 Electron 通用 IPC 语义。 */
class GatewayCodexIpcPort {
  handlers;
  channels;

  /** 初始化业务 handler，并构造 canHandleCodexChannel 使用的 channel 集合。 */
  constructor({ appServer, broadcast, logger, isClientConnected }) {
    this.handlers = makeHandlers({ appServer, broadcast, logger, isClientConnected });
    this.channels = new Set([
      ...BRIDGE_MAP_ENTRIES.map((entry) => entry && entry.renderer).filter(Boolean),
      ...CODEX_ADDITIONAL_CHANNELS,
    ]);
  }

  /** 返回所有显式注册的业务 channel。 */
  listCodexChannels() {
    return [...this.channels];
  }

  /** 判断 channel 是否属于 Codex 业务层，避免 Electron IPC unknown 被业务层误吞。 */
  canHandleCodexChannel(channel) {
    if (this.channels.has(channel)) return true;
    return channel.startsWith("codex_desktop:worker:") && channel.endsWith(":from-view");
  }

  /** 执行具体 Codex 业务 IPC。 */
  handleCodexRequest(channel, payload, context) {
    return this.handlers.handle(channel, payload, context);
  }
}

module.exports = {
  BRIDGE_MAP_ENTRIES,
  GatewayCodexIpcPort,
  appendUnknownIpc: diagnostics.appendUnknownIpc,
  buildGatewayConfig,
  makeHandlers,
  renderCodexBridgeMapMarkdown: diagnostics.renderCodexBridgeMapMarkdown,
  writeCodexBridgeMapReport: diagnostics.writeCodexBridgeMapReport,
};
