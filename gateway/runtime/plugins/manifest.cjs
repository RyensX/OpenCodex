const fs = require("fs");
const path = require("path");
const { authorizedCoreFeature, isRegisteredCoreFeature } = require("./feature-registry.cjs");

const PLUGIN_MANIFEST_FILE = "plugin.json";
const SETTING_TYPES = new Set(["boolean", "string", "select", "model", "reasoning-effort"]);
const SAFE_PLUGIN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value || {}, key);
}

function normalizeOption(option) {
  if (typeof option === "string") return { label: option, value: option };
  if (!option || typeof option !== "object" || typeof option.value !== "string") return null;
  return {
    label: String(option.label || option.value),
    labelKey: String(option.labelKey || ""),
    value: option.value,
  };
}

function normalizeDefaultValue(setting, type) {
  if (type === "boolean") return setting.defaultValue !== false;
  if (type === "select") {
    const options = (Array.isArray(setting.options) ? setting.options : []).map(normalizeOption).filter(Boolean);
    const requested = typeof setting.defaultValue === "string" ? setting.defaultValue : "";
    return options.some((option) => option.value === requested) ? requested : options[0]?.value || "";
  }
  return typeof setting.defaultValue === "string" ? setting.defaultValue : "";
}

function normalizeSetting(setting, index) {
  if (!setting || typeof setting !== "object" || !SAFE_PLUGIN_ID.test(String(setting.id || ""))) return null;
  const type = SETTING_TYPES.has(setting.type) ? setting.type : "boolean";
  const order = Number(setting.order);
  const normalized = {
    id: String(setting.id),
    type,
    label: String(setting.label || setting.id),
    labelKey: String(setting.labelKey || ""),
    description: String(setting.description || ""),
    descriptionKey: String(setting.descriptionKey || ""),
    defaultValue: normalizeDefaultValue(setting, type),
    order: Number.isFinite(order) ? order : 1000 + index,
  };
  if (type === "select") {
    normalized.options = (Array.isArray(setting.options) ? setting.options : []).map(normalizeOption).filter(Boolean);
  }
  return normalized;
}

function normalizePluginManifest(entry, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id = String(value.id || "");
  if (!SAFE_PLUGIN_ID.test(id)) return null;
  const requestedFeature = typeof value.feature === "string" ? value.feature.trim() : "";
  const feature = authorizedCoreFeature(entry, value);
  if (requestedFeature && isRegisteredCoreFeature(requestedFeature) && !feature) {
    // 已注册核心 feature 只接受代码内绑定的内置提供者，外部同名声明直接失效。
    console.warn(`[gateway] plugin core feature rejected: ${id} -> ${requestedFeature}`);
  }
  const order = Number(value.order);
  const settings = (Array.isArray(value.settings) ? value.settings : [])
    .map(normalizeSetting)
    .filter(Boolean)
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
  return {
    id,
    name: String(value.name || id),
    label: String(value.label || value.name || id),
    labelKey: String(value.labelKey || ""),
    desc: String(value.desc || value.description || ""),
    descKey: String(value.descKey || ""),
    defaultEnabled: value.defaultEnabled === true,
    builtin: entry?.sourceId === "builtin",
    feature,
    persistence: feature && value.persistence === "gateway" ? "gateway" : "browser",
    surface: String(value.surface || "renderer"),
    order: Number.isFinite(order) ? order : 1000,
    settings,
  };
}

function readPluginManifest(entry, manifestFile) {
  if (!manifestFile) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestFile, "utf-8"));
    return normalizePluginManifest(entry, parsed);
  } catch (error) {
    console.warn(
      "[gateway] plugin manifest skipped:",
      entry?.name || path.basename(path.dirname(manifestFile)),
      error instanceof Error ? error.message : String(error)
    );
    return null;
  }
}

function pluginManifestFile(pluginDir) {
  return path.join(pluginDir, PLUGIN_MANIFEST_FILE);
}

module.exports = {
  PLUGIN_MANIFEST_FILE,
  SETTING_TYPES,
  hasOwn,
  normalizePluginManifest,
  pluginManifestFile,
  readPluginManifest,
};
