const fs = require("fs");
const os = require("os");
const path = require("path");

// 路径校验错误需要同时给 HTTP 状态码和 i18n key，前端才能用本地化 toast 展示。
class WorkspaceRootError extends Error {
  constructor(status, errorKey, message) {
    super(message);
    this.name = "WorkspaceRootError";
    this.status = status;
    this.errorKey = errorKey;
  }
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function paramsFromPayload(payload) {
  // 兼容直接传参和 { params } 两种 IPC payload 形态，避免前端调用方式变更时破坏校验。
  const params = isPlainObject(payload) && isPlainObject(payload.params) ? payload.params : payload;
  return isPlainObject(params) ? params : {};
}

function pathFromPayload(payload) {
  // 前端新弹窗传 path；如果后续复用官方 root 字段，这里也能兼容。
  const params = paramsFromPayload(payload);
  if (typeof params.path === "string") return params.path;
  if (typeof params.root === "string") return params.root;
  return "";
}

function expandHomeDir(value) {
  // 只展开当前用户目录，避免实现 shell 那种复杂的 ~otherUser 规则。
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function workspaceRootErrorForFsError(error) {
  // fs 错误转成稳定 key，避免把英文系统错误直接暴露到 Web toast。
  const code = error && typeof error.code === "string" ? error.code : "";
  if (code === "ENOENT" || code === "ENOTDIR") {
    return new WorkspaceRootError(400, "web.workspaceRoot.error.notFound", "Workspace root path does not exist.");
  }
  if (code === "EACCES" || code === "EPERM") {
    return new WorkspaceRootError(403, "web.workspaceRoot.error.noAccess", "Workspace root path is not accessible.");
  }
  return new WorkspaceRootError(400, "web.workspaceRoot.error.unavailable", "Workspace root path cannot be used.");
}

function resolveWorkspaceRoot(input) {
  const raw = String(input || "").trim();
  if (!raw) {
    throw new WorkspaceRootError(400, "web.workspaceRoot.error.empty", "Workspace root path is required.");
  }

  const expanded = expandHomeDir(raw);
  if (!path.isAbsolute(expanded)) {
    throw new WorkspaceRootError(400, "web.workspaceRoot.error.relative", "Workspace root path must be absolute.");
  }

  // path.resolve 先规整 .. 和重复分隔符，真正的符号链接规整放到 realpath。
  const resolved = path.resolve(expanded);
  let stats = null;
  try {
    stats = fs.statSync(resolved);
  } catch (error) {
    throw workspaceRootErrorForFsError(error);
  }

  if (!stats.isDirectory()) {
    throw new WorkspaceRootError(400, "web.workspaceRoot.error.notDirectory", "Workspace root path is not a directory.");
  }

  try {
    // 返回真实路径给官方 IPC，后续 app://fs allowlist 也按真实路径判断，防止符号链接绕过。
    return fs.realpathSync.native ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved);
  } catch (error) {
    throw workspaceRootErrorForFsError(error);
  }
}

function createWorkspaceRootsService(options = {}) {
  // 动态 roots 只保存在本轮 gateway 内存里；官方 IPC 成功后仍由官方逻辑负责持久化项目。
  const dynamicRoots = new Set();
  const maxRoots = Math.max(1, Number(options.maxRoots) || 1024);

  function registerWorkspaceRoot(root) {
    // 注册前强制复用同一套校验，避免 allowlist 接受未经确认的任意路径。
    const resolved = resolveWorkspaceRoot(root);
    dynamicRoots.delete(resolved);
    dynamicRoots.add(resolved);
    // 极端长会话只保留最近项目 allowlist；普通项目数远低于上限，旧项目重新打开会再次注册。
    while (dynamicRoots.size > maxRoots) dynamicRoots.delete(dynamicRoots.values().next().value);
    return resolved;
  }

  function handleValidateWorkspaceRootPayload(payload) {
    const root = registerWorkspaceRoot(pathFromPayload(payload));
    return { root };
  }

  function workspaceRoots() {
    return Array.from(dynamicRoots);
  }

  return {
    handleValidateWorkspaceRootPayload,
    registerWorkspaceRoot,
    resolveWorkspaceRoot,
    workspaceRoots,
  };
}

module.exports = {
  WorkspaceRootError,
  createWorkspaceRootsService,
  resolveWorkspaceRoot,
};
