// @ts-nocheck
export {};

/** 写 mcp 配置前清理空字符串/null，减少无效配置项。 */
function stripEmptyConfigValues(value) {
  if (value == null) return undefined;
  if (typeof value === "string" && value.length === 0) return undefined;
  if (Array.isArray(value)) {
    return value
      .map((item) => stripEmptyConfigValues(item))
      .filter((item) => item !== undefined);
  }
  if (typeof value !== "object") return value;
  const entries = Object.entries(value)
    .map(([key, item]) => [key, stripEmptyConfigValues(item)])
    .filter(([, item]) => item !== undefined);
  return Object.fromEntries(entries);
}

/** 归一化 mcp-codex-config 结构，避免 project_root_markers/agents 类型不合法。 */
function normalizeMcpCodexConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) return config;
  const normalized = stripEmptyConfigValues(config) || {};
  const markers = normalized.project_root_markers;
  if (markers == null) {
    delete normalized.project_root_markers;
  } else if (Array.isArray(markers)) {
    normalized.project_root_markers = markers.filter((marker) => typeof marker === "string");
  } else if (typeof markers === "string") {
    normalized.project_root_markers = markers
      .split(/[\n,]/)
      .map((marker) => marker.trim())
      .filter(Boolean);
  } else {
    delete normalized.project_root_markers;
  }
  if (normalized.agents != null && (typeof normalized.agents !== "object" || Array.isArray(normalized.agents))) {
    delete normalized.agents;
  }
  return normalized;
}

module.exports = {
  normalizeMcpCodexConfig,
};
