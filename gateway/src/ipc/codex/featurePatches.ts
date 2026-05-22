// @ts-nocheck
export {};

const STATSIG_DEFAULT_FEATURES_CONFIG = "statsig_default_enable_features";
const STATSIG_I18N_LAYER_CONFIG = "72216192";
const STATSIG_I18N_LAYER_VALUES = {
  enable_i18n: true,
  locale_source: "IDE",
};

const STATSIG_DEFAULT_FEATURE_OVERRIDES = {
  guardian_approval: true,
  // 开启官方右侧 artifact/file preview pane，renderer 才会渲染原生预览入口。
  "3903742690": true,
  artifacts: true,
};
const APP_SERVER_UNSUPPORTED_FEATURE_ENABLEMENTS = new Set([
  "auth_elicitation",
  "enable_mcp_apps",
]);
const DEFAULT_ALLOWED_APPROVALS_REVIEWERS = ["user", "auto_review", "guardian_subagent"];

/** 生成离线 Statsig initialize 响应；SDK 需要 has_updates/time 等外层字段才会完成初始化。 */
function buildStatsigDefaultInitializeResponse() {
  const feature_gates = {};
  const dynamic_configs = {};
  for (const [featureName, enabled] of Object.entries(STATSIG_DEFAULT_FEATURE_OVERRIDES)) {
    feature_gates[featureName] = {
      name: featureName,
      value: enabled,
      rule_id: "gateway_override",
      secondary_exposures: [],
    };
  }
  dynamic_configs[STATSIG_DEFAULT_FEATURES_CONFIG] = {
    name: STATSIG_DEFAULT_FEATURES_CONFIG,
    value: { ...STATSIG_DEFAULT_FEATURE_OVERRIDES },
    rule_id: "gateway_override",
    secondary_exposures: [],
  };
  return {
    has_updates: true,
    time: Date.now(),
    hash_used: "djb2",
    feature_gates,
    dynamic_configs,
    layer_configs: {
      [STATSIG_I18N_LAYER_CONFIG]: {
        name: STATSIG_I18N_LAYER_CONFIG,
        value: { ...STATSIG_I18N_LAYER_VALUES },
        rule_id: "gateway_override",
        secondary_exposures: [],
      },
    },
    param_stores: {},
    exposures: {},
    sdk_flags: {},
  };
}

/** 判断值是否为普通对象；很多 IPC payload 都需要先做这个防御性判断。 */
function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 在 Statsig feature gate 快照里强制开启 Web 版需要的能力开关。 */
function setStatsigGateEnabled(container, gateName) {
  if (!isPlainObject(container)) return false;
  const existing = isPlainObject(container[gateName]) ? container[gateName] : {};
  const next = {
    name: gateName,
    value: true,
    rule_id: existing.rule_id || "gateway_override",
    secondary_exposures: Array.isArray(existing.secondary_exposures) ? existing.secondary_exposures : [],
    ...existing,
    value: true,
  };
  if (JSON.stringify(existing) === JSON.stringify(next)) return false;
  container[gateName] = next;
  return true;
}

/** 在 Statsig dynamic config 中写入特性值，保持和官方 renderer 读取路径一致。 */
function setStatsigDynamicConfigValue(container, configName, key, value) {
  if (!isPlainObject(container)) return false;
  const existing = isPlainObject(container[configName]) ? container[configName] : {};
  const existingValue = isPlainObject(existing.value) ? existing.value : {};
  const nextValue = {
    ...existingValue,
    [key]: value,
  };
  const next = {
    name: configName,
    rule_id: existing.rule_id || "gateway_override",
    secondary_exposures: Array.isArray(existing.secondary_exposures) ? existing.secondary_exposures : [],
    ...existing,
    value: nextValue,
  };
  if (JSON.stringify(existing) === JSON.stringify(next)) return false;
  container[configName] = next;
  return true;
}

/** 在 Statsig layer config 里写入实验参数；官方 i18n 当前从 layer 72216192 读取。 */
function setStatsigLayerConfigValues(container, configName, values) {
  if (!isPlainObject(container)) return false;
  const existing = isPlainObject(container[configName]) ? container[configName] : {};
  const existingValue = isPlainObject(existing.value) ? existing.value : {};
  const nextValue = {
    ...existingValue,
    ...values,
  };
  const next = {
    name: configName,
    rule_id: existing.rule_id || "gateway_override",
    secondary_exposures: Array.isArray(existing.secondary_exposures) ? existing.secondary_exposures : [],
    ...existing,
    value: nextValue,
  };
  if (JSON.stringify(existing) === JSON.stringify(next)) return false;
  container[configName] = next;
  return true;
}

