const net = require("node:net");

const IPC_FRAME_HEADER_BYTES = 4;
const IPC_MAX_FRAME_BYTES = 256 * 1024 * 1024;
const DEFAULT_HOST_ID = "local";
const DEFAULT_CLIENT_TYPE = "opencodex-readonly-observer";
const DEFAULT_RECONNECT_DELAY_MS = 5_000;
const DEFAULT_MAX_RECONNECT_DELAY_MS = 60_000;
const DEFAULT_MAX_KNOWN_THREADS = 512;

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
  const header = Buffer.alloc(IPC_FRAME_HEADER_BYTES);
  let headerOffset = 0;
  let body = null;
  let bodyOffset = 0;
  let failed = false;

  function fail(error) {
    failed = true;
    onError(error);
  }

  function consume(chunk) {
    if (failed || !chunk || chunk.length === 0) return;
    let chunkOffset = 0;
    while (chunkOffset < chunk.length) {
      if (!body) {
        const headerBytes = Math.min(IPC_FRAME_HEADER_BYTES - headerOffset, chunk.length - chunkOffset);
        chunk.copy(header, headerOffset, chunkOffset, chunkOffset + headerBytes);
        headerOffset += headerBytes;
        chunkOffset += headerBytes;
        if (headerOffset < IPC_FRAME_HEADER_BYTES) continue;

        const frameBytes = header.readUInt32LE(0);
        if (frameBytes === 0 || frameBytes > IPC_MAX_FRAME_BYTES) {
          fail(new Error(`Invalid official IPC frame length: ${frameBytes}`));
          return;
        }
        try {
          // 按声明长度只分配一次，避免大 snapshot 每到一个分片就复制全部历史数据。
          body = Buffer.allocUnsafe(frameBytes);
        } catch (error) {
          fail(error);
          return;
        }
      }

      const bodyBytes = Math.min(body.length - bodyOffset, chunk.length - chunkOffset);
      chunk.copy(body, bodyOffset, chunkOffset, chunkOffset + bodyBytes);
      bodyOffset += bodyBytes;
      chunkOffset += bodyBytes;
      if (bodyOffset < body.length) continue;

      const payload = body.toString("utf8");
      body = null;
      bodyOffset = 0;
      headerOffset = 0;
      try {
        onMessage(JSON.parse(payload));
      } catch (error) {
        fail(error);
        return;
      }
    }
  }

  function reset() {
    headerOffset = 0;
    body = null;
    bodyOffset = 0;
    failed = false;
  }

  return { consume, reset };
}

function reconnectDelayForAttempt(baseDelayMs, maxDelayMs, attempt) {
  return Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt));
}

function isExpectedSocketUnavailableError(error) {
  return error?.code === "ENOENT" || error?.code === "ECONNREFUSED";
}

