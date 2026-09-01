const path = require("path");
const { RUNTIME_DIR } = require("../core/config.cjs");
const { listPluginManifests } = require("../core/plugin-assets.cjs");
const { createSmartModelRouterService } = require("../model-router/service.cjs");
const { createSmartSchedulingPresentation } = require("../model-router/presentation.cjs");
const { createInjectionHealthRegistry } = require("../model-router/injection-health.cjs");
const { createPluginConfigStore } = require("./config-store.cjs");

const PLUGIN_CONFIG_FILE = "opencodex-plugin-settings.json";
const SMART_ROUTER_STATE_FILE = "smart-model-router-state.json";
function createGatewayPluginService({
  runtimeDir = RUNTIME_DIR,
  classifierOptions,
  compatibilityService,
  getRuntimeIdentity,
} = {}) {
  const gatewayPoints = compatibilityService?.modificationPoints?.gateway;
  const smartRouterPoints = Object.freeze([
    gatewayPoints?.appServerTransport,
    gatewayPoints?.virtualModel,
    gatewayPoints?.turnRouter,
    gatewayPoints?.internalSession,
    gatewayPoints?.routeMetadata,
    gatewayPoints?.historyContext,
  ].filter(Boolean));
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
    for (const point of smartRouterPoints) {
      try {
        try {
          compatibilityService?.modifications.setEnabled(
            point,
            enabled,
            "Smart scheduling is disabled"
          );
        } catch {
          compatibilityService?.modifications.execute(point, () => undefined, { verify: () => true });
          if (!enabled) {
            // 初始即关闭时先建立正式 Provider 状态，再由同一 Kernel 状态机标记为 disabled。
            compatibilityService?.modifications.setEnabled(point, false, "Smart scheduling is disabled");
          }
        }
      } catch {
        // 设置同步仅用于诊断；失败不能改变智能调度开关本身。
      }
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
      try {
        compatibilityService?.modifications.effect(gatewayPoints.routeMetadata).emit();
      } catch {}
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
