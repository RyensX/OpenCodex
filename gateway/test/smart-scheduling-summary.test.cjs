const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const SUMMARY_SOURCE = fs.readFileSync(
  path.resolve(__dirname, "..", "..", "web-shell", "codex-smart-scheduling-summary.js"),
  "utf-8"
);
const SUMMARY_SELECTOR = "[data-opencodex-smart-scheduling-summary]";
const ACTIVE_SIDEBAR_THREAD_SELECTOR =
  '[data-app-action-sidebar-thread-row][data-app-action-sidebar-thread-active="true"]';

function dataAttributeName(property) {
  return `data-${String(property).replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
}

// 轻量 DOM 只实现摘要适配器实际使用的能力，同时保留真实的父子关系和选择器行为。
class FakeElement {
  constructor(tagName, ownerDocument) {
    this.attributes = new Map();
    this.children = [];
    this.className = "";
    this.nodeType = 1;
    this.ownerDocument = ownerDocument;
    this.parentElement = null;
    this.tagName = String(tagName || "div").toUpperCase();
    this.textContent = "";
    this.title = "";
    this.dataset = new Proxy(
      {},
      {
        set: (target, property, value) => {
          target[property] = String(value);
          this.attributes.set(dataAttributeName(property), String(value));
          return true;
        },
      }
    );
  }

  get isConnected() {
    return this === this.ownerDocument.documentElement || this.ownerDocument.documentElement.contains(this);
  }

  append(...nodes) {
    for (const node of nodes) this.appendChild(node);
  }

  appendChild(node) {
    node.remove();
    node.parentElement = this;
    this.children.push(node);
    return node;
  }

  prepend(node) {
    node.remove();
    node.parentElement = this;
    this.children.unshift(node);
    return node;
  }

  remove() {
    if (!this.parentElement) return;
    const index = this.parentElement.children.indexOf(this);
    if (index >= 0) this.parentElement.children.splice(index, 1);
    this.parentElement = null;
  }

  setAttribute(name, value) {
    this.attributes.set(String(name), String(value));
  }

  getAttribute(name) {
    return this.attributes.get(String(name)) ?? null;
  }

  hasAttribute(name) {
    return this.attributes.has(String(name));
  }

  contains(node) {
    if (node === this) return true;
    return this.children.some((child) => child.contains(node));
  }

  matches(selector) {
    const source = String(selector || "").trim();
    if (!source) return false;
    if (source.startsWith(".")) {
      const className = source.slice(1);
      return this.className.split(/\s+/).filter(Boolean).includes(className);
    }
    const attributes = Array.from(source.matchAll(/\[([^\]=]+)(?:="([^"]*)")?\]/g));
    const tagName = source.replace(/\[[^\]]+\]/g, "").trim();
    if (tagName && this.tagName !== tagName.toUpperCase()) return false;
    if (attributes.length === 0) return !!tagName;
    return attributes.every((match) => {
      if (!this.hasAttribute(match[1])) return false;
      return match[2] === undefined || this.getAttribute(match[1]) === match[2];
    });
  }

  closest(selector) {
    let current = this;
    while (current) {
      if (current.matches(selector)) return current;
      current = current.parentElement;
    }
    return null;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    const results = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (child.matches(selector)) results.push(child);
        visit(child);
      }
    };
    visit(this);
    return results;
  }
}

function createHarness() {
  const fetchRequests = [];
  const windowListeners = new Map();
  let activeSidebarThread = null;
  let mutationCallback = null;

  const document = {
    readyState: "complete",
    addEventListener() {},
    createElement(tagName) {
      return new FakeElement(tagName, document);
    },
    querySelector(selector) {
      if (selector === ACTIVE_SIDEBAR_THREAD_SELECTOR) return activeSidebarThread;
      return document.documentElement.querySelector(selector);
    },
    querySelectorAll(selector) {
      return document.documentElement.querySelectorAll(selector);
    },
  };
  document.documentElement = new FakeElement("html", document);
  document.documentElement.lang = "zh-CN";
  const body = document.createElement("body");
  document.documentElement.appendChild(body);

  const window = {
    __CODEX_WEB_CONFIG__: { locale: "zh-CN", messages: {} },
    __OpenCodexSmartModelRouterComposer: { autoSelected: false },
    addEventListener(type, handler) {
      windowListeners.set(type, handler);
    },
    clearTimeout,
    location: { pathname: "/" },
    requestAnimationFrame(callback) {
      callback();
      return 1;
    },
    setTimeout,
  };
  window.window = window;

  class TestHeaders {
    set() {}
  }

  class TestMutationObserver {
    constructor(callback) {
      mutationCallback = callback;
    }

    observe() {}
  }

  function fetch(url) {
    const normalizedUrl = String(url);
    if (normalizedUrl === "/api/opencodex/plugins/config") {
      return Promise.resolve({
        ok: true,
        async json() {
          return {
            plugins: [
              {
                enabled: true,
                feature: "smart-model-router",
                values: { showRouteInSummary: true },
              },
            ],
          };
        },
      });
    }
    return new Promise((resolve) => {
      fetchRequests.push({ resolve, url: normalizedUrl });
    });
  }

  vm.runInNewContext(SUMMARY_SOURCE, {
    console,
    decodeURIComponent,
    document,
    encodeURIComponent,
    fetch,
    Headers: TestHeaders,
    MutationObserver: TestMutationObserver,
    window,
  });

  const summary = window.__OpenCodexSmartSchedulingSummary;

  function notifyMutation(record) {
    mutationCallback?.([record]);
  }

  function createNativeSummaryPanel(mode, includeNativeItem = true, officialOverlay = true) {
    const root = document.createElement("div");
    if (mode === "pinned") root.setAttribute("data-pip-obstacle", "thread-summary-panel");
    else root.setAttribute("data-radix-popper-content-wrapper", "");

    let contentRoot = root;
    if (mode === "overlay" && officialOverlay) {
      // 对齐 26.727 官方 PopoverContent，而不是用简化结构掩盖空摘要浮层的挂载问题。
      contentRoot = document.createElement("div");
      contentRoot.className =
        "flex max-h-[min(var(--radix-popover-content-available-height),calc(100vh-16px))] flex-col gap-3";
      root.appendChild(contentRoot);
    }
    const card = document.createElement("div");
    const container = document.createElement("div");
    container.className = "overflow-y-auto";
    if (includeNativeItem) {
      const nativeSection = document.createElement("section");
      const nativeItem = document.createElement("div");
      nativeItem.dataset.slot = "thread-summary-panel-item";
      nativeSection.appendChild(nativeItem);
      container.appendChild(nativeSection);
    }
    card.appendChild(container);
    contentRoot.appendChild(card);
    body.appendChild(root);
    notifyMutation({ type: "childList", addedNodes: [root], removedNodes: [] });
    return root;
  }

  return {
    activeRoute() {
      return summary.activeRoute;
    },
    async ready() {
      await flushAsyncWork();
    },
    handleRouteEvent(event) {
      summary.handleRouteEvent(event);
    },
    mountSummary(mode) {
      return createNativeSummaryPanel(mode);
    },
    mountEmptyOverlaySummary() {
      return createNativeSummaryPanel("overlay", false, true);
    },
    mountUnrelatedOverlay() {
      return createNativeSummaryPanel("overlay", false, false);
    },
    openThread(threadId) {
      summary.handleAppHostData(
        JSON.stringify({ id: `read-${threadId}`, method: "thread/read", params: { threadId } }),
        "client"
      );
    },
    pendingFetchCount(threadId) {
      return fetchRequests.filter((request) =>
        request.url.includes(`threadId=${encodeURIComponent(threadId)}`)
      ).length;
    },
    resolveFetches(threadId, route) {
      const matching = fetchRequests.filter((request) =>
        request.url.includes(`threadId=${encodeURIComponent(threadId)}`)
      );
      assert.ok(matching.length > 0, `missing active-route request for ${threadId}`);
      for (const request of matching) {
        fetchRequests.splice(fetchRequests.indexOf(request), 1);
        request.resolve({
          ok: true,
          async json() {
            return { route };
          },
        });
      }
    },
    sendClientMessage(message) {
      summary.handleAppHostData(JSON.stringify(message), "client");
    },
    sendServerMessage(message) {
      summary.handleAppHostData(JSON.stringify(message), "server");
    },
    sendViewMessage(payload) {
      windowListeners.get("opencodex:plugin-event")?.({
        detail: { eventName: "view:message", payload },
      });
    },
    sendViewActivity(threadId, active = true) {
      // 对齐官方 renderer 实际发出的结构化前台任务活动日志。
      windowListeners.get("opencodex:plugin-event")?.({
        detail: {
          eventName: "view:message",
          payload: {
            type: "log-message",
            message: "thread_stream_view_activity_changed",
            tags: { safe: { active, conversationId: threadId } },
          },
        },
      });
    },
    setActiveSidebarThread(threadKey, kind = "local") {
      if (!activeSidebarThread) {
        activeSidebarThread = document.createElement("div");
        activeSidebarThread.setAttribute("data-app-action-sidebar-thread-row", "");
        body.appendChild(activeSidebarThread);
      }
      activeSidebarThread.setAttribute("data-app-action-sidebar-thread-id", threadKey);
      activeSidebarThread.setAttribute("data-app-action-sidebar-thread-kind", kind);
      activeSidebarThread.setAttribute("data-app-action-sidebar-thread-active", "true");
      notifyMutation({
        type: "attributes",
        attributeName: "data-app-action-sidebar-thread-active",
        target: activeSidebarThread,
      });
    },
    summaryValues() {
      return {
        effort: document.querySelector(".opencodex-smart-scheduling-summary-effort")?.textContent || "",
        model: document.querySelector(".opencodex-smart-scheduling-summary-model")?.textContent || "",
      };
    },
    fallbackSummaryValue() {
      return document.querySelector(".opencodex-smart-scheduling-summary-fallback")?.textContent || "";
    },
    summaryVisible() {
      return !!document.querySelector(SUMMARY_SELECTOR);
    },
    triggerUnrelatedMutation() {
      const node = document.createElement("div");
      body.appendChild(node);
      notifyMutation({ type: "childList", addedNodes: [node], removedNodes: [] });
    },
    unmountSummary(root) {
      root.remove();
      notifyMutation({ type: "childList", addedNodes: [], removedNodes: [root] });
    },
  };
}

async function flushAsyncWork() {
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

async function resolveRoute(harness, threadId, route) {
  harness.resolveFetches(threadId, route);
  await flushAsyncWork();
}

test("smart scheduling summary mounts in pinned and overlay panels and remounts after reopen", async () => {
  for (const mode of ["pinned", "overlay"]) {
    const harness = createHarness();
    await harness.ready();
    harness.sendViewMessage({ type: "navigate-to-route", path: "/local/thread-a" });
    harness.handleRouteEvent({ threadId: "thread-a", status: "selected" });
    await resolveRoute(harness, "thread-a", {
      displayName: "Luna",
      effort: "high",
      model: "luna",
      turnId: "turn-a",
    });

    if (mode === "overlay") {
      const unrelatedOverlay = harness.mountUnrelatedOverlay();
      assert.equal(harness.summaryVisible(), false, "unrelated Radix content must not be treated as the summary");
      harness.unmountSummary(unrelatedOverlay);
    }
    const root = harness.mountSummary(mode);
    assert.equal(harness.summaryVisible(), true, `${mode} panel should contain the custom section`);
    assert.deepEqual(harness.summaryValues(), { effort: "high", model: "Luna" });
    assert.equal(harness.fallbackSummaryValue(), "");

    harness.unmountSummary(root);
    assert.equal(harness.summaryVisible(), false);
    harness.mountSummary(mode);
    assert.equal(harness.summaryVisible(), true, `${mode} panel should remount the custom section`);
  }
});

test("smart scheduling summary only shows the fallback status for failed classification", async () => {
  const harness = createHarness();
  await harness.ready();
  harness.sendViewMessage({ type: "navigate-to-route", path: "/local/thread-fallback" });
  harness.handleRouteEvent({ threadId: "thread-fallback", status: "selected" });
  await resolveRoute(harness, "thread-fallback", {
    displayName: "Spark",
    effort: "low",
    model: "spark",
    fallback: false,
  });
  harness.mountSummary("pinned");
  assert.equal(harness.fallbackSummaryValue(), "");

  harness.handleRouteEvent({
    threadId: "thread-fallback",
    status: "selected",
    route: { displayName: "Spark", effort: "low", model: "spark", fallback: true },
  });
  assert.equal(harness.fallbackSummaryValue(), "失败回退");

  harness.handleRouteEvent({
    threadId: "thread-fallback",
    status: "selected",
    route: { displayName: "Luna", effort: "high", model: "luna", fallback: false },
  });
  assert.equal(harness.fallbackSummaryValue(), "");
});

test("root-routed new Auto task renders directly in an otherwise empty official overlay", async () => {
  const harness = createHarness();
  await harness.ready();
  harness.sendViewMessage({ type: "new-chat" });
  // 官方先导航到 client-* 占位任务，App Server 创建完成后 turn/start 才携带真实 threadId。
  harness.sendViewMessage({
    type: "navigate-to-route",
    path: "/local/client-new-thread%3Atemporary",
  });
  harness.sendClientMessage({
    id: "turn-new",
    method: "turn/start",
    params: { threadId: "thread-new", model: "auto" },
  });
  harness.mountEmptyOverlaySummary();
  assert.deepEqual(harness.summaryValues(), {
    effort: "正在判断…",
    model: "正在判断…",
  });

  // 桌面本地任务的 renderer 路径固定为根路由，不能把它误判成离开当前任务。
  harness.sendViewMessage({ type: "navigate-to-route", path: "/" });
  harness.handleRouteEvent({
    threadId: "thread-new",
    status: "selected",
    route: {
      displayName: "Spark",
      effort: "low",
      model: "spark",
      turnId: "turn-new",
    },
  });

  // 即使活动路由 HTTP 请求尚未返回，核心 WS 事件也必须立刻成为可见结果。
  assert.equal(harness.activeRoute()?.threadId, "thread-new");
  assert.deepEqual(harness.summaryValues(), { effort: "low", model: "Spark" });
  assert.equal(harness.summaryVisible(), true);
});

test("navigation intent is not overwritten by a stale sidebar or background route", async () => {
  const harness = createHarness();
  await harness.ready();
  harness.setActiveSidebarThread("local:thread-a");
  harness.handleRouteEvent({
    threadId: "thread-a",
    status: "selected",
    route: { displayName: "Luna", model: "luna", effort: "high" },
  });
  await resolveRoute(harness, "thread-a", { model: "luna", effort: "high" });
  harness.mountSummary("pinned");
  assert.equal(harness.activeRoute()?.threadId, "thread-a");
  assert.equal(harness.summaryVisible(), true);

  // B 的导航先于 React 侧栏提交，旧的 A 标记和普通 DOM 变化都不能把可见任务改回 A。
  harness.sendViewMessage({ type: "navigate-to-route", path: "/local/thread-b" });
  assert.equal(harness.activeRoute(), null);
  assert.equal(harness.summaryVisible(), false);
  harness.openThread("thread-b");
  harness.setActiveSidebarThread("local:thread-a");
  harness.triggerUnrelatedMutation();
  assert.equal(harness.activeRoute(), null);

  harness.handleRouteEvent({
    threadId: "thread-a",
    status: "idle",
    route: { displayName: "Luna", model: "luna", effort: "high" },
  });
  await resolveRoute(harness, "thread-a", { model: "luna", effort: "high" });
  assert.equal(harness.activeRoute(), null);

  await resolveRoute(harness, "thread-b", null);
  harness.setActiveSidebarThread("local:thread-b");
  assert.equal(harness.activeRoute(), null);

  // 新会话是明确的空上下文，即使侧栏仍停留在 B，也不能恢复 B 的摘要。
  harness.sendViewMessage({ type: "new-chat" });
  harness.triggerUnrelatedMutation();
  harness.handleRouteEvent({ threadId: "thread-b", status: "idle" });
  await resolveRoute(harness, "thread-b", { model: "spark", effort: "medium" });
  assert.equal(harness.activeRoute(), null);
  assert.equal(harness.summaryVisible(), false);
});

test("returning to a cached thread renders immediately and then revalidates its authoritative route", async () => {
  const harness = createHarness();
  await harness.ready();

  harness.sendViewMessage({ type: "navigate-to-route", path: "/local/thread-b" });
  harness.handleRouteEvent({ threadId: "thread-b", status: "selected" });
  await resolveRoute(harness, "thread-b", { model: "spark", effort: "medium" });
  assert.equal(harness.activeRoute()?.modelId, "spark");

  harness.sendViewMessage({ type: "navigate-to-route", path: "/local/thread-a" });
  await resolveRoute(harness, "thread-a", null);
  assert.equal(harness.activeRoute(), null);

  // 模拟 B 在后台关闭 Auto 但页面漏收 cleared；重新进入时先恢复缓存，权威空回读随后负责清理。
  harness.sendViewMessage({ type: "navigate-to-route", path: "/local/thread-b" });
  assert.equal(harness.activeRoute()?.modelId, "spark");
  await resolveRoute(harness, "thread-b", null);
  assert.equal(harness.activeRoute(), null);
});

test("client-new-thread alias restores an in-progress route after switching away and back", async () => {
  const harness = createHarness();
  await harness.ready();
  const clientThreadA = "client-new-thread:thread-a";

  harness.setActiveSidebarThread(`local:${clientThreadA}`);
  harness.sendViewActivity("thread-a");
  await resolveRoute(harness, clientThreadA, null);
  harness.handleRouteEvent({ threadId: "thread-a", status: "classifying" });
  assert.equal(harness.activeRoute()?.pending, true);

  // 覆盖前台活动信号早于侧栏 DOM 提交的顺序，不能把仍活动的 A 占位键误绑定给 B。
  harness.sendViewActivity("thread-b");
  harness.setActiveSidebarThread("local:thread-b");
  await resolveRoute(harness, "thread-b", null);
  assert.equal(harness.activeRoute(), null);

  // 侧栏再次给出 client-*，别名必须恢复真实 A，并立即显示此前的分类状态。
  harness.setActiveSidebarThread(`local:${clientThreadA}`);
  assert.equal(harness.activeRoute()?.threadId, "thread-a");
  assert.equal(harness.activeRoute()?.pending, true);
  await resolveRoute(harness, "thread-a", null);
  assert.equal(harness.activeRoute()?.pending, true, "empty hydration must not erase classifying state");

  harness.handleRouteEvent({
    threadId: "thread-a",
    status: "selected",
    route: { displayName: "Luna", model: "luna", effort: "high" },
  });
  assert.equal(harness.activeRoute()?.modelId, "luna");
  await resolveRoute(harness, "thread-a", { displayName: "Luna", model: "luna", effort: "high" });
  assert.equal(harness.activeRoute()?.modelId, "luna");
});

test("client-new-thread alias restores a completed route before hydration finishes", async () => {
  const harness = createHarness();
  await harness.ready();
  const clientThreadA = "client-new-thread:completed-a";

  harness.setActiveSidebarThread(`local:${clientThreadA}`);
  harness.sendViewActivity("thread-a");
  await resolveRoute(harness, clientThreadA, null);
  harness.handleRouteEvent({
    threadId: "thread-a",
    status: "selected",
    route: { displayName: "Spark", model: "spark", effort: "low" },
  });
  await resolveRoute(harness, "thread-a", { displayName: "Spark", model: "spark", effort: "low" });

  harness.setActiveSidebarThread("local:thread-b");
  harness.sendViewActivity("thread-b");
  await resolveRoute(harness, "thread-b", null);
  assert.equal(harness.activeRoute(), null);

  harness.setActiveSidebarThread(`local:${clientThreadA}`);
  assert.equal(harness.activeRoute()?.threadId, "thread-a");
  assert.equal(harness.activeRoute()?.modelId, "spark");
  assert.equal(harness.pendingFetchCount("thread-a") > 0, true);
});

test("manual selection wins over delayed selected and turn metadata", async () => {
  const harness = createHarness();
  await harness.ready();
  harness.sendViewMessage({ type: "navigate-to-route", path: "/local/thread-a" });
  harness.handleRouteEvent({ threadId: "thread-a", status: "classifying" });
  assert.equal(harness.activeRoute()?.pending, true);

  harness.sendClientMessage({
    id: "manual-a",
    method: "thread/settings/update",
    params: { threadId: "thread-a", model: "gpt-5.6-terra", effort: "high" },
  });
  assert.equal(harness.activeRoute(), null);

  harness.handleRouteEvent({
    threadId: "thread-a",
    status: "selected",
    route: { displayName: "Luna", model: "luna", effort: "high" },
  });
  await resolveRoute(harness, "thread-a", null);
  assert.equal(harness.activeRoute(), null);

  harness.sendServerMessage({
    method: "turn/started",
    params: {
      threadId: "thread-a",
      turn: { id: "turn-a" },
      _meta: {
        "opencodex/smart-scheduling": { model: "luna", effort: "high" },
      },
    },
  });
  await resolveRoute(harness, "thread-a", null);
  assert.equal(harness.activeRoute(), null);
});

test("raw local sidebar ids and background hydration remain isolated", async () => {
  const harness = createHarness();
  await harness.ready();
  harness.setActiveSidebarThread("thread-b");
  await resolveRoute(harness, "thread-b", { model: "spark", effort: "medium" });
  assert.equal(harness.activeRoute()?.threadId, "thread-b");

  harness.handleRouteEvent({
    threadId: "thread-a",
    status: "selected",
    route: { displayName: "Luna", model: "luna", effort: "high" },
  });
  await resolveRoute(harness, "thread-a", { model: "luna", effort: "high" });
  assert.equal(harness.activeRoute()?.threadId, "thread-b");
  assert.equal(harness.activeRoute()?.modelId, "spark");
});
