const fs = require("fs");
const crypto = require("crypto");
const os = require("os");
const path = require("path");

// gateway 的运行目录集中在这里定义，其他模块只消费常量，避免散落 process.env 读取。
// 当前文件位于 gateway/runtime/core，项目根目录需要回退三级。
const PROJECT_ROOT = path.resolve(__dirname, "..", "..", "..");
const DATA_DIR = path.join(PROJECT_ROOT, ".data");
const WEB_SHELL_DIR = path.join(PROJECT_ROOT, "web-shell");
const WEB_SHELL_ASSETS_PREFIX = "/assets/";
// CODEX_WEB_RUNTIME_DIR 用于打包态把配置、报告和缓存放到用户数据目录；开发态默认收敛到 .data。
const RUNTIME_DIR = process.env.CODEX_WEB_RUNTIME_DIR
  ? path.resolve(process.env.CODEX_WEB_RUNTIME_DIR)
  : path.join(DATA_DIR, "runtime");
const REPORTS_DIR = process.env.CODEX_WEB_REPORTS_DIR
  ? path.resolve(process.env.CODEX_WEB_REPORTS_DIR)
  : process.env.CODEX_WEB_RUNTIME_DIR
    ? path.join(RUNTIME_DIR, "reports")
    : path.join(DATA_DIR, "reports");
const UNKNOWN_IPC_PATH = path.join(REPORTS_DIR, "unknown-ipc.jsonl");
// CODEX_HOME 需要和官方 CLI/app-server 对齐，才能复用登录态、配置和生成图片目录。
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const CODEX_GENERATED_IMAGES_DIR = path.join(CODEX_HOME, "generated_images");
const CODEX_WEB_PICKED_FILES_DIR = path.join(CODEX_HOME, ".tmp", "web-picked-files");
const CODEX_WEB_PICKED_FILES_MAX_COUNT = positiveIntegerFromEnv("CODEX_WEB_PICKED_FILES_MAX_COUNT", 20);
const CODEX_WEB_PICKED_FILE_MAX_BYTES = positiveIntegerFromEnv("CODEX_WEB_PICKED_FILE_MAX_BYTES", 50 * 1024 * 1024);
const CODEX_WEB_PICKED_FILES_MAX_TOTAL_BYTES = positiveIntegerFromEnv(
  "CODEX_WEB_PICKED_FILES_MAX_TOTAL_BYTES",
  100 * 1024 * 1024
);
const CODEX_WEB_PICKED_FILE_TTL_MS = positiveIntegerFromEnv("CODEX_WEB_PICKED_FILE_TTL_MS", 24 * 60 * 60 * 1000);
const PORT = Number(process.env.PORT || 3737);
const HOST = process.env.HOST || "0.0.0.0";
// 每次 gateway 进程启动都会生成新标识，认证页据此确认重启后接入的确实是新实例。
const GATEWAY_INSTANCE_ID = crypto.randomBytes(16).toString("hex");
// 配置路径支持 launcher 显式传入，避免 Electron cwd 变化时误读项目根目录的 config.yaml。
const AUTH_CONFIG_PATH = process.env.CODEX_WEB_CONFIG_PATH
  ? path.resolve(process.env.CODEX_WEB_CONFIG_PATH)
  : process.env.CODEX_WEB_RUNTIME_DIR
    ? path.join(RUNTIME_DIR, "config.yaml")
    : path.join(process.cwd(), "config.yaml");
const LAUNCHER_TOKEN = process.env.CODEX_WEB_LAUNCHER_TOKEN || "";
const PASSWORD_HASH_PREFIX = "sha256-v1:";
const COOKIE_NAME = "codex_web_auth";
const AUTH_TOKEN_TTL_MS = Math.max(
  1_000,
  Number(process.env.CODEX_WEB_AUTH_TOKEN_TTL_MS || 12 * 60 * 60 * 1000)
);
const DEBUG_LOGS = process.env.CODEX_WEB_DEBUG === "1" || process.env.CODEX_WEB_DEBUG === "true";
const IPC_SLOW_LOG_MS = Number(process.env.CODEX_WEB_SLOW_LOG_MS || 750);
const LOCAL_FILE_TOKEN_TTL_MS = Math.max(1_000, Number(process.env.CODEX_WEB_LOCAL_FILE_TOKEN_TTL_MS || 5 * 60 * 1000));
const LOCAL_DOWNLOAD_ARCHIVE_DIR = path.join(RUNTIME_DIR, "local-downloads");
const LOCAL_DOWNLOAD_ARCHIVE_MAX_FILES = positiveIntegerFromEnv("CODEX_WEB_DOWNLOAD_ARCHIVE_MAX_FILES", 30000);
const LOCAL_DOWNLOAD_ARCHIVE_MAX_BYTES = positiveIntegerFromEnv(
  "CODEX_WEB_DOWNLOAD_ARCHIVE_MAX_BYTES",
  1024 * 1024 * 1024
);
// 路径版本是响应期 patch 的缓存破坏位：官方文件 hash 不变，但 gateway 注入逻辑可能变化。
const PATCHED_OFFICIAL_PREFIX = "/official-patched-v8/";
// 这两个 channel 是官方桌面 renderer/main 的主消息桥，gateway 通过 hook 复用它们。
const MESSAGE_FROM_VIEW_CHANNEL = "codex_desktop:message-from-view";
const MESSAGE_FOR_VIEW_CHANNEL = "codex_desktop:message-for-view";

