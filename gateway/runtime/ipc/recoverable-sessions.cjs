const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const COOKIE = "opencodex_browser";
const positive = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
};

/** 页面身份、连接绑定和传输确认独立于官方 RPC；不解析或重新执行聊天请求。 */
function createRecoverableSessions({ runtimeDir, isAuthed, deliver, dispose, log = () => {} }) {
  fs.mkdirSync(runtimeDir, { recursive: true });
  const keyPath = path.join(runtimeDir, "browser-identity.key");
  try { fs.writeFileSync(keyPath, crypto.randomBytes(32), { flag: "wx", mode: 0o600 }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  fs.chmodSync(keyPath, 0o600);
  const key = fs.readFileSync(keyPath);
  if (key.length !== 32) throw new Error("Invalid browser identity signing key");
  const sessions = new Map();
  const ttl = positive("OPENCODEX_RPC_RETENTION_MS", 43200000);
  const limitBytes = positive("OPENCODEX_RPC_BUFFER_BYTES", 64 * 1024 * 1024);
  const limitFrames = positive("OPENCODEX_RPC_BUFFER_FRAMES", 10000);
  const totalLimit = positive("OPENCODEX_RPC_TOTAL_BUFFER_BYTES", 256 * 1024 * 1024);
  const maxSessions = positive("OPENCODEX_RPC_MAX_SESSIONS", 128);
  let totalBytes = 0;
  const mac = (id) => crypto.createHmac("sha256", key).update(id).digest("hex");
  function browser(req) {
    const value = String(req.headers.cookie || "").split(";").map(s => s.trim()).find(s => s.startsWith(COOKIE + "="))?.slice(COOKIE.length + 1) || "";
    const [id, signature] = value.split(".");
    if (!/^[a-f0-9]{64}$/.test(id || "") || !/^[a-f0-9]{64}$/.test(signature || "")) return null;
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(mac(id))) ? id : null;
  }
  function write(socket, message) {
    if (!socket || socket.readyState !== 1) return false;
    try {
      if (socket.bufferedAmount > 64 * 1024 * 1024) { socket.terminate?.(); return false; }
      socket.send(JSON.stringify(message)); return true;
    } catch { return false; }
  }
  function expire(session, reason) {
    if (session.closed) return;
    session.closed = true;
    clearTimeout(session.timer); clearTimeout(session.ackTimer);
    if (sessions.get(session.browserId) === session) sessions.delete(session.browserId);
    totalBytes -= session.bytes; session.bytes = 0; session.out.clear();
    write(session.socket, { type: "rpc-reset", reason });
    try { session.socket?.close(4001, reason); } catch {}
    session.facade.readyState = 3;
    dispose(session.facade);
    log("rpc_session_closed", { reason, pageId: session.id.slice(0, 8) });
  }
  function timer(session, ms, reason) {
    clearTimeout(session.timer);
    session.timer = setTimeout(() => expire(session, reason), ms);
    session.timer.unref?.();
  }
  function ack(session, value) {
    if (!Number.isSafeInteger(value) || value < 0 || value > session.sent) throw new Error("Invalid RPC acknowledgement");
    session.acked = Math.max(session.acked, value);
    for (const [seq, frame] of session.out) {
      if (seq > value) break;
      session.bytes -= frame.bytes; totalBytes -= frame.bytes; session.out.delete(seq);
    }
  }
  function output(session, payload) {
    if (session.closed) throw new Error("RPC session closed");
    const seq = ++session.sent;
    const wire = { type: "rpc-frame", generation: session.generation, seq, ack: session.received, payload };
    const bytes = Buffer.byteLength(JSON.stringify(wire));
    while (totalBytes + bytes > totalLimit) {
      const oldest = [...sessions.values()].filter(s => s !== session && s.detachedAt).sort((a,b) => a.detachedAt - b.detachedAt)[0];
      if (!oldest) break;
      expire(oldest, "overflow");
    }
    if (session.bytes + bytes > limitBytes || session.out.size >= limitFrames || totalBytes + bytes > totalLimit) {
      expire(session, "overflow"); throw new Error("RPC recovery buffer exceeded");
    }
    session.out.set(seq, { wire, bytes }); session.bytes += bytes; totalBytes += bytes;
    clearTimeout(session.ackTimer); session.ackTimer = null;
    write(session.socket, wire);
  }
  function initialize(req, res) {
    const reply = (status, value, headers = {}) => { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers }); res.end(JSON.stringify(value)); };
    if (req.method !== "POST") return reply(405, { error: "Method not allowed" });
    if (!isAuthed(req)) return reply(401, { error: "Authentication required" });
    // 初始化会接管旧页面，禁止跨站请求触发接管。
    if (req.headers["sec-fetch-site"] === "cross-site") return reply(403, { error: "Cross-site request rejected" });
    if (req.headers.origin) {
      try { if (new URL(req.headers.origin).host !== req.headers.host) return reply(403, { error: "Origin mismatch" }); }
      catch { return reply(403, { error: "Invalid origin" }); }
    }
    const browserId = browser(req) || crypto.randomBytes(32).toString("hex");
    const previous = sessions.get(browserId);
    if (!previous && sessions.size >= maxSessions) return reply(503, { error: "RPC session limit reached" });
    const session = { browserId, id: crypto.randomUUID(), generation: crypto.randomUUID(), secret: crypto.randomBytes(32).toString("hex"), socket: null, out: new Map(), bytes: 0, sent: 0, received: 0, acked: 0, closed: false, detachedAt: 0 };
    // 稳定的端口宿主不随 WebSocket 替换；离线下行进入有界恢复队列。
    session.facade = { __recoverable: true, OPEN: 1, readyState: 1, bufferedAmount: 0,
      send(message, options, callback) { const payload = JSON.parse(message); if (payload.type === "app-host-port-error") { expire(session, "delivery_failed"); throw new Error("RPC port failed"); } output(session, payload); (typeof options === "function" ? options : callback)?.(); },
      close() { expire(session, "closed"); }, terminate() { expire(session, "overflow"); },
    };
    if (previous) expire(previous, "superseded");
    sessions.set(browserId, session); timer(session, 60000, "unclaimed");
    const secure = req.socket.encrypted || String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https";
    reply(200, { version: 1, pageId: session.id, generation: session.generation, credential: session.secret, retentionMs: ttl }, {
      "Set-Cookie": `${COOKIE}=${browserId}.${mac(browserId)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000${secure ? "; Secure" : ""}`,
    });
    log("rpc_session_created", { pageId: session.id.slice(0, 8) });
  }
  function attach(socket, req, hello) {
    const session = sessions.get(browser(req));
    if (!session || session.id !== hello.pageId || session.generation !== hello.generation || session.secret !== hello.credential) {
      write(socket, { type: "rpc-reset", reason: session ? "superseded" : "expired" }); socket.close(4001, "session unavailable"); return false;
    }
    if (session.clientId && session.clientId !== hello.clientId) { socket.close(4001, "client mismatch"); return false; }
    try { ack(session, hello.ack); } catch { expire(session, "sequence_error"); return false; }
    const old = session.socket;
    session.socket = socket; socket.__rpcSession = session;
    session.clientId = hello.clientId; session.facade.__codexWebClientId = hello.clientId;
    session.facade.__codexRemoteAddress = req.socket.remoteAddress || "";
    session.detachedAt = 0; clearTimeout(session.timer);
    if (old && old !== socket) old.close(4000, "connection replaced");
    log("rpc_session_attached", { pageId: session.id.slice(0, 8), pending: session.out.size });
    return true;
  }
  function ready(socket) {
    const s = socket.__rpcSession;
    write(socket, { type: "rpc-ready", generation: s.generation, ack: s.received });
    for (const { wire } of s.out.values()) write(socket, { ...wire, ack: s.received });
  }
  function message(socket, req, data) {
    const s = socket.__rpcSession;
    if (!s || s.closed || s.socket !== socket) return true;
    if (!isAuthed(req)) { expire(s, "auth_required"); return true; }
    if (data.type === "rpc-probe") { write(socket, { type: "rpc-probe-ack", nonce: data.nonce }); return true; }
    if (data.type !== "rpc-frame" && data.type !== "rpc-ack") return false;
    try {
      if (data.generation !== s.generation) throw new Error("RPC generation mismatch");
      ack(s, data.ack);
      if (data.type === "rpc-ack") return true;
      if (!Number.isSafeInteger(data.seq) || data.seq < 1 || data.seq > s.received + 1) throw new Error("RPC sequence gap");
      if (data.seq === s.received + 1) {
        const messages = data.payload?.type === "rpc-batch" ? data.payload.messages : [data.payload];
        if (!Array.isArray(messages) || messages.length < 1 || messages.length > 32) throw new Error("Invalid RPC batch");
        // 先校验整批，再按原顺序投递；任何中途失败都会结束会话，不重放已执行的前半批。
        for (const payload of messages) {
          if (!["app-host-connect", "app-host-port-message"].includes(payload?.type) || payload.clientId !== s.clientId) throw new Error("Invalid RPC payload");
        }
        for (const payload of messages) {
          if (!deliver(s.facade, req, payload) || s.closed) throw new Error("RPC delivery failed");
        }
        s.received = data.seq;
      }
      if (s.closed) return true;
      if (!s.ackTimer) s.ackTimer = setTimeout(() => {
        s.ackTimer = null; write(s.socket, { type: "rpc-ack", generation: s.generation, ack: s.received });
      }, 25);
    } catch { expire(s, "sequence_error"); }
    return true;
  }
  function detach(socket) {
    const s = socket.__rpcSession;
    if (!s || s.closed || s.socket !== socket) return;
    s.socket = null; s.detachedAt = Date.now(); timer(s, ttl, "expired");
    log("rpc_session_detached", { pageId: s.id.slice(0, 8), retentionMs: ttl });
  }
  function validateHttp(req) {
    if (!req.headers["x-opencodex-page-id"]) return true; // 旧协议页面保持兼容。
    const s = sessions.get(browser(req));
    return !!s && !s.closed && s.id === req.headers["x-opencodex-page-id"] && s.generation === req.headers["x-opencodex-page-generation"] && s.secret === req.headers["x-opencodex-page-credential"];
  }
  function logout(req) { const s = sessions.get(browser(req)); if (s) expire(s, "auth_required"); }
  function close() { for (const s of [...sessions.values()]) expire(s, "shutdown"); }
  return { initialize, attach, ready, message, detach, logout, close, validateHttp, fail: (socket) => { if (socket.__rpcSession?.socket === socket) expire(socket.__rpcSession, "invalid_frame"); } };
}
module.exports = { createRecoverableSessions };
