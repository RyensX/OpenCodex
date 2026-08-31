const COMPATIBILITY_REPORT_SCHEMA_VERSION = 2;

const POINT_ID_RE = /^(web\.runtime|gateway\.runtime|static\.cache)\.[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const GROUP_ID_RE = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const ADAPTER_ID_RE = /^adapter\.[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const FINGERPRINT_RE = /^[a-zA-Z0-9._:-]{1,160}$/;
const HIT_EVENT_INTERVAL_MS = 5000;

class CompatibilityStateError extends Error {
  constructor(message, code = "COMPATIBILITY_INVALID_STATE") {
    super(message);
    this.name = "CompatibilityStateError";
    this.code = code;
  }
}

function normalizedRuntimeIdentity(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    version: safeIdentityPart(source.version),
    build: safeIdentityPart(source.build),
    bundleHash: safeIdentityPart(source.bundleHash),
  };
}

function safeIdentityPart(value) {
  const text = String(value || "unknown").trim();
  if (!text || text.includes("/") || text.includes("\\")) return "unknown";
  return text.slice(0, 160);
}

function runtimeIdentityKey(identity) {
  return `${identity.version}\0${identity.build}\0${identity.bundleHash}`;
}

function sanitizeCompatibilityText(value, fallback = "") {
  let text = value instanceof Error ? value.message : String(value || fallback);
  // 兼容报告可能展示给远程浏览器，不能把用户目录、临时目录或访问令牌写入快照。
  text = text
    .replace(/\b[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s]+/g, "[path]")
    .replace(/\/(?:Users|home|private|Volumes|var|tmp)\/(?:[^/\s]+\/?)+/g, "[path]")
    .replace(/([?&](?:token|auth|authorization|code|access_token|refresh_token)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/\b(Bearer)\s+[a-zA-Z0-9._~+/-]+=*/gi, "$1 [redacted]")
    .replace(
      /\b(token|auth|authorization|access_token|refresh_token)\s*[:=]\s*(?:Bearer\s+)?(?:\[redacted\]|[^\s,;]+)/gi,
      "$1=[redacted]"
    );
  return text.trim().slice(0, 320);
}

function normalizedFingerprint(value, fieldName) {
  const text = String(value || "").trim();
  if (!FINGERPRINT_RE.test(text)) {
    throw new TypeError(`${fieldName} must be a non-sensitive fingerprint`);
  }
  return text;
}

function normalizedPositiveInteger(value, fieldName) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new TypeError(`${fieldName} must be a positive integer`);
  }
  return number;
}

function normalizedNonNegativeInteger(value, fieldName) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new TypeError(`${fieldName} must be a non-negative integer`);
  }
  return number;
}

function normalizedPointDefinition(definition) {
  if (!definition || typeof definition !== "object") throw new TypeError("Point definition is required");
  const id = String(definition.id || "").trim();
  if (!POINT_ID_RE.test(id)) throw new TypeError(`Invalid compatibility point id: ${id || "<empty>"}`);
  const groupId = String(definition.groupId || "").trim();
  if (!GROUP_ID_RE.test(groupId)) throw new TypeError(`Invalid compatibility group id: ${groupId || "<empty>"}`);
  const directAdapterIds = Array.from(new Set(Array.isArray(definition.directAdapterIds) ? definition.directAdapterIds.map(String) : []));
  const adapterChainIds = Array.from(new Set(Array.isArray(definition.adapterChainIds) ? definition.adapterChainIds.map(String) : []));
  if (directAdapterIds.length === 0 || adapterChainIds.length === 0) {
    throw new TypeError(`Compatibility point ${id} must declare adapter references`);
  }
  if (directAdapterIds.some((adapterId) => !ADAPTER_ID_RE.test(adapterId))) {
    throw new TypeError(`Compatibility point ${id} has an invalid direct adapter id`);
  }
  if (adapterChainIds.some((adapterId) => !ADAPTER_ID_RE.test(adapterId))) {
    throw new TypeError(`Compatibility point ${id} has an invalid adapter chain id`);
  }
  if (directAdapterIds.some((adapterId) => !adapterChainIds.includes(adapterId))) {
    throw new TypeError(`Compatibility point ${id} direct adapters must be present in its complete chain`);
  }
  return Object.freeze({
    id,
    description: sanitizeCompatibilityText(definition.description),
    owner: sanitizeCompatibilityText(definition.owner || "opencodex"),
    groupId,
    directAdapterIds: Object.freeze(directAdapterIds),
    adapterChainIds: Object.freeze(adapterChainIds),
  });
}

