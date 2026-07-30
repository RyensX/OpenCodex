const path = require("path");
const { RUNTIME_DIR } = require("../core/config.cjs");
const { listPluginManifests } = require("../core/plugin-assets.cjs");
const { createSmartModelRouterService } = require("../model-router/service.cjs");
const { createSmartSchedulingPresentation } = require("../model-router/presentation.cjs");
const { createInjectionHealthRegistry } = require("../model-router/injection-health.cjs");
const { createPluginConfigStore } = require("./config-store.cjs");

const PLUGIN_CONFIG_FILE = "opencodex-plugin-settings.json";
const SMART_ROUTER_STATE_FILE = "smart-model-router-state.json";

function createGatewayPluginService({ runtimeDir = RUNTIME_DIR, classifierOptions, getRuntimeIdentity } = {}) {
  const manifests = listPluginManifests();
  const configStore = createPluginConfigStore({
    filePath: path.join(runtimeDir, PLUGIN_CONFIG_FILE),
    manifests,
  });
  const injectionHealth = createInjectionHealthRegistry({ getRuntimeIdentity });
  const modelRouter = createSmartModelRouterService({
    configStore,
    stateFilePath: path.join(runtimeDir, SMART_ROUTER_STATE_FILE),
    classifierOptions,
    injectionHealth,
  });
  const stopInjectionHealthConfigListener = configStore.onChanged((event) => {
    if (event.id !== "opencodex.smart-model-router") return;
    if (event.previous.enabled !== event.current.enabled) {
      // Auto 目录项只在开关开启后的 model/list 中注入，切换开关后要求重新收到当前状态的回执。
      injectionHealth.resetGatewayPoint("auto-model-catalog");
    }
  });
  let smartSchedulingPresentation = null;
  return {
    configStore,
    injectionHealth,
    manifests,
    modelRouter,
    bindSmartSchedulingPresentation(options) {
      smartSchedulingPresentation?.dispose();
      smartSchedulingPresentation = createSmartSchedulingPresentation({ modelRouter, ...options });
      injectionHealth.reportGateway("route-presentation");
      return smartSchedulingPresentation;
    },
    get smartSchedulingPresentation() {
      return smartSchedulingPresentation;
    },
    dispose(error) {
      stopInjectionHealthConfigListener();
      smartSchedulingPresentation?.dispose();
      modelRouter.dispose(error);
    },
  };
}

module.exports = {
  PLUGIN_CONFIG_FILE,
  SMART_ROUTER_STATE_FILE,
  createGatewayPluginService,
};
