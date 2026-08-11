const os = require("os");
const {
  AUTO_REASONING_EFFORT,
  CLASSIFICATION_MAX_CONCURRENCY,
  CLASSIFICATION_TIMEOUT_MS,
  EFFORT_ORDER,
} = require("./constants.cjs");
const { assistantFinalFromItems, assistantFinalFromTurn, buildClassifierPrompt } = require("./context.cjs");
const { defaultTierDefinitions, enabledTierDefinitions } = require("./tiers.cjs");

function classifierOutputSchema(automaticEffortTiers, tiers = defaultTierDefinitions()) {
  const activeTiers = enabledTierDefinitions(tiers);
  const tierIds = activeTiers.map((tier) => tier.id);
  const configuredAutoTiers = Array.isArray(automaticEffortTiers)
    ? automaticEffortTiers
    : activeTiers.filter((tier) => tier.effort === AUTO_REASONING_EFFORT).map((tier) => tier.id);
  const automaticTiers = new Set(configuredAutoTiers.filter((tier) => tierIds.includes(tier)));
  const variants = tierIds.map((tier) => {
    const effortRequired = automaticTiers.has(tier);
    return {
      type: "object",
      additionalProperties: false,
      required: ["tier", ...(effortRequired ? ["effort"] : []), "rationale"],
      properties: {
        tier: { type: "string", enum: [tier] },
        ...(effortRequired ? { effort: { type: "string", enum: EFFORT_ORDER } } : {}),
        rationale: { type: "string", maxLength: 300 },
      },
    };
  });
  /**
   * Responses API 禁止在输出 schema 顶层使用 anyOf，因此统一用稳定的 route 外壳承载条件分支。
   * 每个启用档位恰好一个分支，并在 schema 层保证只有 Auto 档位能够返回 effort。
   */
  return {
    type: "object",
    additionalProperties: false,
    required: ["route"],
    properties: {
      route: { anyOf: variants },
    },
  };
}

// 默认导出同样从当前内置定义动态生成，避免另维护一套固定枚举或 effort 规则。
const DEFAULT_TIERS = defaultTierDefinitions();
const DEFAULT_TIER_IDS = Object.freeze(DEFAULT_TIERS.filter((tier) => tier.enabled).map((tier) => tier.id));
const DEFAULT_AUTOMATIC_EFFORT_TIERS = Object.freeze(
  DEFAULT_TIERS.filter((tier) => tier.enabled && tier.effort === AUTO_REASONING_EFFORT).map((tier) => tier.id)
);
const CLASSIFIER_OUTPUT_SCHEMA = Object.freeze(
  classifierOutputSchema(DEFAULT_AUTOMATIC_EFFORT_TIERS, DEFAULT_TIERS)
);

class ClassificationError extends Error {
  constructor(message, category = "classification") {
    super(message);
    this.name = "ClassificationError";
    this.category = category;
  }
}

function createSemaphore(limit) {
  let active = 0;
  const queue = [];

  function dispatch() {
    while (active < limit && queue.length > 0) {
      const entry = queue.shift();
      if (entry.expired) continue;
      clearTimeout(entry.timer);
      active += 1;
      let released = false;
      entry.resolve(() => {
        if (released) return;
        released = true;
        active -= 1;
        dispatch();
      });
    }
  }

  function acquire(timeoutMs) {
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, expired: false, timer: null };
      entry.timer = setTimeout(() => {
        entry.expired = true;
        reject(new ClassificationError("Classifier concurrency queue timed out", "timeout"));
      }, Math.max(1, timeoutMs));
      queue.push(entry);
      dispatch();
    });
  }

  return {
    acquire,
    status() {
      return { active, queued: queue.filter((entry) => !entry.expired).length, limit };
    },
  };
}

function remainingMs(deadlineAt) {
  const value = deadlineAt - Date.now();
  if (value <= 0) throw new ClassificationError("Classifier deadline exceeded", "timeout");
  return value;
}

function parseClassificationText(
  text,
  allowedTierIds = DEFAULT_TIER_IDS,
  automaticEffortTiers = DEFAULT_AUTOMATIC_EFFORT_TIERS
) {
  if (typeof text !== "string" || !text.trim()) throw new ClassificationError("Classifier returned no message", "empty");
  const trimmed = text.trim();
  const unwrapped = trimmed.startsWith("```")
    ? trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
    : trimmed;
  let parsed;
  try {
    parsed = JSON.parse(unwrapped);
  } catch {
    throw new ClassificationError("Classifier returned invalid JSON", "invalid_json");
  }
  return validateClassification(parsed, allowedTierIds, automaticEffortTiers);
}

