const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const BUNDLE = fs.readFileSync(
  path.resolve(__dirname, "..", "dist", "web", "opencodex-modification-runtime.js"),
  "utf8"
);

class EventTargetStub {
  constructor() {
    this.listeners = new Map();
  }
  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(callback);
  }
  removeEventListener(type, callback) {
    this.listeners.get(type)?.delete(callback);
  }
  emit(type, event = { type }) {
    for (const callback of this.listeners.get(type) || []) callback(event);
  }
  listenerCount(type) {
    return this.listeners.get(type)?.size || 0;
  }
}

function createHarness() {
  const mutationObservers = [];
  class MutationObserverStub {
    constructor(callback) {
      this.callback = callback;
      this.observeCalls = [];
      this.disconnected = false;
      this.pendingRecords = [];
      mutationObservers.push(this);
    }
    disconnect() {
      this.disconnected = true;
    }
    observe(root, options) {
      this.observeCalls.push({ root, options });
      this.disconnected = false;
    }
    takeRecords() {
      return this.pendingRecords.splice(0);
    }
  }
  const window = new EventTargetStub();
  const document = new EventTargetStub();
  document.documentElement = new EventTargetStub();
  window.window = window;
  vm.runInNewContext(BUNDLE, {
    console,
    document,
    MutationObserver: MutationObserverStub,
    window,
  });
  return { document, host: window.__OpenCodexAdapterHost, mutationObservers, window };
}

test("browser adapter bundle is idempotent across login-shell document replacement", () => {
  const mutationObservers = [];
  class MutationObserverStub {
    constructor(callback) { this.callback = callback; mutationObservers.push(this); }
    disconnect() {}
    observe() {}
    takeRecords() { return []; }
  }
  const window = new EventTargetStub();
  const firstDocument = new EventTargetStub();
  firstDocument.documentElement = new EventTargetStub();
  window.window = window;
  const context = vm.createContext({ console, document: firstDocument, MutationObserver: MutationObserverStub, window });
  vm.runInContext(BUNDLE, context);
  const firstHost = window.__OpenCodexAdapterHost;
  const firstSdk = window.OpenCodexPluginSdk;

  const officialDocument = new EventTargetStub();
  officialDocument.documentElement = new EventTargetStub();
  context.document = officialDocument;
  assert.doesNotThrow(() => vm.runInContext(BUNDLE, context));
  assert.equal(window.__OpenCodexAdapterHost, firstHost);
  assert.equal(window.OpenCodexPluginSdk, firstSdk);
});

test("browser adapter host shares observers and event listeners", () => {
  const harness = createHarness();
  const root = {};
  let firstMutations = 0;
  let secondMutations = 0;
  const disposeFirst = harness.host.dom.observe({
    key: {},
    root,
    options: { childList: true },
    callback() { firstMutations += 1; },
  });
  const disposeSecond = harness.host.dom.observe({
    key: {},
    root,
    options: { attributes: true, attributeFilter: ["class"] },
    callback() { secondMutations += 1; },
  });
  assert.equal(harness.mutationObservers.length, 1);
  const disposeAllAttributes = harness.host.dom.observe({
    key: {},
    root,
    options: { attributes: true },
    callback() {},
  });
  assert.equal(Object.hasOwn(harness.mutationObservers[0].observeCalls.at(-1).options, "attributeFilter"), false);
  harness.mutationObservers[0].callback([{ type: "childList", target: root }], harness.mutationObservers[0]);
  assert.deepEqual([firstMutations, secondMutations], [1, 0]);
  harness.mutationObservers[0].callback(
    [{ type: "attributes", target: root, attributeName: "class" }],
    harness.mutationObservers[0]
  );
  assert.deepEqual([firstMutations, secondMutations], [1, 1]);

  let firstEvents = 0;
  let secondEvents = 0;
  const disposeEventA = harness.host.events.observe({
    key: {}, target: harness.document, type: "click", callback() { firstEvents += 1; },
  });
  const disposeEventB = harness.host.events.observe({
    key: {}, target: harness.document, type: "click", callback() { secondEvents += 1; },
  });
  assert.equal(harness.document.listenerCount("click"), 1);
  const disposeEventPassive = harness.host.events.observe({
    key: {}, target: harness.document, type: "click", passive: true, callback() {},
  });
  assert.equal(harness.document.listenerCount("click"), 1);
  harness.document.emit("click");
  assert.deepEqual([firstEvents, secondEvents], [1, 1]);

  let onceEvents = 0;
  harness.host.events.observe({
    key: {}, target: harness.document, type: "focus", once: true, callback() { onceEvents += 1; },
  });
  harness.document.emit("focus");
  harness.document.emit("focus");
  assert.equal(onceEvents, 1);
  assert.equal(harness.document.listenerCount("focus"), 0);

  disposeFirst();
  assert.equal(harness.mutationObservers[0].disconnected, false);
  disposeSecond();
  disposeAllAttributes();
  assert.equal(harness.mutationObservers[0].disconnected, true);
  disposeEventA();
  assert.equal(harness.document.listenerCount("click"), 1);
  disposeEventB();
  disposeEventPassive();
  assert.equal(harness.document.listenerCount("click"), 0);
});

