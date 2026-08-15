const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const {
  AUTH_CONFIG_PATH,
  AUTH_TOKEN_STORE_PATH,
  AUTH_TOKEN_TTL_MS,
  COOKIE_NAME,
  LAUNCHER_TOKEN,
  PASSWORD_HASH_PREFIX,
  ensureDir,
  exists,
  readText,
} = require("../core/config.cjs");
const { authRateLimiter } = require("./auth-rate-limit.cjs");
const { headerValue, isRequestBodyTooLargeError, readBody, sendJson } = require("./http-utils.cjs");

// auth.cjs 负责 gateway 自身访问控制；密码只在配置文件里短暂出现，启动后会改写为 sha256-v1 hash。
const LOGIN_BODY_MAX_BYTES = 8 * 1024;

function sha256Hex(value) {
  return crypto.createHash("sha256").update(String(value), "utf-8").digest("hex");
}

function isPrefixedPasswordHash(value) {
  return new RegExp(`^${PASSWORD_HASH_PREFIX}[a-f0-9]{64}$`, "i").test(String(value || "").trim());
}

function stripYamlComment(value) {
  let quote = "";
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    // 只去掉引号外的 YAML 注释，避免密码里的 # 被错误截断。
    if (quote === '"') {
      if (char === "\\") {
        i += 1;
        continue;
      }
      if (char === '"') quote = "";
      continue;
    }
    if (quote === "'") {
      if (char === "'" && value[i + 1] === "'") {
        i += 1;
        continue;
      }
      if (char === "'") quote = "";
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "#" && (i === 0 || /\s/.test(value[i - 1]))) return value.slice(0, i);
  }
  return value;
}

