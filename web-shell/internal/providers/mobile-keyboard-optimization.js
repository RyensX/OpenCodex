(function () {
  const w = window;
  const modificationScope = w.__OpenCodexCurrentProviderScope;
  const modificationEffects = modificationScope?.effects;
  const providerGeneration = modificationScope?.generation || document;
  const adapterHost = w.__OpenCodexAdapterHost;
  const scheduler = adapterHost?.scheduler?.capture?.() || w;
  const pluginSystem = w.OpenCodexPluginSystem || w.__OpenCodexPluginSystem;
  if (!pluginSystem || typeof pluginSystem.registerPlugin !== "function") return;
  const registerPlugin = adapterHost?.plugins?.register
    ? (plugin) => adapterHost.plugins.register(pluginSystem, plugin)
    : pluginSystem.registerPlugin.bind(pluginSystem);
  const sharedAdapterHost = adapterHost;

  const POST_SEND_FOCUS_BLOCK_MS = 4000;
  const MANUAL_FOCUS_MS = 900;

  function isComposerEditableElement(element) {
    return !!(
      element &&
      element.nodeType === 1 &&
      typeof element.matches === "function" &&
      element.matches(".ProseMirror,[contenteditable='true'],textarea,input")
    );
  }

  function scrollableAncestor(element) {
    for (let node = element?.parentElement; node && node !== document.body; node = node.parentElement) {
      const style = w.getComputedStyle ? w.getComputedStyle(node) : null;
      const overflowY = String(style?.overflowY || "");
      if (/(auto|scroll)/.test(overflowY) && node.scrollHeight > node.clientHeight) return node;
    }
    return null;
  }

  function isPromptSendInvoke(channel, payload) {
    if (channel === "turn:start" || channel === "start-conversation") return true;
    if (channel !== "codex_desktop:message-from-view") return false;
    if (!payload || typeof payload !== "object") return false;
    const request = payload.request && typeof payload.request === "object" ? payload.request : null;
    return !!request && request.method === "turn/start";
  }

  function isIOSWebKitDevice() {
    const nav = w.navigator || {};
    const ua = String(nav.userAgent || "");
    const platform = String(nav.platform || "");
    const touchPoints = Number(nav.maxTouchPoints || 0);
    // iPadOS 桌面 UA 会伪装成 MacIntel，只能结合触控点数识别。
    const isAppleTouchDevice = /iP(?:hone|ad|od)/i.test(ua) || (platform === "MacIntel" && touchPoints > 1);
    return isAppleTouchDevice && /WebKit/i.test(ua) && !/Android/i.test(ua);
  }

  function createViewportCoordinator() {
    const subscribers = new Set();
    const settleTimers = new Map();
    let animationFrame = 0;
    let listening = false;
    let pendingReason = "viewport";
    let lastSnapshot = null;
    let settleGeneration = 0;
    let eventDisposers = [];
    const diagnostics = { dispatches: 0, frameRequests: 0, metricReads: 0 };

    function readSnapshot() {
      diagnostics.metricReads += 1;
      const root = document.documentElement;
      const viewport = w.visualViewport;
      const visualHeight = Math.max(0, Number(viewport?.height || w.innerHeight || root.clientHeight || 0));
      const offsetTop = Math.max(0, Number(viewport?.offsetTop || 0));
      const layoutHeight = Math.max(0, Number(root.clientHeight || w.innerHeight || visualHeight));
      const innerHeight = Math.max(0, Number(w.innerHeight || layoutHeight || visualHeight));
      return Object.freeze({
        bodyHeight: Math.max(0, Number(document.body?.clientHeight || 0)),
        innerHeight,
        layoutHeight,
        offsetTop,
        visualBottom: visualHeight + offsetTop,
        visualHeight,
      });
    }

    function dispatch(reason) {
      if (document.visibilityState === "hidden") return;
      lastSnapshot = readSnapshot();
      diagnostics.dispatches += 1;
      for (const subscriber of Array.from(subscribers)) {
        try {
          subscriber(lastSnapshot, reason);
        } catch (error) {
          console.warn("[opencodex-viewport] subscriber failed", error);
        }
      }
    }

    function cancelScheduledFrame() {
      if (!animationFrame) return;
      if (typeof w.cancelAnimationFrame === "function") scheduler.cancelAnimationFrame(animationFrame);
      else scheduler.clearTimeout(animationFrame);
      animationFrame = 0;
    }

    function clearSettleTimers() {
      settleGeneration += 1;
      for (const timer of settleTimers.values()) scheduler.clearTimeout(timer);
      settleTimers.clear();
    }

    function scheduleSettleDispatches(reason, delays) {
      clearSettleTimers();
      if (delays.length === 0) return;
      const generation = settleGeneration;
      const [firstDelay, ...remainingDelays] = delays;
      const firstTimer = scheduler.setTimeout(() => {
        if (generation !== settleGeneration) return;
        settleTimers.delete(firstDelay);
        // 事件风暴安静到首个校准点后再展开余下时点，热路径始终只反复维护一个 timer。
        for (const delay of remainingDelays) {
          const timer = scheduler.setTimeout(() => {
            if (generation !== settleGeneration) return;
            settleTimers.delete(delay);
            dispatch(`${reason}:settle`);
          }, Math.max(0, delay - firstDelay));
          settleTimers.set(delay, timer);
        }
        dispatch(`${reason}:settle`);
      }, firstDelay);
      settleTimers.set(firstDelay, firstTimer);
    }

    function request(reason = "viewport", options = {}) {
      if (document.visibilityState === "hidden") {
        cancelScheduledFrame();
        clearSettleTimers();
        return;
      }
      const immediate = options.immediate === true;
      const delays = Array.from(new Set(options.settleDelays || []))
        .map(Number)
        .filter((delay) => Number.isFinite(delay) && delay >= 0)
        .sort((left, right) => left - right);
      // 同一帧内的 resize/scroll 风暴只保留一次前沿测量，帧尾再统一确认最终几何值。
      if (immediate && !animationFrame) dispatch(reason);
      pendingReason = reason;
      if (!animationFrame) {
        diagnostics.frameRequests += 1;
        const run = () => {
          animationFrame = 0;
          dispatch(pendingReason);
        };
        animationFrame =
          typeof w.requestAnimationFrame === "function" ? scheduler.requestAnimationFrame(run) : scheduler.setTimeout(run, 0);
      }
      if (delays.length > 0) {
        // 连续 visualViewport 事件只保留最后一组稳定期校准，避免每个事件累积多轮定时任务。
        scheduleSettleDispatches(reason, delays);
      }
    }

    const requestViewportTransition = () =>
      request("viewport", { immediate: true, settleDelays: [80, 240, 260, 600] });
    const requestOrientationTransition = () =>
      request("orientationchange", { immediate: true, settleDelays: [80, 240, 260, 600] });
    const requestFocusIn = () =>
      request("focusin", { immediate: true, settleDelays: [80, 240, 260, 600] });
    const requestFocusOut = () =>
      request("focusout", { immediate: true, settleDelays: [80, 240, 260, 600] });
    const requestInput = () => request("input");
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        request("visibility", { immediate: true, settleDelays: [80, 260] });
      } else {
        cancelScheduledFrame();
        clearSettleTimers();
      }
    };

    function startListening() {
      if (listening || !sharedAdapterHost?.events?.observe) return;
      listening = true;
      const observe = (target, type, callback, options = {}) => {
        if (!target) return;
        eventDisposers.push(sharedAdapterHost.events.observe({ key: {}, target, type, callback, ...options }));
      };
      observe(w, "resize", requestViewportTransition, { passive: true });
      // 单独保留旋转原因，订阅方可丢弃旧方向的稳定高度，避免把横竖屏差值误判成键盘。
      observe(w, "orientationchange", requestOrientationTransition, { passive: true });
      observe(w.visualViewport, "resize", requestViewportTransition, { passive: true });
      observe(w.visualViewport, "scroll", requestViewportTransition, { passive: true });
      observe(document, "focusin", requestFocusIn, { capture: true });
      observe(document, "focusout", requestFocusOut, { capture: true });
      observe(document, "input", requestInput, { capture: true });
      observe(document, "visibilitychange", handleVisibility);
    }

    function stopListening() {
      if (!listening) return;
      listening = false;
      for (const disposeEvent of eventDisposers.reverse()) disposeEvent();
      eventDisposers = [];
      cancelScheduledFrame();
      clearSettleTimers();
      // 无订阅期间屏幕仍可能旋转或被浏览器工具栏改变；再次启用时必须重新读取真实尺寸。
      lastSnapshot = null;
    }

    return Object.freeze({
      get diagnostics() {
        return { ...diagnostics, subscribers: subscribers.size };
      },
      request,
      snapshot() {
        return lastSnapshot || readSnapshot();
      },
      subscribe(subscriber) {
        if (typeof subscriber !== "function") return () => {};
        subscribers.add(subscriber);
        startListening();
        // 第二个移动插件直接复用第一份初始快照，避免激活阶段重复读取布局尺寸。
        lastSnapshot ||= readSnapshot();
        subscriber(lastSnapshot, "subscribe");
        return () => {
          subscribers.delete(subscriber);
          if (subscribers.size === 0) stopListening();
        };
      },
    });
  }

  // 两个移动插件共享同一个事件源和布局快照，避免 iOS 上重复读取 visualViewport 和根节点尺寸。
  if (w.__OpenCodexViewportCoordinatorGeneration !== providerGeneration) {
    w.__OpenCodexViewportCoordinator = createViewportCoordinator();
    w.__OpenCodexViewportCoordinatorGeneration = providerGeneration;
  }
  const viewportCoordinator = w.__OpenCodexViewportCoordinator;

  registerPlugin({
    id: "opencodex.mobile-keyboard-optimization",
    name: "Mobile keyboard optimization",
    labelKey: "plugin.mobileKeyboardOptimization.label",
    label: "移动端软键盘优化",
    descKey: "plugin.mobileKeyboardOptimization.desc",
    desc: "优化移动端输入框聚焦和视口高度，减少软键盘遮挡。",
    enableStorageKey: "mobileKeyboardOptimization",
    defaultEnabled: true,
    builtin: true,
    order: 10,
    activate(context) {
      if (
        context.scope !== "renderer" ||
        !document ||
        !context.platform.isMobile() ||
        document.__opencodexMobileKeyboardPluginInstalled ||
        !adapterHost?.events?.observe ||
        !adapterHost?.hooks?.around
      ) {
        // 桌面端没有软键盘，不安装 viewport/input 监听器，也不写入仅移动端消费的 CSS 变量。
        return null;
      }
      document.__opencodexMobileKeyboardPluginInstalled = true;

      let focusBlockedUntilMs = 0;
      let lastManualFocusIntentAtMs = 0;

      const isEnabled = () => context.plugin.isEnabled();
      const isMobile = () => !!context.platform.isMobile();

      const setDatasetValue = (root, key, value) => {
        if (root.dataset[key] !== value) root.dataset[key] = value;
      };

      const setStyleValue = (root, name, value) => {
        if (root.style.getPropertyValue(name) !== value) root.style.setProperty(name, value);
      };

      const style = document.createElement("style");
      style.id = "opencodex-mobile-keyboard-plugin-styles";
      style.textContent = `
        @media (max-width: 820px), (pointer: coarse) {
          html[data-opencodex-mobile-keyboard-optimization="true"]:not([data-opencodex-ios-keyboard-optimization="true"]),
          html[data-opencodex-mobile-keyboard-optimization="true"]:not([data-opencodex-ios-keyboard-optimization="true"]) body,
          html[data-opencodex-mobile-keyboard-optimization="true"]:not([data-opencodex-ios-keyboard-optimization="true"]) #root {
            height: var(--codex-visual-viewport-height, 100dvh) !important;
            min-height: var(--codex-visual-viewport-height, 100dvh) !important;
            max-height: var(--codex-visual-viewport-height, 100dvh) !important;
            overflow: hidden;
          }

          html[data-opencodex-mobile-keyboard-optimization="true"] body {
            width: 100%;
            touch-action: pan-x pan-y;
            overscroll-behavior: none;
          }

          html[data-opencodex-mobile-keyboard-optimization="true"] input,
          html[data-opencodex-mobile-keyboard-optimization="true"] textarea,
          html[data-opencodex-mobile-keyboard-optimization="true"] [contenteditable="true"],
          html[data-opencodex-mobile-keyboard-optimization="true"] .ProseMirror {
            font-size: max(16px, 1em) !important;
            scroll-margin-bottom: calc(var(--codex-keyboard-inset-bottom, 0px) + 96px);
          }

          html[data-opencodex-ios-keyboard-optimization="true"] {
            /* iOS 下同时避让 Safari 底栏/软键盘和 Home Indicator 安全区。 */
            --codex-ios-bottom-avoidance: max(var(--codex-keyboard-inset-bottom, 0px), env(safe-area-inset-bottom, 0px));
          }

          html[data-opencodex-ios-keyboard-optimization="true"] .app-shell-main-content-viewport {
            --thread-floating-content-bottom-inset: calc(var(--spacing, 4px) * 3 + var(--codex-ios-bottom-avoidance, 0px));
          }

          html[data-opencodex-ios-keyboard-optimization="true"] [data-thread-find-composer="true"] {
            transform: translate3d(0, calc(-1 * var(--codex-ios-bottom-avoidance, 0px)), 0);
          }
        }
      `;
      (document.head || document.documentElement).appendChild(style);

      const syncEnabledState = () => {
        const enabled = isEnabled();
        const root = document.documentElement;
        setDatasetValue(root, "opencodexMobileKeyboardOptimization", enabled ? "true" : "false");
        setDatasetValue(
          root,
          "opencodexIosKeyboardOptimization",
          enabled && isMobile() && isIOSWebKitDevice() ? "true" : "false"
        );
        if (!enabled) {
          root.style.removeProperty("--codex-visual-viewport-height");
          root.style.removeProperty("--codex-visual-viewport-offset-top");
          root.style.removeProperty("--codex-keyboard-inset-bottom");
        }
        return enabled;
      };

      const setViewportVars = (snapshot = viewportCoordinator.snapshot()) => {
        if (!syncEnabledState()) return;
        const height = Math.max(0, Math.floor(snapshot.visualHeight));
        const offsetTop = Math.max(0, Math.floor(snapshot.offsetTop));
        const layoutHeight = Math.max(0, Math.floor(snapshot.layoutHeight || height));
        const innerHeight = Math.max(0, Math.floor(snapshot.innerHeight || layoutHeight || height));
        const viewportBottom = Math.max(0, Math.floor(snapshot.visualBottom));
        // iOS Safari 的地址栏和软键盘不会稳定改写布局视口；用可视视口底部差值推导被遮挡高度。
        const keyboardInset = isIOSWebKitDevice()
          ? Math.max(0, layoutHeight - viewportBottom, innerHeight - viewportBottom)
          : Math.max(0, innerHeight - viewportBottom);
        const root = document.documentElement;
        if (height > 0) setStyleValue(root, "--codex-visual-viewport-height", `${height}px`);
        setStyleValue(root, "--codex-visual-viewport-offset-top", `${offsetTop}px`);
        setStyleValue(root, "--codex-keyboard-inset-bottom", `${keyboardInset}px`);
        modificationEffects?.primary?.emit();
      };

      const keepActiveInputVisible = (snapshot = viewportCoordinator.snapshot()) => {
        if (!isEnabled() || !isMobile()) return;
        const active = document.activeElement;
        if (!isComposerEditableElement(active)) return;
        const visibleTop = Math.max(0, snapshot.offsetTop || 0);
        const visibleBottom = Math.max(visibleTop, snapshot.visualBottom || 0);
        if (visibleBottom <= visibleTop) return;

        const rect = active.getBoundingClientRect();
        const bottomLimit = visibleBottom - 18;
        const topLimit = visibleTop + 8;
        let delta = 0;
        if (rect.bottom > bottomLimit) {
          delta = rect.bottom - bottomLimit;
        } else if (rect.top < topLimit) {
          delta = rect.top - topLimit;
        }
        if (Math.abs(delta) < 1) return;

        const scroller = scrollableAncestor(active);
        if (scroller) {
          scroller.scrollTop += delta;
          return;
        }
        try {
          w.scrollBy(0, delta);
        } catch {}
      };

      const scheduleViewportUpdate = () => {
        viewportCoordinator.request("mobile-plugin", { immediate: true, settleDelays: [80, 240] });
      };

      const disposeViewport = viewportCoordinator.subscribe((snapshot) => {
        setViewportVars(snapshot);
        keepActiveInputVisible(snapshot);
      });

      const preventZoomGesture = (event) => {
        if (!isEnabled() || !isMobile()) return;
        if (event.touches && event.touches.length < 2) return;
        event.preventDefault();
        modificationEffects?.primary?.emit();
      };

      const rememberManualFocusIntent = (event) => {
        const target = event && event.target;
        if (!target || typeof target.closest !== "function") return;
        if (target.closest(".ProseMirror,[contenteditable='true'],textarea,input")) {
          lastManualFocusIntentAtMs = Date.now();
        }
      };

      const shouldSuppressFocus = (element) => {
        if (!isEnabled() || !isMobile()) return false;
        const now = Date.now();
        if (now > focusBlockedUntilMs) return false;
        if (!isComposerEditableElement(element)) return false;
        return now - lastManualFocusIntentAtMs > MANUAL_FOCUS_MS;
      };

      const proto = w.HTMLElement && w.HTMLElement.prototype;
      const disposeFocusHook = proto && typeof proto.focus === "function"
        ? adapterHost.hooks.around({
            key: {},
            target: proto,
            property: "focus",
            handle(thisValue, args, proceed) {
              if (shouldSuppressFocus(thisValue)) {
                modificationEffects?.primary?.emit();
                return;
              }
              return proceed(args);
            },
          })
        : () => {};

      const disposePreference = context.events.on("plugin:enabled-changed", (payload) => {
        if (payload && payload.id === context.plugin.id) scheduleViewportUpdate();
      });
      const disposeIpcInvoke = context.events.on("ipc:invoke", (event) => {
        if (isEnabled() && isMobile() && isPromptSendInvoke(event?.channel, event?.payload)) {
          focusBlockedUntilMs = Date.now() + POST_SEND_FOCUS_BLOCK_MS;
        }
      });

      const eventDisposers = [
        adapterHost.events.observe({ key: {}, target: document, type: "touchmove", passive: false, callback: preventZoomGesture }),
        adapterHost.events.observe({ key: {}, target: document, type: "gesturestart", passive: false, callback: preventZoomGesture }),
        adapterHost.events.observe({ key: {}, target: document, type: "gesturechange", passive: false, callback: preventZoomGesture }),
        adapterHost.events.observe({ key: {}, target: document, type: "pointerdown", capture: true, callback: rememberManualFocusIntent }),
        adapterHost.events.observe({ key: {}, target: document, type: "touchstart", capture: true, callback: rememberManualFocusIntent }),
      ];

      return () => {
        disposePreference();
        disposeIpcInvoke();
        disposeViewport();
        disposeFocusHook();
        for (const disposeEvent of eventDisposers.reverse()) disposeEvent();
        if (style.parentNode) style.parentNode.removeChild(style);
        document.documentElement.removeAttribute("data-opencodex-mobile-keyboard-optimization");
        document.documentElement.removeAttribute("data-opencodex-ios-keyboard-optimization");
        document.documentElement.style.removeProperty("--codex-visual-viewport-height");
        document.documentElement.style.removeProperty("--codex-visual-viewport-offset-top");
        document.documentElement.style.removeProperty("--codex-keyboard-inset-bottom");
        document.__opencodexMobileKeyboardPluginInstalled = false;
      };
    },
  });
})();
