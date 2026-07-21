const {
  AUTO_DISPLAY_NAME,
  AUTO_MODEL_ID,
  AUTO_PLACEHOLDER_EFFORT,
} = require("./constants.cjs");

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function requestKey(id) {
  return `${typeof id}:${String(id)}`;
}

function isAuto(value) {
  return typeof value === "string" && value.toLowerCase() === AUTO_MODEL_ID;
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value || {}, key);
}

function autoCatalogModel() {
  return {
    id: AUTO_MODEL_ID,
    model: AUTO_MODEL_ID,
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName: AUTO_DISPLAY_NAME,
    description: "Automatically selects a model and reasoning effort for every turn.",
    hidden: false,
    // Auto 的推理强度由网关逐轮决定，不向官方选择器暴露占位强度，避免出现无效的手动入口。
    supportedReasoningEfforts: [],
    defaultReasoningEffort: AUTO_PLACEHOLDER_EFFORT,
    inputModalities: ["text", "image"],
    supportsPersonality: true,
    additionalSpeedTiers: [],
    serviceTiers: [],
    defaultServiceTier: null,
    isDefault: false,
  };
}

function configuredModelInParams(params) {
  if (isAuto(params?.model)) return AUTO_MODEL_ID;
  if (typeof params?.model === "string" && params.model) return params.model;
  const collaborationModel = params?.collaborationMode?.settings?.model;
  if (isAuto(collaborationModel)) return AUTO_MODEL_ID;
  return typeof collaborationModel === "string" ? collaborationModel : "";
}

function configuredEffortInParams(params) {
  const collaborationEffort = params?.collaborationMode?.settings?.reasoning_effort;
  return typeof collaborationEffort === "string"
    ? collaborationEffort
    : typeof params?.effort === "string"
      ? params.effort
      : "";
}

function replaceModelOverrides(params, concrete) {
  if (!params || typeof params !== "object") return params;
  if (isAuto(params.model)) params.model = concrete.model;
  if (params.config && typeof params.config === "object") {
    if (isAuto(params.config.model)) params.config.model = concrete.model;
    if (isAuto(params.config.model_reasoning_effort) || concrete.ignoreIncomingEffort) {
      params.config.model_reasoning_effort = concrete.effort;
    }
  }
  if (params.collaborationMode?.settings && isAuto(params.collaborationMode.settings.model)) {
    params.collaborationMode.settings.model = concrete.model;
    params.collaborationMode.settings.reasoning_effort = concrete.effort;
  }
  if (concrete.ignoreIncomingEffort && hasOwn(params, "effort")) params.effort = concrete.effort;
  return params;
}

function virtualizeModelFields(value) {
  if (!value || typeof value !== "object") return value;
  const result = cloneJson(value);
  if (hasOwn(result, "model") && typeof result.model === "string") result.model = AUTO_MODEL_ID;
  if (hasOwn(result, "effort")) result.effort = AUTO_PLACEHOLDER_EFFORT;
  if (hasOwn(result, "reasoningEffort")) result.reasoningEffort = AUTO_PLACEHOLDER_EFFORT;
  if (result.collaborationMode?.settings) {
    result.collaborationMode.settings.model = AUTO_MODEL_ID;
    result.collaborationMode.settings.reasoning_effort = AUTO_PLACEHOLDER_EFFORT;
  }
  if (result.threadSettings && typeof result.threadSettings === "object") {
    // thread/settings/updated 把模型包在 threadSettings 内，需与直接响应使用同一虚拟视图。
    result.threadSettings = virtualizeModelFields(result.threadSettings);
  }
  return result;
}

