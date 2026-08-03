const {
  AUTO_REASONING_EFFORT,
  BUILTIN_ROUTE_DEFAULTS,
  EFFORT_ORDER,
  SMART_ROUTER_PLUGIN_ID,
  TIER_ORDER,
} = require("./constants.cjs");

const MAX_TIER_COUNT = 32;
const MAX_TIER_NAME_LENGTH = 80;
const MAX_TIER_PROMPT_LENGTH = 2_000;
const MAX_TIER_MODEL_LENGTH = 200;
const SAFE_TIER_ID = /^[a-z][a-z0-9_-]{1,63}$/;
const ALLOWED_TIER_EFFORTS = new Set([AUTO_REASONING_EFFORT, ...EFFORT_ORDER]);

// 内置档位只负责提供首次启用时的默认数据；运行时分类统一读取持久化后的档位列表。
const BUILTIN_TIER_COPY = Object.freeze({
  economy: Object.freeze({
    name: "Economy",
    prompt: "Use for trivial questions/edits.",
  }),
  balanced: Object.freeze({
    name: "Balanced",
    prompt: "Use for normal implementation.",
  }),
  complex: Object.freeze({
    name: "Complex",
    prompt: "Use for difficult debugging or multi-file reasoning.",
    failureFloor: true,
  }),
  frontier: Object.freeze({
    name: "Frontier",
    prompt: "Use only for exceptional ambiguity or architecture depth.",
  }),
});

const LEGACY_TIER_SETTING_IDS = Object.freeze(
  TIER_ORDER.flatMap((tierId) => [`${tierId}Model`, `${tierId}Effort`])
);

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function builtinTierDefinition(tierId) {
  const route = BUILTIN_ROUTE_DEFAULTS[tierId];
  const copy = BUILTIN_TIER_COPY[tierId];
  return {
    id: tierId,
    builtin: true,
    enabled: true,
    name: copy.name,
    defaultName: copy.name,
    nameKey: `plugin.smartModelRouter.group.${tierId}`,
    prompt: copy.prompt,
    model: route.model,
    // 只有经济档位交给分类器动态选择强度，其余内置档位使用固定默认强度。
    effort: route.effort,
    failureFloor: copy.failureFloor === true,
    defaultModel: route.model,
    defaultEffort: route.effort,
  };
}

const BUILTIN_TIER_DEFINITIONS = Object.freeze(
  TIER_ORDER.map((tierId) => Object.freeze(builtinTierDefinition(tierId)))
);
const BUILTIN_TIER_BY_ID = new Map(BUILTIN_TIER_DEFINITIONS.map((tier) => [tier.id, tier]));

function defaultTierDefinitions() {
  return cloneJson(BUILTIN_TIER_DEFINITIONS);
}

function normalizedText(value, fallback, maxLength) {
  const text = typeof value === "string" ? value.trim() : "";
  return (text || fallback).slice(0, maxLength);
}

function normalizedModel(value, fallback) {
  const model = normalizedText(value, fallback, MAX_TIER_MODEL_LENGTH);
  return model.toLowerCase() === "auto" ? fallback : model;
}

function normalizedEffort(value, fallback = AUTO_REASONING_EFFORT) {
  return ALLOWED_TIER_EFFORTS.has(value) ? value : fallback;
}

function normalizeTierDefinition(value, fallback = null) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const requestedId = String(source.id || fallback?.id || "")
    .trim()
    .toLowerCase();
  const builtin = BUILTIN_TIER_BY_ID.get(requestedId) || null;
  const baseline = builtin || fallback;
  if (!baseline || !SAFE_TIER_ID.test(requestedId)) return null;
  return {
    id: requestedId,
    builtin: Boolean(builtin),
    enabled: source.enabled !== false,
    name: builtin
      ? builtin.name
      : normalizedText(source.name, baseline.name || requestedId, MAX_TIER_NAME_LENGTH),
    defaultName: builtin?.name || "",
    nameKey: builtin?.nameKey || "",
    prompt: builtin
      ? builtin.prompt
      : normalizedText(source.prompt, baseline.prompt || "", MAX_TIER_PROMPT_LENGTH),
    // 内置档位仅开放路由参数；损坏或缺失的持久化值仍回退到代码内默认值。
    model: normalizedModel(source.model, baseline.model || BUILTIN_ROUTE_DEFAULTS.fallback.model),
    effort: normalizedEffort(source.effort, baseline.effort || AUTO_REASONING_EFFORT),
    failureFloor: builtin?.failureFloor === true,
    defaultModel: builtin?.defaultModel || "",
    defaultEffort: builtin?.defaultEffort || "medium",
  };
}

function legacyTierDefinitions(legacyValues = {}) {
  const values =
    legacyValues && typeof legacyValues === "object" && !Array.isArray(legacyValues) ? legacyValues : {};
  // 旧版扁平设置与新版可编辑字段一一对应，迁移时保留用户选择过的模型和推理强度。
  return defaultTierDefinitions().map((tier) =>
    normalizeTierDefinition(
      {
        id: tier.id,
        enabled: tier.enabled,
        model: values[`${tier.id}Model`],
        effort: values[`${tier.id}Effort`],
      },
      tier
    )
  );
}

function restoreBuiltinTierOrder(tiers) {
  const orderedBuiltins = BUILTIN_TIER_DEFINITIONS.map((definition) =>
    tiers.find((tier) => tier.id === definition.id)
  );
  let builtinIndex = 0;
  // 自定义档位保留原位置，只把所有内置槽位恢复成固定的内置相对顺序。
  return tiers.map((tier) => (tier.builtin ? orderedBuiltins[builtinIndex++] : tier));
}

