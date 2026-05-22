// @ts-nocheck
export {};

const fs = require("fs");
const path = require("path");
const http = require("http");
const os = require("os");
const crypto = require("crypto");
const { AsyncLocalStorage } = require("async_hooks");

if (process.versions && process.versions.electron) {
  process.noAsar = true;
}

let express = null;
try {
  express = require("express");
} catch {}

let WebSocketServer = null;
try {
  ({ WebSocketServer } = require("ws"));
} catch {}

const { createCodexAppServerClient } = require("./codex-app-server");
const {
  buildGatewayConfig,
  GatewayCodexIpcPort,
} = require("./ipc/codex/GatewayCodexIpcPort");
const { GatewayIpcPort } = require("./ipc/GatewayIpcPort");
const { GatewayWebClient } = require("./ipc/GatewayWebClient");
const { DirectGatewayElectronIpcPort } = require("./ipc/electron/DirectGatewayElectronIpcPort");
const { ElectronToWebGatewayElectronIpcPort } = require("./ipc/electron/ElectronToWebGatewayElectronIpcPort");
const { ensureOfficialBundle } = require("./official/LocalCodexBundleProvider");

const PROJECT_ROOT = path.resolve(__dirname, "../..");
const WEB_SHELL_DIR = path.join(PROJECT_ROOT, "web-shell");
const WEB_SHELL_ASSETS_PREFIX = "/assets/";
const RUNTIME_DIR = process.env.CODEX_WEB_RUNTIME_DIR
  ? path.resolve(process.env.CODEX_WEB_RUNTIME_DIR)
  : PROJECT_ROOT;
const REPORTS_DIR = process.env.CODEX_WEB_REPORTS_DIR
  ? path.resolve(process.env.CODEX_WEB_REPORTS_DIR)
  : process.env.CODEX_WEB_RUNTIME_DIR
    ? path.join(RUNTIME_DIR, "reports")
    : path.join(PROJECT_ROOT, "reports");
const UNKNOWN_IPC_PATH = path.join(REPORTS_DIR, "unknown-ipc.jsonl");
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const CODEX_GENERATED_IMAGES_DIR = path.join(CODEX_HOME, "generated_images");
const CODEX_WEB_PICKED_FILES_DIR = path.join(CODEX_HOME, ".tmp", "web-picked-files");
const PORT = Number(process.env.PORT || 3737);
const HOST = process.env.HOST || "0.0.0.0";
const AUTH_CONFIG_PATH = process.env.CODEX_WEB_CONFIG_PATH
  ? path.resolve(process.env.CODEX_WEB_CONFIG_PATH)
  : process.env.CODEX_WEB_RUNTIME_DIR
    ? path.join(RUNTIME_DIR, "config.yaml")
    : path.join(process.cwd(), "config.yaml");
const LAUNCHER_TOKEN = process.env.CODEX_WEB_LAUNCHER_TOKEN || "";
const PASSWORD_HASH_PREFIX = "sha256-v1:";
const AUTH_PASSWORD_HASH = loadAuthPasswordHashFromConfig();
const COOKIE_NAME = "codex_web_auth";
const AUTH_TOKEN_TTL_MS = Math.max(
  1_000,
  Number(process.env.CODEX_WEB_AUTH_TOKEN_TTL_MS || 12 * 60 * 60 * 1000)
);
const DEBUG_LOGS = process.env.CODEX_WEB_DEBUG === "1" || process.env.CODEX_WEB_DEBUG === "true";
const IPC_SLOW_LOG_MS = Number(process.env.CODEX_WEB_SLOW_LOG_MS || 750);
const LOCAL_FILE_TOKEN_TTL_MS = Math.max(1_000, Number(process.env.CODEX_WEB_LOCAL_FILE_TOKEN_TTL_MS || 5 * 60 * 1000));
const PATCHED_OFFICIAL_PREFIX = "/official-patched/";
let officialBundle = null;
let hasWarnedHistoryPatchMiss = false;
// AsyncLocalStorage 用来把当前请求的 clientId/remoteAddress 传入更深层的 IPC handler。
const requestContext = new AsyncLocalStorage();
// 这些 channel 必须优先定向回触发请求的浏览器，避免局域网多设备访问时互相收到审批/fetch 响应。
const TARGETED_CHANNELS = new Set([
  "fetch-response",
  "fetch-stream-complete",
  "fetch-stream-error",
  "mcp-request",
  "mcp-response",
  "codex-web:preview-file",
  "persisted-atom-sync",
]);

/** 统一整理远端地址，后续可在这里接入设备验证/访问控制。 */
function normalizeRemoteAddress(req) {
  return String(req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : "");
}

/** 确保目录存在，主要用于 reports 等运行时产物。 */
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/** 读取文本文件；调用方负责确认文件存在。 */
function readText(file) {
  return fs.readFileSync(file, "utf-8");
}

/** fs.existsSync 的语义包装，便于后续替换/统一错误处理。 */
function exists(file) {
  return fs.existsSync(file);
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(String(value), "utf-8").digest("hex");
}

function isPrefixedPasswordHash(value) {
  return new RegExp(`^${PASSWORD_HASH_PREFIX}[a-f0-9]{64}$`, "i").test(String(value || "").trim());
}

function stripYamlComment(value) {
  let quote = "";
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (quote === '"') {
      if (char === "\\") {
        i += 1;
        continue;
      }
      if (char === '"') quote = "";
      continue;
    }
    if (quote === "'") {
      if (char === "'" && value[i + 1] === "'") {
        i += 1;
        continue;
      }
      if (char === "'") quote = "";
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "#" && (i === 0 || /\s/.test(value[i - 1]))) {
      return value.slice(0, i);
    }
  }
  return value;
}

