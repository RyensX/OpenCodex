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
} = require("./http/auth.cjs");
const {
  DEBUG_LOGS,
  HOST,
  IPC_SLOW_LOG_MS,
  PORT,
  PROJECT_ROOT,
  REPORTS_DIR,
  UNKNOWN_IPC_PATH,
  ensureDir,
  exists,
} = require("./core/config.cjs");
const { readBody, send, sendJson } = require("./http/http-utils.cjs");
const { createLocalFileService } = require("./http/local-files.cjs");
const {
  buildGatewayStatus,
  createOfficialAppHostRelay,
  getOfficialBundle,
  invokeOfficialIpc,
  listOfficialIpcChannels,
  rejectPendingInternalResponses,
  requestContext,
  setWsHub,
  startOfficialRuntime,
  webConfigScript,
} = require("./ipc/official-runtime.cjs");
const { createStaticAssetService } = require("./http/static-assets.cjs");
const { createWsHub } = require("./ipc/ws-hub.cjs");
const { diagnosticError, diagnosticLog, diagnosticWarn, sanitizeDiagnosticValue, shortId } = require("./core/diagnostics.cjs");
const { markGatewaySilentQuit } = require("./lifecycle/quit-confirmation-suppressor.cjs");

// server.cjs 只负责编排 HTTP/WS 生命周期；官方 Electron hook 细节放在 official-runtime.cjs。
function gatewayUrl(req) {
  // Node 原生 req.url 只有 path，需要补 host 才能安全解析 query 参数。
  return new URL(req.url, `http://${req.headers.host || "localhost"}`);
}

