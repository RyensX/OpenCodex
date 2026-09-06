const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { Worker } = require("worker_threads");
const zlib = require("zlib");
const {
  PATCHED_OFFICIAL_PREFIX,
  WEB_SHELL_ASSETS_PREFIX,
  WEB_SHELL_DIR,
  exists,
  isWithinRoot,
  mimeType,
  readText,
} = require("../core/config.cjs");
const { isLoopbackHostHeader } = require("../core/loopback-host.cjs");
const {
  OPENCODEX_PLUGIN_URL_PREFIX,
  listPluginEntries,
  pluginEntryFileFromRequestPath,
  withPluginI18nMessages,
} = require("../core/plugin-assets.cjs");
const { gzipIfUseful, send } = require("./http-utils.cjs");
const { OPENCODEX_VERSION_LABEL } = require("../../../shared/app-version.cjs");
const { runtimeCompatibilityMessagesForLocale } = require("../../../shared/i18n/index.cjs");
const { createHostModificationRuntime } = require("../modification/production-runtime.cjs");

const configuredPatchedAssetCacheMaxBytes = Number(
  process.env.CODEX_WEB_PATCHED_ASSET_CACHE_MAX_BYTES || 96 * 1024 * 1024
);
const PATCHED_ASSET_CACHE_MAX_BYTES = Math.max(
  16 * 1024 * 1024,
  Number.isFinite(configuredPatchedAssetCacheMaxBytes)
    ? configuredPatchedAssetCacheMaxBytes
    : 96 * 1024 * 1024
);
const PATCHED_ASSET_PATCH_REVISION = "11";
const ASYNC_PATCH_MIN_BYTES = 512 * 1024;
const OFFICIAL_ASSET_PATCH_WORKER_IDLE_MS = 30_000;
const OFFICIAL_ASSET_PATCH_WORKER_PATH = path.join(__dirname, "official-asset-patch-worker.cjs");
const LATE_STARTUP_MODULE_PREFIXES = [
  "thread-app-shell-chrome-",
  "home-ambient-suggestions-content-",
  "codex-home-announcements-",
];

const OPENCODEX_PLUGIN_LOADER_PATH = "/opencodex-plugin-loader.js";
const OPENCODEX_PLUGIN_SYSTEM_PATH = "/opencodex-plugin-system.js";
const OPENCODEX_MODIFICATION_RUNTIME_PATH = "/opencodex-modification-runtime.js";
const OPENCODEX_MODIFICATION_ACTIVATE_PATH = "/opencodex-modification-activate.js";
const OPENCODEX_GATEWAY_PLUGIN_SWITCHES_PATH = "/opencodex-gateway-plugin-switches.js";
const CODEX_SMART_MODEL_ROUTER_SETTINGS_CSS_PATH = "/codex-smart-model-router-settings.css";
const CODEX_SMART_SCHEDULING_INJECTION_HEALTH_PATH = "/codex-smart-scheduling-injection-health.js";
const CODEX_SMART_MODEL_ROUTER_SETTINGS_PATH = "/codex-smart-model-router-settings.js";
const CODEX_SMART_MODEL_ROUTER_COMPOSER_PATH = "/codex-smart-model-router-composer.js";
const CODEX_SMART_SCHEDULING_SUMMARY_CSS_PATH = "/codex-smart-scheduling-summary.css";
const CODEX_SMART_SCHEDULING_SUMMARY_PATH = "/codex-smart-scheduling-summary.js";
const OPENCODEX_TOKEN_USAGE_CAPABILITY_PATH = "/codex-token-usage-capability.js";
const OPENCODEX_WINDOW_CONTROLS_OVERLAY_CSS_PATH = "/codex-window-controls-overlay.css";
const OPENCODEX_WINDOW_CONTROLS_OVERLAY_PATH = "/codex-window-controls-overlay.js";
const OPENCODEX_RUNTIME_BOOTSTRAP_PATH = "/opencodex-runtime-bootstrap.js";
const OPENCODEX_RUNTIME_COMPATIBILITY_PATH = "/codex-runtime-compatibility.js";
const RUNTIME_COMPATIBILITY_PAGE_PATH = "/opencodex/runtime-compatibility";
const RUNTIME_COMPATIBILITY_SETTINGS_PATH = "/settings/developer/runtime-compatibility";
const RUNTIME_COMPATIBILITY_SCRIPT_PATH = "/opencodex/runtime-compatibility.js";
const RUNTIME_COMPATIBILITY_STYLE_PATH = "/opencodex/runtime-compatibility.css";
const OPENCODEX_SIDEBAR_PREVIEW_PATH = "/codex-sidebar-preview.js";
const OPENCODEX_OFFSCREEN_ANIMATION_GUARD_PATH = "/codex-offscreen-animation-guard.js";
const CODEX_APP_HOST_MESSAGE_CODEC_PATH = "/codex-app-host-message-codec.js";
const CODEX_BRIDGE_POLYFILL_PATH = "/codex-bridge-polyfill.js";
const CODEX_REMOTE_FILE_ACTIONS_PATH = "/codex-remote-file-actions.js";
const CODEX_WORKSPACE_ROOT_PICKER_CSS_PATH = "/codex-workspace-root-picker.css";
const CODEX_WORKSPACE_ROOT_PICKER_PATH = "/codex-workspace-root-picker.js";
const CODEX_TOOLTIP_DISMISS_GUARD_PATH = "/codex-tooltip-dismiss-guard.js";
const FAVICON_PATH = "/favicon.ico";
const PWA_MANIFEST_PATH = "/manifest.webmanifest";
const OFFICIAL_LOADING_SHIMMER_POWER_GUARD = [
  '<style id="codex-web-loading-shimmer-power-guard">',
  // 官方加载 Logo 通过 background-position 无限刷新，每秒会触发约 120 次样式重算；保留三轮反馈后静止。
  '#root > .relative.size-full [aria-hidden="true"].size-14 > [class*="_Overlay_"][style*="mask-image"] { animation-iteration-count: 3 !important; }',
  "</style>",
].join("");
const WEB_SHELL_ASSETS_DIR = path.join(WEB_SHELL_DIR, "assets");
const OPENCODEX_MODIFICATION_RUNTIME_FILE = path.join(
  __dirname,
  "..",
  "..",
  "dist",
  "web",
  "opencodex-modification-runtime.js"
);
const INTERNAL_PROVIDER_DIR = path.join(WEB_SHELL_DIR, "internal", "providers");
const BUILTIN_PROVIDER_FILES = new Map([
  ["/opencodex/internal/providers/mobile-keyboard-optimization.js", path.join(INTERNAL_PROVIDER_DIR, "mobile-keyboard-optimization.js")],
  ["/opencodex/internal/providers/ios-fix.js", path.join(INTERNAL_PROVIDER_DIR, "ios-fix.js")],
  ["/opencodex/internal/providers/mobile-sidebar-auto-collapse.js", path.join(INTERNAL_PROVIDER_DIR, "mobile-sidebar-auto-collapse.js")],
  ["/opencodex/internal/providers/token-usage-inline.js", path.join(INTERNAL_PROVIDER_DIR, "token-usage-inline.js")],
  ["/opencodex/internal/providers/project-recent-sort.js", path.join(INTERNAL_PROVIDER_DIR, "project-recent-sort.js")],
]);
const BROWSER_PROVIDER_KEY_BY_FILE = new Map([
  [path.join(INTERNAL_PROVIDER_DIR, "codex-sidebar-preview.js"), "sidebar-preview"],
  [path.join(INTERNAL_PROVIDER_DIR, "codex-offscreen-animation-guard.js"), "offscreen-animation"],
  [path.join(INTERNAL_PROVIDER_DIR, "mobile-keyboard-optimization.js"), "mobile-keyboard"],
  [path.join(INTERNAL_PROVIDER_DIR, "ios-fix.js"), "ios-layout"],
  [path.join(INTERNAL_PROVIDER_DIR, "mobile-sidebar-auto-collapse.js"), "mobile-sidebar"],
  [path.join(INTERNAL_PROVIDER_DIR, "token-usage-inline.js"), "token-usage-inline"],
  [path.join(INTERNAL_PROVIDER_DIR, "project-recent-sort.js"), "project-recent-sort"],
  [path.join(INTERNAL_PROVIDER_DIR, "codex-smart-scheduling-injection-health.js"), "smart-settings"],
  [path.join(INTERNAL_PROVIDER_DIR, "codex-smart-model-router-settings.js"), "smart-settings"],
  [path.join(INTERNAL_PROVIDER_DIR, "codex-smart-model-router-composer.js"), "smart-composer"],
  [path.join(INTERNAL_PROVIDER_DIR, "codex-smart-scheduling-summary.js"), "smart-summary"],
  [path.join(INTERNAL_PROVIDER_DIR, "codex-token-usage-capability.js"), "token-usage-capability"],
  [path.join(INTERNAL_PROVIDER_DIR, "codex-window-controls-overlay.js"), "window-controls"],
  [path.join(INTERNAL_PROVIDER_DIR, "codex-bridge-polyfill.js"), "bridge"],
  [path.join(INTERNAL_PROVIDER_DIR, "codex-remote-file-actions.js"), "remote-file-actions"],
  [path.join(INTERNAL_PROVIDER_DIR, "codex-workspace-root-picker.js"), "workspace-root-picker"],
  [path.join(INTERNAL_PROVIDER_DIR, "codex-tooltip-dismiss-guard.js"), "tooltip-dismiss"],
]);
const OFFICIAL_OPEN_IN_FOLDER_MESSAGE_ID = "artifactTab.preview.openInFolder";
const OPENCODEX_DOWNLOAD_FILE_MESSAGE_ID = "web.remoteFile.downloadFile";
const JS_STRING_LITERAL = String.raw`(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|` + "`" + String.raw`(?:\\.|[^` + "`" + String.raw`\\])*` + "`" + ")";
const REGEXP_SPECIAL_CHARS_RE = /[.*+?^${}()|[\]\\]/g;
function escapeRegExp(value) {
  return String(value).replace(REGEXP_SPECIAL_CHARS_RE, "\\$&");
}
const OPEN_IN_FOLDER_LOCALE_TOKEN = `"${OFFICIAL_OPEN_IN_FOLDER_MESSAGE_ID}"`;
const OPEN_IN_FOLDER_LOCALE_VALUE_AT_START_RE = new RegExp(
  `("${escapeRegExp(OFFICIAL_OPEN_IN_FOLDER_MESSAGE_ID)}"\\s*:\\s*)${JS_STRING_LITERAL}`,
  "y"
);
const APPLICATION_MENU_TOKEN = ".applicationMenu";
const PENDING_WORKTREES_TOKEN = "pending_worktrees";
const PENDING_WORKTREES_FIND_RE =
  /function ([A-Za-z0-9_$]+)\(e,t\)\{return e\.find\(e=>e\.clientThreadId===t\)\?\?null\}/;
const APPLICATION_MENU_CAPABILITY_CHECK_AT_START_RE =
  /\b[A-Za-z_$][\w$]*\(\)\s*&&\s*[A-Za-z_$][\w$]*\??\.applicationMenu\s*!={1,2}\s*(?:null|void 0)\b/y;
const APPLICATION_MENU_SERVICE_USAGE_RE =
  /\b[A-Za-z_$][\w$]*\??\.applicationMenu\??\.(?:getSnapshot|invokeItem)\b/;
const APP_SERVER_REQUEST_CLIENT_FIELDS_RE =
  /pendingConfigReadRequests=new Map;queuedRequests=\[\]/;
const APP_SERVER_REQUEST_CLIENT_DISPATCH_ERROR = "AppServerRequestClient is missing a message dispatcher";
const APP_SERVER_REQUEST_CLIENT_SEND_RE =
  /async sendRequest\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)\{if\(this\.dispatchMessage==null\)throw Error\(`AppServerRequestClient is missing a message dispatcher`\);return \1===`config\/read`\?this\.sendConfigReadRequest\(\2,\3\):this\.enqueueRequest\(\1,\2,\3\)\}/;
