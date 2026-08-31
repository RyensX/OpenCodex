(function () {
  const w = window;
  if (w.__codexTooltipDismissGuardInstalled) return;
  const adapterHost = w.__OpenCodexAdapterHost;
  if (!adapterHost?.dom?.observe || !adapterHost?.events?.observe) return;
  w.__codexTooltipDismissGuardInstalled = true;

  const TOOLTIP_SELECTOR = '[role="tooltip"]';
  const TOOLTIP_DISMISS_EVENT = "codex:dismiss-tooltips";
  const TOOLTIP_TRIGGER_SELECTOR = [
    "button",
    "a",
    "input",
    "select",
    "textarea",
    "[role]",
    "[tabindex]",
    "[title]",
    "[aria-label]",
    "[aria-describedby]",
    '[data-slot*="tooltip"]',
  ].join(",");

  let lastPointer = null;
  let pendingFrame = 0;
  let tooltipPresent = !!document.querySelector(TOOLTIP_SELECTOR);
  let disposeTooltipObservation = null;
  let tooltipObserverExpiryTimer = 0;
  const TOOLTIP_OBSERVER_SESSION_MS = 2_500;

  function visibleTooltips() {
    const tooltips = Array.from(document.querySelectorAll(TOOLTIP_SELECTOR));
    tooltipPresent = tooltips.length > 0;
    return tooltips;
  }

  function dispatchOfficialTooltipDismiss() {
    if (!tooltipPresent) return;
    if (!document.querySelector(TOOLTIP_SELECTOR)) {
      tooltipPresent = false;
      return;
    }

    if (typeof w.Event === "function") {
      w.dispatchEvent(new w.Event(TOOLTIP_DISMISS_EVENT));
      return;
    }

    const event = document.createEvent("Event");
    event.initEvent(TOOLTIP_DISMISS_EVENT, false, false);
    w.dispatchEvent(event);
  }

  function containsElement(parent, child) {
    return !!(parent && child && (parent === child || parent.contains(child)));
  }

  function targetReferencesTooltip(target, tooltipId) {
    if (!target || !tooltipId) return false;
    // 指针/焦点目标只可能属于其祖先 trigger；沿局部祖先链检查，避免每帧扫描全页 aria-describedby。
    for (let node = target; node && node.nodeType === 1; node = node.parentElement) {
      const describedBy = String(node.getAttribute?.("aria-describedby") || "");
      if (describedBy.split(/\s+/).includes(tooltipId)) return true;
    }
    return false;
  }

  function targetBelongsToOpenTooltip(target, tooltips) {
    if (!target) return false;

    for (const tooltip of tooltips) {
      if (containsElement(tooltip, target)) return true;

      if (targetReferencesTooltip(target, tooltip.id)) return true;
    }

    return false;
  }

  function currentPointerTarget() {
    if (!lastPointer) return null;
    if (typeof document.elementFromPoint !== "function") return lastPointer.target;
    return document.elementFromPoint(lastPointer.x, lastPointer.y) || lastPointer.target;
  }

  function dismissIfPointerLeftTooltips() {
    pendingFrame = 0;

    const tooltips = visibleTooltips();
    if (!tooltips.length) return;
    if (!lastPointer) return;

    if (
      targetBelongsToOpenTooltip(currentPointerTarget(), tooltips) ||
      targetBelongsToOpenTooltip(document.activeElement, tooltips)
    ) {
      return;
    }
    dispatchOfficialTooltipDismiss();
  }

  function scheduleDismissCheck() {
    if (pendingFrame) return;
    pendingFrame = w.setTimeout(dismissIfPointerLeftTooltips, 16);
  }

  function rememberPointer(event) {
    // 没有 tooltip、也没有等待挂载的短会话时不记录高频 pointermove，尤其避免触摸滚动持续分配对象。
    if (!tooltipPresent && !tooltipObserverExpiryTimer) return;
    lastPointer = {
      x: event.clientX,
      y: event.clientY,
      target: event.target && event.target.nodeType === 1 ? event.target : null,
    };
    if (tooltipPresent) scheduleDismissCheck();
  }

  function dismissOnDocumentExit(event) {
    if (!event.relatedTarget) dispatchOfficialTooltipDismiss();
  }

  function nodeHasTooltip(node) {
    if (!node || node.nodeType !== 1) return false;
    if (typeof node.matches === "function" && node.matches(TOOLTIP_SELECTOR)) return true;
    if (!node.firstElementChild) return false;
    return typeof node.querySelector === "function" && !!node.querySelector(TOOLTIP_SELECTOR);
  }

  function stopTooltipObservation() {
    disposeTooltipObservation?.();
    disposeTooltipObservation = null;
    if (tooltipObserverExpiryTimer) w.clearTimeout(tooltipObserverExpiryTimer);
    tooltipObserverExpiryTimer = 0;
    if (!tooltipPresent) lastPointer = null;
  }

  function handleTooltipMutations(mutations) {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes || []) {
        if (nodeHasTooltip(node)) {
          tooltipPresent = !!document.querySelector(TOOLTIP_SELECTOR);
          if (tooltipPresent) {
            w.OpenCodexRuntimeCompatibility?.active?.("web.runtime.dom.tooltip-dismiss");
            stopTooltipObservation();
            scheduleDismissCheck();
          }
          return;
        }
      }
    }
  }

  function mayOpenTooltip(event) {
    // focusin 本身只来自可聚焦节点；pointerover 则过滤正文流式渲染产生的大量普通节点切换。
    if (event?.type === "focusin") return true;
    const target = event?.target;
    if (!target || target.nodeType !== 1) return false;
    if (typeof target.closest !== "function") return true;
    return !!target.closest(TOOLTIP_TRIGGER_SELECTOR);
  }

  function observeForTooltipMount(event) {
    if (!mayOpenTooltip(event)) return;
    if (tooltipPresent && document.querySelector(TOOLTIP_SELECTOR)) return;
    tooltipPresent = false;
    // 同一交互会话不反复断开、重连或续期，避免鼠标经过嵌套按钮节点时持续扫描全页。
    if (tooltipObserverExpiryTimer) {
      rememberPointer(event);
      return;
    }
    disposeTooltipObservation = adapterHost.dom.observe({
      key: {},
      root: document.documentElement,
      options: { childList: true, subtree: true },
      callback: handleTooltipMutations,
    });
    // Tooltip 只会紧随 hover/focus 挂载；有限会话避免正文流式更新永久进入观察队列。
    tooltipObserverExpiryTimer = w.setTimeout(stopTooltipObservation, TOOLTIP_OBSERVER_SESSION_MS);
    if (event?.type !== "focusin") rememberPointer(event);
  }

  if (typeof w.PointerEvent === "function") {
    adapterHost.events.observe({ key: {}, target: document, type: "pointermove", callback: rememberPointer, capture: true, passive: true });
    adapterHost.events.observe({ key: {}, target: document, type: "pointerover", callback: observeForTooltipMount, capture: true, passive: true });
    adapterHost.events.observe({ key: {}, target: document, type: "pointerout", callback: dismissOnDocumentExit, capture: true, passive: true });
  } else {
    // 老浏览器没有 PointerEvent 时才使用鼠标事件，避免现代浏览器为同一次移动执行两遍逻辑。
    adapterHost.events.observe({ key: {}, target: document, type: "mousemove", callback: rememberPointer, capture: true, passive: true });
    adapterHost.events.observe({ key: {}, target: document, type: "mouseover", callback: observeForTooltipMount, capture: true, passive: true });
    adapterHost.events.observe({ key: {}, target: document, type: "mouseout", callback: dismissOnDocumentExit, capture: true, passive: true });
  }
  adapterHost.events.observe({ key: {}, target: document, type: "focusin", callback: observeForTooltipMount, capture: true });
  adapterHost.events.observe({ key: {}, target: document, type: "scroll", callback: dispatchOfficialTooltipDismiss, capture: true, passive: true });
  adapterHost.events.observe({ key: {}, target: w, type: "blur", callback: dispatchOfficialTooltipDismiss });
  adapterHost.events.observe({ key: {}, target: document, type: "visibilitychange", callback: () => {
    if (document.visibilityState !== "visible") dispatchOfficialTooltipDismiss();
  } });
  w.OpenCodexRuntimeCompatibility?.installed?.("web.runtime.dom.tooltip-dismiss");
})();
