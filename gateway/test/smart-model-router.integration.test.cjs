const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const test = require("node:test");
const { listPluginManifests } = require("../runtime/core/plugin-assets.cjs");
const { createSmartModelRouterService } = require("../runtime/model-router/service.cjs");
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
    values: { balancedEffort: "auto" },
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
      effort: "high",
      confidence: 0.9,
      taskType: "code_generation",
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
      tier: "balanced",
      confidence: 0.9,
      taskType: "code_generation",
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
