(() => {
  const w = window;
  const existing = w.OpenCodexRuntimeCompatibility;
  if (existing?.apiVersion === 2 && typeof existing.ingestSnapshot === "function") return;

  const ENDPOINT = "/api/opencodex/runtime-compatibility/reports";
  const MAX_REPORTS_PER_FLUSH = 16;
  const clientId =
    w.crypto?.randomUUID?.() || `browser_page_${Math.random().toString(36).slice(2, 18)}`;
  const queue = new Map();
  const catalogQueue = new Map();
  const latestCatalogs = new Map();
  const sentSignatures = new Map();
  const sentCatalogSignatures = new Map();
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
      description: safeReason(source.description),
      owner: String(source.owner || ""),
      plugin: source.plugin && typeof source.plugin === "object"
        ? { id: String(source.plugin.id || ""), name: safeReason(source.plugin.name) }
        : null,
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

  function disabledPoint(point, reason) {
    return {
      ...point,
      status: "disabled",
      contributions: point.contributions.map((contribution) => ({
        ...contribution,
        application: "disabled",
        verification: "not-required",
        activation: "inactive",
        exercise: "disabled",
        hitCount: 0,
        fallbackActive: false,
        fallbackReason: "",
        reason: safeReason(reason || "Plugin disabled"),
      })),
    };
  }

  function normalizedPluginCatalog(snapshot, plugin) {
    const normalizedPlugin = {
      id: String(plugin?.id || ""),
      name: safeReason(plugin?.name),
    };
    if (!normalizedPlugin.id || !normalizedPlugin.name) return null;
    const points = (Array.isArray(snapshot?.points) ? snapshot.points : [])
      .map(normalizedPoint)
      .filter((point) => point.plugin?.id === normalizedPlugin.id && point.plugin?.name === normalizedPlugin.name);
    if (points.length === 0) return null;
    const groupIds = new Set(points.map((point) => point.groupId));
    const adapterIds = new Set(points.flatMap((point) => point.adapterChainIds));
    return {
      plugin: normalizedPlugin,
      groups: (Array.isArray(snapshot?.groups) ? snapshot.groups : [])
        .filter((group) => groupIds.has(String(group?.id || "")))
        .map((group) => ({
          id: String(group.id || ""),
          name: safeReason(group.name),
          description: safeReason(group.description),
          order: Number(group.order),
        })),
      adapterTypes: (Array.isArray(snapshot?.adapterTypes) ? snapshot.adapterTypes : [])
        .filter((adapter) => adapterIds.has(String(adapter?.id || "")))
        .map((adapter) => ({
          id: String(adapter.id || ""),
          name: safeReason(adapter.name),
          description: safeReason(adapter.description),
          kind: String(adapter.kind || ""),
          dependencies: Array.isArray(adapter.dependencies) ? adapter.dependencies.map(String) : [],
        })),
      points: points.map((point) => ({
        id: point.id,
        description: point.description,
        owner: point.owner,
        plugin: point.plugin,
        groupId: point.groupId,
        directAdapterIds: point.directAdapterIds,
        adapterChainIds: point.adapterChainIds,
      })),
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
    const orderedReports = Array.from(queue.values()).sort((left, right) => left.sequence - right.sequence);
    const batchPluginId = orderedReports[0]?.pluginId || "";
    const reports = [];
    // 服务端按全局 sequence 接收回执；这里只取同来源的连续前缀，不能跨过其它来源后再发送更大的序号。
    for (const report of orderedReports) {
      if ((report.pluginId || "") !== batchPluginId || reports.length >= MAX_REPORTS_PER_FLUSH) break;
      reports.push(report);
    }
    const pluginIds = new Set(reports.map((report) => report.pluginId).filter(Boolean));
    const catalogs = [...pluginIds].map((pluginId) => catalogQueue.get(pluginId)).filter(Boolean);
    for (const report of reports) queue.delete(report.point.id);
    try {
      const response = await fetch(ENDPOINT, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId, generation, catalogs: catalogs.map((entry) => entry.catalog), reports }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      for (const report of reports) {
        if (report.generation === generation) sentSignatures.set(report.point.id, report.signature);
      }
      for (const entry of catalogs) {
        if (entry.generation !== generation) continue;
        sentCatalogSignatures.set(entry.catalog.plugin.id, entry.signature);
        if (catalogQueue.get(entry.catalog.plugin.id) === entry) catalogQueue.delete(entry.catalog.plugin.id);
      }
      retryDelayMs = 1000;
    } catch {
      failed = true;
      for (const report of reports) restoreFailedReport(report);
      // Gateway 重启后会丢失动态目录；任意失败都带上最新插件目录重试，以便自动恢复注册。
      for (const pluginId of pluginIds) {
        const entry = latestCatalogs.get(pluginId);
        if (entry) catalogQueue.set(pluginId, entry);
      }
    } finally {
      flushing = false;
      if (queue.size > 0 && document.visibilityState === "visible") {
        if (failed) {
          scheduleFlush(retryDelayMs);
          retryDelayMs = Math.min(60_000, retryDelayMs * 2);
        } else {
          // 首批保留去抖；开始排空后立即发送下一段连续序列，避免短生命周期页面留下大量待检测点。
          scheduleFlush(0);
        }
      }
    }
  }

  function ingestSnapshot(snapshot, options = {}) {
    const pluginCatalog = options?.plugin ? normalizedPluginCatalog(snapshot, options.plugin) : null;
    if (options?.plugin && !pluginCatalog) return;
    if (pluginCatalog) {
      const catalogSignature = signature(pluginCatalog);
      if (sentCatalogSignatures.get(pluginCatalog.plugin.id) !== catalogSignature) {
        const entry = {
          generation,
          catalog: pluginCatalog,
          signature: catalogSignature,
        };
        latestCatalogs.set(pluginCatalog.plugin.id, entry);
        catalogQueue.set(pluginCatalog.plugin.id, entry);
      }
    }
    for (const value of Array.isArray(snapshot?.points) ? snapshot.points : []) {
      let point = normalizedPoint(value);
      const pluginId = pluginCatalog?.plugin.id || "";
      if (pluginId ? point.plugin?.id !== pluginId : !point.id.startsWith("web.runtime.")) continue;
      if (point.contributions.length === 0) continue;
      if (pluginId && options.disabled === true) point = disabledPoint(point, options.reason);
      const pointSignature = signature(point);
      if (sentSignatures.get(point.id) === pointSignature && !queue.has(point.id)) continue;
      queue.set(point.id, {
        generation,
        point,
        sequence: ++sequence,
        signature: pointSignature,
        pluginId,
      });
    }
    scheduleFlush();
  }

  function beginGeneration() {
    bindCurrentDocument();
    generation += 1;
    sequence = 0;
    queue.clear();
    catalogQueue.clear();
    latestCatalogs.clear();
    sentSignatures.clear();
    sentCatalogSignatures.clear();
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
