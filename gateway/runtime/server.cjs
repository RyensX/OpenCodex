const http = require("http");
const path = require("path");
const { app } = require("electron");
const {
  AUTH_PASSWORD_HASH,
  authRefreshHeaders,
  authResultForRequest,
  handleAuthLogin,
  handleAuthLogout,
  handleAuthStatus,
  isAuthed,
  isLauncherRequest,
  sendUnauthorized,
  verifyAccessPasswordRequest,
} = require("./http/auth.cjs");
const {
  CODEX_WEB_PICKED_FILES_MAX_TOTAL_BYTES,
  DEBUG_LOGS,
  GATEWAY_INSTANCE_ID,
  HOST,
  IPC_SLOW_LOG_MS,
  PORT,
  PROJECT_ROOT,
  REPORTS_DIR,
  RUNTIME_DIR,
  UNKNOWN_IPC_PATH,
  ensureDir,
  exists,
} = require("./core/config.cjs");
const {
  hostnameFromHostHeader,
  isLoopbackHostHeader,
  loopbackHostname,
} = require("./core/loopback-host.cjs");
const { gzipIfUseful, isRequestBodyTooLargeError, readBody, send, sendJson } = require("./http/http-utils.cjs");
const { createLocalFileService } = require("./http/local-files.cjs");
const { createServiceRestartHandler } = require("./http/service-control.cjs");
const { handleTokenUsageRequest } = require("./http/token-usage.cjs");
const {
  buildGatewayStatus,
  createOfficialAppHostRelay,
  getI18nSnapshot,
  getOfficialBundle,
  handleOfficialNotificationEvent,
  invokeOfficialIpc,
  listOfficialIpcChannels,
  rejectPendingInternalResponses,
  requestContext,
  setWsHub,
  startOfficialRuntime,
  webConfigScript,
} = require("./ipc/official-runtime.cjs");
const { openFileTargetFromIpc } = require("./ipc/open-file-context.cjs");
const { createPickedFilesService } = require("./ipc/picked-files.cjs");
const { OPENCODEX_RUNTIME_BOOTSTRAP_PATH, createStaticAssetService } = require("./http/static-assets.cjs");
const { handleOpenCodexPluginApi } = require("./http/plugin-config.cjs");
const { handleRuntimeCompatibilityApi } = require("./http/runtime-compatibility.cjs");
const { createHistoryPreviewService } = require("./history-preview.cjs");
const { createWsHub } = require("./ipc/ws-hub.cjs");
const { workspaceRootsFromIpcPayload } = require("./ipc/workspace-root-context.cjs");
const { createWorkspaceRootsService } = require("./ipc/workspace-roots.cjs");
const { diagnosticError, diagnosticLog, diagnosticWarn, sanitizeDiagnosticValue, shortId } = require("./core/diagnostics.cjs");
const { markGatewaySilentQuit } = require("./lifecycle/quit-confirmation-suppressor.cjs");
const { createGatewayPluginService } = require("./plugins/service.cjs");
const { createCompatibilityService } = require("./compatibility/service.cjs");
const {
  GATEWAY_RESTART_EXIT_CODE,
  isGatewayRestartSupported,
} = require("../../shared/gateway-lifecycle.cjs");
const {
  HIDDEN_RUNTIME_GCM_HOLD_PATH,
} = require("./electron/hidden-runtime-command-line.cjs");

// server.cjs 只负责编排 HTTP/WS 生命周期；官方 Electron hook 细节放在 official-runtime.cjs。
const LOCAL_DOWNLOAD_PATH_BODY_MAX_BYTES = 32 * 1024;
const CLIENT_LOG_BODY_MAX_BYTES = 256 * 1024;
// pick-files 使用 base64，保留现有总附件能力并给 JSON 元数据预留 2MB；其它 IPC 同享这一硬上限。
const IPC_INVOKE_BODY_MAX_BYTES =
  Math.ceil((CODEX_WEB_PICKED_FILES_MAX_TOTAL_BYTES * 4) / 3) + 2 * 1024 * 1024;
const GATEWAY_PLUGIN_SYNC_PENDING_COOKIE = "opencodex_gateway_plugin_sync_pending";

function gatewayUrl(req) {
  // Node 原生 req.url 只有 path，需要补 host 才能安全解析 query 参数。
  return new URL(req.url, `http://${req.headers.host || "localhost"}`);
}

function hasPendingGatewayPluginSync(req) {
  // Cookie 只是一位提示，不包含插件 id 或配置；严格按分号边界解析，避免同名前缀误命中。
  return String(req?.headers?.cookie || "")
    .split(";")
    .some((part) => part.trim() === `${GATEWAY_PLUGIN_SYNC_PENDING_COOKIE}=1`);
}

function remoteAddressFromRequest(req) {
  return String(req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : "");
}

