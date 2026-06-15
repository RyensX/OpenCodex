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
const { gzipIfUseful, send } = require("./http-utils.cjs");

const OPENCODEX_PLUGIN_LOADER_PATH = "/opencodex-plugin-loader.js";
const OPENCODEX_PLUGIN_URL_PREFIX = "/opencodex-plugins/";
const OPENCODEX_TOKEN_USAGE_CAPABILITY_PATH = "/codex-token-usage-capability.js";
const PWA_MANIFEST_PATH = "/manifest.webmanifest";
const WEB_SHELL_PLUGINS_DIR = path.join(WEB_SHELL_DIR, "plugins");
const SAFE_PLUGIN_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.js$/;

// 静态资源层把官方 renderer/web-shell 的路径差异统一隐藏起来，server 只需要按 URL 取文件。
function createStaticAssetService({ getI18nSnapshot, getOfficialBundle }) {
  let hasWarnedHistoryPatchMiss = false;
  // 旧版本曾经使用 /official-patched/；浏览器缓存的旧 chunk 可能还会懒加载这个前缀。
  const patchedOfficialPrefixes = Array.from(new Set([PATCHED_OFFICIAL_PREFIX, "/official-patched/"]));

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
     * - manifest/theme-color，允许 Chrome 把 Web 入口安装为独立窗口壳。
     * - bridge polyfill，把 Electron API 转成 HTTP/WS 调用。
     */
    let html = rawHtml;
    // 官方 HTML 是 Electron renderer 用的，浏览器里需要补 locale、移动端 viewport 和站点图标。
    html = patchHtmlLang(html, currentI18n().locale);
    html = html.replace(
      /<meta([^>]*\bname=["']viewport["'][^>]*)>/i,
      '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover" />'
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
    const base = [
      '<base href="/official/">',
      '<link rel="manifest" href="/manifest.webmanifest">',
      '<meta name="theme-color" content="#ffffff">',
      '<script src="/codex-web-config.js"></script>',
      '<script src="/opencodex-plugin-system.js"></script>',
      '<script src="/opencodex-plugin-loader.js"></script>',
      '<script src="/codex-token-usage-capability.js"></script>',
      '<script src="/codex-bridge-polyfill.js"></script>',
      '<script src="/codex-tooltip-dismiss-guard.js"></script>',
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
    if (rawHtml.includes("&#39;unsafe-eval&#39;") || rawHtml.includes("'unsafe-eval'")) return rawHtml;
    return rawHtml
      .replace("&#39;wasm-unsafe-eval&#39;", "&#39;wasm-unsafe-eval&#39; &#39;unsafe-eval&#39;")
      .replace("'wasm-unsafe-eval'", "'wasm-unsafe-eval' 'unsafe-eval'");
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
    return typeof getI18nSnapshot === "function" ? getI18nSnapshot() : { locale: "en-US", messages: {} };
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

  function listPluginFileNames() {
    if (!exists(WEB_SHELL_PLUGINS_DIR)) return [];
    return fs
      .readdirSync(WEB_SHELL_PLUGINS_DIR)
      .filter((entry) => SAFE_PLUGIN_FILE_NAME.test(entry))
      .filter((entry) => {
        try {
          return fs.statSync(path.join(WEB_SHELL_PLUGINS_DIR, entry)).isFile();
        } catch {
          return false;
        }
      })
      .sort();
  }

  function createPluginLoaderScript() {
    const pluginUrls = listPluginFileNames().map((fileName) => `${OPENCODEX_PLUGIN_URL_PREFIX}${fileName}`);
    return `(() => {
  const pluginUrls = ${JSON.stringify(pluginUrls)};
  // loader 由 gateway 生成；刷新页面即可重新扫描 web-shell/plugins 下的插件文件。
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
    let html = patchHtmlLang(readText(shell), i18n.locale);
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
    if (reqPath === "/favicon.ico" || reqPath === PWA_MANIFEST_PATH || reqPath.startsWith(WEB_SHELL_ASSETS_PREFIX)) {
      return true;
    }
    if (
      reqPath === OPENCODEX_PLUGIN_LOADER_PATH ||
      reqPath === "/opencodex-plugin-system.js" ||
      reqPath === OPENCODEX_TOKEN_USAGE_CAPABILITY_PATH ||
      reqPath === "/codex-bridge-polyfill.js" ||
      reqPath === "/codex-tooltip-dismiss-guard.js"
    ) {
      return true;
    }
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

  /** 对官方 chunk 做响应期 patch，不落盘改 vendor/官方构建产物。 */
  function patchOfficialAsset(reqPath, data) {
    if (!shouldPatchOfficialAsset(reqPath)) return data;
    const source = data.toString("utf-8");
    const patched = /\/app-server-manager-signals-[^/]+\.js$/.test(reqPath)
      ? patchAppServerManagerSignalsChunk(source)
      : source;
    return Buffer.from(patched, "utf-8");
  }

  /** 将 URL path 映射到 web-shell 或官方 asset 的真实文件。 */
  function staticFile(reqPath) {
    // 路径映射只接受固定前缀；不能把任意 URL path 直接拼到项目根目录。
    if (reqPath === "/favicon.ico") return path.join(WEB_SHELL_DIR, "assets", "icon.png");
    if (reqPath === PWA_MANIFEST_PATH) return path.join(WEB_SHELL_DIR, "manifest.webmanifest");
    if (reqPath === "/opencodex-plugin-system.js") return path.join(WEB_SHELL_DIR, "opencodex-plugin-system.js");
    if (reqPath === OPENCODEX_TOKEN_USAGE_CAPABILITY_PATH) return path.join(WEB_SHELL_DIR, "codex-token-usage-capability.js");
    if (reqPath === "/codex-bridge-polyfill.js") return path.join(WEB_SHELL_DIR, "codex-bridge-polyfill.js");
    if (reqPath === "/codex-tooltip-dismiss-guard.js") return path.join(WEB_SHELL_DIR, "codex-tooltip-dismiss-guard.js");
    if (reqPath.startsWith(OPENCODEX_PLUGIN_URL_PREFIX)) {
      const fileName = reqPath.slice(OPENCODEX_PLUGIN_URL_PREFIX.length);
      // 插件只允许顶层安全文件名，避免 URL 拼接穿透到插件目录外。
      if (SAFE_PLUGIN_FILE_NAME.test(fileName)) return path.join(WEB_SHELL_PLUGINS_DIR, fileName);
      return null;
    }
    if (reqPath.startsWith(WEB_SHELL_ASSETS_PREFIX)) {
      const rel = reqPath.slice(WEB_SHELL_ASSETS_PREFIX.length);
      if (rel && !rel.includes("..") && !path.isAbsolute(rel)) {
        return path.join(WEB_SHELL_DIR, "assets", rel);
      }
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
  function cacheControlForRequestPath(reqPath) {
    if (process.env.CODEX_WEB_DISABLE_ASSET_CACHE === "1") return "no-store";
    if (patchedOfficialAssetName(reqPath)) {
      // patched chunk 的内容由 gateway 响应期生成，旧前缀也必须 no-store，避免跨版本继续吃旧模块图。
      return "no-store";
    }
    if (reqPath.startsWith("/official/assets/")) return "public, max-age=31536000, immutable";
    if (reqPath.startsWith(WEB_SHELL_ASSETS_PREFIX)) return "public, max-age=86400";
    if (reqPath.startsWith("/official/")) return "public, max-age=3600";
    return "no-store";
  }

  /** 发送静态文件，并按路径套用合适的缓存策略。 */
  function serveFile(req, res, file, status = 200, reqPath = "") {
    const data = patchOfficialAsset(reqPath, fs.readFileSync(file));
    const response = gzipIfUseful(
      req,
      { "content-type": mimeType(file), "cache-control": cacheControlForRequestPath(reqPath) },
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
