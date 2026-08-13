(function () {
  const w = window;
  if (w.__opencodexSidebarPreviewInstalled) return;
  w.__opencodexSidebarPreviewInstalled = true;

  const PREVIEW_ID = "opencodex-sidebar-preview";
  const PREVIEW_ROW_SELECTOR = "[data-opencodex-sidebar-preview-row]";
  const OFFICIAL_ROW_SELECTOR = "[data-app-action-sidebar-thread-row]";
  const MAX_LIFETIME_MS = 8_000;
  const LATE_MODULE_PRELOAD_DELAY_MS = 350;
  const startedAtMs = Date.now();
  let pendingThreadId = "";
  let checkTimer = null;
  let checkDelayMs = 16;
  let readyObserver = null;
  let readyFrame = null;

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
    };
    const scheduleInstall = () => w.setTimeout(install, LATE_MODULE_PRELOAD_DELAY_MS);
    // load 后再留出一段主模块初始化窗口，避免低速 CPU 同时编译语言包和 React 首屏任务。
    if (document.readyState === "complete") scheduleInstall();
    else w.addEventListener("load", scheduleInstall, { once: true });
  }

  function previewElement() {
    return document.getElementById(PREVIEW_ID);
  }

  function officialThreadRow(threadId) {
    if (!threadId) return null;
    const expected = `local:${threadId}`;
    // 不把 id 拼进 CSS selector，历史 id 即使出现特殊字符也不会改变选择器语义。
    return Array.from(document.querySelectorAll(OFFICIAL_ROW_SELECTOR)).find(
      (row) => row.getAttribute("data-app-action-sidebar-thread-id") === expected
    );
  }

  function removePreview() {
    if (checkTimer) w.clearTimeout(checkTimer);
    if (readyFrame) w.cancelAnimationFrame(readyFrame);
    readyObserver?.disconnect();
    checkTimer = null;
    readyFrame = null;
    readyObserver = null;
    previewElement()?.remove();
    document.removeEventListener("click", onDocumentClick, true);
  }

  function handoffIfOfficialReady() {
    const officialTarget = officialThreadRow(pendingThreadId);
    if (officialTarget) {
      // 先移除覆盖层再委托点击，官方 React 仍是唯一负责导航和会话状态的实现。
      removePreview();
      w.requestAnimationFrame(() => {
        officialTarget.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: w }));
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
    checkTimer = w.setTimeout(() => {
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
    const row = event.target?.closest?.(PREVIEW_ROW_SELECTOR);
    if (!row || !previewElement()?.contains(row)) return;
    const threadId = String(row.getAttribute("data-opencodex-thread-id") || "");
    if (!threadId) return;
    event.preventDefault();
    event.stopPropagation();
    pendingThreadId = threadId;
    previewElement()?.setAttribute("data-opencodex-pending-thread", threadId);
    row.setAttribute("aria-busy", "true");
    checkDelayMs = 16;
    // 常态首屏只做低频轮询；用户已经提前选择会话时才临时观察 DOM，兼顾低功耗和快速交接。
    observeOfficialSidebar();
    if (checkTimer) w.clearTimeout(checkTimer);
    checkTimer = null;
    scheduleCheck();
  }

  function observeOfficialSidebar() {
    if (readyObserver || typeof w.MutationObserver !== "function") return;
    readyObserver = new w.MutationObserver(() => {
      if (readyFrame) return;
      readyFrame = w.requestAnimationFrame(() => {
        readyFrame = null;
        // 官方 React 提交侧栏节点时直接交接，不让连续 DOM 更新反复取消定时检查。
        handoffIfOfficialReady();
      });
    });
    readyObserver.observe(document.documentElement, { childList: true, subtree: true });
  }

  // 脚本位于 head，先安装委托；服务端预渲染的 aside 随后才会被解析进 body。
  scheduleLateModulePreloads();
  document.addEventListener("click", onDocumentClick, true);
  scheduleCheck();
  document.addEventListener("DOMContentLoaded", () => {
    if (!previewElement()) {
      // 没有历史快照时服务端不会输出 aside；立即清理轮询和点击委托，避免空会话页面常驻全局 DOM 观察器。
      removePreview();
      return;
    }
    // React 初始化期间不观察整棵 DOM；没有提前点击时指数退避轮询足以在 250ms 内完成遮罩交接。
    scheduleCheck();
  }, { once: true });
})();
