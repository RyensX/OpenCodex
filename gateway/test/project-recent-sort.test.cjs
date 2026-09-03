const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { listPluginEntries, pluginMessagesForLocale } = require("../runtime/core/plugin-assets.cjs");

const PLUGIN_SOURCE = fs.readFileSync(
  path.resolve(__dirname, "..", "..", "web-shell", "internal", "providers", "project-recent-sort.js"),
  "utf-8"
);
const FLAT_PREFERENCES_KEY = "flat-project-sidebar-preferences-v1";
const LEGACY_SORT_MODE_KEY = "codex-sidebar-sort-mode-v1";
const PROJECT_ORDER_KEY = "project-order";

function defaultBootstrap() {
  return {
    globalStateEntries: [
      { key: PROJECT_ORDER_KEY, value: ["gamehub", "current", "empty"] },
      {
        key: "local-projects",
        value: {
          gamehub: { id: "gamehub", rootPaths: ["/work/Gamehub"], createdAt: 10, updatedAt: 100 },
          current: { id: "current", rootPaths: ["/work/Current"], createdAt: 20, updatedAt: 200 },
          empty: { id: "empty", rootPaths: ["/work/Empty"], createdAt: 5, updatedAt: 50 },
        },
      },
      { key: "thread-project-assignments", value: {} },
    ],
    catalogSnapshot: {
      entries: [
        { threadId: "gamehub-old", cwd: "/work/Gamehub", createdAt: 1000, recencyAt: 1000 },
        { threadId: "current-new", cwd: "/work/Current", createdAt: 2000, recencyAt: 2000 },
      ],
    },
  };
}

function decodedProtocolValue(value) {
  if (typeof value !== "string") return value;
  const source = value.trim();
  if (!source.startsWith("{") && !source.startsWith("[")) return value;
  try {
    return JSON.parse(source);
  } catch {
    return value;
  }
}

