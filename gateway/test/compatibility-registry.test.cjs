const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  ADAPTER_DEFINITIONS,
  POINT_DEFINITIONS,
  POINT_GROUP_DEFINITIONS,
  registerCompatibilityCatalog,
} = require("../runtime/compatibility/catalog.cjs");
const {
  CompatibilityStateError,
  createCompatibilityRegistry,
  sanitizeCompatibilityText,
} = require("../runtime/compatibility/registry.cjs");
const { POINT_DEFINITION_BY_ID } = require("../dist/modification/catalog.js");
const { createProductionModificationCoordinator } = require("../dist/modification/production.js");

function createClock() {
  let value = Date.parse("2026-08-28T00:00:00.000Z");
  return {
    now: () => value,
    tick(ms = 1) {
      value += ms;
    },
  };
}

const preparedRegistries = new WeakSet();

function prepareTestCatalog(registry) {
  if (preparedRegistries.has(registry)) return;
  registry.registerGroup({ id: "test-group", name: "测试组", description: "测试修改点分组", order: 1 });
  registry.registerAdapterType({
    id: "adapter.test",
    name: "测试适配器",
    description: "测试修改点使用的适配器",
    kind: "terminal",
    dependencies: [],
  });
  preparedRegistries.add(registry);
}

function registerTestPoint(registry, id = "gateway.runtime.test.point") {
  prepareTestCatalog(registry);
  registry.registerPoint({
    id,
    description: "测试修改点",
    owner: "test",
    groupId: "test-group",
    directAdapterIds: ["adapter.test"],
    adapterChainIds: ["adapter.test"],
  });
  return id;
}

function resolveTestPoint(registry, id, options = {}) {
  let fingerprint = options.fingerprint || "target-v1";
  const handle = registry
    .beginResolution(id, {
      locatorRevision: options.locatorRevision || "locator-v1",
      adapterId: "adapter.test",
      expectedCandidates: options.expectedCandidates || 1,
    })
    .resolve({
      candidateCount: options.candidateCount ?? 1,
      constraintsPassed: options.constraintsPassed ?? true,
      targetFingerprint: options.fingerprint || "target-v1",
      contextHash: "context-hash-v1",
      getCurrentFingerprint: () => fingerprint,
      apply: options.apply || (() => undefined),
      verify: options.verify,
    });
  return {
    handle,
    changeFingerprint(value) {
      fingerprint = value;
    },
  };
}

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(entryPath);
    return /\.(?:cjs|js|ts|html)$/.test(entry.name) ? [entryPath] : [];
  });
}

test("compatibility catalog declares groups and adapter chains for every stable point", () => {
  assert.equal(POINT_DEFINITIONS.length, 102);
  assert.equal(POINT_GROUP_DEFINITIONS.length, 17);
  assert.equal(ADAPTER_DEFINITIONS.length, 23);
  assert.equal(new Set(POINT_DEFINITIONS.map((point) => point.id)).size, POINT_DEFINITIONS.length);
  assert.equal(POINT_DEFINITIONS.every((point) => point.groupId && point.adapterChainIds.length > 0), true);

  const registry = registerCompatibilityCatalog(createCompatibilityRegistry());
  const snapshot = registry.snapshot();
  assert.equal(snapshot.schemaVersion, 2);
  assert.equal(snapshot.points.length, 102);
  assert.equal(snapshot.groups.length, 17);
  assert.equal(snapshot.adapterTypes.length, 23);
  assert.equal(snapshot.status, "pending");
});

test("every catalog point is wired into production code outside the catalog", () => {
  const projectRoot = path.resolve(__dirname, "..", "..");
  const files = [
    ...sourceFiles(path.join(projectRoot, "gateway", "runtime")),
    ...sourceFiles(path.join(projectRoot, "gateway", "runner")),
    ...sourceFiles(path.join(projectRoot, "gateway", "src")),
    ...sourceFiles(path.join(projectRoot, "launcher")),
    ...sourceFiles(path.join(projectRoot, "web-shell")),
  ].filter((file) => {
    if (file.endsWith(path.join("compatibility", "catalog.cjs"))) return false;
    // 强类型目录本身当然包含全部 ID；这里必须只检查真实 Provider/执行路径，避免测试自证。
    return !file.includes(`${path.sep}src${path.sep}modification${path.sep}`);
  });
  const source = files.map((file) => fs.readFileSync(file, "utf8")).join("\n");
  const missing = POINT_DEFINITIONS.filter((point) => !source.includes(point.id)).map((point) => point.id);
  assert.deepEqual(missing, []);
});

