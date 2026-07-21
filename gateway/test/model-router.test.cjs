const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { parseClassificationText, validateClassification } = require("../runtime/model-router/classifier.cjs");
const {
  createRoutingContext,
  summarizeUserInput,
  userInputsFromTurns,
} = require("../runtime/model-router/context.cjs");
const {
  applyClassificationPolicy,
  nearestEffort,
  resolveClassifierRoute,
  resolveTierRoute,
} = require("../runtime/model-router/resolver.cjs");
const { createAutoStateStore } = require("../runtime/model-router/state-store.cjs");

function tempFile(t, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodex-router-test-"));
  t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
  return path.join(dir, name);
}

function model(id, efforts = ["low", "medium", "high", "xhigh"], isDefault = false) {
  return {
    id,
    model: id,
    displayName: id,
    hidden: false,
    isDefault,
    defaultReasoningEffort: efforts[0],
    supportedReasoningEfforts: efforts.map((reasoningEffort) => ({ reasoningEffort, description: "" })),
  };
}

test("classification policy promotes low confidence and previous failures", () => {
  assert.equal(applyClassificationPolicy({ tier: "economy", confidence: 0.64 }, "completed").tier, "balanced");
  assert.equal(applyClassificationPolicy({ tier: "frontier", confidence: 0.1 }, "completed").tier, "frontier");
  assert.equal(applyClassificationPolicy({ tier: "balanced", confidence: 0.9 }, "failed").tier, "complex");
  assert.equal(applyClassificationPolicy({ tier: "economy", confidence: 0.9 }, "interrupted").tier, "economy");
});

test("resolver honors configured, tier, catalog default and nearest effort order", () => {
  const configured = resolveTierRoute({
    tier: "balanced",
    configValues: { balancedModel: "custom", balancedEffort: "medium", fallbackModel: "fallback" },
    models: [model("custom", ["low", "high"]), model("fallback"), model("catalog-default", ["medium"], true)],
  });
  assert.equal(configured.model, "custom");
  // medium 与 low/high 等距时向上选择 high。
  assert.equal(configured.effort, "high");

  const tierBuiltin = resolveTierRoute({
    tier: "balanced",
    configValues: { balancedModel: "missing", balancedEffort: "medium", fallbackModel: "fallback" },
    models: [model("gpt-5.6-luna"), model("catalog-default", ["medium"], true), model("fallback")],
  });
  assert.equal(tierBuiltin.model, "gpt-5.6-luna");

  const catalogDefault = resolveTierRoute({
    tier: "balanced",
    configValues: { balancedModel: "missing", balancedEffort: "medium", fallbackModel: "fallback" },
    models: [model("catalog-default", ["medium"], true), model("fallback")],
  });
  assert.equal(catalogDefault.model, "catalog-default");
  assert.equal(nearestEffort("medium", model("x", ["low", "high"])), "high");

  const automatic = resolveTierRoute({
    tier: "balanced",
    classificationEffort: "xhigh",
    configValues: { balancedModel: "custom", balancedEffort: "auto", fallbackModel: "fallback" },
    models: [model("custom", ["high", "max"]), model("fallback")],
  });
  // 分类建议 xhigh 与 high/max 等距时，仍沿用既有规则向上选择 max。
  assert.equal(automatic.effort, "max");

  const automaticClassifier = resolveClassifierRoute({
    configValues: { classifierModel: "custom", classifierEffort: "auto", fallbackModel: "fallback" },
    models: [model("custom", ["high", "xhigh"]), model("fallback")],
  });
  assert.equal(automaticClassifier.effort, "high");
});

test("routing context keeps six recent user inputs, image markers, usage and state", () => {
  const turns = Array.from({ length: 8 }, (_value, index) => ({
    items: [
      {
        type: "userMessage",
        content: [
          { type: "text", text: `message-${index}` },
          ...(index === 7 ? [{ type: "localImage", path: "/tmp/image.png" }] : []),
        ],
      },
    ],
  }));
  const history = userInputsFromTurns(turns);
  assert.deepEqual(history.map((entry) => entry.text), ["message-2", "message-3", "message-4", "message-5", "message-6", "message-7"]);
  assert.equal(history[5].hasImages, true);

  const context = createRoutingContext({
    input: [{ type: "text", text: "current" }, { type: "image", url: "data:image/png" }],
    history,
    lastRoute: { tier: "balanced", model: "luna", effort: "medium" },
    previousStatus: "failed",
    usage: { total: { inputTokens: 120, outputTokens: 30, totalTokens: 150 } },
  });
  assert.equal(context.current.imageCount, 1);
  assert.equal(context.recentUserInputs.length, 6);
  assert.equal(context.previousStatus, "failed");
  assert.equal(context.usage.totalTokens, 150);
  assert.equal(summarizeUserInput([{ type: "skill", name: "x" }]).skillCount, 1);
});

test("classifier JSON parser validates all required structured fields", () => {
  const value = parseClassificationText(
    '```json\n{"tier":"complex","effort":"high","confidence":0.8,"taskType":"debugging","rationale":"multi-file failure"}\n```'
  );
  assert.equal(value.tier, "complex");
  assert.equal(value.effort, "high");
  assert.throws(
    () =>
      validateClassification({
        tier: "complex",
        effort: "high",
        confidence: 2,
        taskType: "debugging",
        rationale: "x",
      }),
    /confidence/
  );
  const fixedEffort = validateClassification({
    tier: "complex",
    confidence: 0.9,
    taskType: "debugging",
    rationale: "x",
  });
  assert.equal("effort" in fixedEffort, false);
  assert.throws(
    () =>
      validateClassification({
        tier: "complex",
        effort: "adaptive",
        confidence: 0.9,
        taskType: "debugging",
        rationale: "x",
      }),
    /effort/
  );
  assert.throws(() => parseClassificationText("not-json"), /invalid JSON/);
});

test("auto state survives restart and clear keeps the last concrete route", (t) => {
  const filePath = tempFile(t, "state.json");
  const first = createAutoStateStore({ filePath });
  first.setDefaultAuto(true, { model: "spark", effort: "low" });
  first.setThreadAuto("thread-1", true, { model: "terra", effort: "high" });
  first.recordRoute("thread-1", { tier: "complex", model: "terra", effort: "high" });
  first.recordStatus("thread-1", "failed");

  const second = createAutoStateStore({ filePath });
  assert.equal(second.isDefaultAuto(), true);
  assert.equal(second.isThreadAuto("thread-1"), true);
  assert.equal(second.threadState("thread-1").lastTier, "complex");
  second.clearAllAuto();
  assert.equal(second.isDefaultAuto(), false);
  assert.equal(second.isThreadAuto("thread-1"), false);
  assert.equal(second.threadState("thread-1").lastModel, "terra");
});
