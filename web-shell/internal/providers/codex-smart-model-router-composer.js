(function () {
  const w = window;
  if (w.__OpenCodexSmartModelRouterComposerInstalled) return;
  const adapterHost = w.__OpenCodexAdapterHost;
  if (!adapterHost?.dom?.observe || !adapterHost?.events?.observe) return;
  w.__OpenCodexSmartModelRouterComposerInstalled = true;

  const TRIGGER_SELECTOR = '[data-codex-intelligence-trigger="true"]';
  const MODEL_TEXT_SELECTOR = '[class*="_ModelPickerTriggerModelText_"]';
  const EFFORT_TEXT_SELECTOR = '[class*="_ModelPickerTriggerEffortLabel_"]';
  const MENU_RELEVANT_SELECTOR =
    '[data-model-picker-model-row="true"],[data-opencodex-auto-model-menu="true"],[data-opencodex-auto-effort-item="true"]';
  const MAIN_OBSERVER_OPTIONS = {
    attributes: true,
    attributeFilter: ["aria-controls", "data-selected-reasoning-effort"],
    childList: true,
    subtree: true,
  };
  const AUTO_MODEL = "auto";
  let syncScheduled = false;
  let linkedMenuIds = new Set();
  let linkedMenus = new Set();
  let triggerTextDisposers = [];
  let compatibilityHitReported = false;

  function stopTriggerTextObservation() {
    for (const dispose of triggerTextDisposers.reverse()) dispose();
    triggerTextDisposers = [];
  }

  function visibleNode(root, selector) {
    return Array.from(root.querySelectorAll(selector)).find((node) => !node.closest('[aria-hidden="true"]')) || null;
  }

  function modelTextForTrigger(trigger) {
    const officialText = visibleNode(trigger, MODEL_TEXT_SELECTOR)?.textContent?.trim();
    if (officialText) return officialText;
    // 官方样式类名可能随 bundle 更新；触发器自身的可见文本仍是稳定、语言无关的模型名兜底。
    return String(trigger?.innerText || trigger?.textContent || "").trim();
  }

  function isAutoSelected() {
    return Array.from(document.querySelectorAll(TRIGGER_SELECTOR)).some((trigger) => {
      return modelTextForTrigger(trigger).toLowerCase() === AUTO_MODEL;
    });
  }

  function linkedMenu(trigger) {
    const menuId = trigger.getAttribute("aria-controls");
    return menuId ? document.getElementById(menuId) : null;
  }

  function markAutoEffortItem(menu, effortText) {
    let markedItem = null;
    if (effortText) {
      const activePanel = menu.querySelector('[data-active="true"]');
      const candidates = activePanel?.querySelectorAll('[role="menuitem"][aria-haspopup="menu"]') || [];
      markedItem = Array.from(candidates).find((item) => {
        // 模型行有官方稳定标记；其余行再用当前强度值匹配，避免依赖“推理强度”的具体语言。
        if (item.querySelector('[data-model-picker-model-row="true"]')) return false;
        return String(item.textContent || "").trim().endsWith(effortText);
      });
    }
    if (markedItem) markedItem.dataset.opencodexAutoEffortItem = "true";
    return markedItem;
  }

  function syncComposer() {
    syncScheduled = false;
    if (document.visibilityState === "hidden") {
      stopTriggerTextObservation();
      return;
    }
    const activeMenus = new Set();
    const activeEffortItems = new Set();
    const nextLinkedMenuIds = new Set();
    const nextLinkedMenus = new Set();

    const triggers = Array.from(document.querySelectorAll(TRIGGER_SELECTOR));
    if (triggers.length > 0 && !compatibilityHitReported) {
      compatibilityHitReported = true;
      w.OpenCodexRuntimeCompatibility?.active?.("web.runtime.smart-router.composer");
    }
    stopTriggerTextObservation();
    for (const trigger of triggers) {
      triggerTextDisposers.push(adapterHost.dom.observe({
        key: {},
        root: trigger,
        options: { characterData: true, childList: true, subtree: true },
        callback() {
          // 只监听实际模型触发器内的文字变化，正文流式 characterData 不再进入全页观察队列。
          if (document.visibilityState !== "hidden") scheduleSync();
        },
      }));
      const menuId = trigger.getAttribute("aria-controls");
      if (menuId) nextLinkedMenuIds.add(menuId);
      const menu = linkedMenu(trigger);
      if (menu) nextLinkedMenus.add(menu);
      const modelText = modelTextForTrigger(trigger);
      const isAuto = modelText.toLowerCase() === AUTO_MODEL;
      if (isAuto) trigger.dataset.opencodexAutoModel = "true";
      else trigger.removeAttribute("data-opencodex-auto-model");
      if (!isAuto) continue;

      if (!menu) continue;
      menu.dataset.opencodexAutoModelMenu = "true";
      activeMenus.add(menu);
      const effortText = visibleNode(trigger, EFFORT_TEXT_SELECTOR)?.textContent?.trim() || "";
      const effortItem = markAutoEffortItem(menu, effortText);
      if (effortItem) activeEffortItems.add(effortItem);
    }

    // Radix 菜单通过 portal 动态重建，及时清理失效标记，切回具体模型后立即恢复官方界面。
    for (const menu of document.querySelectorAll('[data-opencodex-auto-model-menu="true"]')) {
      if (!activeMenus.has(menu)) menu.removeAttribute("data-opencodex-auto-model-menu");
    }
    for (const item of document.querySelectorAll('[data-opencodex-auto-effort-item="true"]')) {
      if (!activeEffortItems.has(item)) item.removeAttribute("data-opencodex-auto-effort-item");
    }
    // MutationObserver 热路径只使用这份小型索引，不能为每个流式文本记录重新扫描整页 trigger。
    linkedMenuIds = nextLinkedMenuIds;
    linkedMenus = nextLinkedMenus;
  }

  function scheduleSync() {
    if (syncScheduled) return;
    syncScheduled = true;
    requestAnimationFrame(syncComposer);
  }

  function elementTouchesComposer(element, includeDescendants = false) {
    if (!element || element.nodeType !== 1) return false;
    if (element.matches?.(`${TRIGGER_SELECTOR},${MENU_RELEVANT_SELECTOR}`)) return true;
    if (element.closest?.(`${TRIGGER_SELECTOR},${MENU_RELEVANT_SELECTOR}`)) return true;
    if (element.id && linkedMenuIds.has(element.id)) return true;
    if (
      includeDescendants &&
      element.firstElementChild &&
      (element.querySelector?.(`${TRIGGER_SELECTOR},${MENU_RELEVANT_SELECTOR}`) ||
        Array.from(element.querySelectorAll?.("[id]") || []).some(
          (node) => node.id && linkedMenuIds.has(node.id)
        ))
    ) {
      return true;
    }
    // Portal 菜单没有稳定 class，使用上次同步得到的有限集合判断，不触发 document 级查询。
    return Array.from(linkedMenus).some(
      (menu) => menu === element || menu.contains?.(element) || (includeDescendants && element.contains?.(menu))
    );
  }

  function mutationsTouchComposer(records) {
    return Array.from(records || []).some((record) => {
      if (record.type === "attributes") return elementTouchesComposer(record.target);
      if (record.type !== "childList") return false;
      if (elementTouchesComposer(record.target)) return true;
      return [...Array.from(record.addedNodes || []), ...Array.from(record.removedNodes || [])].some(
        (node) => elementTouchesComposer(node, true)
      );
    });
  }

  const handleMainMutations = (records) => {
    // 流式回答会持续修改正文文本；只有 Composer trigger 或菜单 portal 相关变化才需要重新标记。
    if (document.visibilityState === "hidden" || !mutationsTouchComposer(records)) return;
    scheduleSync();
  };
  let disposeMainObservation = null;
  function startComposerObservation() {
    if (disposeMainObservation || document.visibilityState === "hidden") return;
    disposeMainObservation = adapterHost.dom.observe({
      key: {},
      root: document.documentElement,
      options: MAIN_OBSERVER_OPTIONS,
      callback: handleMainMutations,
    });
  }

  function stopComposerObservation() {
    disposeMainObservation?.();
    disposeMainObservation = null;
    // trigger 内的文字观察同样只服务可见 UI，后台不保留任何 DOM observer。
    stopTriggerTextObservation();
  }

  adapterHost.events.observe({ key: {}, target: document, type: "visibilitychange", callback: () => {
    if (document.visibilityState === "hidden") {
      stopComposerObservation();
      return;
    }
    startComposerObservation();
    scheduleSync();
  } });
  startComposerObservation();
  scheduleSync();
  // observer 安装完成才代表 Composer 适配器已注入；回执请求保持旁路，不参与 DOM 同步。
  void w.__OpenCodexSmartSchedulingInjectionHealth?.report("composer-adapter");

  w.__OpenCodexSmartModelRouterComposer = Object.freeze({
    get autoSelected() {
      // 供同一标签页内的展示模块判断分类阶段；真实路由结果仍以后端通知为准。
      return isAutoSelected();
    },
    sync: syncComposer,
  });
})();
