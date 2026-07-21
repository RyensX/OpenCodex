const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createModelCatalog } = require("../runtime/model-router/catalog.cjs");
const { createAutoStateStore } = require("../runtime/model-router/state-store.cjs");
const { createVirtualModelController } = require("../runtime/model-router/virtual-model.cjs");

function setup(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodex-virtual-model-test-"));
  t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
  const filePath = path.join(dir, "state.json");
  const stateStore = createAutoStateStore({ filePath });
  const catalog = createModelCatalog();
  let enabled = false;
  const controller = createVirtualModelController({
    stateStore,
    catalog,
    isEnabled: () => enabled,
    fallbackRoute: () => ({ model: "spark", effort: "low", tier: "economy" }),
    onAutoModelInjected: options.onAutoModelInjected,
  });
  return { catalog, controller, filePath, setEnabled: (value) => (enabled = value), stateStore };
}

function realModel(id = "spark") {
  return { id, model: id, displayName: id, supportedReasoningEfforts: [], defaultReasoningEffort: "low", hidden: false };
}

test("Auto is injected once on the first model page only while enabled", (t) => {
  let injectionCount = 0;
  const value = setup(t, { onAutoModelInjected: () => (injectionCount += 1) });
  value.controller.prepareClientMessage({ id: 1, method: "model/list", params: { cursor: null } });
  let response = value.controller.processServerMessage({ id: 1, result: { data: [realModel()], nextCursor: "next" } });
  assert.deepEqual(response.result.data.map((model) => model.model), ["spark"]);
  assert.equal(injectionCount, 0);

  value.setEnabled(true);
  value.controller.prepareClientMessage({ id: 2, method: "model/list", params: { cursor: null } });
  response = value.controller.processServerMessage({ id: 2, result: { data: [realModel()], nextCursor: "next" } });
  assert.deepEqual(response.result.data.map((model) => model.model), ["auto", "spark"]);
  assert.deepEqual(response.result.data[0].supportedReasoningEfforts, []);
  assert.equal(injectionCount, 1);

  value.controller.prepareClientMessage({ id: 3, method: "model/list", params: { cursor: "next" } });
  response = value.controller.processServerMessage({ id: 3, result: { data: [realModel("other")], nextCursor: null } });
  assert.deepEqual(response.result.data.map((model) => model.model), ["other"]);
  assert.equal(injectionCount, 1);
});

test("config and thread protocol virtualize Auto without sending it to App Server", (t) => {
  const value = setup(t);
  value.setEnabled(true);
  const batch = value.controller.prepareClientMessage({
    id: "config-write",
    method: "config/batchWrite",
    params: {
      edits: [
        { keyPath: "model", value: "auto", mergeStrategy: "replace" },
        { keyPath: "model_reasoning_effort", value: "medium", mergeStrategy: "replace" },
      ],
    },
  }).message;
  assert.equal(JSON.stringify(batch).includes('"auto"'), false);
  assert.equal(value.stateStore.isDefaultAuto(), true);

  value.controller.prepareClientMessage({ id: "read", method: "config/read", params: {} });
  const read = value.controller.processServerMessage({
    id: "read",
    result: { config: { model: "spark", model_reasoning_effort: "low" }, origins: {}, layers: null },
  });
  assert.equal(read.result.config.model, "auto");
  assert.equal(read.result.config.model_reasoning_effort, "medium");

  const start = value.controller.prepareClientMessage({
    id: "start",
    method: "thread/start",
    params: { model: "spark" },
  }).message;
  assert.equal(start.params.model, "spark");
  assert.equal(start.params.config.model, "spark");
  const started = value.controller.processServerMessage({
    id: "start",
    result: { thread: { id: "thread-1" }, model: "spark", reasoningEffort: "low" },
  });
  assert.equal(value.stateStore.isThreadAuto("thread-1"), true);
  assert.equal(started.result.model, "auto");

  const settings = value.controller.prepareClientMessage({
    id: "settings",
    method: "thread/settings/update",
    params: { threadId: "thread-1", model: "terra", effort: "high" },
  }).message;
  assert.equal(settings.params.model, "terra");
  assert.equal(value.stateStore.isThreadAuto("thread-1"), false);
});

test("first Auto selection preserves config model and does not capture background ephemeral threads", (t) => {
  const value = setup(t);
  value.setEnabled(true);

  value.controller.prepareClientMessage({ id: "initial-read", method: "config/read", params: {} });
  value.controller.processServerMessage({
    id: "initial-read",
    result: { config: { model: "terra", model_reasoning_effort: "high" }, origins: {}, layers: null },
  });
  const selected = value.controller.prepareClientMessage({
    id: "select-auto",
    method: "config/batchWrite",
    params: {
      edits: [
        { keyPath: "model", value: "auto" },
        { keyPath: "model_reasoning_effort", value: "medium" },
      ],
    },
  }).message;
  assert.equal(selected.params.edits[0].value, "terra");
  assert.equal(selected.params.edits[1].value, "high");

  const ephemeral = value.controller.prepareClientMessage({
    id: "background-thread",
    method: "thread/start",
    params: { ephemeral: true, model: "auto", config: { model: "auto", model_reasoning_effort: "medium" } },
  }).message;
  value.controller.processServerMessage({
    id: "background-thread",
    result: { thread: { id: "title-thread", ephemeral: true }, model: "terra", reasoningEffort: "low" },
  });
  assert.equal(ephemeral.params.model, "terra");
  assert.equal(JSON.stringify(ephemeral).includes('"auto"'), false);
  assert.equal(value.stateStore.isThreadAuto("title-thread"), false);
  assert.equal(value.stateStore.threadState("title-thread"), null);
});

test("Auto thread state restores after restart and clears without losing its real model", (t) => {
  const value = setup(t);
  value.stateStore.setThreadAuto("thread-1", true, { model: "terra", effort: "high" });
  const restored = createAutoStateStore({ filePath: value.filePath });
  assert.equal(restored.isThreadAuto("thread-1"), true);
  restored.clearAllAuto();
  assert.equal(restored.isThreadAuto("thread-1"), false);
  assert.equal(restored.threadState("thread-1").lastModel, "terra");
});

test("thread settings notifications keep nested model fields virtual", (t) => {
  const value = setup(t);
  value.setEnabled(true);
  value.stateStore.setThreadAuto("thread-1", true, { model: "spark", effort: "low" });
  const notification = value.controller.processServerMessage({
    method: "thread/settings/updated",
    params: {
      threadId: "thread-1",
      threadSettings: { model: "spark", effort: "low", modelProvider: "openai" },
    },
  });
  assert.equal(notification.params.threadSettings.model, "auto");
  assert.equal(notification.params.threadSettings.effort, "medium");
});
