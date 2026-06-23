const { app, BrowserWindow, Menu, Tray, clipboard, dialog, ipcMain, nativeImage, shell } = require("electron");
const crypto = require("crypto");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { prepareOfficialElectronRuntime } = require("../gateway/runner/index.cjs");
const {
  createInitialLatestReleaseState,
  fetchLatestReleaseState,
  markLatestReleaseChecking,
} = require("./latest-release.cjs");
const { createBoundedLogWriter } = require("./log-writer.cjs");
const { OPENCODEX_VERSION_LABEL } = require("../shared/app-version.cjs");
const { PREFERRED_LANGUAGES_ENV, formatMessage, resolveOpenCodexI18n } = require("../shared/i18n/index.cjs");
const packageMetadata = require("../package.json");

const APP_ROOT = path.resolve(__dirname, "..");

const DEFAULT_HOST = process.env.OPENCODEX_HOST || "127.0.0.1";
const DEFAULT_PORT = normalizePort(process.env.OPENCODEX_PORT);
const PLUGIN_DIRS_ENV = "OPENCODEX_PLUGIN_DIRS";
const OPENCODEX_GITHUB_URL = "https://github.com/RyensX/OpenCodex";
const OPENCODEX_AUTHOR_URL = "https://github.com/RyensX";
const OPENCODEX_AUTHOR = packageMetadata.author || "Ryens";

let mainWindow = null;
let tray = null;
let trayMenu = null;
let statusTimer = null;
let latestReleaseCheckedForForeground = false;
let isQuitting = false;
const gatewayLogWriter = createBoundedLogWriter();

const gatewayState = {
  child: null,
  host: DEFAULT_HOST,
  port: DEFAULT_PORT || 0,
  listenUrl: "",
  localUrl: "",
  primaryUrl: "",
  lanUrls: [],
  token: crypto.randomBytes(32).toString("hex"),
  paths: null,
  settings: null,
  status: null,
  i18n: null,
  preferredLanguages: null,
  latestRelease: createInitialLatestReleaseState(),
  lastError: "",
  startedAt: null,
  officialRuntime: null,
};

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function appendLog(line, options) {
  if (!gatewayState.paths || !gatewayState.paths.logPath) return;
  try {
    // Launcher 主流程只把日志交给 writer 入队；真正落盘和轮转由后台 flush 处理。
    gatewayLogWriter.append(gatewayState.paths.logPath, line, options);
  } catch {}
}

function flushGatewayLog() {
  try {
    // 打开日志前主动 flush，避免用户看到的文件明显落后于内存缓冲。
    return gatewayLogWriter.flush();
  } catch {
    return Promise.resolve();
  }
}

function flushGatewayLogSync() {
  try {
    // 只有退出和异常路径允许同步写盘，用短暂阻塞换取关键日志尽量落盘。
    gatewayLogWriter.flushSync();
  } catch {}
}

function errorLogText(error) {
  if (error instanceof Error && error.stack) return error.stack;
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

function runtimePaths() {
  const userDataDir = app.getPath("userData");
  const runtimeDir = path.join(userDataDir, "runtime");
  const reportsDir = path.join(runtimeDir, "reports");
  const cacheDir = path.join(runtimeDir, "cache");
  const logsDir = path.join(userDataDir, "logs");
  const officialBundleDir = path.join(cacheDir, "codex-official-bundle");

  return {
    userDataDir,
    runtimeDir,
    reportsDir,
    cacheDir,
    logsDir,
    officialBundleDir,
    configPath: path.join(runtimeDir, "config.yaml"),
    settingsPath: path.join(userDataDir, "launcher-settings.json"),
    logPath: path.join(logsDir, "gateway.log"),
    gatewayScriptPath: path.join(APP_ROOT, "gateway", "main.cjs"),
    officialElectronRunnerDir: path.join(runtimeDir, "official-electron-runner"),
  };
}

function ensureRuntimeLayout(paths) {
  ensureDir(paths.runtimeDir);
  ensureDir(paths.reportsDir);
  ensureDir(paths.cacheDir);
  ensureDir(paths.logsDir);
  ensureDir(paths.officialBundleDir);
}

function normalizeHostMode(value) {
  return value === "lan" ? "lan" : "local";
}

function normalizePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return port;
}

