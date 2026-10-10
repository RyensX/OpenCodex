// relay-config.cjs
// 反向隧道客户端的运行配置，全部来自环境变量（不引入 js-yaml，不改 YAML 解析器）。
// 这样 OpenCodex 本身完全无感，只在 env 打开时才激活反连。

function readRelayConfig() {
  const enabled = process.env.OCX_RELAY_ENABLED === "1";
  const url = String(process.env.OCX_RELAY_URL || "").trim();
  const secret = String(process.env.OCX_RELAY_SECRET || "").trim();
  const deviceName = String(
    process.env.OCX_RELAY_DEVICE_NAME ||
      process.env.OCX_DEVICE_NAME ||
      process.env.COMPUTERNAME ||
      process.env.HOSTNAME ||
      "device"
  ).trim();
  // 设备身份与访问路径分别接收，不再用随机后缀冒充设备 MAC。
  const deviceId = String(process.env.OCX_RELAY_DEVICE_ID || "").trim().toLowerCase();
  const accessPath = String(process.env.OCX_RELAY_ACCESS_PATH || "").trim();
  if (enabled && (!/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(deviceId) || !/^[a-z0-9][a-z0-9_-]{1,31}$/.test(accessPath))) {
    throw new Error("中继配置需要设备 MAC 和独立访问后缀");
  }
  let localPort = 3737;
  try {
    localPort = Number(require("../core/config.cjs").PORT) || 3737;
  } catch {}
  // 隧道配置只描述设备连接；Gateway 密码由访问它的浏览器分别校验。
  return {
    enabled,
    url,
    secret,
    deviceId,
    accessPath,
    deviceName,
    localHost: "127.0.0.1",
    localPort,
  };
}

module.exports = { readRelayConfig };
