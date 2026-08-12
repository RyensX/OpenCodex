const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  GATEWAY_RESTART_EXIT_CODE,
  GATEWAY_RESTART_SUPPORTED_ENV,
  isGatewayRestartExit,
  isGatewayRestartSupported,
} = require("../../shared/gateway-lifecycle.cjs");

test("recognizes only the reserved clean exit as a gateway restart request", () => {
  assert.equal(isGatewayRestartExit(GATEWAY_RESTART_EXIT_CODE, null), true);
  assert.equal(isGatewayRestartExit(0, null), false);
  assert.equal(isGatewayRestartExit(GATEWAY_RESTART_EXIT_CODE, "SIGTERM"), false);
});

test("requires the supervisor capability flag before exposing remote restart", () => {
  assert.equal(isGatewayRestartSupported({ [GATEWAY_RESTART_SUPPORTED_ENV]: "1" }), true);
  assert.equal(isGatewayRestartSupported({ [GATEWAY_RESTART_SUPPORTED_ENV]: "0" }), false);
  assert.equal(isGatewayRestartSupported({}), false);
});

test("launcher and dev runner both wire the restart supervisor contract", () => {
  const root = path.resolve(__dirname, "..", "..");
  const launcherSource = fs.readFileSync(path.join(root, "launcher", "main.cjs"), "utf8");
  const devRunnerSource = fs.readFileSync(path.join(root, "gateway", "dev", "run-gateway.cjs"), "utf8");
  const officialRunnerSource = fs.readFileSync(
    path.join(root, "gateway", "runner", "shared", "runner-source.cjs"),
    "utf8"
  );

  // 两条标准启动路径都必须声明能力并识别退出码，否则 Web 按钮会把服务停在离线状态。
  for (const source of [launcherSource, devRunnerSource]) {
    assert.match(source, /GATEWAY_RESTART_SUPPORTED_ENV/);
    assert.match(source, /isGatewayRestartExit/);
  }
  // Launcher 有多个 UI/托盘入口，异步启动阶段必须使用 single-flight，旧子进程退出也不能清空新实例。
  assert.match(launcherSource, /let gatewayStartPromise = null/);
  assert.match(launcherSource, /if \(gatewayStartPromise\) return gatewayStartPromise/);
  assert.match(launcherSource, /let gatewayRestartPromise = null/);
  assert.match(launcherSource, /if \(gatewayRestartPromise\) return gatewayRestartPromise/);
  assert.match(launcherSource, /if \(gatewayState\.child === child\)/);
  // 状态探活只服务于可见 Launcher 窗口，并且请求 single-flight，托盘驻留不能永久轮询。
  assert.match(launcherSource, /function launcherWindowNeedsStatusPolling\(\)/);
  assert.match(launcherSource, /mainWindow\.isVisible\(\)/);
  assert.match(launcherSource, /if \(statusRefreshPromise\) return statusRefreshPromise/);
  assert.match(launcherSource, /GATEWAY_STATUS_TIMEOUT_MS/);
  assert.match(launcherSource, /timedOut = true/);
  assert.match(launcherSource, /mainWindow\.on\("hide", stopStatusPolling\)/);
  assert.match(launcherSource, /mainWindow\.on\("minimize", stopStatusPolling\)/);
  // 隐藏 Electron 只承载本地 IPC；Chromium GCM/后台同步必须关闭，避免周期网络唤醒。
  assert.match(officialRunnerSource, /appendSwitch\("disable-background-networking"\)/);
  const staticAssetSource = fs.readFileSync(
    path.join(root, "gateway", "runtime", "http", "static-assets.cjs"),
    "utf8"
  );
  // 大资源 worker 只承担冷启动任务，空闲后必须主动释放而不是常驻额外 isolate。
  assert.match(staticAssetSource, /OFFICIAL_ASSET_PATCH_WORKER_IDLE_MS/);
  assert.match(staticAssetSource, /void worker\.terminate\(\)\.catch/);

  const serverSource = fs.readFileSync(path.join(root, "gateway", "runtime", "server.cjs"), "utf8");
  // 诊断与统一 IPC 都会缓冲 JSON body，必须在进入 JSON.parse 前执行硬上限。
  assert.match(serverSource, /readBody\(req, \{ maxBytes: CLIENT_LOG_BODY_MAX_BYTES \}\)/);
  assert.match(serverSource, /readBody\(req, \{ maxBytes: IPC_INVOKE_BODY_MAX_BYTES \}\)/);
  assert.match(serverSource, /CODEX_WEB_PICKED_FILES_MAX_TOTAL_BYTES \* 4/);
});