function normalizedFailureCode(value) {
  const code = String(value || "").trim();
  return /^[a-z][a-z0-9_]{1,63}$/i.test(code) ? code : "";
}

function classifierTurnFailureCategory(turn) {
  const error = turn?.error;
  const message = typeof error?.message === "string" ? error.message.trim() : "";
  if (message) {
    try {
      const parsed = JSON.parse(message);
      const responseCode = normalizedFailureCode(parsed?.error?.code || parsed?.code);
      if (responseCode) return responseCode;
    } catch {
      // 普通文本错误不进入日志，避免未来协议把输入片段混入错误消息造成隐私泄漏。
    }
  }
  const codexErrorInfo = normalizedFailureCode(error?.codexErrorInfo);
  return codexErrorInfo && codexErrorInfo !== "other" ? codexErrorInfo : "turn_failed";
}

function validateClassification(
  value,
  allowedTierIds = DEFAULT_TIER_IDS,
  automaticEffortTiers = DEFAULT_AUTOMATIC_EFFORT_TIERS
) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ClassificationError("Classifier result must be an object", "invalid_schema");
  }
  const envelopeKeys = Object.keys(value);
  if (envelopeKeys.length !== 1 || envelopeKeys[0] !== "route") {
    throw new ClassificationError("Classifier result must contain only route", "invalid_schema");
  }
  const route = value.route;
  if (!route || typeof route !== "object" || Array.isArray(route)) {
    throw new ClassificationError("Classifier route must be an object", "invalid_schema");
  }
  const allowedTiers = new Set(Array.isArray(allowedTierIds) ? allowedTierIds : []);
  if (!allowedTiers.has(route.tier)) throw new ClassificationError("Classifier tier is invalid", "invalid_schema");
  const automaticTiers = new Set(
    (Array.isArray(automaticEffortTiers) ? automaticEffortTiers : []).filter((tier) => allowedTiers.has(tier))
  );
  const usesAutomaticEffort = automaticTiers.has(route.tier);
  if (usesAutomaticEffort && !EFFORT_ORDER.includes(route.effort)) {
    throw new ClassificationError("Classifier effort is required for an automatic-effort tier", "invalid_schema");
  }
  if (!usesAutomaticEffort && route.effort !== undefined) {
    throw new ClassificationError("Classifier effort is forbidden for a fixed-effort tier", "invalid_schema");
  }
  const allowedKeys = new Set(["tier", "rationale", ...(usesAutomaticEffort ? ["effort"] : [])]);
  if (Object.keys(route).some((key) => !allowedKeys.has(key))) {
    throw new ClassificationError("Classifier route contains unsupported fields", "invalid_schema");
  }
  if (typeof route.rationale !== "string" || route.rationale.length > 300) {
    throw new ClassificationError("Classifier rationale is invalid", "invalid_schema");
  }
  return {
    tier: route.tier,
    ...(usesAutomaticEffort ? { effort: route.effort } : {}),
    rationale: route.rationale,
  };
}

async function completedAgentMessage({ transport, completedTurn, observedItems, threadId, deadlineAt }) {
  const inlineMessage = assistantFinalFromTurn(completedTurn);
  if (inlineMessage) return inlineMessage;
  const observedMessage = assistantFinalFromItems(observedItems, { allowLegacy: completedTurn?.status === "completed" });
  if (observedMessage) return observedMessage;

  /**
   * 新版 App Server 会按订阅视图把 turn/completed.items 裁成摘要，结构化消息可能只存在于完整历史里。
   * 分类线程仍处于 ephemeral 生命周期内，清理前补读最后一轮即可兼容 summary/full 两种通知形态。
   */
  try {
    const result = await transport.request(
      "thread/turns/list",
      { threadId, cursor: null, limit: 1, sortDirection: "desc", itemsView: "full" },
      { timeoutMs: remainingMs(deadlineAt) }
    );
    const turns = Array.isArray(result?.data) ? result.data : [];
    return turns.length > 0 ? assistantFinalFromTurn(turns[0]) : "";
  } catch {
    // 某些 App Server 版本不允许读取 ephemeral 历史；此处转成 empty fallback，不能阻断用户回合。
    return "";
  }
}