function holdHiddenRuntimeGcmRequest(req, hiddenRuntimeGcmSockets) {
  const socket = req?.socket;
  if (!socket || typeof socket.once !== "function") return Promise.resolve();
  hiddenRuntimeGcmSockets.add(socket);
  // 请求体需要继续消费；响应则刻意保持未完成，让 Chromium 停在首次 check-in 而不进入重试或 MCS 连接阶段。
  if (typeof req.resume === "function") req.resume();
  if (typeof socket.setTimeout === "function") socket.setTimeout(0);
  diagnosticLog("gateway", "hidden_gcm_checkin_held", {
    remoteAddress: remoteAddressFromRequest(req),
  });
  return new Promise((resolve) => {
    socket.once("close", () => {
      hiddenRuntimeGcmSockets.delete(socket);
      resolve();
    });
  });
}

function isHiddenRuntimeGcmHoldRequest(req, pathname) {
  // Host 与真实 peer 地址必须同时是 loopback，防止远端伪造 Host 后占用一个永不响应的连接。
  return (
    pathname === HIDDEN_RUNTIME_GCM_HOLD_PATH &&
    req.method === "POST" &&
    isLoopbackHostHeader(req.headers.host) &&
    loopbackHostname(remoteAddressFromRequest(req))
  );
}

function payloadFromArgs(args) {
  return args.length <= 1 ? (args[0] ?? null) : args;
}

function ipcArgsFromRequestBody(parsed) {
  if (Array.isArray(parsed.args)) return parsed.args;
  // 兼容旧版 web-shell：没有 args 时仍接受单 payload 字段。
  if (Object.prototype.hasOwnProperty.call(parsed, "payload")) return [parsed.payload];
  return [];
}

function ipcPayloadSummary(payload) {
  if (!payload || typeof payload !== "object") return {};
  const summary = {};
  // 慢 IPC 日志只打印路由字段，不打印正文内容，避免把用户消息或文件内容写进日志。
  for (const key of ["type", "requestId", "hostId", "url", "method"]) {
    if (typeof payload[key] === "string" && payload[key]) summary[key] = payload[key];
  }
  if (payload.request && typeof payload.request === "object") {
    if (payload.request.id != null) summary.requestId = String(payload.request.id);
    if (typeof payload.request.method === "string") summary.requestMethod = payload.request.method;
  }
  return summary;
}

function formatIpcPayloadSummary(payload) {
  const summary = ipcPayloadSummary(payload);
  return Object.keys(summary).length > 0 ? ` ${JSON.stringify(summary)}` : "";
}

