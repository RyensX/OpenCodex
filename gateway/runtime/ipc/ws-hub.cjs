let WebSocketServer = null;
try {
  ({ WebSocketServer } = require("ws"));
} catch {}
const { diagnosticLog, diagnosticWarn, shortId } = require("../core/diagnostics.cjs");
const { DEBUG_LOGS } = require("../core/config.cjs");

// 下面这些阈值只服务于 OPENCODEX_DEBUG_WS=1 的链路排障；默认运行不会采样慢 WS 发送。
const WS_LARGE_MESSAGE_BYTES = Number(process.env.OPENCODEX_WS_LARGE_LOG_BYTES || 256 * 1024);
const WS_SEND_SLOW_MS = Number(process.env.OPENCODEX_WS_SEND_SLOW_MS || 80);
const WS_STRINGIFY_SLOW_MS = Number(process.env.OPENCODEX_WS_STRINGIFY_SLOW_MS || 20);
const WS_BUFFERED_LOG_BYTES = Number(process.env.OPENCODEX_WS_BUFFERED_LOG_BYTES || 512 * 1024);
const APP_HOST_TRAFFIC_FLUSH_MS = Number(process.env.OPENCODEX_APP_HOST_TRAFFIC_FLUSH_MS || 2000);
const APP_HOST_LARGE_FRAME_BYTES = Number(process.env.OPENCODEX_APP_HOST_LARGE_FRAME_BYTES || 64 * 1024);
// WS 压缩和 debug 采集分开控制：压缩默认开启，诊断默认关闭。
const WS_DEFLATE_DISABLED = process.env.OPENCODEX_WS_DISABLE_DEFLATE === "1";
const WS_DEFLATE_THRESHOLD = Number(process.env.OPENCODEX_WS_DEFLATE_THRESHOLD || 64 * 1024);
const WS_DEFLATE_CONCURRENCY = Number(process.env.OPENCODEX_WS_DEFLATE_CONCURRENCY || 4);
const WS_DEFLATE_LEVEL = Number(process.env.OPENCODEX_WS_DEFLATE_LEVEL || 3);
const WS_DEBUG_ENABLED = process.env.OPENCODEX_DEBUG_WS === "1";

function byteLength(value) {
  // WebSocket bufferedAmount 用字节衡量；日志里也统一按 UTF-8 字节估算，方便对齐网络层现象。
  return Buffer.byteLength(String(value || ""), "utf-8");
}

function routeIdFromPayload(value, depth = 0, seen = new WeakSet()) {
  // 官方 IPC 版本变化时 requestId 可能藏在 payload/request/response/body 里，递归提取比写死类型更稳。
  if (!value || typeof value !== "object" || depth > 4) return "";
  if (seen.has(value)) return "";
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = routeIdFromPayload(item, depth + 1, seen);
      if (nested) return nested;
    }
    return "";
  }
  if (typeof value.requestId === "string" && value.requestId) return value.requestId;
  if (value.request && typeof value.request === "object" && value.request.id != null) return String(value.request.id);
  if (value.id != null && (depth > 0 || value.method || value.jsonrpc || value.type)) return String(value.id);
  for (const key of ["payload", "message", "response", "body"]) {
    const nested = routeIdFromPayload(value[key], depth + 1, seen);
    if (nested) return nested;
  }
  return "";
}

function wsPayloadSummary(payload) {
  // 摘要只保留路由相关字段，不把正文、prompt、文件内容写进日志。
  const summary = {};
  if (payload && typeof payload === "object") {
    if (typeof payload.channel === "string") summary.channel = payload.channel;
    if (typeof payload.portId === "string") summary.portId = shortId(payload.portId);
    const nestedPayload = payload.payload && typeof payload.payload === "object" ? payload.payload : payload.payload;
    if (nestedPayload && typeof nestedPayload === "object" && typeof nestedPayload.type === "string") {
      summary.type = nestedPayload.type;
    }
    if (payload.type && typeof payload.type === "string") summary.type = payload.type;
    const requestId = routeIdFromPayload(payload);
    if (requestId) summary.requestId = requestId;
    summary.payloadType = nestedPayload && typeof nestedPayload === "object" ? `object(${Object.keys(nestedPayload).length})` : typeof nestedPayload;
  }
  return summary;
}

