const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  GATEWAY_RESTART_EXIT_CODE,
  GATEWAY_RESTART_SUPPORTED_ENV,
  createGatewayExitHandler,
  createSingleFlightGatewayStarter,
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

test("exit supervisor reports state before restarting and ignores ordinary exits", () => {
  const events = [];
  let stopping = false;
  const handleExit = createGatewayExitHandler({
    isStopping: () => stopping,
    onExit(value) {
      events.push(["exit", value]);
    },
    onRestart(value) {
      events.push(["restart", value]);
    },
  });

  assert.equal(handleExit(GATEWAY_RESTART_EXIT_CODE, null), true);
  assert.deepEqual(events, [
    ["exit", { code: GATEWAY_RESTART_EXIT_CODE, signal: null, restartRequested: true }],
    ["restart", { code: GATEWAY_RESTART_EXIT_CODE, signal: null }],
  ]);

  events.length = 0;
  assert.equal(handleExit(1, null), false);
  assert.deepEqual(events, [["exit", { code: 1, signal: null, restartRequested: false }]]);

  events.length = 0;
  stopping = true;
  assert.equal(handleExit(GATEWAY_RESTART_EXIT_CODE, null), false);
  assert.deepEqual(events, [
    ["exit", { code: GATEWAY_RESTART_EXIT_CODE, signal: null, restartRequested: false }],
  ]);
});

test("single-flight starter shares an in-progress launch and permits a later retry", async () => {
  let startCount = 0;
  let releaseStart = null;
  const startGateway = createSingleFlightGatewayStarter(
    () =>
      new Promise((resolve) => {
        startCount += 1;
        releaseStart = resolve;
      })
  );

  const first = startGateway();
  const second = startGateway();
  assert.strictEqual(first, second);
  assert.equal(startCount, 0);

  // Promise.resolve().then(start) 会在微任务中执行，先让启动任务真正进入 pending 状态。
  await Promise.resolve();
  assert.equal(startCount, 1);
  releaseStart("started");
  assert.deepEqual(await Promise.all([first, second]), ["started", "started"]);

  const third = startGateway();
  await Promise.resolve();
  assert.equal(startCount, 2);
  releaseStart("restarted");
  assert.equal(await third, "restarted");
});

test("launcher and dev runner wire restart supervision without background polling regressions", () => {
  const root = path.resolve(__dirname, "..", "..");
  const launcherSource = fs.readFileSync(path.join(root, "launcher", "main.cjs"), "utf8");
  const devRunnerSource = fs.readFileSync(path.join(root, "gateway", "dev", "run-gateway.cjs"), "utf8");
  const officialRunnerSource = fs.readFileSync(
    path.join(root, "gateway", "runner", "shared", "runner-source.cjs"),
    "utf8"
  );

  // 两条标准启动路径共享已通过行为测试的退出处理器，避免重复实现退出码分支。
  for (const source of [launcherSource, devRunnerSource]) {
    assert.match(source, /GATEWAY_RESTART_SUPPORTED_ENV/);
    assert.match(source, /createGatewayExitHandler/);
  }
  // Launcher 的异步启动和完整重启都必须 single-flight，迟到的旧子进程不能覆盖新实例。
  assert.match(launcherSource, /createSingleFlightGatewayStarter/);
  assert.match(launcherSource, /let gatewayStartPromise = null/);
  assert.match(launcherSource, /gatewayStartPromise = currentStart/);
  assert.match(launcherSource, /let gatewayRestartPromise = null/);
  assert.match(launcherSource, /if \(gatewayRestartPromise\) return gatewayRestartPromise/);
  assert.match(launcherSource, /gatewayState\.child !== child/);
  // 状态探活只服务于可见 Launcher 窗口，并且请求 single-flight，托盘驻留不能永久轮询。
  assert.match(launcherSource, /function launcherWindowNeedsStatusPolling\(\)/);
  assert.match(launcherSource, /mainWindow\.isVisible\(\)/);
  assert.match(launcherSource, /if \(statusRefreshPromise\) return statusRefreshPromise/);
  assert.match(launcherSource, /GATEWAY_STATUS_TIMEOUT_MS/);
  assert.match(launcherSource, /timedOut = true/);
  assert.match(launcherSource, /mainWindow\.on\("hide", stopStatusPolling\)/);
  assert.match(launcherSource, /mainWindow\.on\("minimize", stopStatusPolling\)/);
  // 兼容报告失败只能影响诊断状态，不能把已经成功的 Runner 误判成启动失败。
  assert.match(launcherSource, /function writeRunnerCompatibilityReportSafely/);
  assert.match(
    launcherSource,
    /gatewayState\.officialRuntime = officialRuntime;\s+writeRunnerCompatibilityReportSafely\(paths, officialRuntime\)/
  );
  // 调试页沿用主入口的 localhost 域，才能复用现有认证 Cookie。
  assert.match(
    launcherSource,
    /ipcMain\.handle\("launcher:open-runtime-compatibility", \(\) => \{\s+const openUrl = openOpenCodexUrl\(\)/
  );
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
