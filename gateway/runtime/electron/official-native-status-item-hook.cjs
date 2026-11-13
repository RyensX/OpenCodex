const Module = require("module");
const path = require("path");

// macOS 新版菜单栏通过 sky.node 创建，需在原生模块返回给官方代码前替换相关接口。
function createOfficialNativeStatusItemHook(options = {}) {
  const moduleLoader = options.moduleLoader || Module;
  const wrappers = new WeakMap();
  let installed = false;

  function install({ onCreate, onDestroy } = {}) {
    if (installed) return;
    const originalLoad = moduleLoader._load;
    function loadWithHiddenStatusItem(request) {
      const addon = originalLoad.apply(this, arguments);
      if (typeof request !== "string" || path.basename(request) !== "sky.node" ||
          !addon || typeof addon.createStatusItem !== "function") return addon;
      if (wrappers.has(addon)) return wrappers.get(addon);

      let active = false;
      const overrides = {
        createStatusItem() {
          active = true;
          onCreate?.();
          // 官方代码以返回值判断初始化是否成功；后台模式仍提供成功语义。
          return true;
        },
        destroyStatusItem() {
          if (!active) return;
          active = false;
          onDestroy?.();
        },
        updateStatusItemMenuState() {},
        updateStatusItemState() {},
      };
      const wrapper = Object.create(Object.getPrototypeOf(addon));
      // 保留原生模块的其他导出与调用接收者，并兼容不可写的原生导出属性。
      const descriptors = Object.getOwnPropertyDescriptors(addon);
      for (const [name, descriptor] of Object.entries(descriptors)) {
        if (Object.hasOwn(overrides, name)) continue;
        if (typeof descriptor.value === "function") descriptor.value = descriptor.value.bind(addon);
        Object.defineProperty(wrapper, name, descriptor);
      }
      for (const [name, value] of Object.entries(overrides)) {
        Object.defineProperty(wrapper, name, { value, enumerable: true });
      }
      wrappers.set(addon, wrapper);
      return wrapper;
    }
    moduleLoader._load = loadWithHiddenStatusItem;
    if (moduleLoader._load !== loadWithHiddenStatusItem) {
      throw new Error("Cannot install native status item require hook");
    }
    installed = true;
  }

  return { install };
}

module.exports = { createOfficialNativeStatusItemHook };