function normalizedGroupDefinition(definition) {
  if (!definition || typeof definition !== "object") throw new TypeError("Group definition is required");
  const id = String(definition.id || "").trim();
  if (!GROUP_ID_RE.test(id)) throw new TypeError(`Invalid compatibility group id: ${id || "<empty>"}`);
  const order = Number(definition.order);
  if (!Number.isFinite(order)) throw new TypeError(`Compatibility group ${id} must declare a finite order`);
  return Object.freeze({
    id,
    name: sanitizeCompatibilityText(definition.name),
    description: sanitizeCompatibilityText(definition.description),
    order,
  });
}

function normalizedAdapterDefinition(definition) {
  if (!definition || typeof definition !== "object") throw new TypeError("Adapter definition is required");
  const id = String(definition.id || "").trim();
  if (!ADAPTER_ID_RE.test(id)) throw new TypeError(`Invalid compatibility adapter id: ${id || "<empty>"}`);
  const kind = definition.kind === "composite" ? "composite" : definition.kind === "terminal" ? "terminal" : "";
  if (!kind) throw new TypeError(`Compatibility adapter ${id} has an invalid kind`);
  return Object.freeze({
    id,
    name: sanitizeCompatibilityText(definition.name),
    description: sanitizeCompatibilityText(definition.description),
    kind,
    dependencies: Object.freeze(Array.from(new Set(Array.isArray(definition.dependencies) ? definition.dependencies.map(String) : []))),
  });
}

function freshPointState(definition, generation, at) {
  return {
    id: definition.id,
    description: definition.description,
    owner: definition.owner,
    groupId: definition.groupId,
    directAdapterIds: definition.directAdapterIds,
    adapterChainIds: definition.adapterChainIds,
    generation,
    location: {
      status: "unresolved",
      locatorRevision: "",
      adapterId: "",
      expectedCandidates: 0,
      candidateCount: 0,
      targetHash: "",
      contextHash: "",
      reason: "",
      startedAt: null,
      resolvedAt: null,
    },
    application: {
      status: "pending",
      attemptCount: 0,
      appliedAt: null,
      lastError: "",
    },
    verification: {
      status: "pending",
      verifiedAt: null,
      lastError: "",
    },
    exercise: {
      status: "not-exercised",
      hitCount: 0,
      lastHitAt: null,
    },
    fallback: {
      active: false,
      reason: "",
      activatedAt: null,
    },
    updatedAt: at,
  };
}

function pointSummaryStatus(state) {
  if (state.application.status === "disabled") return "disabled";
  if (state.fallback.active) return "degraded";
  if (
    ["unsupported", "ambiguous", "failed", "stale"].includes(state.location.status) ||
    state.application.status === "failed" ||
    state.verification.status === "failed"
  ) {
    return "unavailable";
  }
  if (
    ["unresolved", "resolving"].includes(state.location.status) ||
    ["pending", "applying"].includes(state.application.status) ||
    state.verification.status === "pending"
  ) {
    return "pending";
  }
  return state.exercise.status === "active" ? "healthy" : "ready";
}

function groupDisplayStatus(pointSnapshots) {
  const statuses = pointSnapshots.map((point) => point.status);
  if (statuses.length === 0) return "pending";
  if (statuses.every((status) => status === "disabled")) return "disabled";
  if (statuses.includes("unavailable")) return "unavailable";
  if (statuses.includes("degraded") || statuses.includes("disabled")) return "degraded";
  if (statuses.includes("pending")) return "pending";
  if (statuses.includes("ready")) return "ready";
  return "healthy";
}

function isThenable(value) {
  return !!value && (typeof value === "object" || typeof value === "function") && typeof value.then === "function";
}

function verificationOutcome(value) {
  if (value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, "ok")) {
    return { ok: value.ok === true, reason: sanitizeCompatibilityText(value.reason) };
  }
  return { ok: value === true, reason: "" };
}

