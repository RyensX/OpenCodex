const Module = require("module");

function createOfficialElectronModuleHook(options = {}) {
  const moduleLoader = options.moduleLoader || Module;
  const state = {
    installed: false,
    overrideNames: new Set(),
    servedCount: 0,
    lastServedAt: null,
    lastError: null,
  };
  let electronModule = null;
  let electronWrapper = null;
  let originalModuleLoad = null;

  function fail(message) {
    state.lastError = message;
    throw new Error(message);
  }

  function ensureInstalled(candidateModule) {
    if (
      !candidateModule ||
      (typeof candidateModule !== "object" && typeof candidateModule !== "function")
    ) {
      fail("Electron module is unavailable");
    }
    if (!moduleLoader || typeof moduleLoader._load !== "function") {
      fail("Node module loader is unavailable");
    }
    if (state.installed) {
      if (candidateModule !== electronModule) fail("Electron module changed after the require hook was installed");
      return;
    }

    /**
     * Electron 的内建导出在新版本中可能是不可写、不可配置的访问器。
     * 这里保留原对象作为原型，只在包装对象上定义需要替换的导出，避免修改 Electron 自身。
     */
    electronModule = candidateModule;
    electronWrapper = Object.create(candidateModule);
    originalModuleLoad = moduleLoader._load;
    const hookedModuleLoad = function opencodexElectronModuleLoad(request, parent, isMain) {
      const loaded = originalModuleLoad.apply(this, arguments);
      if (request === "electron" && loaded === electronModule) {
        // 记录包装对象是否真正进入官方 bundle，便于区分“Hook 已安装”和“官方代码已消费”。
        state.servedCount += 1;
        state.lastServedAt = new Date().toISOString();
        return electronWrapper;
      }
      return loaded;
    };

    try {
      moduleLoader._load = hookedModuleLoad;
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    if (moduleLoader._load !== hookedModuleLoad) fail("Cannot install Electron module require hook");
    state.installed = true;
  }

  function registerOverride(candidateModule, exportName, exportValue) {
    if (typeof exportName !== "string" || !exportName.trim()) fail("Electron override name is invalid");
    ensureInstalled(candidateModule);
    try {
      Object.defineProperty(electronWrapper, exportName, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: exportValue,
      });
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    state.overrideNames.add(exportName);
    state.lastError = null;
    return electronWrapper;
  }

  function status() {
    return {
      installed: state.installed,
      overrideNames: Array.from(state.overrideNames).sort(),
      servedCount: state.servedCount,
      lastServedAt: state.lastServedAt,
      lastError: state.lastError,
    };
  }

  return {
    registerOverride,
    status,
  };
}

const officialElectronModuleHook = createOfficialElectronModuleHook();

function registerOfficialElectronModuleOverride(electronModule, exportName, exportValue) {
  return officialElectronModuleHook.registerOverride(electronModule, exportName, exportValue);
}

function officialElectronModuleHookStatus() {
  return officialElectronModuleHook.status();
}

module.exports = {
  officialElectronModuleHookStatus,
  registerOfficialElectronModuleOverride,
  __test: {
    createOfficialElectronModuleHook,
  },
};
