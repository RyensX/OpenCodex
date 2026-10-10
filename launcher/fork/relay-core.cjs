// launcher/fork/relay-core.cjs
// [OCX-FORK] 服务器中继（反连隧道）的全部可独立逻辑，集中在此单文件。
// 目标：fork 合并 upstream 时，原 launcher/main.cjs 只保留极薄的调用点（见各 [OCX-FORK] 标记），
// 业务改动都发生在这个 upstream 没有的新文件里，冲突面最小。
//
// 依赖注入约定：本文件不 require launcher/main.cjs（避免循环依赖），
// 一切来自 main.cjs 的函数（saveLauncherSettings / readAuthEnabled / appendLog 等）
// 都通过 createRelayCore(deps) 传入；纯函数（normalize 系列 / URL 拼接）在模块级直接导出。

// 显式使用 Node.js 随机源生成访问后缀；设备身份来自网卡 MAC。
const crypto = require("node:crypto");
const os = require("node:os");

// ---------- 纯函数（无外部依赖） ----------

// 与 main.cjs 的 normalizeHostMode 语义保持一致（upstream 原有函数，这里独立副本避免反向依赖）。
function hostModeOf(value) {
  if (value === "lan") return "lan";
  if (value === "server") return "server";
  return "local";
}

// 与 main.cjs 的 normalizePort 语义保持一致（upstream 原有函数的独立副本）。
function normalizePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return port;
}

function normalizeRelayString(value) {
  return String(value || "").trim();
}

