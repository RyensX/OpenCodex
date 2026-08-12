const { sendJson } = require("./http-utils.cjs");

function createServiceRestartHandler({ instanceId, requestRestart, restartSupported, verifyAccessPasswordRequest }) {
  return async function handleServiceRestart(req, res) {
    if (req.method !== "POST") {
      return sendJson(res, 405, { ok: false, error: "Method Not Allowed" }, { "cache-control": "no-store" });
    }
    if (!restartSupported) {
      return sendJson(
        res,
        503,
        { ok: false, error: "Service restart is unavailable" },
        { "cache-control": "no-store" }
      );
    }
    // 重启入口位于通用认证闸门之前，因此这里必须独立验证本次输入的访问密码。
    if (!(await verifyAccessPasswordRequest(req, res))) return;
    if (!requestRestart()) {
      return sendJson(
        res,
        409,
        { ok: false, error: "Service restart is already pending" },
        { "cache-control": "no-store" }
      );
    }
    // 先把旧实例标识返回给页面；页面只在轮询到不同标识后判定重启成功。
    return sendJson(
      res,
      202,
      { ok: true, restarting: true, instanceId },
      { "cache-control": "no-store" }
    );
  };
}

module.exports = { createServiceRestartHandler };
