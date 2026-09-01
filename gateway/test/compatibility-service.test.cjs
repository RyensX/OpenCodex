const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { EventEmitter } = require("node:events");
const {
  RUNTIME_COMPATIBILITY_API_PATH,
  RUNTIME_COMPATIBILITY_REPORT_PATH,
  handlePublicRuntimeCompatibilityApi,
  handleRuntimeCompatibilityApi,
} = require("../runtime/http/runtime-compatibility.cjs");
const { createCompatibilityReportStore } = require("../runtime/compatibility/report-store.cjs");
const {
  BROWSER_REPORTER_STALE_MS,
  createCompatibilityService,
} = require("../runtime/compatibility/service.cjs");
const { POINT_DEFINITION_BY_ID } = require("../dist/modification/catalog.js");
const { createProductionModificationCoordinator } = require("../dist/modification/production.js");

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "opencodex-compatibility-"));
  t.after(() => fs.rmSync(directory, { force: true, recursive: true }));
  return directory;
}

function responseRecorder() {
  return {
    body: "",
    headers: {},
    status: 0,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body) {
      this.body = String(body || "");
    },
  };
}

function request(method, body) {
  const value = new EventEmitter();
  value.method = method;
  process.nextTick(() => {
    if (body !== undefined) value.emit("data", Buffer.from(JSON.stringify(body)));
    value.emit("end");
  });
  return value;
}

function browserKernelPoint(id, { active = false } = {}) {
  const point = POINT_DEFINITION_BY_ID.get(id);
  let snapshot = null;
  const coordinator = createProductionModificationCoordinator({
    host: "browser",
    publish(value) { snapshot = value; },
  });
  const capability = coordinator.bind(point, () => true);
  if (active) capability();
  return snapshot;
}

test("compatibility service exposes the Gateway production Kernel coordinator", () => {
  const service = createCompatibilityService();
  const calls = [];
  const point = service.modificationPoints.gateway.dialogOpen;
  const capability = service.modifications.bind(point, (value) => {
    calls.push(value);
    return value.toUpperCase();
  });
  assert.equal(service.registry.point(point.id).status, "ready");
  assert.equal(capability("ready"), "READY");
  assert.deepEqual(calls, ["ready"]);
  const snapshot = service.registry.point(point.id);
  assert.equal(snapshot.status, "healthy");
  assert.equal(snapshot.contributions.length > 0, true);
  assert.equal(snapshot.contributions.every((item) => item.activation === "ready"), true);
  service.dispose();
});

test("browser Kernel reports are catalog checked, monotonic and idempotent", () => {
  const service = createCompatibilityService();
  const clientId = "browser_page_123";
  const readyPoint = browserKernelPoint("web.runtime.bridge.desktop-api");
  const activePoint = browserKernelPoint("web.runtime.bridge.desktop-api", { active: true });
  assert.equal(service.browserKernelReport({
    clientId,
    generation: 1,
    report: { sequence: 1, point: readyPoint },
  }), true);
  assert.equal(service.registry.point(readyPoint.id).status, "ready");
  assert.equal(service.browserKernelReport({
    clientId,
    generation: 1,
    report: { sequence: 2, point: activePoint },
  }), true);
  assert.equal(service.registry.point(activePoint.id).status, "healthy");
  assert.equal(activePoint.contributions.length > 1, true);
  assert.equal(service.registry.point(activePoint.id).exercise.hitCount, 1);
  assert.equal(service.browserKernelReport({
    clientId,
    generation: 1,
    report: { sequence: 2, point: activePoint },
  }), true);
  assert.equal(service.canAcceptBrowserKernelReport({
    clientId: "bad id",
    generation: 1,
    report: { sequence: 3, point: activePoint },
  }), false);
  assert.equal(service.canAcceptBrowserKernelReport({
    clientId,
    generation: 1,
    report: { sequence: 3, point: { ...activePoint, id: "gateway.runtime.electron.ipc-main" } },
  }), false);
  service.dispose();
});