// UI 只让用户填 IP；这里容错处理直接粘贴完整地址的情况，自动抽取纯主机部分。
function normalizeRelayHost(value) {
  let text = String(value || "").trim();
  if (!text) return "";
  text = text.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "");
  text = text.split(/[/?#]/)[0];
  if (text.includes("@")) text = text.slice(text.lastIndexOf("@") + 1);
  if (!text.includes("]")) text = text.split(":")[0];
  return text.trim();
}

// 端口留空或非法时回退到默认 8443。
function normalizeRelayPort(value) {
  const port = normalizePort(value);
  return port || 8443;
}

// 自定义访问后缀：小写字母/数字开头，允许小写字母、数字、中划线、下划线，长度 2-32。
// 留空表示使用首次生成并保存的随机访问后缀；访问协议由 HTTPS 开关决定。
function normalizeRelayPath(value) {
  const text = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-");
  if (!text) return "";
  if (!/^[a-z0-9][a-z0-9_-]{1,31}$/.test(text)) return "";
  return text;
}

// settings 的 relay 字段默认值（defaultSettings / load / save 三处共用同一份 schema）。
const RELAY_DEFAULT_FIELDS = Object.freeze({
  relayHost: "",
  relayPort: 8443,
  relaySecret: "",
  relayDeviceId: "",
  relayAccessPath: "",
  relayDeviceName: "",
  relayCustomPath: "",
  relayUseHttps: false,
});

// 对任意来源（磁盘 JSON / 内存 settings / IPC 入参）的 relay 字段做统一 normalize。
// 兼容 v3 的 relayUrl（完整地址）——relayHost 缺失时自动从 relayUrl 抽取主机。
function normalizeRelayFields(source) {
  const src = source && typeof source === "object" ? source : {};
  return {
    relayHost: normalizeRelayHost(src.relayHost || src.relayUrl),
    relayPort: normalizeRelayPort(src.relayPort),
    relaySecret: normalizeRelayString(src.relaySecret),
    relayDeviceId: normalizeRelayString(src.relayDeviceId),
    relayAccessPath: normalizeRelayPath(src.relayAccessPath),
    relayDeviceName: normalizeRelayString(src.relayDeviceName),
    relayCustomPath: normalizeRelayPath(src.relayCustomPath),
    // HTTPS 必须明确开启，缺省和未勾选均使用 HTTP。
    relayUseHttps: src.relayUseHttps === true,
  };
}

// 服务器模式顶部访问地址：VPS 统一入口里本机设备的页面。
// 自定义后缀优先于默认随机后缀；MAC 仅作为设备身份，不能用作默认访问地址。
// 返回 null 表示非服务器模式或信息不全，调用方回退原有 LAN/local 逻辑。
function relayPrimaryUrl(settings) {
  const relay = settings || {};
  const relayHost = normalizeRelayHost(relay.relayHost);
  if (hostModeOf(relay.hostMode) !== "server" || !relayHost) return null;
  const accessId = normalizeRelayPath(relay.relayCustomPath) || normalizeRelayPath(relay.relayAccessPath);
  if (!accessId) return null;
  // 页面协议与反连协议使用同一个持久化开关。
  const protocol = relay.relayUseHttps === true ? "https" : "http";
  return `${protocol}://${relayHost}:${normalizeRelayPort(relay.relayPort)}/d/${encodeURIComponent(accessId)}/`;
}

// 「打开 OpenCodex」按钮在服务器模式下的行为判定：返回应打开的 URL，或 null（走原有流程）。
function relayServerEntryUrl(settings, primaryUrl) {
  const relay = settings || {};
  const relayHost = normalizeRelayHost(relay.relayHost);
  const relayDeviceId = normalizeRelayString(relay.relayDeviceId);
  if (hostModeOf(relay.hostMode) === "server" && relayHost && relayDeviceId && primaryUrl) {
    return primaryUrl;
  }
  return null;
}

// ---------- 需要注入 main.cjs 依赖的部分 ----------

function createRelayCore(deps) {
  const { saveLauncherSettings } = deps;

  // MAC 与访问后缀分别持久化：前者标识设备，后者用于浏览器访问。
  // 返回值可能经过 saveLauncherSettings 落盘，与原 main.cjs 内嵌版本行为一致。
  function ensureRelayIdentity(paths, settings) {
    const merged = { ...settings };
    let dirty = false;
    if (!normalizeRelayPath(merged.relayAccessPath)) {
      // 保留此前误写到设备 ID 中的随机后缀，避免修正身份时再次改变访问地址。
      const previousId = normalizeRelayString(merged.relayDeviceId);
      merged.relayAccessPath = /^[0-9a-f]{16}$/.test(previousId)
        ? previousId
        : crypto.randomBytes(8).toString("hex");
      dirty = true;
    }
    if (!/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(normalizeRelayString(merged.relayDeviceId))) {
      // 优先恢复此前保存的 MAC；不存在时选取物理网卡，不用随机值冒充设备。
      const oldMac = /^pc-([0-9a-f]{12})$/.exec(normalizeRelayString(merged.relayDeviceId));
      const interfaces = os.networkInterfaces();
      const candidates = [];
      const virtualCandidates = [];
      for (const name of Object.keys(interfaces).sort()) {
        for (const item of interfaces[name] || []) {
          if (item.internal || !item.mac || item.mac === "00:00:00:00:00:00") continue;
          if (/^(00:15:5d|00:05:69|00:0c:29|00:1c:14|08:00:27|0a:00:27|00:50:56|00:1c:42|02:00:4c|02:42:ac):/i.test(item.mac)) {
            // 虚拟机没有物理网卡时仍使用实际 MAC，不能退回随机设备身份。
            virtualCandidates.push(item.mac.toLowerCase());
            continue;
          }
          candidates.push(item.mac.toLowerCase());
        }
      }
      const macPairs = oldMac ? oldMac[1].match(/../g) : null;
      const deviceMac = macPairs ? macPairs.join(":") : candidates[0] || virtualCandidates[0];
      if (!deviceMac) throw new Error("未找到可用的网卡 MAC，无法确定中继设备身份");
      merged.relayDeviceId = deviceMac;
      dirty = true;
    }
    if (!normalizeRelayString(merged.relayDeviceName)) {
      merged.relayDeviceName = os.hostname() || merged.relayDeviceId;
      dirty = true;
    }
    if (!dirty) return merged;
    return saveLauncherSettings(paths, merged);
  }

  // 服务器模式：把 relay 配置转译为 OCX_RELAY_* 环境变量（gateway 启动后反连 VPS）。
  // 网关只在本地监听（relay 负责把流量推出去），未填服务器地址时回退本机模式避免起不来。
  // 返回 null 表示非服务器模式（调用方跳过）；否则返回 { env, settings }——settings 可能已被
  // ensureRelayIdentity 补齐身份字段并落盘，调用方需要写回 gatewayState.settings。
  function relayChildEnv(settings, paths) {
    if (hostModeOf(settings && settings.hostMode) !== "server") return null;
    const next = ensureRelayIdentity(paths, settings);
    const relay = next || {};
    const env = {};
    const relayHost = normalizeRelayHost(relay.relayHost);
    const relayCustomPath = normalizeRelayPath(relay.relayCustomPath);
    if (relayHost) {
      env.OCX_RELAY_ENABLED = "1";
      // UI 只填 IP + 端口，完整反连地址统一在这里拼接。
      const protocol = relay.relayUseHttps === true ? "wss" : "ws";
      env.OCX_RELAY_URL = `${protocol}://${relayHost}:${normalizeRelayPort(relay.relayPort)}/openCodeProxy`;
      if (relay.relaySecret) env.OCX_RELAY_SECRET = relay.relaySecret;
      // 注册身份始终使用 MAC；访问后缀单独传递，修改地址不改变设备身份。
      env.OCX_RELAY_DEVICE_ID = normalizeRelayString(relay.relayDeviceId);
      env.OCX_RELAY_ACCESS_PATH = relayCustomPath || normalizeRelayPath(relay.relayAccessPath);
      if (relay.relayDeviceName) env.OCX_RELAY_DEVICE_NAME = relay.relayDeviceName;
    } else {
      env.HOST = "127.0.0.1";
    }
    return { env, settings: next };
  }

  // launcher:update-relay IPC handler。deps 全部来自 main.cjs（清单见 FORK-NOTES.md）。
  function createRelayIpcHandler(handlerDeps) {
    const {
      appendLog,
      runtimePaths,
      ensureRuntimeLayout,
      gatewayState,
      loadLauncherSettings,
      readAuthEnabled,
      restartGateway,
    } = handlerDeps;
    return async function handleUpdateRelay(_event, relay) {
      const relayInput = relay && typeof relay === "object" ? relay : {};
      appendLog(
        `[launcher] update-relay invoked host=${relayInput.relayHost ? "<set>" : "<empty>"} port=${JSON.stringify(relayInput.relayPort)} secret=${relayInput.relaySecret ? "<set>" : "<empty>"} https=${relayInput.relayUseHttps} path=${JSON.stringify(relayInput.relayCustomPath || "")}\n`
      );
      const paths = runtimePaths();
      ensureRuntimeLayout(paths);
      gatewayState.paths = paths;
      // 保存表单只覆盖可编辑连接项，设备身份从当前持久化设置取得。
      const currentSettings = gatewayState.settings || loadLauncherSettings(paths);
      const merged = {
        ...currentSettings,
        ...normalizeRelayFields(relayInput),
        // UI 不提交设备码；保存面板时沿用已持久化的身份，且不允许 IPC 替换它。
        relayDeviceId: normalizeRelayString(currentSettings.relayDeviceId),
        // 默认随机后缀不是可编辑表单项，保存其他连接项时保留它。
        relayAccessPath: normalizeRelayPath(currentSettings.relayAccessPath),
      };
      // 服务器模式强制设置访问密码：自定义后缀的地址好记也可被猜测，公网入口必须有密码保护。
      if (
        hostModeOf(merged.hostMode) === "server" &&
        merged.relayHost &&
        !readAuthEnabled(paths.configPath)
      ) {
        throw new Error("服务器模式必须先设置访问密码（设置区的「访问密码」），再保存中继配置");
      }
      // 设备身份不接受表单替换；由网卡 MAC 确定，随机后缀另行保存。
      // 必须先把用户保存的中继配置显式落盘：ensureRelayIdentity 只在需要补身份字段
      // （dirty=true）时才写文件；设备 ID/名称已存在时它不会保存，若不在前面显式落盘，
      // restartGateway 会从磁盘读回旧配置覆盖内存态，表现为「保存即清空」。
      gatewayState.settings = ensureRelayIdentity(paths, saveLauncherSettings(paths, merged));
      return restartGateway();
    };
  }

  return {
    ensureRelayIdentity,
    relayChildEnv,
    createRelayIpcHandler,
  };
}

module.exports = {
  createRelayCore,
  // 纯函数直接导出，方便测试与 renderer 侧复用。
  hostModeOf,
  normalizeRelayString,
  normalizeRelayHost,
  normalizeRelayPort,
  normalizeRelayPath,
  normalizeRelayFields,
  RELAY_DEFAULT_FIELDS,
  relayPrimaryUrl,
  relayServerEntryUrl,
};
