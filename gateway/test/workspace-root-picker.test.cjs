const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const PICKER_SOURCE = fs.readFileSync(
  path.resolve(__dirname, "..", "..", "web-shell", "internal", "providers", "codex-workspace-root-picker.js"),
  "utf-8"
);

function serializable(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function createFakeElement(tagName, elements) {
  // 测试只实现 picker 实际使用的 DOM 子集，避免引入浏览器或第三方 DOM 依赖。
  const element = {
    attributes: {},
    children: [],
    className: "",
    disabled: false,
    listeners: new Map(),
    parentNode: null,
    removed: false,
    tagName: String(tagName || "").toUpperCase(),
    value: "",
    addEventListener(type, handler) {
      this.listeners.set(type, handler);
    },
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    focus() {
      this.focused = true;
    },
    remove() {
      this.removed = true;
      if (!this.parentNode) return;
      this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
      this.parentNode = null;
    },
    select() {
      this.selected = true;
    },
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
  };
  elements.push(element);
  return element;
}

function createPickerHarness({ hostname = "remote.example.com", resolvePath } = {}) {
  const delivered = [];
  const elements = [];
  const invokes = [];
  const toasts = [];
  const windowListeners = new Map();
  const body = createFakeElement("body", elements);
  const document = {
    body,
    createElement(tagName) {
      return createFakeElement(tagName, elements);
    },
  };
  const window = {
    __OpenCodexAdapterHost: {
      events: {
        observe({ target, type, callback, capture = false }) {
          target.addEventListener(type, callback, capture);
          return () => target.removeEventListener(type, callback, capture);
        },
      },
    },
    __codexWebBridgeHelpers: {
      deliverLocalRendererMessage(channel, payload) {
        delivered.push({ channel, payload: serializable(payload) });
        return 1;
      },
      async invoke(channel, payload) {
        const normalizedPayload = serializable(payload);
        invokes.push({ channel, payload: normalizedPayload });
        if (channel === "opencodex:validate-workspace-root") {
          const root = typeof resolvePath === "function" ? resolvePath(normalizedPayload.path) : normalizedPayload.path;
          return { root };
        }
        return true;
      },
      normalizeErrorMessage(error) {
        return error && error.message ? error.message : String(error || "");
      },
      showToast(payload) {
        toasts.push(serializable(payload));
      },
      t(key) {
        return key;
      },
    },
    addEventListener(type, handler) {
      windowListeners.set(type, handler);
    },
    dispatchEvent() {},
    location: { hostname },
    removeEventListener(type, handler) {
      if (windowListeners.get(type) === handler) windowListeners.delete(type);
    },
    requestAnimationFrame(callback) {
      callback();
      return 1;
    },
  };

  vm.runInNewContext(PICKER_SOURCE, { console, document, window });
  return {
    api: window.OpenCodexWorkspaceRootPicker,
    delivered,
    elements,
    invokes,
    toasts,
  };
}

function activeElement(harness, tagName) {
  return harness.elements.find((element) => element.tagName === tagName && !element.removed);
}

async function submitDialog(harness, rawValue) {
  const form = activeElement(harness, "FORM");
  const input = activeElement(harness, "INPUT") || activeElement(harness, "TEXTAREA");
  assert.ok(form, "workspace root dialog form should exist");
  assert.ok(input, "workspace root dialog input should exist");
  input.value = rawValue;
  const submit = form.listeners.get("submit");
  assert.equal(typeof submit, "function");
  await submit({ preventDefault() {} });
}

test("workspace root picker intercepts both official protocols only for remote browsers", () => {
  const remote = createPickerHarness();
  assert.equal(remote.api.shouldHandleMessage({ type: "electron-add-new-workspace-root-option" }), true);
  assert.equal(
    remote.api.shouldHandleMessage({ type: "electron-add-new-workspace-root-option", root: "/already/validated" }),
    false
  );
  assert.equal(remote.api.shouldHandleMessage({ type: "electron-pick-workspace-root-option" }), true);
  assert.equal(remote.api.shouldHandleMessage({ type: "unrelated-message" }), false);

  const local = createPickerHarness({ hostname: "127.0.0.1" });
  assert.equal(local.api.shouldHandleMessage({ type: "electron-add-new-workspace-root-option" }), false);
  assert.equal(local.api.shouldHandleMessage({ type: "electron-pick-workspace-root-option" }), false);
});

test("legacy add protocol validates then forwards the root to official Main", async () => {
  const harness = createPickerHarness({ resolvePath: (rawPath) => `/real${rawPath}` });
  const handled = harness.api.handleMessage({ type: "electron-add-new-workspace-root-option", source: "menu" });
  assert.equal(typeof handled.then, "function");

  await submitDialog(harness, "/project-one");
  await handled;

  assert.deepEqual(harness.invokes, [
    { channel: "opencodex:validate-workspace-root", payload: { path: "/project-one" } },
    {
      channel: "codex_desktop:message-from-view",
      payload: { type: "electron-add-new-workspace-root-option", source: "menu", root: "/real/project-one" },
    },
  ]);
  assert.deepEqual(harness.delivered, []);
  assert.deepEqual(harness.toasts, []);
});

test("new pick protocol returns a validated root directly to official Renderer", async () => {
  const harness = createPickerHarness({ resolvePath: (rawPath) => `/real${rawPath}` });
  const handled = harness.api.handleMessage({ type: "electron-pick-workspace-root-option", allowMultiple: false });
  assert.equal(activeElement(harness, "INPUT").tagName, "INPUT");

  await submitDialog(harness, "/project-one");
  await handled;

  assert.deepEqual(harness.invokes, [
    { channel: "opencodex:validate-workspace-root", payload: { path: "/project-one" } },
  ]);
  assert.deepEqual(harness.delivered, [
    { channel: "workspace-root-option-picked", payload: { root: "/real/project-one" } },
  ]);
  assert.deepEqual(harness.toasts, []);
});

test("new multi-pick protocol validates, deduplicates, and returns roots in input order", async () => {
  const harness = createPickerHarness({ resolvePath: (rawPath) => `/real${rawPath}` });
  const handled = harness.api.handleMessage({
    type: "electron-pick-workspace-root-option",
    params: { allowMultiple: true },
  });
  assert.equal(activeElement(harness, "TEXTAREA").tagName, "TEXTAREA");

  await submitDialog(harness, "/project-one\n\n/project-two\r\n/project-one");
  await handled;

  assert.deepEqual(harness.invokes, [
    { channel: "opencodex:validate-workspace-root", payload: { path: "/project-one" } },
    { channel: "opencodex:validate-workspace-root", payload: { path: "/project-two" } },
  ]);
  assert.deepEqual(harness.delivered, [
    { channel: "workspace-root-option-picked", payload: { root: "/real/project-one" } },
    { channel: "workspace-root-option-picked", payload: { root: "/real/project-two" } },
  ]);
  assert.deepEqual(harness.toasts, []);
});

test("multi-pick protocol delivers no partial selection when validation fails", async () => {
  const harness = createPickerHarness({
    resolvePath(rawPath) {
      if (rawPath === "/project-two") throw new Error("not found");
      return `/real${rawPath}`;
    },
  });
  harness.api.handleMessage({ type: "electron-pick-workspace-root-option", allowMultiple: true });

  await submitDialog(harness, "/project-one\n/project-two");

  // 两个路径先全部校验，任一失败都保留弹窗且不污染官方工程表单。
  assert.deepEqual(harness.delivered, []);
  assert.equal(harness.toasts.length, 1);
  assert.equal(activeElement(harness, "FORM").removed, false);
  assert.equal(activeElement(harness, "TEXTAREA").disabled, false);
});