function normalizePluginDirs(value) {
  return String(value || "").trim();
}

function splitConfiguredPluginDirs(value) {
  const text = normalizePluginDirs(value);
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    // 手写配置时允许 JSON 数组，数组里的路径按原样处理，不再用分隔符拆开。
    if (Array.isArray(parsed)) return parsed.map((item) => normalizePluginDirs(item)).filter(Boolean);
    if (typeof parsed === "string") return [normalizePluginDirs(parsed)].filter(Boolean);
  } catch {}
  return text
    .split(path.delimiter)
    .flatMap((part) => part.split(","))
    .map((part) => part.trim())
    .filter(Boolean);
}

function defaultSettings() {
  return {
    hostMode: DEFAULT_HOST === "0.0.0.0" ? "lan" : "local",
    port: DEFAULT_PORT,
    pluginDirs: "",
  };
}

function loadLauncherSettings(paths) {
  try {
    const parsed = JSON.parse(fs.readFileSync(paths.settingsPath, "utf8"));
    return {
      ...defaultSettings(),
      ...parsed,
      hostMode: normalizeHostMode(parsed.hostMode),
      port: normalizePort(parsed.port),
      pluginDirs: normalizePluginDirs(parsed.pluginDirs),
    };
  } catch {
    return defaultSettings();
  }
}

function saveLauncherSettings(paths, settings) {
  const nextSettings = {
    ...defaultSettings(),
    ...settings,
    hostMode: normalizeHostMode(settings && settings.hostMode),
    port: normalizePort(settings && settings.port),
    pluginDirs: normalizePluginDirs(settings && settings.pluginDirs),
  };
  fs.writeFileSync(paths.settingsPath, `${JSON.stringify(nextSettings, null, 2)}\n`, "utf8");
  return nextSettings;
}

function hostForMode(hostMode) {
  return normalizeHostMode(hostMode) === "lan" ? "0.0.0.0" : "127.0.0.1";
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function stripYamlComment(value) {
  let quote = "";
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (quote === "\"") {
      if (char === "\\") {
        i += 1;
        continue;
      }
      if (char === "\"") quote = "";
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
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (char === "#" && (i === 0 || /\s/.test(value[i - 1]))) return value.slice(0, i);
  }
  return value;
}

function parseYamlStringScalar(rawValue) {
  const value = stripYamlComment(String(rawValue || "")).trim();
  if (!value || value === "null" || value === "~") return "";
  if (value.startsWith("\"") && value.endsWith("\"")) {
    try {
      return JSON.parse(value);
    } catch {
      return "";
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

function readAuthEnabled(configPath) {
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    const match = raw.match(/^\s*password\s*:\s*(.*)$/m);
    if (!match) return false;
    return !!parseYamlStringScalar(match[1]).trim();
  } catch {
    return false;
  }
}

function writeAuthConfig(paths, password) {
  const value = String(password || "").trim();
  const stored = value ? `sha256-v1:${sha256Hex(value)}` : "";
  fs.writeFileSync(paths.configPath, `auth:\n  password: ${JSON.stringify(stored)}\n`, "utf8");
}

function externalPluginStatus(pluginDirs) {
  const roots = splitConfiguredPluginDirs(pluginDirs);
  if (roots.length === 0) return { configured: false, count: 0 };
  let count = 0;
  for (const root of roots) {
    try {
      // Launcher 只展示外部插件目录的直观数量：根目录下有多少个子目录。
      count += fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length;
    } catch {}
  }
  return {
    configured: true,
    count,
  };
}

function parseIpv4Parts(address) {
  const parts = String(address || "")
    .split(".")
    .map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return parts;
}

function ipv4NetworkScore(address) {
  const parts = parseIpv4Parts(address);
  if (!parts) return -1000;

  const [first, second] = parts;
  if (first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168)) {
    return 500;
  }
  if (first === 100 && second >= 64 && second <= 127) return 350;
  if (first === 169 && second === 254) return 100;
  return 200;
}

function interfaceNameScore(name) {
  const normalizedName = String(name || "").toLowerCase();
  let score = 0;

  // 局域网访问地址优先选择真实 Wi-Fi / 以太网，避免虚拟网卡抢占展示的主地址。
  if (/wi-?fi|wlan|ethernet|以太网|无线|本地连接|^en\d|^eth\d/.test(normalizedName)) score += 120;
  if (/virtual|vmware|vbox|virtualbox|hyper-v|vethernet|wsl|docker|container/.test(normalizedName)) score -= 160;
  if (/loopback|npcap|tailscale|zerotier|hamachi|wireguard|wintun|vpn|openvpn|utun|tap|tun|ppp/.test(normalizedName)) {
    score -= 120;
  }
  if (/bluetooth|蓝牙/.test(normalizedName)) score -= 80;

  return score;
}

function lanCandidateScore(candidate) {
  return ipv4NetworkScore(candidate.address) + interfaceNameScore(candidate.name);
}

function lanUrlsForPort(port) {
  const candidates = [];
  const interfaces = os.networkInterfaces();
  let order = 0;
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries || []) {
      if (!entry || entry.internal || (entry.family !== "IPv4" && entry.family !== 4) || !entry.address) continue;
      const parts = parseIpv4Parts(entry.address);
      if (!parts) continue;
      const [first] = parts;
      if (first === 0 || first === 127 || first >= 224) continue;
      candidates.push({
        address: entry.address,
        name,
        order: order++,
        url: `http://${entry.address}:${port}`,
      });
    }
  }
  const seen = new Set();
  return candidates
    .sort((left, right) => lanCandidateScore(right) - lanCandidateScore(left) || left.order - right.order)
    .filter((candidate) => {
      if (seen.has(candidate.url)) return false;
      seen.add(candidate.url);
      return true;
    })
    .map((candidate) => candidate.url);
}

