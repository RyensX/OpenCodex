const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { listPluginEntries, listPluginManifests } = require("../runtime/core/plugin-assets.cjs");
const { handleOpenCodexPluginApi, pluginIdFromPath } = require("../runtime/http/plugin-config.cjs");
const {
  BROWSER_INJECTION_POINTS,
  GLOBAL_INJECTION_POINTS,
  createInjectionHealthRegistry,
} = require("../runtime/model-router/injection-health.cjs");
const { PluginConfigError, createPluginConfigStore } = require("../runtime/plugins/config-store.cjs");
const { normalizePluginManifest } = require("../runtime/plugins/manifest.cjs");

function tempFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodex-plugin-config-test-"));
  t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
  return path.join(dir, "plugins.json");
}

test("manifest-only smart router is discovered without an executable entry", () => {
  const entry = listPluginEntries().find((value) => value.name === "smart-model-router");
  assert.ok(entry);
  assert.equal(entry.entryFile, null);
  assert.equal(entry.manifest.feature, "smart-model-router");
  assert.equal(entry.manifest.persistence, "gateway");
  assert.equal(listPluginManifests().some((manifest) => manifest.id === "opencodex.smart-model-router"), true);
});

test("external manifests cannot bind a registered core feature", () => {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const manifest = normalizePluginManifest(
      { sourceId: "external-1" },
      {
        id: "opencodex.smart-model-router",
        feature: "smart-model-router",
        persistence: "gateway",
        settings: [],
      }
    );
    assert.equal(manifest.feature, "");
    assert.equal(manifest.persistence, "browser");
  } finally {
    console.warn = originalWarn;
  }
});

test("gateway plugin config validates types, writes atomically and detects revision conflicts", (t) => {
  const filePath = tempFile(t);
  const store = createPluginConfigStore({ filePath, manifests: listPluginManifests() });
  const initial = store.snapshot();
  const plugin = initial.plugins.find((value) => value.id === "opencodex.smart-model-router");
  assert.equal(initial.revision, 0);
  assert.equal(plugin.enabled, true);
  assert.equal(plugin.values.classifierModel, "gpt-5.3-codex-spark");
  assert.equal(plugin.values.classifierEffort, "low");
  assert.equal(plugin.values.showRouteInSummary, true);
  assert.deepEqual(plugin.tiers.map((tier) => tier.id), ["economy", "balanced", "complex", "frontier"]);
  assert.equal(plugin.tiers.every((tier) => tier.builtin && tier.enabled), true);
  assert.deepEqual(plugin.tiers.map((tier) => tier.effort), ["auto", "max", "max", "ultra"]);
  assert.equal(plugin.values.fallbackEffort, "auto");

  const updated = store.update(plugin.id, {
    expectedRevision: 0,
    enabled: true,
  });
  assert.equal(updated.revision, 1);
  assert.equal(store.plugin(plugin.id).tiers.find((tier) => tier.id === "balanced").model, "gpt-5.6-luna");
  assert.equal(store.plugin(plugin.id).tiers.find((tier) => tier.id === "balanced").effort, "max");
  assert.equal(fs.existsSync(filePath), true);
  assert.equal(fs.readdirSync(path.dirname(filePath)).some((name) => name.endsWith(".tmp")), false);

  assert.throws(
    () => store.update(plugin.id, { expectedRevision: 0, enabled: false }),
    (error) => error instanceof PluginConfigError && error.status === 409
  );
  assert.throws(
    () => store.update(plugin.id, { expectedRevision: 1, values: { fallbackModel: "auto" } }),
    /cannot target Auto/
  );
  const customizedBuiltins = store.plugin(plugin.id).tiers.map((tier) =>
    tier.id === "balanced" ? { ...tier, model: "custom-balanced", effort: "high" } : tier
  );
  const customized = store.update(plugin.id, { expectedRevision: 1, tiers: customizedBuiltins });
  assert.equal(customized.revision, 2);
  assert.equal(store.plugin(plugin.id).tiers.find((tier) => tier.id === "balanced").model, "custom-balanced");
  assert.equal(store.plugin(plugin.id).tiers.find((tier) => tier.id === "balanced").effort, "high");
});

