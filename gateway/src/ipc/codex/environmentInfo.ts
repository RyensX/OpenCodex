// @ts-nocheck
export {};

const os = require("os");

const DEFAULT_LOCALE = process.env.CODEX_WEB_LOCALE || "zh-CN";

/** chronicle-permissions IPC：Web环境不能读取 Electron sidecar/TCC 权限，只返回明确的禁用状态。 */
function chroniclePermissionsStatus() {
  return {
    accessibility: "unknown",
    screenRecording: "unknown",
    chronicleSidecarPresent: false,
    chronicleSidecarProcessState: "disabled",
  };
}

/** os-info IPC 的 Web 版本机信息。 */
function buildOsInfo() {
  return {
    platform: process.platform,
    arch: process.arch,
    release: os.release(),
    hostname: os.hostname(),
    type: os.type(),
    web: true,
  };
}

/** locale-info IPC 返回运行 gateway 机器的 locale/timeZone。 */
function buildLocaleInfo() {
  const options = Intl.DateTimeFormat().resolvedOptions();
  const locale = DEFAULT_LOCALE || options.locale || "zh-CN";
  return {
    locale,
    ideLocale: locale,
    systemLocale: locale,
    timeZone: options.timeZone || "UTC",
    platform: process.platform,
  };
}

module.exports = {
  DEFAULT_LOCALE,
  buildLocaleInfo,
  buildOsInfo,
  chroniclePermissionsStatus,
};
