(() => {
  const w = window;
  const existing = w.OpenCodexRuntimeCompatibility;
  if (existing?.apiVersion === 2 && typeof existing.ingestSnapshot === "function") return;

  const ENDPOINT = "/api/opencodex/runtime-compatibility/reports";
  const MAX_REPORTS_PER_FLUSH = 16;
  const clientId =
    w.crypto?.randomUUID?.() || `browser_page_${Math.random().toString(36).slice(2, 18)}`;
  const queue = new Map();
  const sentSignatures = new Map();
  let flushTimer = null;
  let flushing = false;
  let retryDelayMs = 1000;
  let generation = 1;
  let sequence = 0;
  let observedDocument = null;

  function handleVisibilityChange() {
    if (document.visibilityState === "visible" && queue.size > 0) scheduleFlush();
  }

  function bindCurrentDocument() {
    if (observedDocument === document) return;
    observedDocument?.removeEventListener?.("visibilitychange", handleVisibilityChange);
    observedDocument = document;
    observedDocument.addEventListener("visibilitychange", handleVisibilityChange);
  }

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

  function normalizedContribution(value) {
    const source = value && typeof value === "object" ? value : {};
    return {
      id: String(source.id || ""),
      directAdapterId: String(source.directAdapterId || ""),
      adapterId: String(source.adapterId || ""),
      adapterChainIds: Array.isArray(source.adapterChainIds)
        ? source.adapterChainIds.map((item) => String(item || ""))
        : [],
      location: String(source.location || "unresolved"),
      application: String(source.application || "pending"),
      verification: String(source.verification || "pending"),
      activation: String(source.activation || "inactive"),
      exercise: String(source.exercise || "not-exercised"),
      hitCount: Math.max(0, Math.trunc(Number(source.hitCount) || 0)),
      fallbackActive: source.fallbackActive === true,
      fallbackReason: safeReason(source.fallbackReason),
      reason: safeReason(source.reason),
    };
  }

  function normalizedPoint(value) {
    const source = value && typeof value === "object" ? value : {};
    return {
      id: String(source.id || ""),
      groupId: String(source.groupId || ""),
      status: String(source.status || "pending"),
      directAdapterIds: Array.isArray(source.directAdapterIds)
        ? source.directAdapterIds.map((item) => String(item || ""))
        : [],
      adapterChainIds: Array.isArray(source.adapterChainIds)
        ? source.adapterChainIds.map((item) => String(item || ""))
        : [],
      contributions: Array.isArray(source.contributions)
        ? source.contributions.map(normalizedContribution)
        : [],
    };
  }

  function signature(point) {
    return JSON.stringify(point);
  }

  function scheduleFlush(delayMs = 80) {
    if (flushTimer || flushing) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flush();
    }, delayMs);
  }

  function restoreFailedReport(report) {
    if (report.generation !== generation) return;
    const queued = queue.get(report.point.id);
    if (queued && queued.sequence > report.sequence) return;
    queue.set(report.point.id, report);
  }

  async function flush() {
    if (flushing || queue.size === 0) return;
    flushing = true;
    let failed = false;
    const reports = Array.from(queue.values())
      .sort((left, right) => left.sequence - right.sequence)
      .slice(0, MAX_REPORTS_PER_FLUSH);
    for (const report of reports) queue.delete(report.point.id);
    try {
      const response = await fetch(ENDPOINT, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId, generation, reports }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      for (const report of reports) {
        if (report.generation === generation) sentSignatures.set(report.point.id, report.signature);
      }
      retryDelayMs = 1000;
    } catch {
      failed = true;
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

  function ingestSnapshot(snapshot) {
    for (const value of Array.isArray(snapshot?.points) ? snapshot.points : []) {
      const point = normalizedPoint(value);
      if (!point.id.startsWith("web.runtime.") || point.contributions.length === 0) continue;
      const pointSignature = signature(point);
      if (sentSignatures.get(point.id) === pointSignature && !queue.has(point.id)) continue;
      queue.set(point.id, {
        generation,
        point,
        sequence: ++sequence,
        signature: pointSignature,
      });
    }
    scheduleFlush();
  }

  function beginGeneration() {
    bindCurrentDocument();
    generation += 1;
    sequence = 0;
    queue.clear();
    sentSignatures.clear();
  }

  const api = Object.freeze({
    apiVersion: 2,
    clientId,
    beginGeneration,
    ingestSnapshot,
    flush,
  });
  Object.defineProperty(w, "OpenCodexRuntimeCompatibility", {
    configurable: false,
    enumerable: false,
    writable: false,
    value: api,
  });
  bindCurrentDocument();
  w.addEventListener("online", () => queue.size > 0 && scheduleFlush());
})();
