const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const PLUGIN_SOURCE = fs.readFileSync(
  path.resolve(__dirname, "..", "..", "web-shell", "internal", "providers", "mobile-sidebar-auto-collapse.js"),
  "utf-8"
);

// 只模拟插件实际读取的 DOM 能力，让回归测试聚焦按钮识别和侧栏收起链路。
function createElement(tagName, initialAttributes = {}) {
  const attributes = new Map(Object.entries(initialAttributes));
  const children = [];
  const element = {
    nodeType: 1,
    parentElement: null,
    disabled: false,
    style: {},
    appendChild(child) {
      child.parentElement = element;
      children.push(child);
      return child;
    },
    contains(candidate) {
      return candidate === element || children.some((child) => child.contains(candidate));
    },
    closest(selector) {
      for (let node = element; node; node = node.parentElement) {
        if (node.matches(selector)) return node;
      }
      return null;
    },
    getAttribute(name) {
      return attributes.has(name) ? attributes.get(name) : null;
    },
    getBoundingClientRect() {
      return { width: 240, height: 40 };
    },
    matches(selector) {
      if (selector === tagName) return true;
      if (selector === "button") return tagName === "button";
      if (selector === "nav") return tagName === "nav";
      const attributeMatch = /^\[([^=\]]+)\]$/.exec(selector);
      return !!attributeMatch && attributes.has(attributeMatch[1]);
    },
    querySelector(selector) {
      return element.querySelectorAll(selector)[0] || null;
    },
    querySelectorAll(selector) {
      const matches = [];
      for (const child of children) {
        if (selector === "svg path") {
          if (child.tagName === "path") matches.push(child);
        } else if (child.matches(selector)) {
          matches.push(child);
        }
        matches.push(...child.querySelectorAll(selector));
      }
      return matches;
    },
    setAttribute(name, value) {
      attributes.set(name, String(value));
    },
    tagName,
  };
  return element;
}

function createHarness(iconPath) {
  const listeners = new Map();
  const timers = new Map();
  let nextTimerId = 1;
  let toggleClickCount = 0;
  let fallbackMessageCount = 0;
  let registeredPlugin = null;

  const panel = createElement("div");
  const scroll = createElement("div", { "data-app-action-sidebar-scroll": "" });
  const newTaskButton = createElement("button");
  const svg = createElement("svg");
  const icon = createElement("path", { d: iconPath });
  const toggleButton = createElement("button", { "data-app-shell-sidebar-trigger": "true" });
  toggleButton.click = () => {
    toggleClickCount += 1;
  };
  panel.appendChild(scroll);
  panel.appendChild(newTaskButton);
  newTaskButton.appendChild(svg);
  svg.appendChild(icon);

  const document = {
    addEventListener(type, handler, capture = false) {
      listeners.set(type, { capture, handler });
    },
    querySelector(selector) {
      if (selector === ".app-shell-left-panel") return panel;
      if (selector === "[data-app-shell-sidebar-trigger]") return toggleButton;
      return null;
    },
    querySelectorAll(selector) {
      return selector === "button" ? [newTaskButton, toggleButton] : [];
    },
    removeEventListener(type, handler) {
      if (listeners.get(type)?.handler === handler) listeners.delete(type);
    },
  };
  const window = {
    clearTimeout(timerId) {
      timers.delete(timerId);
    },
    getComputedStyle() {
      return { display: "block", visibility: "visible" };
    },
    location: { origin: "http://localhost" },
    postMessage() {
      fallbackMessageCount += 1;
    },
    setTimeout(callback) {
      const timerId = nextTimerId++;
      timers.set(timerId, callback);
      return timerId;
    },
  };
  window.OpenCodexPluginSystem = {
    registerPlugin(plugin) {
      registeredPlugin = plugin;
    },
  };
  window.__OpenCodexAdapterHost = {
    events: {
      observe({ type, capture = false, callback }) {
        listeners.set(type, { capture, handler: callback });
        return () => {
          if (listeners.get(type)?.handler === callback) listeners.delete(type);
        };
      },
    },
  };
  window.window = window;

  vm.runInNewContext(PLUGIN_SOURCE, { console, document, window });
  const dispose = registeredPlugin.activate({
    events: { on: () => () => {} },
    platform: { isMobile: () => true },
    plugin: { isEnabled: () => true },
    scope: "renderer",
  });

  return {
    appendSidebarChild(element) {
      scroll.appendChild(element);
    },
    clickNewTask() {
      listeners.get("click").handler({
        altKey: false,
        button: 0,
        ctrlKey: false,
        defaultPrevented: false,
        metaKey: false,
        shiftKey: false,
        target: icon,
      });
    },
    pointerDown(target, pointerType) {
      let stopped = 0;
      listeners.get("pointerdown").handler({
        pointerType,
        stopPropagation() {
          stopped += 1;
        },
        target,
      });
      return stopped;
    },
    listenerCapture(type) {
      return listeners.get(type)?.capture;
    },
    dispose,
    fallbackMessageCount: () => fallbackMessageCount,
    flushTimers() {
      for (const [timerId, callback] of Array.from(timers)) {
        timers.delete(timerId);
        callback();
      }
    },
    pendingTimerCount: () => timers.size,
    toggleClickCount: () => toggleClickCount,
  };
}

test("mobile sidebar collapses after clicking new task icons from supported renderer versions", () => {
  // 旧版和当前版图标都必须触发收起，升级官方 renderer 时不能破坏移动端行为。
  for (const iconPath of ["M2.6687 11.333 legacy", "M6.33325 1.88379 current"]) {
    const harness = createHarness(iconPath);
    harness.clickNewTask();
    assert.equal(harness.pendingTimerCount(), 1);
    harness.flushTimers();
    assert.equal(harness.toggleClickCount(), 1);
    assert.equal(harness.fallbackMessageCount(), 0);
    harness.dispose();
  }
});

test("mobile sidebar ignores unrelated sidebar icon buttons", () => {
  const harness = createHarness("M0 0 unrelated");
  harness.clickNewTask();
  assert.equal(harness.pendingTimerCount(), 0);
  assert.equal(harness.toggleClickCount(), 0);
  harness.dispose();
});

test("mobile sidebar keeps touch scrolling out of the official thread drag sensor", () => {
  const harness = createHarness("M0 0 unrelated");
  const threadRow = createElement("div", {
    "data-app-action-sidebar-thread-id": "thread-1",
    "data-app-action-sidebar-thread-kind": "local",
    "data-app-action-sidebar-thread-row": "",
  });
  const unrelated = createElement("div");

  harness.appendSidebarChild(threadRow);
  assert.equal(harness.listenerCapture("pointerdown"), true);
  assert.equal(harness.pointerDown(threadRow, "touch"), 1);
  assert.equal(harness.pointerDown(threadRow, "mouse"), 0);
  assert.equal(harness.pointerDown(unrelated, "touch"), 0);
  harness.dispose();
});
