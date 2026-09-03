const crypto = require("crypto");
const path = require("path");
const { registerCompatibilityCatalog } = require("./catalog.cjs");
const {
  createCompatibilityRegistry,
  normalizedRuntimeIdentity,
} = require("./registry.cjs");
const { createCompatibilityReportStore } = require("./report-store.cjs");
const { createProductionModificationCoordinator } = require("../../dist/modification/production.js");
const modificationPoints = require("../modification/point-refs.cjs");

const BROWSER_CLIENT_ID_RE = /^[a-zA-Z0-9_-]{8,96}$/;
const BROWSER_REPORTER_STALE_MS = 30_000;
const MAX_BROWSER_PLUGIN_POINTS = 512;

function createCompatibilityService({
  runtimeDir,
  reportsDir,
  getRuntimeIdentity = () => ({}),
  reportStore,
  persistDelayMs = 25,
  now = () => Date.now(),
} = {}) {
  let explicitRuntimeIdentity = null;
  const registry = registerCompatibilityCatalog(
    createCompatibilityRegistry({
      getRuntimeIdentity() {
        return explicitRuntimeIdentity || getRuntimeIdentity();
      },
    })
  );
  const browserKernelReporters = new Map();
  const browserPluginPointIds = new Set();
  const browserReportInstanceId = crypto.randomUUID().replace(/-/g, "");
  let activeBrowserReporter = null;
  let browserReportRevision = 0;
  const store = reportStore || (
    runtimeDir && reportsDir
      ? createCompatibilityReportStore({
          filePath: path.join(runtimeDir, "compatibility-report.json"),
          historyDir: path.join(reportsDir, "compatibility"),
        })
      : null
  );
  let persistTimer = null;
  let disposed = false;
  let cachedSummary = null;
  const modifications = createProductionModificationCoordinator({
    host: "gateway",
    publish(point) {
      try {
        registry.ingestKernelPoint(point.id, point);
      } catch {
        // Kernel 报告属于诊断输出；聚合失败不能改变 Gateway Provider 行为。
      }
    },
  });

  function currentBrowserReportEpoch() {
    return `${browserReportInstanceId}:${browserReportRevision}`;
  }

  function advanceBrowserReportEpoch() {
    browserReportRevision += 1;
    return currentBrowserReportEpoch();
  }

  function persistNow() {
    if (!store) return registry.snapshot();
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = null;
    return store.write(registry.snapshot());
  }

  function schedulePersist() {
    if (!store || disposed || persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      try {
        store.write(registry.snapshot());
      } catch {
        // 报告落盘是诊断能力，失败不能影响官方 Bootstrap 或浏览器请求。
      }
    }, Math.max(0, Number(persistDelayMs) || 0));
    if (persistTimer.unref) persistTimer.unref();
  }

  let replayingRuntimeState = false;
  const stopRegistryListener = registry.onChanged((event) => {
    cachedSummary = null;
    if (event?.type === "runtime-reset") {
      browserKernelReporters.clear();
      activeBrowserReporter = null;
      advanceBrowserReportEpoch();
      if (!replayingRuntimeState) {
        replayingRuntimeState = true;
        try {
          // Runtime 身份切换只清空诊断 Registry；仍存活的 Gateway Provider 必须立即重放当前状态。
          modifications.refreshAll();
        } catch {
          // 状态重放属于旁路诊断，不能让 Runtime 身份同步失败。
        } finally {
          replayingRuntimeState = false;
        }
      }
    }
    schedulePersist();
  });

  function setRuntimeIdentity(identity) {
    const nextIdentity = normalizedRuntimeIdentity(identity);
    explicitRuntimeIdentity = nextIdentity;
    cachedSummary = null;
    // Registry 的 runtime-reset 事件统一负责浏览器代际失效与 Gateway 状态重放。
    registry.snapshot();
    schedulePersist();
    return { ...explicitRuntimeIdentity };
  }

  function validBrowserReporterIdentity(clientId, generation) {
    const normalizedClientId = String(clientId || "").trim();
    const normalizedGeneration = Number(generation);
    if (!BROWSER_CLIENT_ID_RE.test(normalizedClientId)) return false;
    if (!Number.isInteger(normalizedGeneration) || normalizedGeneration < 1) return false;
    return true;
  }

  function canAcceptBrowserPluginCatalog({ clientId, generation, catalog }) {
    if (!validBrowserReporterIdentity(clientId, generation)) return false;
    try {
      const prepared = registry.validatePluginCatalog(catalog);
      const newPointCount = prepared.pointIds.filter((pointId) => !browserPluginPointIds.has(pointId)).length;
      return browserPluginPointIds.size + newPointCount <= MAX_BROWSER_PLUGIN_POINTS;
    } catch {
      return false;
    }
  }

  function registerBrowserPluginCatalog({ clientId, generation, catalog }) {
    if (!canAcceptBrowserPluginCatalog({ clientId, generation, catalog })) return false;
    try {
      const registered = registry.registerPluginCatalog(catalog);
      for (const pointId of registered.pointIds) browserPluginPointIds.add(pointId);
      return true;
    } catch {
      return false;
    }
  }

  function canAcceptBrowserKernelReport({ clientId, generation, report, catalogs = [] }) {
    if (!validBrowserReporterIdentity(clientId, generation)) return false;
    const sequence = Number(report?.sequence);
    const pointId = String(report?.point?.id || "");
    if (!Number.isInteger(sequence) || sequence < 1) return false;
    try {
      let definition;
      try {
        definition = registry.point(pointId);
        if (!pointId.startsWith("web.runtime.") && !browserPluginPointIds.has(pointId)) return false;
      } catch {
        const preparedCatalogs = Array.from(catalogs || [], (catalog) => registry.validatePluginCatalog(catalog));
        definition = preparedCatalogs.flatMap((catalog) => catalog.points).find((point) => point.id === pointId);
        if (!definition) return false;
      }
      return (
        String(report.point.groupId || "") === definition.groupId &&
        JSON.stringify(report.point.plugin || null) === JSON.stringify(definition.plugin || null) &&
        Array.isArray(report.point.contributions) &&
        report.point.contributions.length > 0
      );
    } catch {
      return false;
    }
  }

  function browserKernelReportResult({ clientId, generation, report, reportEpoch }) {
    const requestEpoch = typeof reportEpoch === "string" && reportEpoch.length <= 160 ? reportEpoch : "";
    const result = (accepted) => Object.freeze({
      accepted,
      reportEpoch: currentBrowserReportEpoch(),
      // 客户端确认的服务端代际不同，说明它必须重放本页保存的全部最新快照。
      resync: accepted && requestEpoch !== currentBrowserReportEpoch(),
    });
    if (!canAcceptBrowserKernelReport({ clientId, generation, report })) return result(false);
    const normalizedClientId = String(clientId).trim();
    const normalizedGeneration = Number(generation);
    const sequence = Number(report.sequence);
    let reporter = browserKernelReporters.get(normalizedClientId);
    const isNewClient = !reporter;
    if (!reporter) {
      reporter = { generation: normalizedGeneration, sequence: 0, updatedAt: now() };
      browserKernelReporters.set(normalizedClientId, reporter);
    }
    const activeReporterState = activeBrowserReporter
      ? browserKernelReporters.get(activeBrowserReporter.clientId)
      : null;
    const activeReporterIsFresh = !!activeReporterState && now() - activeReporterState.updatedAt <= BROWSER_REPORTER_STALE_MS;
    if (
      activeBrowserReporter &&
      activeBrowserReporter.clientId !== normalizedClientId &&
      !isNewClient &&
      activeReporterIsFresh
    ) {
      // 已被新页面替代的旧标签页仍可能补发请求；确认但忽略，避免它覆盖当前页面快照并无限重试。
      reporter.updatedAt = now();
      return result(true);
    }
    if (
      !activeBrowserReporter ||
      activeBrowserReporter.clientId !== normalizedClientId ||
      normalizedGeneration > reporter.generation
    ) {
      if (normalizedGeneration < reporter.generation) return result(false);
      reporter.generation = normalizedGeneration;
      reporter.sequence = 0;
      activeBrowserReporter = { clientId: normalizedClientId, generation: normalizedGeneration };
      advanceBrowserReportEpoch();
      registry.resetPointsByPrefix("web.runtime.");
      registry.resetPoints([...browserPluginPointIds].filter((pointId) => !pointId.startsWith("web.runtime.")));
      // 新页面尚未重新上报的外部插件按“已关闭”展示，避免已卸载插件长期停留在待检测状态。
      for (const pointId of browserPluginPointIds) registry.disablePoint(pointId, "Plugin not reported by current page");
    }
    if (normalizedGeneration < reporter.generation) return result(false);
    // 响应在网络中丢失时浏览器会重发同一批；旧 sequence 已经成功落入 Registry，可幂等确认。
    if (sequence <= reporter.sequence) return result(true);
    try {
      registry.ingestKernelPoint(report.point.id, report.point);
    } catch {
      return result(false);
    }
    reporter.sequence = sequence;
    reporter.updatedAt = now();
    if (browserKernelReporters.size > 64) {
      const oldest = [...browserKernelReporters.entries()]
        .sort((left, right) => left[1].updatedAt - right[1].updatedAt)[0]?.[0];
      if (oldest) browserKernelReporters.delete(oldest);
    }
    return result(true);
  }

  function browserKernelReport(input) {
    return browserKernelReportResult(input).accepted;
  }

  schedulePersist();

  return Object.freeze({
    registry,
    modifications,
    modificationPoints,
    reportStore: store,
    setRuntimeIdentity,
    browserKernelReport,
    browserKernelReportResult,
    canAcceptBrowserKernelReport,
    canAcceptBrowserPluginCatalog,
    registerBrowserPluginCatalog,
    snapshot() {
      return registry.snapshot();
    },
    summary() {
      if (cachedSummary) return { ...cachedSummary };
      const current = registry.snapshot();
      cachedSummary = {
        status: current.status,
        generatedAt: current.generatedAt,
        pointCount: current.points.length,
        unavailableCount: current.points.filter((point) => point.status === "unavailable").length,
        degradedCount: current.points.filter((point) => point.status === "degraded").length,
      };
      return { ...cachedSummary };
    },
    persistNow,
    dispose() {
      disposed = true;
      stopRegistryListener();
      if (persistTimer) clearTimeout(persistTimer);
      persistTimer = null;
      if (store) {
        try {
          store.write(registry.snapshot());
        } catch {}
      }
      // 先保留最后一次可运行快照，再释放 Provider；销毁态只属于进程退出过程，不覆盖离线诊断。
      void modifications.dispose().catch(() => undefined);
    },
  });
}

module.exports = {
  BROWSER_CLIENT_ID_RE,
  BROWSER_REPORTER_STALE_MS,
  MAX_BROWSER_PLUGIN_POINTS,
  createCompatibilityService,
};
