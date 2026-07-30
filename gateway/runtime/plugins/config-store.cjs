const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");
const {
  LEGACY_TIER_SETTING_IDS,
  SMART_ROUTER_PLUGIN_ID,
  normalizeStoredTierDefinitions,
  validateTierDefinitions,
} = require("../model-router/tiers.cjs");

const CONFIG_SCHEMA_VERSION = 3;
// reasoning-effort 是通用设置类型；auto 由具体核心能力在运行时解析为实际强度。
const REASONING_EFFORTS = new Set(["auto", "low", "medium", "high", "xhigh", "max", "ultra"]);
const LEGACY_SMART_ROUTER_EFFORT_DEFAULTS = Object.freeze({
  economyEffort: "low",
  balancedEffort: "medium",
  complexEffort: "high",
  frontierEffort: "xhigh",
  fallbackEffort: "low",
});

class PluginConfigError extends Error {
  constructor(message, status = 400, errorKey = "plugin_config_invalid") {
    super(message);
    this.name = "PluginConfigError";
    this.status = status;
    this.errorKey = errorKey;
  }
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value || {}, key);
}

function defaultValuesForManifest(manifest) {
  const values = {};
  for (const setting of manifest.settings || []) values[setting.id] = setting.defaultValue;
  return values;
}

function normalizeStoredDocument(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const revision = Number(value.revision);
  const schemaVersion = Number(value.schemaVersion);
  return {
    schemaVersion: Number.isSafeInteger(schemaVersion) && schemaVersion >= 0 ? schemaVersion : 0,
    revision: Number.isSafeInteger(revision) && revision >= 0 ? revision : 0,
    plugins: value.plugins && typeof value.plugins === "object" && !Array.isArray(value.plugins) ? value.plugins : {},
  };
}

function migrateStoredDocument(document) {
  const plugins = { ...document.plugins };
  const router = plugins[SMART_ROUTER_PLUGIN_ID];
  if (router && typeof router === "object" && router.values && typeof router.values === "object") {
    const values = { ...router.values };
    if (document.schemaVersion < 2) {
      // v2 将仍等于旧内置默认值的档位迁移到 Auto；非默认具体值视为用户选择并原样保留。
      for (const [id, legacyDefault] of Object.entries(LEGACY_SMART_ROUTER_EFFORT_DEFAULTS)) {
        if (values[id] === legacyDefault) values[id] = "auto";
      }
    }
    let tiers = router.tiers;
    if (document.schemaVersion < 3) {
      // v3 把扁平的四档模型/强度迁入有序档位列表，分类器和失败回退设置仍保留为普通字段。
      tiers = normalizeStoredTierDefinitions(tiers, values);
      for (const settingId of LEGACY_TIER_SETTING_IDS) delete values[settingId];
    }
    plugins[SMART_ROUTER_PLUGIN_ID] = {
      ...router,
      values,
      tiers: normalizeStoredTierDefinitions(tiers, values),
    };
  }
  return { ...document, schemaVersion: CONFIG_SCHEMA_VERSION, plugins };
}

