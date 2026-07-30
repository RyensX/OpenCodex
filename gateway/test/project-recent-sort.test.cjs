const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { listPluginEntries, pluginMessagesForLocale } = require("../runtime/core/plugin-assets.cjs");

const PLUGIN_SOURCE = fs.readFileSync(
  path.resolve(__dirname, "..", "..", "web-shell", "plugins", "project-recent-sort", "index.js"),
  "utf-8"
);
const FLAT_PREFERENCES_KEY = "flat-project-sidebar-preferences-v1";
const LEGACY_SORT_MODE_KEY = "codex-sidebar-sort-mode-v1";
const PROJECT_ORDER_KEY = "project-order";

function createHarness({
  flatPreferences = { projectSortMode: "priority" },
  legacySortMode,
  bootstrapEntries = [
    { key: PROJECT_ORDER_KEY, value: ["project-a", "project-b"] },
    { key: "local-projects", value: { "project-a": {} } },
  ],
} = {}) {
  const bridgeListeners = new Map();
  const forwardedMessages = [];
  const postedMessages = [];
  const dispatchedMessages = [];
  const microtasks = [];
  let registeredPlugin = null;
  const initialBootstrap = { globalStateEntries: bootstrapEntries };

  const persistedAtomSnapshot = {
    [FLAT_PREFERENCES_KEY]: flatPreferences,
  };
  if (legacySortMode !== undefined) persistedAtomSnapshot[LEGACY_SORT_MODE_KEY] = legacySortMode;

  const bridge = {
    getInitialSidebarBootstrap() {
      return initialBootstrap;
    },
    on(channel, handler) {
      if (!bridgeListeners.has(channel)) bridgeListeners.set(channel, new Set());
      bridgeListeners.get(channel).add(handler);
      return () => bridgeListeners.get(channel)?.delete(handler);
    },
    sendMessageFromView(payload) {
      forwardedMessages.push(payload);
      if (payload?.type === "persisted-atom-update") {
        for (const handler of bridgeListeners.get("persisted-atom-updated") || []) {
          handler({ key: payload.key, value: payload.value, deleted: !!payload.deleted });
        }
      }
      return Promise.resolve(true);
    },
  };

  const window = {
    __CODEX_WEB_CONFIG__: { persistedAtomSnapshot },
    __codexWebDispatch(type, payload) {
      dispatchedMessages.push({ type, payload });
    },
    clearTimeout() {},
    location: { origin: "http://localhost" },
    postMessage(message) {
      postedMessages.push(message);
    },
    queueMicrotask(callback) {
      microtasks.push(callback);
    },
    setTimeout(callback) {
      microtasks.push(callback);
      return microtasks.length;
    },
  };
  window.OpenCodexPluginSystem = {
    registerPlugin(plugin) {
      registeredPlugin = plugin;
    },
  };
  window.window = window;

  vm.runInNewContext(PLUGIN_SOURCE, { console, window });
  const dispose = registeredPlugin.activate({
    plugin: { isEnabled: () => true },
    scope: "renderer",
  });
  window.electronBridge = bridge;

  // 实际页面会在 bridge 脚本结束后、官方模块执行前清空微任务；测试显式复现这一加载顺序。
  while (microtasks.length > 0) microtasks.shift()();

  return {
    bridge,
    dispatchedMessages,
    dispose,
    forwardedMessages,
    initialBootstrap,
    plugin: registeredPlugin,
    postedMessages,
  };
}

function projectOrderFetch(requestId) {
  return {
    type: "fetch",
    requestId,
    method: "POST",
    url: "vscode://codex/get-global-state",
    body: JSON.stringify({ key: PROJECT_ORDER_KEY }),
  };
}

function parsed(value) {
  return JSON.parse(JSON.stringify(value));
}

test("project recent sort plugin is discovered with localized copy", () => {
  const entry = listPluginEntries().find((plugin) => plugin.name === "project-recent-sort");
  const zh = pluginMessagesForLocale("zh-CN");
  const en = pluginMessagesForLocale("en-US");

  // 插件必须由现有内置 loader 自动发现，且默认开关和文案能出现在插件设置中。
  assert.ok(entry);
  assert.equal(entry.sourceId, "builtin");
  assert.equal(entry.urlPath, "builtin/project-recent-sort/index.js");
  assert.equal(zh["plugin.projectRecentSort.label"], "项目最近更新排序");
  assert.equal(en["plugin.projectRecentSort.label"], "Sort projects by recent activity");
});

