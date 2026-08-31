const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const WEB_SHELL_DIR = path.resolve(__dirname, "..", "..", "web-shell");
const MOBILE_VIEWPORT_SOURCE = fs.readFileSync(
  path.join(WEB_SHELL_DIR, "plugins", "mobile-keyboard-optimization", "index.js"),
  "utf8"
);
const IOS_FIX_SOURCE = fs.readFileSync(
  path.join(WEB_SHELL_DIR, "plugins", "ios-fix", "index.js"),
  "utf8"
);
const WCO_SOURCE = fs.readFileSync(path.join(WEB_SHELL_DIR, "codex-window-controls-overlay.js"), "utf8");
const COMPOSER_SOURCE = fs.readFileSync(
  path.join(WEB_SHELL_DIR, "codex-smart-model-router-composer.js"),
  "utf8"
);
const TOOLTIP_SOURCE = fs.readFileSync(path.join(WEB_SHELL_DIR, "codex-tooltip-dismiss-guard.js"), "utf8");
const BRIDGE_SOURCE = fs.readFileSync(path.join(WEB_SHELL_DIR, "codex-bridge-polyfill.js"), "utf8");
const SIDEBAR_PREVIEW_SOURCE = fs.readFileSync(
  path.join(WEB_SHELL_DIR, "codex-sidebar-preview.js"),
  "utf8"
);
const OFFSCREEN_ANIMATION_GUARD_SOURCE = fs.readFileSync(
  path.join(WEB_SHELL_DIR, "codex-offscreen-animation-guard.js"),
  "utf8"
);
const REMOTE_FILE_ACTIONS_SOURCE = fs.readFileSync(
  path.join(WEB_SHELL_DIR, "codex-remote-file-actions.js"),
  "utf8"
);
const HEALTH_SOURCE = fs.readFileSync(
  path.join(WEB_SHELL_DIR, "codex-smart-scheduling-injection-health.js"),
  "utf8"
);
const SETTINGS_SOURCE = fs.readFileSync(
  path.join(WEB_SHELL_DIR, "codex-smart-model-router-settings.js"),
  "utf8"
);
const SUMMARY_SOURCE = fs.readFileSync(
  path.join(WEB_SHELL_DIR, "codex-smart-scheduling-summary.js"),
  "utf8"
);
const TOKEN_USAGE_INLINE_SOURCE = fs.readFileSync(
  path.join(WEB_SHELL_DIR, "plugins", "token-usage-inline", "index.js"),
  "utf8"
);
const TOKEN_USAGE_CAPABILITY_SOURCE = fs.readFileSync(
  path.join(WEB_SHELL_DIR, "codex-token-usage-capability.js"),
  "utf8"
);

function sourceSection(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return source.slice(start, end);
}

class ListenerTarget {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(handler);
  }

  removeEventListener(type, handler) {
    this.listeners.get(type)?.delete(handler);
  }

  emit(type, event = {}) {
    for (const handler of Array.from(this.listeners.get(type) || [])) {
      handler({ type, target: this, ...event });
    }
  }

  listenerCount(type) {
    return this.listeners.get(type)?.size || 0;
  }
}

class TestStyle {
  constructor() {
    this.values = new Map();
    this.cssText = "";
    this.width = "0px";
  }

  getPropertyValue(name) {
    return this.values.get(name) || "";
  }

  getPropertyPriority(name) {
    return this.priorities?.get(name) || "";
  }

  setProperty(name, value, priority = "") {
    const nextValue = String(value);
    const nextPriority = String(priority);
    if (this.values.get(name) === nextValue && this.priorities?.get(name) === nextPriority) return;
    this.priorities ||= new Map();
    this.values.set(name, nextValue);
    this.priorities.set(name, nextPriority);
    this.mutationCount = (this.mutationCount || 0) + 1;
  }

  removeProperty(name) {
    if (!this.values.has(name)) return;
    this.values.delete(name);
    this.priorities?.delete(name);
    this.mutationCount = (this.mutationCount || 0) + 1;
  }
}

class TestElement {
  constructor(tagName = "div") {
    this.attributes = new Map();
    this.children = [];
    this.classList = { contains: () => false };
    this.dataset = {};
    this.firstElementChild = null;
    this.id = "";
    this.nodeType = 1;
    this.parentElement = null;
    this.parentNode = null;
    this.style = new TestStyle();
    this.tagName = tagName.toUpperCase();
  }

  appendChild(node) {
    node.parentElement = this;
    node.parentNode = this;
    this.children.push(node);
    this.firstElementChild ||= node;
    return node;
  }

  contains(node) {
    return node === this || this.children.some((child) => child.contains?.(node));
  }

