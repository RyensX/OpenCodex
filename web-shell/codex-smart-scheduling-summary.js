(function () {
  const w = window;
  if (w.__OpenCodexSmartSchedulingSummaryInstalled) return;
  w.__OpenCodexSmartSchedulingSummaryInstalled = true;

  const FEATURE = "smart-model-router";
  const ROUTE_METADATA_KEY = "opencodex/smart-scheduling";
  const SUMMARY_ROOT_SELECTOR = '[data-pip-obstacle="thread-summary-panel"]';
  const SECTION_ATTRIBUTE = "data-opencodex-smart-scheduling-summary";
  const TERMINAL_METHODS = new Set(["turn/completed", "turn/failed", "turn/interrupted"]);
  const VISIBLE_THREAD_METHODS = new Set(["thread/read", "thread/resume", "turn/start"]);
  const PROTOCOL_ENVELOPE_KEYS = ["message", "request", "payload", "body"];
  const messages = w.__CODEX_WEB_CONFIG__?.messages || {};
  const locale = String(w.__CODEX_WEB_CONFIG__?.locale || document.documentElement.lang || "zh-CN").toLowerCase();
  const isEnglish = locale.startsWith("en");
  const copy = {
    title: messages["plugin.smartModelRouter.summary.title"] || (isEnglish ? "Smart scheduling" : "智能调度"),
    model: messages["plugin.smartModelRouter.summary.model"] || (isEnglish ? "Model" : "模型"),
    effort:
      messages["plugin.smartModelRouter.summary.effort"] || (isEnglish ? "Reasoning effort" : "推理强度"),
    determining:
      messages["plugin.smartModelRouter.summary.determining"] || (isEnglish ? "Determining…" : "正在判断…"),
  };
  const activeRoutes = new Map();
  const pendingTurnStarts = new Map();
  const pendingModelSelections = new Map();
  const threadRevisions = new Map();
  let pluginEnabled = false;
  let displayEnabled = true;
  let installed = false;
  let observerScheduled = false;
  let lastThreadId = "";
  let visibleThreadId = "";
  let hydrateSequence = 0;
  let configurationRetryTimer = null;
  let configurationRetryCount = 0;

  function normalizedId(value) {
    if (value == null) return "";
    const raw = String(value).trim();
    if (!raw) return "";
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }

  function currentThreadId() {
    const pathname = String(w.location?.pathname || "");
    const patterns = [
      /\/local\/([^/?#]+)/,
      /\/hotkey-window\/thread\/([^/?#]+)/,
      /\/thread\/([^/?#]+)/,
      /\/conversation\/([^/?#]+)/,
    ];
    for (const pattern of patterns) {
      const match = pattern.exec(pathname);
      if (match?.[1]) return normalizedId(match[1]);
    }
    // 新版官方 renderer 在任务间切换时 URL 仍为根路径，需回退到同一标签页的 App Server 上下文。
    if (visibleThreadId) return visibleThreadId;
    // 首个通知可能早于 renderer 发出的 thread/read；仅有一条活动路由时可无歧义地作为当前任务。
    return activeRoutes.size === 1 ? activeRoutes.keys().next().value : "";
  }

  function requestId(value) {
    if (value == null) return "";
    return `${typeof value}:${String(value)}`;
  }

  function selectVisibleThread(threadId, hydrate = false) {
    const normalizedThreadId = normalizedId(threadId);
    if (!normalizedThreadId) return;
    visibleThreadId = normalizedThreadId;
    if (hydrate && !activeRoutes.has(normalizedThreadId)) void hydrateActiveRoute(normalizedThreadId);
  }

  function gatewayHeaders() {
    const headers = new Headers();
    const token = String(w.__OPEN_CODEX_RUNTIME_AUTH_TOKEN__ || "").trim();
    if (token) headers.set("authorization", `Bearer ${token}`);
    return headers;
  }

  function isAutoTurn(params) {
    const selectedModel = configuredModel(params).toLowerCase();
    // 官方可能把虚拟 Auto 映射成上一轮真实 model 再发请求，当前模型选择器是分类前的可靠兜底信号。
    return selectedModel === "auto" || w.__OpenCodexSmartModelRouterComposer?.autoSelected === true;
  }

  function configuredModel(params) {
    const directModel = String(params?.model || "").trim();
    if (directModel) return directModel;
    return String(params?.collaborationMode?.settings?.model || "").trim();
  }

  function bumpThreadRevision(threadId) {
    const normalizedThreadId = normalizedId(threadId);
    if (!normalizedThreadId) return;
    threadRevisions.set(normalizedThreadId, (threadRevisions.get(normalizedThreadId) || 0) + 1);
  }

  function normalizedRoute(value, threadId, turnId) {
    if (!value || typeof value !== "object") return null;
    const modelId = String(value.model || "").trim();
    const model = String(value.displayName || modelId).trim();
    const effort = String(value.effort || "").trim();
    if (!modelId || !model || !effort) return null;
    return {
      threadId: normalizedId(threadId || value.threadId),
      turnId: normalizedId(turnId || value.turnId),
      tier: String(value.tier || ""),
      modelId,
      model,
      effort,
      fallback: value.fallback === true,
    };
  }

  function removeSections() {
    for (const section of document.querySelectorAll(`[${SECTION_ATTRIBUTE}]`)) section.remove();
  }

  function summarySectionsContainer() {
    const root = document.querySelector(SUMMARY_ROOT_SELECTOR);
    if (!root) return null;
    const nativeSection = root.querySelector("section");
    if (nativeSection?.parentElement && root.contains(nativeSection.parentElement)) return nativeSection.parentElement;
    // 空摘要面板没有 section 时，使用官方内容滚动容器；错误占位不会命中此回退选择器。
    return root.querySelector(".overflow-y-auto");
  }

  function createItem(label, valueClass) {
    const item = document.createElement("div");
    item.className =
      "group/summary-panel-item relative isolate flex min-h-token-button-composer w-full min-w-0 items-center gap-token-button-composer-gap rounded-sm border-0 bg-transparent px-0 py-1 text-left";
    item.dataset.slot = "thread-summary-panel-item";

    const name = document.createElement("span");
    name.className = "text-fade-truncate min-w-0 flex-1 text-base";
    name.dataset.slot = "thread-summary-panel-item-label";
    name.textContent = label;

    const meta = document.createElement("span");
    meta.className = "flex max-w-1/2 min-w-0 shrink items-center text-base text-token-text-tertiary";
    meta.dataset.slot = "thread-summary-panel-item-meta";
    const value = document.createElement("span");
    value.className = `text-fade-truncate ${valueClass}`;
    meta.appendChild(value);
    item.append(name, meta);
    return item;
  }

  function createSection() {
    const section = document.createElement("section");
    section.setAttribute(SECTION_ATTRIBUTE, "true");
    section.setAttribute("aria-label", copy.title);
    section.className =
      "opencodex-smart-scheduling-summary-section relative z-0 flex flex-col pb-3 after:absolute after:inset-x-3.5 after:bottom-0 after:h-[0.5px] after:bg-token-border-default after:content-[''] last:pb-0 last:after:hidden";

    const header = document.createElement("div");
    header.className =
      "sticky top-0 z-10 flex h-7 w-full min-w-0 items-center justify-start gap-2 bg-token-dropdown-background ps-3.5 pe-2.5 pb-0.5 text-base text-token-text-tertiary";
    const title = document.createElement("span");
    title.className = "truncate";
    title.textContent = copy.title;
    header.appendChild(title);

    const content = document.createElement("div");
    content.className = "relative z-0 mt-0.5 overflow-hidden";
    const items = document.createElement("div");
    items.className = "flex flex-col gap-0.5 px-3.5";
    items.append(
      createItem(copy.model, "opencodex-smart-scheduling-summary-model"),
      createItem(copy.effort, "opencodex-smart-scheduling-summary-effort")
    );
    content.appendChild(items);
    section.append(header, content);
    return section;
  }

  function render() {
    observerScheduled = false;
    const threadId = currentThreadId();
    const route = threadId ? activeRoutes.get(threadId) : null;
    if (!pluginEnabled || !displayEnabled || !route) {
      removeSections();
      return;
    }
    const container = summarySectionsContainer();
    if (!container) {
      removeSections();
      return;
    }
    for (const stale of document.querySelectorAll(`[${SECTION_ATTRIBUTE}]`)) {
      if (stale.parentElement !== container) stale.remove();
    }
    const section = container.querySelector(`:scope > [${SECTION_ATTRIBUTE}]`) || createSection();
    const model = section.querySelector(".opencodex-smart-scheduling-summary-model");
    const effort = section.querySelector(".opencodex-smart-scheduling-summary-effort");
    if (model && model.textContent !== route.model) model.textContent = route.model;
    if (effort && effort.textContent !== route.effort) effort.textContent = route.effort;
    const tooltip = `${copy.model}: ${route.model}\n${copy.effort}: ${route.effort}`;
    if (section.title !== tooltip) section.title = tooltip;
    if (!section.isConnected) container.prepend(section);
  }

  function scheduleRender() {
    if (observerScheduled) return;
    observerScheduled = true;
    w.requestAnimationFrame(render);
  }

  async function hydrateActiveRoute(threadId) {
    const normalizedThreadId = normalizedId(threadId);
    if (!normalizedThreadId || !pluginEnabled || !displayEnabled) return;
    const sequence = ++hydrateSequence;
    const revision = threadRevisions.get(normalizedThreadId) || 0;
    try {
      const response = await fetch(
        `/api/opencodex/model-router/active-route?threadId=${encodeURIComponent(normalizedThreadId)}`,
        { cache: "no-store", credentials: "same-origin", headers: gatewayHeaders() }
      );
      if (!response.ok || sequence !== hydrateSequence || revision !== (threadRevisions.get(normalizedThreadId) || 0)) return;
      const payload = await response.json();
      const route = normalizedRoute(payload?.route, normalizedThreadId, payload?.route?.turnId);
      if (route) activeRoutes.set(normalizedThreadId, route);
      else activeRoutes.delete(normalizedThreadId);
      scheduleRender();
    } catch {}
  }

  function syncCurrentThread() {
    const threadId = currentThreadId();
    if (threadId !== lastThreadId) {
      lastThreadId = threadId;
      hydrateSequence += 1;
      if (threadId && !activeRoutes.has(threadId)) void hydrateActiveRoute(threadId);
    }
    scheduleRender();
  }

  function handleNotification(message) {
    if (!message || typeof message !== "object") return;
    if (Array.isArray(message)) {
      message.forEach(handleNotification);
      return;
    }
    const method = String(message.method || "");
    const params = message.params && typeof message.params === "object" ? message.params : {};
    const threadId = normalizedId(params.threadId || params.thread?.id);
    if (!threadId) return;
    if (method === "turn/started") {
      // 根路径 renderer 不暴露 task id；真实回合开始通知是当前执行任务最可靠的服务端信号。
      selectVisibleThread(threadId);
      const metadata = params._meta?.[ROUTE_METADATA_KEY];
      const route = normalizedRoute(metadata, threadId, params.turn?.id || params.turnId);
      bumpThreadRevision(threadId);
      if (route) {
        // 路由元数据只会由已开启的核心能力注入，可用于兜住页面认证初始化早于配置读取的竞态。
        pluginEnabled = true;
        activeRoutes.set(threadId, route);
      } else {
        const pending = activeRoutes.get(threadId);
        const autoSelected = w.__OpenCodexSmartModelRouterComposer?.autoSelected === true;
        if (pending?.pending || autoSelected) {
          // 部分官方版本会规范化通知字段；保留“判断中”并从核心活动路由补取最终结果。
          pluginEnabled = true;
          if (!pending) {
            activeRoutes.set(threadId, {
              threadId,
              turnId: normalizedId(params.turn?.id || params.turnId),
              tier: "",
              model: copy.determining,
              effort: copy.determining,
              fallback: false,
              pending: true,
            });
          }
          void hydrateActiveRoute(threadId);
        } else {
          activeRoutes.delete(threadId);
        }
      }
      scheduleRender();
      return;
    }
    if (TERMINAL_METHODS.has(method)) {
      const active = activeRoutes.get(threadId);
      const turnId = normalizedId(params.turn?.id || params.turnId);
      bumpThreadRevision(threadId);
      if (active && (!turnId || !active.turnId || active.turnId === turnId)) {
        // 回合结束只清除运行标记，具体路由继续作为 Auto 的最近一次分类结果展示。
        activeRoutes.set(threadId, { ...active, turnId: "", pending: false });
      }
      void hydrateActiveRoute(threadId);
      scheduleRender();
      return;
    }
    if (["thread/deleted", "thread/archived", "thread/unsubscribed"].includes(method)) {
      activeRoutes.delete(threadId);
      bumpThreadRevision(threadId);
      scheduleRender();
    }
  }

  function handleClientMessage(message) {
    if (!message || typeof message !== "object") return;
    if (Array.isArray(message)) {
      message.forEach(handleClientMessage);
      return;
    }
    const method = String(message.method || "");
    const params = message.params && typeof message.params === "object" ? message.params : {};
    const threadId = normalizedId(params.threadId || params.thread?.id);
    if (threadId && VISIBLE_THREAD_METHODS.has(method)) selectVisibleThread(threadId, method !== "turn/start");
    if (method === "thread/settings/update" && threadId) {
      const model = configuredModel(params).toLowerCase();
      if (!model) return;
      selectVisibleThread(threadId);
      const key = requestId(message.id);
      if (key) pendingModelSelections.set(key, { auto: model === "auto", threadId });
      bumpThreadRevision(threadId);
      if (model === "auto") {
        // 成功响应或网关状态事件会补取持久化结果；现有最近结果无需在切换时闪烁隐藏。
        pluginEnabled = true;
      } else {
        activeRoutes.delete(threadId);
      }
      scheduleRender();
      return;
    }
    if (method !== "turn/start" || !threadId) return;

    const key = requestId(message.id);
    if (key) pendingTurnStarts.set(key, threadId);
    bumpThreadRevision(threadId);
    if (isAutoTurn(params)) {
      // Auto 选择器只在核心开关开启时存在；先展示分类状态，配置请求随后仍可关闭展示开关。
      pluginEnabled = true;
      // 分类本身属于本轮执行：结果未定时明确显示判断中，避免七秒分类阶段看起来像功能未生效。
      activeRoutes.set(threadId, {
        threadId,
        turnId: "",
        tier: "",
        model: copy.determining,
        effort: copy.determining,
        fallback: false,
        pending: true,
      });
    } else {
      activeRoutes.delete(threadId);
    }
    scheduleRender();
  }

  function handleServerMessage(message) {
    if (!message || typeof message !== "object") return;
    if (Array.isArray(message)) {
      message.forEach(handleServerMessage);
      return;
    }
    const key = requestId(message.id);
    if (key && pendingModelSelections.has(key)) {
      const selection = pendingModelSelections.get(key);
      pendingModelSelections.delete(key);
      bumpThreadRevision(selection.threadId);
      if (message.error || selection.auto) void hydrateActiveRoute(selection.threadId);
      else activeRoutes.delete(selection.threadId);
      scheduleRender();
    }
    if (key && pendingTurnStarts.has(key)) {
      const threadId = pendingTurnStarts.get(key);
      pendingTurnStarts.delete(key);
      if (message.error) {
        bumpThreadRevision(threadId);
        // Auto 启动失败时仍展示最近分类；手动回合会由接口返回空结果。
        void hydrateActiveRoute(threadId);
        scheduleRender();
      }
    }
    handleNotification(message);
  }

  function handleRouteEvent(event) {
    const threadId = normalizedId(event?.threadId);
    const status = String(event?.status || "");
    if (!threadId || !status) return;
    selectVisibleThread(threadId);
    bumpThreadRevision(threadId);
    if (status === "classifying") {
      pluginEnabled = true;
      activeRoutes.set(threadId, {
        threadId,
        turnId: "",
        tier: "",
        model: copy.determining,
        effort: copy.determining,
        fallback: false,
        pending: true,
      });
    } else if (["selected", "started", "idle"].includes(status)) {
      const route = normalizedRoute(event.route, threadId, event.route?.turnId);
      if (route) {
        pluginEnabled = true;
        activeRoutes.set(threadId, route);
      }
    } else if (["cleared", "deleted", "unsubscribed"].includes(status)) {
      activeRoutes.delete(threadId);
    }
    scheduleRender();
  }

  function visitProtocolMessages(value, direction, depth = 0) {
    if (!value || typeof value !== "object" || depth > 4) return;
    if (direction === "client") handleClientMessage(value);
    else handleServerMessage(value);
    // App Server 帧通常是直接 JSON-RPC；有界解包兼容官方 renderer 增加的传输 envelope。
    for (const key of PROTOCOL_ENVELOPE_KEYS) {
      const nested = value[key];
      if (nested && typeof nested === "object") visitProtocolMessages(nested, direction, depth + 1);
      else if (typeof nested === "string" && (nested.includes("turn/") || nested.includes("thread/"))) {
        try {
          visitProtocolMessages(JSON.parse(nested), direction, depth + 1);
        } catch {}
      }
    }
  }

  function handleAppHostData(data, direction = "server") {
    if (typeof data !== "string" || !data.trim()) return;
    if (!data.includes("turn/") && !data.includes("thread/")) return;
    try {
      visitProtocolMessages(JSON.parse(data), direction);
    } catch {}
  }

  function applyConfiguration(detail) {
    pluginEnabled = detail?.enabled === true;
    displayEnabled = detail?.showRouteInSummary !== false;
    if (!pluginEnabled || !displayEnabled) removeSections();
    else void hydrateActiveRoute(currentThreadId());
    scheduleRender();
  }

  async function loadConfiguration() {
    try {
      const response = await fetch("/api/opencodex/plugins/config", {
        cache: "no-store",
        credentials: "same-origin",
        headers: gatewayHeaders(),
      });
      if (!response.ok) throw new Error(`config_${response.status}`);
      const payload = await response.json();
      const plugin = (payload.plugins || []).find((value) => value?.feature === FEATURE);
      applyConfiguration({
        enabled: plugin?.enabled === true,
        showRouteInSummary: plugin?.values?.showRouteInSummary !== false,
      });
      configurationRetryCount = 0;
      if (configurationRetryTimer) {
        w.clearTimeout(configurationRetryTimer);
        configurationRetryTimer = null;
      }
    } catch {
      if (configurationRetryTimer || configurationRetryCount >= 5) return;
      const delay = Math.min(500 * 2 ** configurationRetryCount, 8000);
      configurationRetryCount += 1;
      // 登录态和运行时 token 可能晚于 renderer 脚本就绪，短暂重试即可消除初始化竞态。
      configurationRetryTimer = w.setTimeout(() => {
        configurationRetryTimer = null;
        void loadConfiguration();
      }, delay);
    }
  }

  function install() {
    if (installed) return;
    installed = true;
    const observer = new MutationObserver(syncCurrentThread);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    w.addEventListener("popstate", syncCurrentThread);
    w.addEventListener("opencodex:smart-scheduling-config-changed", (event) => applyConfiguration(event.detail));
    syncCurrentThread();
    void loadConfiguration();
    // 协议观察和 DOM 观察均已安装后再回执，避免把单纯脚本下载当成摘要适配器注入成功。
    void w.__OpenCodexSmartSchedulingInjectionHealth?.report("summary-adapter");
  }

  // bridge 只负责把原始 App Server 帧送入此独立展示模块，不承载任何路由或 DOM 逻辑。
  w.__OpenCodexSmartSchedulingSummary = Object.freeze({
    handleAppHostData,
    handleRouteEvent,
    get activeRoute() {
      const route = activeRoutes.get(currentThreadId());
      return route ? { ...route } : null;
    },
    get visible() {
      return !!document.querySelector(`[${SECTION_ATTRIBUTE}]`);
    },
    get diagnostics() {
      // 只暴露布尔值和计数，便于联调；不记录任务 ID、prompt 或分类依据。
      return {
        activeRouteCount: activeRoutes.size,
        autoSelected: w.__OpenCodexSmartModelRouterComposer?.autoSelected === true,
        displayEnabled,
        pendingModelSelectionCount: pendingModelSelections.size,
        pendingTurnCount: pendingTurnStarts.size,
        pluginEnabled,
        visibleThreadKnown: !!currentThreadId(),
      };
    },
  });

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install, { once: true });
  else install();
})();
