(() => {
  const w = window;
  if (w.OpenCodexRuntimeCompatibility) return;
  const ENDPOINT = "/api/opencodex/runtime-compatibility/reports";
  const PHASE_PRIORITY = { installed: 1, active: 2, fallback: 3, failed: 4, disabled: 4 };
  const clientId =
    w.crypto?.randomUUID?.() || `browser_page_${Math.random().toString(36).slice(2, 18)}`;
  const queue = new Map();
  const sentPhases = new Map();
  let flushTimer = null;
  let flushing = false;
  let retryDelayMs = 1000;

  function safeReason(value) {
    return String(value instanceof Error ? value.message : value || "")
      .replace(/\b[A-Za-z]:\\[^\s]+/g, "[path]")
      .replace(/\/(?:Users|home|private|Volumes|var|tmp)\/[^\s]+/g, "[path]")
      .replace(/([?&](?:token|auth|authorization|code|access_token|refresh_token)=)[^&\s]+/gi, "$1[redacted]")
      .replace(/\b(Bearer)\s+[a-zA-Z0-9._~+/-]+=*/gi, "$1 [redacted]")
      .replace(
        /\b(token|auth|authorization|access_token|refresh_token)\s*[:=]\s*(?:Bearer\s+)?(?:\[redacted\]|[^\s,;]+)/gi,
        "$1=[redacted]"
      )
      .slice(0, 240);
  }

  function scheduleFlush(delayMs = 80) {
    if (flushTimer || flushing) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flush();
    }, delayMs);
  }

  function restoreFailedReport(report) {
    const queued = queue.get(report.id);
    // 请求在途期间可能产生更新状态；只在旧回执优先级更高时覆盖，避免 active 失败后退回 installed。
    if (queued && (PHASE_PRIORITY[queued.phase] || 0) >= (PHASE_PRIORITY[report.phase] || 0)) return;
    queue.set(report.id, report);
  }

  async function flush() {
    if (flushing || queue.size === 0) return;
    flushing = true;
    let failed = false;
    const reports = Array.from(queue.values()).slice(0, 128);
    for (const report of reports) queue.delete(report.id);
    try {
      const response = await fetch(ENDPOINT, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId, reports }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      for (const report of reports) sentPhases.set(report.id, report.phase);
      retryDelayMs = 1000;
    } catch {
      failed = true;
      // 页面加载早于认证 Cookie 刷新或网络短暂断开时保留最后状态，下一次回执会继续尝试。
      for (const report of reports) restoreFailedReport(report);
    } finally {
      flushing = false;
      if (queue.size > 0 && document.visibilityState === "visible") {
        if (failed) {
          scheduleFlush(retryDelayMs);
          retryDelayMs = Math.min(60_000, retryDelayMs * 2);
        } else scheduleFlush();
      }
    }
  }

  function report(id, phase, reason = "") {
    const normalizedId = String(id || "");
    if (!normalizedId.startsWith("web.runtime.")) return false;
    if (sentPhases.get(normalizedId) === phase && !queue.has(normalizedId)) return true;
    const queued = queue.get(normalizedId);
    if (queued && (PHASE_PRIORITY[queued.phase] || 0) > (PHASE_PRIORITY[phase] || 0)) return true;
    queue.set(normalizedId, {
      id: normalizedId,
      phase,
      ...(reason ? { reason: safeReason(reason) } : {}),
    });
    scheduleFlush();
    return true;
  }

  const api = Object.freeze({
    clientId,
    installed(id) { return report(id, "installed"); },
    active(id) { return report(id, "active"); },
    failed(id, reason) { return report(id, "failed", reason); },
    fallback(id, reason) { return report(id, "fallback", reason); },
    disabled(id, reason) { return report(id, "disabled", reason); },
    reportMany(ids, phase = "installed") {
      for (const id of ids || []) report(id, phase);
    },
    flush,
  });
  Object.defineProperty(w, "OpenCodexRuntimeCompatibility", {
    configurable: false,
    enumerable: false,
    writable: false,
    value: api,
  });
  try {
    if (sessionStorage.getItem("opencodex_legacy_document_replace_hit") === "1") {
      sessionStorage.removeItem("opencodex_legacy_document_replace_hit");
      api.active("web.runtime.shell.legacy-document-replace");
    }
  } catch {}
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && queue.size > 0) scheduleFlush();
  });
  w.addEventListener("online", () => queue.size > 0 && scheduleFlush());
})();
