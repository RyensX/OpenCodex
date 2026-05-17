// @ts-nocheck
export {};

const fs = require("fs");
const path = require("path");
const os = require("os");

function createWorkspaceIpcHandlers(deps) {
  const PROJECT_ROOT = deps.projectRoot;
  const CODEX_ASSET_ROOTS = deps.codexAssetRoots || [];
  const DESKTOP_PROJECT_ROOTS_KEY = deps.desktopProjectRootsKey;
  const DESKTOP_WORKSPACE_LABELS_KEY = deps.desktopWorkspaceLabelsKey;
  const GLOBAL_STATE = deps.globalState;
  const getDesktopGlobalStateValue = deps.getDesktopGlobalStateValue;
  const setDesktopGlobalStateValue = deps.setDesktopGlobalStateValue;
  const getGlobalStateValue = deps.getGlobalStateValue;
  const normalizeWorkspacePath = deps.normalizeWorkspacePath;

  /** 解析允许暴露给 Web 的 workspace roots，优先环境变量，其次复用 Desktop 状态。 */
  function parseWorkspaceRoots() {
    const configuredRoots = (process.env.CODEX_WEB_WORKSPACE_ROOTS || "")
      .split(",")
      .map((root) => root.trim())
      .filter(Boolean);
    if (configuredRoots.length > 0) return configuredRoots;
    const desktopRoots = getDesktopGlobalStateValue(DESKTOP_PROJECT_ROOTS_KEY);
    if (Array.isArray(desktopRoots)) {
      const validRoots = desktopRoots.filter((root) => typeof root === "string" && root.trim());
      if (validRoots.length > 0) return validRoots;
    }
    const storedRoots =
      GLOBAL_STATE.get(DESKTOP_PROJECT_ROOTS_KEY) ||
      GLOBAL_STATE.get("workspace-root-options") ||
      GLOBAL_STATE.get("WORKSPACE_ROOT_OPTIONS") ||
      GLOBAL_STATE.get("workspaceRootOptions") ||
      null;
    if (Array.isArray(storedRoots)) {
      const validRoots = storedRoots.filter((root) => typeof root === "string" && root.trim());
      if (validRoots.length > 0) return validRoots;
    }
    return [PROJECT_ROOT];
  }
  
  /** 安全解析真实路径，失败时返回 null 而不是抛出。 */
  function realpathSafe(filePath) {
    try {
      return fs.realpathSync.native ? fs.realpathSync.native(filePath) : fs.realpathSync(filePath);
    } catch {
      return null;
    }
  }
  
  /** 限制本地文件/目录访问只能发生在允许的 workspace 或 Codex asset root 内。 */
  function isWithinAllowedRoots(filePath) {
    const candidate = realpathSafe(filePath);
    if (!candidate) return false;
    for (const root of [...activeWorkspaceRootPaths(), ...parseWorkspaceRoots(), ...CODEX_ASSET_ROOTS]) {
      const rootReal = realpathSafe(root);
      if (!rootReal) continue;
      const rel = path.relative(rootReal, candidate);
      if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
        return true;
      }
    }
    return false;
  }
  
  /** 读取 workspace root 的显示名映射。 */
  function workspaceRootLabelMap() {
    const labels =
      getDesktopGlobalStateValue(DESKTOP_WORKSPACE_LABELS_KEY) ||
      GLOBAL_STATE.get(DESKTOP_WORKSPACE_LABELS_KEY) ||
      GLOBAL_STATE.get("workspace-root-labels") ||
      GLOBAL_STATE.get("WORKSPACE_ROOT_LABELS") ||
      {};
    return labels && typeof labels === "object" && !Array.isArray(labels) ? labels : {};
  }
  
  /** 返回 renderer 使用的 workspace root 列表。 */
  function listWorkspaceRoots() {
    const labels = workspaceRootLabelMap();
    return parseWorkspaceRoots().map((root) => {
      const resolved = realpathSafe(root) || path.resolve(root);
      return {
        id: resolved,
        path: resolved,
        label: labels[resolved] || labels[root] || path.basename(resolved) || resolved,
        kind: "local",
      };
    });
  }
  
  /** workspace-root-options IPC 的返回格式。 */
  function workspaceRootOptions() {
    const roots = listWorkspaceRoots();
    const storedLabels = workspaceRootLabelMap();
    return {
      roots: roots.map((root) => root.path),
      labels: Object.fromEntries(
        roots.map((root) => [
          root.path,
          storedLabels && typeof storedLabels === "object" && typeof storedLabels[root.path] === "string"
            ? storedLabels[root.path]
            : root.label,
        ])
      ),
    };
  }
  
  /** 获取当前激活 workspace root，缺省时回退到全部 root。 */
  function activeWorkspaceRootPaths() {
    const stored =
      getDesktopGlobalStateValue("active-workspace-roots") ||
      GLOBAL_STATE.get("active-workspace-roots") ||
      GLOBAL_STATE.get("ACTIVE_WORKSPACE_ROOTS") ||
      null;
    if (Array.isArray(stored)) {
      const valid = stored.filter((root) => typeof root === "string" && root.trim());
      return valid;
    }
    return listWorkspaceRoots().map((root) => root.path);
  }
  
  /** 新增项目根目录，并同步写入 Desktop/globalState。 */
  function addWorkspaceRootOption(payload) {
    if (!payload || typeof payload !== "object") return { success: true };
    const root = typeof payload.root === "string" && payload.root.trim() ? payload.root.trim() : null;
    if (!root) return { success: false, error: "Missing root" };
    const resolved = realpathSafe(root) || path.resolve(root);
    const roots = listWorkspaceRoots().map((entry) => entry.path);
    const nextRoots = [resolved, ...roots.filter((entry) => entry !== resolved)];
    GLOBAL_STATE.set("workspace-root-options", nextRoots);
    GLOBAL_STATE.set(DESKTOP_PROJECT_ROOTS_KEY, nextRoots);
    setDesktopGlobalStateValue(DESKTOP_PROJECT_ROOTS_KEY, nextRoots);
    if (typeof payload.label === "string" && payload.label.trim()) {
      const labels = getGlobalStateValue("workspace-root-labels") || {};
      const nextLabels = { ...labels, [resolved]: payload.label.trim() };
      GLOBAL_STATE.set("workspace-root-labels", nextLabels);
      GLOBAL_STATE.set(DESKTOP_WORKSPACE_LABELS_KEY, nextLabels);
      setDesktopGlobalStateValue(DESKTOP_WORKSPACE_LABELS_KEY, nextLabels);
    }
    if (payload.setActive) {
      GLOBAL_STATE.set("active-workspace-roots", [resolved]);
      setDesktopGlobalStateValue("active-workspace-roots", [resolved]);
    }
    return { success: true };
  }
  
  /** 比较两个字符串数组是否完全一致，用于判断 active roots 是否需要广播刷新。 */
  function sameStringArray(left, right) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((entry, index) => entry === right[index])
    );
  }
  
  /** 归一化前端传回的项目根目录列表，过滤非法路径并按真实路径去重。 */
  function normalizeWorkspaceRootList(roots) {
    const seen = new Set();
    const normalized = [];
    for (const root of Array.isArray(roots) ? roots : []) {
      const resolved = normalizeWorkspacePath(root);
      if (!resolved) continue;
      const comparable = normalizeComparablePath(resolved);
      if (seen.has(comparable)) continue;
      seen.add(comparable);
      normalized.push(resolved);
    }
    return normalized;
  }
  
  /** 保存完整项目列表；移除当前 active root 时自动切到剩余第一个项目。 */
  function setWorkspaceRootOptions(roots) {
    const nextRoots = normalizeWorkspaceRootList(roots);
    const nextRootSet = new Set(nextRoots.map(normalizeComparablePath));
    const labels = workspaceRootLabelMap();
    const nextLabels = {};
    for (const root of nextRoots) {
      if (typeof labels[root] === "string") nextLabels[root] = labels[root];
    }
  
    const previousActiveRoots = activeWorkspaceRootPaths();
    let nextActiveRoots = previousActiveRoots.filter((root) => nextRootSet.has(normalizeComparablePath(root)));
    if (nextActiveRoots.length === 0 && nextRoots.length > 0) nextActiveRoots = [nextRoots[0]];
  
    GLOBAL_STATE.set("workspace-root-options", nextRoots);
    GLOBAL_STATE.set(DESKTOP_PROJECT_ROOTS_KEY, nextRoots);
    GLOBAL_STATE.set("workspace-root-labels", nextLabels);
    GLOBAL_STATE.set(DESKTOP_WORKSPACE_LABELS_KEY, nextLabels);
    GLOBAL_STATE.set("active-workspace-roots", nextActiveRoots);
    setDesktopGlobalStateValue(DESKTOP_PROJECT_ROOTS_KEY, nextRoots);
    setDesktopGlobalStateValue(DESKTOP_WORKSPACE_LABELS_KEY, nextLabels);
    setDesktopGlobalStateValue("active-workspace-roots", nextActiveRoots);
  
    return {
      success: true,
      activeRootsChanged: !sameStringArray(previousActiveRoots, nextActiveRoots),
    };
  }
  
  /** 更新单个项目显示名；项目不存在时保持幂等，避免前端旧消息导致报错。 */
  function renameWorkspaceRootOption(payload) {
    if (!payload || typeof payload !== "object") return { success: true };
    const root = normalizeWorkspacePath(payload.root);
    if (!root) return { success: false, error: "Missing root" };
    const roots = listWorkspaceRoots().map((entry) => entry.path);
    if (!roots.some((entry) => normalizeComparablePath(entry) === normalizeComparablePath(root))) {
      return { success: true };
    }
    const labels = workspaceRootLabelMap();
    const nextLabels = { ...labels };
    const label = typeof payload.label === "string" ? payload.label.trim() : "";
    if (label) nextLabels[root] = label;
    else delete nextLabels[root];
    GLOBAL_STATE.set("workspace-root-labels", nextLabels);
    GLOBAL_STATE.set(DESKTOP_WORKSPACE_LABELS_KEY, nextLabels);
    setDesktopGlobalStateValue(DESKTOP_WORKSPACE_LABELS_KEY, nextLabels);
    return { success: true };
  }
  
  /** 将某个 root 设为当前 active workspace。 */
  function setActiveWorkspaceRoot(root) {
    if (typeof root !== "string" || !root.trim()) return false;
    const resolved = realpathSafe(root.trim()) || path.resolve(root.trim());
    const roots = listWorkspaceRoots().map((entry) => entry.path);
    const nextRoots = [resolved, ...roots.filter((entry) => entry !== resolved)];
    GLOBAL_STATE.set("workspace-root-options", nextRoots);
    GLOBAL_STATE.set(DESKTOP_PROJECT_ROOTS_KEY, nextRoots);
    GLOBAL_STATE.set("active-workspace-roots", [resolved]);
    setDesktopGlobalStateValue(DESKTOP_PROJECT_ROOTS_KEY, nextRoots);
    setDesktopGlobalStateValue("active-workspace-roots", [resolved]);
    return true;
  }
  
  /** 清空 active workspace，用于 projectless 场景。 */
  function clearActiveWorkspaceRoot() {
    GLOBAL_STATE.set("active-workspace-roots", []);
    setDesktopGlobalStateValue("active-workspace-roots", []);
  }
  
  /** 路径比较前去掉尾部斜杠，避免同一路径被视为不同。 */
  function normalizeComparablePath(filePath) {
    return String(filePath || "").replace(/\/+$/, "");
  }
  
  /** 实现 paths-exist，防止 renderer 把实际存在的 project 误判为已删除。 */
  function pathsExist(payload) {
    const params = payload && typeof payload === "object" && payload.params ? payload.params : payload;
    const inputPaths = Array.isArray(params && params.paths) ? params.paths : [];
    const existingPaths = [];
    const seen = new Set();
    for (const candidate of inputPaths) {
      if (typeof candidate !== "string" || !candidate.trim()) continue;
      const expanded = candidate.startsWith("~")
        ? path.join(os.homedir(), candidate.slice(1))
        : candidate;
      const resolved = realpathSafe(expanded) || (fs.existsSync(expanded) ? path.resolve(expanded) : null);
      if (!resolved) continue;
      const comparable = normalizeComparablePath(resolved);
      if (seen.has(comparable)) continue;
      seen.add(comparable);
      existingPaths.push(resolved);
    }
    return { existingPaths };
  }
  
  /** projects:list 使用的项目列表，基于 workspace roots 构造。 */
  function listProjects() {
    return listWorkspaceRoots().map((root) => ({
      id: root.id,
      path: root.path,
      label: root.label,
      name: root.label,
      kind: root.kind,
      repoPath: root.path,
      rootPath: root.path,
    }));
  }
  
  /** 从 projects:browse payload 中提取目标目录。 */
  function resolveProjectBrowsePath(payload) {
    if (!payload || typeof payload !== "object") return null;
    const direct =
      payload.path ||
      payload.directoryPath ||
      payload.root ||
      payload.rootPath ||
      payload.projectPath ||
      payload.projectId ||
      null;
    if (typeof direct === "string" && direct.trim()) return direct;
    return null;
  }
  
  /** 浏览项目目录，只允许列出 allowlist 内的路径。 */
  function browseProjects(payload) {
    const requestedPath = resolveProjectBrowsePath(payload);
    if (!requestedPath) {
      return {
        roots: listWorkspaceRoots(),
        projects: listProjects(),
        entries: [],
      };
    }
  
    const resolved = realpathSafe(requestedPath) || path.resolve(requestedPath);
    if (!isWithinAllowedRoots(resolved)) {
      return {
        roots: listWorkspaceRoots(),
        projects: listProjects(),
        entries: [],
      };
    }
  
    return {
      roots: listWorkspaceRoots(),
      projects: listProjects(),
      entries: listDirectoryEntries(resolved),
      path: resolved,
    };
  }

  /** 列出目录内容，用于项目浏览和文件树，访问范围必须受 allowlist 限制。 */
  function listDirectoryEntries(directoryPath) {
    const resolved = realpathSafe(directoryPath);
    if (!resolved || !isWithinAllowedRoots(resolved)) return [];
    try {
      return fs
        .readdirSync(resolved, { withFileTypes: true })
        .filter((entry) => !entry.name.startsWith("."))
        .map((entry) => {
          const entryPath = path.join(resolved, entry.name);
          const stats = fs.statSync(entryPath);
          const type = entry.isDirectory() ? "directory" : "file";
          return {
            name: entry.name,
            path: entryPath,
            type,
            kind: type,
            isDirectory: entry.isDirectory(),
            size: stats.size,
            mtimeMs: stats.mtimeMs,
          };
        });
    } catch {
      return [];
    }
  }
  
  /** workspace-directory-entries IPC 的实现，返回相对路径给 renderer 文件树。 */
  function listWorkspaceDirectoryEntries(payload) {
    const params = payload && typeof payload === "object" && payload.params ? payload.params : payload;
    const workspaceRoot =
      params && typeof params === "object" ? params.workspaceRoot || params.root || null : null;
    const directoryPath = params && typeof params === "object" ? params.directoryPath || null : null;
    const includeHidden = !!(params && typeof params === "object" && params.includeHidden);
    const root = realpathSafe(workspaceRoot);
    if (!root || !isWithinAllowedRoots(root)) return { entries: [] };
    const requested =
      typeof directoryPath === "string" && directoryPath
        ? path.isAbsolute(directoryPath)
          ? directoryPath
          : path.join(root, directoryPath)
        : root;
    const resolved = realpathSafe(requested);
    if (!resolved || resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) return { entries: [] };
    try {
      const entries = fs
        .readdirSync(resolved, { withFileTypes: true })
        .filter((entry) => includeHidden || !entry.name.startsWith("."))
        .map((entry) => {
          const entryPath = path.join(resolved, entry.name);
          const stats = fs.statSync(entryPath);
          const type = entry.isDirectory() ? "directory" : "file";
          const relativePath = path.relative(root, entryPath).split(path.sep).join("/");
          return {
            name: entry.name,
            path: relativePath,
            absolutePath: entryPath,
            type,
            kind: type,
            isDirectory: entry.isDirectory(),
            size: stats.size,
            mtimeMs: stats.mtimeMs,
          };
        })
        .sort((a, b) => {
          if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
      return { entries };
    } catch (error) {
      return {
        entries: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return {
    activeWorkspaceRootPaths,
    addWorkspaceRootOption,
    browseProjects,
    clearActiveWorkspaceRoot,
    isWithinAllowedRoots,
    listProjects,
    listWorkspaceDirectoryEntries,
    listWorkspaceRoots,
    parseWorkspaceRoots,
    pathsExist,
    realpathSafe,
    renameWorkspaceRootOption,
    setActiveWorkspaceRoot,
    setWorkspaceRootOptions,
    workspaceRootOptions,
  };
}

module.exports = {
  createWorkspaceIpcHandlers,
};
