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
const { createCompatibilityService } = require("../runtime/compatibility/service.cjs");

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

test("compatibility service binds existing behavior behind a tracked capability", () => {
  const service = createCompatibilityService();
  const calls = [];
  const capability = service.bindCapability(
    "static.cache.renderer.html.lang",
    (html, locale) => {
      calls.push({ html, locale });
      return html.replace("en", locale);
    },
    {
      locatorRevision: "html-lang-v1",
      strategyId: "html-transform",
      verify: () => true,
    }
  );

  assert.equal(capability('<html lang="en">', "zh-CN"), '<html lang="zh-CN">');
  assert.equal(calls.length, 1);
  const point = service.registry.point("static.cache.renderer.html.lang");
  assert.equal(point.status, "healthy");
  assert.equal(point.exercise.hitCount, 1);
  service.dispose();
});

test("browser receipts are allowlisted to web runtime points", () => {
  const service = createCompatibilityService();
  const clientId = "browser_page_123";
  assert.equal(
    service.browserReport({
      clientId,
      id: "web.runtime.bridge.desktop-api",
      phase: "installed",
    }),
    true
  );
  assert.equal(service.registry.point("web.runtime.bridge.desktop-api").status, "ready");
  assert.equal(
    service.browserReport({
      clientId,
      id: "web.runtime.bridge.desktop-api",
      phase: "active",
    }),
    true
  );
  assert.equal(service.registry.point("web.runtime.bridge.desktop-api").status, "healthy");
  assert.equal(
    service.browserReport({
      clientId,
      id: "web.runtime.bridge.desktop-api",
      phase: "fallback",
      reason: "temporary fallback",
    }),
    true
  );
  assert.equal(service.registry.point("web.runtime.bridge.desktop-api").status, "degraded");
  service.browserReport({ clientId, id: "web.runtime.bridge.desktop-api", phase: "active" });
  assert.equal(service.registry.point("web.runtime.bridge.desktop-api").status, "healthy");
  assert.equal(
    service.browserReport({
      clientId,
      id: "gateway.runtime.electron.ipc-main",
      phase: "active",
    }),
    false
  );
  assert.equal(
    service.browserReport({
      clientId: "bad id",
      id: "web.runtime.bridge.desktop-api",
      phase: "active",
    }),
    false
  );
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

  assert.equal(store.read().runtime.version, "26.3");
  assert.equal(fs.readdirSync(historyDir).length, 2);
  assert.equal(fs.readdirSync(path.dirname(filePath)).some((name) => name.includes(".tmp-")), false);
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
});

test("service persists a sanitized report and resets capabilities for a new runtime", (t) => {
  const directory = temporaryDirectory(t);
  const runtimeDir = path.join(directory, "runtime");
  const reportsDir = path.join(directory, "reports");
  const service = createCompatibilityService({ runtimeDir, reportsDir, persistDelayMs: 0 });
  service.setRuntimeIdentity({ version: "26.8", build: "1", bundleHash: "bundle-a" });
  service.failPoint(
    "gateway.runtime.electron.dialog-open",
    new Error("failed under /Users/alice/private/dialog.js?token=secret"),
    { fallbackReason: "official dialog" }
  );
  service.persistNow();

  const first = JSON.parse(fs.readFileSync(path.join(runtimeDir, "compatibility-report.json"), "utf8"));
  const point = first.points.find((item) => item.id === "gateway.runtime.electron.dialog-open");
  assert.equal(point.location.reason.includes("/Users/alice"), false);
  assert.equal(point.location.reason.includes("secret"), false);
  assert.equal(point.status, "degraded");

  service.setRuntimeIdentity({ version: "26.9", build: "2", bundleHash: "bundle-b" });
  assert.equal(service.registry.point("gateway.runtime.electron.dialog-open").location.status, "unresolved");
  service.dispose();
});

