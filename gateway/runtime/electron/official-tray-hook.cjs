const { EventEmitter } = require("events");
const { diagnosticLog, diagnosticWarn } = require("../core/diagnostics.cjs");
const {
  registerOfficialElectronModuleOverride,
} = require("./official-electron-module-hook.cjs");

const state = {
  installed: false,
  createdCount: 0,
  destroyedCount: 0,
  lastCreatedAt: null,
  lastDestroyedAt: null,
  lastError: null,
};

function installOfficialTrayHook(electronModule, options = {}) {
  if (!electronModule || state.installed) return hiddenTrayHookStatus();

  const NativeTray = electronModule.Tray;
  if (typeof NativeTray !== "function") {
    diagnosticWarn("official-tray", "tray_unavailable");
    return hiddenTrayHookStatus();
  }

  /**
   * 官方 main 会创建托盘图标来承载桌面端菜单和窗口唤起能力。
   * gateway 只把官方 runtime 当后台 IPC 服务使用，不需要真实系统托盘；
   * 这里提供一个无 UI 的 Tray 替身，让官方代码继续拿到可调用对象。
   */
  class HiddenTray extends EventEmitter {
    constructor(image, guid) {
      super();
      this.__opencodexHiddenTray = true;
      this.image = image || null;
      this.guid = guid || "";
      this.pressedImage = null;
      this.toolTip = "";
      this.title = "";
      this.contextMenu = null;
      this.ignoreDoubleClickEvents = false;
      this.destroyed = false;
      state.createdCount += 1;
      state.lastCreatedAt = new Date().toISOString();
      diagnosticLog("official-tray", "hidden_tray_created", {
        createdCount: state.createdCount,
      });
    }

    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.emit("destroyed");
      this.removeAllListeners();
      state.destroyedCount += 1;
      state.lastDestroyedAt = new Date().toISOString();
      diagnosticLog("official-tray", "hidden_tray_destroyed", {
        destroyedCount: state.destroyedCount,
      });
    }

    isDestroyed() {
      return this.destroyed;
    }

    isReady() {
      return !this.destroyed;
    }

    whenReady() {
      // 隐藏托盘不创建原生资源，因此构造完成后即可视为 ready。
      return Promise.resolve();
    }

    getGUID() {
      return this.guid || null;
    }

    setImage(image) {
      this.image = image || null;
    }

    setPressedImage(image) {
      this.pressedImage = image || null;
    }

    setToolTip(toolTip) {
      this.toolTip = String(toolTip || "");
    }

    setTitle(title) {
      this.title = String(title || "");
    }

    setContextMenu(menu) {
      this.contextMenu = menu || null;
    }

    setIgnoreDoubleClickEvents(ignore) {
      this.ignoreDoubleClickEvents = !!ignore;
    }

    setHighlightMode(mode) {
      this.highlightMode = String(mode || "");
    }

    popUpContextMenu(menu) {
      // 后台 gateway 不展示任何菜单，但保留最后一次传入的菜单便于官方代码继续更新状态。
      if (menu) this.contextMenu = menu;
    }

    closeContextMenu() {}

    displayBalloon(options) {
      this.lastBalloonOptions = options || null;
    }

    removeBalloon() {
      this.lastBalloonOptions = null;
    }

    focus() {}

    getBounds() {
      // 没有真实托盘坐标；返回稳定的空区域，避免调用方拿到 undefined 后崩溃。
      return { x: 0, y: 0, width: 0, height: 0 };
    }
  }

  Object.setPrototypeOf(HiddenTray, NativeTray);
  const registerElectronOverride =
    typeof options.registerElectronOverride === "function"
      ? options.registerElectronOverride
      : registerOfficialElectronModuleOverride;
  try {
    registerElectronOverride(electronModule, "Tray", HiddenTray);
  } catch (error) {
    state.lastError = error instanceof Error ? error.message : String(error);
    diagnosticWarn("official-tray", "tray_patch_failed", { error: state.lastError });
    return hiddenTrayHookStatus();
  }

  state.installed = true;
  state.lastError = null;
  diagnosticLog("official-tray", "tray_hook_installed", { strategy: "module_load_wrapper" });
  return hiddenTrayHookStatus();
}

function hiddenTrayHookStatus() {
  return {
    installed: state.installed,
    createdCount: state.createdCount,
    destroyedCount: state.destroyedCount,
    lastCreatedAt: state.lastCreatedAt,
    lastDestroyedAt: state.lastDestroyedAt,
    lastError: state.lastError,
  };
}

module.exports = {
  hiddenTrayHookStatus,
  installOfficialTrayHook,
};