function isConnectorLogoFetchPayload(payload) {
  if (!payload || typeof payload !== "object" || payload.type !== "fetch" || typeof payload.url !== "string") return false;
  try {
    const parsed = new URL(payload.url, "http://opencodex.local");
    return /^\/aip\/connectors\/[^/]+\/logo\/?$/.test(parsed.pathname);
  } catch {
    return /^\/aip\/connectors\/[^/?#]+\/logo(?:[?#]|$)/.test(payload.url);
  }
}

function shouldSuppressRoutineIpcLog(payload) {
  // 官方 renderer 会高频发送 log-message 和 connector logo fetch；默认不打印 start/end，避免淹没有价值的慢请求。
  return (
    payload &&
    typeof payload === "object" &&
    (payload.type === "log-message" || isConnectorLogoFetchPayload(payload))
  );
}

function safeClientLogData(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result = {};
  // 浏览器诊断日志只保留排障字段，避免把 prompt、文件内容或完整响应写进日志。
  for (const key of [
    "ageMs",
    "activeCount",
    "attempt",
    "cacheKey",
    "cacheSize",
    "clientAt",
    "channel",
    "clientId",
    "count",
    "elapsedMs",
    "error",
    "errorName",
    "event",
    "handledBy",
    "handleMs",
    "href",
    "inFlightCount",
    "method",
    "ok",
    "payloadType",
    "portId",
    "parseMs",
    "queuedCount",
    "rawChars",
    "ready",
    "reason",
    "requestId",
    "requestMethod",
    "responseType",
    "status",
    "startedCount",
    "target",
    "totalQueuedCount",
    "type",
    "url",
    "waitMs",
    "waiterCount",
    "wsReady",
    "wsState",
  ]) {
    const nestedValue = value[key];
    const sanitized = sanitizeDiagnosticValue(key, nestedValue);
    if (sanitized !== undefined) result[key] = key === "clientId" ? shortId(String(sanitized)) : sanitized;
  }
  return result;
}

async function handleClientLog(req, res) {
  let body = "";
  try {
    body = await readBody(req, { maxBytes: CLIENT_LOG_BODY_MAX_BYTES });
  } catch (error) {
    if (isRequestBodyTooLargeError(error)) {
      return sendJson(res, 413, { ok: false, error: "Request body is too large." }, { "cache-control": "no-store" });
    }
    throw error;
  }
  let parsed = {};
  try {
    parsed = JSON.parse(body || "{}");
  } catch {
    return sendJson(res, 400, { ok: false, error: "Invalid JSON body" }, { "cache-control": "no-store" });
  }

  // 浏览器端会批量上报诊断事件，减少日志本身对真实 IPC 请求的干扰；旧单事件格式继续兼容。
  const entries = Array.isArray(parsed.events) ? parsed.events.slice(0, 200) : [parsed];
  if (DEBUG_LOGS) {
    // client-diagnostic 是浏览器侧辅助埋点，正常渲染会大量触发；默认只接收不落盘，排查前端链路时再打开。
    for (const entry of entries) {
      const event = entry && typeof entry.event === "string" ? entry.event.slice(0, 120) : "unknown";
      const data = safeClientLogData(entry && entry.data);
      if (!data.clientId && typeof parsed.clientId === "string") data.clientId = shortId(parsed.clientId);
      diagnosticLog("client-diagnostic", event, data);
    }
  }
  return sendJson(res, 200, { ok: true }, { "cache-control": "no-store" });
}

async function handleLocalDownloadPath(req, res, localFiles) {
  if (isLoopbackHostHeader(req.headers.host)) {
    // localhost 保持桌面原生体验，不暴露侧栏远端下载 API。
    return sendJson(res, 404, { ok: false, error: "Remote path downloads are unavailable on localhost." }, { "cache-control": "no-store" });
  }

  let body = "";
  try {
    body = await readBody(req, { maxBytes: LOCAL_DOWNLOAD_PATH_BODY_MAX_BYTES });
  } catch (error) {
    if (isRequestBodyTooLargeError(error)) {
      return sendJson(res, 413, { ok: false, error: "Request body is too large." }, { "cache-control": "no-store" });
    }
    throw error;
  }

  let parsed = {};
  try {
    parsed = JSON.parse(body || "{}");
  } catch {
    return sendJson(res, 400, { ok: false, error: "Invalid JSON body" }, { "cache-control": "no-store" });
  }

  const filePath = typeof parsed.path === "string" ? parsed.path.trim() : "";
  const workspaceRoot = typeof parsed.workspaceRoot === "string" ? parsed.workspaceRoot.trim() : "";
  const normalizedPath = localFiles.resolveLocalDownloadPath(filePath, { workspaceRoot });
  const diagnosticBase = {
    filePath,
    host: req.headers.host || "",
    normalizedPath,
    remoteAddress: remoteAddressFromRequest(req),
    workspaceRoot,
  };
  diagnosticLog("local-download", "path_request", diagnosticBase);
  if (!normalizedPath || !path.isAbsolute(normalizedPath)) {
    diagnosticWarn("local-download", "invalid_path", diagnosticBase);
    return sendJson(res, 400, { ok: false, error: "Invalid download path." }, { "cache-control": "no-store" });
  }
  if (!localFiles.isAllowedLocalDownloadPath(normalizedPath)) {
    diagnosticWarn("local-download", "path_not_allowed", diagnosticBase);
    return sendJson(res, 403, { ok: false, error: "Path is not allowed." }, { "cache-control": "no-store" });
  }

  try {
    const value = await localFiles.createLocalPathDownload(normalizedPath);
    diagnosticLog("local-download", "path_ready", {
      ...diagnosticBase,
      downloadName: value && value.name,
    });
    return sendJson(res, 200, { ok: true, value }, { "cache-control": "no-store" });
  } catch (error) {
    const status =
      error && typeof error.status === "number"
        ? error.status
        : error && (error.code === "ENOENT" || error.code === "ENOTDIR")
          ? 404
          : 500;
    diagnosticWarn("local-download", "path_failed", {
      ...diagnosticBase,
      error: error instanceof Error ? error.message : String(error),
      status,
    });
    return sendJson(
      res,
      status,
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { "cache-control": "no-store" }
    );
  }
}

function installShutdownHandlers(
  server,
  localFiles,
  pickedFiles,
  pluginService,
  compatibilityService,
  historyPreview,
  hiddenRuntimeGcmSockets
) {
  let shuttingDown = false;
  let restartScheduled = false;
  function shutdown({ exitCode = null, reason = "", signal = "" } = {}) {
    if (shuttingDown) return;
    shuttingDown = true;
    // 退出时先释放短期 token 和待处理的官方内部请求，避免请求一直挂起。
    localFiles.dispose();
    if (pickedFiles && typeof pickedFiles.dispose === "function") pickedFiles.dispose();
    if (historyPreview && typeof historyPreview.dispose === "function") historyPreview.dispose();
    if (pluginService && typeof pluginService.dispose === "function") {
      pluginService.dispose(new Error("gateway shutting down"));
    }
    if (compatibilityService && typeof compatibilityService.dispose === "function") {
      compatibilityService.dispose();
    }
    rejectPendingInternalResponses(new Error("gateway shutting down"));
    // GCM check-in 响应被有意挂起；先销毁这些本机 socket，避免 http.Server.close 等待到强退超时。
    for (const socket of hiddenRuntimeGcmSockets) socket.destroy();
    hiddenRuntimeGcmSockets.clear();
    const exit = () => {
      if (Number.isInteger(exitCode)) {
        markGatewaySilentQuit(reason || "gateway_restart");
        app.exit(exitCode);
        return;
      }
      if (signal) {
        markGatewaySilentQuit(signal);
        app.quit();
      }
    };
    try {
      server.close(exit);
    } catch {
      exit();
    }
    if (signal || Number.isInteger(exitCode)) {
      // 信号退出和重启都给 Electron 一小段清理时间，超时后使用对应退出码强制结束。
      const forceExitTimer = setTimeout(() => process.exit(Number.isInteger(exitCode) ? exitCode : 0), 1500);
      if (forceExitTimer && typeof forceExitTimer.unref === "function") forceExitTimer.unref();
    }
  }

  function requestRestart() {
    if (restartScheduled || shuttingDown) return false;
    restartScheduled = true;
    // 延后一轮再关闭服务，确保 202 响应和按钮加载态先送达浏览器。
    setImmediate(() => shutdown({ exitCode: GATEWAY_RESTART_EXIT_CODE, reason: "web_restart" }));
    return true;
  }

  process.once("SIGINT", () => shutdown({ signal: "SIGINT" }));
  process.once("SIGTERM", () => shutdown({ signal: "SIGTERM" }));
  app.once("before-quit", () => shutdown());
  return { requestRestart };
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    // http.Server.listen 没有 Promise 版本，封装一次便于 createGateway 按顺序启动。
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(PORT, HOST);
  });
}

