// @ts-nocheck
export {};

const path = require("path");

function createFetchIpcHandlers(deps) {
  const broadcast = deps.broadcast;
  const logger = deps.logger;
  const chatgptBackend = deps.chatgptBackend;
  const targetClientIdForContext = deps.targetClientIdForContext;
  const withTargetClient = deps.withTargetClient;
  const invokeCodexChannel = deps.invokeCodexChannel;
  const shouldPatchStatsigInitialize = deps.shouldPatchStatsigInitialize;
  const patchStatsigDefaultFeatures = deps.patchStatsigDefaultFeatures;
  const buildStatsigDefaultInitializeResponse = deps.buildStatsigDefaultInitializeResponse;
  const STATSIG_DEFAULT_FEATURE_OVERRIDES = deps.statsigDefaultFeatureOverrides;

  /** 发送 JSON fetch-response。 */
  function broadcastFetchResponse(requestId, value, status = 200, targetClientId = "") {
    if (typeof broadcast !== "function") return;
    broadcast(withTargetClient({
      channel: "fetch-response",
      payload: {
        requestId,
        responseType: "success",
        status,
        headers: { "content-type": "application/json; charset=utf-8" },
        bodyJsonString: JSON.stringify(value),
      },
    }, targetClientId));
  }

  /** 发送原始 HTTP 形态 fetch-response。 */
  function broadcastFetchHttpResponse(requestId, response, targetClientId = "") {
    if (typeof broadcast !== "function") return;
    broadcast(withTargetClient({
      channel: "fetch-response",
      payload: response,
    }, targetClientId));
  }

  /** 发送 fetch 错误响应；details 用于把 vscode://codex/... 等来源信息带回前端 toast。 */
  function broadcastFetchError(requestId, error, status = 500, targetClientId = "", details = {}) {
    if (typeof broadcast !== "function") return;
    broadcast(withTargetClient({
      channel: "fetch-response",
      payload: {
        requestId,
        responseType: "error",
        status,
        error: error instanceof Error ? error.message : String(error),
        ...(details && typeof details === "object" ? details : {}),
      },
    }, targetClientId));
  }

  /** 告诉 web-shell 某个 fetch stream 已结束。 */
  function broadcastFetchStreamComplete(requestId, targetClientId = "") {
    if (typeof broadcast !== "function") return;
    broadcast(withTargetClient({
      channel: "fetch-stream-complete",
      payload: { requestId },
    }, targetClientId));
  }

  /** CES/Segment 遥测在 Web gateway 中不是业务依赖；受限网络下直接 ACK。 */
  function isTelemetryRegisterUrl(urlObject) {
    if (!urlObject || urlObject.hostname !== "chatgpt.com") return false;
    const pathname = urlObject.pathname.replace(/\/+$/, "");
    return pathname === "/ces/v1/rgstr" || pathname === "/ces/v1/log_event";
  }

  /** 处理 renderer 发起的 fetch/request，包括 vscode://codex、/wham、/aip 等内部代理。 */
  async function handleFetchMessage(message, context = {}) {
    const targetClientId = targetClientIdForContext(context);
    const requestId = String(message.requestId || "");
    const url = String(message.url || "");
    const rawBody = message.body;
    const body = chatgptBackend.parseMaybeJson(message.body);
    const urlObject = (() => {
      try {
        return new URL(url);
      } catch {
        return null;
      }
    })();
    const pathname = urlObject ? urlObject.pathname : url.split("?")[0].split("#")[0];
    logger && logger.info(`[fetch] ${url}`, {
      requestId,
      method: String(message.method || ""),
      bodyShape:
        body === null
          ? "null"
          : Array.isArray(body)
            ? `array(${body.length})`
            : typeof body === "object"
              ? `object(${Object.keys(body).length})`
              : typeof body,
    });

    try {
      if (url.startsWith("vscode://codex/")) {
        // renderer 把部分 Electron 行为编码成 vscode://codex/...，这里再转回业务 IPC。
        const endpoint = url.slice("vscode://codex/".length);
        const value = await invokeCodexChannel(endpoint, body, context);
        if (
          endpoint === "open-file" &&
          value &&
          typeof value === "object" &&
          typeof value.url === "string" &&
          value.url.length > 0 &&
          typeof broadcast === "function"
        ) {
          const valuePath = typeof value.path === "string" ? value.path : "";
          broadcast(withTargetClient({
            channel: "codex-web:preview-file",
            payload: {
              requestId,
              url: value.url,
              path: valuePath || null,
              name: typeof value.name === "string" && value.name ? value.name : valuePath ? path.basename(valuePath) : null,
            },
          }, targetClientId));
        }
        broadcastFetchResponse(requestId, value, 200, targetClientId);
        return true;
      }

      if (pathname === "/wham/accounts/check") {
        broadcastFetchResponse(requestId, await chatgptBackend.buildWhamAccountsCheck(), 200, targetClientId);
        return true;
      }

      if (pathname.startsWith("/accounts/check/")) {
        broadcastFetchResponse(requestId, await chatgptBackend.buildAccountsCheck(), 200, targetClientId);
        return true;
      }

      if (pathname === "/transcribe") {
        const headers = chatgptBackend.normalizeFetchHeaders(message.headers);
        const isBase64Body = Object.entries(headers).some(
          ([key, value]) => key.toLowerCase() === "x-codex-base64" && String(value) === "1"
        );
        const value = await chatgptBackend.transcribeAudioViaChatgpt({
          ...(isBase64Body
            ? { bodyBase64: typeof rawBody === "string" ? rawBody : String(rawBody || "") }
            : { body: typeof rawBody === "string" ? rawBody : JSON.stringify(body ?? null) }),
          headers,
        });
        broadcastFetchHttpResponse(requestId, {
          requestId,
          responseType: "success",
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" },
          bodyText: JSON.stringify(value),
          bodyJsonString: JSON.stringify(value),
        }, targetClientId);
        return true;
      }

      if (pathname.startsWith("/wham/") || pathname.startsWith("/aip/") || pathname.startsWith("/files/")) {
        // 这些请求必须由 gateway 带 token 代理，远端浏览器不能直接访问底层后端。
        const backendPath = urlObject ? `${urlObject.pathname}${urlObject.search}` : url;
        const proxied = await chatgptBackend.fetchChatgptBackendRaw(backendPath, {
          method: String(message.method || "GET"),
          headers: chatgptBackend.normalizeFetchHeaders(message.headers),
          body:
            body !== undefined && String(message.method || "GET").toUpperCase() !== "GET"
              ? typeof body === "string"
                ? body
                : JSON.stringify(body)
              : undefined,
        });
        broadcastFetchHttpResponse(requestId, {
          requestId,
          ...proxied,
        }, targetClientId);
        return true;
      }

      if (url.startsWith("http://") || url.startsWith("https://")) {
        // 普通 http(s) fetch 由 gateway 代理，statsig initialize 会顺手 patch Web 必需 feature。
        if (isTelemetryRegisterUrl(urlObject)) {
          broadcastFetchHttpResponse(requestId, {
            requestId,
            responseType: "success",
            status: 200,
            headers: { "content-type": "application/json; charset=utf-8" },
            bodyText: "{}",
            bodyJsonString: "{}",
          }, targetClientId);
          return true;
        }
        if (urlObject && urlObject.hostname === "statsigapi.net" && urlObject.pathname === "/v1/sdk_exception") {
          logger && logger.warn("[renderer-sdk-exception]", chatgptBackend.summarizeSdkException(body));
        }
        const headers = chatgptBackend.normalizeFetchHeaders(message.headers);
        const init = {
          method: String(message.method || "GET"),
          headers,
          redirect: "follow",
        };
        if (body !== undefined && init.method !== "GET" && init.method !== "HEAD") {
          init.body = typeof body === "string" ? body : JSON.stringify(body);
        }
        const response = await fetch(url, init).catch((error) => {
          if (!shouldPatchStatsigInitialize(urlObject)) throw error;
          return null;
        });
        if (response == null) {
          const text = JSON.stringify(buildStatsigDefaultInitializeResponse());
          logger && logger.warn("[statsig] initialize unavailable; using gateway feature defaults");
          broadcastFetchHttpResponse(requestId, {
            requestId,
            responseType: "success",
            status: 200,
            headers: { "content-type": "application/json; charset=utf-8" },
            bodyText: text,
            bodyJsonString: text,
          }, targetClientId);
          return true;
        }
        const contentType = response.headers.get("content-type") || "";
        let text = await response.text();
        const headerObject = Object.fromEntries(response.headers.entries());
        const statsigPatch = shouldPatchStatsigInitialize(urlObject) ? patchStatsigDefaultFeatures(text) : null;
        if (statsigPatch != null) {
          text = statsigPatch;
          headerObject["content-type"] = "application/json; charset=utf-8";
          delete headerObject["content-length"];
          delete headerObject["content-encoding"];
          logger && logger.info("[statsig] enabled gateway feature gates", {
            gates: Object.keys(STATSIG_DEFAULT_FEATURE_OVERRIDES),
          });
        }
        const fetchPayload = {
          requestId,
          responseType: "success",
          status: response.status,
          headers: headerObject,
          bodyText: text,
          bodyJsonString: text && text.length > 0 ? text : "null",
        };
        if (!contentType.includes("application/json") && text && text.length > 0) {
          try {
            JSON.parse(text);
          } catch {
            fetchPayload.bodyJsonString = JSON.stringify(text);
          }
        }
        broadcastFetchHttpResponse(requestId, fetchPayload, targetClientId);
        return true;
      }

      broadcastFetchResponse(requestId, null, 200, targetClientId);
      return true;
    } catch (error) {
      logger.warn(`[fetch] ${url} failed`, error);
      // fetch 形态的 IPC 不走 invoke 响应体，必须把 url 带回 WebSocket 消息，前端才能展示具体失败来源。
      broadcastFetchError(requestId, error, 500, targetClientId, { url });
      return false;
    }
  }

  /** fetch-stream 目前只需要把完成事件定向发回前端。 */
  async function handleFetchStreamMessage(message, context = {}) {
    const requestId = String(message.requestId || "");
    const targetClientId = targetClientIdForContext(context);
    try {
      broadcastFetchStreamComplete(requestId, targetClientId);
      return true;
    } catch (error) {
      logger.warn(`[fetch-stream] ${String(message.url || "")} failed`, error);
      if (typeof broadcast === "function") {
        broadcast(withTargetClient({
          channel: "fetch-stream-error",
          payload: {
            requestId,
            url: String(message.url || ""),
            error: error instanceof Error ? error.message : String(error),
          },
        }, targetClientId));
      }
      return false;
    }
  }

  /** 对 renderer 来说只需要 ACK 的长任务，后台执行并通过广播返回结果。 */

  return {
    handleFetchMessage,
    handleFetchStreamMessage,
  };
}

module.exports = {
  createFetchIpcHandlers,
};
