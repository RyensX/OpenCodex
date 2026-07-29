const net = require("node:net");

const IPC_FRAME_HEADER_BYTES = 4;
const IPC_MAX_FRAME_BYTES = 256 * 1024 * 1024;
const DEFAULT_HOST_ID = "local";
const DEFAULT_CLIENT_TYPE = "opencodex-readonly-observer";
const DEFAULT_RECONNECT_DELAY_MS = 5_000;

function threadKey(conversationId, hostId) {
  return `${hostId}\u0000${conversationId}`;
}

function encodeIpcFrame(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(IPC_FRAME_HEADER_BYTES);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

function createIpcFrameParser(onMessage, onError) {
  let buffer = Buffer.alloc(0);

  function consume(chunk) {
    if (!chunk || chunk.length === 0) return;
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= IPC_FRAME_HEADER_BYTES) {
      const frameBytes = buffer.readUInt32LE(0);
      if (frameBytes === 0 || frameBytes > IPC_MAX_FRAME_BYTES) {
        onError(new Error(`Invalid official IPC frame length: ${frameBytes}`));
        return;
      }
      if (buffer.length < IPC_FRAME_HEADER_BYTES + frameBytes) return;
      const payload = buffer
        .subarray(IPC_FRAME_HEADER_BYTES, IPC_FRAME_HEADER_BYTES + frameBytes)
        .toString("utf8");
      buffer = buffer.subarray(IPC_FRAME_HEADER_BYTES + frameBytes);
      try {
        onMessage(JSON.parse(payload));
      } catch (error) {
        onError(error);
        return;
      }
    }
  }

  function reset() {
    buffer = Buffer.alloc(0);
  }

  return { consume, reset };
}