test("compatibility handle keeps locate, apply, verify and exercise state independent", () => {
  const clock = createClock();
  const registry = createCompatibilityRegistry({
    getRuntimeIdentity: () => ({ version: "26.8", build: "53001", bundleHash: "bundle-1" }),
    now: clock.now,
  });
  const id = registerTestPoint(registry);
  let applied = 0;
  const { handle } = resolveTestPoint(registry, id, {
    apply() {
      applied += 1;
      return "patched";
    },
    verify: () => ({ ok: true }),
  });

  assert.equal(handle.snapshot().status, "pending");
  clock.tick();
  assert.equal(handle.apply(), "patched");
  assert.equal(applied, 1);
  assert.equal(handle.snapshot().application.status, "applied");
  assert.equal(handle.snapshot().verification.status, "pending");
  clock.tick();
  assert.equal(handle.verify(), true);
  assert.equal(handle.snapshot().status, "ready");
  clock.tick();
  assert.equal(handle.recordHit(2), 2);

  const point = registry.point(id);
  assert.equal(point.status, "healthy");
  assert.equal(point.location.status, "resolved");
  assert.equal(point.application.status, "applied");
  assert.equal(point.verification.status, "verified");
  assert.equal(point.exercise.status, "active");
  assert.equal(point.exercise.hitCount, 2);
  assert.deepEqual(registry.snapshot().runtime, {
    version: "26.8",
    build: "53001",
    bundleHash: "bundle-1",
  });
  assert.throws(() => handle.apply(), CompatibilityStateError);
});

test("strict resolution refuses missing, ambiguous and weak candidates", () => {
  const registry = createCompatibilityRegistry();
  const missingId = registerTestPoint(registry, "static.cache.test.missing");
  const ambiguousId = registerTestPoint(registry, "static.cache.test.ambiguous");
  const weakId = registerTestPoint(registry, "static.cache.test.weak");

  assert.equal(
    registry
      .beginResolution(missingId, { locatorRevision: "v1", adapterId: "adapter.test" })
      .resolve({ candidateCount: 0, constraintsPassed: true }),
    null
  );
  assert.equal(registry.point(missingId).location.status, "unsupported");

  assert.equal(
    registry
      .beginResolution(ambiguousId, { locatorRevision: "v1", adapterId: "adapter.test" })
      .resolve({ candidateCount: 2, constraintsPassed: true }),
    null
  );
  assert.equal(registry.point(ambiguousId).location.status, "ambiguous");

  assert.equal(
    registry
      .beginResolution(weakId, { locatorRevision: "v1", adapterId: "adapter.test" })
      .resolve({ candidateCount: 1, constraintsPassed: false }),
    null
  );
  assert.equal(registry.point(weakId).location.status, "failed");
  assert.equal(registry.point(weakId).application.status, "pending");
});

test("patch handle becomes stale before applying when the located target changes", () => {
  const registry = createCompatibilityRegistry();
  const id = registerTestPoint(registry, "static.cache.test.stale");
  let mutationCount = 0;
  const resolved = resolveTestPoint(registry, id, {
    apply() {
      mutationCount += 1;
    },
  });

  resolved.changeFingerprint("target-v2");
  assert.throws(
    () => resolved.handle.apply(),
    (error) => error instanceof CompatibilityStateError && error.code === "COMPATIBILITY_TARGET_STALE"
  );
  assert.equal(mutationCount, 0);
  assert.equal(registry.point(id).location.status, "stale");
  assert.equal(registry.point(id).status, "unavailable");
});

test("display groups derive status without changing point lifecycle", () => {
  const registry = createCompatibilityRegistry();
  const first = registerTestPoint(registry, "gateway.runtime.group.first");
  const second = registerTestPoint(registry, "web.runtime.group.second");

  for (const id of [first, second]) {
    const { handle } = resolveTestPoint(registry, id);
    handle.apply();
    handle.verify();
  }
  let snapshot = registry.snapshot();
  assert.equal(snapshot.groups.find((group) => group.id === "test-group").status, "ready");
  assert.equal(snapshot.status, "ready");

  registry.useFallback(first, "使用官方实现");
  snapshot = registry.snapshot();
  assert.equal(snapshot.groups.find((group) => group.id === "test-group").status, "degraded");
  assert.equal(snapshot.status, "degraded");

  registry.setPointsEnabled([first, second], false, "插件关闭");
  snapshot = registry.snapshot();
  assert.equal(snapshot.groups.find((group) => group.id === "test-group").status, "disabled");
  assert.equal(snapshot.points.every((point) => point.status === "disabled"), true);
  assert.equal(snapshot.status, "disabled");
});