test("smart scheduling history count defaults to three and validates select bounds", (t) => {
  const filePath = tempFile(t);
  const manifests = listPluginManifests();
  const store = createPluginConfigStore({ filePath, manifests });
  const pluginId = "opencodex.smart-model-router";
  assert.equal(store.plugin(pluginId).values.classifierHistoryCount, "3");

  const minimum = store.update(pluginId, {
    expectedRevision: 0,
    values: { classifierHistoryCount: "1" },
  });
  assert.equal(minimum.revision, 1);
  assert.equal(store.plugin(pluginId).values.classifierHistoryCount, "1");

  const maximum = store.update(pluginId, {
    expectedRevision: 1,
    values: { classifierHistoryCount: "20" },
  });
  assert.equal(maximum.revision, 2);
  assert.equal(store.plugin(pluginId).values.classifierHistoryCount, "20");
  for (const invalidValue of ["0", "21", "invalid"]) {
    assert.throws(
      () =>
        store.update(pluginId, {
          expectedRevision: 2,
          values: { classifierHistoryCount: invalidValue },
        }),
      /unsupported value/
    );
  }
  assert.equal(createPluginConfigStore({ filePath, manifests }).plugin(pluginId).values.classifierHistoryCount, "20");

  const legacyFilePath = tempFile(t);
  // 旧版持久化文档没有该字段时，由 manifest 默认值补齐，不需要提升配置 schema。
  fs.writeFileSync(
    legacyFilePath,
    JSON.stringify({
      schemaVersion: 3,
      revision: 4,
      plugins: {
        [pluginId]: {
          enabled: true,
          values: { classifierModel: "gpt-5.3-codex-spark" },
        },
      },
    })
  );
  const legacyStore = createPluginConfigStore({ filePath: legacyFilePath, manifests });
  assert.equal(legacyStore.snapshot().revision, 4);
  assert.equal(legacyStore.plugin(pluginId).values.classifierHistoryCount, "3");
});

test("smart scheduling tiers support custom CRUD while protecting built-in structure", (t) => {
  const store = createPluginConfigStore({ filePath: tempFile(t), manifests: listPluginManifests() });
  const pluginId = "opencodex.smart-model-router";
  const initial = store.plugin(pluginId);
  const custom = {
    id: "routine-plus",
    enabled: true,
    name: "Routine plus",
    prompt: "Use for bounded implementation across a few files.",
    model: "gpt-5.6-luna",
    effort: "high",
  };
  const withCustom = [initial.tiers[0], custom, ...initial.tiers.slice(1)];
  store.update(pluginId, { expectedRevision: 0, tiers: withCustom });
  assert.deepEqual(store.plugin(pluginId).tiers.map((tier) => tier.id), [
    "economy",
    "routine-plus",
    "balanced",
    "complex",
    "frontier",
  ]);
  assert.equal(store.plugin(pluginId).tiers.find((tier) => tier.id === "routine-plus").builtin, false);

  assert.throws(
    () =>
      store.update(pluginId, {
        expectedRevision: 1,
        tiers: store.plugin(pluginId).tiers.filter((tier) => tier.id !== "economy"),
      }),
    /cannot be deleted/
  );
  for (const [field, value] of [["name", "Renamed"], ["prompt", "Different criteria"]]) {
    assert.throws(
      () =>
        store.update(pluginId, {
          expectedRevision: 1,
          tiers: store
            .plugin(pluginId)
            .tiers.map((tier) => (tier.id === "balanced" ? { ...tier, [field]: value } : tier)),
        }),
      new RegExp(`${field} cannot be modified`)
    );
  }
  assert.throws(
    () =>
      store.update(pluginId, {
        expectedRevision: 1,
        tiers: store
          .plugin(pluginId)
          .tiers.map((tier) => (tier.id === "balanced" ? { ...tier, model: "auto" } : tier)),
      }),
    /cannot target Auto/
  );
  assert.throws(
    () =>
      store.update(pluginId, {
        expectedRevision: 1,
        tiers: store
          .plugin(pluginId)
          .tiers.map((tier) => (tier.id === "balanced" ? { ...tier, effort: "adaptive" } : tier)),
      }),
    /effort is unsupported/
  );
  const reorderedBuiltins = [...store.plugin(pluginId).tiers];
  [reorderedBuiltins[0], reorderedBuiltins[2]] = [reorderedBuiltins[2], reorderedBuiltins[0]];
  assert.throws(
    () => store.update(pluginId, { expectedRevision: 1, tiers: reorderedBuiltins }),
    /Built-in tier order cannot be changed/
  );
  assert.throws(
    () =>
      store.update(pluginId, {
        expectedRevision: 1,
        tiers: store
          .plugin(pluginId)
          .tiers.map((tier) => (tier.id === "routine-plus" ? { ...tier, model: "auto" } : tier)),
      }),
    /cannot target Auto/
  );

  const withoutCustom = store.plugin(pluginId).tiers.filter((tier) => tier.id !== "routine-plus");
  store.update(pluginId, { expectedRevision: 1, tiers: withoutCustom });
  assert.equal(store.plugin(pluginId).tiers.some((tier) => tier.id === "routine-plus"), false);
  store.update(pluginId, {
    expectedRevision: 2,
    tiers: store.plugin(pluginId).tiers.map((tier) => ({ ...tier, enabled: false })),
  });
  assert.equal(store.plugin(pluginId).tiers.some((tier) => tier.enabled), false);
});

