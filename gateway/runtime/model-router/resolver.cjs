const {
  AUTO_REASONING_EFFORT,
  BUILTIN_ROUTE_DEFAULTS,
  EFFORT_ORDER,
} = require("./constants.cjs");
const {
  defaultTierDefinitions,
  enabledTierDefinitions,
  failureFloorTierId,
  normalizeStoredTierDefinitions,
} = require("./tiers.cjs");

const BUILTIN_TIER_CANDIDATES = Object.freeze({
  classifier: Object.freeze(["gpt-5.3-codex-spark"]),
  fallback: Object.freeze(["gpt-5.3-codex-spark"]),
});

function modelIdentifier(model) {
  return String(model?.model || model?.id || "");
}

function visibleModels(models) {
  return (Array.isArray(models) ? models : []).filter(
    (model) => model && model.hidden !== true && modelIdentifier(model) && modelIdentifier(model).toLowerCase() !== "auto"
  );
}

function modelMatches(model, candidate) {
  const value = String(candidate || "");
  return !!value && (String(model?.model || "") === value || String(model?.id || "") === value);
}

function supportedEfforts(model) {
  const values = (Array.isArray(model?.supportedReasoningEfforts) ? model.supportedReasoningEfforts : [])
    .map((option) => (typeof option === "string" ? option : option?.reasoningEffort))
    .filter((effort) => EFFORT_ORDER.includes(effort));
  return Array.from(new Set(values));
}

function nearestEffort(requested, model) {
  const desired = EFFORT_ORDER.includes(requested) ? requested : model?.defaultReasoningEffort || "medium";
  const supported = supportedEfforts(model);
  if (supported.length === 0 || supported.includes(desired)) return desired;
  const desiredIndex = Math.max(0, EFFORT_ORDER.indexOf(desired));
  // 距离相同时按索引降序排序，确保选择更高推理强度。
  return supported.sort((left, right) => {
    const leftIndex = EFFORT_ORDER.indexOf(left);
    const rightIndex = EFFORT_ORDER.indexOf(right);
    return Math.abs(leftIndex - desiredIndex) - Math.abs(rightIndex - desiredIndex) || rightIndex - leftIndex;
  })[0];
}

function requestedEffort({ configuredEffort, automaticEffort, automaticEffortFallback, model }) {
  if (configuredEffort !== AUTO_REASONING_EFFORT) {
    return EFFORT_ORDER.includes(configuredEffort)
      ? configuredEffort
      : model?.defaultReasoningEffort || automaticEffortFallback || "medium";
  }
  // 档位 auto 优先采用分类建议；分类器自身和失败回退没有建议时采用目标模型默认值。
  if (EFFORT_ORDER.includes(automaticEffort)) return automaticEffort;
  if (EFFORT_ORDER.includes(model?.defaultReasoningEffort)) return model.defaultReasoningEffort;
  return EFFORT_ORDER.includes(automaticEffortFallback) ? automaticEffortFallback : "medium";
}

function routeSettings(configValues, tier) {
  const defaults = BUILTIN_ROUTE_DEFAULTS[tier] || BUILTIN_ROUTE_DEFAULTS.fallback;
  const prefix = tier === "classifier" || tier === "fallback" ? tier : tier;
  return {
    model: String(configValues?.[`${prefix}Model`] || defaults.model),
    effort: String(configValues?.[`${prefix}Effort`] || defaults.effort),
  };
}

function candidateModelNames({ tier, configuredModel, tierCandidates = [], fallbackModel }) {
  const values = [
    configuredModel,
    ...tierCandidates,
    ...(BUILTIN_TIER_CANDIDATES[tier] || []),
    fallbackModel,
    ...BUILTIN_TIER_CANDIDATES.fallback,
  ];
  return Array.from(new Set(values.filter(Boolean)));
}

