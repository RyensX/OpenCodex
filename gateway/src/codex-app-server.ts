// @ts-nocheck
export {};

const { spawn } = require("child_process");
const net = require("net");
const path = require("path");
const { enrichNotificationForReviewDiff } = require("./ipc/codex/reviewDiffSnapshots");

let WebSocketImpl = globalThis.WebSocket;
try {
  WebSocketImpl = require("ws");
} catch {}

const PROJECT_ROOT = path.resolve(__dirname, "../..");

/**
 * 创建一个最小 JSON-RPC client。
 *
 * app-server 通过 WebSocket 使用 JSON-RPC；这里负责 request id、pending promise、
 * 超时和连接断开时的统一失败处理。
 */
function createJsonRpcClient(sendFn) {
  let nextId = 1;
  const pending = new Map();

  /** 收到 app-server 响应时，根据 id 找到 pending promise 并完成它。 */
  function settle(message) {
    if (!message || typeof message !== "object") return false;
    if (Object.prototype.hasOwnProperty.call(message, "id") && pending.has(message.id)) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      if (entry.timer) clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else entry.resolve(message.result);
      return true;
    }
    return false;
  }

  return {
    settle,
    /** 发送需要响应的 JSON-RPC request。 */
    request(method, params, options = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timeoutMs = Number(options && options.timeoutMs);
        const entry = { resolve, reject, timer: null };
        if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
          // 关键请求不能无限挂住，否则 renderer 会一直等模型、技能或会话恢复结果。
          entry.timer = setTimeout(() => {
            if (!pending.has(id)) return;
            pending.delete(id);
            reject(new Error(`app-server request timed out after ${timeoutMs}ms: ${method}`));
          }, timeoutMs);
          if (entry.timer && typeof entry.timer.unref === "function") entry.timer.unref();
        }
        pending.set(id, entry);
        sendFn({ id, method, params }).catch((error) => {
          const current = pending.get(id);
          if (current && current.timer) clearTimeout(current.timer);
          pending.delete(id);
          reject(error);
        });
      });
    },
    /** 发送不需要响应的 JSON-RPC notification。 */
    notify(method, params) {
      return sendFn(params === undefined ? { method } : { method, params });
    },
    /** socket 断开或 dispose 时，把所有未完成请求一起失败掉。 */
    failAll(error) {
      for (const { reject, timer } of pending.values()) {
        if (timer) clearTimeout(timer);
        reject(error);
      }
      pending.clear();
    },
  };
}

