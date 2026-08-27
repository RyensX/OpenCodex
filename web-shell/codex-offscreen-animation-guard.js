(function () {
  const w = window;
  if (w.__opencodexOffscreenAnimationGuardInstalled) return;
  w.__opencodexOffscreenAnimationGuardInstalled = true;

  const REGION_CONFIGS = [
    {
      rootSelector: "[data-app-action-sidebar-scroll]",
      targetSelector: ".animate-spin",
    },
    {
      rootSelector: "main[data-app-shell-main-surface]",
      targetSelector: ".horizontal-scroll-fade-mask",
    },
  ];
  let discoveryObserver = null;
  let discoveryFrame = null;

  function createRegionGuard({ rootSelector, targetSelector }) {
    const originalPlayStates = new WeakMap();
    const observedTargets = new Set();
    const rootLifecycleObservers = [];
    let mutationObserver = null;
    let visibilityObserver = null;
    let visibilityFrame = null;
    let root = null;

    function restorePlayState(target) {
      const original = originalPlayStates.get(target);
      if (!original) return;
      if (original.value) {
        target.style.setProperty("animation-play-state", original.value, original.priority);
      } else {
        target.style.removeProperty("animation-play-state");
      }
    }

    function observeTarget(target) {
      if (!target || target.nodeType !== 1 || observedTargets.has(target)) return;
      observedTargets.add(target);
      originalPlayStates.set(target, {
        priority: target.style.getPropertyPriority?.("animation-play-state") || "",
        value: target.style.getPropertyValue("animation-play-state"),
      });
      // 先同步暂停，IntersectionObserver 下一帧确认可见后再恢复，避免离屏动画抢跑一帧。
      target.style.setProperty("animation-play-state", "paused", "important");
      visibilityObserver.observe(target);
    }

    function forgetTarget(target) {
      if (!observedTargets.delete(target)) return;
      visibilityObserver?.unobserve?.(target);
      // React 可能复用刚移除的 DOM；先恢复原样，重新挂载时才能重新采集正确状态。
      restorePlayState(target);
    }

    function forgetRemovedNode(node) {
      if (!node || node.nodeType !== 1) return;
      if (node.matches?.(targetSelector)) forgetTarget(node);
      for (const target of node.querySelectorAll?.(targetSelector) || []) forgetTarget(target);
    }

    function scanAddedNode(node) {
      if (!node || node.nodeType !== 1) return;
      if (node.matches?.(targetSelector)) observeTarget(node);
      for (const target of node.querySelectorAll?.(targetSelector) || []) observeTarget(target);
    }

    function syncVisibility() {
      visibilityFrame = null;
      if (!root) return;
      const rootRect = root.getBoundingClientRect();
      for (const target of observedTargets) {
        if (target.isConnected === false) {
          forgetTarget(target);
          continue;
        }
        const rect = target.getBoundingClientRect();
        const visible =
          rect.bottom > rootRect.top &&
          rect.top < rootRect.bottom &&
          rect.right > rootRect.left &&
          rect.left < rootRect.right;
        if (visible) restorePlayState(target);
        else target.style.setProperty("animation-play-state", "paused", "important");
      }
    }

    function scheduleVisibilitySync() {
      if (visibilityFrame !== null) return;
      if (typeof w.requestAnimationFrame !== "function") {
        syncVisibility();
        return;
      }
      // 用户滚动和 React 批量提交都折叠到同一帧，每个动画目标最多读取一次几何信息。
      visibilityFrame = w.requestAnimationFrame(syncVisibility);
    }

    function teardown() {
      if (visibilityFrame !== null) w.cancelAnimationFrame?.(visibilityFrame);
      visibilityFrame = null;
      root?.removeEventListener?.("scroll", scheduleVisibilitySync);
      mutationObserver?.disconnect();
      visibilityObserver?.disconnect?.();
      for (const observer of rootLifecycleObservers) observer.disconnect();
      rootLifecycleObservers.length = 0;
      mutationObserver = null;
      visibilityObserver = null;
      // 容器被重建时恢复旧节点原有样式并释放强引用，避免多次切换会话后积累 detached DOM。
      for (const target of observedTargets) restorePlayState(target);
      observedTargets.clear();
      root = null;
    }

    function observeRootLifecycle(nextRoot) {
      if (typeof w.MutationObserver !== "function") return;
      let ancestor = nextRoot.parentNode;
      // 只观察祖先的直接子节点，不监听其整棵子树；任一层被 React 替换时再统一重查两个根。
      while (ancestor && ancestor !== document) {
        const observer = new w.MutationObserver(scheduleRootDiscovery);
        observer.observe(ancestor, { childList: true });
        rootLifecycleObservers.push(observer);
        ancestor = ancestor.parentNode;
      }
    }

    function install(nextRoot) {
      if (!nextRoot || nextRoot === root || typeof w.IntersectionObserver !== "function") return false;
      teardown();
      root = nextRoot;
      w.OpenCodexRuntimeCompatibility?.active?.("web.runtime.dom.offscreen-animation");
      const observer = new w.IntersectionObserver(
        (entries) => {
          // disconnect 后可能仍有排队回调；旧 observer 不得改写新容器里的节点。
          if (observer !== visibilityObserver) return;
          for (const entry of entries) {
            if (entry.target.isConnected === false) {
              forgetTarget(entry.target);
              continue;
            }
            if (entry.isIntersecting) restorePlayState(entry.target);
            else entry.target.style.setProperty("animation-play-state", "paused", "important");
          }
        },
        { root: nextRoot }
      );
      visibilityObserver = observer;
      scanAddedNode(nextRoot);

      if (typeof w.MutationObserver === "function") {
        // 只观察目标区域新增/移除节点，不监听属性与文本变化，避免动画样式本身形成反馈循环。
        mutationObserver = new w.MutationObserver((records) => {
          for (const record of records) {
            for (const node of record.removedNodes || []) forgetRemovedNode(node);
            for (const node of record.addedNodes || []) scanAddedNode(node);
          }
          scheduleVisibilitySync();
        });
        mutationObserver.observe(nextRoot, { childList: true, subtree: true });
      }
      nextRoot.addEventListener?.("scroll", scheduleVisibilitySync, { passive: true });
      observeRootLifecycle(nextRoot);
      scheduleVisibilitySync();
      return true;
    }

    function refreshRoot() {
      const nextRoot = document.querySelector(rootSelector);
      if (nextRoot === root) return;
      if (nextRoot) install(nextRoot);
      else teardown();
    }

    return {
      hasRoot: () => !!root,
      refreshRoot,
    };
  }

  const regionGuards = REGION_CONFIGS.map(createRegionGuard);

  function refreshRoots() {
    discoveryFrame = null;
    for (const guard of regionGuards) guard.refreshRoot();
    if (regionGuards.every((guard) => guard.hasRoot())) {
      discoveryObserver?.disconnect();
      discoveryObserver = null;
    } else {
      installDiscoveryObserver();
    }
  }

  function scheduleRootDiscovery() {
    if (discoveryFrame !== null) return;
    if (typeof w.requestAnimationFrame !== "function") {
      refreshRoots();
      return;
    }
    discoveryFrame = w.requestAnimationFrame(refreshRoots);
  }

  function installDiscoveryObserver() {
    if (discoveryObserver || typeof w.MutationObserver !== "function") return;
    // head 阶段两个区域尚未挂载；全部找到后立即关闭这条全页发现监听。
    discoveryObserver = new w.MutationObserver(scheduleRootDiscovery);
    discoveryObserver.observe(document.documentElement, { childList: true, subtree: true });
  }

  refreshRoots();
  if (regionGuards.some((guard) => guard.hasRoot())) {
    w.OpenCodexRuntimeCompatibility?.active?.("web.runtime.dom.offscreen-animation");
  }
  w.OpenCodexRuntimeCompatibility?.installed?.("web.runtime.dom.offscreen-animation");
})();
