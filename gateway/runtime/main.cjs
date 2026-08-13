if (process.versions && process.versions.electron) {
  // 官方 app.asar 已经抽取到缓存目录，gateway 运行时需要按普通文件访问资源。
  process.noAsar = true;
}

const { app } = require("electron");
const { installLauncherLifecycleWatchdog } = require("./lifecycle/launcher-lifecycle-watchdog.cjs");
const { installGatewayQuitConfirmationSuppressor, markGatewaySilentQuit } = require("./lifecycle/quit-confirmation-suppressor.cjs");
const {
  configureHiddenRuntimeCommandLine,
  configureHiddenRuntimeEnvironment,
} = require("./electron/hidden-runtime-command-line.cjs");

// 官方 main 加载前先关闭副本无法使用的更新器；Chromium 开关也必须在 app ready 前设置。
configureHiddenRuntimeEnvironment();
configureHiddenRuntimeCommandLine(app);
// 先应用 Chromium 开关再加载网关编排及其 Electron 依赖，防止未来模块初始化提前创建隐藏 renderer。
const { createGateway } = require("./server.cjs");

const gatewayAgentMode = process.env.OPENCODEX_GATEWAY_AGENT_MODE === "1";

function hideGatewayDockIcon() {
  if (process.platform !== "darwin") return;
  if (gatewayAgentMode) return;
  try {
    // gateway 是 launcher 拉起的后台 Electron 进程，macOS Dock / Cmd+Tab 里只应该保留 launcher 图标。
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
      // 官方 main 可能在窗口初始化后恢复 Dock；gateway 是后台宿主，直接拦截 show 并维持隐藏。
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
      // gateway 没有前台应用级 UI；官方 main 触发 show 时保持隐藏，避免 Dock 图标回弹。
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
  // 非 agent 模式是开发兜底路径，仍保留 JS 级隐藏；正式 runner 通过 LSBackgroundOnly 隐藏，不走这里。
  installDockVisibilityGuard();
  hideGatewayDockIcon();
  scheduleDockHideRetries();
  app.on("will-finish-launching", hideGatewayDockIcon);
  app.whenReady().then(hideGatewayDockIcon).catch(() => {});
  app.on("ready", hideGatewayDockIcon);
  app.on("activate", hideGatewayDockIcon);
  app.on("browser-window-created", hideGatewayDockIcon);
}

installGatewayQuitConfirmationSuppressor();
installLauncherLifecycleWatchdog({ app });

createGateway().catch((error) => {
  console.error("[gateway] fatal error", error);
  process.exitCode = 1;
  try {
    markGatewaySilentQuit("gateway_fatal_error");
    app.quit();
  } catch {}
});
