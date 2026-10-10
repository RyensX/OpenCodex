// proxy.integration.cjs —— openCodeProxy 本地端到端验证
// 1) 启动 mock gateway(:3737) 模拟 OpenCodex 本机 gateway（含 /codex-web-config.js、/ws echo、/api/health）
// 2) 启动真实 openCodeProxy(server.js, :8080)：账号登录（admin/admin 首登强制改密）+ 加密 auth.json
// 3) 用真实 PC 端 reverse-tunnel-client 反连，把 :3737 推到代理
// 4) 验证：登录/改密、Gateway 访问密码、设备页 Cookie、根路径反代、config.js 重写、WS 隧道与加密存储
// 回归背景：
//   - /openCodeProxy upgrade 曾误套浏览器 Basic Auth，生产（有密码）环境 PC 反连被 destroy（socket hang up）
//   - 设备 UI 引用根绝对路径资源，曾全部 404 导致设备页加载不出 → 根路径按设备 cookie 反代
// 测试代理仅监听回环地址，避免本地联调服务暴露到局域网。
process.env.RELAY_PORT = "8080";
process.env.RELAY_HOST = "127.0.0.1";
// legacy/second 是「添加设备」时的占位登记名；PC 反连自报自定义后缀 mock 后自动 re-bind。
// second 用于验证「同 ID 已被在线设备占用」时的 register-reject 冲突保护。
process.env.DEVICE_SECRETS = "legacy=testsecret,second=testsecret2";
// 账号数据与主密钥写到临时目录，避免污染仓库。
process.env.RELAY_AUTH_FILE = require("os").tmpdir() + `/proxy-auth-test-${Date.now()}.json`;
process.env.RELAY_AUTH_KEY_FILE = require("os").tmpdir() + `/proxy-authkey-test-${Date.now()}.key`;
process.env.RELAY_DEVICES_FILE = require("os").tmpdir() + `/proxy-devices-test-${Date.now()}.json`;

const WebSocket = require("ws");
const http = require("http");
const fs = require("fs");
const crypto = require("crypto");
const zlib = require("zlib");
const GATEWAY_AUTH_COOKIE = "codex_web_auth";
const GATEWAY_AUTH_TOKEN = "mock-gateway-session";
const gatewayPasswordDigest = crypto.createHash("sha256");
gatewayPasswordDigest.update("relay-harness-password", "utf8");
const GATEWAY_PASSWORD_HASH = gatewayPasswordDigest.digest("hex");
const GATEWAY_AUTH_CONFIG_PATH = require("os").tmpdir() + `/proxy-gateway-auth-test-${Date.now()}.yaml`;
process.env.CODEX_WEB_CONFIG_PATH = GATEWAY_AUTH_CONFIG_PATH;
// 为隧道客户端准备隔离的启用密码配置，确保回归用例覆盖旧的设备级自动登录行为。
fs.writeFileSync(GATEWAY_AUTH_CONFIG_PATH, 'auth:\n  password: "relay-harness-password"\n', "utf8");

function gatewayAuthSource(req) {
  // 按 Gateway 的凭据优先级区分浏览器 Cookie 与设备注入的令牌。
  const tokenHeader = String(req.headers["x-codex-web-token"] || "").trim();
  if (tokenHeader) return tokenHeader === GATEWAY_AUTH_TOKEN ? "header" : "";
  const authorization = String(req.headers.authorization || "").match(/^Bearer\s+(.+)$/i);
  if (authorization) return authorization[1].trim() === GATEWAY_AUTH_TOKEN ? "authorization" : "";
  const url = new URL(req.url, "http://localhost");
  const queryToken = String(url.searchParams.get("token") || "").trim();
  if (queryToken) return queryToken === GATEWAY_AUTH_TOKEN ? "query" : "";
  const expectedCookie = `${GATEWAY_AUTH_COOKIE}=${GATEWAY_AUTH_TOKEN}`;
  const cookies = String(req.headers.cookie || "").split(";");
  for (const part of cookies) {
    if (part.trim() === expectedCookie) return "cookie";
  }
  return "";
}