function updateGatewayUrls() {
  gatewayState.listenUrl = gatewayState.host ? `http://${gatewayState.host}:${gatewayState.port}` : "";
  gatewayState.localUrl = gatewayState.port ? `http://127.0.0.1:${gatewayState.port}` : "";
  gatewayState.lanUrls = gatewayState.host === "0.0.0.0" ? lanUrlsForPort(gatewayState.port) : [];
  gatewayState.primaryUrl =
    gatewayState.host === "0.0.0.0" && gatewayState.lanUrls.length > 0
      ? gatewayState.lanUrls[0]
      : gatewayState.localUrl || gatewayState.listenUrl;
}

function findFreePort(startPort, host) {
  return new Promise((resolve, reject) => {
    const tryPort = (port) => {
      const server = net.createServer();
      server.once("error", (error) => {
        if (error && error.code === "EADDRINUSE") {
          tryPort(port + 1);
          return;
        }
        reject(error);
      });
      server.once("listening", () => {
        server.close(() => resolve(port));
      });
      server.listen(port, host);
    };
    tryPort(startPort);
  });
}

async function findRandomFreePort(host) {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const candidate = 20000 + Math.floor(Math.random() * 30000);
    try {
      return await findFreePort(candidate, host);
    } catch {}
  }
  return findFreePort(3737, host);
}

async function ensurePortSetting(paths, settings) {
  const port = normalizePort(settings && settings.port);
  if (port) return settings;
  const host = hostForMode(settings && settings.hostMode);
  return saveLauncherSettings(paths, {
    ...settings,
    port: await findRandomFreePort(host),
  });
}

function buildState() {
  const i18n = currentGatewayI18n();
  const latestRelease = gatewayState.latestRelease || {};
  return {
    running: !!gatewayState.child && !gatewayState.child.killed,
    pid: gatewayState.child ? gatewayState.child.pid : null,
    host: gatewayState.host,
    port: gatewayState.port,
    url: gatewayState.primaryUrl,
    urls: {
      primary: gatewayState.primaryUrl,
      local: gatewayState.localUrl,
      listen: gatewayState.listenUrl,
      lan: gatewayState.lanUrls,
    },
    paths: gatewayState.paths,
    settings: gatewayState.settings || defaultSettings(),
    auth: {
      enabled: gatewayState.paths ? readAuthEnabled(gatewayState.paths.configPath) : false,
    },
    // launcher 版本来自构建前同步的静态文件，不依赖 gateway 或官方 Codex runtime 状态。
    app: {
      version: OPENCODEX_VERSION_LABEL,
      author: OPENCODEX_AUTHOR,
      authorUrl: OPENCODEX_AUTHOR_URL,
      githubUrl: OPENCODEX_GITHUB_URL,
    },
    latestRelease: {
      checking: !!latestRelease.checking,
      tagName: latestRelease.tagName || "",
      available: !!latestRelease.available,
      lastCheckedAt: latestRelease.lastCheckedAt || null,
      error: latestRelease.error || "",
    },
    externalPlugins: externalPluginStatus((gatewayState.settings || defaultSettings()).pluginDirs),
    status: gatewayState.status,
    lastError: gatewayState.lastError,
    startedAt: gatewayState.startedAt,
    officialRuntime: gatewayState.officialRuntime,
    locale: i18n.locale,
    messages: i18n.messages,
    i18nSource: i18n.source,
  };
}