function createOfficialLiveObserver(options = {}) {
  const socketPaths = Array.isArray(options.socketPaths) ? options.socketPaths.filter(Boolean) : [];
  const socketFactory =
    typeof options.socketFactory === "function" ? options.socketFactory : (socketPath) => net.createConnection(socketPath);
  const publish = typeof options.publish === "function" ? options.publish : () => {};
  const onError = typeof options.onError === "function" ? options.onError : () => {};
  const clientType = options.clientType || DEFAULT_CLIENT_TYPE;
  const reconnectDelayMs =
    // -1 是显式禁用重连的测试/关闭语义；生产默认仍使用固定退避，避免反复打满 socket。
    Number.isFinite(options.reconnectDelayMs) && options.reconnectDelayMs >= -1
      ? options.reconnectDelayMs
      : DEFAULT_RECONNECT_DELAY_MS;

  const knownThreads = new Map();
  const activeOwners = new Map();
  // 只保存可验证增量所需的 revision 元数据，不保存任何 snapshot/patch 内容。
  const activeRevisions = new Map();
  let socket = null;
  let socketPathIndex = 0;
  let clientId = "";
  let started = false;
  let stopped = false;
  let reconnectTimer = null;
  let parser = null;
  let initializeRequestId = 0;

  function emit(channel, payload) {
    try {
      publish({ channel, payload });
    } catch (error) {
      onError(error);
    }
  }

  function emitOwnerDisconnected(ownerClientId) {
    // 官方 follower 在 owner 断开时依赖 client-status-changed 清理 stream role，避免永久 spinner。
    emit("client-status-changed", {
      type: "broadcast",
      method: "client-status-changed",
      sourceClientId: ownerClientId,
      params: { clientId: ownerClientId, status: "disconnected" },
    });
  }

  function clearActiveState() {
    for (const ownerClientId of new Set(activeOwners.values())) {
      if (ownerClientId) emitOwnerDisconnected(ownerClientId);
    }
    activeOwners.clear();
    activeRevisions.clear();
  }

  function emitConnectionReset(reason, sourceMessage = null) {
    emit("ipc-connection-reset", sourceMessage || {
      type: "broadcast",
      method: "ipc-connection-reset",
      params: { reason },
    });
  }

  function writeMessage(message) {
    if (!socket || socket.destroyed || socket.writable !== true) return false;
    try {
      socket.write(encodeIpcFrame(message));
      return true;
    } catch (error) {
      onError(error);
      return false;
    }
  }

  function send(message) {
    if (!clientId) return false;
    return writeMessage(message);
  }

  function sendFollowing(conversationId, hostId, following) {
    // observer 只允许 initialize 和 following 广播，绝不生成任何 thread-follower 控制请求。
    return send({
      type: "broadcast",
      method: "thread-stream-following-changed",
      version: 1,
      sourceClientId: clientId,
      params: { conversationId, hostId, following },
    });
  }

  function resubscribeKnownThreads() {
    for (const { conversationId, hostId } of knownThreads.values()) {
      sendFollowing(conversationId, hostId, true);
    }
  }

  function handleMessage(message) {
    if (!message || typeof message !== "object") return;
    if (message.type === "response" && message.method === "initialize") {
      if (message.resultType !== "success") {
        onError(new Error(`Official live IPC initialize failed: ${message.error || "unknown error"}`));
        return;
      }
      clientId = String(message.handledByClientId || message.result?.clientId || "");
      if (!clientId) {
        onError(new Error("Official live IPC initialize response did not include client id"));
        return;
      }
      resubscribeKnownThreads();
      return;
    }
    const method = String(message.method || (message.type === "ipc-connection-reset" ? message.type : ""));
    if (method === "ipc-connection-reset") {
      // reset 后只保留 knownThreads；旧 owner/revision 不能跨连接安全接收 patches。
      clearActiveState();
      emitConnectionReset("peer-reset", message);
      resubscribeKnownThreads();
      return;
    }
    if (message.type !== "broadcast") return;

    const params = message.params && typeof message.params === "object" ? message.params : {};
    const conversationId = typeof params.conversationId === "string" ? params.conversationId : "";
    const hostId = typeof params.hostId === "string" && params.hostId ? params.hostId : DEFAULT_HOST_ID;
    const key = conversationId ? threadKey(conversationId, hostId) : "";

    if (method === "thread-stream-following-status-requested") {
      // Desktop 新建任务可能不在 Web 首屏快照里；owner 主动询问 follower 时再按官方协议订阅。
      if (conversationId) observeThread(conversationId, hostId);
      return;
    }

    if (method === "thread-stream-state-changed") {
      if (!key) return;
      const change = params.change && typeof params.change === "object" ? params.change : null;
      const ownerClientId = typeof message.sourceClientId === "string" ? message.sourceClientId : "";
      // 首个 snapshot 可能早于 Web 首屏 catalog；patch 没有可用 baseRevision，不能跨 renderer 重放。
      if (!knownThreads.has(key) && change?.type !== "snapshot") return;
      if (change?.type === "snapshot") {
        if (!knownThreads.has(key)) knownThreads.set(key, { conversationId, hostId });
        if (ownerClientId) activeOwners.set(key, ownerClientId);
        else activeOwners.delete(key);
        if (change.revision !== undefined && change.revision !== null) {
          activeRevisions.set(key, change.revision);
        } else {
          activeRevisions.delete(key);
        }
        emit(method, message);
        return;
      }
      if (change?.type !== "patches") return;
      if (activeOwners.get(key) !== ownerClientId) return;
      if (!activeRevisions.has(key) || activeRevisions.get(key) !== change.baseRevision) return;
      if (change.revision === undefined || change.revision === null) return;
      activeRevisions.set(key, change.revision);
      emit(method, message);
      return;
    }

    if (
      method === "client-status-changed" &&
      params.status === "disconnected" &&
      typeof params.clientId === "string"
    ) {
      let matched = false;
      for (const [thread, ownerClientId] of activeOwners.entries()) {
        if (ownerClientId !== params.clientId) continue;
        activeOwners.delete(thread);
        activeRevisions.delete(thread);
        matched = true;
      }
      // client-status-changed 是 owner 级别的全局事件，多个 thread 只需向 renderer 转发一次。
      if (matched) emit(method, message);
    }
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer || reconnectDelayMs < 0) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, reconnectDelayMs);
    if (typeof reconnectTimer.unref === "function") reconnectTimer.unref();
  }

  function closeSocket() {
    const current = socket;
    socket = null;
    clientId = "";
    parser?.reset();
    parser = null;
    if (!current) return;
    current.removeAllListeners?.();
    try {
      current.destroy();
    } catch {}
  }

  function handleSocketClosed(current) {
    if (socket !== current) return;
    socket = null;
    clientId = "";
    parser?.reset();
    parser = null;
    clearActiveState();
    emitConnectionReset("socket-closed");
    scheduleReconnect();
  }

  function connect() {
    if (stopped || socket || socketPaths.length === 0) return;
    const socketPath = socketPaths[socketPathIndex % socketPaths.length];
    socketPathIndex += 1;
    let current;
    try {
      current = socketFactory(socketPath);
    } catch (error) {
      onError(error);
      scheduleReconnect();
      return;
    }
    socket = current;
    parser = createIpcFrameParser(handleMessage, (error) => {
      onError(error);
      current.destroy?.();
    });
    const onConnect = () => {
      initializeRequestId += 1;
      writeMessage({
        type: "request",
        requestId: `opencodex-observer-init-${initializeRequestId}`,
        method: "initialize",
        params: { clientType },
      });
    };
    current.once?.("connect", onConnect);
    current.on?.("data", (chunk) => parser?.consume(chunk));
    current.once?.("error", (error) => {
      onError(error);
      handleSocketClosed(current);
    });
    current.once?.("close", () => handleSocketClosed(current));
  }

  function observeThread(conversationId, hostId = DEFAULT_HOST_ID) {
    if (typeof conversationId !== "string" || conversationId.length === 0) return false;
    const normalizedHostId = typeof hostId === "string" && hostId ? hostId : DEFAULT_HOST_ID;
    const key = threadKey(conversationId, normalizedHostId);
    knownThreads.set(key, { conversationId, hostId: normalizedHostId });
    if (clientId) sendFollowing(conversationId, normalizedHostId, true);
    return true;
  }

  function observeSidebarBootstrap(bootstrap) {
    const entries = bootstrap?.catalogSnapshot?.entries;
    if (!Array.isArray(entries)) return 0;
    let observed = 0;
    for (const entry of entries) {
      const conversationId = entry?.threadId || entry?.conversationId;
      if (observeThread(conversationId, entry?.hostId || DEFAULT_HOST_ID)) observed += 1;
    }
    return observed;
  }

  function start() {
    if (started) return;
    started = true;
    stopped = false;
    connect();
  }

  function refresh() {
    resubscribeKnownThreads();
  }

  function stop() {
    stopped = true;
    started = false;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    clearActiveState();
    closeSocket();
  }

  return {
    observeSidebarBootstrap,
    observeThread,
    refresh,
    start,
    stop,
    __test: {
      getActiveOwners: () => new Map(activeOwners),
      getClientId: () => clientId,
      getKnownThreads: () => new Map(knownThreads),
      handleMessage,
      encodeIpcFrame,
    },
  };
}

module.exports = {
  createIpcFrameParser,
  createOfficialLiveObserver,
  encodeIpcFrame,
  __test: {
    DEFAULT_CLIENT_TYPE,
    DEFAULT_HOST_ID,
    IPC_MAX_FRAME_BYTES,
    IPC_FRAME_HEADER_BYTES,
    threadKey,
  },
};
