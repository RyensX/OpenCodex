// @ts-nocheck
export {};

function createAppServerBridge(deps) {
  const appServer = deps.appServer;
  const logger = deps.logger;
  const APP_SERVER_METHOD_ALIASES = deps.appServerMethodAliases;
  const WARNED_UNSUPPORTED_FEATURE_ENABLEMENTS = deps.warnedUnsupportedFeatureEnablements;
  const filterUnsupportedFeatureEnablements = deps.filterUnsupportedFeatureEnablements;
  const patchCodexConfigResult = deps.patchCodexConfigResult;

  /** renderer 需要这个时间才能把历史折叠摘要显示成“已处理 xs”。 */
  function isFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
  }

  function enrichWorkedForTurnTiming(turn) {
    if (!turn || typeof turn !== "object" || !Array.isArray(turn.items)) return turn;
    if (turn.firstTurnWorkItemStartedAt != null) return turn;
    const existingMs = turn.firstTurnWorkItemStartedAtMs;
    if (isFiniteNumber(existingMs)) {
      return { ...turn, firstTurnWorkItemStartedAt: existingMs / 1000 };
    }
    const hasWorkItem = turn.items.some(
      (item) => item && typeof item === "object" && item.type !== "userMessage" && item.type !== "hookPrompt"
    );
    if (!hasWorkItem) return turn;
    const completedAt = turn.completedAt;
    const durationMs = turn.durationMs;
    if (isFiniteNumber(completedAt) && isFiniteNumber(durationMs) && durationMs >= 0) {
      const firstTurnWorkItemStartedAt = completedAt - durationMs / 1000;
      return {
        ...turn,
        firstTurnWorkItemStartedAt,
        firstTurnWorkItemStartedAtMs: firstTurnWorkItemStartedAt * 1000,
      };
    }
    const startedAt = turn.startedAt;
    if (!isFiniteNumber(startedAt)) return turn;
    return {
      ...turn,
      firstTurnWorkItemStartedAt: startedAt,
      firstTurnWorkItemStartedAtMs: startedAt * 1000,
    };
  }

  function enrichWorkedForThreadTimings(thread) {
    if (!thread || typeof thread !== "object" || !Array.isArray(thread.turns)) return thread;
    let changed = false;
    const turns = thread.turns.map((turn) => {
      const enriched = enrichWorkedForTurnTiming(turn);
      if (enriched !== turn) changed = true;
      return enriched;
    });
    return changed ? { ...thread, turns } : thread;
  }

  function enrichWorkedForAppServerResult(method, result) {
    if (!result || typeof result !== "object") return result;
    if (method === "thread/resume" || method === "thread/read") {
      const thread = enrichWorkedForThreadTimings(result.thread);
      return thread !== result.thread ? { ...result, thread } : result;
    }
    if (method === "thread/turns/list" && Array.isArray(result.data)) {
      let changed = false;
      const data = result.data.map((turn) => {
        const enriched = enrichWorkedForTurnTiming(turn);
        if (enriched !== turn) changed = true;
        return enriched;
      });
      return changed ? { ...result, data } : result;
    }
    return result;
  }

  /** 转发业务请求到 app-server，并统一记录失败日志。 */
  async function callAppServer(method, payload) {
    const appServerMethod = APP_SERVER_METHOD_ALIASES.get(method) || method;
    let appServerPayload = payload;
    if (appServerMethod === "experimentalFeature/enablement/set") {
      const filtered = filterUnsupportedFeatureEnablements(payload);
      appServerPayload = filtered.payload;
      if (filtered.removed.length > 0) {
        for (const featureName of filtered.removed) {
          if (WARNED_UNSUPPORTED_FEATURE_ENABLEMENTS.has(featureName)) continue;
          WARNED_UNSUPPORTED_FEATURE_ENABLEMENTS.add(featureName);
          logger && logger.warn(`[app-server] ignoring unsupported feature enablement: ${featureName}`);
        }
      }
      if (filtered.skipped) {
        return { enablement: {} };
      }
    }
    try {
      if (!appServer || !appServer.isConnected()) {
        throw new Error(`app-server is not connected for ${appServerMethod}`);
      }
      return enrichWorkedForAppServerResult(appServerMethod, await appServer.request(appServerMethod, appServerPayload));
    } catch (error) {
      logger && logger.warn(`[app-server] ${appServerMethod} failed`, error);
      throw error;
    }
  }

  /** renderer 对 app-server 反向请求的响应入口。 */
  async function respondToAppServerRequest(payload) {
    const response =
      payload && typeof payload === "object"
        ? payload.response || payload.message || payload
        : null;
    if (!response || typeof response !== "object" || !Object.prototype.hasOwnProperty.call(response, "id")) {
      throw new Error("mcp-response is missing response.id");
    }
    if (!appServer || typeof appServer.respondToServerRequest !== "function") {
      throw new Error("app-server does not support server request responses");
    }
    return appServer.respondToServerRequest(response);
  }

  /** 读取 Codex 配置：业务配置必须来自 app-server，失败就让前端看到真实错误。 */
  async function readCodexConfig(payload) {
    const params = payload && typeof payload === "object" && payload.params ? payload.params : payload;
    const includeLayers = !!(params && typeof params === "object" && params.includeLayers);
    const request = {
      includeLayers,
      cwd:
        params && typeof params === "object" && typeof params.cwd === "string" && params.cwd.trim()
          ? params.cwd
          : null,
    };
    return patchCodexConfigResult(await callAppServer("config/read", request));
  }

  /** list-models-for-host 参数归一化。 */
  function normalizeListModelsForHostParams(payload) {
    const params = payload && typeof payload === "object" && payload.params ? payload.params : payload;
    const input = params && typeof params === "object" && !Array.isArray(params) ? params : {};
    const limit = Number(input.limit);
    const cursor = input.cursor == null ? null : String(input.cursor);
    return {
      hostId: typeof input.hostId === "string" && input.hostId.trim() ? input.hostId : "local",
      includeHidden: input.includeHidden !== false,
      cursor,
      limit: Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 100,
    };
  }

  /** list-models-for-host 通过 app-server model/list 实现，并在 gateway 做分页/过滤。 */
  async function listModelsForHost(payload) {
    const params = normalizeListModelsForHostParams(payload);
    const result = await callAppServer("model/list", {});
    const sourceModels = Array.isArray(result && result.data) ? result.data : Array.isArray(result) ? result : [];
    const visibleModels = params.includeHidden ? sourceModels : sourceModels.filter((model) => !model || model.hidden !== true);
    const cursorOffset = params.cursor && /^\d+$/.test(params.cursor) ? Number(params.cursor) : 0;
    const start = Math.max(0, cursorOffset);
    const end = Math.min(visibleModels.length, start + params.limit);
    return {
      ...(result && typeof result === "object" && !Array.isArray(result) ? result : {}),
      data: visibleModels.slice(start, end),
      nextCursor: end < visibleModels.length ? String(end) : null,
      hostId: params.hostId,
    };
  }

  return {
    callAppServer,
    listModelsForHost,
    readCodexConfig,
    respondToAppServerRequest,
  };
}

module.exports = {
  createAppServerBridge,
};
