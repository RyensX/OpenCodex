const PROTOCOL_ENVELOPE_KEYS = ["message", "request", "payload", "body"];
const PRESENTATION_MESSAGE_TYPE = "opencodex:smart-scheduling-route";

function normalizedId(value) {
  return value == null ? "" : String(value).trim();
}

function safeRoute(route, displayNameForModel) {
  if (!route || typeof route !== "object") return null;
  const model = normalizedId(route.model);
  const effort = normalizedId(route.effort);
  if (!model || !effort) return null;
  const displayName =
    normalizedId(route.displayName) || normalizedId(displayNameForModel?.(model)) || model;
  return {
    tier: normalizedId(route.tier),
    model,
    displayName,
    effort,
    fallback: route.fallback === true,
  };
}

function visitProtocolMessages(value, visitor, depth = 0) {
  if (!value || typeof value !== "object" || depth > 4) return;
  if (Array.isArray(value)) {
    for (const item of value) visitProtocolMessages(item, visitor, depth + 1);
    return;
  }
  visitor(value);
  for (const key of PROTOCOL_ENVELOPE_KEYS) {
    const nested = value[key];
    if (nested && typeof nested === "object") visitProtocolMessages(nested, visitor, depth + 1);
    else if (typeof nested === "string" && (nested.includes("turn/") || nested.includes("thread/"))) {
      try {
        visitProtocolMessages(JSON.parse(nested), visitor, depth + 1);
      } catch {}
    }
  }
}

function createSmartSchedulingPresentation({ modelRouter, sendTo } = {}) {
  const clientsByThread = new Map();

  function rememberClient(threadId, clientId) {
    const normalizedThreadId = normalizedId(threadId);
    const normalizedClientId = normalizedId(clientId);
    if (!normalizedThreadId || !normalizedClientId) return;
    const clients = clientsByThread.get(normalizedThreadId) || new Set();
    clients.add(normalizedClientId);
    clientsByThread.set(normalizedThreadId, clients);
  }

  function observeAppHostFrame({ clientId, data, direction = "client" } = {}) {
    if (
      direction !== "client" ||
      typeof data !== "string" ||
      (!data.includes("turn/") && !data.includes("thread/"))
    ) {
      return;
    }
    try {
      visitProtocolMessages(JSON.parse(data), (message) => {
        if (!["turn/start", "thread/settings/update"].includes(message?.method)) return;
        rememberClient(message.params?.threadId || message.params?.thread?.id, clientId);
      });
    } catch {}
  }

  function observeIpcInvoke({ clientId, args } = {}) {
    if (!normalizedId(clientId) || !Array.isArray(args)) return;
    // 沿已知协议包裹层关联回合和模型选择，不保存输入正文或设置内容。
    visitProtocolMessages(args, (message) => {
      if (!["turn/start", "thread/settings/update"].includes(message?.method)) return;
      rememberClient(message.params?.threadId || message.params?.thread?.id, clientId);
    });
  }

  function payloadForEvent(event) {
    const threadId = normalizedId(event?.threadId);
    const status = normalizedId(event?.status);
    if (!threadId || !status) return null;
    const route = safeRoute(event.route, (model) => modelRouter?.modelDisplayName?.(model));
    if (["selected", "started", "idle"].includes(status) && !route) return null;
    return {
      type: PRESENTATION_MESSAGE_TYPE,
      event: {
        threadId,
        status,
        ...(route ? { route } : {}),
      },
    };
  }

  function deliver(event) {
    const payload = payloadForEvent(event);
    if (!payload) return;
    const clients = clientsByThread.get(payload.event.threadId);
    if (!clients || clients.size === 0) return;
    for (const clientId of clients) {
      // 路由展示只能定向回发给曾在该任务发起 turn 的页面，禁止缺失 client 时回退成广播。
      sendTo?.(clientId, payload, { suppressDiagnostic: true });
    }
    if (["deleted", "unsubscribed"].includes(payload.event.status)) {
      clientsByThread.delete(payload.event.threadId);
    }
  }

  const unsubscribe = modelRouter?.onRouteStatus?.(deliver) || (() => {});

  return {
    dispose() {
      unsubscribe();
      clientsByThread.clear();
    },
    observeAppHostFrame,
    observeIpcInvoke,
    snapshot() {
      return { trackedThreadCount: clientsByThread.size };
    },
  };
}

module.exports = {
  PRESENTATION_MESSAGE_TYPE,
  createSmartSchedulingPresentation,
  safeRoute,
  visitProtocolMessages,
};
