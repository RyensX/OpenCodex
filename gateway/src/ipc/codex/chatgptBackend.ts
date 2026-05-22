// @ts-nocheck
export {};

const util = require("util");

const CHATGPT_AUTH_REFRESH_SKEW_MS = 60 * 1000;
const CHATGPT_BACKEND_DEFAULT_TTL_MS = 30 * 1000;
const CHATGPT_BACKEND_LOGO_TTL_MS = 5 * 60 * 1000;
const CHATGPT_BACKEND_DEFAULT_TIMEOUT_MS = 10 * 1000;
const CHATGPT_BACKEND_LOGO_TIMEOUT_MS = 800;

let CHATGPT_AUTH_CACHE = null;
const CHATGPT_BACKEND_GET_CACHE = new Map();
const CHATGPT_BACKEND_GET_INFLIGHT = new Map();

/** fetch/mcp payload 中部分字段可能是 JSON 字符串，按需解析。 */
function parseMaybeJson(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** 归一化 fetch headers，支持数组和对象两种输入。 */
function normalizeFetchHeaders(headers) {
  if (!headers || typeof headers !== "object") return {};
  const entries = Array.isArray(headers) ? headers : Object.entries(headers);
  const normalized = {};
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length < 2) continue;
    const [key, value] = entry;
    if (key == null || value == null) continue;
    normalized[String(key)] = String(value);
  }
  return normalized;
}

/** 日志截断，避免错误对象过大。 */
function truncateForLog(value, maxLength = 500) {
  const text = typeof value === "string" ? value : util.inspect(value, { depth: 4, breakLength: 120 });
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

/** 提取 Sentry/SDK 异常摘要，日志里不输出完整 body。 */
function summarizeSdkException(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { body: truncateForLog(body) };
  }
  const bodyKeys = Object.keys(body);
  const events = Array.isArray(body.events) ? body.events : [];
  const firstEvent = events.find((event) => event && typeof event === "object") || null;
  const metadata =
    firstEvent && firstEvent.metadata && typeof firstEvent.metadata === "object" && !Array.isArray(firstEvent.metadata)
      ? firstEvent.metadata
      : {};
  const directError = body.exception || body.error || body.message || body.reason || body.stack || null;
  return {
    bodyKeys: bodyKeys.slice(0, 30),
    eventCount: events.length,
    eventName: firstEvent && firstEvent.eventName,
    error: truncateForLog(metadata.error || metadata.exception || metadata.message || directError),
    metadataKeys: Object.keys(metadata).slice(0, 20),
  };
}

/** 解析 JWT payload，不做验签，只用于提取展示/转发所需 claim。 */
function decodeJwtPayload(token) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

/** 从 ChatGPT auth token 中提取 account/user/plan/email。 */
function authClaimsFromToken(token) {
  const payload = decodeJwtPayload(token);
  if (!payload || typeof payload !== "object") return {};
  const openaiAuth = payload["https://api.openai.com/auth"];
  return {
    accountId:
      openaiAuth && typeof openaiAuth === "object" && typeof openaiAuth.chatgpt_account_id === "string"
        ? openaiAuth.chatgpt_account_id
        : null,
    plan:
      openaiAuth && typeof openaiAuth === "object" && typeof openaiAuth.chatgpt_plan_type === "string"
        ? openaiAuth.chatgpt_plan_type
        : null,
    userId: typeof payload.sub === "string" ? payload.sub : null,
    email: typeof payload.email === "string" ? payload.email : null,
  };
}

/** 读取 JWT 过期时间。 */
function jwtExpiresAtMs(token) {
  const payload = decodeJwtPayload(token);
  return payload && typeof payload.exp === "number" ? payload.exp * 1000 : null;
}

/** 判断缓存的 ChatGPT token 是否仍可用，预留刷新缓冲时间。 */
function isCachedChatgptAuthUsable(entry) {
  if (!entry || !entry.token) return false;
  if (typeof entry.expiresAtMs !== "number") return true;
  return Date.now() + CHATGPT_AUTH_REFRESH_SKEW_MS < entry.expiresAtMs;
}

