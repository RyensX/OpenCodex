const LOCAL_THREAD_PATH = /^\/local\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const DESKTOP_STATUS_BINDING = "opencodexDesktopStatus";
const INSTALL_STATUS_HOOK = `(() => {
  if (window.__opencodexDesktopStatusHookInstalled) return true;
  if (typeof window.${DESKTOP_STATUS_BINDING} !== "function") return false;
  const stringify = JSON.stringify;
  let lastTraySnapshot = null;
  JSON.stringify = function(value, ...args) {
    const serialized = stringify.call(JSON, value, ...args);
    if (
      value &&
      Array.isArray(value.runningThreads) &&
      Array.isArray(value.unreadThreads) &&
      Array.isArray(value.pinnedThreads) &&
      Array.isArray(value.recentThreads) &&
      Array.isArray(value.usageLimits) &&
      serialized !== lastTraySnapshot
    ) {
      lastTraySnapshot = serialized;
      try {
        window.${DESKTOP_STATUS_BINDING}(stringify.call(JSON, {
          type: "tray-menu-threads-changed",
          trayMenuThreads: value,
        }));
      } catch {}
    }
    return serialized;
  };
  window.__opencodexDesktopStatusHookInstalled = true;
  return true;
})()`;

function loopbackCdpEndpoint(value) {
  const endpoint = new URL(value);
  if (
    endpoint.protocol !== "http:" ||
    !["127.0.0.1", "[::1]"].includes(endpoint.hostname) ||
    endpoint.username ||
    endpoint.password
  ) {
    throw new Error("Desktop CDP endpoint must be loopback HTTP");
  }
  return endpoint;
}

function isMainAppRendererTarget(candidate) {
  if (candidate?.type !== "page" || typeof candidate.url !== "string") return false;
  try {
    const url = new URL(candidate.url);
    return url.protocol === "app:" && url.pathname.endsWith("/index.html") && !url.search;
  } catch {
    return false;
  }
}

async function connectDesktopStatusBridge({ endpoint, onSnapshot }) {
  const endpointUrl = loopbackCdpEndpoint(endpoint);
  const response = await fetch(new URL("/json/list", endpointUrl), { redirect: "error" });
  if (!response.ok) throw new Error(`Desktop CDP discovery failed: HTTP ${response.status}`);
  const targets = await response.json();
  const target = Array.isArray(targets)
    ? targets.find(
        (candidate) =>
          isMainAppRendererTarget(candidate) && typeof candidate.webSocketDebuggerUrl === "string"
      )
    : null;
  if (!target) throw new Error("Desktop CDP app renderer was not found");

  const debuggerUrl = new URL(target.webSocketDebuggerUrl);
  if (
    debuggerUrl.protocol !== "ws:" ||
    debuggerUrl.hostname !== endpointUrl.hostname ||
    debuggerUrl.port !== endpointUrl.port
  ) {
    throw new Error("Desktop CDP WebSocket must use the discovery loopback endpoint");
  }

  const { WebSocket } = require("ws");
  const socket = new WebSocket(debuggerUrl);
  const pending = new Map();
  let nextId = 0;
  let resolveClosed;
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });

  let handshakeComplete = false;
  let rejectHandshake;
  socket.on("error", (error) => {
    if (!handshakeComplete) {
      rejectHandshake?.(error);
      return;
    }
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    socket.terminate();
  });

  await new Promise((resolve, reject) => {
    rejectHandshake = reject;
    socket.once("open", () => {
      handshakeComplete = true;
      resolve();
    });
  });

  socket.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (message.id != null) {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message || "Desktop CDP command failed"));
      else request.resolve(message.result);
      return;
    }
    if (message.method !== "Runtime.bindingCalled" || message.params?.name !== DESKTOP_STATUS_BINDING) return;
    try {
      const snapshot = JSON.parse(message.params.payload);
      if (snapshot?.type === "tray-menu-threads-changed") onSnapshot(snapshot);
    } catch {}
  });

  socket.once("close", () => {
    for (const request of pending.values()) request.reject(new Error("Desktop CDP connection closed"));
    pending.clear();
    resolveClosed();
  });

  function command(method, params = {}) {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      pending.set(id, { reject, resolve });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }

  await command("Runtime.enable");
  await command("Page.enable");
  await command("Runtime.addBinding", { name: DESKTOP_STATUS_BINDING });
  await command("Page.addScriptToEvaluateOnNewDocument", { source: INSTALL_STATUS_HOOK });
  await command("Runtime.evaluate", { expression: INSTALL_STATUS_HOOK });
  await command("Page.reload", { ignoreCache: true });

  return {
    closed,
    close() {
      socket.close();
    },
  };
}

function desktopRunningThreadIds(message) {
  const runningThreads = message?.trayMenuThreads?.runningThreads;
  if (!Array.isArray(runningThreads)) return null;
  const ids = new Set();
  for (const thread of runningThreads) {
    const match = typeof thread?.path === "string" ? LOCAL_THREAD_PATH.exec(thread.path) : null;
    if (match) ids.add(match[1].toLowerCase());
  }
  return ids;
}

function statusEnvelope(threadId, active) {
  const payload = {
    type: "mcp-notification",
    hostId: "local",
    method: "thread/status/changed",
    params: {
      threadId,
      status: active ? { type: "active", activeFlags: [] } : { type: "idle" },
    },
  };
  return { channel: "codex_desktop:message-for-view", payload, args: [payload] };
}

function createDesktopStatusSynchronizer({ getVisibleThreads, publish }) {
  const statuses = new Map();
  let lastActiveThreadIds = null;

  function publishStatuses(activeThreadIds) {
    for (const thread of getVisibleThreads()) {
      if (thread?.hostId !== "local" || typeof thread.threadId !== "string") continue;
      const active = activeThreadIds.has(thread.threadId.toLowerCase());
      if (statuses.get(thread.threadId) === active) continue;
      statuses.set(thread.threadId, active);
      publish(statusEnvelope(thread.threadId, active));
    }
  }

  function applyTraySnapshot(message) {
    const activeThreadIds = desktopRunningThreadIds(message);
    if (!activeThreadIds) return false;
    lastActiveThreadIds = activeThreadIds;
    publishStatuses(activeThreadIds);
    return true;
  }

  function refresh() {
    if (lastActiveThreadIds) publishStatuses(lastActiveThreadIds);
  }

  function replay(replayPublish) {
    if (!lastActiveThreadIds) return;
    for (const thread of getVisibleThreads()) {
      if (thread?.hostId !== "local" || typeof thread.threadId !== "string") continue;
      replayPublish(statusEnvelope(thread.threadId, lastActiveThreadIds.has(thread.threadId.toLowerCase())));
    }
  }

  return { applyTraySnapshot, refresh, replay };
}

module.exports = {
  connectDesktopStatusBridge,
  createDesktopStatusSynchronizer,
  desktopRunningThreadIds,
  __test: { INSTALL_STATUS_HOOK },
};