  closest() {
    return null;
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  getBoundingClientRect() {
    return {
      bottom: 0,
      height: 0,
      left: 0,
      right: 0,
      top: 0,
      width: Number.parseFloat(this.style.width) || 0,
    };
  }

  matches() {
    return false;
  }

  querySelector() {
    return null;
  }

  querySelectorAll() {
    return [];
  }

  remove() {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    this.parentElement = null;
    this.parentNode = null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  toggleAttribute(name, enabled) {
    if (enabled) this.setAttribute(name, "");
    else this.removeAttribute(name);
  }
}

function createScheduler() {
  let nextId = 1;
  const frames = new Map();
  const timers = new Map();
  return {
    frames,
    timers,
    cancelAnimationFrame(id) {
      frames.delete(id);
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    flushFrames() {
      const pending = Array.from(frames.entries());
      frames.clear();
      for (const [, callback] of pending) callback();
    },
    flushTimers() {
      const pending = Array.from(timers.entries());
      timers.clear();
      for (const [, timer] of pending) timer.callback();
    },
    requestAnimationFrame(callback) {
      const id = nextId++;
      frames.set(id, callback);
      return id;
    },
    setTimeout(callback, delay = 0) {
      const id = nextId++;
      timers.set(id, { callback, delay });
      return id;
    },
  };
}

test("sidebar preview hands off immediately when the official sidebar mounts", () => {
  const scheduler = createScheduler();
  const document = new ListenerTarget();
  let removed = false;
  let officialReady = false;
  let observer = null;
  const localeMarker = new TestElement("meta");
  localeMarker.setAttribute("content", "/official-patched-v7/assets/zh-CN-test.js");
  const shellMarker = new TestElement("meta");
  shellMarker.setAttribute("content", "/official-patched-v7/assets/thread-shell-test.js");
  const preview = {
    contains: () => true,
    remove() {
      removed = true;
    },
    setAttribute() {},
  };
  const previewRow = {
    closest: (selector) => selector === "[data-opencodex-sidebar-preview-row]" ? previewRow : null,
    getAttribute: () => "thread-1",
    setAttribute() {},
  };
  const officialRow = { getAttribute: () => "local:thread-1" };
  document.documentElement = {};
  document.head = new TestElement("head");
  document.readyState = "loading";
  document.createElement = (tagName) => new TestElement(tagName);
  document.getElementById = () => (removed ? null : preview);
  document.querySelector = () => (officialReady ? officialRow : null);
  document.querySelectorAll = (selector) =>
    selector === 'meta[name="opencodex-late-modulepreload"]'
      ? [localeMarker, shellMarker]
      : selector === 'link[rel="modulepreload"]'
        ? document.head.children
        : officialReady
          ? [officialRow]
          : [];
  const window = new ListenerTarget();
  Object.assign(window, {
    MutationObserver: class {
      constructor(callback) {
        this.callback = callback;
        observer = this;
      }
      disconnect() {}
      observe() {}
    },
    cancelAnimationFrame: scheduler.cancelAnimationFrame,
    clearTimeout: scheduler.clearTimeout,
    requestAnimationFrame: scheduler.requestAnimationFrame,
    setTimeout: scheduler.setTimeout,
  });
  window.window = window;

  vm.runInNewContext(SIDEBAR_PREVIEW_SOURCE, { document, MouseEvent: class {}, window });
  assert.equal(document.head.children.length, 0);
  window.emit("load");
  assert.equal(document.head.children.length, 0);
  const localeTimer = Array.from(scheduler.timers.values()).find((timer) => timer.delay === 350);
  assert.ok(localeTimer);
  localeTimer.callback();
  assert.equal(document.head.children.length, 2);
  assert.equal(document.head.children[0].getAttribute("href"), "/official-patched-v7/assets/zh-CN-test.js");
  assert.equal(document.head.children[1].getAttribute("href"), "/official-patched-v7/assets/thread-shell-test.js");
  document.emit("DOMContentLoaded");
  // 常态 React 挂载不启用全树观察；只有用户提前点击预览会话时才临时启用。
  assert.equal(observer, null);
  document.emit("click", {
    target: previewRow,
    preventDefault() {},
    stopPropagation() {},
  });
  assert.ok(observer);
  officialReady = true;
  observer.callback();
  scheduler.flushFrames();

  assert.equal(removed, true);
  assert.equal(document.listenerCount("click"), 0);
  assert.doesNotMatch(SIDEBAR_PREVIEW_SOURCE, /SidebarPreviewDiagnostics/);
});

test("sidebar preview leaves no observer or timer behind when history is empty", () => {
  const scheduler = createScheduler();
  const document = new ListenerTarget();
  let observerCount = 0;
  document.documentElement = {};
  document.head = new TestElement("head");
  document.readyState = "loading";
  document.getElementById = () => null;
  document.querySelector = () => null;
  document.querySelectorAll = () => [];
  const window = new ListenerTarget();
  Object.assign(window, {
    MutationObserver: class {
      constructor() {
        observerCount += 1;
      }
      disconnect() {}
      observe() {}
    },
    cancelAnimationFrame: scheduler.cancelAnimationFrame,
    clearTimeout: scheduler.clearTimeout,
    requestAnimationFrame: scheduler.requestAnimationFrame,
    setTimeout: scheduler.setTimeout,
  });
  window.window = window;

  vm.runInNewContext(SIDEBAR_PREVIEW_SOURCE, { document, MouseEvent: class {}, window });
  assert.equal(document.listenerCount("click"), 1);
  assert.equal(scheduler.timers.size, 1);
  document.emit("DOMContentLoaded");

  assert.equal(observerCount, 0);
  assert.equal(document.listenerCount("click"), 0);
  assert.equal(scheduler.timers.size, 0);
});

test("offscreen sidebar animations pause until visible and observe replacement spinners", () => {
  const scheduler = createScheduler();
  const document = new ListenerTarget();
  const initialSpinner = new TestElement();
  const replacementSpinner = new TestElement();
  initialSpinner.matches = replacementSpinner.matches = (selector) => selector === ".animate-spin";
  const sidebar = new TestElement();
  const sidebarEvents = new ListenerTarget();
  sidebar.addEventListener = sidebarEvents.addEventListener.bind(sidebarEvents);
  let spinnerTop = 200;
  sidebar.getBoundingClientRect = () => ({ bottom: 100, left: 0, right: 100, top: 0 });
  initialSpinner.getBoundingClientRect = () => ({
    bottom: spinnerTop + 20,
    left: 0,
    right: 20,
    top: spinnerTop,
  });
  sidebar.querySelectorAll = (selector) => selector === ".animate-spin" ? [initialSpinner] : [];
  let mounted = false;
  let discoveryObserver = null;
  let sidebarObserver = null;
  let intersectionObserver = null;
  document.documentElement = new TestElement("html");
  document.querySelector = (selector) =>
    selector === "[data-app-action-sidebar-scroll]" && mounted ? sidebar : null;
  const mutationObservers = [];
  const window = new ListenerTarget();
  Object.assign(window, {
    IntersectionObserver: class {
      constructor(callback, options) {
        this.callback = callback;
        this.options = options;
        this.targets = [];
        this.unobserved = [];
        intersectionObserver = this;
      }
      observe(target) {
        this.targets.push(target);
      }
      unobserve(target) {
        this.unobserved.push(target);
      }
    },
    MutationObserver: class {
      constructor(callback) {
        this.callback = callback;
        this.disconnected = false;
        mutationObservers.push(this);
      }
      disconnect() {
        this.disconnected = true;
      }
      observe(target) {
        if (target === document.documentElement) discoveryObserver = this;
        if (target === sidebar) sidebarObserver = this;
      }
    },
    requestAnimationFrame: scheduler.requestAnimationFrame,
  });
  window.window = window;

  vm.runInNewContext(OFFSCREEN_ANIMATION_GUARD_SOURCE, { document, window });
  assert.ok(discoveryObserver);
  mounted = true;
  discoveryObserver.callback();
  scheduler.flushFrames();

  // 主内容根尚未挂载时保留共享发现监听；两个区域都找到后才会自动关闭。
  assert.equal(discoveryObserver.disconnected, false);
  assert.equal(intersectionObserver.options.root, sidebar);
  assert.equal(initialSpinner.style.getPropertyValue("animation-play-state"), "paused");
  scheduler.flushFrames();
  assert.equal(initialSpinner.style.getPropertyValue("animation-play-state"), "paused");
  spinnerTop = 20;
  sidebarEvents.emit("scroll");
  scheduler.flushFrames();
  assert.equal(initialSpinner.style.getPropertyValue("animation-play-state"), "");
  intersectionObserver.callback([{ isIntersecting: true, target: initialSpinner }]);
  assert.equal(initialSpinner.style.getPropertyValue("animation-play-state"), "");
  intersectionObserver.callback([{ isIntersecting: false, target: initialSpinner }]);
  assert.equal(initialSpinner.style.getPropertyValue("animation-play-state"), "paused");

  sidebarObserver.callback([{ addedNodes: [replacementSpinner], removedNodes: [initialSpinner] }]);
  assert.equal(intersectionObserver.targets.includes(replacementSpinner), true);
  assert.equal(intersectionObserver.unobserved.includes(initialSpinner), true);
  assert.equal(initialSpinner.style.getPropertyValue("animation-play-state"), "");
  assert.equal(replacementSpinner.style.getPropertyValue("animation-play-state"), "paused");
  assert.equal(mutationObservers.length, 2);
});

test("offscreen horizontal scroll fades pause without changing visible content", () => {
  const scheduler = createScheduler();
  const document = new ListenerTarget();
  document.documentElement = new TestElement("html");
  const visibleFade = new TestElement();
  const offscreenFade = new TestElement();
  const replacementFade = new TestElement();
  visibleFade.matches = offscreenFade.matches = replacementFade.matches =
    (selector) => selector === ".horizontal-scroll-fade-mask";
  let offscreenTop = 200;
  visibleFade.getBoundingClientRect = () => ({ bottom: 40, left: 10, right: 90, top: 20 });
  offscreenFade.getBoundingClientRect = () => ({
    bottom: offscreenTop + 20,
    left: 10,
    right: 90,
    top: offscreenTop,
  });
  replacementFade.getBoundingClientRect = () => ({ bottom: 240, left: 10, right: 90, top: 220 });
  const main = new TestElement("main");
  const mainEvents = new ListenerTarget();
  main.addEventListener = mainEvents.addEventListener.bind(mainEvents);
  main.removeEventListener = mainEvents.removeEventListener.bind(mainEvents);
  main.getBoundingClientRect = () => ({ bottom: 100, left: 0, right: 100, top: 0 });
  main.querySelectorAll = (selector) =>
    selector === ".horizontal-scroll-fade-mask" ? [visibleFade, offscreenFade] : [];
  document.querySelector = (selector) =>
    selector === "main[data-app-shell-main-surface]" ? main : null;
  let mainObserver = null;
  let intersectionObserver = null;
  const window = new ListenerTarget();
  Object.assign(window, {
    IntersectionObserver: class {
      constructor(callback, options) {
        this.callback = callback;
        this.options = options;
        this.targets = [];
        this.unobserved = [];
        intersectionObserver = this;
      }
      disconnect() {}
      observe(target) {
        this.targets.push(target);
      }
      unobserve(target) {
        this.unobserved.push(target);
      }
    },
    MutationObserver: class {
      constructor(callback) {
        this.callback = callback;
      }
      disconnect() {}
      observe(target, options) {
        if (target === main && options?.subtree === true) mainObserver = this;
      }
    },
    cancelAnimationFrame: scheduler.cancelAnimationFrame,
    requestAnimationFrame: scheduler.requestAnimationFrame,
  });
  window.window = window;

  vm.runInNewContext(OFFSCREEN_ANIMATION_GUARD_SOURCE, { document, window });
  assert.equal(intersectionObserver.options.root, main);
  assert.equal(visibleFade.style.getPropertyValue("animation-play-state"), "paused");
  assert.equal(offscreenFade.style.getPropertyValue("animation-play-state"), "paused");
  scheduler.flushFrames();
  assert.equal(visibleFade.style.getPropertyValue("animation-play-state"), "");
  assert.equal(offscreenFade.style.getPropertyValue("animation-play-state"), "paused");

  offscreenTop = 30;
  mainEvents.emit("scroll");
  scheduler.flushFrames();
  assert.equal(offscreenFade.style.getPropertyValue("animation-play-state"), "");

  mainObserver.callback([{ addedNodes: [replacementFade], removedNodes: [offscreenFade] }]);
  assert.equal(intersectionObserver.unobserved.includes(offscreenFade), true);
  assert.equal(offscreenFade.style.getPropertyValue("animation-play-state"), "");
  assert.equal(replacementFade.style.getPropertyValue("animation-play-state"), "paused");
});

test("offscreen animation guard releases and reinstalls when the sidebar root is replaced", () => {
  const scheduler = createScheduler();
  const document = new ListenerTarget();
  document.documentElement = new TestElement("html");
  const rootContainer = new TestElement();
  document.documentElement.appendChild(rootContainer);

  function createSidebar() {
    const spinner = new TestElement();
    spinner.matches = (selector) => selector === ".animate-spin";
    spinner.getBoundingClientRect = () => ({ bottom: 220, left: 0, right: 20, top: 200 });
    const sidebar = new TestElement();
    const events = new ListenerTarget();
    sidebar.addEventListener = events.addEventListener.bind(events);
    sidebar.removeEventListener = events.removeEventListener.bind(events);
    sidebar.getBoundingClientRect = () => ({ bottom: 100, left: 0, right: 100, top: 0 });
    sidebar.querySelectorAll = (selector) => selector === ".animate-spin" ? [spinner] : [];
    return { events, sidebar, spinner };
  }

  const first = createSidebar();
  const second = createSidebar();
  rootContainer.appendChild(first.sidebar);
  let currentSidebar = first.sidebar;
  document.querySelector = (selector) =>
    selector === "[data-app-action-sidebar-scroll]" ? currentSidebar : null;
  let rootLifecycleObserver = null;
  const intersectionObservers = [];
  const window = new ListenerTarget();
  Object.assign(window, {
    IntersectionObserver: class {
      constructor(callback, options) {
        this.callback = callback;
        this.options = options;
        intersectionObservers.push(this);
      }
      disconnect() {
        this.disconnected = true;
      }
      observe() {}
      unobserve() {}
    },
    MutationObserver: class {
      constructor(callback) {
        this.callback = callback;
      }
      disconnect() {
        this.disconnected = true;
      }
      observe(target, options) {
        this.target = target;
        this.options = options;
        if (target === rootContainer && options?.subtree !== true) rootLifecycleObserver = this;
      }
    },
    cancelAnimationFrame: scheduler.cancelAnimationFrame,
    requestAnimationFrame: scheduler.requestAnimationFrame,
  });
  window.window = window;

  vm.runInNewContext(OFFSCREEN_ANIMATION_GUARD_SOURCE, { document, window });
  assert.ok(rootLifecycleObserver);
  assert.equal(first.spinner.style.getPropertyValue("animation-play-state"), "paused");
  assert.equal(first.events.listenerCount("scroll"), 1);

  // 模拟 React 用新的滚动容器替换整个侧栏，而不是只替换容器内部的 spinner。
  rootContainer.children = [second.sidebar];
  first.sidebar.parentElement = null;
  first.sidebar.parentNode = null;
  second.sidebar.parentElement = rootContainer;
  second.sidebar.parentNode = rootContainer;
  currentSidebar = second.sidebar;
  const previousRootLifecycleObserver = rootLifecycleObserver;
  previousRootLifecycleObserver.callback([{ addedNodes: [second.sidebar], removedNodes: [first.sidebar] }]);
  scheduler.flushFrames();

  assert.equal(previousRootLifecycleObserver.disconnected, true);
  assert.equal(first.events.listenerCount("scroll"), 0);
  assert.equal(first.spinner.style.getPropertyValue("animation-play-state"), "");
  assert.equal(second.spinner.style.getPropertyValue("animation-play-state"), "paused");
  assert.equal(second.events.listenerCount("scroll"), 1);
  assert.equal(intersectionObservers.at(-1).options.root, second.sidebar);
});

test("shared viewport coordinator coalesces event storms and owns one listener source", () => {
  const scheduler = createScheduler();
  const document = new ListenerTarget();
  document.visibilityState = "visible";
  document.documentElement = { clientHeight: 844 };
  document.body = { clientHeight: 844 };
  const visualViewport = new ListenerTarget();
  visualViewport.height = 700;
  visualViewport.offsetTop = 20;
  const registeredPlugins = [];
  const window = new ListenerTarget();
  Object.assign(window, {
    OpenCodexPluginSystem: {
      registerPlugin(plugin) {
        registeredPlugins.push(plugin);
      },
    },
    cancelAnimationFrame: scheduler.cancelAnimationFrame,
    clearTimeout: scheduler.clearTimeout,
    innerHeight: 844,
    navigator: {},
    requestAnimationFrame: scheduler.requestAnimationFrame,
    setTimeout: scheduler.setTimeout,
    visualViewport,
  });
  window.window = window;

  vm.runInNewContext(MOBILE_VIEWPORT_SOURCE, { console, document, window });
  const coordinator = window.__OpenCodexViewportCoordinator;
  assert.equal(registeredPlugins.length, 1);
  assert.ok(coordinator);

  const desktopActivation = registeredPlugins[0].activate({
    platform: { isMobile: () => false },
    plugin: { isEnabled: () => true },
    scope: "renderer",
  });
  assert.equal(desktopActivation, null);
  assert.equal(window.listenerCount("resize"), 0);
  assert.equal(document.listenerCount("input"), 0);

  const firstReasons = [];
  const secondReasons = [];
  const disposeFirst = coordinator.subscribe((_snapshot, reason) => firstReasons.push(reason));
  const disposeSecond = coordinator.subscribe((_snapshot, reason) => secondReasons.push(reason));

  // 两个插件共享一份初始布局快照，每种底层事件也只安装一个监听器。
  assert.deepEqual({ ...coordinator.diagnostics }, {
    dispatches: 0,
    frameRequests: 0,
    metricReads: 1,
    subscribers: 2,
  });
  assert.equal(window.listenerCount("resize"), 1);
  assert.equal(window.listenerCount("orientationchange"), 1);
  assert.equal(visualViewport.listenerCount("resize"), 1);
  assert.equal(visualViewport.listenerCount("scroll"), 1);
  assert.equal(document.listenerCount("focusin"), 1);
  assert.equal(document.listenerCount("focusout"), 1);
  assert.equal(document.listenerCount("input"), 1);

  visualViewport.emit("resize");
  visualViewport.emit("resize");
  visualViewport.emit("scroll");
  assert.equal(scheduler.frames.size, 1);
  // 高频动画阶段只维护一个 debounce timer，不为每个事件重建全部四个稳定期任务。
  assert.equal(scheduler.timers.size, 1);
  assert.deepEqual({ ...coordinator.diagnostics }, {
    dispatches: 1,
    frameRequests: 1,
    metricReads: 2,
    subscribers: 2,
  });

  scheduler.flushFrames();
  assert.deepEqual({ ...coordinator.diagnostics }, {
    dispatches: 2,
    frameRequests: 1,
    metricReads: 3,
    subscribers: 2,
  });
  assert.deepEqual(firstReasons, ["subscribe", "viewport", "viewport"]);
  assert.deepEqual(secondReasons, firstReasons);

  scheduler.flushTimers();
  assert.equal(scheduler.timers.size, 3);
  assert.equal(coordinator.diagnostics.dispatches, 3);

  // 后台标签立即清空帧和稳定期任务，后续 resize 也不能重新排队。
  document.visibilityState = "hidden";
  document.emit("visibilitychange");
  visualViewport.emit("resize");
  assert.equal(scheduler.frames.size, 0);
  assert.equal(scheduler.timers.size, 0);

  disposeFirst();
  assert.equal(window.listenerCount("resize"), 1);
  disposeSecond();
  assert.equal(window.listenerCount("resize"), 0);
  assert.equal(visualViewport.listenerCount("resize"), 0);
  assert.equal(document.listenerCount("input"), 0);

  // 无订阅期间发生旋转后，重新启用必须读取当前视口，不能复用停止监听前的 700px 快照。
  document.visibilityState = "visible";
  visualViewport.height = 520;
  visualViewport.offsetTop = 12;
  let resumedSnapshot = null;
  let resumedReason = "";
  const disposeResumed = coordinator.subscribe((snapshot, reason) => {
    resumedSnapshot = snapshot;
    resumedReason = reason;
  });
  assert.equal(resumedSnapshot.visualHeight, 520);
  assert.equal(resumedSnapshot.visualBottom, 532);
  assert.equal(coordinator.diagnostics.metricReads, 5);
  window.emit("orientationchange");
  assert.equal(resumedReason, "orientationchange");
  disposeResumed();
});

test("WCO heavy observers exist only while the overlay is visible", () => {
  const scheduler = createScheduler();
  const overlay = new ListenerTarget();
  overlay.visible = false;
  overlay.getTitlebarAreaRect = () => ({ height: 32, width: 900, x: 68, y: 0 });
  const displayMode = new ListenerTarget();
  displayMode.matches = false;
  const root = new TestElement("html");
  root.clientHeight = 800;
  root.clientWidth = 1200;
  const head = new TestElement("head");
  const body = new TestElement("body");
  const elementsById = new Map();
  const document = new ListenerTarget();
  Object.assign(document, {
    body,
    documentElement: root,
    head,
    visibilityState: "visible",
    createElement(tagName) {
      const element = new TestElement(tagName);
      const originalSetAttribute = element.setAttribute.bind(element);
      element.setAttribute = (name, value) => {
        originalSetAttribute(name, value);
        if (name === "id") elementsById.set(String(value), element);
      };
      return element;
    },
    elementFromPoint() {
      return null;
    },
    getElementById(id) {
      return elementsById.get(id) || null;
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
  });
  const mutationObservers = [];
  const resizeObservers = [];
  class TestMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.disconnected = false;
      mutationObservers.push(this);
    }

    disconnect() {
      this.disconnected = true;
    }

    observe() {}
  }
  class TestResizeObserver extends TestMutationObserver {
    constructor(callback) {
      super(callback);
      mutationObservers.pop();
      resizeObservers.push(this);
    }
  }
  const window = new ListenerTarget();
  Object.assign(window, {
    cancelAnimationFrame: scheduler.cancelAnimationFrame,
    clearTimeout: scheduler.clearTimeout,
    getComputedStyle: () => ({ backgroundColor: "transparent", getPropertyValue: () => "" }),
    innerHeight: 800,
    innerWidth: 1200,
    matchMedia: (query) => (query === "(display-mode: window-controls-overlay)" ? displayMode : { matches: false }),
    requestAnimationFrame: scheduler.requestAnimationFrame,
    setTimeout: scheduler.setTimeout,
  });
  window.window = window;

  vm.runInNewContext(WCO_SOURCE, {
    HTMLElement: TestElement,
    MutationObserver: TestMutationObserver,
    ResizeObserver: TestResizeObserver,
    console,
    document,
    navigator: { windowControlsOverlay: overlay },
    window,
  });

  assert.equal(root.dataset.opencodexWcoVisible, "false");
  assert.equal(mutationObservers.length, 0);
  assert.equal(resizeObservers.length, 0);
  scheduler.flushFrames();
  scheduler.flushTimers();

  overlay.visible = true;
  const managedMutationStart = root.style.mutationCount || 0;
  overlay.emit("geometrychange");
  assert.equal(root.dataset.opencodexWcoVisible, "true");
  assert.equal(mutationObservers.length, 1);
  assert.equal(resizeObservers.length, 1);
  assert.equal(mutationObservers[0].disconnected, false);
  scheduler.flushFrames();
  const managedMutationCount = (root.style.mutationCount || 0) - managedMutationStart;
  assert.ok(managedMutationCount > 0);
  const rootStyleRecord = { attributeName: "style", target: root, type: "attributes" };
  mutationObservers[0].callback(Array.from({ length: managedMutationCount }, () => rootStyleRecord));
  assert.equal(scheduler.frames.size, 0);
  // 自写预算消耗完后，同样位于根节点的官方 style 更新仍必须触发一次重新测量。
  mutationObservers[0].callback([rootStyleRecord]);
  assert.equal(scheduler.frames.size, 1);
  scheduler.flushFrames();

  const unrelated = new TestElement("div");
  for (let index = 0; index < 1000; index += 1) {
    mutationObservers[0].callback([
      { addedNodes: [{ nodeType: 3 }], removedNodes: [], target: unrelated, type: "childList" },
    ]);
  }
  assert.equal(scheduler.frames.size, 0);
  const header = new TestElement("header");
  header.matches = (selector) => selector.includes("header[data-app-shell-header-edge-scroll]");
  mutationObservers[0].callback([
    { addedNodes: [header], removedNodes: [], target: unrelated, type: "childList" },
  ]);
  assert.equal(scheduler.frames.size, 1);
  scheduler.flushFrames();

  document.visibilityState = "hidden";
  document.emit("visibilitychange");
  assert.equal(mutationObservers[0].disconnected, true);
  assert.equal(resizeObservers[0].disconnected, true);
  assert.equal(scheduler.frames.size, 0);
  document.visibilityState = "visible";
  document.emit("visibilitychange");
  assert.equal(mutationObservers.length, 2);
  assert.equal(resizeObservers.length, 2);
  scheduler.flushFrames();

  overlay.visible = false;
  overlay.emit("geometrychange");
  assert.equal(root.dataset.opencodexWcoVisible, "false");
  assert.equal(mutationObservers[1].disconnected, true);
  assert.equal(resizeObservers[1].disconnected, true);
  assert.equal(scheduler.frames.size, 0);

  window.emit("resize");
  assert.equal(mutationObservers.length, 2);
  assert.equal(resizeObservers.length, 2);
  window.__opencodexWindowControlsOverlayState.cleanup();
  assert.equal(window.listenerCount("resize"), 0);
  assert.equal(document.listenerCount("visibilitychange"), 0);
});

test("composer observer ignores streaming content and hidden-page mutations", () => {
  const frames = [];
  let observerCallback = null;
  const document = new ListenerTarget();
  document.documentElement = {};
  document.visibilityState = "visible";
  document.getElementById = () => null;
  let documentQueryCount = 0;
  document.querySelectorAll = () => {
    documentQueryCount += 1;
    return [];
  };
  class TestMutationObserver {
    constructor(callback) {
      observerCallback = callback;
    }

    disconnect() {}

    observe() {}
  }
  const window = {
    __OpenCodexSmartSchedulingInjectionHealth: { report: () => Promise.resolve() },
  };
  window.window = window;
  vm.runInNewContext(COMPOSER_SOURCE, {
    MutationObserver: TestMutationObserver,
    console,
    document,
    requestAnimationFrame(callback) {
      frames.push(callback);
      return frames.length;
    },
    window,
  });
  frames.shift()();
  documentQueryCount = 0;

  let localQueryCount = 0;
  const unrelated = {
    nodeType: 1,
    closest: () => null,
    contains: () => false,
    matches: () => false,
    querySelector: () => {
      localQueryCount += 1;
      return null;
    },
  };
  observerCallback([{ type: "childList", target: unrelated, addedNodes: [unrelated], removedNodes: [] }]);
  localQueryCount = 0;
  for (let index = 0; index < 1000; index += 1) {
    observerCallback([{ type: "characterData", target: { parentElement: unrelated } }]);
  }
  assert.equal(frames.length, 0);
  assert.equal(documentQueryCount, 0);
  assert.equal(localQueryCount, 0);

  const trigger = {
    ...unrelated,
    matches: (selector) => selector.includes("data-codex-intelligence-trigger"),
  };
  observerCallback([{ type: "attributes", target: trigger, attributeName: "aria-controls" }]);
  assert.equal(frames.length, 1);
  frames.shift()();

  document.visibilityState = "hidden";
  observerCallback([{ type: "childList", target: trigger, addedNodes: [trigger], removedNodes: [] }]);
  assert.equal(frames.length, 0);
});

test("settings and summary observers never scan unrelated mutation targets", () => {
  let localQueryCount = 0;
  const unrelated = {
    className: "",
    closest: () => null,
    matches: () => false,
    nodeType: 1,
    parentElement: null,
    querySelector: () => {
      localQueryCount += 1;
      return null;
    },
  };
  const unrelatedRecord = { addedNodes: [], removedNodes: [], target: unrelated, type: "childList" };

  const settingsFilters = vm.runInNewContext(
    `(() => {
      let active = false;
      let page = null;
      ${sourceSection(
        SETTINGS_SOURCE,
        "  function nodeTouchesSettings",
        "\n\n  function install"
      )}
      return { mutationsTouchSettings, nodeTouchesSettings };
    })()`
  );
  let summaryRenderCount = 0;
  const summaryFilters = vm.runInNewContext(
    `(() => {
      const PINNED_SUMMARY_ROOT_SELECTOR = '[data-pip-obstacle="thread-summary-panel"]';
      const OVERLAY_SUMMARY_MARKER_SELECTOR = '[data-pip-obstacle="thread-summary-panel-popover"]';
      const NATIVE_SUMMARY_ITEM_SELECTOR = '[data-slot="thread-summary-panel-item"]';
      const OVERLAY_SUMMARY_CONTENT_CLASS =
        "max-h-[min(var(--radix-popover-content-available-height),calc(100vh-16px))]";
      let renderCount = 0;
      function scheduleRender() { renderCount += 1; }
      function syncCurrentThread() {}
      ${sourceSection(SUMMARY_SOURCE, "  function hasClass", "\n\n  function officialOverlaySummaryContainer")}
      ${sourceSection(
        SUMMARY_SOURCE,
        "  function nodeContainsSidebarThread",
        "\n\n  function handleNotification"
      )}
      return {
        handleMutations,
        nodeTouchesSummaryMount,
        renderCount: () => renderCount,
      };
    })()`
  );

  for (let index = 0; index < 1000; index += 1) {
    assert.equal(settingsFilters.mutationsTouchSettings([unrelatedRecord]), false);
    summaryFilters.handleMutations([unrelatedRecord]);
  }
  summaryRenderCount = summaryFilters.renderCount();
  assert.equal(localQueryCount, 0);
  assert.equal(summaryRenderCount, 0);

  // 真实新增子树仍向下检查挂载点，不能因叶节点过滤优化漏掉设置页或摘要面板。
  const addedSettingsTree = { ...unrelated, firstElementChild: {}, querySelector: () => ({}) };
  assert.equal(settingsFilters.nodeTouchesSettings(addedSettingsTree, true), true);
  const summaryContent = {
    ...unrelated,
    className: "max-h-[min(var(--radix-popover-content-available-height),calc(100vh-16px))]",
  };
  assert.equal(summaryFilters.nodeTouchesSummaryMount(summaryContent), true);
});

test("injection health polls only while the explicit settings lifecycle is active", () => {
  const frames = [];
  const intervals = new Map();
  let nextIntervalId = 1;
  const page = { dataset: { active: "false" } };
  const mount = { closest: () => page };
  const document = new ListenerTarget();
  document.documentElement = { lang: "zh-CN" };
  document.querySelectorAll = () => [mount];
  document.visibilityState = "visible";
  const window = new ListenerTarget();
  Object.assign(window, {
    __CODEX_WEB_CONFIG__: { locale: "zh-CN", messages: {} },
    clearInterval(id) {
      intervals.delete(id);
    },
    crypto: { randomUUID: () => "health-client" },
    requestAnimationFrame(callback) {
      frames.push(callback);
      return frames.length;
    },
    setInterval(callback, delay) {
      const id = nextIntervalId++;
      intervals.set(id, { callback, delay });
      return id;
    },
    setTimeout() {
      return 1;
    },
  });
  window.window = window;

  vm.runInNewContext(HEALTH_SOURCE, {
    console,
    document,
    fetch: () => new Promise(() => {}),
    window,
  });
  frames.shift()();
  assert.equal(intervals.size, 0);

  page.dataset.active = "true";
  window.emit("opencodex:smart-scheduling-settings-visibility-changed");
  frames.shift()();
  assert.equal(intervals.size, 1);

  page.dataset.active = "false";
  window.emit("opencodex:smart-scheduling-settings-visibility-changed");
  frames.shift()();
  assert.equal(intervals.size, 0);

  page.dataset.active = "true";
  window.emit("opencodex:smart-scheduling-settings-visibility-changed");
  frames.shift()();
  assert.equal(intervals.size, 1);
  document.visibilityState = "hidden";
  document.emit("visibilitychange");
  assert.equal(intervals.size, 0);
});

test("tooltip guard uses one pointer stream and does no timer work without tooltips", () => {
  const scheduler = createScheduler();
  const document = new ListenerTarget();
  document.activeElement = null;
  document.documentElement = {};
  let tooltipNode = null;
  document.querySelector = () => tooltipNode;
  document.querySelectorAll = () => (tooltipNode ? [tooltipNode] : []);
  document.visibilityState = "visible";
  const observers = [];
  class TestMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.disconnected = false;
      this.observing = false;
      observers.push(this);
    }
    disconnect() {
      this.disconnected = true;
      this.observing = false;
    }
    observe() {
      this.disconnected = false;
      this.observing = true;
    }
  }
  const window = new ListenerTarget();
  Object.assign(window, {
    Event: class TestEvent {},
    MutationObserver: TestMutationObserver,
    PointerEvent: class TestPointerEvent {},
    clearTimeout: scheduler.clearTimeout,
    setTimeout: scheduler.setTimeout,
  });
  window.window = window;

  vm.runInNewContext(TOOLTIP_SOURCE, { console, document, window });
  assert.equal(document.listenerCount("pointermove"), 1);
  assert.equal(document.listenerCount("mousemove"), 0);

  for (let index = 0; index < 1000; index += 1) {
    document.emit("pointermove", { clientX: index, clientY: index, target: { nodeType: 1 } });
  }
  assert.equal(scheduler.timers.size, 0);
  assert.equal(observers.length, 0);

  document.emit("pointerover", { target: { closest: () => null, nodeType: 1 } });
  assert.equal(observers.length, 0);
  assert.equal(scheduler.timers.size, 0);

  document.emit("pointerover", { target: { closest: () => ({}), nodeType: 1 } });
  assert.equal(observers.length, 1);
  assert.equal(observers[0].observing, true);
  assert.equal(scheduler.timers.size, 1);
  document.emit("pointerover", { target: { closest: () => ({}), nodeType: 1 } });
  assert.equal(observers.length, 1);
  assert.equal(scheduler.timers.size, 1);
  tooltipNode = {
    contains: () => false,
    firstElementChild: null,
    id: "tooltip-1",
    matches: () => true,
    nodeType: 1,
  };
  observers[0].callback([{ addedNodes: [tooltipNode] }]);
  assert.equal(observers[0].disconnected, true);
  // 观察会话 timer 已清掉，只剩一次指针归属校验。
  assert.equal(scheduler.timers.size, 1);
});

