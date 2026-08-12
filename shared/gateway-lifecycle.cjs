const GATEWAY_RESTART_EXIT_CODE = 75;
const GATEWAY_RESTART_SUPPORTED_ENV = "OPENCODEX_GATEWAY_RESTART_SUPPORTED";

/** 只有监督进程明确注入能力标记时，gateway 才允许远程重启，避免无人拉起时变成远程关机。 */
function isGatewayRestartSupported(env = process.env) {
  return env && env[GATEWAY_RESTART_SUPPORTED_ENV] === "1";
}

/** 专用退出码只表达用户主动请求重启，普通退出和崩溃不能触发无限重拉起。 */
function isGatewayRestartExit(code, signal) {
  return signal == null && code === GATEWAY_RESTART_EXIT_CODE;
}

module.exports = {
  GATEWAY_RESTART_EXIT_CODE,
  GATEWAY_RESTART_SUPPORTED_ENV,
  isGatewayRestartExit,
  isGatewayRestartSupported,
};
