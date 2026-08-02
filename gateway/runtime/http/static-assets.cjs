const fs = require("fs");
const path = require("path");
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

const OPENCODEX_PLUGIN_LOADER_PATH = "/opencodex-plugin-loader.js";
const OPENCODEX_PLUGIN_SYSTEM_PATH = "/opencodex-plugin-system.js";
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
const CODEX_BRIDGE_POLYFILL_PATH = "/codex-bridge-polyfill.js";
const CODEX_THREAD_STATUS_EVIDENCE_PATH = "/codex-thread-status-evidence.js";
const CODEX_REMOTE_FILE_ACTIONS_PATH = "/codex-remote-file-actions.js";
const CODEX_WORKSPACE_ROOT_PICKER_CSS_PATH = "/codex-workspace-root-picker.css";
const CODEX_WORKSPACE_ROOT_PICKER_PATH = "/codex-workspace-root-picker.js";
const CODEX_TOOLTIP_DISMISS_GUARD_PATH = "/codex-tooltip-dismiss-guard.js";
const FAVICON_PATH = "/favicon.ico";
const PWA_MANIFEST_PATH = "/manifest.webmanifest";
const WEB_SHELL_ASSETS_DIR = path.join(WEB_SHELL_DIR, "assets");
const OFFICIAL_OPEN_IN_FOLDER_MESSAGE_ID = "artifactTab.preview.openInFolder";
const OPENCODEX_DOWNLOAD_FILE_MESSAGE_ID = "web.remoteFile.downloadFile";
const JS_STRING_LITERAL = String.raw`(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|` + "`" + String.raw`(?:\\.|[^` + "`" + String.raw`\\])*` + "`" + ")";
const REGEXP_SPECIAL_CHARS_RE = /[.*+?^${}()|[\]\\]/g;
function escapeRegExp(value) {
  return String(value).replace(REGEXP_SPECIAL_CHARS_RE, "\\$&");
}
const OPEN_IN_FOLDER_LOCALE_VALUE_RE = new RegExp(
  `("${escapeRegExp(OFFICIAL_OPEN_IN_FOLDER_MESSAGE_ID)}"\\s*:\\s*)${JS_STRING_LITERAL}`
);
const APPLICATION_MENU_CAPABILITY_CHECK_RE =
  /\b[A-Za-z_$][\w$]*\(\)\s*&&\s*[A-Za-z_$][\w$]*\??\.applicationMenu\s*!={1,2}\s*(?:null|void 0)\b/g;
const APPLICATION_MENU_SERVICE_USAGE_RE =
  /\b[A-Za-z_$][\w$]*\??\.applicationMenu\??\.(?:getSnapshot|invokeItem)\b/;
const APP_SERVER_REQUEST_CLIENT_FIELDS_RE =
  /pendingConfigReadRequests=new Map;queuedRequests=\[\]/;
const APP_SERVER_REQUEST_CLIENT_SEND_RE =
  /async sendRequest\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)\{if\(this\.dispatchMessage==null\)throw Error\(`AppServerRequestClient is missing a message dispatcher`\);return \1===`config\/read`\?this\.sendConfigReadRequest\(\2,\3\):this\.enqueueRequest\(\1,\2,\3\)\}/;
const APP_SERVER_BACKGROUND_METHODS_RE =
  /new Set\(\[`app\/list`,`collaborationMode\/list`,`config\/read`,`configRequirements\/read`,`experimentalFeature\/list`,`hooks\/list`,`mcpServerStatus\/list`,`model\/list`,`permissionProfile\/list`,`plugin\/list`,`skills\/list`\]\)/;