function createOfficialLiveObserver(options = {}) {
  const socketPaths = Array.isArray(options.socketPaths) ? options.socketPaths.filter(Boolean) : [];
  const socketFactory =
    typeof options.socketFactory === "function" ? options.socketFactory : (socketPath) => net.createConnection(socketPath);
  const publish = typeof options.publish === "function" ? options.publish : () => {};
  const onError = typeof options.onError === "function" ? options.onError : () => {};
  const clientType = options.clientType || DEFAULT_CLIENT_TYPE;
  const reconnectDelayMs =
    // -1 是显式禁用重连的测试/关闭语义；生产默认从五秒开始退避。
    Number.isFinite(options.reconnectDelayMs) && options.reconnectDelayMs >= -1
      ? options.reconnectDelayMs
      : DEFAULT_RECONNECT_DELAY_MS;
  const maxReconnectDelayMs = Math.max(
    reconnectDelayMs,
    Number.isFinite(options.maxReconnectDelayMs) && options.maxReconnectDelayMs >= 0
      ? options.maxReconnectDelayMs
      : DEFAULT_MAX_RECONNECT_DELAY_MS
  );
  const configuredMaxKnownThreads = Number(options.maxKnownThreads);
  const maxKnownThreads =
    Number.isInteger(configuredMaxKnownThreads) && configuredMaxKnownThreads > 0
      ? configuredMaxKnownThreads
      : DEFAULT_MAX_KNOWN_THREADS;

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
  let reconnectAttempt = 0;
  let threadListInvalidationPending = false;
  let followingEnabled = options.followingEnabled !== false;

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
    // observer 只发送初始化、订阅及列表失效通知，绝不生成任何 thread-follower 控制请求。
    return send({
      type: "broadcast",
      method: "thread-stream-following-changed",
      version: 1,
      sourceClientId: clientId,
      params: { conversationId, hostId, following },
    });
  }

  function resubscribeKnownThreads() {
    if (!followingEnabled) return;
    for (const { conversationId, hostId } of knownThreads.values()) {
      sendFollowing(conversationId, hostId, true);
    }
  }

  function invalidateThreadList() {
    if (stopped) return false;
    // 桌面断连时只保留一次索引刷新需求，不缓存会话正文或控制请求。
    threadListInvalidationPending = true;
    // 官方 query-cache-invalidate 未单独定义版本，按现有协议使用默认版本 0。
    const sent = send({
      type: "broadcast",
      method: "query-cache-invalidate",
      version: 0,
      sourceClientId: clientId,
      params: { queryKey: ["recent-conversations-meta"] },
    });
    if (sent) threadListInvalidationPending = false;
    return sent;
  }

  function forgetKnownThread(key, notifyOfficial = true) {
    const thread = knownThreads.get(key);
    if (!thread) return false;
    knownThreads.delete(key);
    activeOwners.delete(key);
    activeRevisions.delete(key);
    if (notifyOfficial && clientId) sendFollowing(thread.conversationId, thread.hostId, false);
    return true;
  }

  function rememberKnownThread(conversationId, hostId) {
    const key = threadKey(conversationId, hostId);
    const parentConversationId = knownThreads.get(key)?.parentConversationId;
    // 重新观察视为最近使用；异常 owner 连续制造线程时只保留最近订阅，避免长会话状态无界增长。
    knownThreads.delete(key);
    knownThreads.set(key, { conversationId, hostId, parentConversationId });
    while (knownThreads.size > maxKnownThreads) {
      const oldestKey = knownThreads.keys().next().value;
      if (!oldestKey || oldestKey === key) break;
      // 淘汰时同步取消官方订阅，不能只清本地 Map 后继续接收无用 stream。
      forgetKnownThread(oldestKey);
    }
    return key;
  }

  /** 从已订阅会话的协作调用发现子会话，只保存订阅关系，不保留正文。 */
  function observeSubagentThreads(conversationId, hostId, change) {
    // 1. 快照与增量都可能首次带来 spawn 调用，按有界队列检查结构化值。
    const pending = change.type === "snapshot"
      ? [change.conversationState]
      : (change.patches || []).map((patch) => patch.value);
    for (let index = 0; index < pending.length && index < 4096; index += 1) {
      const value = pending[index];
      if (!value || typeof value !== "object") continue;
      if (value.type === "collabAgentToolCall") {
        const receivers = value.receiverThreadIds || value.receiverThreads?.map((thread) => thread.threadId) || [];
        for (const threadId of receivers) {
          if (typeof threadId !== "string" || !threadId || threadId === conversationId) continue;
          const childKey = threadKey(threadId, hostId);
          if (!knownThreads.has(childKey)) {
            // 2. 子 agent 不在侧栏目录，仍需沿当前官方来源请求其完整状态。
            observeThread(threadId, hostId);
          }
          const child = knownThreads.get(childKey);
          if (child) child.parentConversationId = conversationId;
        }
      }
      // 仅遍历对象，不解析工具输出中的文本；容量上限与订阅 LRU 共同限制开销。
      for (const child of Object.values(value)) {
        if (child && typeof child === "object" && pending.length < 4096) pending.push(child);
      }
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
      if (threadListInvalidationPending) {
        // 使用本次连接分配的 clientId 补发断连期间的索引刷新，避免桌面持续显示旧列表。
        invalidateThreadList();
      }
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

    // 桌面归档和缓存失效走独立 IPC；保留官方 envelope，不能只监听生成快照。
    if (["thread-archived", "thread-unarchived", "thread-deleted", "query-cache-invalidate"].includes(method)) {
      if (message.sourceClientId === clientId) return;
      if ((method === "thread-archived" || method === "thread-deleted") && key) {
        // 已移出侧栏的会话同时退订，避免后台 follower 继续保留写入权。
        forgetKnownThread(key);
      }
      emit("codex_desktop:message-for-view", { ...message, type: "ipc-broadcast" });
      return;
    }

    if (!followingEnabled) return;

    if (method === "thread-stream-following-status-requested") {
      // Desktop 新建任务可能不在 Web 首屏快照里；owner 主动询问 follower 时再按官方协议订阅。
      if (conversationId) observeThread(conversationId, hostId);
      return;
    }

    if (method === "thread-queued-followups-changed") {
      // 排队状态独立于会话 snapshot/patch 发布；只同步已订阅线程当前 owner 的完整队列。
      if (!key || !knownThreads.has(key) || !Array.isArray(params.messages)) return;
      const ownerClientId = activeOwners.get(key);
      if (ownerClientId && ownerClientId !== message.sourceClientId) return;
      emit(method, message);
      return;
    }

    if (method === "thread-stream-state-changed") {
      if (!key) return;
      const change = params.change && typeof params.change === "object" ? params.change : null;
      const ownerClientId = typeof message.sourceClientId === "string" ? message.sourceClientId : "";
      // 首个 snapshot 可能早于 Web 首屏 catalog；patch 没有可用 baseRevision，不能跨 renderer 重放。
      if (!knownThreads.has(key) && change?.type !== "snapshot") return;
      if (change?.type === "snapshot") {
        // 相同 owner 的迟到快照不能覆盖已接受的新 revision；owner 切换仍由官方协议处理。
        if (activeOwners.get(key) === ownerClientId && Number.isFinite(change.revision) &&
            Number.isFinite(activeRevisions.get(key)) && change.revision < activeRevisions.get(key)) return;
        // snapshot 代表线程正在活跃，刷新 LRU，避免异常压力下优先淘汰当前 stream。
        rememberKnownThread(conversationId, hostId);
        if (ownerClientId) activeOwners.set(key, ownerClientId);
        else activeOwners.delete(key);
        if (change.revision !== undefined && change.revision !== null) {
          activeRevisions.set(key, change.revision);
        } else {
          activeRevisions.delete(key);
        }
        // 发布父会话前订阅其协作子会话，子状态随后沿同一事件链交给 renderer。
        observeSubagentThreads(conversationId, hostId, change);
        emit(method, message);
        return;
      }
      if (change?.type !== "patches") return;
      if (activeOwners.get(key) !== ownerClientId) return;
      if (!activeRevisions.has(key) || activeRevisions.get(key) !== change.baseRevision) {
        // 丢失增量后重取完整快照，不能永久停在历史的已完成状态。
        sendFollowing(conversationId, hostId, true);
        return;
      }
      if (change.revision === undefined || change.revision === null) return;
      activeRevisions.set(key, change.revision);
      // 后续 spawn 可能只出现在 patches 中，同样需要跟踪子 agent。
      observeSubagentThreads(conversationId, hostId, change);
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
    const delayMs = reconnectDelayForAttempt(reconnectDelayMs, maxReconnectDelayMs, reconnectAttempt);
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delayMs);
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
      // Desktop 未运行是正常部署形态，缺失 socket/拒绝连接无需持续污染日志。
      if (!isExpectedSocketUnavailableError(error)) onError(error);
      scheduleReconnect();
      return;
    }
    socket = current;
    parser = createIpcFrameParser(handleMessage, (error) => {
      onError(error);
      current.destroy?.();
    });
    const onConnect = () => {
      reconnectAttempt = 0;
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
      if (!isExpectedSocketUnavailableError(error)) onError(error);
      handleSocketClosed(current);
    });
    current.once?.("close", () => handleSocketClosed(current));
  }

  function observeThread(conversationId, hostId = DEFAULT_HOST_ID) {
    if (typeof conversationId !== "string" || conversationId.length === 0) return false;
    const normalizedHostId = typeof hostId === "string" && hostId ? hostId : DEFAULT_HOST_ID;
    rememberKnownThread(conversationId, normalizedHostId);
    if (clientId && followingEnabled) sendFollowing(conversationId, normalizedHostId, true);
    return true;
  }

  function observeSidebarBootstrap(bootstrap) {
    // 新版官方启动快照直接提供 catalogEntries，旧版仍包装在 catalogSnapshot 中。
    const entries = Array.isArray(bootstrap?.catalogEntries) ? bootstrap.catalogEntries : bootstrap?.catalogSnapshot?.entries;
    if (!Array.isArray(entries)) return 0;
    let observed = 0;
    const visibleThreads = new Set();
    for (const entry of entries) {
      const conversationId = entry?.threadId || entry?.conversationId;
      const hostId = entry?.hostId || DEFAULT_HOST_ID;
      if (observeThread(conversationId, hostId)) {
        visibleThreads.add(threadKey(conversationId, hostId));
        observed += 1;
      }
    }
    // 从可见父会话展开已有子订阅；刷新目录不能把仍运行的子 agent 当成不可见任务退订。
    for (let pass = 0; pass < knownThreads.size; pass += 1) {
      let added = false;
      for (const [key, thread] of knownThreads) {
        if (visibleThreads.has(key) || !thread.parentConversationId ||
            !visibleThreads.has(threadKey(thread.parentConversationId, thread.hostId))) continue;
        visibleThreads.add(key);
        added = true;
      }
      if (!added) break;
    }
    // sidebar bootstrap 是可见任务真源；移除不再可见的订阅，避免 knownThreads 只增不减。
    for (const key of knownThreads.keys()) {
      if (visibleThreads.has(key)) continue;
      forgetKnownThread(key);
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

  function setFollowingEnabled(enabled) {
    const nextEnabled = enabled === true;
    if (followingEnabled === nextEnabled) return;
    followingEnabled = nextEnabled;
    // 没有 Web 消费者时取消全部订阅；保留目录，重连仍可重新请求完整快照。
    if (!followingEnabled) {
      for (const { conversationId, hostId } of knownThreads.values()) {
        // 通知真实 owner 已停止跟随，使官方空闲释放机制可以继续执行。
        sendFollowing(conversationId, hostId, false);
      }
      clearActiveState();
    }
  }

  function stop() {
    stopped = true;
    started = false;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    threadListInvalidationPending = false;
    clearActiveState();
    closeSocket();
  }

  return {
    setFollowingEnabled,
    invalidateThreadList,
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
    DEFAULT_MAX_KNOWN_THREADS,
    DEFAULT_MAX_RECONNECT_DELAY_MS,
    IPC_MAX_FRAME_BYTES,
    IPC_FRAME_HEADER_BYTES,
    isExpectedSocketUnavailableError,
    reconnectDelayForAttempt,
    threadKey,
  },
};