function parseYamlStringScalar(rawValue) {
  const value = stripYamlComment(String(rawValue || "")).trim();
  if (!value || value === "null" || value === "~") return "";
  if (value.startsWith('"')) {
    if (!value.endsWith('"')) throw new Error("[gateway] invalid quoted auth.password in config.yaml");
    try {
      return JSON.parse(value);
    } catch {
      throw new Error("[gateway] invalid quoted auth.password in config.yaml");
    }
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'")) throw new Error("[gateway] invalid quoted auth.password in config.yaml");
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

function leadingIndent(line) {
  const match = String(line || "").match(/^(\s*)/);
  return match ? match[1].length : 0;
}

function findAuthPasswordScalar(rawConfig) {
  const lines = String(rawConfig || "").split(/\r?\n/);
  let inAuth = false;
  let authIndent = 0;
  let authChildIndent = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const logicalLine = stripYamlComment(line);
    if (!logicalLine.trim()) continue;
    const indent = leadingIndent(line);
    if (inAuth && indent <= authIndent) {
      inAuth = false;
      authChildIndent = null;
    }
    if (!inAuth && indent === 0) {
      const authMatch = logicalLine.trim().match(/^auth\s*:\s*(.*)$/);
      if (authMatch) {
        if (authMatch[1].trim()) {
          throw new Error("[gateway] unsupported inline auth config in config.yaml; use block form auth.password");
        }
        inAuth = true;
        authIndent = indent;
        authChildIndent = null;
        continue;
      }
    }
    if (!inAuth || indent <= authIndent) continue;
    if (authChildIndent == null) authChildIndent = indent;
    if (indent !== authChildIndent) continue;
    const passwordMatch = line.match(/^(\s*)password\s*:\s*(.*)$/);
    if (!passwordMatch) continue;
    return {
      lineIndex: i,
      value: parseYamlStringScalar(passwordMatch[2]),
    };
  }
  return null;
}

function rewriteAuthPasswordHash(rawConfig, lineIndex, passwordHash) {
  const hasFinalNewline = /\r?\n$/.test(rawConfig);
  const normalizedConfig = hasFinalNewline ? String(rawConfig || "").replace(/\r?\n$/, "") : String(rawConfig || "");
  const lines = normalizedConfig.split(/\r?\n/);
  const line = lines[lineIndex] || "";
  const match = line.match(/^(\s*password\s*:\s*).*/);
  if (!match) throw new Error("[gateway] auth.password line was not found while rewriting config.yaml");
  lines[lineIndex] = `${match[1]}"${PASSWORD_HASH_PREFIX}${passwordHash}"`;
  return lines.join("\n") + (hasFinalNewline ? "\n" : "");
}

function loadAuthPasswordHashFromConfig() {
  if (!exists(AUTH_CONFIG_PATH)) return "";
  let rawConfig = "";
  try {
    rawConfig = readText(AUTH_CONFIG_PATH);
  } catch (error) {
    throw new Error(`[gateway] failed to read config.yaml: ${error.message || error}`);
  }
  const authPassword = findAuthPasswordScalar(rawConfig);
  if (!authPassword || String(authPassword.value || "").length === 0) return "";
  const passwordValue = String(authPassword.value);
  const trimmedPasswordValue = passwordValue.trim();
  if (isPrefixedPasswordHash(trimmedPasswordValue)) {
    return trimmedPasswordValue.slice(PASSWORD_HASH_PREFIX.length).toLowerCase();
  }
  const passwordHash = sha256Hex(passwordValue);
  const nextConfig = rewriteAuthPasswordHash(rawConfig, authPassword.lineIndex, passwordHash);
  try {
    fs.writeFileSync(AUTH_CONFIG_PATH, nextConfig, "utf-8");
  } catch (error) {
    throw new Error(`[gateway] failed to rewrite config.yaml auth.password as hash: ${error.message || error}`);
  }
  return passwordHash;
}

/** 安全解析真实路径；失败返回 null，避免路径检查阶段抛异常。 */
function realpathSafe(filePath) {
  try {
    return fs.realpathSync.native ? fs.realpathSync.native(filePath) : fs.realpathSync(filePath);
  } catch {
    return null;
  }
}

/** 判断 candidate 是否位于 root 内部，用真实路径避免 ../ 和符号链接绕过。 */
function isWithinRoot(candidate, root) {
  const candidateReal = realpathSafe(candidate);
  const rootReal = realpathSafe(root);
  if (!candidateReal || !rootReal) return false;
  const relative = path.relative(rootReal, candidateReal);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** 把本机路径转成 URL/HTML 更友好的 POSIX 分隔符。 */
function toPosix(p) {
  return p.split(path.sep).join("/");
}

/** 根据文件扩展名返回静态资源 Content-Type。 */
function mimeType(file) {
  const ext = path.extname(file).toLowerCase();
  switch (ext) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
    case ".mjs":
      return "application/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".ico":
      return "image/x-icon";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    case ".ttf":
      return "font/ttf";
    case ".otf":
      return "font/otf";
    default:
      return "application/octet-stream";
  }
}

/** 解析 Cookie header；这里只服务 gateway 自己的轻量鉴权 cookie。 */
function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
}

/** 只保存 token hash；重启 gateway 后 token 自然失效。 */
function makeAuthStore() {
  const tokens = new Map();
  const hashToken = (token) => crypto.createHash("sha256").update(String(token)).digest("base64url");
  const prune = () => {
    const now = Date.now();
    for (const [hash, entry] of tokens) {
      if (!entry || entry.expiresAtMs <= now) tokens.delete(hash);
    }
  };
  return {
    issue() {
      prune();
      const token = crypto.randomBytes(32).toString("base64url");
      const expiresAtMs = Date.now() + AUTH_TOKEN_TTL_MS;
      tokens.set(hashToken(token), { expiresAtMs });
      return { token, expiresAtMs };
    },
    validate(token) {
      if (!token) return null;
      const hash = hashToken(token);
      const entry = tokens.get(hash);
      if (!entry) return null;
      if (entry.expiresAtMs <= Date.now()) {
        tokens.delete(hash);
        return null;
      }
      entry.expiresAtMs = Date.now() + AUTH_TOKEN_TTL_MS;
      return entry;
    },
    revoke(token) {
      if (token) tokens.delete(hashToken(token));
    },
  };
}

const authStore = makeAuthStore();