function currentGatewayI18n() {
  const statusI18n = gatewayState.status && gatewayState.status.i18n;
  if (statusI18n && statusI18n.messages && typeof statusI18n.messages === "object") {
    gatewayState.i18n = statusI18n;
    return statusI18n;
  }
  if (gatewayState.i18n && gatewayState.i18n.messages && typeof gatewayState.i18n.messages === "object") {
    return gatewayState.i18n;
  }
  // gateway 尚未返回状态前，launcher 可以用即将传给 gateway 的同一份首选语言列表兜底。
  return resolveOpenCodexI18n({ systemLocales: currentPreferredLanguages() });
}

function launcherText(key, values) {
  const i18n = currentGatewayI18n();
  return formatMessage(i18n.messages, key, values);
}

async function checkLatestRelease() {
  if (gatewayState.latestRelease.checking) return gatewayState.latestRelease;
  gatewayState.latestRelease = markLatestReleaseChecking(gatewayState.latestRelease);
  broadcastState();
  gatewayState.latestRelease = await fetchLatestReleaseState({
    currentVersionLabel: OPENCODEX_VERSION_LABEL,
    previousState: gatewayState.latestRelease,
  });
  broadcastState();
  return gatewayState.latestRelease;
}

function checkLatestReleaseForForeground() {
  if (latestReleaseCheckedForForeground) return;
  // 同一次前台停留只检查一次；窗口失焦后会重置，下一次回到前台再查。
  latestReleaseCheckedForForeground = true;
  void checkLatestRelease();
}

function openOpenCodexUrl() {
  // 只有 launcher 主动打开浏览器时固定使用 localhost；展示和复制仍走 primaryUrl 方便局域网访问。
  return gatewayState.port ? `http://localhost:${gatewayState.port}` : "";
}

function canOpenOpenCodex() {
  return !!gatewayState.child && !gatewayState.child.killed && !!openOpenCodexUrl();
}

function openOpenCodex() {
  const openUrl = openOpenCodexUrl();
  if (canOpenOpenCodex()) shell.openExternal(openUrl);
  return buildState();
}

function openLatestRelease() {
  const release = gatewayState.latestRelease || {};
  if (!release.available || !release.htmlUrl) return false;
  return shell.openExternal(release.htmlUrl);
}

function preferredSystemLanguages() {
  try {
    const languages = app && typeof app.getPreferredSystemLanguages === "function" ? app.getPreferredSystemLanguages() : [];
    return Array.isArray(languages) ? languages : [];
  } catch {
    return [];
  }
}

function currentPreferredLanguages() {
  if (Array.isArray(gatewayState.preferredLanguages)) return gatewayState.preferredLanguages;
  gatewayState.preferredLanguages = preferredSystemLanguages();
  return gatewayState.preferredLanguages;
}

function preferredLanguagesEnvValue() {
  // 只在 launcher 启动 gateway 时读取系统首选语言；gateway 侧通过环境变量消费同一份列表。
  return JSON.stringify(currentPreferredLanguages());
}

function broadcastState() {
  updateTrayMenu();
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("launcher:state", buildState());
}

async function fetchGatewayStatus() {
  if (!gatewayState.localUrl) return null;
  const response = await fetch(`${gatewayState.localUrl}/api/launcher/status`, {
    headers: {
      "x-opencodex-launcher-token": gatewayState.token,
    },
  });
  if (!response.ok) {
    throw new Error(`gateway status failed: HTTP ${response.status}`);
  }
  return response.json();
}