function createRequestHandler({
  compatibilityService,
  historyPreview,
  hiddenRuntimeGcmSockets = new Set(),
  localFiles,
  pickedFiles,
  pluginService,
  requestRestart = () => false,
  staticAssets,
  workspaceRoots,
}) {
  /**
   * 路由顺序很关键：
   * 1. 认证和 launcher 探活先处理。
   * 2. 登录页依赖的公开静态资源先放行。
   * 3. 未登录请求返回公开登录壳；已认证请求直接返回最终 renderer。
   * 4. 其余 API、官方资源和本地文件入口必须通过 auth gate。
   */
  const handleServiceRestart = createServiceRestartHandler({
    instanceId: GATEWAY_INSTANCE_ID,
    requestRestart,
    restartSupported: isGatewayRestartSupported(),
    verifyAccessPasswordRequest,
  });
  return async (req, res) => {
    const url = gatewayUrl(req);
    const pathname = url.pathname;

    if (isHiddenRuntimeGcmHoldRequest(req, pathname)) {
      // 仅隐藏 Electron 自己的 loopback 请求可进入；放在认证前，避免生成快速 401 导致 GCM 高频重试。
      return holdHiddenRuntimeGcmRequest(req, hiddenRuntimeGcmSockets);
    }

    // 认证接口必须在通用 auth gate 之前处理，否则首次登录会被拦截。
    if (pathname === "/api/auth/status") return handleAuthStatus(req, res, url);
    if (pathname === "/api/auth/login") return handleAuthLogin(req, res);
    if (pathname === "/api/auth/logout") return handleAuthLogout(req, res, url);
    if (pathname === "/api/service/restart") return handleServiceRestart(req, res);
    if (pathname === "/login") return send(res, 302, { location: "/" }, "");
    if (pathname === "/api/launcher/status") {
      // launcher/status 只给桌面壳进程探活，不接受普通浏览器请求。
      if (!isLauncherRequest(req)) {
        return sendJson(res, 401, { ok: false, error: "Unauthorized" }, { "cache-control": "no-store" });
      }
      return sendJson(res, 200, buildGatewayStatus(), { "cache-control": "no-store" });
    }

    // 公开静态资源先返回，保证登录页和 web-shell polyfill 在未登录时也能加载。
    if (pathname === "/opencodex-plugin-loader.js" && req.method === "GET") {
      // loader 是目录扫描结果，登录页设置面板也依赖它，所以必须在 auth gate 前动态生成。
      return staticAssets.servePluginLoader(res);
    }
    if (staticAssets.isPublicStaticPath(pathname)) {
      const file = staticAssets.staticFile(pathname);
      if (file && exists(file)) return staticAssets.serveFile(req, res, file, 200, pathname);
    }

    if (staticAssets.isAppShellRoute(req, pathname)) {
      const shellAuth = AUTH_PASSWORD_HASH ? authResultForRequest(req, url) : { authenticated: true };
      if (!shellAuth.authenticated) {
        // 未登录用户刷新任意前端路由时仍回到登录体验，而不是直接看到 401 文本页。
        return staticAssets.serveWebShellIndex(res);
      }
      if (url.searchParams.has("token")) {
        // query token 只用于换取 HttpOnly cookie；认证成功后立即清理地址，避免后续同源 Referer 携带令牌。
        const cleanUrl = new URL(url.href);
        cleanUrl.searchParams.delete("token");
        return send(
          res,
          302,
          {
            location: `${cleanUrl.pathname}${cleanUrl.search}`,
            "cache-control": "no-store",
            ...authRefreshHeaders(shellAuth),
          },
          ""
        );
      }
      if (hasPendingGatewayPluginSync(req)) {
        // 匿名入口曾记录插件改动时沿用原同步壳；正常导航没有此 cookie，仍直接进入最终 renderer。
        return staticAssets.serveWebShellIndex(res);
      }
      // 导航请求已经通过认证时直接发送最终 HTML，省掉 auth/status、二次 HTML 请求和 document.write 重解析。
      const sidebarPreview = await historyPreview?.snapshot?.({ maxWaitMs: 700 });
      return staticAssets.serveRendererIndex(req, res, authRefreshHeaders(shellAuth), { sidebarPreview });
    }

    // 从这里开始进入受保护区：官方 renderer、IPC API、本地文件和诊断接口都不能匿名访问。
    const requestAuthForRefresh = AUTH_PASSWORD_HASH ? authResultForRequest(req, url) : null;
    if (AUTH_PASSWORD_HASH && !requestAuthForRefresh.authenticated) return sendUnauthorized(req, res);
    const requestAuthRefreshHeaders = authRefreshHeaders(requestAuthForRefresh);
    // 对已登录请求顺手刷新 cookie TTL，浏览器长时间使用时不需要频繁重新登录。
    for (const [name, value] of Object.entries(requestAuthRefreshHeaders)) {
      res.setHeader(name, value);
    }

    if (pathname === OPENCODEX_RUNTIME_BOOTSTRAP_PATH && req.method === "GET") {
      // 聚合固定运行时脚本，消除高延迟网络上十余个 parser-blocking 往返；认证边界与配置接口一致。
      return staticAssets.serveRuntimeBootstrap(req, res, requestAuthRefreshHeaders);
    }

    if (pathname === "/codex-web-config.js") {
      // 运行时配置必须动态生成，因为端口、workspace roots 和 locale 都来自当前进程环境。
      const response = gzipIfUseful(
        req,
        {
          "content-type": "application/javascript; charset=utf-8",
          "cache-control": "no-store",
          ...requestAuthRefreshHeaders,
        },
        Buffer.from(
          await webConfigScript({ gatewayPluginConfig: pluginService?.configStore?.snapshot?.() || null }),
          "utf-8"
        )
      );
      return send(res, 200, response.headers, response.body);
    }

    if (pathname === "/api/health") {
      return sendJson(res, 200, buildGatewayStatus());
    }

    if (pathname === "/api/ipc/handlers") {
      // 这个端点主要用于排查官方 bundle 是否注册了预期 IPC handler。
      return sendJson(res, 200, listOfficialIpcChannels(), { "cache-control": "no-store" });
    }

    if (pathname === "/api/token-usage") {
      return handleTokenUsageRequest(req, res, url);
    }

    if (await handleRuntimeCompatibilityApi(req, res, url, compatibilityService)) return;

    if (await handleOpenCodexPluginApi(req, res, url, pluginService)) return;

    const protectedStaticFile = staticAssets.protectedStaticFile?.(pathname);
    if (
      protectedStaticFile &&
      (req.method === "GET" || req.method === "HEAD") &&
      exists(protectedStaticFile)
    ) {
      return staticAssets.serveFile(req, res, protectedStaticFile, 200, pathname);
    }

    if (pathname === "/api/local-file/download-path" && req.method === "POST") {
      // 侧栏文件树右键下载入口：文件直接下发，目录先临时压缩再返回短期 token。
      return handleLocalDownloadPath(req, res, localFiles);
    }

    if (pathname === "/api/plugin-image" && req.method === "GET") {
      // 官方插件摘要只保留同源 URL，实际挂载 img 时再流式读取，避免启动期批量 base64 IPC。
      return localFiles.servePluginImage(url, req, res);
    }

    if (pathname.startsWith("/api/app-fs/@fs/") && req.method === "GET") {
      // 官方 renderer 里的 app://fs 图片会被前端改写到这个 HTTP 入口。
      return localFiles.serveAppFsFile(pathname, res);
    }

    if (pathname.startsWith("/api/local-file/") && req.method === "GET") {
      // 只有官方 openFile 生成的短期 token 可以走这里预览或下载本机文件。
      return localFiles.serveLocalFile(pathname, res, { download: url.searchParams.get("download") === "1" });
    }

    if (pathname === "/api/ipc/invoke" && req.method === "POST") {
      return handleIpcInvoke(
        req,
        res,
        localFiles,
        pickedFiles,
        workspaceRoots,
        pluginService,
        compatibilityService
      );
    }

    if (pathname === "/api/client-log" && req.method === "POST") {
      // Web 端启动期诊断日志走独立端点，避免混入官方 IPC 语义或触发额外官方 handler。
      return handleClientLog(req, res);
    }

    if (pathname === "/official-index.patched.html") {
      // 保留这个调试入口，便于单独查看官方 renderer HTML 的注入和 CSP patch 结果。
      const sidebarPreview = await historyPreview?.snapshot?.({ maxWaitMs: 700 });
      return staticAssets.serveRendererIndex(req, res, requestAuthRefreshHeaders, { sidebarPreview });
    }

    const file = staticAssets.staticFile(pathname);
    if (file && exists(file)) return staticAssets.serveFile(req, res, file, 200, pathname);

    if (staticAssets.isAppShellRoute(req, pathname)) {
      // 理论上导航已在前面返回；保留最终 renderer 兜底，避免未来新增公开路由改变深链行为。
      const sidebarPreview = await historyPreview?.snapshot?.({ maxWaitMs: 700 });
      return staticAssets.serveRendererIndex(req, res, requestAuthRefreshHeaders, { sidebarPreview });
    }

    return send(res, 404, { "content-type": "text/plain; charset=utf-8" }, "Not Found");
  };
}

