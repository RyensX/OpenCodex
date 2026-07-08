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

function collectWorkspaceRoots(value, roots, depth = 0) {
  if (depth > 6 || value == null) return;
  const structured = parseStructuredString(value);
  if (structured) {
    collectWorkspaceRoots(structured, roots, depth + 1);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectWorkspaceRoots(item, roots, depth + 1);
    return;
  }
  if (!isPlainObject(value)) return;

  const params = paramsLike(value);
  const root = rootFromParams(params);
  if (root && hasFileTreePathContext(params)) roots.add(root);

  for (const nestedValue of Object.values(value)) {
    collectWorkspaceRoots(nestedValue, roots, depth + 1);
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
    isAbsoluteLocalPath,
    parseStructuredString,
  },
  workspaceRootsFromIpcPayload,
};