test("gateway logout menu observes DOM only during an interaction session", () => {
  const scheduler = createScheduler();
  const document = new ListenerTarget();
  document.documentElement = {};
  document.readyState = "complete";
  const observers = [];
  class TestMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.disconnected = false;
      this.observing = false;
      observers.push(this);
    }

    disconnect() {
      this.disconnected = true;
      this.observing = false;
    }

    observe() {
      this.disconnected = false;
      this.observing = true;
    }
  }
  const window = new ListenerTarget();
  Object.assign(window, {
    clearTimeout: scheduler.clearTimeout,
    requestAnimationFrame: scheduler.requestAnimationFrame,
    setTimeout: scheduler.setTimeout,
  });
  window.window = window;
  const api = vm.runInNewContext(
    `(() => {
      const w = window;
      function gatewayAuthLogoutItemFromEvent() { return null; }
      function handleGatewayAuthLogoutPointer() {}
      function handleGatewayAuthLogoutKeydown() {}
      function scanGatewayAuthLogoutMenuItems() { return 1; }
      ${sourceSection(
        BRIDGE_SOURCE,
        "  function installGatewayAuthMenuInjection",
        "\n\n  function installOpenCodexBuiltinPlugins"
      )}
      installGatewayAuthMenuInjection();
      return {};
    })()`,
    { MutationObserver: TestMutationObserver, document, window }
  );
  assert.ok(api);
  assert.equal(observers.length, 0);

  document.emit("pointerdown", { target: { closest: () => null, nodeType: 1 } });
  assert.equal(observers.length, 0);
  document.emit("pointerdown", { target: { closest: () => ({}), nodeType: 1 } });
  assert.equal(observers.length, 1);
  assert.equal(observers[0].observing, true);
  observers[0].callback([
    {
      addedNodes: [{ closest: () => ({}), nodeType: 1 }],
      target: { closest: () => null, matches: () => false },
    },
  ]);
  scheduler.flushFrames();
  assert.equal(observers[0].disconnected, true);
  assert.equal(observers[0].observing, false);
});

