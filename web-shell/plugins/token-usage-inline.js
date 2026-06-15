(function () {
  const w = window;
  const pluginSystem = w.OpenCodexPluginSystem || w.__OpenCodexPluginSystem;
  if (!pluginSystem || typeof pluginSystem.registerPlugin !== "function") return;

  const PLUGIN_ID = "opencodex.token-usage-inline";
  const BADGE_ATTR = "data-opencodex-token-usage-inline";
  const REQUEST_RETRY_MS = 65 * 1000;
  const MAX_REQUESTED_KEYS = 600;
  const DIAGNOSTIC_KEY = "__OpenCodexTokenUsageInline";

  // 只暴露计数型诊断，方便确认“没显示”时区分没扫到 DOM、没取到数据还是没渲染。
  const diagnostics = {
    forkButtons: 0,
    lastError: "",
    lastIds: null,
    lastRenderText: "",
    lastRequestAt: 0,
    lastScanAt: 0,
    lastUsageFound: null,
    nullResponses: 0,
    observedRows: 0,
    rendered: 0,
    requested: 0,
    rows: 0,
  };

  w[DIAGNOSTIC_KEY] = diagnostics;

  function visibleElement(element) {
    if (!element || typeof element.getBoundingClientRect !== "function") return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = w.getComputedStyle ? w.getComputedStyle(element) : null;
    return !style || (style.display !== "none" && style.visibility !== "hidden");
  }

  function decodePathSegment(value) {
    if (!value) return null;
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  function currentThreadId() {
    const pathname = String(w.location?.pathname || "");
    const patterns = [
      /\/local\/([^/?#]+)/,
      /\/hotkey-window\/thread\/([^/?#]+)/,
      /\/thread\/([^/?#]+)/,
      /\/conversation\/([^/?#]+)/,
    ];
    for (const pattern of patterns) {
      const match = pattern.exec(pathname);
      if (match?.[1]) return decodePathSegment(match[1]);
    }
    return null;
  }

  function actionRowLooksLikeAssistantActions(row) {
    if (!row || row.nodeType !== 1 || row.tagName !== "DIV") return false;
    const className = String(row.getAttribute("class") || "");
    // 官方 action row 没有稳定 data-testid，只能用尺寸/布局类做低风险启发式判断。
    return (
      className.includes("h-5") &&
      className.includes("items-center") &&
      className.includes("justify-start") &&
      className.includes("gap-0.5")
    );
  }

  function isForkButton(button) {
    if (!button || button.tagName !== "BUTTON") return false;
    const label = String(button.getAttribute("aria-label") || button.getAttribute("title") || "").toLowerCase();
    // 以分叉按钮作为锚点插入，避免插件自己猜测回复正文或 action row 的完整结构。
    if (/(fork|forken|分叉|派生|分支|从此处|從此處|ab hier)/i.test(label)) return true;
    return false;
  }

  function findForkButton(row) {
    const buttons = Array.from(row.querySelectorAll("button")).filter(visibleElement);
    return buttons.find(isForkButton) || null;
  }

  function actionRowForForkButton(button) {
    if (!button) return null;
    const turnElement = button.closest("[data-turn-key]") || button.closest("[data-content-search-turn-key]");
    let cursor = button.parentElement;
    let fallback = null;
    let depth = 0;
    while (cursor && cursor !== turnElement && depth < 10) {
      if (cursor.tagName === "DIV") {
        if (actionRowLooksLikeAssistantActions(cursor)) return cursor;
        // 官方 action row 可能包了 tooltip/span；找不到精确 class 时退到最近的 flex 容器。
        const className = String(cursor.getAttribute("class") || "");
        if (!fallback && (className.includes("flex") || className.includes("items-center"))) fallback = cursor;
      }
      cursor = cursor.parentElement;
      depth += 1;
    }
    return fallback;
  }

  function directChildForInsert(row, element) {
    let cursor = element;
    // 插入点需要是 action row 的直接子节点，否则 tooltip wrapper 里插 badge 会破坏按钮布局。
    while (cursor && cursor.parentElement && cursor.parentElement !== row) {
      cursor = cursor.parentElement;
    }
    return cursor && cursor.parentElement === row ? cursor : element;
  }

  function idsForElement(element) {
    // 当前官方虚拟列表实际渲染 data-turn-key；content-search key 只在搜索适配器里使用。
    const turnElement = element?.closest("[data-turn-key]") || element?.closest("[data-content-search-turn-key]");
    const rawTurnId =
      turnElement?.getAttribute("data-turn-key") || turnElement?.getAttribute("data-content-search-turn-key") || "";
    const turnId = decodePathSegment(rawTurnId.trim());
    const threadId =
      turnElement?.getAttribute("data-opencodex-thread-id") ||
      element?.closest("[data-opencodex-thread-id]")?.getAttribute("data-opencodex-thread-id") ||
      currentThreadId();
    if (
      !turnId ||
      turnId.startsWith("turn-index-") ||
      turnId.startsWith(":") ||
      turnId === "expanded-review-composer-preview"
    ) {
      return null;
    }
    // 官方根路径可能不暴露 threadId；这种情况下先按 turnId 懒查，后端会从 session 文件解析 threadId。
    return { key: `${threadId || "__unknown_thread__"}\0${turnId}`, threadId: threadId || null, turnId };
  }

  function formatTokenCount(value) {
    if (!Number.isFinite(value)) return "-";
    if (value < 1000) return String(Math.max(0, Math.floor(value)));
    if (value < 1000000) {
      const text = (value / 1000).toFixed(value >= 100000 ? 0 : 1);
      return `${text.replace(/\.0$/, "")}k`;
    }
    const text = (value / 1000000).toFixed(value >= 10000000 ? 0 : 1);
    return `${text.replace(/\.0$/, "")}m`;
  }

  function formatHitRate(value) {
    return Number.isFinite(value) ? `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%` : "-";
  }

  function usageCompactText(usage) {
    return `${formatTokenCount(usage?.inputTokens)} ${formatTokenCount(usage?.outputTokens)} ${formatHitRate(usage?.cacheHitRate)}`;
  }

  function usageParts(usage) {
    return [
      { icon: "input", value: formatTokenCount(usage?.inputTokens) },
      { icon: "output", value: formatTokenCount(usage?.outputTokens) },
      { icon: "hit", value: formatHitRate(usage?.cacheHitRate) },
    ];
  }

  function iconPaths(name) {
    if (name === "output") {
      return ["M8 2.5v9", "M4.75 8.25 8 11.5l3.25-3.25", "M3 13.25h10"];
    }
    if (name === "hit") {
      return [
        "M8 2.25a5.75 5.75 0 1 0 0 11.5 5.75 5.75 0 0 0 0-11.5Z",
        "M8 5.25a2.75 2.75 0 1 0 0 5.5 2.75 2.75 0 0 0 0-5.5Z",
        "M8 1v2.25",
        "M8 12.75V15",
        "M1 8h2.25",
        "M12.75 8H15",
      ];
    }
    // 输入/输出恢复第一版箭头图标，并按用户确认的方向交换映射。
    return ["M8 13.5V4.5", "M4.75 7.75 8 4.5l3.25 3.25", "M3 2.75h10"];
  }

  function createUsageIcon(name) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("aria-hidden", "true");
    svg.classList.add("opencodex-token-usage-inline-icon");
    // 插件没有 React 图标上下文；这里用静态线性 SVG，颜色跟随官方 action row 的 currentColor。
    for (const d of iconPaths(name)) {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", d);
      svg.appendChild(path);
    }
    return svg;
  }

  function renderUsageContent(badge, usage) {
    badge.textContent = "";
    // 不设置 title/aria-label，避免 token 统计 DOM 额外携带需要本地化的悬浮提示文案。
    badge.removeAttribute("title");
    badge.removeAttribute("aria-label");
    for (const part of usageParts(usage)) {
      const item = document.createElement("span");
      item.className = "opencodex-token-usage-inline-item";
      const value = document.createElement("span");
      value.className = "opencodex-token-usage-inline-value";
      value.textContent = part.value;
      item.append(createUsageIcon(part.icon), value);
      badge.appendChild(item);
    }
  }

  function trimRequestedKeys(requestedAtByKey) {
    while (requestedAtByKey.size > MAX_REQUESTED_KEYS) {
      const oldestKey = requestedAtByKey.keys().next().value;
      if (!oldestKey) break;
      requestedAtByKey.delete(oldestKey);
    }
  }

  pluginSystem.registerPlugin({
    id: PLUGIN_ID,
    name: "Token usage inline",
    label: "显示Token消耗",
    desc: "在AI回复底部显示输入、输出 token 和缓存命中率。",
    defaultEnabled: true,
    builtin: true,
    order: 30,
    activate(context) {
      const tokenUsage = context.capabilities?.tokenUsage;
      if (
        context.scope !== "renderer" ||
        !document ||
        document.__opencodexTokenUsageInlineInstalled ||
        !tokenUsage ||
        typeof tokenUsage.acquireConsumer !== "function" ||
        typeof tokenUsage.getForTurn !== "function"
      ) {
        return null;
      }
      document.__opencodexTokenUsageInlineInstalled = true;

      const observedRows = new Set();
      const pendingScanRoots = new Set();
      const requestedAtByKey = new Map();
      // WeakMap 绑定 DOM row 和 turn 信息；虚拟列表卸载后可被 GC 自动回收。
      const rowIds = new WeakMap();
      let scanTimer = null;
      let disposed = false;

      const style = document.createElement("style");
      style.id = "opencodex-token-usage-inline-styles";
      style.textContent = `
        [${BADGE_ATTR}] {
          align-items: center;
          color: var(--color-token-input-placeholder-foreground, var(--color-token-text-secondary));
          display: inline-flex;
          flex: 0 1 auto;
          font-variant-numeric: tabular-nums;
          height: 100%;
          line-height: 1.25rem;
          margin-left: 0.125rem;
          max-width: min(34vw, 260px);
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        [${BADGE_ATTR}] .opencodex-token-usage-inline-item {
          align-items: center;
          display: inline-flex;
          flex: 0 1 auto;
          gap: 0.125rem;
          min-width: 0;
        }
        [${BADGE_ATTR}] .opencodex-token-usage-inline-item + .opencodex-token-usage-inline-item {
          margin-left: 0.375rem;
        }
        [${BADGE_ATTR}] .opencodex-token-usage-inline-icon {
          color: currentColor;
          flex: 0 0 auto;
          height: 0.8125rem;
          opacity: 0.72;
          width: 0.8125rem;
        }
        [${BADGE_ATTR}] .opencodex-token-usage-inline-icon path {
          fill: none;
          stroke: currentColor;
          stroke-linecap: round;
          stroke-linejoin: round;
          stroke-width: 1.5;
        }
        [${BADGE_ATTR}] .opencodex-token-usage-inline-value {
          overflow: hidden;
          text-overflow: ellipsis;
        }
      `;
      (document.head || document.documentElement).appendChild(style);

      const releaseConsumer = tokenUsage.acquireConsumer(PLUGIN_ID);

      const idsForRow = (row) => rowIds.get(row) || idsForElement(row);

      const rememberRowIds = (row, ids) => {
        if (!row || !ids) return ids || null;
        rowIds.set(row, ids);
        return ids;
      };

      const renderUsage = (row, usage, providedIds) => {
        if (disposed || !usage) return;
        const forkButton = findForkButton(row);
        if (!forkButton) return;
        const ids = providedIds || idsForRow(row);
        if (!ids || ids.turnId !== usage.turnId || (ids.threadId && ids.threadId !== usage.threadId)) return;
        if (!ids.threadId && usage.threadId) {
          rememberRowIds(row, { ...ids, key: `${usage.threadId}\0${usage.turnId}`, threadId: usage.threadId });
        }
        let badge = row.querySelector(`[${BADGE_ATTR}]`);
        if (!badge) {
          badge = document.createElement("span");
          badge.setAttribute(BADGE_ATTR, "true");
          badge.className = "opencodex-token-usage-inline text-size-chat";
          // 插到分叉按钮 wrapper 后面，保持和官方 action row 的按钮间距一致。
          directChildForInsert(row, forkButton).after(badge);
        }
        renderUsageContent(badge, usage);
        diagnostics.lastRenderText = usageCompactText(usage);
        diagnostics.rendered += 1;
      };

      const requestUsageForRow = (row, providedIds) => {
        if (disposed || !context.plugin.isEnabled()) return;
        const ids = rememberRowIds(row, providedIds || idsForRow(row));
        if (!ids) return;
        diagnostics.lastIds = ids;
        diagnostics.lastRequestAt = Date.now();
        diagnostics.requested += 1;
        const requestedAt = requestedAtByKey.get(ids.key) || 0;
        // null/失败结果也短暂限流，避免滚动或 DOM 重排时对同一 turn 重复查询。
        if (Date.now() - requestedAt < REQUEST_RETRY_MS) return;
        requestedAtByKey.delete(ids.key);
        requestedAtByKey.set(ids.key, Date.now());
        trimRequestedKeys(requestedAtByKey);
        tokenUsage
          .getForTurn({ threadId: ids.threadId, turnId: ids.turnId })
          .then((usage) => {
            diagnostics.lastUsageFound = !!usage;
            if (usage) {
              renderUsage(row, usage, ids);
            } else {
              diagnostics.nullResponses += 1;
            }
          })
          .catch((error) => {
            diagnostics.lastError = error?.message || String(error || "token usage request failed");
          });
      };

      const intersectionObserver =
        typeof IntersectionObserver === "function"
          ? new IntersectionObserver((entries) => {
              for (const entry of entries) {
                if (entry.isIntersecting) requestUsageForRow(entry.target);
              }
            })
          : null;

      const observeRow = (row, ids) => {
        rememberRowIds(row, ids);
        if (observedRows.has(row)) return;
        observedRows.add(row);
        if (intersectionObserver) {
          intersectionObserver.observe(row);
        }
        // DOM 已经渲染出来时立即懒查一次；observer 只作为后续滚动进入视口的补偿。
        requestUsageForRow(row, ids);
      };

      const pruneObservedRows = () => {
        for (const row of Array.from(observedRows)) {
          if (row.isConnected) continue;
          // 官方虚拟列表会频繁替换节点；及时解除观察，避免集合里保留离屏旧 DOM。
          observedRows.delete(row);
          intersectionObserver?.unobserve(row);
        }
      };

      const buttonsFromRoot = (root) => {
        if (!root || root.nodeType !== 1) return [];
        const buttons = [];
        if (root.tagName === "BUTTON") buttons.push(root);
        if (typeof root.querySelectorAll === "function") {
          // 这里只查新增子树内的按钮，不再做 document 级全量扫描。
          buttons.push(...root.querySelectorAll("button"));
        }
        return buttons;
      };

      const rootMayContainForkButton = (root) => {
        if (!root || root.nodeType !== 1) return false;
        if (root.hasAttribute?.(BADGE_ATTR) || root.closest?.(`[${BADGE_ATTR}]`)) return false;
        if (root.tagName === "BUTTON") return true;
        // 增量观察只关心可能含有 action row 的新增子树，避免流式文本节点触发全页查询。
        return typeof root.querySelector === "function" && !!root.querySelector("button");
      };

      const scanRoot = (root) => {
        if (disposed || !context.plugin.isEnabled() || !root) return;
        pruneObservedRows();
        const rows = new Map();
        const forkButtons = buttonsFromRoot(root).filter((button) => visibleElement(button) && isForkButton(button));
        for (const button of forkButtons) {
          // 同一 action row 可能包含多个 tooltip 包装，Map 去重后每条回复只观察一次。
          const row = actionRowForForkButton(button);
          const ids = idsForElement(button);
          if (row && ids) rows.set(row, ids);
        }
        diagnostics.forkButtons = forkButtons.length;
        diagnostics.lastScanAt = Date.now();
        diagnostics.rows = rows.size;
        for (const [row, ids] of rows) {
          observeRow(row, ids);
        }
        diagnostics.observedRows = observedRows.size;
      };

      const flushPendingScans = () => {
        scanTimer = null;
        const roots = Array.from(pendingScanRoots);
        pendingScanRoots.clear();
        for (const root of roots) {
          if (root?.isConnected) scanRoot(root);
        }
      };

      const addPendingScanRoot = (root) => {
        if (!root || root.nodeType !== 1) return;
        for (const existing of Array.from(pendingScanRoots)) {
          if (existing === root || existing.contains?.(root)) return;
          // 同一批新增里如果父节点已经覆盖子节点，只保留更大的子树，避免重复查局部按钮。
          if (root.contains?.(existing)) pendingScanRoots.delete(existing);
        }
        pendingScanRoots.add(root);
      };

      const scheduleScan = (root) => {
        if (disposed) return;
        addPendingScanRoot(root);
        if (scanTimer) return;
        scanTimer = w.setTimeout(flushPendingScans, 80);
      };

      const mutationObserver = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          if (mutation.type !== "childList") continue;
          for (const node of mutation.addedNodes || []) {
            if (rootMayContainForkButton(node)) {
              // mutation 只把候选新增子树入队，真正查询延迟合并到一次 flush。
              scheduleScan(node);
            }
          }
        }
      });

      const disposeUpdate = typeof tokenUsage.onUpdate === "function" ? tokenUsage.onUpdate((usage) => {
        if (!usage || disposed) return;
        for (const row of Array.from(observedRows)) {
          if (!row.isConnected) {
            observedRows.delete(row);
            continue;
          }
          const ids = idsForRow(row);
          if (ids && ids.turnId === usage.turnId && (!ids.threadId || ids.threadId === usage.threadId)) {
            // 被动通道先拿到 usage 时，只更新已经观察过的行，不为了订阅事件重新扫全页。
            renderUsage(row, usage, ids);
          }
        }
      }) : () => {};

      scanRoot(document.documentElement);
      mutationObserver.observe(document.documentElement, { childList: true, subtree: true });

      return () => {
        disposed = true;
        if (scanTimer) w.clearTimeout(scanTimer);
        disposeUpdate();
        releaseConsumer();
        mutationObserver.disconnect();
        intersectionObserver?.disconnect();
        for (const element of Array.from(document.querySelectorAll(`[${BADGE_ATTR}]`))) {
          element.remove();
        }
        if (style.parentNode) style.parentNode.removeChild(style);
        document.__opencodexTokenUsageInlineInstalled = false;
      };
    },
  });
})();
