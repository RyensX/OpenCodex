const assert = require("node:assert/strict");
const test = require("node:test");
const {
  ClassificationError,
  classifierTurnFailureCategory,
  classifierOutputSchema,
  createClassifier,
} = require("../runtime/model-router/classifier.cjs");
const { defaultTierDefinitions } = require("../runtime/model-router/tiers.cjs");

function classifierTransport(
  agentText,
  {
    inlineItems = true,
    streamItem = false,
    failFullRead = false,
    turnStatus = "completed",
    turnError = null,
    messagePhase = "final_answer",
  } = {}
) {
  const calls = [];
  const observers = new Set();
  const agentItem = () => ({
    type: "agentMessage",
    text: agentText,
    ...(messagePhase === undefined ? {} : { phase: messagePhase }),
  });
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
                item: agentItem(),
              },
            });
          }
        }
        return { turn: { id: "classifier-turn" } };
      }
      if (method === "thread/turns/list") {
        if (failFullRead) throw new Error("ephemeral history is unavailable");
        return {
          data: [{ status: "completed", items: [agentItem()] }],
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
            items: inlineItems ? [agentItem()] : [],
          },
        },
      };
    },
  };
}

test("classifier creates one ephemeral read-only thread with no dynamic tools", async () => {
  const transport = classifierTransport(
    JSON.stringify({
      route: {
        tier: "balanced",
        rationale: "normal change",
      },
    })
  );
  const classifier = createClassifier({ transport, timeoutMs: 500 });
  const result = await classifier.classify({ context: { current: {}, recentTurns: [] }, model: "spark", effort: "low" });
  assert.equal(result.classification.tier, "balanced");
  assert.equal("effort" in result.classification, false);
  const start = transport.calls.find((call) => call.method === "thread/start");
  assert.equal(start.params.ephemeral, true);
  assert.equal(start.params.approvalPolicy, "never");
  assert.equal(start.params.sandbox, "read-only");
  assert.deepEqual(start.params.dynamicTools, []);
  const turn = transport.calls.find((call) => call.method === "turn/start");
  assert.deepEqual(turn.params.outputSchema.required, ["route"]);
  assert.equal(turn.params.outputSchema.properties.route.anyOf.every((variant) => !variant.properties.effort), true);
  assert.match(turn.params.input[0].text, /"automaticEffortTiers":\[\]/);
});

test("classifier requests effort only when a configured tier uses Auto", async () => {
  const transport = classifierTransport(
    JSON.stringify({
      route: {
        tier: "balanced",
        effort: "high",
        rationale: "normal change",
      },
    })
  );
  const classifier = createClassifier({ transport, timeoutMs: 500 });
  const result = await classifier.classify({
    context: { current: {}, recentTurns: [] },
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
  assert.equal(variants.length, 4);
  assert.match(turn.params.input[0].text, /"automaticEffortTiers":\["balanced"\]/);
});

test("classifier schema and prompt use enabled custom tiers", async () => {
  const tiers = defaultTierDefinitions();
  tiers[0].enabled = false;
  tiers.splice(1, 0, {
    id: "routine-plus",
    builtin: false,
    enabled: true,
    name: "Routine plus",
    prompt: "Use for bounded changes spanning a few files.",
    model: "custom",
    effort: "auto",
  });
  const transport = classifierTransport(
    JSON.stringify({
      route: {
        tier: "routine-plus",
        effort: "high",
        rationale: "bounded implementation",
      },
    })
  );
  const classifier = createClassifier({ transport, timeoutMs: 500 });
  const result = await classifier.classify({
    context: { current: {}, recentTurns: [] },
    model: "spark",
    effort: "low",
    tiers,
    automaticEffortTiers: ["routine-plus"],
  });
  assert.equal(result.classification.tier, "routine-plus");
  const turn = transport.calls.find((call) => call.method === "turn/start");
  const tierEnums = turn.params.outputSchema.properties.route.anyOf.flatMap(
    (variant) => variant.properties.tier.enum
  );
  assert.equal(tierEnums.includes("routine-plus"), true);
  assert.equal(tierEnums.includes("economy"), false);
  assert.match(turn.params.input[0].text, /bounded changes spanning a few files/);
});

test("classifier schema supports a custom-only tier set and updates with its effort mode", () => {
  const tiers = defaultTierDefinitions().map((tier) => ({ ...tier, enabled: false }));
  tiers.splice(2, 0, {
    id: "solo-custom",
    builtin: false,
    enabled: true,
    name: "Solo custom",
    prompt: "Use for the only enabled routing boundary.",
    model: "custom",
    effort: "auto",
  });

  const automaticSchema = classifierOutputSchema(["solo-custom"], tiers);
  const automaticVariants = automaticSchema.properties.route.anyOf;
  assert.equal(automaticVariants.length, 1);
  assert.deepEqual(automaticVariants[0].properties.tier.enum, ["solo-custom"]);
  assert.deepEqual(automaticVariants[0].required, ["tier", "effort", "rationale"]);

  tiers.find((tier) => tier.id === "solo-custom").effort = "high";
  const fixedSchema = classifierOutputSchema([], tiers);
  assert.equal(fixedSchema.properties.route.anyOf.length, 1);
  assert.deepEqual(fixedSchema.properties.route.anyOf[0].required, ["tier", "rationale"]);
  assert.equal("effort" in fixedSchema.properties.route.anyOf[0].properties, false);
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
    classifier.classify({ context: { current: {}, recentTurns: [] }, model: "spark", effort: "low" }),
    (error) => error instanceof ClassificationError && error.category === "invalid_json_schema"
  );
});

test("classifier rejects malformed structured output", async () => {
  const classifier = createClassifier({ transport: classifierTransport("not-json"), timeoutMs: 500 });
  await assert.rejects(
    classifier.classify({ context: { current: {}, recentTurns: [] }, model: "spark", effort: "low" }),
    (error) => error instanceof ClassificationError && error.category === "invalid_json"
  );
});

test("classifier reloads the full last turn when completion only contains a summary", async () => {
  const transport = classifierTransport(
    JSON.stringify({ route: { tier: "economy", effort: "low", rationale: "short answer" } }),
    { inlineItems: false, messagePhase: null }
  );
  const classifier = createClassifier({ transport, timeoutMs: 500 });
  const result = await classifier.classify({
    context: { current: {}, recentTurns: [] },
    model: "spark",
    effort: "low",
    automaticEffortTiers: ["economy"],
  });
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
    JSON.stringify({ route: { tier: "complex", rationale: "deep failure" } }),
    { inlineItems: false, streamItem: true, failFullRead: true }
  );
  const classifier = createClassifier({ transport, timeoutMs: 500 });
  const result = await classifier.classify({ context: { current: {}, recentTurns: [] }, model: "spark", effort: "low" });
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
    classifier.classify({ context: { current: {}, recentTurns: [] }, model: "spark", effort: "low" }),
    (error) => error instanceof ClassificationError && error.category === "timeout"
  );
});
