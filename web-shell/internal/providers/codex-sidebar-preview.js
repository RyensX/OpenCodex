(function () {
  const w = window;
  const modificationScope = w.__OpenCodexCurrentProviderScope;
  const modificationEffects = modificationScope?.effects;
  const providerGeneration = modificationScope?.generation || document;
  if (w.__opencodexSidebarPreviewInstalled === providerGeneration) return;
  const adapterHost = w.__OpenCodexAdapterHost;
  const scheduler = adapterHost?.scheduler?.capture?.() || w;
  if (!adapterHost?.dom?.observe || !adapterHost?.events?.observe) return;
  w.__opencodexSidebarPreviewInstalled = providerGeneration;

  const PREVIEW_ID = "opencodex-sidebar-preview";
  const PREVIEW_ROW_SELECTOR = "[data-opencodex-sidebar-preview-row]";
  const HISTORY_LOADING_ID = "opencodex-history-loading";
  // 新版官方侧栏把会话 ID 放在按钮本身；旧版才使用独立的 row 属性。
  const OFFICIAL_ROW_SELECTOR =
    "[data-app-action-sidebar-thread-row],[data-app-action-sidebar-thread-id]";
  // 公网中继首次编译官方资源可能超过数秒；用户已点选会话时必须保留交接目标，避免超时后回到空白页。
  const MAX_LIFETIME_MS = 30_000;
  const LATE_MODULE_PRELOAD_DELAY_MS = 350;
  const startedAtMs = Date.now();
  let pendingThreadId = "";
  let checkTimer = null;
  let checkDelayMs = 16;
  let disposeReadyObservation = null;
  let readyFrame = null;
  let historyLoadingCheckTimer = null;
  let historyLoadingTimeoutTimer = null;
  let historyLoadingProgressTimer = null;
  let disposeHistoryLoadingObservation = null;
  let historyLoadingInitialText = "";
  let handoffFallbackTimer = null;
  let historyLoadingProgress = 8;

  function scheduleLateModulePreloads() {
    const markers = Array.from(
      document.querySelectorAll('meta[name="opencodex-late-modulepreload"]')
    );
    const entries = markers
      .map((marker) => ({ marker, href: String(marker.getAttribute("content") || "") }))
      .filter((entry) => entry.href.startsWith("/official-patched-"));
    if (entries.length === 0) return;
    const install = () => {
      const alreadyPresent = new Set(
        Array.from(document.querySelectorAll('link[rel="modulepreload"]')).map((link) =>
          link.getAttribute("href")
        )
      );
      for (const { marker, href } of entries) {
        if (!alreadyPresent.has(href)) {
          const preload = document.createElement("link");
          preload.setAttribute("rel", "modulepreload");
          preload.setAttribute("crossorigin", "anonymous");
          preload.setAttribute("href", href);
          document.head?.appendChild(preload);
          alreadyPresent.add(href);
        }
        marker.remove();
      }
      modificationEffects?.lateModulePreload?.emit();
    };
    const scheduleInstall = () => scheduler.setTimeout(install, LATE_MODULE_PRELOAD_DELAY_MS);
    // load 后再留出一段主模块初始化窗口，避免低速 CPU 同时编译语言包和 React 首屏任务。
    if (document.readyState === "complete") scheduleInstall();
    else adapterHost.events.observe({ key: {}, target: w, type: "load", once: true, callback: scheduleInstall });
  }

  function previewElement() {
    return document.getElementById(PREVIEW_ID);
  }

  function historyLoadingElement() {
    return document.getElementById(HISTORY_LOADING_ID);
  }

  function ensureHistoryLoadingStyles() {
    if (document.getElementById(`${HISTORY_LOADING_ID}-styles`)) return;
    const styles = document.createElement("style");
    styles.id = `${HISTORY_LOADING_ID}-styles`;
    styles.textContent = `
      #${HISTORY_LOADING_ID}{position:fixed;top:0;right:0;bottom:0;left:340px;z-index:20;display:grid;place-items:center;background:color-mix(in srgb,var(--background-primary,#171717) 92%,transparent);pointer-events:auto}
      #${HISTORY_LOADING_ID} [data-opencodex-history-loading-panel]{display:flex;min-width:220px;flex-direction:column;align-items:center;gap:12px;border:1px solid color-mix(in srgb,var(--border-default,#555) 35%,transparent);border-radius:12px;background:color-mix(in srgb,var(--background-primary,#171717) 96%,transparent);padding:20px 24px;color:var(--text-primary,#ececec);box-shadow:0 8px 32px rgb(0 0 0 / 18%)}
      #${HISTORY_LOADING_ID} [data-opencodex-history-loading-spinner]{width:22px;height:22px;border:3px solid color-mix(in srgb,currentColor 22%,transparent);border-top-color:currentColor;border-radius:50%;animation:opencodex-history-loading-spin .8s linear infinite}
      #${HISTORY_LOADING_ID} [data-opencodex-history-progress-track]{width:220px;height:6px;overflow:hidden;border-radius:999px;background:color-mix(in srgb,currentColor 16%,transparent)}
      #${HISTORY_LOADING_ID} [data-opencodex-history-progress-value]{display:block;width:8%;height:100%;border-radius:inherit;background:currentColor;transition:width .18s ease}
      #${HISTORY_LOADING_ID} [data-opencodex-history-retry]{border:0;border-radius:7px;background:var(--background-secondary,#333);padding:6px 12px;color:inherit;cursor:pointer}
      @keyframes opencodex-history-loading-spin{to{transform:rotate(360deg)}}
    `;
    document.head?.appendChild(styles);
  }

  function stopHistoryLoadingWatch() {
    if (historyLoadingCheckTimer) scheduler.clearTimeout(historyLoadingCheckTimer);
    if (historyLoadingTimeoutTimer) scheduler.clearTimeout(historyLoadingTimeoutTimer);
    if (historyLoadingProgressTimer) scheduler.clearTimeout(historyLoadingProgressTimer);
    disposeHistoryLoadingObservation?.();
    historyLoadingCheckTimer = null;
    historyLoadingTimeoutTimer = null;
    historyLoadingProgressTimer = null;
    disposeHistoryLoadingObservation = null;
    historyLoadingInitialText = "";
  }

  function clearHistoryLoading() {
    stopHistoryLoadingWatch();
    historyLoadingElement()?.remove();
  }

  function historyContentReady() {
    const main = document.querySelector("main");
    if (!main) return false;
    const text = main.textContent || "";
    // 官方历史 turn 渲染后会出现消息节点；仅有标题和侧栏文本时仍属于空白等待态。
    const messageNode = main.querySelector(
      "[data-turn-id],[data-message-author-role],[data-testid*='message'],article,[role='article']"
    );
    return Boolean(messageNode) || text.trim().length > historyLoadingInitialText.trim().length + 32;
  }

  function updateHistoryLoadingProgress(progress, label) {
    const loading = historyLoadingElement();
    if (!loading) return;
    const value = Math.max(0, Math.min(100, Math.round(Number(progress) || 0)));
    historyLoadingProgress = Math.max(historyLoadingProgress, value);
    const bar = loading.querySelector?.("[data-opencodex-history-progress-value]");
    const text = loading.querySelector?.("[data-opencodex-history-progress-label]");
    if (bar) bar.style.width = `${historyLoadingProgress}%`;
    if (text) text.textContent = label || `正在加载历史会话 ${historyLoadingProgress}%`;
  }

  function scheduleHistoryLoadingProgress() {
    if (historyLoadingProgressTimer || !historyLoadingElement()) return;
    historyLoadingProgressTimer = scheduler.setTimeout(() => {
      historyLoadingProgressTimer = null;
      if (!historyLoadingElement()) return;
      updateHistoryLoadingProgress(Math.min(92, historyLoadingProgress + 4));
      scheduleHistoryLoadingProgress();
    }, 500);
  }

  function setHistoryLoadingTimeout() {
    const loading = historyLoadingElement();
    if (!loading) return;
    if (historyLoadingProgressTimer) scheduler.clearTimeout(historyLoadingProgressTimer);
    historyLoadingProgressTimer = null;
    loading.innerHTML = `<div data-opencodex-history-loading-panel role="alert"><span>历史会话加载超时</span><button type="button" data-opencodex-history-retry>重试</button></div>`;
  }

  function checkHistoryContent() {
    historyLoadingCheckTimer = null;
    if (!historyLoadingElement()) return;
    if (historyContentReady()) {
      updateHistoryLoadingProgress(100, "历史会话加载完成");
      clearHistoryLoading();
      return;
    }
    historyLoadingCheckTimer = scheduler.setTimeout(checkHistoryContent, 250);
  }

  function showHistoryLoading() {
    ensureHistoryLoadingStyles();
    const main = document.querySelector("main");
    if (!main) {
      historyLoadingCheckTimer = scheduler.setTimeout(showHistoryLoading, 100);
      return;
    }
    historyLoadingInitialText = main.textContent || "";
    let loading = historyLoadingElement();
    if (!loading) {
      loading = document.createElement("div");
      loading.id = HISTORY_LOADING_ID;
      loading.setAttribute("role", "status");
      loading.setAttribute("aria-live", "polite");
      loading.innerHTML = `<div data-opencodex-history-loading-panel><span data-opencodex-history-loading-spinner aria-hidden="true"></span><span data-opencodex-history-progress-label>正在加载历史会话 8%</span><div data-opencodex-history-progress-track><span data-opencodex-history-progress-value></span></div></div>`;
      // 覆盖层独立挂在 body，避免向官方 React 的 main 子树注入节点后改变其挂载判断。
      document.body?.appendChild(loading);
    }
    historyLoadingProgress = 8;
    updateHistoryLoadingProgress(8);
    stopHistoryLoadingWatch();
    disposeHistoryLoadingObservation = adapterHost.dom.observe({
      key: {},
      root: document.body || main,
      options: { childList: true, subtree: true },
      callback: checkHistoryContent,
    });
    historyLoadingTimeoutTimer = scheduler.setTimeout(setHistoryLoadingTimeout, MAX_LIFETIME_MS);
    scheduleHistoryLoadingProgress();
    checkHistoryContent();
  }

  function officialThreadRow(threadId) {
    if (!threadId) return null;
    const expected = `local:${threadId}`;
    // 不把 id 拼进 CSS selector，历史 id 即使出现特殊字符也不会改变选择器语义。
    return Array.from(document.querySelectorAll(OFFICIAL_ROW_SELECTOR)).find(
      (row) =>
        row.getAttribute("data-app-action-sidebar-thread-id") === expected ||
        row.getAttribute("data-opencodex-thread-id") === threadId
    );
  }

  function removePreview() {
    if (checkTimer) scheduler.clearTimeout(checkTimer);
    if (handoffFallbackTimer) scheduler.clearTimeout(handoffFallbackTimer);
    if (readyFrame) scheduler.cancelAnimationFrame(readyFrame);
    disposeReadyObservation?.();
    checkTimer = null;
    handoffFallbackTimer = null;
    readyFrame = null;
    disposeReadyObservation = null;
    previewElement()?.remove();
    disposePreviewClick?.();
  }

  function scheduleRouteHandoffFallback() {
    if (handoffFallbackTimer || !pendingThreadId) return;
    // 新版官方侧栏可能永远不输出可点击的交接节点；延迟导航到官方线程路由，避免预览被清掉后停在空白页。
    handoffFallbackTimer = scheduler.setTimeout(() => {
      handoffFallbackTimer = null;
      if (!pendingThreadId || handoffIfOfficialReady()) return;
      const threadId = pendingThreadId;
      removePreview();
      clearHistoryLoading();
      const target = new URL(`./local/${encodeURIComponent(threadId)}`, w.location?.href || document.location?.href || "/");
      if (typeof w.location?.assign === "function") w.location.assign(target.href);
      else if (typeof w.location?.replace === "function") w.location.replace(target.href);
    }, 1_200);
  }

  function handoffIfOfficialReady() {
    const officialTarget = officialThreadRow(pendingThreadId);
    if (officialTarget) {
      modificationEffects?.handoff?.emit();
      // 先移除覆盖层再委托点击，官方 React 仍是唯一负责导航和会话状态的实现。
      removePreview();
      scheduler.requestAnimationFrame(() => {
        // 使用原生 click 触发官方按钮默认行为，兼容新版 React 事件委托和键盘/触控语义。
        officialTarget.click?.();
      });
      return true;
    }
    if (!pendingThreadId && document.querySelector(OFFICIAL_ROW_SELECTOR)) {
      removePreview();
      return true;
    }
    return false;
  }

  function scheduleCheck() {
    if (checkTimer) return;
    checkTimer = scheduler.setTimeout(() => {
      checkTimer = null;
      if (!previewElement()) {
        // head 脚本执行时 body 尚未解析；短暂轮询到预渲染 aside 出现，不等待 DOMContentLoaded。
        if (Date.now() - startedAtMs < 1_000) scheduleCheck();
        return;
      }
      if (handoffIfOfficialReady()) return;
      if (Date.now() - startedAtMs >= MAX_LIFETIME_MS) {
        removePreview();
        return;
      }
      checkDelayMs = Math.min(250, Math.round(checkDelayMs * 1.6));
      scheduleCheck();
    }, checkDelayMs);
  }

  function onDocumentClick(event) {
    const retry = event.target?.closest?.("[data-opencodex-history-retry]");
    if (retry && historyLoadingElement()) {
      event.preventDefault();
      event.stopPropagation();
      showHistoryLoading();
      if (officialThreadRow(pendingThreadId)?.click) officialThreadRow(pendingThreadId).click();
      else scheduleRouteHandoffFallback();
      return;
    }
    const row = event.target?.closest?.(PREVIEW_ROW_SELECTOR);
    if (!row || !previewElement()?.contains(row)) return;
    const threadId = String(row.getAttribute("data-opencodex-thread-id") || "");
    if (!threadId) return;
    event.preventDefault();
    event.stopPropagation();
    pendingThreadId = threadId;
    previewElement()?.setAttribute("data-opencodex-pending-thread", threadId);
    row.setAttribute("aria-busy", "true");
    // 官方切换历史会话期间主区域可能暂时没有任何 turn；先给用户明确反馈，避免出现整页空白。
    showHistoryLoading();
    updateHistoryLoadingProgress(18, "正在切换到会话 18%");
    checkDelayMs = 16;
    // 常态首屏只做低频轮询；用户已经提前选择会话时才临时观察 DOM，兼顾低功耗和快速交接。
    observeOfficialSidebar();
    scheduleRouteHandoffFallback();
    if (checkTimer) scheduler.clearTimeout(checkTimer);
    checkTimer = null;
    scheduleCheck();
  }

  function observeOfficialSidebar() {
    if (disposeReadyObservation) return;
    disposeReadyObservation = adapterHost.dom.observe({
      key: {},
      root: document.documentElement,
      options: { childList: true, subtree: true },
      callback() {
      if (readyFrame) return;
      readyFrame = scheduler.requestAnimationFrame(() => {
        readyFrame = null;
        // 官方 React 提交侧栏节点时直接交接，不让连续 DOM 更新反复取消定时检查。
        handoffIfOfficialReady();
      });
      },
    });
  }

  // 脚本位于 head，先安装委托；服务端预渲染的 aside 随后才会被解析进 body。
  scheduleLateModulePreloads();
  const disposePreviewClick = adapterHost.events.observe({
    key: {},
    target: document,
    type: "click",
    capture: true,
    callback: onDocumentClick,
  });
  scheduleCheck();
  adapterHost.events.observe({ key: {}, target: document, type: "DOMContentLoaded", once: true, callback: () => {
    if (!previewElement()) {
      // 没有历史快照时服务端不会输出 aside；立即清理轮询和点击委托，避免空会话页面常驻全局 DOM 观察器。
      removePreview();
      return;
    }
    // React 初始化期间不观察整棵 DOM；没有提前点击时指数退避轮询足以在 250ms 内完成遮罩交接。
    scheduleCheck();
  } });
})();
