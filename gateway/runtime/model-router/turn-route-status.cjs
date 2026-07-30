const ROUTE_METADATA_KEY = "opencodex/smart-scheduling";
const TERMINAL_TURN_METHODS = new Set(["turn/completed", "turn/failed", "turn/interrupted"]);

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

function createTurnRouteStatus() {
  const pendingByThread = new Map();
  const activeByThread = new Map();

  function select({ requestKey, threadId, route }) {
    const normalizedThreadId = String(threadId || "");
    if (!normalizedThreadId || !route?.model || !route?.effort) return;
    const queue = pendingByThread.get(normalizedThreadId) || [];
    queue.push({ requestKey: String(requestKey || ""), route: safeRoute(route, normalizedThreadId, "") });
    pendingByThread.set(normalizedThreadId, queue);
  }

  function cancel(requestKey, threadId) {
    const normalizedThreadId = String(threadId || "");
    const queue = pendingByThread.get(normalizedThreadId);
    if (!queue) return;
    const next = queue.filter((entry) => entry.requestKey !== String(requestKey || ""));
    if (next.length > 0) pendingByThread.set(normalizedThreadId, next);
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
    activeByThread.set(threadId, route);
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
        pendingCount: Array.from(pendingByThread.values()).reduce((total, queue) => total + queue.length, 0),
      };
    },
  };
}

module.exports = {
  ROUTE_METADATA_KEY,
  TERMINAL_TURN_METHODS,
  createTurnRouteStatus,
  routeMetadata,
  safeRoute,
};
