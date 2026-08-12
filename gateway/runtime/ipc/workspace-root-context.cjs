const MAX_WORKSPACE_ROOT_SCAN_NODES = 1024;
const PRIORITY_TRAVERSAL_KEYS = ["params", "payload", "body", "request", "message", "response"];

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseStructuredString(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > 128 * 1024) return null;
  if (!((text.startsWith("{") && text.endsWith("}")) || (text.startsWith("[") && text.endsWith("]")))) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function isAbsoluteLocalPath(value) {
  const text = String(value || "").trim();
  return text.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(text) || /^\\\\[^\\]/.test(text);
}

function paramsLike(value) {
  if (!isPlainObject(value)) return null;
  return isPlainObject(value.params) ? value.params : value;
}

function rootFromParams(params) {
  if (!isPlainObject(params)) return "";
  for (const key of ["workspaceRoot", "cwd", "projectRoot", "root"]) {
    const value = typeof params[key] === "string" ? params[key].trim() : "";
    if (value && isAbsoluteLocalPath(value)) return value;
  }
  return "";
}

function hasFileTreePathContext(params) {
  if (!isPlainObject(params)) return false;
  // workspaceRoot 本身就是官方文件树的根参数；cwd 需要配合具体 path，避免误把普通运行参数加入下载 allowlist。
  if (typeof params.workspaceRoot === "string" || typeof params.root === "string") return true;
  return ["path", "filePath", "openPath", "directoryPath"].some((key) => typeof params[key] === "string");
}

function collectWorkspaceRoots(
  value,
  roots,
  depth = 0,
  traversal = { remaining: MAX_WORKSPACE_ROOT_SCAN_NODES, seen: new WeakSet() }
) {
  if (depth > 6 || value == null || traversal.remaining <= 0) return;
  if (typeof value === "object") {
    if (traversal.seen.has(value)) return;
    traversal.seen.add(value);
  }
  traversal.remaining -= 1;
  const structured = parseStructuredString(value);
  if (structured) {
    collectWorkspaceRoots(structured, roots, depth + 1, traversal);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (traversal.remaining <= 0) break;
      collectWorkspaceRoots(item, roots, depth + 1, traversal);
    }
    return;
  }
  if (!isPlainObject(value)) return;

  const params = paramsLike(value);
  const root = rootFromParams(params);
  if (root && hasFileTreePathContext(params)) roots.add(root);

  // 先走协议 envelope，超宽扩展对象里仍优先识别真实 params/body；其余字段受统一节点预算保护。
  const keys = Object.keys(value);
  for (const key of PRIORITY_TRAVERSAL_KEYS) {
    if (traversal.remaining <= 0) break;
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      collectWorkspaceRoots(value[key], roots, depth + 1, traversal);
    }
  }
  for (const key of keys) {
    if (traversal.remaining <= 0) break;
    if (PRIORITY_TRAVERSAL_KEYS.includes(key)) continue;
    collectWorkspaceRoots(value[key], roots, depth + 1, traversal);
  }
}

function workspaceRootsFromIpcPayload(channel, payload) {
  const roots = new Set();
  // channel 预留给后续按官方 IPC 名称收敛规则；当前主要依赖 payload 里的明确 cwd/workspaceRoot。
  collectWorkspaceRoots({ channel, payload }, roots);
  return Array.from(roots);
}

module.exports = {
  __test: {
    MAX_WORKSPACE_ROOT_SCAN_NODES,
    isAbsoluteLocalPath,
    parseStructuredString,
  },
  workspaceRootsFromIpcPayload,
};