function normalizeStoredTierDefinitions(value, legacyValues = {}) {
  if (!Array.isArray(value)) return legacyTierDefinitions(legacyValues);
  const normalized = [];
  const seen = new Set();
  for (const candidate of value.slice(0, MAX_TIER_COUNT)) {
    const id = String(candidate?.id || "")
      .trim()
      .toLowerCase();
    if (!SAFE_TIER_ID.test(id) || seen.has(id)) continue;
    const fallback = BUILTIN_TIER_BY_ID.get(id) || candidate;
    const tier = normalizeTierDefinition(candidate, fallback);
    if (!tier) continue;
    normalized.push(tier);
    seen.add(id);
  }
  // 持久化配置损坏或来自旧版本时补回内置档位，保证它们不会因异常数据永久消失。
  for (const builtin of BUILTIN_TIER_DEFINITIONS) {
    if (!seen.has(builtin.id)) normalized.push(cloneJson(builtin));
  }
  return restoreBuiltinTierOrder(normalized);
}

function validateRequiredString(value, field, maxLength) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must not be empty`);
  if (value.trim().length > maxLength) throw new Error(`${field} is too long`);
  return value.trim();
}

function validateTierDefinitions(value) {
  if (!Array.isArray(value)) throw new Error("tiers must be an array");
  if (value.length > MAX_TIER_COUNT) throw new Error(`tiers must contain at most ${MAX_TIER_COUNT} entries`);
  const seen = new Set();
  const normalized = value.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error(`tiers[${index}] must be an object`);
    }
    const id = String(candidate.id || "")
      .trim()
      .toLowerCase();
    if (!SAFE_TIER_ID.test(id)) throw new Error(`tiers[${index}].id is invalid`);
    if (seen.has(id)) throw new Error(`Duplicate tier id: ${id}`);
    seen.add(id);
    if (typeof candidate.enabled !== "boolean") throw new Error(`Tier ${id} enabled must be a boolean`);
    const builtin = BUILTIN_TIER_BY_ID.get(id) || null;
    if (builtin) {
      for (const field of ["name", "prompt"]) {
        if (candidate[field] !== builtin[field]) {
          throw new Error(`Built-in tier ${id} ${field} cannot be modified`);
        }
      }
      const model = validateRequiredString(candidate.model, `Tier ${id} model`, MAX_TIER_MODEL_LENGTH);
      if (model.toLowerCase() === "auto") throw new Error(`Tier ${id} model cannot target Auto`);
      if (!ALLOWED_TIER_EFFORTS.has(candidate.effort)) throw new Error(`Tier ${id} effort is unsupported`);
      // 名称、提示词和结构元数据继续使用内置模板，仅持久化允许调整的路由字段。
      return normalizeTierDefinition({ id, enabled: candidate.enabled, model, effort: candidate.effort }, builtin);
    }
    const name = validateRequiredString(candidate.name, `Tier ${id} name`, MAX_TIER_NAME_LENGTH);
    const prompt = validateRequiredString(candidate.prompt, `Tier ${id} prompt`, MAX_TIER_PROMPT_LENGTH);
    const model = validateRequiredString(candidate.model, `Tier ${id} model`, MAX_TIER_MODEL_LENGTH);
    if (model.toLowerCase() === "auto") throw new Error(`Tier ${id} model cannot target Auto`);
    if (!ALLOWED_TIER_EFFORTS.has(candidate.effort)) throw new Error(`Tier ${id} effort is unsupported`);
    return normalizeTierDefinition(
      {
        id,
        enabled: candidate.enabled,
        name,
        prompt,
        model,
        effort: candidate.effort,
      },
      builtin || { id, name, prompt, model, effort: candidate.effort }
    );
  });
  for (const builtin of BUILTIN_TIER_DEFINITIONS) {
    if (!seen.has(builtin.id)) throw new Error(`Built-in tier ${builtin.id} cannot be deleted`);
  }
  const builtinOrder = normalized.filter((tier) => tier.builtin).map((tier) => tier.id);
  if (builtinOrder.some((id, index) => id !== TIER_ORDER[index])) {
    throw new Error("Built-in tier order cannot be changed");
  }
  return normalized;
}

function enabledTierDefinitions(tiers) {
  return normalizeStoredTierDefinitions(tiers).filter((tier) => tier.enabled);
}

function failureFloorTierId(tiers) {
  const normalized = normalizeStoredTierDefinitions(tiers);
  const enabled = normalized.filter((tier) => tier.enabled);
  if (enabled.length === 0) return "";
  const configuredFloorIndex = normalized.findIndex((tier) => tier.failureFloor === true);
  const floorIndex = configuredFloorIndex >= 0 ? configuredFloorIndex : normalized.length - 1;
  const candidate = normalized.slice(Math.max(0, floorIndex)).find((tier) => tier.enabled);
  // 默认失败基准档被关闭且其后没有启用档位时，退到当前最高启用档位。
  return candidate?.id || enabled[enabled.length - 1].id;
}

module.exports = {
  ALLOWED_TIER_EFFORTS,
  BUILTIN_TIER_COPY,
  BUILTIN_TIER_DEFINITIONS,
  LEGACY_TIER_SETTING_IDS,
  MAX_TIER_COUNT,
  MAX_TIER_MODEL_LENGTH,
  MAX_TIER_NAME_LENGTH,
  MAX_TIER_PROMPT_LENGTH,
  SAFE_TIER_ID,
  SMART_ROUTER_PLUGIN_ID,
  defaultTierDefinitions,
  enabledTierDefinitions,
  failureFloorTierId,
  legacyTierDefinitions,
  normalizeStoredTierDefinitions,
  normalizeTierDefinition,
  validateTierDefinitions,
};
