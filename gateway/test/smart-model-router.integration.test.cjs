const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const test = require("node:test");
const { listPluginManifests } = require("../runtime/core/plugin-assets.cjs");
const { createSmartModelRouterService } = require("../runtime/model-router/service.cjs");
const { createAppServerTransport } = require("../runtime/model-router/transport.cjs");
const { createPluginConfigStore } = require("../runtime/plugins/config-store.cjs");

function fakeChild() {
  const child = new EventEmitter();
  const serverInput = new PassThrough();
  const serverOutput = new PassThrough();
  child.stdin = serverInput;
  child.stdout = serverOutput;
  child.stderr = new PassThrough();
  child.stdio = [serverInput, serverOutput, child.stderr];
  child.kill = () => true;
  return { child, serverInput, serverOutput };
}

function observeLines(stream, handler) {
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += chunk.toString("utf-8");
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (line) handler(JSON.parse(line));
    }
  });
}

function waitFor(predicate, timeoutMs = 3_000) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const poll = () => {
      const value = predicate();
      if (value) return resolve(value);
      if (Date.now() - startedAt >= timeoutMs) return reject(new Error("condition timed out"));
      setTimeout(poll, 5);
    };
    poll();
  });
}

function writeRequest(stream, message) {
  return new Promise((resolve, reject) => {
    stream.write(`${JSON.stringify(message)}\n`, (error) => (error ? reject(error) : resolve()));
  });
}

function model(id, effort, isDefault = false) {
  const efforts = Array.isArray(effort) ? effort : [effort];
  return {
    id,
    model: id,
    displayName: id,
    description: id,
    hidden: false,
    isDefault,
    defaultReasoningEffort: efforts[0],
    supportedReasoningEfforts: efforts.map((reasoningEffort) => ({ reasoningEffort, description: "" })),
    inputModalities: ["text"],
  };
}

function createDelayedClassifierTransport() {
  const observers = new Set();
  let completionPredicate = null;
  let resolveCompletion = null;
  let resolveReady = null;
  const ready = new Promise((resolve) => {
    resolveReady = resolve;
  });

  return {
    complete(text) {
      const message = {
        method: "turn/completed",
        params: {
          threadId: "delayed-classifier-thread",
          turn: {
            id: "delayed-classifier-turn",
            status: "completed",
            items: [{ type: "agentMessage", text }],
          },
        },
      };
      for (const observer of observers) observer(message);
      assert.equal(completionPredicate?.(message), true);
      resolveCompletion?.(message);
    },
    observeNotifications(listener) {
      observers.add(listener);
      return () => observers.delete(listener);
    },
    ready,
    registerInternalThread() {},
    async request(method) {
      if (method === "thread/start") {
        return { thread: { id: "delayed-classifier-thread", ephemeral: true } };
      }
      if (method === "turn/start") {
        return { turn: { id: "delayed-classifier-turn" } };
      }
      // 中断、退订和删除是分类器的异步清理步骤，此测试不需要额外模拟状态。
      return {};
    },
    unregisterInternalThread() {},
    waitForNotification(predicate) {
      completionPredicate = predicate;
      resolveReady();
      return new Promise((resolve) => {
        resolveCompletion = resolve;
      });
    },
  };
}

test("internal router terminal failures release turn ids and bound thread tombstones", async (t) => {
  const transport = createAppServerTransport();
  const fake = fakeChild();
  const internalRequests = [];
  observeLines(fake.serverInput, (message) => internalRequests.push(message));
  transport.decorateChild(fake.child);
  t.after(() => fake.child.emit("close"));

  const request = transport.request("turn/start", { threadId: "classifier-thread" });
  const sent = await waitFor(() => internalRequests.find((message) => message.method === "turn/start"));
  fake.serverOutput.write(
    `${JSON.stringify({ id: sent.id, result: { turn: { id: "classifier-turn-failed" } } })}\n`
  );
  await request;
  assert.deepEqual(Array.from(transport.internalTurnIds()), ["classifier-turn-failed"]);

  transport.unregisterInternalTurn("classifier-turn-failed");
  assert.equal(transport.internalTurnIds().size, 0);

  const secondRequest = transport.request("turn/start", { threadId: "classifier-thread" });
  const secondSent = await waitFor(
    () => internalRequests.filter((message) => message.method === "turn/start")[1]
  );
  fake.serverOutput.write(
    `${JSON.stringify({ id: secondSent.id, result: { turn: { id: "classifier-turn-terminal" } } })}\n`
  );
  await secondRequest;

  fake.serverOutput.write(
    `${JSON.stringify({
      method: "turn/failed",
      params: { threadId: "classifier-thread", turn: { id: "classifier-turn-terminal" } },
    })}\n`
  );
  await waitFor(() => transport.internalTurnIds().size === 0);

  for (let index = 0; index < 513; index += 1) {
    transport.registerInternalThread(`classifier-${index}`);
    transport.unregisterInternalThread(`classifier-${index}`);
  }
  assert.equal(transport.isInternalThreadId("classifier-0"), false);
  assert.equal(transport.isInternalThreadId("classifier-512"), true);
});

