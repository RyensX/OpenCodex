const path = require("path");
const { RUNTIME_DIR } = require("../core/config.cjs");
const { listPluginManifests } = require("../core/plugin-assets.cjs");
const { createSmartModelRouterService } = require("../model-router/service.cjs");
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
  return {
    configStore,
    manifests,
    modelRouter,
    dispose(error) {
      modelRouter.dispose(error);
    },
  };
}

module.exports = {
  PLUGIN_CONFIG_FILE,
  SMART_ROUTER_STATE_FILE,
  createGatewayPluginService,
};