function createVirtualModelController({ stateStore, isEnabled, fallbackRoute, catalog, onAutoModelInjected }) {
  const pending = new Map();

  function concreteForDefault() {
    const current = stateStore.defaultState();
    const fallback = fallbackRoute();
    return {
      model: current.lastModel || fallback.model,
      effort: current.lastEffort || fallback.effort,
    };
  }

  function concreteForThread(threadId) {
    const current = stateStore.threadState(threadId) || stateStore.defaultState();
    const fallback = fallbackRoute();
    return {
      model: current.lastModel || fallback.model,
      effort: current.lastEffort || fallback.effort,
    };
  }

  function prepareConfigValueWrite(message, meta) {
    const params = message.params || {};
    if (params.keyPath === "model") {
      const concrete = concreteForDefault();
      if (isAuto(params.value)) {
        stateStore.setDefaultAuto(true, concrete);
        params.value = concrete.model;
        meta.auto = true;
      } else if (typeof params.value === "string" && params.value) {
        stateStore.setDefaultAuto(false, { model: params.value });
      }
    } else if (params.keyPath === "model_reasoning_effort" && stateStore.isDefaultAuto()) {
      params.value = concreteForDefault().effort;
    } else if (params.keyPath === "model_reasoning_effort" && typeof params.value === "string") {
      stateStore.setDefaultAuto(false, { effort: params.value });
    }
  }

  function prepareConfigBatchWrite(message, meta) {
    const edits = Array.isArray(message.params?.edits) ? message.params.edits : [];
    const modelEdit = edits.find((edit) => edit?.keyPath === "model");
    const effortEdit = edits.find((edit) => edit?.keyPath === "model_reasoning_effort");
    const concrete = concreteForDefault();
    if (modelEdit && isAuto(modelEdit.value)) {
      stateStore.setDefaultAuto(true, concrete);
      modelEdit.value = concrete.model;
      if (effortEdit) effortEdit.value = concrete.effort;
      meta.auto = true;
      return;
    }
    if (modelEdit && typeof modelEdit.value === "string" && modelEdit.value) {
      stateStore.setDefaultAuto(false, {
        model: modelEdit.value,
        effort: typeof effortEdit?.value === "string" ? effortEdit.value : "",
      });
      return;
    }
    if (stateStore.isDefaultAuto() && effortEdit) effortEdit.value = concrete.effort;
  }

  function prepareThreadLifecycle(message, meta) {
    const params = message.params || {};
    const sourceThreadId = params.threadId || "";
    const explicitModel = configuredModelInParams(params);
    const configModel = params.config?.model;
    meta.ephemeral = params.ephemeral === true;
    const explicitlyAuto = isAuto(explicitModel) || isAuto(configModel);
    /**
     * 官方 Main 会为标题等后台工作创建 ephemeral 线程；它们不是用户会话，不能继承新会话的 Auto 默认值。
     * 即使上层从虚拟配置携带了 auto，也只会在 concrete guard 中下沉真实模型，不进入逐轮分类状态。
     */
    const mayInheritAuto = params.ephemeral !== true;
    const inheritedAuto = mayInheritAuto
      ? message.method === "thread/start"
        ? stateStore.isDefaultAuto()
        : sourceThreadId
          ? stateStore.isThreadAuto(sourceThreadId)
          : stateStore.isDefaultAuto()
      : false;
    const concrete = sourceThreadId ? concreteForThread(sourceThreadId) : concreteForDefault();
    const explicitMatchesUnderlying =
      (!explicitModel || explicitModel === concrete.model) && (!configModel || configModel === concrete.model);
    // 官方 Main 可能仍携带被虚拟层保留的真实模型；它等于 lastModel 时仍应继承持久化 Auto。
    const requestedAuto = explicitlyAuto || (inheritedAuto && explicitMatchesUnderlying);
    const auto = params.ephemeral === true ? false : requestedAuto;
    meta.auto = auto;
    meta.sourceThreadId = sourceThreadId;
    meta.concrete = requestedAuto
      ? concrete
      : {
          model: explicitModel || (typeof configModel === "string" ? configModel : "") || concrete.model,
          effort:
            configuredEffortInParams(params) ||
            (typeof params.config?.model_reasoning_effort === "string" ? params.config.model_reasoning_effort : "") ||
            concrete.effort,
        };
    if (requestedAuto) {
      if (!params.model) params.model = concrete.model;
      replaceModelOverrides(params, { ...concrete, ignoreIncomingEffort: true });
      params.config = params.config && typeof params.config === "object" ? params.config : {};
      params.config.model = concrete.model;
      params.config.model_reasoning_effort = concrete.effort;
    } else if (sourceThreadId && explicitModel) {
      stateStore.setThreadAuto(sourceThreadId, false, {
        model: explicitModel,
        effort: configuredEffortInParams(params),
      });
    }
  }

  function prepareThreadSettings(message, meta) {
    const params = message.params || {};
    const threadId = String(params.threadId || "");
    const previous = stateStore.threadState(threadId);
    const explicitModel = configuredModelInParams(params);
    const concrete = concreteForThread(threadId);
    meta.threadId = threadId;
    meta.previous = previous;
    if (isAuto(explicitModel)) {
      stateStore.setThreadAuto(threadId, true, concrete);
      replaceModelOverrides(params, { ...concrete, ignoreIncomingEffort: true });
      meta.auto = true;
    } else if (explicitModel) {
      stateStore.setThreadAuto(threadId, false, {
        model: explicitModel,
        effort: configuredEffortInParams(params),
      });
      meta.auto = false;
    } else if (stateStore.isThreadAuto(threadId) && hasOwn(params, "effort")) {
      params.effort = concrete.effort;
      meta.auto = true;
    } else {
      meta.auto = stateStore.isThreadAuto(threadId);
    }
  }

  function prepareTurnStart(message, meta) {
    const params = message.params || {};
    const threadId = String(params.threadId || "");
    const explicitModel = configuredModelInParams(params);
    const concrete = concreteForThread(threadId);
    if (isAuto(explicitModel)) {
      stateStore.setThreadAuto(threadId, true, concrete);
      replaceModelOverrides(params, { ...concrete, ignoreIncomingEffort: true });
    } else if (
      explicitModel &&
      stateStore.isThreadAuto(threadId) &&
      explicitModel !== concrete.model
    ) {
      // Auto 路由后的真实 model 会等于 lastModel；只有不同的显式 model 才代表用户改回手动选择。
      stateStore.setThreadAuto(threadId, false, {
        model: explicitModel,
        effort: configuredEffortInParams(params),
      });
    }
    meta.threadId = threadId;
    meta.autoTurn = isEnabled() && stateStore.isThreadAuto(threadId);
    meta.concrete = concrete;
  }

  function prepareClientMessage(original) {
    if (!original || typeof original !== "object" || typeof original.method !== "string") {
      return { message: original, autoTurn: false };
    }
    const message = cloneJson(original);
    const meta = { method: message.method };
    if (message.method === "model/list") meta.cursor = message.params?.cursor || "";
    if (isEnabled()) {
      if (message.method === "config/value/write") prepareConfigValueWrite(message, meta);
      else if (message.method === "config/batchWrite") prepareConfigBatchWrite(message, meta);
      else if (["thread/start", "thread/resume", "thread/fork"].includes(message.method)) {
        prepareThreadLifecycle(message, meta);
      } else if (message.method === "thread/settings/update") prepareThreadSettings(message, meta);
      else if (message.method === "turn/start") prepareTurnStart(message, meta);
    }
    if (message.method === "thread/delete") meta.threadId = String(message.params?.threadId || "");
    if (message.id != null) pending.set(requestKey(message.id), meta);
    return { message, autoTurn: meta.autoTurn === true, meta };
  }

  function injectAutoModel(result, cursor) {
    if (!isEnabled() || cursor || !result || !Array.isArray(result.data)) return result;
    if (result.data.some((model) => isAuto(model?.id) || isAuto(model?.model))) return result;
    const injected = { ...result, data: [autoCatalogModel(), ...result.data] };
    // 只在 Auto 实际写入官方 model/list 首页面时回执，不能把脚本加载误报成协议注入成功。
    if (typeof onAutoModelInjected === "function") onAutoModelInjected();
    return injected;
  }

  function virtualizeConfigRead(result) {
    if (!isEnabled() || !stateStore.isDefaultAuto() || !result?.config) return result;
    const next = cloneJson(result);
    next.config.model = AUTO_MODEL_ID;
    next.config.model_reasoning_effort = AUTO_PLACEHOLDER_EFFORT;
    return next;
  }

  function observeConcreteConfig(result) {
    const model = result?.config?.model;
    const effort = result?.config?.model_reasoning_effort;
    if (typeof model !== "string" || !model || isAuto(model)) return;
    // 先记住官方配置中的真实选择，首次切到 Auto 时才能保留用户当前模型而不是直接退回默认 fallback。
    stateStore.setDefaultAuto(stateStore.isDefaultAuto(), {
      model,
      effort: typeof effort === "string" ? effort : "",
    });
  }

  function processServerResponse(original) {
    if (!original || typeof original !== "object" || original.id == null) return original;
    const key = requestKey(original.id);
    const meta = pending.get(key);
    if (!meta) return original;
    pending.delete(key);
    if (original.error) {
      if (meta.method === "thread/settings/update" && meta.threadId && isEnabled()) {
        if (meta.previous) {
          stateStore.setThreadAuto(meta.threadId, meta.previous.auto, {
            model: meta.previous.lastModel,
            effort: meta.previous.lastEffort,
          });
        } else {
          stateStore.removeThread(meta.threadId);
        }
      }
      return original;
    }

    let message = cloneJson(original);
    if (meta.method === "model/list") {
      catalog.observePage({ cursor: meta.cursor, result: message.result });
      message.result = injectAutoModel(message.result, meta.cursor);
    } else if (meta.method === "config/read") {
      observeConcreteConfig(message.result);
      message.result = virtualizeConfigRead(message.result);
    } else if (["thread/start", "thread/resume", "thread/fork"].includes(meta.method)) {
      const threadId = String(message.result?.thread?.id || message.result?.threadId || meta.sourceThreadId || "");
      if (threadId && meta.auto !== undefined && meta.ephemeral !== true) {
        const activeAuto = isEnabled() && meta.auto === true;
        stateStore.setThreadAuto(threadId, activeAuto, meta.concrete || {});
        if (activeAuto) message.result = virtualizeModelFields(message.result);
      }
    } else if (meta.method === "thread/settings/update" && meta.auto && meta.threadId) {
      message.result = virtualizeModelFields(message.result);
    } else if (meta.method === "thread/delete" && meta.threadId) {
      stateStore.removeThread(meta.threadId);
    } else if (meta.threadId && stateStore.isThreadAuto(meta.threadId)) {
      message.result = virtualizeModelFields(message.result);
    }
    return message;
  }

  function processServerNotification(original) {
    if (!original || typeof original !== "object" || typeof original.method !== "string") return original;
    const params = original.params;
    const threadId = String(params?.threadId || params?.thread?.id || "");
    if (original.method === "turn/completed" && threadId) {
      stateStore.recordStatus(threadId, params?.turn?.status || "");
    }
    if (original.method === "thread/deleted" && threadId) {
      stateStore.removeThread(threadId);
    }
    if (isEnabled() && threadId && stateStore.isThreadAuto(threadId)) {
      return { ...original, params: virtualizeModelFields(params) };
    }
    if (isEnabled() && original.method.startsWith("config/") && stateStore.isDefaultAuto() && params?.config) {
      return { ...original, params: virtualizeConfigRead(params) };
    }
    return original;
  }

  return {
    autoCatalogModel,
    concreteForThread,
    injectAutoModel,
    prepareClientMessage,
    processServerMessage(message) {
      return message?.id != null ? processServerResponse(message) : processServerNotification(message);
    },
    virtualizeModelFields,
  };
}

module.exports = {
  autoCatalogModel,
  cloneJson,
  configuredEffortInParams,
  configuredModelInParams,
  createVirtualModelController,
  isAuto,
  replaceModelOverrides,
  requestKey,
  virtualizeModelFields,
};