test("remote file menu observes DOM only during a file-tree context-menu session", () => {
  const scheduler = createScheduler();
  const document = new ListenerTarget();
  document.documentElement = {};
  document.readyState = "complete";
  const observers = [];
  class TestMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.disconnected = false;
      this.observing = false;
      observers.push(this);
    }

    disconnect() {
      this.disconnected = true;
      this.observing = false;
    }

    observe() {
      this.disconnected = false;
      this.observing = true;
    }
  }
  const originalFetch = async () => ({ json: async () => ({}), ok: true });
  const window = new ListenerTarget();
  Object.assign(window, {
    clearTimeout: scheduler.clearTimeout,
    fetch: originalFetch,
    location: {
      href: "http://192.168.1.20:3737/",
      hostname: "192.168.1.20",
      origin: "http://192.168.1.20:3737",
    },
    requestAnimationFrame: scheduler.requestAnimationFrame,
    setTimeout: scheduler.setTimeout,
  });
  window.window = window;

  vm.runInNewContext(REMOTE_FILE_ACTIONS_SOURCE, {
    MessageEvent: class TestMessageEvent {},
    MutationObserver: TestMutationObserver,
    URL,
    console,
    document,
    window,
  });
  assert.equal(observers.length, 0);
  // bridge 已在 invoke 前发出同载荷事件，远程文件能力不能再包一层全局 fetch 重复解析每个 IPC body。
  assert.equal(window.fetch, originalFetch);

  let candidateReads = 0;
  const widePayload = {};
  widePayload.self = widePayload;
  widePayload.items = Array.from({ length: 2000 }, (_, index) =>
    Object.defineProperty({}, "value", {
      enumerable: true,
      get() {
        candidateReads += 1;
        return index;
      },
    })
  );
  assert.doesNotThrow(() => {
    window.emit("opencodex:plugin-event", {
      detail: { eventName: "ipc:invoke", payload: widePayload },
    });
  });
  assert.ok(candidateReads > 0 && candidateReads < 1024);

  const container = {
    hasAttribute: () => false,
    nodeType: 1,
    tagName: "FILE-TREE-CONTAINER",
  };
  const item = {
    getAttribute(name) {
      if (name === "data-item-type") return "file";
      if (name === "data-item-path") return "src/index.js";
      return "";
    },
    getBoundingClientRect: () => ({ bottom: 30, height: 20, left: 10, right: 110, top: 10, width: 100 }),
    nodeType: 1,
    parentElement: container,
  };
  document.emit("contextmenu", {
    button: 2,
    clientX: 20,
    clientY: 20,
    composedPath: () => [item, container, document, window],
    target: item,
  });
  assert.equal(observers.length, 1);
  assert.equal(observers[0].observing, true);

  document.emit("pointerdown", { button: 0, target: item });
  assert.equal(observers[0].disconnected, true);
  assert.equal(observers[0].observing, false);
});