function ipcInvokeErrorResponse(error) {
  const response = {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  };
  if (error && typeof error.errorKey === "string" && error.errorKey) response.errorKey = error.errorKey;
  return {
    response,
    status: error && typeof error.status === "number" ? error.status : 500,
  };
}

function invalidIpcInvokeError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

async function executeIpcInvoke(
  parsed,
  req,
  localFiles,
  pickedFiles,
  workspaceRoots,
  pluginService,
  compatibilityService = null
) {
  const channel = typeof parsed.channel === "string" ? parsed.channel : "";
  // channel 是官方 IPC 的唯一路由键，缺失时不能继续调用隐藏 runtime。
  if (!channel) throw invalidIpcInvokeError("Invalid IPC channel");

  const args = ipcArgsFromRequestBody(parsed);
  const payload = payloadFromArgs(args);
  const clientId = typeof parsed.clientId === "string" ? parsed.clientId : "";
  const remoteAddress = remoteAddressFromRequest(req);
  const browserHostname = hostnameFromHostHeader(req.headers.host);
  const isLoopbackBrowserHost = isLoopbackHostHeader(req.headers.host);
  const openFileTarget = openFileTargetFromIpc(channel, payload);
  const ipcWorkspaceRoots = workspaceRootsFromIpcPayload(channel, payload);
  try {
    if (openFileTarget) compatibilityService?.recordHit("gateway.runtime.ipc.open-file-context");
    if (ipcWorkspaceRoots.length > 0) compatibilityService?.recordHit("gateway.runtime.ipc.workspace-context");
  } catch {
    // IPC 上下文提取已经完成，命中统计失败不能改变后续官方调用。
  }
  const startedAtMs = Date.now();
  const diagnosticBase = {
    ...ipcPayloadSummary(payload),
    argsCount: args.length,
    channel,
    clientId: shortId(clientId),
    remoteAddress,
  };
  const suppressRoutineLog = shouldSuppressRoutineIpcLog(payload);
  // 在请求进入官方 Main 前关联浏览器 client 与 thread，确保分类状态能定向回到发起页面。
  pluginService?.smartSchedulingPresentation?.observeIpcInvoke({ channel, clientId, args });
  // 成功 IPC start/end 会跟随前端渲染频率放大；默认保留慢调用和失败日志，DEBUG 时再展开完整链路。
  if (DEBUG_LOGS && !suppressRoutineLog) diagnosticLog("gateway-ipc", "invoke_start", diagnosticBase);
  try {
    for (const root of ipcWorkspaceRoots) {
      try {
        // 官方文件树和 open-in-targets IPC 已经携带当前 cwd/root；注册后供远端右键下载复用同一 allowlist。
        workspaceRoots.registerWorkspaceRoot(root);
      } catch (error) {
        diagnosticWarn("gateway-ipc", "workspace_root_register_failed", {
          channel,
          error: error instanceof Error ? error.message : String(error),
          root,
        });
      }
    }
    if (channel === "pick-files") {
      // Web 端 pick-files 必须在浏览器侧选文件，再由 gateway 落盘；不能继续转给官方 Electron dialog。
      const value = pickedFiles.handlePickFilesPayload(payload);
      const elapsedMs = Date.now() - startedAtMs;
      if (DEBUG_LOGS && !suppressRoutineLog) {
        diagnosticLog("gateway-ipc", "invoke_end", { ...diagnosticBase, elapsedMs, ok: true });
      }
      return value;
    }
    if (channel === "opencodex:validate-workspace-root") {
      // 远端浏览器无法打开 Electron 目录选择器，只允许用户显式输入并在 gateway 侧校验本机路径。
      const value = workspaceRoots.handleValidateWorkspaceRootPayload(payload);
      const elapsedMs = Date.now() - startedAtMs;
      if (DEBUG_LOGS && !suppressRoutineLog) {
        diagnosticLog("gateway-ipc", "invoke_end", { ...diagnosticBase, elapsedMs, ok: true });
      }
      return value;
    }
    // AsyncLocalStorage 让后续官方 webContents.send 和打开文件拦截能知道这次浏览器 IPC 属于哪个 client。
    const value = await requestContext.run(
      {
        browserHostname,
        clientId,
        createLocalFileDownload: localFiles.createLocalFileDownload,
        isLoopbackBrowserHost,
        openFileTarget,
        remoteAddress,
      },
      () =>
        invokeOfficialIpc(channel, args, {
          clientId,
          remoteAddress,
          setTitle: () => true,
          openExternal: (urlToOpen) => {
            if (urlToOpen) console.log(`[openExternal] ${urlToOpen}`);
            return true;
          },
          // 官方 openFile 在桌面里会打开系统应用；Web 端改成短期 token 的浏览器预览链接。
          openFile: (filePath) => localFiles.createLocalFilePreview(filePath),
        })
    );
    const elapsedMs = Date.now() - startedAtMs;
    if (DEBUG_LOGS && !suppressRoutineLog) diagnosticLog("gateway-ipc", "invoke_end", { ...diagnosticBase, elapsedMs, ok: true });
    if (DEBUG_LOGS || elapsedMs >= IPC_SLOW_LOG_MS) {
      diagnosticLog("gateway-ipc", "invoke_slow", { ...diagnosticBase, elapsedMs, slowThresholdMs: IPC_SLOW_LOG_MS });
    }
    return value;
  } catch (error) {
    const elapsedMs = Date.now() - startedAtMs;
    diagnosticWarn("gateway-ipc", "invoke_failed", {
      ...diagnosticBase,
      elapsedMs,
      error: error instanceof Error ? error.message : String(error),
      ok: false,
    });
    throw error;
  }
}

