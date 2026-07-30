(function () {
  const w = window;
  if (w.OpenCodexPluginSystem) return;

  // 继续复用旧设置存储，插件化后不会丢失用户已有开关状态。
  const SETTINGS_STORAGE_KEY = "opencodex_web_settings_v1";
  const plugins = new Map();
  const settingDescriptors = new Map();
  const listeners = new Map();
  const activeScopes = new Map();
  const SETTING_TYPES = new Set(["boolean", "string", "select", "model", "reasoning-effort"]);

  function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object || {}, key);
  }

  function emit(eventName, payload) {
    const handlers = listeners.get(eventName);
    if (!handlers) return;
    for (const handler of Array.from(handlers)) {
      try {
        handler(payload);
      } catch (error) {
        console.warn("[opencodex-plugin] event handler failed", eventName, error);
      }
    }
  }

  function on(eventName, handler) {
    if (typeof handler !== "function") return () => {};
    if (!listeners.has(eventName)) listeners.set(eventName, new Set());
    const handlers = listeners.get(eventName);
    handlers.add(handler);
    return () => handlers.delete(handler);
  }

  function normalizeSetting(plugin, setting, index) {
    if (!setting || !setting.id) return null;
    const order = Number(setting.order);
    const type = SETTING_TYPES.has(setting.type) ? setting.type : "boolean";
    const options = Array.isArray(setting.options)
      ? setting.options
          .map((option) =>
            typeof option === "string"
              ? { label: option, value: option }
              : option && typeof option.value === "string"
                ? {
                    label: String(option.label || option.value),
                    labelKey: String(option.labelKey || ""),
                    value: option.value,
                  }
                : null
          )
          .filter(Boolean)
      : [];
    // 非布尔设置必须保留 manifest 中的原始标量默认值，不能再统一转换成 true/false。
    const defaultValue =
      type === "boolean"
        ? setting.defaultValue !== false
        : type === "select"
          ? options.some((option) => option.value === setting.defaultValue)
            ? setting.defaultValue
            : options[0]?.value || ""
          : typeof setting.defaultValue === "string"
            ? setting.defaultValue
            : "";
    return {
      pluginId: plugin.id,
      id: String(setting.id),
      storageKey: String(setting.storageKey || setting.id),
      labelKey: String(setting.labelKey || ""),
      label: String(setting.label || setting.id),
      description: String(setting.description || ""),
      descriptionKey: String(setting.descriptionKey || ""),
      type,
      options,
      defaultValue,
      surface: setting.surface || "web",
      order: Number.isFinite(order) ? order : 1000 + index,
    };
  }

  function pluginEnableStorageKey(plugin) {
    return String(plugin?.enableStorageKey || `plugin.${plugin?.id || "unknown"}.enabled`);
  }

  function pluginLabel(plugin) {
    return String(plugin?.label || plugin?.name || plugin?.id || "");
  }

  function pluginDescription(plugin) {
    return String(plugin?.desc || "");
  }

  function pluginDefaultEnabled(plugin) {
    // defaultEnabled 是插件总开关的默认值；未声明时保持向后兼容，默认启用。
    return hasOwn(plugin, "defaultEnabled") ? plugin.defaultEnabled !== false : true;
  }

  function registerSetting(plugin, setting, index) {
    const descriptor = normalizeSetting(plugin, setting, index);
    if (!descriptor) return;
    settingDescriptors.set(descriptor.id, descriptor);
  }

  function registerPlugin(plugin) {
    if (!plugin || !plugin.id) return null;
    // 插件先贡献元信息和设置项；运行阶段再由 host 按 scope 激活具体能力。
    const order = Number(plugin.order);
    const normalized = {
      ...plugin,
      id: String(plugin.id),
      builtin: plugin.builtin === true,
      defaultEnabled: pluginDefaultEnabled(plugin),
      desc: pluginDescription(plugin),
      descKey: String(plugin.descKey || ""),
      enableStorageKey: String(plugin.enableStorageKey || `plugin.${plugin.id}.enabled`),
      feature: String(plugin.feature || ""),
      label: pluginLabel(plugin),
      labelKey: String(plugin.labelKey || ""),
      order: Number.isFinite(order) ? order : 1000 + plugins.size,
      persistence: plugin.persistence === "gateway" ? "gateway" : "browser",
      settings: Array.isArray(plugin.settings) ? plugin.settings : [],
      surface: String(plugin.surface || "web"),
    };
    plugins.set(normalized.id, normalized);
    normalized.settings.forEach((setting, index) => registerSetting(normalized, setting, index));
    for (const activation of activeScopes.values()) {
      activatePlugin(normalized, activation);
    }
    return normalized;
  }

  function listSettings(options = {}) {
    const surface = options.surface || "";
    return Array.from(settingDescriptors.values())
      .filter((setting) => !surface || setting.surface === surface || setting.surface === "all")
      .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
  }

  function listPlugins() {
    return Array.from(plugins.values())
      .map((plugin) => ({
        builtin: plugin.builtin,
        defaultEnabled: plugin.defaultEnabled,
        desc: plugin.desc,
        descKey: plugin.descKey,
        enableStorageKey: plugin.enableStorageKey,
        enabled: isPluginEnabled(plugin.id),
        feature: plugin.feature,
        id: plugin.id,
        label: plugin.label,
        labelKey: plugin.labelKey,
        name: plugin.name || plugin.id,
        order: plugin.order,
        persistence: plugin.persistence,
        settings: plugin.settings,
        surface: plugin.surface,
      }))
      .sort((left, right) => left.order - right.order || left.label.localeCompare(right.label) || left.id.localeCompare(right.id));
  }

  function descriptorFor(settingId) {
    return settingDescriptors.get(String(settingId || ""));
  }

  function storageKeyFor(settingId) {
    const descriptor = descriptorFor(settingId);
    return descriptor ? descriptor.storageKey : String(settingId || "");
  }

  function defaultPreferences() {
    // 默认值以插件声明为准，实际落盘仍然按 storageKey 展开。
    const defaults = {};
    for (const plugin of plugins.values()) {
      defaults[pluginEnableStorageKey(plugin)] = plugin.defaultEnabled !== false;
    }
    for (const setting of settingDescriptors.values()) {
      defaults[setting.storageKey] = setting.defaultValue;
    }
    return defaults;
  }

  function loadPreferences() {
    const defaults = defaultPreferences();
    try {
      const parsed = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) || "{}");
      return {
        ...defaults,
        ...(parsed && typeof parsed === "object" ? parsed : {}),
      };
    } catch {
      return { ...defaults };
    }
  }

  function savePreferences(nextPreferences) {
    try {
      localStorage.setItem(
        SETTINGS_STORAGE_KEY,
        JSON.stringify({
          ...defaultPreferences(),
          ...(nextPreferences && typeof nextPreferences === "object" ? nextPreferences : {}),
        })
      );
    } catch {}
  }

  function preferenceValue(settingId) {
    const descriptor = descriptorFor(settingId);
    const storageKey = storageKeyFor(settingId);
    const preferences = loadPreferences();
    if (hasOwn(preferences, storageKey)) return preferences[storageKey];
    return descriptor ? descriptor.defaultValue : undefined;
  }

  function setPreference(settingId, value) {
    const storageKey = storageKeyFor(settingId);
    if (!storageKey) return;
    const preferences = loadPreferences();
    preferences[storageKey] = value;
    savePreferences(preferences);
    emit("preference:changed", { id: String(settingId), storageKey, value });
  }

  function isPreferenceEnabled(settingId) {
    return preferenceValue(settingId) !== false;
  }

  function isPluginEnabled(pluginId) {
    const plugin = plugins.get(String(pluginId || ""));
    if (!plugin) return false;
    const storageKey = pluginEnableStorageKey(plugin);
    const preferences = loadPreferences();
    return preferences[storageKey] !== false;
  }

  function setPluginEnabled(pluginId, enabled) {
    const plugin = plugins.get(String(pluginId || ""));
    if (!plugin) return;
    const value = enabled !== false;
    const storageKey = pluginEnableStorageKey(plugin);
    const preferences = loadPreferences();
    preferences[storageKey] = value;
    savePreferences(preferences);
    emit("plugin:enabled-changed", { enabled: value, id: plugin.id, storageKey });
    emit("preference:changed", { id: `plugin.${plugin.id}.enabled`, storageKey, value });
    for (const activation of activeScopes.values()) {
      if (value) {
        activatePlugin(plugin, activation);
      } else {
        deactivatePlugin(plugin.id, activation);
      }
    }
  }

  function createContext(scope, capabilities, plugin) {
    const safeCapabilities = capabilities && typeof capabilities === "object" ? capabilities : {};
    // context 是插件可见边界，避免插件直接依赖页面内部实现细节。
    return {
      scope,
      capabilities: safeCapabilities,
      events: { emit, on },
      plugin: {
        id: plugin.id,
        isEnabled() {
          return isPluginEnabled(plugin.id);
        },
      },
      preferences: {
        defaults: defaultPreferences,
        get: preferenceValue,
        isEnabled: isPreferenceEnabled,
        load: loadPreferences,
        save: savePreferences,
        set: setPreference,
      },
      settings: {
        list: listSettings,
        register(setting) {
          registerSetting(plugin, setting, settingDescriptors.size);
        },
      },
      platform: {
        isMobile() {
          const isMobile = safeCapabilities.platform && safeCapabilities.platform.isMobile;
          return typeof isMobile === "function" ? !!isMobile() : false;
        },
      },
    };
  }

  function activatePlugin(plugin, activation) {
    if (!plugin || typeof plugin.activate !== "function" || activation.pluginDisposers.has(plugin.id)) return;
    if (!isPluginEnabled(plugin.id)) return;
    try {
      const context = createContext(activation.scope, activation.capabilities, plugin);
      const dispose = plugin.activate(context);
      activation.pluginDisposers.set(plugin.id, typeof dispose === "function" ? dispose : null);
    } catch (error) {
      console.warn("[opencodex-plugin] activation failed", plugin.id, error);
    }
  }

  function deactivatePlugin(pluginId, activation) {
    if (!activation.pluginDisposers.has(pluginId)) return;
    const dispose = activation.pluginDisposers.get(pluginId);
    activation.pluginDisposers.delete(pluginId);
    if (typeof dispose !== "function") return;
    try {
      dispose();
    } catch (error) {
      console.warn("[opencodex-plugin] dispose failed", pluginId, error);
    }
  }

  function activate(scope, capabilities) {
    const scopeName = String(scope || "default");
    if (activeScopes.has(scopeName)) return activeScopes.get(scopeName);
    // 同一个 scope 只激活一次，防止重复注册 DOM 监听或重复 patch 原型方法。
    const activation = {
      capabilities,
      pluginDisposers: new Map(),
      scope: scopeName,
      dispose() {
        for (const pluginId of Array.from(activation.pluginDisposers.keys())) {
          deactivatePlugin(pluginId, activation);
        }
        activeScopes.delete(scopeName);
      },
    };
    activeScopes.set(scopeName, activation);
    for (const plugin of plugins.values()) {
      activatePlugin(plugin, activation);
    }
    return activation;
  }

  const api = Object.freeze({
    SETTINGS_STORAGE_KEY,
    activate,
    events: Object.freeze({ emit, on }),
    preferences: Object.freeze({
      defaults: defaultPreferences,
      get: preferenceValue,
      isEnabled: isPreferenceEnabled,
      load: loadPreferences,
      save: savePreferences,
      set: setPreference,
    }),
    plugins: Object.freeze({
      isEnabled: isPluginEnabled,
      list: listPlugins,
      setEnabled: setPluginEnabled,
    }),
    registerPlugin,
    settings: Object.freeze({
      list: listSettings,
      storageKeyFor,
    }),
  });

  w.OpenCodexPluginSystem = api;
  w.__OpenCodexPluginSystem = api;
})();
