const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const REPORTER_SOURCE = fs.readFileSync(
  path.resolve(__dirname, "..", "..", "web-shell", "codex-runtime-compatibility.js"),
  "utf8"
);

function pointSnapshot({ active = false, hitCount = 0 } = {}) {
  return {
    id: "web.runtime.bridge.desktop-api",
    groupId: "renderer-core",
    status: active ? "active" : "ready",
    directAdapterIds: ["adapter.desktop-bridge"],
    adapterChainIds: ["adapter.desktop-bridge", "adapter.runtime-hook", "adapter.protocol-pipeline"],
    contributions: [
      {
        id: "web.runtime.bridge.desktop-api::0.0",
        directAdapterId: "adapter.desktop-bridge",
        adapterId: "adapter.runtime-hook",
        adapterChainIds: ["adapter.desktop-bridge", "adapter.runtime-hook"],
        location: "resolved",
        application: "applied",
        verification: "verified",
        activation: "ready",
        exercise: active ? "active" : "not-exercised",
        hitCount,
        reason: "",
      },
    ],
  };
}

function createContext(fetch) {
  const documentListeners = new Map();
  const windowListeners = new Map();
  const context = {
    crypto: { randomUUID: () => "browser_page_123" },
    document: {
      visibilityState: "visible",
      addEventListener(type, listener) { documentListeners.set(type, listener); },
      removeEventListener(type, listener) {
        if (documentListeners.get(type) === listener) documentListeners.delete(type);
      },
    },
    fetch,
    setTimeout,
    clearTimeout,
    addEventListener(type, listener) { windowListeners.set(type, listener); },
  };
  context.window = context;
  vm.runInNewContext(REPORTER_SOURCE, context, { filename: "codex-runtime-compatibility.js" });
  return { context, documentListeners, windowListeners };
}

test("browser Kernel reporter batches the latest Contribution snapshot with a shared page id", async () => {
  const calls = [];
  const harness = createContext(async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200 };
  });
  const reporter = harness.context.OpenCodexRuntimeCompatibility;
  assert.equal(reporter.clientId, "browser_page_123");
  assert.equal(reporter.apiVersion, 2);
  reporter.ingestSnapshot({ points: [pointSnapshot()] });
  reporter.ingestSnapshot({ points: [pointSnapshot({ active: true, hitCount: 1 })] });
  reporter.ingestSnapshot({ points: [{ ...pointSnapshot(), id: "gateway.runtime.electron.ipc-main" }] });
  await new Promise((resolve) => setTimeout(resolve, 120));

  assert.equal(calls.length, 1);
  const payload = JSON.parse(calls[0].options.body);
  assert.equal(payload.clientId, "browser_page_123");
  assert.equal(payload.generation, 1);
  assert.equal(payload.reports.length, 1);
  assert.equal(payload.reports[0].point.status, "active");
  assert.equal(payload.reports[0].point.contributions[0].hitCount, 1);
  assert.equal(harness.documentListeners.has("visibilitychange"), true);
  assert.equal(harness.windowListeners.has("online"), true);

  reporter.ingestSnapshot({ points: [pointSnapshot({ active: true, hitCount: 1 })] });
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(calls.length, 1);
});

test("browser Kernel reporter starts a new monotonic generation after document replacement", async () => {
  const calls = [];
  const { context } = createContext(async (_url, options) => {
    calls.push(JSON.parse(options.body));
    return { ok: true, status: 200 };
  });
  const reporter = context.OpenCodexRuntimeCompatibility;
  reporter.ingestSnapshot({ points: [pointSnapshot()] });
  await new Promise((resolve) => setTimeout(resolve, 120));
  reporter.beginGeneration();
  reporter.ingestSnapshot({ points: [pointSnapshot()] });
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.deepEqual(calls.map((call) => call.generation), [1, 2]);
  assert.deepEqual(calls.map((call) => call.reports[0].sequence), [1, 1]);
});

test("browser Kernel reporter moves its visibility listener to the replacement document", () => {
  const harness = createContext(async () => ({ ok: true, status: 200 }));
  assert.equal(harness.documentListeners.has("visibilitychange"), true);
  const nextListeners = new Map();
  harness.context.document = {
    visibilityState: "visible",
    addEventListener(type, listener) { nextListeners.set(type, listener); },
    removeEventListener(type, listener) {
      if (nextListeners.get(type) === listener) nextListeners.delete(type);
    },
  };
  harness.context.OpenCodexRuntimeCompatibility.beginGeneration();
  assert.equal(harness.documentListeners.has("visibilitychange"), false);
  assert.equal(nextListeners.has("visibilitychange"), true);
});

test("failed Kernel delivery preserves a newer snapshot queued while the request is in flight", async () => {
  const calls = [];
  let rejectFirst = null;
  const harness = createContext(async (_url, options) => {
    calls.push(JSON.parse(options.body));
    if (calls.length === 1) {
      return new Promise((_resolve, reject) => { rejectFirst = reject; });
    }
    return { ok: true, status: 200 };
  });
  const reporter = harness.context.OpenCodexRuntimeCompatibility;
  reporter.ingestSnapshot({ points: [pointSnapshot()] });
  await new Promise((resolve) => setTimeout(resolve, 100));
  reporter.ingestSnapshot({ points: [pointSnapshot({ active: true, hitCount: 1 })] });
  harness.context.document.visibilityState = "hidden";
  rejectFirst(new Error("offline"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await reporter.flush();

  assert.equal(calls.length, 2);
  assert.equal(calls[1].reports[0].point.status, "active");
  assert.equal(calls[1].reports[0].point.contributions[0].hitCount, 1);
});

test("an old in-flight response cannot suppress the next document generation", async () => {
  const calls = [];
  let resolveFirst = null;
  const { context } = createContext(async (_url, options) => {
    calls.push(JSON.parse(options.body));
    if (calls.length === 1) {
      return new Promise((resolve) => { resolveFirst = () => resolve({ ok: true, status: 200 }); });
    }
    return { ok: true, status: 200 };
  });
  const reporter = context.OpenCodexRuntimeCompatibility;
  reporter.ingestSnapshot({ points: [pointSnapshot()] });
  await new Promise((resolve) => setTimeout(resolve, 100));
  reporter.beginGeneration();
  reporter.ingestSnapshot({ points: [pointSnapshot({ active: true, hitCount: 1 })] });
  resolveFirst();
  await new Promise((resolve) => setTimeout(resolve, 120));

  assert.deepEqual(calls.map((call) => call.generation), [1, 2]);
  assert.equal(calls[1].reports[0].point.status, "active");
});
