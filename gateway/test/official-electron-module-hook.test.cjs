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
  let delivered = 1;
  let notificationIntercepts = 0;
  let trayIntercepts = 0;

  installOfficialNotificationHook(electronModule, {
    publishNotification(payload) {
      published.push(payload);
      return delivered;
    },
    registerElectronOverride: electronHook.registerOverride,
    onIntercept() { notificationIntercepts += 1; },
  });
  installOfficialTrayHook(electronModule, {
    moduleLoader,
    registerElectronOverride: electronHook.registerOverride,
    onIntercept() { trayIntercepts += 1; },
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
  assert.deepEqual([notificationIntercepts, trayIntercepts], [1, 1]);
  notification.show();
  assert.equal(notification.__opencodexGatewayNotification, true);
  assert.equal(published.length, 1);
  assert.equal(officialNotificationHookStatus().installed, true);
  assert.equal(officialNotificationHookStatus().requireHookInstalled, true);
  assert.equal(officialNotificationHookStatus().activeCount, 1);
  notification.close();
  assert.equal(officialNotificationHookStatus().activeCount, 0);

  delivered = 0;
  const droppedNotification = new officialElectron.Notification({ title: "Offline" });
  droppedNotification.show();
  // 没有任何浏览器接收时仍保留 Electron 对象语义，但不能让全局事件路由表无限增长。
  assert.equal(droppedNotification.destroyed, false);
  assert.equal(officialNotificationHookStatus().activeCount, 0);
  droppedNotification.close();
  assert.equal(hiddenTrayHookStatus().installed, true);
  assert.equal(hiddenTrayHookStatus().createdCount, 1);
});

test("native status item hook hides macOS UI and preserves other addon functions", () => {
  const { createOfficialNativeStatusItemHook } = require("../runtime/electron/official-native-status-item-hook.cjs");
  let nativeCalls = 0;
  let created = 0;
  let destroyed = 0;
  const addon = { marker: "native" };
  // 模拟不可写的原生接口；任何真实菜单栏调用都应被拦截。
  for (const name of ["createStatusItem", "destroyStatusItem", "updateStatusItemState", "updateStatusItemMenuState"]) {
    Object.defineProperty(addon, name, { value() { nativeCalls += 1; }, enumerable: true });
  }
  addon.setWindowDragTarget = function (value) {
    assert.equal(this, addon);
    return value;
  };
  const loads = [];
  const moduleLoader = { _load(...args) { loads.push(args); return addon; } };
  const hook = createOfficialNativeStatusItemHook({ moduleLoader });
  hook.install({ onCreate() { created += 1; }, onDestroy() { destroyed += 1; } });
  const installedLoad = moduleLoader._load;
  hook.install();
  assert.equal(moduleLoader._load, installedLoad);
  const parent = {};
  const wrapped = moduleLoader._load("/resources/native/sky.node", parent, false);
  assert.deepEqual(loads[0], ["/resources/native/sky.node", parent, false]);
  assert.notEqual(wrapped, addon);
  assert.equal(wrapped.createStatusItem("icon", () => assert.fail("后台托盘不应触发菜单事件")), true);
  wrapped.updateStatusItemState(true, true);
  wrapped.updateStatusItemMenuState("{}");
  assert.equal(wrapped.setWindowDragTarget("window"), "window");
  assert.equal(wrapped.marker, "native");
  wrapped.destroyStatusItem();
  wrapped.destroyStatusItem();
  assert.deepEqual([nativeCalls, created, destroyed], [0, 1, 1]);
  assert.equal(moduleLoader._load("/app/native/sky-addon/build/Release-arm64/sky.node"), wrapped);
  assert.equal(moduleLoader._load("/resources/native/other.node"), addon);
  assert.equal(moduleLoader._load("electron"), addon);
  // 销毁后可再次创建，保持官方托盘重新启用时的生命周期。
  assert.equal(wrapped.createStatusItem("icon"), true);
  wrapped.destroyStatusItem();
  assert.deepEqual([nativeCalls, created, destroyed], [0, 2, 2]);
});