test("runtime identity changes reset point state and invalidate old handles", () => {
  let identity = { version: "26.8", build: "1", bundleHash: "bundle-a" };
  const registry = createCompatibilityRegistry({ getRuntimeIdentity: () => identity });
  const id = registerTestPoint(registry, "gateway.runtime.test.runtime-reset");
  const { handle } = resolveTestPoint(registry, id);
  handle.apply();
  handle.verify();
  const generation = registry.snapshot().runtimeGeneration;

  identity = { version: "26.9", build: "2", bundleHash: "bundle-b" };
  const reset = registry.snapshot();
  assert.equal(reset.runtimeGeneration, generation + 1);
  assert.equal(registry.point(id).location.status, "unresolved");
  assert.throws(
    () => handle.recordHit(),
    (error) => error instanceof CompatibilityStateError && error.code === "COMPATIBILITY_HANDLE_STALE"
  );
});

test("high-frequency hit tracking emits persistence events at a bounded rate", () => {
  const clock = createClock();
  const registry = createCompatibilityRegistry({ now: clock.now });
  const id = registerTestPoint(registry, "gateway.runtime.test.hit-throttle");
  const { handle } = resolveTestPoint(registry, id);
  handle.apply();
  handle.verify();
  let events = 0;
  registry.onChanged((event) => {
    if (event.id === id) events += 1;
  });

  handle.recordHit();
  handle.recordHit();
  handle.recordHit();
  assert.equal(events, 1);
  assert.equal(registry.point(id).exercise.hitCount, 3);
  clock.tick(5000);
  handle.recordHit();
  assert.equal(events, 2);
  assert.equal(registry.point(id).exercise.hitCount, 4);
});

test("Kernel ingestion updates every hit count but throttles persistence events", () => {
  const clock = createClock();
  const registry = registerCompatibilityCatalog(createCompatibilityRegistry({ now: clock.now }));
  const point = POINT_DEFINITION_BY_ID.get("gateway.runtime.electron.dialog-open");
  const coordinator = createProductionModificationCoordinator({
    host: "gateway",
    publish(snapshot) { registry.ingestKernelPoint(snapshot.id, snapshot); },
  });
  const capability = coordinator.bind(point, () => true);
  let events = 0;
  registry.onChanged((event) => {
    if (event.id === point.id) events += 1;
  });

  capability();
  capability();
  capability();
  assert.equal(registry.point(point.id).exercise.hitCount, 3);
  assert.equal(events, 1);
  clock.tick(5000);
  capability();
  assert.equal(registry.point(point.id).exercise.hitCount, 4);
  assert.equal(events, 2);
});

test("Kernel ingestion keeps Provider fallback degraded instead of unavailable", () => {
  const registry = registerCompatibilityCatalog(createCompatibilityRegistry());
  const point = POINT_DEFINITION_BY_ID.get("gateway.runtime.electron.notification");
  const coordinator = createProductionModificationCoordinator({
    host: "gateway",
    publish(snapshot) { registry.ingestKernelPoint(snapshot.id, snapshot); },
  });
  coordinator.execute(point, () => undefined, { verify: () => true });
  coordinator.locationFailure(point, "unsupported", new Error("official target is absent"));
  coordinator.useFallback(point, "Official runtime behavior");

  const snapshot = registry.point(point.id);
  assert.equal(snapshot.status, "degraded");
  assert.equal(snapshot.location.status, "unsupported");
  assert.equal(snapshot.fallback.active, true);
  assert.equal(snapshot.fallback.reason, "Official runtime behavior");
  assert.equal(typeof snapshot.fallback.activatedAt, "string");
});

test("compatibility snapshot redacts paths and access tokens from failure reasons", () => {
  const registry = createCompatibilityRegistry();
  const id = registerTestPoint(registry, "gateway.runtime.test.redaction");
  registry
    .beginResolution(id, { locatorRevision: "v1", adapterId: "adapter.test" })
    .fail(new Error("failed at /Users/alice/project/private.js?token=secret-value"));

  const reason = registry.point(id).location.reason;
  assert.equal(reason.includes("/Users/alice"), false);
  assert.equal(reason.includes("secret-value"), false);
  assert.match(reason, /\[path\]/);
  assert.equal(
    sanitizeCompatibilityText("https://example.test/a?access_token=secret"),
    "https://example.test/a?access_token=[redacted]"
  );
  assert.equal(
    sanitizeCompatibilityText("authorization: Bearer abc.def.ghi"),
    "authorization=[redacted]"
  );
});