// 预置两个账号（admin/admin 首登强制改密 + vault/vault-pass-9），写入与 server.js 同格式的加密
// auth.json，用于验证改用户名的「重名拒绝」与「旧名失效」分支（纯黑盒无法凭空造第二个账号）。
(function seedAuth() {
  const key = crypto.randomBytes(32);
  fs.writeFileSync(process.env.RELAY_AUTH_KEY_FILE, key.toString("hex"), { mode: 0o600 });
  const hashPw = (pw, salt) =>
    crypto.scryptSync(String(pw), salt, 64, { N: 16384, r: 8, p: 1 }).toString("hex");
  const mk = (username, password, mustChange) => {
    const salt = crypto.randomBytes(16).toString("hex");
    return { username, salt, hash: hashPw(password, salt), mustChange, createdAt: new Date().toISOString() };
  };
  const users = [mk("admin", "admin", true), mk("vault", "vault-pass-9", false)];
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify({ users }), "utf8"), cipher.final()]);
  const payload = { v: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
  fs.writeFileSync(process.env.RELAY_AUTH_FILE, JSON.stringify(payload, null, 2), { mode: 0o600 });
})();

// --- openCodeProxy 服务端 ---
require("../../proxy/server.js");

// --- mock gateway :3737 ---
const mock = http.createServer((req, res) => {
  const authSource = gatewayAuthSource(req);
  const gatewayAuthenticated = !!authSource;
  if (req.url === "/api/auth/status") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        authRequired: true,
        authenticated: gatewayAuthenticated,
        deviceTokenUsed: authSource !== "" && authSource !== "cookie",
        relayCookieLeaked: /(?:^|;\s*)(?:ocx_session|ocx_device)=/.test(req.headers.cookie || ""),
      })
    );
    return;
  }
  if (req.url === "/api/auth/login" && req.method === "POST") {
    let rawBody = "";
    req.on("data", (chunk) => (rawBody += chunk));
    req.on("end", () => {
      let body = {};
      try {
        body = JSON.parse(rawBody || "{}");
      } catch {}
      if (body.passwordHash !== GATEWAY_PASSWORD_HASH) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, authenticated: false, error: "Invalid password" }));
        return;
      }
      res.writeHead(200, {
        "content-type": "application/json",
        "set-cookie": `${GATEWAY_AUTH_COOKIE}=${GATEWAY_AUTH_TOKEN}; Path=/; HttpOnly; SameSite=Lax`,
      });
      res.end(JSON.stringify({ ok: true, authRequired: true, authenticated: true, token: GATEWAY_AUTH_TOKEN }));
    });
    return;
  }
  if (!gatewayAuthenticated && req.url !== "/") {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Unauthorized" }));
    return;
  }
  if (req.url === "/codex-web-config.js") {
    res.writeHead(200, { "content-type": "application/javascript; charset=utf-8" });
    res.end(
      'window.__CODEX_WEB_CONFIG__ = { gatewayBaseUrl: location.origin, gatewayWsUrl: location.origin.replace(/^http/, "ws") + "/ws" };'
    );
    return;
  }
  if (req.url === "/api/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, from: "mock-gateway" }));
    return;
  }
  if (req.url.startsWith("/official-patched-v8/")) {
    // 模拟设备 UI 的根绝对路径静态资源
    res.writeHead(200, { "content-type": "application/javascript" });
    res.end("// mock static asset: " + req.url);
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(gatewayAuthenticated ? "<h1>Mock Codex Gateway</h1>" : "<h1>Gateway login required</h1>");
});
const mockWss = new WebSocket.Server({ server: mock, path: "/ws" });
mockWss.on("connection", (ws, req) => {
  if (!gatewayAuthSource(req)) {
    ws.close(1008, "Gateway authentication required");
    return;
  }
  // echo 保留帧类型：文本进文本出、二进进二进制出，用于校验隧道是否丢失帧类型。
  ws.on("message", (m, isBinary) => {
    if (isBinary) ws.send(Buffer.concat([Buffer.from("echo:"), m]), { binary: true });
    else ws.send("echo:" + m.toString("utf8"));
  });
});
mock.listen(3737, "127.0.0.1", () => console.log("[test] mock gateway on :3737"));