test("repeating the same runtime identity keeps installed capability handles valid", () => {
  const service = createCompatibilityService();
  service.setRuntimeIdentity({ version: "26.8", build: "1", bundleHash: "bundle-a" });
  const capability = service.bindCapability(
    "gateway.runtime.electron.dialog-open",
    (value) => value,
    { locatorRevision: "dialog-v1", strategyId: "test" }
  );

  service.setRuntimeIdentity({ version: "26.8", build: "1", bundleHash: "bundle-a" });
  assert.equal(capability("same-runtime"), "same-runtime");
  assert.equal(service.registry.point("gateway.runtime.electron.dialog-open").status, "healthy");
  service.dispose();
});

test("public compatibility API exposes only the read-only sanitized snapshot", () => {
  const service = createCompatibilityService();
  const getResponse = responseRecorder();
  assert.equal(
    handlePublicRuntimeCompatibilityApi(
      request("GET"),
      getResponse,
      new URL(`http://localhost${RUNTIME_COMPATIBILITY_API_PATH}`),
      service
    ),
    true
  );
  assert.equal(getResponse.status, 200);
  assert.equal(JSON.parse(getResponse.body).compatibility.points.length, 102);

  const reportResponse = responseRecorder();
  assert.equal(
    handlePublicRuntimeCompatibilityApi(
      request("POST"),
      reportResponse,
      new URL(`http://localhost${RUNTIME_COMPATIBILITY_REPORT_PATH}`),
      service
    ),
    false
  );
  assert.equal(reportResponse.status, 0);

  const unavailableResponse = responseRecorder();
  assert.equal(
    handlePublicRuntimeCompatibilityApi(
      request("GET"),
      unavailableResponse,
      new URL(`http://localhost${RUNTIME_COMPATIBILITY_API_PATH}`),
      null
    ),
    true
  );
  assert.equal(unavailableResponse.status, 503);
  service.dispose();
});

test("authenticated compatibility API exposes snapshots and rejects gateway point spoofing", async () => {
  const service = createCompatibilityService();
  const getResponse = responseRecorder();
  assert.equal(
    await handleRuntimeCompatibilityApi(
      request("GET"),
      getResponse,
      new URL(`http://localhost${RUNTIME_COMPATIBILITY_API_PATH}`),
      service
    ),
    true
  );
  assert.equal(getResponse.status, 200);
  assert.equal(JSON.parse(getResponse.body).compatibility.points.length, 102);

  const reportResponse = responseRecorder();
  await handleRuntimeCompatibilityApi(
    request("POST", {
      clientId: "browser_page_123",
      reports: [{ id: "web.runtime.bridge.desktop-api", phase: "active" }],
    }),
    reportResponse,
    new URL(`http://localhost${RUNTIME_COMPATIBILITY_REPORT_PATH}`),
    service
  );
  assert.equal(reportResponse.status, 200);
  assert.equal(service.registry.point("web.runtime.bridge.desktop-api").status, "healthy");

  const spoofedResponse = responseRecorder();
  await handleRuntimeCompatibilityApi(
    request("POST", {
      clientId: "browser_page_123",
      reports: [{ id: "gateway.runtime.electron.ipc-main", phase: "active" }],
    }),
    spoofedResponse,
    new URL(`http://localhost${RUNTIME_COMPATIBILITY_REPORT_PATH}`),
    service
  );
  assert.equal(spoofedResponse.status, 400);
  const atomicResponse = responseRecorder();
  await handleRuntimeCompatibilityApi(
    request("POST", {
      clientId: "browser_page_123",
      reports: [
        { id: "web.runtime.platform.desktop-globals", phase: "installed" },
        { id: "gateway.runtime.electron.ipc-main", phase: "active" },
      ],
    }),
    atomicResponse,
    new URL(`http://localhost${RUNTIME_COMPATIBILITY_REPORT_PATH}`),
    service
  );
  assert.equal(atomicResponse.status, 400);
  assert.equal(service.registry.point("web.runtime.platform.desktop-globals").status, "pending");
  service.dispose();
});
