(function () {
  const w = window;
  if (w.__codexBridgePolyfillInstalled) return;
  w.__codexBridgePolyfillInstalled = true;
  const cfg = (w.__CODEX_WEB_CONFIG__ =
    w.__CODEX_WEB_CONFIG__ || {
      gatewayBaseUrl: location.origin,
      gatewayWsUrl: location.origin.replace(/^http/, "ws") + "/ws",
    });
  const OPENCODEX_LOCALE = cfg.locale || "zh-CN";
  const OPENCODEX_LANGUAGES = [OPENCODEX_LOCALE, "zh-CN", "zh", "en-US", "en"];
  const AUTH_FORCE_LOGIN_STORAGE_KEY = "codex_web_force_login";
  const OPENCODEX_SETTINGS_STORAGE_KEY = "opencodex_web_settings_v1";
  const GATEWAY_AUTH_LOGOUT_LABEL = "退出认证";
  const GATEWAY_AUTH_LOGOUT_BUSY_LABEL = "正在退出认证...";
  const OFFICIAL_LOGOUT_LABELS = [
    "退出登录",
    "Log out",
    "Logout",
    "Sign out",
    "Sign Out",
    "Sign out of Codex",
    "Log out of Codex",
  ];
  const OPENCODEX_DEFAULT_SETTINGS = {
    mobileKeyboardOptimization: true,
    mobileSidebarAutoCollapse: true,
  };
  const SIDEBAR_THREAD_ROW_SELECTOR = "[data-app-action-sidebar-thread-row]";
  const SIDEBAR_SCROLL_SELECTOR = "[data-app-action-sidebar-scroll]";
  const SIDEBAR_NON_THREAD_ROW_SELECTOR = "[data-app-action-sidebar-project-row],[data-app-action-sidebar-section]";
  const SIDEBAR_TOGGLE_VIEW_TRANSITION_NAME = "sidebar-trigger";
  const SIDEBAR_NEW_CONVERSATION_ICON_PATH_PREFIX = "M2.6687 11.333";
  const NEW_CONVERSATION_MESSAGE_TYPES = new Set(["new-chat", "new-quick-chat"]);

  function installLocaleOverride() {
    try {
      document.documentElement.lang = OPENCODEX_LOCALE;
    } catch {}
    try {
      Object.defineProperty(navigator, "language", {
        configurable: true,
        get: () => OPENCODEX_LOCALE,
      });
    } catch {}
    try {
      Object.defineProperty(navigator, "languages", {
        configurable: true,
        get: () => OPENCODEX_LANGUAGES,
      });
    } catch {}
  }

  function opencodexSettings() {
    try {
      const parsed = JSON.parse(localStorage.getItem(OPENCODEX_SETTINGS_STORAGE_KEY) || "{}");
      return {
        ...OPENCODEX_DEFAULT_SETTINGS,
        ...(parsed && typeof parsed === "object" ? parsed : {}),
      };
    } catch {
      return { ...OPENCODEX_DEFAULT_SETTINGS };
    }
  }

  function opencodexSettingEnabled(key) {
    return opencodexSettings()[key] !== false;
  }

  function gatewayAuthHeaders(headers) {
    return new Headers(headers || {});
  }

  function forceGatewayLoginOnNextBoot() {
    try {
      localStorage.setItem(AUTH_FORCE_LOGIN_STORAGE_KEY, "1");
    } catch {}
  }

  /** 官方 renderer 依赖 crypto.randomUUID，旧浏览器缺失时在 web-shell 侧补齐。 */
  function installRandomUUIDPolyfill() {
    let cryptoObject = w.crypto || {};
    if (typeof cryptoObject.randomUUID === "function") return;
    const randomUUID = () => {
      const bytes = new Uint8Array(16);
      if (typeof cryptoObject.getRandomValues === "function") {
        cryptoObject.getRandomValues(bytes);
      } else {
        for (let i = 0; i < bytes.length; i += 1) {
          bytes[i] = Math.floor(Math.random() * 256);
        }
      }
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
      return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex
        .slice(6, 8)
        .join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
    };
    try {
      Object.defineProperty(cryptoObject, "randomUUID", {
        configurable: true,
        value: randomUUID,
      });
    } catch {
      try {
        cryptoObject.randomUUID = randomUUID;
      } catch {}
    }
    if (typeof cryptoObject.randomUUID !== "function") {
      const wrappedCrypto = Object.create(cryptoObject || null);
      Object.defineProperty(wrappedCrypto, "randomUUID", {
        configurable: true,
        value: randomUUID,
      });
      cryptoObject = wrappedCrypto;
    }
    if (!w.crypto || typeof w.crypto.randomUUID !== "function") {
      try {
        Object.defineProperty(w, "crypto", {
          configurable: true,
          value: cryptoObject,
        });
      } catch {}
    }
  }

  installLocaleOverride();
  installRandomUUIDPolyfill();

  function installMobileViewportGuards() {
    if (!document || document.__codexMobileViewportGuardsInstalled) return;
    document.__codexMobileViewportGuardsInstalled = true;

    const style = document.createElement("style");
    style.id = "codex-mobile-viewport-guards";
    style.textContent = `
      @media (max-width: 820px), (pointer: coarse) {
        html,
        body,
        #root {
          height: var(--codex-visual-viewport-height, 100dvh) !important;
          min-height: var(--codex-visual-viewport-height, 100dvh) !important;
          max-height: var(--codex-visual-viewport-height, 100dvh) !important;
          overflow: hidden;
        }

        body {
          width: 100%;
          touch-action: pan-x pan-y;
          overscroll-behavior: none;
        }

        input,
        textarea,
        [contenteditable="true"],
        .ProseMirror {
          font-size: max(16px, 1em) !important;
          scroll-margin-bottom: calc(var(--codex-keyboard-inset-bottom, 0px) + 96px);
        }
      }
    `;
    (document.head || document.documentElement).appendChild(style);

    const setViewportVars = () => {
      const viewport = w.visualViewport;
      const height = Math.max(0, Math.floor(viewport?.height || w.innerHeight || document.documentElement.clientHeight || 0));
      const offsetTop = Math.max(0, Math.floor(viewport?.offsetTop || 0));
      const layoutHeight = Math.max(0, Math.floor(w.innerHeight || document.documentElement.clientHeight || height));
      const keyboardInset = Math.max(0, layoutHeight - height - offsetTop);
      const root = document.documentElement;
      if (height > 0) root.style.setProperty("--codex-visual-viewport-height", `${height}px`);
      root.style.setProperty("--codex-visual-viewport-offset-top", `${offsetTop}px`);
      root.style.setProperty("--codex-keyboard-inset-bottom", `${keyboardInset}px`);
    };

    const scrollableAncestor = (element) => {
      for (let node = element?.parentElement; node && node !== document.body; node = node.parentElement) {
        const style = w.getComputedStyle ? w.getComputedStyle(node) : null;
        const overflowY = String(style?.overflowY || "");
        if (/(auto|scroll)/.test(overflowY) && node.scrollHeight > node.clientHeight) return node;
      }
      return null;
    };

    const keepActiveInputVisible = () => {
      if (!isLikelyMobileKeyboardDevice()) return;
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
      if (!isLikelyMobileKeyboardDevice()) return;
      if (event.touches && event.touches.length < 2) return;
      event.preventDefault();
    };

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
  }

  installMobileViewportGuards();

  /**
   * Electron 的 <webview> 在浏览器里不存在。
   *
   * 这里用 iframe 提供最小兼容层，满足官方 renderer 对 webview API 的常见调用。
   */
  function installWebviewShim() {
    if (!document || document.__codexWebviewShimInstalled) return;
    document.__codexWebviewShimInstalled = true;
    const originalCreateElement = document.createElement.bind(document);

    /** 只注入一次 webview shim 的布局样式。 */
    function ensureWebviewStyles() {
      if (document.getElementById("codex-web-webview-shim-styles")) return;
      const style = originalCreateElement("style");
      style.id = "codex-web-webview-shim-styles";
      style.textContent = `
        webview[data-codex-webview-shim="true"] {
          display: block;
          min-width: 0;
          min-height: 0;
          width: 100%;
          height: 100%;
          overflow: hidden;
        }
        webview[data-codex-webview-shim="true"] > iframe[data-codex-webview-frame="true"] {
          display: block;
          width: 100%;
          height: 100%;
          border: 0;
          background: transparent;
        }
      `;
      (document.head || document.documentElement).appendChild(style);
    }

    /** 把一个自定义 webview 元素包装成 iframe-backed shim。 */
    function installOnElement(element) {
      if (!element || element.__codexWebviewShimElement) return element;
      element.__codexWebviewShimElement = true;
      element.setAttribute("data-codex-webview-shim", "true");
      ensureWebviewStyles();

      const frame = originalCreateElement("iframe");
      frame.setAttribute("data-codex-webview-frame", "true");
      frame.setAttribute("allow", "clipboard-read; clipboard-write; fullscreen");
      frame.setAttribute("referrerpolicy", "no-referrer");
      frame.setAttribute("sandbox", "allow-forms allow-modals allow-popups allow-same-origin allow-scripts");
      element.appendChild(frame);

      const originalSetAttribute = element.setAttribute.bind(element);
      const originalRemoveAttribute = element.removeAttribute.bind(element);
      // src 属性需要同时驱动 iframe，否则官方组件设置 webview.src 不会真的加载页面。
      const syncSrc = (value) => {
        if (typeof value !== "string" || value.length === 0) {
          frame.removeAttribute("src");
          return;
        }
        frame.src = value;
      };

      element.setAttribute = (name, value) => {
        originalSetAttribute(name, value);
        if (String(name).toLowerCase() === "src") syncSrc(String(value));
      };
      element.removeAttribute = (name) => {
        originalRemoveAttribute(name);
        if (String(name).toLowerCase() === "src") frame.removeAttribute("src");
      };

      Object.defineProperty(element, "src", {
        configurable: true,
        get() {
          return frame.getAttribute("src") || "";
        },
        set(value) {
          element.setAttribute("src", value);
        },
      });
      Object.defineProperty(element, "contentWindow", {
        configurable: true,
        get() {
          return frame.contentWindow;
        },
      });

      element.getURL = () => frame.src || element.getAttribute("src") || "";
      element.loadURL = (url) => {
        element.setAttribute("src", url);
        return Promise.resolve();
      };
      element.reload = () => {
        try {
          frame.contentWindow?.location.reload();
        } catch {
          frame.src = frame.src;
        }
      };
      element.stop = () => {
        try {
          frame.contentWindow?.stop();
        } catch {}
      };
      element.goBack = () => {
        try {
          frame.contentWindow?.history.back();
        } catch {}
      };
      element.goForward = () => {
        try {
          frame.contentWindow?.history.forward();
        } catch {}
      };
      element.canGoBack = () => false;
      element.canGoForward = () => false;
      element.executeJavaScript = () => Promise.resolve(null);
      element.insertCSS = () => Promise.resolve("");
      element.openDevTools = () => {};
      element.send = () => {};

      frame.addEventListener("load", () => {
        element.dispatchEvent(new Event("dom-ready"));
        element.dispatchEvent(new Event("did-finish-load"));
      });
      frame.addEventListener("error", () => {
        element.dispatchEvent(new Event("did-fail-load"));
      });

      const initialSrc = element.getAttribute("src");
      if (initialSrc) syncSrc(initialSrc);
      return element;
    }

    // 劫持 createElement("webview")，其余元素保持原生行为。
    document.createElement = function createElement(name, options) {
      const element = originalCreateElement(name, options);
      return String(name).toLowerCase() === "webview" ? installOnElement(element) : element;
    };
  }

  installWebviewShim();

  const listeners = new Map();
  const authStatusCallbacks = new Set();
  const terminalMessageQueues = new Map();
  const MOBILE_COMPOSER_POST_SEND_FOCUS_BLOCK_MS = 4000;
  const MOBILE_COMPOSER_MANUAL_FOCUS_MS = 900;
  const MOBILE_SIDEBAR_AUTO_COLLAPSE_DELAY_MS = 80;
  const STATSIG_DEFAULT_FEATURES_CONFIG = "statsig_default_enable_features";
  const STATSIG_I18N_LAYER_CONFIG = "72216192";
  const STATSIG_I18N_LAYER_VALUES = {
    enable_i18n: true,
    locale_source: "IDE",
  };
  const STATSIG_DEFAULT_FEATURE_OVERRIDES = {
    guardian_approval: true,
    "3903742690": true,
    artifacts: true,
  };
  const clientId =
    w.crypto?.randomUUID?.() || `web-client-${Math.random().toString(36).slice(2)}`;
  let ws = null;
  let reconnectTimer = null;
  let reconnectDelay = 500;
  const MODEL_LIST_CACHE_KEY = "__codex_web_model_list_cache_v1__";
  const MODEL_LIST_FRESH_MS = 5 * 60 * 1000;
  const MODEL_LIST_STALE_MS = 60 * 60 * 1000;
  const MCP_REQUEST_TIMEOUTS_MS = new Map([
    ["thread/read", 20 * 1000],
    ["thread/turns/list", 20 * 1000],
    ["thread/goal/get", 15 * 1000],
    ["thread/resume", 35 * 1000],
  ]);
  const MCP_REQUEST_RETRYABLE_METHODS = new Set([
    "thread/read",
    "thread/turns/list",
    "thread/goal/get",
  ]);
  const modelListRequests = new Map();
  const modelListCache = new Map();
  const pendingMcpRequests = new Map();
  let mobileComposerFocusBlockedUntilMs = 0;
  let lastManualComposerFocusIntentAtMs = 0;
  let mobileSidebarCollapseTimer = null;

  /** 判断当前设备是否可能有移动端软键盘。 */
  function isLikelyMobileKeyboardDevice() {
    const nav = w.navigator || {};
    const ua = String(nav.userAgent || "");
    const hasCoarsePointer = !!(w.matchMedia && w.matchMedia("(pointer: coarse)").matches);
    const hasTouch = Number(nav.maxTouchPoints || 0) > 0 || "ontouchstart" in w;
    return (hasCoarsePointer && hasTouch) || /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
  }

  /** ProseMirror 是官方 composer 的可编辑输入区。 */
  function isComposerEditableElement(element) {
    return !!(
      element &&
      element.nodeType === 1 &&
      typeof element.matches === "function" &&
      element.matches(".ProseMirror,[contenteditable='true'],textarea,input")
    );
  }

  /** 用户主动点输入区时，发送后的 focus guard 必须放行。 */
  function rememberManualComposerFocusIntent(event) {
    const target = event && event.target;
    if (!target || typeof target.closest !== "function") return;
    if (target.closest(".ProseMirror,[contenteditable='true'],textarea,input")) {
      lastManualComposerFocusIntentAtMs = Date.now();
    }
  }

  /** 判断一次 IPC 是否代表用户正在发送 prompt。 */
  function isPromptSendInvoke(channel, payload) {
    if (channel === "turn:start" || channel === "start-conversation") return true;
    if (channel !== "codex_desktop:message-from-view") return false;
    if (!payload || typeof payload !== "object") return false;
    const request = payload.request && typeof payload.request === "object" ? payload.request : null;
    return !!request && request.method === "turn/start";
  }

  /** 发送后移动端官方 renderer 会自动 refocus composer；Web 侧短时间拦住，避免键盘重新弹起。 */
  function markMobileComposerPromptSent(channel, payload) {
    if (!opencodexSettingEnabled("mobileKeyboardOptimization")) return;
    if (!isLikelyMobileKeyboardDevice() || !isPromptSendInvoke(channel, payload)) return;
    mobileComposerFocusBlockedUntilMs = Date.now() + MOBILE_COMPOSER_POST_SEND_FOCUS_BLOCK_MS;
  }

  /** 只拦发送后的程序化 composer focus，不拦用户手动点击输入区。 */
  function shouldSuppressMobileComposerFocus(element) {
    if (!opencodexSettingEnabled("mobileKeyboardOptimization")) return false;
    if (!isLikelyMobileKeyboardDevice()) return false;
    const now = Date.now();
    if (now > mobileComposerFocusBlockedUntilMs) return false;
    if (!isComposerEditableElement(element)) return false;
    return now - lastManualComposerFocusIntentAtMs > MOBILE_COMPOSER_MANUAL_FOCUS_MS;
  }

  /** 安装移动端 composer focus guard。 */
  function installMobileComposerFocusGuard() {
    if (!document || document.__codexMobileComposerFocusGuardInstalled) return;
    const proto = w.HTMLElement && w.HTMLElement.prototype;
    if (!proto || typeof proto.focus !== "function") return;
    document.__codexMobileComposerFocusGuardInstalled = true;
    const originalFocus = proto.focus;
    proto.focus = function focus(...args) {
      if (shouldSuppressMobileComposerFocus(this)) return;
      return originalFocus.apply(this, args);
    };
    document.addEventListener("pointerdown", rememberManualComposerFocusIntent, true);
    document.addEventListener("touchstart", rememberManualComposerFocusIntent, true);
  }

  installMobileComposerFocusGuard();

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
    if (panel) {
      return panel.querySelector(SIDEBAR_SCROLL_SELECTOR) || panel.querySelector("nav") || panel;
    }
    return document.querySelector(SIDEBAR_SCROLL_SELECTOR) || document.querySelector("nav");
  }

  function elementTextLabel(element) {
    if (!element) return "";
    return String(
      element.getAttribute?.("aria-label") ||
        element.getAttribute?.("title") ||
        element.innerText ||
        element.textContent ||
        ""
    ).trim();
  }

  function officialLogoutLabelFromElement(element) {
    const label = elementTextLabel(element).replace(/\s+/g, " ").trim();
    if (!label || label === GATEWAY_AUTH_LOGOUT_LABEL) return "";
    return OFFICIAL_LOGOUT_LABELS.find((text) => label === text || label.includes(text)) || "";
  }

  function isMenuLikeContext(element) {
    for (let node = element && element.parentElement; node && node !== document.body; node = node.parentElement) {
      const role = String(node.getAttribute?.("role") || "").toLowerCase();
      if (role === "menu" || role === "menubar") return true;
      if (node.hasAttribute?.("data-radix-menu-content") || node.hasAttribute?.("data-radix-popper-content-wrapper")) {
        return true;
      }
      const className = String(node.className || "");
      if (role === "dialog" || /\bcodex-dialog\b/i.test(className)) return false;
      if (/\b(dropdown|menu|popover)\b/i.test(className)) return true;
    }
    return false;
  }

  function isOfficialLogoutMenuItem(element) {
    if (!element || element.nodeType !== 1) return false;
    if (element.dataset?.codexWebGatewayAuthLogout === "true") return false;
    if (!visibleElement(element)) return false;
    if (!officialLogoutLabelFromElement(element)) return false;
    if (!isMenuLikeContext(element)) return false;
    const tagName = String(element.tagName || "").toLowerCase();
    const role = String(element.getAttribute?.("role") || "").toLowerCase();
    return tagName === "button" || tagName === "a" || role === "menuitem" || role === "menuitemradio";
  }

  function removeDuplicatedIdentityAttributes(element) {
    if (!element || element.nodeType !== 1) return;
    element.removeAttribute("id");
    element.removeAttribute("data-testid");
    element.querySelectorAll?.("[id],[data-testid]").forEach((child) => {
      child.removeAttribute("id");
      child.removeAttribute("data-testid");
    });
  }

  function replaceMenuItemText(element, fromText, toText) {
    const textNodes = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      if (String(node.nodeValue || "").includes(fromText)) textNodes.push(node);
      node = walker.nextNode();
    }
    if (textNodes.length === 0) {
      element.textContent = toText;
      return;
    }
    for (const textNode of textNodes) {
      textNode.nodeValue = String(textNode.nodeValue || "").replace(fromText, toText);
    }
  }

  function markGatewayAuthLogoutBusy(item, busy) {
    if (!item) return;
    item.toggleAttribute("disabled", busy);
    item.setAttribute("aria-disabled", busy ? "true" : "false");
    const originalLabel = item.dataset.codexWebGatewayAuthOriginalLabel || GATEWAY_AUTH_LOGOUT_LABEL;
    replaceMenuItemText(item, busy ? originalLabel : GATEWAY_AUTH_LOGOUT_BUSY_LABEL, busy ? GATEWAY_AUTH_LOGOUT_BUSY_LABEL : originalLabel);
  }

  async function logoutGatewayAuthFromMenu(item) {
    if (w.__codexGatewayAuthLogoutInProgress) return;
    w.__codexGatewayAuthLogoutInProgress = true;
    markGatewayAuthLogoutBusy(item, true);
    try {
      const res = await w.fetch("/api/auth/logout", {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: gatewayAuthHeaders({ accept: "application/json" }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      forceGatewayLoginOnNextBoot();
      w.location.replace("/");
    } catch (error) {
      w.__codexGatewayAuthLogoutInProgress = false;
      markGatewayAuthLogoutBusy(item, false);
      renderBridgeErrorToast({
        description: `退出认证失败：${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  function stopGatewayAuthLogoutEvent(event) {
    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
  }

  function gatewayAuthLogoutItemFromEvent(event) {
    const target = event && event.target;
    const element = target && target.nodeType === 1 ? target : target?.parentElement;
    return element && typeof element.closest === "function"
      ? element.closest('[data-codex-web-gateway-auth-logout="true"]')
      : null;
  }

  function handleGatewayAuthLogoutPointer(event) {
    const item = gatewayAuthLogoutItemFromEvent(event);
    if (!item) return;
    stopGatewayAuthLogoutEvent(event);
    logoutGatewayAuthFromMenu(item);
  }

  function handleGatewayAuthLogoutKeydown(event) {
    const item = gatewayAuthLogoutItemFromEvent(event);
    if (!item || (event.key !== "Enter" && event.key !== " ")) return;
    stopGatewayAuthLogoutEvent(event);
    logoutGatewayAuthFromMenu(item);
  }

  function createGatewayAuthLogoutMenuItem(logoutItem) {
    const officialLabel = officialLogoutLabelFromElement(logoutItem) || "退出登录";
    const item = logoutItem.cloneNode(true);
    item.dataset.codexWebGatewayAuthLogout = "true";
    item.dataset.codexWebGatewayAuthOriginalLabel = GATEWAY_AUTH_LOGOUT_LABEL;
    item.setAttribute("aria-label", GATEWAY_AUTH_LOGOUT_LABEL);
    item.setAttribute("title", GATEWAY_AUTH_LOGOUT_LABEL);
    item.removeAttribute("disabled");
    item.removeAttribute("aria-disabled");
    removeDuplicatedIdentityAttributes(item);
    replaceMenuItemText(item, officialLabel, GATEWAY_AUTH_LOGOUT_LABEL);
    if (String(item.tagName || "").toLowerCase() === "button") item.type = "button";
    item.addEventListener("pointerdown", (event) => {
      stopGatewayAuthLogoutEvent(event);
      logoutGatewayAuthFromMenu(item);
    });
    item.addEventListener("click", (event) => {
      stopGatewayAuthLogoutEvent(event);
      logoutGatewayAuthFromMenu(item);
    });
    item.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      stopGatewayAuthLogoutEvent(event);
      logoutGatewayAuthFromMenu(item);
    });
    return item;
  }

  function injectGatewayAuthLogoutMenuItem(logoutItem) {
    const parent = logoutItem && logoutItem.parentElement;
    if (!parent) return false;
    if (Array.from(parent.children || []).some((child) => child.dataset?.codexWebGatewayAuthLogout === "true")) {
      return false;
    }
    parent.insertBefore(createGatewayAuthLogoutMenuItem(logoutItem), logoutItem);
    return true;
  }

  function scanGatewayAuthLogoutMenuItems(root = document) {
    const scope = root && root.nodeType === 1 ? root : document;
    const candidates = Array.from(scope.querySelectorAll?.("button,a,[role='menuitem'],[role='menuitemradio']") || []);
    if (scope !== document && isOfficialLogoutMenuItem(scope)) candidates.unshift(scope);
    let injected = 0;
    for (const candidate of candidates) {
      if (isOfficialLogoutMenuItem(candidate) && injectGatewayAuthLogoutMenuItem(candidate)) injected += 1;
    }
    return injected;
  }

  function installGatewayAuthMenuInjection() {
    if (!document || document.__codexGatewayAuthMenuInjectionInstalled) return;
    document.__codexGatewayAuthMenuInjectionInstalled = true;
    let scheduled = false;
    const scheduleScan = () => {
      if (scheduled) return;
      scheduled = true;
      const run = () => {
        scheduled = false;
        scanGatewayAuthLogoutMenuItems(document);
      };
      if (typeof w.requestAnimationFrame === "function") {
        w.requestAnimationFrame(run);
      } else {
        w.setTimeout(run, 0);
      }
    };
    const start = () => {
      scheduleScan();
      document.addEventListener("pointerdown", handleGatewayAuthLogoutPointer, true);
      document.addEventListener("click", handleGatewayAuthLogoutPointer, true);
      document.addEventListener("keydown", handleGatewayAuthLogoutKeydown, true);
      const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          for (const node of mutation.addedNodes || []) {
            if (node && node.nodeType === 1) {
              scheduleScan();
              return;
            }
          }
        }
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", start, { once: true });
    } else {
      start();
    }
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

  function collapseMobileSidebarAfterSelection() {
    if (mobileSidebarCollapseTimer) w.clearTimeout(mobileSidebarCollapseTimer);
    mobileSidebarCollapseTimer = w.setTimeout(() => {
      mobileSidebarCollapseTimer = null;
      const panel = sidebarPanelElement();
      if (!panel || !visibleElement(panel)) return;
      const toggleButton = findSidebarToggleButton();
      if (toggleButton && typeof toggleButton.click === "function") {
        toggleButton.click();
        return;
      }
      postSidebarToggleMessage();
    }, MOBILE_SIDEBAR_AUTO_COLLAPSE_DELAY_MS);
  }

  function isNewConversationMessage(payload) {
    if (!payload || typeof payload !== "object") return false;
    if (NEW_CONVERSATION_MESSAGE_TYPES.has(payload.type)) return true;
    if (payload.type !== "navigate-to-route" || payload.path !== "/") return false;
    const state = payload.state && typeof payload.state === "object" ? payload.state : null;
    return !!state && Object.prototype.hasOwnProperty.call(state, "focusComposerNonce");
  }

  function collapseMobileSidebarAfterNewConversation(payload) {
    if (!opencodexSettingEnabled("mobileSidebarAutoCollapse")) return;
    if (!isLikelyMobileKeyboardDevice()) return;
    if (!isNewConversationMessage(payload)) return;
    collapseMobileSidebarAfterSelection();
  }

  function isSidebarNewConversationButton(button) {
    if (!button || typeof button.matches !== "function" || !button.matches("button")) return false;
    const panel = sidebarPanelElement();
    if (!panel || !panel.contains(button)) return false;
    if (!visibleElement(button) || button.disabled || button.getAttribute("aria-disabled") === "true") return false;
    return Array.from(button.querySelectorAll("svg path")).some((path) =>
      String(path.getAttribute("d") || "").startsWith(SIDEBAR_NEW_CONVERSATION_ICON_PATH_PREFIX)
    );
  }

  function sidebarNewConversationButtonFromTarget(target) {
    const element = target && target.nodeType === 1 ? target : target?.parentElement;
    if (!element || typeof element.closest !== "function") return null;
    const button = element.closest("button");
    return isSidebarNewConversationButton(button) ? button : null;
  }

  function handleMobileSidebarAutoCollapseClick(event) {
    if (!opencodexSettingEnabled("mobileSidebarAutoCollapse")) return;
    if (!isLikelyMobileKeyboardDevice()) return;
    if (event.defaultPrevented || event.button > 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (!sidebarConversationRowFromTarget(event.target) && !sidebarNewConversationButtonFromTarget(event.target)) {
      return;
    }
    collapseMobileSidebarAfterSelection();
  }

  function installMobileSidebarAutoCollapse() {
    if (!document || document.__codexMobileSidebarAutoCollapseInstalled) return;
    document.__codexMobileSidebarAutoCollapseInstalled = true;
    document.addEventListener("click", handleMobileSidebarAutoCollapseClick, true);
  }

  installMobileSidebarAutoCollapse();
  installGatewayAuthMenuInjection();

  /** 模型列表请求参数归一化，保证缓存 key 稳定。 */
  function normalizeModelListParams(params) {
    const input = params && typeof params === "object" && !Array.isArray(params) ? params : {};
    const limit = Number(input.limit);
    return {
      hostId: typeof input.hostId === "string" && input.hostId.trim() ? input.hostId : "local",
      includeHidden: input.includeHidden !== false,
      cursor: input.cursor == null ? null : String(input.cursor),
      limit: Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 100,
    };
  }

  /** 模型列表缓存 key，和 normalizeModelListParams 一起保证同义请求命中同一缓存。 */
  function modelListCacheKey(params) {
    const normalized = normalizeModelListParams(params);
    return JSON.stringify(normalized);
  }

  /** 从 localStorage 恢复模型列表缓存，让远端设备刷新后也能秒出模型。 */
  function restoreModelListCache() {
    try {
      const raw = localStorage.getItem(MODEL_LIST_CACHE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      const entries = parsed && typeof parsed === "object" ? parsed.entries : null;
      if (!entries || typeof entries !== "object") return;
      const now = Date.now();
      for (const [key, entry] of Object.entries(entries)) {
        if (!entry || typeof entry !== "object") continue;
        if (!entry.storedAtMs || now - Number(entry.storedAtMs) > MODEL_LIST_STALE_MS) continue;
        if (!entry.result || typeof entry.result !== "object") continue;
        modelListCache.set(key, {
          result: entry.result,
          storedAtMs: Number(entry.storedAtMs),
        });
      }
    } catch {}
  }

  /** 把模型列表缓存写入 localStorage。 */
  function persistModelListCache() {
    try {
      const entries = {};
      for (const [key, entry] of modelListCache.entries()) {
        entries[key] = entry;
      }
      localStorage.setItem(MODEL_LIST_CACHE_KEY, JSON.stringify({ entries }));
    } catch {}
  }

  /** 清空模型列表缓存和正在进行的请求。 */
  function clearModelListCache() {
    modelListCache.clear();
    modelListRequests.clear();
    try {
      localStorage.removeItem(MODEL_LIST_CACHE_KEY);
    } catch {}
  }

  /** 收到账户/配置/插件/MCP 变更通知时主动清模型缓存，避免长期不新鲜。 */
  function shouldClearModelListCache(channel, payload) {
    if (channel === "account/updated") return true;
    if (channel !== "mcp-notification") return false;
    const method =
      payload && typeof payload === "object"
        ? payload.method ||
          (payload.message && typeof payload.message === "object" ? payload.message.method : null)
        : null;
    if (typeof method !== "string") return false;
    return /^(account\/|config\/|model\/|plugin\/|marketplace\/|mcpServer\/|mcpServerStatus\/)/.test(method);
  }

  /** 读取模型列表缓存；allowStale 用于先展示旧数据再后台刷新。 */
  function readCachedModelList(params, allowStale = true) {
    const entry = modelListCache.get(modelListCacheKey(params));
    if (!entry) return null;
    const age = Date.now() - Number(entry.storedAtMs || 0);
    const maxAge = allowStale ? MODEL_LIST_STALE_MS : MODEL_LIST_FRESH_MS;
    return age >= 0 && age <= maxAge ? entry.result : null;
  }

  /** 写入模型列表缓存，只有包含 data 数组的结果才缓存。 */
  function writeCachedModelList(params, result) {
    if (!result || typeof result !== "object" || !Array.isArray(result.data)) return result;
    modelListCache.set(modelListCacheKey(params), {
      result,
      storedAtMs: Date.now(),
    });
    persistModelListCache();
    return result;
  }

  /** 从 gateway 的轻量 API 拉模型列表，并合并相同参数的并发请求。 */
  function fetchModelListForHost(params) {
    const normalized = normalizeModelListParams(params);
    const key = modelListCacheKey(normalized);
    if (modelListRequests.has(key)) return modelListRequests.get(key);
    const search = new URLSearchParams();
    search.set("hostId", normalized.hostId);
    search.set("includeHidden", normalized.includeHidden ? "1" : "0");
    search.set("cursor", normalized.cursor == null ? "" : normalized.cursor);
    search.set("limit", String(normalized.limit));
    const promise = fetch(`/api/models/list-for-host?${search.toString()}`, {
      credentials: "same-origin",
      headers: gatewayAuthHeaders({ accept: "application/json" }),
    })
      .then((res) => {
        if (!res.ok) throw new Error(`model list request failed (${res.status})`);
        return res.json();
      })
      .then((result) => writeCachedModelList(normalized, result))
      .finally(() => {
        if (modelListRequests.get(key) === promise) modelListRequests.delete(key);
      });
    modelListRequests.set(key, promise);
    return promise;
  }

  /** 官方 renderer 默认读取 local host 的全部模型。 */
  function defaultModelListParams() {
    return { hostId: "local", includeHidden: true, cursor: null, limit: 100 };
  }

  /** 用 gateway 注入的首屏 modelList 预填缓存。 */
  function seedModelListCacheFromConfig() {
    if (!cfg.modelList || typeof cfg.modelList !== "object" || !Array.isArray(cfg.modelList.data)) return;
    writeCachedModelList(defaultModelListParams(), cfg.modelList);
  }

  /** 页面启动后预热模型列表，优先用缓存，不阻塞首屏。 */
  function scheduleModelListPreload() {
    restoreModelListCache();
    seedModelListCacheFromConfig();
    const params = defaultModelListParams();
    if (readCachedModelList(params, false)) return;
    setTimeout(() => {
      fetchModelListForHost(params).catch(() => {});
    }, 0);
  }

  /** 从 mcp-request/thread-prewarm-start 中识别 list-models-for-host 请求。 */
  function modelListRequestFromPayload(payload) {
    if (!payload || typeof payload !== "object") return null;
    if (payload.type !== "mcp-request" && payload.type !== "thread-prewarm-start") return null;
    const request =
      payload.request && typeof payload.request === "object"
        ? payload.request
        : payload.method
          ? payload
          : null;
    if (!request || request.method !== "list-models-for-host") return null;
    const id = request.id || payload.id;
    if (id == null) return null;
    return {
      id: String(id),
      params: request.params,
      hostId:
        (typeof payload.hostId === "string" && payload.hostId) ||
        (request.params && typeof request.params.hostId === "string" && request.params.hostId) ||
        "local",
    };
  }

  /** 用官方 renderer 期望的 mcp-response 形态回填模型列表结果。 */
  function emitModelListMcpResponse(request, result) {
    emitWindowMessage("mcp-response", {
      hostId: request.hostId,
      message: {
        id: request.id,
        result,
      },
    });
  }

  /** 模型列表请求的前端快速路径，减少打开会话时等待右下角模型信息。 */
  function handleModelListMcpRequest(payload) {
    const request = modelListRequestFromPayload(payload);
    if (!request) return false;
    const fresh = readCachedModelList(request.params, false);
    if (fresh) {
      queueMicrotask(() => emitModelListMcpResponse(request, fresh));
      return true;
    }
    const stale = readCachedModelList(request.params, true);
    fetchModelListForHost(request.params)
      .then((result) => emitModelListMcpResponse(request, result))
      .catch(() => {
        if (stale) {
          emitModelListMcpResponse(request, stale);
          return;
        }
        invoke("codex_desktop:message-from-view", payload).catch((error) => {
          emitWindowMessage("mcp-response", {
            hostId: request.hostId,
            message: {
              id: request.id,
              error: { message: error instanceof Error ? error.message : String(error) },
            },
          });
        });
      });
    return true;
  }

  /** 获取某个 channel 的监听集合。 */
  function ensureSet(channel) {
    if (!listeners.has(channel)) listeners.set(channel, new Set());
    return listeners.get(channel);
  }

  /** 模拟 Electron ipcRenderer.on。 */
  function subscribe(channel, handler) {
    const set = ensureSet(channel);
    set.add(handler);
    return () => unsubscribe(channel, handler);
  }

  /** 模拟 Electron ipcRenderer.off。 */
  function unsubscribe(channel, handler) {
    const set = listeners.get(channel);
    if (!set) return;
    set.delete(handler);
    if (set.size === 0) listeners.delete(channel);
  }

  /** renderer listener 需要回复 gateway 时统一走 invoke。 */
  function sendRendererReply(channel, payload) {
    if (typeof channel !== "string" || !channel) return Promise.resolve(false);
    const message =
      payload && typeof payload === "object"
        ? { type: channel, ...payload }
        : { type: channel, payload };
    return invoke("codex_desktop:message-from-view", message).catch((error) => {
      console.warn("[codex-web] failed to send renderer reply", channel, error);
      return false;
    });
  }

  /** 分发 gateway/web-shell 事件给通过 ipcRenderer.on 注册的监听器。 */
  function dispatch(channel, payload) {
    const set = listeners.get(channel);
    if (!set || set.size === 0) return 0;
    let delivered = 0;
    for (const handler of [...set]) {
      try {
        handler(payload, sendRendererReply);
        delivered += 1;
      } catch (error) {
        console.error("[codex-web] listener error", channel, error);
      }
    }
    return delivered;
  }

  /** 同时模拟 window.postMessage 风格的 renderer 消息入口。 */
  function emitWindowMessage(channel, payload) {
    try {
      if (channel === "mcp-response" && payload && typeof payload === "object") {
        const normalizedMessage = payload.message || payload.response || payload;
        clearPendingMcpRequest(normalizedMessage && normalizedMessage.id);
        const data = {
          type: channel,
          ...payload,
          message:
            normalizedMessage && typeof normalizedMessage === "object"
              ? normalizedMessage
              : { id: payload.id, result: payload.result, error: payload.error },
        };
        if (!data.response && payload.response) {
          data.response = payload.response;
        }
        w.dispatchEvent(new MessageEvent("message", { data }));
        return;
      }
      const data =
        payload && typeof payload === "object"
          ? { type: channel, ...payload }
          : { type: channel, payload };
      w.dispatchEvent(new MessageEvent("message", { data }));
    } catch (error) {
      console.warn("[codex-web] failed to emit window message", channel, error);
    }
  }

  function mcpRequestDetails(payload) {
    if (!payload || typeof payload !== "object") return null;
    if (payload.type !== "mcp-request" && payload.type !== "thread-prewarm-start") return null;
    const request = payload.request;
    if (!request || typeof request !== "object") return null;
    const id = request.id == null ? "" : String(request.id);
    const method =
      payload.type === "thread-prewarm-start"
        ? "thread/start"
        : String(request.method || "");
    if (!id || !method) return null;
    const timeoutMs = MCP_REQUEST_TIMEOUTS_MS.get(method) || 0;
    if (!timeoutMs) return null;
    return {
      id,
      method,
      timeoutMs,
      hostId: payload.hostId ?? null,
    };
  }

  function clearPendingMcpRequest(id) {
    const requestId = id == null ? "" : String(id);
    if (!requestId) return;
    const pending = pendingMcpRequests.get(requestId);
    if (!pending) return;
    pendingMcpRequests.delete(requestId);
    if (pending.retryTimer) clearTimeout(pending.retryTimer);
    if (pending.timeoutTimer) clearTimeout(pending.timeoutTimer);
  }

  function trackPendingMcpRequest(payload) {
    const details = mcpRequestDetails(payload);
    if (!details) return;
    clearPendingMcpRequest(details.id);
    const entry = {
      id: details.id,
      method: details.method,
      hostId: details.hostId,
      retryTimer: null,
      timeoutTimer: null,
    };
    if (MCP_REQUEST_RETRYABLE_METHODS.has(details.method)) {
      const retryDelayMs = Math.min(5 * 1000, Math.max(1 * 1000, Math.floor(details.timeoutMs / 2)));
      entry.retryTimer = setTimeout(() => {
        const current = pendingMcpRequests.get(details.id);
        if (current !== entry) return;
        invoke("codex_desktop:message-from-view", payload).catch((error) => {
          console.warn("[codex-web] failed to retry mcp request", details.method, error);
        });
      }, retryDelayMs);
    }
    entry.timeoutTimer = setTimeout(() => {
      const current = pendingMcpRequests.get(details.id);
      if (current !== entry) return;
      pendingMcpRequests.delete(details.id);
      if (entry.retryTimer) clearTimeout(entry.retryTimer);
      console.warn("[codex-web] mcp request timed out", {
        id: details.id,
        method: details.method,
        timeoutMs: details.timeoutMs,
      });
      emitWindowMessage("mcp-response", {
        hostId: details.hostId,
        message: {
          id: details.id,
          error: {
            message: `OpenCodex timed out waiting for ${details.method}`,
          },
        },
      });
    }, details.timeoutMs);
  }

  /** 调试用 payload 形状摘要，不输出完整敏感数据。 */
  function payloadShape(payload) {
    if (payload === null) return "null";
    if (Array.isArray(payload)) return `array(${payload.length})`;
    if (typeof payload === "object") return `object(${Object.keys(payload).length})`;
    return typeof payload;
  }

  /** 安全序列化 IPC payload，支持 Error 和循环引用。 */
  function stringifyForIpc(value) {
    const seen = new WeakSet();
    return JSON.stringify(value, (_key, nestedValue) => {
      if (nestedValue instanceof Error) {
        return {
          name: nestedValue.name,
          message: nestedValue.message,
          stack: nestedValue.stack,
          cause: nestedValue.cause,
        };
      }
      if (nestedValue && typeof nestedValue === "object") {
        if (seen.has(nestedValue)) return "[Circular]";
        seen.add(nestedValue);
      }
      return nestedValue;
    });
  }

  const ipcErrorToastState = {
    lastKey: "",
    lastShownAtMs: 0,
  };

  /** 把 gateway 返回的 error 字段归一成可展示字符串。 */
  function normalizeErrorMessage(error) {
    if (!error) return "";
    if (typeof error === "string") return error;
    if (error && typeof error === "object" && typeof error.message === "string") {
      return error.message;
    }
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }

  /** 优先使用 gateway 返回的真实错误，而不是只显示 HTTP status。 */
  function ipcInvokeErrorMessage(channel, status, json) {
    const bodyError =
      json && typeof json === "object" && Object.prototype.hasOwnProperty.call(json, "error")
        ? normalizeErrorMessage(json.error)
        : "";
    return bodyError || `IPC invoke failed: ${channel} (${status})`;
  }

  /** 只兜底展示 fetch 形态的 IPC 兼容错误，invoke 错误交给官方前端调用栈自然处理。 */
  function shouldSurfaceFetchIpcError(status, message) {
    if (status === 400) return true;
    return /unsupported codex ipc channel|method not found|no electron ipc handler|invalid ipc channel/i.test(
      message || ""
    );
  }

  /** 创建 web-shell 兜底 toast 容器；内部节点复用官方 toast-root 动画类。 */
  function ensureBridgeToastRoot() {
    if (!document || !document.body) return null;
    let root = document.getElementById("codex-web-toast-root");
    if (root) return root;
    root = document.createElement("div");
    root.id = "codex-web-toast-root";
    root.style.cssText = [
      "position:fixed",
      "top:16px",
      "left:0",
      "right:0",
      "z-index:2147483647",
      "display:flex",
      "flex-direction:column",
      "align-items:center",
      "gap:8px",
      "padding:0 16px",
      "pointer-events:none",
    ].join(";");
    document.body.appendChild(root);
    return root;
  }

  /** 使用官方 toast-root 的 exiting 状态触发同款退出动画。 */
  function removeBridgeToast(toast) {
    if (!toast) return;
    toast.dataset.state = "exiting";
    w.setTimeout(() => {
      try {
        toast.remove();
      } catch {}
    }, 260);
  }

  /** 官方 toast signal 不暴露给 polyfill，fetch 兜底只复用官方 Toast/Alert DOM 类名。 */
  function renderBridgeErrorToast(payload) {
    if (!document || !document.body) {
      w.setTimeout(() => renderBridgeErrorToast(payload), 0);
      return;
    }
    const root = ensureBridgeToastRoot();
    if (!root) return;
    const toast = document.createElement("div");
    toast.className = "toast-root";
    toast.dataset.state = "entered";
    toast.style.maxWidth = "min(520px, calc(100vw - 32px))";

    const alert = document.createElement("div");
    alert.className = [
      "alert-root",
      "inline-flex",
      "flex-row",
      "items-start",
      "gap-1.5",
      "rounded-2xl",
      "px-2",
      "py-2",
      "text-base",
      "leading-[1.4]",
      "pointer-events-auto",
      "box-shadow-lg",
      "border",
      "text-token-foreground",
      "border-token-input-validation-error-border",
      "bg-token-input-validation-error-background",
    ].join(" ");
    alert.setAttribute("role", "alert");
    alert.setAttribute("data-testid", "codex-web-fetch-ipc-error-toast");
    alert.style.maxWidth = "min(520px, calc(100vw - 32px))";

    const content = document.createElement("div");
    content.className = "flex-1 justify-center gap-2";

    const description = document.createElement("div");
    description.className = "font-medium";
    description.textContent = payload.description || "";
    description.style.whiteSpace = "pre-wrap";
    description.style.overflowWrap = "anywhere";
    content.appendChild(description);
    alert.appendChild(content);

    const close = document.createElement("button");
    close.type = "button";
    close.setAttribute("aria-label", "Close");
    close.textContent = "x";
    close.className =
      "mt-0.5 flex shrink-0 grow-0 cursor-interaction rounded-full opacity-50 hover:bg-token-button-secondary-hover-background/5 hover:opacity-80";
    close.addEventListener("click", () => removeBridgeToast(toast));
    alert.appendChild(close);

    toast.appendChild(alert);
    root.appendChild(toast);
    w.setTimeout(() => removeBridgeToast(toast), 8000);
  }

  /** fetch 形态没有稳定的官方业务 catch，这里才做同款 toast 兜底并短时间去重。 */
  function surfaceFetchIpcError(channel, payload) {
    if (!payload || typeof payload !== "object") return;
    const message = normalizeErrorMessage(payload.error);
    if (!message) return;
    const status = Number(payload.status || 0);
    if (!shouldSurfaceFetchIpcError(Number.isFinite(status) ? status : undefined, message)) return;
    const url = typeof payload.url === "string" && payload.url ? payload.url : channel;
    const key = `${url}:${message}`;
    const now = Date.now();
    if (ipcErrorToastState.lastKey === key && now - ipcErrorToastState.lastShownAtMs < 3000) {
      return;
    }
    ipcErrorToastState.lastKey = key;
    ipcErrorToastState.lastShownAtMs = now;
    const toastPayload = {
      level: "danger",
      source: "codex-web-gateway",
      description: `${url}: ${message}`,
    };

    // 先广播给可能存在的官方适配器；无人处理时再用官方类名兜底渲染。
    const delivered = dispatch("codex-web:toast", toastPayload);
    emitWindowMessage("codex-web:toast", toastPayload);
    if (delivered > 0) return;
    renderBridgeErrorToast(toastPayload);
  }

  /** 把 ArrayBuffer 转成 base64；分块处理避免大文件触发调用栈上限。 */
  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      const chunk = bytes.subarray(offset, offset + chunkSize);
      binary += String.fromCharCode.apply(null, chunk);
    }
    return btoa(binary);
  }

  /** 浏览器 File 对象不能暴露真实路径，所以只把文件名和内容交给 gateway 落盘。 */
  async function serializePickedFile(file) {
    return {
      name: file.name || "attachment",
      type: file.type || "",
      size: file.size,
      lastModified: file.lastModified,
      contentsBase64: arrayBufferToBase64(await file.arrayBuffer()),
    };
  }

  /** 使用浏览器原生 input[type=file] 实现官方 pick-files IPC 的选择动作。 */
  function openBrowserFilePicker(params) {
    return new Promise((resolve, reject) => {
      const input = document.createElement("input");
      let finished = false;

      input.type = "file";
      input.multiple = true;
      if (params && params.imagesOnly) input.accept = "image/*";
      input.style.position = "fixed";
      input.style.left = "-10000px";
      input.style.top = "-10000px";
      input.style.opacity = "0";

      const cleanup = () => {
        window.removeEventListener("focus", handleFocus, true);
        input.remove();
      };
      const finish = (files) => {
        if (finished) return;
        finished = true;
        cleanup();
        resolve(files);
      };
      function handleFocus() {
        // macOS 文件选择器取消时不一定触发 change，用重新聚焦后的空列表表示取消。
        window.setTimeout(() => {
          if (!finished && (!input.files || input.files.length === 0)) finish([]);
        }, 250);
      }

      input.addEventListener(
        "change",
        () => {
          finish(Array.from(input.files || []));
        },
        { once: true }
      );
      input.addEventListener("cancel", () => finish([]), { once: true });
      window.addEventListener("focus", handleFocus, true);

      try {
        (document.body || document.documentElement).appendChild(input);
        input.click();
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
  }

  /** 实现 pick-files：浏览器选文件，gateway 写临时文件并返回 renderer 需要的 fsPath。 */
  async function pickFilesInBrowser(payload) {
    const params = payload && typeof payload === "object" && payload.params ? payload.params : payload || {};
    const files = await openBrowserFilePicker(params);
    if (!files || files.length === 0) return { files: [] };
    const serialized = await Promise.all(files.map((file) => serializePickedFile(file)));
    return invokeGateway("pick-files", {
      params: {
        ...(params && typeof params === "object" ? params : {}),
        files: serialized,
      },
    });
  }

  /** 发送 fetch-response 给官方 vscode-api 请求管理器。 */
  function emitFetchResponse(payload) {
    dispatch("fetch-response", payload);
    emitWindowMessage("fetch-response", payload);
  }

  /** 成功响应 vscode://codex/... fetch IPC，bodyJsonString 必须是 JSON 字符串。 */
  function emitFetchSuccess(requestId, body) {
    emitFetchResponse({
      requestId,
      responseType: "success",
      status: 200,
      headers: { "content-type": "application/json" },
      bodyJsonString: JSON.stringify(body),
    });
  }

  /** 失败响应 vscode://codex/... fetch IPC，让官方 query/mutation 继续走原有错误 toast。 */
  function emitFetchError(requestId, error) {
    emitFetchResponse({
      requestId,
      responseType: "error",
      status: 500,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  /** 官方 renderer 通过 fetch 消息发起 pick-files；该能力必须在 web-shell 里触发浏览器 picker。 */
  function handlePickFilesFetchMessage(payload) {
    if (!payload || typeof payload !== "object") return false;
    if (payload.type !== "fetch" || payload.url !== "vscode://codex/pick-files") return false;
    const requestId = String(payload.requestId || "");
    let params = {};
    try {
      params = payload.body ? JSON.parse(payload.body) : {};
    } catch {}
    pickFilesInBrowser({ params })
      .then((result) => emitFetchSuccess(requestId, result))
      .catch((error) => emitFetchError(requestId, error));
    return true;
  }

  /** 短延迟 Promise，用于启动期 transient fetch 失败后的重试。 */
  function delay(ms) {
    return new Promise((resolve) => w.setTimeout(resolve, ms));
  }

  /** 只把浏览器网络层的瞬时失败视为可重试，HTTP 500 等业务错误不在这里吞。 */
  function isTransientGatewayFetchError(error) {
    const message = error instanceof Error ? error.message : String(error || "");
    return /failed to fetch|networkerror|load failed/i.test(message);
  }

  /** 判断 mcp-request 是否适合在浏览器未完全稳定时做短重试。 */
  function isRetryableMcpRequest(payload) {
    if (!payload || typeof payload !== "object") return false;
    if (payload.type !== "mcp-request" || !payload.request || typeof payload.request !== "object") return false;
    const method = String(payload.request.method || "");
    if (!method) return false;
    return !/^(turn\/start|thread\/start|approval\/|config\/batchWrite|account\/login\/|automation-|plugin\/install|skills\/install)/.test(method);
  }

  /** 判断 fetch-message 是否适合短重试；避免用户发送消息这类写操作被重复提交。 */
  function isRetryableFetchMessage(payload) {
    if (!payload || typeof payload !== "object" || payload.type !== "fetch") return false;
    const method = String(payload.method || "GET").toUpperCase();
    const url = String(payload.url || "");
    if (method === "GET") return true;
    return /^vscode:\/\/codex\/(paths-exist|git-origins|ide-context|get-global-state|set-global-state|get-configuration|set-configuration|get-settings|get-setting|set-setting|set-remote-control-connections-enabled)$/i.test(url);
  }

  /** 只对首屏/切换会话所需的安全 IPC 做短重试，避免第一次点击被 transient fetch 失败卡死。 */
  function shouldRetryGatewayInvoke(channel, payload) {
    if (channel !== "codex_desktop:message-from-view") return false;
    if (!payload || typeof payload !== "object") return false;
    if (payload.type === "shared-object-subscribe" || payload.type === "persisted-atom-sync-request") return true;
    return isRetryableMcpRequest(payload) || isRetryableFetchMessage(payload);
  }

  /** 只负责把 IPC 请求发给 gateway，不做 web-shell 侧能力拦截。 */
  async function invokeGateway(channel, payload) {
    const body = stringifyForIpc({ channel, payload, clientId });
    const retryDelays = shouldRetryGatewayInvoke(channel, payload) ? [0, 80, 250] : [0];
    let res = null;
    let lastFetchError = null;
    for (let attempt = 0; attempt < retryDelays.length; attempt += 1) {
      if (retryDelays[attempt] > 0) await delay(retryDelays[attempt]);
      try {
        res = await w.fetch("/api/ipc/invoke", {
          method: "POST",
          credentials: "same-origin",
          headers: gatewayAuthHeaders({ "content-type": "application/json" }),
          body,
        });
        lastFetchError = null;
        break;
      } catch (error) {
        lastFetchError = error;
        if (!isTransientGatewayFetchError(error) || attempt === retryDelays.length - 1) throw error;
      }
    }

    if (!res) throw lastFetchError || new Error("IPC invoke failed before request was sent");
    const json = await res.json().catch(() => null);
    if (!res.ok || (json && typeof json === "object" && json.ok === false)) {
      const message = ipcInvokeErrorMessage(channel, res.status, json);
      const error = new Error(message);
      error.channel = channel;
      error.status = res.status;
      error.response = json;
      throw error;
    }
    if (json && typeof json === "object" && Object.prototype.hasOwnProperty.call(json, "value")) {
      if (
        channel === "open-file" &&
        json.value &&
        typeof json.value === "object" &&
        typeof json.value.url === "string"
      ) {
        openPreviewInCodexSidePanel(json.value);
      }
      return json.value;
    }
    return json;
  }

  /** 模拟 Electron ipcRenderer.invoke，实际通过 gateway 的 /api/ipc/invoke 完成。 */
  async function invoke(channel, payload) {
    if (channel === "pick-files") return pickFilesInBrowser(payload);
    markMobileComposerPromptSent(channel, payload);
    return invokeGateway(channel, payload);
  }

  /** 终端消息按 sessionId 串行化，避免 write/resize/attach 乱序。 */
  function terminalSessionId(payload) {
    return payload && typeof payload === "object" && typeof payload.sessionId === "string"
      ? payload.sessionId
      : "__global__";
  }

  /** 对同一个终端 session 的 invoke 排队执行。 */
  function enqueueTerminalInvoke(sessionId, payload) {
    const previous = terminalMessageQueues.get(sessionId) || Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(() => invoke("codex_desktop:message-from-view", payload))
      .finally(() => {
        if (terminalMessageQueues.get(sessionId) === next) {
          terminalMessageQueues.delete(sessionId);
        }
      });
    terminalMessageQueues.set(sessionId, next);
    return next;
  }

  /** terminal-write 也走队列，避免输入字符和 attach/resize 交错。 */
  function enqueueTerminalWrite(payload) {
    const sessionId = terminalSessionId(payload);
    return enqueueTerminalInvoke(sessionId, payload);
  }

  /** 所有 terminal-* 消息统一进入 session 队列。 */
  function enqueueTerminalMessage(payload) {
    const sessionId =
      payload && typeof payload === "object" && typeof payload.sessionId === "string"
        ? payload.sessionId
        : "__global__";
    if (payload && typeof payload === "object" && payload.type === "terminal-write") {
      return enqueueTerminalWrite(payload);
    }
    return enqueueTerminalInvoke(sessionId, payload);
  }

  /** Electron shell.openExternal 的浏览器实现。 */
  function openExternal(url) {
    const newWindow = w.open(url, "_blank", "noopener,noreferrer");
    if (newWindow) return true;
    return true;
  }

  /** 清理旧的 web-shell 自定义预览面板，现在优先复用 Codex 右侧面板。 */
  function closeLegacyPreviewPanel() {
    const panel = document.getElementById("codex-web-file-preview");
    if (panel) panel.remove();
    const styles = document.getElementById("codex-web-file-preview-styles");
    if (styles) styles.remove();
  }

  /** 将 gateway 返回的相对预览 URL 转成绝对 URL。 */
  function normalizePreviewUrl(url) {
    if (typeof url !== "string" || !url) return null;
    try {
      return new URL(url, location.origin).href;
    } catch {
      return null;
    }
  }

  /** 复用 Codex 原本右侧 panel 打开文件预览。 */
  function openPreviewInCodexSidePanel(payload) {
    if (!payload || typeof payload !== "object" || typeof payload.url !== "string") return false;
    const url = normalizePreviewUrl(payload.url);
    if (!url) return false;
    closeLegacyPreviewPanel();
    const panelPayload = {
      open: true,
      url,
      source: "manual",
      initiator: "open_file_bridge",
    };
    const delivered = dispatch("toggle-browser-panel", panelPayload);
    emitWindowMessage("toggle-browser-panel", panelPayload);
    if (delivered === 0) {
      setTimeout(() => {
        dispatch("toggle-browser-panel", panelPayload);
        emitWindowMessage("toggle-browser-panel", panelPayload);
      }, 0);
    }
    return true;
  }

  /** 把 Desktop 专用 app://fs/@fs/... URL 转成 gateway 同源文件 URL。 */
  function appFsUrlToGatewayUrl(value) {
    if (typeof value !== "string" || !value.startsWith("app://fs/")) return null;
    try {
      const url = new URL(value);
      if (url.protocol !== "app:" || url.hostname !== "fs" || !url.pathname.startsWith("/@fs/")) return null;
      const decodedPath = decodeURIComponent(url.pathname.slice("/@fs/".length));
      const encodedPath = decodedPath
        .split("/")
        .filter((part, index) => index === 0 || part.length > 0)
        .map((part) => encodeURIComponent(part))
        .join("/");
      return new URL(`/api/app-fs/@fs/${encodedPath}`, location.origin).href;
    } catch {
      return null;
    }
  }

  /** 重写单个图片节点的 app://fs src，避免浏览器直接请求不支持的自定义协议。 */
  function rewriteAppFsImageElement(element) {
    if (!element || element.nodeType !== 1 || String(element.tagName || "").toLowerCase() !== "img") return;
    const rawSrc = element.getAttribute("src") || element.src || "";
    const rewritten = appFsUrlToGatewayUrl(rawSrc);
    if (!rewritten || element.getAttribute("src") === rewritten) return;
    element.setAttribute("data-codex-web-app-fs-src", rawSrc);
    element.setAttribute("src", rewritten);
  }

  /** 只扫描本次新增节点内部的 app://fs 图片，避免对整页 DOM 做全量遍历。 */
  function rewriteAppFsImagesInAddedNode(node) {
    rewriteAppFsImageElement(node);
    if (!node || node.nodeType !== 1 || typeof node.querySelectorAll !== "function") return;
    node.querySelectorAll("img[src^='app://fs/']").forEach((element) => rewriteAppFsImageElement(element));
  }

  /** 安装 MutationObserver，只处理新增图片节点和 src 更新，避免启动时全量扫描 DOM。 */
  function installAppFsImageRewrite() {
    if (!document || document.__codexAppFsImageRewriteInstalled) return;
    document.__codexAppFsImageRewriteInstalled = true;
    const start = () => {
      const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          if (mutation.type === "attributes") {
            rewriteAppFsImageElement(mutation.target);
            continue;
          }
          for (const node of mutation.addedNodes || []) {
            rewriteAppFsImagesInAddedNode(node);
          }
        }
      });
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["src"],
        childList: true,
        subtree: true,
      });
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", start, { once: true });
    } else {
      start();
    }
  }

  /** Electron window.setTitle 的浏览器实现。 */
  function setWindowTitle(title) {
    document.title = String(title || "");
    return true;
  }

  /** 归一化 account/updated，兼容官方 auth callback 需要的字段。 */
  function normalizeAuthStatus(payload) {
    const authMethod =
      payload && typeof payload === "object"
        ? payload.authMode || (payload.account && payload.account.type === "chatgpt" ? "chatgpt" : payload.account && payload.account.type === "apikey" ? "apikey" : null)
        : null;
    return {
      authMethod,
      openAIAuth: authMethod,
      account: payload && typeof payload === "object" ? payload.account || null : null,
      requiresOpenaiAuth:
        payload && typeof payload === "object" && Object.prototype.hasOwnProperty.call(payload, "requiresOpenaiAuth")
          ? !!payload.requiresOpenaiAuth
          : authMethod == null,
    };
  }

  /** 通知所有通过 addAuthStatusCallback 注册的监听器。 */
  function notifyAuthStatus(payload) {
    const status = normalizeAuthStatus(payload);
    for (const callback of [...authStatusCallbacks]) {
      try {
        callback(status);
      } catch (error) {
        console.error("[codex-web] auth status callback failed", error);
      }
    }
  }

  const sharedObjectSnapshot = new Map();

  /** 判断普通对象。 */
  function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  /** shared-object snapshot 写入前补齐 Web 必需 feature flag。 */
  function normalizeSharedObjectSnapshotValue(key, value) {
    if (key !== STATSIG_DEFAULT_FEATURES_CONFIG) return value;
    return {
      ...(isPlainObject(value) ? value : {}),
      ...STATSIG_DEFAULT_FEATURE_OVERRIDES,
    };
  }

  /** 更新本地 shared-object snapshot。 */
  function setSharedObjectSnapshotValue(key, value) {
    if (!key) return null;
    const normalized = normalizeSharedObjectSnapshotValue(key, value);
    sharedObjectSnapshot.set(key, normalized);
    return normalized;
  }

  /** 读取 shared-object snapshot，特定 key 会懒补默认值。 */
  function getSharedObjectSnapshotValue(key) {
    if (key === STATSIG_DEFAULT_FEATURES_CONFIG || sharedObjectSnapshot.has(key)) {
      return setSharedObjectSnapshotValue(key, sharedObjectSnapshot.get(key));
    }
    return null;
  }

  /** 异步发出 shared-object-updated，模拟官方订阅行为。 */
  function emitSharedObjectSnapshotValue(key) {
    const value = getSharedObjectSnapshotValue(key);
    if (value === null) return;
    queueMicrotask(() => dispatch("shared-object-updated", { key, value }));
  }

  /** 初始化 shared-object snapshot，合并 gateway 注入的首屏快照。 */
  function initializeSharedObjectSnapshot() {
    setSharedObjectSnapshotValue("host_config", { id: "local", kind: "local" });
    const snapshot =
      cfg.sharedObjectSnapshot && typeof cfg.sharedObjectSnapshot === "object"
        ? cfg.sharedObjectSnapshot
        : {};
    for (const [key, value] of Object.entries(snapshot)) {
      setSharedObjectSnapshotValue(key, value);
    }
    getSharedObjectSnapshotValue(STATSIG_DEFAULT_FEATURES_CONFIG);
  }

  initializeSharedObjectSnapshot();

  /** 把 Electron/Codex bridge API 挂到多个官方可能访问的全局对象上。 */
  function attachBridge(target) {
    target.invoke = invoke;
    target.on = (channel, handler) => subscribe(channel, handler);
    target.off = (channel, handler) => unsubscribe(channel, handler);
    target.subscribe = target.on;
    target.unsubscribe = target.off;
    target.getPlatform = () => "web";
    target.getVersion = () => "web-poc";
    target.openExternal = (url) => openExternal(url);
    target.setWindowTitle = (title) => setWindowTitle(title);
    target.getAccount = () => invoke("account-info");
    target.addAuthStatusCallback = (callback) => {
      if (typeof callback !== "function") return () => {};
      authStatusCallbacks.add(callback);
      return () => authStatusCallbacks.delete(callback);
    };
    target.removeAuthStatusCallback = (callback) => {
      authStatusCallbacks.delete(callback);
    };
    target.send = (channel, payload) => invoke(channel, payload);
    target.dispatchMessage = (channel, payload) => {
      const message =
        payload && typeof payload === "object"
          ? { type: channel, ...payload }
          : { type: channel, payload };
      return target.sendMessageFromView(message);
    };
    target.getPathForFile = (file) => {
      if (typeof file === "string") return file;
      if (file && typeof file === "object" && typeof file.path === "string") return file.path;
      return null;
    };
    target.sendMessageFromView = async (payload) =>
      Promise.resolve().then(() => {
        if (payload && typeof payload === "object" && payload.type === "shared-object-set") {
          // shared-object 的本地快照先同步更新，再交给 gateway 持久化。
          const value = setSharedObjectSnapshotValue(payload.key, payload.value);
          dispatch("shared-object-updated", { ...payload, value });
        }
        if (payload && typeof payload === "object" && payload.type === "shared-object-subscribe" && payload.key) {
          emitSharedObjectSnapshotValue(payload.key);
        }
        if (payload && typeof payload === "object" && payload.type === "open-in-browser" && payload.url) {
          return openExternal(payload.url);
        }
        if (handleModelListMcpRequest(payload)) {
          return true;
        }
        trackPendingMcpRequest(payload);
        if (handlePickFilesFetchMessage(payload)) {
          return true;
        }
        collapseMobileSidebarAfterNewConversation(payload);
        if (
          payload &&
          typeof payload === "object" &&
          typeof payload.type === "string" &&
          payload.type.startsWith("terminal-")
        ) {
          return enqueueTerminalMessage(payload);
        }
        return invoke("codex_desktop:message-from-view", payload);
      });
    target.sendWorkerMessageFromView = async (workerId, payload) =>
      invoke(`codex_desktop:worker:${workerId}:from-view`, payload);
    target.subscribeToWorkerMessages = (workerId, handler) =>
      subscribe(`codex_desktop:worker:${workerId}:for-view`, handler);
    target.getBuildFlavor = () => "prod";
    target.getSentryInitOptions = () => ({
      enabled: false,
      appVersion: "0.0.0-web-poc",
      codexAppSessionId: target.getAppSessionId(),
    });
    target.getSystemThemeVariant = () => {
      const mq = w.matchMedia?.("(prefers-color-scheme: dark)");
      return mq && mq.matches ? "dark" : "light";
    };
    target.getAppSessionId = () => {
      const key = "__codex_web_session_id__";
      let id = localStorage.getItem(key);
      if (!id) {
        id = w.crypto?.randomUUID?.() || `web-${Math.random().toString(36).slice(2)}`;
        localStorage.setItem(key, id);
      }
      return id;
    };
    target.getSharedObjectSnapshotValue = (key) => getSharedObjectSnapshotValue(key);
    target.showContextMenu = () => true;
    target.showApplicationMenu = () => true;
    target.triggerSentryTestError = () => {
      console.warn("[codex-web] triggerSentryTestError is a no-op in web");
      return false;
    };
    target.subscribeToSystemThemeVariant = (handler) => {
      const mq = w.matchMedia?.("(prefers-color-scheme: dark)");
      if (!mq) return () => {};
      const emit = () => handler(mq.matches ? "dark" : "light");
      emit();
      mq.addEventListener("change", emit);
      return () => mq.removeEventListener("change", emit);
    };
  }

  w.codexBridge = w.codexBridge || {};
  w.electronAPI = w.electronAPI || {};
  w.electronBridge = w.electronBridge || {};
  w.__TAURI__ = undefined;
  w.global = w.global || w;
  w.process = w.process || {
    env: {},
    platform: "browser",
    versions: {
      electron: "0.0.0-web-poc",
      node: "0.0.0-web-poc",
      chrome: "0.0.0-web-poc",
    },
  };
  w.codexWindowType = w.codexWindowType || "electron";

  /** 浏览器直连 Statsig/遥测在受限网络下会刷 console error；Web 侧用本地默认值兜底。 */
  function buildStatsigInitializeResponse() {
    const feature_gates = {};
    const dynamic_configs = {
      [STATSIG_DEFAULT_FEATURES_CONFIG]: {
        name: STATSIG_DEFAULT_FEATURES_CONFIG,
        value: { ...STATSIG_DEFAULT_FEATURE_OVERRIDES },
        rule_id: "gateway_override",
        secondary_exposures: [],
      },
    };
    for (const [name, value] of Object.entries(STATSIG_DEFAULT_FEATURE_OVERRIDES)) {
      feature_gates[name] = {
        name,
        value,
        rule_id: "gateway_override",
        secondary_exposures: [],
      };
    }
    return {
      has_updates: true,
      time: Date.now(),
      hash_used: "djb2",
      feature_gates,
      dynamic_configs,
      layer_configs: {
        [STATSIG_I18N_LAYER_CONFIG]: {
          name: STATSIG_I18N_LAYER_CONFIG,
          value: { ...STATSIG_I18N_LAYER_VALUES },
          rule_id: "gateway_override",
          secondary_exposures: [],
        },
      },
      param_stores: {},
      exposures: {},
      sdk_flags: {},
    };
  }

  function isStatsigInitializeUrl(url) {
    try {
      const parsed = new URL(url, location.href);
      return parsed.hostname === "ab.chatgpt.com" && parsed.pathname.replace(/\/+$/, "") === "/v1/initialize";
    } catch {
      return false;
    }
  }

  function isTelemetryRegisterUrl(url) {
    try {
      const parsed = new URL(url, location.href);
      const pathname = parsed.pathname.replace(/\/+$/, "");
      return parsed.hostname === "chatgpt.com" && (pathname === "/ces/v1/rgstr" || pathname === "/ces/v1/log_event");
    } catch {
      return false;
    }
  }

  // sentry-ipc:// 是 Electron 私有协议，浏览器里用空响应兜底，避免 renderer 报错。
  if (typeof w.fetch === "function" && !w.__codexWebFetchPatched) {
    const originalFetch = w.fetch.bind(w);
    w.fetch = async (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input && typeof input === "object" && "url" in input
            ? String(input.url || "")
            : "";
      if (url.startsWith("sentry-ipc://")) {
        return new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (isStatsigInitializeUrl(url)) {
        return new Response(JSON.stringify(buildStatsigInitializeResponse()), {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
      if (isTelemetryRegisterUrl(url)) {
        return new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
      return originalFetch(input, init);
    };
    w.__codexWebFetchPatched = true;
  }

  // 官方 bundle 仍可能 require("electron"/"path"/"os")，这里提供浏览器安全替身。
  if (typeof w.require !== "function") {
    w.require = (name) => {
      if (name === "electron") {
        return {
          ipcRenderer: w.electronBridge,
          shell: { openExternal },
          contextBridge: { exposeInMainWorld() {} },
        };
      }
      if (name === "path") {
        return {
          join: (...parts) =>
            parts
              .filter((part) => part !== null && part !== undefined)
              .map(String)
              .join("/")
              .replace(/\/+/g, "/"),
          basename: (p) => String(p).split(/[\\/]/).filter(Boolean).pop() || "",
          dirname: (p) => {
            const parts = String(p).split(/[\\/]/).filter(Boolean);
            parts.pop();
            return parts.join("/") || "/";
          },
        };
      }
      if (name === "os") {
        const homeDir =
          typeof cfg.homeDir === "string" && cfg.homeDir
            ? cfg.homeDir
            : Array.isArray(cfg.workspaceRoots) && typeof cfg.workspaceRoots[0] === "string"
              ? cfg.workspaceRoots[0].split("/").slice(0, 3).join("/") || "/"
              : "/";
        return { platform: () => "browser", homedir: () => homeDir };
      }
      if (name === "process") return w.process;
      console.warn("[codex-web] unhandled require:", name);
      return {};
    };
  }

  attachBridge(w.codexBridge);
  attachBridge(w.electronAPI);
  attachBridge(w.electronBridge);
  installAppFsImageRewrite();

  subscribe("window:setTitle", (title) => setWindowTitle(title));
  subscribe("account/updated", (payload) => notifyAuthStatus(payload));
  subscribe("codex_desktop:system-theme-variant-updated", (value) => {
    if (value === "dark" || value === "light") {
      document.documentElement.dataset.theme = value;
    }
  });
  subscribe("shared-object-updated", (message) => {
    if (message && typeof message === "object" && message.key) {
      setSharedObjectSnapshotValue(message.key, message.value);
    }
  });

  w.__codexWebSubscribe = subscribe;
  w.__codexWebUnsubscribe = unsubscribe;
  w.__codexWebDispatch = dispatch;
  w.__codexWebPayloadShape = payloadShape;
  scheduleModelListPreload();

  /** 建立到 gateway 的 WebSocket，接收 app-server/业务广播事件。 */
  function connect() {
    if (!cfg.gatewayWsUrl || !("WebSocket" in w)) return;
    try {
      ws = new WebSocket(cfg.gatewayWsUrl || "");
    } catch (error) {
      console.warn("[codex-web] failed to open gateway socket", error);
      scheduleReconnect();
      return;
    }

    ws.addEventListener("open", () => {
      // hello 会把本页面 clientId 注册到 gateway，后续审批/fetch 响应才能定向回来。
      reconnectDelay = 500;
      try {
        ws.send(JSON.stringify({ type: "hello", clientId }));
      } catch {}
      emitSharedObjectSnapshotValue(STATSIG_DEFAULT_FEATURES_CONFIG);
    });
    ws.addEventListener("message", (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg && typeof msg.channel === "string") {
          if (shouldClearModelListCache(msg.channel, msg.payload)) {
            clearModelListCache();
          }
          if (msg.channel === "codex-web:preview-file") {
            // 文件预览是 web-shell 扩展事件，直接打开右侧 Codex panel。
            openPreviewInCodexSidePanel(msg.payload);
            return;
          }
          // vscode://codex/... 这类 fetch IPC 的失败只会从 WebSocket 回来，这里统一转成页面错误 toast。
          if (msg.channel === "fetch-response" && msg.payload && msg.payload.responseType === "error") {
            surfaceFetchIpcError("fetch-response", msg.payload);
          }
          if (msg.channel === "fetch-stream-error") {
            surfaceFetchIpcError("fetch-stream-error", msg.payload);
          }
          if (msg.channel !== "mcp-response" && msg.channel !== "mcp-notification") {
            dispatch(msg.channel, msg.payload);
          }
          emitWindowMessage(msg.channel, msg.payload);
        }
      } catch (error) {
        console.warn("[codex-web] invalid gateway message", error);
      }
    });
    ws.addEventListener("close", () => scheduleReconnect());
    ws.addEventListener("error", () => {
      try {
        ws.close();
      } catch {}
    });
  }

  /** WebSocket 断开后的指数退避重连。 */
  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      reconnectDelay = Math.min(reconnectDelay * 2, 5000);
      connect();
    }, reconnectDelay);
  }

  connect();
})();
