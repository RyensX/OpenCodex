(function () {
  const w = window;
  const pluginSystem = w.OpenCodexPluginSystem || w.__OpenCodexPluginSystem;
  if (!pluginSystem || typeof pluginSystem.registerPlugin !== "function") return;

  const ROOT_DATA_ATTR = "opencodexIosFix";
  const KEYBOARD_DATA_ATTR = "opencodexIosKeyboardVisible";
  const STANDALONE_DATA_ATTR = "opencodexIosStandalone";
  const APP_SHELL_DATA_ATTR = "opencodexIosAppShell";
  const EDITABLE_SELECTOR = ".ProseMirror,[contenteditable='true'],textarea,input";
  const KEYBOARD_OPENING_GUARD_MS = 900;
  const KEYBOARD_VISIBLE_THRESHOLD_PX = 80;
  const APP_SHELL_MARKER_SELECTOR =
    ".app-shell-main-content-viewport,.thread-scroll-container,[data-thread-find-composer='true']";
  const THREAD_SCROLL_SELECTOR = ".thread-scroll-container";
  const THREAD_FOOTER_SELECTOR = "[data-thread-scroll-footer='true']";
  const COMPOSER_SELECTOR = "[data-thread-find-composer='true']";
  const DEBUG_GLOBAL = "__opencodexIosFixDebug";
  const SETTLE_DELAYS_MS = [80, 260, 600];

  function isIOSWebKitDevice() {
    const nav = w.navigator || {};
    const ua = String(nav.userAgent || "");
    const platform = String(nav.platform || "");
    const touchPoints = Number(nav.maxTouchPoints || 0);
    // iPadOS 桌面 UA 会伪装成 MacIntel，需要结合触控点数识别。
    const isAppleTouchDevice = /iP(?:hone|ad|od)/i.test(ua) || (platform === "MacIntel" && touchPoints > 1);
    return isAppleTouchDevice && /WebKit/i.test(ua) && !/Android/i.test(ua);
  }

  function isStandaloneDisplayMode() {
    // 普通 Safari 标签页无法由网页隐藏底部地址栏；添加到主屏幕后才会进入 standalone。
    return !!w.navigator?.standalone || w.matchMedia?.("(display-mode: standalone)")?.matches === true;
  }

  function isElement(node) {
    return !!node && node.nodeType === 1;
  }

  function deepActiveElement() {
    let active = document.activeElement;
    // 官方输入框如果后续放进 shadow root，这里继续向内找到真正焦点节点。
    while (active && active.shadowRoot && active.shadowRoot.activeElement) {
      active = active.shadowRoot.activeElement;
    }
    return active;
  }

  function activeEditableElement() {
    const active = deepActiveElement();
    if (!active || active.nodeType !== 1 || typeof active.matches !== "function") return null;
    if (active.matches(EDITABLE_SELECTOR)) return active;
    return typeof active.closest === "function" ? active.closest(EDITABLE_SELECTOR) : null;
  }

  function cssPixel(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return "0px";
    return `${Math.round(number * 100) / 100}px`;
  }

  function roundedNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.round(number * 100) / 100 : null;
  }

  pluginSystem.registerPlugin({
    id: "opencodex.ios-fix",
    name: "iOS fix",
    labelKey: "plugin.iosFix.label",
    label: "iOS兼容修复",
    descKey: "plugin.iosFix.desc",
    desc: "修复iOS下视口高度、底部遮挡和软键盘重复避让等兼容问题。",
    // v2 避免旧版 defaultEnabled=false 写入的 iosCompatibilityFix:false 持续覆盖 iOS 默认开启。
    enableStorageKey: "iosCompatibilityFix.v2",
    defaultEnabled: isIOSWebKitDevice(),
    builtin: true,
    order: 15,
    activate(context) {
      if (
        context.scope !== "renderer" ||
        !document ||
        !isIOSWebKitDevice() ||
        document.__opencodexIosFixInstalled
      ) {
        return null;
      }
      document.__opencodexIosFixInstalled = true;

      let animationFrame = 0;
      let keyboardOpeningUntilMs = 0;
      let mutationObserver = null;
      let mutationSettleTimer = 0;
      let markedAppShell = null;
      let largestObservedLayoutHeight = 0;
      let lastDebugState = null;
      let previousKeyboardVisible = false;
      let wasAtBottomBeforeFocus = false;
      let userHasScrolled = false;
      const settleTimers = new Set();

      const isEnabled = () => context.plugin.isEnabled();
      const isActive = () => isEnabled() && isIOSWebKitDevice();
      const rootElement = () => document.getElementById("root");
      const threadScrollElement = () => document.querySelector(THREAD_SCROLL_SELECTOR);
      const threadFooterElement = () => document.querySelector(THREAD_FOOTER_SELECTOR);
      const composerElement = () => document.querySelector(COMPOSER_SELECTOR);

      const findAppShellElement = () => {
        const rootNode = rootElement();
        if (!rootNode) return null;
        const marker = rootNode.querySelector(APP_SHELL_MARKER_SELECTOR);
        if (!marker) return rootNode.firstElementChild || rootNode;

        let node = marker;
        // 官方 app shell 是 #root 下第一层全屏容器；从稳定内容节点向上找，避免依赖哈希 class。
        while (node.parentElement && node.parentElement !== rootNode) {
          node = node.parentElement;
        }
        return isElement(node) ? node : rootNode.firstElementChild || rootNode;
      };

      const clearAppShellMark = () => {
        if (isElement(markedAppShell)) delete markedAppShell.dataset[APP_SHELL_DATA_ATTR];
        markedAppShell = null;
      };

      const syncAppShellMark = (enabled) => {
        if (!enabled) {
          clearAppShellMark();
          return null;
        }

        const next = findAppShellElement();
        if (markedAppShell && markedAppShell !== next) clearAppShellMark();
        if (isElement(next)) {
          next.dataset[APP_SHELL_DATA_ATTR] = "true";
          markedAppShell = next;
        }
        return markedAppShell;
      };

      const resetDocumentScroll = () => {
        const scrollingElement = document.scrollingElement || document.documentElement;
        // iOS 聚焦输入框时会滚动 document；应用实际滚动应留给内部 thread 容器。
        try {
          w.scrollTo(0, 0);
        } catch {}
        if (scrollingElement) scrollingElement.scrollTop = 0;
        document.documentElement.scrollTop = 0;
        if (document.body) document.body.scrollTop = 0;
      };

      const threadScrollIsAtBottom = () => {
        const scroller = threadScrollElement();
        if (!isElement(scroller)) return false;
        // 官方 thread 使用 flex-col-reverse，底部位置的 scrollTop 接近 0。
        return Math.abs(Number(scroller.scrollTop || 0)) <= 2;
      };

      const settleThreadScroll = () => {
        const scroller = threadScrollElement();
        if (!isElement(scroller) || !activeEditableElement()) return false;
        // 官方 thread 使用 flex-col-reverse，scrollTop=0 才是贴底。
        try {
          scroller.scrollTo({ top: 0, behavior: "auto" });
        } catch {
          try {
            scroller.scrollTo(0, 0);
          } catch {}
        }
        scroller.scrollTop = 0;
        return true;
      };

      const elementDebug = (element) => {
        if (!isElement(element)) return null;
        const rect = element.getBoundingClientRect();
        const computed = w.getComputedStyle ? w.getComputedStyle(element) : null;
        return {
          tagName: element.tagName,
          id: element.id || "",
          className: String(element.getAttribute("class") || ""),
          rect: {
            top: roundedNumber(rect.top),
            bottom: roundedNumber(rect.bottom),
            height: roundedNumber(rect.height),
            width: roundedNumber(rect.width),
          },
          style: {
            bottom: computed?.bottom || "",
            height: computed?.height || "",
            maxHeight: computed?.maxHeight || "",
            minHeight: computed?.minHeight || "",
            overflowX: computed?.overflowX || "",
            overflowY: computed?.overflowY || "",
            position: computed?.position || "",
            transform: computed?.transform || "",
            width: computed?.width || "",
          },
          scroll: {
            clientHeight: roundedNumber(element.clientHeight),
            clientWidth: roundedNumber(element.clientWidth),
            scrollHeight: roundedNumber(element.scrollHeight),
            scrollLeft: roundedNumber(element.scrollLeft),
            scrollTop: roundedNumber(element.scrollTop),
            scrollWidth: roundedNumber(element.scrollWidth),
          },
        };
      };

      const debugSnapshot = () => {
        const root = document.documentElement;
        const viewport = w.visualViewport;
        const visualHeight = Number(viewport?.height || w.innerHeight || root.clientHeight || 0);
        const offsetTop = Number(viewport?.offsetTop || 0);
        const visualBottom = visualHeight + offsetTop;
        const rootNode = rootElement();
        const appShell = markedAppShell || findAppShellElement();
        const gapToVisualBottom = (element) => {
          if (!isElement(element)) return null;
          return roundedNumber(visualBottom - element.getBoundingClientRect().bottom);
        };

        return {
          active: isActive(),
          enabled: isEnabled(),
          iosWebKit: isIOSWebKitDevice(),
          rootDataset: {
            viewportFix: root.dataset[ROOT_DATA_ATTR] || "",
            keyboardVisible: root.dataset[KEYBOARD_DATA_ATTR] || "",
            standalone: root.dataset[STANDALONE_DATA_ATTR] || "",
            mobileKeyboardOptimization: root.dataset.opencodexMobileKeyboardOptimization || "",
            iosKeyboardOptimization: root.dataset.opencodexIosKeyboardOptimization || "",
          },
          visualViewport: viewport
            ? {
                bottom: roundedNumber(visualBottom),
                height: roundedNumber(viewport.height),
                offsetTop: roundedNumber(viewport.offsetTop),
                pageTop: roundedNumber(viewport.pageTop),
                scale: roundedNumber(viewport.scale),
                width: roundedNumber(viewport.width),
              }
            : null,
          window: {
            innerHeight: roundedNumber(w.innerHeight),
            innerWidth: roundedNumber(w.innerWidth),
            scrollY: roundedNumber(w.scrollY),
          },
          document: {
            bodyClientHeight: roundedNumber(document.body?.clientHeight),
            bodyScrollTop: roundedNumber(document.body?.scrollTop),
            clientHeight: roundedNumber(root.clientHeight),
            scrollTop: roundedNumber(root.scrollTop),
          },
          cssVars: {
            appHeight: root.style.getPropertyValue("--opencodex-ios-visual-viewport-height").trim(),
            keyboardInset: root.style.getPropertyValue("--opencodex-ios-keyboard-inset-bottom").trim(),
          },
          lastState: lastDebugState,
          appShell: elementDebug(appShell),
          threadScroller: elementDebug(threadScrollElement()),
          threadFooter: elementDebug(threadFooterElement()),
          composer: elementDebug(composerElement()),
          activeEditable: elementDebug(activeEditableElement()),
          derived: {
            gapToVisualViewportBottom: {
              root: gapToVisualBottom(rootNode),
              appShell: gapToVisualBottom(appShell),
              threadScroller: gapToVisualBottom(threadScrollElement()),
              threadFooter: gapToVisualBottom(threadFooterElement()),
              composer: gapToVisualBottom(composerElement()),
              activeEditable: gapToVisualBottom(activeEditableElement()),
            },
          },
        };
      };

      // 保留控制台快照入口；不显示覆盖层，避免诊断 UI 自身影响布局。
      w[DEBUG_GLOBAL] = debugSnapshot;

      const style = document.createElement("style");
      style.id = "opencodex-ios-fix-styles";
      style.textContent = `
        @media (max-width: 820px), (pointer: coarse) {
          html[data-opencodex-ios-fix="true"] {
            --opencodex-ios-app-height: var(--opencodex-ios-visual-viewport-height, 100svh);
            --opencodex-ios-footer-padding-bottom: max(env(safe-area-inset-bottom, 0px), 8px);
            --thread-floating-content-bottom-inset: 0px !important;
            box-sizing: border-box !important;
            width: 100vw !important;
            max-width: 100vw !important;
            /* html 保留完整布局视口，不能用可视高度裁剪带 offsetTop 的应用壳。 */
            height: 100% !important;
            min-height: 100% !important;
            max-height: none !important;
            overflow: hidden !important;
            overflow-x: hidden !important;
            overscroll-behavior: none !important;
          }

          html[data-opencodex-ios-fix="true"][data-opencodex-ios-keyboard-visible="true"] {
            --opencodex-ios-footer-padding-bottom: 0px;
          }

          html[data-opencodex-ios-fix="true"] body {
            /* body/#root 只提供完整祖先空间，可视几何统一交给最外层 app shell。 */
            position: static !important;
            box-sizing: border-box !important;
            width: 100% !important;
            max-width: 100vw !important;
            height: 100% !important;
            min-height: 0 !important;
            max-height: none !important;
            overflow: hidden !important;
            overflow-x: hidden !important;
            overscroll-behavior: none !important;
          }

          html[data-opencodex-ios-fix="true"] #root {
            box-sizing: border-box !important;
            position: relative !important;
            width: 100% !important;
            max-width: 100vw !important;
            height: 100% !important;
            min-height: 0 !important;
            max-height: none !important;
            overflow: hidden !important;
            overflow-x: hidden !important;
          }

          html[data-opencodex-ios-fix="true"] [data-opencodex-ios-app-shell="true"] {
            /* 只有 app shell 同时消费 visualViewport 的顶部偏移和可视高度。 */
            box-sizing: border-box !important;
            position: fixed !important;
            top: var(--opencodex-ios-visual-viewport-offset-top, 0px) !important;
            right: 0 !important;
            bottom: auto !important;
            left: 0 !important;
            width: 100% !important;
            max-width: 100vw !important;
            height: var(--opencodex-ios-app-height) !important;
            min-height: var(--opencodex-ios-app-height) !important;
            max-height: var(--opencodex-ios-app-height) !important;
            overflow: hidden !important;
            overflow-x: hidden !important;
          }

          html[data-opencodex-ios-fix="true"] .h-screen,
          html[data-opencodex-ios-fix="true"] .h-dvh,
          html[data-opencodex-ios-fix="true"] .h-\\[100dvh\\] {
            height: var(--opencodex-ios-app-height) !important;
          }

          html[data-opencodex-ios-fix="true"] .min-h-screen {
            min-height: var(--opencodex-ios-app-height) !important;
          }

          html[data-opencodex-ios-fix="true"] .main-surface,
          html[data-opencodex-ios-fix="true"] .app-shell-main-content-viewport,
          html[data-opencodex-ios-fix="true"] .app-shell-main-content-frame,
          html[data-opencodex-ios-fix="true"] .thread-scroll-container {
            box-sizing: border-box !important;
            min-height: 0 !important;
            min-width: 0 !important;
            max-width: 100vw !important;
            overflow-x: hidden !important;
          }

          html[data-opencodex-ios-fix="true"] .app-shell-main-content-viewport.app-shell-main-content-viewport,
          html[data-opencodex-ios-fix="true"][data-opencodex-ios-keyboard-optimization="true"] .app-shell-main-content-viewport {
            /* 移动键盘插件会额外给 floating footer 留 inset；iOS 修复插件只保留 visualViewport 收缩。 */
            --thread-floating-content-bottom-inset: 0px !important;
          }

          html[data-opencodex-ios-fix="true"] .thread-scroll-container {
            height: 100% !important;
            max-height: 100% !important;
            overflow-y: auto !important;
            touch-action: pan-y;
            overscroll-behavior: contain !important;
            scroll-padding-bottom: 0px !important;
            -webkit-overflow-scrolling: touch;
          }

          html[data-opencodex-ios-fix="true"] [data-thread-scroll-footer="true"] {
            bottom: 0 !important;
            margin-bottom: 0 !important;
            padding-bottom: var(--opencodex-ios-footer-padding-bottom) !important;
          }

          html[data-opencodex-ios-fix="true"][data-opencodex-ios-keyboard-visible="true"] [data-thread-scroll-footer="true"],
          html[data-opencodex-ios-fix="true"] [data-thread-scroll-footer="true"]:focus-within {
            /* 键盘态不能叠加 footer padding，否则会在键盘上方留下额外 DOM 空白。 */
            padding-bottom: 0 !important;
            margin-bottom: 0 !important;
          }

          html[data-opencodex-ios-fix="true"] [data-thread-find-composer="true"][data-thread-find-composer="true"],
          html[data-opencodex-ios-fix="true"][data-opencodex-ios-keyboard-optimization="true"] [data-thread-find-composer="true"] {
            /* 禁用移动键盘插件的 translate 避让，避免和 visualViewport 收缩重复计算。 */
            transform: translate3d(0, 0, 0) !important;
            will-change: auto !important;
          }
        }
      `;
      (document.head || document.documentElement).appendChild(style);

      const clearViewportState = () => {
        const root = document.documentElement;
        delete root.dataset[ROOT_DATA_ATTR];
        delete root.dataset[KEYBOARD_DATA_ATTR];
        delete root.dataset[STANDALONE_DATA_ATTR];
        root.style.removeProperty("--opencodex-ios-visual-viewport-height");
        root.style.removeProperty("--opencodex-ios-visual-viewport-offset-top");
        root.style.removeProperty("--opencodex-ios-keyboard-inset-bottom");
        clearAppShellMark();
        lastDebugState = null;
        previousKeyboardVisible = false;
      };

      const viewportMetrics = () => {
        const root = document.documentElement;
        const viewport = w.visualViewport;
        const visualHeight = Number(viewport?.height || w.innerHeight || root.clientHeight || 0);
        const offsetTop = Number(viewport?.offsetTop || 0);
        const visualBottom = visualHeight + offsetTop;
        const rawLayoutHeight = Math.max(
          Number(w.innerHeight || 0),
          Number(root.clientHeight || 0),
          Number(document.body?.clientHeight || 0),
          visualHeight
        );
        const editable = activeEditableElement();

        if (!editable || rawLayoutHeight > largestObservedLayoutHeight) {
          largestObservedLayoutHeight = Math.max(largestObservedLayoutHeight, rawLayoutHeight);
        }

        const stableLayoutHeight = Math.max(largestObservedLayoutHeight, rawLayoutHeight, visualHeight);
        // 只在真实编辑区聚焦时进入 keyboard-visible，避免底部地址栏被误判成键盘。
        const keyboardInset = editable
          ? Math.max(0, stableLayoutHeight - visualBottom, stableLayoutHeight - visualHeight)
          : 0;
        const keyboardOpening = Date.now() < keyboardOpeningUntilMs;
        const keyboardVisible =
          !!editable &&
          (keyboardOpening || keyboardInset > KEYBOARD_VISIBLE_THRESHOLD_PX || stableLayoutHeight - visualHeight > KEYBOARD_VISIBLE_THRESHOLD_PX);

        return {
          editable,
          keyboardInset,
          keyboardOpening,
          keyboardVisible,
          offsetTop,
          rawLayoutHeight,
          stableLayoutHeight,
          visualBottom,
          visualHeight,
        };
      };

      const updateViewportState = () => {
        const root = document.documentElement;
        if (!isActive()) {
          clearViewportState();
          return;
        }

        const metrics = viewportMetrics();
        root.dataset[ROOT_DATA_ATTR] = "true";
        root.dataset[KEYBOARD_DATA_ATTR] = metrics.keyboardVisible ? "true" : "false";
        root.dataset[STANDALONE_DATA_ATTR] = isStandaloneDisplayMode() ? "true" : "false";
        root.style.setProperty("--opencodex-ios-visual-viewport-height", cssPixel(metrics.visualHeight));
        root.style.setProperty("--opencodex-ios-visual-viewport-offset-top", cssPixel(metrics.offsetTop));
        root.style.setProperty("--opencodex-ios-keyboard-inset-bottom", cssPixel(metrics.keyboardInset));
        syncAppShellMark(true);

        const keyboardJustOpened = metrics.keyboardVisible && !previousKeyboardVisible;

        lastDebugState = {
          keyboardInset: roundedNumber(metrics.keyboardInset),
          keyboardOpening: metrics.keyboardOpening,
          keyboardVisible: metrics.keyboardVisible,
          offsetTop: roundedNumber(metrics.offsetTop),
          rawLayoutHeight: roundedNumber(metrics.rawLayoutHeight),
          stableLayoutHeight: roundedNumber(metrics.stableLayoutHeight),
          visualBottom: roundedNumber(metrics.visualBottom),
          visualHeight: roundedNumber(metrics.visualHeight),
        };

        if (metrics.editable) {
          resetDocumentScroll();
        }
        if (keyboardJustOpened && wasAtBottomBeforeFocus && !userHasScrolled) {
          // 只在键盘首次打开且用户原本贴底时校准一次，流式 DOM 更新不得覆盖用户上滚意图。
          settleThreadScroll();
        }
        previousKeyboardVisible = metrics.keyboardVisible;
      };

      const clearSettleTimers = () => {
        for (const timer of settleTimers) w.clearTimeout(timer);
        settleTimers.clear();
      };

      const scheduleViewportUpdate = () => {
        updateViewportState();
        if (animationFrame) w.cancelAnimationFrame?.(animationFrame);
        animationFrame = w.requestAnimationFrame
          ? w.requestAnimationFrame(() => {
              animationFrame = 0;
              updateViewportState();
            })
          : 0;

        clearSettleTimers();
        for (const delay of SETTLE_DELAYS_MS) {
          // iOS 地址栏/键盘动画结束后还会补发 visualViewport 尺寸，分段校准更稳。
          const timer = w.setTimeout(() => {
            settleTimers.delete(timer);
            updateViewportState();
          }, delay);
          settleTimers.add(timer);
        }
      };

      const observeAppTree = () => {
        if (mutationObserver || !document.body || typeof w.MutationObserver !== "function") return;
        mutationObserver = new w.MutationObserver(() => {
          // app shell 稳定挂载后忽略流式消息的子树变化，避免每个 token 都触发布局测量。
          if (isElement(markedAppShell) && markedAppShell !== rootElement() && markedAppShell.isConnected) return;
          if (mutationSettleTimer) w.clearTimeout(mutationSettleTimer);
          // DOM 变化只重新定位 app shell，不能在流式输出期间改变任何滚动位置。
          mutationSettleTimer = w.setTimeout(() => syncAppShellMark(isActive()), 50);
        });
        mutationObserver.observe(document.body, {
          childList: true,
          subtree: true,
        });
      };

      const handleFocusIn = () => {
        if (activeEditableElement()) {
          wasAtBottomBeforeFocus = threadScrollIsAtBottom();
          userHasScrolled = false;
          // 键盘动画开始前先进入 keyboard-visible 状态，避免 iOS 自动滚动留下旧布局空白。
          keyboardOpeningUntilMs = Date.now() + KEYBOARD_OPENING_GUARD_MS;
        }
        scheduleViewportUpdate();
      };

      const handleFocusOut = () => {
        keyboardOpeningUntilMs = 0;
        scheduleViewportUpdate();
      };

      const handleThreadScrollIntent = (event) => {
        if (!isActive() || !activeEditableElement()) return;
        const scroller = threadScrollElement();
        const target = event?.target;
        if (!isElement(scroller) || !target || (target !== scroller && !scroller.contains(target))) return;
        if (isElement(target) && target.closest(`${EDITABLE_SELECTOR},${COMPOSER_SELECTOR}`)) return;
        // 手势一旦落在消息区，就停止本次聚焦周期的自动贴底。
        userHasScrolled = true;
      };

      const handleThreadScroll = (event) => {
        if (event?.isTrusted && event.target === threadScrollElement() && activeEditableElement()) {
          userHasScrolled = true;
        }
      };

      const disposePreference = context.events.on("plugin:enabled-changed", (payload) => {
        if (payload && payload.id === context.plugin.id) scheduleViewportUpdate();
      });

      scheduleViewportUpdate();
      observeAppTree();
      w.addEventListener("resize", scheduleViewportUpdate, { passive: true });
      w.addEventListener("orientationchange", scheduleViewportUpdate, { passive: true });
      w.visualViewport?.addEventListener("resize", scheduleViewportUpdate, { passive: true });
      w.visualViewport?.addEventListener("scroll", scheduleViewportUpdate, { passive: true });
      document.addEventListener("focusin", handleFocusIn, true);
      document.addEventListener("focusout", handleFocusOut, true);
      document.addEventListener("touchstart", handleThreadScrollIntent, { capture: true, passive: true });
      document.addEventListener("wheel", handleThreadScrollIntent, { capture: true, passive: true });
      document.addEventListener("scroll", handleThreadScroll, true);

      return () => {
        disposePreference();
        if (animationFrame) w.cancelAnimationFrame?.(animationFrame);
        clearSettleTimers();
        if (mutationSettleTimer) w.clearTimeout(mutationSettleTimer);
        if (mutationObserver) mutationObserver.disconnect();
        w.removeEventListener("resize", scheduleViewportUpdate, { passive: true });
        w.removeEventListener("orientationchange", scheduleViewportUpdate, { passive: true });
        w.visualViewport?.removeEventListener("resize", scheduleViewportUpdate, { passive: true });
        w.visualViewport?.removeEventListener("scroll", scheduleViewportUpdate, { passive: true });
        document.removeEventListener("focusin", handleFocusIn, true);
        document.removeEventListener("focusout", handleFocusOut, true);
        document.removeEventListener("touchstart", handleThreadScrollIntent, { capture: true, passive: true });
        document.removeEventListener("wheel", handleThreadScrollIntent, { capture: true, passive: true });
        document.removeEventListener("scroll", handleThreadScroll, true);
        if (style.parentNode) style.parentNode.removeChild(style);
        if (w[DEBUG_GLOBAL] === debugSnapshot) delete w[DEBUG_GLOBAL];
        clearViewportState();
        document.__opencodexIosFixInstalled = false;
      };
    },
  });
})();