// --- 真实 PC 端 relay client（OpenCodex 仓库内） ---
process.env.OCX_RELAY_ENABLED = "1";
process.env.OCX_RELAY_URL = "ws://127.0.0.1:8080/openCodeProxy";
process.env.OCX_RELAY_SECRET = "testsecret";
// 使用合法设备 MAC，并独立保留浏览器访问后缀，覆盖当前身份协议。
process.env.OCX_RELAY_DEVICE_ID = "02:00:00:00:00:01";
process.env.OCX_RELAY_ACCESS_PATH = "mock";
process.env.OCX_RELAY_DEVICE_NAME = "MockPC";
const { startReverseTunnel } = require("../runtime/relay/reverse-tunnel-client.cjs");
startReverseTunnel({
  diagnosticLog: () => {},
  diagnosticWarn: (c, m, o) => console.log("[relay-warn]", m, o || ""),
});

const BASE = "http://127.0.0.1:8080";
let sessionCookie = "";
let deviceCookie = "";
let gatewayCookie = "";

function request(path, { method = "GET", body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    // 模拟浏览器同时持有中继会话、设备绑定和 Gateway 登录三类 Cookie。
    const cookieParts = [];
    if (sessionCookie) cookieParts.push(sessionCookie);
    if (deviceCookie) cookieParts.push(deviceCookie);
    if (gatewayCookie) cookieParts.push(gatewayCookie);
    const cookieHeader = cookieParts.join("; ");
    const req = http.request(
      BASE + path,
      {
        method,
        headers: Object.assign(
          data
            ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) }
            : {},
          cookieHeader ? { cookie: cookieHeader } : {},
          headers
        ),
      },
      (res) => {
        let d = "";
        const chunks = [];
        // 保留原始字节以验证 gzip 配置响应，原有文本断言继续使用 body。
        res.on("data", (c) => { d += c; chunks.push(c); });
        res.on("end", () =>
          resolve({ status: res.statusCode, body: d, rawBody: Buffer.concat(chunks), headers: res.headers, setCookie: res.headers["set-cookie"] })
        );
      }
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

function wsTest(path) {
  return new Promise((resolve) => {
    // 浏览器 WebSocket 与普通请求携带同一份 Cookie，回归认证边界及帧类型透传。
    const cookieParts = [];
    if (sessionCookie) cookieParts.push(sessionCookie);
    if (deviceCookie) cookieParts.push(deviceCookie);
    if (gatewayCookie) cookieParts.push(gatewayCookie);
    const headers = cookieParts.length ? { cookie: cookieParts.join("; ") } : {};
    const c = new WebSocket(BASE + path, { headers });
    const result = { textEcho: "", textIsText: null, binEcho: "", binIsBinary: null, closeCode: null };
    let stage = "text";
    c.on("open", () => c.send("ping-from-browser"));
    c.on("message", (data, isBinary) => {
      if (stage === "text") {
        result.textEcho = data.toString("utf8");
        result.textIsText = !isBinary;
        stage = "binary";
        c.send(Buffer.from("binary-ping-123"));
      } else {
        result.binEcho = data.toString("utf8");
        result.binIsBinary = !!isBinary;
        c.close();
      }
    });
    c.on("close", (code) => {
      result.closeCode = code;
      resolve(result);
    });
    c.on("error", () => resolve(result));
    setTimeout(() => resolve(result), 5000);
  });
}

let pass = true;
const check = (name, cond, detail) => {
  console.log(`[test] ${name}:`, cond ? "PASS" : `FAIL ${detail || ""}`);
  if (!cond) pass = false;
};

setTimeout(async () => {
  try {
    // 1) 未登录访问看板 → 302 /login
    const anon = await request("/");
    check("未登录 302 到登录页", anon.status === 302 && String(anon.headers.location).includes("/login"), JSON.stringify(anon.status) + anon.headers.location);

    // 1.5) 登录页 DOM 完整性：必须同时含用户名与密码输入框（防 null.value 回归）
    const loginPage = await request("/login");
    check("登录页含用户名+密码输入框", loginPage.status === 200 && loginPage.body.includes('id="username"') && loginPage.body.includes('id="password"'), "status=" + loginPage.status);

    // 2) 错误密码被拒
    const bad = await request("/login", { method: "POST", body: { username: "admin", password: "wrong" } });
    check("错误密码被拒", bad.status === 200 && JSON.parse(bad.body).ok === false);

    // 3) admin/admin 登录 → mustChange=true + set-cookie
    const login = await request("/login", { method: "POST", body: { username: "admin", password: "admin" } });
    const loginBody = JSON.parse(login.body);
    check("默认账号登录", loginBody.ok === true && loginBody.mustChange === true, login.body);
    check("登录下发会话 cookie", !!(login.setCookie && login.setCookie.join("").includes("ocx_session=")));
    sessionCookie = (login.setCookie || []).map((c) => c.split(";")[0]).join("; ");

    // 4) mustChange 未改密前访问看板 → 302 /change-password
    const gate = await request("/");
    check("首登强制改密拦截", gate.status === 302 && String(gate.headers.location).includes("/change-password"), gate.status + "@" + gate.headers.location);

    // 5) 改密（admin → harness-pass-123）
    const change = await request("/change-password", {
      method: "POST",
      body: { oldPassword: "admin", newPassword: "harness-pass-123" },
    });
    check("修改密码成功", JSON.parse(change.body).ok === true, change.body);

    // 6) 改密后看板 200
    const dash = await request("/");
    check("看板可访问", dash.status === 200 && dash.body.includes("OpenCodex 设备看板") && dash.body.includes("添加设备"));

    // 7) 设备页 200 + 种设备 cookie
    const devPage = await request("/d/mock/");
    const devCookie = (devPage.setCookie || []).find((c) => c.startsWith("ocx_device="));
    check("未登录设备页显示 Gateway 登录入口", devPage.status === 200 && devPage.body.includes("Gateway login required"));
    check("设备页绑定设备 cookie", !!devCookie && devCookie.includes("ocx_device=02%3A00%3A00%3A00%3A00%3A01"), JSON.stringify(devPage.setCookie));
    deviceCookie = devCookie ? devCookie.split(";")[0] : "";

    // Gateway 密码必须独立于 relay 管理员登录；HTTP 转发只保留 Gateway 自己的登录 Cookie。
    const anonymousAuth = await request("/api/auth/status");
    const anonymousAuthBody = JSON.parse(anonymousAuth.body);
    check(
      "中继不会用设备令牌绕过 Gateway 密码",
      anonymousAuthBody.authRequired && !anonymousAuthBody.authenticated && !anonymousAuthBody.deviceTokenUsed
    );
    check("转发到设备的 Cookie 不含中继会话", !anonymousAuthBody.relayCookieLeaked);
    const anonymousHealth = await request("/api/health");
    check("未输入 Gateway 密码时受保护 API 返回 401", anonymousHealth.status === 401);
    const badGatewayLogin = await request("/api/auth/login", {
      method: "POST",
      body: { passwordHash: "0".repeat(64) },
    });
    check("Gateway 错误密码仍被拒绝", badGatewayLogin.status === 401);
    const anonymousWs = await wsTest("/d/mock/ws");
    check("未登录 Gateway 的 WebSocket 被拒绝", anonymousWs.closeCode === 1008);

    const gatewayLogin = await request("/api/auth/login", {
      method: "POST",
      body: { passwordHash: GATEWAY_PASSWORD_HASH },
    });
    let gatewaySetCookie = "";
    for (const cookie of gatewayLogin.setCookie || []) {
      if (cookie.startsWith(`${GATEWAY_AUTH_COOKIE}_mock=`)) {
        gatewaySetCookie = cookie;
        break;
      }
    }
    gatewayCookie = gatewaySetCookie ? gatewaySetCookie.split(";")[0] : "";
    check("Gateway 正确密码建立独立登录态", gatewayLogin.status === 200 && !!gatewayCookie);
    const authenticatedAuth = await request("/api/auth/status");
    const authenticatedAuthBody = JSON.parse(authenticatedAuth.body);
    check("Gateway Cookie 经中继到达设备", authenticatedAuthBody.authenticated && !authenticatedAuthBody.relayCookieLeaked);
    const authenticatedPage = await request("/d/mock/");
    check("Gateway 登录后设备页开放", authenticatedPage.status === 200 && authenticatedPage.body.includes("Mock Codex Gateway"));

    // 8) config.js 重写 gatewayWsUrl
    const cfg = await request("/d/mock/codex-web-config.js");
    check("config.js 重写", cfg.body.includes("/d/mock/ws"), cfg.body.slice(0, 120));
    // 改写后的配置允许 gzip，长度头必须对应最终压缩字节，且拒绝压缩的客户端仍能读取明文。
    const compressedCfg = await request("/d/mock/codex-web-config.js", { headers: { "accept-encoding": "gzip" } });
    check("config.js gzip 正文及长度", compressedCfg.headers["content-encoding"] === "gzip" &&
      Number(compressedCfg.headers["content-length"]) === compressedCfg.rawBody.length &&
      zlib.gunzipSync(compressedCfg.rawBody).toString("utf8").includes("/d/mock/ws"));
    const identityCfg = await request("/d/mock/codex-web-config.js", { headers: { "accept-encoding": "gzip;q=0" } });
    check("config.js 尊重 gzip 禁用", !identityCfg.headers["content-encoding"] && identityCfg.body.includes("/d/mock/ws"));

    // 9) 根路径反代：设备 UI 的根绝对路径资源（按 cookie/唯一在线设备转发）
    const asset = await request("/official-patched-v8/assets/index-test.js");
    check("根路径资源反代到设备", asset.status === 200 && asset.body.includes("official-patched-v8"), asset.status + " " + asset.body.slice(0, 60));
    const health = await request("/api/health");
    check("根路径 API 反代到设备", health.status === 200 && health.body.includes("mock-gateway"), health.status + " " + health.body.slice(0, 60));

    // 10) 设备页 WS 隧道 echo + 帧类型严格校验（文本帧必须回文本帧，否则官方 UI JSON.parse 失败）
    const echo = await wsTest("/d/mock/ws");
    check(
      "WS 隧道 echo（文本帧类型保留）",
      echo.textEcho === "echo:ping-from-browser" && echo.textIsText === true,
      JSON.stringify(echo)
    );
    check(
      "WS 隧道 echo（二进制帧类型保留）",
      echo.binEcho === "echo:binary-ping-123" && echo.binIsBinary === true,
      JSON.stringify(echo)
    );

    // 11) 看板 API（会话内）
    const devices = await request("/api/devices");
    const devList = JSON.parse(devices.body).devices || [];
    check("设备列表含 mock（re-bind 后）", devList.some((x) => x.id === "02:00:00:00:00:01" && x.accessPath === "mock" && x.online));

    // 12) auth.json 加密存储：文件中不存在明文用户名/密码
    const authRaw = fs.readFileSync(process.env.RELAY_AUTH_FILE, "utf8");
    check("auth.json 已加密（无明文 admin/密码）", !authRaw.includes("admin") && !authRaw.includes("harness-pass") && authRaw.includes('"data"'));

    // 13) re-bind：占位登记 legacy 已迁移到自定义后缀 mock
    const rebound = await request("/api/devices");
    const reboundList = JSON.parse(rebound.body).devices || [];
    check("设备已 re-bind 到自定义后缀", reboundList.some((x) => x.id === "02:00:00:00:00:01" && x.accessPath === "mock") && !reboundList.some((x) => x.id === "legacy"));

    // 14) 冲突保护：另一密钥抢注同 ID（已在线）→ register-reject
    const conflict = await new Promise((resolve) => {
      const c = new WebSocket("ws://127.0.0.1:8080/openCodeProxy?device=02:00:00:00:00:01&path=mock&secret=testsecret2");
      const timer = setTimeout(() => resolve("TIMEOUT"), 3000);
      c.on("message", (m) => {
        clearTimeout(timer);
        resolve(String(m));
        c.close();
      });
      c.on("error", () => {
        clearTimeout(timer);
        resolve("WS-ERROR");
      });
    });
    check("同 ID 冲突被拒绝", conflict.includes("register-reject") && conflict.includes("already in use"), conflict.slice(0, 120));

    // 15) 改用户名：非法格式拒绝（1 位，低于 2-32 位要求）
    const badName = await request("/change-username", { method: "POST", body: { newUsername: "a" } });
    check("非法用户名拒绝", badName.status === 200 && JSON.parse(badName.body).ok === false, badName.body);

    // 16) 改用户名：重名拒绝（vault 账号已占用该用户名）
    const dupName = await request("/change-username", { method: "POST", body: { newUsername: "vault" } });
    check(
      "重名用户名拒绝",
      JSON.parse(dupName.body).ok === false && String(JSON.parse(dupName.body).error).includes("占用"),
      dupName.body
    );

    // 17) 改用户名：admin → harness-admin 成功
    const rename = await request("/change-username", { method: "POST", body: { newUsername: "harness-admin" } });
    check("改用户名成功", JSON.parse(rename.body).ok === true && JSON.parse(rename.body).username === "harness-admin", rename.body);

    // 18) 看板顶栏显示新用户名
    const dash2 = await request("/");
    check("看板显示新用户名", dash2.status === 200 && dash2.body.includes("harness-admin"), "status=" + dash2.status);

    // 19) 旧用户名登录失败（改名后旧名已失效）
    const oldLogin = await request("/login", { method: "POST", body: { username: "admin", password: "harness-pass-123" } });
    check("旧用户名登录失败", JSON.parse(oldLogin.body).ok === false, oldLogin.body);

    // 20) 新用户名登录成功
    const newLogin = await request("/login", { method: "POST", body: { username: "harness-admin", password: "harness-pass-123" } });
    check(
      "新用户名登录成功",
      JSON.parse(newLogin.body).ok === true && JSON.parse(newLogin.body).mustChange === false,
      newLogin.body
    );

    // 21) 登录冻结：连续 5 次错误密码 → 第 6 次（即使密码正确）429，且响应带剩余冻结秒数
    for (let i = 0; i < 5; i++) {
      await request("/login", { method: "POST", body: { username: "harness-admin", password: "wrong-pw" } });
    }
    const frozen = await request("/login", { method: "POST", body: { username: "harness-admin", password: "harness-pass-123" } });
    const frozenBody = JSON.parse(frozen.body);
    check(
      "5 次错误后冻结（429 + 剩余秒数）",
      frozen.status === 429 && frozenBody.ok === false && Number(frozenBody.retryAfterSec) > 500,
      frozen.status + " " + frozen.body
    );
  } catch (e) {
    console.error("[test] exception:", e);
    pass = false;
  }

  console.log(pass ? "\n[test] ALL PASS ✅" : "\n[test] FAILED ❌");
  try {
    fs.unlinkSync(GATEWAY_AUTH_CONFIG_PATH);
  } catch {}
  process.exit(pass ? 0 : 1);
}, 2500);
