const { isRequestBodyTooLargeError, readBody, sendJson } = require("./http-utils.cjs");

const RUNTIME_COMPATIBILITY_API_PATH = "/api/opencodex/runtime-compatibility";
const RUNTIME_COMPATIBILITY_REPORT_PATH = `${RUNTIME_COMPATIBILITY_API_PATH}/reports`;
const RUNTIME_COMPATIBILITY_BODY_MAX_BYTES = 32 * 1024;
const MAX_BROWSER_REPORTS_PER_REQUEST = 128;

function sendRuntimeCompatibilitySnapshot(res, compatibilityService) {
  sendJson(
    res,
    200,
    { ok: true, compatibility: compatibilityService.snapshot() },
    { "cache-control": "no-store" }
  );
}

function handlePublicRuntimeCompatibilityApi(req, res, url, compatibilityService) {
  // 匿名诊断只开放只读快照；浏览器命中回执仍留在认证门之后，避免外部伪造运行状态。
  if (url.pathname !== RUNTIME_COMPATIBILITY_API_PATH || req.method !== "GET") return false;
  if (!compatibilityService) {
    sendJson(res, 503, { ok: false, error: "Runtime compatibility service is unavailable" }, { "cache-control": "no-store" });
    return true;
  }
  sendRuntimeCompatibilitySnapshot(res, compatibilityService);
  return true;
}

async function handleBrowserReports(req, res, compatibilityService) {
  let parsed;
  try {
    parsed = JSON.parse((await readBody(req, { maxBytes: RUNTIME_COMPATIBILITY_BODY_MAX_BYTES })) || "{}");
  } catch (error) {
    const status = isRequestBodyTooLargeError(error) ? 413 : 400;
    sendJson(
      res,
      status,
      { ok: false, error: status === 413 ? "Request body is too large" : "Invalid JSON body" },
      { "cache-control": "no-store" }
    );
    return;
  }
  const reports = Array.isArray(parsed.reports) ? parsed.reports : [];
  if (reports.length === 0 || reports.length > MAX_BROWSER_REPORTS_PER_REQUEST) {
    sendJson(res, 400, { ok: false, error: "Invalid compatibility reports" }, { "cache-control": "no-store" });
    return;
  }
  if (
    reports.some((report) => !compatibilityService.canAcceptBrowserReport({
      clientId: parsed.clientId,
      id: report?.id,
      phase: report?.phase,
    }))
  ) {
    sendJson(res, 400, { ok: false, error: "One or more compatibility reports were rejected" }, { "cache-control": "no-store" });
    return;
  }
  let accepted = 0;
  for (const report of reports) {
    if (
      compatibilityService.browserReport({
        clientId: parsed.clientId,
        id: report?.id,
        phase: report?.phase,
        reason: report?.reason,
      })
    ) {
      accepted += 1;
    }
  }
  if (accepted !== reports.length) {
    sendJson(res, 400, { ok: false, error: "One or more compatibility reports were rejected" }, { "cache-control": "no-store" });
    return;
  }
  sendJson(res, 200, { ok: true, accepted }, { "cache-control": "no-store" });
}

async function handleRuntimeCompatibilityApi(req, res, url, compatibilityService) {
  if (!compatibilityService) return false;
  if (url.pathname === RUNTIME_COMPATIBILITY_API_PATH) {
    if (req.method !== "GET") {
      sendJson(res, 405, { ok: false, error: "Method Not Allowed" }, { allow: "GET" });
      return true;
    }
    sendRuntimeCompatibilitySnapshot(res, compatibilityService);
    return true;
  }
  if (url.pathname === RUNTIME_COMPATIBILITY_REPORT_PATH) {
    if (req.method !== "POST") {
      sendJson(res, 405, { ok: false, error: "Method Not Allowed" }, { allow: "POST" });
      return true;
    }
    await handleBrowserReports(req, res, compatibilityService);
    return true;
  }
  return false;
}

module.exports = {
  MAX_BROWSER_REPORTS_PER_REQUEST,
  RUNTIME_COMPATIBILITY_API_PATH,
  RUNTIME_COMPATIBILITY_BODY_MAX_BYTES,
  RUNTIME_COMPATIBILITY_REPORT_PATH,
  handleBrowserReports,
  handlePublicRuntimeCompatibilityApi,
  handleRuntimeCompatibilityApi,
};