function wsCompressionOptions() {
  if (WS_DEFLATE_DISABLED) return false;
  return {
    // 只压缩大会话快照/历史消息这类大 JSON，小 IPC 保持原样，避免 CPU 成本抵消收益。
    threshold: WS_DEFLATE_THRESHOLD,
    // 不跨消息复用压缩上下文，降低内存占用和压缩侧信道风险。
    clientNoContextTakeover: true,
    serverNoContextTakeover: true,
    concurrencyLimit: WS_DEFLATE_CONCURRENCY,
    zlibDeflateOptions: {
      level: WS_DEFLATE_LEVEL,
    },
  };
}

// ws-hub 不理解官方 IPC 协议，只负责维护连接和按 clientId 投递 JSON 消息。
/** 创建 WebSocket hub，负责浏览器连接管理和 gateway 事件分发。 */
function createWsHub(server, { createAppHostRelay, handleNotificationEvent, isAuthed }) {
  if (!WebSocketServer) {
    throw new Error("The ws package is required for gateway websocket support.");
  }

  const perMessageDeflate = wsCompressionOptions();
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate });
  if (WS_DEBUG_ENABLED) {
    // 压缩配置只在排障模式打印；压缩本身始终按上面的配置生效。
    diagnosticLog("ws-hub", "compression_configured", {
      debugWs: WS_DEBUG_ENABLED,
      enabled: !!perMessageDeflate,
      threshold: perMessageDeflate ? perMessageDeflate.threshold : 0,
      concurrencyLimit: perMessageDeflate ? perMessageDeflate.concurrencyLimit : 0,
      level: perMessageDeflate ? perMessageDeflate.zlibDeflateOptions.level : 0,
    });
  }
  const clients = new Set();
  // clientsById 是定向回包索引；clients 是广播索引，二者都需要维护。
  const clientsById = new Map();
  let lastAuthRejectLogAtMs = 0;
  let suppressedAuthRejectCount = 0;
  const appHostTraffic = new Map();

  function socketRemoteAddress(socket) {
    return (socket && socket.__codexRemoteAddress) || "";
  }

  function socketClientId(socket) {
    return (socket && socket.__codexWebClientId) || "";
  }

  function appHostTrafficKey(clientId, portId, direction) {
    // app-host 一个页面可能同时有多个 MessagePort，聚合 key 必须带 portId 才不会混在一起。
    return `${clientId || "unknown"}\n${portId || "unknown"}\n${direction || "unknown"}`;
  }

  function flushAppHostTraffic(key) {
    if (!WS_DEBUG_ENABLED) return;
    const stat = appHostTraffic.get(key);
    if (!stat) return;
    appHostTraffic.delete(key);
    if (stat.timer) clearTimeout(stat.timer);
    // app-host 是官方新版 renderer 的 MessagePort RPC 通道。这里做聚合日志，避免逐帧日志影响冷加载。
    diagnosticLog("ws-hub", "app_host_traffic_summary", {
      bytes: stat.bytes,
      clientId: shortId(stat.clientId),
      count: stat.count,
      direction: stat.direction,
      maxBytes: stat.maxBytes,
      maxSendCallbackMs: stat.maxSendCallbackMs,
      portId: shortId(stat.portId),
      remoteAddress: stat.remoteAddress,
      windowMs: Date.now() - stat.startedAtMs,
    });
  }

  function recordAppHostTraffic(socket, direction, portId, dataBytes) {
    if (!WS_DEBUG_ENABLED) return;
    const clientId = socketClientId(socket);
    const key = appHostTrafficKey(clientId, portId, direction);
    let stat = appHostTraffic.get(key);
    if (!stat) {
      stat = {
        bytes: 0,
        clientId,
        count: 0,
        direction,
        maxBytes: 0,
        maxSendCallbackMs: 0,
        portId,
        remoteAddress: socketRemoteAddress(socket),
        startedAtMs: Date.now(),
        timer: null,
      };
      // 聚合窗口结束后只打一条 summary，避免 app-host 高频字符串帧把会话加载日志刷爆。
      stat.timer = setTimeout(() => flushAppHostTraffic(key), APP_HOST_TRAFFIC_FLUSH_MS);
      if (stat.timer && typeof stat.timer.unref === "function") stat.timer.unref();
      appHostTraffic.set(key, stat);
    }
    stat.bytes += dataBytes;
    stat.count += 1;
    stat.maxBytes = Math.max(stat.maxBytes, dataBytes);
  }

  function recordAppHostSendCallback(socket, portId, sendCallbackMs) {
    if (!WS_DEBUG_ENABLED) return;
    const key = appHostTrafficKey(socketClientId(socket), portId, "official-to-browser");
    const stat = appHostTraffic.get(key);
    if (stat) stat.maxSendCallbackMs = Math.max(stat.maxSendCallbackMs, sendCallbackMs);
  }

  function flushAppHostTrafficForClient(clientId) {
    if (!WS_DEBUG_ENABLED) return;
    // 页面关闭时把该 client 的聚合窗口立即写出，方便复现后马上看完整统计。
    for (const [key, stat] of appHostTraffic.entries()) {
      if (stat.clientId === clientId) flushAppHostTraffic(key);
    }
  }

  function appHostPayloadInfo(payload) {
    // app-host-port-message.data 是官方 RPC 字符串；只统计长度，不解析内容，避免耦合官方协议细节。
    if (!payload || payload.type !== "app-host-port-message" || typeof payload.data !== "string") return null;
    return {
      bytes: byteLength(payload.data),
      portId: typeof payload.portId === "string" ? payload.portId : "",
    };
  }

  function wsSendDiagnosticBase(socket, payload, route, messageBytes, stringifyMs, bufferedBefore, bufferedAfter, options = {}) {
    // diagnosticSummary 来自 official-runtime 的原始请求摘要，可把大回包反查到 requestMethod/url。
    return {
      ...(options.diagnosticSummary && typeof options.diagnosticSummary === "object" ? options.diagnosticSummary : {}),
      ...wsPayloadSummary(payload),
      bufferedAfter,
      bufferedBefore,
      bytes: messageBytes,
      clientId: shortId(socketClientId(socket)),
      remoteAddress: socketRemoteAddress(socket),
      route,
      stringifyMs,
    };
  }

  function shouldLogWsSend(messageBytes, stringifyMs, bufferedBefore, bufferedAfter) {
    if (!WS_DEBUG_ENABLED) return false;
    // 只在消息大、JSON 序列化慢或 socket 已经有明显积压时打慢日志。
    return (
      messageBytes >= WS_LARGE_MESSAGE_BYTES ||
      stringifyMs >= WS_STRINGIFY_SLOW_MS ||
      bufferedBefore >= WS_BUFFERED_LOG_BYTES ||
      bufferedAfter >= WS_BUFFERED_LOG_BYTES
    );
  }

  function sendPrepared(socket, payload, message, options = {}) {
    /**
     * 所有下行 WS 消息最终走这里：
     * - 默认路径只做一次 socket.send，避免为了诊断增加常态开销。
     * - OPENCODEX_DEBUG_WS=1 时才读取 bufferedAmount、统计字节数、挂 send callback。
     */
    const route = options.route || "send";
    const stringifyMs = options.stringifyMs || 0;
    const messageBytes = WS_DEBUG_ENABLED ? byteLength(message) : 0;
    const appHostInfo = WS_DEBUG_ENABLED ? appHostPayloadInfo(payload) : null;
    const bufferedBefore = WS_DEBUG_ENABLED ? Number(socket.bufferedAmount || 0) : 0;
    let bufferedAfter = bufferedBefore;
    const sendStartedAtMs = WS_DEBUG_ENABLED ? Date.now() : 0;
    const needCallback =
      WS_DEBUG_ENABLED &&
      (shouldLogWsSend(messageBytes, stringifyMs, bufferedBefore, bufferedAfter) ||
        (appHostInfo && appHostInfo.bytes >= APP_HOST_LARGE_FRAME_BYTES));
    try {
      if (appHostInfo) recordAppHostTraffic(socket, "official-to-browser", appHostInfo.portId, appHostInfo.bytes);
      const onSent = (error) => {
        const sendCallbackMs = Date.now() - sendStartedAtMs;
        const doneBuffered = Number(socket.bufferedAmount || 0);
        if (appHostInfo) recordAppHostSendCallback(socket, appHostInfo.portId, sendCallbackMs);
        if (error) {
          diagnosticWarn("ws-hub", "send_callback_failed", {
            ...wsSendDiagnosticBase(socket, payload, route, messageBytes, stringifyMs, bufferedBefore, doneBuffered, options),
            error: error instanceof Error ? error.message : String(error),
            sendCallbackMs,
          });
          return;
        }
        if (
          messageBytes >= WS_LARGE_MESSAGE_BYTES ||
          sendCallbackMs >= WS_SEND_SLOW_MS ||
          stringifyMs >= WS_STRINGIFY_SLOW_MS ||
          bufferedBefore >= WS_BUFFERED_LOG_BYTES ||
          doneBuffered >= WS_BUFFERED_LOG_BYTES
        ) {
          diagnosticLog("ws-hub", "send_large_or_slow", {
            ...wsSendDiagnosticBase(socket, payload, route, messageBytes, stringifyMs, bufferedBefore, doneBuffered, options),
            sendCallbackMs,
          });
        }
      };
      if (needCallback) {
        socket.send(message, onSent);
      } else {
        socket.send(message);
      }
      bufferedAfter = WS_DEBUG_ENABLED ? Number(socket.bufferedAmount || 0) : 0;
      if (shouldLogWsSend(messageBytes, stringifyMs, bufferedBefore, bufferedAfter) && !needCallback) {
        diagnosticLog("ws-hub", "send_large_or_buffered", {
          ...wsSendDiagnosticBase(socket, payload, route, messageBytes, stringifyMs, bufferedBefore, bufferedAfter, options),
        });
      }
      return true;
    } catch (error) {
      diagnosticWarn("ws-hub", "send_failed", {
        ...wsSendDiagnosticBase(socket, payload, route, messageBytes, stringifyMs, bufferedBefore, bufferedAfter, options),
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  function stringifyForWs(payload) {
    // JSON.stringify 是必须成本；只有 debug 模式才额外记录它用了多久。
    if (!WS_DEBUG_ENABLED) return { message: JSON.stringify(payload), stringifyMs: 0 };
    const startedAtMs = Date.now();
    const message = JSON.stringify(payload);
    return { message, stringifyMs: Date.now() - startedAtMs };
  }

  function safeSend(socket, payload, options = {}) {
    // 所有 WebSocket 下行都走这个出口，便于统一压日志和记录投递失败。
    if (!socket || socket.readyState !== socket.OPEN) return false;
    try {
      const { message, stringifyMs } = stringifyForWs(payload);
      const sent = sendPrepared(socket, payload, message, { ...options, route: options.route || "send", stringifyMs });
      if (DEBUG_LOGS && sent && !options.suppressDiagnostic) {
        // 单点发送是 WS 下行的正常成功路径，默认不打印，避免会话流式事件把日志撑满。
        diagnosticLog("ws-hub", "send", wsPayloadSummary(payload));
      }
      return sent;
    } catch (error) {
      diagnosticWarn("ws-hub", "send_failed", {
        ...wsPayloadSummary(payload),
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  function appHostRelaysForSocket(ws) {
    // app-host MessagePort 的生命周期必须跟浏览器页面一致，不能做成跨页面共享的全局状态。
    if (!ws.__codexAppHostRelays) ws.__codexAppHostRelays = new Map();
    return ws.__codexAppHostRelays;
  }

  function closeAppHostRelays(ws, reason) {
    const relays = ws.__codexAppHostRelays;
    if (!relays || relays.size === 0) return;
    // 页面断开时主动关闭官方端口，否则官方 app-host 服务会保留无主连接。
    for (const [portId, relay] of relays.entries()) {
      relays.delete(portId);
      try {
        relay.close(reason);
      } catch {}
    }
  }

  function removeClient(ws) {
    flushAppHostTrafficForClient(socketClientId(ws));
    closeAppHostRelays(ws, "client_disconnected");
    clients.delete(ws);
    if (ws.__codexWebClientId && clientsById.get(ws.__codexWebClientId) === ws) {
      clientsById.delete(ws.__codexWebClientId);
    }
  }

  function logAuthRejected(url) {
    const now = Date.now();
    if (now - lastAuthRejectLogAtMs < 10_000) {
      suppressedAuthRejectCount += 1;
      return;
    }
    // 未登录旧页面可能持续重连 WS，这里节流汇总，避免噪声盖住真实 IPC 慢链路。
    diagnosticWarn("ws-hub", "upgrade_rejected_auth", {
      suppressedCount: suppressedAuthRejectCount,
      url,
    });
    suppressedAuthRejectCount = 0;
    lastAuthRejectLogAtMs = now;
  }

  /** 向所有在线浏览器广播 gateway 消息。 */
  function broadcast(payload, options = {}) {
    const { message, stringifyMs } = stringifyForWs(payload);
    let sent = 0;
    for (const socket of clients) {
      if (socket.readyState !== socket.OPEN) continue;
      if (sendPrepared(socket, payload, message, { ...options, route: "broadcast", stringifyMs })) sent += 1;
    }
    if (DEBUG_LOGS && !options.suppressDiagnostic) {
      // 广播类消息在会话同步时非常高频，默认只转发不打印；需要排查 WS 路由时再打开 CODEX_WEB_DEBUG。
      diagnosticLog("ws-hub", "broadcast", {
        ...wsPayloadSummary(payload),
        clientCount: clients.size,
        sent,
      });
    }
    return sent;
  }

  /** 向指定 clientId 的浏览器发送 gateway 消息。 */
  function sendTo(clientId, payload, options = {}) {
    const socket = clientsById.get(clientId);
    if (!socket || socket.readyState !== socket.OPEN) {
      diagnosticWarn("ws-hub", "send_to_missing_client", {
        ...wsPayloadSummary(payload),
        clientId: shortId(clientId),
        readyState: socket ? socket.readyState : "missing",
      });
      return false;
    }
    try {
      const { message, stringifyMs } = stringifyForWs(payload);
      const sent = sendPrepared(socket, payload, message, { ...options, route: "send_to", stringifyMs });
      if (DEBUG_LOGS && sent && !options.suppressDiagnostic) {
        // 定向发送成功只说明路由命中，排查路由时有用，日常运行不需要持续记录。
        diagnosticLog("ws-hub", "send_to", {
          ...wsPayloadSummary(payload),
          clientId: shortId(clientId),
        });
      }
      return sent;
    } catch (error) {
      diagnosticWarn("ws-hub", "send_to_failed", {
        ...wsPayloadSummary(payload),
        clientId: shortId(clientId),
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  function hasClient(clientId) {
    const socket = clientsById.get(clientId);
    return !!socket && socket.readyState === socket.OPEN;
  }

  function normalizedWsClientId(ws, message) {
    // 控制帧允许带 clientId，但最终必须和 hello 注册到 socket 上的 clientId 一致。
    const messageClientId = message && typeof message.clientId === "string" ? message.clientId : "";
    const socketClientId = ws.__codexWebClientId || "";
    return messageClientId || socketClientId;
  }

  function validAppHostPortId(value) {
    // portId 只作为本页多条 MessagePort 的路由键，限制长度即可，不引入额外协议含义。
    return typeof value === "string" && value.length > 0 && value.length <= 160;
  }

  function handleAppHostConnect(ws, req, message) {
    // 浏览器发起 connect 后，gateway 才创建 Electron MessageChannelMain 并交给官方 listener。
    const clientId = normalizedWsClientId(ws, message);
    const portId = message && typeof message.portId === "string" ? message.portId : "";
    if (!clientId || ws.__codexWebClientId !== clientId || !validAppHostPortId(portId)) {
      diagnosticWarn("ws-hub", "app_host_connect_rejected", {
        clientId: shortId(clientId),
        mappedClientId: shortId(ws.__codexWebClientId || ""),
        portId: shortId(portId),
      });
      return true;
    }
    if (typeof createAppHostRelay !== "function") {
      diagnosticWarn("ws-hub", "app_host_connect_unavailable", {
        clientId: shortId(clientId),
        portId: shortId(portId),
      });
      safeSend(ws, { type: "app-host-port-error", portId, error: "App host relay is unavailable" });
      return true;
    }

    const relays = appHostRelaysForSocket(ws);
    const existing = relays.get(portId);
    if (existing) {
      // 同一个页面重复使用 portId 时以后到者为准，先关闭旧 relay 避免双写。
      try {
        existing.close("replaced");
      } catch {}
      relays.delete(portId);
    }

    try {
      const relay = createAppHostRelay({
        clientId,
        portId,
        remoteAddress: req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : "",
        onClose(reason) {
          if (relays.get(portId) === relay) relays.delete(portId);
          safeSend(ws, { type: "app-host-port-close", portId, reason }, { suppressDiagnostic: true });
          if (DEBUG_LOGS) {
            diagnosticLog("ws-hub", "app_host_closed", {
              clientId: shortId(clientId),
              portId: shortId(portId),
              reason,
            });
          }
        },
        onError(error) {
          safeSend(
            ws,
            {
              type: "app-host-port-error",
              portId,
              error: error instanceof Error ? error.message : String(error),
            },
            { suppressDiagnostic: true }
          );
        },
        onMessage(data) {
          // app-host RPC 是高频字符串流，只转发不逐条写日志，避免首屏日志刷屏和拖慢关键链路。
          safeSend(ws, { type: "app-host-port-message", portId, data }, { suppressDiagnostic: true });
        },
      });
      relays.set(portId, relay);
      safeSend(ws, { type: "app-host-port-connected", portId }, { suppressDiagnostic: true });
      if (DEBUG_LOGS) {
        // app-host 端口连接/关闭是前端组件生命周期的一部分，默认只保留失败日志。
        diagnosticLog("ws-hub", "app_host_connect", {
          clientId: shortId(clientId),
          portId: shortId(portId),
        });
      }
    } catch (error) {
      diagnosticWarn("ws-hub", "app_host_connect_failed", {
        clientId: shortId(clientId),
        error: error instanceof Error ? error.message : String(error),
        portId: shortId(portId),
      });
      safeSend(
        ws,
        {
          type: "app-host-port-error",
          portId,
          error: error instanceof Error ? error.message : String(error),
        },
        { suppressDiagnostic: true }
      );
    }
    return true;
  }

  function handleAppHostPortMessage(ws, message) {
    // 浏览器端 MessagePort 的后续字符串帧都从这里回写到官方 Electron port。
    const clientId = normalizedWsClientId(ws, message);
    const portId = message && typeof message.portId === "string" ? message.portId : "";
    const data = message ? message.data : undefined;
    if (!clientId || ws.__codexWebClientId !== clientId || !validAppHostPortId(portId)) {
      diagnosticWarn("ws-hub", "app_host_message_rejected", {
        clientId: shortId(clientId),
        mappedClientId: shortId(ws.__codexWebClientId || ""),
        portId: shortId(portId),
      });
      return true;
    }
    if (!(data == null || typeof data === "string")) {
      // 官方 app-host 当前只使用字符串 JSON-RPC 帧；非字符串直接拒绝，避免污染官方端口。
      diagnosticWarn("ws-hub", "app_host_non_string_message_rejected", {
        clientId: shortId(clientId),
        payloadType: typeof data,
        portId: shortId(portId),
      });
      return true;
    }
    const relays = appHostRelaysForSocket(ws);
    const relay = relays.get(portId);
    if (!relay) {
      diagnosticWarn("ws-hub", "app_host_message_missing_relay", {
        clientId: shortId(clientId),
        portId: shortId(portId),
      });
      return true;
    }
    if (WS_DEBUG_ENABLED && typeof data === "string") recordAppHostTraffic(ws, "browser-to-official", portId, byteLength(data));
    relay.postMessage(data);
    // null 是关闭信号，发送给官方后即可从索引移除，后续 close 回调再到达也不会重复处理。
    if (data == null && relays.get(portId) === relay) relays.delete(portId);
    return true;
  }

  function handleWsControlMessage(ws, req, message) {
    if (!message || typeof message !== "object") return false;
    if (message.type === "opencodex:notification-event") {
      // 通知 click/close 只从已认证 WS 回传；hub 不理解官方通知语义，直接交回 runtime 的 fake Notification。
      return typeof handleNotificationEvent === "function" ? handleNotificationEvent(message, ws, req) : true;
    }
    if (message.type === "app-host-connect") return handleAppHostConnect(ws, req, message);
    if (message.type === "app-host-port-message") return handleAppHostPortMessage(ws, message);
    return false;
  }

  // 只接受 /ws 升级，并校验 gateway 访问 token。浏览器 WebSocket 不能自定义 header，所以允许 query/cookie。
  server.on("upgrade", (req, socket, head) => {
    // 先在 HTTP upgrade 阶段完成路径和 auth 校验，失败时不创建 WebSocket 对象。
    const url = new URL(req.url || "", `http://${req.headers.host || "localhost"}`);
    if (url.pathname !== "/ws") {
      diagnosticWarn("ws-hub", "upgrade_rejected_path", { url: req.url || "" });
      return socket.destroy();
    }
    if (!isAuthed(req, url)) {
      logAuthRejected(url.pathname);
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.__codexRemoteAddress = req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : "";
      clients.add(ws);
      if (DEBUG_LOGS) {
        // WS 握手/关闭属于页面生命周期噪声，默认不写入常规日志；认证失败和异常仍会保留。
        diagnosticLog("ws-hub", "connected", {
          clientCount: clients.size,
          remoteAddress: socketRemoteAddress(ws),
        });
      }
      ws.on("message", (raw) => {
        try {
          const message = JSON.parse(String(raw));
          const clientId = message && typeof message.clientId === "string" ? message.clientId : "";
          // hello 是浏览器接入 IPC 的握手消息，拿到 clientId 后才能定向投递事件。
          if (message && message.type === "hello" && clientId) {
            const previousClientId = ws.__codexWebClientId;
            if (previousClientId && previousClientId !== clientId && clientsById.get(previousClientId) === ws) {
              clientsById.delete(previousClientId);
            }
            // 后来重复 hello 时直接覆盖映射，保证同一 clientId 指向最新连接。
            ws.__codexWebClientId = clientId;
            clientsById.set(clientId, ws);
            if (DEBUG_LOGS) {
              diagnosticLog("ws-hub", "hello", {
                clientId: shortId(clientId),
                clientCount: clients.size,
                mappedClientCount: clientsById.size,
                remoteAddress: socketRemoteAddress(ws),
              });
            }
            try {
              // ack 明确告诉浏览器：clientId 已经进入路由表，可以开始发会产生异步回包的官方 IPC。
              ws.send(JSON.stringify({ type: "hello-ack", clientId }));
              if (DEBUG_LOGS) diagnosticLog("ws-hub", "hello_ack", { clientId: shortId(clientId) });
            } catch (error) {
              diagnosticWarn("ws-hub", "hello_ack_failed", {
                clientId: shortId(clientId),
                error: error instanceof Error ? error.message : String(error),
              });
            }
            return;
          }
          if (handleWsControlMessage(ws, req, message)) return;
        } catch (error) {
          diagnosticWarn("ws-hub", "message_parse_failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
      ws.on("close", () => {
        // close/error 都要从两个索引里删除，避免后续 sendTo 命中过期 socket。
        const closedClientId = ws.__codexWebClientId || "";
        removeClient(ws);
        if (DEBUG_LOGS) {
          diagnosticLog("ws-hub", "closed", {
            clientId: shortId(closedClientId),
            clientCount: clients.size,
            mappedClientCount: clientsById.size,
          });
        }
      });
      ws.on("error", (error) => {
        // error 事件不一定随后触发 close，这里主动做一次相同清理。
        const erroredClientId = ws.__codexWebClientId || "";
        removeClient(ws);
        diagnosticWarn("ws-hub", "error", {
          clientId: shortId(erroredClientId),
          clientCount: clients.size,
          error: error instanceof Error ? error.message : String(error),
          mappedClientCount: clientsById.size,
        });
      });
      wss.emit("connection", ws, req);
    });
  });

  return { broadcast, clients, sendTo, hasClient };
}

module.exports = { createWsHub };