function createClassifier({ transport, timeoutMs = CLASSIFICATION_TIMEOUT_MS, concurrency = CLASSIFICATION_MAX_CONCURRENCY }) {
  const semaphore = createSemaphore(Math.max(1, concurrency));

  async function cleanup(threadId, turnId, interrupt) {
    if (!threadId) return;
    if (interrupt && turnId) {
      try {
        await transport.request("turn/interrupt", { threadId, turnId }, { timeoutMs: 1_500 });
      } catch {}
    }
    try {
      await transport.request("thread/unsubscribe", { threadId }, { timeoutMs: 1_500 });
    } catch {}
    try {
      await transport.request("thread/delete", { threadId }, { timeoutMs: 1_500 });
    } catch {}
    transport.unregisterInternalThread(threadId);
  }

  async function classify({
    context,
    model,
    effort,
    tiers = defaultTierDefinitions(),
    automaticEffortTiers = [],
    deadlineAt: requestedDeadlineAt,
  }) {
    const startedAt = Date.now();
    const deadlineAt = Number.isFinite(requestedDeadlineAt) ? requestedDeadlineAt : startedAt + timeoutMs;
    const activeTierIds = enabledTierDefinitions(tiers).map((tier) => tier.id);
    if (activeTierIds.length === 0) throw new ClassificationError("No enabled tiers are available", "no_enabled_tiers");
    const release = await semaphore.acquire(remainingMs(deadlineAt));
    let threadId = "";
    let turnId = "";
    let completed = false;
    const observedAgentItems = [];
    let stopObserving = () => {};
    try {
      const threadResult = await transport.request(
        "thread/start",
        {
          model,
          cwd: os.tmpdir(),
          approvalPolicy: "never",
          sandbox: "read-only",
          config: { model_reasoning_effort: effort },
          baseInstructions: "Classify the supplied task for routing. Do not execute, answer, or use tools.",
          developerInstructions: "Return only the structured classification requested by the output schema.",
          ephemeral: true,
          environments: [],
          dynamicTools: [],
          selectedCapabilityRoots: [],
        },
        { timeoutMs: remainingMs(deadlineAt) }
      );
      threadId = String(threadResult?.thread?.id || threadResult?.threadId || "");
      if (!threadId) throw new ClassificationError("Classifier thread did not start", "thread_start");
      transport.registerInternalThread(threadId);

      stopObserving = transport.observeNotifications((message) => {
        if (message?.method !== "item/completed" || message?.params?.threadId !== threadId) return;
        const item = message.params.item;
        if (item?.type === "agentMessage" && typeof item.text === "string") observedAgentItems.push(item);
      });

      const completionPromise = transport.waitForNotification(
        (message) => message?.method === "turn/completed" && message?.params?.threadId === threadId,
        { timeoutMs: remainingMs(deadlineAt) }
      );
      const turnResultPromise = transport.request(
        "turn/start",
        {
          threadId,
          input: [
            {
              type: "text",
              text: buildClassifierPrompt(context, { tiers, automaticEffortTiers }),
              text_elements: [],
            },
          ],
          model,
          effort,
          outputSchema: classifierOutputSchema(automaticEffortTiers, tiers),
        },
        { timeoutMs: remainingMs(deadlineAt) }
      );
      let turnResult;
      try {
        turnResult = await turnResultPromise;
      } catch (error) {
        // notification waiter 已注册，失败分支显式接住其后续超时，避免产生未处理 rejection。
        void completionPromise.catch(() => {});
        throw error;
      }
      turnId = String(turnResult?.turn?.id || turnResult?.turnId || "");
      const completedMessage = await completionPromise;
      completed = true;
      const turn = completedMessage?.params?.turn;
      if (turn?.status !== "completed") {
        const category = classifierTurnFailureCategory(turn);
        throw new ClassificationError(
          `Classifier turn ended with ${turn?.status || "unknown"} (${category})`,
          category
        );
      }
      const agentMessage = await completedAgentMessage({
        transport,
        completedTurn: turn,
        observedItems: observedAgentItems,
        threadId,
        deadlineAt,
      });
      const classification = parseClassificationText(agentMessage, activeTierIds, automaticEffortTiers);
      return { classification, elapsedMs: Date.now() - startedAt };
    } catch (error) {
      if (error instanceof ClassificationError) throw error;
      const category = error?.category === "timeout" ? "timeout" : "transport";
      throw new ClassificationError(error instanceof Error ? error.message : String(error), category);
    } finally {
      stopObserving();
      release();
      // 清理走内部 ID 且完全隐藏；不把清理延迟叠加到用户 turn/start 的关键路径。
      void cleanup(threadId, turnId, !completed).catch(() => {});
    }
  }

  return {
    classify,
    status: semaphore.status,
  };
}

module.exports = {
  CLASSIFIER_OUTPUT_SCHEMA,
  ClassificationError,
  classifierTurnFailureCategory,
  classifierOutputSchema,
  completedAgentMessage,
  createClassifier,
  createSemaphore,
  parseClassificationText,
  validateClassification,
};