test("a replaced browser client cannot overwrite the current page generation", () => {
  let currentTime = 1_000;
  const service = createCompatibilityService({ now: () => currentTime });
  const pointId = "web.runtime.bridge.desktop-api";
  const readyPoint = browserKernelPoint(pointId);
  const activePoint = browserKernelPoint(pointId, { active: true });

  assert.equal(service.browserKernelReport({
    clientId: "browser_page_old",
    generation: 1,
    report: { sequence: 1, point: activePoint },
  }), true);
  assert.equal(service.registry.point(pointId).status, "healthy");
  assert.equal(service.browserKernelReport({
    clientId: "browser_page_new",
    generation: 1,
    report: { sequence: 1, point: readyPoint },
  }), true);
  assert.equal(service.registry.point(pointId).status, "ready");

  // 旧页面的延迟回执只做幂等确认，不能把新页面状态覆盖回去。
  assert.equal(service.browserKernelReport({
    clientId: "browser_page_old",
    generation: 1,
    report: { sequence: 2, point: activePoint },
  }), true);
  assert.equal(service.registry.point(pointId).status, "ready");

  // 当前页面长时间没有回执时，仍存活的旧标签页可以成为新的当前报告者。
  currentTime += BROWSER_REPORTER_STALE_MS + 1;
  assert.equal(service.browserKernelReport({
    clientId: "browser_page_old",
    generation: 1,
    report: { sequence: 3, point: activePoint },
  }), true);
  assert.equal(service.registry.point(pointId).status, "healthy");
  service.dispose();
});

test("compatibility report store writes latest and bounded per-runtime history atomically", (t) => {
  const directory = temporaryDirectory(t);
  const filePath = path.join(directory, "runtime", "compatibility-report.json");
  const historyDir = path.join(directory, "reports", "compatibility");
  const store = createCompatibilityReportStore({ filePath, historyDir, historyLimit: 2 });
  for (let index = 1; index <= 3; index += 1) {
    store.write({
      schemaVersion: 1,
      generatedAt: new Date(2026, 7, index).toISOString(),
      runtime: { version: `26.${index}`, build: String(index), bundleHash: `hash-${index}` },
      status: "ready",
      points: [],
      features: [],
    });
    const historyPath = path.join(historyDir, `compatibility-26.${index}-${index}-hash-${index}.json`);
    const adjustedTime = new Date(Date.now() + index * 1000);
    fs.utimesSync(historyPath, adjustedTime, adjustedTime);
  }
  const normalizedLegacyReport = store.read();
  assert.equal(normalizedLegacyReport.runtime.version, "26.3");
  assert.equal(normalizedLegacyReport.schemaVersion, 2);
  assert.equal(normalizedLegacyReport.sourceSchemaVersion, 1);
  assert.equal(normalizedLegacyReport.readOnly, true);
  assert.equal(normalizedLegacyReport.groups.length, 3);
  assert.equal(normalizedLegacyReport.adapterTypes[0].id, "adapter.legacy-report");
  assert.equal(fs.readdirSync(historyDir).length, 2);
  assert.equal(fs.readdirSync(path.dirname(filePath)).some((name) => name.includes(".tmp-")), false);
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
});

test("service persists sanitized Kernel failures and resets state for a new runtime", (t) => {
  const directory = temporaryDirectory(t);
  const runtimeDir = path.join(directory, "runtime");
  const reportsDir = path.join(directory, "reports");
  const service = createCompatibilityService({ runtimeDir, reportsDir, persistDelayMs: 0 });
  service.setRuntimeIdentity({ version: "26.8", build: "1", bundleHash: "bundle-a" });
  const point = service.modificationPoints.gateway.dialogOpen;
  assert.throws(() => service.modifications.execute(point, () => {
    throw new Error("failed under /Users/alice/private/dialog.js?token=secret");
  }), /failed under/);
  service.persistNow();
  const first = JSON.parse(fs.readFileSync(path.join(runtimeDir, "compatibility-report.json"), "utf8"));
  const persistedPoint = first.points.find((item) => item.id === point.id);
  assert.equal(persistedPoint.location.reason.includes("/Users/alice"), false);
  assert.equal(persistedPoint.location.reason.includes("secret"), false);
  assert.equal(persistedPoint.status, "unavailable");

  service.setRuntimeIdentity({ version: "26.9", build: "2", bundleHash: "bundle-b" });
  assert.equal(service.registry.point(point.id).location.status, "unresolved");
  service.dispose();
});

