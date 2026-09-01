const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const {
  messagesForLocale,
  runtimeCompatibilityMessagesForLocale,
} = require("../../shared/i18n/index.cjs");

const PAGE_SCRIPT = fs.readFileSync(
  path.resolve(__dirname, "..", "..", "web-shell", "runtime-compatibility.js"),
  "utf8"
);

class FakeElement {
  constructor(options = {}) {
    this.checked = options.checked === true;
    this.dataset = options.dataset || {};
    this.hidden = options.hidden === true;
    this.listeners = new Map();
    this.textContent = options.textContent || "";
    this.attributes = new Map();
  }

  addEventListener(type, callback) {
    this.listeners.set(type, callback);
  }

  dispatch(type) {
    this.listeners.get(type)?.({ currentTarget: this, target: this });
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) || "";
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  replaceChildren() {}
  append() {}
}

function createPageHarness(initialPreference = "disabled") {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, new FakeElement());
    return elements.get(id);
  };
  const title = new FakeElement({
    dataset: { i18n: "web.runtimeCompatibility.pageTitle" },
    textContent: "OpenCodex虚拟骨架调试",
  });
  const documentListeners = new Map();
  const timers = new Map();
  const storage = new Map([["opencodex_runtime_compatibility_auto_refresh", initialPreference]]);
  let timerId = 0;
  let fetchCount = 0;

  const document = {
    documentElement: { lang: "zh-CN" },
    visibilityState: "visible",
    getElementById: element,
    querySelectorAll(selector) {
      if (selector === "[data-i18n]") return [title];
      return [];
    },
    addEventListener(type, callback) {
      documentListeners.set(type, callback);
    },
    createElement() {
      return new FakeElement();
    },
  };
  const window = {
    __CODEX_WEB_CONFIG__: {
      locale: "en-US",
      messages: {
        ...messagesForLocale("en-US"),
        ...runtimeCompatibilityMessagesForLocale("en-US"),
      },
    },
    addEventListener() {},
  };
  const context = {
    console,
    document,
    fetch: async () => {
      fetchCount += 1;
      throw new Error("offline");
    },
    history: { length: 1, back() {} },
    localStorage: {
      getItem: (key) => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, String(value)),
    },
    location: { assign() {} },
    setTimeout(callback) {
      const id = ++timerId;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    window,
  };
  vm.runInNewContext(PAGE_SCRIPT, context, { filename: "runtime-compatibility.js" });
  return { document, element, fetchCount: () => fetchCount, storage, timers, title };
}

test("diagnostics page follows locale and persists auto-refresh control", async () => {
  const page = createPageHarness("disabled");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(page.document.documentElement.lang, "en-US");
  assert.equal(page.title.textContent, "OpenCodex Virtual Skeleton Diagnostics");
  assert.equal(page.element("autoRefreshToggle").checked, false);
  assert.equal(page.timers.size, 0);
  assert.equal(page.fetchCount(), 1, "initial page load still performs one explicit read");

  const toggle = page.element("autoRefreshToggle");
  toggle.checked = true;
  toggle.dispatch("change");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(page.storage.get("opencodex_runtime_compatibility_auto_refresh"), "enabled");
  assert.equal(page.fetchCount(), 2);
  assert.equal(page.timers.size, 1);

  toggle.checked = false;
  toggle.dispatch("change");
  assert.equal(page.storage.get("opencodex_runtime_compatibility_auto_refresh"), "disabled");
  assert.equal(page.timers.size, 0);
});

test("injection category help describes only the Adapter chain", () => {
  assert.match(PAGE_SCRIPT, /完整适配器链路，包括直接使用的适配器及其依赖的适配器/);
  assert.match(PAGE_SCRIPT, /statuses: \[\]/);
});