function timingSafeEqualString(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  if (leftBuffer.length !== rightBuffer.length) {
    try {
      crypto.timingSafeEqual(Buffer.alloc(rightBuffer.length), rightBuffer);
    } catch {}
    return false;
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function bearerToken(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  const match = String(raw || "").match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function authTokenFromRequest(req, url = null) {
  const headerToken = String(headerValue(req.headers, "x-codex-web-token") || "").trim();
  if (headerToken) return headerToken;
  const authorizationToken = bearerToken(headerValue(req.headers, "authorization"));
  if (authorizationToken) return authorizationToken;
  const queryToken = url && url.searchParams ? String(url.searchParams.get("token") || "").trim() : "";
  if (queryToken) return queryToken;
  const cookies = parseCookies(req.headers.cookie || "");
  return String(cookies[COOKIE_NAME] || "").trim();
}

/** 判断当前 HTTP 请求是否已通过 gateway 访问鉴权。 */
function authResultForRequest(req, url = null) {
  if (!AUTH_PASSWORD_HASH) return { authRequired: false, authenticated: true, token: "", expiresAtMs: null };
  const token = authTokenFromRequest(req, url);
  const entry = authStore.validate(token);
  return {
    authRequired: true,
    authenticated: !!entry,
    token,
    expiresAtMs: entry ? entry.expiresAtMs : null,
  };
}

function isAuthed(req, url = null) {
  return authResultForRequest(req, url).authenticated;
}

function authCookieHeader(token) {
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax`;
}

function clearAuthCookieHeader() {
  const expired = "Thu, 01 Jan 1970 00:00:00 GMT";
  return [
    `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0; Expires=${expired}`,
    `${COOKIE_NAME}=; Path=/; SameSite=Lax; Max-Age=0; Expires=${expired}`,
    `${COOKIE_NAME}=; HttpOnly; Path=/api/auth; SameSite=Lax; Max-Age=0; Expires=${expired}`,
    `${COOKIE_NAME}=; Path=/api/auth; SameSite=Lax; Max-Age=0; Expires=${expired}`,
  ];
}

function authRefreshHeaders(auth) {
  if (!auth || !auth.authenticated || !auth.token || !auth.expiresAtMs) return {};
  return { "set-cookie": authCookieHeader(auth.token, auth.expiresAtMs) };
}

/** 发送原始 HTTP 响应。 */
function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

/** 发送 JSON 响应，统一设置 content-type。动态 API 默认不走静态资源缓存。 */
function sendJson(res, status, value, extraHeaders = {}) {
  send(
    res,
    status,
    { "content-type": "application/json; charset=utf-8", ...extraHeaders },
    JSON.stringify(value, null, 2)
  );
}

/** 兼容 Node 不同 headers 结构的大小写查询。 */
function headerValue(headers, name) {
  const normalized = String(name).toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (key.toLowerCase() === normalized) return value;
  }
  return undefined;
}

function isLauncherRequest(req) {
  if (!LAUNCHER_TOKEN) return false;
  const value = headerValue(req.headers, "x-opencodex-launcher-token");
  return typeof value === "string" && value === LAUNCHER_TOKEN;
}

/** 读取完整请求体，用于 JSON POST 和登录表单。 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

/** 给官方 renderer HTML 注入 web-shell polyfill 和运行时配置。 */
function transformOfficialHtml(rawHtml) {
  let html = rawHtml;
  html = html.replace(/<html([^>]*)\blang=["'][^"']*["']([^>]*)>/i, "<html$1lang=\"zh-CN\"$2>");
  if (!/<html[^>]*\blang=/i.test(html)) {
    html = html.replace(/<html([^>]*)>/i, "<html$1 lang=\"zh-CN\">");
  }
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
  html = html.replace(/(src|href)=["']\/(?!(?:official|assets)\/)([^"'#?]+)["']/g, '$1="/official/$2"');
  html = html.replace(/(src|href)=["']\.\/([^"'#?]+)["']/g, '$1="/official/$2"');
  const base = [
    '<base href="/official/">',
    '<script src="/codex-web-config.js"></script>',
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
  return rawHtml
    .replace(
      /((?:src|href)=["']\/official\/assets\/[^"'?#]+\.js)(["'])/g,
      (_match, prefix, quote) => `${prefix.replace("/official/assets/", "/official-patched/assets/")}${quote}`
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

/** 查找 provider 准备好的官方 renderer 入口；运行链路不再依赖 CodexDesktop-Rebuild 的 src/ 快照。 */
function locateOfficialIndex() {
  if (!officialBundle || !officialBundle.webviewDir) return null;
  const srcIndex = path.join(officialBundle.webviewDir, "index.html");
  if (exists(srcIndex)) return { kind: "source", file: srcIndex };
  return null;
}

/** 官方 asset 来自启动前由本机 Codex.app 处理出的 webview bundle。 */
function locateOfficialAsset(filePath) {
  if (!officialBundle || !officialBundle.webviewDir) return null;
  const candidate = path.normalize(path.join(officialBundle.webviewDir, filePath));
  if (!exists(candidate)) return null;
  return isWithinRoot(candidate, officialBundle.webviewDir) ? candidate : null;
}

function locateOfficialStyleAssetHref(prefix) {
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

function createWebShellIndexResponse() {
  const shell = path.join(WEB_SHELL_DIR, "index.html");
  let html = readText(shell);
  const links = officialStyleLinks();
  if (links) {
    if (html.includes("<!-- codex-official-styles -->")) {
      html = html.replace("<!-- codex-official-styles -->", links);
    } else {
      html = html.replace(/<\/head>/i, `${links}\n  </head>`);
    }
  }
  return html;
}

function isPublicOfficialAsset(reqPath) {
  if (reqPath === "/favicon.ico" || reqPath.startsWith(WEB_SHELL_ASSETS_PREFIX)) return true;
  if (/^\/official-patched\/assets\/[^/]+$/.test(reqPath)) return true;
  return /^\/official\/assets\/[^/]+\.(?:css|woff2?|ttf|otf)$/.test(reqPath);
}

/** 读取并转换官方 renderer HTML，作为浏览器访问 Codex 的主页面。 */
function createRendererResponse() {
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
  return /^\/official-patched\/assets\/[^/]+\.js$/.test(reqPath);
}

/** 恢复历史 turn 时旧 renderer 转换漏了 firstTurnWorkItemStartedAtMs，导致折叠摘要退回“上 x 条消息”。 */
function patchAppServerManagerSignalsChunk(source) {
  const alreadyPatched =
    /turnStartedAtMs:([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\.startedAt\),firstTurnWorkItemStartedAtMs:\1\(\2\.firstTurnWorkItemStartedAt\?\?\2\.startedAt\),finalAssistantStartedAtMs:\1\(\2\.completedAt\)/;
  if (alreadyPatched.test(source)) return source;
  const historyTurnShape =
    /(turnStartedAtMs:([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\.startedAt\),)(finalAssistantStartedAtMs:\2\(\3\.completedAt\),status:\3\.status)/;
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
  if (reqPath === "/favicon.ico") return path.join(WEB_SHELL_DIR, "assets", "icon.png");
  if (reqPath === "/codex-bridge-polyfill.js") return path.join(WEB_SHELL_DIR, "codex-bridge-polyfill.js");
  if (reqPath === "/codex-tooltip-dismiss-guard.js") return path.join(WEB_SHELL_DIR, "codex-tooltip-dismiss-guard.js");
  if (reqPath.startsWith(WEB_SHELL_ASSETS_PREFIX)) {
    const rel = reqPath.slice(WEB_SHELL_ASSETS_PREFIX.length);
    if (rel && !rel.includes("..") && !path.isAbsolute(rel)) {
      return path.join(WEB_SHELL_DIR, "assets", rel);
    }
  }
  if (reqPath.startsWith(PATCHED_OFFICIAL_PREFIX)) {
    const rel = reqPath.slice(PATCHED_OFFICIAL_PREFIX.length);
    return locateOfficialAsset(rel);
  }
  if (reqPath.startsWith("/official/")) {
    const rel = reqPath.slice("/official/".length);
    return locateOfficialAsset(rel);
  }
  return null;
}

function isValidPasswordHash(value) {
  return /^[a-f0-9]{64}$/i.test(String(value || "").trim());
}

function readPasswordHashFromBody(rawBody, contentType) {
  if (String(contentType || "").includes("application/json")) {
    try {
      const parsed = JSON.parse(rawBody || "{}");
      return typeof parsed.passwordHash === "string" ? parsed.passwordHash : "";
    } catch {
      return "";
    }
  }
  const params = new URLSearchParams(rawBody || "");
  return params.get("passwordHash") || "";
}

async function handleAuthLogin(req, res) {
  if (req.method !== "POST") {
    return sendJson(res, 405, { ok: false, error: "Method Not Allowed" }, { "cache-control": "no-store" });
  }
  if (!AUTH_PASSWORD_HASH) {
    return sendJson(
      res,
      200,
      {
        ok: true,
        authRequired: false,
        authenticated: true,
        token: "",
        expiresAtMs: null,
        ttlMs: null,
      },
      { "cache-control": "no-store" }
    );
  }
  const rawBody = await readBody(req);
  const passwordHash = readPasswordHashFromBody(rawBody, headerValue(req.headers, "content-type")).trim().toLowerCase();
  if (!isValidPasswordHash(passwordHash) || !timingSafeEqualString(passwordHash, AUTH_PASSWORD_HASH)) {
    return sendJson(
      res,
      401,
      { ok: false, authRequired: true, authenticated: false, error: "Invalid password" },
      { "cache-control": "no-store" }
    );
  }
  const issued = authStore.issue();
  return sendJson(
    res,
    200,
    {
      ok: true,
      authRequired: true,
      authenticated: true,
      token: issued.token,
      expiresAtMs: issued.expiresAtMs,
      ttlMs: AUTH_TOKEN_TTL_MS,
    },
    {
      "cache-control": "no-store",
      "set-cookie": authCookieHeader(issued.token, issued.expiresAtMs),
    }
  );
}

function handleAuthStatus(req, res, url) {
  const auth = authResultForRequest(req, url);
  return sendJson(
    res,
    200,
    {
      ok: true,
      authRequired: !!AUTH_PASSWORD_HASH,
      authenticated: auth.authenticated,
      expiresAtMs: auth.expiresAtMs,
      ttlMs: AUTH_PASSWORD_HASH ? AUTH_TOKEN_TTL_MS : null,
    },
    { "cache-control": "no-store", ...authRefreshHeaders(auth) }
  );
}

function handleAuthLogout(req, res, url) {
  const auth = authResultForRequest(req, url);
  if (auth.token) authStore.revoke(auth.token);
  return sendJson(
    res,
    200,
    { ok: true },
    {
      "cache-control": "no-store",
      "set-cookie": clearAuthCookieHeader(),
    }
  );
}

function sendUnauthorized(req, res) {
  return sendJson(
    res,
    401,
    { ok: false, error: "Unauthorized" },
    { "cache-control": "no-store", "www-authenticate": "Bearer" }
  );
}

/** 静态资源缓存策略：hash asset 长缓存，入口 HTML/no-store 保持可更新。 */
function cacheControlForRequestPath(reqPath) {
  if (process.env.CODEX_WEB_DISABLE_ASSET_CACHE === "1") return "no-store";
  if (shouldPatchOfficialAsset(reqPath)) return "no-store";
  if (reqPath.startsWith("/official-patched/assets/")) return "public, max-age=31536000, immutable";
  if (reqPath.startsWith("/official/assets/")) return "public, max-age=31536000, immutable";
  if (reqPath.startsWith(WEB_SHELL_ASSETS_PREFIX)) return "public, max-age=86400";
  if (reqPath.startsWith("/official/")) return "public, max-age=3600";
  return "no-store";
}

/** 发送静态文件，并按路径套用合适的缓存策略。 */
function serveFile(res, file, status = 200, reqPath = "") {
  const data = patchOfficialAsset(reqPath, fs.readFileSync(file));
  send(res, status, { "content-type": mimeType(file), "cache-control": cacheControlForRequestPath(reqPath) }, data);
}

function serveWebShellIndex(res) {
  send(
    res,
    200,
    { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    createWebShellIndexResponse()
  );
}

/** Content-Disposition 文件名兜底，避免特殊字符破坏 inline 预览 header。 */
function safeInlineFilename(filePath) {
  return path.basename(filePath).replace(/["\r\n]/g, "_") || "file";
}

/** 解析官方 renderer 里的 app://fs/@fs/... 图片 URL 到本机绝对路径。 */
function appFsPathFromRequestPath(pathname) {
  const prefix = "/api/app-fs/@fs/";
  if (!pathname.startsWith(prefix)) return null;
  try {
    const decoded = decodeURIComponent(pathname.slice(prefix.length));
    const filePath = path.normalize(`/${decoded}`);
    return path.isAbsolute(filePath) ? filePath : null;
  } catch {
    return null;
  }
}

/** app://fs 只服务 Codex 生成图、Web 附件临时目录和当前允许的 workspace roots。 */
function isAllowedAppFsFile(filePath) {
  const roots = [
    CODEX_GENERATED_IMAGES_DIR,
    CODEX_WEB_PICKED_FILES_DIR,
    ...(buildGatewayConfig().workspaceRoots || []),
  ];
  return roots.some((root) => typeof root === "string" && root.length > 0 && isWithinRoot(filePath, root));
}

/** 发送 app://fs 映射后的本机图片/文件；所有路径都必须先过 allowlist。 */
function serveAppFsFile(pathname, res) {
  const filePath = appFsPathFromRequestPath(pathname);
  if (!filePath || !isAllowedAppFsFile(filePath)) {
    return send(res, 404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }, "File not allowed.");
  }
  try {
    const stats = fs.statSync(filePath);
    if (!stats.isFile()) {
      return send(res, 404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }, "Not a file.");
    }
    return send(
      res,
      200,
      {
        "content-type": mimeType(filePath),
        "cache-control": "no-store",
        "content-disposition": `inline; filename="${safeInlineFilename(filePath)}"`,
      },
      fs.readFileSync(filePath)
    );
  } catch {
    return send(res, 404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }, "File not found.");
  }
}

/** 打日志时只摘要 open-file payload，避免把完整路径/大对象刷屏。 */
function summarizeOpenFilePayload(payload) {
  if (!payload || typeof payload !== "object") return { payloadType: payload === null ? "null" : typeof payload };
  const pickBasename = (value) => {
    if (typeof value !== "string" || value.length === 0) return null;
    try {
      if (value.startsWith("file://")) return path.basename(new URL(value).pathname);
    } catch {}
    return path.basename(value);
  };
  return {
    keys: Object.keys(payload).sort(),
    target: typeof payload.target === "string" ? payload.target : null,
    path: pickBasename(payload.path),
    filePath: pickBasename(payload.filePath),
    fsPath: pickBasename(payload.fsPath),
    cwd: pickBasename(payload.cwd),
    uri: pickBasename(payload.uri),
  };
}

/** 打日志时只摘要本地文件预览结果。 */
function summarizeOpenFileResult(value) {
  if (!value || typeof value !== "object") return { resultType: value === null ? "null" : typeof value };
  return {
    opened: value.opened === true,
    hasUrl: typeof value.url === "string" && value.url.length > 0,
    reason: typeof value.reason === "string" ? value.reason : null,
    name: typeof value.path === "string" ? path.basename(value.path) : null,
  };
}

/** 把 app-server 已缓存的模型列表塞进首屏配置，减少远端设备打开会话时的等待。 */
function cachedModelListForWebConfig(appServer) {
  if (!appServer || typeof appServer.getCachedResponse !== "function") return null;
  const result = appServer.getCachedResponse("model/list", {}, true);
  const data = result && typeof result === "object" && Array.isArray(result.data) ? result.data : null;
  if (!data) return null;
  return {
    ...(result && typeof result === "object" && !Array.isArray(result) ? result : {}),
    data,
    nextCursor: null,
    hostId: "local",
  };
}

/** 创建 WebSocket hub，负责浏览器连接管理和 gateway 事件分发。 */
function createWsHub(server, getGatewayIpcPort) {
  if (!WebSocketServer) {
    throw new Error("The ws package is required for gateway websocket support.");
  }

  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set();
  const clientsById = new Map();

  /** 向所有在线浏览器广播 gateway 消息。 */
  function broadcast(payload) {
    const message = JSON.stringify(payload);
    for (const socket of clients) {
      if (socket.readyState !== socket.OPEN) continue;
      try {
        socket.send(message);
      } catch {}
    }
  }

  /** 向指定 clientId 的浏览器发送 gateway 消息。 */
  function sendTo(clientId, payload) {
    const socket = clientsById.get(clientId);
    if (!socket || socket.readyState !== socket.OPEN) return false;
    try {
      socket.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  /** 判断某个浏览器 clientId 是否仍在线。 */
  function hasClient(clientId) {
    const socket = clientsById.get(clientId);
    return !!socket && socket.readyState === socket.OPEN;
  }

  // 只接受 /ws 升级，并校验 gateway 访问 token。浏览器 WebSocket 不能自定义 header，所以允许 query/cookie。
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "", `http://${req.headers.host || "localhost"}`);
    if (url.pathname !== "/ws") return socket.destroy();
    if (!isAuthed(req, url)) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => {
      clients.add(ws);
      ws.on("message", (raw) => {
        try {
          const message = JSON.parse(String(raw));
          const clientId = message && typeof message.clientId === "string" ? message.clientId : "";
          // hello 是浏览器接入 IPC 的握手消息，拿到 clientId 后才能定向投递事件。
          if (message && message.type === "hello" && clientId) {
            ws.__codexWebClientId = clientId;
            clientsById.set(clientId, ws);
            const gatewayIpcPort = getGatewayIpcPort && getGatewayIpcPort();
            if (gatewayIpcPort) {
              gatewayIpcPort.attachGatewayClient(new GatewayWebClient({ clientId, socket: ws }));
            }
          }
        } catch {}
      });
      ws.on("close", () => {
        clients.delete(ws);
        if (ws.__codexWebClientId && clientsById.get(ws.__codexWebClientId) === ws) {
          clientsById.delete(ws.__codexWebClientId);
          const gatewayIpcPort = getGatewayIpcPort && getGatewayIpcPort();
          if (gatewayIpcPort) gatewayIpcPort.detachGatewayClient(ws.__codexWebClientId);
        }
      });
      ws.on("error", () => {
        clients.delete(ws);
        if (ws.__codexWebClientId && clientsById.get(ws.__codexWebClientId) === ws) {
          clientsById.delete(ws.__codexWebClientId);
          const gatewayIpcPort = getGatewayIpcPort && getGatewayIpcPort();
          if (gatewayIpcPort) gatewayIpcPort.detachGatewayClient(ws.__codexWebClientId);
        }
      });
      wss.emit("connection", ws, req);
    });
  });

  return { broadcast, clients, sendTo, hasClient };
}