test("shared and persisted snapshots are bounded while preserving active keys", () => {
  const snapshots = vm.runInNewContext(
    `(() => {
      const SHARED_OBJECT_SNAPSHOT_MAX_ENTRIES = 4;
      const PERSISTED_ATOM_SNAPSHOT_MAX_ENTRIES = 4;
      const STATSIG_DEFAULT_FEATURES_CONFIG = "statsig";
      const COMPOSER_PERMISSION_MODE_VISIBILITY_KEY = "composer-mode";
      const sharedObjectSnapshot = new Map();
      const persistedAtomSnapshot = new Map();
      const PINNED_SHARED_OBJECT_SNAPSHOT_KEYS = new Set(["host_config", STATSIG_DEFAULT_FEATURES_CONFIG]);
      const PINNED_PERSISTED_ATOM_SNAPSHOT_KEYS = new Set([
        "prompt-history",
        COMPOSER_PERMISSION_MODE_VISIBILITY_KEY,
      ]);
      function normalizeSharedObjectSnapshotValue(_key, value) { return value; }
      function normalizePersistedAtomValue(_key, value) { return value; }
      ${sourceSection(BRIDGE_SOURCE, "  function trimSnapshotMap", "\n\n  /** 判断普通对象")}
      ${sourceSection(BRIDGE_SOURCE, "  function setSharedObjectSnapshotValue", "\n\n  /** 读取 shared-object")}
      ${sourceSection(BRIDGE_SOURCE, "  function setPersistedAtomSnapshotValue", "\n\n  function persistedAtomSnapshotObject")}
      return {
        persistedKeys: () => Array.from(persistedAtomSnapshot.keys()),
        setPersisted: (key) => setPersistedAtomSnapshotValue(key, key, false),
        setShared: (key) => setSharedObjectSnapshotValue(key, key),
        sharedKeys: () => Array.from(sharedObjectSnapshot.keys()),
      };
    })()`
  );

  for (const key of ["host_config", "statsig", "shared-a", "shared-b"]) snapshots.setShared(key);
  snapshots.setShared("shared-a");
  snapshots.setShared("shared-c");
  assert.deepEqual(Array.from(snapshots.sharedKeys()), ["host_config", "statsig", "shared-a", "shared-c"]);

  for (const key of ["prompt-history", "composer-mode", "atom-a", "atom-b"]) snapshots.setPersisted(key);
  snapshots.setPersisted("atom-a");
  snapshots.setPersisted("atom-c");
  assert.deepEqual(Array.from(snapshots.persistedKeys()), ["prompt-history", "composer-mode", "atom-a", "atom-c"]);
});

test("connector logo response cache is bounded and refreshes LRU order", () => {
  const cache = vm.runInNewContext(
    `(() => {
      const CONNECTOR_LOGO_CACHE_MAX_ENTRIES = 256;
      const CONNECTOR_LOGO_CACHE_MAX_CHARS = 10_000;
      const connectorLogoResponseCache = new Map();
      const connectorLogoResponseCacheChars = new Map();
      let connectorLogoResponseCacheTotalChars = 0;
      function clonePlainPayload(payload) { return structuredClone(payload); }
      ${sourceSection(
        BRIDGE_SOURCE,
        "  function touchConnectorLogoCacheEntry",
        "\n\n  function isSuccessfulFetchResponse"
      )}
      return {
        cacheConnectorLogoResponse,
        keys: () => Array.from(connectorLogoResponseCache.keys()),
        read: (key) => connectorLogoResponseCache.get(key),
        size: () => connectorLogoResponseCache.size,
        touchConnectorLogoCacheEntry,
      };
    })()`,
    { structuredClone }
  );

  for (let index = 0; index < 256; index += 1) {
    cache.cacheConnectorLogoResponse(`logo-${index}`, { body: `image-${index}` });
  }
  const oldestPayload = cache.read("logo-0");
  cache.touchConnectorLogoCacheEntry("logo-0", oldestPayload);
  cache.cacheConnectorLogoResponse("logo-256", { body: "image-256" });

  assert.equal(cache.size(), 256);
  assert.equal(cache.read("logo-1"), undefined);
  assert.deepEqual(cache.read("logo-0"), { body: "image-0" });
  assert.equal(cache.keys().at(-1), "logo-256");

  cache.cacheConnectorLogoResponse("oversized", { body: "x".repeat(20_000) });
  assert.equal(cache.read("oversized"), undefined);
});

