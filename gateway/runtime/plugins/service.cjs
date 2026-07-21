const path = require("path");
const { RUNTIME_DIR } = require("../core/config.cjs");
const { listPluginManifests } = require("../core/plugin-assets.cjs");
const { createSmartModelRouterService } = require("../model-router/service.cjs");
const { createSmartSchedulingPresentation } = require("../model-router/presentation.cjs");
const { createPluginConfigStore } = require("./config-store.cjs");

const PLUGIN_CONFIG_FILE = "opencodex-plugin-settings.json";
const SMART_ROUTER_STATE_FILE = "smart-model-router-state.json";

function createGatewayPluginService({ runtimeDir = RUNTIME_DIR, classifierOptions } = {}) {
  const manifests = listPluginManifests();
  const configStore = createPluginConfigStore({
    filePath: path.join(runtimeDir, PLUGIN_CONFIG_FILE),
    manifests,
  });
  const modelRouter = createSmartModelRouterService({
    configStore,
    stateFilePath: path.join(runtimeDir, SMART_ROUTER_STATE_FILE),
    classifierOptions,
  });
  let smartSchedulingPresentation = null;
  return {
    configStore,
    manifests,
    modelRouter,
    bindSmartSchedulingPresentation(options) {
      smartSchedulingPresentation?.dispose();
      smartSchedulingPresentation = createSmartSchedulingPresentation({ modelRouter, ...options });
      return smartSchedulingPresentation;
    },
    get smartSchedulingPresentation() {
      return smartSchedulingPresentation;
    },
    dispose(error) {
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
