const { PassThrough, Writable } = require("stream");
const { StringDecoder } = require("string_decoder");
const { ROUTER_REQUEST_PREFIX } = require("./constants.cjs");

const DECORATED_CHILD = Symbol("opencodexModelRouterDecoratedChild");
const MAX_PENDING_CLIENT_FRAMES = 64;

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
      if (message.method === "turn/completed") internalTurnIds.delete(turnIdFromMessage(message));
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
    let nextClientCommit = 0;
    let flushingClientFrames = false;
    let clientFailure = null;
    const clientFrames = new Map();
    const clientCapacityCallbacks = [];
    const clientIdleWaiters = [];
    let clientStdin;

    function pendingClientFrameCount() {
      return nextClientFrame - nextClientCommit;
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

    async function flushClientFrames() {
      if (flushingClientFrames || clientFailure) return;
      flushingClientFrames = true;
      try {
        while (clientFrames.has(nextClientCommit)) {
          // 每一帧的分类可并发执行，但写回真实 stdin 时按官方原始顺序提交。
          const frame = await clientFrames.get(nextClientCommit);
          if (frame) await writeDirectBuffer(frame);
          clientFrames.delete(nextClientCommit);
          nextClientCommit += 1;
          settleClientWaiters();
        }
      } catch (error) {
        clientFailure = error;
        // 已并发启动的后续 middleware 仍可能失败，显式接住并清空，避免未处理 rejection。
        for (const frame of clientFrames.values()) void frame.catch(() => {});
        clientFrames.clear();
        nextClientCommit = nextClientFrame;
        settleClientWaiters();
        if (clientStdin && !clientStdin.destroyed) clientStdin.destroy(error);
      } finally {
        flushingClientFrames = false;
        // await 期间可能追加了下一帧，退出前再检查一次避免队列失去唤醒。
        if (!clientFailure && clientFrames.has(nextClientCommit)) void flushClientFrames();
      }
    }

    function enqueueClientLine(rawLine) {
      const frameIndex = nextClientFrame;
      nextClientFrame += 1;
      // Promise 创建时就开始执行 middleware，使两个 Auto turn 能并发占用分类器的两个 permit。
      clientFrames.set(frameIndex, prepareOutgoingClientLine(rawLine));
      void flushClientFrames();
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
