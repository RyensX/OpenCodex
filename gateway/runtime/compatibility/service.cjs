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
  let activeBrowserReporter = null;
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

  const stopRegistryListener = registry.onChanged(() => {
    cachedSummary = null;
    schedulePersist();
  });

  function currentIdentity() {
    return normalizedRuntimeIdentity(explicitRuntimeIdentity || getRuntimeIdentity());
  }

  function setRuntimeIdentity(identity) {
    const previousIdentity = currentIdentity();
    const nextIdentity = normalizedRuntimeIdentity(identity);
    explicitRuntimeIdentity = nextIdentity;
    const identityChanged =
      previousIdentity.version !== nextIdentity.version ||
      previousIdentity.build !== nextIdentity.build ||
      previousIdentity.bundleHash !== nextIdentity.bundleHash;
    // 相同身份的重复同步必须幂等；身份变化由 Registry generation 统一使旧 Kernel 报告失效。
    if (identityChanged) {
      browserKernelReporters.clear();
      activeBrowserReporter = null;
    }
    cachedSummary = null;
    registry.snapshot();
    schedulePersist();
    return { ...explicitRuntimeIdentity };
  }

  function canAcceptBrowserKernelReport({ clientId, generation, report }) {
    const normalizedClientId = String(clientId || "").trim();
    const normalizedGeneration = Number(generation);
    const sequence = Number(report?.sequence);
    const pointId = String(report?.point?.id || "");
    if (!BROWSER_CLIENT_ID_RE.test(normalizedClientId)) return false;
    if (!Number.isInteger(normalizedGeneration) || normalizedGeneration < 1) return false;
    if (!Number.isInteger(sequence) || sequence < 1) return false;
    if (!pointId.startsWith("web.runtime.")) return false;
    try {
      const definition = registry.point(pointId);
      return (
        String(report.point.groupId || "") === definition.groupId &&
        Array.isArray(report.point.contributions) &&
        report.point.contributions.length > 0
      );
    } catch {
      return false;
    }
  }

  function browserKernelReport({ clientId, generation, report }) {
    if (!canAcceptBrowserKernelReport({ clientId, generation, report })) return false;
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
      return true;
    }
    if (
      !activeBrowserReporter ||
      activeBrowserReporter.clientId !== normalizedClientId ||
      normalizedGeneration > reporter.generation
    ) {
      if (normalizedGeneration < reporter.generation) return false;
      reporter.generation = normalizedGeneration;
      reporter.sequence = 0;
      activeBrowserReporter = { clientId: normalizedClientId, generation: normalizedGeneration };
      registry.resetPointsByPrefix("web.runtime.");
    }
    if (normalizedGeneration < reporter.generation) return false;
    // 响应在网络中丢失时浏览器会重发同一批；旧 sequence 已经成功落入 Registry，可幂等确认。
    if (sequence <= reporter.sequence) return true;
    try {
      registry.ingestKernelPoint(report.point.id, report.point);
    } catch {
      return false;
    }
    reporter.sequence = sequence;
    reporter.updatedAt = now();
    if (browserKernelReporters.size > 64) {
      const oldest = [...browserKernelReporters.entries()]
        .sort((left, right) => left[1].updatedAt - right[1].updatedAt)[0]?.[0];
      if (oldest) browserKernelReporters.delete(oldest);
    }
    return true;
  }

  schedulePersist();

  return Object.freeze({
    registry,
    modifications,
    modificationPoints,
    reportStore: store,
    setRuntimeIdentity,
    browserKernelReport,
    canAcceptBrowserKernelReport,
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
  createCompatibilityService,
};