function createCompatibilityRegistry({ getRuntimeIdentity = () => ({}), now = () => Date.now() } = {}) {
  const points = new Map();
  const groups = new Map();
  const adapterTypes = new Map();
  const listeners = new Set();
  let runtimeIdentity = normalizedRuntimeIdentity(getRuntimeIdentity());
  let runtimeKey = runtimeIdentityKey(runtimeIdentity);
  let runtimeGeneration = 1;

  function timestamp() {
    return new Date(now()).toISOString();
  }

  function emit(type, id = "") {
    const event = Object.freeze({ type, id, at: timestamp(), runtimeGeneration });
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // 诊断持久化失败不能反向破坏官方运行时或补丁执行流程。
      }
    }
  }

  function resetRuntimeState(nextIdentity, nextKey) {
    runtimeIdentity = nextIdentity;
    runtimeKey = nextKey;
    runtimeGeneration += 1;
    const at = timestamp();
    for (const point of points.values()) {
      point.state = freshPointState(point.definition, point.state.generation + 1, at);
      point.currentAttempt = null;
      point.currentHandle = null;
      point.lastHitEventAtMs = 0;
      point.lastHitAtMs = 0;
    }
    emit("runtime-reset");
  }

  function synchronizeRuntime() {
    const nextIdentity = normalizedRuntimeIdentity(getRuntimeIdentity());
    const nextKey = runtimeIdentityKey(nextIdentity);
    if (nextKey !== runtimeKey) resetRuntimeState(nextIdentity, nextKey);
    return runtimeIdentity;
  }

  function requiredPoint(id) {
    synchronizeRuntime();
    const point = points.get(String(id));
    if (!point) throw new CompatibilityStateError(`Unknown compatibility point: ${id}`, "COMPATIBILITY_POINT_UNKNOWN");
    return point;
  }

  function touch(point, eventType = "point-changed") {
    point.state.updatedAt = timestamp();
    emit(eventType, point.definition.id);
  }

  function resetDownstreamState(point) {
    point.state.application = {
      status: "pending",
      attemptCount: 0,
      appliedAt: null,
      lastError: "",
    };
    point.state.verification = {
      status: "pending",
      verifiedAt: null,
      lastError: "",
    };
    point.state.exercise = {
      status: "not-exercised",
      hitCount: 0,
      lastHitAt: null,
    };
    point.state.fallback = {
      active: false,
      reason: "",
      activatedAt: null,
    };
  }

  function setLocationFailure(point, attemptToken, status, details = {}) {
    if (point.currentAttempt !== attemptToken) {
      throw new CompatibilityStateError("Resolution attempt is no longer current", "COMPATIBILITY_RESOLUTION_STALE");
    }
    point.currentAttempt = null;
    point.currentHandle = null;
    point.state.location.status = status;
    point.state.location.candidateCount = normalizedNonNegativeInteger(details.candidateCount || 0, "candidateCount");
    point.state.location.reason = sanitizeCompatibilityText(details.reason, status);
    point.state.location.resolvedAt = timestamp();
    touch(point);
    return null;
  }

  function markHandleStale(point, handleToken, reason) {
    if (point.currentHandle === handleToken) point.currentHandle = null;
    point.state.location.status = "stale";
    point.state.location.reason = sanitizeCompatibilityText(reason, "Target changed after resolution");
    touch(point);
  }

  function createHandle(point, handleToken, target) {
    const resolvedFingerprint = target.targetFingerprint;
    const getCurrentFingerprint = target.getCurrentFingerprint;
    const applyExecutor = target.apply;
    const verifyExecutor = target.verify;

    function assertCurrent() {
      synchronizeRuntime();
      if (point.currentHandle !== handleToken || point.state.location.status !== "resolved") {
        throw new CompatibilityStateError("Patch handle is no longer current", "COMPATIBILITY_HANDLE_STALE");
      }
    }

    function assertTargetCurrent() {
      assertCurrent();
      let currentFingerprint;
      try {
        currentFingerprint = normalizedFingerprint(getCurrentFingerprint(), "current target fingerprint");
      } catch (error) {
        markHandleStale(point, handleToken, error);
        throw new CompatibilityStateError("Patch target fingerprint is unavailable", "COMPATIBILITY_TARGET_STALE");
      }
      if (currentFingerprint !== resolvedFingerprint) {
        markHandleStale(point, handleToken, "Target changed after resolution");
        throw new CompatibilityStateError("Patch target changed after resolution", "COMPATIBILITY_TARGET_STALE");
      }
    }

    function markApplicationFailed(error) {
      if (point.currentHandle !== handleToken) return;
      point.state.application.status = "failed";
      point.state.application.lastError = sanitizeCompatibilityText(error, "Patch application failed");
      touch(point);
    }

    function finishApplication(value) {
      assertCurrent();
      point.state.application.status = "applied";
      point.state.application.appliedAt = timestamp();
      point.state.application.lastError = "";
      touch(point);
      return value;
    }

    function apply() {
      assertTargetCurrent();
      if (point.state.application.status !== "pending") {
        throw new CompatibilityStateError("Patch handle can only be applied once");
      }
      point.state.application.status = "applying";
      point.state.application.attemptCount += 1;
      touch(point);
      try {
        const result = applyExecutor();
        if (isThenable(result)) {
          return Promise.resolve(result).then(finishApplication, (error) => {
            markApplicationFailed(error);
            throw error;
          });
        }
        return finishApplication(result);
      } catch (error) {
        markApplicationFailed(error);
        throw error;
      }
    }

    function finishVerification(value) {
      assertCurrent();
      const outcome = verificationOutcome(value);
      if (!outcome.ok) {
        point.state.verification.status = "failed";
        point.state.verification.lastError = outcome.reason || "Post-application verification failed";
        touch(point);
        return false;
      }
      point.state.verification.status = "verified";
      point.state.verification.verifiedAt = timestamp();
      point.state.verification.lastError = "";
      touch(point);
      return true;
    }

    function verify() {
      assertTargetCurrent();
      if (point.state.application.status !== "applied") {
        throw new CompatibilityStateError("Patch must be applied before verification");
      }
      if (!verifyExecutor) {
        point.state.verification.status = "not-required";
        point.state.verification.verifiedAt = timestamp();
        touch(point);
        return true;
      }
      try {
        const result = verifyExecutor();
        if (isThenable(result)) {
          return Promise.resolve(result).then(finishVerification, (error) => {
            if (point.currentHandle === handleToken) {
              point.state.verification.status = "failed";
              point.state.verification.lastError = sanitizeCompatibilityText(error, "Verification failed");
              touch(point);
            }
            throw error;
          });
        }
        return finishVerification(result);
      } catch (error) {
        if (point.currentHandle === handleToken) {
          point.state.verification.status = "failed";
          point.state.verification.lastError = sanitizeCompatibilityText(error, "Verification failed");
          touch(point);
        }
        throw error;
      }
    }

    return Object.freeze({
      id: point.definition.id,
      apply,
      verify,
      recordHit(count = 1) {
        assertCurrent();
        const increment = normalizedPositiveInteger(count, "hit count");
        const firstHit = point.state.exercise.status !== "active";
        point.state.exercise.status = "active";
        point.state.exercise.hitCount = Math.min(
          Number.MAX_SAFE_INTEGER,
          point.state.exercise.hitCount + increment
        );
        const currentTime = now();
        point.lastHitAtMs = currentTime;
        if (firstHit || currentTime - point.lastHitEventAtMs >= HIT_EVENT_INTERVAL_MS) {
          point.lastHitEventAtMs = currentTime;
          point.state.exercise.lastHitAt = new Date(currentTime).toISOString();
          touch(point);
        }
        return point.state.exercise.hitCount;
      },
      useFallback(reason) {
        assertCurrent();
        point.state.fallback.active = true;
        point.state.fallback.reason = sanitizeCompatibilityText(reason, "Official behavior");
        point.state.fallback.activatedAt = timestamp();
        touch(point);
      },
      clearFallback() {
        assertCurrent();
        point.state.fallback.active = false;
        point.state.fallback.reason = "";
        point.state.fallback.activatedAt = null;
        touch(point);
      },
      snapshot() {
        return pointSnapshot(point);
      },
    });
  }

  function pointSnapshot(point) {
    const state = point.state;
    return {
      id: state.id,
      description: state.description,
      owner: state.owner,
      groupId: state.groupId,
      directAdapterIds: [...state.directAdapterIds],
      adapterChainIds: [...state.adapterChainIds],
      generation: state.generation,
      status: pointSummaryStatus(state),
      location: { ...state.location },
      application: { ...state.application },
      verification: { ...state.verification },
      exercise: {
        ...state.exercise,
        // 高频命中只记录数值时间，生成快照时再格式化，避免每次 IPC 都分配 ISO 字符串。
        lastHitAt: point.lastHitAtMs ? new Date(point.lastHitAtMs).toISOString() : state.exercise.lastHitAt,
      },
      fallback: { ...state.fallback },
      updatedAt: state.updatedAt,
    };
  }

  function registerPoint(definition) {
    synchronizeRuntime();
    const normalized = normalizedPointDefinition(definition);
    if (points.has(normalized.id)) throw new CompatibilityStateError(`Duplicate compatibility point: ${normalized.id}`);
    if (!groups.has(normalized.groupId)) {
      throw new CompatibilityStateError(`Point ${normalized.id} references unknown group ${normalized.groupId}`);
    }
    for (const adapterId of normalized.adapterChainIds) {
      if (!adapterTypes.has(adapterId)) {
        throw new CompatibilityStateError(`Point ${normalized.id} references unknown adapter ${adapterId}`);
      }
    }
    points.set(normalized.id, {
      definition: normalized,
      state: freshPointState(normalized, 0, timestamp()),
      currentAttempt: null,
      currentHandle: null,
      lastHitEventAtMs: 0,
      lastHitAtMs: 0,
    });
    return normalized;
  }

  function registerGroup(definition) {
    synchronizeRuntime();
    const normalized = normalizedGroupDefinition(definition);
    if (groups.has(normalized.id)) throw new CompatibilityStateError(`Duplicate compatibility group: ${normalized.id}`);
    groups.set(normalized.id, normalized);
    return normalized;
  }

  function registerAdapterType(definition) {
    synchronizeRuntime();
    const normalized = normalizedAdapterDefinition(definition);
    if (adapterTypes.has(normalized.id)) throw new CompatibilityStateError(`Duplicate compatibility adapter: ${normalized.id}`);
    for (const dependency of normalized.dependencies) {
      if (!adapterTypes.has(dependency)) {
        throw new CompatibilityStateError(`Adapter ${normalized.id} references unknown dependency ${dependency}`);
      }
    }
    adapterTypes.set(normalized.id, normalized);
    return normalized;
  }

  function beginResolution(id, options = {}) {
    const point = requiredPoint(id);
    const locatorRevision = normalizedFingerprint(options.locatorRevision, "locatorRevision");
    const adapterId = normalizedFingerprint(options.adapterId, "adapterId");
    if (!point.definition.adapterChainIds.includes(adapterId)) {
      throw new TypeError(`Adapter ${adapterId} is not declared by point ${point.definition.id}`);
    }
    const expectedCandidates = normalizedPositiveInteger(options.expectedCandidates || 1, "expectedCandidates");
    const attemptToken = Symbol(`resolution:${point.definition.id}`);
    point.currentAttempt = attemptToken;
    point.currentHandle = null;
    point.lastHitEventAtMs = 0;
    point.lastHitAtMs = 0;
    point.state.generation += 1;
    resetDownstreamState(point);
    point.state.location = {
      status: "resolving",
      locatorRevision,
      adapterId,
      expectedCandidates,
      candidateCount: 0,
      contextHash: "",
      targetHash: "",
      reason: "",
      startedAt: timestamp(),
      resolvedAt: null,
    };
    touch(point);

    function resolve(details = {}) {
      if (point.currentAttempt !== attemptToken) {
        throw new CompatibilityStateError("Resolution attempt is no longer current", "COMPATIBILITY_RESOLUTION_STALE");
      }
      const candidateCount = normalizedNonNegativeInteger(details.candidateCount, "candidateCount");
      if (candidateCount < expectedCandidates) {
        return setLocationFailure(point, attemptToken, "unsupported", {
          candidateCount,
          reason: details.reason || `Expected ${expectedCandidates} candidates but found ${candidateCount}`,
        });
      }
      if (candidateCount > expectedCandidates) {
        return setLocationFailure(point, attemptToken, "ambiguous", {
          candidateCount,
          reason: details.reason || `Expected ${expectedCandidates} candidates but found ${candidateCount}`,
        });
      }
      if (details.constraintsPassed !== true) {
        return setLocationFailure(point, attemptToken, "failed", {
          candidateCount,
          reason: details.reason || "Strong locator constraints did not pass",
        });
      }
      if (typeof details.getCurrentFingerprint !== "function") {
        throw new TypeError("getCurrentFingerprint is required for a resolved point");
      }
      if (typeof details.apply !== "function") throw new TypeError("apply is required for a resolved point");
      const targetFingerprint = normalizedFingerprint(details.targetFingerprint, "targetFingerprint");
      const contextHash = details.contextHash
        ? normalizedFingerprint(details.contextHash, "contextHash")
        : "";
      const handleToken = Symbol(`handle:${point.definition.id}`);
      point.currentAttempt = null;
      point.currentHandle = handleToken;
      point.state.location.status = "resolved";
      point.state.location.candidateCount = candidateCount;
      point.state.location.targetHash = targetFingerprint;
      point.state.location.contextHash = contextHash;
      point.state.location.reason = "";
      point.state.location.resolvedAt = timestamp();
      touch(point);
      return createHandle(point, handleToken, {
        targetFingerprint,
        getCurrentFingerprint: details.getCurrentFingerprint,
        apply: details.apply,
        verify: typeof details.verify === "function" ? details.verify : null,
      });
    }

    return Object.freeze({
      id: point.definition.id,
      resolve,
      unsupported(details = {}) {
        return setLocationFailure(point, attemptToken, "unsupported", details);
      },
      ambiguous(details = {}) {
        return setLocationFailure(point, attemptToken, "ambiguous", details);
      },
      fail(error, details = {}) {
        return setLocationFailure(point, attemptToken, "failed", {
          ...details,
          reason: details.reason || error,
        });
      },
    });
  }

  function useFallback(id, reason) {
    const point = requiredPoint(id);
    point.state.fallback.active = true;
    point.state.fallback.reason = sanitizeCompatibilityText(reason, "Official behavior");
    point.state.fallback.activatedAt = timestamp();
    touch(point);
  }

  function disablePoint(id, reason) {
    const point = requiredPoint(id);
    point.currentAttempt = null;
    point.currentHandle = null;
    point.state.application.status = "disabled";
    point.state.application.lastError = sanitizeCompatibilityText(reason, "Disabled by configuration");
    touch(point);
  }

  function setPointsEnabled(ids, enabled, reason = "") {
    for (const id of ids || []) {
      const point = requiredPoint(id);
      if (enabled === true) {
        if (point.state.application.status !== "disabled") continue;
        point.state = freshPointState(point.definition, point.state.generation + 1, timestamp());
        point.currentAttempt = null;
        point.currentHandle = null;
        point.lastHitEventAtMs = 0;
        point.lastHitAtMs = 0;
        touch(point);
      } else {
        disablePoint(id, reason);
      }
    }
  }

  function snapshot() {
    synchronizeRuntime();
    const pointItems = Array.from(points.values()).map(pointSnapshot).sort((left, right) => left.id.localeCompare(right.id));
    const groupItems = Array.from(groups.values())
      .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
      .map((group) => {
        const groupPoints = pointItems.filter((point) => point.groupId === group.id);
        return {
          id: group.id,
          name: group.name,
          description: group.description,
          order: group.order,
          status: groupDisplayStatus(groupPoints),
          pointIds: groupPoints.map((point) => point.id),
        };
      });
    const adapterItems = Array.from(adapterTypes.values()).map((adapter) => ({
      id: adapter.id,
      name: adapter.name,
      description: adapter.description,
      kind: adapter.kind,
      dependencies: [...adapter.dependencies],
    }));
    const pointStatuses = pointItems.map((point) => point.status);
    // 分类组只是展示索引；总体状态必须只由修改点计算，避免同一失败被重复聚合。
    const statuses = pointStatuses;
    const status = statuses.length > 0 && statuses.every((pointStatus) => pointStatus === "disabled")
      ? "disabled"
      : statuses.includes("unavailable")
      ? "unavailable"
      : statuses.includes("degraded") || statuses.includes("disabled")
        ? "degraded"
        : statuses.includes("pending")
          ? "pending"
          : statuses.includes("ready")
            ? "ready"
            : "healthy";
    return {
      schemaVersion: COMPATIBILITY_REPORT_SCHEMA_VERSION,
      generatedAt: timestamp(),
      runtimeGeneration,
      runtime: { ...runtimeIdentity },
      status,
      groups: groupItems,
      adapterTypes: adapterItems,
      points: pointItems,
    };
  }

  return Object.freeze({
    registerGroup,
    registerGroups(definitions) {
      return Array.from(definitions || [], registerGroup);
    },
    registerAdapterType,
    registerAdapterTypes(definitions) {
      return Array.from(definitions || [], registerAdapterType);
    },
    registerPoint,
    registerPoints(definitions) {
      return Array.from(definitions || [], registerPoint);
    },
    beginResolution,
    disablePoint,
    useFallback,
    setPointsEnabled,
    point(id) {
      return pointSnapshot(requiredPoint(id));
    },
    snapshot,
    onChanged(listener) {
      if (typeof listener !== "function") throw new TypeError("Compatibility listener must be a function");
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
}

module.exports = {
  COMPATIBILITY_REPORT_SCHEMA_VERSION,
  HIT_EVENT_INTERVAL_MS,
  CompatibilityStateError,
  createCompatibilityRegistry,
  normalizedRuntimeIdentity,
  sanitizeCompatibilityText,
};
