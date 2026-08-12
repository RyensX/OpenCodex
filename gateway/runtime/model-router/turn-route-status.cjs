const ROUTE_METADATA_KEY = "opencodex/smart-scheduling";
const TERMINAL_TURN_METHODS = new Set(["turn/completed", "turn/failed", "turn/interrupted"]);
const DEFAULT_MAX_TRACKED_THREADS = 512;
const DEFAULT_MAX_PENDING_ROUTES_PER_THREAD = 64;

function turnIdFromMessage(message) {
  return String(message?.params?.turnId || message?.params?.turn?.id || message?.result?.turn?.id || "");
}

function safeRoute(route, threadId, turnId) {
  return {
    threadId: String(threadId || ""),
    turnId: String(turnId || ""),
    tier: String(route?.tier || ""),
    model: String(route?.model || ""),
    effort: String(route?.effort || ""),
    fallback: route?.fallback === true,
  };
}

function routeMetadata(route) {
  return {
    tier: route.tier,
    model: route.model,
    effort: route.effort,
    fallback: route.fallback,
  };
}

function createTurnRouteStatus(options = {}) {
  const pendingByThread = new Map();
  const activeByThread = new Map();
  const maxTrackedThreads = Math.max(1, Number(options.maxTrackedThreads) || DEFAULT_MAX_TRACKED_THREADS);
  const maxPendingRoutesPerThread = Math.max(
    1,
    Number(options.maxPendingRoutesPerThread) || DEFAULT_MAX_PENDING_ROUTES_PER_THREAD
  );

  function setBoundedThreadEntry(map, threadId, value) {
    map.delete(threadId);
    map.set(threadId, value);
    // 极端断线或异常客户端不能让未完成展示状态永久占用内存；旧线程重新活动时会自然重建。
    while (map.size > maxTrackedThreads) map.delete(map.keys().next().value);
  }

  function select({ requestKey, threadId, route }) {
    const normalizedThreadId = String(threadId || "");
    if (!normalizedThreadId || !route?.model || !route?.effort) return;
    const queue = pendingByThread.get(normalizedThreadId) || [];
    queue.push({ requestKey: String(requestKey || ""), route: safeRoute(route, normalizedThreadId, "") });
    while (queue.length > maxPendingRoutesPerThread) queue.shift();
    setBoundedThreadEntry(pendingByThread, normalizedThreadId, queue);
  }

  function cancel(requestKey, threadId) {
    const normalizedThreadId = String(threadId || "");
    const queue = pendingByThread.get(normalizedThreadId);
    if (!queue) return;
    const next = queue.filter((entry) => entry.requestKey !== String(requestKey || ""));
    if (next.length > 0) setBoundedThreadEntry(pendingByThread, normalizedThreadId, next);
    else pendingByThread.delete(normalizedThreadId);
  }

  function clearThread(threadId) {
    const normalizedThreadId = String(threadId || "");
    pendingByThread.delete(normalizedThreadId);
    activeByThread.delete(normalizedThreadId);
  }

  function startTurn(message) {
    const threadId = String(message?.params?.threadId || "");
    if (!threadId) return message;
    const pending = pendingByThread.get(threadId)?.shift();
    if (pendingByThread.get(threadId)?.length === 0) pendingByThread.delete(threadId);
    if (!pending) {
      // 同一线程切回手动模型后，新的真实回合不能沿用上一轮的 Auto 展示。
      activeByThread.delete(threadId);
      return message;
    }
    const route = safeRoute(pending.route, threadId, turnIdFromMessage(message));
    setBoundedThreadEntry(activeByThread, threadId, route);
    const params = message.params && typeof message.params === "object" ? message.params : {};
    const metadata = params._meta && typeof params._meta === "object" ? params._meta : {};
    return {
      ...message,
      params: {
        ...params,
        // 元数据只包含最终采用的档位、模型和强度，不携带分类 prompt、依据或回复正文。
        _meta: { ...metadata, [ROUTE_METADATA_KEY]: routeMetadata(route) },
      },
    };
  }

  function finishTurn(message) {
    const threadId = String(message?.params?.threadId || "");
    if (!threadId) return;
    const active = activeByThread.get(threadId);
    const turnId = turnIdFromMessage(message);
    if (!active || !turnId || !active.turnId || active.turnId === turnId) activeByThread.delete(threadId);
    // 没有收到 turn/started 的失败回合也必须清掉等待展示的路由结果。
    pendingByThread.delete(threadId);
  }

  function processServerMessage(message, requestMeta) {
    if (!message || typeof message !== "object") return message;
    if (message.id != null && requestMeta?.method === "turn/start" && message.error) {
      cancel(requestMeta.requestKey, requestMeta.threadId);
      return message;
    }
    if (message.method === "turn/started") return startTurn(message);
    if (TERMINAL_TURN_METHODS.has(message.method)) finishTurn(message);
    if (["thread/deleted", "thread/archived", "thread/unsubscribed"].includes(message.method)) {
      clearThread(message?.params?.threadId || message?.params?.thread?.id);
    }
    return message;
  }

  return {
    activeRoute(threadId) {
      const route = activeByThread.get(String(threadId || ""));
      return route ? { ...route } : null;
    },
    cancel,
    clearAll() {
      pendingByThread.clear();
      activeByThread.clear();
    },
    clearThread,
    processServerMessage,
    select,
    snapshot() {
      return {
        active: Object.fromEntries(Array.from(activeByThread, ([threadId, route]) => [threadId, { ...route }])),
        activeCount: activeByThread.size,
        pendingCount: Array.from(pendingByThread.values()).reduce((total, queue) => total + queue.length, 0),
        pendingThreadCount: pendingByThread.size,
      };
    },
  };
}

module.exports = {
  ROUTE_METADATA_KEY,
  TERMINAL_TURN_METHODS,
  DEFAULT_MAX_PENDING_ROUTES_PER_THREAD,
  DEFAULT_MAX_TRACKED_THREADS,
  createTurnRouteStatus,
  routeMetadata,
  safeRoute,
};
