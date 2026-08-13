const fs = require("node:fs");
const path = require("node:path");

const UNUSED_HIDDEN_RUNTIME_FEATURES = ["PushMessaging"];
const UNUSED_HIDDEN_RUNTIME_BLINK_FEATURES = ["PushMessaging"];
const HIDDEN_RUNTIME_GCM_HOLD_PATH = "/__opencodex-internal/gcm-checkin-hold";
const HIDDEN_RUNTIME_GCM_STORE_BACKUP = "GCM Store.opencodex-disabled";

function appendMergedSwitch(commandLine, name, additions) {
  const existing =
    typeof commandLine.getSwitchValue === "function"
      ? String(commandLine.getSwitchValue(name) || "")
      : "";
  const values = new Set(
    existing
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  );
  for (const addition of additions) values.add(addition);
  const merged = Array.from(values);
  commandLine.appendSwitch(name, merged.join(","));
  return merged;
}

function configureHiddenRuntimeEnvironment(env = process.env) {
  if (!env || typeof env !== "object") return {};
  // 隐藏 runner 是只读官方运行时副本，不能由 Sparkle 原地更新；OpenCodex 自身升级仍由 launcher 发布链路负责。
  env.CODEX_SPARKLE_ENABLED = "false";
  return { CODEX_SPARKLE_ENABLED: env.CODEX_SPARKLE_ENABLED };
}

function hiddenRuntimeGcmStorePaths(profilePath, fileSystem = fs) {
  const storePaths = [path.join(profilePath, "GCM Store")];
  const partitionsPath = path.join(profilePath, "Partitions");
  try {
    for (const entry of fileSystem.readdirSync(partitionsPath, { withFileTypes: true })) {
      // 官方 browser partition 也各自维护 GCM 凭据；只扫描一级真实目录，避免跟随链接越出隔离 profile。
      if (!entry.isDirectory()) continue;
      storePaths.push(path.join(partitionsPath, entry.name, "GCM Store"));
    }
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
  }
  return storePaths;
}

function isolateHiddenRuntimeGcmStoresForUserData(userDataPath, fileSystem = fs) {
  if (!userDataPath) return { isolated: false, reason: "missing-user-data" };
  try {
    const profilePath = path.join(userDataPath, "Default");
    let backedUpCount = 0;
    let removedCount = 0;
    for (const storePath of hiddenRuntimeGcmStorePaths(profilePath, fileSystem)) {
      if (!fileSystem.existsSync(storePath)) continue;
      const backupPath = path.join(path.dirname(storePath), HIDDEN_RUNTIME_GCM_STORE_BACKUP);
      fileSystem.mkdirSync(path.dirname(storePath), { recursive: true });
      if (!fileSystem.existsSync(backupPath)) {
        // 每个 profile/partition 首次升级都保留原数据以便回滚；后续产生的空缓存才直接丢弃。
        fileSystem.renameSync(storePath, backupPath);
        backedUpCount += 1;
        continue;
      }
      fileSystem.rmSync(storePath, { force: true, recursive: true });
      removedCount += 1;
    }
    const reason = backedUpCount > 0
      ? "store-backed-up"
      : removedCount > 0
        ? "transient-store-removed"
        : "store-absent";
    return { backedUpCount, isolated: true, reason, removedCount };
  } catch (error) {
    return {
      isolated: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function isolateHiddenRuntimeGcmStore(app, fileSystem = fs) {
  if (!app || typeof app.getPath !== "function") return { isolated: false, reason: "missing-user-data" };
  try {
    return isolateHiddenRuntimeGcmStoresForUserData(app.getPath("userData"), fileSystem);
  } catch (error) {
    return {
      isolated: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function hiddenRuntimeGcmHoldUrl(env = process.env) {
  // 与 gateway/core/config 的默认端口保持一致；只有显式非法值才退到不会误连其它服务的 discard 端口。
  const rawPort = env?.PORT == null || env.PORT === "" ? 3737 : env.PORT;
  const port = Number(rawPort);
  const safePort = Number.isInteger(port) && port > 0 && port <= 65535 ? port : 9;
  return `http://127.0.0.1:${safePort}${HIDDEN_RUNTIME_GCM_HOLD_PATH}`;
}

function hiddenRuntimeGcmCommandLineArgs(env = process.env) {
  const holdUrl = hiddenRuntimeGcmHoldUrl(env);
  /**
   * 隐藏 runner 不承载浏览器后台服务；Chromium 官方的 background-networking 开关会关闭更新、
   * 预测等非页面请求。它与 GCM 端点都必须在进程创建前进入 argv，main 阶段再追加可能已经太晚。
   */
  return [
    "--disable-background-networking",
    `--gcm-checkin-url=${holdUrl}`,
    `--gcm-mcs-endpoint=${holdUrl}`,
    `--gcm-registration-url=${holdUrl}`,
  ];
}

function configureHiddenRuntimeCommandLine(app, env = process.env) {
  const commandLine = app?.commandLine;
  if (!commandLine || typeof commandLine.appendSwitch !== "function") return [];

  // 隐藏 renderer 不接收 Web Push；浏览器通知由远程浏览器自己处理，服务端事件继续走既有 WebSocket。
  const disabledFeatures = appendMergedSwitch(
    commandLine,
    "disable-features",
    UNUSED_HIDDEN_RUNTIME_FEATURES
  );
  // PushMessaging 同时存在 Blink 运行时门；两层都关闭，避免 renderer API 重新唤醒 GCM 注册服务。
  appendMergedSwitch(commandLine, "disable-blink-features", UNUSED_HIDDEN_RUNTIME_BLINK_FEATURES);
  // Chromium 明确定义该开关同时关闭 Web Notification 与 Push API；Electron Main 的通知桥不受影响。
  commandLine.appendSwitch("disable-notifications");
  // 官方该开关只抑制浏览器自身的后台子系统，普通页面请求和 App Server 网络仍按原链路运行。
  commandLine.appendSwitch("disable-background-networking");
  /**
   * Chromium 151 的企业策略 invalidation 会绕过 PushMessaging，且官方没有完全关闭 GCM
   * 的开关。隐藏 profile 不消费浏览器推送：启动前隔离既有凭据，再把首次 check-in 挂到
   * gateway 的本机静默端点，使 GCM 保持未就绪且无重试；MCS/注册地址也限制到本机作为兜底。
   */
  isolateHiddenRuntimeGcmStore(app);
  const gcmHoldUrl = hiddenRuntimeGcmHoldUrl(env);
  commandLine.appendSwitch("gcm-checkin-url", gcmHoldUrl);
  commandLine.appendSwitch("gcm-mcs-endpoint", gcmHoldUrl);
  commandLine.appendSwitch("gcm-registration-url", gcmHoldUrl);
  return disabledFeatures;
}

module.exports = {
  UNUSED_HIDDEN_RUNTIME_FEATURES,
  UNUSED_HIDDEN_RUNTIME_BLINK_FEATURES,
  HIDDEN_RUNTIME_GCM_HOLD_PATH,
  HIDDEN_RUNTIME_GCM_STORE_BACKUP,
  configureHiddenRuntimeCommandLine,
  configureHiddenRuntimeEnvironment,
  hiddenRuntimeGcmStorePaths,
  hiddenRuntimeGcmCommandLineArgs,
  hiddenRuntimeGcmHoldUrl,
  isolateHiddenRuntimeGcmStore,
  isolateHiddenRuntimeGcmStoresForUserData,
};
