(function () {
  const w = window;
  const activeRoot = document.documentElement || null;
  const previousInstallState = w.__opencodexWindowControlsOverlayState;
  if (previousInstallState?.document === document && previousInstallState?.root === activeRoot) return;
  try {
    previousInstallState?.cleanup?.();
  } catch {
    // 旧页面可能已经被 document.write 清空，清理失败时不能阻断当前页面重新安装。
  }
  // Web shell 会先加载登录壳，再用 document.write 写入官方 renderer；guard 必须跟随当前根节点。
  const installState = { document, root: activeRoot, cleanup: null };
  w.__opencodexWindowControlsOverlayState = installState;

  /**
   * PWA window-controls-overlay 会把页面铺到系统标题栏下方。
   *
   * 官方 renderer 的 header 默认横跨整窗；Web shell 这里把浏览器 WCO 几何信息
   * 翻译成可用标题栏矩形，避免左上/右上工具按钮被系统窗口按钮压住。
   */
  function installWindowControlsOverlaySafeArea() {
    if (!document || !document.documentElement) return null;
    const overlay = navigator.windowControlsOverlay || null;
    const displayModeQuery =
      typeof w.matchMedia === "function" ? w.matchMedia("(display-mode: window-controls-overlay)") : null;
    const root = document.documentElement;
    const rootStyle = root.style;
    const cleanupHandlers = [];

    function addCleanup(handler) {
      if (typeof handler === "function") cleanupHandlers.push(handler);
    }

    function roundPixel(value) {
      return Math.max(0, Math.round(Number(value) || 0));
    }

    let cssLengthProbe = null;

    function measureCssLength(value) {
      if (!cssLengthProbe) {
        cssLengthProbe = document.createElement("div");
        cssLengthProbe.style.cssText =
          "position:fixed;left:-10000px;top:-10000px;height:0;visibility:hidden;pointer-events:none;contain:strict;";
        (document.body || document.documentElement).appendChild(cssLengthProbe);
      }
      cssLengthProbe.style.width = value;
      return roundPixel(cssLengthProbe.getBoundingClientRect().width);
    }

    function envInsets() {
      const titlebarX = measureCssLength("var(--opencodex-wco-env-titlebar-x)");
      const titlebarWidth = measureCssLength("var(--opencodex-wco-env-titlebar-width)");
      return {
        left: titlebarX,
        right: measureCssLength("var(--opencodex-wco-env-right)"),
        top: measureCssLength("var(--opencodex-wco-env-top)"),
        height: measureCssLength("var(--opencodex-wco-env-height)"),
        titlebarEnd: titlebarX + titlebarWidth,
        titlebarWidth,
        titlebarX,
      };
    }

    function insetsFromRect(rect) {
      const width = w.innerWidth || document.documentElement.clientWidth || 0;
      return {
        left: rect.x,
        right: Math.max(0, width - rect.x - rect.width),
        top: rect.y,
        height: rect.height,
        titlebarEnd: rect.x + rect.width,
        titlebarWidth: rect.width,
        titlebarX: rect.x,
      };
    }

    function ensureOverrideStyles() {
      if (document.getElementById("codex-web-window-controls-overlay-styles")) return;
      const link = document.createElement("link");
      link.id = "codex-web-window-controls-overlay-styles";
      link.rel = "stylesheet";
      link.href = "/codex-window-controls-overlay.css";
      // WCO 适配样式体积较大，独立 CSS 文件比塞进 polyfill 更容易维护。
      (document.head || document.documentElement).appendChild(link);
    }

    function setInsets(visible, insets) {
      const rawInsets = insets || { left: 0, right: 0, top: 0, height: 0 };
      const cssInsets = visible
        ? envInsets()
        : { left: 0, right: 0, top: 0, height: 0, titlebarEnd: 0, titlebarWidth: 0, titlebarX: 0 };
      const rawTitlebarWidth = roundPixel(rawInsets.titlebarWidth);
      const titlebarSource = rawTitlebarWidth > 0 ? rawInsets : cssInsets;
      // left/right 作为禁区避让值取较大值；titlebar 矩形保持同一来源，避免 x 和 width 拼出错误区域。
      const nextInsets = {
        left: Math.max(roundPixel(rawInsets.left), cssInsets.left),
        right: Math.max(roundPixel(rawInsets.right), cssInsets.right),
        top: Math.max(roundPixel(rawInsets.top), cssInsets.top),
        height: Math.max(roundPixel(rawInsets.height), cssInsets.height),
        titlebarEnd: roundPixel(titlebarSource.titlebarEnd),
        titlebarWidth: roundPixel(titlebarSource.titlebarWidth),
        titlebarX: roundPixel(titlebarSource.titlebarX),
      };
      root.dataset.opencodexWcoVisible = visible ? "true" : "false";
      if (!insets) {
        // JS rect 不可用时，删除 inline 覆盖，让上面的 CSS env(titlebar-area-*) 继续提供 WCO 数据。
        removeManagedRootStyle("--opencodex-wco-left");
        removeManagedRootStyle("--opencodex-wco-right");
        removeManagedRootStyle("--opencodex-wco-top");
        removeManagedRootStyle("--opencodex-wco-height");
        removeManagedRootStyle("--opencodex-wco-titlebar-x");
        removeManagedRootStyle("--opencodex-wco-titlebar-width");
        removeManagedRootStyle("--spacing-token-safe-header-left");
        removeManagedRootStyle("--spacing-token-safe-header-right");
        removeManagedRootStyle("--safe-area-left");
        removeManagedRootStyle("--safe-area-right");
        return;
      }
      setManagedRootStyle("--opencodex-wco-left", `${nextInsets.left}px`);
      setManagedRootStyle("--opencodex-wco-right", `${nextInsets.right}px`);
      setManagedRootStyle("--opencodex-wco-top", `${nextInsets.top}px`);
      setManagedRootStyle("--opencodex-wco-height", `${nextInsets.height}px`);
      setManagedRootStyle("--opencodex-wco-titlebar-x", `${nextInsets.titlebarX}px`);
      setManagedRootStyle("--opencodex-wco-titlebar-width", `${nextInsets.titlebarWidth}px`);
      setManagedRootStyle("--spacing-token-safe-header-left", "0px");
      setManagedRootStyle("--spacing-token-safe-header-right", "0px");
      removeManagedRootStyle("--safe-area-left");
      removeManagedRootStyle("--safe-area-right");
    }

    let rightHeaderSlotMetricsQueued = false;
    let metricFrameId = null;
    let metricTimeoutId = null;
    let managedThemeColorState = null;
    let windowControlsThemeColor = "";
    let imagePreviewThemeColor = "";
    let cssColorProbe = null;
    let mutationObserver = null;
    let managedRootStyleMutationBudget = 0;
    let resizeObserver = null;
    let heavyObserversActive = false;
    let inactiveMetricsSynced = false;
    let currentImagePreviewRoot = null;
    const METRIC_MOUNT_SELECTOR = [
      "header[data-app-shell-header-edge-scroll]",
      'aside[data-app-shell-focus-area="right-panel"]',
      '[data-app-shell-tab-strip-controller="right"]',
      '[data-testid="image-preview-dismiss-area"]',
    ].join(",");

    function setManagedRootStyle(name, value) {
      const nextValue = String(value);
      if (rootStyle.getPropertyValue(name) === nextValue) return;
      // 每次实际自写对应一个 style MutationRecord，observer 据此只过滤自身产生的记录。
      if (mutationObserver) managedRootStyleMutationBudget += 1;
      rootStyle.setProperty(name, nextValue);
    }

    function removeManagedRootStyle(name) {
      if (!rootStyle.getPropertyValue(name)) return;
      if (mutationObserver) managedRootStyleMutationBudget += 1;
      rootStyle.removeProperty(name);
    }

    function parseRgbColor(value) {
      const match = String(value || "").match(/rgba?\(([^)]+)\)/i);
      if (!match) return null;
      const [channelsPart, slashAlpha] = match[1].split("/");
      const parts = channelsPart.includes(",")
        ? channelsPart.split(",").map((part) => part.trim())
        : channelsPart.trim().split(/\s+/);
      const channels = parts.slice(0, 3).map((part) => Number.parseFloat(part));
      if (channels.length !== 3 || !channels.every((part) => Number.isFinite(part))) return null;
      const alphaSource = slashAlpha ?? parts[3] ?? "";
      const parsedAlpha = alphaSource.trim().endsWith("%")
        ? Number.parseFloat(alphaSource) / 100
        : Number.parseFloat(alphaSource);
      const alpha = Number.isFinite(parsedAlpha) ? parsedAlpha : 1;
      return { alpha, channels };
    }

    function visibleCssColor(value) {
      if (!value || value === "transparent") return false;
      const rgb = parseRgbColor(value);
      return !rgb || rgb.alpha > 0;
    }

    function colorSchemeFromCssColor(value) {
      const rgb = parseRgbColor(value);
      if (!rgb) return fallbackColorScheme();
      const { channels } = rgb;
      const [red, green, blue] = channels.map((channel) => {
        const normalized = Math.max(0, Math.min(255, channel)) / 255;
        return normalized <= 0.03928
          ? normalized / 12.92
          : Math.pow((normalized + 0.055) / 1.055, 2.4);
      });
      // WCO 只需要知道标题栏更接近亮色还是暗色，阈值按相对亮度判断。
      const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
      return luminance < 0.5 ? "dark" : "light";
    }

    function fallbackColorScheme() {
      const explicitTheme = root.dataset.theme;
      if (explicitTheme === "dark" || explicitTheme === "light") return explicitTheme;
      if (root.classList.contains("electron-dark") || root.classList.contains("dark")) return "dark";
      if (root.classList.contains("electron-light") || root.classList.contains("light")) return "light";
      const media = typeof w.matchMedia === "function" ? w.matchMedia("(prefers-color-scheme: dark)") : null;
      return media?.matches ? "dark" : "light";
    }

    function resolveCssColor(value) {
      const color = String(value || "").trim();
      if (!color) return "";
      if (!cssColorProbe) {
        cssColorProbe = document.createElement("div");
        cssColorProbe.style.cssText =
          "position:fixed;left:-10000px;top:-10000px;width:1px;height:1px;visibility:hidden;pointer-events:none;contain:strict;";
        (document.body || document.documentElement).appendChild(cssColorProbe);
      }
      cssColorProbe.style.backgroundColor = "";
      cssColorProbe.style.backgroundColor = color;
      const resolved = w.getComputedStyle(cssColorProbe).backgroundColor;
      return visibleCssColor(resolved) ? resolved : "";
    }

    function findSurfaceColorFromElement(element, minWidth) {
      for (let node = element; node instanceof HTMLElement; node = node.parentElement) {
        const color = resolveCssColor(w.getComputedStyle(node).backgroundColor);
        if (!color) continue;
        const rect = node === document.body ? document.documentElement.getBoundingClientRect() : node.getBoundingClientRect();
        const isPageSurface =
          node === document.body ||
          node === document.documentElement ||
          rect.width >= minWidth ||
          rect.height >= Math.max(1, measureCssLength("var(--opencodex-wco-height)")) * 2;
        if (isPageSurface) return color;
      }
      return "";
    }

    function findSurfaceColorAtPoint(x, y, minWidth) {
      const element = document.elementFromPoint(
        Math.max(0, Math.min(w.innerWidth - 1, x)),
        Math.max(0, Math.min(w.innerHeight - 1, y))
      );
      return element instanceof HTMLElement ? findSurfaceColorFromElement(element, minWidth) : "";
    }

    function findTokenSurfaceColor() {
      const computedRoot = w.getComputedStyle(root);
      const tokenNames = [
        "--color-token-main-surface-primary",
        "--color-background-surface-under",
        "--color-token-bg-primary",
        "--color-bg-primary",
        "--vscode-editor-background",
      ];
      for (const tokenName of tokenNames) {
        const color = resolveCssColor(computedRoot.getPropertyValue(tokenName));
        if (color) return color;
      }
      return resolveCssColor(w.getComputedStyle(document.body).backgroundColor) ||
        resolveCssColor(computedRoot.backgroundColor);
    }

    function findWindowControlsTitlebarColors() {
      const viewportWidth = w.innerWidth || document.documentElement.clientWidth || 0;
      const viewportHeight = w.innerHeight || document.documentElement.clientHeight || 0;
      const leftInset = measureCssLength("var(--opencodex-wco-left)");
      const rightInset = measureCssLength("var(--opencodex-wco-right)");
      const titlebarX = measureCssLength("var(--opencodex-wco-titlebar-x)");
      const titlebarWidth = measureCssLength("var(--opencodex-wco-titlebar-width)");
      const titlebarTop = measureCssLength("var(--opencodex-wco-top)");
      const titlebarHeight = Math.max(1, measureCssLength("var(--opencodex-wco-height)"));
      const probeY = Math.max(0, Math.min(viewportHeight - 1, titlebarTop + titlebarHeight / 2));
      const minSurfaceWidth = Math.max(titlebarHeight * 3, Math.min(viewportWidth, titlebarWidth) * 0.12);
      const header = document.querySelector("header[data-app-shell-header-edge-scroll]");
      const fallback = findTokenSurfaceColor();
      const centerX =
        titlebarWidth > 0
          ? titlebarX + Math.max(1, Math.min(titlebarWidth - 1, titlebarWidth / 2))
          : viewportWidth / 2;
      const centerColor =
        findSurfaceColorAtPoint(centerX, probeY, minSurfaceWidth) ||
        (header instanceof HTMLElement ? findSurfaceColorFromElement(header, minSurfaceWidth) : "") ||
        fallback;
      const leftColor =
        leftInset > 0 ? findSurfaceColorAtPoint(leftInset / 2, probeY, minSurfaceWidth) || centerColor : centerColor;
      const rightColor =
        rightInset > 0
          ? findSurfaceColorAtPoint(viewportWidth - rightInset / 2, probeY, minSurfaceWidth) || centerColor
          : centerColor;
      // theme-color 只能设置单色，优先取右侧系统按钮区域的真实表面色；补底层仍分别使用左右采样色。
      const themeColor = rightColor || leftColor || centerColor;
      return {
        centerColor,
        leftColor,
        rightColor,
        themeColor,
      };
    }

    function setWindowControlsThemeColor(color) {
      windowControlsThemeColor = color || "";
      applyManagedThemeColor();
    }

    function setImagePreviewThemeColor(color) {
      imagePreviewThemeColor = color || "";
      applyManagedThemeColor();
    }

    function applyManagedThemeColor() {
      const color =
        root.dataset.opencodexWcoVisible === "true" ? imagePreviewThemeColor || windowControlsThemeColor : "";
      if (!color) {
        if (managedThemeColorState) {
          const { created, meta, previousContent } = managedThemeColorState;
          if (created) {
            meta.remove();
          } else if (previousContent == null) {
            meta.removeAttribute("content");
          } else {
            meta.setAttribute("content", previousContent);
          }
          managedThemeColorState = null;
        }
        return;
      }
      let meta = document.querySelector('meta[name="theme-color"]');
      let created = false;
      if (!meta) {
        meta = document.createElement("meta");
        meta.setAttribute("name", "theme-color");
        document.head?.appendChild(meta);
        created = true;
      }
      if (!managedThemeColorState || managedThemeColorState.meta !== meta) {
        managedThemeColorState = {
          created,
          meta,
          previousContent: meta.getAttribute("content"),
        };
      }
      // Chrome PWA 会参考 theme-color 绘制 WCO 标题栏底色，这里统一管理普通标题栏和图片预览遮罩。
      meta.setAttribute("content", color);
    }

    function syncWindowControlsThemeState() {
      if (root.dataset.opencodexWcoVisible !== "true") {
        setWindowControlsThemeColor("");
        root.removeAttribute("data-opencodex-wco-titlebar-scheme");
        return;
      }
      const { centerColor, leftColor, rightColor, themeColor } = findWindowControlsTitlebarColors();
      if (centerColor) setManagedRootStyle("--opencodex-wco-titlebar-background", centerColor);
      if (leftColor) setManagedRootStyle("--opencodex-wco-titlebar-left-background", leftColor);
      if (rightColor) setManagedRootStyle("--opencodex-wco-titlebar-right-background", rightColor);
      root.dataset.opencodexWcoTitlebarScheme = themeColor ? colorSchemeFromCssColor(themeColor) : fallbackColorScheme();
      setWindowControlsThemeColor(themeColor);
    }

    function findImagePreviewScrimColor(previewRoot) {
      const viewportWidth = w.innerWidth || document.documentElement.clientWidth || 0;
      const viewportHeight = w.innerHeight || document.documentElement.clientHeight || 0;
      const candidates = new Set();
      for (let node = previewRoot; node instanceof HTMLElement; node = node.parentElement) {
        const parent = node.parentElement;
        if (!parent) break;
        for (const child of parent.children) {
          if (child instanceof HTMLElement && child !== node && !node.contains(child)) {
            candidates.add(child);
          }
        }
        if (parent === document.body) break;
      }
      for (const candidate of candidates) {
        const style = w.getComputedStyle(candidate);
        if (style.display === "none" || style.visibility === "hidden") continue;
        if (style.position !== "fixed" && style.position !== "absolute") continue;
        if (!visibleCssColor(style.backgroundColor)) continue;
        const rect = candidate.getBoundingClientRect();
        const coversViewport =
          rect.width >= viewportWidth * 0.8 &&
          rect.height >= viewportHeight * 0.8 &&
          rect.left <= viewportWidth * 0.1 &&
          rect.top <= viewportHeight * 0.1;
        if (coversViewport) return style.backgroundColor;
      }
      return "";
    }

    function syncImagePreviewOverlayState() {
      const dismissArea = document.querySelector('[data-testid="image-preview-dismiss-area"]');
      const previewRoot = dismissArea?.parentElement instanceof HTMLElement ? dismissArea.parentElement : null;
      currentImagePreviewRoot = previewRoot;
      const scrimColor = previewRoot ? findImagePreviewScrimColor(previewRoot) : "";
      root.dataset.opencodexWcoImagePreviewOpen = previewRoot ? "true" : "false";
      root.dataset.opencodexWcoImagePreviewScheme = scrimColor ? colorSchemeFromCssColor(scrimColor) : "";
      if (scrimColor) {
        setManagedRootStyle("--opencodex-wco-image-preview-scrim", scrimColor);
      } else {
        removeManagedRootStyle("--opencodex-wco-image-preview-scrim");
      }
      setImagePreviewThemeColor(root.dataset.opencodexWcoVisible === "true" ? scrimColor : "");

      for (const node of document.querySelectorAll('[data-opencodex-wco-image-preview="true"]')) {
        if (node !== previewRoot) node.removeAttribute("data-opencodex-wco-image-preview");
      }
      for (const node of document.querySelectorAll('[data-opencodex-wco-image-preview-controls="true"]')) {
        node.removeAttribute("data-opencodex-wco-image-preview-controls");
      }
      if (!previewRoot) return;

      previewRoot.setAttribute("data-opencodex-wco-image-preview", "true");
      const controls = Array.from(previewRoot.children).find((child) => {
        if (!(child instanceof HTMLElement)) return false;
        return child.classList.contains("top-3") && child.classList.contains("right-3") && child.querySelector("a,button");
      });
      // 官方图片预览没有稳定 test id，这里按直接子节点的 top/right 工具条特征补一个稳定标记。
      controls?.setAttribute("data-opencodex-wco-image-preview-controls", "true");
    }

    function syncRightHeaderSlotMetrics() {
      rightHeaderSlotMetricsQueued = false;
      const header = document.querySelector("header[data-app-shell-header-edge-scroll]");
      const slot =
        header?.querySelector(':scope > [data-test-id="header-shell-slot"]:last-child') ||
        document.querySelector('header[data-app-shell-header-edge-scroll] > [data-test-id="header-shell-slot"]:last-child');
      const inner = slot?.firstElementChild;
      let fixedWidth = 0;
      let leadingWidth = 0;
      if (inner) {
        const children = Array.from(inner.children);
        const fixedIndex = children.findIndex((child) => child.classList.contains("ms-auto"));
        const hasLeading = fixedIndex > 0;
        slot.toggleAttribute("data-opencodex-wco-has-leading", hasLeading);
        header?.toggleAttribute("data-opencodex-wco-has-right-leading", hasLeading);
        for (const [index, child] of children.entries()) {
          const isLeading = hasLeading && index < fixedIndex;
          const isFixed = hasLeading && index >= fixedIndex;
          // 官方 DOM 没有把「可收缩标签区」包成一组，这里按 .ms-auto 分界补充稳定标记。
          child.toggleAttribute("data-opencodex-wco-leading", isLeading);
          child.toggleAttribute("data-opencodex-wco-fixed", isFixed);
        }
        if (hasLeading) {
          const fixedChildren = children.slice(fixedIndex);
          const fixedRects = fixedChildren
            .map((child) => child.getBoundingClientRect())
            .filter((rect) => rect.width > 0 || rect.height > 0);
          if (fixedRects.length > 0) {
            const fixedLeft = Math.min(...fixedRects.map((rect) => rect.left));
            const fixedRight = Math.max(...fixedRects.map((rect) => rect.right));
            const headerRect = header?.getBoundingClientRect();
            const innerRect = inner.getBoundingClientRect();
            const slotRect = slot.getBoundingClientRect();
            const innerStyle = w.getComputedStyle(inner);
            const gap = Math.max(
              0,
              Number.parseFloat(innerStyle.columnGap || innerStyle.gap || "0") || 0
            );
            const visibleSlotRight = Math.min(slotRect.right, headerRect?.right ?? slotRect.right);
            // 固定按钮组要连同右侧 padding 一起保留，避免默认按钮再次被标题栏裁掉。
            fixedWidth = Math.ceil(Math.max(0, visibleSlotRight - fixedLeft));
            // 侧栏标签的右边界直接取固定按钮左边界，扣掉 flex gap 后不会再压到按钮上。
            const leadingRight = Math.min(fixedLeft, visibleSlotRight - Math.max(0, fixedRight - fixedLeft));
            leadingWidth = Math.max(0, Math.floor(leadingRight - innerRect.left - gap));
          }
        }
      } else if (slot) {
        slot.removeAttribute("data-opencodex-wco-has-leading");
        header?.removeAttribute("data-opencodex-wco-has-right-leading");
      } else {
        header?.removeAttribute("data-opencodex-wco-has-right-leading");
      }
      const nextSlotMin = `${fixedWidth}px`;
      if (rootStyle.getPropertyValue("--opencodex-wco-right-slot-min") !== nextSlotMin) {
        setManagedRootStyle("--opencodex-wco-right-slot-min", nextSlotMin);
      }
      const nextLeadingMax = `${leadingWidth}px`;
      if (rootStyle.getPropertyValue("--opencodex-wco-leading-max") !== nextLeadingMax) {
        setManagedRootStyle("--opencodex-wco-leading-max", nextLeadingMax);
      }
    }

    function syncRightPanelTabStripMetrics() {
      const strip =
        document.querySelector(
          'aside[data-app-shell-focus-area="right-panel"] [data-app-shell-tab-strip-controller="right"]'
        ) || document.querySelector('[data-app-shell-tab-strip-controller="right"]');
      const toolbar = strip?.parentElement instanceof HTMLElement ? strip.parentElement : null;
      const header = document.querySelector("header[data-app-shell-header-edge-scroll]");
      for (const node of document.querySelectorAll('[data-opencodex-wco-right-panel-toolbar="true"]')) {
        if (node !== toolbar) node.removeAttribute("data-opencodex-wco-right-panel-toolbar");
      }
      for (const node of document.querySelectorAll('[data-opencodex-wco-right-panel-strip="true"]')) {
        if (node !== strip) node.removeAttribute("data-opencodex-wco-right-panel-strip");
      }
      header?.toggleAttribute("data-opencodex-wco-has-right-panel-toolbar", Boolean(toolbar));
      const clipNodes = new Set();
      let extend = 0;
      if (toolbar) {
        const leftSlot = header?.querySelector(':scope > [data-test-id="header-shell-slot"]:first-child');
        const headerRect = header?.getBoundingClientRect();
        const leftSlotRect = leftSlot?.getBoundingClientRect();
        const stripRect = strip.getBoundingClientRect();
        const appliedExtend =
          Number.parseFloat(rootStyle.getPropertyValue("--opencodex-wco-right-panel-toolbar-extend") || "0") || 0;
        const toolbarStyle = w.getComputedStyle(toolbar);
        const toolbarGap = Math.max(
          0,
          Number.parseFloat(toolbarStyle.columnGap || toolbarStyle.gap || "0") || 0
        );
        const minStripLeft = Math.max(headerRect?.left ?? 0, (leftSlotRect?.right ?? stripRect.left) + toolbarGap);
        // stripRect.left 会受上一轮负 margin 影响；加回已应用扩展量后再计算，避免扩展值来回抖动。
        extend = Math.max(0, Math.floor(stripRect.left + appliedExtend - minStripLeft));
        for (let node = toolbar.parentElement; node instanceof HTMLElement; node = node.parentElement) {
          clipNodes.add(node);
          if (node.matches('aside[data-app-shell-focus-area="right-panel"]')) break;
        }
        // 官方 sticky 按钮和 scroll-padding 都在 strip 内部，Web shell 只移动 strip 左边界并保留右边界。
        toolbar.setAttribute("data-opencodex-wco-right-panel-toolbar", "true");
        strip.setAttribute("data-opencodex-wco-right-panel-strip", "true");
      }
      for (const node of document.querySelectorAll('[data-opencodex-wco-right-panel-toolbar-clip="true"]')) {
        if (!clipNodes.has(node)) node.removeAttribute("data-opencodex-wco-right-panel-toolbar-clip");
      }
      for (const node of clipNodes) {
        node.setAttribute("data-opencodex-wco-right-panel-toolbar-clip", "true");
      }
      const nextExtend = `${extend}px`;
      if (rootStyle.getPropertyValue("--opencodex-wco-right-panel-toolbar-extend") !== nextExtend) {
        setManagedRootStyle("--opencodex-wco-right-panel-toolbar-extend", nextExtend);
      }
      // 不主动改 scrollLeft、tablist padding 或 sticky 子节点；官方 tab strip 自己维护滚动位置。
    }

    function syncHeaderAndPanelMetrics() {
      syncRightHeaderSlotMetrics();
      syncRightPanelTabStripMetrics();
      syncWindowControlsThemeState();
      syncImagePreviewOverlayState();
    }

    function queueRightHeaderSlotMetrics() {
      if (rightHeaderSlotMetricsQueued) return;
      rightHeaderSlotMetricsQueued = true;
      if (typeof w.requestAnimationFrame === "function") {
        metricFrameId = w.requestAnimationFrame(() => {
          metricFrameId = null;
          syncHeaderAndPanelMetrics();
        });
      } else {
        metricTimeoutId = w.setTimeout(() => {
          metricTimeoutId = null;
          syncHeaderAndPanelMetrics();
        }, 0);
      }
    }

    function cancelQueuedMetrics() {
      if (metricFrameId != null && typeof w.cancelAnimationFrame === "function") {
        w.cancelAnimationFrame(metricFrameId);
      }
      if (metricTimeoutId != null) w.clearTimeout(metricTimeoutId);
      metricFrameId = null;
      metricTimeoutId = null;
      rightHeaderSlotMetricsQueued = false;
    }

    function nodeTouchesMetricMount(node, includeDescendants = false) {
      if (!node || node.nodeType !== 1) return false;
      if (node.matches?.(METRIC_MOUNT_SELECTOR) || node.closest?.(METRIC_MOUNT_SELECTOR)) return true;
      if (
        currentImagePreviewRoot &&
        (node === currentImagePreviewRoot || currentImagePreviewRoot.contains?.(node))
      ) {
        return true;
      }
      return includeDescendants && !!node.firstElementChild && !!node.querySelector?.(METRIC_MOUNT_SELECTOR);
    }

    function mutationTouchesMetrics(record) {
      if (!record) return false;
      if (record.type === "attributes") {
        if (record.target === root || record.target === document.body) return true;
        return nodeTouchesMetricMount(record.target);
      }
      if (record.type !== "childList") return false;
      if (nodeTouchesMetricMount(record.target)) return true;
      return [...Array.from(record.addedNodes || []), ...Array.from(record.removedNodes || [])].some(
        (node) => nodeTouchesMetricMount(node, true)
      );
    }

    function startHeavyObservers() {
      if (heavyObserversActive) return;
      heavyObserversActive = true;
      inactiveMetricsSynced = false;
      if (typeof MutationObserver === "function") {
        // 只有 WCO 真正可见时才观察官方 renderer；普通网页和移动端无需承担整页 DOM 监听成本。
        mutationObserver = new MutationObserver((records) => {
          let hasExternalMutation = false;
          for (const record of Array.from(records || [])) {
            // CSS 测量探针会频繁改写自身 style；绝不能让它们反向触发下一轮测量。
            if (record.target === cssLengthProbe || record.target === cssColorProbe) continue;
            const isRootStyle =
              record.type === "attributes" && record.target === root && record.attributeName === "style";
            if (isRootStyle && managedRootStyleMutationBudget > 0) {
              managedRootStyleMutationBudget -= 1;
              continue;
            }
            if (mutationTouchesMetrics(record)) hasExternalMutation = true;
          }
          // 预算之外的根 style 记录来自官方 renderer，必须像其它外部变化一样重新测量。
          if (hasExternalMutation) queueRightHeaderSlotMetrics();
        });
        mutationObserver.observe(document.documentElement, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ["class", "style", "data-theme"],
        });
      }
      if (typeof ResizeObserver === "function") {
        resizeObserver = new ResizeObserver(queueRightHeaderSlotMetrics);
        resizeObserver.observe(root);
      }
    }

    function stopHeavyObservers() {
      mutationObserver?.disconnect();
      resizeObserver?.disconnect();
      mutationObserver = null;
      managedRootStyleMutationBudget = 0;
      resizeObserver = null;
      currentImagePreviewRoot = null;
      heavyObserversActive = false;
      cancelQueuedMetrics();
    }

    function syncInsets() {
      const visible = Boolean(overlay?.visible || displayModeQuery?.matches);
      if (document.visibilityState === "hidden") {
        // 后台页面保留最后一份 CSS 几何值，但彻底停止 DOM/布局观察；回前台时再统一校准。
        stopHeavyObservers();
        return;
      }
      if (visible && overlay && typeof overlay.getTitlebarAreaRect === "function") {
        startHeavyObservers();
        const rect = overlay.getTitlebarAreaRect();
        setInsets(true, insetsFromRect(rect));
        queueRightHeaderSlotMetrics();
        return;
      }
      if (visible) {
        startHeavyObservers();
        setInsets(true, null);
        queueRightHeaderSlotMetrics();
        return;
      }
      setInsets(false, null);
      stopHeavyObservers();
      if (!inactiveMetricsSynced) {
        // 从 WCO 退出时只做一次完整清理，之后普通页面的 DOM 更新不再触发布局测量。
        inactiveMetricsSynced = true;
        syncHeaderAndPanelMetrics();
      }
    }

    ensureOverrideStyles();
    if (overlay?.addEventListener) {
      overlay.addEventListener("geometrychange", syncInsets);
      addCleanup(() => overlay.removeEventListener?.("geometrychange", syncInsets));
    }
    if (displayModeQuery?.addEventListener) {
      displayModeQuery.addEventListener("change", syncInsets);
      addCleanup(() => displayModeQuery.removeEventListener("change", syncInsets));
    } else if (displayModeQuery?.addListener) {
      displayModeQuery.addListener(syncInsets);
      addCleanup(() => displayModeQuery.removeListener?.(syncInsets));
    }
    w.addEventListener("resize", syncInsets);
    addCleanup(() => w.removeEventListener("resize", syncInsets));
    document.addEventListener?.("visibilitychange", syncInsets);
    addCleanup(() => document.removeEventListener?.("visibilitychange", syncInsets));
    syncInsets();
    const initialFrameId =
      typeof w.requestAnimationFrame === "function" ? w.requestAnimationFrame(syncInsets) : null;
    const initialTimeoutId = w.setTimeout(syncInsets, 250);
    return () => {
      setWindowControlsThemeColor("");
      setImagePreviewThemeColor("");
      stopHeavyObservers();
      if (initialFrameId != null && typeof w.cancelAnimationFrame === "function") {
        w.cancelAnimationFrame(initialFrameId);
      }
      w.clearTimeout(initialTimeoutId);
      for (const cleanup of cleanupHandlers.splice(0).reverse()) {
        try {
          cleanup();
        } catch {
          // 页面切换期间 DOM/监听对象可能已经失效，逐个清理时保持幂等。
        }
      }
      cssLengthProbe?.remove();
      cssColorProbe?.remove();
    };
  }

  installState.cleanup = installWindowControlsOverlaySafeArea() || null;
  if (installState.cleanup) {
    w.OpenCodexRuntimeCompatibility?.active?.("web.runtime.dom.window-controls-overlay");
  }
  w.OpenCodexRuntimeCompatibility?.installed?.("web.runtime.dom.window-controls-overlay");
})();