async function handleIpcInvoke(
  req,
  res,
  localFiles,
  pickedFiles,
  workspaceRoots,
  pluginService,
  compatibilityService = null
) {
  /**
   * HTTP 是旧页面和 WS 尚未就绪时的兼容通道；两种传输最终复用同一套官方 IPC 执行逻辑。
   */
  let body = "";
  try {
    body = await readBody(req, { maxBytes: IPC_INVOKE_BODY_MAX_BYTES });
  } catch (error) {
    if (isRequestBodyTooLargeError(error)) {
      return sendJson(res, 413, { ok: false, error: "Request body is too large." });
    }
    throw error;
  }
  let parsed = {};
  try {
    parsed = JSON.parse(body || "{}");
  } catch {
    return sendJson(res, 400, { ok: false, error: "Invalid JSON body" });
  }

  try {
    const value = await executeIpcInvoke(
      parsed,
      req,
      localFiles,
      pickedFiles,
      workspaceRoots,
      pluginService,
      compatibilityService
    );
    return sendJson(res, 200, { ok: true, value });
  } catch (error) {
    const { response, status } = ipcInvokeErrorResponse(error);
    return sendJson(res, status, response);
  }
}

async function handleWsIpcInvoke(
  request,
  req,
  clientId,
  localFiles,
  pickedFiles,
  workspaceRoots,
  pluginService,
  compatibilityService = null
) {
  // clientId 只信任已完成 hello 的 socket 映射，忽略浏览器帧里可能伪造的同名字段。
  const parsed = request && typeof request === "object" ? { ...request, clientId } : {};
  try {
    const value = await executeIpcInvoke(
      parsed,
      req,
      localFiles,
      pickedFiles,
      workspaceRoots,
      pluginService,
      compatibilityService
    );
    return { ok: true, value };
  } catch (error) {
    const { response, status } = ipcInvokeErrorResponse(error);
    return { ...response, status };
  }
}

