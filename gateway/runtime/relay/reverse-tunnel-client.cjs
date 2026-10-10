// reverse-tunnel-client.cjs
// OpenCodex 内嵌的反向隧道客户端：启动后主动出站连 VPS RelayServer（WebSocket），
// 把本机 gateway 的整个 HTTP+WS 能力反推到 VPS。这样 PC 端无需任何独立穿透工具（frpc 等），
// 也不需要在 PC 侧开任何入站端口——连接方向是出站，绝大多数 NAT/防火墙默认放行。
//
// 多路复用协议（控制 WS 上的 JSON 帧）：
//   register / register-ok / register-reject
//   open{id,method,path,headers}            -> VPS 新 HTTP 流（浏览器请求到达）
//   ws-open{id,path,headers}                -> VPS 新 WebSocket 流（浏览器 /ws 升级）
//   head{id,status,headers}                 -> PC 回复 HTTP 响应头
//   data{id,chunk(base64)}                  -> 任意方向的正文/消息字节
//   end{id}                                 -> HTTP 流结束
//   ws-close{id,code}                       -> WebSocket 关闭
//   ping / pong                             -> 心跳
const WebSocket = require("ws");
const http = require("http");
const crypto = require("crypto");
const { readRelayConfig } = require("./relay-config.cjs");

const b64 = (buf) => Buffer.from(buf).toString("base64");
const unb64 = (s) => Buffer.from(s, "base64");

function gatewayAuthCookie(value) {
  // 设备端只接收 Gateway 登录 Cookie，避免把中继管理员会话转交给本机服务。
  const cookies = String(value || "").split(";");
  for (const part of cookies) {
    const cookie = part.trim();
    if (cookie.startsWith("codex_web_auth=")) return cookie;
  }
  return "";
}

function resHeaders(res) {
  const out = {};
  for (const [k, v] of Object.entries(res.headers || {})) out[k] = v;
  return out;
}