function startStatusPolling() {
  if (statusTimer) clearInterval(statusTimer);
  statusTimer = setInterval(async () => {
    try {
      gatewayState.status = await fetchGatewayStatus();
      if (gatewayState.status && gatewayState.status.i18n) gatewayState.i18n = gatewayState.status.i18n;
      gatewayState.lastError = "";
    } catch (error) {
      gatewayState.lastError = error instanceof Error ? error.message : String(error);
    }
    broadcastState();
  }, 1500);
  if (statusTimer.unref) statusTimer.unref();
}

async function startGateway() {
  if (gatewayState.child) return buildState();

  const paths = runtimePaths();
  gatewayState.paths = paths;
  ensureRuntimeLayout(paths);
  gatewayState.settings = await ensurePortSetting(paths, loadLauncherSettings(paths));
  gatewayState.host = hostForMode(gatewayState.settings.hostMode);

  if (!fs.existsSync(paths.gatewayScriptPath)) {
    gatewayState.lastError = `Missing gateway entry: ${paths.gatewayScriptPath}`;
    appendLog(`[launcher] ${gatewayState.lastError}\n`, { urgent: true });
    broadcastState();
    return buildState();
  }

  gatewayState.port = await findFreePort(gatewayState.settings.port, gatewayState.host);
  updateGatewayUrls();
  gatewayState.status = null;
  gatewayState.lastError = "";
  gatewayState.startedAt = new Date().toISOString();
  gatewayState.officialRuntime = null;
  gatewayState.preferredLanguages = preferredSystemLanguages();

  appendLog(`\n[launcher] starting gateway ${gatewayState.listenUrl} at ${gatewayState.startedAt}\n`);

  let officialRuntime;
  try {
    // gateway 必须运行在官方 Electron ABI 下，否则官方 native addon（例如 better-sqlite3）会随 Codex 升级失配。
    officialRuntime = await prepareOfficialElectronRuntime({
      runtimeDir: paths.runtimeDir,
      officialBundleDir: paths.officialBundleDir,
      logger: appendLog,
    });
    gatewayState.officialRuntime = officialRuntime;
  } catch (error) {
    gatewayState.lastError = error instanceof Error ? error.message : String(error);
    appendLog(`[launcher] official Electron runtime prepare failed: ${gatewayState.lastError}\n`, { urgent: true });
    broadcastState();
    return buildState();
  }

  const officialUserDataDir = path.join(paths.runtimeDir, "official-user-data");
  const officialRuntimeArgs = [`--user-data-dir=${officialUserDataDir}`];
  const childEnv = {
    ...process.env,
    OPENCODEX_GATEWAY_ENTRY: paths.gatewayScriptPath,
    [PREFERRED_LANGUAGES_ENV]: preferredLanguagesEnvValue(),
    // runner 的 Info.plist 已经用 LSBackgroundOnly 隐藏；该标记让业务入口不要再调用 Dock API。
    OPENCODEX_GATEWAY_AGENT_MODE: "1",
    // 第 4 个 stdio fd 是生命周期 pipe；gateway 会监听它判断 launcher 是否已退出。
    OPENCODEX_GATEWAY_LIFECYCLE_FD: "3",
    // Chromium profile 必须和官方 Desktop 隔离；核心数据继续通过 CODEX_HOME 共享。
    CODEX_WEB_OFFICIAL_USER_DATA_DIR: officialUserDataDir,
    CODEX_ELECTRON_USER_DATA_PATH: officialUserDataDir,
    HOST: gatewayState.host,
    PORT: String(gatewayState.port),
    CODEX_WEB_RUNTIME_DIR: paths.runtimeDir,
    CODEX_WEB_CONFIG_PATH: paths.configPath,
    CODEX_WEB_REPORTS_DIR: paths.reportsDir,
    CODEX_WEB_OFFICIAL_BUNDLE_DIR: paths.officialBundleDir,
    CODEX_WEB_GATEWAY_BASE_URL: gatewayState.primaryUrl,
    CODEX_WEB_LAUNCHER_TOKEN: gatewayState.token,
  };
  const pluginDirs = normalizePluginDirs(gatewayState.settings && gatewayState.settings.pluginDirs);
  if (pluginDirs) {
    childEnv[PLUGIN_DIRS_ENV] = pluginDirs;
  } else {
    // Launcher 设置为空表示不配置外部插件目录，同时避免继承启动 Launcher 时的同名环境变量。
    delete childEnv[PLUGIN_DIRS_ENV];
  }
  const child = spawn(officialRuntime.executablePath, officialRuntimeArgs, {
    cwd: APP_ROOT,
    env: childEnv,
    // 第 4 个 fd 是生命周期 pipe：launcher 退出时 OS 会关闭写端，gateway watchdog 会自杀。
    stdio: ["ignore", "pipe", "pipe", "pipe"],
  });

  gatewayState.child = child;

  child.stdout.on("data", (chunk) => appendLog(`[gateway] ${chunk.toString()}`));
  child.stderr.on("data", (chunk) => appendLog(`[gateway:err] ${chunk.toString()}`, { urgent: true }));
  child.on("error", (error) => {
    gatewayState.lastError = error instanceof Error ? error.message : String(error);
    appendLog(`[launcher] gateway spawn error: ${gatewayState.lastError}\n`, { urgent: true });
    broadcastState();
  });
  child.on("exit", (code, signal) => {
    appendLog(`[launcher] gateway exited: code=${code} signal=${signal}\n`, { urgent: true });
    gatewayState.child = null;
    gatewayState.status = null;
    if (!isQuitting) {
      gatewayState.lastError = `gateway exited: code=${code} signal=${signal}`;
    }
    broadcastState();
  });

  startStatusPolling();
  broadcastState();
  return buildState();
}