function shellQuote(value) {
  // Windows 这里会走 cmd.exe /d /s /c，单引号不会保护带空格的 Program Files 路径。
  if (process.platform === "win32") return `"${String(value).replace(/"/g, '""')}"`;
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

/** 从 CODEX_APP_SERVER_CMD 里推导 --listen endpoint，避免重复配置 URL。 */
function deriveListenEndpointFromCommand(cmd) {
  if (!cmd) return "";
  const listenMatch = cmd.match(/--listen(?:=|\s+)([^\s"']+)/);
  return listenMatch ? listenMatch[1] : "";
}

function normalizeWebSocketUrl(candidate) {
  if (!candidate) return "";
  if (/^wss?:\/\//i.test(candidate)) return candidate;
  if (/^https?:\/\//i.test(candidate)) {
    return candidate.replace(/^http:\/\//i, "ws://").replace(/^https:\/\//i, "wss://");
  }
  if (/^[^:]+:\d+$/.test(candidate)) return `ws://${candidate}`;
  return "";
}

function transportFromEndpoint(endpoint) {
  const candidate = String(endpoint || "");
  if (!candidate) return { kind: "none", endpoint: "", display: "none" };
  const wsUrl = normalizeWebSocketUrl(candidate);
  if (wsUrl) return { kind: "websocket", endpoint: wsUrl, display: wsUrl };
  if (candidate === "stdio://") return { kind: "stdio", endpoint: candidate, display: candidate };
  if (candidate.startsWith("unix://")) {
    const socketPath = candidate.slice("unix://".length);
    if (socketPath) return { kind: "unix", endpoint: socketPath, display: candidate };
    return { kind: "unix", endpoint: "", display: candidate };
  }
  return { kind: "unknown", endpoint: candidate, display: candidate };
}

function deriveTransport(url, cmd) {
  const configuredUrl = String(url || "");
  if (configuredUrl) return transportFromEndpoint(configuredUrl);
  return transportFromEndpoint(deriveListenEndpointFromCommand(cmd));
}

/** 从 CODEX_APP_SERVER_CMD 里推导 WebSocket 地址，保留给旧 health/兼容逻辑。 */
function deriveUrlFromCommand(cmd) {
  if (!cmd) return "";
  const candidate = deriveListenEndpointFromCommand(cmd);
  if (!candidate) return "";
  return normalizeWebSocketUrl(candidate);
}

/** 日志预览前递归打码 token/password 等敏感字段。 */
function redactSensitiveValues(value) {
  if (typeof value === "string") {
    return value.length > 24 && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)
      ? "[redacted-jwt]"
      : value;
  }
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((entry) => redactSensitiveValues(entry));
  const redacted = {};
  for (const [key, entry] of Object.entries(value)) {
    if (/token|authorization|secret|credential|password/i.test(key)) {
      redacted[key] = entry == null ? entry : "[redacted]";
    } else {
      redacted[key] = redactSensitiveValues(entry);
    }
  }
  return redacted;
}

/** 生成适合日志输出的短预览，避免大对象或敏感信息刷屏。 */
function safePreview(value) {
  try {
    return JSON.stringify(redactSensitiveValues(value)).slice(0, 300);
  } catch {
    return String(value);
  }
}

/** 读取正数环境变量，非法值统一回退，避免 NaN 进入超时/TTL 计算。 */
function parsePositiveNumberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * 创建 gateway 到 Codex app-server 的连接管理器。
 *
 * 所有 /wham、/aip、模型、技能、会话等业务数据都应该通过这里走本机
 * app-server，不让远端浏览器直接拿 token 或直连底层服务。
 */
function createCodexAppServerClient({ broadcast, logger, defaultCodexBinaryPath } = {}) {
  const url = process.env.CODEX_APP_SERVER_URL || "";
  const defaultPort = String(process.env.CODEX_APP_SERVER_PORT || 3760);
  const defaultCmd = defaultCodexBinaryPath
    ? `${shellQuote(defaultCodexBinaryPath)} app-server --listen stdio://`
    : `codex app-server --listen ws://127.0.0.1:${defaultPort}`;
  const cmd = process.env.CODEX_APP_SERVER_CMD || (url ? "" : defaultCmd);
  const transport = deriveTransport(url, cmd);
  const derivedUrl = transport.kind === "websocket" ? transport.endpoint : "";
  let child = null;
  let socket = null;
  let client = null;
  let sendMessage = null;
  let connected = false;
  let connecting = false;
  let connectionPromise = null;
  let connectionResolve = null;
  let connectionReject = null;
  let lastError = null;
  let reconnectTimer = null;
  let disposed = false;
  const pendingTurnsByThreadId = new Map();
  const pendingTurnIdleTimers = new Map();
  const pendingServerRequests = new Map();
  const requestClientIdsByThreadId = new Map();
  // responseCache 保存可缓存 RPC 的最近结果，减少远端设备加载时的一串阻塞请求。
  const responseCache = new Map();
  // inflightRequests 用来合并同一个 cache key 的并发请求，避免首屏同时打爆 app-server。
  const inflightRequests = new Map();
  // cacheVersions 用于判断后台刷新完成前后是否已有更新，避免过期结果覆盖新结果。
  const cacheVersions = new Map();
  const backgroundRefreshKeys = new Set();
  const CACHEABLE_REQUEST_TIMEOUT_MS = Math.max(
    1_000,
    parsePositiveNumberEnv("CODEX_WEB_APP_SERVER_CACHEABLE_REQUEST_TIMEOUT_MS", 15 * 1000)
  );
  const METHOD_REQUEST_TIMEOUTS_MS = new Map([
    ["thread/read", 15 * 1000],
    ["thread/turns/list", 15 * 1000],
    ["thread/goal/get", 10 * 1000],
    ["thread/resume", 30 * 1000],
  ]);
  const REQUEST_CLIENT_TTL_MS = 10 * 60 * 1000;
  // fresh TTL：在这段时间内直接返回缓存，同时后台可按需刷新。
  const CACHEABLE_METHOD_TTLS_MS = new Map([
    ["account/read", 30 * 1000],
    ["account/rateLimits/read", 30 * 1000],
    ["app/list", 5 * 60 * 1000],
    ["config/read", 30 * 1000],
    ["configRequirements/read", 5 * 60 * 1000],
    ["experimentalFeature/list", 5 * 60 * 1000],
    ["getAuthStatus", 60 * 1000],
    ["mcpServerStatus/list", 60 * 1000],
    ["model/list", 5 * 60 * 1000],
    ["plugin/list", 5 * 60 * 1000],
    ["skills/list", 5 * 60 * 1000],
    ["thread/list", 30 * 1000],
    ["thread/loaded/list", 30 * 1000],
  ]);
  // stale TTL：超过 fresh 但还未过期时可以先返回旧数据，提升弱网/远端体验。
  const CACHEABLE_METHOD_STALE_MS = new Map([
    ["account/read", 2 * 60 * 1000],
    ["account/rateLimits/read", 2 * 60 * 1000],
    ["app/list", 30 * 60 * 1000],
    ["config/read", 2 * 60 * 1000],
    ["configRequirements/read", 30 * 60 * 1000],
    ["experimentalFeature/list", 30 * 60 * 1000],
    ["mcpServerStatus/list", 10 * 60 * 1000],
    ["model/list", 60 * 60 * 1000],
    ["plugin/list", 30 * 60 * 1000],
    ["skills/list", 30 * 60 * 1000],
    ["thread/list", 5 * 60 * 1000],
    ["thread/loaded/list", 5 * 60 * 1000],
  ]);
  // 模型列表影响输入框右下角显示，优先预热。
  const CRITICAL_PREWARM_REQUESTS = [
    ["model/list", {}],
  ];
  // 启动预热覆盖首屏和设置页常用数据，减少浏览器打开后的串行等待。
  const DEFAULT_PREWARM_REQUESTS = [
    ["account/read", {}],
    ["config/read", {}],
    ["configRequirements/read", {}],
    ...CRITICAL_PREWARM_REQUESTS,
    ["plugin/list", {}],
    ["skills/list", {}],
    ["thread/list", {}],
    ["thread/loaded/list", {}],
    ["mcpServerStatus/list", {}],
  ];

  function timeoutForRequest(method, key, options) {
    const explicitTimeoutMs = Number(options && options.timeoutMs);
    if (Number.isFinite(explicitTimeoutMs) && explicitTimeoutMs > 0) return explicitTimeoutMs;
    if (key) return CACHEABLE_REQUEST_TIMEOUT_MS;
    return METHOD_REQUEST_TIMEOUTS_MS.get(method) || 0;
  }

  function threadIdFromParams(params) {
    if (!params || typeof params !== "object") return "";
    if (typeof params.threadId === "string" && params.threadId) return params.threadId;
    if (typeof params.conversationId === "string" && params.conversationId) return params.conversationId;
    if (params.thread && typeof params.thread === "object" && typeof params.thread.id === "string") {
      return params.thread.id;
    }
    return "";
  }

  function pruneRequestClientIds(now = Date.now()) {
    for (const [threadId, entry] of requestClientIdsByThreadId.entries()) {
      if (!entry || entry.expiresAtMs <= now) requestClientIdsByThreadId.delete(threadId);
    }
  }

  function recordRequestClient(method, params, clientId) {
    const normalizedClientId = typeof clientId === "string" ? clientId : "";
    if (!normalizedClientId) return false;
    const threadId = threadIdFromParams(params);
    if (!threadId) return false;
    const now = Date.now();
    pruneRequestClientIds(now);
    requestClientIdsByThreadId.set(threadId, {
      clientId: normalizedClientId,
      method: String(method || ""),
      expiresAtMs: now + REQUEST_CLIENT_TTL_MS,
    });
    return true;
  }

  function targetClientIdForServerRequest(request) {
    const params = request && request.params && typeof request.params === "object" ? request.params : null;
    const threadId = threadIdFromParams(params);
    if (!threadId) return "";
    pruneRequestClientIds();
    const entry = requestClientIdsByThreadId.get(threadId);
    return entry && typeof entry.clientId === "string" ? entry.clientId : "";
  }

  /** app-server 某些方法要求 params 不能缺失，这里补齐默认请求参数。 */
  function normalizeParams(method, params) {
    if (params !== null && params !== undefined) return params;
    switch (method) {
      case "initialize":
        return {
          clientInfo: {
            name: "codex-web-gateway",
            title: null,
            version: "0.0.0-web",
          },
          capabilities: {
            experimentalApi: true,
            requestAttestation: false,
          },
        };
      case "account/read":
      case "account/rateLimits/read":
      case "app/list":
      case "configRequirements/read":
      case "experimentalFeature/list":
      case "getAuthStatus":
      case "mcpServerStatus/list":
      case "model/list":
      case "plugin/list":
      case "skills/list":
      case "thread/list":
      case "thread/loaded/list":
      case "config/read":
        return {};
      default:
        return params;
    }
  }

  /** 通过当前 transport 向 app-server 写入 JSON-RPC 消息。 */
  async function sendJson(message) {
    if (typeof sendMessage !== "function") {
      throw new Error(`app-server ${transport.kind} transport is not connected`);
    }
    await sendMessage(message);
  }

  /** 兼容浏览器 WebSocket 和 ws 包的事件 API 差异。 */
  function onSocketEvent(ws, eventName, handler) {
    if (typeof ws.addEventListener === "function") {
      ws.addEventListener(eventName, handler);
      return;
    }
    if (typeof ws.on === "function") {
      ws.on(eventName, handler);
    }
  }

  /** app-server notification 转成 gateway 广播，同时触发相关缓存失效/刷新。 */
  function broadcastNotification(method, payload) {
    if (!method) return;
    const normalized = String(method);
    const notificationPayload = enrichNotificationForReviewDiff(normalized, payload);
    scheduleCacheRefresh(invalidateCacheForNotification(normalized));
    if (typeof broadcast !== "function") return;
    if (normalized === "turn/started" && notificationPayload && typeof notificationPayload === "object") {
      const threadId = typeof notificationPayload.threadId === "string" ? notificationPayload.threadId : null;
      const turnId = notificationPayload.turn && typeof notificationPayload.turn.id === "string" ? notificationPayload.turn.id : null;
      if (threadId && turnId) {
        pendingTurnsByThreadId.set(threadId, {
          turnId,
          startedAt: notificationPayload.turn.startedAt ?? Math.floor(Date.now() / 1000),
        });
      }
    }
    if (normalized === "turn/completed" && notificationPayload && typeof notificationPayload === "object") {
      const threadId = typeof notificationPayload.threadId === "string" ? notificationPayload.threadId : null;
      if (threadId) {
        pendingTurnsByThreadId.delete(threadId);
        const timer = pendingTurnIdleTimers.get(threadId);
        if (timer) clearTimeout(timer);
        pendingTurnIdleTimers.delete(threadId);
      }
    }
    const colonVariant = normalized.replace(/\//g, ":");
    const dashVariant = normalized.replace(/\//g, "-");
    const envelopes = [
      {
        channel: "mcp-notification",
        payload: {
          hostId: "local",
          method: normalized,
          params: notificationPayload,
        },
      },
      { channel: `app-server:${normalized}`, payload: notificationPayload },
      { channel: normalized, payload: notificationPayload },
    ];
    if (colonVariant !== normalized) {
      envelopes.push({ channel: colonVariant, payload: notificationPayload });
    }
    if (dashVariant !== normalized && dashVariant !== colonVariant) {
      envelopes.push({ channel: dashVariant, payload: notificationPayload });
    }
    for (const entry of envelopes) {
      broadcast(entry);
    }
    if (
      normalized === "thread/status/changed" &&
      notificationPayload &&
      typeof notificationPayload === "object" &&
      notificationPayload.status &&
      notificationPayload.status.type === "idle" &&
      typeof notificationPayload.threadId === "string" &&
      pendingTurnsByThreadId.has(notificationPayload.threadId) &&
      !pendingTurnIdleTimers.has(notificationPayload.threadId)
    ) {
      const threadId = notificationPayload.threadId;
      const timer = setTimeout(() => {
        pendingTurnIdleTimers.delete(threadId);
        const pendingTurn = pendingTurnsByThreadId.get(threadId);
        if (!pendingTurn) return;
        pendingTurnsByThreadId.delete(threadId);
        broadcastNotification("turn/completed", {
          threadId,
          turn: {
            id: pendingTurn.turnId,
            items: [],
            status: "completed",
            error: null,
            startedAt: pendingTurn.startedAt ?? null,
            completedAt: Math.floor(Date.now() / 1000),
            durationMs: null,
          },
          synthesized: true,
        });
      }, 300);
      pendingTurnIdleTimers.set(threadId, timer);
    }
  }

  /** 生成缓存 key；无法序列化的参数不缓存。 */
  function cacheKey(method, params) {
    try {
      return `${method}:${JSON.stringify(params ?? null)}`;
    } catch {
      return null;
    }
  }

  /** 判断某个 app-server request 是否允许走缓存。 */
  function shouldCacheRequest(method, params) {
    if (!CACHEABLE_METHOD_TTLS_MS.has(method)) return false;
    if (params && typeof params === "object" && params.forceReload) return false;
    return true;
  }

  /** 删除某个 method 的所有缓存和正在进行的同类请求。 */
  function deleteCachedMethod(method) {
    cacheVersions.set(method, (cacheVersions.get(method) || 0) + 1);
    for (const key of responseCache.keys()) {
      if (key.startsWith(`${method}:`)) responseCache.delete(key);
    }
    for (const key of inflightRequests.keys()) {
      if (key.startsWith(`${method}:`)) inflightRequests.delete(key);
    }
  }

  /** 缓存失效后把需要后台刷新的 method 加入刷新队列。 */
  function addRefreshTarget(targets, method, params = {}) {
    deleteCachedMethod(method);
    targets.push([method, params]);
  }

  /** 根据 app-server 主动通知判断哪些缓存需要失效。 */
  function invalidateCacheForNotification(method) {
    const refreshTargets = [];
    if (method === "skills/changed") addRefreshTarget(refreshTargets, "skills/list");
    if (method === "account/updated") {
      addRefreshTarget(refreshTargets, "account/read");
      addRefreshTarget(refreshTargets, "account/rateLimits/read");
      addRefreshTarget(refreshTargets, "getAuthStatus");
      addRefreshTarget(refreshTargets, "model/list");
    }
    if (method === "app/list/updated") {
      // app-server 已经把最新列表放在 notification payload 里；主动再拉 app/list
      // 会触发新的 app/list/updated，形成刷新风暴并挤占会话切换请求。
      deleteCachedMethod("app/list");
    }
    if (method === "mcpServer/startupStatus/updated" || method === "mcpServer/oauthLogin/completed") {
      addRefreshTarget(refreshTargets, "mcpServerStatus/list");
      addRefreshTarget(refreshTargets, "model/list");
    }
    if (
      method === "thread/started" ||
      method === "thread/archived" ||
      method === "thread/unarchived" ||
      method === "thread/closed" ||
      method === "thread/name/updated"
    ) {
      addRefreshTarget(refreshTargets, "thread/list");
      addRefreshTarget(refreshTargets, "thread/loaded/list");
    } else if (method === "thread/status/changed") {
      deleteCachedMethod("thread/list");
      deleteCachedMethod("thread/loaded/list");
    }
    return refreshTargets;
  }

  /** 根据会改变状态的 request 判断哪些缓存需要失效。 */
  function invalidateCacheForRequest(method) {
    const refreshTargets = [];
    if (method.startsWith("thread/") && method !== "thread/list" && method !== "thread/loaded/list") {
      addRefreshTarget(refreshTargets, "thread/list");
      addRefreshTarget(refreshTargets, "thread/loaded/list");
    }
    if (method.startsWith("skills/") && method !== "skills/list") addRefreshTarget(refreshTargets, "skills/list");
    if (method.startsWith("plugin/") && method !== "plugin/list" && method !== "plugin/read") {
      addRefreshTarget(refreshTargets, "plugin/list");
      addRefreshTarget(refreshTargets, "app/list");
      addRefreshTarget(refreshTargets, "mcpServerStatus/list");
      addRefreshTarget(refreshTargets, "configRequirements/read");
    }
    if (method.startsWith("marketplace/")) {
      addRefreshTarget(refreshTargets, "plugin/list");
      addRefreshTarget(refreshTargets, "app/list");
      addRefreshTarget(refreshTargets, "mcpServerStatus/list");
      addRefreshTarget(refreshTargets, "configRequirements/read");
    }
    if (method.startsWith("config/") && method !== "config/read") {
      addRefreshTarget(refreshTargets, "config/read");
      addRefreshTarget(refreshTargets, "configRequirements/read");
      addRefreshTarget(refreshTargets, "mcpServerStatus/list");
      addRefreshTarget(refreshTargets, "plugin/list");
      addRefreshTarget(refreshTargets, "model/list");
    }
    if (method.startsWith("model/") && method !== "model/list") {
      addRefreshTarget(refreshTargets, "model/list");
    }
    if (
      method.startsWith("mcpServer/") ||
      (method.startsWith("mcpServerStatus/") && method !== "mcpServerStatus/list")
    ) {
      addRefreshTarget(refreshTargets, "mcpServerStatus/list");
    }
    if (method.startsWith("account/") && !["account/read", "account/rateLimits/read"].includes(method)) {
      addRefreshTarget(refreshTargets, "account/read");
      addRefreshTarget(refreshTargets, "account/rateLimits/read");
      addRefreshTarget(refreshTargets, "getAuthStatus");
    }
    return refreshTargets;
  }

  /** 把缓存刷新放到后台执行，并对相同 key 去重。 */
  function scheduleCacheRefresh(requests) {
    const uniqueRequests = [];
    for (const [method, params] of requests || []) {
      const normalizedParams = normalizeParams(method, params);
      const key = cacheKey(method, normalizedParams);
      if (!key || backgroundRefreshKeys.has(key)) continue;
      backgroundRefreshKeys.add(key);
      uniqueRequests.push([method, normalizedParams, key]);
    }
    if (uniqueRequests.length === 0) return;
    const timer = setTimeout(() => {
      warmCache(uniqueRequests.map(([method, params]) => [method, params])).finally(() => {
        for (const [, , key] of uniqueRequests) backgroundRefreshKeys.delete(key);
      });
    }, 0);
    if (timer && typeof timer.unref === "function") timer.unref();
  }

  /** WebSocket 连接成功后释放等待 ensureConnection 的调用方。 */
  function resolveConnectionPromise() {
    if (connectionResolve) connectionResolve();
    connectionPromise = null;
    connectionResolve = null;
    connectionReject = null;
  }

  /** WebSocket 连接失败/断开后让等待者拿到明确错误。 */
  function rejectConnectionPromise(error) {
    if (connectionReject) connectionReject(error);
    connectionPromise = null;
    connectionResolve = null;
    connectionReject = null;
  }

  function shouldReconnectAppServer() {
    return !!cmd || transport.kind === "websocket" || transport.kind === "unix";
  }

  function scheduleReconnect(error) {
    if (disposed || !shouldReconnectAppServer()) return;
    lastError = error || lastError;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      ensureConnection().catch((retryError) => {
        lastError = retryError;
        logger && logger.warn("[app-server] reconnect failed", retryError);
      });
    }, 1000);
  }

  async function completeConnectionHandshake() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    connected = true;
    connecting = false;
    lastError = null;
    try {
      await client.request("initialize", normalizeParams("initialize", null));
      await client.notify("initialized");
      broadcast && broadcast({ channel: "app-server:initialized", payload: { ok: true } });
      resolveConnectionPromise();
    } catch (error) {
      logger && logger.warn("[app-server] initialize failed", error);
      connected = false;
      lastError = error;
      rejectConnectionPromise(error);
      scheduleReconnect(error);
    }
  }

  function handleTransportClosed(error) {
    if (disposed) return;
    connected = false;
    connecting = false;
    sendMessage = null;
    rejectConnectionPromise(error);
    client && client.failAll(error);
    client = null;
    scheduleReconnect(error);
  }

  function parseRawMessage(raw) {
    if (Buffer.isBuffer(raw)) return JSON.parse(raw.toString("utf8"));
    if (typeof raw === "string") return JSON.parse(raw);
    if (raw instanceof ArrayBuffer) return JSON.parse(Buffer.from(raw).toString("utf8"));
    if (ArrayBuffer.isView(raw)) return JSON.parse(Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString("utf8"));
    return raw && typeof raw === "object" ? raw : JSON.parse(String(raw));
  }

  async function handleAppServerMessage(raw, event = null) {
    try {
      const msg = parseRawMessage(raw);
      logger &&
        logger.info("[app-server] inbound message", {
          transport: transport.kind,
          eventType: event && typeof event === "object" ? event.constructor && event.constructor.name : null,
          rawType: raw && raw.constructor ? raw.constructor.name : typeof raw,
          type: Array.isArray(msg) ? "array" : typeof msg,
          hasId: !!(msg && typeof msg === "object" && Object.prototype.hasOwnProperty.call(msg, "id")),
          id: msg && typeof msg === "object" && Object.prototype.hasOwnProperty.call(msg, "id") ? msg.id : null,
          method: msg && typeof msg === "object" && typeof msg.method === "string" ? msg.method : null,
          hasResult: !!(msg && typeof msg === "object" && Object.prototype.hasOwnProperty.call(msg, "result")),
          hasError: !!(msg && typeof msg === "object" && Object.prototype.hasOwnProperty.call(msg, "error")),
          preview: safePreview(msg),
        });
      const hasId = msg && typeof msg === "object" && Object.prototype.hasOwnProperty.call(msg, "id");
      // 带 id 且有 method、没有 result/error 的消息，是 app-server 要 renderer 处理的反向请求。
      const isServerRequest =
        hasId &&
        msg &&
        typeof msg.method === "string" &&
        !Object.prototype.hasOwnProperty.call(msg, "result") &&
        !Object.prototype.hasOwnProperty.call(msg, "error");
      if (client && client.settle(msg)) {
        return;
      }
      if (isServerRequest) {
        rememberServerRequest(msg);
        return;
      }
      if (msg && typeof msg.method === "string") {
        broadcastNotification(msg.method, msg.params ?? msg.result ?? null);
      }
    } catch (error) {
      logger && logger.warn("[app-server] message parse failed", error);
    }
  }

  function createJsonLineReader(sourceName) {
    let buffer = "";
    return (chunk) => {
      buffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) {
          handleAppServerMessage(line, { sourceName }).catch((error) => {
            logger && logger.warn("[app-server] message handle failed", error);
          });
        }
        newlineIndex = buffer.indexOf("\n");
      }
    };
  }

  function logChildStderr(chunk) {
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk || "");
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      logger && logger.warn("[app-server] stderr", line.length > 1000 ? `${line.slice(0, 1000)}...` : line);
    }
  }

  /** app-server 主动发来的 request id 统一转成字符串 key。 */
  function serverRequestKey(id) {
    return String(id);
  }

  /** 记录 app-server 发给 renderer 的 mcp-request，并广播给 web-shell 处理。 */
  function rememberServerRequest(message) {
    const request = {
      id: message.id,
      method: message.method,
      params: message.params ?? null,
    };
    const targetClientId = targetClientIdForServerRequest(request);
    pendingServerRequests.set(serverRequestKey(message.id), { ...request, targetClientId });
    if (typeof broadcast === "function") {
      broadcast({
        channel: "mcp-request",
        payload: {
          hostId: "local",
          request,
        },
        ...(targetClientId ? { targetClientId } : {}),
      });
    }
  }

  /** web-shell 返回 mcp-response 后，把响应转回 app-server。 */
  async function respondToServerRequest(response) {
    if (!response || typeof response !== "object" || !Object.prototype.hasOwnProperty.call(response, "id")) {
      throw new Error("invalid app-server response: missing id");
    }
    await ensureConnection();
    if (!client || !connected || typeof sendMessage !== "function") {
      throw lastError || new Error("app-server is not connected");
    }

    const requestKey = serverRequestKey(response.id);
    const pending = pendingServerRequests.get(requestKey);
    const wireResponse = {
      ...response,
      id: pending ? pending.id : response.id,
    };
    logger &&
      logger.info("[app-server] server request response", {
        id: wireResponse.id,
        method: pending ? pending.method : null,
        hasResult: Object.prototype.hasOwnProperty.call(wireResponse, "result"),
        hasError: Object.prototype.hasOwnProperty.call(wireResponse, "error"),
      });
    await sendJson(wireResponse);
    pendingServerRequests.delete(requestKey);

    const params = pending && pending.params && typeof pending.params === "object" ? pending.params : null;
    if (pending && params && typeof params.threadId === "string") {
      broadcastNotification("serverRequest/resolved", {
        threadId: params.threadId,
        requestId: pending.id,
      });
    }
    return true;
  }

  /** 绑定 app-server WebSocket 生命周期，并把 JSON-RPC 消息分成响应、请求、通知三类。 */
  function attachSocket(ws) {
    socket = ws;
    connected = false;
    sendMessage = async (message) => {
      if (!socket || socket.readyState !== WebSocketImpl.OPEN) {
        throw new Error("app-server websocket is not connected");
      }
      socket.send(JSON.stringify(message));
    };
    client = createJsonRpcClient(sendJson);
    onSocketEvent(ws, "open", async () => {
      await completeConnectionHandshake();
    });
    onSocketEvent(ws, "message", async (event) => {
      const raw = event && typeof event === "object" && "data" in event ? event.data : event;
      await handleAppServerMessage(raw, event);
    });
    onSocketEvent(ws, "close", () => {
      handleTransportClosed(new Error("app-server disconnected"));
    });
    onSocketEvent(ws, "error", (event) => {
      handleTransportClosed(event.error || new Error("app-server websocket error"));
    });
  }

  /** 新版 Codex.app app-server 默认使用 stdio://，一行一个 JSON 消息。 */
  async function attachStdioChild(childProcess) {
    socket = null;
    const stdoutReader = createJsonLineReader("stdout");
    sendMessage = async (message) => {
      if (!childProcess.stdin || childProcess.stdin.destroyed || !childProcess.stdin.writable) {
        throw new Error("app-server stdio is not connected");
      }
      childProcess.stdin.write(`${JSON.stringify(message)}\n`);
    };
    client = createJsonRpcClient(sendJson);
    childProcess.stdout.on("data", stdoutReader);
    childProcess.stderr.on("data", logChildStderr);
    await completeConnectionHandshake();
  }

  /** unix://PATH 使用与 stdio 相同的 JSON-lines framing，只是底层换成 Unix domain socket。 */
  function attachUnixSocket(socketPath) {
    if (!socketPath) throw new Error("app-server unix transport requires a socket path");
    const unixSocket = net.createConnection(socketPath);
    socket = unixSocket;
    const lineReader = createJsonLineReader("unix");
    sendMessage = async (message) => {
      if (!unixSocket || !unixSocket.writable || unixSocket.destroyed) {
        throw new Error("app-server unix socket is not connected");
      }
      unixSocket.write(`${JSON.stringify(message)}\n`);
    };
    client = createJsonRpcClient(sendJson);
    unixSocket.on("connect", async () => {
      await completeConnectionHandshake();
    });
    unixSocket.on("data", lineReader);
    unixSocket.on("close", () => {
      handleTransportClosed(new Error("app-server unix socket disconnected"));
    });
    unixSocket.on("error", (error) => {
      handleTransportClosed(error || new Error("app-server unix socket error"));
    });
  }

  /** 确保 app-server 已启动并连上；并发调用会复用同一个 connectionPromise。 */
  async function ensureConnection() {
    if (disposed) throw new Error("app-server client disposed");
    if (connected) return;
    if (connecting && connectionPromise) return connectionPromise;
    connecting = true;
    connectionPromise = new Promise((resolve, reject) => {
      connectionResolve = resolve;
      connectionReject = reject;
    });
    try {
      if (transport.kind === "unknown") {
        throw new Error(`unsupported app-server transport endpoint: ${transport.endpoint}`);
      }
      if (transport.kind === "none") {
        throw new Error("app-server transport endpoint is not configured");
      }
      if (transport.kind === "stdio") {
        if (!cmd) throw new Error("app-server stdio transport requires CODEX_APP_SERVER_CMD or a default command");
        logger && logger.info(`[app-server] spawning (${transport.display}): ${cmd}`);
        child = spawn(cmd, {
          shell: true,
          stdio: ["pipe", "pipe", "pipe"],
          detached: process.platform !== "win32",
          env: process.env,
        });
        child.on("exit", (code, signal) => {
          logger && logger.info(`[app-server] child exited: code=${code} signal=${signal}`);
          child = null;
          handleTransportClosed(new Error(`app-server child exited: code=${code} signal=${signal}`));
        });
        attachStdioChild(child).catch((error) => {
          connected = false;
          connecting = false;
          lastError = error;
          rejectConnectionPromise(error);
          scheduleReconnect(error);
        });
        return connectionPromise;
      }
      if (cmd && !child) {
        logger && logger.info(`[app-server] spawning (${transport.display}): ${cmd}`);
        child = spawn(cmd, {
          shell: true,
          stdio: "ignore",
          detached: process.platform !== "win32",
          env: process.env,
        });
        child.on("exit", (code, signal) => {
          logger && logger.info(`[app-server] child exited: code=${code} signal=${signal}`);
          child = null;
        });
      }
      if (transport.kind === "websocket") {
        const ws = new WebSocketImpl(derivedUrl);
        attachSocket(ws);
      } else if (transport.kind === "unix") {
        attachUnixSocket(transport.endpoint);
      }
    } catch (error) {
      connecting = false;
      lastError = error;
      logger && logger.warn("[app-server] connection failed", error);
      rejectConnectionPromise(error);
      scheduleReconnect(error);
    }
    return connectionPromise;
  }

  /** 调用 app-server 方法，内置连接、缓存、并发合并和状态变更后的缓存刷新。 */
  async function request(method, params, options = {}) {
    const normalizedParams = normalizeParams(method, params);
    const key = shouldCacheRequest(method, normalizedParams) ? cacheKey(method, normalizedParams) : null;
    const startRequest = () => {
      const cacheVersion = cacheVersions.get(method) || 0;
      const run = (async () => {
        await ensureConnection();
        if (!client || !connected) {
          throw lastError || new Error("app-server is not connected");
        }
        logger &&
          logger.info(`[app-server] request ${method}`, {
            paramsShape:
              normalizedParams === null
                ? "null"
                : Array.isArray(normalizedParams)
                  ? `array(${normalizedParams.length})`
                  : typeof normalizedParams === "object"
                    ? `object(${Object.keys(normalizedParams).length})`
                    : typeof normalizedParams,
          });
        const timeoutMs = timeoutForRequest(method, key, options);
        return client.request(
          method,
          normalizedParams,
          timeoutMs > 0 ? { timeoutMs } : undefined
        );
      })();
      const tracked = key
        ? run
            .then((value) => {
              // 如果请求过程中缓存版本被 bump，说明已有更新，不能用旧结果覆盖缓存。
              if ((cacheVersions.get(method) || 0) === cacheVersion) {
                const ttlMs = CACHEABLE_METHOD_TTLS_MS.get(method);
                const staleMs = CACHEABLE_METHOD_STALE_MS.get(method) || 0;
                const now = Date.now();
                responseCache.set(key, {
                  value,
                  expiresAtMs: now + ttlMs,
                  staleUntilMs: now + ttlMs + staleMs,
                });
              }
              return value;
            })
            .finally(() => {
              inflightRequests.delete(key);
            })
        : run;
      if (key) inflightRequests.set(key, tracked);
      return tracked;
    };
    if (key) {
      const cached = responseCache.get(key);
      if (cached && Date.now() < cached.expiresAtMs) return cached.value;
      if (cached && Date.now() < (cached.staleUntilMs || 0)) {
        // stale-while-revalidate：先返回旧数据保证 UI 快，再后台刷新。
        if (!inflightRequests.has(key)) {
          startRequest().catch((error) => {
            logger && logger.warn(`[app-server] background refresh failed: ${method}`, error);
          });
        }
        return cached.value;
      }
      // 同一个 key 的并发请求复用同一个 Promise，避免首屏多个组件重复请求。
      if (inflightRequests.has(key)) return inflightRequests.get(key);
    }
    const promise = startRequest();
    const result = await promise;
    scheduleCacheRefresh(invalidateCacheForRequest(method));
    if (method === "turn/start") {
      // turn/start 的结果用于兜底合成 turn/completed，避免 UI 一直显示进行中。
      const threadId =
        normalizedParams && typeof normalizedParams === "object" && typeof normalizedParams.threadId === "string"
          ? normalizedParams.threadId
          : null;
      const turnId = result && result.turn && typeof result.turn.id === "string" ? result.turn.id : null;
      if (threadId && turnId) {
        pendingTurnsByThreadId.set(threadId, {
          turnId,
          startedAt: result.turn.startedAt ?? Math.floor(Date.now() / 1000),
        });
      }
    }
    return result;
  }

  /** 预热一组常用 app-server 请求；失败只记录日志，不阻塞 gateway 启动。 */
  function warmCache(requests = DEFAULT_PREWARM_REQUESTS) {
    return Promise.allSettled(
      requests.map(([method, params]) =>
        request(method, params).catch((error) => {
          logger && logger.warn(`[app-server] prewarm failed: ${method}`, error);
          throw error;
        })
      )
      );
  }

  /** 给 server.ts 首屏配置读取缓存；不会主动发请求。 */
  function getCachedResponse(method, params, allowStale = true) {
    const normalizedParams = normalizeParams(method, params);
    const key = shouldCacheRequest(method, normalizedParams) ? cacheKey(method, normalizedParams) : null;
    if (!key) return null;
    const cached = responseCache.get(key);
    if (!cached) return null;
    const now = Date.now();
    if (now < cached.expiresAtMs) return cached.value;
    if (allowStale && now < (cached.staleUntilMs || 0)) return cached.value;
    return null;
  }

  /** 启动预热：先拿模型列表，再把技能/插件/会话等放到后台补齐。 */
  async function warmStartupCache() {
    await warmCache(CRITICAL_PREWARM_REQUESTS);
    const secondaryRequests = DEFAULT_PREWARM_REQUESTS.filter(
      ([method]) => method !== "model/list"
    );
    const timer = setTimeout(() => {
      warmCache(secondaryRequests).catch((error) => {
        logger && logger.warn("[app-server] secondary prewarm failed", error);
      });
    }, 0);
    if (timer && typeof timer.unref === "function") timer.unref();
  }

  /** 是否已经完成 app-server initialize/initialized 握手。 */
  function isConnected() {
    return connected;
  }

  /** 返回对外展示用的连接模式。 */
  function getMode() {
    if (connected) return "connected";
    if (transport.kind !== "none" && transport.kind !== "unknown") return "connecting";
    if (cmd) return "configured";
    return "disconnected";
  }

  /** health API 使用的状态快照。 */
  function getHealth() {
    return {
      mode: getMode(),
      connected,
      transport: transport.kind,
      endpoint: transport.display || null,
      url: derivedUrl || null,
      cmd: cmd || null,
      lastError: lastError ? String(lastError.message || lastError) : null,
    };
  }

  /** gateway 退出时释放 socket、子进程、timer、pending promise 和缓存。 */
  function dispose() {
    if (disposed) return;
    disposed = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    rejectConnectionPromise(new Error("app-server client disposed"));
    if (client) {
      client.failAll(new Error("app-server client disposed"));
      client = null;
    }
    sendMessage = null;
    if (socket) {
      const currentSocket = socket;
      socket = null;
      try {
        if (typeof currentSocket.close === "function") currentSocket.close();
        else if (typeof currentSocket.destroy === "function") currentSocket.destroy();
        else if (typeof currentSocket.terminate === "function") currentSocket.terminate();
      } catch {}
    }
    if (child) {
      const currentChild = child;
      child = null;
      try {
        if (process.platform !== "win32" && currentChild.pid) {
          process.kill(-currentChild.pid);
        } else {
          currentChild.kill();
        }
      } catch {}
    }
    for (const timer of pendingTurnIdleTimers.values()) {
      clearTimeout(timer);
    }
    pendingTurnIdleTimers.clear();
    pendingTurnsByThreadId.clear();
    pendingServerRequests.clear();
    requestClientIdsByThreadId.clear();
    responseCache.clear();
    inflightRequests.clear();
    cacheVersions.clear();
    backgroundRefreshKeys.clear();
    connected = false;
    connecting = false;
  }

  return {
    ensureConnection,
    request,
    recordRequestClient,
    warmCache,
    getCachedResponse,
    warmStartupCache,
    respondToServerRequest,
    isConnected,
    getHealth,
    getMode,
    dispose,
  };
}

module.exports = {
  createCodexAppServerClient,
  createJsonRpcClient,
};
