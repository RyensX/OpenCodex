const { diagnosticLog, diagnosticWarn } = require("../core/diagnostics.cjs");
const { createClassifier } = require("./classifier.cjs");
const { createModelCatalog } = require("./catalog.cjs");
const { createRoutingContext, summarizeUserInput, userInputsFromTurns } = require("./context.cjs");
const {
  AUTO_REASONING_EFFORT,
  CLASSIFICATION_TIMEOUT_MS,
  EFFORT_ORDER,
  SMART_ROUTER_PLUGIN_ID,
  TIER_ORDER,
} = require("./constants.cjs");
const {
  applyClassificationPolicy,
  resolveClassifierRoute,
  resolveFallbackRoute,
  resolveTierRoute,
  routeSettings,
} = require("./resolver.cjs");
const { createAutoStateStore } = require("./state-store.cjs");
const { createAppServerTransport } = require("./transport.cjs");
const { createTurnRouteStatus } = require("./turn-route-status.cjs");
const { createVirtualModelController, isAuto, requestKey } = require("./virtual-model.cjs");

function createSmartModelRouterService({ configStore, stateFilePath, classifierOptions = {}, injectionHealth = null }) {
  const stateStore = createAutoStateStore({ filePath: stateFilePath });
  const catalog = createModelCatalog();
  const historyByThread = new Map();
  const usageByThread = new Map();
  const externalRequests = new Map();
  const threadRoutingChains = new Map();
  const turnRouteStatus = createTurnRouteStatus();
  const routeStatusListeners = new Set();
  let catalogRefreshPromise = null;

  function emitRouteStatus(event) {
    for (const listener of Array.from(routeStatusListeners)) {
      try {
        // 展示事件只携带状态和安全路由摘要，不能把分类 rationale 或用户输入带出核心。
        listener(event);
      } catch {}
    }
  }

  function pluginConfig() {
    return configStore.plugin(SMART_ROUTER_PLUGIN_ID) || { enabled: false, values: {} };
  }

  function isEnabled() {
    return pluginConfig().enabled === true;
  }

  function fallbackRoute() {
    return resolveFallbackRoute({ configValues: pluginConfig().values, models: catalog.models() });
  }

  function modelDisplayName(modelId) {
    const normalizedModelId = String(modelId || "");
    if (!normalizedModelId) return "";
    const model = catalog
      .models()
      .find((candidate) => String(candidate?.model || candidate?.id || "") === normalizedModelId);
    // 展示名称来自当前账号的真实模型目录；目录尚未就绪时保守回退到协议 ID。
    return String(model?.displayName || normalizedModelId).trim() || normalizedModelId;
  }

  function currentAutoRoute(threadId) {
    const normalizedThreadId = String(threadId || "");
    if (!normalizedThreadId || !isEnabled() || !stateStore.isThreadAuto(normalizedThreadId)) return null;
    const active = turnRouteStatus.activeRoute(normalizedThreadId);
    if (active) return active;
    const previous = stateStore.threadState(normalizedThreadId);
    if (!previous?.lastModel || !previous.lastEffort) return null;
    // 空闲时继续返回最近一次具体调度；turnId 留空，避免被调用方误判为仍在执行。
    return {
      threadId: normalizedThreadId,
      turnId: "",
      tier: previous.lastTier,
      model: previous.lastModel,
      effort: previous.lastEffort,
      fallback: false,
    };
  }

  function emitCurrentAutoRoute(threadId) {
    const route = currentAutoRoute(threadId);
    if (route) emitRouteStatus({ status: "idle", threadId: String(threadId || ""), route });
    else emitRouteStatus({ status: "cleared", threadId: String(threadId || "") });
  }

  let virtualModel;
  let classifier;
  const transport = createAppServerTransport({
    processClientMessage: (message) => processClientMessage(message),
    processServerMessage: (message) => processServerMessage(message),
    onClosed() {
      catalog.clear();
      catalogRefreshPromise = null;
      // App Server 连接断开即表示没有仍可确认的真实执行，防止任务摘要显示过期状态。
      turnRouteStatus.clearAll();
    },
    onAttached() {
      injectionHealth?.reportGateway("app-server-router");
    },
  });
  virtualModel = createVirtualModelController({
    stateStore,
    isEnabled,
    fallbackRoute,
    catalog,
    onAutoModelInjected() {
      injectionHealth?.reportGateway("auto-model-catalog");
    },
  });
  classifier = createClassifier({ transport, ...classifierOptions });

  if (!isEnabled()) stateStore.clearAllAuto();
  const stopConfigListener = configStore.onChanged((event) => {
    if (event.id !== SMART_ROUTER_PLUGIN_ID) return;
    if (!event.current.enabled) stateStore.clearAllAuto();
  });

  function remainingRouteMs(deadlineAt, cap) {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) {
      const error = new Error("Smart scheduling deadline exceeded");
      error.category = "timeout";
      throw error;
    }
    return Math.max(1, Math.min(remaining, cap || remaining));
  }

  async function refreshCatalog(deadlineAt = 0) {
    if (!transport.isAttached()) return catalog.models();
    if (catalogRefreshPromise) return catalogRefreshPromise;
    catalogRefreshPromise = (async () => {
      let cursor = null;
      let pages = 0;
      do {
        const result = await transport.request(
          "model/list",
          { cursor, limit: 100, includeHidden: false },
          { timeoutMs: deadlineAt ? remainingRouteMs(deadlineAt, 5_000) : 5_000 }
        );
        catalog.observePage({ cursor, result });
        cursor = result?.nextCursor || null;
        pages += 1;
      } while (cursor && pages < 20);
      return catalog.models();
    })()
      .catch((error) => {
        diagnosticWarn("model-router", "catalog_refresh_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        return catalog.models();
      })
      .finally(() => {
        catalogRefreshPromise = null;
      });
    return catalogRefreshPromise;
  }

  async function recentHistory(threadId, deadlineAt = 0) {
    if (historyByThread.has(threadId)) return historyByThread.get(threadId);
    try {
      const result = await transport.request(
        "thread/turns/list",
        { threadId, cursor: null, limit: 6, sortDirection: "desc", itemsView: "full" },
        { timeoutMs: deadlineAt ? remainingRouteMs(deadlineAt, 4_000) : 4_000 }
      );
      // desc 页先倒序为时间正序，再抽取最近六条用户输入。
      const history = userInputsFromTurns([...(Array.isArray(result?.data) ? result.data : [])].reverse());
      historyByThread.set(threadId, history);
      return history;
    } catch {
      historyByThread.set(threadId, []);
      return [];
    }
  }

  function appendUserInput(threadId, input) {
    if (!threadId) return;
    const history = historyByThread.get(threadId) || [];
    history.push(summarizeUserInput(input));
    while (history.length > 6) history.shift();
    historyByThread.set(threadId, history);
  }

  function rewriteTurn(message, route) {
    const params = message.params || (message.params = {});
    params.model = route.model;
    params.effort = route.effort;
    if (params.collaborationMode?.settings) {
      // collaborationMode 在 App Server 中优先于顶层 model/effort，两组字段必须同步改写。
      params.collaborationMode.settings.model = route.model;
      params.collaborationMode.settings.reasoning_effort = route.effort;
    }
    return message;
  }

  function concreteGuard(message, route) {
    const params = message?.params;
    if (!params || typeof params !== "object") return message;
    const concrete = route || fallbackRoute();
    if (isAuto(params.model)) params.model = concrete.model;
    if (isAuto(params.config?.model)) params.config.model = concrete.model;
    if (isAuto(params.collaborationMode?.settings?.model)) {
      params.collaborationMode.settings.model = concrete.model;
      params.collaborationMode.settings.reasoning_effort = concrete.effort;
    }
    if (message.method === "config/value/write" && message.params?.keyPath === "model" && isAuto(message.params.value)) {
      message.params.value = concrete.model;
    }
    if (message.method === "config/batchWrite") {
      for (const edit of Array.isArray(message.params?.edits) ? message.params.edits : []) {
        if (edit?.keyPath === "model" && isAuto(edit.value)) edit.value = concrete.model;
      }
    }
    return message;
  }

  async function routeAutoTurn(message, threadId) {
    const startedAt = Date.now();
    const deadlineAt = startedAt + CLASSIFICATION_TIMEOUT_MS;
    let route;
    let errorCategory = "";
    try {
      if (catalog.models().length === 0) await refreshCatalog(deadlineAt);
      const history = await recentHistory(threadId, deadlineAt);
      const threadState = stateStore.threadState(threadId) || {};
      const context = createRoutingContext({
        input: message.params?.input,
        history,
        lastRoute: {
          tier: threadState.lastTier,
          model: threadState.lastModel,
          effort: threadState.lastEffort,
        },
        usage: usageByThread.get(threadId),
        previousStatus: threadState.lastStatus,
      });
      const configValues = pluginConfig().values;
      const automaticEffortTiers = TIER_ORDER.filter(
        (tier) => routeSettings(configValues, tier).effort === AUTO_REASONING_EFFORT
      );
      const classifierRoute = resolveClassifierRoute({
        configValues,
        models: catalog.models(),
      });
      const result = await classifier.classify({
        context,
        model: classifierRoute.model,
        effort: classifierRoute.effort,
        automaticEffortTiers,
        deadlineAt,
      });
      const classification = applyClassificationPolicy(result.classification, threadState.lastStatus);
      if (automaticEffortTiers.includes(classification.tier) && !EFFORT_ORDER.includes(classification.effort)) {
        const error = new Error("Classifier omitted effort for an automatic-effort tier");
        error.category = "invalid_schema";
        throw error;
      }
      route = resolveTierRoute({
        tier: classification.tier,
        classificationEffort: classification.effort,
        configValues,
        models: catalog.models(),
      });
    } catch (error) {
      errorCategory = String(error?.category || "classification");
      route = fallbackRoute();
    }
    rewriteTurn(message, route);
    turnRouteStatus.select({
      requestKey: requestKey(message.id),
      threadId,
      route,
    });
    emitRouteStatus({ status: "selected", threadId, route });
    // 分类期间用户可能已经切回手动模型；此时仍完成已开始的当前回合，但不能覆盖新的手动状态。
    if (stateStore.isThreadAuto(threadId)) stateStore.recordRoute(threadId, route);
    diagnosticLog("model-router", "route_selected", {
      tier: route.tier,
      model: route.model,
      effort: route.effort,
      elapsedMs: Date.now() - startedAt,
      fallback: route.fallback === true,
      ...(errorCategory ? { error: errorCategory } : {}),
    });
    return message;
  }

  async function routeAutoTurnInThreadOrder(message, threadId) {
    const previous = threadRoutingChains.get(threadId) || Promise.resolve();
    const current = previous.catch(() => {}).then(() => routeAutoTurn(message, threadId));
    threadRoutingChains.set(threadId, current);
    try {
      return await current;
    } finally {
      if (threadRoutingChains.get(threadId) === current) threadRoutingChains.delete(threadId);
    }
  }

  async function processClientMessage(original) {
    if (original?.id != null && typeof original.method === "string") {
      externalRequests.set(requestKey(original.id), {
        method: original.method,
        requestKey: requestKey(original.id),
        threadId: String(original.params?.threadId || ""),
      });
    }
    const prepared = virtualModel.prepareClientMessage(original);
    const message = prepared.message;
    if (message?.method === "thread/settings/update" && prepared.meta?.threadId) {
      // 模型选择一提交就同步摘要状态；若官方拒绝，响应处理会按回滚后的状态再次校正。
      emitCurrentAutoRoute(prepared.meta.threadId);
    } else if (message?.method === "turn/start") {
      const threadId = String(message.params?.threadId || "");
      // 同一线程严格按 turn 顺序路由，不同线程仍可并发占用两个分类 permit。
      if (prepared.autoTurn) {
        emitRouteStatus({ status: "classifying", threadId });
        await routeAutoTurnInThreadOrder(message, threadId);
      } else {
        emitRouteStatus({ status: "cleared", threadId });
      }
      appendUserInput(threadId, message.params?.input);
    }
    return concreteGuard(message);
  }

  function filterInternalThreads(message, meta) {
    if (!meta || !["thread/list", "thread/search", "thread/loaded/list"].includes(meta.method)) return message;
    const data = message?.result?.data;
    if (!Array.isArray(data)) return message;
    return {
      ...message,
      result: {
        ...message.result,
        data: data.filter((thread) => !transport.isInternalThreadId(thread?.id)),
      },
    };
  }

  function observeServerNotification(message) {
    if (!message?.method || !message.params) return;
    const threadId = String(message.params.threadId || message.params.thread?.id || "");
    if (message.method === "thread/tokenUsage/updated" && threadId) {
      usageByThread.set(threadId, message.params.tokenUsage);
    }
    if (message.method === "thread/deleted" && threadId) {
      historyByThread.delete(threadId);
      usageByThread.delete(threadId);
    }
  }

  function processServerMessage(original) {
    observeServerNotification(original);
    const key = original?.id != null ? requestKey(original.id) : "";
    const meta = key ? externalRequests.get(key) : null;
    if (key) externalRequests.delete(key);
    const filtered = filterInternalThreads(original, meta);
    if (meta?.method === "thread/turns/list" && meta.threadId && Array.isArray(filtered?.result?.data)) {
      const history = userInputsFromTurns([...filtered.result.data].reverse());
      historyByThread.set(meta.threadId, history);
    }
    const withRouteStatus = turnRouteStatus.processServerMessage(filtered, meta);
    const threadId = String(withRouteStatus?.params?.threadId || withRouteStatus?.params?.thread?.id || meta?.threadId || "");
    const processed = virtualModel.processServerMessage(withRouteStatus);
    if (withRouteStatus?.method === "turn/started" && threadId) {
      const route = turnRouteStatus.activeRoute(threadId);
      if (route) emitRouteStatus({ status: "started", threadId, route });
    } else if (["turn/completed", "turn/failed", "turn/interrupted"].includes(withRouteStatus?.method) && threadId) {
      // 回合结束只退出运行态；Auto 未关闭时，摘要继续展示刚完成的分类结果。
      emitCurrentAutoRoute(threadId);
    } else if (withRouteStatus?.id != null && meta?.method === "turn/start" && withRouteStatus.error && threadId) {
      emitCurrentAutoRoute(threadId);
    } else if (withRouteStatus?.id != null && meta?.method === "thread/settings/update" && withRouteStatus.error && threadId) {
      // virtual model 已在失败响应中恢复旧选择，此处把回滚后的 Auto 状态同步给展示层。
      emitCurrentAutoRoute(threadId);
    } else if (["thread/deleted", "thread/unsubscribed"].includes(withRouteStatus?.method) && threadId) {
      emitRouteStatus({ status: withRouteStatus.method === "thread/deleted" ? "deleted" : "unsubscribed", threadId });
    }
    return processed;
  }

  return {
    decorateAppServerChild: transport.decorateChild,
    diagnostics() {
      const catalogSnapshot = catalog.snapshot();
      const state = stateStore.snapshot();
      return {
        enabled: isEnabled(),
        attached: transport.isAttached(),
        catalogComplete: catalogSnapshot.complete,
        modelCount: catalogSnapshot.models.length,
        classifier: classifier.status(),
        defaultAuto: state.default.auto === true,
        autoThreadCount: Object.values(state.threads).filter((thread) => thread.auto).length,
        activeRouteCount: Object.keys(turnRouteStatus.snapshot().active).length,
      };
    },
    dispose(error = new Error("smart model router disposed")) {
      stopConfigListener();
      routeStatusListeners.clear();
      turnRouteStatus.clearAll();
      transport.rejectPending(error);
    },
    isEnabled,
    onRouteStatus(listener) {
      if (typeof listener !== "function") return () => {};
      routeStatusListeners.add(listener);
      return () => routeStatusListeners.delete(listener);
    },
    activeRoute(threadId) {
      const config = pluginConfig();
      if (!config.enabled || config.values?.showRouteInSummary === false) return null;
      const route = currentAutoRoute(threadId);
      return route ? { ...route, displayName: modelDisplayName(route.model) } : null;
    },
    async listModels() {
      if (catalog.models().length === 0) await refreshCatalog();
      return catalog.models();
    },
    modelCatalog: catalog,
    modelDisplayName,
    processClientMessage,
    processServerMessage,
    refreshCatalog,
    stateStore,
    transport,
    turnRouteStatus,
    virtualModel,
  };
}

module.exports = { createSmartModelRouterService };
