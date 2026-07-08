(function () {
  const w = window;
  if (w.__codexRemoteFileActionsInstalled) return;
  w.__codexRemoteFileActionsInstalled = true;

  const DOWNLOAD_PATH_API = "/api/local-file/download-path";
  const FILE_TREE_MENU_SESSION_TTL_MS = 2500;
  const FILE_TREE_MENU_ANCHOR_MARGIN_PX = 80;
  const state = {
    installed: true,
    injectedPathDownloadItems: 0,
    lastDownloadDetail: "",
    lastDownloadError: "",
    lastMenuSessionClearReason: "",
    lastDownloadPath: "",
    lastPathSource: "",
    lastRawPath: "",
    lastResolvedPath: "",
    lastScanAtMs: 0,
    lastWorkspaceRootSource: "",
    lastWorkspaceRoot: "",
    pathDownloads: 0,
    pendingPathMenuSession: false,
    remoteBrowser: false,
    workspaceRootCaptures: 0,
  };
  let pendingPathMenuSession = null;
  let nextPathMenuSessionId = 1;
  const workspaceRootByRelativePath = new Map();
  w.__codexRemoteFileActionsStatus = state;

  function bridgeHelpers() {
    return w.__codexWebBridgeHelpers && typeof w.__codexWebBridgeHelpers === "object"
      ? w.__codexWebBridgeHelpers
      : {};
  }

  function runtimeMessages() {
    const cfg = w.__CODEX_WEB_CONFIG__ || {};
    return cfg.messages && typeof cfg.messages === "object" ? cfg.messages : {};
  }

  function t(key, values) {
    const helper = bridgeHelpers().t;
    if (typeof helper === "function") return helper(key, values);
    const template = runtimeMessages()[key] || key;
    if (!values || typeof values !== "object") return template;
    return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name) =>
      Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match
    );
  }

  function showToast(payload) {
    const helper = bridgeHelpers().showToast;
    if (typeof helper === "function") {
      helper(payload);
      return;
    }
    try {
      w.dispatchEvent(new MessageEvent("message", { data: { type: "codex-web:toast", ...payload } }));
    } catch {}
  }

  function normalizedText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function loopbackHostname(hostname) {
    // 远端下载能力只在非 loopback 浏览器启用；localhost 保持桌面原生行为。
    const normalized = String(hostname || "").trim().toLowerCase();
    if (!normalized) return false;
    const bracketed = normalized.match(/^\[([^\]]+)]$/);
    const host = bracketed ? bracketed[1] : normalized;
    if (host === "localhost" || host === "::1") return true;
    return isIpv4Loopback(host) || (host.startsWith("::ffff:") && isIpv4Loopback(host.slice("::ffff:".length)));
  }

  function isIpv4Loopback(hostname) {
    const parts = String(hostname || "").split(".");
    if (parts.length !== 4 || parts[0] !== "127") return false;
    return parts.every((part) => {
      if (!/^\d{1,3}$/.test(part)) return false;
      const value = Number(part);
      return value >= 0 && value <= 255;
    });
  }

  function shouldEnableRemoteFileActions() {
    try {
      state.remoteBrowser = !loopbackHostname(w.location && w.location.hostname);
      return state.remoteBrowser;
    } catch {
      state.remoteBrowser = true;
      return true;
    }
  }

  function safeDownloadName(value) {
    return normalizedText(value).replace(/[\\/]/g, "_");
  }

  function configWorkspaceRoots() {
    const cfg = w.__CODEX_WEB_CONFIG__ || {};
    if (!Array.isArray(cfg.workspaceRoots)) return [];
    return cfg.workspaceRoots
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object" && typeof item.path === "string") return item.path;
        return "";
      })
      .filter(Boolean);
  }

  function stripPathQuotes(value) {
    const text = normalizedText(value);
    if (text.length >= 2 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))) {
      return text.slice(1, -1);
    }
    return text;
  }

  function appFsUrlToPath(value) {
    if (typeof value !== "string" || !value.startsWith("app://fs/")) return "";
    try {
      const url = new URL(value);
      if (url.protocol !== "app:" || url.hostname !== "fs" || !url.pathname.startsWith("/@fs/")) return "";
      return `/${decodeURIComponent(url.pathname.slice("/@fs/".length))}`.replace(/\/+/g, "/");
    } catch {
      return "";
    }
  }

  function fileUrlToPath(value) {
    if (typeof value !== "string" || !value.startsWith("file:")) return "";
    try {
      const url = new URL(value);
      if (url.protocol !== "file:") return "";
      const pathname = decodeURIComponent(url.pathname || "");
      return /^\/[a-zA-Z]:\//.test(pathname) ? pathname.slice(1) : pathname;
    } catch {
      return "";
    }
  }

  function isAbsoluteLocalPath(value) {
    const text = stripPathQuotes(value);
    return text.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(text) || /^\\\\[^\\]/.test(text);
  }

  function normalizedPathCandidate(value) {
    const text = stripPathQuotes(value);
    if (!text) return "";
    const appFsPath = appFsUrlToPath(text);
    if (appFsPath) return appFsPath;
    const filePath = fileUrlToPath(text);
    if (filePath) return filePath;
    return isAbsoluteLocalPath(text) ? text : "";
  }

  function safeRelativeFileTreePath(value) {
    const text = stripPathQuotes(value);
    if (!text || text.includes("\0") || text.startsWith("~")) return "";
    if (normalizedPathCandidate(text) || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(text)) return "";
    const segments = text
      .replace(/^[\\/]+/, "")
      .split(/[\\/]+/)
      .filter((segment) => segment && segment !== ".");
    if (segments.length === 0 || segments.some((segment) => segment === "..")) return "";
    return segments.join("/");
  }

  function downloadPathFromFileTreePath(value) {
    const direct = normalizedPathCandidate(value);
    if (direct) return direct;
    const relativePath = safeRelativeFileTreePath(value);
    // 官方文件树给的是相对 workspace root 的 path；前端不能用配置根提前拼绝对路径，避免下载同名错文件。
    return relativePath;
  }

  function downloadPathCandidate(value) {
    const text = stripPathQuotes(value);
    // 文件树空白处没有具体条目路径，使用 "." 让后端按当前 workspace root 下载整目录。
    if (text === ".") return ".";
    return normalizedPathCandidate(value) || safeRelativeFileTreePath(value);
  }

  function workspaceRootFromValue(value) {
    const root = normalizedPathCandidate(value);
    return root && isAbsoluteLocalPath(root) ? root : "";
  }

  function rememberWorkspaceRoot(workspaceRoot, source) {
    const root = workspaceRootFromValue(workspaceRoot);
    if (!root) return "";
    state.lastWorkspaceRoot = root;
    state.lastWorkspaceRootSource = source || "unknown";
    state.workspaceRootCaptures += 1;
    return root;
  }

  function rememberWorkspaceRootForPath(filePath, workspaceRoot, source) {
    const relativePath = safeRelativeFileTreePath(filePath);
    const root = rememberWorkspaceRoot(workspaceRoot, source);
    if (!relativePath || !root) return false;
    workspaceRootByRelativePath.set(relativePath, root);
    return true;
  }

  function workspaceRootForDownloadPath(filePath) {
    if (stripPathQuotes(filePath) === ".") {
      const configuredRoots = configWorkspaceRoots();
      return state.lastWorkspaceRoot || (configuredRoots.length === 1 ? configuredRoots[0] : "");
    }
    const relativePath = safeRelativeFileTreePath(filePath);
    if (!relativePath) return "";
    const configuredRoots = configWorkspaceRoots();
    return workspaceRootByRelativePath.get(relativePath) || state.lastWorkspaceRoot || (configuredRoots.length === 1 ? configuredRoots[0] : "");
  }

  function paramsLike(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return value.params && typeof value.params === "object" && !Array.isArray(value.params) ? value.params : value;
  }

  function rememberWorkspaceRootFromCandidate(value, depth = 0) {
    if (depth > 5 || value == null) return false;
    if (typeof value === "string") {
      const text = value.trim();
      if (!text || !((text.startsWith("{") && text.endsWith("}")) || (text.startsWith("[") && text.endsWith("]")))) {
        return false;
      }
      try {
        return rememberWorkspaceRootFromCandidate(JSON.parse(text), depth + 1);
      } catch {
        return false;
      }
    }
    if (Array.isArray(value)) {
      let remembered = false;
      for (const item of value) remembered = rememberWorkspaceRootFromCandidate(item, depth + 1) || remembered;
      return remembered;
    }
    if (typeof value !== "object") return false;

    const params = paramsLike(value);
    const filePath =
      typeof params.path === "string"
        ? params.path
        : typeof params.filePath === "string"
          ? params.filePath
          : "";
    const workspaceRoot =
      typeof params.cwd === "string"
        ? params.cwd
        : typeof params.workspaceRoot === "string"
          ? params.workspaceRoot
        : typeof params.projectRoot === "string"
            ? params.projectRoot
            : "";
    let remembered = false;
    if (workspaceRoot) {
      rememberWorkspaceRoot(workspaceRoot, "ipc");
      remembered = true;
    }
    remembered = rememberWorkspaceRootForPath(filePath, workspaceRoot, "ipc-path") || remembered;
    for (const nestedValue of Object.values(value)) {
      remembered = rememberWorkspaceRootFromCandidate(nestedValue, depth + 1) || remembered;
    }
    return remembered;
  }

  function rememberWorkspaceRootFromIpcBody(body) {
    if (typeof body !== "string" || !body.trim()) return false;
    try {
      const parsed = JSON.parse(body);
      if (!parsed || typeof parsed !== "object") return false;
      return rememberWorkspaceRootFromCandidate(parsed);
    } catch {
      return false;
    }
  }

  function installWorkspaceRootCapture() {
    if (!w.__codexRemoteFileActionsPluginEventListener) {
      w.addEventListener("opencodex:plugin-event", (event) => {
        const detail = event && event.detail;
        if (!detail || detail.eventName !== "ipc:invoke") return;
        rememberWorkspaceRootFromCandidate(detail.payload);
      });
      w.__codexRemoteFileActionsPluginEventListener = true;
    }
    if (w.__codexRemoteFileActionsFetchPatched || typeof w.fetch !== "function") return;
    const originalFetch = w.fetch.bind(w);
    w.fetch = function codexRemoteFileActionsFetch(input, init) {
      try {
        const url = typeof input === "string" ? input : input && typeof input.url === "string" ? input.url : "";
        const pathname = new URL(url, w.location.href).pathname;
        if (pathname === "/api/ipc/invoke") rememberWorkspaceRootFromIpcBody(init && init.body);
      } catch {}
      return originalFetch(input, init);
    };
    w.__codexRemoteFileActionsFetchPatched = true;
  }

  function pathContextFromFileTreeElement(element, source) {
    if (!element || element.nodeType !== 1) return null;
    const itemType = element.getAttribute("data-item-type");
    if (itemType !== "file" && itemType !== "folder") return null;
    const rawPath = element.getAttribute("data-item-path") || element.getAttribute("data-file-tree-sticky-path") || "";
    const filePath = downloadPathFromFileTreePath(rawPath);
    if (!filePath) return null;
    return { filePath, itemType, rawPath, source };
  }

  function isFileTreeContainerElement(element) {
    if (!element || element.nodeType !== 1) return false;
    const tagName = String(element.tagName || "").toLowerCase();
    return (
      tagName === "file-tree-container" ||
      element.hasAttribute?.("data-file-tree-id") ||
      element.hasAttribute?.("data-file-tree-virtualized-wrapper") ||
      element.hasAttribute?.("data-file-tree-virtualized-scroll")
    );
  }

  function fileTreeContainerFromEventPath(eventPath) {
    for (const node of eventPath || []) {
      if (isFileTreeContainerElement(node)) return node;
    }
    return null;
  }

  function eventPathFromEvent(event) {
    if (typeof event?.composedPath === "function") return event.composedPath();
    const path = [];
    for (let node = elementFromEventTarget(event?.target); node; node = node.parentElement) path.push(node);
    path.push(document, w);
    return path;
  }

  function pathContextFromBlankFileTree(eventPath) {
    if (!fileTreeContainerFromEventPath(eventPath)) return null;
    const workspaceRoot = workspaceRootForDownloadPath(".");
    if (!workspaceRoot) return null;
    return {
      filePath: ".",
      itemType: "workspace-folder",
      rawPath: ".",
      source: "blank-file-tree",
    };
  }

  function elementFromEventTarget(target) {
    return target && target.nodeType === 1 ? target : target?.parentElement || null;
  }

  function pathContextFromEvent(event) {
    const eventPath = eventPathFromEvent(event);
    // 只接受文件树容器内部的右键事件，避免其他功能区复用类似 data-item-* 属性时误注入。
    if (!fileTreeContainerFromEventPath(eventPath)) return null;
    for (const node of eventPath) {
      const context = pathContextFromFileTreeElement(node, "event");
      if (context) return context;
    }
    const blankFileTreeContext = pathContextFromBlankFileTree(eventPath);
    if (blankFileTreeContext) return blankFileTreeContext;
    return pathContextFromElement(elementFromEventTarget(event?.target), "event-target");
  }

  function pathContextFromElement(element, source) {
    for (let node = element, depth = 0; node && node.nodeType === 1 && depth < 10; node = node.parentElement, depth += 1) {
      const context = pathContextFromFileTreeElement(node, source);
      if (context) return context;
    }
    return null;
  }

  function updateLastPathContext(context) {
    state.lastPathSource = context.source;
    state.lastRawPath = context.rawPath;
    state.lastResolvedPath = context.filePath;
  }

  function clearLastPathContext() {
    state.lastPathSource = "";
    state.lastRawPath = "";
    state.lastResolvedPath = "";
  }

  function eventClientPoint(event) {
    const x = Number(event?.clientX);
    const y = Number(event?.clientY);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    // 键盘触发的 contextmenu 常见坐标是 0,0；这类场景改用目标元素位置兜底。
    if (x === 0 && y === 0) return null;
    return { x, y };
  }

  function elementRectSnapshot(element) {
    if (!element || typeof element.getBoundingClientRect !== "function") return null;
    try {
      const rect = element.getBoundingClientRect();
      if (!rect || (!rect.width && !rect.height)) return null;
      return {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      };
    } catch {
      return null;
    }
  }

  function clearPendingPathMenuSession(reason) {
    pendingPathMenuSession = null;
    state.pendingPathMenuSession = false;
    state.lastMenuSessionClearReason = reason || "";
  }

  function createPendingPathMenuSession(event) {
    const context = pathContextFromEvent(event);
    if (!context) {
      clearPendingPathMenuSession("contextmenu-miss");
      clearLastPathContext();
      return null;
    }
    context.recordedAtMs = Date.now();
    // 文件树右键菜单用一次性会话绑定：事件源、路径、坐标和随后出现的菜单必须对应。
    pendingPathMenuSession = {
      id: nextPathMenuSessionId++,
      context,
      createdAtMs: context.recordedAtMs,
      point: eventClientPoint(event),
      target: elementFromEventTarget(event?.target),
      targetRect: elementRectSnapshot(elementFromEventTarget(event?.target)),
    };
    state.pendingPathMenuSession = true;
    state.lastMenuSessionClearReason = "";
    updateLastPathContext(context);
    return pendingPathMenuSession;
  }

  function freshPendingPathMenuSession() {
    if (!pendingPathMenuSession?.context?.filePath) return null;
    if (Date.now() - pendingPathMenuSession.createdAtMs > FILE_TREE_MENU_SESSION_TTL_MS) {
      clearPendingPathMenuSession("expired");
      return null;
    }
    return pendingPathMenuSession;
  }

  function absoluteDownloadUrl(payload) {
    const rawUrl = payload && typeof payload === "object" ? payload.downloadUrl || payload.url : "";
    if (typeof rawUrl !== "string" || !rawUrl) return "";
    try {
      return new URL(rawUrl, w.location.origin).href;
    } catch {
      return "";
    }
  }

  function truncateDebugText(value, maxLength = 220) {
    const text = normalizedText(value);
    if (text.length <= maxLength) return text;
    return `${text.slice(0, maxLength - 1)}…`;
  }

  function downloadDebugDetail(error, filePath) {
    const errorMessage = error instanceof Error ? error.message : String(error || "");
    const parts = [];
    // toast 里直接带上关键路径上下文，便于远端环境截图定位失败阶段。
    if (errorMessage) parts.push(`error=${truncateDebugText(errorMessage)}`);
    if (filePath || state.lastResolvedPath) parts.push(`path=${truncateDebugText(filePath || state.lastResolvedPath)}`);
    if (state.lastRawPath) parts.push(`raw=${truncateDebugText(state.lastRawPath)}`);
    if (state.lastPathSource) parts.push(`source=${truncateDebugText(state.lastPathSource)}`);
    const workspaceRoot = workspaceRootForDownloadPath(filePath || state.lastResolvedPath);
    if (workspaceRoot) parts.push(`root=${truncateDebugText(workspaceRoot)}`);
    return parts.join("\n");
  }

  function triggerDownload(payload) {
    const href = absoluteDownloadUrl(payload);
    if (!href) {
      showDownloadErrorToast("error=Download URL unavailable");
      return;
    }
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = safeDownloadName(payload && payload.name);
    anchor.rel = "noopener";
    anchor.style.display = "none";
    (document.body || document.documentElement).appendChild(anchor);
    anchor.click();
    w.setTimeout(() => {
      try {
        anchor.remove();
      } catch {}
    }, 0);
  }

  function showDownloadErrorToast(detail) {
    const baseDescription = t("web.remoteFile.downloadFailed");
    const debugDetail = String(detail || "").trim();
    showToast({
      level: "danger",
      source: "codex-web-remote-file",
      description: debugDetail ? `${baseDescription}\n${debugDetail}` : baseDescription,
    });
  }

  function stopMenuEvent(event) {
    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
  }

  function resolveDownloadPath(downloadItem) {
    const fromDownloadItem = downloadPathCandidate(downloadItem?.dataset?.codexRemotePathDownloadPath);
    if (fromDownloadItem) return fromDownloadItem;
    // 下载入口只使用创建时写入的路径，避免旧右键目标污染其他菜单。
    return "";
  }

  async function requestPathDownload(filePath) {
    const workspaceRoot = workspaceRootForDownloadPath(filePath);
    const response = await w.fetch(DOWNLOAD_PATH_API, {
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: filePath, workspaceRoot }),
    });
    const json = await response.json().catch(() => null);
    if (!response.ok || !json || json.ok === false) {
      const responseError = json && typeof json.error === "string" ? json.error : response.statusText || "Request failed";
      throw new Error(`HTTP ${response.status}: ${responseError}`);
    }
    return json.value && typeof json.value === "object" ? json.value : json;
  }

  function markDownloadItemBusy(item, busy) {
    if (!item) return;
    item.toggleAttribute("disabled", busy);
    item.setAttribute("aria-disabled", busy ? "true" : "false");
    item.dataset.codexRemotePathDownloadBusy = busy ? "true" : "false";
  }

  async function downloadPathFromMenuItem(item) {
    if (!shouldEnableRemoteFileActions() || item?.dataset?.codexRemotePathDownloadBusy === "true") return;
    markDownloadItemBusy(item, true);
    try {
      const filePath = resolveDownloadPath(item);
      state.lastDownloadPath = filePath || "";
      if (!filePath) throw new Error("Path unavailable");
      const payload = await requestPathDownload(filePath);
      state.lastDownloadError = "";
      state.lastDownloadDetail = "";
      state.pathDownloads += 1;
      triggerDownload(payload);
    } catch (error) {
      state.lastDownloadError = error instanceof Error ? error.message : String(error);
      state.lastDownloadDetail = downloadDebugDetail(error, state.lastDownloadPath);
      showDownloadErrorToast(state.lastDownloadDetail);
    } finally {
      markDownloadItemBusy(item, false);
    }
  }

  function handleGatewayMessage(event) {
    const data = event && event.data;
    if (!data || typeof data !== "object") return;
    if (data.type === "codex-web:download-file") {
      triggerDownload(data);
      return;
    }
    if (data.type === "codex-web:download-file-error") {
      const detail = typeof data.error === "string" && data.error ? `error=${data.error}` : "error=Gateway download event failed";
      showDownloadErrorToast(detail);
    }
  }

  function isMenuContainer(element) {
    if (!element || element.nodeType !== 1) return false;
    const role = String(element.getAttribute?.("role") || "").toLowerCase();
    return (
      role === "menu" ||
      role === "menubar" ||
      element.hasAttribute?.("data-radix-menu-content") ||
      element.hasAttribute?.("data-radix-popper-content-wrapper")
    );
  }

  function menuContentElement(element) {
    if (!element || element.nodeType !== 1) return null;
    if (!isMenuContainer(element)) return null;
    const role = String(element.getAttribute?.("role") || "").toLowerCase();
    if (role === "menu" || role === "menubar" || element.hasAttribute?.("data-radix-menu-content")) {
      return element;
    }
    return element.querySelector?.("[role='menu'],[role='menubar'],[data-radix-menu-content]") || null;
  }

  function rectDistanceToPoint(rect, point) {
    const dx = point.x < rect.left ? rect.left - point.x : point.x > rect.right ? point.x - rect.right : 0;
    const dy = point.y < rect.top ? rect.top - point.y : point.y > rect.bottom ? point.y - rect.bottom : 0;
    return Math.hypot(dx, dy);
  }

  function rectCenterPoint(rect) {
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    };
  }

  function menuMatchesPendingPathSession(menuContainer, content, session) {
    if (!session?.context?.filePath || !content) return false;
    const menuRect = elementRectSnapshot(content) || elementRectSnapshot(menuContainer);
    if (!menuRect) return false;
    // 鼠标右键菜单必须靠近本次右键坐标，避免账户菜单等后续 portal 菜单误用文件树路径。
    if (session.point) {
      return rectDistanceToPoint(menuRect, session.point) <= FILE_TREE_MENU_ANCHOR_MARGIN_PX;
    }
    if (!session.targetRect) return true;
    return rectDistanceToPoint(menuRect, rectCenterPoint(session.targetRect)) <= FILE_TREE_MENU_ANCHOR_MARGIN_PX * 2;
  }

  function createStandalonePathDownloadMenuItem(pathContext) {
    const item = document.createElement("div");
    const label = t("web.remoteFile.downloadFile");
    item.dataset.codexRemotePathDownload = "true";
    item.dataset.codexRemotePathDownloadBusy = "false";
    item.dataset.codexRemoteStandalonePathDownload = "true";
    if (pathContext?.filePath) item.dataset.codexRemotePathDownloadPath = pathContext.filePath;
    item.setAttribute("role", "menuitem");
    item.setAttribute("tabindex", "-1");
    item.setAttribute("aria-disabled", "false");
    item.setAttribute("aria-label", label);
    item.setAttribute("title", label);
    // 不复用官方菜单项文案或结构，只插入 OpenCodex 自己的稳定下载入口。
    item.className =
      "text-token-foreground outline-hidden rounded-lg p-1.5 text-sm cursor-interaction hover:bg-token-list-hover-background focus:bg-token-list-hover-background";
    item.textContent = label;
    item.addEventListener("pointerdown", (event) => {
      stopMenuEvent(event);
    });
    item.addEventListener("click", (event) => {
      stopMenuEvent(event);
      downloadPathFromMenuItem(item);
    });
    item.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      stopMenuEvent(event);
      downloadPathFromMenuItem(item);
    });
    return item;
  }

  function pendingPathSessionForMenu(menuContainer) {
    const session = freshPendingPathMenuSession();
    const content = menuContentElement(menuContainer);
    if (!session || !content || !menuMatchesPendingPathSession(menuContainer, content, session)) return null;
    return { session, content };
  }

  function injectPathDownloadMenuItem(menuContainer) {
    const matched = pendingPathSessionForMenu(menuContainer);
    if (!matched) return false;
    const { session, content } = matched;
    if (content.querySelector?.("[data-codex-remote-path-download='true']")) {
      clearPendingPathMenuSession("already-injected");
      return false;
    }
    content.appendChild(createStandalonePathDownloadMenuItem(session.context));
    state.injectedPathDownloadItems += 1;
    clearPendingPathMenuSession("injected");
    return true;
  }

  function scanMenuContainersForPathDownload(scope) {
    if (!freshPendingPathMenuSession()) return;
    const candidates = new Set();
    for (const element of Array.from(scope.querySelectorAll?.("[role='menu'],[role='menubar'],[data-radix-menu-content],[data-radix-popper-content-wrapper]") || [])) {
      candidates.add(element);
    }
    if (scope && scope !== document && isMenuContainer(scope)) candidates.add(scope);
    if (scope && scope !== document && typeof scope.closest === "function") {
      const closestMenu = scope.closest("[role='menu'],[role='menubar'],[data-radix-menu-content],[data-radix-popper-content-wrapper]");
      if (closestMenu) candidates.add(closestMenu);
    }
    for (const candidate of candidates) {
      if (injectPathDownloadMenuItem(candidate)) break;
    }
  }

  function scanMenuItems(root) {
    if (!shouldEnableRemoteFileActions()) return;
    if (!freshPendingPathMenuSession()) return;
    state.lastScanAtMs = Date.now();
    const scope = root && root.nodeType === 1 ? root : document;
    scanMenuContainersForPathDownload(scope);
  }

  function schedulePendingMenuScans() {
    if (!freshPendingPathMenuSession()) return;
    const scanDocument = () => scanMenuItems(document);
    if (typeof w.requestAnimationFrame === "function") w.requestAnimationFrame(scanDocument);
    w.setTimeout(scanDocument, 50);
    w.setTimeout(scanDocument, 150);
  }

  function installMenuObserver() {
    if (!document || !shouldEnableRemoteFileActions()) return;
    const start = () => {
      document.addEventListener(
        "contextmenu",
        (event) => {
          if (createPendingPathMenuSession(event)) schedulePendingMenuScans();
        },
        true
      );
      document.addEventListener(
        "pointerdown",
        (event) => {
          // 普通点击会打开大量非文件树菜单，必须切断之前的文件树右键会话。
          if (event.button !== 2) clearPendingPathMenuSession("pointerdown");
        },
        true
      );
      document.addEventListener(
        "keydown",
        (event) => {
          // ContextMenu / Shift+F10 可能触发键盘右键菜单，等后续 contextmenu 事件重新建会话。
          if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) return;
          clearPendingPathMenuSession("keydown");
        },
        true
      );
      const observer = new MutationObserver((mutations) => {
        if (!freshPendingPathMenuSession()) return;
        for (const mutation of mutations) {
          if (mutation.type === "characterData") {
            const parent = mutation.target && mutation.target.parentElement;
            if (parent) scanMenuItems(parent);
            continue;
          }
          for (const node of mutation.addedNodes || []) {
            if (node && node.nodeType === 1) scanMenuItems(node);
          }
        }
      });
      observer.observe(document.documentElement, { characterData: true, childList: true, subtree: true });
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", start, { once: true });
    } else {
      start();
    }
  }

  w.addEventListener("message", handleGatewayMessage);
  installWorkspaceRootCapture();
  installMenuObserver();
})();
