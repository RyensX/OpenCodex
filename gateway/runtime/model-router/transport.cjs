const { PassThrough, Writable } = require("stream");
const { StringDecoder } = require("string_decoder");
const { ROUTER_REQUEST_PREFIX } = require("./constants.cjs");

const DECORATED_CHILD = Symbol("opencodexModelRouterDecoratedChild");
const MAX_PENDING_CLIENT_FRAMES = 64;
const MAX_INTERNAL_THREAD_TOMBSTONES = 512;
const INTERNAL_TURN_TERMINAL_METHODS = new Set(["turn/completed", "turn/failed", "turn/interrupted"]);

// 这些是当前协议中明确的只读请求；官方本身会并发发起它们，调用方不能依赖它们排在未完成的 turn/start 之后。
const INDEPENDENT_CLIENT_READ_METHODS = new Set([
  "account/rateLimits/read",
  "account/read",
  "account/usage/read",
  "account/workspaceMessages/read",
  "app/installed",
  "app/list",
  "app/read",
  "collaborationMode/list",
  "config/read",
  "configRequirements/read",
  "environment/info",
  "environment/status",
  "experimentalFeature/list",
  "externalAgentConfig/detect",
  "externalAgentConfig/import/readHistories",
  "fs/getMetadata",
  "fs/readDirectory",
  "fs/readFile",
  "getAuthStatus",
  "gitDiffToRemote",
  "hooks/list",
  "mcpServer/resource/read",
  "mcpServerStatus/list",
  "model/list",
  "modelProvider/capabilities/read",
  "permissionProfile/list",
  "plugin/installed",
  "plugin/list",
  "plugin/read",
  "plugin/share/list",
  "plugin/skill/read",
  "remoteControl/client/list",
  "remoteControl/pairing/status",
  "remoteControl/status/read",
  "skills/list",
  "windowsSandbox/readiness",
]);

// 历史任务列表是全局索引读取；允许它越过未发送的 turn/start，但不能越过删除、重命名等索引写入。
const THREAD_INDEX_READ_METHODS = new Set(["thread/list", "thread/search"]);

// 只把当前协议中明确以 threadId 隔离的请求放入任务作用域；未知新方法一律回退为全局屏障。
const THREAD_SCOPED_CLIENT_METHODS = new Set([
  "mcpServer/tool/call",
  "review/start",
  "thread/approveGuardianDeniedAction",
  "thread/archive",
  "thread/backgroundTerminals/clean",
  "thread/backgroundTerminals/list",
  "thread/backgroundTerminals/terminate",
  "thread/compact/start",
  "thread/decrement_elicitation",
  "thread/delete",
  "thread/fork",
  "thread/goal/clear",
  "thread/goal/get",
  "thread/goal/set",
  "thread/increment_elicitation",
  "thread/inject_items",
  "thread/items/list",
  "thread/memoryMode/set",
  "thread/metadata/update",
  "thread/name/set",
  "thread/read",
  "thread/realtime/appendAudio",
  "thread/realtime/appendSpeech",
  "thread/realtime/appendText",
  "thread/realtime/start",
  "thread/realtime/stop",
  "thread/resume",
  "thread/rollback",
  "thread/searchOccurrences",
  "thread/settings/update",
  "thread/shellCommand",
  "thread/turns/list",
  "thread/unarchive",
  "thread/unsubscribe",
  "turn/interrupt",
  "turn/start",
  "turn/steer",
]);

const THREAD_SCOPED_READ_METHODS = new Set([
  "getConversationSummary",
  "thread/backgroundTerminals/list",
  "thread/goal/get",
  "thread/items/list",
  "thread/read",
  "thread/searchOccurrences",
  "thread/turns/list",
]);

// 部分目录请求可选携带 threadId；有任务上下文时必须跟随该任务的顺序，没有时才视为全局只读。
const OPTIONAL_THREAD_CONTEXT_READ_METHODS = new Set([
  "app/installed",
  "app/list",
  "experimentalFeature/list",
  "mcpServer/resource/read",
  "mcpServerStatus/list",
]);

