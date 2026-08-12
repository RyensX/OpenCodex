function gatewayRunnerMainSource() {
  return `// 这个 runner 壳只负责把官方 Electron 运行时切到 OpenCodex gateway 入口。
const fs = require("fs");
const path = require("path");
const { app } = require("electron");

const entry = process.env.OPENCODEX_GATEWAY_ENTRY;
const gatewayAgentMode = process.env.OPENCODEX_GATEWAY_AGENT_MODE === "1";

if (!entry) {
  throw new Error("Missing OPENCODEX_GATEWAY_ENTRY for OpenCodex gateway runtime runner");
}

try {
  /**
   * gateway 的网络由 Node HTTP/WS/app-server 承载，不使用 Chromium 后台同步/GCM。
   * 关闭这组后台网络任务可避免隐藏 runtime 周期注册已废弃的 push endpoint；不影响网页端通知桥接。
   */
  app.commandLine.appendSwitch("disable-background-networking");
} catch {}

function hideGatewayDockIcon() {
  if (process.platform !== "darwin") return;
  if (gatewayAgentMode) return;
  try {
    // runner 是后台 IPC 宿主，禁止作为前台 App 激活，避免 Dock / Cmd+Tab 出现第二个图标。
    if (typeof app.setActivationPolicy === "function") app.setActivationPolicy("prohibited");
  } catch {}
  try {
    if (app.dock && typeof app.dock.hide === "function") app.dock.hide();
  } catch {}
  try {
    if (typeof app.hide === "function") app.hide();
  } catch {}
}

function installDockVisibilityGuard() {
  if (process.platform !== "darwin" || app.__opencodexDockVisibilityGuardInstalled) return;
  if (gatewayAgentMode) return;
  app.__opencodexDockVisibilityGuardInstalled = true;
  if (app.dock && typeof app.dock.show === "function") {
    const originalShow = app.dock.show.bind(app.dock);
    app.dock.__opencodexOriginalShow = originalShow;
    app.dock.show = () => {
      // 官方 main 偶尔会按桌面应用路径触发 dock.show；后台 runner 一律吞掉并维持隐藏。
      hideGatewayDockIcon();
      return undefined;
    };
  }
  if (typeof app.setActivationPolicy === "function") {
    const originalSetActivationPolicy = app.setActivationPolicy.bind(app);
    app.__opencodexOriginalSetActivationPolicy = originalSetActivationPolicy;
    app.setActivationPolicy = (policy) => originalSetActivationPolicy(policy === "regular" ? "prohibited" : policy);
  }
  if (typeof app.show === "function") {
    const originalShowApp = app.show.bind(app);
    app.__opencodexOriginalShowApp = originalShowApp;
    app.show = () => {
      // 后台 runner 没有需要展示的应用级 UI；任何 show 都保持为隐藏状态。
      hideGatewayDockIcon();
      return undefined;
    };
  }
}

function scheduleDockHideRetries() {
  if (gatewayAgentMode) return;
  let remaining = 20;
  const timer = setInterval(() => {
    hideGatewayDockIcon();
    remaining -= 1;
    if (remaining <= 0) clearInterval(timer);
  }, 500);
  if (timer.unref) timer.unref();
}

if (!gatewayAgentMode) {
  installDockVisibilityGuard();
  hideGatewayDockIcon();
  scheduleDockHideRetries();
  app.on("will-finish-launching", hideGatewayDockIcon);
  app.whenReady().then(hideGatewayDockIcon).catch(() => {});
  app.on("ready", hideGatewayDockIcon);
  app.on("activate", hideGatewayDockIcon);
  app.on("browser-window-created", hideGatewayDockIcon);
}

// 尽早隔离隐藏 runtime 的 Chromium profile；核心数据仍然通过 CODEX_HOME 与官方 Codex 共享。
const userDataPath =
  process.env.CODEX_WEB_OFFICIAL_USER_DATA_DIR ||
  process.env.CODEX_ELECTRON_USER_DATA_PATH ||
  (process.env.CODEX_WEB_RUNTIME_DIR ? path.join(process.env.CODEX_WEB_RUNTIME_DIR, "official-user-data") : "");
if (userDataPath) {
  fs.mkdirSync(userDataPath, { recursive: true });
  process.env.CODEX_ELECTRON_USER_DATA_PATH = userDataPath;
  try {
    // --user-data-dir 需要尽早进入 Chromium 命令行；外层 spawn 也会传一份，这里作为 runner 入口兜底。
    app.commandLine.appendSwitch("user-data-dir", userDataPath);
  } catch {}
  try {
    app.setPath("userData", userDataPath);
  } catch {}
}

// 这条日志用于区分“Electron 启动前崩溃”和“gateway JS 初始化后崩溃”。
console.log("[official-electron-runner] loading gateway entry", entry);
require(entry);
`;
}

module.exports = {
  gatewayRunnerMainSource,
};
