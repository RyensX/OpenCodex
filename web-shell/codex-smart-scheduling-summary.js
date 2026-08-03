(function () {
  const w = window;
  if (w.__OpenCodexSmartSchedulingSummaryInstalled) return;
  w.__OpenCodexSmartSchedulingSummaryInstalled = true;

  const FEATURE = "smart-model-router";
  const ROUTE_METADATA_KEY = "opencodex/smart-scheduling";
  const PINNED_SUMMARY_ROOT_SELECTOR = '[data-pip-obstacle="thread-summary-panel"]';
  const OVERLAY_SUMMARY_ROOT_SELECTOR = "[data-radix-popper-content-wrapper]";
  const OVERLAY_SUMMARY_CONTENT_CLASS =
    "max-h-[min(var(--radix-popover-content-available-height),calc(100vh-16px))]";
  const NATIVE_SUMMARY_ITEM_SELECTOR = '[data-slot="thread-summary-panel-item"]';
  const SECTION_ATTRIBUTE = "data-opencodex-smart-scheduling-summary";
  const ACTIVE_SIDEBAR_THREAD_SELECTOR =
    '[data-app-action-sidebar-thread-row][data-app-action-sidebar-thread-active="true"]';
  const LOCAL_SIDEBAR_THREAD_PREFIX = "local:";
  const CLIENT_THREAD_PREFIXES = ["client-new-thread:", "client-local-thread:"];
  const TERMINAL_METHODS = new Set(["turn/completed", "turn/failed", "turn/interrupted"]);
  const VISIBLE_THREAD_METHODS = new Set(["thread/read", "thread/resume", "turn/start"]);
  const AUTHORITATIVE_VISIBLE_THREAD_SOURCES = new Set(["thread/read", "thread/resume", "view-activity"]);
  const NEW_THREAD_MESSAGE_TYPES = new Set(["new-chat", "new-quick-chat"]);
  const PROTOCOL_ENVELOPE_KEYS = ["message", "request", "payload", "body"];
  const THREAD_PATH_PATTERNS = [
    /\/local\/([^/?#]+)/,
    /\/hotkey-window\/thread\/([^/?#]+)/,
    /\/thread\/([^/?#]+)/,
    /\/conversation\/([^/?#]+)/,
  ];
  const messages = w.__CODEX_WEB_CONFIG__?.messages || {};
  const locale = String(w.__CODEX_WEB_CONFIG__?.locale || document.documentElement.lang || "zh-CN").toLowerCase();
  const isEnglish = locale.startsWith("en");
  const copy = {
    title: messages["plugin.smartModelRouter.summary.title"] || (isEnglish ? "Smart scheduling" : "智能调度"),
    model: messages["plugin.smartModelRouter.summary.model"] || (isEnglish ? "Model" : "模型"),
    effort:
      messages["plugin.smartModelRouter.summary.effort"] || (isEnglish ? "Reasoning effort" : "推理强度"),
    status: messages["plugin.smartModelRouter.summary.status"] || (isEnglish ? "Routing status" : "调度状态"),
    fallback:
      messages["plugin.smartModelRouter.summary.fallback"] ||
      (isEnglish ? "failure" : "失败回退"),
    determining:
      messages["plugin.smartModelRouter.summary.determining"] || (isEnglish ? "Determining…" : "正在判断…"),
  };
  const activeRoutes = new Map();
  const pendingTurnStarts = new Map();
  const pendingModelSelections = new Map();
  const hydrateSequences = new Map();
  const manuallySelectedThreads = new Set();
  const threadAliases = new Map();
  let pluginEnabled = false;
  let displayEnabled = true;
  let installed = false;
  let observerScheduled = false;
  let visibleThreadId = "";
  let visibleThreadKnown = false;
  let pendingNavigationThreadId = null;
  let pendingNavigationSequence = 0;
  let visibleThreadActivitySequence = 0;
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

  function resolvedThreadId(value) {
    let threadId = normalizedId(value);
    const visited = new Set();
    // 新建任务的侧栏键可能长期保留 client-*，这里统一解析到 App Server 的真实 threadId。
    while (threadId && threadAliases.has(threadId) && !visited.has(threadId)) {
      visited.add(threadId);
      threadId = normalizedId(threadAliases.get(threadId));
    }
    return threadId;
  }

  function setPendingNavigation(threadId) {
    pendingNavigationThreadId = resolvedThreadId(threadId);
    const sequence = ++pendingNavigationSequence;
    const timer = w.setTimeout(() => {
      if (sequence !== pendingNavigationSequence || pendingNavigationThreadId === null) return;
      // 导航意图只保护 React 提交窗口，超时后释放，避免一次未确认的 client-* 永久阻断后续切换。
      pendingNavigationThreadId = null;
      scheduleRender();
    }, 1000);
    timer?.unref?.();
  }

  function clearPendingNavigation() {
    pendingNavigationThreadId = null;
    pendingNavigationSequence += 1;
  }

  function bindThreadAlias(aliasId, threadId) {
    const alias = normalizedId(aliasId);
    const target = resolvedThreadId(threadId);
    if (
      !alias ||
      !target ||
      alias === target ||
      !isClientThreadPlaceholder(alias) ||
      isClientThreadPlaceholder(target)
    ) {
      return false;
    }
    threadAliases.set(alias, target);
    if (pendingNavigationThreadId === alias) setPendingNavigation(target);
    if (visibleThreadKnown && visibleThreadId === alias) visibleThreadId = target;
    return true;
  }

  function activeSidebarThreadContext() {
    const row = document.querySelector(ACTIVE_SIDEBAR_THREAD_SELECTOR);
    if (!row) return null;
    const kind = String(row.getAttribute("data-app-action-sidebar-thread-kind") || "");
    const sidebarThreadKey = normalizedId(row.getAttribute("data-app-action-sidebar-thread-id"));
    // 官方侧栏暴露的是 local:<threadId> 导航键，智能调度状态使用的是不带前缀的 App Server threadId。
    const rawThreadId =
      kind === "local" && sidebarThreadKey.startsWith(LOCAL_SIDEBAR_THREAD_PREFIX)
        ? normalizedId(sidebarThreadKey.slice(LOCAL_SIDEBAR_THREAD_PREFIX.length))
        : sidebarThreadKey;
    // 远程任务没有本地路由；本地 client-* 键通过已记录的别名恢复为真实 threadId。
    return {
      rawThreadId: kind === "local" ? rawThreadId : "",
      threadId: kind === "local" ? resolvedThreadId(rawThreadId) : "",
    };
  }

  function threadIdFromPath(pathname) {
    const value = String(pathname || "");
    for (const pattern of THREAD_PATH_PATTERNS) {
      const match = pattern.exec(value);
      if (match?.[1]) return normalizedId(match[1]);
    }
    return "";
  }

  function currentThreadId() {
    // 所有绘制和事件判断只读取已提交的可见任务，避免 URL、侧栏和协议消息每次重算出不同结果。
    return visibleThreadKnown ? resolvedThreadId(visibleThreadId) : "";
  }

  function isClientThreadPlaceholder(threadId) {
    const normalizedThreadId = normalizedId(threadId);
    return CLIENT_THREAD_PREFIXES.some((prefix) => normalizedThreadId.startsWith(prefix));
  }

  function requestId(value) {
    if (value == null) return "";
    return `${typeof value}:${String(value)}`;
  }

  function invalidateHydration(threadId) {
    const normalizedThreadId = resolvedThreadId(threadId);
    if (!normalizedThreadId) return;
    hydrateSequences.set(normalizedThreadId, (hydrateSequences.get(normalizedThreadId) || 0) + 1);
  }

  function clearRoute(threadId) {
    const normalizedThreadId = resolvedThreadId(threadId);
    if (!normalizedThreadId) return;
    invalidateHydration(normalizedThreadId);
    activeRoutes.delete(normalizedThreadId);
  }

  function commitVisibleThread(threadId, hydrate = false) {
    const normalizedThreadId = resolvedThreadId(threadId);
    const changed = !visibleThreadKnown || visibleThreadId !== normalizedThreadId;
    visibleThreadKnown = true;
    visibleThreadId = normalizedThreadId;
    // 切回任务时先恢复该任务自己的缓存；异步回读只负责校正，不能制造无结果空窗。
    scheduleRender();
    if (normalizedThreadId && (hydrate || changed)) void hydrateActiveRoute(normalizedThreadId);
  }

  function bindActiveSidebarAlias(threadId, source) {
    const target = resolvedThreadId(threadId);
    const sidebarContext = activeSidebarThreadContext();
    const alias = sidebarContext?.rawThreadId || "";
    if (!target || isClientThreadPlaceholder(target) || !isClientThreadPlaceholder(alias)) return false;
    const canBind =
      !visibleThreadKnown ||
      visibleThreadId === alias ||
      pendingNavigationThreadId === alias ||
      pendingNavigationThreadId === "" ||
      (source === "view-activity" && currentThreadId() === target);
    return canBind ? bindThreadAlias(alias, target) : false;
  }

  function isAuthoritativeVisibleThread(threadId, source) {
    if (!AUTHORITATIVE_VISIBLE_THREAD_SOURCES.has(source)) return false;
    if (source === "view-activity") return true;
    const sidebarContext = activeSidebarThreadContext();
    if (!sidebarContext?.threadId) return true;
    return (
      sidebarContext.threadId === threadId ||
      sidebarContext.rawThreadId === visibleThreadId ||
      sidebarContext.rawThreadId === pendingNavigationThreadId
    );
  }

  function selectVisibleThread(threadId, hydrate = false, source = "protocol") {
    let normalizedThreadId = resolvedThreadId(threadId);
    if (!normalizedThreadId) return false;
    bindActiveSidebarAlias(normalizedThreadId, source);
    normalizedThreadId = resolvedThreadId(normalizedThreadId);
    const authoritativeVisibleThread = isAuthoritativeVisibleThread(normalizedThreadId, source);
    if (AUTHORITATIVE_VISIBLE_THREAD_SOURCES.has(source) && !authoritativeVisibleThread) return false;
    if (pendingNavigationThreadId !== null && pendingNavigationThreadId !== normalizedThreadId) {
      const canResolveClientPlaceholder =
        ["turn-start", "route-event"].includes(source) &&
        (pendingNavigationThreadId === "" || isClientThreadPlaceholder(pendingNavigationThreadId));
      // 新会话先使用 client-* 占位 ID，首个真实回合/路由事件负责原子替换；其它旧任务帧不能越权。
      if (canResolveClientPlaceholder) {
        setPendingNavigation(normalizedThreadId);
      } else if (authoritativeVisibleThread) {
        // 前台视图活动或当前侧栏对应的 read/resume 是已提交事实，可以结束过期的导航保护。
        clearPendingNavigation();
      } else {
        return false;
      }
    } else if (authoritativeVisibleThread) {
      clearPendingNavigation();
    }
    // 显式导航意图只由 URL/侧栏提交确认；协议帧到达更早时继续保留保护，避免旧活动行反向覆盖。
    commitVisibleThread(normalizedThreadId, hydrate);
    return true;
  }

  function navigateVisibleThread(threadId) {
    setPendingNavigation(threadId);
    commitVisibleThread(pendingNavigationThreadId, !!pendingNavigationThreadId);
  }

  function clearVisibleThread() {
    // 空字符串也是明确的导航目标，用于阻断新会话页面残留的旧侧栏活动标记。
    setPendingNavigation("");
    commitVisibleThread("");
  }

  function gatewayHeaders() {
    const headers = new Headers();
    const token = String(w.__OPEN_CODEX_RUNTIME_AUTH_TOKEN__ || "").trim();
    if (token) headers.set("authorization", `Bearer ${token}`);
    return headers;
  }

  function isAutoTurn(params, threadId) {
    const selectedModel = configuredModel(params).toLowerCase();
    // 官方可能把虚拟 Auto 映射成上一轮真实 model 再发请求，当前模型选择器是分类前的可靠兜底信号。
    return (
      selectedModel === "auto" ||
      (resolvedThreadId(threadId) === currentThreadId() &&
        w.__OpenCodexSmartModelRouterComposer?.autoSelected === true)
    );
  }

  function configuredModel(params) {
    const directModel = String(params?.model || "").trim();
    if (directModel) return directModel;
    return String(params?.collaborationMode?.settings?.model || "").trim();
  }

  function normalizedRoute(value, threadId, turnId) {
    if (!value || typeof value !== "object") return null;
    const modelId = String(value.model || "").trim();
    const model = String(value.displayName || modelId).trim();
    const effort = String(value.effort || "").trim();
    if (!modelId || !model || !effort) return null;
    return {
      threadId: resolvedThreadId(threadId || value.threadId),
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

  function nativeSummarySection(root, allowSectionFallback = false) {
    if (!root) return null;
    for (const item of Array.from(root.querySelectorAll(NATIVE_SUMMARY_ITEM_SELECTOR))) {
      if (item.closest?.(`[${SECTION_ATTRIBUTE}]`)) continue;
      const section = item.closest?.("section");
      if (section && root.contains(section)) return section;
    }
    if (!allowSectionFallback) return null;
    // 固定面板可能暂时没有原生条目，仍可通过排除自定义 section 找到官方分组。
    for (const section of Array.from(root.querySelectorAll("section"))) {
      if (!section.hasAttribute?.(SECTION_ATTRIBUTE)) return section;
    }
    return null;
  }

  function hasClass(element, className) {
    return String(element?.className || "")
      .split(/\s+/)
      .filter(Boolean)
      .includes(className);
  }

  function officialOverlaySummaryContainer(root) {
    if (!root) return null;
    // 官方 overlay 的 PopoverContent 有稳定的专用高度类；借此支持“原生分组全为空”的新任务。
    for (const candidate of Array.from(root.querySelectorAll("div"))) {
      if (!hasClass(candidate, OVERLAY_SUMMARY_CONTENT_CLASS)) continue;
      const container = candidate.querySelector(".overflow-y-auto");
      if (container) return container;
    }
    return null;
  }

  function containerInSummaryRoot(root, allowEmptyPinnedPanel = false) {
    const nativeSection = nativeSummarySection(root, allowEmptyPinnedPanel);
    if (nativeSection?.parentElement && root.contains(nativeSection.parentElement)) {
      return nativeSection.parentElement;
    }
    // 只有带专用标记的固定面板允许空内容回退，避免把任意 Radix 浮层误识别为任务摘要。
    return allowEmptyPinnedPanel ? root.querySelector(".overflow-y-auto") : null;
  }

  function summarySectionsContainer() {
    for (const root of Array.from(document.querySelectorAll(PINNED_SUMMARY_ROOT_SELECTOR))) {
      const container = containerInSummaryRoot(root, true);
      if (container) return container;
    }
    // overlay 优先用原生条目识别；全空时再核对官方 PopoverContent 专用结构，避开其它 Radix 浮层。
    for (const root of Array.from(document.querySelectorAll(OVERLAY_SUMMARY_ROOT_SELECTOR))) {
      const container = containerInSummaryRoot(root) || officialOverlaySummaryContainer(root);
      if (container) return container;
    }
    return null;
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
    items.className = "opencodex-smart-scheduling-summary-items flex flex-col gap-0.5 px-3.5";
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
    const section =
      Array.from(container.children || []).find((child) => child.hasAttribute?.(SECTION_ATTRIBUTE)) ||
      createSection();
    const model = section.querySelector(".opencodex-smart-scheduling-summary-model");
    const effort = section.querySelector(".opencodex-smart-scheduling-summary-effort");
    const items = section.querySelector(".opencodex-smart-scheduling-summary-items");
    const fallbackItem = section.querySelector('[data-opencodex-smart-scheduling-fallback-item="true"]');
    if (model && model.textContent !== route.model) model.textContent = route.model;
    if (effort && effort.textContent !== route.effort) effort.textContent = route.effort;
    if (route.fallback === true) {
      // 失败回退是本轮分类的结果，只有明确失败时才添加状态行，成功时不占用摘要空间。
      const item = fallbackItem || createItem(copy.status, "opencodex-smart-scheduling-summary-fallback");
      const value = item.querySelector(".opencodex-smart-scheduling-summary-fallback");
      if (value && value.textContent !== copy.fallback) value.textContent = copy.fallback;
      if (!fallbackItem) {
        item.setAttribute("data-opencodex-smart-scheduling-fallback-item", "true");
        if (items) items.appendChild(item);
      }
    } else if (fallbackItem) {
      fallbackItem.remove();
    }
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
    const normalizedThreadId = resolvedThreadId(threadId);
    if (!normalizedThreadId || !pluginEnabled || !displayEnabled) return;
    const sequence = (hydrateSequences.get(normalizedThreadId) || 0) + 1;
    hydrateSequences.set(normalizedThreadId, sequence);
    try {
      const response = await fetch(
        `/api/opencodex/model-router/active-route?threadId=${encodeURIComponent(normalizedThreadId)}`,
        { cache: "no-store", credentials: "same-origin", headers: gatewayHeaders() }
      );
      if (!response.ok || sequence !== hydrateSequences.get(normalizedThreadId)) return;
      const payload = await response.json();
      if (sequence !== hydrateSequences.get(normalizedThreadId)) return;
      const route = normalizedRoute(payload?.route, normalizedThreadId, payload?.route?.turnId);
      if (route) {
        manuallySelectedThreads.delete(normalizedThreadId);
        activeRoutes.set(normalizedThreadId, route);
      } else {
        const cachedRoute = activeRoutes.get(normalizedThreadId);
        // 分类完成前核心尚无具体 route；空回读不能覆盖已经确认的“正在判断”状态。
        if (!cachedRoute?.pending || manuallySelectedThreads.has(normalizedThreadId)) {
          activeRoutes.delete(normalizedThreadId);
        }
      }
      scheduleRender();
    } catch {}
  }

  function syncCurrentThread() {
    const routedThreadId = threadIdFromPath(String(w.location?.pathname || ""));
    const sidebarContext = activeSidebarThreadContext();
    if (
      routedThreadId &&
      isClientThreadPlaceholder(sidebarContext?.rawThreadId) &&
      (pendingNavigationThreadId === routedThreadId || currentThreadId() === routedThreadId)
    ) {
      // URL 已提交到真实任务且活动侧栏仍使用 client-* 时，两者共同构成可靠的别名证据。
      bindThreadAlias(sidebarContext.rawThreadId, routedThreadId);
      sidebarContext.threadId = resolvedThreadId(sidebarContext.rawThreadId);
    }
    if (pendingNavigationThreadId !== null) {
      const navigationConfirmed =
        routedThreadId === pendingNavigationThreadId ||
        sidebarContext?.threadId === pendingNavigationThreadId ||
        (pendingNavigationThreadId === "" && !routedThreadId && sidebarContext?.threadId === "");
      if (!navigationConfirmed) {
        // React 提交新导航前，URL 和侧栏都可能短暂保留旧任务；此阶段只重绘，不回滚已提交目标。
        scheduleRender();
        return;
      }
      const confirmedThreadId = pendingNavigationThreadId;
      clearPendingNavigation();
      commitVisibleThread(confirmedThreadId, !!confirmedThreadId);
      return;
    }
    if (routedThreadId) {
      commitVisibleThread(routedThreadId);
      return;
    }
    if (sidebarContext) {
      commitVisibleThread(sidebarContext.threadId);
      return;
    }
    // 侧栏在窄布局下可能整体卸载；没有新的可靠信号时保留已知可见任务。
    if (!visibleThreadKnown) commitVisibleThread("");
    else scheduleRender();
  }

  function nodeContainsSidebarThread(node) {
    if (!node || node.nodeType !== 1) return false;
    return (
      node.matches?.("[data-app-action-sidebar-thread-row]") === true ||
      !!node.querySelector?.("[data-app-action-sidebar-thread-row]")
    );
  }

  function handleMutations(records) {
    const mutations = Array.from(records || []);
    const sidebarChanged = mutations.some((record) => {
      if (record.type === "attributes") {
        return [
          "data-app-action-sidebar-thread-active",
          "data-app-action-sidebar-thread-id",
          "data-app-action-sidebar-thread-kind",
        ].includes(record.attributeName);
      }
      if (record.type !== "childList") return false;
      return [...Array.from(record.addedNodes || []), ...Array.from(record.removedNodes || [])].some(
        nodeContainsSidebarThread
      );
    });
    if (sidebarChanged) syncCurrentThread();
    else scheduleRender();
  }

  function handleNotification(message) {
    if (!message || typeof message !== "object") return;
    if (Array.isArray(message)) {
      message.forEach(handleNotification);
      return;
    }
    const method = String(message.method || "");
    const params = message.params && typeof message.params === "object" ? message.params : {};
    const threadId = resolvedThreadId(params.threadId || params.thread?.id);
    if (!threadId) return;
    if (method === "turn/started") {
      // 服务端可能同时推送后台任务的回合通知；这里只更新所属任务的路由，不改变当前可见任务。
      const metadata = params._meta?.[ROUTE_METADATA_KEY];
      const route = normalizedRoute(metadata, threadId, params.turn?.id || params.turnId);
      if (route) {
        // 先使用同一 turn/started 携带的安全路由，接口回读只负责最终校正，不能成为唯一展示来源。
        pluginEnabled = true;
        if (!manuallySelectedThreads.has(threadId)) activeRoutes.set(threadId, route);
        void hydrateActiveRoute(threadId);
      } else {
        const pending = activeRoutes.get(threadId);
        const autoSelected =
          threadId === currentThreadId() && w.__OpenCodexSmartModelRouterComposer?.autoSelected === true;
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
          clearRoute(threadId);
        }
      }
      scheduleRender();
      return;
    }
    if (TERMINAL_METHODS.has(method)) {
      const active = activeRoutes.get(threadId);
      const turnId = normalizedId(params.turn?.id || params.turnId);
      if (active && (!turnId || !active.turnId || active.turnId === turnId)) {
        // 回合结束只清除运行标记，具体路由继续作为 Auto 的最近一次分类结果展示。
        activeRoutes.set(threadId, { ...active, turnId: "", pending: false });
      }
      void hydrateActiveRoute(threadId);
      scheduleRender();
      return;
    }
    if (["thread/deleted", "thread/archived", "thread/unsubscribed"].includes(method)) {
      clearRoute(threadId);
      manuallySelectedThreads.delete(threadId);
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
    const threadId = resolvedThreadId(params.threadId || params.thread?.id);
    if (threadId && VISIBLE_THREAD_METHODS.has(method)) {
      if (method === "turn/start") {
        const canBecomeVisible =
          !visibleThreadKnown ||
          !currentThreadId() ||
          currentThreadId() === threadId ||
          pendingNavigationThreadId === threadId ||
          pendingNavigationThreadId === "" ||
          isClientThreadPlaceholder(currentThreadId()) ||
          isClientThreadPlaceholder(pendingNavigationThreadId);
        if (canBecomeVisible) selectVisibleThread(threadId, false, "turn-start");
      } else {
        selectVisibleThread(threadId, true, method);
      }
    }
    if (method === "thread/settings/update" && threadId) {
      const model = configuredModel(params).toLowerCase();
      if (!model) return;
      selectVisibleThread(threadId, false, "settings");
      const key = requestId(message.id);
      if (key) pendingModelSelections.set(key, { auto: model === "auto", threadId });
      clearRoute(threadId);
      if (model === "auto") {
        // 成功响应或网关状态事件会从核心重新补取，避免复用切换前的缓存。
        manuallySelectedThreads.delete(threadId);
        pluginEnabled = true;
      } else {
        // 手动选择是本页最即时的否定信号，阻止仍在路上的 selected/turn metadata 短暂回显。
        manuallySelectedThreads.add(threadId);
      }
      scheduleRender();
      return;
    }
    if (method !== "turn/start" || !threadId) return;

    const key = requestId(message.id);
    if (key) pendingTurnStarts.set(key, threadId);
    clearRoute(threadId);
    const autoTurn = isAutoTurn(params, threadId);
    if (autoTurn) {
      // Auto 选择器只在核心开关开启时存在；先展示分类状态，配置请求随后仍可关闭展示开关。
      manuallySelectedThreads.delete(threadId);
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
      manuallySelectedThreads.add(threadId);
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
      if (message.error || selection.auto) void hydrateActiveRoute(selection.threadId);
      else clearRoute(selection.threadId);
      scheduleRender();
    }
    if (key && pendingTurnStarts.has(key)) {
      const threadId = pendingTurnStarts.get(key);
      pendingTurnStarts.delete(key);
      if (message.error) {
        // Auto 启动失败时仍展示最近分类；手动回合会由接口返回空结果。
        void hydrateActiveRoute(threadId);
        scheduleRender();
      }
    }
    handleNotification(message);
  }

  function handleRouteEvent(event) {
    const threadId = resolvedThreadId(event?.threadId);
    const status = String(event?.status || "");
    if (!threadId || !status) return;
    if (
      isClientThreadPlaceholder(currentThreadId()) &&
      ["classifying", "selected", "started", "idle"].includes(status)
    ) {
      // 极早期 turn/start 若因脚本初始化竞态漏收，核心定向事件仍可完成占位 ID 到真实 ID 的交接。
      selectVisibleThread(threadId, false, "route-event");
    }
    // 网关事件可能来自当前标签页曾执行过的后台任务，只更新该任务缓存，不夺取可见任务上下文。
    if (status === "classifying") {
      // classifying 由核心只在确认 Auto 的 turn/start 上发出，可结束此前的手动展示屏蔽。
      manuallySelectedThreads.delete(threadId);
      pluginEnabled = true;
      invalidateHydration(threadId);
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
      // WS 事件本身已来自核心且只含安全字段，先显示它；HTTP 回读用于处理跨页和延迟清理。
      pluginEnabled = true;
      const route = normalizedRoute(event.route, threadId, event.route?.turnId);
      if (route && !manuallySelectedThreads.has(threadId)) activeRoutes.set(threadId, route);
      void hydrateActiveRoute(threadId);
    } else if (["cleared", "deleted", "unsubscribed"].includes(status)) {
      clearRoute(threadId);
      if (["deleted", "unsubscribed"].includes(status)) manuallySelectedThreads.delete(threadId);
    }
    scheduleRender();
  }

  function visibleThreadActivity(payload) {
    if (
      payload?.type !== "log-message" ||
      String(payload.message || "") !== "thread_stream_view_activity_changed"
    ) {
      return null;
    }
    const safe = payload.tags?.safe || payload.safe || {};
    const active = safe.active === true || safe.active === "true";
    const threadId = resolvedThreadId(safe.conversationId);
    if (!active || !threadId || isClientThreadPlaceholder(threadId)) return null;
    // 官方 renderer 只在任务视图 active 状态变化时记录该消息，它是根路由下 A/B 切换的直接信号。
    return threadId;
  }

  function handlePluginEvent(event) {
    const detail = event?.detail;
    if (detail?.eventName !== "view:message") return;
    const payload = detail.payload;
    if (!payload || typeof payload !== "object") return;
    const activeThreadId = visibleThreadActivity(payload);
    if (activeThreadId) {
      const sequence = ++visibleThreadActivitySequence;
      // 等本轮 React/MutationObserver 提交侧栏活动行后再绑定别名，避免把旧 A 的 client-* 误绑定到新 B。
      w.requestAnimationFrame(() => {
        if (sequence !== visibleThreadActivitySequence) return;
        selectVisibleThread(activeThreadId, true, "view-activity");
      });
      return;
    }
    if (payload.type === "navigate-to-route") {
      const threadId = threadIdFromPath(payload.path);
      if (threadId) navigateVisibleThread(threadId);
      else {
        const pathname = String(payload.path || "").split(/[?#]/, 1)[0];
        /**
         * 官方桌面 renderer 的本地任务内部路由长期保持 "/"；它不是“离开任务”信号。
         * 设置、技能等明确的非任务页仍需清空，避免在那里保留上一任务的摘要。
         */
        if (pathname && pathname !== "/") clearVisibleThread();
      }
      return;
    }
    if (NEW_THREAD_MESSAGE_TYPES.has(payload.type)) clearVisibleThread();
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
    if (!pluginEnabled || !displayEnabled) {
      // 关闭展示时同时废弃未完成请求和内存缓存，重新开启后必须再次向核心确认。
      for (const threadId of Array.from(hydrateSequences.keys())) invalidateHydration(threadId);
      activeRoutes.clear();
      removeSections();
    } else {
      void hydrateActiveRoute(currentThreadId());
    }
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
    const observer = new MutationObserver(handleMutations);
    // React 可能复用侧栏行并只修改活动属性，属性变化也必须触发当前任务同步。
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: [
        "data-app-action-sidebar-thread-active",
        "data-app-action-sidebar-thread-id",
        "data-app-action-sidebar-thread-kind",
      ],
      childList: true,
      subtree: true,
    });
    w.addEventListener("popstate", syncCurrentThread);
    w.addEventListener("opencodex:plugin-event", handlePluginEvent);
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
        visibleThreadKnown,
      };
    },
  });

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install, { once: true });
  else install();
})();
