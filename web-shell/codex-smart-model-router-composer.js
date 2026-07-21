(function () {
  const w = window;
  if (w.__OpenCodexSmartModelRouterComposerInstalled) return;
  w.__OpenCodexSmartModelRouterComposerInstalled = true;

  const TRIGGER_SELECTOR = '[data-codex-intelligence-trigger="true"]';
  const MODEL_TEXT_SELECTOR = '[class*="_ModelPickerTriggerModelText_"]';
  const EFFORT_TEXT_SELECTOR = '[class*="_ModelPickerTriggerEffortLabel_"]';
  const AUTO_MODEL = "auto";
  let syncScheduled = false;

  function visibleNode(root, selector) {
    return Array.from(root.querySelectorAll(selector)).find((node) => !node.closest('[aria-hidden="true"]')) || null;
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
    const activeMenus = new Set();
    const activeEffortItems = new Set();

    for (const trigger of document.querySelectorAll(TRIGGER_SELECTOR)) {
      const modelText = visibleNode(trigger, MODEL_TEXT_SELECTOR)?.textContent?.trim() || "";
      const isAuto = modelText.toLowerCase() === AUTO_MODEL;
      if (isAuto) trigger.dataset.opencodexAutoModel = "true";
      else trigger.removeAttribute("data-opencodex-auto-model");
      if (!isAuto) continue;

      const menu = linkedMenu(trigger);
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
  }

  function scheduleSync() {
    if (syncScheduled) return;
    syncScheduled = true;
    requestAnimationFrame(syncComposer);
  }

  const observer = new MutationObserver(scheduleSync);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["aria-controls", "data-selected-reasoning-effort"],
    characterData: true,
    childList: true,
    subtree: true,
  });
  scheduleSync();

  w.__OpenCodexSmartModelRouterComposer = Object.freeze({ sync: syncComposer });
})();
