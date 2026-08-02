(function exposeThreadStatusEvidence(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root?.document) api.install(root);
})(typeof window === "object" ? window : null, () => {
  const THREAD_STATUS_METHOD = "thread/status/changed";
  const KNOWN_STATUS_TYPES = new Set(["active", "idle", "notLoaded", "systemError"]);

  function statusKey(hostId, threadId) {
    return JSON.stringify([hostId || "local", threadId]);
  }

  function statusChangeFromMessage(message) {
    if (
      !message ||
      typeof message !== "object" ||
      message.method !== THREAD_STATUS_METHOD ||
      !message.params ||
      typeof message.params.threadId !== "string" ||
      !message.params.threadId ||
      !KNOWN_STATUS_TYPES.has(message.params.status?.type)
    ) {
      return null;
    }
    return {
      key: statusKey(message.hostId, message.params.threadId),
      pending: message.params.status.type === "notLoaded",
    };
  }

  function createPendingThreadStore(onChange = () => {}) {
    const pending = new Set();
    return {
      handle(message) {
        const change = statusChangeFromMessage(message);
        if (!change) return false;
        const hadPending = pending.has(change.key);
        if (change.pending) pending.add(change.key);
        else pending.delete(change.key);
        if (hadPending !== change.pending) onChange();
        return true;
      },
      pendingThreadKeys() {
        return new Set(pending);
      },
    };
  }

  function threadIdFromRow(row) {
    const threadId = row?.getAttribute?.("data-app-action-sidebar-thread-id") || "";
    const hostId = row?.getAttribute?.("data-app-action-sidebar-thread-host-id") || "local";
    const hostPrefix = `${hostId}:`;
    // 官方 DOM 会给本地 row id 加 host 前缀，而状态事件始终使用裸 thread id。
    return threadId.startsWith(hostPrefix) ? threadId.slice(hostPrefix.length) : threadId;
  }

  function statusKeyFromRow(row) {
    const threadId = threadIdFromRow(row);
    if (!threadId) return "";
    return statusKey(row?.getAttribute?.("data-app-action-sidebar-thread-host-id"), threadId);
  }

  function install(root) {
    if (root.__OpenCodexThreadStatusEvidence) return root.__OpenCodexThreadStatusEvidence;
    const document = root.document;
    let renderQueued = false;
    let rendererReadySignature = "";

    function render() {
      renderQueued = false;
      const pending = store.pendingThreadKeys();
      for (const indicator of document.querySelectorAll("[data-opencodex-thread-status-pending]")) {
        if (!pending.has(indicator.dataset.opencodexThreadStatusPending)) indicator.remove();
      }
      const rows = document.querySelectorAll("[data-app-action-sidebar-thread-row]");
      const readySignature = [...rows].map(statusKeyFromRow).filter(Boolean).sort().join("\n");
      if (readySignature && readySignature !== rendererReadySignature) {
        rendererReadySignature = readySignature;
        root.__OpenCodexThreadStatusRendererReady?.();
      }
      for (const row of rows) {
        const key = statusKeyFromRow(row);
        if (!key || !pending.has(key)) {
          delete row.dataset.opencodexPendingRow;
          continue;
        }
        row.dataset.opencodexPendingRow = "true";
        if (row.querySelector("[data-opencodex-thread-status-pending]")) continue;
        const indicator = document.createElement("span");
        indicator.dataset.opencodexThreadStatusPending = key;
        indicator.className = "opencodex-thread-status-pending";
        indicator.setAttribute("aria-label", "状态待确认");
        indicator.setAttribute("role", "img");
        indicator.title = "状态待确认";
        row.appendChild(indicator);
      }
    }

    function scheduleRender() {
      if (renderQueued) return;
      renderQueued = true;
      root.queueMicrotask(render);
    }

    const store = createPendingThreadStore(scheduleRender);
    const style = document.createElement("style");
    style.dataset.opencodexThreadStatusEvidence = "true";
    style.textContent = `
[data-opencodex-pending-row="true"] {
  position: relative;
}
.opencodex-thread-status-pending {
  position: absolute;
  top: 50%;
  right: 28px;
  box-sizing: border-box;
  width: 13px;
  height: 13px;
  border: 1.5px solid var(--color-token-text-tertiary, #8b8b8b);
  border-radius: 50%;
  background: var(--color-background-surface-under, #fff);
  color: var(--color-token-text-tertiary, #8b8b8b);
  transform: translateY(-50%);
  z-index: 2;
}
.opencodex-thread-status-pending::before {
  content: "";
  position: absolute;
  left: 5px;
  top: 2px;
  width: 1.5px;
  height: 4px;
  border-radius: 1px;
  background: currentColor;
}
.opencodex-thread-status-pending::after {
  content: "";
  position: absolute;
  left: 5px;
  top: 5px;
  width: 3px;
  height: 1.5px;
  border-radius: 1px;
  background: currentColor;
}
`;
    (document.head || document.documentElement).appendChild(style);
    root.addEventListener("message", (event) => store.handle(event.data));
    const observer = new root.MutationObserver(scheduleRender);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    scheduleRender();

    const api = { pendingThreadKeys: store.pendingThreadKeys, render };
    root.__OpenCodexThreadStatusEvidence = api;
    return api;
  }

  return { createPendingThreadStore, install, statusChangeFromMessage, statusKeyFromRow, threadIdFromRow };
});
