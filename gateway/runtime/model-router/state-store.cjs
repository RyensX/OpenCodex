const fs = require("fs");
const path = require("path");

const STATE_SCHEMA_VERSION = 1;
const DEFAULT_MAX_THREAD_STATES = 2048;

function emptyState() {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    default: { auto: false, lastModel: "", lastEffort: "" },
    threads: {},
  };
}

function normalizeRouteState(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    auto: source.auto === true,
    lastModel: typeof source.lastModel === "string" ? source.lastModel : "",
    lastEffort: typeof source.lastEffort === "string" ? source.lastEffort : "",
    lastTier: typeof source.lastTier === "string" ? source.lastTier : "",
    lastFallback: source.lastFallback === true,
    updatedAt: Number.isFinite(Number(source.updatedAt)) ? Number(source.updatedAt) : 0,
  };
}

function normalizeState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return emptyState();
  const threads = {};
  if (value.threads && typeof value.threads === "object" && !Array.isArray(value.threads)) {
    for (const [threadId, state] of Object.entries(value.threads)) {
      if (threadId) threads[threadId] = normalizeRouteState(state);
    }
  }
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    default: normalizeRouteState(value.default),
    threads,
  };
}

function trimThreadStates(threads, maxThreads) {
  const entries = Object.entries(threads || {});
  const limit = Math.max(1, Number(maxThreads) || DEFAULT_MAX_THREAD_STATES);
  if (entries.length <= limit) return threads;
  // 先淘汰最旧的手动会话，再淘汰最旧 Auto 会话，尽量保留仍影响模型虚拟化的状态。
  entries.sort((left, right) => {
    const autoDifference = Number(left[1]?.auto === true) - Number(right[1]?.auto === true);
    if (autoDifference !== 0) return autoDifference;
    return Number(left[1]?.updatedAt || 0) - Number(right[1]?.updatedAt || 0);
  });
  for (let index = 0; index < entries.length - limit; index += 1) delete threads[entries[index][0]];
  return threads;
}

function createAutoStateStore({ filePath, maxThreads = DEFAULT_MAX_THREAD_STATES }) {
  let state = load();
  const loadedThreadCount = Object.keys(state.threads).length;
  trimThreadStates(state.threads, maxThreads);

  function load() {
    try {
      if (fs.existsSync(filePath)) return normalizeState(JSON.parse(fs.readFileSync(filePath, "utf-8")));
    } catch (error) {
      console.warn("[gateway] smart router state ignored:", error instanceof Error ? error.message : String(error));
    }
    return emptyState();
  }

  function persist() {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
    fs.writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
    try {
      fs.renameSync(temporaryPath, filePath);
    } catch (error) {
      try {
        fs.unlinkSync(temporaryPath);
      } catch {}
      throw error;
    }
  }

  // 旧文件超过新上限时立即收敛磁盘状态，避免每次启动都重新解析已经淘汰的大量线程。
  if (Object.keys(state.threads).length !== loadedThreadCount) persist();

  function updateDefault(patch) {
    const unchanged = Object.entries(patch).every(([key, value]) => state.default[key] === value);
    if (unchanged) return { ...state.default };
    state.default = { ...state.default, ...patch, updatedAt: Date.now() };
    persist();
    return { ...state.default };
  }

  function updateThread(threadId, patch) {
    if (!threadId) return null;
    const current = normalizeRouteState(state.threads[threadId]);
    const unchanged = state.threads[threadId] && Object.entries(patch).every(([key, value]) => current[key] === value);
    // 高频 config/read 与重复通知不应反复触发磁盘原子替换。
    if (unchanged) return { ...current };
    state.threads[threadId] = {
      ...current,
      ...patch,
      updatedAt: Date.now(),
    };
    trimThreadStates(state.threads, maxThreads);
    persist();
    return { ...state.threads[threadId] };
  }

  function removeThread(threadId) {
    if (!threadId || !state.threads[threadId]) return false;
    delete state.threads[threadId];
    persist();
    return true;
  }

  function clearAllAuto() {
    let changed = state.default.auto === true;
    state.default.auto = false;
    for (const thread of Object.values(state.threads)) {
      if (thread.auto) changed = true;
      thread.auto = false;
    }
    // 关闭功能时不删除最后一次真实路由，底层线程可继续沿用该模型。
    if (changed) persist();
  }

  return {
    clearAllAuto,
    defaultState() {
      return { ...state.default };
    },
    isDefaultAuto() {
      return state.default.auto === true;
    },
    isThreadAuto(threadId) {
      return state.threads[threadId]?.auto === true;
    },
    recordRoute(threadId, route) {
      return updateThread(threadId, {
        lastTier: String(route?.tier || ""),
        lastModel: String(route?.model || ""),
        lastEffort: String(route?.effort || ""),
        lastFallback: route?.fallback === true,
      });
    },
    removeThread,
    setDefaultAuto(enabled, concrete = {}) {
      return updateDefault({
        auto: enabled === true,
        ...(concrete.model ? { lastModel: String(concrete.model) } : {}),
        ...(concrete.effort ? { lastEffort: String(concrete.effort) } : {}),
      });
    },
    setThreadAuto(threadId, enabled, concrete = {}) {
      return updateThread(threadId, {
        auto: enabled === true,
        ...(concrete.model ? { lastModel: String(concrete.model) } : {}),
        ...(concrete.effort ? { lastEffort: String(concrete.effort) } : {}),
      });
    },
    snapshot() {
      return JSON.parse(JSON.stringify(state));
    },
    threadState(threadId) {
      return threadId && state.threads[threadId] ? { ...state.threads[threadId] } : null;
    },
  };
}

module.exports = {
  STATE_SCHEMA_VERSION,
  DEFAULT_MAX_THREAD_STATES,
  createAutoStateStore,
  emptyState,
  normalizeState,
  trimThreadStates,
};
