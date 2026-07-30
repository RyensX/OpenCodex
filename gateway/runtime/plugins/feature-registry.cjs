// 核心 feature 的授权关系固定在 OpenCodex 代码内，插件 manifest 只能引用，不能自行扩权。
const CORE_FEATURE_PROVIDERS = new Map([
  [
    "smart-model-router",
    Object.freeze({
      pluginId: "opencodex.smart-model-router",
      sourceId: "builtin",
    }),
  ],
]);

function authorizedCoreFeature(entry, manifest) {
  const feature = typeof manifest?.feature === "string" ? manifest.feature.trim() : "";
  if (!feature) return "";
  const provider = CORE_FEATURE_PROVIDERS.get(feature);
  if (!provider) return "";
  return provider.sourceId === entry?.sourceId && provider.pluginId === manifest?.id ? feature : "";
}

function isRegisteredCoreFeature(feature) {
  return CORE_FEATURE_PROVIDERS.has(String(feature || ""));
}

module.exports = {
  CORE_FEATURE_PROVIDERS,
  authorizedCoreFeature,
  isRegisteredCoreFeature,
};
