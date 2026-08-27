const crypto = require("crypto");
const path = require("path");
const { registerCompatibilityCatalog } = require("./catalog.cjs");
const {
  CompatibilityStateError,
  createCompatibilityRegistry,
  normalizedRuntimeIdentity,
} = require("./registry.cjs");
const { createCompatibilityReportStore } = require("./report-store.cjs");

const BROWSER_CLIENT_ID_RE = /^[a-zA-Z0-9_-]{8,96}$/;
const BROWSER_REPORT_PHASES = new Set(["installed", "active", "failed", "fallback", "disabled"]);

function capabilityFingerprint(id, locatorRevision, runtimeIdentity, targetKey = "") {
  return crypto
    .createHash("sha256")
    .update([id, locatorRevision, runtimeIdentity.version, runtimeIdentity.build, runtimeIdentity.bundleHash, targetKey].join("\0"))
    .digest("hex");
}

function createCompatibilityService({
  runtimeDir,
  reportsDir,
  getRuntimeIdentity = () => ({}),
  reportStore,
  persistDelayMs = 25,
} = {}) {
  let explicitRuntimeIdentity = null;
  const registry = registerCompatibilityCatalog(
    createCompatibilityRegistry({
      getRuntimeIdentity() {
        return explicitRuntimeIdentity || getRuntimeIdentity();
      },
    })
  );
  const handles = new Map();
  const browserReporters = new Map();
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
    // 相同身份的重复同步必须幂等，否则 Registry 状态未重置但能力句柄会被单独清空。
    if (identityChanged) handles.clear();
    cachedSummary = null;
    registry.snapshot();
    schedulePersist();
    return { ...explicitRuntimeIdentity };
  }

  function resolveHandle(id, options, implementation) {
    const locatorRevision = String(options.locatorRevision || "legacy-v1");
    const strategyId = String(options.strategyId || "legacy-adapter");
    const targetFingerprint = String(
      options.targetFingerprint || capabilityFingerprint(id, locatorRevision, currentIdentity(), options.targetKey)
    );
    const getCurrentFingerprint = typeof options.getCurrentFingerprint === "function"
      ? options.getCurrentFingerprint
      : () => targetFingerprint;
    const handle = registry
      .beginResolution(id, {
        locatorRevision,
        strategyId,
        expectedCandidates: options.expectedCandidates || 1,
      })
      .resolve({
        candidateCount: options.candidateCount ?? 1,
        constraintsPassed: options.constraintsPassed !== false,
        targetFingerprint,
        contextHash: options.contextHash,
        getCurrentFingerprint,
        apply: implementation,
        verify: options.verify || (() => true),
      });
    if (!handle) return null;
    handles.set(id, handle);
    return handle;
  }

  function installPoint(id, options = {}) {
    const existing = handles.get(id);
    if (existing && registry.point(id).location.status === "resolved") return existing;
    const handle = resolveHandle(id, options, () => undefined);
    if (!handle) return null;
    handle.apply();
    handle.verify();
    if (options.active) handle.recordHit(options.hitCount || 1);
    return handle;
  }

  function bindCapability(id, implementation, options = {}) {
    if (typeof implementation !== "function") throw new TypeError(`Compatibility capability ${id} must be a function`);
    let handle = resolveHandle(id, options, () => implementation);
    if (!handle) {
      const fallback = typeof options.fallback === "function" ? options.fallback : implementation;
      registry.useFallback(id, options.failureReason || "Locator did not resolve");
      return fallback;
    }
    let capability;
    try {
      capability = handle.apply();
      if (isPromiseLike(capability)) {
        throw new TypeError(`Compatibility capability ${id} must install synchronously`);
      }
      if (!handle.verify()) throw new CompatibilityStateError(`Compatibility capability ${id} failed verification`);
    } catch (error) {
      registry.useFallback(id, error);
      const fallback = typeof options.fallback === "function" ? options.fallback : implementation;
      return fallback;
    }
    return function compatibilityCapability(...args) {
      try {
        const value = capability.apply(this, args);
        try {
          handle.recordHit();
        } catch {
          // 运行时身份刚切换时旧句柄会失效；观测失败不能改变能力函数的原始返回值。
          handles.delete(id);
        }
        return value;
      } catch (error) {
        // 能力函数已经开始执行后不能自动重试 fallback，否则可能重复产生文件或 IPC 副作用。
        throw error;
      }
    };
  }

  function isPromiseLike(value) {
    return !!value && typeof value.then === "function";
  }

  function failPoint(id, error, options = {}) {
    handles.delete(id);
    registry
      .beginResolution(id, {
        locatorRevision: options.locatorRevision || "legacy-v1",
        strategyId: options.strategyId || "legacy-adapter",
        expectedCandidates: options.expectedCandidates || 1,
      })
      .fail(error, { candidateCount: options.candidateCount || 0, reason: options.reason });
    if (options.fallback !== false) registry.useFallback(id, options.fallbackReason || "Official behavior");
  }

  function unsupportedPoint(id, options = {}) {
    handles.delete(id);
    registry
      .beginResolution(id, {
        locatorRevision: options.locatorRevision || "legacy-v1",
        strategyId: options.strategyId || "legacy-adapter",
        expectedCandidates: options.expectedCandidates || 1,
      })
      .unsupported({
        candidateCount: options.candidateCount || 0,
        reason: options.reason || "Current official runtime does not expose this point",
      });
    if (options.fallback !== false) registry.useFallback(id, options.fallbackReason || "Official behavior");
  }

  function ambiguousPoint(id, options = {}) {
    handles.delete(id);
    registry
      .beginResolution(id, {
        locatorRevision: options.locatorRevision || "legacy-v1",
        strategyId: options.strategyId || "legacy-adapter",
        expectedCandidates: options.expectedCandidates || 1,
      })
      .ambiguous({
        candidateCount: options.candidateCount || 0,
        reason: options.reason || "Locator produced multiple candidates",
      });
    if (options.fallback !== false) registry.useFallback(id, options.fallbackReason || "Official behavior");
  }

  function recordHit(id, count = 1) {
    const handle = handles.get(id);
    if (!handle) return false;
    try {
      handle.recordHit(count);
      return true;
    } catch {
      handles.delete(id);
      return false;
    }
  }

  function disablePoint(id, reason) {
    handles.delete(id);
    registry.disablePoint(id, reason);
  }

  function browserReport({ clientId, id, phase, reason }) {
    const normalizedClientId = String(clientId || "").trim();
    const normalizedId = String(id || "").trim();
    const normalizedPhase = String(phase || "").trim();
    if (!canAcceptBrowserReport({ clientId: normalizedClientId, id: normalizedId, phase: normalizedPhase })) return false;
    // 只保存页面 ID 和时间，不接受浏览器上传选择器、源码片段或本机路径。
    browserReporters.set(normalizedClientId, Date.now());
    if (browserReporters.size > 64) browserReporters.delete(browserReporters.keys().next().value);
    if (normalizedPhase === "failed") {
      failPoint(normalizedId, reason || "Browser locator failed", {
        locatorRevision: "browser-v1",
        strategyId: "browser-receipt",
      });
      return true;
    }
    if (normalizedPhase === "disabled") {
      handles.delete(normalizedId);
      registry.disablePoint(normalizedId, reason || "Disabled in browser");
      return true;
    }
    const handle = installPoint(normalizedId, {
      locatorRevision: "browser-v1",
      strategyId: "browser-receipt",
      targetKey: normalizedClientId,
    });
    if (!handle) return false;
    if (
      (normalizedPhase === "installed" || normalizedPhase === "active") &&
      registry.point(normalizedId).fallback.active
    ) {
      handle.clearFallback();
    }
    if (normalizedPhase === "active") handle.recordHit();
    if (normalizedPhase === "fallback") handle.useFallback(reason || "Official browser behavior");
    return true;
  }

  function canAcceptBrowserReport({ clientId, id, phase }) {
    const normalizedClientId = String(clientId || "").trim();
    const normalizedId = String(id || "").trim();
    const normalizedPhase = String(phase || "").trim();
    if (!BROWSER_CLIENT_ID_RE.test(normalizedClientId)) return false;
    if (!normalizedId.startsWith("web.runtime.") || !BROWSER_REPORT_PHASES.has(normalizedPhase)) return false;
    try {
      registry.point(normalizedId);
    } catch {
      return false;
    }
    return true;
  }

  schedulePersist();

  return Object.freeze({
    registry,
    reportStore: store,
    setRuntimeIdentity,
    installPoint,
    bindCapability,
    failPoint,
    unsupportedPoint,
    ambiguousPoint,
    recordHit,
    disablePoint,
    browserReport,
    canAcceptBrowserReport,
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
    },
  });
}

module.exports = {
  BROWSER_CLIENT_ID_RE,
  BROWSER_REPORT_PHASES,
  capabilityFingerprint,
  createCompatibilityService,
};