test("Auto turn is classified on the same App Server, rewritten, hidden and safely falls back", async (t) => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodex-router-integration-"));
  t.after(() => fs.rmSync(runtimeDir, { force: true, recursive: true }));
  const configStore = createPluginConfigStore({
    filePath: path.join(runtimeDir, "plugins.json"),
    manifests: listPluginManifests(),
  });
  configStore.update("opencodex.smart-model-router", {
    expectedRevision: 0,
    enabled: true,
  });
  const injectionPoints = [];
  const service = createSmartModelRouterService({
    configStore,
    stateFilePath: path.join(runtimeDir, "router-state.json"),
    classifierOptions: { timeoutMs: 1_000 },
    injectionHealth: { reportGateway: (point) => injectionPoints.push(point) },
  });
  const fake = fakeChild();
  service.decorateAppServerChild(fake.child);
  assert.equal(injectionPoints.includes("app-server-router"), true);
  t.after(() => {
    service.dispose();
    fake.child.emit("close");
  });

  const publicMessages = [];
  const serverMessages = [];
  const forwardedTurns = [];
  let classifierThread = 0;
  let classifierText = JSON.stringify({
    route: {
      tier: "balanced",
      rationale: "ordinary implementation",
    },
  });
  const models = [
    model("gpt-5.3-codex-spark", "low", true),
    model("gpt-5.6-luna", ["medium", "high"]),
    model("gpt-5.6-terra", "high"),
    model("gpt-5.6-sol", "xhigh"),
  ];

  observeLines(fake.child.stdout, (message) => publicMessages.push(message));
  observeLines(fake.serverInput, (message) => {
    serverMessages.push(message);
    const internal = typeof message.id === "string" && message.id.startsWith("opencodex.router:");
    if (message.method === "model/list") {
      fake.serverOutput.write(`${JSON.stringify({ id: message.id, result: { data: models, nextCursor: null } })}\n`);
      return;
    }
    if (internal && message.method === "thread/turns/list") {
      const data = String(message.params?.threadId || "").startsWith("classifier-")
        ? [{ status: "completed", items: [{ type: "agentMessage", text: classifierText }] }]
        : [];
      fake.serverOutput.write(
        `${JSON.stringify({ id: message.id, result: { data, nextCursor: null, backwardsCursor: null } })}\n`
      );
      return;
    }
    if (internal && message.method === "thread/start") {
      classifierThread += 1;
      fake.serverOutput.write(
        `${JSON.stringify({ id: message.id, result: { thread: { id: `classifier-${classifierThread}`, ephemeral: true } } })}\n`
      );
      return;
    }
    if (internal && message.method === "turn/start") {
      const threadId = message.params.threadId;
      const turnId = `classifier-turn-${classifierThread}`;
      const response = JSON.stringify({ id: message.id, result: { turn: { id: turnId } } });
      const itemNotification = JSON.stringify({
        method: "item/completed",
        params: {
          threadId,
          turnId,
          item: { type: "agentMessage", text: classifierText },
        },
      });
      const notification = JSON.stringify({
        method: "turn/completed",
        params: {
          threadId,
          turn: {
            id: turnId,
            status: "completed",
            // 模拟真实 App Server 的 summary 通知，分类器需在清理前补读 full items。
            items: [],
          },
        },
      });
      // 响应与通知在同一数据块到达，覆盖 promise microtask 前后的竞态。
      fake.serverOutput.write(`${response}\n${itemNotification}\n${notification}\n`);
      return;
    }
    if (internal) {
      fake.serverOutput.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
      return;
    }
    if (message.method === "turn/start") {
      forwardedTurns.push(message);
      const turnId = `public-${message.id}`;
      fake.serverOutput.write(
        `${JSON.stringify({ id: message.id, result: { turn: { id: turnId, status: "inProgress" } } })}\n${JSON.stringify({
          method: "turn/started",
          params: { threadId: message.params.threadId, turn: { id: turnId, status: "inProgress" } },
        })}\n`
      );
      return;
    }
    fake.serverOutput.write(
      `${JSON.stringify({ id: message.id, result: message.method === "thread/settings/update" ? { model: message.params.model } : { ok: true } })}\n`
    );
  });

  await writeRequest(fake.child.stdin, { id: "models", method: "model/list", params: { cursor: null } });
  const modelResponse = await waitFor(() => publicMessages.find((message) => message.id === "models"));
  assert.equal(modelResponse.result.data[0].model, "auto");
  assert.equal(injectionPoints.includes("auto-model-catalog"), true);

  await writeRequest(fake.child.stdin, {
    id: "select-auto",
    method: "thread/settings/update",
    params: { threadId: "user-thread", model: "auto", effort: "medium" },
  });
  await waitFor(() => publicMessages.find((message) => message.id === "select-auto"));
  const rawSettings = serverMessages.find((message) => message.id === "select-auto");
  assert.equal(rawSettings.params.model, "gpt-5.3-codex-spark");
  assert.equal(JSON.stringify(rawSettings).includes('"auto"'), false);
  // Auto 刚开启且尚未分类时，摘要先沿用当前具体模型；分类完成后会更新为最近结果。
  assert.deepEqual(service.activeRoute("user-thread"), {
    threadId: "user-thread",
    turnId: "",
    tier: "",
    model: "gpt-5.3-codex-spark",
    effort: "low",
    fallback: false,
    displayName: "gpt-5.3-codex-spark",
  });

  await writeRequest(fake.child.stdin, {
    id: "user-turn-1",
    method: "turn/start",
    params: {
      threadId: "user-thread",
      model: "auto",
      effort: "medium",
      input: [{ type: "text", text: "Implement the requested feature", text_elements: [] }],
    },
  });
  const firstTurn = await waitFor(() => forwardedTurns.find((message) => message.id === "user-turn-1"));
  assert.equal(firstTurn.params.model, "gpt-5.6-luna");
  assert.equal(firstTurn.params.effort, "high");
  assert.equal(JSON.stringify(firstTurn).includes('"auto"'), false);
  await waitFor(() => publicMessages.find((message) => message.id === "user-turn-1"));
  const firstStarted = await waitFor(() =>
    publicMessages.find(
      (message) => message.method === "turn/started" && message.params?.turn?.id === "public-user-turn-1"
    )
  );
  assert.deepEqual(firstStarted.params._meta["opencodex/smart-scheduling"], {
    tier: "balanced",
    model: "gpt-5.6-luna",
    effort: "high",
    fallback: false,
  });
  assert.equal(service.activeRoute("user-thread").turnId, "public-user-turn-1");
  configStore.update("opencodex.smart-model-router", {
    expectedRevision: 1,
    values: { showRouteInSummary: false },
  });
  assert.equal(service.activeRoute("user-thread"), null);
  configStore.update("opencodex.smart-model-router", {
    expectedRevision: 2,
    values: { showRouteInSummary: true },
  });
  assert.equal(service.activeRoute("user-thread").turnId, "public-user-turn-1");
  fake.serverOutput.write(
    `${JSON.stringify({
      method: "turn/completed",
      params: { threadId: "user-thread", turn: { id: "public-user-turn-1", status: "completed" } },
    })}\n`
  );
  const firstIdleRoute = await waitFor(() => {
    const route = service.activeRoute("user-thread");
    return route?.turnId === "" ? route : null;
  });
  assert.equal(firstIdleRoute.model, "gpt-5.6-luna");
  assert.equal(firstIdleRoute.effort, "high");

  classifierText = JSON.stringify({
    route: {
      // 当前只有经济档位使用自动推理强度，缺失 effort 应触发失败回退。
      tier: "economy",
      rationale: "missing automatic effort",
    },
  });
  await writeRequest(fake.child.stdin, {
    id: "user-turn-missing-effort",
    method: "turn/start",
    params: {
      threadId: "user-thread",
      model: "auto",
      effort: "medium",
      input: [{ type: "text", text: "Continue without an effort result", text_elements: [] }],
    },
  });
  const missingEffortTurn = await waitFor(() =>
    forwardedTurns.find((message) => message.id === "user-turn-missing-effort")
  );
  assert.equal(missingEffortTurn.params.model, "gpt-5.3-codex-spark");
  assert.equal(missingEffortTurn.params.effort, "low");
  fake.serverOutput.write(
    `${JSON.stringify({
      method: "turn/completed",
      params: {
        threadId: "user-thread",
        turn: { id: "public-user-turn-missing-effort", status: "completed" },
      },
    })}\n`
  );

  classifierText = "invalid-json";
  await writeRequest(fake.child.stdin, {
    id: "user-turn-2",
    method: "turn/start",
    params: {
      threadId: "user-thread",
      model: "auto",
      effort: "medium",
      input: [{ type: "text", text: "Continue", text_elements: [] }],
    },
  });
  const fallbackTurn = await waitFor(() => forwardedTurns.find((message) => message.id === "user-turn-2"));
  assert.equal(fallbackTurn.params.model, "gpt-5.3-codex-spark");
  assert.equal(fallbackTurn.params.effort, "low");
  await waitFor(() => publicMessages.find((message) => message.id === "user-turn-2"));
  fake.serverOutput.write(
    `${JSON.stringify({
      method: "turn/interrupted",
      params: { threadId: "user-thread", turn: { id: "public-user-turn-2", status: "interrupted" } },
    })}\n`
  );
  const interruptedIdleRoute = await waitFor(() => {
    const route = service.activeRoute("user-thread");
    return route?.turnId === "" ? route : null;
  });
  assert.equal(interruptedIdleRoute.model, "gpt-5.3-codex-spark");
  assert.equal(interruptedIdleRoute.effort, "low");

  await writeRequest(fake.child.stdin, {
    id: "select-manual",
    method: "thread/settings/update",
    params: { threadId: "user-thread", model: "gpt-5.6-terra", effort: "high" },
  });
  await waitFor(() => publicMessages.find((message) => message.id === "select-manual"));
  assert.equal(service.activeRoute("user-thread"), null);

  const classifierCountBeforeDisabledTurn = classifierThread;
  configStore.update("opencodex.smart-model-router", {
    expectedRevision: 3,
    tiers: configStore
      .plugin("opencodex.smart-model-router")
      .tiers.map((tier) => ({ ...tier, enabled: false })),
  });
  await writeRequest(fake.child.stdin, {
    id: "select-auto-without-tiers",
    method: "thread/settings/update",
    params: { threadId: "user-thread", model: "auto", effort: "medium" },
  });
  await waitFor(() => publicMessages.find((message) => message.id === "select-auto-without-tiers"));
  await writeRequest(fake.child.stdin, {
    id: "user-turn-without-tiers",
    method: "turn/start",
    params: {
      threadId: "user-thread",
      model: "auto",
      effort: "medium",
      input: [{ type: "text", text: "Use fallback because every tier is disabled", text_elements: [] }],
    },
  });
  const disabledTierTurn = await waitFor(() =>
    forwardedTurns.find((message) => message.id === "user-turn-without-tiers")
  );
  assert.equal(disabledTierTurn.params.model, "gpt-5.3-codex-spark");
  assert.equal(disabledTierTurn.params.effort, "low");
  assert.equal(classifierThread, classifierCountBeforeDisabledTurn);

  assert.equal(publicMessages.some((message) => String(message.id || "").startsWith("opencodex.router:")), false);
  assert.equal(publicMessages.some((message) => String(message.params?.threadId || "").startsWith("classifier-")), false);
  assert.equal(
    serverMessages
      .filter((message) => String(message.id || "").startsWith("opencodex.router:") && message.method === "thread/start")
      .every(
        (message) =>
          message.params.ephemeral === true &&
          message.params.approvalPolicy === "never" &&
          message.params.sandbox === "read-only" &&
          Array.isArray(message.params.dynamicTools) &&
          message.params.dynamicTools.length === 0
      ),
    true
  );
});

