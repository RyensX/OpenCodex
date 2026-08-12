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

/**
 * 统一处理受监督 gateway 的退出事件，让 launcher 与 dev runner 共享同一套重启判定。
 * 回调顺序固定为先上报退出、再触发重启，便于父进程先清空旧 child 引用。
 */
function createGatewayExitHandler({ isStopping, onExit, onRestart }) {
  if (typeof isStopping !== "function" || typeof onExit !== "function" || typeof onRestart !== "function") {
    throw new TypeError("gateway exit handler requires isStopping, onExit and onRestart callbacks");
  }
  return function handleGatewayExit(code, signal) {
    const restartRequested = !isStopping() && isGatewayRestartExit(code, signal);
    onExit({ code, signal, restartRequested });
    if (restartRequested) onRestart({ code, signal });
    return restartRequested;
  };
}

/** 把跨越异步准备阶段的 gateway 启动收敛成单飞任务，防止并发 spawn。 */
function createSingleFlightGatewayStarter(start) {
  if (typeof start !== "function") throw new TypeError("gateway starter requires a start callback");
  let pendingStart = null;
  return function startGatewaySingleFlight() {
    if (pendingStart) return pendingStart;
    const currentStart = Promise.resolve().then(() => start());
    pendingStart = currentStart;
    const clearPending = () => {
      if (pendingStart === currentStart) pendingStart = null;
    };
    currentStart.then(clearPending, clearPending);
    return currentStart;
  };
}

module.exports = {
  GATEWAY_RESTART_EXIT_CODE,
  GATEWAY_RESTART_SUPPORTED_ENV,
  createGatewayExitHandler,
  createSingleFlightGatewayStarter,
  isGatewayRestartExit,
  isGatewayRestartSupported,
};