test("repeating the same runtime identity keeps Kernel capabilities valid", () => {
  const service = createCompatibilityService();
  const point = service.modificationPoints.gateway.dialogOpen;
  service.setRuntimeIdentity({ version: "26.8", build: "1", bundleHash: "bundle-a" });
  const capability = service.modifications.bind(point, (value) => value);
  service.setRuntimeIdentity({ version: "26.8", build: "1", bundleHash: "bundle-a" });
  assert.equal(capability("same-runtime"), "same-runtime");
  assert.equal(service.registry.point(point.id).status, "healthy");
  service.dispose();
});

test("public compatibility API exposes only the read-only sanitized snapshot", () => {
  const service = createCompatibilityService();
  const getResponse = responseRecorder();
  assert.equal(handlePublicRuntimeCompatibilityApi(
    request("GET"),
    getResponse,
    new URL(`http://localhost${RUNTIME_COMPATIBILITY_API_PATH}`),
    service,
  ), true);
  assert.equal(getResponse.status, 200);
  assert.equal(JSON.parse(getResponse.body).compatibility.points.length, 102);

  const reportResponse = responseRecorder();
  assert.equal(handlePublicRuntimeCompatibilityApi(
    request("POST"),
    reportResponse,
    new URL(`http://localhost${RUNTIME_COMPATIBILITY_REPORT_PATH}`),
    service,
  ), false);
  assert.equal(reportResponse.status, 0);

  const unavailableResponse = responseRecorder();
  assert.equal(handlePublicRuntimeCompatibilityApi(
    request("GET"),
    unavailableResponse,
    new URL(`http://localhost${RUNTIME_COMPATIBILITY_API_PATH}`),
    null,
  ), true);
  assert.equal(unavailableResponse.status, 503);
  service.dispose();
});

test("authenticated API accepts only validated Browser Kernel reports", async () => {
  const service = createCompatibilityService();
  const getResponse = responseRecorder();
  assert.equal(await handleRuntimeCompatibilityApi(
    request("GET"),
    getResponse,
    new URL(`http://localhost${RUNTIME_COMPATIBILITY_API_PATH}`),
    service,
  ), true);
  assert.equal(getResponse.status, 200);
  assert.equal(JSON.parse(getResponse.body).compatibility.points.length, 102);

  const point = browserKernelPoint("web.runtime.bridge.desktop-api", { active: true });
  const reportResponse = responseRecorder();
  await handleRuntimeCompatibilityApi(
    request("POST", {
      clientId: "browser_page_123",
      generation: 1,
      reports: [{ sequence: 1, point }],
    }),
    reportResponse,
    new URL(`http://localhost${RUNTIME_COMPATIBILITY_REPORT_PATH}`),
    service,
  );
  assert.equal(reportResponse.status, 200);
  assert.equal(service.registry.point(point.id).status, "healthy");

  const spoofedResponse = responseRecorder();
  await handleRuntimeCompatibilityApi(
    request("POST", {
      clientId: "browser_page_123",
      generation: 1,
      reports: [{ sequence: 2, point: { ...point, id: "gateway.runtime.electron.ipc-main" } }],
    }),
    spoofedResponse,
    new URL(`http://localhost${RUNTIME_COMPATIBILITY_REPORT_PATH}`),
    service,
  );
  assert.equal(spoofedResponse.status, 400);

  const untouched = browserKernelPoint("web.runtime.platform.desktop-globals");
  const atomicResponse = responseRecorder();
  await handleRuntimeCompatibilityApi(
    request("POST", {
      clientId: "browser_page_123",
      generation: 1,
      reports: [
        { sequence: 2, point: untouched },
        { sequence: 3, point: { ...point, id: "gateway.runtime.electron.ipc-main" } },
      ],
    }),
    atomicResponse,
    new URL(`http://localhost${RUNTIME_COMPATIBILITY_REPORT_PATH}`),
    service,
  );
  assert.equal(atomicResponse.status, 400);
  assert.equal(service.registry.point(untouched.id).status, "pending");
  service.dispose();
});
