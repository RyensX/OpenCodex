const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  FEATURE_DEFINITIONS,
  POINT_DEFINITIONS,
  registerCompatibilityCatalog,
} = require("../runtime/compatibility/catalog.cjs");
const {
  CompatibilityStateError,
  createCompatibilityRegistry,
  sanitizeCompatibilityText,
} = require("../runtime/compatibility/registry.cjs");

function createClock() {
  let value = Date.parse("2026-08-28T00:00:00.000Z");
  return {
    now: () => value,
    tick(ms = 1) {
      value += ms;
    },
  };
}

function registerTestPoint(registry, id = "gateway.runtime.test.point") {
  registry.registerPoint({ id, description: "测试修改点", owner: "test" });
  return id;
}

function resolveTestPoint(registry, id, options = {}) {
  let fingerprint = options.fingerprint || "target-v1";
  const handle = registry
    .beginResolution(id, {
      locatorRevision: options.locatorRevision || "locator-v1",
      strategyId: options.strategyId || "test-strategy",
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

test("compatibility catalog declares three stable point categories without duplicate ids", () => {
  assert.equal(POINT_DEFINITIONS.length, 102);
  assert.equal(FEATURE_DEFINITIONS.length, 6);
  assert.equal(new Set(POINT_DEFINITIONS.map((point) => point.id)).size, POINT_DEFINITIONS.length);
  assert.deepEqual(
    POINT_DEFINITIONS.reduce((counts, point) => {
      const category = point.id.split(".").slice(0, 2).join(".");
      counts[category] = (counts[category] || 0) + 1;
      return counts;
    }, {}),
    {
      "web.runtime": 36,
      "gateway.runtime": 36,
      "static.cache": 30,
    }
  );

  const registry = registerCompatibilityCatalog(createCompatibilityRegistry());
  const snapshot = registry.snapshot();
  assert.equal(snapshot.points.length, 102);
  assert.equal(snapshot.features.length, 6);
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
  ].filter((file) => !file.endsWith(path.join("compatibility", "catalog.cjs")));
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
      .beginResolution(missingId, { locatorRevision: "v1", strategyId: "regex-v1" })
      .resolve({ candidateCount: 0, constraintsPassed: true }),
    null
  );
  assert.equal(registry.point(missingId).location.status, "unsupported");

  assert.equal(
    registry
      .beginResolution(ambiguousId, { locatorRevision: "v1", strategyId: "regex-v1" })
      .resolve({ candidateCount: 2, constraintsPassed: true }),
    null
  );
  assert.equal(registry.point(ambiguousId).location.status, "ambiguous");

  assert.equal(
    registry
      .beginResolution(weakId, { locatorRevision: "v1", strategyId: "regex-v1" })
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

test("feature state is atomic across required points and degrades for optional failures", () => {
  const registry = createCompatibilityRegistry();
  const requiredA = registerTestPoint(registry, "gateway.runtime.feature.required-a");
  const requiredB = registerTestPoint(registry, "web.runtime.feature.required-b");
  const optional = registerTestPoint(registry, "static.cache.feature.optional");
  registry.registerFeature({
    id: "feature.test-atomic",
    description: "测试原子功能",
    fallback: "官方逻辑",
    required: [requiredA, requiredB],
    optional: [optional],
  });

  for (const id of [requiredA, requiredB]) {
    const { handle } = resolveTestPoint(registry, id);
    handle.apply();
    handle.verify();
  }
  assert.equal(registry.feature("feature.test-atomic").status, "ready");
  assert.equal(registry.feature("feature.test-atomic").canActivate, true);

  registry
    .beginResolution(optional, { locatorRevision: "v1", strategyId: "test" })
    .ambiguous({ candidateCount: 2, reason: "multiple candidates" });
  assert.equal(registry.feature("feature.test-atomic").status, "degraded");
  assert.equal(registry.feature("feature.test-atomic").canActivate, true);

  registry.useFallback(requiredA, "使用官方实现");
  assert.equal(registry.feature("feature.test-atomic").status, "degraded");
  registry.disablePoint(requiredB, "配置关闭");
  assert.equal(registry.feature("feature.test-atomic").status, "unavailable");
  registry.setFeatureEnabled("feature.test-atomic", false, "插件关闭");
  assert.equal(registry.feature("feature.test-atomic").status, "disabled");
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

test("compatibility snapshot redacts paths and access tokens from failure reasons", () => {
  const registry = createCompatibilityRegistry();
  const id = registerTestPoint(registry, "gateway.runtime.test.redaction");
  registry
    .beginResolution(id, { locatorRevision: "v1", strategyId: "test" })
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