test("recent mode masks project order in both bootstrap and global-state fetches", async () => {
  const harness = createHarness({ flatPreferences: { projectSortMode: "updated_at" } });

  const bootstrap = parsed(harness.bridge.getInitialSidebarBootstrap());
  assert.deepEqual(
    bootstrap.globalStateEntries.find((entry) => entry.key === PROJECT_ORDER_KEY)?.value,
    []
  );
  assert.deepEqual(
    harness.initialBootstrap.globalStateEntries.find((entry) => entry.key === PROJECT_ORDER_KEY)?.value,
    ["project-a", "project-b"]
  );

  await harness.bridge.sendMessageFromView(projectOrderFetch("recent-request"));
  assert.equal(harness.forwardedMessages.length, 0);
  const response = harness.postedMessages.find(
    (message) => message.type === "fetch-response" && message.requestId === "recent-request"
  );
  assert.ok(response);
  assert.deepEqual(JSON.parse(response.bodyJsonString), { value: [] });

  harness.dispose();
});

test("manual mode keeps the saved project order and forwards the official request", async () => {
  const harness = createHarness({ flatPreferences: { projectSortMode: "manual" } });

  assert.deepEqual(
    parsed(harness.bridge.getInitialSidebarBootstrap()).globalStateEntries.find(
      (entry) => entry.key === PROJECT_ORDER_KEY
    )?.value,
    ["project-a", "project-b"]
  );

  const request = projectOrderFetch("manual-request");
  await harness.bridge.sendMessageFromView(request);
  assert.equal(harness.forwardedMessages.length, 1);
  assert.equal(harness.forwardedMessages[0], request);
  assert.equal(
    harness.postedMessages.some(
      (message) => message.type === "fetch-response" && message.requestId === "manual-request"
    ),
    false
  );

  harness.dispose();
});

test("switching between recent and manual invalidates the project-order query immediately", async () => {
  const harness = createHarness({ flatPreferences: { projectSortMode: "manual" } });
  const initialInvalidations = harness.postedMessages.filter(
    (message) => message.type === "global-state-updated"
  ).length;

  await harness.bridge.sendMessageFromView({
    type: "persisted-atom-update",
    key: FLAT_PREFERENCES_KEY,
    value: { projectSortMode: "updated_at" },
  });
  await harness.bridge.sendMessageFromView(projectOrderFetch("after-recent"));
  assert.equal(harness.forwardedMessages.some((message) => message.requestId === "after-recent"), false);

  await harness.bridge.sendMessageFromView({
    type: "persisted-atom-update",
    key: FLAT_PREFERENCES_KEY,
    value: { projectSortMode: "manual" },
  });
  await harness.bridge.sendMessageFromView(projectOrderFetch("after-manual"));
  assert.equal(harness.forwardedMessages.some((message) => message.requestId === "after-manual"), true);

  const invalidations = harness.postedMessages.filter(
    (message) => message.type === "global-state-updated"
  );
  assert.equal(invalidations.length, initialInvalidations + 2);
  assert.deepEqual(parsed(invalidations.at(-1).keys), [PROJECT_ORDER_KEY]);

  harness.dispose();
});

test("legacy unified sort override follows the same precedence as the official renderer", async () => {
  const harness = createHarness({
    flatPreferences: { projectSortMode: "updated_at" },
    legacySortMode: "manual",
  });

  await harness.bridge.sendMessageFromView(projectOrderFetch("legacy-manual"));
  assert.equal(harness.forwardedMessages.some((message) => message.requestId === "legacy-manual"), true);

  await harness.bridge.sendMessageFromView({
    type: "persisted-atom-update",
    key: LEGACY_SORT_MODE_KEY,
    deleted: true,
    value: null,
  });
  await harness.bridge.sendMessageFromView(projectOrderFetch("legacy-removed"));
  assert.equal(harness.forwardedMessages.some((message) => message.requestId === "legacy-removed"), false);

  harness.dispose();
});

test("disabling the plugin restores the original bridge methods and real project order", async () => {
  const harness = createHarness({ flatPreferences: { projectSortMode: "updated_at" } });
  harness.dispose();

  assert.equal(harness.bridge.getInitialSidebarBootstrap(), harness.initialBootstrap);
  const request = projectOrderFetch("after-dispose");
  await harness.bridge.sendMessageFromView(request);
  assert.equal(harness.forwardedMessages.at(-1), request);
  assert.equal(harness.postedMessages.at(-1)?.type, "global-state-updated");
});
