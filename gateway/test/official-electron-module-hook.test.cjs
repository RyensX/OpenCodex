const assert = require("node:assert/strict");
const test = require("node:test");

const {
  __test: { createOfficialElectronModuleHook },
} = require("../runtime/electron/official-electron-module-hook.cjs");
const {
  installOfficialNotificationHook,
  officialNotificationHookStatus,
} = require("../runtime/electron/official-notification-hook.cjs");
const {
  hiddenTrayHookStatus,
  installOfficialTrayHook,
} = require("../runtime/electron/official-tray-hook.cjs");

function officialNamespaceFromCommonJs(moduleValue) {
  const namespace = {};
  // 模拟官方 bundle 的 CommonJS interop：它会枚举包装对象及其原型上的 Electron 导出。
  for (const key in moduleValue) {
    Object.defineProperty(namespace, key, {
      enumerable: true,
      get: () => moduleValue[key],
    });
  }
  return namespace;
}

test("shared Electron wrapper shadows immutable Tray and Notification exports", async () => {
  class NativeTray {}
  class NativeNotification {}
  const electronModule = { app: { name: "OpenCodex" } };
  Object.defineProperty(electronModule, "Tray", {
    configurable: false,
    enumerable: true,
    writable: false,
    value: NativeTray,
  });
  Object.defineProperty(electronModule, "Notification", {
    configurable: false,
    enumerable: true,
    writable: false,
    value: NativeNotification,
  });

  const moduleLoader = {
    _load(request) {
      return request === "electron" ? electronModule : { request };
    },
  };
  const electronHook = createOfficialElectronModuleHook({ moduleLoader });
  const published = [];

  installOfficialNotificationHook(electronModule, {
    publishNotification(payload) {
      published.push(payload);
      return 1;
    },
    registerElectronOverride: electronHook.registerOverride,
  });
  installOfficialTrayHook(electronModule, {
    registerElectronOverride: electronHook.registerOverride,
  });

  const wrappedElectron = moduleLoader._load("electron");
  const officialElectron = officialNamespaceFromCommonJs(wrappedElectron);
  assert.notEqual(wrappedElectron, electronModule);
  assert.equal(Object.getPrototypeOf(wrappedElectron), electronModule);
  assert.equal(electronModule.Tray, NativeTray);
  assert.equal(electronModule.Notification, NativeNotification);
  assert.notEqual(officialElectron.Tray, NativeTray);
  assert.notEqual(officialElectron.Notification, NativeNotification);
  assert.deepEqual(electronHook.status(), {
    installed: true,
    overrideNames: ["Notification", "Tray"],
    servedCount: 1,
    lastServedAt: electronHook.status().lastServedAt,
    lastError: null,
  });
  assert.match(electronHook.status().lastServedAt, /^\d{4}-\d{2}-\d{2}T/);

  const tray = new officialElectron.Tray("icon", "tray-guid");
  assert.equal(tray.__opencodexHiddenTray, true);
  assert.equal(tray.isReady(), true);
  assert.equal(tray.getGUID(), "tray-guid");
  await tray.whenReady();
  let destroyed = false;
  tray.once("destroyed", () => {
    destroyed = true;
  });
  tray.destroy();
  assert.equal(destroyed, true);
  assert.equal(tray.isDestroyed(), true);

  const notification = new officialElectron.Notification({ title: "Done", body: "Task completed" });
  notification.show();
  assert.equal(notification.__opencodexGatewayNotification, true);
  assert.equal(published.length, 1);
  assert.equal(officialNotificationHookStatus().installed, true);
  assert.equal(officialNotificationHookStatus().requireHookInstalled, true);
  assert.equal(hiddenTrayHookStatus().installed, true);
  assert.equal(hiddenTrayHookStatus().createdCount, 1);
});