/** app-server 日志适配，统一加前缀并保留 warn/error 语义。 */
function createAppLogger() {
  return {
    info: (...args) => {
      if (DEBUG_LOGS) console.log(...args);
    },
    warn: (...args) => console.warn(...args),
  };
}

/** app-server 的业务广播先进入总 IPC 端口，再由 Electron 语义层投递给浏览器。 */
function broadcastToWebClients(gatewayIpcPort, msg) {
  if (!gatewayIpcPort || !msg) return;
  gatewayIpcPort.broadcastGatewayIpc(msg);
}

function buildGatewayStatus(appServer) {
  const listenUrl = `http://${HOST}:${PORT}`;
  const localUrl = `http://127.0.0.1:${PORT}`;
  return {
    ok: true,
    gateway: {
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
    },
    officialBundle: officialBundle
      ? {
          version: officialBundle.version,
          build: officialBundle.build,
          sourceAppPath: officialBundle.sourceAppPath,
          sourceAsarPath: officialBundle.sourceAsarPath,
          codexBinaryPath: officialBundle.codexBinaryPath,
          bundleDir: officialBundle.bundleDir,
          webviewDir: officialBundle.webviewDir,
          cacheProcessedAt: officialBundle.manifest && officialBundle.manifest.processedAt ? officialBundle.manifest.processedAt : null,
        }
      : null,
    appServer: appServer && appServer.getHealth ? appServer.getHealth() : null,
    workspaceRoots: process.env.CODEX_WEB_WORKSPACE_ROOTS ? process.env.CODEX_WEB_WORKSPACE_ROOTS.split(",").filter(Boolean) : [],
  };
}