test("connector logo in-flight requests are bounded and expire with one sweep timer", () => {
  const scheduler = createScheduler();
  const inflight = vm.runInNewContext(
    `(() => {
      let now = 0;
      const Date = { now: () => now };
      const CONNECTOR_LOGO_INFLIGHT_MAX_ENTRIES = 2;
      const CONNECTOR_LOGO_RESPONSE_TIMEOUT_MS = 20;
      const connectorLogoInFlight = new Map();
      const connectorLogoRequestCacheKeys = new Map();
      const emitted = [];
      let connectorLogoSweepTimer = null;
      function cloneConnectorLogoFetchResponse(payload, requestId) { return { ...payload, requestId }; }
      function emitFetchResponse(payload) { emitted.push(payload); }
      function logConnectorLogoDiagnostic() {}
      ${sourceSection(
        BRIDGE_SOURCE,
        "  function emitConnectorLogoWaitingResponses",
        "\n\n  function shouldLogLowPriorityIpcQueue"
      )}
      return {
        emitted,
        keys: () => Array.from(connectorLogoInFlight.keys()),
        rememberConnectorLogoRequest,
        repeatError: emitConnectorLogoInvokeError,
        setNow: (value) => { now = value; },
      };
    })()`,
    {
      w: {
        clearTimeout: scheduler.clearTimeout,
        setTimeout: scheduler.setTimeout,
      },
    }
  );

  inflight.rememberConnectorLogoRequest("logo-a", "request-a");
  inflight.rememberConnectorLogoRequest("logo-b", "request-b");
  inflight.rememberConnectorLogoRequest("logo-c", "request-c");
  assert.equal(inflight.keys().join(","), "logo-b,logo-c");
  assert.equal(inflight.emitted.length, 1);
  assert.equal(scheduler.timers.size, 1);

  inflight.setNow(21);
  scheduler.flushTimers();
  assert.equal(inflight.keys().length, 0);
  assert.equal(inflight.emitted.length, 3);
  assert.equal(inflight.emitted.every((payload) => payload.responseType === "error"), true);
  // HTTP 超时随后再次回调时必须幂等，不能给官方 promise 投递第二个错误。
  inflight.repeatError("logo-c", "request-c", new Error("late abort"));
  assert.equal(inflight.emitted.length, 3);
  assert.equal(scheduler.timers.size, 0);
});

test("low-priority IPC queue rejects overflow instead of retaining unlimited tasks", async () => {
  const queue = vm.runInNewContext(
    `(() => {
      const LOW_PRIORITY_IPC_CONCURRENCY = 0;
      const LOW_PRIORITY_IPC_QUEUE_MAX_ENTRIES = 2;
      const LOW_PRIORITY_IPC_LOG_EVERY = 25;
      const CLIENT_DIAGNOSTICS_ENABLED = false;
      const lowPriorityIpcQueue = [];
      let activeLowPriorityIpcCount = 0;
      let lowPriorityIpcQueuedCount = 0;
      let lowPriorityIpcStartedCount = 0;
      function clientDiagnostic() {}
      ${sourceSection(
        BRIDGE_SOURCE,
        "  function shouldLogLowPriorityIpcQueue",
        "\n\n  clientDiagnostic(\"bridge-installed\""
      )}
      return { enqueueLowPriorityIpc, size: () => lowPriorityIpcQueue.length };
    })()`,
    { Date, Error, Promise }
  );

  void queue.enqueueLowPriorityIpc({}, () => Promise.resolve());
  void queue.enqueueLowPriorityIpc({}, () => Promise.resolve());
  await assert.rejects(queue.enqueueLowPriorityIpc({}, () => Promise.resolve()), /queue limit exceeded/);
  assert.equal(queue.size(), 2);
});

test("browser IPC requests do not serialize the same single argument twice", () => {
  assert.match(BRIDGE_SOURCE, /stringifyForIpc\(\{ channel, args: ipcArgs, clientId \}\)/);
  assert.doesNotMatch(BRIDGE_SOURCE, /stringifyForIpc\(\{ channel, args: ipcArgs, payload, clientId \}\)/);
  assert.match(BRIDGE_SOURCE, /IPC_WS_MAX_BODY_CHARS = 16 \* 1024 \* 1024/);
  assert.match(BRIDGE_SOURCE, /body\.length > IPC_WS_MAX_BODY_CHARS/);
});

test("app-host oversized frames bypass the limit only when they can be sent immediately", () => {
  const relay = vm.runInNewContext(
    `(() => {
      const APP_HOST_PENDING_MESSAGE_LIMIT = 3;
      const APP_HOST_PENDING_MESSAGE_CHARS_LIMIT = 512;
      let sendable = false;
      const sent = [];
      const closed = [];
      function appHostWsPayload(state, payload) { return { portId: state.portId, ...payload }; }
      function sendAppHostWsPayload(payload) {
        if (!sendable) return false;
        sent.push(payload);
        return true;
      }
      function clientDiagnostic() {}
      function closeAppHostRelay(state, reason) {
        state.closed = true;
        state.pending.length = 0;
        state.pendingChars = 0;
        closed.push(reason);
      }
      function flushAppHostRelayMessages(state) {
        while (!state.closed && state.pending.length > 0) {
          if (!sendAppHostWsPayload(state.pending[0])) return;
          const payload = state.pending.shift();
          state.pendingChars = Math.max(0, state.pendingChars - appHostPendingPayloadChars(payload));
        }
      }
      ${sourceSection(
        BRIDGE_SOURCE,
        "  function appHostPendingPayloadChars",
        "\n\n  function closeAppHostRelay"
      )}
      return {
        closed,
        sent,
        queue: queueAppHostRelayPayload,
        setSendable(value) { sendable = value; },
      };
    })()`
  );
  const makeState = (portId) => ({ closed: false, flushing: false, pending: [], pendingChars: 0, portId });

  const offlineLarge = makeState("offline-large");
  relay.queue(offlineLarge, { data: "x".repeat(300), type: "app-host-port-message" });
  assert.equal(offlineLarge.closed, true);
  assert.deepEqual(Array.from(relay.closed), ["queue_overflow"]);

  relay.setSendable(true);
  const onlineLarge = makeState("online-large");
  relay.queue(onlineLarge, { data: "x".repeat(300), type: "app-host-port-message" });
  assert.equal(onlineLarge.closed, false);
  assert.equal(onlineLarge.pending.length, 0);
  assert.equal(relay.sent.length, 1);

  relay.setSendable(false);
  const offlineSmall = makeState("offline-small");
  relay.queue(offlineSmall, { data: "ok", type: "app-host-port-message" });
  assert.equal(offlineSmall.closed, false);
  assert.equal(offlineSmall.pending.length, 1);
});

test("terminal relay bounds per-session, session-count, and total pending work", async () => {
  const relay = vm.runInNewContext(
    `(() => {
      const TERMINAL_QUEUE_MAX_SESSIONS = 2;
      const TERMINAL_QUEUE_MAX_PENDING_PER_SESSION = 2;
      const TERMINAL_QUEUE_MAX_TOTAL_PENDING = 3;
      const TERMINAL_SESSION_ID_MAX_CHARS = 8;
      const terminalMessageQueues = new Map();
      const terminalMessageQueueDepths = new Map();
      let terminalMessagePendingCount = 0;
      const diagnostics = [];
      function clientDiagnostic(event, data) { diagnostics.push({ event, data }); }
      function invoke() { return new Promise(() => {}); }
      ${sourceSection(
        BRIDGE_SOURCE,
        "  function terminalSessionId",
        "\n\n  /** Electron shell.openExternal"
      )}
      return {
        diagnostics,
        enqueue: enqueueTerminalMessage,
        snapshot: () => ({
          pendingCount: terminalMessagePendingCount,
          sessionCount: terminalMessageQueues.size,
          depths: Array.from(terminalMessageQueueDepths.entries()),
        }),
      };
    })()`
  );

  relay.enqueue({ type: "terminal-write", sessionId: "one", data: "a" });
  relay.enqueue({ type: "terminal-write", sessionId: "one", data: "b" });
  await assert.rejects(
    relay.enqueue({ type: "terminal-write", sessionId: "one", data: "c" }),
    /Terminal message queue is full/
  );
  relay.enqueue({ type: "terminal-resize", sessionId: "two" });
  await assert.rejects(
    relay.enqueue({ type: "terminal-write", sessionId: "three", data: "d" }),
    /Terminal message queue is full/
  );

  assert.deepEqual(JSON.parse(JSON.stringify(relay.snapshot())), {
    pendingCount: 3,
    sessionCount: 2,
    depths: [["one", 2], ["two", 1]],
  });
  assert.equal(relay.diagnostics.length, 2);
});

test("Statsig telemetry fetch messages complete locally without gateway work", () => {
  const responses = vm.runInNewContext(
    `(() => {
      const responses = [];
      function isTelemetryRegisterUrl(url) {
        const parsed = new URL(String(url));
        return parsed.hostname === "chatgpt.com" && parsed.pathname === "/ces/v1/rgstr";
      }
      function emitFetchSuccess(requestId, body) { responses.push({ requestId, body }); }
      ${sourceSection(
        BRIDGE_SOURCE,
        "  function handleStatsigTelemetryFetchMessage",
        "\n\n  /** 短延迟"
      )}
      return {
        handle: handleStatsigTelemetryFetchMessage,
        responses,
      };
    })()`,
    { URL }
  );

  assert.equal(
    responses.handle({
      type: "fetch",
      requestId: "statsig-1",
      method: "POST",
      url: "https://chatgpt.com/ces/v1/rgstr?k=client",
    }),
    true
  );
  assert.deepEqual(JSON.parse(JSON.stringify(responses.responses)), [
    { requestId: "statsig-1", body: {} },
  ]);
  assert.equal(
    responses.handle({ type: "fetch", requestId: "other-1", url: "https://example.com/data" }),
    false
  );
});