function startReverseTunnel({ diagnosticLog = () => {}, diagnosticWarn = () => {} } = {}) {
  const cfg = readRelayConfig();
  if (!cfg.enabled || !cfg.url) {
    diagnosticLog("relay", "disabled", { reason: !cfg.enabled ? "OCX_RELAY_ENABLED!=1" : "OCX_RELAY_URL empty" });
    return { started: false, reason: "disabled" };
  }

  let ws = null;
  let closedByServer = false;
  let reconnectDelay = 1000;
  const MAX_DELAY = 30_000;
  const streams = new Map(); // id -> { role:'http'|'ws', req?, localWs? }
  let pingTimer = null;

  const send = (obj) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(obj));
        return true;
      } catch {
        return false;
      }
    }
    return false;
  };

  const genId = () => crypto.randomBytes(8).toString("hex");

  function openHttpStream(msg) {
    const headers = Object.assign({}, msg.headers || {});
    // 认证必须来自当前浏览器，不能用设备密码换出的令牌替所有中继用户登录。
    const authCookie = gatewayAuthCookie(headers.cookie);
    if (authCookie) headers.cookie = authCookie;
    else delete headers.cookie;
    if (String(msg.path || "/").split("?", 1)[0] === "/codex-web-config.js") {
      // 服务器会按 UTF-8 改写该脚本的 WebSocket 地址；压缩正文经文本改写会损坏，因此要求设备端返回明文。
      headers["accept-encoding"] = "identity";
    }
    let req;
    try {
      req = http.request(
        {
          host: cfg.localHost,
          port: cfg.localPort,
          method: msg.method || "GET",
          path: msg.path || "/",
          headers,
        },
        (res) => {
          send({ t: "head", id: msg.id, status: res.statusCode, headers: resHeaders(res) });
          res.on("data", (c) => send({ t: "data", id: msg.id, chunk: b64(c) }));
          res.on("end", () => send({ t: "end", id: msg.id }));
        }
      );
    } catch (e) {
      send({ t: "head", id: msg.id, status: 502, headers: { "content-type": "text/plain" }, error: String(e) });
      return;
    }
    req.on("error", (e) => {
      send({ t: "head", id: msg.id, status: 502, headers: { "content-type": "text/plain" }, error: String(e) });
      send({ t: "end", id: msg.id });
    });
    req.setTimeout(120_000, () => req.destroy());
    streams.set(msg.id, { role: "http", req });
  }

  function openWsStream(msg) {
    const url = `ws://${cfg.localHost}:${cfg.localPort}/ws`;
    // WebSocket 沿用浏览器登录态，避免 HTTP 已拦截但实时连接仍被设备级令牌放行。
    const authCookie = gatewayAuthCookie(msg.headers && msg.headers.cookie);
    const wsOptions = authCookie ? { headers: { cookie: authCookie } } : {};
    // 浏览器可能在 PC 本地 WS 尚未连上时就把首帧发过来，这里先登记流并缓冲，待本地 WS 打开后再 flush。
    const stream = { role: "ws", localWs: null, pending: [], opened: false };
    streams.set(msg.id, stream);
    let localWs;
    try {
      localWs = new WebSocket(url, wsOptions);
    } catch (e) {
      send({ t: "ws-close", id: msg.id, code: 1011 });
      streams.delete(msg.id);
      return;
    }
    stream.localWs = localWs;
    localWs.on("open", () => {
      stream.opened = true;
      for (const p of stream.pending) {
        try {
          localWs.send(p.buf, { binary: !!p.bin });
        } catch {}
      }
      stream.pending = [];
    });
    localWs.on("message", (data, isBinary) => {
      // 保留 WS 帧类型：文本帧必须回传文本帧（浏览器端 JSON.parse(event.data) 依赖 string），
      // 否则官方 UI 收到 Blob/ArrayBuffer 直接解析失败——工作区/主题等实时数据全挂。
      send({ t: "data", id: msg.id, chunk: b64(data), bin: !!isBinary });
    });
    localWs.on("close", (code) => {
      send({ t: "ws-close", id: msg.id, code: code || 1000 });
      streams.delete(msg.id);
    });
    localWs.on("error", () => {
      try {
        localWs.close();
      } catch {}
    });
  }

  function handleData(msg) {
    const s = streams.get(msg.id);
    if (!s) return;
    const buf = unb64(msg.chunk || "");
    if (s.role === "http" && s.req) {
      try {
        s.req.write(buf);
      } catch {}
    } else if (s.role === "ws") {
      // 去程同样保留帧类型：浏览器发来的文本帧必须以文本帧交给本地 gateway。
      if (s.opened && s.localWs && s.localWs.readyState === WebSocket.OPEN) {
        try {
          s.localWs.send(buf, { binary: !!msg.bin });
        } catch {}
      } else {
        s.pending.push({ buf, bin: !!msg.bin });
      }
    }
  }

  function endStream(id) {
    const s = streams.get(id);
    if (!s) return;
    if (s.role === "http" && s.req) {
      try {
        s.req.end();
      } catch {}
    }
    streams.delete(id);
  }

  function closeWsStream(msg) {
    const s = streams.get(msg.id);
    if (s && s.role === "ws" && s.localWs) {
      try {
        s.localWs.close(msg.code || 1000);
      } catch {}
    }
    streams.delete(msg.id);
  }

  function closeAllStreams() {
    for (const [, s] of streams) {
      try {
        if (s.req) s.req.destroy();
        if (s.localWs) s.localWs.close();
      } catch {}
    }
    streams.clear();
  }

  async function connect() {
    // 隧道只建立传输连接，Gateway 登录态由每个浏览器会话独立携带。
    const sep = cfg.url.includes("?") ? "&" : "?";
    const auth = `${sep}device=${encodeURIComponent(cfg.deviceId)}&path=${encodeURIComponent(cfg.accessPath)}&secret=${encodeURIComponent(cfg.secret)}`;
    let target = cfg.url;
    // 允许 env 里只写 wss://host:port 不带路径；统一挂到 /openCodeProxy
    if (!/\/openCodeProxy\b/.test(target)) target = target.replace(/\/?$/, "/openCodeProxy");
    const fullUrl = target + auth;
    diagnosticLog("relay", "connecting", { url: target, deviceId: cfg.deviceId });
    try {
      // HTTPS 使用默认的证书验证，不再提供跳过验证的兼容开关。
      ws = new WebSocket(fullUrl);
    } catch (e) {
      diagnosticWarn("relay", "connect_failed", { error: String(e) });
      scheduleReconnect();
      return;
    }
    ws.on("open", () => {
      reconnectDelay = 1000;
      send({ t: "register", deviceId: cfg.deviceId, name: cfg.deviceName, secret: cfg.secret });
      pingTimer = setInterval(() => send({ t: "ping" }), 25_000);
      if (pingTimer && typeof pingTimer.unref === "function") pingTimer.unref();
      diagnosticLog("relay", "connected", { deviceId: cfg.deviceId });
    });
    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      switch (msg.t) {
        case "register-ok":
          diagnosticLog("relay", "registered", { deviceId: cfg.deviceId });
          break;
        case "register-reject":
          diagnosticWarn("relay", "register_rejected", { reason: msg.reason || "unknown" });
          closedByServer = true;
          try {
            ws.close();
          } catch {}
          break;
        case "open":
          openHttpStream(msg);
          break;
        case "ws-open":
          openWsStream(msg);
          break;
        case "data":
          handleData(msg);
          break;
        case "end":
          endStream(msg.id);
          break;
        case "ws-close":
          closeWsStream(msg);
          break;
        case "ping":
          send({ t: "pong" });
          break;
        default:
          break;
      }
    });
    ws.on("close", () => onClose());
    ws.on("error", (e) => {
      // 必须记录：TLS 证书校验失败/握手被拒都会只触发 error + close，
      // 不打日志的话只能看到 connecting -> disconnected，无从定位。
      diagnosticWarn("relay", "socket_error", {
        error: String((e && e.message) || e),
      });
      try {
        ws.close();
      } catch {}
    });
  }

  function onClose() {
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = null;
    closeAllStreams();
    if (closedByServer) {
      diagnosticWarn("relay", "stopped_by_server", { deviceId: cfg.deviceId });
      return;
    }
    diagnosticWarn("relay", "disconnected", { deviceId: cfg.deviceId, retryMs: reconnectDelay });
    scheduleReconnect();
  }

  function scheduleReconnect() {
    const delay = reconnectDelay;
    reconnectDelay = Math.min(MAX_DELAY, reconnectDelay * 2);
    const t = setTimeout(() => {
      connect().catch(() => scheduleReconnect());
    }, delay);
    if (t && typeof t.unref === "function") t.unref();
  }

  connect().catch((e) => diagnosticWarn("relay", "init_failed", { error: String(e) }));

  return {
    started: true,
    stop() {
      closedByServer = true;
      try {
        ws && ws.close();
      } catch {}
      if (pingTimer) clearInterval(pingTimer);
      closeAllStreams();
    },
  };
}

module.exports = { startReverseTunnel };