test("browser adapter host flushes pending mutations before adding a late subscriber", () => {
  const harness = createHarness();
  const root = {};
  let first = 0;
  let second = 0;
  const disposeFirst = harness.host.dom.observe({
    key: {}, root, options: { childList: true }, callback() { first += 1; },
  });
  harness.mutationObservers[0].pendingRecords.push({ type: "childList", target: root });
  const disposeSecond = harness.host.dom.observe({
    key: {}, root, options: { childList: true }, callback() { second += 1; },
  });
  assert.deepEqual([first, second], [1, 0]);
  disposeFirst();
  disposeSecond();
});

test("browser adapter host installs one ordered wrapper per hook target", () => {
  const { host } = createHarness();
  const target = {
    calculate(value) {
      return value + 1;
    },
  };
  const original = target.calculate;
  const disposeOuter = host.hooks.around({
    key: {},
    target,
    property: "calculate",
    order: 10,
    handle(_thisValue, args, proceed) {
      return proceed([args[0] * 2]);
    },
  });
  const wrapper = target.calculate;
  const disposeInner = host.hooks.around({
    key: {},
    target,
    property: "calculate",
    order: 20,
    handle(_thisValue, args, proceed) {
      return proceed(args) + 3;
    },
  });
  assert.equal(target.calculate, wrapper);
  assert.equal(target.calculate(4), 12);
  assert.equal(host.diagnostics().hookTargetCount, 1);
  disposeOuter();
  assert.equal(target.calculate(4), 8);
  disposeInner();
  assert.equal(target.calculate, original);
});

test("browser protocol pipeline decodes each frame once and fans out by channel", () => {
  const { host } = createHarness();
  const values = [];
  const disposeLazy = host.protocol.observe({
    key: {},
    channel: host.protocol.channels.gateway,
    callback(frame) { assert.equal(typeof frame.raw, "string"); },
  });
  host.protocol.publish({ channel: host.protocol.channels.gateway, value: '{"method":"unrelated"}' });
  assert.equal(host.diagnostics().protocolDecodeCount, 0);
  disposeLazy();
  const channel = host.protocol.channels.appHost;
  const disposeFirst = host.protocol.observe({
    key: {}, channel, callback(frame) { values.push(frame.value); },
  });
  const disposeSecond = host.protocol.observe({
    key: {}, channel, callback(frame) { values.push(frame.value); },
  });
  host.protocol.publish({ channel, value: '{"method":"turn/completed"}', metadata: { direction: "server" } });
  assert.equal(values.length, 2);
  assert.equal(values[0], values[1]);
  assert.equal(values[0].method, "turn/completed");
  assert.equal(host.diagnostics().protocolDecodeCount, 1);
  assert.equal(host.diagnostics().protocolDispatchCount, 2);
  assert.equal(host.diagnostics().protocolSubscriberCount, 2);
  disposeFirst();
  disposeSecond();
  assert.equal(host.diagnostics().protocolSubscriberCount, 0);
});

