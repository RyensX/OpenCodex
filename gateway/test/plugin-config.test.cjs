const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { listPluginEntries, listPluginManifests } = require("../runtime/core/plugin-assets.cjs");
const { handleOpenCodexPluginApi, pluginIdFromPath } = require("../runtime/http/plugin-config.cjs");
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
  assert.equal(plugin.enabled, false);
  assert.equal(plugin.values.classifierModel, "gpt-5.3-codex-spark");
  assert.equal(plugin.values.classifierEffort, "low");
  assert.equal(plugin.values.showRouteInSummary, true);
  assert.equal(
    ["economy", "balanced", "complex", "frontier", "fallback"].every(
      (tier) => plugin.values[`${tier}Effort`] === "auto"
    ),
    true
  );

  const updated = store.update(plugin.id, {
    expectedRevision: 0,
    enabled: true,
    values: { balancedModel: "custom-balanced", balancedEffort: "auto" },
  });
  assert.equal(updated.revision, 1);
  assert.equal(store.plugin(plugin.id).values.balancedModel, "custom-balanced");
  assert.equal(store.plugin(plugin.id).values.balancedEffort, "auto");
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
  assert.throws(
    () => store.update(plugin.id, { expectedRevision: 1, values: { balancedEffort: "adaptive" } }),
    /unsupported effort/
  );
});

test("legacy smart scheduling defaults migrate to Auto without replacing custom efforts", (t) => {
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
  const values = store.plugin("opencodex.smart-model-router").values;

  // 分类器保持 low，旧默认档位迁移为 Auto，用户显式选择的 max 不变。
  assert.equal(values.classifierEffort, "low");
  assert.equal(values.economyEffort, "auto");
  assert.equal(values.balancedEffort, "auto");
  assert.equal(values.complexEffort, "max");
  assert.equal(values.frontierEffort, "auto");
  assert.equal(values.fallbackEffort, "auto");

  store.update("opencodex.smart-model-router", { expectedRevision: 4, enabled: true });
  assert.equal(JSON.parse(fs.readFileSync(filePath, "utf-8")).schemaVersion, 2);
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

function patchRequest(body) {
  const request = new EventEmitter();
  request.method = "PATCH";
  process.nextTick(() => {
    request.emit("data", Buffer.from(JSON.stringify(body)));
    request.emit("end");
  });
  return request;
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
