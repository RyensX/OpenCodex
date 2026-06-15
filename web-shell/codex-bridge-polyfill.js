(function () {
  const w = window;
  if (w.__codexBridgePolyfillInstalled) return;
  w.__codexBridgePolyfillInstalled = true;
  const cfg = (w.__CODEX_WEB_CONFIG__ =
    w.__CODEX_WEB_CONFIG__ || {
      gatewayBaseUrl: location.origin,
      gatewayWsUrl: location.origin.replace(/^http/, "ws") + "/ws",
    });
  // 语言只信任 gateway 启动配置；浏览器侧不自行读配置或按平台猜测。
  const OPENCODEX_LOCALE = cfg.locale || "zh-CN";
  const OPENCODEX_MESSAGES = cfg.messages && typeof cfg.messages === "object" ? cfg.messages : {};
  function t(key, values) {
    const template = OPENCODEX_MESSAGES[key] || key;
    if (!values || typeof values !== "object") return template;
    return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name) =>
      Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match
    );
  }
  const OPENCODEX_LANGUAGES = [OPENCODEX_LOCALE, "zh-CN", "zh", "en-US", "en"];
  const AUTH_FORCE_LOGIN_STORAGE_KEY = "codex_web_force_login";
  const WS_READY_WAIT_TIMEOUT_MS = 2500;
  const CLIENT_DIAGNOSTIC_FLUSH_DELAY_MS = 120;
  const CLIENT_DIAGNOSTIC_MAX_BATCH = 40;
  const LOW_PRIORITY_IPC_CONCURRENCY = 2;
  const LOW_PRIORITY_IPC_LOG_EVERY = 25;
  // debugWs 由 gateway 的 OPENCODEX_DEBUG_WS 注入；默认关闭，避免每条 WS 消息都额外计时/算长度。
  const WS_DEBUG_ENABLED = cfg.debugWs === true || cfg.debugWs === "1";
  // 下面三个阈值只在 debugWs 开启时生效，用来定位“远端首个会话打开慢”的浏览器侧瓶颈。
  const WS_INBOUND_LARGE_CHARS = Number(cfg.wsInboundLargeChars || 256 * 1024);
  const WS_INBOUND_PARSE_SLOW_MS = Number(cfg.wsInboundParseSlowMs || 30);
  const WS_INBOUND_HANDLE_SLOW_MS = Number(cfg.wsInboundHandleSlowMs || 80);
  // app-host RPC 首屏会连续发多条字符串帧；WS 未握手完成前先短暂排队，超过上限直接关闭端口。
  const APP_HOST_PENDING_MESSAGE_LIMIT = 2000;
  const GATEWAY_AUTH_LOGOUT_LABEL = t("web.auth.logoutGateway");
  const GATEWAY_AUTH_LOGOUT_BUSY_LABEL = t("web.auth.logoutGatewayBusy");
  const OFFICIAL_LOGOUT_LABELS = [
    "退出登录",
    "Log out",
    "Logout",
    "Sign out",
    "Sign Out",
    "Sign out of Codex",
    "Log out of Codex",
  ];
  const MESSAGE_FOR_VIEW_CHANNEL = "codex_desktop:message-for-view";

  function installLocaleOverride() {
    try {
      document.documentElement.lang = OPENCODEX_LOCALE;
    } catch {}
    try {
      Object.defineProperty(navigator, "language", {
        configurable: true,
        get: () => OPENCODEX_LOCALE,
      });
    } catch {}
    try {
      Object.defineProperty(navigator, "languages", {
        configurable: true,
        get: () => OPENCODEX_LANGUAGES,
      });
    } catch {}
  }

  function opencodexPluginSystem() {
    return w.OpenCodexPluginSystem || w.__OpenCodexPluginSystem || null;
  }

  function emitOpenCodexPluginEvent(eventName, payload) {
    try {
      opencodexPluginSystem()?.events?.emit?.(eventName, payload);
    } catch {}
  }

  const tokenUsageCapability = createTokenUsageCapability();

  function createTokenUsageCapability() {
    const factory = w.__OpenCodexCreateTokenUsageCapability;
    if (typeof factory !== "function") return null;
    try {
      // tokenUsage 的重逻辑拆到独立 capability 文件，polyfill 只提供认证 header 和消息入口。
      return factory({ getAuthHeaders: gatewayAuthHeaders });
    } catch (error) {
      console.warn("[opencodex-token-usage] failed to initialize capability", error);
      return null;
    }
  }

  function handleTokenUsageAppHostData(data) {
    tokenUsageCapability?.handleAppHostData?.(data);
  }

  function handleTokenUsageGatewayPayload(payload) {
    tokenUsageCapability?.handleGatewayPayload?.(payload);
  }

  function gatewayAuthToken() {
    try {
      return String(w.__OPEN_CODEX_RUNTIME_AUTH_TOKEN__ || "").trim();
    } catch {
      return "";
    }
  }

  function gatewayAuthHeaders(headers) {
    const result = new Headers(headers || {});
    const token = gatewayAuthToken();
    if (token) {
      // 首次登录后 cookie 可能还没被浏览器带到所有子请求，显式 header 用来兜住这段竞态。
      result.set("authorization", `Bearer ${token}`);
      result.set("x-codex-web-token", token);
    }
    return result;
  }

  function gatewayWebSocketUrl() {
    const rawUrl = cfg.gatewayWsUrl || location.origin.replace(/^http/, "ws") + "/ws";
    const token = gatewayAuthToken();
    if (!token) return rawUrl;
    try {
      const parsed = new URL(rawUrl, location.href);
      // WebSocket 不能自定义 header，只能用短期 token query 配合 gateway 的 auth gate。
      parsed.searchParams.set("token", token);
      return parsed.toString();
    } catch {
      const separator = rawUrl.includes("?") ? "&" : "?";
      return `${rawUrl}${separator}token=${encodeURIComponent(token)}`;
    }
  }

  function forceGatewayLoginOnNextBoot() {
    try {
      localStorage.setItem(AUTH_FORCE_LOGIN_STORAGE_KEY, "1");
    } catch {}
  }

  /** 官方 renderer 依赖 crypto.randomUUID，旧浏览器缺失时在 web-shell 侧补齐。 */
  function installRandomUUIDPolyfill() {
    let cryptoObject = w.crypto || {};
    if (typeof cryptoObject.randomUUID === "function") return;
    const randomUUID = () => {
      const bytes = new Uint8Array(16);
      if (typeof cryptoObject.getRandomValues === "function") {
        cryptoObject.getRandomValues(bytes);
      } else {
        for (let i = 0; i < bytes.length; i += 1) {
          bytes[i] = Math.floor(Math.random() * 256);
        }
      }
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
      return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex
        .slice(6, 8)
        .join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
    };
    try {
      Object.defineProperty(cryptoObject, "randomUUID", {
        configurable: true,
        value: randomUUID,
      });
    } catch {
      try {
        cryptoObject.randomUUID = randomUUID;
      } catch {}
    }
    if (typeof cryptoObject.randomUUID !== "function") {
      const wrappedCrypto = Object.create(cryptoObject || null);
      Object.defineProperty(wrappedCrypto, "randomUUID", {
        configurable: true,
        value: randomUUID,
      });
      cryptoObject = wrappedCrypto;
    }
    if (!w.crypto || typeof w.crypto.randomUUID !== "function") {
      try {
        Object.defineProperty(w, "crypto", {
          configurable: true,
          value: cryptoObject,
        });
      } catch {}
    }
  }

  installLocaleOverride();
  installRandomUUIDPolyfill();

  /**
   * Electron 的 <webview> 在浏览器里不存在。
   *
   * 这里用 iframe 提供最小兼容层，满足官方 renderer 对 webview API 的常见调用。
   */
  function installWebviewShim() {
    if (!document || document.__codexWebviewShimInstalled) return;
    document.__codexWebviewShimInstalled = true;
    const originalCreateElement = document.createElement.bind(document);

    /** 只注入一次 webview shim 的布局样式。 */
    function ensureWebviewStyles() {
      if (document.getElementById("codex-web-webview-shim-styles")) return;
      const style = originalCreateElement("style");
      style.id = "codex-web-webview-shim-styles";
      style.textContent = `
        webview[data-codex-webview-shim="true"] {
          display: block;
          min-width: 0;
          min-height: 0;
          width: 100%;
          height: 100%;
          overflow: hidden;
        }
        webview[data-codex-webview-shim="true"] > iframe[data-codex-webview-frame="true"] {
          display: block;
          width: 100%;
          height: 100%;
          border: 0;
          background: transparent;
        }
      `;
      (document.head || document.documentElement).appendChild(style);
    }

    /** 把一个自定义 webview 元素包装成 iframe-backed shim。 */
    function installOnElement(element) {
      if (!element || element.__codexWebviewShimElement) return element;
      element.__codexWebviewShimElement = true;
      element.setAttribute("data-codex-webview-shim", "true");
      ensureWebviewStyles();

      const frame = originalCreateElement("iframe");
      frame.setAttribute("data-codex-webview-frame", "true");
      frame.setAttribute("allow", "clipboard-read; clipboard-write; fullscreen");
      frame.setAttribute("referrerpolicy", "no-referrer");
      frame.setAttribute("sandbox", "allow-forms allow-modals allow-popups allow-same-origin allow-scripts");
      element.appendChild(frame);

      const originalSetAttribute = element.setAttribute.bind(element);
      const originalRemoveAttribute = element.removeAttribute.bind(element);
      // src 属性需要同时驱动 iframe，否则官方组件设置 webview.src 不会真的加载页面。
      const syncSrc = (value) => {
        if (typeof value !== "string" || value.length === 0) {
          frame.removeAttribute("src");
          return;
        }
        frame.src = value;
      };

      element.setAttribute = (name, value) => {
        originalSetAttribute(name, value);
        if (String(name).toLowerCase() === "src") syncSrc(String(value));
      };
      element.removeAttribute = (name) => {
        originalRemoveAttribute(name);
        if (String(name).toLowerCase() === "src") frame.removeAttribute("src");
      };

      Object.defineProperty(element, "src", {
        configurable: true,
        get() {
          return frame.getAttribute("src") || "";
        },
        set(value) {
          element.setAttribute("src", value);
        },
      });
      Object.defineProperty(element, "contentWindow", {
        configurable: true,
        get() {
          return frame.contentWindow;
        },
      });

      element.getURL = () => frame.src || element.getAttribute("src") || "";
      element.loadURL = (url) => {
        element.setAttribute("src", url);
        return Promise.resolve();
      };
      element.reload = () => {
        try {
          frame.contentWindow?.location.reload();
        } catch {
          frame.src = frame.src;
        }
      };
      element.stop = () => {
        try {
          frame.contentWindow?.stop();
        } catch {}
      };
      element.goBack = () => {
        try {
          frame.contentWindow?.history.back();
        } catch {}
      };
      element.goForward = () => {
        try {
          frame.contentWindow?.history.forward();
        } catch {}
      };
      element.canGoBack = () => false;
      element.canGoForward = () => false;
      element.executeJavaScript = () => Promise.resolve(null);
      element.insertCSS = () => Promise.resolve("");
      element.openDevTools = () => {};
      element.send = () => {};

      frame.addEventListener("load", () => {
        element.dispatchEvent(new Event("dom-ready"));
        element.dispatchEvent(new Event("did-finish-load"));
      });
      frame.addEventListener("error", () => {
        element.dispatchEvent(new Event("did-fail-load"));
      });

      const initialSrc = element.getAttribute("src");
      if (initialSrc) syncSrc(initialSrc);
      return element;
    }

    // 劫持 createElement("webview")，其余元素保持原生行为。
    document.createElement = function createElement(name, options) {
      const element = originalCreateElement(name, options);
      return String(name).toLowerCase() === "webview" ? installOnElement(element) : element;
    };
  }

  installWebviewShim();

  const listeners = new Map();
  const authStatusCallbacks = new Set();
  const terminalMessageQueues = new Map();
  // 每个官方 connect-app-host MessagePort 对应一条 relay，key 是仅在当前页面内有效的 portId。
  const appHostPortRelays = new Map();
  const activeBrowserNotifications = new Map();
  const STATSIG_DEFAULT_FEATURES_CONFIG = "statsig_default_enable_features";
  const STATSIG_I18N_LAYER_CONFIG = "72216192";
  const STATSIG_I18N_LAYER_VALUES = {
    enable_i18n: true,
    locale_source: "IDE",
  };
  const STATSIG_DEFAULT_FEATURE_OVERRIDES = {
    guardian_approval: true,
    "3903742690": true,
    artifacts: true,
  };
  const clientId =
    w.crypto?.randomUUID?.() || `web-client-${Math.random().toString(36).slice(2)}`;
  let ws = null;
  let wsReady = false;
  const wsReadyWaiters = new Set();
  let reconnectTimer = null;
  let reconnectDelay = 500;
  const bridgeStartedAtMs = Date.now();
  const clientDiagnosticQueue = [];
  let clientDiagnosticFlushTimer = null;
  const lowPriorityIpcQueue = [];
  const connectorLogoResponseCache = new Map();
  const connectorLogoInFlight = new Map();
  const connectorLogoRequestCacheKeys = new Map();
  const connectorLogoDiagnosticCounts = new Map();
  let activeLowPriorityIpcCount = 0;
  let lowPriorityIpcQueuedCount = 0;
  let lowPriorityIpcStartedCount = 0;

  function shortClientId(value) {
    const text = typeof value === "string" ? value : "";
    if (text.length <= 16) return text;
    return `${text.slice(0, 8)}...${text.slice(-4)}`;
  }

  function redactDiagnosticUrl(value) {
    const text = String(value || "");
    try {
      const parsed = new URL(text, location.href);
      // 诊断日志不能把认证 token 打到 gateway 终端，只保留定位慢请求所需的 URL 形状。
      for (const key of ["token", "auth", "authorization", "code", "access_token", "refresh_token"]) {
        if (parsed.searchParams.has(key)) parsed.searchParams.set(key, "[redacted]");
      }
      return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    } catch {
      return text.replace(/([?&](?:token|auth|authorization|code|access_token|refresh_token)=)[^&]+/gi, "$1[redacted]");
    }
  }

  function websocketStateName(socket) {
    if (!socket || !("WebSocket" in w)) return "missing";
    if (socket.readyState === w.WebSocket.CONNECTING) return "connecting";
    if (socket.readyState === w.WebSocket.OPEN) return "open";
    if (socket.readyState === w.WebSocket.CLOSING) return "closing";
    if (socket.readyState === w.WebSocket.CLOSED) return "closed";
    return String(socket.readyState);
  }

  function diagnosticRouteIdFromValue(value, depth = 0, seen = new WeakSet()) {
    if (!value || typeof value !== "object" || depth > 4) return "";
    if (seen.has(value)) return "";
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) {
        const nested = diagnosticRouteIdFromValue(item, depth + 1, seen);
        if (nested) return nested;
      }
      return "";
    }
    if (typeof value.requestId === "string" && value.requestId) return value.requestId;
    if (value.request && typeof value.request === "object" && value.request.id != null) return String(value.request.id);
    if (value.id != null && (depth > 0 || value.method || value.jsonrpc || value.type)) return String(value.id);
    for (const key of ["payload", "message", "response", "body"]) {
      const nested = diagnosticRouteIdFromValue(value[key], depth + 1, seen);
      if (nested) return nested;
    }
    return "";
  }

  function sanitizeClientDiagnosticValue(key, value) {
    if (value == null) return value;
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return Number.isFinite(value) ? Math.round(value) : undefined;
    if (typeof value === "string") {
      const sanitized = /url|href/i.test(key) ? redactDiagnosticUrl(value) : value;
      return sanitized.length > 260 ? `${sanitized.slice(0, 260)}...` : sanitized;
    }
    return payloadShape(value);
  }

  function flushClientDiagnostics() {
    clientDiagnosticFlushTimer = null;
    if (clientDiagnosticQueue.length === 0) return;
    const events = clientDiagnosticQueue.splice(0, clientDiagnosticQueue.length);
    try {
      // 诊断上报走独立端点并批量发送，不参与官方 IPC，避免日志本身改变官方 renderer 行为。
      w.fetch("/api/client-log", {
        method: "POST",
        credentials: "same-origin",
        headers: gatewayAuthHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ clientId, events }),
      }).catch(() => {});
    } catch {}
  }

  function scheduleClientDiagnosticFlush() {
    if (clientDiagnosticFlushTimer) return;
    clientDiagnosticFlushTimer = w.setTimeout(flushClientDiagnostics, CLIENT_DIAGNOSTIC_FLUSH_DELAY_MS);
  }

  function clientDiagnostic(event, data) {
    try {
      const diagnosticData = {
        ageMs: Date.now() - bridgeStartedAtMs,
        clientAt: new Date().toISOString(),
        clientId: shortClientId(clientId),
        href: redactDiagnosticUrl(location.href),
      };
      if (data && typeof data === "object") {
        for (const [key, value] of Object.entries(data)) {
          const sanitized = sanitizeClientDiagnosticValue(key, value);
          if (sanitized !== undefined) diagnosticData[key] = sanitized;
        }
      }
      clientDiagnosticQueue.push({ event, data: diagnosticData });
      if (clientDiagnosticQueue.length >= CLIENT_DIAGNOSTIC_MAX_BATCH) {
        if (clientDiagnosticFlushTimer) {
          w.clearTimeout(clientDiagnosticFlushTimer);
          clientDiagnosticFlushTimer = null;
        }
        flushClientDiagnostics();
      } else {
        scheduleClientDiagnosticFlush();
      }
    } catch {}
  }

  function ipcDiagnosticSummary(channel, payload) {
    const summary = {
      channel,
      payloadType: payloadShape(payload),
    };
    const requestId = diagnosticRouteIdFromValue(payload);
    if (requestId) summary.requestId = requestId;
    if (payload && typeof payload === "object") {
      if (typeof payload.type === "string") summary.type = payload.type;
      if (typeof payload.method === "string") summary.method = payload.method;
      if (typeof payload.url === "string") summary.url = payload.url;
      if (payload.request && typeof payload.request === "object") {
        if (payload.request.id != null) summary.requestId = String(payload.request.id);
        if (typeof payload.request.method === "string") summary.requestMethod = payload.request.method;
      }
    }
    return summary;
  }

  function rawWsMessageChars(value) {
    // 浏览器 WebSocket message 一般是字符串；Blob/ArrayBuffer 分支保留给未来协议变化。
    if (typeof value === "string") return value.length;
    if (value && typeof value.size === "number") return value.size;
    return 0;
  }

  function appHostGatewayMessageSummary(message) {
    // app-host 消息只统计字符串长度和端口，不解析 RPC 内容，保持对官方协议透明。
    return {
      dataChars: typeof message?.data === "string" ? message.data.length : 0,
      payloadType: payloadShape(message?.data),
      portId: typeof message?.portId === "string" ? message.portId : "",
      type: typeof message?.type === "string" ? message.type : "",
    };
  }

  function gatewayWsInboundSummary(message, effectiveChannel, payload) {
    // 与服务端日志字段对齐，方便用 requestId/channel 在两端拼同一条链路。
    if (message && typeof message.channel === "string") {
      return {
        ...ipcDiagnosticSummary(effectiveChannel || message.channel, payload),
        target: message.channel,
      };
    }
    if (message && typeof message.type === "string" && message.type.startsWith("app-host-")) {
      return appHostGatewayMessageSummary(message);
    }
    return {
      payloadType: payloadShape(message),
      type: message && typeof message.type === "string" ? message.type : "",
    };
  }

  function maybeLogLargeOrSlowWsInbound(details) {
    if (!WS_DEBUG_ENABLED) return;
    const rawChars = Number(details.rawChars || 0);
    const parseMs = Number(details.parseMs || 0);
    const handleMs = Number(details.handleMs || 0);
    if (
      rawChars < WS_INBOUND_LARGE_CHARS &&
      parseMs < WS_INBOUND_PARSE_SLOW_MS &&
      handleMs < WS_INBOUND_HANDLE_SLOW_MS
    ) {
      return;
    }
    // 大会话冷加载可能卡在“收到 WS 字符串 -> JSON.parse -> 投递官方 renderer”这一段。
    clientDiagnostic("ws-inbound-large-or-slow", {
      ...details.summary,
      handledBy: details.handledBy,
      handleMs,
      parseMs,
      rawChars,
      wsReady,
      wsState: websocketStateName(ws),
    });
  }

  function shouldSuppressRoutineIpcDiagnostic(payload) {
    // log-message 和 connector logo 都是高频非关键请求；默认不打印逐条 start/end，避免盖住会话加载链路。
    return (
      payload &&
      typeof payload === "object" &&
      (payload.type === "log-message" || isLowPriorityFetchPayload(payload))
    );
  }

  function isConnectorLogoUrl(url) {
    return connectorLogoCacheKeyFromUrl(url) != null;
  }

  function safeDecodeURIComponent(value) {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  function connectorLogoCacheKeyFromUrl(url) {
    if (typeof url !== "string") return null;
    try {
      const parsed = new URL(url, location.href);
      const match = parsed.pathname.match(/^\/aip\/connectors\/([^/]+)\/logo\/?$/);
      if (!match) return null;
      const connectorId = safeDecodeURIComponent(match[1]);
      const theme = parsed.searchParams.get("theme")?.toLowerCase() === "dark" ? "dark" : "light";
      return `${connectorId}:${theme}`;
    } catch {
      const match = String(url).match(/^\/aip\/connectors\/([^/?#]+)\/logo(?:\?([^#]*))?/);
      if (!match) return null;
      const params = new URLSearchParams(match[2] || "");
      const theme = params.get("theme")?.toLowerCase() === "dark" ? "dark" : "light";
      return `${safeDecodeURIComponent(match[1])}:${theme}`;
    }
  }

  function isLowPriorityFetchPayload(payload) {
    return !!(
      payload &&
      typeof payload === "object" &&
      payload.type === "fetch" &&
      isConnectorLogoUrl(payload.url)
    );
  }

  function connectorLogoCacheKeyFromPayload(payload) {
    if (!isLowPriorityFetchPayload(payload)) return null;
    return connectorLogoCacheKeyFromUrl(payload.url);
  }

  function connectorLogoRequestId(payload) {
    return payload && typeof payload === "object" && payload.requestId != null ? String(payload.requestId) : "";
  }

  function isTrackedConnectorLogoResponse(payload) {
    const requestId = connectorLogoRequestId(payload);
    return !!requestId && connectorLogoRequestCacheKeys.has(requestId);
  }

  function shouldLogSampledCount(count) {
    return count <= 3 || count % LOW_PRIORITY_IPC_LOG_EVERY === 0;
  }

  function logConnectorLogoDiagnostic(event, details) {
    const count = (connectorLogoDiagnosticCounts.get(event) || 0) + 1;
    connectorLogoDiagnosticCounts.set(event, count);
    // connector logo 数量很大，只抽样打点；否则日志又会反过来拖慢关键 IPC 排障。
    if (!shouldLogSampledCount(count)) return;
    clientDiagnostic(event, {
      ...details,
      cacheSize: connectorLogoResponseCache.size,
      count,
      inFlightCount: connectorLogoInFlight.size,
    });
  }

  function clonePlainPayload(payload) {
    if (typeof structuredClone === "function") return structuredClone(payload);
    return JSON.parse(JSON.stringify(payload));
  }

  function cloneConnectorLogoFetchResponse(template, requestId) {
    const cloned = clonePlainPayload(template);
    cloned.requestId = requestId;
    return cloned;
  }

  function isSuccessfulFetchResponse(payload) {
    const status = Number(payload && payload.status);
    return !!(
      payload &&
      typeof payload === "object" &&
      payload.responseType === "success" &&
      Number.isFinite(status) &&
      status >= 200 &&
      status < 300
    );
  }

  function emitConnectorLogoCachedResponse(cacheKey, requestId) {
    const cached = connectorLogoResponseCache.get(cacheKey);
    if (!cached) return false;
    emitFetchResponse(cloneConnectorLogoFetchResponse(cached, requestId));
    logConnectorLogoDiagnostic("logo_cache_hit", { cacheKey, requestId });
    return true;
  }

  function emitConnectorLogoWaitingResponses(cacheKey, responsePayload) {
    const inFlight = connectorLogoInFlight.get(cacheKey);
    if (!inFlight) return 0;
    connectorLogoInFlight.delete(cacheKey);
    let delivered = 0;
    for (const waitingRequestId of inFlight.waitingRequestIds) {
      emitFetchResponse(cloneConnectorLogoFetchResponse(responsePayload, waitingRequestId));
      delivered += 1;
    }
    return delivered;
  }

  function rememberConnectorLogoRequest(cacheKey, requestId) {
    if (!cacheKey || !requestId) return;
    connectorLogoRequestCacheKeys.set(requestId, cacheKey);
    connectorLogoInFlight.set(cacheKey, {
      primaryRequestId: requestId,
      waitingRequestIds: [],
    });
  }

  function handleConnectorLogoFetchResponse(payload) {
    const requestId = connectorLogoRequestId(payload);
    if (!requestId) return false;
    const cacheKey = connectorLogoRequestCacheKeys.get(requestId);
    if (!cacheKey) return false;
    connectorLogoRequestCacheKeys.delete(requestId);

    const waiterCount = connectorLogoInFlight.get(cacheKey)?.waitingRequestIds.length || 0;
    if (isSuccessfulFetchResponse(payload)) {
      // 缓存完整 fetch-response 模板，后续只替换 requestId，确保官方请求管理器收到的数据形状完全一致。
      connectorLogoResponseCache.set(cacheKey, clonePlainPayload(payload));
      const delivered = emitConnectorLogoWaitingResponses(cacheKey, payload);
      logConnectorLogoDiagnostic("logo_cache_store", {
        cacheKey,
        requestId,
        status: payload.status,
        waiterCount: delivered,
      });
    } else {
      // 失败不缓存，但要把同 key 等待者全部唤醒，避免官方 fetch promise 永远 pending。
      const delivered = emitConnectorLogoWaitingResponses(cacheKey, payload);
      logConnectorLogoDiagnostic("logo_fetch_failed", {
        cacheKey,
        requestId,
        status: payload.status || 0,
        waiterCount: Math.max(waiterCount, delivered),
      });
    }
    return true;
  }

  function emitConnectorLogoInvokeError(cacheKey, requestId, error) {
    if (!cacheKey || !requestId) return;
    connectorLogoRequestCacheKeys.delete(requestId);
    const errorPayload = {
      requestId,
      responseType: "error",
      status: 500,
      error: error instanceof Error ? error.message : String(error),
    };
    const delivered = emitConnectorLogoWaitingResponses(cacheKey, errorPayload);
    emitFetchResponse(errorPayload);
    logConnectorLogoDiagnostic("logo_invoke_failed", {
      cacheKey,
      error: errorPayload.error,
      requestId,
      waiterCount: delivered,
    });
  }

  function shouldLogLowPriorityIpcQueue(queueDepth, sequenceCount) {
    return queueDepth === 1 || queueDepth % LOW_PRIORITY_IPC_LOG_EVERY === 0 || sequenceCount % LOW_PRIORITY_IPC_LOG_EVERY === 0;
  }

  function pumpLowPriorityIpcQueue() {
    while (activeLowPriorityIpcCount < LOW_PRIORITY_IPC_CONCURRENCY && lowPriorityIpcQueue.length > 0) {
      const item = lowPriorityIpcQueue.shift();
      activeLowPriorityIpcCount += 1;
      lowPriorityIpcStartedCount += 1;
      const waitMs = Date.now() - item.enqueuedAtMs;
      if (shouldLogLowPriorityIpcQueue(lowPriorityIpcQueue.length + 1, lowPriorityIpcStartedCount)) {
        clientDiagnostic("ipc-low-priority-start", {
          ...item.summary,
          activeCount: activeLowPriorityIpcCount,
          queuedCount: lowPriorityIpcQueue.length,
          startedCount: lowPriorityIpcStartedCount,
          waitMs,
        });
      }
      Promise.resolve()
        .then(item.task)
        .then(item.resolve, item.reject)
        .finally(() => {
          activeLowPriorityIpcCount = Math.max(0, activeLowPriorityIpcCount - 1);
          pumpLowPriorityIpcQueue();
        });
    }
  }

  function enqueueLowPriorityIpc(summary, task) {
    lowPriorityIpcQueuedCount += 1;
    const enqueuedAtMs = Date.now();
    const queueDepth = lowPriorityIpcQueue.length + 1;
    if (shouldLogLowPriorityIpcQueue(queueDepth, lowPriorityIpcQueuedCount)) {
      clientDiagnostic("ipc-low-priority-queued", {
        ...summary,
        activeCount: activeLowPriorityIpcCount,
        queuedCount: queueDepth,
        totalQueuedCount: lowPriorityIpcQueuedCount,
      });
    }
    return new Promise((resolve, reject) => {
      lowPriorityIpcQueue.push({ enqueuedAtMs, reject, resolve, summary, task });
      pumpLowPriorityIpcQueue();
    });
  }

  clientDiagnostic("bridge-installed", {
    target: "codex-bridge-polyfill",
    wsState: websocketStateName(ws),
  });

  /** 判断当前设备是否可能有移动端软键盘。 */
  function isLikelyMobileKeyboardDevice() {
    const nav = w.navigator || {};
    const ua = String(nav.userAgent || "");
    const hasCoarsePointer = !!(w.matchMedia && w.matchMedia("(pointer: coarse)").matches);
    const hasTouch = Number(nav.maxTouchPoints || 0) > 0 || "ontouchstart" in w;
    return (hasCoarsePointer && hasTouch) || /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
  }

  function visibleElement(element) {
    if (!element || typeof element.getBoundingClientRect !== "function") return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = w.getComputedStyle ? w.getComputedStyle(element) : null;
    return !style || (style.display !== "none" && style.visibility !== "hidden");
  }

  function elementTextLabel(element) {
    if (!element) return "";
    return String(
      element.getAttribute?.("aria-label") ||
        element.getAttribute?.("title") ||
        element.innerText ||
        element.textContent ||
        ""
    ).trim();
  }

  function officialLogoutLabelFromElement(element) {
    const label = elementTextLabel(element).replace(/\s+/g, " ").trim();
    if (!label || label === GATEWAY_AUTH_LOGOUT_LABEL) return "";
    return OFFICIAL_LOGOUT_LABELS.find((text) => label === text || label.includes(text)) || "";
  }

  function isMenuLikeContext(element) {
    for (let node = element && element.parentElement; node && node !== document.body; node = node.parentElement) {
      const role = String(node.getAttribute?.("role") || "").toLowerCase();
      if (role === "menu" || role === "menubar") return true;
      if (node.hasAttribute?.("data-radix-menu-content") || node.hasAttribute?.("data-radix-popper-content-wrapper")) {
        return true;
      }
      const className = String(node.className || "");
      if (role === "dialog" || /\bcodex-dialog\b/i.test(className)) return false;
      if (/\b(dropdown|menu|popover)\b/i.test(className)) return true;
    }
    return false;
  }

  function isOfficialLogoutMenuItem(element) {
    if (!element || element.nodeType !== 1) return false;
    if (element.dataset?.codexWebGatewayAuthLogout === "true") return false;
    if (!visibleElement(element)) return false;
    if (!officialLogoutLabelFromElement(element)) return false;
    if (!isMenuLikeContext(element)) return false;
    const tagName = String(element.tagName || "").toLowerCase();
    const role = String(element.getAttribute?.("role") || "").toLowerCase();
    return tagName === "button" || tagName === "a" || role === "menuitem" || role === "menuitemradio";
  }

  function removeDuplicatedIdentityAttributes(element) {
    if (!element || element.nodeType !== 1) return;
    element.removeAttribute("id");
    element.removeAttribute("data-testid");
    element.querySelectorAll?.("[id],[data-testid]").forEach((child) => {
      child.removeAttribute("id");
      child.removeAttribute("data-testid");
    });
  }

  function replaceMenuItemText(element, fromText, toText) {
    const textNodes = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      if (String(node.nodeValue || "").includes(fromText)) textNodes.push(node);
      node = walker.nextNode();
    }
    if (textNodes.length === 0) {
      element.textContent = toText;
      return;
    }
    for (const textNode of textNodes) {
      textNode.nodeValue = String(textNode.nodeValue || "").replace(fromText, toText);
    }
  }

  function markGatewayAuthLogoutBusy(item, busy) {
    if (!item) return;
    item.toggleAttribute("disabled", busy);
    item.setAttribute("aria-disabled", busy ? "true" : "false");
    const originalLabel = item.dataset.codexWebGatewayAuthOriginalLabel || GATEWAY_AUTH_LOGOUT_LABEL;
    replaceMenuItemText(item, busy ? originalLabel : GATEWAY_AUTH_LOGOUT_BUSY_LABEL, busy ? GATEWAY_AUTH_LOGOUT_BUSY_LABEL : originalLabel);
  }

  async function logoutGatewayAuthFromMenu(item) {
    if (w.__codexGatewayAuthLogoutInProgress) return;
    w.__codexGatewayAuthLogoutInProgress = true;
    markGatewayAuthLogoutBusy(item, true);
    try {
      const res = await w.fetch("/api/auth/logout", {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: gatewayAuthHeaders({ accept: "application/json" }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      forceGatewayLoginOnNextBoot();
      w.location.replace("/");
    } catch (error) {
      w.__codexGatewayAuthLogoutInProgress = false;
      markGatewayAuthLogoutBusy(item, false);
      renderBridgeErrorToast({
        description: t("web.auth.logoutGatewayFailed", { error: error instanceof Error ? error.message : String(error) }),
      });
    }
  }

  function stopGatewayAuthLogoutEvent(event) {
    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
  }

  function gatewayAuthLogoutItemFromEvent(event) {
    const target = event && event.target;
    const element = target && target.nodeType === 1 ? target : target?.parentElement;
    return element && typeof element.closest === "function"
      ? element.closest('[data-codex-web-gateway-auth-logout="true"]')
      : null;
  }

  function handleGatewayAuthLogoutPointer(event) {
    const item = gatewayAuthLogoutItemFromEvent(event);
    if (!item) return;
    stopGatewayAuthLogoutEvent(event);
    logoutGatewayAuthFromMenu(item);
  }

  function handleGatewayAuthLogoutKeydown(event) {
    const item = gatewayAuthLogoutItemFromEvent(event);
    if (!item || (event.key !== "Enter" && event.key !== " ")) return;
    stopGatewayAuthLogoutEvent(event);
    logoutGatewayAuthFromMenu(item);
  }

  function createGatewayAuthLogoutMenuItem(logoutItem) {
    const officialLabel = officialLogoutLabelFromElement(logoutItem) || "退出登录";
    const item = logoutItem.cloneNode(true);
    item.dataset.codexWebGatewayAuthLogout = "true";
    item.dataset.codexWebGatewayAuthOriginalLabel = GATEWAY_AUTH_LOGOUT_LABEL;
    item.setAttribute("aria-label", GATEWAY_AUTH_LOGOUT_LABEL);
    item.setAttribute("title", GATEWAY_AUTH_LOGOUT_LABEL);
    item.removeAttribute("disabled");
    item.removeAttribute("aria-disabled");
    removeDuplicatedIdentityAttributes(item);
    replaceMenuItemText(item, officialLabel, GATEWAY_AUTH_LOGOUT_LABEL);
    if (String(item.tagName || "").toLowerCase() === "button") item.type = "button";
    item.addEventListener("pointerdown", (event) => {
      stopGatewayAuthLogoutEvent(event);
      logoutGatewayAuthFromMenu(item);
    });
    item.addEventListener("click", (event) => {
      stopGatewayAuthLogoutEvent(event);
      logoutGatewayAuthFromMenu(item);
    });
    item.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      stopGatewayAuthLogoutEvent(event);
      logoutGatewayAuthFromMenu(item);
    });
    return item;
  }

  function injectGatewayAuthLogoutMenuItem(logoutItem) {
    const parent = logoutItem && logoutItem.parentElement;
    if (!parent) return false;
    if (Array.from(parent.children || []).some((child) => child.dataset?.codexWebGatewayAuthLogout === "true")) {
      return false;
    }
    parent.insertBefore(createGatewayAuthLogoutMenuItem(logoutItem), logoutItem);
    return true;
  }

  function scanGatewayAuthLogoutMenuItems(root = document) {
    const scope = root && root.nodeType === 1 ? root : document;
    const candidates = Array.from(scope.querySelectorAll?.("button,a,[role='menuitem'],[role='menuitemradio']") || []);
    if (scope !== document && isOfficialLogoutMenuItem(scope)) candidates.unshift(scope);
    let injected = 0;
    for (const candidate of candidates) {
      if (isOfficialLogoutMenuItem(candidate) && injectGatewayAuthLogoutMenuItem(candidate)) injected += 1;
    }
    return injected;
  }

  function installGatewayAuthMenuInjection() {
    if (!document || document.__codexGatewayAuthMenuInjectionInstalled) return;
    document.__codexGatewayAuthMenuInjectionInstalled = true;
    let scheduled = false;
    const scheduleScan = () => {
      if (scheduled) return;
      scheduled = true;
      const run = () => {
        scheduled = false;
        scanGatewayAuthLogoutMenuItems(document);
      };
      if (typeof w.requestAnimationFrame === "function") {
        w.requestAnimationFrame(run);
      } else {
        w.setTimeout(run, 0);
      }
    };
    const start = () => {
      scheduleScan();
      document.addEventListener("pointerdown", handleGatewayAuthLogoutPointer, true);
      document.addEventListener("click", handleGatewayAuthLogoutPointer, true);
      document.addEventListener("keydown", handleGatewayAuthLogoutKeydown, true);
      const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          for (const node of mutation.addedNodes || []) {
            if (node && node.nodeType === 1) {
              scheduleScan();
              return;
            }
          }
        }
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", start, { once: true });
    } else {
      start();
    }
  }

  function installOpenCodexBuiltinPlugins() {
    const capabilities = {
      platform: {
        isMobile: isLikelyMobileKeyboardDevice,
      },
    };
    if (tokenUsageCapability) capabilities.tokenUsage = tokenUsageCapability;
    const pluginSystem = opencodexPluginSystem();
    if (pluginSystem && typeof pluginSystem.activate === "function") {
      pluginSystem.activate("renderer", capabilities);
      return;
    }

    console.warn("[opencodex-plugin] plugin system is unavailable; builtin plugin capabilities were not activated");
  }

  installOpenCodexBuiltinPlugins();
  installGatewayAuthMenuInjection();

  /** 获取某个 channel 的监听集合。 */
  function ensureSet(channel) {
    if (!listeners.has(channel)) listeners.set(channel, new Set());
    return listeners.get(channel);
  }

  /** 模拟 Electron ipcRenderer.on。 */
  function subscribe(channel, handler) {
    const set = ensureSet(channel);
    set.add(handler);
    return () => unsubscribe(channel, handler);
  }

  /** 模拟 Electron ipcRenderer.off。 */
  function unsubscribe(channel, handler) {
    const set = listeners.get(channel);
    if (!set) return;
    set.delete(handler);
    if (set.size === 0) listeners.delete(channel);
  }

  /** renderer listener 需要回复 gateway 时统一走 invoke。 */
  function sendRendererReply(channel, payload) {
    if (typeof channel !== "string" || !channel) return Promise.resolve(false);
    const message =
      payload && typeof payload === "object"
        ? { type: channel, ...payload }
        : { type: channel, payload };
    return invoke("codex_desktop:message-from-view", message).catch((error) => {
      console.warn("[codex-web] failed to send renderer reply", channel, error);
      return false;
    });
  }

  /** 分发 gateway/web-shell 事件给通过 ipcRenderer.on 注册的监听器。 */
  function dispatch(channel, payload) {
    const set = listeners.get(channel);
    if (!set || set.size === 0) return 0;
    let delivered = 0;
    for (const handler of [...set]) {
      try {
        handler(payload, sendRendererReply);
        delivered += 1;
      } catch (error) {
        console.error("[codex-web] listener error", channel, error);
      }
    }
    return delivered;
  }

  /** 同时模拟 window.postMessage 风格的 renderer 消息入口。 */
  function emitWindowMessage(channel, payload) {
    try {
      if (channel === "mcp-response" && payload && typeof payload === "object") {
        const normalizedMessage = payload.message || payload.response || payload;
        const data = {
          type: channel,
          ...payload,
          message:
            normalizedMessage && typeof normalizedMessage === "object"
              ? normalizedMessage
              : { id: payload.id, result: payload.result, error: payload.error },
        };
        if (!data.response && payload.response) {
          data.response = payload.response;
        }
        w.dispatchEvent(new MessageEvent("message", { data }));
        return;
      }
      const data =
        payload && typeof payload === "object"
          ? { type: channel, ...payload }
          : { type: channel, payload };
      w.dispatchEvent(new MessageEvent("message", { data }));
    } catch (error) {
      console.warn("[codex-web] failed to emit window message", channel, error);
    }
  }

  /** 官方 main 发给 renderer 的消息通常用 message-for-view 包一层，真实类型在 payload.type。 */
  function effectiveGatewayMessageChannel(channel, payload) {
    if (
      channel === MESSAGE_FOR_VIEW_CHANNEL &&
      payload &&
      typeof payload === "object" &&
      typeof payload.type === "string" &&
      payload.type
    ) {
      return payload.type;
    }
    return channel;
  }

  /** message-for-view 是官方 preload 到 renderer 的传输层；Web 侧只投递解包后的真实消息，避免重复应用状态补丁。 */
  function shouldDispatchGatewayMessage(channel, effectiveChannel) {
    if (channel === MESSAGE_FOR_VIEW_CHANNEL) return false;
    return effectiveChannel !== "mcp-response" && effectiveChannel !== "mcp-notification";
  }

  /** 调试用 payload 形状摘要，不输出完整敏感数据。 */
  function payloadShape(payload) {
    if (payload === null) return "null";
    if (Array.isArray(payload)) return `array(${payload.length})`;
    if (typeof payload === "object") return `object(${Object.keys(payload).length})`;
    return typeof payload;
  }

  /** 安全序列化 IPC payload，支持 Error 和循环引用。 */
  function stringifyForIpc(value) {
    const seen = new WeakSet();
    return JSON.stringify(value, (_key, nestedValue) => {
      if (nestedValue instanceof Error) {
        return {
          name: nestedValue.name,
          message: nestedValue.message,
          stack: nestedValue.stack,
          cause: nestedValue.cause,
        };
      }
      if (nestedValue && typeof nestedValue === "object") {
        if (seen.has(nestedValue)) return "[Circular]";
        seen.add(nestedValue);
      }
      return nestedValue;
    });
  }

  const ipcErrorToastState = {
    lastKey: "",
    lastShownAtMs: 0,
  };

  /** 把 gateway 返回的 error 字段归一成可展示字符串。 */
  function normalizeErrorMessage(error) {
    if (!error) return "";
    if (typeof error === "string") return error;
    if (error && typeof error === "object" && typeof error.message === "string") {
      return error.message;
    }
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }

  /** 优先使用 gateway 返回的真实错误，而不是只显示 HTTP status。 */
  function ipcInvokeErrorMessage(channel, status, json) {
    const bodyError =
      json && typeof json === "object" && Object.prototype.hasOwnProperty.call(json, "error")
        ? normalizeErrorMessage(json.error)
        : "";
    return bodyError || `IPC invoke failed: ${channel} (${status})`;
  }

  /** 只兜底展示 fetch 形态的 IPC 兼容错误，invoke 错误交给官方前端调用栈自然处理。 */
  function shouldSurfaceFetchIpcError(status, message) {
    if (status === 400) return true;
    return /unsupported codex ipc channel|method not found|no electron ipc handler|invalid ipc channel/i.test(
      message || ""
    );
  }

  /** 创建 web-shell 兜底 toast 容器；内部节点复用官方 toast-root 动画类。 */
  function ensureBridgeToastRoot() {
    if (!document || !document.body) return null;
    let root = document.getElementById("codex-web-toast-root");
    if (root) return root;
    root = document.createElement("div");
    root.id = "codex-web-toast-root";
    root.style.cssText = [
      "position:fixed",
      "top:16px",
      "left:0",
      "right:0",
      "z-index:2147483647",
      "display:flex",
      "flex-direction:column",
      "align-items:center",
      "gap:8px",
      "padding:0 16px",
      "pointer-events:none",
    ].join(";");
    document.body.appendChild(root);
    return root;
  }

  /** 使用官方 toast-root 的 exiting 状态触发同款退出动画。 */
  function removeBridgeToast(toast) {
    if (!toast) return;
    toast.dataset.state = "exiting";
    w.setTimeout(() => {
      try {
        toast.remove();
      } catch {}
    }, 260);
  }

  /** 官方 toast signal 不暴露给 polyfill，fetch 兜底只复用官方 Toast/Alert DOM 类名。 */
  function renderBridgeErrorToast(payload) {
    if (!document || !document.body) {
      w.setTimeout(() => renderBridgeErrorToast(payload), 0);
      return;
    }
    const root = ensureBridgeToastRoot();
    if (!root) return;
    const toast = document.createElement("div");
    toast.className = "toast-root";
    toast.dataset.state = "entered";
    toast.style.maxWidth = "min(520px, calc(100vw - 32px))";

    const alert = document.createElement("div");
    alert.className = [
      "alert-root",
      "inline-flex",
      "flex-row",
      "items-start",
      "gap-1.5",
      "rounded-2xl",
      "px-2",
      "py-2",
      "text-base",
      "leading-[1.4]",
      "pointer-events-auto",
      "box-shadow-lg",
      "border",
      "text-token-foreground",
      "border-token-input-validation-error-border",
      "bg-token-input-validation-error-background",
    ].join(" ");
    alert.setAttribute("role", "alert");
    alert.setAttribute("data-testid", "codex-web-fetch-ipc-error-toast");
    alert.style.maxWidth = "min(520px, calc(100vw - 32px))";

    const content = document.createElement("div");
    content.className = "flex-1 justify-center gap-2";

    const description = document.createElement("div");
    description.className = "font-medium";
    description.textContent = payload.description || "";
    description.style.whiteSpace = "pre-wrap";
    description.style.overflowWrap = "anywhere";
    content.appendChild(description);
    alert.appendChild(content);

    const close = document.createElement("button");
    close.type = "button";
    close.setAttribute("aria-label", "Close");
    close.textContent = "x";
    close.className =
      "mt-0.5 flex shrink-0 grow-0 cursor-interaction rounded-full opacity-50 hover:bg-token-button-secondary-hover-background/5 hover:opacity-80";
    close.addEventListener("click", () => removeBridgeToast(toast));
    alert.appendChild(close);

    toast.appendChild(alert);
    root.appendChild(toast);
    w.setTimeout(() => removeBridgeToast(toast), 8000);
  }

  /** fetch 形态没有稳定的官方业务 catch，这里才做同款 toast 兜底并短时间去重。 */
  function surfaceFetchIpcError(channel, payload) {
    if (!payload || typeof payload !== "object") return;
    const message = normalizeErrorMessage(payload.error);
    if (!message) return;
    const status = Number(payload.status || 0);
    if (!shouldSurfaceFetchIpcError(Number.isFinite(status) ? status : undefined, message)) return;
    const url = typeof payload.url === "string" && payload.url ? payload.url : channel;
    const key = `${url}:${message}`;
    const now = Date.now();
    if (ipcErrorToastState.lastKey === key && now - ipcErrorToastState.lastShownAtMs < 3000) {
      return;
    }
    ipcErrorToastState.lastKey = key;
    ipcErrorToastState.lastShownAtMs = now;
    const toastPayload = {
      level: "danger",
      source: "codex-web-gateway",
      description: `${url}: ${message}`,
    };

    // 先广播给可能存在的官方适配器；无人处理时再用官方类名兜底渲染。
    const delivered = dispatch("codex-web:toast", toastPayload);
    emitWindowMessage("codex-web:toast", toastPayload);
    if (delivered > 0) return;
    renderBridgeErrorToast(toastPayload);
  }

  /** 把 ArrayBuffer 转成 base64；分块处理避免大文件触发调用栈上限。 */
  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      const chunk = bytes.subarray(offset, offset + chunkSize);
      binary += String.fromCharCode.apply(null, chunk);
    }
    return btoa(binary);
  }

  /** 浏览器 File 对象不能暴露真实路径，所以只把文件名和内容交给 gateway 落盘。 */
  async function serializePickedFile(file) {
    return {
      name: file.name || "attachment",
      type: file.type || "",
      size: file.size,
      lastModified: file.lastModified,
      contentsBase64: arrayBufferToBase64(await file.arrayBuffer()),
    };
  }

  /** 使用浏览器原生 input[type=file] 实现官方 pick-files IPC 的选择动作。 */
  function openBrowserFilePicker(params) {
    return new Promise((resolve, reject) => {
      const input = document.createElement("input");
      let finished = false;

      input.type = "file";
      input.multiple = true;
      if (params && params.imagesOnly) input.accept = "image/*";
      input.style.position = "fixed";
      input.style.left = "-10000px";
      input.style.top = "-10000px";
      input.style.opacity = "0";

      const cleanup = () => {
        window.removeEventListener("focus", handleFocus, true);
        input.remove();
      };
      const finish = (files) => {
        if (finished) return;
        finished = true;
        cleanup();
        resolve(files);
      };
      function handleFocus() {
        // macOS 文件选择器取消时不一定触发 change，用重新聚焦后的空列表表示取消。
        window.setTimeout(() => {
          if (!finished && (!input.files || input.files.length === 0)) finish([]);
        }, 250);
      }

      input.addEventListener(
        "change",
        () => {
          finish(Array.from(input.files || []));
        },
        { once: true }
      );
      input.addEventListener("cancel", () => finish([]), { once: true });
      window.addEventListener("focus", handleFocus, true);

      try {
        (document.body || document.documentElement).appendChild(input);
        input.click();
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
  }

  /** 实现 pick-files：浏览器选文件，gateway 写临时文件并返回 renderer 需要的 fsPath。 */
  async function pickFilesInBrowser(payload) {
    const params = payload && typeof payload === "object" && payload.params ? payload.params : payload || {};
    const files = await openBrowserFilePicker(params);
    if (!files || files.length === 0) return { files: [] };
    const serialized = await Promise.all(files.map((file) => serializePickedFile(file)));
    return invokeGateway("pick-files", {
      params: {
        ...(params && typeof params === "object" ? params : {}),
        files: serialized,
      },
    });
  }

  /** 发送 fetch-response 给官方 vscode-api 请求管理器。 */
  function emitFetchResponse(payload) {
    dispatch("fetch-response", payload);
    emitWindowMessage("fetch-response", payload);
  }

  /** 成功响应 vscode://codex/... fetch IPC，bodyJsonString 必须是 JSON 字符串。 */
  function emitFetchSuccess(requestId, body) {
    emitFetchResponse({
      requestId,
      responseType: "success",
      status: 200,
      headers: { "content-type": "application/json" },
      bodyJsonString: JSON.stringify(body),
    });
  }

  /** 失败响应 vscode://codex/... fetch IPC，让官方 query/mutation 继续走原有错误 toast。 */
  function emitFetchError(requestId, error) {
    emitFetchResponse({
      requestId,
      responseType: "error",
      status: 500,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  /** 官方 renderer 通过 fetch 消息发起 pick-files；该能力必须在 web-shell 里触发浏览器 picker。 */
  function handlePickFilesFetchMessage(payload) {
    if (!payload || typeof payload !== "object") return false;
    if (payload.type !== "fetch" || payload.url !== "vscode://codex/pick-files") return false;
    const requestId = String(payload.requestId || "");
    let params = {};
    try {
      params = payload.body ? JSON.parse(payload.body) : {};
    } catch {}
    pickFilesInBrowser({ params })
      .then((result) => emitFetchSuccess(requestId, result))
      .catch((error) => emitFetchError(requestId, error));
    return true;
  }

  function configWorkspaceRoots() {
    const roots = Array.isArray(cfg.workspaceRoots) ? cfg.workspaceRoots : [];
    return roots
      .map((root) => {
        if (typeof root === "string") return root;
        if (root && typeof root === "object" && typeof root.path === "string") return root.path;
        return null;
      })
      .filter(Boolean);
  }

  /** OpenCodex 没有外部 IDE client，快速返回空 IDE 上下文，避免官方 IPC 等 5 秒超时。 */
  function buildBrowserIdeContext(params) {
    const workspaceRoots = configWorkspaceRoots();
    const requestedRoot =
      params && typeof params === "object"
        ? params.workspaceRoot || params.cwd || params.projectRoot
        : null;
    const cwd =
      (typeof requestedRoot === "string" && requestedRoot) ||
      workspaceRoots[0] ||
      cfg.homeDir ||
      "/";
    const ideContext = {
      cwd,
      workspaceRoots: workspaceRoots.length > 0 ? workspaceRoots : [cwd],
      openFiles: [],
      selectedFile: null,
      diagnostics: [],
    };
    // 当前官方 main 返回 { ideContext }；旧 gateway 曾直接返回 ideContext 本体，这里同时带上两种字段。
    return { ...ideContext, ideContext };
  }

  /** 处理 vscode://codex/ide-context，Web 壳没有真实 IDE 时不能转给官方链路等待超时。 */
  function handleIdeContextFetchMessage(payload) {
    if (!payload || typeof payload !== "object") return false;
    if (payload.type !== "fetch" || payload.url !== "vscode://codex/ide-context") return false;
    const requestId = String(payload.requestId || "");
    let params = {};
    try {
      params = payload.body ? JSON.parse(payload.body) : {};
    } catch {}
    emitFetchSuccess(requestId, buildBrowserIdeContext(params));
    return true;
  }

  /** 短延迟 Promise，用于启动期 transient fetch 失败后的重试。 */
  function delay(ms) {
    return new Promise((resolve) => w.setTimeout(resolve, ms));
  }

  /** 只把浏览器网络层的瞬时失败视为可重试，HTTP 500 等业务错误不在这里吞。 */
  function isTransientGatewayFetchError(error) {
    const message = error instanceof Error ? error.message : String(error || "");
    return /failed to fetch|networkerror|load failed/i.test(message);
  }

  /** 判断 fetch-message 是否适合短重试；避免用户发送消息这类写操作被重复提交。 */
  function isRetryableFetchMessage(payload) {
    if (!payload || typeof payload !== "object" || payload.type !== "fetch") return false;
    const method = String(payload.method || "GET").toUpperCase();
    const url = String(payload.url || "");
    if (method === "GET") return true;
    return /^vscode:\/\/codex\/(paths-exist|git-origins|ide-context|get-global-state|set-global-state|get-configuration|set-configuration|get-settings|get-setting|set-setting|set-remote-control-connections-enabled)$/i.test(url);
  }

  /** 只对首屏/切换会话所需的安全 IPC 做短重试，避免第一次点击被 transient fetch 失败卡死。 */
  function shouldRetryGatewayInvoke(channel, payload) {
    if (channel !== "codex_desktop:message-from-view") return false;
    if (!payload || typeof payload !== "object") return false;
    if (payload.type === "shared-object-subscribe" || payload.type === "persisted-atom-sync-request") return true;
    // mcp-request 属于官方 IPC 语义，Web 侧不重试、不合成响应，避免重复读写或打乱官方状态机。
    return isRetryableFetchMessage(payload);
  }

  function shouldWaitForWsBeforeInvoke(channel) {
    // 官方 renderer 的 message-from-view 大多是“HTTP 触发、WS 回包”的异步 IPC；WS 未注册 clientId 时回包会丢。
    return (
      typeof channel === "string" &&
      (channel === "codex_desktop:message-from-view" || channel.startsWith("codex_desktop:worker:"))
    );
  }

  function settleWsReadyWaiters(ready) {
    for (const resolve of [...wsReadyWaiters]) {
      wsReadyWaiters.delete(resolve);
      try {
        resolve(ready);
      } catch {}
    }
  }

  function markGatewayWsReady() {
    wsReady = true;
    settleWsReadyWaiters(true);
    // hello-ack 到达后服务端才知道当前 clientId，此时再冲刷 app-host 队列才能保证定向路由正确。
    flushAllAppHostRelayMessages();
  }

  function waitForGatewayWsReady() {
    if (!cfg.gatewayWsUrl || !("WebSocket" in w)) return Promise.resolve(false);
    if (wsReady && ws && ws.readyState === w.WebSocket.OPEN) return Promise.resolve(true);
    // 不能无限等 WS，否则认证失败或网络断开时会把所有 IPC 卡死；超时后仍按原逻辑发送，保留可恢复性。
    return new Promise((resolve) => {
      const timer = w.setTimeout(() => {
        wsReadyWaiters.delete(resolveReady);
        resolve(false);
      }, WS_READY_WAIT_TIMEOUT_MS);
      const resolveReady = (ready) => {
        w.clearTimeout(timer);
        resolve(ready);
      };
      wsReadyWaiters.add(resolveReady);
    });
  }

  function appHostPortId() {
    // portId 只用于 WebSocket JSON 帧复原 MessagePort 边界，不能暴露官方 RPC 细节。
    return `app-host-${clientId}-${w.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)}`;
  }

  function appHostWsPayload(state, payload) {
    // 所有 app-host 控制帧都带 clientId + portId，gateway 据此绑定到正确浏览器页面。
    return {
      clientId,
      portId: state.portId,
      ...payload,
    };
  }

  function sendAppHostWsPayload(payload) {
    // app-host 比普通 IPC 更早启动；WS 未 open 或 hello 未完成时不能直接发送，否则 gateway 无法建立路由。
    if (!ws || ws.readyState !== w.WebSocket.OPEN || !wsReady) return false;
    try {
      ws.send(JSON.stringify(payload));
      return true;
    } catch (error) {
      clientDiagnostic("app-host-ws-send-failed", {
        error: error instanceof Error ? error.message : String(error),
        errorName: error && error.name ? String(error.name) : "",
        portId: payload && payload.portId,
        wsReady,
        wsState: websocketStateName(ws),
      });
      return false;
    }
  }

  function sendGatewayControlPayload(payload, eventName) {
    // OpenCodex 自有控制帧复用同一条已认证 WS；没有 ready 时直接放弃，避免通知事件反向阻塞官方 IPC。
    if (!ws || ws.readyState !== w.WebSocket.OPEN || !wsReady) return false;
    try {
      ws.send(JSON.stringify({ clientId, ...payload }));
      return true;
    } catch (error) {
      clientDiagnostic(eventName || "gateway-control-send-failed", {
        error: error instanceof Error ? error.message : String(error),
        errorName: error && error.name ? String(error.name) : "",
        wsReady,
        wsState: websocketStateName(ws),
      });
      return false;
    }
  }

  function sendBrowserNotificationEvent(notificationId, event, extra) {
    return sendGatewayControlPayload(
      {
        type: "opencodex:notification-event",
        notificationId,
        event,
        ...(extra && typeof extra === "object" ? extra : {}),
      },
      "notification-event-send-failed"
    );
  }

  function browserNotificationOptions(message) {
    const options = {};
    if (typeof message.body === "string" && message.body) options.body = message.body;
    if (typeof message.icon === "string" && message.icon) options.icon = message.icon;
    if (typeof message.tag === "string" && message.tag) options.tag = message.tag;
    if (typeof message.silent === "boolean") options.silent = message.silent;
    if (typeof message.renotify === "boolean") options.renotify = message.renotify;
    if (typeof message.requireInteraction === "boolean") options.requireInteraction = message.requireInteraction;
    if (Array.isArray(message.actions) && message.actions.length > 0) options.actions = message.actions;
    return options;
  }

  function handleOpenCodexNotificationMessage(message) {
    if (!message || typeof message !== "object") return false;
    if (message.type === "opencodex:notification-close") {
      const notificationId = typeof message.notificationId === "string" ? message.notificationId : "";
      const notification = notificationId ? activeBrowserNotifications.get(notificationId) : null;
      if (notification && typeof notification.close === "function") {
        activeBrowserNotifications.delete(notificationId);
        try {
          notification.close();
        } catch {}
      }
      return true;
    }
    if (message.type !== "opencodex:notification") return false;

    const notificationId = typeof message.notificationId === "string" ? message.notificationId : "";
    if (!notificationId || !("Notification" in w)) return true;
    if (w.Notification.permission !== "granted") return true;

    try {
      // 不主动 requestPermission；只有用户已经授予浏览器通知权限时才展示。
      const notification = new w.Notification(String(message.title || ""), browserNotificationOptions(message));
      activeBrowserNotifications.set(notificationId, notification);
      notification.onclick = () => {
        sendBrowserNotificationEvent(notificationId, "click");
      };
      notification.onclose = () => {
        activeBrowserNotifications.delete(notificationId);
        sendBrowserNotificationEvent(notificationId, "close");
      };
    } catch {}
    return true;
  }

  function flushAppHostRelayMessages(state) {
    if (!state || state.closed || state.flushing) return;
    state.flushing = true;
    try {
      while (!state.closed && state.pending.length > 0) {
        // 保持 MessagePort 的 FIFO 语义：只要第一条没发出去，后面的帧也不能越过它。
        if (!sendAppHostWsPayload(state.pending[0])) return;
        state.pending.shift();
      }
    } finally {
      state.flushing = false;
    }
  }

  function flushAllAppHostRelayMessages() {
    for (const state of appHostPortRelays.values()) {
      flushAppHostRelayMessages(state);
    }
  }

  function queueAppHostRelayPayload(state, payload) {
    if (!state || state.closed) return;
    if (state.pending.length >= APP_HOST_PENDING_MESSAGE_LIMIT) {
      // 队列溢出通常意味着 WS 建连或认证异常，主动关闭比无限堆积更容易恢复。
      clientDiagnostic("app-host-queue-overflow", {
        portId: state.portId,
        queuedCount: state.pending.length,
      });
      closeAppHostRelay(state, "queue_overflow", true);
      return;
    }
    state.pending.push(appHostWsPayload(state, payload));
    flushAppHostRelayMessages(state);
  }

  function closeAppHostRelay(state, reason, notifyGateway) {
    if (!state || state.closed) return;
    state.closed = true;
    appHostPortRelays.delete(state.portId);
    if (notifyGateway) {
      // null 沿用 MessagePort 关闭信号，gateway 收到后会关闭对应的 Electron port。
      sendAppHostWsPayload(appHostWsPayload(state, { type: "app-host-port-message", data: null }));
    }
    try {
      state.port.close();
    } catch {}
    clientDiagnostic("app-host-port-closed", {
      portId: state.portId,
      reason,
      wsReady,
      wsState: websocketStateName(ws),
    });
  }

  function handleAppHostGatewayMessage(message) {
    // 这些是 gateway 内部控制帧，不进入官方 IPC 事件分发，避免被 renderer 当作普通广播。
    if (!message || typeof message !== "object") return false;
    if (
      message.type !== "app-host-port-connected" &&
      message.type !== "app-host-port-message" &&
      message.type !== "app-host-port-close" &&
      message.type !== "app-host-port-error"
    ) {
      return false;
    }
    const portId = typeof message.portId === "string" ? message.portId : "";
    const state = appHostPortRelays.get(portId);
    if (!state) {
      clientDiagnostic("app-host-message-missing-port", {
        portId,
        type: message.type,
      });
      return true;
    }
    if (message.type === "app-host-port-connected") {
      state.connected = true;
      // connected 只表示 gateway 已把 port 接到官方 listener；后续服务初始化仍由官方 RPC 自己完成。
      clientDiagnostic("app-host-connected", {
        portId,
        queuedCount: state.pending.length,
      });
      flushAppHostRelayMessages(state);
      return true;
    }
    if (message.type === "app-host-port-error") {
      clientDiagnostic("app-host-error", {
        error: typeof message.error === "string" ? message.error : "",
        portId,
      });
      closeAppHostRelay(state, "gateway_error", false);
      return true;
    }
    if (message.type === "app-host-port-close") {
      closeAppHostRelay(state, message.reason || "gateway_close", false);
      return true;
    }
    const data = Object.prototype.hasOwnProperty.call(message, "data") ? message.data : undefined;
    if (!(data === null || typeof data === "string")) {
      // 官方 app-host 当前只传字符串 JSON-RPC；其它类型保持拒绝，避免破坏 renderer 侧协议假设。
      clientDiagnostic("app-host-non-string-message", {
        payloadType: payloadShape(data),
        portId,
      });
      return true;
    }
    handleTokenUsageAppHostData(data);
    try {
      state.port.postMessage(data);
      if (data === null) closeAppHostRelay(state, "official_closed", false);
    } catch (error) {
      clientDiagnostic("app-host-port-post-failed", {
        error: error instanceof Error ? error.message : String(error),
        errorName: error && error.name ? String(error.name) : "",
        portId,
      });
      closeAppHostRelay(state, "post_to_browser_failed", true);
    }
    return true;
  }

  function installAppHostMessagePortBridge() {
    if (w.__codexAppHostMessagePortBridgeInstalled) return;
    w.__codexAppHostMessagePortBridgeInstalled = true;
    w.addEventListener("message", (event) => {
      // 官方 renderer 按 Electron preload 协议给 window 自己 postMessage，不处理 iframe/外部来源。
      if (event.source !== w) return;
      const data = event.data;
      if (!data || typeof data !== "object" || data.type !== "connect-app-host") return;
      const port = data.port || (event.ports && event.ports[0]);
      if (!port || typeof port.postMessage !== "function" || typeof port.start !== "function") {
        clientDiagnostic("app-host-connect-missing-port", {
          payloadType: payloadShape(data),
        });
        return;
      }
      const state = {
        closed: false,
        connected: false,
        flushing: false,
        pending: [],
        port,
        portId: appHostPortId(),
      };
      appHostPortRelays.set(state.portId, state);
      port.addEventListener("message", (portEvent) => {
        // MessageEvent.data 可能不是自有属性，直接读取才能拿到官方 RPC 字符串。
        const portData = portEvent ? portEvent.data : undefined;
        if (!(portData === null || typeof portData === "string")) {
          clientDiagnostic("app-host-browser-non-string-message", {
            payloadType: payloadShape(portData),
            portId: state.portId,
          });
          return;
        }
        queueAppHostRelayPayload(state, { type: "app-host-port-message", data: portData });
        if (portData === null) closeAppHostRelay(state, "browser_closed", false);
      });
      port.addEventListener("messageerror", () => {
        clientDiagnostic("app-host-browser-message-error", { portId: state.portId });
        closeAppHostRelay(state, "browser_message_error", true);
      });
      /**
       * 官方 preload 会把 connect-app-host 的 port 直接转给 ipcRenderer.postMessage。
       * Web 端不能跨进程传 MessagePort，所以这里先发 connect 控制帧，再透明转发后续字符串 RPC。
       */
      queueAppHostRelayPayload(state, { type: "app-host-connect" });
      port.start();
      clientDiagnostic("app-host-connect-captured", {
        portId: state.portId,
        wsReady,
        wsState: websocketStateName(ws),
      });
    });
  }

  function payloadFromIpcArgs(args) {
    return args.length <= 1 ? (args[0] ?? null) : args;
  }

  function handleConnectorLogoFetchInvoke(channel, ipcArgs, payload, diagnosticSummary) {
    const cacheKey = connectorLogoCacheKeyFromPayload(payload);
    const requestId = connectorLogoRequestId(payload);
    if (!cacheKey || !requestId) {
      return enqueueLowPriorityIpc(diagnosticSummary, () => invokeGatewayImmediate(channel, ipcArgs, payload));
    }

    if (emitConnectorLogoCachedResponse(cacheKey, requestId)) {
      return Promise.resolve({ ok: true, cached: true });
    }

    const inFlight = connectorLogoInFlight.get(cacheKey);
    if (inFlight) {
      // 同一个页面内相同 logo 只让第一条请求进入官方 IPC，其余 requestId 等待第一条回包后本地克隆。
      inFlight.waitingRequestIds.push(requestId);
      logConnectorLogoDiagnostic("logo_inflight_join", {
        cacheKey,
        requestId,
        waiterCount: inFlight.waitingRequestIds.length,
      });
      return Promise.resolve({ ok: true, joined: true });
    }

    rememberConnectorLogoRequest(cacheKey, requestId);
    logConnectorLogoDiagnostic("logo_cache_miss", { cacheKey, requestId });
    return enqueueLowPriorityIpc(diagnosticSummary, () =>
      invokeGatewayImmediate(channel, ipcArgs, payload).catch((error) => {
        emitConnectorLogoInvokeError(cacheKey, requestId, error);
        throw error;
      })
    );
  }

  /** 只负责把 IPC 请求发给 gateway，不做 web-shell 侧能力拦截。 */
  async function invokeGateway(channel, args) {
    const ipcArgs = Array.isArray(args) ? args : [args];
    const payload = payloadFromIpcArgs(ipcArgs);
    const diagnosticSummary = ipcDiagnosticSummary(channel, payload);
    if (isLowPriorityFetchPayload(payload)) {
      /**
       * connector logo 属于首屏非关键资产，但官方 renderer 会一次性发很多。
       * 这里使用页内缓存 + in-flight 去重 + 低优先级队列，避免非关键图片和会话/终端 IPC 抢通道。
       */
      return handleConnectorLogoFetchInvoke(channel, ipcArgs, payload, diagnosticSummary);
    }
    return invokeGatewayImmediate(channel, ipcArgs, payload);
  }

  async function invokeGatewayImmediate(channel, ipcArgs, payload) {
    const diagnosticSummary = ipcDiagnosticSummary(channel, payload);
    const invokeStartedAtMs = Date.now();
    const suppressRoutineDiagnostic = shouldSuppressRoutineIpcDiagnostic(payload);
    if (!suppressRoutineDiagnostic) {
      clientDiagnostic("ipc-invoke-start", {
        ...diagnosticSummary,
        wsReady,
        wsState: websocketStateName(ws),
      });
    }
    if (shouldWaitForWsBeforeInvoke(channel)) {
      const waitStartedAtMs = Date.now();
      if (!suppressRoutineDiagnostic) {
        clientDiagnostic("ipc-ws-wait-start", {
          ...diagnosticSummary,
          wsReady,
          wsState: websocketStateName(ws),
        });
      }
      const ready = await waitForGatewayWsReady();
      if (!suppressRoutineDiagnostic) {
        clientDiagnostic("ipc-ws-wait-end", {
          ...diagnosticSummary,
          ready,
          waitMs: Date.now() - waitStartedAtMs,
          wsReady,
          wsState: websocketStateName(ws),
        });
      }
    }
    // args 是新的自适应传输格式；payload 保留给旧 gateway 或调试工具读取。
    const body = stringifyForIpc({ channel, args: ipcArgs, payload, clientId });
    const retryDelays = shouldRetryGatewayInvoke(channel, payload) ? [0, 80, 250] : [0];
    let res = null;
    let lastFetchError = null;
    try {
      for (let attempt = 0; attempt < retryDelays.length; attempt += 1) {
        if (retryDelays[attempt] > 0) await delay(retryDelays[attempt]);
        const attemptStartedAtMs = Date.now();
        if (!suppressRoutineDiagnostic) {
          clientDiagnostic("ipc-http-attempt", {
            ...diagnosticSummary,
            attempt: attempt + 1,
            wsReady,
            wsState: websocketStateName(ws),
          });
        }
        try {
          res = await w.fetch("/api/ipc/invoke", {
            method: "POST",
            credentials: "same-origin",
            headers: gatewayAuthHeaders({ "content-type": "application/json" }),
            body,
          });
          if (!suppressRoutineDiagnostic) {
            clientDiagnostic("ipc-http-response", {
              ...diagnosticSummary,
              attempt: attempt + 1,
              elapsedMs: Date.now() - attemptStartedAtMs,
              ok: res.ok,
              status: res.status,
            });
          }
          lastFetchError = null;
          break;
        } catch (error) {
          lastFetchError = error;
          clientDiagnostic("ipc-http-error", {
            ...diagnosticSummary,
            attempt: attempt + 1,
            elapsedMs: Date.now() - attemptStartedAtMs,
            error: error instanceof Error ? error.message : String(error),
            errorName: error && error.name ? String(error.name) : "",
          });
          if (!isTransientGatewayFetchError(error) || attempt === retryDelays.length - 1) throw error;
        }
      }

      if (!res) throw lastFetchError || new Error("IPC invoke failed before request was sent");
      const json = await res.json().catch(() => null);
      if (!res.ok || (json && typeof json === "object" && json.ok === false)) {
        const message = ipcInvokeErrorMessage(channel, res.status, json);
        const error = new Error(message);
        error.channel = channel;
        error.status = res.status;
        error.response = json;
        throw error;
      }
      if (!suppressRoutineDiagnostic) {
        clientDiagnostic("ipc-invoke-success", {
          ...diagnosticSummary,
          elapsedMs: Date.now() - invokeStartedAtMs,
          ok: true,
          responseType:
            json && typeof json === "object" && Object.prototype.hasOwnProperty.call(json, "value")
              ? payloadShape(json.value)
              : payloadShape(json),
          status: res.status,
        });
      }
      if (json && typeof json === "object" && Object.prototype.hasOwnProperty.call(json, "value")) {
        if (
          channel === "open-file" &&
          json.value &&
          typeof json.value === "object" &&
          typeof json.value.url === "string"
        ) {
          openPreviewInCodexSidePanel(json.value);
        }
        return json.value;
      }
      return json;
    } catch (error) {
      clientDiagnostic("ipc-invoke-failed", {
        ...diagnosticSummary,
        elapsedMs: Date.now() - invokeStartedAtMs,
        error: error instanceof Error ? error.message : String(error),
        errorName: error && error.name ? String(error.name) : "",
        ok: false,
        status: error && typeof error.status === "number" ? error.status : 0,
      });
      throw error;
    }
  }

  /** 模拟 Electron ipcRenderer.invoke，实际通过 gateway 的 /api/ipc/invoke 完成。 */
  async function invoke(channel, ...args) {
    const payload = payloadFromIpcArgs(args);
    if (channel === "pick-files") return pickFilesInBrowser(payload);
    emitOpenCodexPluginEvent("ipc:invoke", { channel, payload });
    return invokeGateway(channel, args);
  }

  /** 终端消息按 sessionId 串行化，避免 write/resize/attach 乱序。 */
  function terminalSessionId(payload) {
    return payload && typeof payload === "object" && typeof payload.sessionId === "string"
      ? payload.sessionId
      : "__global__";
  }

  /** 对同一个终端 session 的 invoke 排队执行。 */
  function enqueueTerminalInvoke(sessionId, payload) {
    const previous = terminalMessageQueues.get(sessionId) || Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(() => invoke("codex_desktop:message-from-view", payload))
      .finally(() => {
        if (terminalMessageQueues.get(sessionId) === next) {
          terminalMessageQueues.delete(sessionId);
        }
      });
    terminalMessageQueues.set(sessionId, next);
    return next;
  }

  /** terminal-write 也走队列，避免输入字符和 attach/resize 交错。 */
  function enqueueTerminalWrite(payload) {
    const sessionId = terminalSessionId(payload);
    return enqueueTerminalInvoke(sessionId, payload);
  }

  /** 所有 terminal-* 消息统一进入 session 队列。 */
  function enqueueTerminalMessage(payload) {
    const sessionId =
      payload && typeof payload === "object" && typeof payload.sessionId === "string"
        ? payload.sessionId
        : "__global__";
    if (payload && typeof payload === "object" && payload.type === "terminal-write") {
      return enqueueTerminalWrite(payload);
    }
    return enqueueTerminalInvoke(sessionId, payload);
  }

  /** Electron shell.openExternal 的浏览器实现。 */
  function openExternal(url) {
    const newWindow = w.open(url, "_blank", "noopener,noreferrer");
    if (newWindow) return true;
    return true;
  }

  /** 清理旧的 web-shell 自定义预览面板，现在优先复用 Codex 右侧面板。 */
  function closeLegacyPreviewPanel() {
    const panel = document.getElementById("codex-web-file-preview");
    if (panel) panel.remove();
    const styles = document.getElementById("codex-web-file-preview-styles");
    if (styles) styles.remove();
  }

  /** 将 gateway 返回的相对预览 URL 转成绝对 URL。 */
  function normalizePreviewUrl(url) {
    if (typeof url !== "string" || !url) return null;
    try {
      return new URL(url, location.origin).href;
    } catch {
      return null;
    }
  }

  /** 复用 Codex 原本右侧 panel 打开文件预览。 */
  function openPreviewInCodexSidePanel(payload) {
    if (!payload || typeof payload !== "object" || typeof payload.url !== "string") return false;
    const url = normalizePreviewUrl(payload.url);
    if (!url) return false;
    closeLegacyPreviewPanel();
    const panelPayload = {
      open: true,
      url,
      source: "manual",
      initiator: "open_file_bridge",
    };
    const delivered = dispatch("toggle-browser-panel", panelPayload);
    emitWindowMessage("toggle-browser-panel", panelPayload);
    if (delivered === 0) {
      setTimeout(() => {
        dispatch("toggle-browser-panel", panelPayload);
        emitWindowMessage("toggle-browser-panel", panelPayload);
      }, 0);
    }
    return true;
  }

  /** 把 Desktop 专用 app://fs/@fs/... URL 转成 gateway 同源文件 URL。 */
  function appFsUrlToGatewayUrl(value) {
    if (typeof value !== "string" || !value.startsWith("app://fs/")) return null;
    try {
      const url = new URL(value);
      if (url.protocol !== "app:" || url.hostname !== "fs" || !url.pathname.startsWith("/@fs/")) return null;
      const decodedPath = decodeURIComponent(url.pathname.slice("/@fs/".length));
      const encodedPath = decodedPath
        .split("/")
        .filter((part, index) => index === 0 || part.length > 0)
        .map((part) => encodeURIComponent(part))
        .join("/");
      return new URL(`/api/app-fs/@fs/${encodedPath}`, location.origin).href;
    } catch {
      return null;
    }
  }

  /** 重写单个图片节点的 app://fs src，避免浏览器直接请求不支持的自定义协议。 */
  function rewriteAppFsImageElement(element) {
    if (!element || element.nodeType !== 1 || String(element.tagName || "").toLowerCase() !== "img") return;
    const rawSrc = element.getAttribute("src") || element.src || "";
    const rewritten = appFsUrlToGatewayUrl(rawSrc);
    if (!rewritten || element.getAttribute("src") === rewritten) return;
    element.setAttribute("data-codex-web-app-fs-src", rawSrc);
    element.setAttribute("src", rewritten);
  }

  /** 只扫描本次新增节点内部的 app://fs 图片，避免对整页 DOM 做全量遍历。 */
  function rewriteAppFsImagesInAddedNode(node) {
    rewriteAppFsImageElement(node);
    if (!node || node.nodeType !== 1 || typeof node.querySelectorAll !== "function") return;
    node.querySelectorAll("img[src^='app://fs/']").forEach((element) => rewriteAppFsImageElement(element));
  }

  /** 安装 MutationObserver，只处理新增图片节点和 src 更新，避免启动时全量扫描 DOM。 */
  function installAppFsImageRewrite() {
    if (!document || document.__codexAppFsImageRewriteInstalled) return;
    document.__codexAppFsImageRewriteInstalled = true;
    const start = () => {
      const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          if (mutation.type === "attributes") {
            rewriteAppFsImageElement(mutation.target);
            continue;
          }
          for (const node of mutation.addedNodes || []) {
            rewriteAppFsImagesInAddedNode(node);
          }
        }
      });
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["src"],
        childList: true,
        subtree: true,
      });
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", start, { once: true });
    } else {
      start();
    }
  }

  /** Electron window.setTitle 的浏览器实现。 */
  function setWindowTitle(title) {
    document.title = String(title || "");
    return true;
  }

  /** 归一化 account/updated，兼容官方 auth callback 需要的字段。 */
  function normalizeAuthStatus(payload) {
    const authMethod =
      payload && typeof payload === "object"
        ? payload.authMode || (payload.account && payload.account.type === "chatgpt" ? "chatgpt" : payload.account && payload.account.type === "apikey" ? "apikey" : null)
        : null;
    return {
      authMethod,
      openAIAuth: authMethod,
      account: payload && typeof payload === "object" ? payload.account || null : null,
      requiresOpenaiAuth:
        payload && typeof payload === "object" && Object.prototype.hasOwnProperty.call(payload, "requiresOpenaiAuth")
          ? !!payload.requiresOpenaiAuth
          : authMethod == null,
    };
  }

  /** 通知所有通过 addAuthStatusCallback 注册的监听器。 */
  function notifyAuthStatus(payload) {
    const status = normalizeAuthStatus(payload);
    for (const callback of [...authStatusCallbacks]) {
      try {
        callback(status);
      } catch (error) {
        console.error("[codex-web] auth status callback failed", error);
      }
    }
  }

  const sharedObjectSnapshot = new Map();
  const persistedAtomSnapshot = new Map();
  const COMPOSER_PERMISSION_MODE_VISIBILITY_KEY = "composer-permission-mode-visibility";
  const DEFAULT_COMPOSER_PERMISSION_MODE_VISIBILITY = {
    "guardian-approvals": true,
    "full-access": true,
  };

  /** 判断普通对象。 */
  function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  /** shared-object snapshot 写入前补齐 Web 必需 feature flag。 */
  function normalizeSharedObjectSnapshotValue(key, value) {
    if (key !== STATSIG_DEFAULT_FEATURES_CONFIG) return value;
    return {
      ...(isPlainObject(value) ? value : {}),
      ...STATSIG_DEFAULT_FEATURE_OVERRIDES,
    };
  }

  /** 更新本地 shared-object snapshot。 */
  function setSharedObjectSnapshotValue(key, value) {
    if (!key) return null;
    const normalized = normalizeSharedObjectSnapshotValue(key, value);
    sharedObjectSnapshot.set(key, normalized);
    return normalized;
  }

  /** 读取 shared-object snapshot，特定 key 会懒补默认值。 */
  function getSharedObjectSnapshotValue(key) {
    if (key === STATSIG_DEFAULT_FEATURES_CONFIG || sharedObjectSnapshot.has(key)) {
      return setSharedObjectSnapshotValue(key, sharedObjectSnapshot.get(key));
    }
    return null;
  }

  /** 异步发出 shared-object-updated，模拟官方订阅行为。 */
  function emitSharedObjectSnapshotValue(key) {
    const value = getSharedObjectSnapshotValue(key);
    if (value === null) return;
    queueMicrotask(() => dispatch("shared-object-updated", { key, value }));
  }

  /** 初始化 shared-object snapshot，合并 gateway 注入的首屏快照。 */
  function initializeSharedObjectSnapshot() {
    setSharedObjectSnapshotValue("host_config", { id: "local", kind: "local" });
    const snapshot =
      cfg.sharedObjectSnapshot && typeof cfg.sharedObjectSnapshot === "object"
        ? cfg.sharedObjectSnapshot
        : {};
    for (const [key, value] of Object.entries(snapshot)) {
      setSharedObjectSnapshotValue(key, value);
    }
    getSharedObjectSnapshotValue(STATSIG_DEFAULT_FEATURES_CONFIG);
  }

  initializeSharedObjectSnapshot();

  /** Desktop 的 prompt-history 可能是分组对象，renderer 的 persisted atom 只消费字符串数组。 */
  function normalizePromptHistoryForRenderer(value) {
    if (Array.isArray(value)) return value.filter((item) => typeof item === "string");
    if (!isPlainObject(value)) return [];
    if (Array.isArray(value.global)) return value.global.filter((item) => typeof item === "string");
    if (Array.isArray(value["new-conversation"])) {
      return value["new-conversation"].filter((item) => typeof item === "string");
    }
    return [];
  }

  /** persisted atom 写给官方 renderer 前做形态兼容，避免首屏状态和 Desktop 存储结构不一致。 */
  function normalizePersistedAtomValue(key, value) {
    if (key === "prompt-history") return normalizePromptHistoryForRenderer(value);
    if (key === COMPOSER_PERMISSION_MODE_VISIBILITY_KEY) {
      return {
        ...DEFAULT_COMPOSER_PERMISSION_MODE_VISIBILITY,
        ...(isPlainObject(value) ? value : {}),
      };
    }
    return value;
  }

  /** 更新浏览器内 persisted atom 快照；真正持久化仍交给官方 IPC handler。 */
  function setPersistedAtomSnapshotValue(key, value, deleted) {
    if (!key) return null;
    if (deleted) {
      persistedAtomSnapshot.delete(key);
      return undefined;
    }
    const normalized = normalizePersistedAtomValue(key, value);
    persistedAtomSnapshot.set(key, normalized);
    return normalized;
  }

  function persistedAtomSnapshotObject() {
    return Object.fromEntries(persistedAtomSnapshot.entries());
  }

  /** 初始化 persisted atom 快照，保证 renderer 的启动同步不依赖过早建立的 WebSocket。 */
  function initializePersistedAtomSnapshot() {
    const snapshot =
      cfg.persistedAtomSnapshot && typeof cfg.persistedAtomSnapshot === "object"
        ? cfg.persistedAtomSnapshot
        : {};
    for (const [key, value] of Object.entries(snapshot)) {
      setPersistedAtomSnapshotValue(key, value, false);
    }
  }

  /** 立即给官方 renderer 回 persisted-atom-sync，消除启动期固定 5 秒等待。 */
  function emitPersistedAtomSync() {
    const payload = { state: persistedAtomSnapshotObject() };
    const delivered = dispatch("persisted-atom-sync", payload);
    emitWindowMessage("persisted-atom-sync", payload);
    return delivered;
  }

  /** persisted atom 更新先同步给当前页面，防止 UI 等待官方异步广播。 */
  function emitPersistedAtomUpdated(key, value, deleted) {
    const payload = {
      key,
      value: deleted ? null : value,
      deleted: !!deleted,
    };
    dispatch("persisted-atom-updated", payload);
    emitWindowMessage("persisted-atom-updated", payload);
  }

  initializePersistedAtomSnapshot();

  /** 把 Electron/Codex bridge API 挂到多个官方可能访问的全局对象上。 */
  function attachBridge(target) {
    target.invoke = invoke;
    target.on = (channel, handler) => subscribe(channel, handler);
    target.off = (channel, handler) => unsubscribe(channel, handler);
    target.subscribe = target.on;
    target.unsubscribe = target.off;
    target.addListener = target.on;
    target.removeListener = target.off;
    target.once = (channel, handler) => {
      if (typeof handler !== "function") return () => {};
      const unsubscribeOnce = subscribe(channel, (...listenerArgs) => {
        unsubscribeOnce();
        return handler(...listenerArgs);
      });
      return unsubscribeOnce;
    };
    target.removeAllListeners = (channel) => {
      if (typeof channel === "string") {
        listeners.delete(channel);
      } else {
        listeners.clear();
      }
    };
    target.getPlatform = () => "web";
    target.getVersion = () => "web-poc";
    // 对齐官方 preload 暴露的基础字段，避免新版 renderer 走 fallback IPC 后报 missing handler。
    target.windowType = "electron";
    target.openExternal = (url) => openExternal(url);
    target.setWindowTitle = (title) => setWindowTitle(title);
    target.getAccount = () => invoke("account-info");
    target.addAuthStatusCallback = (callback) => {
      if (typeof callback !== "function") return () => {};
      authStatusCallbacks.add(callback);
      return () => authStatusCallbacks.delete(callback);
    };
    target.removeAuthStatusCallback = (callback) => {
      authStatusCallbacks.delete(callback);
    };
    target.send = (channel, ...args) => invoke(channel, ...args);
    target.dispatchMessage = (channel, payload) => {
      const message =
        payload && typeof payload === "object"
          ? { type: channel, ...payload }
          : { type: channel, payload };
      return target.sendMessageFromView(message);
    };
    target.getPathForFile = (file) => {
      if (typeof file === "string") return file;
      if (file && typeof file === "object" && typeof file.path === "string") return file.path;
      return null;
    };
    target.sendMessageFromView = async (payload) =>
      Promise.resolve().then(() => {
        if (payload && typeof payload === "object" && payload.type === "persisted-atom-sync-request") {
          // 官方 renderer 首屏会很早请求 persisted atom；这里先本地回包，避免 WS 未连接导致回包丢失。
          emitPersistedAtomSync();
          void invoke("codex_desktop:message-from-view", payload).catch((error) => {
            console.warn("[codex-web] failed to forward persisted atom sync request", error);
          });
          return true;
        }
        if (payload && typeof payload === "object" && payload.type === "persisted-atom-update" && payload.key) {
          // 更新先写本页快照并广播，后续再交给官方 main 按 Desktop 原逻辑落盘。
          const value = setPersistedAtomSnapshotValue(payload.key, payload.value, !!payload.deleted);
          emitPersistedAtomUpdated(payload.key, value, !!payload.deleted);
          return invoke("codex_desktop:message-from-view", payload);
        }
        if (payload && typeof payload === "object" && payload.type === "shared-object-set") {
          // shared-object 的本地快照先同步更新，再交给 gateway 持久化。
          const value = setSharedObjectSnapshotValue(payload.key, payload.value);
          dispatch("shared-object-updated", { ...payload, value });
        }
        if (payload && typeof payload === "object" && payload.type === "shared-object-subscribe" && payload.key) {
          emitSharedObjectSnapshotValue(payload.key);
        }
        if (payload && typeof payload === "object" && payload.type === "open-in-browser" && payload.url) {
          return openExternal(payload.url);
        }
        if (handlePickFilesFetchMessage(payload)) {
          return true;
        }
        if (handleIdeContextFetchMessage(payload)) {
          return true;
        }
        emitOpenCodexPluginEvent("view:message", payload);
        if (
          payload &&
          typeof payload === "object" &&
          typeof payload.type === "string" &&
          payload.type.startsWith("terminal-")
        ) {
          return enqueueTerminalMessage(payload);
        }
        return invoke("codex_desktop:message-from-view", payload);
      });
    target.sendWorkerMessageFromView = async (workerId, payload) =>
      invoke(`codex_desktop:worker:${workerId}:from-view`, payload);
    target.subscribeToWorkerMessages = (workerId, handler) =>
      subscribe(`codex_desktop:worker:${workerId}:for-view`, handler);
    target.getBuildFlavor = () => "prod";
    // 这些方法是当前官方 preload 明确暴露的能力；Web 侧给出等价或保守结果，避免 renderer 走缺失 IPC。
    target.isIntelMacBuild = () => /macintosh|mac os x/i.test(navigator.userAgent) && /intel/i.test(navigator.userAgent);
    target.usesOwlAppShell = () => false;
    target.getFastModeRolloutMetrics = (params) =>
      invoke("codex_desktop:get-fast-mode-rollout-metrics", params).catch(() => null);
    target.getSentryInitOptions = () => ({
      enabled: false,
      appVersion: "0.0.0-web-poc",
      codexAppSessionId: target.getAppSessionId(),
    });
    target.getSystemThemeVariant = () => {
      const mq = w.matchMedia?.("(prefers-color-scheme: dark)");
      return mq && mq.matches ? "dark" : "light";
    };
    target.getAppSessionId = () => {
      const key = "__codex_web_session_id__";
      let id = localStorage.getItem(key);
      if (!id) {
        id = w.crypto?.randomUUID?.() || `web-${Math.random().toString(36).slice(2)}`;
        localStorage.setItem(key, id);
      }
      return id;
    };
    target.getSharedObjectSnapshotValue = (key) => getSharedObjectSnapshotValue(key);
    // Web shell 没有真实原生菜单；不暴露 showContextMenu，让官方 context-menu 组件走自带 DOM 菜单。
    try {
      delete target.showContextMenu;
    } catch {
      target.showContextMenu = undefined;
    }
    // 官方 Windows 菜单栏只检查 showApplicationMenu 是否存在；Web shell 不暴露它，避免渲染文件/编辑等菜单项。
    try {
      delete target.showApplicationMenu;
    } catch {
      target.showApplicationMenu = undefined;
    }
    target.triggerSentryTestError = () => {
      console.warn("[codex-web] triggerSentryTestError is a no-op in web");
      return false;
    };
    target.subscribeToSystemThemeVariant = (handler) => {
      const mq = w.matchMedia?.("(prefers-color-scheme: dark)");
      if (!mq) return () => {};
      const emit = () => handler(mq.matches ? "dark" : "light");
      emit();
      mq.addEventListener("change", emit);
      return () => mq.removeEventListener("change", emit);
    };
  }

  const BRIDGE_FALLBACK_UNDEFINED_PROPS = new Set([
    "then",
    "catch",
    "finally",
    "showContextMenu",
    "showApplicationMenu",
    "constructor",
    "toJSON",
    "inspect",
  ]);

  function createAdaptiveBridgeProxy(target, label) {
    if (!target || target.__codexAdaptiveBridgeProxy) return target;
    const proxy = new Proxy(target, {
      get(object, prop, receiver) {
        if (Reflect.has(object, prop)) return Reflect.get(object, prop, receiver);
        if (typeof prop !== "string" || BRIDGE_FALLBACK_UNDEFINED_PROPS.has(prop)) return undefined;
        // 官方新增 bridge 方法时先按同名 IPC channel 透传，避免因为 undefined 直接崩。
        return (...args) => {
          console.warn(`[codex-web] fallback bridge method ${label}.${prop} -> IPC channel ${prop}`);
          return invoke(prop, ...args);
        };
      },
    });
    try {
      Object.defineProperty(proxy, "__codexAdaptiveBridgeProxy", {
        configurable: true,
        value: true,
      });
    } catch {}
    return proxy;
  }

  w.codexBridge = w.codexBridge || {};
  w.electronAPI = w.electronAPI || {};
  w.electronBridge = w.electronBridge || {};
  w.__TAURI__ = undefined;
  w.global = w.global || w;
  w.process = w.process || {
    env: {},
    platform: "browser",
    versions: {
      electron: "0.0.0-web-poc",
      node: "0.0.0-web-poc",
      chrome: "0.0.0-web-poc",
    },
  };
  w.codexWindowType = w.codexWindowType || "electron";

  /** 浏览器直连 Statsig/遥测在受限网络下会刷 console error；Web 侧用本地默认值兜底。 */
  function buildStatsigInitializeResponse() {
    const feature_gates = {};
    const dynamic_configs = {
      [STATSIG_DEFAULT_FEATURES_CONFIG]: {
        name: STATSIG_DEFAULT_FEATURES_CONFIG,
        value: { ...STATSIG_DEFAULT_FEATURE_OVERRIDES },
        rule_id: "gateway_override",
        secondary_exposures: [],
      },
    };
    for (const [name, value] of Object.entries(STATSIG_DEFAULT_FEATURE_OVERRIDES)) {
      feature_gates[name] = {
        name,
        value,
        rule_id: "gateway_override",
        secondary_exposures: [],
      };
    }
    return {
      has_updates: true,
      time: Date.now(),
      hash_used: "djb2",
      feature_gates,
      dynamic_configs,
      layer_configs: {
        [STATSIG_I18N_LAYER_CONFIG]: {
          name: STATSIG_I18N_LAYER_CONFIG,
          value: { ...STATSIG_I18N_LAYER_VALUES },
          rule_id: "gateway_override",
          secondary_exposures: [],
        },
      },
      param_stores: {},
      exposures: {},
      sdk_flags: {},
    };
  }

  function isStatsigInitializeUrl(url) {
    try {
      const parsed = new URL(url, location.href);
      return parsed.hostname === "ab.chatgpt.com" && parsed.pathname.replace(/\/+$/, "") === "/v1/initialize";
    } catch {
      return false;
    }
  }

  function isTelemetryRegisterUrl(url) {
    try {
      const parsed = new URL(url, location.href);
      const pathname = parsed.pathname.replace(/\/+$/, "");
      return parsed.hostname === "chatgpt.com" && (pathname === "/ces/v1/rgstr" || pathname === "/ces/v1/log_event");
    } catch {
      return false;
    }
  }

  // sentry-ipc:// 是 Electron 私有协议，浏览器里用空响应兜底，避免 renderer 报错。
  if (typeof w.fetch === "function" && !w.__codexWebFetchPatched) {
    const originalFetch = w.fetch.bind(w);
    w.fetch = async (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input && typeof input === "object" && "url" in input
            ? String(input.url || "")
            : "";
      if (url.startsWith("sentry-ipc://")) {
        return new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (isStatsigInitializeUrl(url)) {
        return new Response(JSON.stringify(buildStatsigInitializeResponse()), {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
      if (isTelemetryRegisterUrl(url)) {
        return new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
      return originalFetch(input, init);
    };
    w.__codexWebFetchPatched = true;
  }

  // 官方 bundle 仍可能 require("electron"/"path"/"os")，这里提供浏览器安全替身。
  if (typeof w.require !== "function") {
    w.require = (name) => {
      if (name === "electron") {
        return {
          ipcRenderer: w.electronBridge,
          shell: { openExternal },
          contextBridge: { exposeInMainWorld() {} },
        };
      }
      if (name === "path") {
        return {
          join: (...parts) =>
            parts
              .filter((part) => part !== null && part !== undefined)
              .map(String)
              .join("/")
              .replace(/\/+/g, "/"),
          basename: (p) => String(p).split(/[\\/]/).filter(Boolean).pop() || "",
          dirname: (p) => {
            const parts = String(p).split(/[\\/]/).filter(Boolean);
            parts.pop();
            return parts.join("/") || "/";
          },
        };
      }
      if (name === "os") {
        const homeDir =
          typeof cfg.homeDir === "string" && cfg.homeDir
            ? cfg.homeDir
            : Array.isArray(cfg.workspaceRoots) && typeof cfg.workspaceRoots[0] === "string"
              ? cfg.workspaceRoots[0].split("/").slice(0, 3).join("/") || "/"
              : "/";
        return { platform: () => "browser", homedir: () => homeDir };
      }
      if (name === "process") return w.process;
      console.warn("[codex-web] unhandled require:", name);
      return {};
    };
  }

  attachBridge(w.codexBridge);
  attachBridge(w.electronAPI);
  attachBridge(w.electronBridge);
  w.codexBridge = createAdaptiveBridgeProxy(w.codexBridge, "codexBridge");
  w.electronAPI = createAdaptiveBridgeProxy(w.electronAPI, "electronAPI");
  w.electronBridge = createAdaptiveBridgeProxy(w.electronBridge, "electronBridge");
  installAppHostMessagePortBridge();
  installAppFsImageRewrite();

  subscribe("window:setTitle", (title) => setWindowTitle(title));
  subscribe("account/updated", (payload) => notifyAuthStatus(payload));
  subscribe("codex_desktop:system-theme-variant-updated", (value) => {
    if (value === "dark" || value === "light") {
      document.documentElement.dataset.theme = value;
    }
  });
  subscribe("shared-object-updated", (message) => {
    if (message && typeof message === "object" && message.key) {
      setSharedObjectSnapshotValue(message.key, message.value);
    }
  });

  w.__codexWebSubscribe = subscribe;
  w.__codexWebUnsubscribe = unsubscribe;
  w.__codexWebDispatch = dispatch;
  w.__codexWebPayloadShape = payloadShape;

  /** 建立到 gateway 的 WebSocket，接收 app-server/业务广播事件。 */
  function connect() {
    if (!cfg.gatewayWsUrl || !("WebSocket" in w)) return;
    wsReady = false;
    let socket = null;
    clientDiagnostic("ws-connect-start", {
      wsReady,
      wsState: websocketStateName(ws),
    });
    try {
      socket = new WebSocket(gatewayWebSocketUrl());
      ws = socket;
    } catch (error) {
      console.warn("[codex-web] failed to open gateway socket", error);
      clientDiagnostic("ws-connect-failed", {
        error: error instanceof Error ? error.message : String(error),
        errorName: error && error.name ? String(error.name) : "",
        wsState: websocketStateName(socket),
      });
      scheduleReconnect();
      return;
    }

    socket.addEventListener("open", () => {
      // hello 会把本页面 clientId 注册到 gateway，后续审批/fetch 响应才能定向回来。
      reconnectDelay = 500;
      try {
        socket.send(JSON.stringify({ type: "hello", clientId }));
        clientDiagnostic("ws-hello-sent", {
          wsReady,
          wsState: websocketStateName(socket),
        });
      } catch (error) {
        clientDiagnostic("ws-hello-send-failed", {
          error: error instanceof Error ? error.message : String(error),
          errorName: error && error.name ? String(error.name) : "",
          wsState: websocketStateName(socket),
        });
      }
      clientDiagnostic("ws-open", {
        wsReady,
        wsState: websocketStateName(socket),
      });
      emitSharedObjectSnapshotValue(STATSIG_DEFAULT_FEATURES_CONFIG);
    });
    socket.addEventListener("message", (event) => {
      const rawData = event.data;
      // 这些字段只用于 debugWs 排障；默认值保持 0，避免常态下多做字符串长度和 Date.now 采样。
      const rawChars = WS_DEBUG_ENABLED ? rawWsMessageChars(rawData) : 0;
      const parseStartedAtMs = WS_DEBUG_ENABLED ? Date.now() : 0;
      let msg = null;
      let parseMs = 0;
      try {
        // 官方桥接协议要求浏览器收到完整 JSON 后再按 channel/MessagePort 分发，不能在这里改消息形状。
        msg = JSON.parse(rawData);
        parseMs = WS_DEBUG_ENABLED ? Date.now() - parseStartedAtMs : 0;
        if (msg && msg.type === "hello-ack" && msg.clientId === clientId) {
          // ack 表示 gateway 已经把 clientId 写入路由表，之后再发 IPC 才不会丢首批异步回包。
          markGatewayWsReady();
          clientDiagnostic("ws-hello-ack", {
            ready: true,
            wsReady,
            wsState: websocketStateName(socket),
          });
          if (WS_DEBUG_ENABLED) {
            maybeLogLargeOrSlowWsInbound({
              handledBy: "hello-ack",
              handleMs: Math.max(0, Date.now() - parseStartedAtMs - parseMs),
              parseMs,
              rawChars,
              summary: gatewayWsInboundSummary(msg),
            });
          }
          return;
        }
        const appHostStartedAtMs = WS_DEBUG_ENABLED ? Date.now() : 0;
        if (handleAppHostGatewayMessage(msg)) {
          if (WS_DEBUG_ENABLED) {
            maybeLogLargeOrSlowWsInbound({
              handledBy: "app-host",
              handleMs: Date.now() - appHostStartedAtMs,
              parseMs,
              rawChars,
              summary: gatewayWsInboundSummary(msg),
            });
          }
          return;
        }
        if (handleOpenCodexNotificationMessage(msg)) {
          if (WS_DEBUG_ENABLED) {
            maybeLogLargeOrSlowWsInbound({
              handledBy: "opencodex-notification",
              handleMs: Math.max(0, Date.now() - parseStartedAtMs - parseMs),
              parseMs,
              rawChars,
              summary: gatewayWsInboundSummary(msg),
            });
          }
          return;
        }
        if (msg && typeof msg.channel === "string") {
          // handleStartedAtMs 只包住前端分发阶段，用来和服务端 sendCallbackMs 区分。
          const handleStartedAtMs = WS_DEBUG_ENABLED ? Date.now() : 0;
          const messageArgs = Array.isArray(msg.args) ? msg.args : [msg.payload];
          const messagePayload = Object.prototype.hasOwnProperty.call(msg, "payload")
            ? msg.payload
            : payloadFromIpcArgs(messageArgs);
          const effectiveChannel = effectiveGatewayMessageChannel(msg.channel, messagePayload);
          const trackedConnectorLogoResponse =
            effectiveChannel === "fetch-response" && isTrackedConnectorLogoResponse(messagePayload);
          if (!trackedConnectorLogoResponse) {
            // 常规 ws-message 摘要仍保留，便于排查基础 IPC 路由；真正的大包耗时采样由 debugWs 控制。
            clientDiagnostic("ws-message", {
              ...ipcDiagnosticSummary(effectiveChannel, messagePayload),
              target: msg.channel,
              wsReady,
              wsState: websocketStateName(socket),
            });
          }
          if (effectiveChannel === "codex-web:preview-file") {
            // 文件预览是 web-shell 扩展事件，直接打开右侧 Codex panel。
            if (WS_DEBUG_ENABLED) {
              maybeLogLargeOrSlowWsInbound({
                handledBy: "preview-file",
                handleMs: Date.now() - handleStartedAtMs,
                parseMs,
                rawChars,
                summary: gatewayWsInboundSummary(msg, effectiveChannel, messagePayload),
              });
            }
            openPreviewInCodexSidePanel(messagePayload);
            return;
          }
          if (effectiveChannel === "fetch-response") {
            // 官方 logo 回包到达后写入页内缓存，并把同 key 等待的 requestId 用原样数据唤醒。
            handleConnectorLogoFetchResponse(messagePayload);
          }
          // vscode://codex/... 这类 fetch IPC 的失败只会从 WebSocket 回来，这里统一转成页面错误 toast。
          if (
            !trackedConnectorLogoResponse &&
            effectiveChannel === "fetch-response" &&
            messagePayload &&
            messagePayload.responseType === "error"
          ) {
            surfaceFetchIpcError("fetch-response", messagePayload);
          }
          if (effectiveChannel === "fetch-stream-error") {
            surfaceFetchIpcError("fetch-stream-error", messagePayload);
          }
          handleTokenUsageGatewayPayload(messagePayload);
          if (shouldDispatchGatewayMessage(msg.channel, effectiveChannel)) {
            dispatch(effectiveChannel, messagePayload);
          }
          emitWindowMessage(effectiveChannel, messagePayload);
          if (WS_DEBUG_ENABLED) {
            maybeLogLargeOrSlowWsInbound({
              handledBy: "gateway-channel",
              handleMs: Date.now() - handleStartedAtMs,
              parseMs,
              rawChars,
              summary: gatewayWsInboundSummary(msg, effectiveChannel, messagePayload),
            });
          }
        }
      } catch (error) {
        console.warn("[codex-web] invalid gateway message", error);
        clientDiagnostic("ws-message-invalid", {
          error: error instanceof Error ? error.message : String(error),
          errorName: error && error.name ? String(error.name) : "",
          parseMs: WS_DEBUG_ENABLED ? Date.now() - parseStartedAtMs : 0,
          rawChars,
          wsState: websocketStateName(socket),
        });
      }
    });
    socket.addEventListener("close", (event) => {
      if (ws === socket) wsReady = false;
      clientDiagnostic("ws-close", {
        status: event && typeof event.code === "number" ? event.code : 0,
        wsReady,
        wsState: websocketStateName(socket),
      });
      scheduleReconnect();
    });
    socket.addEventListener("error", (event) => {
      clientDiagnostic("ws-error", {
        errorName: event && event.type ? String(event.type) : "",
        wsReady,
        wsState: websocketStateName(socket),
      });
      try {
        socket.close();
      } catch {}
    });
  }

  /** WebSocket 断开后的指数退避重连。 */
  function scheduleReconnect() {
    if (reconnectTimer) return;
    clientDiagnostic("ws-reconnect-scheduled", {
      elapsedMs: reconnectDelay,
      wsReady,
      wsState: websocketStateName(ws),
    });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      reconnectDelay = Math.min(reconnectDelay * 2, 5000);
      connect();
    }, reconnectDelay);
  }

  connect();
})();