test("pending Auto classification blocks only requests from the same thread", async (t) => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodex-router-cross-thread-"));
  t.after(() => fs.rmSync(runtimeDir, { force: true, recursive: true }));
  const configStore = createPluginConfigStore({
    filePath: path.join(runtimeDir, "plugins.json"),
    manifests: listPluginManifests(),
  });
  configStore.update("opencodex.smart-model-router", {
    expectedRevision: 0,
    enabled: true,
  });
  const service = createSmartModelRouterService({
    configStore,
    stateFilePath: path.join(runtimeDir, "router-state.json"),
    classifierOptions: { timeoutMs: 1_000 },
  });
  service.modelCatalog.addModels([
    model("gpt-5.3-codex-spark", "low", true),
    model("gpt-5.6-luna", ["medium", "high"]),
    model("gpt-5.6-terra", "high"),
    model("gpt-5.6-sol", "xhigh"),
  ]);
  service.stateStore.setThreadAuto("thread-a", true, {
    model: "gpt-5.3-codex-spark",
    effort: "low",
  });

  const fake = fakeChild();
  service.decorateAppServerChild(fake.child);
  t.after(() => {
    service.dispose();
    fake.child.emit("close");
  });
  const publicMessages = [];
  const serverMessages = [];
  let classifierThreadId = "";
  let classifierTurnId = "";
  let resolveClassifierReady;
  const classifierReady = new Promise((resolve) => {
    resolveClassifierReady = resolve;
  });
  observeLines(fake.child.stdout, (message) => publicMessages.push(message));
  observeLines(fake.serverInput, (message) => {
    serverMessages.push(message);
    const internal = typeof message.id === "string" && message.id.startsWith("opencodex.router:");
    if (internal && message.method === "thread/turns/list") {
      fake.serverOutput.write(
        `${JSON.stringify({ id: message.id, result: { data: [], nextCursor: null, backwardsCursor: null } })}\n`
      );
      return;
    }
    if (internal && message.method === "thread/start") {
      classifierThreadId = "classifier-cross-thread";
      fake.serverOutput.write(
        `${JSON.stringify({ id: message.id, result: { thread: { id: classifierThreadId, ephemeral: true } } })}\n`
      );
      return;
    }
    if (internal && message.method === "turn/start") {
      classifierTurnId = "classifier-cross-thread-turn";
      fake.serverOutput.write(`${JSON.stringify({ id: message.id, result: { turn: { id: classifierTurnId } } })}\n`);
      resolveClassifierReady();
      return;
    }
    if (internal) {
      fake.serverOutput.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
      return;
    }
    if (message.method === "thread/list") {
      // 即使 App Server 返回正在运行的 ephemeral 分类任务，公共响应也必须把它过滤掉。
      fake.serverOutput.write(
        `${JSON.stringify({
          id: message.id,
          result: {
            data: [
              { id: classifierThreadId, ephemeral: true },
              { id: "thread-b", ephemeral: false },
            ],
            nextCursor: null,
            backwardsCursor: null,
          },
        })}\n`
      );
      return;
    }
    fake.serverOutput.write(`${JSON.stringify({ id: message.id, result: { ok: true } })}\n`);
  });

  await writeRequest(fake.child.stdin, {
    id: "turn-a",
    method: "turn/start",
    params: {
      threadId: "thread-a",
      model: "auto",
      effort: "medium",
      input: [{ type: "text", text: "Classify this slowly", text_elements: [] }],
    },
  });
  await classifierReady;
  await Promise.all([
    writeRequest(fake.child.stdin, {
      id: "read-b",
      method: "thread/read",
      params: { threadId: "thread-b", includeTurns: false },
    }),
    writeRequest(fake.child.stdin, {
      id: "list",
      method: "thread/list",
      params: { cursor: null },
    }),
    writeRequest(fake.child.stdin, {
      id: "interrupt-a",
      method: "turn/interrupt",
      params: { threadId: "thread-a", turnId: "turn-a" },
    }),
  ]);

  await waitFor(() => serverMessages.some((message) => message.id === "read-b"));
  const listResponse = await waitFor(() => publicMessages.find((message) => message.id === "list"));
  assert.deepEqual(listResponse.result.data.map((thread) => thread.id), ["thread-b"]);
  assert.equal(serverMessages.some((message) => message.id === "turn-a"), false);
  assert.equal(serverMessages.some((message) => message.id === "interrupt-a"), false);

  const classifierText = JSON.stringify({
    route: {
      tier: "balanced",
      rationale: "integration ordering check",
    },
  });
  fake.serverOutput.write(
    `${JSON.stringify({
      method: "item/completed",
      params: {
        threadId: classifierThreadId,
        turnId: classifierTurnId,
        item: { type: "agentMessage", text: classifierText },
      },
    })}\n${JSON.stringify({
      method: "turn/completed",
      params: {
        threadId: classifierThreadId,
        turn: { id: classifierTurnId, status: "completed", items: [] },
      },
    })}\n`
  );
  await waitFor(() => serverMessages.some((message) => message.id === "interrupt-a"));
  assert.deepEqual(
    serverMessages
      .filter((message) => ["read-b", "list", "turn-a", "interrupt-a"].includes(message.id))
      .map((message) => message.id),
    ["read-b", "list", "turn-a", "interrupt-a"]
  );
});