test("browser Statsig defaults preserve the official new-worktree capability", () => {
  // Web 壳接管 Statsig 初始化后必须显式打开该官方门，否则 Git 项目的工作树入口会静默消失。
  assert.match(BRIDGE_SOURCE, /STATSIG_DEFAULT_FEATURE_OVERRIDES\s*=\s*\{[\s\S]*?"505458": true/);
});

test("token usage passive parsing bounds wide and cyclic payload traversal", () => {
  const compatibilityHits = [];
  const window = {
    clearTimeout,
    location: { origin: "http://127.0.0.1", pathname: "/" },
    OpenCodexRuntimeCompatibility: {
      active(id) {
        compatibilityHits.push(id);
      },
      installed() {},
    },
    setTimeout,
  };
  window.window = window;
  vm.runInNewContext(TOKEN_USAGE_CAPABILITY_SOURCE, {
    AbortController,
    Headers,
    URL,
    console,
    fetch: async () => {
      throw new Error("unexpected token usage fetch");
    },
    window,
  });

  const capability = window.__OpenCodexCreateTokenUsageCapability();
  const release = capability.acquireConsumer("performance-test");
  let passiveArrayReads = 0;
  const passiveWide = new Proxy(Array.from({ length: 50_000 }, () => "ordinary"), {
    get(target, key, receiver) {
      if (/^\d+$/.test(String(key))) passiveArrayReads += 1;
      return Reflect.get(target, key, receiver);
    },
  });
  const cyclicPayload = { payload: passiveWide };
  cyclicPayload.self = cyclicPayload;
  capability.handleGatewayPayload(cyclicPayload);
  // 无 token 线索的超宽消息只能读取固定预算内的数组项，循环引用也不能重复展开。
  assert.ok(passiveArrayReads > 0);
  assert.ok(passiveArrayReads <= 80, `passive scan read ${passiveArrayReads} array items`);
  assert.deepEqual(compatibilityHits, []);

  let topLevelArrayReads = 0;
  const topLevelWide = new Proxy(Array.from({ length: 50_000 }, () => "ordinary"), {
    get(target, key, receiver) {
      if (/^\d+$/.test(String(key))) topLevelArrayReads += 1;
      return Reflect.get(target, key, receiver);
    },
  });
  capability.handleGatewayPayload(topLevelWide);
  // 顶层批消息必须和嵌套数组共享同一预算，不能为每个元素重新获得 80 次扫描额度。
  assert.ok(topLevelArrayReads > 0);
  assert.ok(topLevelArrayReads <= 80, `top-level scan read ${topLevelArrayReads} array items`);

  let treeArrayReads = 0;
  const tokenWide = new Proxy(Array.from({ length: 50_000 }, () => ({})), {
    get(target, key, receiver) {
      if (/^\d+$/.test(String(key))) treeArrayReads += 1;
      return Reflect.get(target, key, receiver);
    },
  });
  capability.handleGatewayPayload({ payload: tokenWide, type: "token_count" });
  // 命中 token 线索后的完整解析也必须在统一树扫描预算内停止，不能先展开整个数组。
  assert.ok(treeArrayReads > 0);
  assert.ok(treeArrayReads <= 2_000, `tree scan read ${treeArrayReads} array items`);

  capability.handleGatewayPayload({
    payload: {
      info: { last_token_usage: { cached_input_tokens: 8, input_tokens: 10, output_tokens: 2 } },
      threadId: "thread-1",
      turnId: "turn-1",
      type: "token_count",
    },
  });
  assert.deepEqual(compatibilityHits, ["web.runtime.protocol.token-usage"]);
  release();
});

test("smart scheduling protocol traversal shares one batch budget", () => {
  const traversal = vm.runInNewContext(
    `(() => {
      const MAX_PROTOCOL_SCAN_NODES = 2048;
      const PROTOCOL_ENVELOPE_KEYS = ["message", "request", "payload", "body"];
      let clientMessages = 0;
      let serverMessages = 0;
      function handleClientMessage() { clientMessages += 1; }
      function handleServerMessage() { serverMessages += 1; }
      ${sourceSection(
        SUMMARY_SOURCE,
        "  function visitProtocolMessages",
        "\n\n  function handleAppHostData"
      )}
      return {
        counts: () => ({ clientMessages, serverMessages }),
        visit: visitProtocolMessages,
      };
    })()`
  );

  let arrayReads = 0;
  const wideBatch = new Proxy(Array.from({ length: 50_000 }, () => ({ method: "thread/read" })), {
    get(target, key, receiver) {
      if (/^\d+$/.test(String(key))) arrayReads += 1;
      return Reflect.get(target, key, receiver);
    },
  });
  traversal.visit(wideBatch, "client");
  assert.ok(arrayReads > 0);
  assert.ok(arrayReads <= 2_048, `protocol traversal read ${arrayReads} array items`);
  assert.ok(traversal.counts().clientMessages <= 2_048);

  const cyclic = { method: "thread/read" };
  cyclic.message = cyclic;
  const before = traversal.counts().serverMessages;
  traversal.visit(cyclic, "server");
  // 同一个 envelope 对象即使形成环，也只能交给业务处理器一次。
  assert.equal(traversal.counts().serverMessages - before, 1);
});

test("whole-document observer filters stay scoped to their feature mounts", () => {
  // 这些源码约束覆盖不适合完整 DOM 模拟的 portal/app-shell 边界，防止后续又引入 closest 全树放大。
  assert.match(IOS_FIX_SOURCE, /mutationObserver\.observe\(observedRoot, \{ childList: true \}\)/);
  assert.match(IOS_FIX_SOURCE, /mutationObserver\.observe\(document\.body, \{ childList: true \}\)/);
  assert.match(IOS_FIX_SOURCE, /document\.visibilityState === "hidden"[\s\S]*mutationObserver\?\.disconnect\(\)/);
  assert.match(IOS_FIX_SOURCE, /reason === "orientationchange"[\s\S]*largestObservedLayoutHeight = 0/);
  assert.doesNotMatch(IOS_FIX_SOURCE, /mutationObserver\.observe\([^)]*, \{[\s\S]*?subtree: true/);
  assert.doesNotMatch(IOS_FIX_SOURCE, /attributeFilter: \["class", "style"\]/);
  assert.match(BRIDGE_SOURCE, /node\.firstElementChild && node\.querySelector\?\.\(menuSelector\)/);
  assert.doesNotMatch(BRIDGE_SOURCE, /node\?\.nodeType === 1 \? node : mutation\.target/);
  assert.match(BRIDGE_SOURCE, /function installGatewayAuthMenuInjection\(\)[\s\S]*observeGatewayAuthMenuSession/);
  assert.match(BRIDGE_SOURCE, /menuObserver \|\|= new MutationObserver\(handleMenuMutations\)/);
  assert.doesNotMatch(
    sourceSection(BRIDGE_SOURCE, "    const start = () => {", "\n    if (document.readyState === \"loading\")"),
    /\.observe\(/
  );
  assert.match(BRIDGE_SOURCE, /reconnectDeferredUntilVisible = true/);
  assert.match(BRIDGE_SOURCE, /document\.visibilityState === "hidden"/);
  assert.match(BRIDGE_SOURCE, /if \(!CLIENT_DIAGNOSTICS_ENABLED\) return/);
  assert.match(BRIDGE_SOURCE, /CLIENT_DIAGNOSTICS_ENABLED \? ipcDiagnosticSummary/);
  assert.match(BRIDGE_SOURCE, /IPC_INVOKE_TIMEOUT_MS = 65_000/);
  assert.match(BRIDGE_SOURCE, /w\.setTimeout\(\(\) => controller\.abort\(\), IPC_INVOKE_TIMEOUT_MS\)/);
  assert.match(BRIDGE_SOURCE, /signal: controller\?\.signal/);
  assert.match(BRIDGE_SOURCE, /CONNECTOR_LOGO_WAITERS_MAX_ENTRIES/);
  assert.match(BRIDGE_SOURCE, /activeBrowserNotifications\.size > BROWSER_NOTIFICATION_MAX_ACTIVE/);
  assert.match(BRIDGE_SOURCE, /appHostPortRelays\.size >= APP_HOST_RELAY_MAX_ENTRIES/);
  assert.match(BRIDGE_SOURCE, /nextPendingChars > APP_HOST_PENDING_MESSAGE_CHARS_LIMIT/);
  assert.match(BRIDGE_SOURCE, /nextPendingChars > APP_HOST_PENDING_MESSAGE_CHARS_LIMIT &&\s*sendAppHostWsPayload\(framedPayload\)/);
  assert.doesNotMatch(BRIDGE_SOURCE, /state\.pending\.length > 0 && nextPendingChars/);
  assert.match(BRIDGE_SOURCE, /state\.pending\.length = 0;[\s\S]*state\.pendingChars = 0/);
  assert.match(BRIDGE_SOURCE, /TERMINAL_QUEUE_MAX_PENDING_PER_SESSION/);
  assert.match(BRIDGE_SOURCE, /TERMINAL_QUEUE_MAX_TOTAL_PENDING/);
  assert.match(BRIDGE_SOURCE, /TERMINAL_QUEUE_MAX_SESSIONS/);
  assert.match(BRIDGE_SOURCE, /SHARED_OBJECT_SNAPSHOT_MAX_ENTRIES = 512/);
  assert.match(BRIDGE_SOURCE, /PERSISTED_ATOM_SNAPSHOT_MAX_ENTRIES = 512/);
  assert.match(BRIDGE_SOURCE, /function handlePostLoginStatsigBootstrapFetchMessage/);
  assert.match(BRIDGE_SOURCE, /statsigPayload: JSON\.stringify\(\{ \.\.\.buildStatsigInitializeResponse\(\), user \}\)/);
  assert.match(BRIDGE_SOURCE, /function handleStatsigTelemetryFetchMessage/);
  assert.match(BRIDGE_SOURCE, /if \(handleStatsigTelemetryFetchMessage\(payload\)\)/);
  assert.match(BRIDGE_SOURCE, /target\.getDesktopUserAgent = \(\) => navigator\.userAgent/);
  assert.match(BRIDGE_SOURCE, /w\.__opencodexPluginImageUrl = localPluginImageUrl/);
  assert.match(BRIDGE_SOURCE, /return `\/api\/plugin-image\?path=\$\{encodeURIComponent\(filePath\)\}`/);
  assert.match(BRIDGE_SOURCE, /activeBrowserFilePickerCancel\?\.\(\)/);
  assert.match(BRIDGE_SOURCE, /sessionTimeout = w\.setTimeout\(cancelPicker, FILE_PICKER_SESSION_TIMEOUT_MS\)/);
  assert.match(HEALTH_SOURCE, /document\.visibilityState === "hidden"[\s\S]*w\.clearInterval\(pollTimer\)/);
  assert.doesNotMatch(HEALTH_SOURCE, /new MutationObserver/);
  assert.match(HEALTH_SOURCE, /w\.addEventListener\(SETTINGS_VISIBILITY_EVENT, schedulePollingSync\)/);
  assert.match(SETTINGS_SOURCE, /w\.dispatchEvent\(new CustomEvent\(HEALTH_VISIBILITY_EVENT\)\)/);
  assert.match(COMPOSER_SOURCE, /triggerTextObserver\.observe\(trigger, \{ characterData: true/);
  assert.doesNotMatch(
    sourceSection(COMPOSER_SOURCE, "  function startComposerObservation", "\n\n  document.addEventListener"),
    /characterData: true/
  );
  assert.match(COMPOSER_SOURCE, /stopComposerObservation\(\);[\s\S]*startComposerObservation\(\)/);
  assert.match(SETTINGS_SOURCE, /document\.visibilityState === "hidden"[\s\S]*stopObservation\(\)/);
  assert.match(TOOLTIP_SOURCE, /if \(!tooltipPresent\) return/);
  assert.match(TOOLTIP_SOURCE, /if \(!tooltipPresent && !tooltipObserverExpiryTimer\) return/);
  assert.match(TOOLTIP_SOURCE, /pointermove", rememberPointer, \{ capture: true, passive: true \}/);
  assert.doesNotMatch(TOOLTIP_SOURCE, /querySelectorAll\("\[aria-describedby\]"\)/);
  assert.match(TOOLTIP_SOURCE, /function observeForTooltipMount\(event\)/);
  assert.match(TOOLTIP_SOURCE, /if \(tooltipObserverExpiryTimer\) \{/);
  assert.match(TOOLTIP_SOURCE, /tooltipObserverExpiryTimer = w\.setTimeout/);
  assert.doesNotMatch(BRIDGE_SOURCE, /renderBridgeErrorToast\(payload\), 0/);
  assert.match(BRIDGE_SOURCE, /retryCount >= BRIDGE_TOAST_BODY_RETRY_MAX/);
  assert.match(BRIDGE_SOURCE, /document\.addEventListener\("error", handleAppFsImageError, true\)/);
  assert.match(BRIDGE_SOURCE, /document\.visibilityState === "hidden"[\s\S]*stopObservation\(\)/);
  assert.match(BRIDGE_SOURCE, /else startObservation\(\)/);
  assert.doesNotMatch(
    sourceSection(BRIDGE_SOURCE, "  function installAppFsImageRewrite", "\n\n  \/\*\* Electron window.setTitle"),
    /childList/
  );
  assert.match(REMOTE_FILE_ACTIONS_SOURCE, /function observePendingPathMenu\(session\)/);
  assert.doesNotMatch(
    sourceSection(REMOTE_FILE_ACTIONS_SOURCE, "  function installMenuObserver", "\n\n  w.addEventListener"),
    /new MutationObserver/
  );
  assert.match(MOBILE_VIEWPORT_SOURCE, /!context\.platform\.isMobile\(\)/);
  assert.match(MOBILE_VIEWPORT_SOURCE, /request\("orientationchange"/);
  assert.doesNotMatch(MOBILE_VIEWPORT_SOURCE, /will-change:\s*transform/);
  assert.match(WCO_SOURCE, /record\.target === cssLengthProbe \|\| record\.target === cssColorProbe/);
  assert.match(WCO_SOURCE, /mutationTouchesMetrics\(record\)/);
  assert.match(TOKEN_USAGE_INLINE_SOURCE, /document\.visibilityState === "hidden"/);
  assert.match(TOKEN_USAGE_INLINE_SOURCE, /intersectionObserver\?\.disconnect\(\);[\s\S]*deactivateConsumer\(\)/);
  assert.match(TOKEN_USAGE_INLINE_SOURCE, /activateConsumer\(\);[\s\S]*startMutationObservation\(\)/);
  assert.match(
    TOKEN_USAGE_INLINE_SOURCE,
    /isForkButton\(button\) && visibleElement\(button\)/
  );
  assert.match(TOKEN_USAGE_INLINE_SOURCE, /if \(!intersectionObserver\) requestUsageForRow\(row, ids\)/);
  assert.match(TOKEN_USAGE_INLINE_SOURCE, /MAX_PENDING_SCAN_ROOTS = 64/);
  assert.match(TOKEN_USAGE_INLINE_SOURCE, /if \(removedNodes\) scheduleScanFlush\(\)/);
  assert.doesNotMatch(
    sourceSection(
      BRIDGE_SOURCE,
      "  function handleTokenUsageAppHostData",
      "\n\n  const smartSchedulingBridgeStats"
    ),
    /OpenCodexRuntimeCompatibility\?\.active/
  );
  assert.match(
    sourceSection(
      TOKEN_USAGE_CAPABILITY_SOURCE,
      "    function setTokenUsageCacheEntry",
      "\n\n    function setTokenUsageNegativeCache"
    ),
    /OpenCodexRuntimeCompatibility\?\.active\?\.\("web\.runtime\.protocol\.token-usage"\)/
  );
  assert.doesNotMatch(
    sourceSection(TOKEN_USAGE_INLINE_SOURCE, "      const observeRow =", "\n\n      const pruneObservedRows"),
    /intersectionObserver\.observe\(row\);\s*}\s*\/\/[^\n]*\n\s*requestUsageForRow/
  );
  assert.match(
    TOKEN_USAGE_INLINE_SOURCE,
    /startMutationObservation\(\);[\s\S]*scheduleScan\(document\.documentElement\)/
  );
  assert.match(
    sourceSection(
      TOKEN_USAGE_INLINE_SOURCE,
      "      const disposeUpdate =",
      "\n\n      if (document.visibilityState === \"visible\")"
    ),
    /intersectionObserver\?\.unobserve\(row\)/
  );
  assert.match(TOKEN_USAGE_CAPABILITY_SOURCE, /TOKEN_USAGE_THREAD_STATE_LIMIT = 256/);
  assert.match(TOKEN_USAGE_CAPABILITY_SOURCE, /TOKEN_USAGE_PENDING_QUERY_LIMIT = 256/);
  assert.match(TOKEN_USAGE_CAPABILITY_SOURCE, /TOKEN_USAGE_PASSIVE_HINT_SCAN_LIMIT = 80/);
  assert.match(
    sourceSection(
      TOKEN_USAGE_CAPABILITY_SOURCE,
      "    function tokenUsageObjectHasPassiveHint",
      "\n\n    function shouldHandleTokenUsagePassiveMessage"
    ),
    /TOKEN_USAGE_PASSIVE_HINT_SCAN_LIMIT - scanned - stack\.length/
  );
  assert.doesNotMatch(
    sourceSection(
      TOKEN_USAGE_CAPABILITY_SOURCE,
      "    function tokenUsageObjectHasPassiveHint",
      "\n\n    function shouldHandleTokenUsagePassiveMessage"
    ),
    /Object\.(?:entries|values)/
  );
  assert.doesNotMatch(
    sourceSection(
      TOKEN_USAGE_CAPABILITY_SOURCE,
      "    function shouldHandleTokenUsagePassiveMessage",
      "\n\n    function markTokenUsagePassiveSkipped"
    ),
    /\.some\(/
  );
  assert.match(
    sourceSection(
      TOKEN_USAGE_CAPABILITY_SOURCE,
      "    function collectTokenUsageFromTree",
      "\n\n    function handleTokenUsageProtocolMessage"
    ),
    /inspectedChildren >= TOKEN_USAGE_TREE_SCAN_LIMIT/
  );
  assert.doesNotMatch(
    sourceSection(
      TOKEN_USAGE_CAPABILITY_SOURCE,
      "    function collectTokenUsageFromTree",
      "\n\n    function handleTokenUsageProtocolMessage"
    ),
    /Object\.(?:entries|values)/
  );
  assert.match(
    sourceSection(TOKEN_USAGE_CAPABILITY_SOURCE, "        const pending = fetchTokenUsageForTurn", "        tokenUsageState.pendingQueries.set"),
    /if \(!tokenUsageConsumerActive\(\)\) return null;[\s\S]*setTokenUsageCacheEntry\(usage\)/
  );
  assert.match(SUMMARY_SOURCE, /node\.querySelector\?\.\(SUMMARY_MARKER_DISCOVERY_SELECTOR\)/);
  assert.match(SUMMARY_SOURCE, /node\.getElementsByClassName\?\.\(OVERLAY_SUMMARY_CONTENT_CLASS\)/);
  assert.match(SUMMARY_SOURCE, /MAX_PROTOCOL_SCAN_NODES = 2048/);
  assert.match(SUMMARY_SOURCE, /document\.visibilityState === "hidden"[\s\S]*stopObservation\(\)/);
  assert.match(SUMMARY_SOURCE, /observerScheduled \|\| document\.visibilityState === "hidden"/);
  assert.match(SUMMARY_SOURCE, /document\.visibilityState === "hidden" \|\|[\s\S]*!normalizedThreadId/);
  assert.doesNotMatch(
    sourceSection(SUMMARY_SOURCE, "  function visitProtocolMessages", "\n\n  function handleAppHostData"),
    /\.forEach\(/
  );
  assert.doesNotMatch(SUMMARY_SOURCE, /querySelectorAll\?\.\("div"\)/);
  assert.match(REMOTE_FILE_ACTIONS_SOURCE, /workspaceRootByRelativePath\.size > MAX_WORKSPACE_PATH_ROOTS/);
  assert.match(REMOTE_FILE_ACTIONS_SOURCE, /MAX_WORKSPACE_ROOT_SCAN_NODES = 1024/);
  assert.doesNotMatch(REMOTE_FILE_ACTIONS_SOURCE, /__codexRemoteFileActionsFetchPatched/);
  assert.doesNotMatch(REMOTE_FILE_ACTIONS_SOURCE, /rememberWorkspaceRootFromIpcBody/);
  assert.match(
    TOKEN_USAGE_CAPABILITY_SOURCE,
    /完成事件都应结束该线程的暂存 usage 生命周期[\s\S]*pendingUsageByThread\.delete/
  );
});
