const { app, BrowserWindow, Menu, Tray, clipboard, ipcMain, nativeImage, shell } = require("electron");
const crypto = require("crypto");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { prepareOfficialElectronRuntime } = require("../gateway/runner/index.cjs");
const { PREFERRED_LANGUAGES_ENV, formatMessage, resolveOpenCodexI18n } = require("../shared/i18n/index.cjs");

const APP_ROOT = path.resolve(__dirname, "..");
const START_HIDDEN_ARG = "--opencodex-start-hidden";

const DEFAULT_HOST = process.env.OPENCODEX_HOST || "127.0.0.1";
const DEFAULT_PORT = normalizePort(process.env.OPENCODEX_PORT);

let mainWindow = null;
let tray = null;
let trayMenu = null;
let statusTimer = null;
let isQuitting = false;

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
  lastError: "",
  startedAt: null,
  officialRuntime: null,
};

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function appendLog(line) {
  if (!gatewayState.paths || !gatewayState.paths.logPath) return;
  try {
    fs.appendFileSync(gatewayState.paths.logPath, line);
  } catch {}
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

function defaultSettings() {
  return {
    hostMode: DEFAULT_HOST === "0.0.0.0" ? "lan" : "local",
    port: DEFAULT_PORT,
    minimizeToTray: true,
    launchAtLogin: false,
  };
}

function normalizeBoolean(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function loadLauncherSettings(paths) {
  try {
    const parsed = JSON.parse(fs.readFileSync(paths.settingsPath, "utf8"));
    const defaults = defaultSettings();
    return {
      ...defaults,
      ...parsed,
      hostMode: normalizeHostMode(parsed.hostMode),
      port: normalizePort(parsed.port),
      minimizeToTray: normalizeBoolean(parsed.minimizeToTray, defaults.minimizeToTray),
      launchAtLogin: normalizeBoolean(parsed.launchAtLogin, defaults.launchAtLogin),
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
    minimizeToTray: normalizeBoolean(settings && settings.minimizeToTray, true),
    launchAtLogin: normalizeBoolean(settings && settings.launchAtLogin, false),
  };
  fs.writeFileSync(paths.settingsPath, `${JSON.stringify(nextSettings, null, 2)}\n`, "utf8");
  return nextSettings;
}

function hostForMode(hostMode) {
  return normalizeHostMode(hostMode) === "lan" ? "0.0.0.0" : "127.0.0.1";
}

function launchAtLoginSupported() {
  return process.platform === "win32" || process.platform === "darwin";
}

function launchAtLoginArgs() {
  const args = [START_HIDDEN_ARG];
  return process.defaultApp ? [app.getAppPath(), ...args] : args;
}

function quoteWindowsCommandArg(value) {
  const text = String(value || "");
  if (!text) return "\"\"";
  if (!/[ \t"]/.test(text)) return text;
  return `"${text.replace(/(\\*)"/g, "$1$1\\\"").replace(/\\+$/, "$&$&")}"`;
}

function windowsLaunchCommand() {
  return [process.execPath, ...launchAtLoginArgs()].map(quoteWindowsCommandArg).join(" ");
}

function windowsStartupScriptName() {
  const safeName = String(app.getName() || "OpenCodex")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
    .trim();
  return `${safeName || "OpenCodex"}.vbs`;
}

function windowsStartupScriptTargets() {
  if (process.platform !== "win32") return [];
  const scriptName = windowsStartupScriptName();
  const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  const programData = process.env.PROGRAMDATA || path.join(path.parse(os.homedir()).root, "ProgramData");
  const candidates = [
    {
      scope: "user",
      path: path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", scriptName),
    },
    {
      scope: "machine",
      path: path.join(programData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", scriptName),
    },
  ];
  const seen = new Set();
  return candidates.filter((target) => {
    const key = target.path.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function windowsStartupScriptContent() {
  const command = windowsLaunchCommand().replace(/"/g, "\"\"");
  return [
    "' OpenCodex 管理的启动项；应用路径变化时启动器会自动重写。",
    "Set WshShell = CreateObject(\"WScript.Shell\")",
    `WshShell.Run "${command}", 0, False`,
    "",
  ].join("\r\n");
}

function readTextFilePreservingUnicode(filePath) {
  const buffer = fs.readFileSync(filePath);
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.slice(2).toString("utf16le");
  }
  return buffer.toString("utf8");
}

function writeWindowsStartupScript(filePath) {
  ensureDir(path.dirname(filePath));
  // VBS 对中文路径的兼容性依赖 BOM，运行时启动脚本用 UTF-16LE 写入。
  const content = windowsStartupScriptContent();
  fs.writeFileSync(filePath, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(content, "utf16le")]));
}

function readWindowsStartupScriptState() {
  const expectedContent = windowsStartupScriptContent();
  const items = windowsStartupScriptTargets().map((target) => {
    try {
      const content = readTextFilePreservingUnicode(target.path);
      return {
        ...target,
        exists: true,
        matches: content === expectedContent,
        error: "",
      };
    } catch (error) {
      return {
        ...target,
        exists: false,
        matches: false,
        error: error && error.code === "ENOENT" ? "" : error instanceof Error ? error.message : String(error),
      };
    }
  });
  return {
    enabled: items.some((item) => item.exists && item.matches),
    present: items.some((item) => item.exists),
    stale: items.some((item) => item.exists && !item.matches),
    items,
  };
}

function encodePowerShellScript(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

function runWindowsPowerShell(script) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodePowerShellScript(script)], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => {
      stdout = `${stdout}${chunk.toString("utf8")}`.slice(-8192);
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-8192);
    });
    child.on("error", (error) => {
      resolve({ ok: false, code: null, stdout, stderr, error: error instanceof Error ? error.message : String(error) });
    });
    child.on("close", (code) => {
      resolve({ ok: code === 0, code, stdout, stderr, error: "" });
    });
  });
}

function childProcessFailureText(result) {
  if (!result) return "";
  return String(result.stderr || result.stdout || result.error || (result.code == null ? "" : `exit ${result.code}`)).trim();
}

async function runElevatedWindowsStartupScript(openAtLogin) {
  const targets = windowsStartupScriptTargets();
  const userTarget = targets.find((target) => target.scope === "user") || targets[0];
  const payload = {
    openAtLogin: !!openAtLogin,
    writePath: userTarget ? userTarget.path : "",
    removePaths: targets.map((target) => target.path),
    content: windowsStartupScriptContent(),
  };
  const payloadBase64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  const elevatedScript = `
$ErrorActionPreference = 'Stop'
$payloadJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payloadBase64}'))
$payload = $payloadJson | ConvertFrom-Json
if ($payload.openAtLogin) {
  $parent = Split-Path -LiteralPath $payload.writePath -Parent
  New-Item -ItemType Directory -Force -LiteralPath $parent | Out-Null
  [IO.File]::WriteAllText($payload.writePath, $payload.content, [Text.Encoding]::Unicode)
} else {
  foreach ($targetPath in $payload.removePaths) {
    if (Test-Path -LiteralPath $targetPath) {
      Remove-Item -LiteralPath $targetPath -Force
    }
  }
}
`;
  const encodedElevatedScript = encodePowerShellScript(elevatedScript);
  // 只有普通用户级启动项写入失败时才触发 UAC，避免每次切换都打扰用户。
  const wrapperScript = `
$ErrorActionPreference = 'Stop'
$argumentList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', '${encodedElevatedScript}')
$process = Start-Process -FilePath 'powershell.exe' -ArgumentList $argumentList -Verb RunAs -Wait -PassThru
if ($null -eq $process) { exit 1 }
exit $process.ExitCode
`;
  return runWindowsPowerShell(wrapperScript);
}

async function applyWindowsStartupScriptSetting(openAtLogin, options = {}) {
  const errors = [];
  if (openAtLogin) {
    const userTarget = windowsStartupScriptTargets().find((target) => target.scope === "user");
    if (userTarget) {
      try {
        writeWindowsStartupScript(userTarget.path);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (readWindowsStartupScriptState().enabled) return { ok: true, error: "" };
    if (options.allowElevated) {
      const elevated = await runElevatedWindowsStartupScript(true);
      if (!elevated.ok) errors.push(childProcessFailureText(elevated));
      if (readWindowsStartupScriptState().enabled) return { ok: true, error: "" };
    }
    return {
      ok: false,
      error: errors.filter(Boolean).join("; ") || launcherText("launcher.error.launchAtLoginVerifyFailed"),
    };
  }

  for (const item of readWindowsStartupScriptState().items) {
    if (!item.exists) continue;
    try {
      fs.unlinkSync(item.path);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  // 关闭时同名脚本无论是否为当前内容都要清掉，避免旧路径继续触发开机启动。
  if (!readWindowsStartupScriptState().present) return { ok: true, error: "" };
  if (options.allowElevated) {
    const elevated = await runElevatedWindowsStartupScript(false);
    if (!elevated.ok) errors.push(childProcessFailureText(elevated));
    if (!readWindowsStartupScriptState().present) return { ok: true, error: "" };
  }
  return {
    ok: false,
    error: errors.filter(Boolean).join("; ") || launcherText("launcher.error.launchAtLoginVerifyFailed"),
  };
}

function loginItemQueryOptions() {
  if (process.platform !== "win32") return {};
  return {
    path: process.execPath,
    args: launchAtLoginArgs(),
    name: app.getName(),
  };
}

function loginItemSettingsOptions(openAtLogin) {
  const enabled = !!openAtLogin;
  const options = {
    openAtLogin: enabled,
  };
  if (process.platform === "win32") {
    return {
      ...options,
      path: process.execPath,
      args: launchAtLoginArgs(),
      name: app.getName(),
      enabled,
    };
  }
  if (process.platform === "darwin") {
    return {
      ...options,
      // 老版本 macOS 仍会读取该字段；新版本忽略也不会影响 Windows 主路径。
      openAsHidden: enabled,
    };
  }
  return options;
}

function readElectronLaunchAtLoginState() {
  if (!launchAtLoginSupported()) {
    return {
      supported: false,
      openAtLogin: false,
      detail: null,
      error: "",
    };
  }
  try {
    const detail = app.getLoginItemSettings(loginItemQueryOptions());
    return {
      supported: true,
      openAtLogin: !!(detail && detail.openAtLogin),
      detail,
      error: "",
    };
  } catch (error) {
    return {
      supported: true,
      openAtLogin: false,
      detail: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function readLaunchAtLoginState() {
  const electronState = readElectronLaunchAtLoginState();
  if (process.platform !== "win32" || !electronState.supported) return electronState;
  const startupScript = readWindowsStartupScriptState();
  return {
    ...electronState,
    openAtLogin: electronState.openAtLogin || startupScript.enabled,
    detail: {
      ...(electronState.detail || {}),
      openCodexStartupScript: startupScript,
    },
  };
}

function applyElectronLaunchAtLoginSetting(openAtLogin) {
  if (!launchAtLoginSupported()) {
    return {
      ok: false,
      error: launcherText("launcher.error.launchAtLoginUnsupported"),
    };
  }
  try {
    app.setLoginItemSettings(loginItemSettingsOptions(openAtLogin));
    return { ok: true, error: "" };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function applyWindowsLaunchAtLoginSetting(openAtLogin, options = {}) {
  const errors = [];
  const electronResult = applyElectronLaunchAtLoginSetting(openAtLogin);
  if (!electronResult.ok) errors.push(electronResult.error);

  const electronState = readElectronLaunchAtLoginState();
  if (openAtLogin && electronState.openAtLogin) {
    await applyWindowsStartupScriptSetting(false, { allowElevated: false });
    return { ok: true, error: "" };
  }

  const scriptResult = await applyWindowsStartupScriptSetting(openAtLogin, {
    allowElevated: !!options.allowElevated,
  });
  if (!scriptResult.ok) errors.push(scriptResult.error);

  const current = readLaunchAtLoginState();
  if (openAtLogin && current.openAtLogin) return { ok: true, error: "" };
  if (!openAtLogin && !current.openAtLogin && !readWindowsStartupScriptState().present) return { ok: true, error: "" };

  return {
    ok: false,
    error: launcherText("launcher.error.launchAtLoginApplyFailed", {
      error: errors.filter(Boolean).join("; ") || launcherText("launcher.error.launchAtLoginVerifyFailed"),
    }),
  };
}

async function applyLaunchAtLoginSetting(openAtLogin, options = {}) {
  if (process.platform === "win32") {
    return applyWindowsLaunchAtLoginSetting(openAtLogin, options);
  }
  return applyElectronLaunchAtLoginSetting(openAtLogin);
}

async function syncLaunchAtLoginWithSettings(settings) {
  if (!launchAtLoginSupported()) return;
  const current = readLaunchAtLoginState();
  // 系统登录项是开机自启的事实源；这里只修复“用户在启动器里开启过，但系统项丢失”的情况。
  if (current.error || current.openAtLogin || !(settings && settings.launchAtLogin)) return;
  const result = await applyLaunchAtLoginSetting(!!settings.launchAtLogin, { allowElevated: false });
  if (!result.ok) gatewayState.lastError = result.error;
}

async function initializeLauncherSettings() {
  const paths = runtimePaths();
  ensureRuntimeLayout(paths);
  gatewayState.paths = paths;
  gatewayState.settings = loadLauncherSettings(paths);
  await syncLaunchAtLoginWithSettings(gatewayState.settings);
  return gatewayState.settings;
}

function shouldStartHidden() {
  if (process.argv.includes(START_HIDDEN_ARG)) return true;
  const loginItemState = readLaunchAtLoginState();
  return !!(loginItemState.detail && (loginItemState.detail.wasOpenedAtLogin || loginItemState.detail.wasOpenedAsHidden));
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
  const launchAtLogin = readLaunchAtLoginState();
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
    settings: {
      ...(gatewayState.settings || defaultSettings()),
      launchAtLogin: launchAtLogin.supported
        ? launchAtLogin.openAtLogin
        : false,
    },
    platform: {
      launchAtLoginSupported: launchAtLogin.supported,
    },
    auth: {
      enabled: gatewayState.paths ? readAuthEnabled(gatewayState.paths.configPath) : false,
    },
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

function canOpenOpenCodex() {
  return !!gatewayState.child && !gatewayState.child.killed && !!gatewayState.primaryUrl;
}

function openOpenCodex() {
  if (canOpenOpenCodex()) shell.openExternal(gatewayState.primaryUrl);
  return buildState();
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
    appendLog(`[launcher] official Electron runtime prepare failed: ${gatewayState.lastError}\n`);
    broadcastState();
    return buildState();
  }

  const officialUserDataDir = path.join(paths.runtimeDir, "official-user-data");
  const officialRuntimeArgs = [`--user-data-dir=${officialUserDataDir}`];
  const child = spawn(officialRuntime.executablePath, officialRuntimeArgs, {
    cwd: APP_ROOT,
    env: {
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
    },
    // 第 4 个 fd 是生命周期 pipe：launcher 退出时 OS 会关闭写端，gateway watchdog 会自杀。
    stdio: ["ignore", "pipe", "pipe", "pipe"],
  });

  gatewayState.child = child;

  child.stdout.on("data", (chunk) => appendLog(`[gateway] ${chunk.toString()}`));
  child.stderr.on("data", (chunk) => appendLog(`[gateway:err] ${chunk.toString()}`));
  child.on("error", (error) => {
    gatewayState.lastError = error instanceof Error ? error.message : String(error);
    appendLog(`[launcher] gateway spawn error: ${gatewayState.lastError}\n`);
    broadcastState();
  });
  child.on("exit", (code, signal) => {
    appendLog(`[launcher] gateway exited: code=${code} signal=${signal}\n`);
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

function hideLauncherWindowToTray() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    // 隐藏到托盘时从任务栏移除，避免用户看到一个不可交互的最小化窗口残留。
    if (typeof mainWindow.setSkipTaskbar === "function") mainWindow.setSkipTaskbar(true);
  } catch {}
  mainWindow.hide();
  hideLauncherDockIconForTray();
  updateTrayMenu();
}

function launcherShouldMinimizeToTray() {
  const settings = gatewayState.settings || defaultSettings();
  return !!settings.minimizeToTray;
}

function createWindow(options = {}) {
  // Windows/Linux 默认会显示 Electron 应用菜单；启动器不需要菜单栏，创建窗口前统一关闭。
  Menu.setApplicationMenu(null);
  const startHidden = !!options.startHidden;
  if (!startHidden) void showLauncherDockIcon();
  mainWindow = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 820,
    minHeight: 600,
    title: "OpenCodex",
    backgroundColor: "#f7f6f2",
    autoHideMenuBar: true,
    show: !startHidden,
    skipTaskbar: startHidden,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "index.html"));
  mainWindow.setMenuBarVisibility(false);
  mainWindow.on("minimize", (event) => {
    if (!launcherShouldMinimizeToTray()) return;
    event.preventDefault();
    hideLauncherWindowToTray();
  });
  mainWindow.on("show", () => {
    try {
      mainWindow.setSkipTaskbar(false);
    } catch {}
  });
  mainWindow.on("close", (event) => {
    if (isQuitting || !launcherShouldMinimizeToTray()) return;
    event.preventDefault();
    hideLauncherWindowToTray();
  });
  mainWindow.on("closed", () => {
    // 窗口允许真正关闭；后台驻留由托盘对象和 app 生命周期负责，之后需要时再重建窗口。
    mainWindow = null;
    hideLauncherDockIconIfWindowless();
    updateTrayMenu();
  });
  if (startHidden) hideLauncherDockIconForTray();
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
  hideLauncherDockIconForTray();
}

function hideLauncherDockIconForTray() {
  if (process.platform !== "darwin") return;
  try {
    // macOS 进入托盘后台模式后只保留菜单栏托盘图标，避免 Dock 里留下无窗口应用图标。
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
  try {
    if (typeof mainWindow.setSkipTaskbar === "function") mainWindow.setSkipTaskbar(false);
  } catch {}
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
ipcMain.handle("launcher:open-logs", () => {
  if (gatewayState.paths) revealPath(gatewayState.paths.logPath);
  return buildState();
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
ipcMain.handle("launcher:update-minimize-to-tray", (_event, value) => {
  const paths = runtimePaths();
  ensureRuntimeLayout(paths);
  gatewayState.paths = paths;
  gatewayState.settings = saveLauncherSettings(paths, {
    ...(gatewayState.settings || loadLauncherSettings(paths)),
    minimizeToTray: !!value,
  });
  broadcastState();
  return buildState();
});
ipcMain.handle("launcher:update-launch-at-login", async (_event, value) => {
  const paths = runtimePaths();
  ensureRuntimeLayout(paths);
  gatewayState.paths = paths;
  const nextLaunchAtLogin = !!value;
  const previousSettings = gatewayState.settings || loadLauncherSettings(paths);
  const result = await applyLaunchAtLoginSetting(nextLaunchAtLogin, { allowElevated: true });
  if (!result.ok) {
    gatewayState.lastError = result.error;
    broadcastState();
    return buildState();
  }
  gatewayState.settings = saveLauncherSettings(paths, {
    ...previousSettings,
    launchAtLogin: nextLaunchAtLogin,
  });
  gatewayState.lastError = "";
  broadcastState();
  return buildState();
});
ipcMain.handle("launcher:update-password", async (_event, password) => {
  const paths = runtimePaths();
  ensureRuntimeLayout(paths);
  gatewayState.paths = paths;
  writeAuthConfig(paths, password);
  return restartGateway();
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    void showLauncherWindow();
  });

  app.whenReady().then(async () => {
    await initializeLauncherSettings();
    createWindow({ startHidden: shouldStartHidden() });
    createLauncherTray();
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
  });
}