function remoteAddressFromRequest(req) {
  return String(req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : "");
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
  const body = await readBody(req);
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

function installShutdownHandlers(server, localFiles) {
  let shuttingDown = false;
  function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    // 退出时先释放短期 token 和待处理的官方内部请求，避免请求一直挂起。
    localFiles.dispose();
    rejectPendingInternalResponses(new Error("gateway shutting down"));
    const exit = () => {
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
    if (signal) {
      // 信号退出时给 Electron 一小段清理时间，避免隐藏窗口阻塞进程结束。
      const forceExitTimer = setTimeout(() => process.exit(0), 1500);
      if (forceExitTimer && typeof forceExitTimer.unref === "function") forceExitTimer.unref();
    }
  }

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  app.once("before-quit", () => shutdown());
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

function createRequestHandler({ localFiles, staticAssets }) {
  /**
   * 路由顺序很关键：
   * 1. 认证和 launcher 探活先处理。
   * 2. 登录页依赖的公开静态资源先放行。
   * 3. SPA shell 可公开返回，真正敏感数据在后续 API/WS 才校验 token。
   * 4. 其余 API、官方 renderer 和本地文件入口必须通过 auth gate。
   */
  return async (req, res) => {
    const url = gatewayUrl(req);
    const pathname = url.pathname;

    // 认证接口必须在通用 auth gate 之前处理，否则首次登录会被拦截。
    if (pathname === "/api/auth/status") return handleAuthStatus(req, res, url);
    if (pathname === "/api/auth/login") return handleAuthLogin(req, res);
    if (pathname === "/api/auth/logout") return handleAuthLogout(req, res, url);
    if (pathname === "/login") return send(res, 302, { location: "/" }, "");
    if (pathname === "/api/launcher/status") {
      // launcher/status 只给桌面壳进程探活，不接受普通浏览器请求。
      if (!isLauncherRequest(req)) {
        return sendJson(res, 401, { ok: false, error: "Unauthorized" }, { "cache-control": "no-store" });
      }
      return sendJson(res, 200, buildGatewayStatus(), { "cache-control": "no-store" });
    }

    // 公开静态资源先返回，保证登录页和 web-shell polyfill 在未登录时也能加载。
    if (staticAssets.isPublicStaticPath(pathname)) {
      const file = staticAssets.staticFile(pathname);
      if (file && exists(file)) return staticAssets.serveFile(req, res, file, 200, pathname);
    }

    if (staticAssets.isAppShellRoute(req, pathname)) {
      // index shell 允许公开返回；后续 renderer 资源、API 和 WS 再走 token 校验。
      // 这么做可以让未登录用户刷新任意前端路由时仍回到登录体验，而不是直接 401 文本页。
      return staticAssets.serveWebShellIndex(res);
    }

    // 从这里开始进入受保护区：官方 renderer、IPC API、本地文件和诊断接口都不能匿名访问。
    const requestAuthForRefresh = AUTH_PASSWORD_HASH ? authResultForRequest(req, url) : null;
    if (AUTH_PASSWORD_HASH && !requestAuthForRefresh.authenticated) return sendUnauthorized(req, res);
    const requestAuthRefreshHeaders = authRefreshHeaders(requestAuthForRefresh);
    // 对已登录请求顺手刷新 cookie TTL，浏览器长时间使用时不需要频繁重新登录。
    for (const [name, value] of Object.entries(requestAuthRefreshHeaders)) {
      res.setHeader(name, value);
    }

    if (pathname === "/codex-web-config.js") {
      // 运行时配置必须动态生成，因为端口、workspace roots 和 locale 都来自当前进程环境。
      return send(
        res,
        200,
        {
          "content-type": "application/javascript; charset=utf-8",
          "cache-control": "no-store",
          ...requestAuthRefreshHeaders,
        },
        webConfigScript()
      );
    }

    if (pathname === "/api/health") {
      return sendJson(res, 200, buildGatewayStatus());
    }

    if (pathname === "/api/ipc/handlers") {
      // 这个端点主要用于排查官方 bundle 是否注册了预期 IPC handler。
      return sendJson(res, 200, listOfficialIpcChannels(), { "cache-control": "no-store" });
    }

    if (pathname.startsWith("/api/app-fs/@fs/") && req.method === "GET") {
      // 官方 renderer 里的 app://fs 图片会被前端改写到这个 HTTP 入口。
      return localFiles.serveAppFsFile(pathname, res);
    }

    if (pathname.startsWith("/api/local-file/") && req.method === "GET") {
      // 只有官方 openFile 生成的短期 token 可以走这里预览本机文件。
      return localFiles.serveLocalFile(pathname, res);
    }

    if (pathname === "/api/ipc/invoke" && req.method === "POST") {
      return handleIpcInvoke(req, res, localFiles);
    }

    if (pathname === "/api/client-log" && req.method === "POST") {
      // Web 端启动期诊断日志走独立端点，避免混入官方 IPC 语义或触发额外官方 handler。
      return handleClientLog(req, res);
    }

    if (pathname === "/official-index.patched.html") {
      // 保留这个调试入口，便于单独查看官方 renderer HTML 的注入和 CSP patch 结果。
      const html = staticAssets.createRendererResponse();
      if (!html) {
        return send(
          res,
          404,
          { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
          "Official renderer bundle is not available yet."
        );
      }
      return send(res, 200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }, html);
    }

    const file = staticAssets.staticFile(pathname);
    if (file && exists(file)) return staticAssets.serveFile(req, res, file, 200, pathname);

    if (staticAssets.isAppShellRoute(req, pathname)) {
      // 受保护区内再兜底一次 SPA shell，覆盖登录后深链刷新场景。
      return staticAssets.serveWebShellIndex(res);
    }

    return send(res, 404, { "content-type": "text/plain; charset=utf-8" }, "Not Found");
  };
}

async function handleIpcInvoke(req, res, localFiles) {
  /**
   * 浏览器把 Electron ipcRenderer.invoke/send 折叠成 HTTP POST。
   * gateway 在这里恢复 channel/args，并伪造 IpcMainEvent 交给官方 handler。
   */
  const body = await readBody(req);
  let parsed = {};
  try {
    parsed = JSON.parse(body || "{}");
  } catch {
    return sendJson(res, 400, { ok: false, error: "Invalid JSON body" });
  }

  const channel = typeof parsed.channel === "string" ? parsed.channel : "";
  if (!channel) {
    // channel 是官方 IPC 的唯一路由键，缺失时不能继续调用隐藏 runtime。
    return sendJson(res, 400, { ok: false, error: "Invalid IPC channel" });
  }

  const args = ipcArgsFromRequestBody(parsed);
  const payload = payloadFromArgs(args);
  const clientId = typeof parsed.clientId === "string" ? parsed.clientId : "";
  const remoteAddress = remoteAddressFromRequest(req);
  const startedAtMs = Date.now();
  const diagnosticBase = {
    ...ipcPayloadSummary(payload),
    argsCount: args.length,
    channel,
    clientId: shortId(clientId),
    remoteAddress,
  };
  const suppressRoutineLog = shouldSuppressRoutineIpcLog(payload);
  // 成功 IPC start/end 会跟随前端渲染频率放大；默认保留慢调用和失败日志，DEBUG 时再展开完整链路。
  if (DEBUG_LOGS && !suppressRoutineLog) diagnosticLog("gateway-ipc", "invoke_start", diagnosticBase);
  try {
    // AsyncLocalStorage 让后续官方 webContents.send 能知道这次 HTTP IPC 属于哪个浏览器 client。
    const value = await requestContext.run({ clientId, remoteAddress }, () =>
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
    return sendJson(res, 200, { ok: true, value });
  } catch (error) {
    const elapsedMs = Date.now() - startedAtMs;
    diagnosticWarn("gateway-ipc", "invoke_failed", {
      ...diagnosticBase,
      elapsedMs,
      error: error instanceof Error ? error.message : String(error),
      ok: false,
    });
    return sendJson(res, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
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
  // 先启动官方 runtime，确保后续 health/IPC 路由能看到官方 handler 注册状态。
  await startOfficialRuntime();

  const localFiles = createLocalFileService();
  const staticAssets = createStaticAssetService({ getOfficialBundle });
  const requestHandler = createRequestHandler({ localFiles, staticAssets });
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
  const webSocketHub = createWsHub(server, { createAppHostRelay: createOfficialAppHostRelay, isAuthed });
  // official-runtime 通过这个 hub 把官方 renderer 的异步消息转发给浏览器。
  setWsHub(webSocketHub);
  installShutdownHandlers(server, localFiles);
  await listen(server);

  diagnosticLog("gateway", "listening", { url: `http://${HOST}:${PORT}` });
  diagnosticLog("gateway", "health_endpoint", { url: `http://${HOST}:${PORT}/api/health` });
  diagnosticLog("gateway", "unknown_ipc_log", { path: path.relative(PROJECT_ROOT, UNKNOWN_IPC_PATH) });

  return { localFiles, server, staticAssets, wsHub: webSocketHub };
}

module.exports = { createGateway, createRequestHandler };