/** 通过 app-server 获取 ChatGPT token；token 只留在 gateway 内部，不暴露给浏览器。 */
async function readChatgptAuth(callAppServer, { refreshToken = false } = {}) {
  if (!refreshToken && isCachedChatgptAuthUsable(CHATGPT_AUTH_CACHE)) {
    return {
      token: CHATGPT_AUTH_CACHE.token,
      claims: CHATGPT_AUTH_CACHE.claims,
    };
  }
  const authStatus = await callAppServer("getAuthStatus", {
    includeToken: true,
    refreshToken,
  });
  const token =
    authStatus && typeof authStatus === "object" && typeof authStatus.authToken === "string"
      ? authStatus.authToken
      : null;
  if (!token) return null;
  const auth = {
    token,
    claims: authClaimsFromToken(token),
    expiresAtMs: jwtExpiresAtMs(token),
  };
  CHATGPT_AUTH_CACHE = auth;
  return {
    token: auth.token,
    claims: auth.claims,
  };
}

/** 构造访问 ChatGPT backend 的 headers。 */
function buildChatgptHeaders(auth, extraHeaders = {}, options = {}) {
  const headers = {
    ...extraHeaders,
    Authorization: `Bearer ${auth.token}`,
    originator: process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE || "Codex Desktop",
    "User-Agent": `Codex Desktop/web-gateway (${process.platform}; ${process.arch})`,
  };
  if (options.attachProductSku !== false) {
    headers["OAI-Product-Sku"] = "CONNECTOR_SETTING";
  }
  if (auth.claims.accountId && !headers["ChatGPT-Account-Id"]) {
    headers["ChatGPT-Account-Id"] = auth.claims.accountId;
  }
  return headers;
}

/** 请求 ChatGPT backend 并解析 JSON 响应。 */
async function fetchChatgptBackendJson(callAppServer, backendPath, options = {}) {
  const response = await fetchChatgptBackendRaw(callAppServer, backendPath, options);
  return response.bodyText ? JSON.parse(response.bodyText) : null;
}

