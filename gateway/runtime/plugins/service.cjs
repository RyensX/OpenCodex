const path = require("path");
const { RUNTIME_DIR } = require("../core/config.cjs");
const { listPluginManifests } = require("../core/plugin-assets.cjs");
const { createSmartModelRouterService } = require("../model-router/service.cjs");
const { createSmartSchedulingPresentation } = require("../model-router/presentation.cjs");
const { createInjectionHealthRegistry } = require("../model-router/injection-health.cjs");
const { createPluginConfigStore } = require("./config-store.cjs");

const PLUGIN_CONFIG_FILE = "opencodex-plugin-settings.json";
const SMART_ROUTER_STATE_FILE = "smart-model-router-state.json";
const SMART_ROUTER_COMPATIBILITY_POINTS = Object.freeze([
  "gateway.runtime.app-server.transport",
  "gateway.runtime.app-server.virtual-model",
  "gateway.runtime.app-server.turn-router",
  "gateway.runtime.app-server.internal-session",
  "gateway.runtime.app-server.route-metadata",
  "gateway.runtime.app-server.history-context",
]);

function createGatewayPluginService({
  runtimeDir = RUNTIME_DIR,
  classifierOptions,
  compatibilityService,
  getRuntimeIdentity,
} = {}) {
  const manifests = listPluginManifests();
  const configStore = createPluginConfigStore({
    filePath: path.join(runtimeDir, PLUGIN_CONFIG_FILE),
    manifests,
  });
  const injectionHealth = createInjectionHealthRegistry({ compatibilityService, getRuntimeIdentity });
  const modelRouter = createSmartModelRouterService({
    configStore,
    stateFilePath: path.join(runtimeDir, SMART_ROUTER_STATE_FILE),
    classifierOptions,
    injectionHealth,
    compatibilityService,
  });
  function syncSmartRouterCompatibilityPoints(enabled) {
    try {
      compatibilityService?.registry.setPointsEnabled(
        SMART_ROUTER_COMPATIBILITY_POINTS,
        enabled,
        "Smart scheduling is disabled"
      );
    } catch {}
    if (!enabled) return;
    for (const id of SMART_ROUTER_COMPATIBILITY_POINTS) {
      try {
        compatibilityService?.installPoint(id, {
          locatorRevision: "app-server-protocol-v1",
        });
      } catch {}
    }
  }
  // 分类组不再承担启停语义；插件开关直接作用于对应修改点。
  syncSmartRouterCompatibilityPoints(modelRouter.isEnabled());
  const stopInjectionHealthConfigListener = configStore.onChanged((event) => {
    if (event.id !== "opencodex.smart-model-router") return;
    if (event.previous.enabled !== event.current.enabled) {
      // Auto 目录项只在开关开启后的 model/list 中注入，切换开关后要求重新收到当前状态的回执。
      injectionHealth.resetGatewayPoint("auto-model-catalog");
      syncSmartRouterCompatibilityPoints(event.current.enabled);
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
      smartSchedulingPresentation = createSmartSchedulingPresentation({
        compatibilityService,
        modelRouter,
        ...options,
      });
      injectionHealth.reportGateway("route-presentation");
      compatibilityService?.recordHit("gateway.runtime.app-server.route-metadata");
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
