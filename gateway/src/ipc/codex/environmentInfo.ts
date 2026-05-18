// @ts-nocheck
export {};

const os = require("os");

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

/** locale-info IPC 返回官方 renderer 期望的 IDE/system locale 形态。 */
function buildLocaleInfo() {
  const options = Intl.DateTimeFormat().resolvedOptions();
  const locale = options.locale || "en-US";
  return {
    locale,
    ideLocale: locale,
    systemLocale: locale,
    timeZone: options.timeZone || "UTC",
    platform: process.platform,
  };
}

module.exports = {
  buildLocaleInfo,
  buildOsInfo,
  chroniclePermissionsStatus,
};