/** logo 请求失败不应阻塞主 UI，因此使用更短 timeout 和空响应兜底。 */
function isChatgptBackendLogoPath(requestPath) {
  return /\/logo(?:[?#]|$)/.test(requestPath);
}

/** 为 ChatGPT backend 请求创建 timeout signal。 */
function createChatgptBackendTimeoutSignal(requestPath) {
  if (typeof AbortSignal === "undefined" || typeof AbortSignal.timeout !== "function") return undefined;
  return AbortSignal.timeout(
    isChatgptBackendLogoPath(requestPath)
      ? CHATGPT_BACKEND_LOGO_TIMEOUT_MS
      : CHATGPT_BACKEND_DEFAULT_TIMEOUT_MS
  );
}

/** 构造一个空成功响应，主要用于 logo 等非关键资源。 */
function emptyChatgptBackendResponse(status = 204) {
  return {
    responseType: "success",
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
    bodyText: "",
    bodyJsonString: "null",
  };
}

/** ChatGPT 任务列表只用于远端/云任务展示；网络不可用时给空列表，不阻塞本地 Codex UI。 */
function emptyChatgptBackendJsonResponse(value, status = 200) {
  const bodyJsonString = JSON.stringify(value);
  return {
    responseType: "success",
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
    bodyText: bodyJsonString,
    bodyJsonString,
  };
}

/** ChatGPT backend GET 缓存按账号/用户/组织隔离。 */
function chatgptBackendCacheScope(auth) {
  const claims = auth && auth.claims && typeof auth.claims === "object" ? auth.claims : {};
  return [
    claims.accountId || "",
    claims.userId || "",
    claims.organizationId || claims.orgId || claims.workspaceId || "",
    claims.plan || "",
  ].join(":");
}

/** gateway 内部代请求 /wham、/aip 等 ChatGPT backend，浏览器不直接接触 token。 */
async function fetchChatgptBackendRaw(callAppServer, backendPath, options = {}) {
  const requestPath = backendPath.startsWith("/") ? backendPath : `/${backendPath}`;
  const url = `https://chatgpt.com/backend-api${requestPath}`;
  const method = String(options.method || "GET").toUpperCase();
  let auth = await readChatgptAuth(callAppServer, { refreshToken: false });
  if (!auth) {
    throw new Error("ChatGPT auth token is not available from app-server");
  }
  const cacheKey = method === "GET" ? `${chatgptBackendCacheScope(auth)}:${requestPath}` : null;
  const cached = cacheKey ? CHATGPT_BACKEND_GET_CACHE.get(cacheKey) : null;
  if (cached && Date.now() < cached.expiresAtMs) return cached.value;
  if (cacheKey && CHATGPT_BACKEND_GET_INFLIGHT.has(cacheKey)) {
    return CHATGPT_BACKEND_GET_INFLIGHT.get(cacheKey);
  }

  const run = async () => {
  // 401 时强制刷新 token 后重试一次，避免账号信息偶发过期导致 UI 卡住。
  const fetchBackend = (authForRequest) =>
    fetch(url, {
      method,
      headers: buildChatgptHeaders(authForRequest, options.headers || {}, {
        attachProductSku: options.attachProductSku,
      }),
      body: options.body,
      signal: createChatgptBackendTimeoutSignal(requestPath),
    });
  let response = await fetchBackend(auth);
  if (response.status === 401) {
    CHATGPT_AUTH_CACHE = null;
    CHATGPT_BACKEND_GET_CACHE.clear();
    auth = await readChatgptAuth(callAppServer, { refreshToken: true });
    if (auth) {
      response = await fetchBackend(auth);
    }
  }
  const text = await response.text();
  const contentType = response.headers.get("content-type") || "";
  let bodyJsonString = text && text.length > 0 ? text : "null";
  if (!contentType.includes("application/json") && text && text.length > 0) {
    try {
      JSON.parse(text);
    } catch {
      bodyJsonString = JSON.stringify(text);
    }
  }
  return {
    responseType: "success",
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    bodyText: text,
    bodyJsonString,
  };
  };

  const promise = run().catch((error) => {
    if (method === "GET" && isChatgptBackendLogoPath(requestPath)) {
      return emptyChatgptBackendResponse();
    }
    if (method === "GET" && requestPath.startsWith("/wham/tasks/list")) {
      return emptyChatgptBackendJsonResponse({ items: [], cursor: null });
    }
    if (method === "GET" && requestPath.startsWith("/wham/usage")) {
      return emptyChatgptBackendJsonResponse(null);
    }
    throw error;
  }).then((value) => {
    if (cacheKey) {
      const ttlMs = isChatgptBackendLogoPath(requestPath)
        ? CHATGPT_BACKEND_LOGO_TTL_MS
        : CHATGPT_BACKEND_DEFAULT_TTL_MS;
      CHATGPT_BACKEND_GET_CACHE.set(cacheKey, { value, expiresAtMs: Date.now() + ttlMs });
    }
    return value;
  }).finally(() => {
    if (cacheKey) CHATGPT_BACKEND_GET_INFLIGHT.delete(cacheKey);
  });
  if (cacheKey) CHATGPT_BACKEND_GET_INFLIGHT.set(cacheKey, promise);
  return promise;
}

/** 听写接口：浏览器上传音频到 gateway，由 gateway 带 token 转发给 ChatGPT。 */
async function transcribeAudioViaChatgpt(callAppServer, payload) {
  const params = payload && typeof payload === "object" ? payload : {};
  const body =
    typeof params.bodyBase64 === "string"
      ? Buffer.from(params.bodyBase64, "base64")
      : typeof params.body === "string"
        ? params.body
        : undefined;
  if (body === undefined) {
    throw new Error("Missing transcription audio body");
  }
  const headers = {};
  const incomingHeaders = params.headers && typeof params.headers === "object" ? params.headers : {};
  for (const [key, value] of Object.entries(incomingHeaders)) {
    if (value == null) continue;
    const normalized = key.toLowerCase();
    if (normalized === "content-type" || normalized === "accept" || normalized === "openai-beta") {
      headers[key] = String(value);
    }
  }
  const proxied = await fetchChatgptBackendRaw(callAppServer, "/transcribe", {
    method: "POST",
    headers,
    body,
    attachProductSku: false,
  });
  if (proxied.status < 200 || proxied.status >= 300) {
    const detail = String(proxied.bodyText || "").trim();
    throw new Error(
      detail
        ? `Transcription failed with status ${proxied.status}: ${detail.slice(0, 200)}`
        : `Transcription failed with status ${proxied.status}`
    );
  }
  try {
    return JSON.parse(proxied.bodyJsonString || proxied.bodyText || "{}");
  } catch {
    return { text: proxied.bodyText || "" };
  }
}

/** 从 app-server account/read 和 token claim 合成 renderer 需要的账号信息。 */
async function accountInfoFromCodexAccount(callAppServer, payload) {
  let accountResult = null;
  try {
    accountResult = await callAppServer("account/read", payload);
  } catch {}
  const account =
    accountResult && typeof accountResult === "object" && accountResult.account
      ? accountResult.account
      : null;
  let tokenClaims = {};
  try {
    const auth = await readChatgptAuth(callAppServer, { refreshToken: false });
    tokenClaims = auth ? auth.claims : {};
  } catch {}
  if (!account || typeof account !== "object") {
    return {
      accountId: tokenClaims.accountId || null,
      userId: tokenClaims.userId || null,
      plan: tokenClaims.plan || null,
      email: tokenClaims.email || null,
    };
  }
  return {
    accountId:
      tokenClaims.accountId ||
      (typeof account.accountId === "string" && account.accountId) ||
      (typeof account.account_id === "string" && account.account_id) ||
      (typeof account.id === "string" && account.id) ||
      null,
    userId:
      tokenClaims.userId ||
      (typeof account.userId === "string" && account.userId) ||
      (typeof account.user_id === "string" && account.user_id) ||
      null,
    plan:
      tokenClaims.plan ||
      (typeof account.plan === "string" && account.plan) ||
      (typeof account.planType === "string" && account.planType) ||
      null,
    email: tokenClaims.email || (typeof account.email === "string" && account.email ? account.email : null),
  };
}

/** 调真实 /wham/accounts/check，不再返回 mock 账号数据。 */
async function buildWhamAccountsCheck(callAppServer, logger) {
  try {
    return await fetchChatgptBackendJson(callAppServer, "/wham/accounts/check");
  } catch (error) {
    logger && logger.warn("[wham] real /wham/accounts/check failed", error);
    throw error;
  }
}

/** 把 /wham/accounts/check 响应转成旧 accounts/check 的兼容结构。 */
async function buildAccountsCheck(callAppServer, logger) {
  const wham = await buildWhamAccountsCheck(callAppServer, logger);
  return {
    accounts: Object.fromEntries(
      wham.accounts.map((account) => [
        account.id,
        {
          account: account.account || {
            id: account.id,
            email: account.email || "",
            account_user_role: "member",
          },
        },
      ])
    ),
  };
}

function createChatgptBackendIpcHandlers(deps) {
  const callAppServer = deps.callAppServer;
  const logger = deps.logger;
  return {
    parseMaybeJson,
    normalizeFetchHeaders,
    summarizeSdkException,
    fetchChatgptBackendRaw: (backendPath, options) => fetchChatgptBackendRaw(callAppServer, backendPath, options),
    transcribeAudioViaChatgpt: (payload) => transcribeAudioViaChatgpt(callAppServer, payload),
    accountInfoFromCodexAccount: (payload) => accountInfoFromCodexAccount(callAppServer, payload),
    buildWhamAccountsCheck: () => buildWhamAccountsCheck(callAppServer, logger),
    buildAccountsCheck: () => buildAccountsCheck(callAppServer, logger),
  };
}

module.exports = {
  createChatgptBackendIpcHandlers,
  normalizeFetchHeaders,
  parseMaybeJson,
  summarizeSdkException,
};