test("manual selection suppresses delayed route status after classification already started", async (t) => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodex-router-race-"));
  t.after(() => fs.rmSync(runtimeDir, { force: true, recursive: true }));
  const configStore = createPluginConfigStore({
    filePath: path.join(runtimeDir, "plugins.json"),
    manifests: listPluginManifests(),
  });
  configStore.update("opencodex.smart-model-router", {
    expectedRevision: 0,
    enabled: true,
  });
  const classifierTransport = createDelayedClassifierTransport();
  const service = createSmartModelRouterService({
    configStore,
    stateFilePath: path.join(runtimeDir, "router-state.json"),
    classifierOptions: { timeoutMs: 1_000, transport: classifierTransport },
  });
  t.after(() => service.dispose());
  service.modelCatalog.addModels([
    model("gpt-5.3-codex-spark", "low", true),
    model("gpt-5.6-luna", ["medium", "high"]),
    model("gpt-5.6-terra", "high"),
    model("gpt-5.6-sol", "xhigh"),
  ]);
  service.stateStore.setThreadAuto("race-thread", true, {
    model: "gpt-5.3-codex-spark",
    effort: "low",
  });

  const routeStatuses = [];
  service.onRouteStatus((event) => routeStatuses.push(event));
  const routedTurnPromise = service.processClientMessage({
    id: "race-turn",
    method: "turn/start",
    params: {
      threadId: "race-thread",
      model: "auto",
      effort: "medium",
      input: [{ type: "text", text: "Implement the race fix", text_elements: [] }],
    },
  });
  await classifierTransport.ready;
  assert.equal(routeStatuses.at(-1)?.status, "classifying");

  // 分类尚未返回时切到手动模型，核心状态应立即清除展示资格。
  await service.processClientMessage({
    id: "race-manual",
    method: "thread/settings/update",
    params: {
      threadId: "race-thread",
      model: "gpt-5.6-terra",
      effort: "high",
    },
  });
  assert.equal(service.stateStore.isThreadAuto("race-thread"), false);
  assert.equal(routeStatuses.at(-1)?.status, "cleared");

  classifierTransport.complete(
    JSON.stringify({
      route: {
        tier: "balanced",
        rationale: "delayed result",
      },
    })
  );
  const routedTurn = await routedTurnPromise;
  assert.equal(routedTurn.params.model, "gpt-5.6-luna");
  assert.equal(routedTurn.params.effort, "high");
  assert.equal(service.activeRoute("race-thread"), null);
  assert.equal(routeStatuses.some((event) => event.status === "selected"), false);
  assert.equal(routeStatuses.at(-1)?.status, "cleared");

  service.processServerMessage({
    id: "race-turn",
    result: { turn: { id: "public-race-turn", status: "inProgress" } },
  });
  service.processServerMessage({
    method: "turn/started",
    params: {
      threadId: "race-thread",
      turn: { id: "public-race-turn", status: "inProgress" },
    },
  });
  assert.equal(routeStatuses.some((event) => event.status === "started"), false);
  assert.equal(routeStatuses.at(-1)?.status, "cleared");
});