const TARGETED_MESSAGE_TYPES = new Set([
  // 这些官方消息通常属于某个具体浏览器操作，不能默认广播给所有连接。
  "mcp-response",
  "fetch-response",
  "fetch-stream-complete",
  "fetch-stream-error",
  "codex-web:preview-file",
  "persisted-atom-sync",
]);

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readText(file) {
  return fs.readFileSync(file, "utf-8");
}

function exists(file) {
  return fs.existsSync(file);
}

function positiveIntegerFromEnv(name, fallback) {
  const value = Math.floor(Number(process.env[name] || fallback));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

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

function mimeType(file) {
  // 避免引入 mime 依赖，gateway 只需要覆盖官方 webview 常见静态资源类型。
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
    case ".webmanifest":
      // manifest 需要明确 MIME，Chrome 才能稳定识别安装元数据。
      return "application/manifest+json; charset=utf-8";
    case ".wasm":
      return "application/wasm";
    case ".svg":
      return "image/svg+xml";
    case ".zip":
      return "application/zip";
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

function workspaceRootsFromEnv() {
  // workspace roots 由外层 launcher 注入，Web 端据此决定 app://fs 可访问范围。
  return process.env.CODEX_WEB_WORKSPACE_ROOTS ? process.env.CODEX_WEB_WORKSPACE_ROOTS.split(",").filter(Boolean) : [];
}

function platformUserDataDir(appName) {
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", appName);
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), appName);
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), appName);
}

function officialDataDir() {
  // 这是官方 Codex Desktop 自己的 Electron profile，只用于诊断和迁移判断，隐藏 runtime 不应直接占用。
  return platformUserDataDir("Codex");
}

function officialRuntimeUserDataDir() {
  /**
   * OpenCodex 仍然共享 CODEX_HOME 里的账号、历史会话、插件等核心数据；
   * 但 Chromium/Electron profile 里有 LocalStorage/SessionStorage/LOCK，必须和官方桌面端隔离。
   */
  return process.env.CODEX_WEB_OFFICIAL_USER_DATA_DIR
    ? path.resolve(process.env.CODEX_WEB_OFFICIAL_USER_DATA_DIR)
    : path.join(DATA_DIR, "official-user-data");
}

function safePathSegment(value, fallback) {
  const text = String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return text || fallback;
}

function officialRuntimeTempDir() {
  /**
   * 官方 main 内部还有一条跨进程 live IPC bus：
   *   os.tmpdir()/codex-ipc/ipc-<uid>.sock
   * 如果 OpenCodex 和 Codex Desktop 共用这条 socket，两个 renderer 会互相广播
   * thread-stream-state-changed，进而抢同一会话的 owner/follower 状态。
   *
   * 这里只隔离临时 IPC 目录，不隔离 CODEX_HOME，所以历史、设置、账号和插件仍然共享。
   * 默认放到 /tmp 下是为了缩短 Unix socket 路径，避免 macOS sockaddr_un 长度限制。
   */
  const configured = process.env.CODEX_WEB_OFFICIAL_TMPDIR || process.env.CODEX_WEB_OFFICIAL_TMP_DIR;
  if (configured) return path.resolve(configured);

  const uid =
    typeof process.getuid === "function"
      ? String(process.getuid())
      : safePathSegment(os.userInfo().username, "user");
  const runtimeHash = crypto.createHash("sha256").update(RUNTIME_DIR).digest("hex").slice(0, 12);
  const baseDir = process.platform === "win32" ? os.tmpdir() : "/tmp";
  return path.join(baseDir, `opencodex-official-${safePathSegment(uid, "user")}-${runtimeHash}`);
}

module.exports = {
  AUTH_CONFIG_PATH,
  AUTH_TOKEN_TTL_MS,
  CODEX_GENERATED_IMAGES_DIR,
  CODEX_HOME,
  CODEX_WEB_PICKED_FILE_MAX_BYTES,
  CODEX_WEB_PICKED_FILE_TTL_MS,
  CODEX_WEB_PICKED_FILES_DIR,
  CODEX_WEB_PICKED_FILES_MAX_COUNT,
  CODEX_WEB_PICKED_FILES_MAX_TOTAL_BYTES,
  COOKIE_NAME,
  DEBUG_LOGS,
  GATEWAY_INSTANCE_ID,
  HOST,
  IPC_SLOW_LOG_MS,
  LAUNCHER_TOKEN,
  LOCAL_DOWNLOAD_ARCHIVE_DIR,
  LOCAL_DOWNLOAD_ARCHIVE_MAX_BYTES,
  LOCAL_DOWNLOAD_ARCHIVE_MAX_FILES,
  LOCAL_FILE_TOKEN_TTL_MS,
  MESSAGE_FOR_VIEW_CHANNEL,
  MESSAGE_FROM_VIEW_CHANNEL,
  PASSWORD_HASH_PREFIX,
  PATCHED_OFFICIAL_PREFIX,
  PORT,
  PROJECT_ROOT,
  REPORTS_DIR,
  RUNTIME_DIR,
  TARGETED_MESSAGE_TYPES,
  UNKNOWN_IPC_PATH,
  WEB_SHELL_ASSETS_PREFIX,
  WEB_SHELL_DIR,
  ensureDir,
  exists,
  isWithinRoot,
  mimeType,
  officialDataDir,
  officialRuntimeUserDataDir,
  officialRuntimeTempDir,
  readText,
  workspaceRootsFromEnv,
};
