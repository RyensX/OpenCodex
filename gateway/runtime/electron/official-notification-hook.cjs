const { EventEmitter } = require("events");
const Module = require("module");
const { DEBUG_LOGS } = require("../core/config.cjs");
const { diagnosticLog, diagnosticWarn, shortId } = require("../core/diagnostics.cjs");

const NOTIFICATION_EVENT_TYPE = "opencodex:notification-event";
const NOTIFICATION_SHOW_TYPE = "opencodex:notification";
const NOTIFICATION_CLOSE_TYPE = "opencodex:notification-close";

const state = {
  installed: false,
  createdCount: 0,
  shownCount: 0,
  forwardedCount: 0,
  droppedCount: 0,
  closedCount: 0,
  browserClickCount: 0,
  browserCloseCount: 0,
  requireHookInstalled: false,
  lastCreatedAt: null,
  lastShownAt: null,
  lastForwardedAt: null,
  lastDroppedAt: null,
  lastClosedAt: null,
  lastError: null,
};

const notifications = new Map();
let publishNotification = null;
let electronRequireWrapper = null;
let originalModuleLoad = null;

function nextNotificationId() {
  return `notification-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function stringField(value, maxLength) {
  const text = String(value || "");
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function safeBrowserIcon(value) {
  if (typeof value !== "string") return "";
  const icon = value.trim();
  if (!icon) return "";
  // 浏览器 Notification 只能可靠消费 URL/data URL；不转发本机文件路径，避免跨设备不可读和泄露本地路径。
  if (/^(?:https?:|data:|blob:|\/)/i.test(icon)) return icon.length > 4096 ? "" : icon;
  return "";
}

function safeActions(value) {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, 2)
    .map((action) => {
      if (!action || typeof action !== "object") return null;
      return {
        action: stringField(action.type || action.action || action.text, 80),
        title: stringField(action.text || action.title || action.type || action.action, 120),
      };
    })
    .filter((action) => action && action.action && action.title);
}

function optionsFromConstructor(options) {
  return options && typeof options === "object" ? options : {};
}

function browserNotificationPayload(notification) {
  const options = notification.options;
  const payload = {
    type: NOTIFICATION_SHOW_TYPE,
    notificationId: notification.notificationId,
    title: stringField(notification.title, 512),
    body: stringField(notification.body, 4096),
    silent: !!options.silent,
  };
  const icon = safeBrowserIcon(options.icon);
  if (icon) payload.icon = icon;
  const tag = stringField(options.tag, 160);
  if (tag) payload.tag = tag;
  const actions = safeActions(options.actions);
  if (actions.length > 0) payload.actions = actions;
  if (options.renotify != null) payload.renotify = !!options.renotify;
  if (options.requireInteraction != null) payload.requireInteraction = !!options.requireInteraction;
  return payload;
}

function publish(payload) {
  if (typeof publishNotification !== "function") return 0;
  try {
    return Number(publishNotification(payload)) || 0;
  } catch (error) {
    state.lastError = error instanceof Error ? error.message : String(error);
    diagnosticWarn("official-notification", "publish_failed", { error: state.lastError });
    return 0;
  }
}

function createElectronRequireWrapper(electronModule, NotificationClass) {
  /**
   * Electron 的 module.exports 在部分版本里把 Notification 定义成不可重写属性。
   * 不能直接改原对象；这里创建一个以原 electron 为原型的浅包装对象，只覆盖 Notification。
   */
  const wrapper = Object.create(electronModule);
  Object.defineProperty(wrapper, "Notification", {
    configurable: true,
    enumerable: true,
    writable: true,
    value: NotificationClass,
  });
  wrapper.__opencodexNativeNotification = electronModule.Notification;
  wrapper.__opencodexOfficialGatewayNotificationPatched = true;
  return wrapper;
}

function installElectronRequireHook(electronModule, NotificationClass) {
  if (state.requireHookInstalled) return true;
  originalModuleLoad = originalModuleLoad || Module._load;
  electronRequireWrapper = createElectronRequireWrapper(electronModule, NotificationClass);
  Module._load = function opencodexNotificationModuleLoad(request, parent, isMain) {
    const loaded = originalModuleLoad.apply(this, arguments);
    if (request === "electron" && loaded === electronModule) return electronRequireWrapper;
    return loaded;
  };
  state.requireHookInstalled = true;
  return true;
}

function installOfficialNotificationHook(electronModule, options = {}) {
  if (!electronModule || state.installed || electronModule.__opencodexOfficialGatewayNotificationPatched) {
    return officialNotificationHookStatus();
  }

  const NativeNotification = electronModule.Notification;
  if (typeof NativeNotification !== "function") {
    diagnosticWarn("official-notification", "notification_unavailable");
    return officialNotificationHookStatus();
  }

  publishNotification = options.publishNotification;

  /**
   * 官方 main 会直接创建系统通知。gateway 是后台服务，不应该自己弹系统通知；
   * 这里用无 UI 的 Notification 替身接住官方调用，再把通知转发给已连接浏览器。
   */
  class GatewayNotification extends EventEmitter {
    constructor(options) {
      super();
      const normalizedOptions = optionsFromConstructor(options);
      this.__opencodexGatewayNotification = true;
      this.notificationId = nextNotificationId();
      this.options = { ...normalizedOptions };
      this.title = stringField(normalizedOptions.title, 512);
      this.subtitle = stringField(normalizedOptions.subtitle, 512);
      this.body = stringField(normalizedOptions.body, 4096);
      this.replyPlaceholder = stringField(normalizedOptions.replyPlaceholder, 512);
      this.closeButtonText = stringField(normalizedOptions.closeButtonText, 120);
      this.sound = normalizedOptions.sound || "";
      this.icon = normalizedOptions.icon || null;
      this.silent = !!normalizedOptions.silent;
      this.hasReply = !!normalizedOptions.hasReply;
      this.timeoutType = normalizedOptions.timeoutType || "";
      this.urgency = normalizedOptions.urgency || "";
      this.actions = Array.isArray(normalizedOptions.actions) ? normalizedOptions.actions.slice() : [];
      this.visible = false;
      this.destroyed = false;
      notifications.set(this.notificationId, this);
      state.createdCount += 1;
      state.lastCreatedAt = new Date().toISOString();
    }

    show() {
      if (this.destroyed) return;
      this.visible = true;
      state.shownCount += 1;
      state.lastShownAt = new Date().toISOString();
      const sent = publish(browserNotificationPayload(this));
      if (sent > 0) {
        state.forwardedCount += 1;
        state.lastForwardedAt = new Date().toISOString();
      } else {
        // 通知是时效消息；没有在线浏览器或 WS 尚未 ready 时直接丢弃，不做持久化队列。
        state.droppedCount += 1;
        state.lastDroppedAt = new Date().toISOString();
      }
      if (DEBUG_LOGS) {
        diagnosticLog("official-notification", "notification_show_intercepted", {
          notificationId: shortId(this.notificationId),
          sent,
        });
      }
      setImmediate(() => {
        if (!this.destroyed) this.emit("show");
      });
    }

    close(options = {}) {
      if (this.destroyed) return;
      this.visible = false;
      this.destroyed = true;
      notifications.delete(this.notificationId);
      state.closedCount += 1;
      state.lastClosedAt = new Date().toISOString();
      if (options.notifyBrowser !== false) {
        publish({
          type: NOTIFICATION_CLOSE_TYPE,
          notificationId: this.notificationId,
        });
      }
      setImmediate(() => this.emit("close"));
    }
  }

  GatewayNotification.isSupported = () => true;
  Object.setPrototypeOf(GatewayNotification, NativeNotification);
  installElectronRequireHook(electronModule, GatewayNotification);

  state.installed = true;
  if (DEBUG_LOGS) diagnosticLog("official-notification", "notification_hook_installed", { strategy: "module_load_wrapper" });
  return officialNotificationHookStatus();
}

function handleOfficialNotificationEvent(message) {
  if (!message || typeof message !== "object" || message.type !== NOTIFICATION_EVENT_TYPE) return false;
  const notificationId = typeof message.notificationId === "string" ? message.notificationId : "";
  const event = typeof message.event === "string" ? message.event : "";
  const notification = notificationId ? notifications.get(notificationId) : null;
  if (!notification) return true;

  if (event === "click") {
    state.browserClickCount += 1;
    notification.emit("click");
    return true;
  }
  if (event === "close") {
    state.browserCloseCount += 1;
    notification.close({ notifyBrowser: false });
    return true;
  }
  if (event === "action") {
    notification.emit("action", message.action || "");
    return true;
  }
  if (event === "reply") {
    notification.emit("reply", message.reply || "");
    return true;
  }
  return true;
}

function officialNotificationHookStatus() {
  return {
    installed: state.installed,
    createdCount: state.createdCount,
    shownCount: state.shownCount,
    forwardedCount: state.forwardedCount,
    droppedCount: state.droppedCount,
    closedCount: state.closedCount,
    browserClickCount: state.browserClickCount,
    browserCloseCount: state.browserCloseCount,
    requireHookInstalled: state.requireHookInstalled,
    activeCount: notifications.size,
    lastCreatedAt: state.lastCreatedAt,
    lastShownAt: state.lastShownAt,
    lastForwardedAt: state.lastForwardedAt,
    lastDroppedAt: state.lastDroppedAt,
    lastClosedAt: state.lastClosedAt,
    lastError: state.lastError,
  };
}

module.exports = {
  NOTIFICATION_CLOSE_TYPE,
  NOTIFICATION_EVENT_TYPE,
  NOTIFICATION_SHOW_TYPE,
  handleOfficialNotificationEvent,
  installOfficialNotificationHook,
  officialNotificationHookStatus,
};