test("legacy smart scheduling settings migrate to editable built-in route fields", (t) => {
  const filePath = tempFile(t);
  fs.writeFileSync(
    filePath,
    JSON.stringify({
      schemaVersion: 1,
      revision: 4,
      plugins: {
        "opencodex.smart-model-router": {
          enabled: true,
          values: {
            classifierEffort: "low",
            economyModel: "legacy-economy",
            balancedModel: "legacy-balanced",
            complexModel: "legacy-complex",
            frontierModel: "legacy-frontier",
            economyEffort: "low",
            balancedEffort: "medium",
            complexEffort: "max",
            frontierEffort: "xhigh",
            fallbackEffort: "low",
          },
        },
      },
    })
  );
  const store = createPluginConfigStore({ filePath, manifests: listPluginManifests() });
  const plugin = store.plugin("opencodex.smart-model-router");
  const values = plugin.values;
  const tiers = Object.fromEntries(plugin.tiers.map((tier) => [tier.id, tier]));

  // 分类器保持 low；旧版自定义路由字段迁入内置档位，旧默认强度和失败回退仍迁移到 Auto。
  assert.equal(values.classifierEffort, "low");
  assert.equal(tiers.economy.model, "legacy-economy");
  assert.equal(tiers.balanced.model, "legacy-balanced");
  assert.equal(tiers.complex.model, "legacy-complex");
  assert.equal(tiers.frontier.model, "legacy-frontier");
  assert.equal(tiers.economy.effort, "auto");
  assert.equal(tiers.balanced.effort, "auto");
  assert.equal(tiers.complex.effort, "max");
  assert.equal(tiers.frontier.effort, "auto");
  assert.equal(values.fallbackEffort, "auto");
  assert.equal("economyEffort" in values, false);

  store.update("opencodex.smart-model-router", { expectedRevision: 4, enabled: true });
  assert.equal(JSON.parse(fs.readFileSync(filePath, "utf-8")).schemaVersion, 3);
});

test("browser plugin descriptors preserve typed default values", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "..", "..", "web-shell", "opencodex-plugin-system.js"), "utf-8");
  const storage = new Map();
  const window = {
    localStorage: {
      getItem(key) {
        return storage.get(key) || null;
      },
      setItem(key, value) {
        storage.set(key, value);
      },
    },
  };
  window.window = window;
  vm.runInNewContext(source, { window, localStorage: window.localStorage, console });
  window.OpenCodexPluginSystem.registerPlugin({
    id: "typed",
    settings: [
      { id: "name", type: "string", defaultValue: "spark" },
      { id: "effort", type: "reasoning-effort", defaultValue: "low" },
      { id: "mode", type: "select", defaultValue: "b", options: ["a", "b"] },
    ],
  });
  assert.equal(window.OpenCodexPluginSystem.preferences.get("name"), "spark");
  assert.equal(window.OpenCodexPluginSystem.preferences.get("effort"), "low");
  assert.equal(window.OpenCodexPluginSystem.preferences.get("mode"), "b");
});

test("gateway plugin switch keeps anonymous intent pending and syncs it after authentication", async () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, "..", "..", "web-shell", "opencodex-gateway-plugin-switches.js"),
    "utf-8"
  );
  const storage = new Map();
  const window = {};
  let localEnabled = false;
  let remoteEnabled = true;
  let revision = 7;
  const plugin = { id: "opencodex.smart-model-router", persistence: "gateway" };
  const pluginSystem = {
    plugins: {
      isEnabled: () => localEnabled,
      setEnabled: (_id, enabled) => {
        localEnabled = enabled;
      },
    },
  };
  const snapshot = () => ({ revision, plugins: [{ ...plugin, enabled: remoteEnabled }] });
  const request = async (requestPath, options = {}) => {
    if (!options.method) return snapshot();
    assert.match(requestPath, /opencodex\.smart-model-router\/config$/);
    const body = JSON.parse(options.body);
    assert.equal(body.expectedRevision, revision);
    remoteEnabled = body.enabled;
    revision += 1;
    return snapshot();
  };
  const localStorage = {
    getItem(key) {
      return storage.get(key) || null;
    },
    setItem(key, value) {
      storage.set(key, value);
    },
  };
  window.window = window;
  vm.runInNewContext(source, { window, localStorage, console, encodeURIComponent });
  const controller = window.OpenCodexGatewayPluginSwitches.create({
    pluginSystem,
    plugins: () => [plugin],
    request,
  });

  // 没有匿名页待提交操作时只拉取服务端状态，避免本地默认值覆盖全局配置。
  await controller.sync();
  assert.equal(localEnabled, true);
  assert.equal(revision, 7);

  // 用户在匿名页关闭后，认证完成才把这次显式意图提交给网关，并清掉 pending 标记。
  localEnabled = false;
  controller.markPending(plugin.id, false);
  await controller.sync();
  assert.equal(remoteEnabled, false);
  assert.equal(revision, 8);
  assert.deepEqual(JSON.parse(storage.get(window.OpenCodexGatewayPluginSwitches.PENDING_STORAGE_KEY)), {});
});

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

