(function () {
  const w = window;
  const pluginSystem = w.OpenCodexPluginSystem || w.__OpenCodexPluginSystem;
  if (!pluginSystem || typeof pluginSystem.registerPlugin !== "function") return;

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

  pluginSystem.registerPlugin({
    id: "opencodex.mobile-keyboard-optimization",
    name: "Mobile keyboard optimization",
    labelKey: "web.settings.mobileKeyboard",
    label: "移动端软键盘优化",
    desc: "优化移动端输入框聚焦和视口高度，减少软键盘遮挡。",
    enableStorageKey: "mobileKeyboardOptimization",
    defaultEnabled: true,
    builtin: true,
    order: 10,
    activate(context) {
      if (context.scope !== "renderer" || !document || document.__opencodexMobileKeyboardPluginInstalled) return null;
      document.__opencodexMobileKeyboardPluginInstalled = true;

      let focusBlockedUntilMs = 0;
      let lastManualFocusIntentAtMs = 0;

      const isEnabled = () => context.plugin.isEnabled();
      const isMobile = () => !!context.platform.isMobile();

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
            will-change: transform;
          }
        }
      `;
      (document.head || document.documentElement).appendChild(style);

      const syncEnabledState = () => {
        const enabled = isEnabled();
        const root = document.documentElement;
        root.dataset.opencodexMobileKeyboardOptimization = enabled ? "true" : "false";
        root.dataset.opencodexIosKeyboardOptimization = enabled && isMobile() && isIOSWebKitDevice() ? "true" : "false";
        if (!enabled) {
          root.style.removeProperty("--codex-visual-viewport-height");
          root.style.removeProperty("--codex-visual-viewport-offset-top");
          root.style.removeProperty("--codex-keyboard-inset-bottom");
        }
        return enabled;
      };

      const setViewportVars = () => {
        if (!syncEnabledState()) return;
        const viewport = w.visualViewport;
        const height = Math.max(0, Math.floor(viewport?.height || w.innerHeight || document.documentElement.clientHeight || 0));
        const offsetTop = Math.max(0, Math.floor(viewport?.offsetTop || 0));
        const layoutHeight = Math.max(0, Math.floor(document.documentElement.clientHeight || w.innerHeight || height));
        const innerHeight = Math.max(0, Math.floor(w.innerHeight || layoutHeight || height));
        const viewportBottom = height + offsetTop;
        // iOS Safari 的地址栏和软键盘不会稳定改写布局视口；用可视视口底部差值推导被遮挡高度。
        const keyboardInset = isIOSWebKitDevice()
          ? Math.max(0, layoutHeight - viewportBottom, innerHeight - viewportBottom)
          : Math.max(0, innerHeight - viewportBottom);
        const root = document.documentElement;
        if (height > 0) root.style.setProperty("--codex-visual-viewport-height", `${height}px`);
        root.style.setProperty("--codex-visual-viewport-offset-top", `${offsetTop}px`);
        root.style.setProperty("--codex-keyboard-inset-bottom", `${keyboardInset}px`);
      };

      const keepActiveInputVisible = () => {
        if (!isEnabled() || !isMobile()) return;
        const active = document.activeElement;
        if (!isComposerEditableElement(active)) return;
        const viewport = w.visualViewport;
        const visibleTop = Math.max(0, viewport?.offsetTop || 0);
        const visibleBottom = visibleTop + Math.max(0, viewport?.height || w.innerHeight || 0);
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
        setViewportVars();
        const run = () => {
          setViewportVars();
          keepActiveInputVisible();
        };
        if (typeof w.requestAnimationFrame === "function") {
          w.requestAnimationFrame(run);
        } else {
          w.setTimeout(run, 0);
        }
        w.setTimeout(run, 80);
        w.setTimeout(run, 240);
      };

      const preventZoomGesture = (event) => {
        if (!isEnabled() || !isMobile()) return;
        if (event.touches && event.touches.length < 2) return;
        event.preventDefault();
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
      const originalFocus = proto && typeof proto.focus === "function" ? proto.focus : null;
      const focusGuardState = (w.__opencodexMobileKeyboardFocusGuardState =
        w.__opencodexMobileKeyboardFocusGuardState || {
          shouldSuppressFocus: () => false,
        });
      focusGuardState.shouldSuppressFocus = shouldSuppressFocus;
      if (originalFocus && !proto.__opencodexMobileKeyboardFocusPatched) {
        proto.__opencodexMobileKeyboardFocusPatched = true;
        proto.__opencodexMobileKeyboardOriginalFocus = originalFocus;
        proto.focus = function focus(...args) {
          if (focusGuardState.shouldSuppressFocus(this)) return;
          return proto.__opencodexMobileKeyboardOriginalFocus.apply(this, args);
        };
      }

      const disposePreference = context.events.on("plugin:enabled-changed", (payload) => {
        if (payload && payload.id === context.plugin.id) scheduleViewportUpdate();
      });
      const disposeIpcInvoke = context.events.on("ipc:invoke", (event) => {
        if (isEnabled() && isMobile() && isPromptSendInvoke(event?.channel, event?.payload)) {
          focusBlockedUntilMs = Date.now() + POST_SEND_FOCUS_BLOCK_MS;
        }
      });

      setViewportVars();
      w.addEventListener("resize", scheduleViewportUpdate, { passive: true });
      w.addEventListener("orientationchange", scheduleViewportUpdate, { passive: true });
      w.visualViewport?.addEventListener("resize", scheduleViewportUpdate, { passive: true });
      w.visualViewport?.addEventListener("scroll", scheduleViewportUpdate, { passive: true });
      document.addEventListener("focusin", scheduleViewportUpdate, true);
      document.addEventListener("input", scheduleViewportUpdate, true);
      document.addEventListener("touchmove", preventZoomGesture, { passive: false });
      document.addEventListener("gesturestart", preventZoomGesture, { passive: false });
      document.addEventListener("gesturechange", preventZoomGesture, { passive: false });
      document.addEventListener("pointerdown", rememberManualFocusIntent, true);
      document.addEventListener("touchstart", rememberManualFocusIntent, true);

      return () => {
        disposePreference();
        disposeIpcInvoke();
        w.removeEventListener("resize", scheduleViewportUpdate, { passive: true });
        w.removeEventListener("orientationchange", scheduleViewportUpdate, { passive: true });
        w.visualViewport?.removeEventListener("resize", scheduleViewportUpdate, { passive: true });
        w.visualViewport?.removeEventListener("scroll", scheduleViewportUpdate, { passive: true });
        document.removeEventListener("focusin", scheduleViewportUpdate, true);
        document.removeEventListener("input", scheduleViewportUpdate, true);
        document.removeEventListener("touchmove", preventZoomGesture, { passive: false });
        document.removeEventListener("gesturestart", preventZoomGesture, { passive: false });
        document.removeEventListener("gesturechange", preventZoomGesture, { passive: false });
        document.removeEventListener("pointerdown", rememberManualFocusIntent, true);
        document.removeEventListener("touchstart", rememberManualFocusIntent, true);
        if (style.parentNode) style.parentNode.removeChild(style);
        focusGuardState.shouldSuppressFocus = () => false;
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