/** 拦截 statsig initialize 响应时补齐右侧预览、审批模式等 Web 必需能力。 */
function patchStatsigDefaultFeatures(bodyText) {
  if (typeof bodyText !== "string" || bodyText.length === 0) return null;
  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;

  let changed = false;
  for (const key of ["feature_gates", "featureGates", "gates"]) {
    if (isPlainObject(parsed[key])) {
      for (const gateName of Object.keys(STATSIG_DEFAULT_FEATURE_OVERRIDES)) {
        changed = setStatsigGateEnabled(parsed[key], gateName) || changed;
      }
    }
  }
  for (const key of ["dynamic_configs", "dynamicConfigs", "configs"]) {
    if (isPlainObject(parsed[key])) {
      for (const [featureName, enabled] of Object.entries(STATSIG_DEFAULT_FEATURE_OVERRIDES)) {
        changed =
          setStatsigDynamicConfigValue(
            parsed[key],
            STATSIG_DEFAULT_FEATURES_CONFIG,
            featureName,
            enabled
          ) || changed;
      }
    }
  }
  if (!isPlainObject(parsed.feature_gates)) {
    parsed.feature_gates = {};
    changed = true;
  }
  if (!isPlainObject(parsed.dynamic_configs)) {
    parsed.dynamic_configs = {};
    changed = true;
  }
  if (!isPlainObject(parsed.layer_configs)) {
    parsed.layer_configs = {};
    changed = true;
  }
  for (const [featureName, enabled] of Object.entries(STATSIG_DEFAULT_FEATURE_OVERRIDES)) {
    changed = setStatsigGateEnabled(parsed.feature_gates, featureName) || changed;
    changed =
      setStatsigDynamicConfigValue(
        parsed.dynamic_configs,
        STATSIG_DEFAULT_FEATURES_CONFIG,
        featureName,
        enabled
      ) || changed;
  }
  for (const key of ["layer_configs", "layerConfigs", "layers"]) {
    if (isPlainObject(parsed[key])) {
      changed =
        setStatsigLayerConfigValues(
          parsed[key],
          STATSIG_I18N_LAYER_CONFIG,
          STATSIG_I18N_LAYER_VALUES
        ) || changed;
    }
  }
  return changed ? JSON.stringify(parsed) : null;
}

/** 修正 shared-object 里的默认 feature snapshot。 */
function patchStatsigDefaultFeatureSnapshot(value) {
  const next = isPlainObject(value) ? { ...value } : {};
  let changed = false;
  for (const [featureName, enabled] of Object.entries(STATSIG_DEFAULT_FEATURE_OVERRIDES)) {
    if (next[featureName] !== enabled) {
      next[featureName] = enabled;
      changed = true;
    }
  }
  return changed ? next : value;
}

/** 把 Web 端需要的 feature flags 合并进 Codex config 结果。 */
function patchCodexConfigFeatureFlags(config) {
  if (!isPlainObject(config)) return config;
  const next = { ...config };
  for (const [featureName, enabled] of Object.entries(STATSIG_DEFAULT_FEATURE_OVERRIDES)) {
    next[`features.${featureName}`] = enabled;
  }
  next.features = {
    ...(isPlainObject(config.features) ? config.features : {}),
    ...STATSIG_DEFAULT_FEATURE_OVERRIDES,
  };
  return next;
}

/** 修正 config/read 返回值，确保 renderer 看到的是已补齐能力的配置。 */
function patchCodexConfigResult(result) {
  if (!isPlainObject(result)) return result;
  if (!isPlainObject(result.config)) return result;
  return {
    ...result,
    config: patchCodexConfigFeatureFlags(result.config),
  };
}

/** 官方 renderer 可能带上比本机 app-server 更靠前的 feature；不支持的项降级为 no-op。 */
function filterUnsupportedFeatureEnablements(payload) {
  if (!isPlainObject(payload) || !isPlainObject(payload.enablement)) {
    return { payload, removed: [], skipped: false };
  }
  const enablement = { ...payload.enablement };
  const removed = [];
  for (const featureName of Object.keys(enablement)) {
    if (APP_SERVER_UNSUPPORTED_FEATURE_ENABLEMENTS.has(featureName)) {
      removed.push(featureName);
      delete enablement[featureName];
    }
  }
  if (removed.length === 0) return { payload, removed, skipped: false };
  return {
    payload: { ...payload, enablement },
    removed,
    skipped: Object.keys(enablement).length === 0,
  };
}

/** 补齐权限 reviewer 选项，避免 Web 端只显示默认/完全权限。 */
function patchConfigRequirements(requirements) {
  const next = isPlainObject(requirements) ? { ...requirements } : {};
  const reviewers = next.allowedApprovalsReviewers;
  const nextReviewers = Array.isArray(reviewers) ? [...reviewers] : [...DEFAULT_ALLOWED_APPROVALS_REVIEWERS];
  for (const reviewer of DEFAULT_ALLOWED_APPROVALS_REVIEWERS) {
    if (!nextReviewers.includes(reviewer)) nextReviewers.push(reviewer);
  }
  if (Array.isArray(reviewers) && nextReviewers.length === reviewers.length) return requirements;
  return {
    ...next,
    allowedApprovalsReviewers: nextReviewers,
  };
}

/** 修正 configRequirements/read 的各种返回形态。 */
function patchConfigRequirementsResult(result) {
  if (!isPlainObject(result)) return { requirements: patchConfigRequirements(null) };
  if ("requirements" in result) {
    return {
      ...result,
      requirements: patchConfigRequirements(result.requirements),
    };
  }
  return patchConfigRequirements(result);
}

module.exports = {
  APP_SERVER_UNSUPPORTED_FEATURE_ENABLEMENTS,
  DEFAULT_ALLOWED_APPROVALS_REVIEWERS,
  STATSIG_DEFAULT_FEATURE_OVERRIDES,
  STATSIG_DEFAULT_FEATURES_CONFIG,
  STATSIG_I18N_LAYER_CONFIG,
  STATSIG_I18N_LAYER_VALUES,
  filterUnsupportedFeatureEnablements,
  isPlainObject,
  patchCodexConfigFeatureFlags,
  patchCodexConfigResult,
  patchConfigRequirements,
  patchConfigRequirementsResult,
  patchStatsigDefaultFeatureSnapshot,
  patchStatsigDefaultFeatures,
  buildStatsigDefaultInitializeResponse,
};