function createHarness({
  flatPreferences = { projectSortMode: "updated_at" },
  legacySortMode,
  initialBootstrap = defaultBootstrap(),
} = {}) {
  const bridgeListeners = new Map();
  const forwardedMessages = [];
  const postedMessages = [];
  const dispatchedMessages = [];
  const microtasks = [];
  const protocolTransforms = new Map();
  const channels = { appHost: {}, gateway: {} };
  let registeredPlugin = null;

  const persistedAtomSnapshot = { [FLAT_PREFERENCES_KEY]: flatPreferences };
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

  const protocol = {
    channels,
    process({ channel, value, metadata = {} }) {
      let current = value;
      const entries = [...(protocolTransforms.get(channel)?.values() || [])]
        .sort((left, right) => left.order - right.order);
      for (const entry of entries) {
        const next = entry.callback({
          raw: current,
          metadata,
          value: decodedProtocolValue(current),
          decode() { return decodedProtocolValue(current); },
        });
        if (next !== undefined) current = next;
      }
      return current;
    },
    publish() {},
    transform({ key, channel, order = 0, callback }) {
      if (!protocolTransforms.has(channel)) protocolTransforms.set(channel, new Map());
      protocolTransforms.get(channel).set(key, { callback, order });
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        protocolTransforms.get(channel)?.delete(key);
      };
    },
  };

  const window = {
    __CODEX_WEB_CONFIG__: { initialSidebarBootstrap: initialBootstrap, persistedAtomSnapshot },
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
  window.__OpenCodexAdapterHost = {
    hooks: {
      around({ target, property, handle }) {
        const original = target[property];
        const wrapper = function (...args) {
          return handle(this, args, (nextArgs = args) => original.apply(this, nextArgs));
        };
        target[property] = wrapper;
        return () => {
          if (target[property] === wrapper) target[property] = original;
        };
      },
    },
    protocol,
  };
  window.window = window;

  vm.runInNewContext(PLUGIN_SOURCE, { console, window });
  const dispose = registeredPlugin.activate({ plugin: { isEnabled: () => true }, scope: "renderer" });
  window.electronBridge = bridge;

  function flushMicrotasks() {
    while (microtasks.length > 0) microtasks.shift()();
  }
  flushMicrotasks();

  return {
    bridge,
    dispatchedMessages,
    dispose,
    flushMicrotasks,
    forwardedMessages,
    initialBootstrap,
    plugin: registeredPlugin,
    postedMessages,
    processAppHost(value, direction) {
      return protocol.process({ channel: channels.appHost, value, metadata: { direction, transport: "app-host" } });
    },
    processGateway(channel, payload, direction) {
      const result = protocol.process({
        channel: channels.gateway,
        value: { channel, payload },
        metadata: { channel, direction, transport: "bridge" },
      });
      return result.payload;
    },
    protocolTransformerCount() {
      return [...protocolTransforms.values()].reduce((total, entries) => total + entries.size, 0);
    },
    window,
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

function fetchResponse(requestId, value) {
  return {
    type: "fetch-response",
    requestId,
    responseType: "success",
    status: 200,
    headers: { "content-type": "application/json" },
    bodyJsonString: JSON.stringify({ value }),
  };
}

function parsed(value) {
  return JSON.parse(JSON.stringify(value));
}

function emittedProjectOrder(harness, requestId) {
  const response = harness.postedMessages.find(
    (message) => message.type === "fetch-response" && message.requestId === requestId
  );
  assert.ok(response);
  return JSON.parse(response.bodyJsonString).value;
}

function announceThreadList(harness, requestId, threads) {
  harness.processGateway("mcp-request", {
    type: "mcp-request",
    hostId: "local",
    request: { id: requestId, method: "thread/list", params: {} },
  }, "client");
  harness.processGateway("mcp-response", {
    type: "mcp-response",
    hostId: "local",
    message: { id: requestId, result: { data: threads } },
  }, "server");
  harness.flushMicrotasks();
}

function announceNotification(harness, method, params) {
  harness.processGateway("mcp-notification", {
    type: "mcp-notification",
    hostId: "local",
    method,
    params,
  }, "server");
  harness.flushMicrotasks();
}

test("project recent sort plugin is discovered with localized copy", () => {
  const entry = listPluginEntries().find((plugin) => plugin.name === "project-recent-sort");
  const zh = pluginMessagesForLocale("zh-CN");
  const en = pluginMessagesForLocale("en-US");

  assert.ok(entry);
  assert.equal(entry.sourceId, "builtin");
  assert.equal(entry.urlPath, "");
  assert.equal(zh["plugin.projectRecentSort.label"], "项目最近更新排序");
  assert.equal(en["plugin.projectRecentSort.label"], "Sort projects by recent activity");
});

test("recent mode derives the full project order from each project's latest thread", async () => {
  const harness = createHarness();

  assert.deepEqual(
    parsed(harness.bridge.getInitialSidebarBootstrap()).globalStateEntries.find(
      (entry) => entry.key === PROJECT_ORDER_KEY
    ).value,
    ["current", "gamehub", "empty"]
  );

  announceNotification(harness, "thread/started", {
    thread: { id: "gamehub-new", cwd: "/work/Gamehub", createdAt: 3000, updatedAt: 3000, recencyAt: 3000 },
  });
  await harness.bridge.sendMessageFromView(projectOrderFetch("recent-request"));

  assert.deepEqual(emittedProjectOrder(harness, "recent-request"), ["gamehub", "current", "empty"]);
  assert.equal(harness.forwardedMessages.some((message) => message.requestId === "recent-request"), false);
  harness.dispose();
});

test("full virtual order drives both first-five projects and show-more projects", async () => {
  const projects = {};
  const projectOrder = [];
  const entries = [];
  for (let index = 1; index <= 6; index += 1) {
    const id = `project-${index}`;
    projectOrder.push(id);
    projects[id] = { id, rootPaths: [`/work/${id}`], createdAt: index, updatedAt: index };
    entries.push({ threadId: `thread-${index}`, cwd: `/work/${id}`, recencyAt: index * 100 });
  }
  const harness = createHarness({
    initialBootstrap: {
      globalStateEntries: [
        { key: PROJECT_ORDER_KEY, value: projectOrder },
        { key: "local-projects", value: projects },
      ],
      catalogSnapshot: { entries },
    },
  });
  announceThreadList(harness, "thread-list-project-1", [
    { id: "project-1-now", cwd: "/work/project-1", createdAt: 1000, recencyAt: 1000 },
  ]);

  await harness.bridge.sendMessageFromView(projectOrderFetch("all-projects"));
  const order = emittedProjectOrder(harness, "all-projects");
  assert.equal(order.length, 6);
  assert.equal(order[0], "project-1");
  assert.equal(order.slice(0, 5).includes("project-1"), true);
  assert.deepEqual([...order].sort(), [...projectOrder].sort());
  harness.dispose();
});

test("new AppHost protocol path transforms only the matching project-order response", () => {
  const harness = createHarness();
  announceThreadList(harness, "app-host-gamehub-list", [
    { id: "gamehub-app-host", cwd: "/work/Gamehub", createdAt: 4000, recencyAt: 4000 },
  ]);

  harness.processAppHost(JSON.stringify({ payload: projectOrderFetch("app-host-order") }), "client");
  const transformed = harness.processAppHost(
    JSON.stringify({ message: fetchResponse("app-host-order", ["empty", "gamehub", "current"]) }),
    "server"
  );
  const response = JSON.parse(transformed).message;
  assert.deepEqual(JSON.parse(response.bodyJsonString).value, ["gamehub", "current", "empty"]);

  const unrelated = fetchResponse("unrelated", ["saved"]);
  assert.equal(harness.processAppHost(JSON.stringify(unrelated), "server"), JSON.stringify(unrelated));
  harness.dispose();
});

test("explicit project assignment wins and cwd fallback selects the longest project root", async () => {
  const harness = createHarness({
    initialBootstrap: {
      globalStateEntries: [
        { key: PROJECT_ORDER_KEY, value: ["root", "nested", "assigned"] },
        {
          key: "local-projects",
          value: {
            root: { id: "root", rootPaths: ["/repo"], updatedAt: 10 },
            nested: { id: "nested", rootPaths: ["/repo/packages/game"], updatedAt: 20 },
            assigned: { id: "assigned", rootPaths: ["/elsewhere"], updatedAt: 30 },
          },
        },
        {
          key: "thread-project-assignments",
          value: { "assigned-thread": { projectKind: "local", projectId: "assigned" } },
        },
      ],
      catalogSnapshot: { entries: [] },
    },
  });
  announceThreadList(harness, "mapping-list", [
    { id: "nested-thread", cwd: "/repo/packages/game/src", recencyAt: 2000 },
    { id: "assigned-thread", cwd: "/repo", projectId: "assigned", recencyAt: 3000 },
  ]);
  await harness.bridge.sendMessageFromView(projectOrderFetch("mapping-order"));
  assert.deepEqual(emittedProjectOrder(harness, "mapping-order"), ["assigned", "nested", "root"]);
  harness.dispose();
});

test("projects without resolvable thread activity keep their official relative order", async () => {
  const harness = createHarness({
    initialBootstrap: {
      globalStateEntries: [
        { key: PROJECT_ORDER_KEY, value: ["unknown-b", "known", "unknown-a"] },
        {
          key: "local-projects",
          value: { known: { id: "known", rootPaths: ["/known"], updatedAt: 500 } },
        },
      ],
      catalogSnapshot: { entries: [] },
    },
  });
  await harness.bridge.sendMessageFromView(projectOrderFetch("stable-unknown-order"));
  assert.deepEqual(
    emittedProjectOrder(harness, "stable-unknown-order"),
    ["known", "unknown-b", "unknown-a"]
  );
  harness.dispose();
});

test("manual mode preserves saved order, pinned state, and official requests", async () => {
  const harness = createHarness({ flatPreferences: { projectSortMode: "manual" } });
  const bootstrap = parsed(harness.bridge.getInitialSidebarBootstrap());
  assert.deepEqual(
    bootstrap.globalStateEntries.find((entry) => entry.key === PROJECT_ORDER_KEY).value,
    ["gamehub", "current", "empty"]
  );

  const orderRequest = projectOrderFetch("manual-request");
  await harness.bridge.sendMessageFromView(orderRequest);
  assert.equal(harness.forwardedMessages.at(-1), orderRequest);

  const pinnedRequest = {
    ...projectOrderFetch("pinned-request"),
    body: JSON.stringify({ key: "pinned-project-ids" }),
  };
  const pinnedResponse = fetchResponse("pinned-request", ["gamehub"]);
  harness.processAppHost(JSON.stringify(pinnedRequest), "client");
  assert.equal(harness.processAppHost(JSON.stringify(pinnedResponse), "server"), JSON.stringify(pinnedResponse));
  harness.dispose();
});

test("legacy unified sort preference keeps official precedence and mode switches invalidate", async () => {
  const harness = createHarness({
    flatPreferences: { projectSortMode: "updated_at" },
    legacySortMode: "manual",
  });
  await harness.bridge.sendMessageFromView(projectOrderFetch("legacy-manual"));
  assert.equal(harness.forwardedMessages.some((message) => message.requestId === "legacy-manual"), true);

  const invalidationsBefore = harness.postedMessages.filter((message) => message.type === "global-state-updated").length;
  await harness.bridge.sendMessageFromView({
    type: "persisted-atom-update",
    key: LEGACY_SORT_MODE_KEY,
    deleted: true,
    value: null,
  });
  harness.flushMicrotasks();
  await harness.bridge.sendMessageFromView(projectOrderFetch("legacy-removed"));
  assert.equal(harness.forwardedMessages.some((message) => message.requestId === "legacy-removed"), false);

  await harness.bridge.sendMessageFromView({
    type: "persisted-atom-update",
    key: FLAT_PREFERENCES_KEY,
    value: { projectSortMode: "manual" },
  });
  assert.equal(
    harness.postedMessages.filter((message) => message.type === "global-state-updated").length >= invalidationsBefore + 2,
    true
  );
  harness.dispose();
});

test("disabling the plugin removes protocol transforms and restores official behavior", async () => {
  const harness = createHarness();
  assert.equal(harness.protocolTransformerCount(), 2);
  harness.dispose();
  assert.equal(harness.protocolTransformerCount(), 0);
  assert.equal(harness.bridge.getInitialSidebarBootstrap(), harness.initialBootstrap);

  const request = projectOrderFetch("after-dispose");
  await harness.bridge.sendMessageFromView(request);
  assert.equal(harness.forwardedMessages.at(-1), request);
  const response = fetchResponse("after-dispose", ["saved"]);
  assert.equal(harness.processAppHost(JSON.stringify(response), "server"), JSON.stringify(response));
});

test("project sort implementation no longer depends on static bundle globals", () => {
  assert.doesNotMatch(PLUGIN_SOURCE, /__OpenCodexProjectRecentSort(?:Active|Owner|Hit)/);
  const staticAssets = fs.readFileSync(
    path.resolve(__dirname, "..", "runtime", "http", "static-assets.cjs"),
    "utf-8"
  );
  assert.doesNotMatch(staticAssets, /patchProjectRecentSortAppHostQuery|PROJECT_RECENT_GROUP_ORDER/);
});
