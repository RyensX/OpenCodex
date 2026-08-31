(function () {
  const w = window;
  const pluginSystem = w.OpenCodexPluginSystem || w.__OpenCodexPluginSystem;
  if (!pluginSystem || typeof pluginSystem.registerPlugin !== "function") return;

  const AUTO_COLLAPSE_DELAY_MS = 80;
  const SIDEBAR_THREAD_ROW_SELECTOR = "[data-app-action-sidebar-thread-row]";
  const SIDEBAR_SCROLL_SELECTOR = "[data-app-action-sidebar-scroll]";
  const SIDEBAR_NON_THREAD_ROW_SELECTOR = "[data-app-action-sidebar-project-row],[data-app-action-sidebar-section]";
  const SIDEBAR_TOGGLE_SELECTOR = "[data-app-shell-sidebar-trigger]";
  const SIDEBAR_TOGGLE_VIEW_TRANSITION_NAME = "sidebar-trigger";
  // 官方不同版本使用过两套“新建任务”图标，需同时兼容，避免上游换图标后点击失效。
  const SIDEBAR_NEW_CONVERSATION_ICON_PATH_PREFIXES = ["M2.6687 11.333", "M6.33325 1.88379"];
  const NEW_CONVERSATION_MESSAGE_TYPES = new Set(["new-chat", "new-quick-chat"]);

  function visibleElement(element) {
    if (!element || typeof element.getBoundingClientRect !== "function") return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = w.getComputedStyle ? w.getComputedStyle(element) : null;
    return !style || (style.display !== "none" && style.visibility !== "hidden");
  }

  function sidebarPanelElement() {
    return document.querySelector(".app-shell-left-panel");
  }

  function sidebarNavigationElement() {
    const panel = sidebarPanelElement();
    if (panel) return panel.querySelector(SIDEBAR_SCROLL_SELECTOR) || panel.querySelector("nav") || panel;
    return document.querySelector(SIDEBAR_SCROLL_SELECTOR) || document.querySelector("nav");
  }

  function isNestedSidebarInteractiveElement(element) {
    if (!element || typeof element.matches !== "function") return false;
    const role = String(element.getAttribute?.("role") || "").toLowerCase();
    return (
      element.matches("button,a[href],input,select,textarea,summary,[contenteditable='true']") ||
      role === "button" ||
      role === "menuitem" ||
      role === "menuitemcheckbox" ||
      role === "menuitemradio" ||
      role === "checkbox" ||
      role === "switch" ||
      role === "tab"
    );
  }

  function nestedSidebarInteractiveFromTarget(target, row) {
    for (let node = target; node && node !== row; node = node.parentElement) {
      if (isNestedSidebarInteractiveElement(node)) return node;
    }
    return null;
  }

  function isSidebarConversationRow(element) {
    if (!element || typeof element.matches !== "function") return false;
    const officialThreadRow = element.matches(SIDEBAR_THREAD_ROW_SELECTOR);
    const legacyThreadRow =
      element.matches("[role='button'].h-token-nav-row") &&
      !element.matches(SIDEBAR_NON_THREAD_ROW_SELECTOR) &&
      !!element.querySelector("[data-thread-title]");
    if (!officialThreadRow && !legacyThreadRow) return false;
    if (!visibleElement(element)) return false;
    if (officialThreadRow) {
      const id = element.getAttribute("data-app-action-sidebar-thread-id");
      const kind = element.getAttribute("data-app-action-sidebar-thread-kind");
      if (!id || !/^(local|remote|pending-worktree)$/.test(kind || "")) return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width >= 80 && rect.height >= 20 && rect.height <= 64;
  }

  function sidebarConversationRowFromTarget(target) {
    const element = target && target.nodeType === 1 ? target : target?.parentElement;
    if (!element || typeof element.closest !== "function") return null;
    const nav = sidebarNavigationElement();
    if (!nav || !nav.contains(element)) return null;
    const officialRow = element.closest(SIDEBAR_THREAD_ROW_SELECTOR);
    if (officialRow && nav.contains(officialRow) && isSidebarConversationRow(officialRow)) {
      return nestedSidebarInteractiveFromTarget(element, officialRow) ? null : officialRow;
    }
    const tokenRow = element.closest("[role='button'].h-token-nav-row");
    if (tokenRow && nav.contains(tokenRow) && isSidebarConversationRow(tokenRow)) {
      return nestedSidebarInteractiveFromTarget(element, tokenRow) ? null : tokenRow;
    }
    for (let node = element; node && node !== nav; node = node.parentElement) {
      if (isSidebarConversationRow(node)) {
        return nestedSidebarInteractiveFromTarget(element, node) ? null : node;
      }
    }
    return null;
  }

  function sidebarToggleViewTransitionName(button) {
    const inlineName =
      button.style?.viewTransitionName || button.style?.getPropertyValue?.("view-transition-name") || "";
    if (inlineName) return String(inlineName).trim();
    try {
      const style = w.getComputedStyle ? w.getComputedStyle(button) : null;
      return String(style?.viewTransitionName || style?.getPropertyValue?.("view-transition-name") || "").trim();
    } catch {
      return "";
    }
  }

  function findSidebarToggleButton() {
    // 新版官方界面提供稳定标记；保留 view-transition 识别以兼容旧版。
    const markedButton = document.querySelector(SIDEBAR_TOGGLE_SELECTOR);
    if (markedButton?.matches?.("button") && visibleElement(markedButton)) return markedButton;
    return Array.from(document.querySelectorAll("button")).find((button) => {
      if (!visibleElement(button)) return false;
      return sidebarToggleViewTransitionName(button) === SIDEBAR_TOGGLE_VIEW_TRANSITION_NAME;
    });
  }

  function postSidebarToggleMessage() {
    try {
      w.postMessage({ type: "toggle-sidebar" }, w.location.origin || "*");
    } catch {}
  }

  function isNewConversationMessage(payload) {
    if (!payload || typeof payload !== "object") return false;
    if (NEW_CONVERSATION_MESSAGE_TYPES.has(payload.type)) return true;
    if (payload.type !== "navigate-to-route" || payload.path !== "/") return false;
    const state = payload.state && typeof payload.state === "object" ? payload.state : null;
    return !!state && Object.prototype.hasOwnProperty.call(state, "focusComposerNonce");
  }

  function isSidebarNewConversationButton(button) {
    if (!button || typeof button.matches !== "function" || !button.matches("button")) return false;
    const panel = sidebarPanelElement();
    if (!panel || !panel.contains(button)) return false;
    if (!visibleElement(button) || button.disabled || button.getAttribute("aria-disabled") === "true") return false;
    return Array.from(button.querySelectorAll("svg path")).some((path) =>
      SIDEBAR_NEW_CONVERSATION_ICON_PATH_PREFIXES.some((prefix) =>
        String(path.getAttribute("d") || "").startsWith(prefix)
      )
    );
  }

  function sidebarNewConversationButtonFromTarget(target) {
    const element = target && target.nodeType === 1 ? target : target?.parentElement;
    if (!element || typeof element.closest !== "function") return null;
    const button = element.closest("button");
    return isSidebarNewConversationButton(button) ? button : null;
  }

  pluginSystem.registerPlugin({
    id: "opencodex.mobile-sidebar-auto-collapse",
    name: "Mobile sidebar auto collapse",
    labelKey: "plugin.mobileSidebarAutoCollapse.label",
    label: "移动端侧栏优化",
    descKey: "plugin.mobileSidebarAutoCollapse.desc",
    desc: "在移动端打开会话或新建会话后自动收起侧栏。",
    enableStorageKey: "mobileSidebarAutoCollapse",
    defaultEnabled: true,
    builtin: true,
    order: 20,
    activate(context) {
      const adapterHost = w.__OpenCodexAdapterHost;
      if (
        context.scope !== "renderer" ||
        !document ||
        document.__opencodexMobileSidebarPluginInstalled ||
        !adapterHost?.events?.observe
      ) return null;
      document.__opencodexMobileSidebarPluginInstalled = true;
      w.OpenCodexRuntimeCompatibility?.installed?.("web.runtime.plugin.mobile-sidebar");

      let collapseTimer = null;
      const isEnabled = () => context.plugin.isEnabled();
      const isMobile = () => !!context.platform.isMobile();

      const collapseAfterSelection = () => {
        if (collapseTimer) w.clearTimeout(collapseTimer);
        collapseTimer = w.setTimeout(() => {
          collapseTimer = null;
          const panel = sidebarPanelElement();
          if (!panel || !visibleElement(panel)) return;
          const toggleButton = findSidebarToggleButton();
          if (toggleButton && typeof toggleButton.click === "function") {
            toggleButton.click();
            w.OpenCodexRuntimeCompatibility?.active?.("web.runtime.plugin.mobile-sidebar");
            return;
          }
          postSidebarToggleMessage();
          w.OpenCodexRuntimeCompatibility?.active?.("web.runtime.plugin.mobile-sidebar");
        }, AUTO_COLLAPSE_DELAY_MS);
      };

      const handleClick = (event) => {
        if (!isEnabled() || !isMobile()) return;
        if (event.defaultPrevented || event.button > 0) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        if (!sidebarConversationRowFromTarget(event.target) && !sidebarNewConversationButtonFromTarget(event.target)) {
          return;
        }
        collapseAfterSelection();
      };

      const handlePointerDown = (event) => {
        if (!isEnabled() || !isMobile() || event.pointerType !== "touch") return;
        if (!sidebarConversationRowFromTarget(event.target)) return;
        // 官方 dnd-kit 移动 6px 就激活拖拽；隔离触摸起点，让浏览器保留纵向滚动。
        event.stopPropagation();
      };

      const disposeViewMessage = context.events.on("view:message", (payload) => {
        if (isEnabled() && isMobile() && isNewConversationMessage(payload)) collapseAfterSelection();
      });

      const disposeClick = adapterHost.events.observe({
        key: {},
        target: document,
        type: "click",
        capture: true,
        callback: handleClick,
      });
      const disposePointerDown = adapterHost.events.observe({
        key: {},
        target: document,
        type: "pointerdown",
        capture: true,
        callback: handlePointerDown,
      });

      return () => {
        if (collapseTimer) w.clearTimeout(collapseTimer);
        disposeViewMessage();
        disposeClick();
        disposePointerDown();
        document.__opencodexMobileSidebarPluginInstalled = false;
      };
    },
  });
})();
