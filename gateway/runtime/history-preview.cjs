const HISTORY_PREVIEW_LIMIT = 12;
const HISTORY_PREVIEW_CACHE_TTL_MS = 1_000;
const HISTORY_PREVIEW_ATTACH_POLL_MS = 10;
const HISTORY_PREVIEW_REQUEST_TIMEOUT_MS = 700;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForAtMost(task, timeoutMs) {
  let timer = null;
  try {
    // 导航提前拿到快照时立即清理预算 timer，避免高频刷新遗留成批无意义的定时回调。
    await Promise.race([
      task,
      new Promise((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function boundedText(value, maxLength) {
  const text = String(value || "").trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function normalizePreviewThread(thread) {
  if (!thread || typeof thread !== "object") return null;
  const id = boundedText(thread.id, 200);
  if (!id) return null;
  const updatedAt = Number(thread.updatedAt);
  return {
    id,
    // 标题和 cwd 只用于首屏只读预览，长度上限避免异常历史记录撑大入口 HTML。
    title: boundedText(thread.name || thread.title, 240),
    cwd: boundedText(thread.cwd, 2_048),
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
  };
}

function createHistoryPreviewService({ transport, now = () => Date.now() } = {}) {
  let cachedThreads = [];
  let refreshedAtMs = 0;
  let refreshPromise = null;
  let disposed = false;

  async function waitUntilAttached(deadlineAtMs) {
    while (!disposed && !transport?.isAttached?.() && now() < deadlineAtMs) {
      await delay(Math.min(HISTORY_PREVIEW_ATTACH_POLL_MS, Math.max(1, deadlineAtMs - now())));
    }
    return !disposed && transport?.isAttached?.() === true;
  }

  async function load(deadlineAtMs) {
    if (!(await waitUntilAttached(deadlineAtMs))) return cachedThreads;
    const timeoutMs = Math.max(1, Math.min(HISTORY_PREVIEW_REQUEST_TIMEOUT_MS, deadlineAtMs - now()));
    if (timeoutMs <= 1) return cachedThreads;
    const result = await transport.request(
      "thread/list",
      {
        archived: false,
        cursor: null,
        limit: HISTORY_PREVIEW_LIMIT,
        modelProviders: null,
        sortKey: "updated_at",
        useStateDbOnly: true,
      },
      { timeoutMs }
    );
    // dispose 可能与仍在途的官方请求交错；销毁后不再让迟到结果复活首屏缓存。
    if (disposed) return cachedThreads;
    const seen = new Set();
    cachedThreads = (Array.isArray(result?.data) ? result.data : [])
      .filter((thread) => !transport.isInternalThreadId?.(thread?.id))
      .map(normalizePreviewThread)
      .filter((thread) => {
        if (!thread || seen.has(thread.id)) return false;
        seen.add(thread.id);
        return true;
      })
      .slice(0, HISTORY_PREVIEW_LIMIT);
    refreshedAtMs = now();
    return cachedThreads;
  }

  function ensureRefresh(maxWaitMs) {
    if (disposed) return Promise.resolve(cachedThreads);
    if (refreshedAtMs > 0 && now() - refreshedAtMs <= HISTORY_PREVIEW_CACHE_TTL_MS) {
      return Promise.resolve(cachedThreads);
    }
    if (!refreshPromise) {
      const deadlineAtMs = now() + Math.max(1, Number(maxWaitMs) || HISTORY_PREVIEW_REQUEST_TIMEOUT_MS);
      // 多个并发导航共享一次 thread/list；失败时沿用最近快照，绝不阻断官方页面加载。
      refreshPromise = load(deadlineAtMs)
        .catch(() => cachedThreads)
        .finally(() => {
          refreshPromise = null;
        });
    }
    return refreshPromise;
  }

  async function snapshot({ maxWaitMs = HISTORY_PREVIEW_REQUEST_TIMEOUT_MS } = {}) {
    const waitMs = Math.max(1, Number(maxWaitMs) || HISTORY_PREVIEW_REQUEST_TIMEOUT_MS);
    const hasCompletedSnapshot = refreshedAtMs > 0;
    const task = ensureRefresh(waitMs);
    if (hasCompletedSnapshot) {
      // 入口只需要一份可见占位；已有快照过期时立即复用并在后台刷新，不能让导航等待 App Server。
      void task;
      return {
        generatedAtMs: refreshedAtMs,
        threads: cachedThreads.map((thread) => ({ ...thread })),
      };
    }
    // 已在进行的预热可能有更长 deadline；当前导航只等待自己的预算，超时即返回旧快照。
    await waitForAtMost(task, waitMs);
    return {
      generatedAtMs: refreshedAtMs,
      threads: cachedThreads.map((thread) => ({ ...thread })),
    };
  }

  return {
    dispose() {
      disposed = true;
      cachedThreads = [];
      refreshedAtMs = 0;
    },
    snapshot,
    warm() {
      // 网关监听端口前就开始预热；首个浏览器导航会复用同一个 Promise。
      return ensureRefresh(HISTORY_PREVIEW_REQUEST_TIMEOUT_MS);
    },
  };
}

module.exports = {
  HISTORY_PREVIEW_LIMIT,
  createHistoryPreviewService,
  normalizePreviewThread,
};
