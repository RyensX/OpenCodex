// @ts-nocheck
export {};

const path = require("path");
const os = require("os");

function createWorkspaceRuntime(deps) {
  const PROJECT_ROOT = deps.projectRoot;
  const SETTINGS_STATE = deps.settingsState;
  const DESKTOP_ARCHIVED_THREADS_KEY = deps.desktopArchivedThreadsKey;
  const GLOBAL_STATE = deps.globalState;
  const getDesktopGlobalStateValue = deps.getDesktopGlobalStateValue;
  const setDesktopGlobalStateValue = deps.setDesktopGlobalStateValue;
  const listWorkspaceRoots = deps.listWorkspaceRoots;
  const activeWorkspaceRootPaths = deps.activeWorkspaceRootPaths;
  const parseWorkspaceRoots = deps.parseWorkspaceRoots;
  const realpathSafe = deps.realpathSafe;
  const isWithinAllowedRoots = deps.isWithinAllowedRoots;

  /** 获取归档会话列表，和 Codex Desktop 共用 globalState。 */
  function listArchivedThreads() {
    const desktopValue = getDesktopGlobalStateValue(DESKTOP_ARCHIVED_THREADS_KEY);
    if (Array.isArray(desktopValue)) return desktopValue;
    return SETTINGS_STATE[DESKTOP_ARCHIVED_THREADS_KEY] && Array.isArray(SETTINGS_STATE[DESKTOP_ARCHIVED_THREADS_KEY])
      ? SETTINGS_STATE[DESKTOP_ARCHIVED_THREADS_KEY]
      : [];
  }
  
  /** 保存归档会话列表，写回 Codex Desktop globalState。 */
  function setArchivedThreads(threads) {
    const nextThreads = Array.isArray(threads) ? threads : [];
    SETTINGS_STATE[DESKTOP_ARCHIVED_THREADS_KEY] = nextThreads;
    setDesktopGlobalStateValue(DESKTOP_ARCHIVED_THREADS_KEY, nextThreads);
  }
  
  /** ambient suggestions 未实现时返回空结构，满足 renderer 数据形态。 */
  function buildEmptyAmbientSuggestionsFile(projectRoot = "") {
    return {
      projectRoot: typeof projectRoot === "string" ? projectRoot : "",
      generatedAtMs: null,
      currentSuggestionIds: [],
      suggestions: [],
    };
  }
  
  /** 根据邮箱域名猜测 provider，仅作为 UI 兜底展示。 */
  function guessMailProvider(domain) {
    const normalized = typeof domain === "string" ? domain.trim().toLowerCase() : "";
    if (!normalized) return null;
    if (["gmail.com", "googlemail.com"].includes(normalized)) return "google";
    if (["outlook.com", "hotmail.com", "live.com", "msn.com"].includes(normalized)) return "microsoft";
    if (["icloud.com", "me.com", "mac.com"].includes(normalized)) return "apple";
    if (["yahoo.com", "ymail.com", "rocketmail.com"].includes(normalized)) return "yahoo";
    if (normalized.endsWith(".edu")) return "school";
    return null;
  }
  
  /** projectless 会话也需要一个 cwd，缺省使用第一个 workspace root。 */
  function getProjectlessWorkspaceRoot() {
    const roots = listWorkspaceRoots();
    return roots.length > 0 ? roots[0].path : PROJECT_ROOT;
  }
  
  /** projectless thread 的目录上下文。 */
  function resolveProjectlessThreadContext() {
    const workspaceRoots = listWorkspaceRoots();
    const workspaceRoot = workspaceRoots.length > 0 ? workspaceRoots[0].path : PROJECT_ROOT;
    return {
      cwd: workspaceRoot,
      outputDirectory: workspaceRoot,
      projectlessOutputDirectory: workspaceRoot,
      workspaceRoot,
      workspaceRoots: workspaceRoots.length > 0 ? workspaceRoots.map((root) => root.path) : [workspaceRoot],
    };
  }
  
  /** ide-context IPC 的 Web 兜底实现。 */
  function buildIdeContext(payload) {
    const workspaceRoots = listWorkspaceRoots().map((root) => root.path);
    return {
      cwd:
        (payload && typeof payload === "object" && typeof payload.cwd === "string" && payload.cwd) ||
        workspaceRoots[0] ||
        PROJECT_ROOT,
      workspaceRoots,
      openFiles: [],
      selectedFile: null,
      diagnostics: [],
    };
  }
  
  /** 规范化 workspace 路径，支持 ~ 展开。 */
  function normalizeWorkspacePath(candidate) {
    if (typeof candidate !== "string" || !candidate.trim()) return null;
    const trimmed = candidate.trim();
    const expanded =
      trimmed === "~" || trimmed.startsWith("~/")
        ? path.join(os.homedir(), trimmed.slice(1))
        : trimmed;
    return realpathSafe(expanded) || path.resolve(expanded);
  }
  
  /** 创建会话前整理 cwd/workspaceRoots，并回退到 active workspace。 */
  function normalizeStartConversationRoots(payload) {
    const inputRoots = Array.isArray(payload && payload.workspaceRoots) ? payload.workspaceRoots : [];
    const roots = inputRoots.map((root) => normalizeWorkspacePath(root)).filter(Boolean);
    const cwd =
      normalizeWorkspacePath(payload && payload.cwd) ||
      roots[0] ||
      activeWorkspaceRootPaths()[0] ||
      listWorkspaceRoots()[0]?.path ||
      PROJECT_ROOT;
    return {
      cwd,
      workspaceRoots: roots.length > 0 ? roots : [cwd],
    };
  }
  
  /** 把 renderer 权限选择转换成 app-server 认识的 approval/sandbox 字段。 */
  function permissionsForAppServer(payload) {
    const params = payload && typeof payload === "object" ? payload : {};
    const permissions =
      params.permissions && typeof params.permissions === "object"
        ? params.permissions
        : {};
    const permissionProfile =
      params.permissionProfile ??
      permissions.permissionProfile ??
      params.agentMode ??
      permissions.agentMode ??
      null;
    const sandboxPolicy =
      params.sandboxPolicy ??
      permissions.sandboxPolicy ??
      (params.sandbox && typeof params.sandbox === "object" ? params.sandbox : null) ??
      (permissions.sandbox && typeof permissions.sandbox === "object" ? permissions.sandbox : null);
    const sandboxMode =
      (typeof params.sandbox === "string" && params.sandbox) ||
      (typeof permissions.sandbox === "string" && permissions.sandbox) ||
      sandboxModeFromPolicy(sandboxPolicy);
    if (permissionProfile === "guardian-approvals") {
      return {
        approvalPolicy: "on-request",
        approvalsReviewer: "guardian_subagent",
        sandboxMode: sandboxMode || "workspace-write",
        sandboxPolicy,
        permissionProfile: null,
      };
    }
    return {
      approvalPolicy: params.approvalPolicy ?? permissions.approvalPolicy ?? null,
      approvalsReviewer: params.approvalsReviewer ?? permissions.approvalsReviewer ?? "user",
      sandboxMode,
      sandboxPolicy,
      permissionProfile,
    };
  }
  
  /** 从 sandboxPolicy 对象反推老字段 sandboxMode。 */
  function sandboxModeFromPolicy(sandboxPolicy) {
    if (!sandboxPolicy || typeof sandboxPolicy !== "object") return null;
    switch (sandboxPolicy.type) {
      case "readOnly":
        return "read-only";
      case "workspaceWrite":
        return "workspace-write";
      case "dangerFullAccess":
        return "danger-full-access";
      case "externalSandbox":
        return null;
      default:
        return null;
    }
  }
  
  /** 记录 threadId 到 workspaceRoot 的映射，刷新后仍能找到会话所属项目。 */
  function recordThreadWorkspaceRoot(threadId, workspaceRoot, workspaceKind) {
    if (typeof threadId !== "string" || !threadId || typeof workspaceRoot !== "string" || !workspaceRoot) {
      return;
    }
    const hints = getDesktopGlobalStateValue("thread-workspace-root-hints");
    const nextHints = hints && typeof hints === "object" && !Array.isArray(hints) ? { ...hints } : {};
    nextHints[threadId] = workspaceRoot;
    GLOBAL_STATE.set("thread-workspace-root-hints", nextHints);
    setDesktopGlobalStateValue("thread-workspace-root-hints", nextHints);
  
    if (workspaceKind === "projectless") {
      const projectlessIds = getDesktopGlobalStateValue("projectless-thread-ids");
      const nextIds = Array.isArray(projectlessIds) ? projectlessIds.filter((id) => id !== threadId) : [];
      nextIds.unshift(threadId);
      GLOBAL_STATE.set("projectless-thread-ids", nextIds);
      setDesktopGlobalStateValue("projectless-thread-ids", nextIds);
    }
  }
  
  /** 从真实 thread/start 返回值提取 threadId；只读响应结构，不生成任何 Web 侧假会话。 */
  function threadIdFromThreadStartResult(result) {
    if (!result || typeof result !== "object") return null;
    if (typeof result.threadId === "string" && result.threadId) return result.threadId;
    if (typeof result.conversationId === "string" && result.conversationId) return result.conversationId;
    const thread = result.thread && typeof result.thread === "object" ? result.thread : null;
    return thread && typeof thread.id === "string" && thread.id ? thread.id : null;
  }
  
  /** thread/start 成功后写入 Desktop 同款 workspace hint；历史本体仍由 app-server 持久化。 */
  function recordThreadStartMetadata(result, payload, options = {}) {
    const threadId = threadIdFromThreadStartResult(result);
    if (!threadId) return null;
    const params = payload && typeof payload === "object" ? payload : {};
    const thread = result && typeof result === "object" && result.thread && typeof result.thread === "object"
      ? result.thread
      : null;
    const workspaceRoots = Array.isArray(params.workspaceRoots) ? params.workspaceRoots : [];
    const workspaceRoot =
      options.workspaceRoot ||
      workspaceRoots.find((root) => typeof root === "string" && root) ||
      (typeof params.cwd === "string" && params.cwd ? params.cwd : null) ||
      (result && typeof result.cwd === "string" && result.cwd ? result.cwd : null) ||
      (thread && typeof thread.cwd === "string" && thread.cwd ? thread.cwd : null);
    const workspaceKind =
      options.workspaceKind ||
      (params.workspaceKind === "projectless" ? "projectless" : "project");
    recordThreadWorkspaceRoot(threadId, workspaceRoot, workspaceKind);
    return threadId;
  }
  
  /** 根据 threadId 找回它所属的 workspace root。 */
  function getThreadWorkspaceRoot(threadId) {
    if (typeof threadId !== "string" || !threadId) return null;
    const hints =
      getDesktopGlobalStateValue("thread-workspace-root-hints") ||
      GLOBAL_STATE.get("thread-workspace-root-hints") ||
      GLOBAL_STATE.get("THREAD_WORKSPACE_ROOT_HINTS") ||
      null;
    const hinted = hints && typeof hints === "object" && !Array.isArray(hints) ? hints[threadId] : null;
    return typeof hinted === "string" && hinted ? hinted : null;
  }
  
  /** 终端 cwd 解析：优先显式 cwd，其次 thread hint，再回退到 active workspace。 */
  function resolveGatewayTerminalCwd(payload) {
    const requested =
      payload && typeof payload === "object" && typeof payload.cwd === "string" ? payload.cwd : null;
    const conversationId =
      payload && typeof payload === "object" && typeof payload.conversationId === "string"
        ? payload.conversationId
        : null;
    const candidates = [
      requested,
      getThreadWorkspaceRoot(conversationId),
      activeWorkspaceRootPaths()[0],
      listWorkspaceRoots()[0]?.path,
      PROJECT_ROOT,
    ];
    for (const candidate of candidates) {
      const resolved = normalizeWorkspacePath(candidate);
      if (resolved && isWithinAllowedRoots(resolved)) return resolved;
    }
    return PROJECT_ROOT;
  }
  
  /** shell 参数单引号转义，用于终端自动 cd。 */
  function shellQuote(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
  }

  return {
    buildEmptyAmbientSuggestionsFile,
    buildIdeContext,
    getProjectlessWorkspaceRoot,
    guessMailProvider,
    listArchivedThreads,
    normalizeStartConversationRoots,
    normalizeWorkspacePath,
    permissionsForAppServer,
    recordThreadStartMetadata,
    recordThreadWorkspaceRoot,
    resolveGatewayTerminalCwd,
    resolveProjectlessThreadContext,
    setArchivedThreads,
    shellQuote,
  };
}

module.exports = {
  createWorkspaceRuntime,
};