const APP_SERVER_BACKGROUND_METHODS_RE =
  /new Set\(\[(?:`app\/installed`,)?`app\/list`(?:,`app\/read`)?,`collaborationMode\/list`,`config\/read`,`configRequirements\/read`,`experimentalFeature\/list`,`hooks\/list`,`mcpServerStatus\/list`,`model\/list`,`permissionProfile\/list`,`plugin\/list`,`skills\/list`\]\)/;
const APP_SERVER_BACKGROUND_METHODS = [
  "app/list",
  "hooks/list",
  "mcpServerStatus/list",
  "plugin/list",
  "skills/list",
];
const PLUGIN_SUMMARY_IMAGE_EAGER_RE =
  /Promise\.all\(\[\s*([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\.composerIconPath\s*,\s*([A-Za-z_$][\w$]*)\s*,\s*([A-Za-z_$][\w$]*)\)\s*,\s*\1\(\2\.logoPath\s*,\s*\3\s*,\s*\4\)\s*,\s*\1\(\2\.logoDarkPath\s*,\s*\3\s*,\s*\4\)\s*\]\)/g;
const PLUGIN_SUMMARY_IMAGE_LAYOUT_HINT_RE =
  /Promise\.all\(\[[\s\S]{0,240}\.composerIconPath[\s\S]{0,240}\.logoPath[\s\S]{0,240}\.logoDarkPath[\s\S]{0,240}\]\)/;

let officialAssetPatchWorker = null;
let officialAssetPatchWorkerIdleTimer = null;
let officialAssetPatchWorkerSequence = 0;
const officialAssetPatchWorkerJobs = new Map();

function officialAssetPatchWorkerHasJobs(worker) {
  return Array.from(officialAssetPatchWorkerJobs.values()).some((job) => job.worker === worker);
}

function rejectOfficialAssetPatchWorkerJobs(worker, error) {
  for (const [id, job] of officialAssetPatchWorkerJobs.entries()) {
    if (job.worker !== worker) continue;
    officialAssetPatchWorkerJobs.delete(id);
    job.reject(error);
  }
}

function clearOfficialAssetPatchWorkerIdleTimer() {
  if (officialAssetPatchWorkerIdleTimer) clearTimeout(officialAssetPatchWorkerIdleTimer);
  officialAssetPatchWorkerIdleTimer = null;
}

function releaseOfficialAssetPatchWorkerWhenIdle(worker) {
  if (officialAssetPatchWorkerHasJobs(worker)) return;
  worker.unref();
  clearOfficialAssetPatchWorkerIdleTimer();
  officialAssetPatchWorkerIdleTimer = setTimeout(() => {
    officialAssetPatchWorkerIdleTimer = null;
    if (officialAssetPatchWorker !== worker || officialAssetPatchWorkerHasJobs(worker)) return;
    // 冷启动资源处理完成后释放整个 Worker isolate，避免网关空闲期常驻额外线程和堆。
    officialAssetPatchWorker = null;
    void worker.terminate().catch(() => {});
  }, OFFICIAL_ASSET_PATCH_WORKER_IDLE_MS);
  if (officialAssetPatchWorkerIdleTimer.unref) officialAssetPatchWorkerIdleTimer.unref();
}

function currentOfficialAssetPatchWorker() {
  if (officialAssetPatchWorker) return officialAssetPatchWorker;
  const worker = new Worker(OFFICIAL_ASSET_PATCH_WORKER_PATH);
  officialAssetPatchWorker = worker;
  worker.on("message", (message) => {
    const job = officialAssetPatchWorkerJobs.get(message?.id);
    if (!job) return;
    officialAssetPatchWorkerJobs.delete(message.id);
    if (message.error) {
      job.reject(new Error(message.error));
    } else {
      const bytes = message.data;
      const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      job.resolve({ data, patched: message.patched === true });
    }
    // 没有待处理资源时不让空闲 worker 阻止测试进程或 gateway 正常退出。
    releaseOfficialAssetPatchWorkerWhenIdle(worker);
  });
  worker.on("error", (error) => {
    if (officialAssetPatchWorker === worker) officialAssetPatchWorker = null;
    rejectOfficialAssetPatchWorkerJobs(worker, error);
  });
  worker.on("exit", (code) => {
    if (officialAssetPatchWorker === worker) officialAssetPatchWorker = null;
    rejectOfficialAssetPatchWorkerJobs(
      worker,
      new Error(`official asset patch worker exited with code ${code}`)
    );
  });
  return worker;
}

function patchOfficialAssetOffMainThread({ data, downloadMessage, host, locale, reqPath }) {
  const worker = currentOfficialAssetPatchWorker();
  clearOfficialAssetPatchWorkerIdleTimer();
  worker.ref();
  const id = ++officialAssetPatchWorkerSequence;
  const transferable =
    data.byteOffset === 0 && data.byteLength === data.buffer.byteLength ? data : Buffer.from(data);
  return new Promise((resolve, reject) => {
    officialAssetPatchWorkerJobs.set(id, { reject, resolve, worker });
    try {
      worker.postMessage(
        { data: transferable, downloadMessage, host, id, locale, reqPath },
        [transferable.buffer]
      );
    } catch (error) {
      officialAssetPatchWorkerJobs.delete(id);
      releaseOfficialAssetPatchWorkerWhenIdle(worker);
      reject(error);
    }
  });
}
// 固定 web-shell 资源只在这里登记一次，白名单和文件映射共用同一份配置。
const WEB_SHELL_STATIC_FILES = new Map([
  [FAVICON_PATH, path.join(WEB_SHELL_ASSETS_DIR, "icon.png")],
  [PWA_MANIFEST_PATH, path.join(WEB_SHELL_DIR, "manifest.webmanifest")],
  // 调试页只读取已经脱敏的兼容性快照，登录前也允许从认证页设置入口打开。
  [RUNTIME_COMPATIBILITY_PAGE_PATH, path.join(WEB_SHELL_DIR, "runtime-compatibility.html")],
  [RUNTIME_COMPATIBILITY_SETTINGS_PATH, path.join(WEB_SHELL_DIR, "runtime-compatibility.html")],
  [RUNTIME_COMPATIBILITY_SCRIPT_PATH, path.join(WEB_SHELL_DIR, "runtime-compatibility.js")],
  [RUNTIME_COMPATIBILITY_STYLE_PATH, path.join(WEB_SHELL_DIR, "runtime-compatibility.css")],
  [OPENCODEX_MODIFICATION_RUNTIME_PATH, OPENCODEX_MODIFICATION_RUNTIME_FILE],
  [OPENCODEX_MODIFICATION_ACTIVATE_PATH, path.join(WEB_SHELL_DIR, "opencodex-modification-activate.js")],
  ...BUILTIN_PROVIDER_FILES,
  [OPENCODEX_PLUGIN_SYSTEM_PATH, path.join(WEB_SHELL_DIR, "opencodex-plugin-system.js")],
  [
    OPENCODEX_RUNTIME_COMPATIBILITY_PATH,
    path.join(WEB_SHELL_DIR, "codex-runtime-compatibility.js"),
  ],
  [
    OPENCODEX_GATEWAY_PLUGIN_SWITCHES_PATH,
    path.join(WEB_SHELL_DIR, "opencodex-gateway-plugin-switches.js"),
  ],
  [
    CODEX_SMART_MODEL_ROUTER_SETTINGS_CSS_PATH,
    path.join(WEB_SHELL_DIR, "codex-smart-model-router-settings.css"),
  ],
  [
    CODEX_SMART_SCHEDULING_INJECTION_HEALTH_PATH,
    path.join(INTERNAL_PROVIDER_DIR, "codex-smart-scheduling-injection-health.js"),
  ],
  [CODEX_SMART_MODEL_ROUTER_SETTINGS_PATH, path.join(INTERNAL_PROVIDER_DIR, "codex-smart-model-router-settings.js")],
  [CODEX_SMART_MODEL_ROUTER_COMPOSER_PATH, path.join(INTERNAL_PROVIDER_DIR, "codex-smart-model-router-composer.js")],
  [
    CODEX_SMART_SCHEDULING_SUMMARY_CSS_PATH,
    path.join(WEB_SHELL_DIR, "codex-smart-scheduling-summary.css"),
  ],
  [CODEX_SMART_SCHEDULING_SUMMARY_PATH, path.join(INTERNAL_PROVIDER_DIR, "codex-smart-scheduling-summary.js")],
  [OPENCODEX_TOKEN_USAGE_CAPABILITY_PATH, path.join(INTERNAL_PROVIDER_DIR, "codex-token-usage-capability.js")],
  [OPENCODEX_WINDOW_CONTROLS_OVERLAY_CSS_PATH, path.join(WEB_SHELL_DIR, "codex-window-controls-overlay.css")],
  [OPENCODEX_WINDOW_CONTROLS_OVERLAY_PATH, path.join(INTERNAL_PROVIDER_DIR, "codex-window-controls-overlay.js")],
  [OPENCODEX_SIDEBAR_PREVIEW_PATH, path.join(INTERNAL_PROVIDER_DIR, "codex-sidebar-preview.js")],
  [
    OPENCODEX_OFFSCREEN_ANIMATION_GUARD_PATH,
    path.join(INTERNAL_PROVIDER_DIR, "codex-offscreen-animation-guard.js"),
  ],
  [CODEX_APP_HOST_MESSAGE_CODEC_PATH, path.join(WEB_SHELL_DIR, "codex-app-host-message-codec.js")],
  [CODEX_BRIDGE_POLYFILL_PATH, path.join(INTERNAL_PROVIDER_DIR, "codex-bridge-polyfill.js")],
  [CODEX_REMOTE_FILE_ACTIONS_PATH, path.join(INTERNAL_PROVIDER_DIR, "codex-remote-file-actions.js")],
  [CODEX_WORKSPACE_ROOT_PICKER_CSS_PATH, path.join(WEB_SHELL_DIR, "codex-workspace-root-picker.css")],
  [CODEX_WORKSPACE_ROOT_PICKER_PATH, path.join(INTERNAL_PROVIDER_DIR, "codex-workspace-root-picker.js")],
  [CODEX_TOOLTIP_DISMISS_GUARD_PATH, path.join(INTERNAL_PROVIDER_DIR, "codex-tooltip-dismiss-guard.js")],
]);

// 静态资源层把官方 renderer/web-shell 的路径差异统一隐藏起来，server 只需要按 URL 取文件。
function createStaticAssetService({
  compatibilityService,
  getI18nSnapshot,
  getOfficialBundle,
  patchedAssetCacheMaxBytes = PATCHED_ASSET_CACHE_MAX_BYTES,
}) {
  const staticModificationRuntime = createHostModificationRuntime({
    host: "static",
    compatibilityService,
  });
  const staticPoints = staticModificationRuntime.points.staticRenderer;
  const modificationCoordinator = staticModificationRuntime.coordinator;
  const effectivePatchedAssetCacheMaxBytes = Math.max(
    1,
    Number.isFinite(Number(patchedAssetCacheMaxBytes))
      ? Number(patchedAssetCacheMaxBytes)
      : PATCHED_ASSET_CACHE_MAX_BYTES
  );
  let hasWarnedHistoryPatchMiss = false;
  let hasWarnedApplicationMenuPatchMiss = false;
  let hasWarnedPluginSummaryImagePatchMiss = false;
  let hasWarnedPatchWorkerFailure = false;
  const failedCompatibilityPoints = new Set();
  let officialAssetFileNamesCache = null;
  const patchedAssetCache = new Map();
  const patchedAssetBuildPromises = new Map();
  let runtimeBootstrapCache = null;
  let patchedAssetCacheBytes = 0;
  const patchedAssetCacheStats = {
    compressionRuns: 0,
    hits: 0,
    misses: 0,
    notModified: 0,
    patchRuns: 0,
  };
  // 旧版本曾经使用 /official-patched/；浏览器缓存的旧 chunk 可能还会懒加载这个前缀。
  const patchedOfficialPrefixes = Array.from(
    new Set([
      PATCHED_OFFICIAL_PREFIX,
      "/official-patched-v8/",
      "/official-patched-v7/",
      "/official-patched-v6/",
      "/official-patched-v5/",
      "/official-patched-v4/",
      "/official-patched/",
    ])
  );

  function hitCompatibilityPoint(point) {
    try {
      modificationCoordinator.effect(point).emit();
    } catch {
      // 命中统计失败不影响 HTML 或资源响应。
    }
  }

  function failCompatibilityPoint(point, reason) {
    if (failedCompatibilityPoints.has(point)) return;
    failedCompatibilityPoints.add(point);
    try {
      modificationCoordinator.locationFailure(point, "failed", new Error(reason));
      modificationCoordinator.useFallback(point, "Official renderer behavior");
    } catch {}
  }

  const dynamicHtmlPoints = [
    staticPoints.runtimeBootstrap,
    staticPoints.startupPreload,
    staticPoints.sidebarPreview,
    staticPoints.loadingAnimation,
  ];
  const staticCapabilityEntries = [
    [staticPoints.htmlLang, patchHtmlLang],
    [staticPoints.htmlViewport, patchHtmlViewport],
    [staticPoints.iconPwa, patchHtmlIcons],
    [staticPoints.assetPathMap, patchHtmlAssetPaths],
    [staticPoints.fontPreload, patchHtmlFontPreloads],
    [staticPoints.assetNamespace, patchOfficialAssetUrls],
    [staticPoints.cspUnsafeEval, patchOfficialCspUnsafeEval],
    [staticPoints.cspManifestSrc, patchOfficialCspManifestSrc],
    [staticPoints.historyTurnSignals, patchAppServerManagerSignalsChunk],
    [staticPoints.applicationMenu, patchApplicationMenuCapabilityCheck],
    [staticPoints.appServerRequestScheduling, patchAppServerRequestScheduling],
    [staticPoints.pluginImageLazyLoad, patchPluginSummaryImageInlining],
    [staticPoints.openInFolderLocale, patchOpenInFolderLocaleMessage],
    ...dynamicHtmlPoints.map((point) => [point, () => undefined]),
  ];
  let staticCapabilities = new Map(staticCapabilityEntries);
  try {
    staticCapabilities = modificationCoordinator.bindBatch(
      staticCapabilityEntries.map(([point, operation]) => ({
        point,
        operation,
        // 字符串补丁只有真实改变输出时才算命中；仅执行定位函数仍保持“已就绪”。
        hitWhen: (args, result) => args.length > 0 && result !== args[0],
      })),
    );
  } catch {
    // Kernel 自身不可用时仍执行原转换函数，保证接入前后的输出字节完全一致。
  }
  const capabilityFor = (point) => staticCapabilities.get(point);
  const patchHtmlLangCompatible = capabilityFor(staticPoints.htmlLang);
  const patchHtmlViewportCompatible = capabilityFor(staticPoints.htmlViewport);
  const patchHtmlIconsCompatible = capabilityFor(staticPoints.iconPwa);
  const patchHtmlAssetPathsCompatible = capabilityFor(staticPoints.assetPathMap);
  const patchHtmlFontPreloadsCompatible = capabilityFor(staticPoints.fontPreload);
  const patchOfficialAssetUrlsCompatible = capabilityFor(staticPoints.assetNamespace);
  const patchOfficialCspUnsafeEvalCompatible = capabilityFor(staticPoints.cspUnsafeEval);
  const patchOfficialCspManifestSrcCompatible = capabilityFor(staticPoints.cspManifestSrc);
  const patchHistorySignalsCompatible = capabilityFor(staticPoints.historyTurnSignals);
  const patchApplicationMenuCompatible = capabilityFor(staticPoints.applicationMenu);
  const patchRequestSchedulingCompatible = capabilityFor(staticPoints.appServerRequestScheduling);
  const patchPluginImageCompatible = capabilityFor(staticPoints.pluginImageLazyLoad);
  const patchOpenInFolderLocaleCompatible = capabilityFor(staticPoints.openInFolderLocale);

  function matchedPatchedOfficialPrefix(reqPath) {
    return patchedOfficialPrefixes.find((prefix) => reqPath.startsWith(prefix)) || "";
  }

  function patchedOfficialRelPath(reqPath) {
    const prefix = matchedPatchedOfficialPrefix(reqPath);
    return prefix ? reqPath.slice(prefix.length) : "";
  }

  function patchedOfficialAssetName(reqPath) {
    const prefix = matchedPatchedOfficialPrefix(reqPath);
    if (!prefix) return "";
    const assetPrefix = `${prefix}assets/`;
    return reqPath.startsWith(assetPrefix) ? reqPath.slice(assetPrefix.length) : "";
  }

  function touchPatchedAssetCacheEntry(key, entry) {
    patchedAssetCache.delete(key);
    patchedAssetCache.set(key, entry);
  }

  function evictPatchedAssetCache() {
    while (patchedAssetCacheBytes > effectivePatchedAssetCacheMaxBytes && patchedAssetCache.size > 1) {
      const oldestKey = patchedAssetCache.keys().next().value;
      const oldest = patchedAssetCache.get(oldestKey);
      patchedAssetCache.delete(oldestKey);
      patchedAssetCacheBytes -= oldest?.byteSize || 0;
    }
  }

  function patchedAssetVariant(reqPath, file, req) {
    const stat = fs.statSync(file);
    const loopback = isLoopbackHostHeader(req?.headers?.host);
    const locale = currentHostI18n();
    const remoteMessage = loopback ? "" : locale.messages?.[OPENCODEX_DOWNLOAD_FILE_MESSAGE_ID] || "Download file";
    // 实际输出只取决于 Host 类型和最终文案；语言标签本身不产生字节差异，避免为同文案复制大型 chunk。
    return {
      host: String(req?.headers?.host || ""),
      key: JSON.stringify([
        PATCHED_ASSET_PATCH_REVISION,
        reqPath,
        file,
        stat.dev,
        stat.ino,
        stat.size,
        stat.mtimeMs,
        loopback ? "loopback" : "remote",
        remoteMessage,
      ]),
      locale: locale.locale || "",
      remoteMessage,
      size: stat.size,
    };
  }

  function storePatchedAssetEntry(key, data, patched) {
    const entry = {
      byteSize: data.length,
      data,
      key,
      patched,
      representationPromises: new Map(),
      representations: new Map(),
    };
    patchedAssetCache.set(key, entry);
    patchedAssetCacheBytes += entry.byteSize;
    evictPatchedAssetCache();
    return entry;
  }

  function cachedPatchedAsset(reqPath, file, req) {
    const variant = patchedAssetVariant(reqPath, file, req);
    const { key } = variant;
    const cached = patchedAssetCache.get(key);
    if (cached) {
      patchedAssetCacheStats.hits += 1;
      touchPatchedAssetCacheEntry(key, cached);
      return cached;
    }
    const pending = patchedAssetBuildPromises.get(key);
    if (pending) {
      patchedAssetCacheStats.hits += 1;
      return pending;
    }

    patchedAssetCacheStats.misses += 1;
    if (variant.size < ASYNC_PATCH_MIN_BYTES) {
      const sourceData = fs.readFileSync(file);
      patchedAssetCacheStats.patchRuns += 1;
      const data = patchOfficialAsset(reqPath, sourceData, req, {
        downloadMessage: variant.remoteMessage,
      });
      return storePatchedAssetEntry(key, data, data !== sourceData);
    }

    // 大 chunk 的磁盘读取、UTF-8 解码和文本改写都移出请求主调用栈，避免阻塞 WS/心跳和其它资源。
    const build = fs.promises
      .readFile(file)
      .then(async (sourceData) => {
        patchedAssetCacheStats.patchRuns += 1;
        if (!officialAssetHasPatchCandidate(reqPath, sourceData, req)) {
          return storePatchedAssetEntry(key, sourceData, false);
        }
        try {
          const result = await patchOfficialAssetOffMainThread({
            data: sourceData,
            downloadMessage: variant.remoteMessage,
            host: variant.host,
            locale: variant.locale,
            reqPath,
          });
          return storePatchedAssetEntry(key, result.data, result.patched);
        } catch (error) {
          if (!hasWarnedPatchWorkerFailure) {
            hasWarnedPatchWorkerFailure = true;
            console.warn("[gateway] official asset patch worker unavailable; using main-thread fallback", error);
          }
          // postMessage 转移后源 Buffer 已失效；失败回退需重新异步读取，保证响应内容完全一致。
          const fallbackSourceData = await fs.promises.readFile(file);
          const data = patchOfficialAsset(reqPath, fallbackSourceData, req, {
            // Worker 失败期间语言设置可能已变化；仍按创建缓存键时的快照生成该条目。
            downloadMessage: variant.remoteMessage,
          });
          return storePatchedAssetEntry(key, data, data !== fallbackSourceData);
        }
      })
      .finally(() => {
        if (patchedAssetBuildPromises.get(key) === build) patchedAssetBuildPromises.delete(key);
      });
    patchedAssetBuildPromises.set(key, build);
    return build;
  }

  function acceptedEncodingQuality(req, name) {
    const values = String(req?.headers?.["accept-encoding"] || "")
      .split(",")
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean);
    let wildcardQuality = 0;
    for (const part of values) {
      const [token, ...parameters] = part.split(";").map((value) => value.trim());
      const qualityParameter = parameters.find((parameter) => parameter.startsWith("q="));
      const parsedQuality = qualityParameter ? Number(qualityParameter.slice(2)) : 1;
      const quality = Number.isFinite(parsedQuality) ? Math.min(1, Math.max(0, parsedQuality)) : 0;
      // 显式编码优先于通配符；例如“br;q=0, *”不能重新启用 br。
      if (token === name) return quality;
      if (token === "*") wildcardQuality = quality;
    }
    return wildcardQuality;
  }

  function representationEncoding(req, contentType, data) {
    if (process.env.CODEX_WEB_DISABLE_GZIP === "1" || data.length < 1024) return "identity";
    if (!/javascript|css|html|json|svg|wasm/i.test(contentType)) return "identity";
    const brotliQuality = acceptedEncodingQuality(req, "br");
    const gzipQuality = acceptedEncodingQuality(req, "gzip");
    if (brotliQuality > 0 && brotliQuality >= gzipQuality) return "br";
    if (gzipQuality > 0) return "gzip";
    return "identity";
  }

  function compressRepresentation(data, encoding) {
    return new Promise((resolve, reject) => {
      const done = (error, body) => {
        if (error) reject(error);
        else resolve(body);
      };
      if (encoding === "br") {
        // 使用异步 zlib，把大型官方 chunk 的冷启动压缩移出 Node 主事件循环。
        zlib.brotliCompress(
          data,
          // 质量 6 对当前主包比质量 4 再缩小约 8%，启动预热会吸收一次性压缩成本。
          { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 6 } },
          done
        );
        return;
      }
      zlib.gzip(data, done);
    });
  }

  function storeRepresentation(entry, encoding, body) {
    const digest = crypto.createHash("sha256").update(body).digest("base64url");
    const representation = { body, etag: `"${digest}"` };
    entry.representations.set(encoding, representation);
    if (encoding === "identity" || patchedAssetCache.get(entry.key) !== entry) return representation;

    entry.byteSize += body.length;
    patchedAssetCacheBytes += body.length;
    touchPatchedAssetCacheEntry(entry.key, entry);
    evictPatchedAssetCache();
    return representation;
  }

  function cachedRepresentation(entry, encoding) {
    const cached = entry.representations.get(encoding);
    if (cached) return cached;

    if (encoding === "identity") return storeRepresentation(entry, encoding, entry.data);

    const pending = entry.representationPromises.get(encoding);
    if (pending) return pending;

    // 同一冷资源的并发请求共享一次压缩任务，避免瞬时重复占满 libuv 线程池。
    const compression = compressRepresentation(entry.data, encoding)
      .then((body) => {
        patchedAssetCacheStats.compressionRuns += 1;
        return storeRepresentation(entry, encoding, body);
      })
      .finally(() => {
        if (entry.representationPromises.get(encoding) === compression) {
          entry.representationPromises.delete(encoding);
        }
      });
    entry.representationPromises.set(encoding, compression);
    return compression;
  }

  function requestHasMatchingEtag(req, etag) {
    return String(req?.headers?.["if-none-match"] || "")
      .split(",")
      .map((value) => value.trim())
      .some((value) => value === "*" || value === etag || value === `W/${etag}`);
  }

  function assetCacheDiagnostics() {
    return {
      ...patchedAssetCacheStats,
      bytes: patchedAssetCacheBytes,
      entries: patchedAssetCache.size,
      maxBytes: effectivePatchedAssetCacheMaxBytes,
    };
  }

  function canBundleRuntimeBootstrap(entries = listPluginEntries()) {
    // 外部插件可能依赖 document.currentScript；发现外部入口时保留逐文件加载语义，不擅自内联。
    return entries.every((entry) => !entry.entryFile || entry.sourceId === "builtin");
  }

  function pluginGatewayStateBootstrapScript() {
    // 这段逻辑同时用于聚合运行时和外部插件兼容 loader，保证两条加载路径的网关开关语义一致。
    return `  const pendingStorageKey = "opencodex_gateway_plugin_enable_pending_v1";
  let pending = {};
  try {
    const parsed = JSON.parse(localStorage.getItem(pendingStorageKey) || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) pending = parsed;
  } catch {}
  const gatewayConfig = window.__CODEX_WEB_CONFIG__?.gatewayPluginConfig;
  if (gatewayConfig && Object.keys(pending).length > 0) {
    try { document.cookie = "opencodex_gateway_plugin_sync_pending=1; Path=/; SameSite=Lax"; } catch {}
    // 兼容升级前遗留的待提交操作：只发生一次重载，随后服务端回到原登录壳并沿用既有同步流程。
    location.reload();
    return;
  }
  if (pluginSystem?.plugins && Array.isArray(gatewayConfig?.plugins)) {
    const gatewayManifestIds = new Set(
      manifests.filter((manifest) => manifest?.persistence === "gateway").map((manifest) => String(manifest.id || ""))
    );
    for (const plugin of gatewayConfig.plugins) {
      if (gatewayManifestIds.has(String(plugin?.id || "")) && typeof plugin?.enabled === "boolean") {
        // 在任何插件入口执行前写入权威开关，保持多设备和重启后的 renderer 状态一致。
        if (pluginSystem.plugins.isEnabled?.(plugin.id) !== plugin.enabled) {
          pluginSystem.plugins.setEnabled(plugin.id, plugin.enabled);
        }
      }
    }
  }`;
  }

  function runtimeBootstrapFileGroups(entries) {
    return {
      beforePlugins: [
        WEB_SHELL_STATIC_FILES.get(OPENCODEX_MODIFICATION_RUNTIME_PATH),
        WEB_SHELL_STATIC_FILES.get(OPENCODEX_RUNTIME_COMPATIBILITY_PATH),
        WEB_SHELL_STATIC_FILES.get(OPENCODEX_SIDEBAR_PREVIEW_PATH),
        WEB_SHELL_STATIC_FILES.get(OPENCODEX_OFFSCREEN_ANIMATION_GUARD_PATH),
        WEB_SHELL_STATIC_FILES.get(OPENCODEX_PLUGIN_SYSTEM_PATH),
      ],
      afterPlugins: [
        ...BUILTIN_PROVIDER_FILES.keys(),
        CODEX_SMART_SCHEDULING_INJECTION_HEALTH_PATH,
        CODEX_SMART_MODEL_ROUTER_SETTINGS_PATH,
        CODEX_SMART_MODEL_ROUTER_COMPOSER_PATH,
        CODEX_SMART_SCHEDULING_SUMMARY_PATH,
        OPENCODEX_TOKEN_USAGE_CAPABILITY_PATH,
        OPENCODEX_WINDOW_CONTROLS_OVERLAY_PATH,
        CODEX_APP_HOST_MESSAGE_CODEC_PATH,
        CODEX_BRIDGE_POLYFILL_PATH,
        CODEX_REMOTE_FILE_ACTIONS_PATH,
        CODEX_WORKSPACE_ROOT_PICKER_PATH,
        CODEX_TOOLTIP_DISMISS_GUARD_PATH,
        OPENCODEX_MODIFICATION_ACTIVATE_PATH,
      ].map((reqPath) => WEB_SHELL_STATIC_FILES.get(reqPath)),
    };
  }

  function runtimeBootstrapFingerprint(entries, groups) {
    const files = [...groups.beforePlugins, ...groups.afterPlugins];
    const fileIdentities = files.map((file) => {
      try {
        const stat = fs.statSync(file);
        return [file, stat.dev, stat.ino, stat.size, stat.mtimeMs];
      } catch {
        return [file, "missing"];
      }
    });
    // 插件 version 已覆盖入口、manifest 与 i18n；固定脚本再按文件身份判断，未变化时不重读和散列正文。
    return JSON.stringify({
      files: fileIdentities,
      plugins: entries.map((entry) => [entry.sourceId, entry.name, entry.version]),
    });
  }

  function createRuntimeBootstrapScript(entries, groups) {
    // 每段脚本都用分号隔开，避免前一文件的尾部表达式与后一文件 IIFE 发生自动分号插入歧义。
    return [
      ...groups.beforePlugins.map(readRuntimeBootstrapFile),
      // 聚合启动路径也必须使用 v2 ESM loader；不能把 export 语法当普通脚本拼进 IIFE。
      createPluginLoaderScript(entries),
      ...groups.afterPlugins.map(readRuntimeBootstrapFile),
    ].join("\n;\n");
  }

  function wrapBrowserProviderSource(file, source) {
    const providerKey = BROWSER_PROVIDER_KEY_BY_FILE.get(file);
    if (!providerKey) return source;
    return `window.__OpenCodexAdapterHost.providers.register(${JSON.stringify(providerKey)},()=>{\n${source}\n});`;
  }

  function readRuntimeBootstrapFile(file) {
    return wrapBrowserProviderSource(file, readText(file));
  }

  function runtimeBootstrapEntry() {
    const entries = listPluginEntries();
    const groups = runtimeBootstrapFileGroups(entries);
    const fingerprint = runtimeBootstrapFingerprint(entries, groups);
    if (runtimeBootstrapCache?.fingerprint === fingerprint) return runtimeBootstrapCache;
    const source = Buffer.from(createRuntimeBootstrapScript(entries, groups), "utf-8");
    // 文件身份未变化时复用正文、散列和压缩体，避免每次刷新都重读整套浏览器运行时。
    runtimeBootstrapCache = {
      // gzip 与 identity 字节不同但语义相同，用弱校验器配合 Vary，避免跨编码误用强 ETag。
      etag: `W/"${crypto.createHash("sha256").update(source).digest("base64url")}"`,
      fingerprint,
      representations: new Map([["identity", source]]),
      source,
    };
    return runtimeBootstrapCache;
  }

  function runtimeBootstrapRepresentation(req, entry) {
    const brotliQuality = acceptedEncodingQuality(req, "br");
    const gzipQuality = acceptedEncodingQuality(req, "gzip");
    const encoding =
      process.env.CODEX_WEB_DISABLE_GZIP === "1"
        ? "identity"
        : brotliQuality > 0 && brotliQuality >= gzipQuality
          ? "br"
          : gzipQuality > 0
            ? "gzip"
            : "identity";
    let body = entry.representations.get(encoding);
    if (!body) {
      body =
        encoding === "br"
          ? zlib.brotliCompressSync(entry.source, {
              // 运行时脚本不到 0.5MB，质量 4 在很低启动成本下即可比 gzip 再缩小约 13%。
              params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 },
            })
          : zlib.gzipSync(entry.source);
      entry.representations.set(encoding, body);
    }
    return { body, encoding };
  }

  function startupAssetPreloads(rawHtml) {
    const urls = new Set();
    for (const match of rawHtml.matchAll(/<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)) {
      urls.add(match[1]);
    }
    for (const match of rawHtml.matchAll(/<link\b(?=[^>]*\brel=["']modulepreload["'])[^>]*\bhref=["']([^"']+)["'][^>]*>/gi)) {
      urls.add(match[1]);
    }
    const modulePreloads = Array.from(urls, (href) =>
      `<link rel="modulepreload" crossorigin href="${escapeHtml(href)}">`
    );
    const stylePreloads = Array.from(
      rawHtml.matchAll(/<link\b(?=[^>]*\brel=["']stylesheet["'])[^>]*\bhref=["']([^"']+)["'][^>]*>/gi),
      (match) => {
        const crossorigin = match[0].match(/\bcrossorigin(?:\s*=\s*["']([^"']*)["'])?/i);
        const crossoriginAttribute = crossorigin
          ? ` crossorigin${crossorigin[1] ? `="${escapeHtml(crossorigin[1])}"` : ""}`
          : "";
        // preload 与最终 stylesheet 必须使用同一 CORS 模式，否则 Chromium 会把同一主 CSS 下载两次。
        return `<link rel="preload" as="style"${crossoriginAttribute} href="${escapeHtml(match[1])}">`;
      }
    );
    // 注入脚本位于原始 modulepreload 之前；复制轻量 preload 提示可让大主包与动态配置并行下载。
    return [...modulePreloads, ...stylePreloads].join("\n    ");
  }

  function lateLocaleModuleHref(locale) {
    const normalizedLocale = String(locale || "").trim();
    if (!normalizedLocale) return "";
    const localeAsset = officialAssetFileNames().find(
      (fileName) => fileName.startsWith(`${normalizedLocale}-`) && fileName.endsWith(".js")
    );
    return localeAsset ? `${PATCHED_OFFICIAL_PREFIX}assets/${localeAsset}` : "";
  }

  function lateStartupModuleHrefs(locale) {
    const officialBundle = getOfficialBundle();
    const fileNames = officialAssetFileNames(officialBundle);
    const hrefs = [lateLocaleModuleHref(locale)];
    if (officialBundle?.webviewDir) {
      let selectedFileNames = officialAssetFileNamesCache?.lateStartupModuleFileNames;
      if (!selectedFileNames) {
        selectedFileNames = [];
        for (const prefix of LATE_STARTUP_MODULE_PREFIXES) {
          const candidates = fileNames
            .filter((fileName) => fileName.startsWith(prefix) && fileName.endsWith(".js"))
            .map((fileName) => {
              try {
                return {
                  fileName,
                  size: fs.statSync(path.join(officialBundle.webviewDir, "assets", fileName)).size,
                };
              } catch {
                // 官方缓存切换期间文件可能刚好被替换；忽略失效索引，不能让整个 renderer HTML 返回 500。
                return null;
              }
            })
            .filter(Boolean)
            .sort((left, right) => left.size - right.size || left.fileName.localeCompare(right.fileName));
          /**
           * 官方构建会给部分懒模块生成一个很小的 re-export 入口；预载最小入口即可让浏览器递归发现
           * 它的静态依赖，避免同时给几十个 chunk 注入高优先级提示。
           */
          if (candidates[0]) selectedFileNames.push(candidates[0].fileName);
        }
        // 官方资源目录在当前 gateway 生命周期内只读；复用选择结果，避免每次导航重复 stat 候选 chunk。
        if (officialAssetFileNamesCache) {
          officialAssetFileNamesCache.lateStartupModuleFileNames = selectedFileNames;
        }
      }
      hrefs.push(...selectedFileNames.map((fileName) => `${PATCHED_OFFICIAL_PREFIX}assets/${fileName}`));
    }
    return Array.from(new Set(hrefs.filter(Boolean)));
  }

  function sidebarPreviewMarkup(snapshot, locale) {
    const threads = Array.isArray(snapshot?.threads) ? snapshot.threads.slice(0, 12) : [];
    if (threads.length === 0) return "";
    const chinese = String(locale || "").toLowerCase().startsWith("zh");
    const recentLabel = chinese ? "最近" : "Recent";
    const newThreadLabel = chinese ? "新对话" : "New thread";
    const fallbackTitle = chinese ? "未命名会话" : "Untitled conversation";
    const rows = threads
      .map((thread) => {
        const id = escapeHtml(String(thread?.id || ""));
        const title = escapeHtml(String(thread?.title || fallbackTitle));
        return `<button type="button" data-opencodex-sidebar-preview-row data-opencodex-thread-id="${id}" title="${title}"><span>${title}</span></button>`;
      })
      .join("");
    return `<aside id="opencodex-sidebar-preview" aria-label="${recentLabel}" aria-busy="true" data-opencodex-sidebar-preview-ready>
      <div class="opencodex-sidebar-preview__toolbar"><span class="opencodex-sidebar-preview__window">▣</span><span>←</span><span>→</span></div>
      <div class="opencodex-sidebar-preview__brand">Codex <span>⌄</span></div>
      <div class="opencodex-sidebar-preview__new"><span>⌑</span>${newThreadLabel}</div>
      <div class="opencodex-sidebar-preview__section">${recentLabel}</div>
      <div class="opencodex-sidebar-preview__rows">${rows}</div>
    </aside>`;
  }

  function sidebarPreviewStyles() {
    return `<style id="opencodex-sidebar-preview-styles">
      #opencodex-sidebar-preview{position:fixed;inset:0 auto 0 0;z-index:30;box-sizing:border-box;width:276px;overflow:hidden;border-right:1px solid rgba(26,28,31,.09);background:#fafafa;color:#242424;font:14px/20px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
      #opencodex-sidebar-preview button{font:inherit;color:inherit}
      .opencodex-sidebar-preview__toolbar{display:flex;height:46px;align-items:center;gap:20px;padding:0 18px;color:#a0a0a0}
      .opencodex-sidebar-preview__window{margin-left:76px}
      .opencodex-sidebar-preview__brand{display:flex;align-items:center;gap:5px;padding:4px 17px 12px;font-size:17px;font-weight:600}
      .opencodex-sidebar-preview__brand span{font-size:13px;font-weight:400;color:#777}
      .opencodex-sidebar-preview__new{display:flex;align-items:center;gap:9px;padding:8px 18px;font-weight:500}
      .opencodex-sidebar-preview__section{padding:24px 17px 8px;color:#929292;font-size:13px}
      .opencodex-sidebar-preview__rows{padding:0 8px}
      #opencodex-sidebar-preview [data-opencodex-sidebar-preview-row]{display:block;box-sizing:border-box;width:100%;height:30px;overflow:hidden;border:0;border-radius:7px;background:transparent;padding:5px 10px 5px 32px;text-align:left;white-space:nowrap;text-overflow:ellipsis;cursor:pointer}
      #opencodex-sidebar-preview [data-opencodex-sidebar-preview-row]:hover,#opencodex-sidebar-preview [data-opencodex-sidebar-preview-row][aria-busy="true"]{background:rgba(0,0,0,.045)}
      #opencodex-sidebar-preview [data-opencodex-sidebar-preview-row] span{display:block;overflow:hidden;text-overflow:ellipsis}
      #opencodex-sidebar-preview+#root .startup-loader{box-sizing:border-box;padding-left:276px}
      @media(max-width:719px){#opencodex-sidebar-preview{display:none}#opencodex-sidebar-preview+#root .startup-loader{padding-left:0}}
      @media(prefers-color-scheme:dark){:root:not(.electron-light) #opencodex-sidebar-preview{border-color:rgba(255,255,255,.1);background:#171717;color:#ececec}:root:not(.electron-light) #opencodex-sidebar-preview [data-opencodex-sidebar-preview-row]:hover{background:rgba(255,255,255,.07)}}
    </style>`;
  }

  /** 给官方 renderer HTML 注入 web-shell polyfill 和运行时配置。 */
  function transformOfficialHtml(rawHtml, options = {}) {
    /**
     * 官方 index.html 原本跑在 Electron app:///file 环境。
     * 浏览器环境需要额外注入：
     * - base href，把官方相对资源定位到 /official/。
     * - codex-web-config.js，提供端口、workspace roots 等运行时信息。
     * - opencodex-plugin-system.js，提供插件 host。
     * - opencodex-plugin-loader.js，按目录扫描结果加载插件脚本。
     * - manifest/移动 Web App 元数据，允许入口安装为独立窗口壳。
     * - bridge polyfill，把 Electron API 转成 HTTP/WS 调用。
     */
    let html = rawHtml;
    const i18n = currentI18n();
    // 官方 HTML 是 Electron renderer 用的，浏览器里需要补 locale、移动端 viewport 和站点图标。
    html = patchHtmlLangCompatible(html, i18n.locale);
    html = patchHtmlViewportCompatible(html);
    html = patchHtmlIconsCompatible(html);
    html = patchHtmlAssetPathsCompatible(html);
    html = patchHtmlFontPreloadsCompatible(html);
    const startupPreloads = startupAssetPreloads(html);
    const lateModuleHrefs = lateStartupModuleHrefs(i18n.locale);
    const previewMarkup = sidebarPreviewMarkup(options.sidebarPreview, i18n.locale);
    if (startupPreloads) hitCompatibilityPoint(staticPoints.startupPreload);
    if (previewMarkup) hitCompatibilityPoint(staticPoints.sidebarPreview);
    const useRuntimeBundle = canBundleRuntimeBootstrap();
    const runtimeScripts = useRuntimeBundle
      ? [
          '<link rel="preload" as="script" href="/codex-web-config.js">',
          `<link rel="preload" as="script" href="${OPENCODEX_RUNTIME_BOOTSTRAP_PATH}">`,
          '<script defer src="/codex-web-config.js"></script>',
          `<script defer src="${OPENCODEX_RUNTIME_BOOTSTRAP_PATH}"></script>`,
        ]
      : [
          '<script defer src="/codex-web-config.js"></script>',
          `<script defer src="${OPENCODEX_MODIFICATION_RUNTIME_PATH}"></script>`,
          `<script defer src="${OPENCODEX_RUNTIME_COMPATIBILITY_PATH}"></script>`,
          `<script defer src="${OPENCODEX_SIDEBAR_PREVIEW_PATH}"></script>`,
          `<script defer src="${OPENCODEX_OFFSCREEN_ANIMATION_GUARD_PATH}"></script>`,
          `<script defer src="${OPENCODEX_PLUGIN_SYSTEM_PATH}"></script>`,
          `<script defer src="${OPENCODEX_PLUGIN_LOADER_PATH}"></script>`,
          ...[...BUILTIN_PROVIDER_FILES.keys()].map((url) => `<script defer src="${url}"></script>`),
          `<script defer src="${CODEX_SMART_SCHEDULING_INJECTION_HEALTH_PATH}"></script>`,
          `<script defer src="${CODEX_SMART_MODEL_ROUTER_SETTINGS_PATH}"></script>`,
          `<script defer src="${CODEX_SMART_MODEL_ROUTER_COMPOSER_PATH}"></script>`,
          `<script defer src="${CODEX_SMART_SCHEDULING_SUMMARY_PATH}"></script>`,
          `<script defer src="${OPENCODEX_TOKEN_USAGE_CAPABILITY_PATH}"></script>`,
          `<script defer src="${OPENCODEX_WINDOW_CONTROLS_OVERLAY_PATH}"></script>`,
          // codec 先于 bridge 执行，确保新版 AppHost 的首批结构化帧可以立即编码。
          `<script defer src="${CODEX_APP_HOST_MESSAGE_CODEC_PATH}"></script>`,
          `<script defer src="${CODEX_BRIDGE_POLYFILL_PATH}"></script>`,
          `<script defer src="${CODEX_REMOTE_FILE_ACTIONS_PATH}"></script>`,
          `<script defer src="${CODEX_WORKSPACE_ROOT_PICKER_PATH}"></script>`,
          `<script defer src="${CODEX_TOOLTIP_DISMISS_GUARD_PATH}"></script>`,
          `<script defer src="${OPENCODEX_MODIFICATION_ACTIVATE_PATH}"></script>`,
        ];
    // manifest 在 Cloudflare Access 等前置认证后面也必须带同源凭据，否则 Chrome 可能拿不到受保护的 manifest。
    const base = [
      '<base href="/official/">',
      startupPreloads,
      `<link rel="manifest" href="${PWA_MANIFEST_PATH}" crossorigin="use-credentials">`,
      '<meta name="theme-color" content="#ffffff">',
      '<meta name="application-name" content="OpenCodex">',
      '<meta name="mobile-web-app-capable" content="yes">',
      '<meta name="apple-mobile-web-app-title" content="OpenCodex">',
      '<meta name="apple-mobile-web-app-capable" content="yes">',
      '<meta name="apple-mobile-web-app-status-bar-style" content="default">',
      lateModuleHrefs
        .map((href) => `<meta name="opencodex-late-modulepreload" content="${escapeHtml(href)}">`)
        .join("\n    "),
      OFFICIAL_LOADING_SHIMMER_POWER_GUARD,
      previewMarkup ? sidebarPreviewStyles() : "",
      `<link id="codex-smart-model-router-settings-styles" rel="stylesheet" href="${CODEX_SMART_MODEL_ROUTER_SETTINGS_CSS_PATH}">`,
      `<link id="codex-smart-scheduling-summary-styles" rel="stylesheet" href="${CODEX_SMART_SCHEDULING_SUMMARY_CSS_PATH}">`,
      `<link id="codex-web-workspace-root-picker-styles" rel="stylesheet" href="${CODEX_WORKSPACE_ROOT_PICKER_CSS_PATH}">`,
      ...runtimeScripts,
    ].join("\n    ");
    if (/<head[^>]*>/i.test(html)) {
      html = html.replace(/<head([^>]*)>/i, `<head$1>\n    ${base}`);
      hitCompatibilityPoint(staticPoints.runtimeBootstrap);
      hitCompatibilityPoint(staticPoints.loadingAnimation);
    }
    if (previewMarkup && /<body[^>]*>/i.test(html)) {
      // aside 与 #root 保持相邻，加载期 CSS 才能把官方 Logo 居中到主内容区域。
      html = html.replace(/<body([^>]*)>/i, `<body$1>\n    ${previewMarkup}`);
    }
    return patchOfficialHtmlForWeb(html);
  }

  /** 给少量运行时 patch 过的官方 chunk 换路径命名空间，绕开浏览器 immutable 缓存。 */
  function patchOfficialAssetUrls(rawHtml) {
    // JS 的相对导入会把 CSS 也落到 patched 命名空间；HTML 同步改写 CSS，避免同一文件下载两次。
    return rawHtml.replace(
      /((?:src|href)=["']\/official\/assets\/[^"'?#]+\.(?:js|css))(["'])/g,
      (_match, prefix, quote) => `${prefix.replace("/official/assets/", `${PATCHED_OFFICIAL_PREFIX}assets/`)}${quote}`
    );
  }

  /** desktop HTML 的 CSP 会拦截浏览器里部分依赖的 Function/eval 探测，需要在 gateway 层放开。 */
  function patchOfficialCspForWeb(rawHtml) {
    const html = patchOfficialCspUnsafeEvalCompatible(rawHtml);
    return patchOfficialCspManifestSrcCompatible(html);
  }

  function patchOfficialCspUnsafeEval(rawHtml) {
    let html = rawHtml;
    if (!html.includes("&#39;unsafe-eval&#39;") && !html.includes("'unsafe-eval'")) {
      html = html
        .replace("&#39;wasm-unsafe-eval&#39;", "&#39;wasm-unsafe-eval&#39; &#39;unsafe-eval&#39;")
        .replace("'wasm-unsafe-eval'", "'wasm-unsafe-eval' 'unsafe-eval'");
    }
    return html;
  }

  function patchOfficialCspManifestSrc(rawHtml) {
    const cspMetaPattern =
      /(<meta\b(?=[^>]*\bhttp-equiv=["']Content-Security-Policy["'])(?=[^>]*\bcontent=(["']))[^>]*\bcontent=\2)([\s\S]*?)(\2[^>]*>)/i;
    return rawHtml.replace(cspMetaPattern, (match, start, _quote, content, end) => {
      if (/\bmanifest-src\b/i.test(content)) return match;
      const trimmedContent = content.trimEnd();
      const trailingWhitespace = content.slice(trimmedContent.length);
      const separator = trimmedContent.endsWith(";") ? " " : "; ";
      const selfSource = content.includes("&#39;") ? "&#39;self&#39;" : "'self'";
      // 官方 CSP 默认 default-src 'none'，必须显式允许 manifest，否则 Chrome 会把 PWA 视为 no-manifest。
      return `${start}${trimmedContent}${separator}manifest-src ${selfSource};${trailingWhitespace}${end}`;
    });
  }

  function patchOfficialHtmlForWeb(rawHtml) {
    return patchOfficialCspForWeb(patchOfficialAssetUrlsCompatible(rawHtml));
  }

  function locateOfficialIndex() {
    // getOfficialBundle 由 runtime 层提供，便于资源层保持无状态并支持后续热替换缓存。
    const officialBundle = getOfficialBundle();
    if (!officialBundle || !officialBundle.webviewDir) return null;
    const srcIndex = path.join(officialBundle.webviewDir, "index.html");
    if (exists(srcIndex)) return { kind: "source", file: srcIndex };
    return null;
  }

  function locateOfficialAsset(filePath) {
    const officialBundle = getOfficialBundle();
    if (!officialBundle || !officialBundle.webviewDir) return null;
    const candidate = path.normalize(path.join(officialBundle.webviewDir, filePath));
    if (!exists(candidate)) return null;
    // URL path 必须落在官方 webview 根目录内，防止 /official/../../ 读取任意文件。
    return isWithinRoot(candidate, officialBundle.webviewDir) ? candidate : null;
  }

  function locateOfficialStyleAssetHref(prefix) {
    // 官方 CSS 带 hash，不能写死文件名，只能按构建稳定前缀查找当前缓存中的实际文件。
    const officialBundle = getOfficialBundle();
    if (!officialBundle || !officialBundle.webviewDir) return null;
    const fileName = officialAssetFileNames(officialBundle)
      .filter((entry) => entry.startsWith(prefix) && entry.endsWith(".css"))
      .sort()[0];
    return fileName ? `/official/assets/${fileName}` : null;
  }

  function officialAssetFileNames(officialBundle = getOfficialBundle()) {
    if (!officialBundle || !officialBundle.webviewDir) return [];
    if (officialAssetFileNamesCache?.webviewDir === officialBundle.webviewDir) {
      return officialAssetFileNamesCache.fileNames;
    }
    const assetsDir = path.join(officialBundle.webviewDir, "assets");
    const fileNames = exists(assetsDir) ? fs.readdirSync(assetsDir) : [];
    // 单个 runtime 的官方资源目录只读；缓存目录索引，避免每次打开页面重复扫描数百个文件。
    officialAssetFileNamesCache = { fileNames, webviewDir: officialBundle.webviewDir };
    return fileNames;
  }

  function officialStyleLinks() {
    return ["app-main-", "app-shell-"]
      .map(locateOfficialStyleAssetHref)
      .filter(Boolean)
      .map((href) => `<link rel="stylesheet" href="${href}" data-codex-official-style />`)
      .join("\n    ");
  }

  function currentHostI18n() {
    const snapshot = typeof getI18nSnapshot === "function"
      ? getI18nSnapshot()
      : { locale: "en-US", messages: {} };
    return snapshot && typeof snapshot === "object"
      ? snapshot
      : { locale: "en-US", messages: {} };
  }

  function currentI18n() {
    // HTML/配置需要合并插件语言包；静态 chunk 的缓存键只消费宿主下载文案，避免每个资源重复扫描插件目录。
    return withPluginI18nMessages(currentHostI18n());
  }

  function patchHtmlLang(rawHtml, locale) {
    let html = rawHtml.replace(/<html([^>]*)\blang=["'][^"']*["']([^>]*)>/i, `<html$1lang="${locale}"$2>`);
    if (!/<html[^>]*\blang=/i.test(html)) {
      html = html.replace(/<html([^>]*)>/i, `<html$1 lang="${locale}">`);
    }
    return html;
  }

  function patchHtmlViewport(rawHtml) {
    return rawHtml.replace(
      /<meta([^>]*\bname=["']viewport["'][^>]*)>/i,
      '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover, interactive-widget=resizes-content" />'
    );
  }

  function patchHtmlIcons(rawHtml) {
    if (/<link[^>]+\brel=["'][^"']*icon/i.test(rawHtml)) return rawHtml;
    const iconLinks = [
      '<link rel="icon" type="image/png" sizes="192x192" href="/assets/pwa-icon-192.png" />',
      '<link rel="apple-touch-icon" href="/assets/pwa-icon-192.png" />',
    ].join("\n    ");
    return rawHtml.replace(/<title>/i, `${iconLinks}\n    <title>`);
  }

  function patchHtmlAssetPaths(rawHtml) {
    // 官方产物里的相对路径统一映射到 /official/，避免和 web-shell 自己的 /assets 冲突。
    return rawHtml
      .replace(/(src|href)=["']\/(?!(?:official|assets)\/)([^"'#?]+)["']/g, '$1="/official/$2"')
      .replace(/(src|href)=["']\.\/([^"'#?]+)["']/g, '$1="/official/$2"');
  }

  function patchHtmlFontPreloads(rawHtml) {
    return rawHtml.replace(/<link\b[^>]*>/gi, (tag) => {
      const isFontPreload =
        /\brel=["'][^"']*\bpreload\b[^"']*["']/i.test(tag) &&
        /\bas=["']font["']/i.test(tag);
      /**
       * 官方主 CSS 由运行时动态加载；Chromium 无法复用 HTML 阶段的字体预载，
       * 因此让字体跟随真实 CSS 使用加载，避免同一资源请求两次。
       */
      return isFontPreload ? "" : tag;
    });
  }

  function webShellBootstrapScript(i18n) {
    const publicConfig = {
      locale: i18n.locale,
      localeSource: i18n.source || "",
      localeMode: i18n.mode || "",
      messages: i18n.messages,
    };
    return `<script>window.__CODEX_WEB_CONFIG__=Object.assign(window.__CODEX_WEB_CONFIG__||{},${JSON.stringify(publicConfig)});</script>`;
  }

  function escapeHtml(value) {
    // 版本号来自同步脚本生成的静态文件，这里仍做 HTML 转义，避免未来格式扩展时污染登录页。
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function patchWebShellAppVersion(rawHtml) {
    // 认证入口必须展示 OpenCodex 自身版本，不能使用官方 Codex runtime 的版本。
    return rawHtml.replace(
      /(<span\b[^>]*\bdata-opencodex-version\b[^>]*>)([\s\S]*?)(<\/span>)/i,
      (_match, start, _content, end) => `${start}${escapeHtml(OPENCODEX_VERSION_LABEL)}${end}`
    );
  }

  function createPluginLoaderScript(entries = listPluginEntries()) {
    const manifests = entries.map((entry) => entry.manifest).filter(Boolean);
    const executablePlugins = entries
      .filter((entry) => entry.entryFile && entry.urlPath)
      .map((entry) => ({
        manifest: entry.manifest,
        url: `${OPENCODEX_PLUGIN_URL_PREFIX}${entry.urlPath}?v=${entry.version}`,
      }));
    return `(() => {
  const manifests = ${JSON.stringify(manifests)};
  const executablePlugins = ${JSON.stringify(executablePlugins)};
  // 声明式插件先注册元信息；它没有可执行入口，核心能力只由 gateway 的受信 feature 注册表绑定。
  const pluginSystem = window.OpenCodexPluginSystem || window.__OpenCodexPluginSystem;
  if (pluginSystem && typeof pluginSystem.registerPlugin === "function") {
    for (const manifest of manifests) pluginSystem.registerPlugin(manifest);
  }
${pluginGatewayStateBootstrapScript()}
  // v2 插件以 ESM 工厂接收宿主 SDK；模块加载失败只禁用该插件，不阻断登录壳或官方 Renderer。
  async function loadPlugin(entry) {
    try {
      const module = await import(entry.url);
      if (typeof module.default !== "function") throw new TypeError("Plugin default export must be a factory");
      const sdkRoot = window.OpenCodexPluginSdk;
      if (!sdkRoot || sdkRoot.apiVersion !== 2 || typeof sdkRoot.createPluginScope !== "function") {
        throw new TypeError("OpenCodex plugin SDK v2 is unavailable");
      }
      const sdk = sdkRoot.createPluginScope(entry.manifest);
      await module.default(sdk);
      sdk.commit();
    } catch (error) {
      console.warn("[opencodex-plugin] ESM plugin load failed", entry.url, error);
    }
  }
  for (const entry of executablePlugins) void loadPlugin(entry);
})();\n`;
  }

  function createWebShellIndexResponse() {
    const shell = path.join(WEB_SHELL_DIR, "index.html");
    const i18n = currentI18n();
    let html = patchWebShellAppVersion(patchHtmlLang(readText(shell), i18n.locale));
    const links = officialStyleLinks();
    if (links) {
      // web-shell 自己负责承载 UI，注入官方样式后视觉表现和桌面 renderer 保持一致。
      if (html.includes("<!-- codex-official-styles -->")) {
        html = html.replace("<!-- codex-official-styles -->", links);
      } else {
        html = html.replace(/<\/head>/i, `${links}\n  </head>`);
      }
    }
    const bootstrap = webShellBootstrapScript(i18n);
    if (html.includes("<!-- opencodex-runtime-config -->")) {
      html = html.replace("<!-- opencodex-runtime-config -->", bootstrap);
    } else {
      html = html.replace(/<\/head>/i, `    ${bootstrap}\n  </head>`);
    }
    return html;
  }

  function isPublicStaticPath(reqPath) {
    // 登录前必须可访问的资源限定在入口依赖和官方静态 asset，不包含任何 API。
    if (WEB_SHELL_STATIC_FILES.has(reqPath) || reqPath.startsWith(WEB_SHELL_ASSETS_PREFIX)) return true;
    if (reqPath === OPENCODEX_PLUGIN_LOADER_PATH) return true;
    if (matchedPatchedOfficialPrefix(reqPath)) return true;
    if (reqPath.startsWith(OPENCODEX_PLUGIN_URL_PREFIX)) return true;
    return reqPath.startsWith("/official/");
  }

  function createRendererResponse(options = {}) {
    // 已认证页面直接返回最终 renderer，避免 web-shell 再 fetch 并重写整份文档。
    const located = locateOfficialIndex();
    if (!located) return null;
    const html = readText(located.file);
    return transformOfficialHtml(html, options);
  }

  /** 判断是否应该回退到 SPA shell；刷新 /local/:id 这类官方前端路由时不能返回 404。 */
  function isAppShellRoute(req, pathname) {
    if (req.method !== "GET" && req.method !== "HEAD") return false;
    if (pathname.startsWith("/api/") || pathname === "/ws") return false;
    if (pathname === "/" || pathname === "") return true;
    if (path.extname(pathname)) return false;
    const accept = String(req.headers.accept || "");
    return !accept || accept.includes("text/html") || accept.includes("*/*");
  }

  /** 所有响应期 patch 过的官方 JS 统一从独立路径命名空间加载，避免和官方 immutable 缓存混用。 */
  function shouldPatchOfficialAsset(reqPath) {
    const rel = patchedOfficialAssetName(reqPath);
    if (!rel) return false;
    // 只 patch 当前官方 assets 目录下的 JS chunk，避免路径拼接穿透到子目录或非脚本资源。
    return rel.endsWith(".js") && !rel.includes("/");
  }

  /** 恢复历史 turn 时旧 renderer 转换漏了 firstTurnWorkItemStartedAtMs，导致折叠摘要退回“上 x 条消息”。 */
  function patchAppServerManagerSignalsChunk(source) {
    /**
     * 这是针对官方 chunk 的最小文本 patch：
     * 只修复历史 turn 缺少 firstTurnWorkItemStartedAtMs 的字段映射，不落盘修改官方缓存。
     */
    const alreadyPatched =
      /turnStartedAtMs:([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\.startedAt\),durationMs:\2\.durationMs,firstTurnWorkItemStartedAtMs:\1\(\2\.firstTurnWorkItemStartedAt\?\?\2\.startedAt\),finalAssistantStartedAtMs:\1\(\2\.completedAt\)/;
    if (alreadyPatched.test(source)) return source;
    const historyTurnShape =
      /(turnStartedAtMs:([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\.startedAt\),durationMs:\3\.durationMs,)(finalAssistantStartedAtMs:\2\(\3\.completedAt\),status:\3\.status)/;
    if (!historyTurnShape.test(source)) {
      if (!hasWarnedHistoryPatchMiss) {
        hasWarnedHistoryPatchMiss = true;
        failCompatibilityPoint(
          staticPoints.historyTurnSignals,
          "Official history turn layout did not match"
        );
        console.warn("[gateway] app-server-manager history patch skipped: current bundle shape did not match");
      }
      return source;
    }
    return source.replace(historyTurnShape, (_match, prefix, secondsToMs, turnVar, suffix) =>
      `${prefix}firstTurnWorkItemStartedAtMs:${secondsToMs}(${turnVar}.firstTurnWorkItemStartedAt??${turnVar}.startedAt),${suffix}`
    );
  }

  function downloadFileMessage() {
    const messages = currentHostI18n().messages || {};
    return messages[OPENCODEX_DOWNLOAD_FILE_MESSAGE_ID] || "Download file";
  }

  function patchOpenInFolderLocaleMessage(source, message = downloadFileMessage()) {
    let searchFrom = 0;
    while (searchFrom < source.length) {
      const tokenIndex = source.indexOf(OPEN_IN_FOLDER_LOCALE_TOKEN, searchFrom);
      if (tokenIndex < 0) return source;
      searchFrom = tokenIndex + OPEN_IN_FOLDER_LOCALE_TOKEN.length;
      OPEN_IN_FOLDER_LOCALE_VALUE_AT_START_RE.lastIndex = tokenIndex;
      const match = OPEN_IN_FOLDER_LOCALE_VALUE_AT_START_RE.exec(source);
      if (!match) continue;
      // 这里按官方 message id 改 locale 值，不匹配展示文案，也不改官方缓存文件。
      return `${source.slice(0, tokenIndex)}${match[1]}${JSON.stringify(message)}${source.slice(
        OPEN_IN_FOLDER_LOCALE_VALUE_AT_START_RE.lastIndex
      )}`;
    }
    return source;
  }

  function isAsciiIdentifierStart(character) {
    const code = character?.charCodeAt?.(0) ?? -1;
    return (
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      character === "_" ||
      character === "$"
    );
  }

  function isAsciiIdentifierPart(character) {
    const code = character?.charCodeAt?.(0) ?? -1;
    return isAsciiIdentifierStart(character) || (code >= 48 && code <= 57);
  }

  function applicationMenuCapabilityCheckStart(source, tokenIndex) {
    let cursor = tokenIndex - 1;
    if (source[cursor] === "?") cursor -= 1;
    const serviceNameEnd = cursor + 1;
    while (cursor >= 0 && isAsciiIdentifierPart(source[cursor])) cursor -= 1;
    const serviceNameStart = cursor + 1;
    if (serviceNameStart === serviceNameEnd || !isAsciiIdentifierStart(source[serviceNameStart])) return -1;

    while (cursor >= 0 && /\s/.test(source[cursor])) cursor -= 1;
    if (source[cursor] !== "&" || source[cursor - 1] !== "&") return -1;
    cursor -= 2;
    while (cursor >= 0 && /\s/.test(source[cursor])) cursor -= 1;
    if (source[cursor] !== ")" || source[cursor - 1] !== "(") return -1;
    cursor -= 2;

    const predicateNameEnd = cursor + 1;
    while (cursor >= 0 && isAsciiIdentifierPart(source[cursor])) cursor -= 1;
    const predicateNameStart = cursor + 1;
    if (predicateNameStart === predicateNameEnd || !isAsciiIdentifierStart(source[predicateNameStart])) return -1;
    return predicateNameStart;
  }

  function patchApplicationMenuCapabilityCheck(source) {
    /**
     * 旧版 renderer 通过 electronBridge.showApplicationMenu 判断是否展示菜单栏，polyfill 已不暴露该方法。
     * 新版改为检查 app-host 的 applicationMenu 服务；Web 端仍需保留其它 app-host 能力，因此只关闭菜单展示判定。
     */
    let searchFrom = 0;
    let copiedUntil = 0;
    let outputParts = null;
    // 先用固定 token 定位少量候选，再用与旧实现相同的正则做粘滞校验，避免为一处判断扫描整个大 chunk。
    while (searchFrom < source.length) {
      const tokenIndex = source.indexOf(APPLICATION_MENU_TOKEN, searchFrom);
      if (tokenIndex < 0) break;
      searchFrom = tokenIndex + APPLICATION_MENU_TOKEN.length;
      const candidateStart = applicationMenuCapabilityCheckStart(source, tokenIndex);
      if (candidateStart < copiedUntil) continue;
      APPLICATION_MENU_CAPABILITY_CHECK_AT_START_RE.lastIndex = candidateStart;
      const match = APPLICATION_MENU_CAPABILITY_CHECK_AT_START_RE.exec(source);
      if (!match || tokenIndex >= APPLICATION_MENU_CAPABILITY_CHECK_AT_START_RE.lastIndex) continue;
      outputParts ||= [];
      outputParts.push(source.slice(copiedUntil, candidateStart), "false");
      copiedUntil = APPLICATION_MENU_CAPABILITY_CHECK_AT_START_RE.lastIndex;
    }
    let patched = source;
    if (outputParts) {
      outputParts.push(source.slice(copiedUntil));
      patched = outputParts.join("");
    }
    if (
      patched === source &&
      source.includes("windowsMenuBar.") &&
      APPLICATION_MENU_SERVICE_USAGE_RE.test(source) &&
      !hasWarnedApplicationMenuPatchMiss
    ) {
      hasWarnedApplicationMenuPatchMiss = true;
      failCompatibilityPoint(
        staticPoints.applicationMenu,
        "Official application menu layout did not match"
      );
      console.warn("[gateway] application menu patch skipped: current bundle shape did not match");
    }
    return patched;
  }

  function patchPendingWorktreesNullSafety(source) {
    /**
     * 在 Web 端发送新消息转入 client-local-thread 路由时，pending_worktrees atom 在部分时序可能为 null，
     * 导致其辅助查询函数抛出 Cannot read properties of null (reading 'find')，引发 React 根 Error Boundary 崩溃。
     */
    if (!source.includes(PENDING_WORKTREES_TOKEN)) return source;
    if (!PENDING_WORKTREES_FIND_RE.test(source)) return source;
    return source
      .replace(
        PENDING_WORKTREES_FIND_RE,
        "function $1(e,t){return e?.find?.(e=>e.clientThreadId===t)??null}"
      )
      .replace(/r=n\.find\(t=>t\.id===e\)\?\?null/g, "r=n?.find?.(t=>t.id===e)??null");
  }

  function patchAppServerRequestScheduling(source) {
    /**
     * 官方调度器会把部分首屏必需读取与耗时的能力清单一起放进 background 队列。
     * 这里只提升首屏读取优先级，并合并仍在进行中的完全相同请求；Promise 完成后立即删除，
     * 不保存返回值，也不延后 plugin/MCP/Apps 的首个初始化请求。
     */
    if (!source.includes(APP_SERVER_REQUEST_CLIENT_DISPATCH_ERROR)) return source;
    const hasFields = APP_SERVER_REQUEST_CLIENT_FIELDS_RE.test(source);
    const sendMatch = source.match(APP_SERVER_REQUEST_CLIENT_SEND_RE);
    const backgroundMatch = source.match(APP_SERVER_BACKGROUND_METHODS_RE);
    if (!hasFields || !sendMatch || !backgroundMatch) {
      failCompatibilityPoint(
        staticPoints.appServerRequestScheduling,
        "Official App Server request layout did not match"
      );
      console.warn("[gateway] app-server request scheduling patch skipped: current bundle shape did not match");
      return source;
    }

    const [, methodVar, paramsVar, optionsVar] = sendMatch;
    const coalescedMethods = [
      `${methodVar}===\`app/list\``,
      `${methodVar}===\`mcpServerStatus/list\``,
      `${methodVar}===\`plugin/list\``,
    ].join("||");
    const replacement = [
      `async sendRequest(${methodVar},${paramsVar},${optionsVar}){`,
      "if(this.dispatchMessage==null)throw Error(`AppServerRequestClient is missing a message dispatcher`);",
      `if(${methodVar}===\`config/read\`)return this.sendConfigReadRequest(${paramsVar},${optionsVar});`,
      `if(!(${coalescedMethods}))return this.enqueueRequest(${methodVar},${paramsVar},${optionsVar});`,
      `let r=JSON.stringify({method:${methodVar},params:${paramsVar},priority:${optionsVar}?.priority??null,source:${optionsVar}?.source??null,timeoutMs:${optionsVar}?.timeoutMs??0,trace:${optionsVar}?.trace===void 0?\`auto\`:${optionsVar}.trace,widget:${optionsVar}?.widget??null}),`,
      "i=this.opencodexInFlightCapabilityReads.get(r);",
      "if(i!=null)return i;",
      `let a=this.enqueueRequest(${methodVar},${paramsVar},${optionsVar});`,
      "return this.opencodexInFlightCapabilityReads.set(r,a),",
      "a.then(()=>this.opencodexInFlightCapabilityReads.delete(r),()=>this.opencodexInFlightCapabilityReads.delete(r)),a}",
    ].join("");
    const backgroundMethods = APP_SERVER_BACKGROUND_METHODS.map((method) => `\`${method}\``).join(",");

    return source
      .replace(
        APP_SERVER_REQUEST_CLIENT_FIELDS_RE,
        "pendingConfigReadRequests=new Map;opencodexInFlightCapabilityReads=new Map;queuedRequests=[]"
      )
      .replace(APP_SERVER_REQUEST_CLIENT_SEND_RE, replacement)
      .replace(APP_SERVER_BACKGROUND_METHODS_RE, `new Set([${backgroundMethods}])`);
  }

  function patchPluginSummaryImageInlining(source) {
    /**
     * 官方 Pii() 会在插件列表返回后把每个插件的三张摘要图全部读成 base64，即使当前页面完全不可见。
     * 远端 Web 改成同源图片 URL 后，React 数据结构与 fallback 都不变，二进制只在 img 挂载时由浏览器读取。
     */
    const patched = source.replace(
      PLUGIN_SUMMARY_IMAGE_EAGER_RE,
      (_match, inlineImage, plugin, hostId, queryClient) => {
        const lazyOrInline = (property) =>
          `window.__opencodexPluginImageUrl?.(${plugin}.${property},${hostId})??${inlineImage}(${plugin}.${property},${hostId},${queryClient})`;
        return `Promise.all([${lazyOrInline("composerIconPath")},${lazyOrInline("logoPath")},${lazyOrInline("logoDarkPath")}])`;
      }
    );
    if (
      patched === source &&
      PLUGIN_SUMMARY_IMAGE_LAYOUT_HINT_RE.test(source) &&
      !hasWarnedPluginSummaryImagePatchMiss
    ) {
      hasWarnedPluginSummaryImagePatchMiss = true;
      failCompatibilityPoint(
        staticPoints.pluginImageLazyLoad,
        "Official plugin image layout did not match"
      );
      console.warn("[gateway] plugin summary image lazy-load patch skipped: current bundle shape did not match");
    }
    return patched;
  }

  function officialAssetHasPatchCandidate(reqPath, data, req) {
    const loopback = isLoopbackHostHeader(req && req.headers && req.headers.host);
    return (
      /\/app-server-manager-signals-[^/]+\.js$/.test(reqPath) ||
      data.includes(APPLICATION_MENU_TOKEN) ||
      data.includes(PENDING_WORKTREES_TOKEN) ||
      data.includes(APP_SERVER_REQUEST_CLIENT_DISPATCH_ERROR) ||
      (!loopback &&
        (data.includes(OPEN_IN_FOLDER_LOCALE_TOKEN) ||
          (data.includes("composerIconPath") && data.includes("read-file-binary"))))
    );
  }

  /** 对官方 chunk 做响应期 patch，不落盘改 vendor/官方构建产物。 */
  function patchOfficialAsset(reqPath, data, req, options = {}) {
    if (!shouldPatchOfficialAsset(reqPath)) return data;
    if (!officialAssetHasPatchCandidate(reqPath, data, req)) return data;
    const loopback = isLoopbackHostHeader(req && req.headers && req.headers.host);
    const isHistorySignalsChunk = /\/app-server-manager-signals-[^/]+\.js$/.test(reqPath);
    // 绝大多数官方 chunk 已在候选检查中直接返回；只有命中的少量资源才进行 UTF-8 文本改写。
    const source = data.toString("utf-8");
    let patched = isHistorySignalsChunk
      ? patchHistorySignalsCompatible(source)
      : source;
    patched = patchApplicationMenuCompatible(patched);
    patched = patchPendingWorktreesNullSafety(patched);
    patched = patchRequestSchedulingCompatible(patched);
    if (!loopback) {
      patched = patchPluginImageCompatible(patched);
      patched = patchOpenInFolderLocaleCompatible(patched, options.downloadMessage || downloadFileMessage());
    }
    // 保留原 Buffer 身份，让缓存层能区分 content-hash 源文件与动态改写后的响应体。
    return patched === source ? data : Buffer.from(patched, "utf-8");
  }

  /** 将 URL path 映射到 web-shell 或官方 asset 的真实文件。 */
  function staticFile(reqPath) {
    // 路径映射只接受固定前缀；不能把任意 URL path 直接拼到项目根目录。
    const fixedWebShellFile = WEB_SHELL_STATIC_FILES.get(reqPath);
    if (fixedWebShellFile) return fixedWebShellFile;
    if (reqPath.startsWith(OPENCODEX_PLUGIN_URL_PREFIX)) {
      return pluginEntryFileFromRequestPath(reqPath);
    }
    if (reqPath.startsWith(WEB_SHELL_ASSETS_PREFIX)) {
      const rel = reqPath.slice(WEB_SHELL_ASSETS_PREFIX.length);
      const candidate = rel ? path.normalize(path.join(WEB_SHELL_ASSETS_DIR, rel)) : "";
      // assets 目录也用真实路径校验，和官方资源分支保持同一套边界模型。
      if (candidate && isWithinRoot(candidate, WEB_SHELL_ASSETS_DIR)) return candidate;
    }
    if (matchedPatchedOfficialPrefix(reqPath)) {
      const rel = patchedOfficialRelPath(reqPath);
      return locateOfficialAsset(rel);
    }
    if (reqPath.startsWith("/official/")) {
      const rel = reqPath.slice("/official/".length);
      return locateOfficialAsset(rel);
    }
    return null;
  }

  /** 静态资源缓存策略：hash asset 长缓存，入口 HTML/no-store 保持可更新。 */
  function cacheControlForRequestPath(reqPath, responsePatched = false) {
    if (process.env.CODEX_WEB_DISABLE_ASSET_CACHE === "1") return "no-store";
    if (patchedOfficialAssetName(reqPath)) {
      if (responsePatched) {
        // 动态 patch 仍要求每次校验，但允许浏览器保存响应并通过 ETag 复用，避免旧版本长期驻留。
        return "private, no-cache, must-revalidate";
      }
      /**
       * patched JS 的相对动态导入会让 CSS、字体和图片也落到当前 patched 命名空间；
       * 这些文件不做响应期改写，只要文件名含 Vite content hash，就能和未改写 JS 一样安全长缓存。
       */
      if (
        reqPath.startsWith(PATCHED_OFFICIAL_PREFIX) &&
        /-[A-Za-z0-9_-]{8}\.(?:avif|css|gif|ico|jpe?g|js|png|svg|webp|woff2?)$/i.test(
          patchedOfficialAssetName(reqPath)
        )
      ) {
        return "public, max-age=31536000, immutable";
      }
      // 旧前缀没有可靠版本位，只用于兼容浏览器残留的懒加载请求。
      return "no-store";
    }
    if (reqPath.startsWith("/official/assets/")) return "public, max-age=31536000, immutable";
    if (reqPath.startsWith(WEB_SHELL_ASSETS_PREFIX)) return "public, max-age=86400";
    if (reqPath.startsWith("/official/")) return "public, max-age=3600";
    if (WEB_SHELL_STATIC_FILES.has(reqPath) || reqPath.startsWith(OPENCODEX_PLUGIN_URL_PREFIX)) {
      // 文件名不带 hash，必须每次验证；内容未变时允许 304，避免远端刷新重复传输整套 Web 扩展脚本。
      return "private, no-cache, must-revalidate";
    }
    return "no-store";
  }

  function weakFileEtag(file) {
    const stat = fs.statSync(file);
    // size + mtime + ctime 足以表示只读构建资源版本，同时允许命中 304 前完全跳过读盘和压缩。
    return `W/"${stat.size.toString(16)}-${Math.trunc(stat.mtimeMs).toString(16)}-${Math.trunc(stat.ctimeMs).toString(16)}"`;
  }

  /** 发送静态文件，并按路径套用合适的缓存策略。 */
  function serveFile(req, res, file, status = 200, reqPath = "") {
    if (shouldPatchOfficialAsset(reqPath) && process.env.CODEX_WEB_DISABLE_ASSET_CACHE !== "1") {
      const sendEntry = (entry) => {
        const contentType = mimeType(file);
        const encoding = representationEncoding(req, contentType, entry.data);
        const sendRepresentation = (representation) => {
          const headers = {
            "content-type": contentType,
            "cache-control": cacheControlForRequestPath(reqPath, entry.patched),
            etag: representation.etag,
            vary: "Accept-Encoding",
          };
          if (encoding !== "identity") headers["content-encoding"] = encoding;
          if (status === 200 && requestHasMatchingEtag(req, representation.etag)) {
            patchedAssetCacheStats.notModified += 1;
            return send(res, 304, headers, "");
          }
          return send(res, status, headers, representation.body);
        };
        const representation = cachedRepresentation(entry, encoding);
        return typeof representation?.then === "function"
          ? representation.then(sendRepresentation)
          : sendRepresentation(representation);
      };
      const entry = cachedPatchedAsset(reqPath, file, req);
      return typeof entry?.then === "function" ? entry.then(sendEntry) : sendEntry(entry);
    }

    if (
      file === WEB_SHELL_STATIC_FILES.get(RUNTIME_COMPATIBILITY_PAGE_PATH) &&
      (reqPath === RUNTIME_COMPATIBILITY_PAGE_PATH || reqPath === RUNTIME_COMPATIBILITY_SETTINGS_PATH)
    ) {
      const i18n = currentI18n();
      const pageI18n = {
        ...i18n,
        messages: {
          ...i18n.messages,
          ...runtimeCompatibilityMessagesForLocale(i18n.locale),
        },
      };
      let html = patchHtmlLang(readText(file), pageI18n.locale);
      const bootstrap = webShellBootstrapScript(pageI18n);
      // 调试页公开可读，但语言必须与认证页来自同一快照；动态 HTML 不参与静态文件 ETag。
      html = html.includes("<!-- opencodex-runtime-config -->")
        ? html.replace("<!-- opencodex-runtime-config -->", bootstrap)
        : html.replace(/<\/head>/i, `    ${bootstrap}\n  </head>`);
      const response = gzipIfUseful(
        req,
        { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
        Buffer.from(html, "utf-8")
      );
      return send(res, status, response.headers, response.body);
    }

    const cacheControl = cacheControlForRequestPath(reqPath);
    const canRevalidateSource = !shouldPatchOfficialAsset(reqPath) && cacheControl !== "no-store";
    const sourceEtag = canRevalidateSource ? weakFileEtag(file) : "";
    if (status === 200 && sourceEtag && requestHasMatchingEtag(req, sourceEtag)) {
      return send(
        res,
        304,
        {
          "content-type": mimeType(file),
          "cache-control": cacheControl,
          etag: sourceEtag,
          vary: "Accept-Encoding",
        },
        ""
      );
    }

    const rawSourceData = fs.readFileSync(file);
    const providerKey = BROWSER_PROVIDER_KEY_BY_FILE.get(file);
    const sourceData = providerKey
      ? Buffer.from(wrapBrowserProviderSource(file, rawSourceData.toString("utf8")), "utf8")
      : rawSourceData;
    const data = patchOfficialAsset(reqPath, sourceData, req);
    const response = gzipIfUseful(
      req,
      {
        "content-type": mimeType(file),
        "cache-control": cacheControlForRequestPath(reqPath, data !== sourceData),
        ...(sourceEtag ? { etag: sourceEtag, vary: "Accept-Encoding" } : {}),
      },
      data
    );
    send(res, status, response.headers, response.body);
  }

  function serveWebShellIndex(res) {
    // web-shell index 总是 no-store，便于调试和升级时立即拿到新的 bridge/polyfill 引用。
    send(
      res,
      200,
      { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      createWebShellIndexResponse()
    );
  }

  function serveRendererIndex(req, res, headers = {}, options = {}) {
    const html = createRendererResponse(options);
    if (!html) {
      return send(
        res,
        404,
        { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...headers },
        "Official renderer bundle is not available yet."
      );
    }
    // renderer HTML 引用动态配置和带版本的静态资源；入口本身不缓存，升级后刷新即可切换新 bundle。
    const response = gzipIfUseful(
      req,
      { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...headers },
      Buffer.from(html, "utf-8")
    );
    return send(
      res,
      200,
      response.headers,
      response.body
    );
  }

  function serveRuntimeBootstrap(req, res, headers = {}) {
    const entry = runtimeBootstrapEntry();
    if (requestHasMatchingEtag(req, entry.etag)) {
      return send(
        res,
        304,
        {
          "cache-control": "private, no-cache, must-revalidate",
          etag: entry.etag,
          vary: "Accept-Encoding",
          ...headers,
        },
        ""
      );
    }
    const representation = runtimeBootstrapRepresentation(req, entry);
    return send(
      res,
      200,
      {
        "content-type": "application/javascript; charset=utf-8",
        "cache-control": "private, no-cache, must-revalidate",
        etag: entry.etag,
        vary: "Accept-Encoding",
        ...(representation.encoding !== "identity" ? { "content-encoding": representation.encoding } : {}),
        ...headers,
      },
      representation.body
    );
  }

  async function prewarmRendererAssets() {
    if (process.env.CODEX_WEB_DISABLE_ASSET_CACHE === "1") return;
    if (canBundleRuntimeBootstrap()) {
      // 浏览器会在解析阶段阻塞等待该脚本；把拼接、散列和两种压缩表示全部移到监听端口之前完成。
      const bootstrapEntry = runtimeBootstrapEntry();
      runtimeBootstrapRepresentation({ headers: { "accept-encoding": "br,gzip" } }, bootstrapEntry);
      runtimeBootstrapRepresentation({ headers: { "accept-encoding": "gzip" } }, bootstrapEntry);
    }
    const mainFileName = officialAssetFileNames()
      .filter((fileName) => /^app-initial-[A-Za-z0-9_-]+\.js$/.test(fileName))
      .sort()[0];
    if (!mainFileName) return;
    const reqPath = `${PATCHED_OFFICIAL_PREFIX}assets/${mainFileName}`;
    const file = locateOfficialAsset(`assets/${mainFileName}`);
    if (!file) return;
    // 本机调试与远程浏览器的主包 patch 可能不同；同时准备 HTTPS/Brotli 与 HTTP/gzip 两条传输路径。
    await Promise.all(
      ["127.0.0.1", "opencodex.remote"].map(async (host) => {
        const req = { headers: { "accept-encoding": "br,gzip", host } };
        const entry = await cachedPatchedAsset(reqPath, file, req);
        await Promise.all([cachedRepresentation(entry, "br"), cachedRepresentation(entry, "gzip")]);
      })
    );
  }

  function servePluginLoader(res) {
    send(
      res,
      200,
      { "content-type": "application/javascript; charset=utf-8", "cache-control": "no-store" },
      createPluginLoaderScript()
    );
  }

  return {
    assetCacheDiagnostics,
    createRendererResponse,
    isAppShellRoute,
    isPublicStaticPath,
    patchOfficialAssetData: patchOfficialAsset,
    prewarmRendererAssets,
    serveFile,
    servePluginLoader,
    serveRendererIndex,
    serveRuntimeBootstrap,
    serveWebShellIndex,
    staticFile,
  };
}

module.exports = { OPENCODEX_RUNTIME_BOOTSTRAP_PATH, createStaticAssetService };