function gatewayCompatibilityPaths() {
  return { runtimeDir: RUNTIME_DIR, reportsDir: REPORTS_DIR };
}

function createGatewayCompatibilityService(paths = gatewayCompatibilityPaths()) {
  // 集中绑定运行目录，确保真实网关启动与测试都覆盖打包态的兼容性服务初始化链路。
  return createCompatibilityService({
    runtimeDir: paths.runtimeDir,
    reportsDir: paths.reportsDir,
    getRuntimeIdentity() {
      const bundle = getOfficialBundle();
      return { version: bundle?.version, build: bundle?.build };
    },
  });
}

async function createGateway() {
  /**
   * 启动顺序：
   * 1. 准备 reports 目录。
   * 2. 启动官方 hidden runtime 并完成 IPC hook。
   * 3. 创建本地文件服务、静态资源服务和 HTTP server。
   * 4. 把 WebSocket hub 注入 runtime，用于官方异步回包转发。
  */
  ensureDir(REPORTS_DIR);
  let compatibilityService = null;
  try {
    compatibilityService = createGatewayCompatibilityService();
  } catch (error) {
    // 兼容骨架是旁路控制面，初始化失败不能阻断原 Gateway 启动链路。
    diagnosticWarn("gateway", "compatibility_service_unavailable", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  // 插件配置和路由服务必须先创建，才能在官方 bootstrap 拉起 App Server 的瞬间装饰其 stdio。
  const pluginService = createGatewayPluginService({
    compatibilityService,
    getRuntimeIdentity() {
      const bundle = getOfficialBundle();
      return { version: bundle?.version, build: bundle?.build };
    },
  });
  // 先启动官方 runtime，确保后续 health/IPC 路由能看到官方 handler 注册状态。
  try {
    await startOfficialRuntime({
      compatibilityService,
      decorateAppServerChild: pluginService.modelRouter.decorateAppServerChild,
    });
  } catch (error) {
    // 官方 Bootstrap 失败时 HTTP 页面尚不可用，必须同步落盘供 Launcher 离线查看。
    try {
      compatibilityService?.persistNow?.();
    } catch {}
    throw error;
  }

  const historyPreview = createHistoryPreviewService({ transport: pluginService.modelRouter.transport });
  // 预热不延迟网关监听；首个导航若更早到达，会在自己的 700ms 预算内复用这次读取。
  void historyPreview.warm();
  const workspaceRoots = createWorkspaceRootsService();
  const localFiles = createLocalFileService({ getWorkspaceRoots: workspaceRoots.workspaceRoots });
  const pickedFiles = createPickedFilesService();
  const staticAssets = createStaticAssetService({ compatibilityService, getI18nSnapshot, getOfficialBundle });
  // 与 request handler 和退出流程共享同一个集合，确保挂起的本机 GCM socket 可被精确回收。
  const hiddenRuntimeGcmSockets = new Set();
  try {
    // 在端口可访问前完成首屏大主包的 patch/压缩，首个远程导航不再承担一次性 CPU 成本。
    await staticAssets.prewarmRendererAssets();
  } catch (error) {
    diagnosticWarn("gateway", "renderer_asset_prewarm_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  let requestRestart = () => false;
  const requestHandler = createRequestHandler({
    compatibilityService,
    historyPreview,
    hiddenRuntimeGcmSockets,
    localFiles,
    pickedFiles,
    pluginService,
    requestRestart: () => requestRestart(),
    staticAssets,
    workspaceRoots,
  });
  const server = http.createServer((req, res) => {
    requestHandler(req, res).catch((error) => {
      diagnosticError("gateway", "request_failed", {
        error: error instanceof Error ? error.message : String(error),
        method: req.method,
        url: req.url || "",
      });
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: String(error.message || error) });
    });
  });

  // 注入 app-host relay 工厂：WS hub 只管理浏览器连接，真正的官方 MessagePort 仍由 official-runtime 创建。
  const webSocketHub = createWsHub(server, {
    createAppHostRelay: createOfficialAppHostRelay,
    handleIpcInvoke({ clientId, request, req }) {
      return handleWsIpcInvoke(
        request,
        req,
        clientId,
        localFiles,
        pickedFiles,
        workspaceRoots,
        pluginService,
        compatibilityService
      );
    },
    handleNotificationEvent: handleOfficialNotificationEvent,
    isAuthed,
    observeAppHostFrame(frame) {
      pluginService.smartSchedulingPresentation?.observeAppHostFrame(frame);
    },
  });
  pluginService.bindSmartSchedulingPresentation({
    onClientRemoved: webSocketHub.onClientRemoved,
    sendTo: webSocketHub.sendTo,
  });
  // official-runtime 通过这个 hub 把官方 renderer 的异步消息转发给浏览器。
  setWsHub(webSocketHub);
  const shutdownController = installShutdownHandlers(
    server,
    localFiles,
    pickedFiles,
    pluginService,
    compatibilityService,
    historyPreview,
    hiddenRuntimeGcmSockets
  );
  requestRestart = shutdownController.requestRestart;
  await listen(server);

  diagnosticLog("gateway", "listening", { url: `http://${HOST}:${PORT}` });
  diagnosticLog("gateway", "health_endpoint", { url: `http://${HOST}:${PORT}/api/health` });
  diagnosticLog("gateway", "unknown_ipc_log", { path: path.relative(PROJECT_ROOT, UNKNOWN_IPC_PATH) });

  return {
    compatibilityService,
    historyPreview,
    localFiles,
    pluginService,
    server,
    staticAssets,
    workspaceRoots,
    wsHub: webSocketHub,
  };
}

module.exports = {
  createGateway,
  createRequestHandler,
  __test: {
    createGatewayCompatibilityService,
    gatewayCompatibilityPaths,
    holdHiddenRuntimeGcmRequest,
    isHiddenRuntimeGcmHoldRequest,
  },
};
