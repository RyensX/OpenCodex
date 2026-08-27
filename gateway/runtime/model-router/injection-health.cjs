const GLOBAL_INJECTION_POINTS = Object.freeze([
  "app-server-router",
  "auto-model-catalog",
  "route-presentation",
]);
const BROWSER_INJECTION_POINTS = Object.freeze([
  "settings-page",
  "composer-adapter",
  "summary-adapter",
]);
const INJECTION_POINTS = Object.freeze([
  ...GLOBAL_INJECTION_POINTS.map((id) => Object.freeze({ id, scope: "gateway" })),
  ...BROWSER_INJECTION_POINTS.map((id) => Object.freeze({ id, scope: "browser" })),
]);
const GLOBAL_POINT_SET = new Set(GLOBAL_INJECTION_POINTS);
const BROWSER_POINT_SET = new Set(BROWSER_INJECTION_POINTS);
const MAX_BROWSER_REPORTERS = 64;
const COMPATIBILITY_POINT_BY_INJECTION = Object.freeze({
  "app-server-router": "gateway.runtime.app-server.transport",
  "auto-model-catalog": "gateway.runtime.app-server.virtual-model",
  "route-presentation": "gateway.runtime.app-server.route-metadata",
  "settings-page": "web.runtime.smart-router.settings",
  "composer-adapter": "web.runtime.smart-router.composer",
  "summary-adapter": "web.runtime.smart-router.summary",
});

function normalizedRuntimeIdentity(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    version: String(source.version || "unknown"),
    build: String(source.build || "unknown"),
  };
}

function runtimeIdentityKey(identity) {
  return `${identity.version}\0${identity.build}`;
}

function normalizedClientId(value) {
  const clientId = String(value || "").trim();
  return /^[a-zA-Z0-9_-]{8,96}$/.test(clientId) ? clientId : "";
}

function createInjectionHealthRegistry({ getRuntimeIdentity = () => ({}), compatibilityService = null } = {}) {
  const gatewayReports = new Map();
  const browserReports = new Map();
  let runtimeIdentity = normalizedRuntimeIdentity(getRuntimeIdentity());
  let runtimeKey = runtimeIdentityKey(runtimeIdentity);

  function synchronizeRuntime() {
    const nextIdentity = normalizedRuntimeIdentity(getRuntimeIdentity());
    const nextKey = runtimeIdentityKey(nextIdentity);
    if (nextKey !== runtimeKey) {
      // Codex 版本变化后旧回执不能继续代表兼容；当前进程内按版本重新开始收集。
      gatewayReports.clear();
      browserReports.clear();
      runtimeIdentity = nextIdentity;
      runtimeKey = nextKey;
    }
    return runtimeIdentity;
  }

  function reportGateway(point) {
    synchronizeRuntime();
    if (!GLOBAL_POINT_SET.has(point)) return false;
    gatewayReports.set(point, Date.now());
    const compatibilityPoint = COMPATIBILITY_POINT_BY_INJECTION[point];
    if (compatibilityPoint) {
      try {
        compatibilityService?.installPoint(compatibilityPoint, {
          locatorRevision: "smart-router-injection-v1",
          strategyId: "legacy-health-adapter",
        });
        compatibilityService?.recordHit(compatibilityPoint);
      } catch {}
    }
    return true;
  }

  function reportBrowser(point, clientId) {
    synchronizeRuntime();
    const normalizedId = normalizedClientId(clientId);
    if (!BROWSER_POINT_SET.has(point) || !normalizedId) return false;
    let reports = browserReports.get(normalizedId);
    if (!reports) {
      // 浏览器刷新会产生新的页面 ID；限制数量可避免长期运行时被陈旧页面无限占用。
      if (browserReports.size >= MAX_BROWSER_REPORTERS) browserReports.delete(browserReports.keys().next().value);
      reports = new Map();
      browserReports.set(normalizedId, reports);
    }
    reports.set(point, Date.now());
    const compatibilityPoint = COMPATIBILITY_POINT_BY_INJECTION[point];
    if (compatibilityPoint) {
      try {
        compatibilityService?.browserReport({
          clientId: normalizedId,
          id: compatibilityPoint,
          phase: "active",
        });
      } catch {}
    }
    return true;
  }

  function resetGatewayPoint(point) {
    synchronizeRuntime();
    return gatewayReports.delete(point);
  }

  function snapshot({ clientId, enabled = false } = {}) {
    const identity = synchronizeRuntime();
    const browser = browserReports.get(normalizedClientId(clientId)) || new Map();
    const items = INJECTION_POINTS.map(({ id, scope }) => {
      const reportedAt = scope === "gateway" ? gatewayReports.get(id) : browser.get(id);
      return {
        id,
        scope,
        status: enabled ? (reportedAt ? "ok" : "missing") : "disabled",
        reportedAt: reportedAt || 0,
      };
    });
    return {
      enabled: enabled === true,
      status: enabled ? (items.every((item) => item.status === "ok") ? "ok" : "error") : "disabled",
      runtime: { ...identity },
      items,
    };
  }

  return {
    reportBrowser,
    reportGateway,
    resetGatewayPoint,
    snapshot,
  };
}

module.exports = {
  BROWSER_INJECTION_POINTS,
  COMPATIBILITY_POINT_BY_INJECTION,
  GLOBAL_INJECTION_POINTS,
  INJECTION_POINTS,
  createInjectionHealthRegistry,
  normalizedClientId,
  normalizedRuntimeIdentity,
};
