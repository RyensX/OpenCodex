const assert = require("node:assert/strict");
const test = require("node:test");
const {
  ClassificationError,
  classifierTurnFailureCategory,
  createClassifier,
} = require("../runtime/model-router/classifier.cjs");

function classifierTransport(
  agentText,
  { inlineItems = true, streamItem = false, failFullRead = false, turnStatus = "completed", turnError = null } = {}
) {
  const calls = [];
  const observers = new Set();
  return {
    calls,
    observeNotifications(observer) {
      observers.add(observer);
      return () => observers.delete(observer);
    },
    registerInternalThread() {},
    unregisterInternalThread() {},
    async request(method, params) {
      calls.push({ method, params });
      if (method === "thread/start") return { thread: { id: "classifier-thread" } };
      if (method === "turn/start") {
        if (streamItem) {
          for (const observer of observers) {
            observer({
              method: "item/completed",
              params: {
                threadId: "classifier-thread",
                turnId: "classifier-turn",
                item: { type: "agentMessage", text: agentText },
              },
            });
          }
        }
        return { turn: { id: "classifier-turn" } };
      }
      if (method === "thread/turns/list") {
        if (failFullRead) throw new Error("ephemeral history is unavailable");
        return {
          data: [{ status: "completed", items: [{ type: "agentMessage", text: agentText }] }],
          nextCursor: null,
        };
      }
      return {};
    },
    async waitForNotification() {
      return {
        method: "turn/completed",
        params: {
          threadId: "classifier-thread",
          turn: {
            status: turnStatus,
            error: turnError,
            items: inlineItems ? [{ type: "agentMessage", text: agentText }] : [],
          },
        },
      };
    },
  };
}

test("classifier creates one ephemeral read-only thread with no dynamic tools", async () => {
  const transport = classifierTransport(
    JSON.stringify({
      tier: "balanced",
      confidence: 0.9,
      taskType: "code_generation",
      rationale: "normal change",
    })
  );
  const classifier = createClassifier({ transport, timeoutMs: 500 });
  const result = await classifier.classify({ context: { current: {}, recentUserInputs: [] }, model: "spark", effort: "low" });
  assert.equal(result.classification.tier, "balanced");
  assert.equal("effort" in result.classification, false);
  const start = transport.calls.find((call) => call.method === "thread/start");
  assert.equal(start.params.ephemeral, true);
  assert.equal(start.params.approvalPolicy, "never");
  assert.equal(start.params.sandbox, "read-only");
  assert.deepEqual(start.params.dynamicTools, []);
  const turn = transport.calls.find((call) => call.method === "turn/start");
  assert.equal("effort" in turn.params.outputSchema.properties, false);
  assert.match(turn.params.input[0].text, /Do not return an effort field/);
});

test("classifier requests effort only when a configured tier uses Auto", async () => {
  const transport = classifierTransport(
    JSON.stringify({
      route: {
        tier: "balanced",
        effort: "high",
        confidence: 0.9,
        taskType: "code_generation",
        rationale: "normal change",
      },
    })
  );
  const classifier = createClassifier({ transport, timeoutMs: 500 });
  const result = await classifier.classify({
    context: { current: {}, recentUserInputs: [] },
    model: "spark",
    effort: "low",
    automaticEffortTiers: ["balanced"],
  });
  assert.equal(result.classification.effort, "high");
  const turn = transport.calls.find((call) => call.method === "turn/start");
  assert.equal(turn.params.outputSchema.type, "object");
  assert.equal("anyOf" in turn.params.outputSchema, false);
  assert.deepEqual(turn.params.outputSchema.required, ["route"]);
  const variants = turn.params.outputSchema.properties.route.anyOf;
  const effortVariants = variants.filter((variant) => variant.properties.effort);
  const fixedVariants = variants.filter((variant) => !variant.properties.effort);
  assert.equal(effortVariants.length > 0, true);
  assert.equal(fixedVariants.length > 0, true);
  assert.equal(effortVariants.every((variant) => variant.required.includes("effort")), true);
  assert.equal(fixedVariants.every((variant) => !variant.required.includes("effort")), true);
  assert.equal(effortVariants[0].properties.effort.enum.includes("ultra"), true);
  assert.match(turn.params.input[0].text, /Auto-effort tiers: balanced/);
  assert.match(turn.params.input[0].text, /"route" field/);
});

test("classifier exposes a safe structured-output failure category", async () => {
  const turnError = {
    message: JSON.stringify({ error: { code: "invalid_json_schema", message: "schema rejected" }, status: 400 }),
    codexErrorInfo: "other",
  };
  assert.equal(classifierTurnFailureCategory({ error: turnError }), "invalid_json_schema");
  const classifier = createClassifier({
    transport: classifierTransport("", { turnStatus: "failed", turnError }),
    timeoutMs: 500,
  });
  await assert.rejects(
    classifier.classify({ context: { current: {}, recentUserInputs: [] }, model: "spark", effort: "low" }),
    (error) => error instanceof ClassificationError && error.category === "invalid_json_schema"
  );
});

test("classifier rejects malformed structured output", async () => {
  const classifier = createClassifier({ transport: classifierTransport("not-json"), timeoutMs: 500 });
  await assert.rejects(
    classifier.classify({ context: { current: {}, recentUserInputs: [] }, model: "spark", effort: "low" }),
    (error) => error instanceof ClassificationError && error.category === "invalid_json"
  );
});

test("classifier reloads the full last turn when completion only contains a summary", async () => {
  const transport = classifierTransport(
    JSON.stringify({ tier: "economy", effort: "low", confidence: 0.98, taskType: "question", rationale: "short answer" }),
    { inlineItems: false }
  );
  const classifier = createClassifier({ transport, timeoutMs: 500 });
  const result = await classifier.classify({ context: { current: {}, recentUserInputs: [] }, model: "spark", effort: "low" });
  assert.equal(result.classification.tier, "economy");
  const fullRead = transport.calls.find((call) => call.method === "thread/turns/list");
  assert.deepEqual(fullRead.params, {
    threadId: "classifier-thread",
    cursor: null,
    limit: 1,
    sortDirection: "desc",
    itemsView: "full",
  });
});

test("classifier consumes the completed agent item when ephemeral history is unavailable", async () => {
  const transport = classifierTransport(
    JSON.stringify({ tier: "complex", effort: "high", confidence: 0.92, taskType: "debugging", rationale: "deep failure" }),
    { inlineItems: false, streamItem: true, failFullRead: true }
  );
  const classifier = createClassifier({ transport, timeoutMs: 500 });
  const result = await classifier.classify({ context: { current: {}, recentUserInputs: [] }, model: "spark", effort: "low" });
  assert.equal(result.classification.tier, "complex");
  assert.equal(transport.calls.some((call) => call.method === "thread/turns/list"), false);
});

test("classifier transport timeout is normalized to the timeout error category", async () => {
  const transport = classifierTransport("unused");
  transport.request = async () => {
    const error = new Error("timed out");
    error.category = "timeout";
    throw error;
  };
  const classifier = createClassifier({ transport, timeoutMs: 50 });
  await assert.rejects(
    classifier.classify({ context: { current: {}, recentUserInputs: [] }, model: "spark", effort: "low" }),
    (error) => error instanceof ClassificationError && error.category === "timeout"
  );
});