class AppServerTransportError extends Error {
  constructor(message, category = "transport") {
    super(message);
    this.name = "AppServerTransportError";
    this.category = category;
  }
}

function threadIdFromMessage(message) {
  return String(
    message?.params?.threadId ||
      message?.params?.thread?.id ||
      message?.result?.thread?.id ||
      message?.result?.threadId ||
      ""
  );
}

function turnIdFromMessage(message) {
  return String(message?.params?.turnId || message?.params?.turn?.id || message?.result?.turn?.id || "");
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value || {}, key);
}

function clientThreadIdFromMessage(message) {
  if (message?.method === "getConversationSummary") return String(message?.params?.conversationId || "");
  return String(message?.params?.threadId || message?.params?.thread?.id || "");
}

function clientFrameDescriptor(rawLine) {
  let message;
  try {
    message = JSON.parse(rawLine);
  } catch {
    return { kind: "barrier", method: "" };
  }
  if (!message || typeof message !== "object") return { kind: "barrier", method: "" };
  if (typeof message.method !== "string") {
    // 无 method 且带 result/error 的帧是对 App Server 主动请求的回包；服务端已经知道该 ID，无需等待后续请求。
    if (message.id != null && (hasOwn(message, "result") || hasOwn(message, "error"))) {
      return { kind: "server-response", method: "" };
    }
    return { kind: "barrier", method: "" };
  }

  const method = message.method;
  const threadId = clientThreadIdFromMessage(message);
  const isThreadScoped = THREAD_SCOPED_CLIENT_METHODS.has(method) || method === "getConversationSummary";
  const hasOptionalThreadContext = OPTIONAL_THREAD_CONTEXT_READ_METHODS.has(method) && threadId;
  if (isThreadScoped || hasOptionalThreadContext) {
    if (!threadId) return { kind: "barrier", method };
    if (
      method === "thread/resume" &&
      (message.params?.history != null || String(message.params?.path || ""))
    ) {
      // history/path 模式可能忽略 threadId，不能错误地把它当成单任务请求。
      return { kind: "barrier", method };
    }
    return {
      kind: "thread",
      method,
      operation:
        method === "turn/start"
          ? "turn-start"
          : THREAD_SCOPED_READ_METHODS.has(method) || OPTIONAL_THREAD_CONTEXT_READ_METHODS.has(method)
            ? "read"
            : "write",
      threadId,
    };
  }
  if (THREAD_INDEX_READ_METHODS.has(method)) return { kind: "thread-index-read", method };
  if (INDEPENDENT_CLIENT_READ_METHODS.has(method)) return { kind: "independent-read", method };
  return { kind: "barrier", method };
}

function clientFramesConflict(earlier, candidate) {
  // 主进程对服务端请求的回包必须及时返回，不能被任何正在分类的用户请求拖住。
  if (candidate.kind === "server-response") return false;
  if (earlier.kind === "server-response") return true;
  if (earlier.kind === "barrier" || candidate.kind === "barrier") return true;
  if (earlier.kind === "thread" && candidate.kind === "thread") {
    return earlier.threadId === candidate.threadId;
  }
  if (candidate.kind === "thread-index-read" && earlier.kind === "thread") {
    // 列表可以接受尚未开始的新回合，但不能越过会改变列表内容的任务写操作。
    return earlier.operation === "write";
  }
  if (earlier.kind === "thread-index-read" && candidate.kind === "thread") {
    return candidate.operation === "write";
  }
  return false;
}