function resolveModelAndEffort({
  tier,
  configuredModel,
  configuredEffort,
  automaticEffort,
  automaticEffortFallback,
  fallbackModel,
  tierCandidates = [],
  models,
}) {
  const available = visibleModels(models);
  // model/list 尚未返回时无法判断账号可用性，先使用配置值，让 App Server 自己做最终校验。
  if (available.length === 0) {
    return {
      model: configuredModel || fallbackModel || BUILTIN_ROUTE_DEFAULTS.fallback.model,
      effort: requestedEffort({
        configuredEffort,
        automaticEffort,
        automaticEffortFallback,
        model: null,
      }),
      catalogResolved: false,
    };
  }

  let selected = null;
  // 严格按“用户配置 → 档位内置候选 → catalog 默认 → fallback”解析，便于结果可预测。
  for (const candidate of Array.from(
    new Set([configuredModel, ...tierCandidates, ...(BUILTIN_TIER_CANDIDATES[tier] || [])].filter(Boolean))
  )) {
    selected = available.find((model) => modelMatches(model, candidate));
    if (selected) break;
  }
  if (!selected) selected = available.find((model) => model.isDefault === true) || null;
  if (!selected) {
    for (const candidate of Array.from(
      new Set([fallbackModel, ...BUILTIN_TIER_CANDIDATES.fallback].filter(Boolean))
    )) {
      selected = available.find((model) => modelMatches(model, candidate));
      if (selected) break;
    }
  }
  if (!selected) selected = available[0];
  return {
    model: modelIdentifier(selected),
    effort: nearestEffort(
      requestedEffort({ configuredEffort, automaticEffort, automaticEffortFallback, model: selected }),
      selected
    ),
    catalogResolved: true,
  };
}

function resolveTierRoute({
  tier,
  classificationEffort,
  tiers = defaultTierDefinitions(),
  configValues,
  models,
}) {
  const enabledTiers = enabledTierDefinitions(tiers);
  const requested = enabledTiers.find((candidate) => candidate.id === tier) || enabledTiers[0] || null;
  if (!requested) return resolveFallbackRoute({ configValues, tiers, models });
  const fallback = routeSettings(configValues, "fallback");
  return {
    tier: requested.id,
    ...resolveModelAndEffort({
      tier: requested.id,
      configuredModel: requested.model,
      configuredEffort: requested.effort,
      automaticEffort: classificationEffort,
      automaticEffortFallback: requested.defaultEffort,
      fallbackModel: fallback.model,
      tierCandidates: requested.defaultModel ? [requested.defaultModel] : [],
      models,
    }),
  };
}

function resolveFallbackRoute({ configValues, tiers = defaultTierDefinitions(), models }) {
  const fallback = routeSettings(configValues, "fallback");
  return {
    tier: enabledTierDefinitions(tiers)[0]?.id || "",
    fallback: true,
    ...resolveModelAndEffort({
      tier: "fallback",
      configuredModel: fallback.model,
      configuredEffort: fallback.effort,
      automaticEffortFallback: BUILTIN_ROUTE_DEFAULTS.fallback.effort,
      fallbackModel: BUILTIN_ROUTE_DEFAULTS.fallback.model,
      models,
    }),
  };
}

function resolveClassifierRoute({ configValues, models }) {
  const classifier = routeSettings(configValues, "classifier");
  const fallback = routeSettings(configValues, "fallback");
  return resolveModelAndEffort({
    tier: "classifier",
    configuredModel: classifier.model,
    configuredEffort: classifier.effort,
    automaticEffortFallback: BUILTIN_ROUTE_DEFAULTS.classifier.effort,
    fallbackModel: fallback.model,
    models,
  });
}

function applyClassificationPolicy(classification, previousStatus, tiers = defaultTierDefinitions()) {
  const normalizedTiers = normalizeStoredTierDefinitions(tiers);
  const activeTiers = enabledTierDefinitions(normalizedTiers);
  if (activeTiers.length === 0) return { ...classification, tier: "" };
  let index = activeTiers.findIndex((tier) => tier.id === classification?.tier);
  if (index < 0) index = 0;
  const confidence = Number(classification?.confidence);
  if (Number.isFinite(confidence) && confidence < 0.65) index = Math.min(index + 1, activeTiers.length - 1);
  // 用户主动中断不代表任务困难；真实失败使用档位定义中的基准标记，并跳过已关闭档位。
  if (previousStatus === "failed") {
    const floorIndex = activeTiers.findIndex((tier) => tier.id === failureFloorTierId(normalizedTiers));
    if (floorIndex >= 0) index = Math.max(index, floorIndex);
  }
  return { ...classification, tier: activeTiers[index].id };
}

module.exports = {
  BUILTIN_TIER_CANDIDATES,
  applyClassificationPolicy,
  candidateModelNames,
  modelIdentifier,
  nearestEffort,
  requestedEffort,
  resolveClassifierRoute,
  resolveFallbackRoute,
  resolveModelAndEffort,
  resolveTierRoute,
  routeSettings,
  supportedEfforts,
  visibleModels,
};