function jsonRequest(method, body) {
  const request = new EventEmitter();
  request.method = method;
  process.nextTick(() => {
    request.emit("data", Buffer.from(JSON.stringify(body)));
    request.emit("end");
  });
  return request;
}

function patchRequest(body) {
  return jsonRequest("PATCH", body);
}

test("plugin HTTP API exposes revisioned config and reports conflicts", async (t) => {
  const store = createPluginConfigStore({ filePath: tempFile(t), manifests: listPluginManifests() });
  const pluginService = {
    configStore: store,
    modelRouter: {
      activeRoute: (threadId) =>
        threadId === "thread-running" ? { threadId, turnId: "turn-1", model: "spark", effort: "low" } : null,
      diagnostics: () => ({ enabled: false }),
      listModels: async () => [{ id: "spark", model: "spark" }],
    },
  };
  const pluginId = "opencodex.smart-model-router";
  assert.equal(pluginIdFromPath(`/api/opencodex/plugins/${pluginId}/config`), pluginId);

  const updatedResponse = responseRecorder();
  assert.equal(
    await handleOpenCodexPluginApi(
      patchRequest({ expectedRevision: 0, enabled: true }),
      updatedResponse,
      new URL(`http://localhost/api/opencodex/plugins/${pluginId}/config`),
      pluginService
    ),
    true
  );
  assert.equal(updatedResponse.status, 200);
  assert.equal(JSON.parse(updatedResponse.body).revision, 1);

  const conflictResponse = responseRecorder();
  await handleOpenCodexPluginApi(
    patchRequest({ expectedRevision: 0, enabled: false }),
    conflictResponse,
    new URL(`http://localhost/api/opencodex/plugins/${pluginId}/config`),
    pluginService
  );
  const conflict = JSON.parse(conflictResponse.body);
  assert.equal(conflictResponse.status, 409);
  assert.equal(conflict.errorKey, "plugin_config_revision_conflict");
  assert.equal(conflict.current.revision, 1);

  const activeRouteResponse = responseRecorder();
  const activeRouteRequest = new EventEmitter();
  activeRouteRequest.method = "GET";
  assert.equal(
    await handleOpenCodexPluginApi(
      activeRouteRequest,
      activeRouteResponse,
      new URL("http://localhost/api/opencodex/model-router/active-route?threadId=thread-running"),
      pluginService
    ),
    true
  );
  assert.equal(activeRouteResponse.status, 200);
  assert.equal(JSON.parse(activeRouteResponse.body).route.turnId, "turn-1");
});

test("plugin HTTP API records browser injection receipts without allowing gateway spoofing", async (t) => {
  const store = createPluginConfigStore({ filePath: tempFile(t), manifests: listPluginManifests() });
  store.update("opencodex.smart-model-router", { expectedRevision: 0, enabled: true });
  const injectionHealth = createInjectionHealthRegistry({
    getRuntimeIdentity: () => ({ version: "26.7", build: "52143" }),
  });
  for (const point of GLOBAL_INJECTION_POINTS) injectionHealth.reportGateway(point);
  const pluginService = {
    configStore: store,
    injectionHealth,
    modelRouter: { isEnabled: () => true },
  };
  const clientId = "browser_page_123";
  const endpoint = new URL("http://localhost/api/opencodex/model-router/injections");

  for (const point of BROWSER_INJECTION_POINTS) {
    const response = responseRecorder();
    await handleOpenCodexPluginApi(jsonRequest("POST", { point, clientId }), response, endpoint, pluginService);
    assert.equal(response.status, 200);
  }

  const getRequest = new EventEmitter();
  getRequest.method = "GET";
  const getResponse = responseRecorder();
  await handleOpenCodexPluginApi(
    getRequest,
    getResponse,
    new URL(`${endpoint.href}?clientId=${clientId}`),
    pluginService
  );
  assert.equal(getResponse.status, 200);
  assert.equal(JSON.parse(getResponse.body).health.status, "ok");

  const spoofedResponse = responseRecorder();
  await handleOpenCodexPluginApi(
    jsonRequest("POST", { point: "app-server-router", clientId }),
    spoofedResponse,
    endpoint,
    pluginService
  );
  assert.equal(spoofedResponse.status, 400);
});