function parseYamlStringScalar(rawValue) {
  const value = stripYamlComment(String(rawValue || "")).trim();
  if (!value || value === "null" || value === "~") return "";
  if (value.startsWith('"')) {
    // 双引号字符串按 JSON 规则解析，复用转义处理，避免手写反斜杠状态机。
    if (!value.endsWith('"')) throw new Error("[gateway] invalid quoted auth.password in config.yaml");
    try {
      return JSON.parse(value);
    } catch {
      throw new Error("[gateway] invalid quoted auth.password in config.yaml");
    }
  }
  if (value.startsWith("'")) {
    // YAML 单引号内用两个单引号表示字面单引号。
    if (!value.endsWith("'")) throw new Error("[gateway] invalid quoted auth.password in config.yaml");
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

function leadingIndent(line) {
  const match = String(line || "").match(/^(\s*)/);
  return match ? match[1].length : 0;
}

function findAuthPasswordScalar(rawConfig) {
  /**
   * 这里只实现 auth.password 需要的 YAML 子集：
   * 顶层 auth: 块 + 一级 password 标量。
   * 这样能保持无额外依赖，同时避免“看似支持完整 YAML 实则不完整”的风险。
   */
  const lines = String(rawConfig || "").split(/\r?\n/);
  let inAuth = false;
  let authIndent = 0;
  let authChildIndent = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const logicalLine = stripYamlComment(line);
    if (!logicalLine.trim()) continue;
    const indent = leadingIndent(line);
    if (inAuth && indent <= authIndent) {
      inAuth = false;
      authChildIndent = null;
    }
    if (!inAuth && indent === 0) {
      const authMatch = logicalLine.trim().match(/^auth\s*:\s*(.*)$/);
      if (authMatch) {
        // 这里仅支持项目约定的 auth: 块形式，避免解析 inline YAML object 引入半吊子解析器。
        if (authMatch[1].trim()) {
          throw new Error("[gateway] unsupported inline auth config in config.yaml; use block form auth.password");
        }
        inAuth = true;
        authIndent = indent;
        authChildIndent = null;
        continue;
      }
    }
    if (!inAuth || indent <= authIndent) continue;
    if (authChildIndent == null) authChildIndent = indent;
    if (indent !== authChildIndent) continue;
    const passwordMatch = line.match(/^(\s*)password\s*:\s*(.*)$/);
    if (!passwordMatch) continue;
    return {
      lineIndex: i,
      value: parseYamlStringScalar(passwordMatch[2]),
    };
  }
  return null;
}

function rewriteAuthPasswordHash(rawConfig, lineIndex, passwordHash) {
  const hasFinalNewline = /\r?\n$/.test(rawConfig);
  // 尽量只改 password 这一行，保持用户 config.yaml 其它格式和注释不动。
  const normalizedConfig = hasFinalNewline ? String(rawConfig || "").replace(/\r?\n$/, "") : String(rawConfig || "");
  const lines = normalizedConfig.split(/\r?\n/);
  const line = lines[lineIndex] || "";
  const match = line.match(/^(\s*password\s*:\s*).*/);
  if (!match) throw new Error("[gateway] auth.password line was not found while rewriting config.yaml");
  lines[lineIndex] = `${match[1]}"${PASSWORD_HASH_PREFIX}${passwordHash}"`;
  return lines.join("\n") + (hasFinalNewline ? "\n" : "");
}

function loadAuthPasswordHashFromConfig() {
  /**
   * 返回值只有两种：
   * - 空字符串：未启用密码保护。
   * - 64 位 sha256：后续登录比较前端提交的 passwordHash。
   */
  if (!exists(AUTH_CONFIG_PATH)) return "";
  let rawConfig = "";
  try {
    rawConfig = readText(AUTH_CONFIG_PATH);
  } catch (error) {
    throw new Error(`[gateway] failed to read config.yaml: ${error.message || error}`);
  }
  const authPassword = findAuthPasswordScalar(rawConfig);
  if (!authPassword || String(authPassword.value || "").length === 0) return "";
  const passwordValue = String(authPassword.value);
  const trimmedPasswordValue = passwordValue.trim();
  if (isPrefixedPasswordHash(trimmedPasswordValue)) {
    return trimmedPasswordValue.slice(PASSWORD_HASH_PREFIX.length).toLowerCase();
  }
  // 首次启动时把明文密码升级为带前缀 hash；后续登录只比较前端提交的 sha256。
  const passwordHash = sha256Hex(passwordValue);
  const nextConfig = rewriteAuthPasswordHash(rawConfig, authPassword.lineIndex, passwordHash);
  try {
    fs.writeFileSync(AUTH_CONFIG_PATH, nextConfig, "utf-8");
  } catch (error) {
    throw new Error(`[gateway] failed to rewrite config.yaml auth.password as hash: ${error.message || error}`);
  }
  return passwordHash;
}

const AUTH_PASSWORD_HASH = loadAuthPasswordHashFromConfig();

function makeAuthStore(options = {}) {
  const filePath = options.filePath || AUTH_TOKEN_STORE_PATH;
  const now = typeof options.now === "function" ? options.now : Date.now;
  const passwordHash = options.passwordHash === undefined ? AUTH_PASSWORD_HASH : options.passwordHash;
  const persistIntervalMs = options.persistIntervalMs === undefined ? 60 * 60 * 1_000 : options.persistIntervalMs;
  const ttlMs = options.ttlMs || AUTH_TOKEN_TTL_MS;
  const passwordId = passwordHash ? sha256Hex(`opencodex-auth-store:${passwordHash}`) : "";
  const tokens = new Map();
  let lastRefreshAtMs = 0;
  const hashToken = (token) => crypto.createHash("sha256").update(String(token)).digest("base64url");
  const prune = () => {
    const currentTime = now();
    let changed = false;
    for (const [hash, entry] of tokens) {
      if (!entry || entry.expiresAtMs <= currentTime) {
        tokens.delete(hash);
        changed = true;
      }
    }
    return changed;
  };

  function persist() {
    if (!passwordId || !filePath) return;
    prune();
    ensureDir(path.dirname(filePath));
    const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
    const document = {
      version: 1,
      passwordId,
      lastRefreshAtMs,
      tokens: [...tokens].map(([hash, entry]) => ({ hash, expiresAtMs: entry.expiresAtMs })),
    };
    fs.writeFileSync(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
    try {
      fs.renameSync(temporaryPath, filePath);
    } catch (error) {
      try {
        fs.unlinkSync(temporaryPath);
      } catch {}
      throw error;
    }
  }

  if (passwordId && filePath && exists(filePath)) {
    try {
      const document = JSON.parse(readText(filePath));
      if (document?.version === 1 && document.passwordId !== passwordId) {
        persist();
      } else if (document?.version === 1 && Array.isArray(document.tokens)) {
        lastRefreshAtMs = Number.isSafeInteger(document.lastRefreshAtMs) ? document.lastRefreshAtMs : 0;
        for (const item of document.tokens) {
          if (!/^[A-Za-z0-9_-]{43}$/.test(item?.hash || "") || !Number.isSafeInteger(item?.expiresAtMs)) continue;
          tokens.set(item.hash, { expiresAtMs: item.expiresAtMs });
        }
        prune();
      }
    } catch {}
  }

  return {
    issue() {
      prune();
      const token = crypto.randomBytes(32).toString("base64url");
      const expiresAtMs = now() + ttlMs;
      tokens.set(hashToken(token), { expiresAtMs });
      lastRefreshAtMs = now();
      persist();
      return { token, expiresAtMs };
    },
    validate(token) {
      // 每次成功校验都滑动续期，用户持续使用时不会被固定过期时间强制踢出。
      if (!token) return null;
      const hash = hashToken(token);
      const entry = tokens.get(hash);
      if (!entry) return null;
      if (entry.expiresAtMs <= now()) {
        tokens.delete(hash);
        persist();
        return null;
      }
      const nextExpiresAtMs = now() + ttlMs;
      if (now() - lastRefreshAtMs >= persistIntervalMs) {
        entry.expiresAtMs = nextExpiresAtMs;
        lastRefreshAtMs = now();
        persist();
      }
      return entry;
    },
    revoke(token) {
      if (!token) return;
      const hash = hashToken(token);
      const entry = tokens.get(hash);
      if (!entry) return;
      tokens.delete(hash);
      try {
        persist();
      } catch (error) {
        tokens.set(hash, entry);
        throw error;
      }
    },
  };
}

const authStore = makeAuthStore();

function parseCookies(header) {
  // 不依赖外部 cookie parser，gateway 只需要读一个 HttpOnly token cookie。
  const cookies = {};
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
}

function timingSafeEqualString(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  if (leftBuffer.length !== rightBuffer.length) {
    try {
      // 长度不同也跑一次 timingSafeEqual，降低长度分支带来的时间侧信道差异。
      crypto.timingSafeEqual(Buffer.alloc(rightBuffer.length), rightBuffer);
    } catch {}
    return false;
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function bearerToken(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  const match = String(raw || "").match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function authTokenFromRequest(req, url = null) {
  // token 来源按显式 header、Authorization、query、cookie 排序，方便 CLI/浏览器各自接入。
  const headerToken = String(headerValue(req.headers, "x-codex-web-token") || "").trim();
  if (headerToken) return headerToken;
  const authorizationToken = bearerToken(headerValue(req.headers, "authorization"));
  if (authorizationToken) return authorizationToken;
  const queryToken = url && url.searchParams ? String(url.searchParams.get("token") || "").trim() : "";
  if (queryToken) return queryToken;
  const cookies = parseCookies(req.headers.cookie || "");
  return String(cookies[COOKIE_NAME] || "").trim();
}

function authResultForRequest(req, url = null) {
  // 没配置密码时 gateway 处于无认证模式，保持本地开发默认可用。
  if (!AUTH_PASSWORD_HASH) return { authRequired: false, authenticated: true, token: "", expiresAtMs: null };
  const token = authTokenFromRequest(req, url);
  const entry = authStore.validate(token);
  return {
    authRequired: true,
    authenticated: !!entry,
    token,
    expiresAtMs: entry ? entry.expiresAtMs : null,
  };
}

function isAuthed(req, url = null) {
  return authResultForRequest(req, url).authenticated;
}

function isLauncherRequest(req) {
  if (!LAUNCHER_TOKEN) return false;
  // 桌面 launcher 用独立 token 读取状态，避免复用用户登录 cookie。
  const value = headerValue(req.headers, "x-opencodex-launcher-token");
  return typeof value === "string" && value === LAUNCHER_TOKEN;
}

function isSecureRequest(req) {
  if (req?.socket?.encrypted) return true;
  const forwardedProto = String(headerValue(req?.headers || {}, "x-forwarded-proto") || "")
    .split(",", 1)[0]
    .trim()
    .toLowerCase();
  return forwardedProto === "https";
}

function authCookieHeader(token, expiresAtMs, nowMs = Date.now(), secure = false) {
  const maxAgeSeconds = Math.max(0, Math.ceil((expiresAtMs - nowMs) / 1_000));
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAgeSeconds}; Expires=${new Date(expiresAtMs).toUTCString()}${secure ? "; Secure" : ""}`;
}

function clearAuthCookieHeader(secure = false) {
  const expired = "Thu, 01 Jan 1970 00:00:00 GMT";
  const secureSuffix = secure ? "; Secure" : "";
  return [
    `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0; Expires=${expired}${secureSuffix}`,
    `${COOKIE_NAME}=; Path=/; SameSite=Lax; Max-Age=0; Expires=${expired}${secureSuffix}`,
    `${COOKIE_NAME}=; HttpOnly; Path=/api/auth; SameSite=Lax; Max-Age=0; Expires=${expired}${secureSuffix}`,
    `${COOKIE_NAME}=; Path=/api/auth; SameSite=Lax; Max-Age=0; Expires=${expired}${secureSuffix}`,
  ];
}

function authRefreshHeaders(auth, req) {
  if (!auth || !auth.authenticated || !auth.token || !auth.expiresAtMs) return {};
  return { "set-cookie": authCookieHeader(auth.token, auth.expiresAtMs, Date.now(), isSecureRequest(req)) };
}

function isValidPasswordHash(value) {
  return /^[a-f0-9]{64}$/i.test(String(value || "").trim());
}

function readPasswordHashFromBody(rawBody, contentType) {
  // 登录接口同时支持 JSON 和 form-urlencoded，方便前端 fetch 与简单表单调试。
  if (String(contentType || "").includes("application/json")) {
    try {
      const parsed = JSON.parse(rawBody || "{}");
      return typeof parsed.passwordHash === "string" ? parsed.passwordHash : "";
    } catch {
      return "";
    }
  }
  const params = new URLSearchParams(rawBody || "");
  return params.get("passwordHash") || "";
}

function retryAfterSeconds(retryAfterMs) {
  return String(Math.max(1, Math.ceil((Number(retryAfterMs) || 0) / 1000)));
}

function sendTooManyLoginAttempts(res, decision) {
  const retryAfterMs = Math.max(1, Math.ceil(Number(decision && decision.retryAfterMs) || 1));
  return sendJson(
    res,
    429,
    {
      ok: false,
      authRequired: true,
      authenticated: false,
      error: "Too many login attempts",
      retryAfterMs,
    },
    {
      "cache-control": "no-store",
      "retry-after": retryAfterSeconds(retryAfterMs),
    }
  );
}

async function handleAuthLogin(req, res) {
  if (req.method !== "POST") {
    return sendJson(res, 405, { ok: false, error: "Method Not Allowed" }, { "cache-control": "no-store" });
  }
  if (!AUTH_PASSWORD_HASH) {
    // 无认证模式下仍返回统一结构，前端可以少写分支。
    return sendJson(
      res,
      200,
      {
        ok: true,
        authRequired: false,
        authenticated: true,
        token: "",
        expiresAtMs: null,
        ttlMs: null,
      },
      { "cache-control": "no-store" }
    );
  }
  const limitBeforeBody = authRateLimiter.check(req);
  if (!limitBeforeBody.allowed) return sendTooManyLoginAttempts(res, limitBeforeBody);

  let rawBody = "";
  try {
    rawBody = await readBody(req, { maxBytes: LOGIN_BODY_MAX_BYTES });
  } catch (error) {
    if (isRequestBodyTooLargeError(error)) {
      return sendJson(
        res,
        413,
        { ok: false, authRequired: true, authenticated: false, error: "Request body too large" },
        { "cache-control": "no-store" }
      );
    }
    throw error;
  }
  // 读 body 期间如果同一来源被其它并发登录失败推入退避/锁定，这里再次拦截。
  const limitAfterBody = authRateLimiter.check(req);
  if (!limitAfterBody.allowed) return sendTooManyLoginAttempts(res, limitAfterBody);

  // 前端提交 passwordHash 而不是明文，避免明文密码在 gateway 日志/代理层出现。
  const passwordHash = readPasswordHashFromBody(rawBody, headerValue(req.headers, "content-type")).trim().toLowerCase();
  if (!isValidPasswordHash(passwordHash) || !timingSafeEqualString(passwordHash, AUTH_PASSWORD_HASH)) {
    const failure = authRateLimiter.recordFailure(req);
    if (failure.limited) return sendTooManyLoginAttempts(res, failure);
    return sendJson(
      res,
      401,
      { ok: false, authRequired: true, authenticated: false, error: "Invalid password" },
      { "cache-control": "no-store" }
    );
  }
  authRateLimiter.recordSuccess(req);
  const issued = authStore.issue();
  return sendJson(
    res,
    200,
    {
      ok: true,
      authRequired: true,
      authenticated: true,
      token: issued.token,
      expiresAtMs: issued.expiresAtMs,
      ttlMs: AUTH_TOKEN_TTL_MS,
    },
    {
      "cache-control": "no-store",
      "set-cookie": authCookieHeader(issued.token, issued.expiresAtMs, Date.now(), isSecureRequest(req)),
    }
  );
}

function handleAuthStatus(req, res, url) {
  // status 接口承担续期职责，前端轮询或页面刷新时会刷新 cookie 过期时间。
  const auth = authResultForRequest(req, url);
  return sendJson(
    res,
    200,
    {
      ok: true,
      authRequired: !!AUTH_PASSWORD_HASH,
      authenticated: auth.authenticated,
      expiresAtMs: auth.expiresAtMs,
      ttlMs: AUTH_PASSWORD_HASH ? AUTH_TOKEN_TTL_MS : null,
    },
    { "cache-control": "no-store", ...authRefreshHeaders(auth, req) }
  );
}

function handleAuthLogout(req, res, url) {
  // logout 同时撤销内存 token 和多路径 cookie，清理旧版本可能写下的 cookie。
  const auth = authResultForRequest(req, url);
  if (auth.token) authStore.revoke(auth.token);
  return sendJson(
    res,
    200,
    { ok: true },
    {
      "cache-control": "no-store",
      "set-cookie": clearAuthCookieHeader(isSecureRequest(req)),
    }
  );
}

function sendUnauthorized(_req, res) {
  return sendJson(
    res,
    401,
    { ok: false, error: "Unauthorized" },
    { "cache-control": "no-store", "www-authenticate": "Bearer" }
  );
}

module.exports = {
  AUTH_PASSWORD_HASH,
  authRefreshHeaders,
  authResultForRequest,
  handleAuthLogin,
  handleAuthLogout,
  handleAuthStatus,
  isAuthed,
  isLauncherRequest,
  sendUnauthorized,
  __test: {
    authCookieHeader,
    isSecureRequest,
    makeAuthStore,
  },
};