function createAppServerTransport({ processClientMessage, processServerMessage, onAttached, onClosed } = {}) {
  let child = null;
  let directStdin = null;
  let requestCounter = 0;
  let connectionGeneration = 0;
  const pendingRequests = new Map();
  const notificationWaiters = new Set();
  const notificationObservers = new Set();
  const internalThreadIds = new Set();
  const internalThreadTombstones = new Map();
  const internalTurnIds = new Set();

  function pruneInternalThreadTombstones() {
    const now = Date.now();
    for (const [threadId, expiresAt] of internalThreadTombstones) {
      if (expiresAt <= now) internalThreadTombstones.delete(threadId);
    }
  }

  function tombstoneInternalThread(threadId) {
    const normalized = String(threadId || "");
    if (!normalized) return;
    internalThreadIds.delete(normalized);
    // 删除确认后的尾部通知仍可能稍晚到达，保留短期 tombstone 防止泄漏到官方 Main。
    internalThreadTombstones.set(normalized, Date.now() + 5 * 60 * 1_000);
    pruneInternalThreadTombstones();
    while (internalThreadTombstones.size > MAX_INTERNAL_THREAD_TOMBSTONES) {
      internalThreadTombstones.delete(internalThreadTombstones.keys().next().value);
    }
  }

  function rejectPending(error) {
    for (const pending of pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    pendingRequests.clear();
    for (const waiter of notificationWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    notificationWaiters.clear();
  }

  function writeDirectBuffer(buffer) {
    return new Promise((resolve, reject) => {
      if (!directStdin || directStdin.destroyed || directStdin.writableEnded) {
        reject(new AppServerTransportError("App Server stdin is unavailable", "closed"));
        return;
      }
      directStdin.write(buffer, (error) => {
        if (error) reject(new AppServerTransportError(error.message || String(error), "write"));
        else resolve();
      });
    });
  }

  function writeMessage(message) {
    return writeDirectBuffer(Buffer.from(`${JSON.stringify(message)}\n`, "utf-8"));
  }

  function request(method, params, options = {}) {
    const timeoutMs = Math.max(1, Number(options.timeoutMs || 10_000));
    const id = `${ROUTER_REQUEST_PREFIX}${++requestCounter}`;
    const generation = connectionGeneration;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingRequests.delete(id);
        reject(new AppServerTransportError(`Internal App Server request timed out: ${method}`, "timeout"));
      }, timeoutMs);
      pendingRequests.set(id, {
        generation,
        method,
        params,
        resolve,
        reject,
        timer,
      });
      writeMessage({ id, method, params }).catch((error) => {
        const pending = pendingRequests.get(id);
        if (!pending) return;
        pendingRequests.delete(id);
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  function waitForNotification(predicate, options = {}) {
    const timeoutMs = Math.max(1, Number(options.timeoutMs || 10_000));
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        notificationWaiters.delete(waiter);
        reject(new AppServerTransportError("Internal App Server notification timed out", "timeout"));
      }, timeoutMs);
      notificationWaiters.add(waiter);
    });
  }

  function publishNotification(message) {
    for (const observer of Array.from(notificationObservers)) {
      try {
        observer(message);
      } catch {
        // 观察器只用于收集内部分类结果，单个回调异常不能影响协议转发或其它等待器。
      }
    }
    for (const waiter of Array.from(notificationWaiters)) {
      let matches = false;
      try {
        matches = typeof waiter.predicate === "function" && waiter.predicate(message);
      } catch (error) {
        notificationWaiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.reject(error);
        continue;
      }
      if (!matches) continue;
      notificationWaiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
  }

  function consumeInternalResponse(message) {
    const id = typeof message?.id === "string" ? message.id : "";
    if (!id.startsWith(ROUTER_REQUEST_PREFIX)) return false;
    const pending = pendingRequests.get(id);
    if (!pending) {
      const lateThreadId = threadIdFromMessage(message);
      if (lateThreadId && message?.result?.thread?.ephemeral === true) {
        internalThreadIds.add(lateThreadId);
        // 超时后才到达的 ephemeral thread/start 也要主动回收，不能只隐藏。
        void request("thread/delete", { threadId: lateThreadId }, { timeoutMs: 1_500 })
          .catch(() => {})
          .finally(() => tombstoneInternalThread(lateThreadId));
      }
      return true;
    }
    pendingRequests.delete(id);
    clearTimeout(pending.timer);
    if (pending.generation !== connectionGeneration) {
      pending.reject(new AppServerTransportError("App Server connection changed", "closed"));
      return true;
    }
    if (message.error) {
      const error = new AppServerTransportError(
        String(message.error.message || `Internal App Server request failed: ${pending.method}`),
        "response"
      );
      error.response = message.error;
      pending.reject(error);
      return true;
    }
    if (pending.method === "thread/start") {
      const threadId = threadIdFromMessage(message);
      if (threadId) internalThreadIds.add(threadId);
    }
    if (pending.method === "turn/start") {
      const turnId = turnIdFromMessage(message);
      if (turnId) internalTurnIds.add(turnId);
    }
    if (pending.method === "thread/delete") {
      const threadId = String(pending.params?.threadId || "");
      if (threadId) tombstoneInternalThread(threadId);
    }
    pending.resolve(message.result);
    return true;
  }

  function isInternalScopedMessage(message) {
    const threadId = threadIdFromMessage(message);
    pruneInternalThreadTombstones();
    if (threadId && (internalThreadIds.has(threadId) || internalThreadTombstones.has(threadId))) return true;
    const turnId = turnIdFromMessage(message);
    return !!turnId && internalTurnIds.has(turnId);
  }

  function processIncomingServerMessage(message) {
    if (consumeInternalResponse(message)) return null;
    if (message?.method) publishNotification(message);
    const internalScoped = isInternalScopedMessage(message);
    if (internalScoped) {
      if (message.id != null) {
        // 分类线程禁止审批和动态工具；若服务端仍发起请求，明确拒绝并在网关内消费。
        void writeMessage({
          id: message.id,
          error: { code: -32001, message: "Internal router sessions do not allow host interactions" },
        }).catch(() => {});
      }
      if (INTERNAL_TURN_TERMINAL_METHODS.has(message.method)) {
        internalTurnIds.delete(turnIdFromMessage(message));
      }
      return null;
    }
    return typeof processServerMessage === "function" ? processServerMessage(message) : message;
  }

  async function prepareOutgoingClientLine(rawLine) {
    let message;
    try {
      message = JSON.parse(rawLine);
    } catch {
      // 未识别的行保持原样透传，避免中间层因新协议帧格式而阻断官方 runtime。
      return Buffer.from(`${rawLine}\n`, "utf-8");
    }
    const next = typeof processClientMessage === "function" ? await processClientMessage(message) : message;
    return next == null ? null : Buffer.from(`${JSON.stringify(next)}\n`, "utf-8");
  }

  function replaceChildStream(target, key, value) {
    try {
      Object.defineProperty(target, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value,
      });
      return true;
    } catch {
      try {
        target[key] = value;
        return target[key] === value;
      } catch {
        return false;
      }
    }
  }

  function decorateChild(nextChild) {
    if (!nextChild || nextChild[DECORATED_CHILD]) return nextChild;
    const realStdin = nextChild.stdin;
    const realStdout = nextChild.stdout;
    if (!realStdin || !realStdout) return nextChild;

    if (child && child !== nextChild) {
      rejectPending(new AppServerTransportError("App Server process was replaced", "closed"));
      internalThreadIds.clear();
      internalThreadTombstones.clear();
      internalTurnIds.clear();
    }
    child = nextChild;
    directStdin = realStdin;
    connectionGeneration += 1;

    const clientDecoder = new StringDecoder("utf-8");
    let clientBuffer = "";
    let nextClientFrame = 0;
    let flushingClientFrames = false;
    let clientFailure = null;
    const clientFrames = new Map();
    const clientCapacityCallbacks = [];
    const clientIdleWaiters = [];
    let clientStdin;

    function pendingClientFrameCount() {
      return clientFrames.size;
    }

    function settleClientWaiters() {
      if (clientFailure || pendingClientFrameCount() < MAX_PENDING_CLIENT_FRAMES) {
        for (const callback of clientCapacityCallbacks.splice(0)) callback(clientFailure);
      }
      if (clientFailure || pendingClientFrameCount() === 0) {
        for (const waiter of clientIdleWaiters.splice(0)) {
          if (clientFailure) waiter.reject(clientFailure);
          else waiter.resolve();
        }
      }
    }

    function findDispatchableClientFrame() {
      for (const candidate of clientFrames.values()) {
        if (candidate.state === "pending") continue;
        let blocked = false;
        for (const earlier of clientFrames.values()) {
          if (earlier.index === candidate.index) break;
          if (clientFramesConflict(earlier.descriptor, candidate.descriptor)) {
            blocked = true;
            break;
          }
        }
        if (!blocked) return candidate;
      }
      return null;
    }

    async function flushClientFrames() {
      if (flushingClientFrames || clientFailure) return;
      flushingClientFrames = true;
      try {
        let record;
        while ((record = findDispatchableClientFrame())) {
          if (record.state === "failed") throw record.error;
          // 只跳过已确认无依赖的帧；实际 stdin 写入仍逐帧 await，避免两个 NDJSON 消息交叉。
          if (record.frame) await writeDirectBuffer(record.frame);
          clientFrames.delete(record.index);
          settleClientWaiters();
        }
      } catch (error) {
        clientFailure = error;
        clientFrames.clear();
        settleClientWaiters();
        if (clientStdin && !clientStdin.destroyed) clientStdin.destroy(error);
      } finally {
        flushingClientFrames = false;
        // await 写入期间可能有 middleware 完成，退出前再检查一次，避免队列失去唤醒。
        if (!clientFailure && findDispatchableClientFrame()) void flushClientFrames();
      }
    }

    function enqueueClientLine(rawLine) {
      const frameIndex = nextClientFrame;
      nextClientFrame += 1;
      const record = {
        descriptor: clientFrameDescriptor(rawLine),
        error: null,
        frame: null,
        index: frameIndex,
        state: "pending",
      };
      clientFrames.set(frameIndex, record);
      // 立即启动每一帧的 middleware；settle 回调在记录上接住异常，避免被前序慢帧拖成未处理 rejection。
      void prepareOutgoingClientLine(rawLine).then(
        (frame) => {
          record.frame = frame;
          record.state = "ready";
          void flushClientFrames();
        },
        (error) => {
          record.error = error;
          record.state = "failed";
          void flushClientFrames();
        }
      );
    }

    function enqueueClientText(text) {
      clientBuffer += text;
      const lines = clientBuffer.split("\n");
      clientBuffer = lines.pop() || "";
      for (const line of lines) {
        const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
        if (normalized) enqueueClientLine(normalized);
      }
    }

    function waitForClientIdle() {
      if (clientFailure) return Promise.reject(clientFailure);
      if (pendingClientFrameCount() === 0) return Promise.resolve();
      return new Promise((resolve, reject) => clientIdleWaiters.push({ resolve, reject }));
    }

    clientStdin = new Writable({
      write(chunk, encoding, callback) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
        enqueueClientText(clientDecoder.write(buffer));
        // 只在积压达到上限时延迟 write callback，让 Node 的 Writable 背压继续生效。
        if (pendingClientFrameCount() >= MAX_PENDING_CLIENT_FRAMES) clientCapacityCallbacks.push(callback);
        else callback();
      },
      final(callback) {
        enqueueClientText(clientDecoder.end());
        if (clientBuffer) enqueueClientLine(clientBuffer);
        clientBuffer = "";
        waitForClientIdle().then(
          () => realStdin.end(callback),
          callback
        );
      },
    });

    const publicStdout = new PassThrough();
    const serverDecoder = new StringDecoder("utf-8");
    let serverBuffer = "";
    let publicQueue = [];
    let waitingForDrain = false;
    let sourceEnded = false;

    function finishPublicOutputIfReady() {
      if (sourceEnded && publicQueue.length === 0 && !waitingForDrain && !publicStdout.writableEnded) publicStdout.end();
    }

    function flushPublicQueue() {
      if (waitingForDrain || publicStdout.destroyed) return;
      while (publicQueue.length > 0) {
        const frame = publicQueue.shift();
        if (!publicStdout.write(frame)) {
          waitingForDrain = true;
          realStdout.pause();
          publicStdout.once("drain", () => {
            waitingForDrain = false;
            realStdout.resume();
            flushPublicQueue();
            finishPublicOutputIfReady();
          });
          return;
        }
      }
      finishPublicOutputIfReady();
    }

    function routeServerLine(rawLine) {
      let parsed;
      try {
        parsed = JSON.parse(rawLine);
      } catch {
        publicQueue.push(Buffer.from(`${rawLine}\n`, "utf-8"));
        return;
      }
      try {
        const next = processIncomingServerMessage(parsed);
        if (next != null) publicQueue.push(Buffer.from(`${JSON.stringify(next)}\n`, "utf-8"));
      } catch {
        // 中间层自身的响应处理异常不能吞掉官方协议帧，原始响应仍交给 Main。
        publicQueue.push(Buffer.from(`${rawLine}\n`, "utf-8"));
      }
    }

    realStdout.on("data", (chunk) => {
      serverBuffer += serverDecoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      const lines = serverBuffer.split("\n");
      serverBuffer = lines.pop() || "";
      for (const line of lines) {
        const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
        if (normalized) routeServerLine(normalized);
      }
      flushPublicQueue();
    });
    realStdout.on("end", () => {
      serverBuffer += serverDecoder.end();
      if (serverBuffer) routeServerLine(serverBuffer);
      serverBuffer = "";
      sourceEnded = true;
      flushPublicQueue();
      finishPublicOutputIfReady();
    });
    realStdout.on("error", (error) => publicStdout.destroy(error));
    realStdin.on("error", (error) => clientStdin.destroy(error));

    replaceChildStream(nextChild, "stdin", clientStdin);
    replaceChildStream(nextChild, "stdout", publicStdout);
    if (Array.isArray(nextChild.stdio)) {
      // 部分调用方读取 child.stdio 而不是快捷属性，两处必须指向同一包装流。
      nextChild.stdio[0] = clientStdin;
      nextChild.stdio[1] = publicStdout;
    }
    Object.defineProperty(nextChild, DECORATED_CHILD, { value: true });
    nextChild.once("close", () => {
      if (child !== nextChild) return;
      child = null;
      directStdin = null;
      rejectPending(new AppServerTransportError("App Server process closed", "closed"));
      internalThreadIds.clear();
      internalThreadTombstones.clear();
      internalTurnIds.clear();
      if (typeof onClosed === "function") onClosed();
    });
    if (typeof onAttached === "function") onAttached(nextChild);
    return nextChild;
  }

  return {
    decorateChild,
    isAttached() {
      return !!directStdin && !directStdin.destroyed && !directStdin.writableEnded;
    },
    isInternalThreadId(threadId) {
      pruneInternalThreadTombstones();
      const normalized = String(threadId || "");
      return internalThreadIds.has(normalized) || internalThreadTombstones.has(normalized);
    },
    internalThreadIds() {
      return new Set(internalThreadIds);
    },
    internalTurnIds() {
      return new Set(internalTurnIds);
    },
    observeNotifications(observer) {
      if (typeof observer !== "function") return () => {};
      notificationObservers.add(observer);
      return () => notificationObservers.delete(observer);
    },
    registerInternalThread(threadId) {
      if (threadId) {
        internalThreadTombstones.delete(String(threadId));
        internalThreadIds.add(String(threadId));
      }
    },
    rejectPending,
    request,
    unregisterInternalThread(threadId) {
      tombstoneInternalThread(threadId);
    },
    unregisterInternalTurn(turnId) {
      if (turnId) internalTurnIds.delete(String(turnId));
    },
    waitForNotification,
    writeMessage,
  };
}

module.exports = {
  AppServerTransportError,
  DECORATED_CHILD,
  createAppServerTransport,
  threadIdFromMessage,
  turnIdFromMessage,
};
