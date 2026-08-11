const AUTO_MODEL_ID = "auto";
const AUTO_REASONING_EFFORT = "auto";
const AUTO_DISPLAY_NAME = "Auto";
const AUTO_PLACEHOLDER_EFFORT = "medium";
const SMART_ROUTER_PLUGIN_ID = "opencodex.smart-model-router";
const ROUTER_REQUEST_PREFIX = "opencodex.router:";
const CLASSIFICATION_TIMEOUT_MS = 20_000;
const CLASSIFICATION_MAX_CONCURRENCY = 2;
// 历史回合数量由插件配置覆盖；配置缺失或损坏时统一回退到这里的默认值。
const HISTORY_USER_INPUT_LIMIT = 3;
const HISTORY_USER_INPUT_LIMIT_MIN = 1;
const HISTORY_USER_INPUT_LIMIT_MAX = 20;

const TIER_ORDER = Object.freeze(["economy", "balanced", "complex", "frontier"]);
const EFFORT_ORDER = Object.freeze(["low", "medium", "high", "xhigh", "max", "ultra"]);
const BUILTIN_ROUTE_DEFAULTS = Object.freeze({
  classifier: Object.freeze({ model: "gpt-5.3-codex-spark", effort: "low" }),
  economy: Object.freeze({ model: "gpt-5.6-luna", effort: "auto" }),
  balanced: Object.freeze({ model: "gpt-5.6-luna", effort: "max" }),
  complex: Object.freeze({ model: "gpt-5.6-sol", effort: "max" }),
  frontier: Object.freeze({ model: "gpt-5.6-sol", effort: "ultra" }),
  fallback: Object.freeze({ model: "gpt-5.3-codex-spark", effort: "low" }),
});

module.exports = {
  AUTO_DISPLAY_NAME,
  AUTO_MODEL_ID,
  AUTO_PLACEHOLDER_EFFORT,
  AUTO_REASONING_EFFORT,
  BUILTIN_ROUTE_DEFAULTS,
  CLASSIFICATION_MAX_CONCURRENCY,
  CLASSIFICATION_TIMEOUT_MS,
  EFFORT_ORDER,
  HISTORY_USER_INPUT_LIMIT,
  HISTORY_USER_INPUT_LIMIT_MAX,
  HISTORY_USER_INPUT_LIMIT_MIN,
  ROUTER_REQUEST_PREFIX,
  SMART_ROUTER_PLUGIN_ID,
  TIER_ORDER,
};