const APP_SERVER_BACKGROUND_METHODS = [
  "app/list",
  "hooks/list",
  "mcpServerStatus/list",
  "plugin/list",
  "skills/list",
];
// 固定 web-shell 资源只在这里登记一次，白名单和文件映射共用同一份配置。
const WEB_SHELL_STATIC_FILES = new Map([
  [FAVICON_PATH, path.join(WEB_SHELL_ASSETS_DIR, "icon.png")],
  [PWA_MANIFEST_PATH, path.join(WEB_SHELL_DIR, "manifest.webmanifest")],
  [OPENCODEX_PLUGIN_SYSTEM_PATH, path.join(WEB_SHELL_DIR, "opencodex-plugin-system.js")],
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
    path.join(WEB_SHELL_DIR, "codex-smart-scheduling-injection-health.js"),
  ],
  [CODEX_SMART_MODEL_ROUTER_SETTINGS_PATH, path.join(WEB_SHELL_DIR, "codex-smart-model-router-settings.js")],
  [CODEX_SMART_MODEL_ROUTER_COMPOSER_PATH, path.join(WEB_SHELL_DIR, "codex-smart-model-router-composer.js")],
  [
    CODEX_SMART_SCHEDULING_SUMMARY_CSS_PATH,
    path.join(WEB_SHELL_DIR, "codex-smart-scheduling-summary.css"),
  ],
  [CODEX_SMART_SCHEDULING_SUMMARY_PATH, path.join(WEB_SHELL_DIR, "codex-smart-scheduling-summary.js")],
  [OPENCODEX_TOKEN_USAGE_CAPABILITY_PATH, path.join(WEB_SHELL_DIR, "codex-token-usage-capability.js")],
  [OPENCODEX_WINDOW_CONTROLS_OVERLAY_CSS_PATH, path.join(WEB_SHELL_DIR, "codex-window-controls-overlay.css")],
  [OPENCODEX_WINDOW_CONTROLS_OVERLAY_PATH, path.join(WEB_SHELL_DIR, "codex-window-controls-overlay.js")],
  [CODEX_BRIDGE_POLYFILL_PATH, path.join(WEB_SHELL_DIR, "codex-bridge-polyfill.js")],
  [
    CODEX_THREAD_STATUS_EVIDENCE_PATH,
    path.join(WEB_SHELL_DIR, "codex-thread-status-evidence.js"),
  ],
  [CODEX_REMOTE_FILE_ACTIONS_PATH, path.join(WEB_SHELL_DIR, "codex-remote-file-actions.js")],
  [CODEX_WORKSPACE_ROOT_PICKER_CSS_PATH, path.join(WEB_SHELL_DIR, "codex-workspace-root-picker.css")],
  [CODEX_WORKSPACE_ROOT_PICKER_PATH, path.join(WEB_SHELL_DIR, "codex-workspace-root-picker.js")],
  [CODEX_TOOLTIP_DISMISS_GUARD_PATH, path.join(WEB_SHELL_DIR, "codex-tooltip-dismiss-guard.js")],
]);