function stopGateway() {
  return new Promise((resolve) => {
    const child = gatewayState.child;
    if (!child) {
      resolve(buildState());
      return;
    }
    const timeout = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      resolve(buildState());
    }, 3000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve(buildState());
    });
    try {
      child.kill("SIGTERM");
    } catch {
      clearTimeout(timeout);
      resolve(buildState());
    }
  });
}

async function restartGateway() {
  await stopGateway();
  gatewayState.child = null;
  return startGateway();
}

function createWindow() {
  // Windows/Linux 默认会显示 Electron 应用菜单；启动器不需要菜单栏，创建窗口前统一关闭。
  Menu.setApplicationMenu(null);
  void showLauncherDockIcon();
  mainWindow = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 820,
    minHeight: 600,
    title: "OpenCodex",
    backgroundColor: "#f7f6f2",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "index.html"));
  mainWindow.setMenuBarVisibility(false);
  mainWindow.on("focus", checkLatestReleaseForForeground);
  mainWindow.on("blur", () => {
    // 失焦后允许下一次回到前台重新检查最新版本。
    latestReleaseCheckedForForeground = false;
  });
  mainWindow.on("closed", () => {
    // 窗口允许真正关闭；后台驻留由托盘对象和 app 生命周期负责，之后需要时再重建窗口。
    mainWindow = null;
    latestReleaseCheckedForForeground = false;
    hideLauncherDockIconIfWindowless();
    updateTrayMenu();
  });
}

async function showLauncherDockIcon() {
  if (process.platform !== "darwin") return;
  try {
    if (typeof app.setActivationPolicy === "function") app.setActivationPolicy("regular");
  } catch {}
  if (!app.dock || typeof app.dock.show !== "function") return;
  try {
    const result = app.dock.show();
    if (result && typeof result.then === "function") await result;
  } catch {}
}

function hideLauncherDockIconIfWindowless() {
  if (process.platform !== "darwin" || BrowserWindow.getAllWindows().length > 0) return;
  try {
    // macOS 关掉最后一个窗口后只保留菜单栏托盘图标，避免 Dock 里留下一个无窗口应用图标。
    if (app.dock && typeof app.dock.hide === "function") app.dock.hide();
  } catch {}
  try {
    // accessory 模式会同时从 Dock / Cmd+Tab 里移除应用；重新打开窗口前会切回 regular。
    if (typeof app.setActivationPolicy === "function") app.setActivationPolicy("accessory");
  } catch {}
}

function presentLauncherWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  try {
    if (process.platform === "darwin" && typeof app.focus === "function") app.focus({ steal: true });
  } catch {}
  try {
    if (typeof mainWindow.moveTop === "function") mainWindow.moveTop();
  } catch {}
  mainWindow.focus();
}

