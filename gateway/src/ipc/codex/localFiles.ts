// @ts-nocheck
export {};

const fs = require("fs");
const path = require("path");
const os = require("os");
const { randomUUID } = require("crypto");

function createLocalFileIpcHandlers(deps) {
  const CODEX_HOME = deps.codexHome;
  const CODEX_WEB_PICKED_FILES_DIR = deps.codexWebPickedFilesDir;
  const REPORTS_DIR = deps.reportsDir;
  const PROJECT_ROOT = deps.projectRoot;
  const parseWorkspaceRoots = deps.parseWorkspaceRoots;
  const realpathSafe = deps.realpathSafe;
  const isWithinAllowedRoots = deps.isWithinAllowedRoots;

  /** 从 open/read-file 等 payload 中提取路径字段。 */
  function resolvePayloadPath(payload) {
    if (!payload || typeof payload !== "object") return null;
    const params = payload.params && typeof payload.params === "object" ? payload.params : payload;
    const candidate =
      params.path ||
      params.filePath ||
      params.fsPath ||
      params.absolutePath ||
      params.uri ||
      null;
    if (typeof candidate !== "string" || !candidate.trim()) return null;
    return candidate.startsWith("file://") ? decodeURIComponent(candidate.slice("file://".length)) : candidate;
  }
  
  /** 把 payload 中的相对/绝对/file:// 路径解析成真实本机路径。 */
  function resolvePayloadFilePath(payload) {
    if (!payload || typeof payload !== "object") return null;
    const params = payload.params && typeof payload.params === "object" ? payload.params : payload;
    const rawPath = resolvePayloadPath(params);
    if (!rawPath) return null;
    const cwd = typeof params.cwd === "string" && params.cwd.trim() ? params.cwd.trim() : null;
    const expandedPath = rawPath.startsWith("~") ? path.join(os.homedir(), rawPath.slice(1)) : rawPath;
    const absolutePath = path.isAbsolute(expandedPath)
      ? expandedPath
      : path.resolve(cwd || parseWorkspaceRoots()[0] || PROJECT_ROOT, expandedPath);
    return realpathSafe(absolutePath) || (fs.existsSync(absolutePath) ? path.resolve(absolutePath) : null);
  }
  
  /** 文件预览允许 workspace、Codex home、tmp、reports，其他路径拒绝。 */
  function isWithinLocalFilePreviewRoots(filePath) {
    if (isWithinAllowedRoots(filePath)) return true;
    const candidate = realpathSafe(filePath);
    if (!candidate) return false;
    const extraRoots = [CODEX_HOME, os.tmpdir(), REPORTS_DIR];
    for (const root of extraRoots) {
      const resolvedRoot = realpathSafe(root);
      if (!resolvedRoot) continue;
      const relative = path.relative(resolvedRoot, candidate);
      if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return true;
    }
    return false;
  }
  
  /** open-file IPC：不直接打开本机 GUI，而是生成 Web 侧可预览的授权 URL。 */
  function openFileForPayload(payload, context = {}) {
    const params = payload && typeof payload === "object" && payload.params ? payload.params : payload;
    const target = params && typeof params === "object" ? String(params.target || "") : "";
    if (target === "fileManager") return { opened: false, reason: "file-manager-target-not-supported" };
    const filePath = resolvePayloadFilePath(payload);
    if (!filePath || !isWithinLocalFilePreviewRoots(filePath)) {
      return { opened: false, reason: "file-not-allowed" };
    }
    try {
      const stats = fs.statSync(filePath);
      if (!stats.isFile()) return { opened: false, reason: "not-a-file", path: filePath };
    } catch {
      return { opened: false, reason: "file-not-found" };
    }
    if (typeof context.openFile === "function") {
      return context.openFile(filePath, payload);
    }
    return { opened: false, path: filePath };
  }
  
  /** 图片文件优先走 open-file 预览，让 Codex 原侧边栏打开。 */
  function isBrowserPreviewImagePath(filePath) {
    const ext = path.extname(String(filePath || "")).toLowerCase();
    return [".avif", ".bmp", ".gif", ".ico", ".jpeg", ".jpg", ".png", ".tif", ".tiff", ".webp"].includes(ext);
  }
  
  /** read-file-metadata IPC 的本地实现。 */
  function readFileMetadata(payload) {
    const filePath = resolvePayloadFilePath(payload);
    if (!filePath || !isWithinAllowedRoots(filePath)) return { isFile: false, sizeBytes: null };
    try {
      const stats = fs.statSync(filePath);
      if (stats.isFile() && isBrowserPreviewImagePath(filePath)) {
        return {
          path: filePath,
          isFile: false,
          isDirectory: false,
          sizeBytes: stats.size,
          mtimeMs: stats.mtimeMs,
          previewViaOpenFile: true,
        };
      }
      return {
        path: filePath,
        isFile: stats.isFile(),
        isDirectory: stats.isDirectory(),
        sizeBytes: stats.size,
        mtimeMs: stats.mtimeMs,
      };
    } catch {
      return { path: filePath, isFile: false, sizeBytes: null };
    }
  }
  
  /** read-file-binary IPC 的本地实现，只允许 allowlist 内文件。 */
  function readFileBinary(payload) {
    const filePath = resolvePayloadFilePath(payload);
    if (!filePath || !isWithinAllowedRoots(filePath)) return null;
    try {
      return {
        path: filePath,
        contentsBase64: fs.readFileSync(filePath).toString("base64"),
      };
    } catch {
      return null;
    }
  }
  
  /** 去掉浏览器上传文件名里的路径和控制字符，避免写入临时目录时发生路径穿越。 */
  function sanitizePickedFileName(name, index) {
    const fallback = `attachment-${index + 1}`;
    const raw = String(name || fallback)
      .split(/[\\/]/)
      .filter(Boolean)
      .pop() || fallback;
    const cleaned = raw
      .replace(/[\u0000-\u001f<>:"|?*]/g, "_")
      .replace(/\s+/g, " ")
      .trim();
    if (!cleaned || cleaned === "." || cleaned === "..") return fallback;
    return cleaned.slice(0, 160);
  }
  
  /** base64 可能来自 data URL 或纯内容，这里统一成 Buffer；非法内容返回 null。 */
  function pickedFileBufferFromBase64(value) {
    if (typeof value !== "string" || value.length === 0) return null;
    const body = value.replace(/^data:[^,]*;base64,/i, "").replace(/\s+/g, "");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(body)) return null;
    try {
      return Buffer.from(body, "base64");
    } catch {
      return null;
    }
  }
  
  /** 浏览器文件选择器只给内容不给真实路径，gateway 写入受控临时目录后再返回 renderer 需要的 fsPath。 */
  function pickFilesForWeb(payload) {
    const params = payload && typeof payload === "object" && payload.params ? payload.params : payload;
    const selectedFiles = params && typeof params === "object" && Array.isArray(params.files) ? params.files : [];
    if (selectedFiles.length === 0) return { files: [] };
  
    const imagesOnly = !!(params && typeof params === "object" && params.imagesOnly);
    const batchDir = path.join(CODEX_WEB_PICKED_FILES_DIR, `${Date.now()}-${randomUUID()}`);
    fs.mkdirSync(batchDir, { recursive: true, mode: 0o700 });
  
    const files = [];
    for (const [index, file] of selectedFiles.entries()) {
      if (!file || typeof file !== "object") continue;
      const label = sanitizePickedFileName(file.name || file.label, index);
      const mimeType = typeof file.type === "string" && file.type ? file.type : null;
      if (imagesOnly && !(mimeType && mimeType.toLowerCase().startsWith("image/")) && !isBrowserPreviewImagePath(label)) {
        continue;
      }
      const buffer = pickedFileBufferFromBase64(file.contentsBase64 || file.bodyBase64 || file.dataBase64);
      if (!buffer) continue;
  
      const targetPath = path.join(batchDir, `${String(index + 1).padStart(3, "0")}-${label}`);
      fs.writeFileSync(targetPath, buffer, { mode: 0o600 });
      // 官方 renderer 用 label 展示、用 fsPath/path 继续读取附件；三个字段必须一起返回。
      files.push({
        label,
        path: targetPath,
        fsPath: targetPath,
        sizeBytes: buffer.length,
        mimeType,
        lastModified: Number.isFinite(Number(file.lastModified)) ? Number(file.lastModified) : null,
      });
    }
  
    return { files };
  }

  return {
    openFileForPayload,
    pickFilesForWeb,
    readFileBinary,
    readFileMetadata,
    resolvePayloadFilePath,
  };
}

module.exports = {
  createLocalFileIpcHandlers,
};