// 静态资源层把官方 renderer/web-shell 的路径差异统一隐藏起来，server 只需要按 URL 取文件。
function createStaticAssetService({ getI18nSnapshot, getOfficialBundle }) {
  let hasWarnedHistoryPatchMiss = false;
  let hasWarnedApplicationMenuPatchMiss = false;
  // 旧版本曾经使用 /official-patched/；浏览器缓存的旧 chunk 可能还会懒加载这个前缀。
  const patchedOfficialPrefixes = Array.from(
    new Set([PATCHED_OFFICIAL_PREFIX, "/official-patched-v5/", "/official-patched-v4/", "/official-patched/"])
  );

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

  /** 给官方 renderer HTML 注入 web-shell polyfill 和运行时配置。 */
  function transformOfficialHtml(rawHtml) {
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
    // 官方 HTML 是 Electron renderer 用的，浏览器里需要补 locale、移动端 viewport 和站点图标。
    html = patchHtmlLang(html, currentI18n().locale);
    html = html.replace(
      /<meta([^>]*\bname=["']viewport["'][^>]*)>/i,
      '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover, interactive-widget=resizes-content" />'
    );
    const iconLinks = [
      '<link rel="icon" type="image/png" href="/assets/icon.png" />',
      '<link rel="apple-touch-icon" href="/assets/icon.png" />',
    ].join("\n    ");
    if (!/<link[^>]+\brel=["'][^"']*icon/i.test(html)) {
      html = html.replace(/<title>/i, `${iconLinks}\n    <title>`);
    }
    // 官方产物里的相对路径统一映射到 /official/，避免和 web-shell 自己的 /assets 冲突。
    html = html.replace(/(src|href)=["']\/(?!(?:official|assets)\/)([^"'#?]+)["']/g, '$1="/official/$2"');
    html = html.replace(/(src|href)=["']\.\/([^"'#?]+)["']/g, '$1="/official/$2"');
    // manifest 在 Cloudflare Access 等前置认证后面也必须带同源凭据，否则 Chrome 可能拿不到受保护的 manifest。
    const base = [
      '<base href="/official/">',
      `<link rel="manifest" href="${PWA_MANIFEST_PATH}" crossorigin="use-credentials">`,
      '<meta name="theme-color" content="#ffffff">',
      '<meta name="application-name" content="OpenCodex">',
      '<meta name="mobile-web-app-capable" content="yes">',
      '<meta name="apple-mobile-web-app-title" content="OpenCodex">',
      '<meta name="apple-mobile-web-app-capable" content="yes">',
      '<meta name="apple-mobile-web-app-status-bar-style" content="default">',
      `<link id="codex-web-window-controls-overlay-styles" rel="stylesheet" href="${OPENCODEX_WINDOW_CONTROLS_OVERLAY_CSS_PATH}">`,
      `<link id="codex-smart-model-router-settings-styles" rel="stylesheet" href="${CODEX_SMART_MODEL_ROUTER_SETTINGS_CSS_PATH}">`,
      `<link id="codex-smart-scheduling-summary-styles" rel="stylesheet" href="${CODEX_SMART_SCHEDULING_SUMMARY_CSS_PATH}">`,
      `<link id="codex-web-workspace-root-picker-styles" rel="stylesheet" href="${CODEX_WORKSPACE_ROOT_PICKER_CSS_PATH}">`,
      '<script src="/codex-web-config.js"></script>',
      `<script src="${OPENCODEX_PLUGIN_SYSTEM_PATH}"></script>`,
      `<script src="${OPENCODEX_PLUGIN_LOADER_PATH}"></script>`,
      `<script src="${CODEX_SMART_SCHEDULING_INJECTION_HEALTH_PATH}"></script>`,
      `<script src="${CODEX_SMART_MODEL_ROUTER_SETTINGS_PATH}"></script>`,
      `<script src="${CODEX_SMART_MODEL_ROUTER_COMPOSER_PATH}"></script>`,
      `<script src="${CODEX_SMART_SCHEDULING_SUMMARY_PATH}"></script>`,
      `<script src="${OPENCODEX_TOKEN_USAGE_CAPABILITY_PATH}"></script>`,
      `<script src="${OPENCODEX_WINDOW_CONTROLS_OVERLAY_PATH}"></script>`,
      `<script src="${CODEX_BRIDGE_POLYFILL_PATH}"></script>`,
      `<script src="${CODEX_THREAD_STATUS_EVIDENCE_PATH}"></script>`,
      `<script src="${CODEX_REMOTE_FILE_ACTIONS_PATH}"></script>`,
      `<script src="${CODEX_WORKSPACE_ROOT_PICKER_PATH}"></script>`,
      `<script src="${CODEX_TOOLTIP_DISMISS_GUARD_PATH}"></script>`,
    ].join("\n    ");
    if (/<head[^>]*>/i.test(html)) {
      html = html.replace(/<head([^>]*)>/i, `<head$1>\n    ${base}`);
    }
    return patchOfficialHtmlForWeb(html);
  }

  /** 给少量运行时 patch 过的官方 chunk 换路径命名空间，绕开浏览器 immutable 缓存。 */
  function patchOfficialAssetUrls(rawHtml) {
    // 只给 JS 资源改到 patched 命名空间，CSS/图片无需响应期 patch，继续走官方 immutable 缓存。
    return rawHtml.replace(
      /((?:src|href)=["']\/official\/assets\/[^"'?#]+\.js)(["'])/g,
      (_match, prefix, quote) => `${prefix.replace("/official/assets/", `${PATCHED_OFFICIAL_PREFIX}assets/`)}${quote}`
    );
  }

  /** desktop HTML 的 CSP 会拦截浏览器里部分依赖的 Function/eval 探测，需要在 gateway 层放开。 */
  function patchOfficialCspForWeb(rawHtml) {
    let html = rawHtml;
    if (!html.includes("&#39;unsafe-eval&#39;") && !html.includes("'unsafe-eval'")) {
      html = html
        .replace("&#39;wasm-unsafe-eval&#39;", "&#39;wasm-unsafe-eval&#39; &#39;unsafe-eval&#39;")
        .replace("'wasm-unsafe-eval'", "'wasm-unsafe-eval' 'unsafe-eval'");
    }
    return patchOfficialCspManifestSrc(html);
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
    return patchOfficialCspForWeb(patchOfficialAssetUrls(rawHtml));
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
    const assetsDir = path.join(officialBundle.webviewDir, "assets");
    if (!exists(assetsDir)) return null;
    const fileName = fs
      .readdirSync(assetsDir)
      .filter((entry) => entry.startsWith(prefix) && entry.endsWith(".css"))
      .sort()[0];
    return fileName ? `/official/assets/${fileName}` : null;
  }

  function officialStyleLinks() {
    return ["app-main-", "app-shell-"]
      .map(locateOfficialStyleAssetHref)
      .filter(Boolean)
      .map((href) => `<link rel="stylesheet" href="${href}" data-codex-official-style />`)
      .join("\n    ");
  }

  function currentI18n() {
    // web-shell 登录页在未认证时也需要知道语言；这里消费 runtime 注入的系统语言快照。
    const snapshot = typeof getI18nSnapshot === "function" ? getI18nSnapshot() : { locale: "en-US", messages: {} };
    return withPluginI18nMessages(snapshot);
  }

  function patchHtmlLang(rawHtml, locale) {
    let html = rawHtml.replace(/<html([^>]*)\blang=["'][^"']*["']([^>]*)>/i, `<html$1lang="${locale}"$2>`);
    if (!/<html[^>]*\blang=/i.test(html)) {
      html = html.replace(/<html([^>]*)>/i, `<html$1 lang="${locale}">`);
    }
    return html;
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

  function createPluginLoaderScript() {
    const entries = listPluginEntries();
    const manifests = entries.map((entry) => entry.manifest).filter(Boolean);
    const pluginUrls = entries
      .filter((entry) => entry.entryFile && entry.urlPath)
      .map((entry) => `${OPENCODEX_PLUGIN_URL_PREFIX}${entry.urlPath}?v=${entry.version}`);
    return `(() => {
  const manifests = ${JSON.stringify(manifests)};
  const pluginUrls = ${JSON.stringify(pluginUrls)};
  // 声明式插件先注册元信息；它没有可执行入口，核心能力只由 gateway 的受信 feature 注册表绑定。
  const pluginSystem = window.OpenCodexPluginSystem || window.__OpenCodexPluginSystem;
  if (pluginSystem && typeof pluginSystem.registerPlugin === "function") {
    for (const manifest of manifests) pluginSystem.registerPlugin(manifest);
  }
  // loader 由 gateway 生成；刷新页面即可重新扫描 web-shell/plugins 下的旧式脚本插件。
  function loadPlugin(url) {
    if (document.readyState === "loading") {
      document.write('<script src="' + url + '"><\\/script>');
      return;
    }
    const script = document.createElement("script");
    script.src = url;
    script.async = false;
    (document.head || document.documentElement).appendChild(script);
  }
  for (const url of pluginUrls) loadPlugin(url);
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

  function createRendererResponse() {
    // 这个响应主要用于调试官方 renderer；实际页面入口仍是 web-shell index。
    const located = locateOfficialIndex();
    if (!located) return null;
    const html = readText(located.file);
    return transformOfficialHtml(html);
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
        console.warn("[gateway] app-server-manager history patch skipped: current bundle shape did not match");
      }
      return source;
    }
    return source.replace(historyTurnShape, (_match, prefix, secondsToMs, turnVar, suffix) =>
      `${prefix}firstTurnWorkItemStartedAtMs:${secondsToMs}(${turnVar}.firstTurnWorkItemStartedAt??${turnVar}.startedAt),${suffix}`
    );
  }

  function downloadFileMessage() {
    const messages = currentI18n().messages || {};
    return messages[OPENCODEX_DOWNLOAD_FILE_MESSAGE_ID] || "Download file";
  }

  function patchOpenInFolderLocaleMessage(source) {
    if (!source.includes(OFFICIAL_OPEN_IN_FOLDER_MESSAGE_ID)) return source;
    // 这里按官方 message id 改 locale 值，不匹配“打开所在文件夹”等展示文案，也不改官方缓存文件。
    return source.replace(OPEN_IN_FOLDER_LOCALE_VALUE_RE, (_match, prefix) => `${prefix}${JSON.stringify(downloadFileMessage())}`);
  }

  function patchApplicationMenuCapabilityCheck(source) {
    /**
     * 旧版 renderer 通过 electronBridge.showApplicationMenu 判断是否展示菜单栏，polyfill 已不暴露该方法。
     * 新版改为检查 app-host 的 applicationMenu 服务；Web 端仍需保留其它 app-host 能力，因此只关闭菜单展示判定。
     */
    const patched = source.replace(APPLICATION_MENU_CAPABILITY_CHECK_RE, "false");
    if (
      patched === source &&
      source.includes("windowsMenuBar.") &&
      APPLICATION_MENU_SERVICE_USAGE_RE.test(source) &&
      !hasWarnedApplicationMenuPatchMiss
    ) {
      hasWarnedApplicationMenuPatchMiss = true;
      console.warn("[gateway] application menu patch skipped: current bundle shape did not match");
    }
    return patched;
  }

  function patchAppServerRequestScheduling(source) {
    /**
     * 官方调度器会把部分首屏必需读取与耗时的能力清单一起放进 background 队列。
     * 这里只提升首屏读取优先级，并合并仍在进行中的完全相同请求；Promise 完成后立即删除，
     * 不保存返回值，也不延后 plugin/MCP/Apps 的首个初始化请求。
     */
    if (!source.includes("AppServerRequestClient is missing a message dispatcher")) return source;
    const hasFields = APP_SERVER_REQUEST_CLIENT_FIELDS_RE.test(source);
    const sendMatch = source.match(APP_SERVER_REQUEST_CLIENT_SEND_RE);
    const backgroundMatch = source.match(APP_SERVER_BACKGROUND_METHODS_RE);
    if (!hasFields || !sendMatch || !backgroundMatch) {
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
      `let r=JSON.stringify({method:${methodVar},params:${paramsVar},priority:${optionsVar}?.priority??null,source:${optionsVar}?.source??null,timeoutMs:${optionsVar}?.timeoutMs??0}),`,
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

  /** 对官方 chunk 做响应期 patch，不落盘改 vendor/官方构建产物。 */
  function patchOfficialAsset(reqPath, data, req) {
    if (!shouldPatchOfficialAsset(reqPath)) return data;
    const source = data.toString("utf-8");
    let patched = /\/app-server-manager-signals-[^/]+\.js$/.test(reqPath)
      ? patchAppServerManagerSignalsChunk(source)
      : source;
    patched = patchApplicationMenuCapabilityCheck(patched);
    patched = patchAppServerRequestScheduling(patched);
    if (!isLoopbackHostHeader(req && req.headers && req.headers.host)) {
      patched = patchOpenInFolderLocaleMessage(patched);
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
      // patched 前缀不包含官方 runtime 版本，只有 Vite content-hash 文件名能安全跨升级长期缓存。
      if (
        reqPath.startsWith(PATCHED_OFFICIAL_PREFIX) &&
        !responsePatched &&
        /-[A-Za-z0-9_-]{8}\.js$/.test(patchedOfficialAssetName(reqPath))
      ) {
        return "public, max-age=31536000, immutable";
      }
      // 旧前缀没有可靠版本位，只用于兼容浏览器残留的懒加载请求。
      return "no-store";
    }
    if (reqPath.startsWith("/official/assets/")) return "public, max-age=31536000, immutable";
    if (reqPath.startsWith(WEB_SHELL_ASSETS_PREFIX)) return "public, max-age=86400";
    if (reqPath.startsWith("/official/")) return "public, max-age=3600";
    return "no-store";
  }

  /** 发送静态文件，并按路径套用合适的缓存策略。 */
  function serveFile(req, res, file, status = 200, reqPath = "") {
    const sourceData = fs.readFileSync(file);
    const data = patchOfficialAsset(reqPath, sourceData, req);
    const response = gzipIfUseful(
      req,
      {
        "content-type": mimeType(file),
        "cache-control": cacheControlForRequestPath(reqPath, data !== sourceData),
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

  function servePluginLoader(res) {
    send(
      res,
      200,
      { "content-type": "application/javascript; charset=utf-8", "cache-control": "no-store" },
      createPluginLoaderScript()
    );
  }

  return {
    createRendererResponse,
    isAppShellRoute,
    isPublicStaticPath,
    serveFile,
    servePluginLoader,
    serveWebShellIndex,
    staticFile,
  };
}

module.exports = { createStaticAssetService };
