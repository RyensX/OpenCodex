const os = require("os");
const {
  CLASSIFICATION_MAX_CONCURRENCY,
  CLASSIFICATION_TIMEOUT_MS,
  EFFORT_ORDER,
  TASK_TYPES,
} = require("./constants.cjs");
const { buildClassifierPrompt } = require("./context.cjs");
const { applyClassificationPolicy } = require("./resolver.cjs");
const { defaultTierDefinitions, enabledTierDefinitions } = require("./tiers.cjs");

function baseClassifierOutputSchema(tierIds) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["tier", "confidence", "taskType", "rationale"],
    properties: {
      tier: { type: "string", enum: tierIds },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      taskType: { type: "string", enum: TASK_TYPES },
      rationale: { type: "string", maxLength: 300 },
    },
  };
}

// 兼容旧调用方的默认 schema 也从内置档位数据生成，不再单独维护一份写死枚举。
const DEFAULT_TIER_IDS = Object.freeze(defaultTierDefinitions().map((tier) => tier.id));
const CLASSIFIER_OUTPUT_SCHEMA = Object.freeze(baseClassifierOutputSchema(DEFAULT_TIER_IDS));

function classifierOutputSchema(
  automaticEffortTiers,
  previousStatus = "",
  tiers = defaultTierDefinitions()
) {
  const activeTiers = enabledTierDefinitions(tiers);
  const tierIds = activeTiers.map((tier) => tier.id);
  const baseSchema = baseClassifierOutputSchema(tierIds);
  const needsEffort = Array.isArray(automaticEffortTiers) && automaticEffortTiers.length > 0;
  if (!needsEffort) return baseSchema;
  const automaticTiers = new Set(automaticEffortTiers);
  const variants = [];
  for (const tier of tierIds) {
    for (const lowConfidence of [true, false]) {
      const confidence = lowConfidence
        ? { type: "number", minimum: 0, exclusiveMaximum: 0.65 }
        : { type: "number", minimum: 0.65, maximum: 1 };
      const effectiveTier = applyClassificationPolicy(
        { tier, confidence: lowConfidence ? 0.64 : 0.65 },
        previousStatus,
        tiers
      ).tier;
      const effortRequired = automaticTiers.has(effectiveTier);
      variants.push({
        type: "object",
        additionalProperties: false,
        required: ["tier", ...(effortRequired ? ["effort"] : []), "confidence", "taskType", "rationale"],
        properties: {
          tier: { type: "string", enum: [tier] },
          ...(effortRequired ? { effort: { type: "string", enum: EFFORT_ORDER } } : {}),
          confidence,
          taskType: baseSchema.properties.taskType,
          rationale: baseSchema.properties.rationale,
        },
      });
    }
  }
  /**
   * Responses API 禁止在输出 schema 顶层使用 anyOf，但允许在对象属性内使用。
   * 因此用稳定的 route 外壳承载条件分支，同时继续从 schema 层保证只有 Auto 档位返回 effort。
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

function parseClassificationText(text, allowedTierIds = DEFAULT_TIER_IDS) {
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
  // Auto effort 的条件 schema 使用 route 外壳；无 Auto 档位时仍兼容原来的扁平对象，避免无谓改变协议形态。
  return validateClassification(parsed?.route ?? parsed, allowedTierIds);
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

function validateClassification(value, allowedTierIds = DEFAULT_TIER_IDS) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ClassificationError("Classifier result must be an object", "invalid_schema");
  }
  const allowedTiers = new Set(Array.isArray(allowedTierIds) ? allowedTierIds : []);
  if (!allowedTiers.has(value.tier)) throw new ClassificationError("Classifier tier is invalid", "invalid_schema");
  if (value.effort !== undefined && !EFFORT_ORDER.includes(value.effort)) {
    throw new ClassificationError("Classifier effort is invalid", "invalid_schema");
  }
  if (!Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1) {
    throw new ClassificationError("Classifier confidence is invalid", "invalid_schema");
  }
  if (!TASK_TYPES.includes(value.taskType)) throw new ClassificationError("Classifier taskType is invalid", "invalid_schema");
  if (typeof value.rationale !== "string" || value.rationale.length > 300) {
    throw new ClassificationError("Classifier rationale is invalid", "invalid_schema");
  }
  return {
    tier: value.tier,
    ...(value.effort === undefined ? {} : { effort: value.effort }),
    confidence: value.confidence,
    taskType: value.taskType,
    rationale: value.rationale,
  };
}

function lastAgentMessage(turn) {
  const messages = (Array.isArray(turn?.items) ? turn.items : []).filter(
    (item) => item?.type === "agentMessage" && typeof item.text === "string"
  );
  return messages.length > 0 ? messages[messages.length - 1].text : "";
}

async function completedAgentMessage({ transport, completedTurn, observedText, threadId, deadlineAt }) {
  const inlineMessage = lastAgentMessage(completedTurn);
  if (inlineMessage) return inlineMessage;
  if (typeof observedText === "string" && observedText) return observedText;

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
    return turns.length > 0 ? lastAgentMessage(turns[0]) : "";
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
    let observedAgentText = "";
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
        if (item?.type === "agentMessage" && typeof item.text === "string") observedAgentText = item.text;
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
          outputSchema: classifierOutputSchema(automaticEffortTiers, context?.previousStatus, tiers),
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
        observedText: observedAgentText,
        threadId,
        deadlineAt,
      });
      const classification = parseClassificationText(agentMessage, activeTierIds);
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
  lastAgentMessage,
  parseClassificationText,
  validateClassification,
};