function scheduleLauncherWindowPresent() {
  presentLauncherWindow();
  for (const delayMs of [80, 250]) {
    const timer = setTimeout(presentLauncherWindow, delayMs);
    if (timer && typeof timer.unref === "function") timer.unref();
  }
}

async function showLauncherWindow() {
  await showLauncherDockIcon();
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  if (!mainWindow || mainWindow.isDestroyed()) return;
  // macOS 从 accessory 切回 regular 后窗口有时会先创建在后台；短延迟重试确保从托盘打开时直接前置。
  scheduleLauncherWindowPresent();
}

function createTrayImage() {
  const iconPath = path.join(APP_ROOT, "web-shell", "assets", "icon.png");
  let image = nativeImage.createFromPath(iconPath);

  if (image.isEmpty()) {
    // 所有入口共用同一份图标；读取失败时返回空图，避免启动器因托盘资源异常崩溃。
    image = nativeImage.createEmpty();
  }
  if (image.isEmpty()) return nativeImage.createEmpty();

  // 托盘区域尺寸很小，运行时缩放一份稳定图标，避免各平台显示尺寸不一致。
  const trayImage = image.resize({
    width: process.platform === "darwin" ? 18 : 16,
    height: process.platform === "darwin" ? 18 : 16,
  });
  return trayImage;
}

function updateTrayMenu() {
  if (!tray) return;

  const menuTemplate = [
    {
      label: launcherText("launcher.tray.openLauncher"),
      click: () => {
        void showLauncherWindow();
      },
    },
  ];

  if (canOpenOpenCodex()) {
    menuTemplate.push({
      label: launcherText("launcher.actions.openCodex"),
      click: openOpenCodex,
    });
  }

  menuTemplate.push({
    label: launcherText("launcher.actions.restart"),
    click: async () => {
      await restartGateway();
      updateTrayMenu();
    },
  });

  menuTemplate.push(
    { type: "separator" },
    {
      label: launcherText("launcher.tray.quit"),
      click: () => {
        isQuitting = true;
        app.quit();
      },
    }
  );

  trayMenu = Menu.buildFromTemplate(menuTemplate);
  tray.setToolTip(launcherText("launcher.tray.tooltip"));
  tray.setContextMenu(trayMenu);
}

function showTrayMenu() {
  if (!tray) return;
  updateTrayMenu();
  try {
    // Windows/Linux 左键点击默认不会像 macOS 一样弹出 setContextMenu 菜单，因此这里手动弹出。
    tray.popUpContextMenu(trayMenu || undefined);
  } catch {}
}

function createLauncherTray() {
  if (tray) return;
  tray = new Tray(createTrayImage());
  if (process.platform !== "darwin") tray.on("click", showTrayMenu);
  updateTrayMenu();
}

function revealPath(targetPath) {
  if (!targetPath) return false;
  if (!fs.existsSync(targetPath)) return false;
  const stat = fs.statSync(targetPath);
  if (stat.isDirectory()) {
    shell.openPath(targetPath);
  } else {
    shell.showItemInFolder(targetPath);
  }
  return true;
}