function validateSettingValue(setting, value) {
  if (setting.type === "boolean") {
    if (typeof value !== "boolean") throw new PluginConfigError(`${setting.id} must be a boolean`);
    return value;
  }
  if (typeof value !== "string") throw new PluginConfigError(`${setting.id} must be a string`);
  if (setting.type === "model") {
    const model = value.trim();
    if (!model) throw new PluginConfigError(`${setting.id} must not be empty`);
    if (model.toLowerCase() === "auto") throw new PluginConfigError(`${setting.id} cannot target Auto`);
    return model;
  }
  if (setting.type === "reasoning-effort") {
    if (!REASONING_EFFORTS.has(value)) throw new PluginConfigError(`${setting.id} has an unsupported effort`);
    return value;
  }
  if (setting.type === "select") {
    const allowed = new Set((setting.options || []).map((option) => option.value));
    if (!allowed.has(value)) throw new PluginConfigError(`${setting.id} has an unsupported value`);
  }
  return value;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function createPluginConfigStore({ filePath, manifests }) {
  const gatewayManifests = (Array.isArray(manifests) ? manifests : []).filter(
    (manifest) => manifest?.persistence === "gateway" && manifest.feature
  );
  const manifestById = new Map(gatewayManifests.map((manifest) => [manifest.id, manifest]));
  const events = new EventEmitter();
  let document = loadDocument();

  function loadDocument() {
    try {
      if (!fs.existsSync(filePath)) return { schemaVersion: CONFIG_SCHEMA_VERSION, revision: 0, plugins: {} };
      const normalized = normalizeStoredDocument(JSON.parse(fs.readFileSync(filePath, "utf-8")));
      if (normalized) return migrateStoredDocument(normalized);
    } catch (error) {
      // 配置损坏时保留原文件供排障，本次启动使用 manifest 默认值，下一次成功修改会原子覆盖。
      console.warn("[gateway] plugin config ignored:", error instanceof Error ? error.message : String(error));
    }
    return { schemaVersion: CONFIG_SCHEMA_VERSION, revision: 0, plugins: {} };
  }

  function stateForManifest(manifest) {
    const stored = document.plugins[manifest.id];
    const values = defaultValuesForManifest(manifest);
    if (stored && typeof stored === "object" && stored.values && typeof stored.values === "object") {
      const settingById = new Map((manifest.settings || []).map((setting) => [setting.id, setting]));
      for (const [id, value] of Object.entries(stored.values)) {
        const setting = settingById.get(id);
        if (!setting) continue;
        try {
          values[id] = validateSettingValue(setting, value);
        } catch {}
      }
    }
    const state = {
      enabled: stored && typeof stored.enabled === "boolean" ? stored.enabled : manifest.defaultEnabled === true,
      values,
    };
    if (manifest.id === SMART_ROUTER_PLUGIN_ID) {
      // 快照始终返回完整的内置档位，旧配置和局部损坏不会让不可删除项从设置页消失。
      state.tiers = normalizeStoredTierDefinitions(stored?.tiers, stored?.values);
    }
    return state;
  }

  function plugin(id) {
    const manifest = manifestById.get(String(id || ""));
    if (!manifest) return null;
    return { ...stateForManifest(manifest), manifest };
  }

  function snapshot() {
    return {
      revision: document.revision,
      plugins: gatewayManifests
        .map((manifest) => ({
          ...cloneJson(manifest),
          ...stateForManifest(manifest),
        }))
        .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id)),
    };
  }

  function persist(nextDocument) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporaryPath = path.join(
      path.dirname(filePath),
      `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
    );
    // 临时文件与目标文件位于同一目录，rename 在常见文件系统上是原子的。
    fs.writeFileSync(temporaryPath, `${JSON.stringify(nextDocument, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
    try {
      fs.renameSync(temporaryPath, filePath);
    } catch (error) {
      try {
        fs.unlinkSync(temporaryPath);
      } catch {}
      throw error;
    }
  }

  function update(id, patch) {
    const manifest = manifestById.get(String(id || ""));
    if (!manifest) throw new PluginConfigError("Unknown gateway plugin", 404, "plugin_not_found");
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new PluginConfigError("Invalid request body");
    if (!Number.isSafeInteger(patch.expectedRevision) || patch.expectedRevision < 0) {
      throw new PluginConfigError("expectedRevision is required");
    }
    if (patch.expectedRevision !== document.revision) {
      throw new PluginConfigError("Plugin configuration revision conflict", 409, "plugin_config_revision_conflict");
    }

    const current = stateForManifest(manifest);
    const next = {
      enabled: current.enabled,
      values: { ...current.values },
      ...(current.tiers ? { tiers: cloneJson(current.tiers) } : {}),
    };
    if (hasOwn(patch, "enabled")) {
      if (typeof patch.enabled !== "boolean") throw new PluginConfigError("enabled must be a boolean");
      next.enabled = patch.enabled;
    }
    if (hasOwn(patch, "values")) {
      if (!patch.values || typeof patch.values !== "object" || Array.isArray(patch.values)) {
        throw new PluginConfigError("values must be an object");
      }
      const settingById = new Map((manifest.settings || []).map((setting) => [setting.id, setting]));
      for (const [settingId, value] of Object.entries(patch.values)) {
        const setting = settingById.get(settingId);
        if (!setting) throw new PluginConfigError(`Unknown setting: ${settingId}`);
        next.values[settingId] = validateSettingValue(setting, value);
      }
    }
    if (hasOwn(patch, "tiers")) {
      if (manifest.id !== SMART_ROUTER_PLUGIN_ID) throw new PluginConfigError("This plugin does not support tiers");
      try {
        next.tiers = validateTierDefinitions(patch.tiers);
      } catch (error) {
        throw new PluginConfigError(error instanceof Error ? error.message : String(error));
      }
    }

    const nextDocument = {
      schemaVersion: CONFIG_SCHEMA_VERSION,
      revision: document.revision + 1,
      plugins: { ...document.plugins, [manifest.id]: next },
    };
    persist(nextDocument);
    const previous = current;
    document = nextDocument;
    const value = snapshot();
    events.emit("changed", { id: manifest.id, previous, current: next, snapshot: value });
    return value;
  }

  return {
    filePath,
    manifests: gatewayManifests,
    onChanged(listener) {
      events.on("changed", listener);
      return () => events.off("changed", listener);
    },
    plugin,
    snapshot,
    update,
  };
}

module.exports = {
  CONFIG_SCHEMA_VERSION,
  PluginConfigError,
  REASONING_EFFORTS,
  createPluginConfigStore,
  defaultValuesForManifest,
  validateSettingValue,
};