test("classification history count controls hydration, caching, invalidation and retry", async (t) => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodex-router-history-"));
  t.after(() => fs.rmSync(runtimeDir, { force: true, recursive: true }));
  const configStore = createPluginConfigStore({
    filePath: path.join(runtimeDir, "plugins.json"),
    manifests: listPluginManifests(),
  });
  const service = createSmartModelRouterService({
    configStore,
    stateFilePath: path.join(runtimeDir, "router-state.json"),
    classifierOptions: { timeoutMs: 1_000 },
  });
  service.modelCatalog.addModels([
    model("gpt-5.3-codex-spark", "low", true),
    model("gpt-5.6-luna", ["low", "max"]),
    model("gpt-5.6-sol", ["max", "ultra"]),
  ]);
  const fake = fakeChild();
  service.decorateAppServerChild(fake.child);
  t.after(() => {
    service.dispose();
    fake.child.emit("close");
  });

  const userTurn = (text) => ({
    status: "completed",
    items: [
      { type: "userMessage", content: [{ type: "text", text }] },
      { type: "agentMessage", phase: "commentary", text: `working-${text}` },
      { type: "agentMessage", phase: "final_answer", text: `done-${text}` },
    ],
  });
  const serverHistory = new Map([
    ["history-thread", [5, 4, 3, 2, 1].map((index) => userTurn(`history-${index}`))],
    ["manual-thread", [2, 1].map((index) => userTurn(`manual-history-${index}`))],
    ["retry-thread", [userTurn("retry-history-1")]],
    ["external-thread", [4, 3, 2, 1].map((index) => userTurn(`external-history-${index}`))],
    ["incomplete-thread", [userTurn("incomplete-history-1")]],
    ["live-stale-thread", [userTurn("live-stale-history-1")]],
  ]);
  const historyRequests = [];
  const classifierContexts = [];
  let classifierSequence = 0;
  let retryReadCount = 0;

  observeLines(fake.serverInput, (message) => {
    const internal = typeof message.id === "string" && message.id.startsWith("opencodex.router:");
    if (!internal) return;
    if (message.method === "thread/turns/list") {
      const threadId = String(message.params?.threadId || "");
      historyRequests.push({ threadId, limit: message.params?.limit });
      if (threadId === "retry-thread" && retryReadCount++ === 0) {
        fake.serverOutput.write(`${JSON.stringify({ id: message.id, error: { message: "history unavailable" } })}\n`);
        return;
      }
      const data = (serverHistory.get(threadId) || []).slice(0, Number(message.params?.limit || 0));
      fake.serverOutput.write(`${JSON.stringify({ id: message.id, result: { data, nextCursor: null } })}\n`);
      return;
    }
    if (message.method === "thread/start") {
      classifierSequence += 1;
      fake.serverOutput.write(
        `${JSON.stringify({ id: message.id, result: { thread: { id: `history-classifier-${classifierSequence}`, ephemeral: true } } })}\n`
      );
      return;
    }
    if (message.method === "turn/start") {
      const prompt = String(message.params?.input?.[0]?.text || "");
      classifierContexts.push(JSON.parse(prompt.split("\n\n").at(-1)));
      const turnId = `history-classifier-turn-${classifierSequence}`;
      const classification = JSON.stringify({
        route: {
          tier: "economy",
          effort: "low",
          rationale: "history test",
        },
      });
      fake.serverOutput.write(
        `${JSON.stringify({ id: message.id, result: { turn: { id: turnId } } })}\n${JSON.stringify({
          method: "turn/completed",
          params: {
            threadId: message.params.threadId,
            turn: {
              id: turnId,
              status: "completed",
              items: [{ type: "agentMessage", text: classification }],
            },
          },
        })}\n`
      );
      return;
    }
    fake.serverOutput.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
  });

  const startTurn = (threadId, id, text, modelId = "auto") =>
    service.processClientMessage({
      id,
      method: "turn/start",
      params: {
        threadId,
        model: modelId,
        effort: "low",
        input: [{ type: "text", text, text_elements: [] }],
      },
    });

  const completeUserTurn = (threadId, turnId, finalText = "") => {
    service.processServerMessage({
      method: "turn/started",
      params: { threadId, turn: { id: turnId, status: "inProgress" } },
    });
    service.processServerMessage({
      method: "item/completed",
      params: {
        threadId,
        turnId,
        item: { type: "agentMessage", phase: "commentary", text: "intermediate progress" },
      },
    });
    if (finalText) {
      service.processServerMessage({
        method: "item/completed",
        params: {
          threadId,
          turnId,
          item: { type: "agentMessage", phase: "final_answer", text: finalText },
        },
      });
    }
    // completion 通知可能只有摘要；缓存应使用先前 item/completed 确认的最终回答。
    service.processServerMessage({
      method: "turn/completed",
      params: { threadId, turn: { id: turnId, status: "completed", items: [] } },
    });
  };

  await startTurn("history-thread", "history-turn-1", "current-1");
  completeUserTurn("history-thread", "real-history-turn-1", "completed-current-1");
  await startTurn("history-thread", "history-turn-2", "current-2");
  assert.deepEqual(
    historyRequests.filter((request) => request.threadId === "history-thread"),
    [{ threadId: "history-thread", limit: 3 }]
  );
  assert.deepEqual(classifierContexts[0].recentTurns.map((entry) => entry.user.text), [
    "history-3",
    "history-4",
    "history-5",
  ]);
  // 第二轮命中缓存，并使用第一轮追加后的最近三个历史回合。
  assert.deepEqual(classifierContexts[1].recentTurns.map((entry) => entry.user.text), [
    "history-4",
    "history-5",
    "current-1",
  ]);
  assert.equal(classifierContexts[1].recentTurns.at(-1).assistantFinal, "completed-current-1");
  assert.equal(JSON.stringify(classifierContexts[1]).includes("intermediate progress"), false);
  assert.equal(classifierContexts[1].current.text, "current-2");

  configStore.update("opencodex.smart-model-router", {
    expectedRevision: 0,
    values: { classifierHistoryCount: "5" },
  });
  await startTurn("history-thread", "history-turn-3", "current-3");
  assert.deepEqual(
    historyRequests.filter((request) => request.threadId === "history-thread"),
    [
      { threadId: "history-thread", limit: 3 },
      { threadId: "history-thread", limit: 5 },
    ]
  );
  assert.deepEqual(classifierContexts[2].recentTurns.map((entry) => entry.user.text), [
    "history-1",
    "history-2",
    "history-3",
    "history-4",
    "history-5",
  ]);

  await startTurn("manual-thread", "manual-turn", "manual-current", "gpt-5.3-codex-spark");
  await startTurn("manual-thread", "manual-auto-turn", "manual-auto-current");
  assert.deepEqual(
    historyRequests.filter((request) => request.threadId === "manual-thread"),
    [{ threadId: "manual-thread", limit: 5 }]
  );
  assert.deepEqual(classifierContexts[3].recentTurns.map((entry) => entry.user.text), [
    "manual-history-1",
    "manual-history-2",
  ]);

  await startTurn("retry-thread", "retry-turn-1", "retry-current-1");
  await startTurn("retry-thread", "retry-turn-2", "retry-current-2");
  assert.deepEqual(
    historyRequests.filter((request) => request.threadId === "retry-thread"),
    [
      { threadId: "retry-thread", limit: 5 },
      { threadId: "retry-thread", limit: 5 },
    ]
  );
  assert.deepEqual(classifierContexts[4].recentTurns, []);
  assert.deepEqual(classifierContexts[5].recentTurns.map((entry) => entry.user.text), ["retry-history-1"]);

  await service.processClientMessage({
    id: "stale-external-history",
    method: "thread/turns/list",
    params: {
      threadId: "external-thread",
      cursor: null,
      limit: 5,
      sortDirection: "desc",
      itemsView: "full",
    },
  });
  configStore.update("opencodex.smart-model-router", {
    expectedRevision: 1,
    values: { classifierHistoryCount: "4" },
  });
  // 配置切换前发起的页面历史响应不能在清理后重新填充旧代次缓存。
  service.processServerMessage({
    id: "stale-external-history",
    result: { data: serverHistory.get("external-thread"), nextCursor: null },
  });
  await startTurn("external-thread", "external-auto-turn", "external-current");
  assert.deepEqual(
    historyRequests.filter((request) => request.threadId === "external-thread"),
    [{ threadId: "external-thread", limit: 4 }]
  );
  assert.deepEqual(classifierContexts[6].recentTurns.map((entry) => entry.user.text), [
    "external-history-1",
    "external-history-2",
    "external-history-3",
    "external-history-4",
  ]);

  await startTurn("incomplete-thread", "incomplete-turn-1", "incomplete-current-1");
  completeUserTurn("incomplete-thread", "real-incomplete-turn-1");
  await startTurn("incomplete-thread", "incomplete-turn-2", "incomplete-current-2");
  assert.deepEqual(
    historyRequests.filter((request) => request.threadId === "incomplete-thread"),
    [
      { threadId: "incomplete-thread", limit: 4 },
      { threadId: "incomplete-thread", limit: 4 },
    ]
  );
  assert.deepEqual(classifierContexts[8].recentTurns.map((entry) => entry.user.text), ["incomplete-history-1"]);

  await service.processClientMessage({
    id: "live-stale-history",
    method: "thread/turns/list",
    params: {
      threadId: "live-stale-thread",
      cursor: null,
      limit: 4,
      sortDirection: "desc",
      itemsView: "full",
    },
  });
  await startTurn("live-stale-thread", "live-stale-manual", "live-stale-current", "gpt-5.3-codex-spark");
  // 请求发出后又开始了新回合，这个旧快照不能覆盖本地正在跟踪的回合缓存。
  service.processServerMessage({
    id: "live-stale-history",
    result: { data: serverHistory.get("live-stale-thread"), nextCursor: null },
  });
  completeUserTurn("live-stale-thread", "real-live-stale-turn", "completed-live-stale-current");
  await startTurn("live-stale-thread", "live-stale-auto", "live-stale-auto-current");
  assert.deepEqual(
    historyRequests.filter((request) => request.threadId === "live-stale-thread"),
    [{ threadId: "live-stale-thread", limit: 4 }]
  );
  assert.deepEqual(classifierContexts[9].recentTurns.map((entry) => entry.user.text), ["live-stale-history-1"]);
});