/** gateway 启动入口：组装 app-server、Electron IPC、Codex 业务 IPC、HTTP/WS 服务。 */
async function createGateway() {
  ensureDir(REPORTS_DIR);
  officialBundle = ensureOfficialBundle({ projectRoot: PROJECT_ROOT });

  let gatewayIpcPort = null;
  const wsHub = { broadcast: () => {}, hasClient: (clientId) => !!gatewayIpcPort && gatewayIpcPort.isGatewayClientConnected(clientId) };
  const localFileTokens = new Map();

  /**
   * 生成本地文件预览 URL。
   *
   * 浏览器拿到的是带 token 的 /api/local-file/... URL，不能直接读取本机任意路径。
   */
  function createLocalFilePreview(filePath) {
    const token = crypto.randomBytes(24).toString("base64url");
    const expiresAtMs = Date.now() + LOCAL_FILE_TOKEN_TTL_MS;
    localFileTokens.set(token, { filePath, expiresAtMs });
    const name = encodeURIComponent(path.basename(filePath));
    return {
      opened: true,
      path: filePath,
      name: path.basename(filePath),
      url: `/api/local-file/${token}/${name}`,
      expiresAtMs,
    };
  }

  /** 定期清理本地文件预览 token，避免 token 长期有效。 */
  function pruneLocalFileTokens() {
    const now = Date.now();
    for (const [token, entry] of localFileTokens) {
      if (!entry || entry.expiresAtMs <= now) localFileTokens.delete(token);
    }
  }

  const localFileTokenTimer = setInterval(pruneLocalFileTokens, Math.min(60 * 1000, LOCAL_FILE_TOKEN_TTL_MS));
  if (localFileTokenTimer && typeof localFileTokenTimer.unref === "function") localFileTokenTimer.unref();
  // Codex 业务数据统一通过 app-server 走 gateway，不让远端浏览器直接接触 app-server/token。
  const appServer = createCodexAppServerClient({
    broadcast: (msg) => {
      broadcastToWebClients(gatewayIpcPort, msg);
    },
    logger: createAppLogger(),
    defaultCodexBinaryPath: officialBundle.codexBinaryPath,
  });
  let appServerStartPromise = null;

  function ensureAppServerStarted() {
    if (!appServer || !appServer.ensureConnection) return Promise.resolve();
    if (!appServerStartPromise) {
      appServerStartPromise = appServer
        .ensureConnection()
        .then(() =>
          appServer.warmStartupCache
            ? appServer.warmStartupCache()
            : appServer.warmCache
              ? appServer.warmCache()
              : null
        )
        .catch((error) => {
          appServerStartPromise = null;
          throw error;
        });
    }
    return appServerStartPromise;
  }

  let electronIpcPort = null;
  // 默认复用 electron-to-web 作为 Electron IPC 语义层；direct 仅作为调试/兜底实现。
  if (process.env.CODEX_WEB_IPC_IMPL === "direct") {
    electronIpcPort = new DirectGatewayElectronIpcPort();
  } else {
    try {
      const electronToWeb = await import(path.join(PROJECT_ROOT, "vendor", "electron-to-web", "dist", "main", "index.js"));
      electronIpcPort = new ElectronToWebGatewayElectronIpcPort({ electronToWeb, requestContext });
    } catch (error) {
      console.warn("[gateway] electron-to-web main bridge unavailable, falling back to direct IPC", error);
      electronIpcPort = new DirectGatewayElectronIpcPort();
    }
  }

  /** 补齐 IPC handler 需要的上下文和 Electron 能力适配函数。 */
  const createInvokeContext = (ctx = {}) => ({
    clientId: typeof ctx.clientId === "string" ? ctx.clientId : "",
    remoteAddress: typeof ctx.remoteAddress === "string" ? ctx.remoteAddress : "",
    setTitle: () => true,
    openExternal: (urlToOpen) => {
      if (urlToOpen) {
        console.log(`[openExternal] ${urlToOpen}`);
      }
      return true;
    },
    openFile: (filePath) => createLocalFilePreview(filePath),
  });

  const codexIpcPort = new GatewayCodexIpcPort({
    appServer,
    broadcast: (msg) => {
      broadcastToWebClients(gatewayIpcPort, msg);
    },
    logger: createAppLogger(),
    isClientConnected: (clientId) => !!gatewayIpcPort && gatewayIpcPort.isGatewayClientConnected(clientId),
  });

  gatewayIpcPort = new GatewayIpcPort({
    electronIpcPort,
    codexIpcPort,
    requestContext,
    targetedChannels: TARGETED_CHANNELS,
    createInvokeContext,
  });

  /** HTTP 请求主分发：静态页面、API、IPC invoke、文件预览都从这里进入。 */
  const requestHandler = async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const pathname = url.pathname;

    if (pathname === "/api/auth/status") return handleAuthStatus(req, res, url);
    if (pathname === "/api/auth/login") return handleAuthLogin(req, res);
    if (pathname === "/api/auth/logout") return handleAuthLogout(req, res, url);
    if (pathname === "/login") return send(res, 302, { location: "/" }, "");
    if (pathname === "/api/launcher/status") {
      if (!isLauncherRequest(req)) {
        return sendJson(res, 401, { ok: false, error: "Unauthorized" }, { "cache-control": "no-store" });
      }
      return sendJson(res, 200, buildGatewayStatus(appServer), { "cache-control": "no-store" });
    }

    if (isPublicOfficialAsset(pathname)) {
      const file = staticFile(pathname);
      if (file && exists(file)) return serveFile(res, file, 200, pathname);
    }

    if (isAppShellRoute(req, pathname)) {
      // index.html 是公开入口；真正 renderer、API、WS 都在通过 token 后才会返回。
      return serveWebShellIndex(res);
    }

    const requestAuthForRefresh = AUTH_PASSWORD_HASH ? authResultForRequest(req, url) : null;
    if (AUTH_PASSWORD_HASH && !requestAuthForRefresh.authenticated) return sendUnauthorized(req, res);
    const requestAuthRefreshHeaders = authRefreshHeaders(requestAuthForRefresh);
    for (const [name, value] of Object.entries(requestAuthRefreshHeaders)) {
      res.setHeader(name, value);
    }

    if (pathname === "/codex-web-config.js") {
      // 这个配置必须 no-store，因为模型缓存、workspaceRoots、app-server 状态都可能变化。
      await ensureAppServerStarted();
      const gatewayConfig = buildGatewayConfig();
      return send(
        res,
        200,
        {
          "content-type": "application/javascript; charset=utf-8",
          "cache-control": "no-store",
          ...requestAuthRefreshHeaders,
        },
        `(() => {
  window.__CODEX_WEB_CONFIG__ = {
    gatewayBaseUrl: location.origin,
    gatewayWsUrl: location.origin.replace(/^http/, "ws") + "/ws",
    workspaceRoots: ${JSON.stringify(gatewayConfig.workspaceRoots)},
    homeDir: ${JSON.stringify(gatewayConfig.homeDir)},
    locale: ${JSON.stringify(gatewayConfig.locale || "zh-CN")},
    appServer: ${JSON.stringify(appServer.getMode())},
    modelList: ${JSON.stringify(cachedModelListForWebConfig(appServer))},
    sharedObjectSnapshot: ${JSON.stringify(gatewayConfig.sharedObjectSnapshot || {})}
  };
})();`
      );
    }

    if (pathname === "/api/health") {
      return sendJson(res, 200, buildGatewayStatus(appServer));
    }

    if (pathname.startsWith("/api/app-fs/@fs/") && req.method === "GET") {
      // 官方 Desktop 用 app://fs 展示本机图片；Web环境统一映射到受控 HTTP 文件服务。
      return serveAppFsFile(pathname, res);
    }

    if (pathname === "/api/models/list-for-host" && req.method === "GET") {
      // 模型列表是远端设备最容易感知到的慢接口，这里走 gateway/app-server 缓存通道。
      await ensureAppServerStarted();
      const limit = Number(url.searchParams.get("limit"));
      const cursorParam = url.searchParams.get("cursor");
      const includeHiddenParam = url.searchParams.get("includeHidden");
      const params = {
        hostId: url.searchParams.get("hostId") || "local",
        includeHidden: includeHiddenParam !== "0" && includeHiddenParam !== "false",
        cursor: cursorParam && cursorParam !== "null" ? cursorParam : null,
        limit: Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 100,
      };
      try {
	        const value = await requestContext.run(
	          { clientId: "", remoteAddress: normalizeRemoteAddress(req) },
	          () => gatewayIpcPort.invokeGatewayIpc("list-models-for-host", params, { remoteAddress: normalizeRemoteAddress(req) })
	        );
        return sendJson(res, 200, value, { "cache-control": "no-store" });
      } catch (error) {
        return sendJson(
          res,
          500,
          { error: error instanceof Error ? error.message : String(error) },
          { "cache-control": "no-store" }
        );
      }
    }

    if (pathname.startsWith("/api/local-file/") && req.method === "GET") {
      // 本地文件预览必须校验 token 和过期时间，不能把任意本机路径直接暴露给浏览器。
      const parts = pathname.split("/");
      const token = parts[3] || "";
      const entry = localFileTokens.get(token);
      if (!entry || entry.expiresAtMs <= Date.now()) {
        localFileTokens.delete(token);
        return send(res, 404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }, "File preview expired.");
      }
      try {
        const stats = fs.statSync(entry.filePath);
        if (!stats.isFile()) {
          return send(res, 404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }, "Not a file.");
        }
        const data = fs.readFileSync(entry.filePath);
        return send(
          res,
          200,
          {
            "content-type": mimeType(entry.filePath),
            "cache-control": "no-store",
            "content-disposition": `inline; filename="${safeInlineFilename(entry.filePath)}"`,
          },
          data
        );
      } catch {
        localFileTokens.delete(token);
        return send(res, 404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }, "File not found.");
      }
    }

    if (pathname === "/transcribe" && req.method === "POST") {
      // 浏览器没有 Electron 原生听写能力时，通过 gateway 转发给 Codex 业务 IPC。
      await ensureAppServerStarted();
      const rawBody = await readBody(req);
      const isBase64 = String(headerValue(req.headers, "x-codex-base64") || "") === "1";
      const contentType = String(headerValue(req.headers, "content-type") || "");
      try {
	        const value = await requestContext.run(
	          { clientId: "", remoteAddress: normalizeRemoteAddress(req) },
	          () =>
	            gatewayIpcPort.invokeGatewayIpc("transcribe", {
	              bodyBase64: isBase64 ? rawBody : Buffer.from(rawBody, "utf8").toString("base64"),
	              headers: {
                "content-type": contentType,
                accept: "application/json",
              },
            })
        );
        return sendJson(res, 200, value && typeof value === "object" ? value : { text: String(value || "") });
      } catch (error) {
        console.warn("[gateway] transcription failed", error);
        return sendJson(res, 502, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (pathname === "/api/ipc/invoke" && req.method === "POST") {
      // web-shell 的 Electron/Codex invoke 都汇聚到这里，再由 GatewayIpcPort 分流。
      await ensureAppServerStarted();
      const body = await readBody(req);
      let parsed = {};
      try {
        parsed = JSON.parse(body || "{}");
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: "Invalid JSON body" });
      }
      // channel 必须是非空字符串；非法请求直接 400，不进入 IPC 层制造歧义。
      const channel = typeof parsed.channel === "string" ? parsed.channel : "";
      if (!channel) {
        return sendJson(res, 400, { ok: false, error: "Invalid IPC channel" });
      }
      const payload = Object.prototype.hasOwnProperty.call(parsed, "payload") ? parsed.payload : null;
      const clientId = typeof parsed.clientId === "string" ? parsed.clientId : "";
      const remoteAddress = normalizeRemoteAddress(req);
      const startedAtMs = Date.now();
      try {
        // requestContext.run 会把当前 clientId 绑定到后续深层调用，定向广播靠它兜底。
	        const value = await requestContext.run({ clientId, remoteAddress }, () =>
	          gatewayIpcPort.invokeGatewayIpc(channel, payload, {
	            clientId,
	            remoteAddress,
            setTitle: () => true,
            openExternal: (urlToOpen) => {
              if (urlToOpen) {
                console.log(`[openExternal] ${urlToOpen}`);
              }
              return true;
            },
            openFile: (filePath) => createLocalFilePreview(filePath),
          })
        );
        const elapsedMs = Date.now() - startedAtMs;
        if (DEBUG_LOGS || elapsedMs >= IPC_SLOW_LOG_MS) {
          console.log(`[gateway] ipc ${channel} completed in ${elapsedMs}ms`, {
            payloadShape:
              payload === null
                ? "null"
                : Array.isArray(payload)
                  ? `array(${payload.length})`
                  : typeof payload === "object"
                    ? `object(${Object.keys(payload).length})`
                    : typeof payload,
          });
        }
        if (DEBUG_LOGS && channel === "open-file") {
          console.log("[gateway] open-file", {
            payload: summarizeOpenFilePayload(payload),
            result: summarizeOpenFileResult(value),
          });
        }
        return sendJson(res, 200, { ok: true, value });
      } catch (error) {
        const elapsedMs = Date.now() - startedAtMs;
        console.warn(`[gateway] ipc ${channel} failed in ${elapsedMs}ms`, error);
        // 保留真实错误 message，web-shell 会把可操作的 IPC 错误展示给用户。
        return sendJson(res, 500, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (pathname === "/official-index.patched.html") {
      await ensureAppServerStarted();
      const html = createRendererResponse();
      if (!html) {
        return send(res, 404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }, "Official renderer bundle is not available yet.");
      }
      return send(res, 200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }, html);
    }

    const file = staticFile(pathname);
    if (file && exists(file)) return serveFile(res, file, 200, pathname);

    if (isAppShellRoute(req, pathname)) {
      // 所有无扩展名前端路由都走同一个 bootstrap，让官方 router 接管 /local、/remote 等路径。
      return serveWebShellIndex(res);
    }

    send(res, 404, { "content-type": "text/plain; charset=utf-8" }, "Not Found");
  };

  let server;
  if (express) {
    const app = express();
    app.disable("x-powered-by");
    app.use((req, res) => {
      requestHandler(req, res).catch((error) => {
        console.error("[gateway] request failed", error);
        if (!res.headersSent) sendJson(res, 500, { ok: false, error: String(error.message || error) });
      });
    });
    server = http.createServer(app);
  } else {
    server = http.createServer((req, res) => {
      requestHandler(req, res).catch((error) => {
        console.error("[gateway] request failed", error);
        if (!res.headersSent) sendJson(res, 500, { ok: false, error: String(error.message || error) });
      });
    });
  }

  Object.assign(wsHub, createWsHub(server, () => gatewayIpcPort));

  server.listen(PORT, HOST, () => {
    console.log(`[gateway] listening on http://${HOST}:${PORT}`);
    console.log(`[gateway] health: http://${HOST}:${PORT}/api/health`);
    console.log(`[gateway] unknown ipc log: ${path.relative(PROJECT_ROOT, UNKNOWN_IPC_PATH)}`);
  });

  let shuttingDown = false;
  /** 进程退出时释放 app-server/socket/timer，避免子进程和定时器泄漏。 */
  function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(localFileTokenTimer);
    if (electronIpcPort && typeof electronIpcPort.dispose === "function") {
      try {
        electronIpcPort.dispose();
      } catch {}
    }
    if (appServer && typeof appServer.dispose === "function") {
      try {
        appServer.dispose();
      } catch {}
    }
    const exit = () => {
      if (signal) process.exit(0);
    };
    try {
      server.close(exit);
    } catch {
      exit();
    }
    if (signal) {
      const forceExitTimer = setTimeout(() => process.exit(0), 1500);
      if (forceExitTimer && typeof forceExitTimer.unref === "function") forceExitTimer.unref();
    }
  }

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

createGateway().catch((error) => {
  console.error("[gateway] fatal error", error);
  process.exitCode = 1;
});
