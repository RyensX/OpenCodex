const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const REPORTER_SOURCE = fs.readFileSync(
  path.resolve(__dirname, "..", "..", "web-shell", "codex-runtime-compatibility.js"),
  "utf8"
);

test("browser compatibility reporter batches the latest phase with a shared page id", async () => {
  const calls = [];
  const documentListeners = new Map();
  const windowListeners = new Map();
  const storage = new Map();
  const context = {
    crypto: { randomUUID: () => "browser_page_123" },
    document: {
      visibilityState: "visible",
      addEventListener(type, listener) {
        documentListeners.set(type, listener);
      },
    },
    sessionStorage: {
      getItem: (key) => storage.get(key) || null,
      removeItem: (key) => storage.delete(key),
    },
    fetch: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200 };
    },
    setTimeout,
    clearTimeout,
    addEventListener(type, listener) {
      windowListeners.set(type, listener);
    },
  };
  context.window = context;
  vm.runInNewContext(REPORTER_SOURCE, context, { filename: "codex-runtime-compatibility.js" });

  const reporter = context.OpenCodexRuntimeCompatibility;
  assert.equal(reporter.clientId, "browser_page_123");
  reporter.installed("web.runtime.bridge.desktop-api");
  reporter.active("web.runtime.bridge.desktop-api");
  reporter.installed("web.runtime.bridge.desktop-api");
  reporter.active("gateway.runtime.electron.ipc-main");
  await new Promise((resolve) => setTimeout(resolve, 120));

  assert.equal(calls.length, 1);
  const payload = JSON.parse(calls[0].options.body);
  assert.equal(payload.clientId, "browser_page_123");
  assert.deepEqual(JSON.parse(JSON.stringify(payload.reports)), [
    { id: "web.runtime.bridge.desktop-api", phase: "active" },
  ]);
  assert.equal(documentListeners.has("visibilitychange"), true);
  assert.equal(windowListeners.has("online"), true);
  reporter.active("web.runtime.bridge.desktop-api");
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(calls.length, 1);
});

test("legacy document replacement is reported only after the login shell used it", async () => {
  const calls = [];
  const storage = new Map([["opencodex_legacy_document_replace_hit", "1"]]);
  const context = {
    crypto: { randomUUID: () => "browser_page_456" },
    document: { visibilityState: "visible", addEventListener() {} },
    sessionStorage: {
      getItem: (key) => storage.get(key) || null,
      removeItem: (key) => storage.delete(key),
    },
    fetch: async (_url, options) => {
      calls.push(JSON.parse(options.body));
      return { ok: true, status: 200 };
    },
    setTimeout,
    clearTimeout,
    addEventListener() {},
  };
  context.window = context;
  vm.runInNewContext(REPORTER_SOURCE, context);
  await new Promise((resolve) => setTimeout(resolve, 120));

  assert.equal(storage.has("opencodex_legacy_document_replace_hit"), false);
  assert.equal(calls[0].reports[0].id, "web.runtime.shell.legacy-document-replace");
  assert.equal(calls[0].reports[0].phase, "active");
});

test("failed browser delivery restores the highest phase observed while the request was in flight", async () => {
  const calls = [];
  let rejectFirst = null;
  const document = { visibilityState: "visible", addEventListener() {} };
  const context = {
    crypto: { randomUUID: () => "browser_page_789" },
    document,
    sessionStorage: { getItem: () => null, removeItem() {} },
    fetch: async (_url, options) => {
      calls.push(JSON.parse(options.body));
      if (calls.length === 1) {
        return new Promise((_resolve, reject) => {
          rejectFirst = reject;
        });
      }
      return { ok: true, status: 200 };
    },
    setTimeout,
    clearTimeout,
    addEventListener() {},
  };
  context.window = context;
  vm.runInNewContext(REPORTER_SOURCE, context);

  const reporter = context.OpenCodexRuntimeCompatibility;
  reporter.active("web.runtime.bridge.desktop-api");
  await new Promise((resolve) => setTimeout(resolve, 100));
  reporter.installed("web.runtime.bridge.desktop-api");
  // 隐藏状态阻止自动重试，测试显式 flush 时队列中的最终优先级。
  document.visibilityState = "hidden";
  rejectFirst(new Error("offline"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await reporter.flush();

  assert.equal(calls.length, 2);
  assert.equal(calls[1].reports[0].phase, "active");
});