test("browser plugin SDK v2 commits strong references and mounts virtual views", () => {
  const harness = createHarness();
  const mountedNodes = [];
  const target = {
    append(node) {
      node.parentNode = this;
      node.isConnected = true;
      mountedNodes.push(node);
    },
    removeChild(node) {
      const index = mountedNodes.indexOf(node);
      if (index >= 0) mountedNodes.splice(index, 1);
      node.parentNode = null;
      node.isConnected = false;
    },
  };
  harness.document.querySelectorAll = (selector) => selector === "[data-test-slot]" ? [target] : [];
  harness.document.createTextNode = (textContent) => ({ isConnected: false, parentNode: null, textContent });
  harness.document.createElement = (tagName) => {
    const element = new EventTargetStub();
    element.attributes = new Map();
    element.children = [];
    element.isConnected = false;
    element.parentNode = null;
    element.tagName = tagName.toUpperCase();
    element.appendChild = (node) => { node.parentNode = element; element.children.push(node); return node; };
    element.setAttribute = (name, value) => element.attributes.set(name, value);
    return element;
  };

  let registeredPlugin = null;
  harness.window.OpenCodexPluginSystem = {
    registerPlugin(plugin) {
      registeredPlugin = plugin;
    },
  };
  const root = harness.window.OpenCodexPluginSdk;
  assert.equal(root.apiVersion, 2);
  const sdk = root.createPluginScope({
    id: "example.virtual-view",
    apiVersion: 2,
    sdkVersion: "^2.0.0",
  });
  const group = sdk.groups.register({
    id: "example.virtual-view-group",
    name: "虚拟视图示例",
    description: "验证 ESM 插件不直接接触真实 DOM",
    order: 900,
  });
  const locator = sdk.view.locators.css("locator.example-slot", "[data-test-slot]");
  const content = sdk.view.ui.element({ tag: "span", children: [sdk.view.ui.text("ready")] });
  const semantic = sdk.adapters.compose({
    id: "adapter.example-view",
    name: "示例语义视图",
    description: "把示例声明展开到公共语义视图适配器",
    dependencies: [sdk.adapters.semanticView.ref],
    expand(declaration) {
      return [sdk.adapters.semanticView.mount(declaration)];
    },
  });
  sdk.points.register({
    id: "example.virtual-view.mount",
    description: "在测试槽位挂载虚拟节点",
    group,
    contributions: [semantic.use({ locator, placement: sdk.view.placements.append, content })],
  });
  harness.window.demoApi = {
    calculate(value) {
      return value + 1;
    },
  };
  const originalCalculate = harness.window.demoApi.calculate;
  const hookTarget = sdk.hooks.targets.windowMethod("hook.example-calculate", ["demoApi", "calculate"]);
  const routeSchema = sdk.protocol.schemas.define("schema.example-route", (value) => {
    return value?.method === "route/selected" ? value : null;
  });
  sdk.points.register({
    id: "example.virtual-view.hook-and-protocol",
    description: "同时验证底层 Hook 与协议适配器",
    group,
    contributions: [
      sdk.adapters.runtimeHook.after({
        target: hookTarget,
        handle({ result }) { return result + 2; },
      }),
      sdk.adapters.protocolPipeline.observe({
        channel: sdk.protocol.channels.appHost,
        schema: routeSchema,
        handle() {},
      }),
    ],
  });
  sdk.commit();
  assert.equal(typeof registeredPlugin.activate, "function");
  const dispose = registeredPlugin.activate({ scope: "renderer" });
  assert.equal(mountedNodes.length, 1);
  let pluginSnapshot = root.snapshot()[0];
  assert.equal(pluginSnapshot.points.find((point) => point.id.endsWith(".mount")).status, "active");
  assert.equal(pluginSnapshot.points.find((point) => point.id.endsWith("hook-and-protocol")).status, "ready");
  assert.equal(harness.window.demoApi.calculate(3), 6);
  pluginSnapshot = root.snapshot()[0];
  assert.equal(pluginSnapshot.points.find((point) => point.id.endsWith("hook-and-protocol")).status, "ready");
  harness.host.protocol.publish({
    channel: harness.host.protocol.channels.appHost,
    value: '{"method":"route/selected"}',
  });
  pluginSnapshot = root.snapshot()[0];
  assert.equal(pluginSnapshot.points.find((point) => point.id.endsWith("hook-and-protocol")).status, "active");
  dispose();
  assert.equal(mountedNodes.length, 0);
  assert.equal(harness.window.demoApi.calculate, originalCalculate);
});