ipcMain.handle("launcher:get-state", () => buildState());
ipcMain.handle("launcher:start", () => startGateway());
ipcMain.handle("launcher:restart", () => restartGateway());
ipcMain.handle("launcher:open-url", () => {
  return openOpenCodex();
});
ipcMain.handle("launcher:open-logs", async () => {
  await flushGatewayLog();
  if (gatewayState.paths) revealPath(gatewayState.paths.logPath);
  return buildState();
});
ipcMain.handle("launcher:open-github", () => {
  // GitHub 入口不接收渲染进程传参，固定打开项目主页，减少外链面。
  return shell.openExternal(OPENCODEX_GITHUB_URL);
});
ipcMain.handle("launcher:open-author", () => {
  // 作者入口同样固定到作者主页，不复用通用外链接口。
  return shell.openExternal(OPENCODEX_AUTHOR_URL);
});
ipcMain.handle("launcher:open-latest-release", () => {
  // 更新按钮只能打开主进程已校验并保存的 latest release 链接。
  return openLatestRelease();
});
ipcMain.handle("launcher:reveal-path", (_event, targetPath) => revealPath(targetPath));
ipcMain.handle("launcher:copy", (_event, value) => {
  clipboard.writeText(String(value || ""));
  return true;
});
ipcMain.handle("launcher:update-host-mode", async (_event, hostMode) => {
  const paths = runtimePaths();
  ensureRuntimeLayout(paths);
  gatewayState.paths = paths;
  gatewayState.settings = saveLauncherSettings(paths, {
    ...(gatewayState.settings || loadLauncherSettings(paths)),
    hostMode: normalizeHostMode(hostMode),
  });
  return restartGateway();
});
ipcMain.handle("launcher:update-port", async (_event, port) => {
  const nextPort = normalizePort(port);
  if (!nextPort) {
    gatewayState.lastError = launcherText("launcher.error.invalidPort");
    broadcastState();
    return buildState();
  }
  const paths = runtimePaths();
  ensureRuntimeLayout(paths);
  gatewayState.paths = paths;
  gatewayState.settings = saveLauncherSettings(paths, {
    ...(gatewayState.settings || loadLauncherSettings(paths)),
    port: nextPort,
  });
  return restartGateway();
});
ipcMain.handle("launcher:update-password", async (_event, password) => {
  const paths = runtimePaths();
  ensureRuntimeLayout(paths);
  gatewayState.paths = paths;
  writeAuthConfig(paths, password);
  return restartGateway();
});
ipcMain.handle("launcher:update-plugin-dirs", async (_event, pluginDirs) => {
  const paths = runtimePaths();
  ensureRuntimeLayout(paths);
  gatewayState.paths = paths;
  gatewayState.settings = saveLauncherSettings(paths, {
    ...(gatewayState.settings || loadLauncherSettings(paths)),
    pluginDirs: normalizePluginDirs(pluginDirs),
  });
  return restartGateway();
});
ipcMain.handle("launcher:choose-plugin-dir", async () => {
  const dialogOptions = {
    properties: ["openDirectory"],
    title: launcherText("launcher.settings.pluginDirs.chooseDialogTitle"),
  };
  const result =
    mainWindow && !mainWindow.isDestroyed()
      ? await dialog.showOpenDialog(mainWindow, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);
  if (result.canceled || !result.filePaths || !result.filePaths[0]) return buildState();
  const paths = runtimePaths();
  ensureRuntimeLayout(paths);
  gatewayState.paths = paths;
  gatewayState.settings = saveLauncherSettings(paths, {
    ...(gatewayState.settings || loadLauncherSettings(paths)),
    pluginDirs: result.filePaths[0],
  });
  return restartGateway();
});

process.on("uncaughtExceptionMonitor", (error) => {
  appendLog(`[launcher] uncaught exception: ${errorLogText(error)}\n`, { urgent: true });
  // 进程即将按 Node 默认流程崩溃时，只能走同步 flush 尽量保留现场日志。
  flushGatewayLogSync();
});

process.on("unhandledRejection", (reason) => {
  appendLog(`[launcher] unhandled rejection: ${errorLogText(reason)}\n`, { urgent: true });
  // 未处理 Promise 拒绝同样属于关键故障，允许在这里短暂阻塞写盘。
  flushGatewayLogSync();
});

process.on("exit", () => {
  flushGatewayLogSync();
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    void showLauncherWindow();
  });

  app.whenReady().then(async () => {
    createWindow();
    createLauncherTray();
    // 首次打开窗口也按“当前前台周期”检查一次，不启动任何后台定时器。
    checkLatestReleaseForForeground();
    await startGateway();
  });

  app.on("activate", () => {
    void showLauncherWindow();
  });

  app.on("window-all-closed", () => {
    // 所有平台关闭窗口后都继续驻留托盘，避免 gateway 因 launcher 退出而被生命周期守护关闭。
    hideLauncherDockIconIfWindowless();
    updateTrayMenu();
  });

  app.on("before-quit", () => {
    isQuitting = true;
    if (statusTimer) clearInterval(statusTimer);
    if (gatewayState.child) {
      try {
        gatewayState.child.kill("SIGTERM");
      } catch {}
    }
    flushGatewayLogSync();
  });
}
