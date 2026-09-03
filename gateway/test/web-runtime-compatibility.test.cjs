const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const REPORTER_SOURCE = fs.readFileSync(
  path.resolve(__dirname, "..", "..", "web-shell", "codex-runtime-compatibility.js"),
  "utf8"
);

function pointSnapshot({ active = false, hitCount = 0, id = "web.runtime.bridge.desktop-api" } = {}) {
  return {
    id,
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

function pluginSnapshot(plugin, id) {
  const basePoint = pointSnapshot({ active: true, hitCount: 1, id });
  const groupId = `${plugin.id}.group`;
  const directAdapterId = `${plugin.id}.adapter`;
  const terminalAdapterId = `${plugin.id}.terminal`;
  const point = {
    ...basePoint,
    description: "Plugin point",
    owner: plugin.id,
    plugin,
    groupId,
    directAdapterIds: [directAdapterId],
    adapterChainIds: [directAdapterId, terminalAdapterId],
    contributions: [{
      ...basePoint.contributions[0],
      id: `${id}::0.0`,
      directAdapterId,
      adapterId: terminalAdapterId,
      adapterChainIds: [directAdapterId, terminalAdapterId],
    }],
  };
  return {
    groups: [{ id: groupId, name: "Plugin group", description: "Plugin points", order: 900, pointIds: [id] }],
    adapterTypes: [
      { id: terminalAdapterId, name: "Terminal", description: "Terminal adapter", kind: "terminal", dependencies: [] },
      {
        id: directAdapterId,
        name: "Plugin adapter",
        description: "Plugin adapter",
        kind: "composite",
        dependencies: [terminalAdapterId],
      },
    ],
    points: [point],
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

test("browser Kernel reporter sends structured catalogs for external plugin points", async () => {
  const calls = [];
  const { context } = createContext(async (_url, options) => {
    calls.push(JSON.parse(options.body));
    return { ok: true, status: 200 };
  });
  const plugin = { id: "example.runtime-plugin", name: "Runtime plugin" };
  const basePoint = pointSnapshot({ active: true, hitCount: 1 });
  const point = {
    ...basePoint,
    id: "example.runtime-plugin.mount",
    description: "Mount plugin content",
    owner: plugin.id,
    plugin,
    groupId: "example-runtime-plugin",
    directAdapterIds: ["adapter.example-runtime-plugin"],
    adapterChainIds: ["adapter.example-runtime-plugin", "adapter.runtime-view"],
    contributions: [{
      ...basePoint.contributions[0],
      id: "example.runtime-plugin.mount::0.0",
      directAdapterId: "adapter.example-runtime-plugin",
      adapterId: "adapter.runtime-view",
      adapterChainIds: ["adapter.example-runtime-plugin", "adapter.runtime-view"],
    }],
  };
  context.OpenCodexRuntimeCompatibility.ingestSnapshot({
    groups: [{
      id: "example-runtime-plugin",
      name: "Runtime plugin",
      description: "Plugin modification points",
      order: 900,
      pointIds: [point.id],
    }],
    adapterTypes: [
      {
        id: "adapter.runtime-view",
        name: "Runtime View",
        description: "Base view adapter",
        kind: "terminal",
        dependencies: [],
      },
      {
        id: "adapter.example-runtime-plugin",
        name: "Plugin view",
        description: "Semantic plugin view adapter",
        kind: "composite",
        dependencies: ["adapter.runtime-view"],
      },
    ],
    points: [point],
  }, { plugin });
  await new Promise((resolve) => setTimeout(resolve, 120));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].catalogs.length, 1);
  assert.deepEqual(calls[0].catalogs[0].plugin, plugin);
  assert.equal(calls[0].reports[0].point.plugin.id, plugin.id);
  assert.equal(calls[0].reports[0].point.id, point.id);
});

test("browser Kernel reporter preserves global sequence across interleaved plugin sources", async () => {
  const calls = [];
  const { context } = createContext(async (_url, options) => {
    calls.push(JSON.parse(options.body));
    return { ok: true, status: 200 };
  });
  const reporter = context.OpenCodexRuntimeCompatibility;
  const plugin = { id: "example.interleaved-plugin", name: "Interleaved plugin" };

  reporter.ingestSnapshot({ points: [pointSnapshot({ id: "web.runtime.bridge.desktop-api" })] });
  reporter.ingestSnapshot(pluginSnapshot(plugin, "example.interleaved-plugin.mount"), { plugin });
  reporter.ingestSnapshot({ points: [pointSnapshot({ id: "web.runtime.bridge.ipc-transport" })] });

  // 三个来源段必须按 1、2、3 依次提交；旧实现会先提交 1、3，导致服务端永久拒绝插件回执 2。
  const deadline = Date.now() + 1_000;
  while (calls.length < 3 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((call) => call.reports.map((report) => report.sequence)), [[1], [2], [3]]);
  assert.deepEqual(calls.map((call) => call.reports[0].point.id), [
    "web.runtime.bridge.desktop-api",
    "example.interleaved-plugin.mount",
    "web.runtime.bridge.ipc-transport",
  ]);
  assert.deepEqual(calls.map((call) => call.catalogs.length), [0, 1, 0]);
});

test("browser Kernel reporter replays every latest point after the server report epoch changes", async () => {
  const calls = [];
  const reportEpoch = "gateway_instance_2:4";
  const { context } = createContext(async (_url, options) => {
    const payload = JSON.parse(options.body);
    calls.push(payload);
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          ok: true,
          accepted: payload.reports.length,
          reportEpoch,
          resync: calls.length === 1,
        };
      },
    };
  });
  const pointIds = Array.from(
    { length: 20 },
    (_value, index) => `web.runtime.test.resync-${String(index).padStart(2, "0")}`,
  );
  context.OpenCodexRuntimeCompatibility.ingestSnapshot({
    points: pointIds.map((id) => pointSnapshot({ id })),
  });

  const deadline = Date.now() + 1_000;
  while (calls.length < 3 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.equal(calls.length, 3);
  assert.equal(calls[0].reportEpoch, "");
  assert.equal(calls[0].reports.length, 16);
  assert.equal(calls.slice(1).every((call) => call.reportEpoch === reportEpoch), true);
  const replayReports = calls.slice(1).flatMap((call) => call.reports);
  assert.deepEqual(replayReports.map((report) => report.point.id), pointIds);
  // 首批尚未发送的旧序号也必须被完整重放替换，避免服务端把较小序号当成过期回执忽略。
  assert.equal(
    Math.min(...replayReports.map((report) => report.sequence)) >
      Math.max(...calls[0].reports.map((report) => report.sequence)),
    true,
  );
});

test("browser Kernel reporter replays an external plugin catalog with its latest point", async () => {
  const calls = [];
  const reportEpoch = "gateway_instance_3:2";
  const { context } = createContext(async (_url, options) => {
    const payload = JSON.parse(options.body);
    calls.push(payload);
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          ok: true,
          accepted: payload.reports.length,
          reportEpoch,
          resync: calls.length === 1,
        };
      },
    };
  });
  const plugin = { id: "example.resync-plugin", name: "Resync plugin" };
  const pointId = "example.resync-plugin.mount";
  context.OpenCodexRuntimeCompatibility.ingestSnapshot(pluginSnapshot(plugin, pointId), { plugin });

  const deadline = Date.now() + 1_000;
  while (calls.length < 2 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.catalogs[0]?.plugin.id), [plugin.id, plugin.id]);
  assert.deepEqual(calls.map((call) => call.reports[0]?.point.id), [pointId, pointId]);
  assert.equal(calls[1].reportEpoch, reportEpoch);
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
