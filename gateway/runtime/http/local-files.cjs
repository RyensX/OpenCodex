const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { pipeline } = require("stream/promises");
const {
  CODEX_GENERATED_IMAGES_DIR,
  CODEX_WEB_PICKED_FILES_DIR,
  LOCAL_DOWNLOAD_ARCHIVE_DIR,
  LOCAL_DOWNLOAD_ARCHIVE_MAX_BYTES,
  LOCAL_DOWNLOAD_ARCHIVE_MAX_FILES,
  LOCAL_FILE_TOKEN_TTL_MS,
  ensureDir,
  isWithinRoot,
  mimeType,
  workspaceRootsFromEnv,
} = require("../core/config.cjs");
const { createZipArchiveFromDirectory, safeArchiveBaseName } = require("./local-archive.cjs");
const { send } = require("./http-utils.cjs");

// 本模块只处理“浏览器临时预览本机文件”，所有入口都必须有 allowlist 或短期 token。
/** Content-Disposition 文件名兜底，避免特殊字符破坏 inline 预览 header。 */
function safeInlineFilename(filePath) {
  return path.basename(filePath).replace(/["\r\n]/g, "_") || "file";
}

/** 解析官方 renderer 里的 app://fs/@fs/... 图片 URL 到本机绝对路径。 */
function appFsPathFromRequestPath(pathname) {
  // 前端会把 app://fs/@fs/Users/a.png 改写为 /api/app-fs/@fs/Users/a.png。
  const prefix = "/api/app-fs/@fs/";
  if (!pathname.startsWith(prefix)) return null;
  try {
    const decoded = decodeURIComponent(pathname.slice(prefix.length));
    const filePath = path.normalize(`/${decoded}`);
    return path.isAbsolute(filePath) ? filePath : null;
  } catch {
    return null;
  }
}

/** app://fs 只服务 Codex 生成图、Web 附件临时目录和当前允许的 workspace roots。 */
function isAllowedAppFsFile(filePath, extraWorkspaceRoots = []) {
  /**
   * app://fs 入口没有单独 token，因此必须限定目录：
   * - Codex 生成图片目录。
   * - Web 上传/选择文件临时目录。
   * - launcher 注入的 workspace roots。
   */
  const roots = [
    CODEX_GENERATED_IMAGES_DIR,
    CODEX_WEB_PICKED_FILES_DIR,
    ...workspaceRootsFromEnv(),
    ...extraWorkspaceRoots,
  ];
  return roots.some((root) => typeof root === "string" && root.length > 0 && isWithinRoot(filePath, root));
}

function isAllowedLocalDownloadPath(filePath, extraWorkspaceRoots = []) {
  // 侧栏右键下载和 app://fs 一样，只允许当前工作区和已授权的临时资源目录。
  return isAllowedAppFsFile(filePath, extraWorkspaceRoots);
}

function uniqueExistingRoots(roots) {
  const seen = new Set();
  const result = [];
  for (const root of roots) {
    if (typeof root !== "string" || !root) continue;
    const resolved = path.resolve(root);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    result.push(resolved);
  }
  return result;
}

function safeRelativeDownloadPath(filePath) {
  const raw = String(filePath || "").trim();
  if (!raw || path.isAbsolute(raw)) return "";
  const normalized = path.normalize(raw);
  // "." 表示当前 workspace root，用于文件树空白处“下载当前目录”的场景。
  if (!normalized || normalized === "..") return "";
  if (normalized.startsWith(`..${path.sep}`) || path.isAbsolute(normalized)) return "";
  return normalized;
}

function isResolvedInsideRoot(candidate, root) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function removeTemporaryPath(temporaryPath) {
  if (!temporaryPath || !isResolvedInsideRoot(temporaryPath, LOCAL_DOWNLOAD_ARCHIVE_DIR)) return;
  try {
    fs.rmSync(temporaryPath, { force: true, recursive: true });
  } catch {}
}

async function sendFileStream(res, status, headers, filePath) {
  // 大文件和临时 zip 直接流式写回浏览器，避免把完整文件读成一个 Buffer。
  res.writeHead(status, headers);
  await pipeline(fs.createReadStream(filePath), res);
}

function createLocalFileService(options = {}) {
  const getWorkspaceRoots = typeof options.getWorkspaceRoots === "function" ? options.getWorkspaceRoots : () => [];
  // token 仅保存在内存中，重启 gateway 后自动失效，不把本机绝对路径持久化到前端。
  const localFileTokens = new Map();

  function currentWorkspaceRoots() {
    // 相对路径只允许按 workspace root 解析，不复用生成图片或临时上传目录。
    return uniqueExistingRoots([...workspaceRootsFromEnv(), ...getWorkspaceRoots()]);
  }

  function resolveLocalDownloadPath(filePath, options = {}) {
    const raw = String(filePath || "").trim();
    if (!raw) return "";
    if (path.isAbsolute(raw)) return path.normalize(raw);

    const relativePath = safeRelativeDownloadPath(raw);
    if (!relativePath) return "";

    const requestedRoot = typeof options.workspaceRoot === "string" ? options.workspaceRoot.trim() : "";
    const workspaceRoots = currentWorkspaceRoots();
    const candidateRoots = [requestedRoot, ...workspaceRoots].filter(Boolean);
    let firstAllowedPath = "";
    for (const root of candidateRoots) {
      const resolvedPath = path.resolve(root, relativePath);
      // 最终仍走同一套 allowlist，避免前端传入伪造 root 时扩大下载范围。
      if (!isAllowedLocalDownloadPath(resolvedPath, currentWorkspaceRoots())) continue;
      if (!firstAllowedPath) firstAllowedPath = resolvedPath;
      if (fs.existsSync(resolvedPath)) return resolvedPath;
    }
    return firstAllowedPath;
  }

  /**
   * 生成本地文件访问 URL。
   *
   * 预览和下载复用同一套短期 token，只在响应阶段通过 download 参数决定 Content-Disposition。
   */
  function createLocalFileAccess(filePath, options = {}) {
    const token = crypto.randomBytes(24).toString("base64url");
    const expiresAtMs = Date.now() + LOCAL_FILE_TOKEN_TTL_MS;
    localFileTokens.set(token, {
      filePath,
      expiresAtMs,
      temporaryPath: typeof options.temporaryPath === "string" ? options.temporaryPath : "",
    });
    const name = encodeURIComponent(path.basename(filePath));
    const url = `/api/local-file/${token}/${name}`;
    return {
      expiresAtMs,
      name: path.basename(filePath),
      url,
      downloadUrl: `${url}?download=1`,
    };
  }

  /**
   * 生成本地文件预览 URL。
   *
   * 浏览器拿到的是带 token 的 /api/local-file/... URL，不能直接读取本机任意路径。
   */
  function createLocalFilePreview(filePath) {
    const access = createLocalFileAccess(filePath);
    return {
      opened: true,
      path: filePath,
      name: access.name,
      url: access.url,
      downloadUrl: access.downloadUrl,
      expiresAtMs: access.expiresAtMs,
    };
  }

  /** 生成远端浏览器下载事件使用的短期 URL。 */
  function createLocalFileDownload(filePath, options = {}) {
    const access = createLocalFileAccess(filePath, options);
    return {
      name: access.name,
      url: access.downloadUrl,
      downloadUrl: access.downloadUrl,
      expiresAtMs: access.expiresAtMs,
    };
  }

  async function createLocalDirectoryDownload(directoryPath) {
    ensureDir(LOCAL_DOWNLOAD_ARCHIVE_DIR);
    const archiveDir = fs.mkdtempSync(path.join(LOCAL_DOWNLOAD_ARCHIVE_DIR, "download-"));
    const archiveName = `${safeArchiveBaseName(path.basename(directoryPath))}.zip`;
    const archivePath = path.join(archiveDir, archiveName);
    try {
      await createZipArchiveFromDirectory(directoryPath, archivePath, {
        maxBytes: LOCAL_DOWNLOAD_ARCHIVE_MAX_BYTES,
        maxFiles: LOCAL_DOWNLOAD_ARCHIVE_MAX_FILES,
      });
      return createLocalFileDownload(archivePath, { temporaryPath: archiveDir });
    } catch (error) {
      removeTemporaryPath(archiveDir);
      throw error;
    }
  }

  async function createLocalPathDownload(filePath) {
    const normalizedPath = path.resolve(String(filePath || ""));
    const stats = fs.statSync(normalizedPath);
    if (stats.isFile()) return createLocalFileDownload(normalizedPath);
    if (stats.isDirectory()) return await createLocalDirectoryDownload(normalizedPath);
    const error = new Error("Selected path is not a downloadable file or directory.");
    error.status = 400;
    error.code = "not_downloadable";
    throw error;
  }

  function deleteLocalFileToken(token, entry) {
    localFileTokens.delete(token);
    // 目录下载会生成临时 zip；token 生命周期结束时同步清掉对应临时目录。
    removeTemporaryPath(entry && entry.temporaryPath);
  }

  /** 定期清理本地文件预览 token，避免 token 长期有效。 */
  function pruneLocalFileTokens() {
    const now = Date.now();
    for (const [token, entry] of localFileTokens) {
      if (!entry || entry.expiresAtMs <= now) deleteLocalFileToken(token, entry);
    }
  }

  const localFileTokenTimer = setInterval(pruneLocalFileTokens, Math.min(60 * 1000, LOCAL_FILE_TOKEN_TTL_MS));
  if (localFileTokenTimer && typeof localFileTokenTimer.unref === "function") localFileTokenTimer.unref();

  /** 发送 app://fs 映射后的本机图片/文件；所有路径都必须先过 allowlist。 */
  async function serveAppFsFile(pathname, res) {
    // 先解析并校验 allowlist，再 stat/read，避免错误信息泄露任意路径是否存在。
    const filePath = appFsPathFromRequestPath(pathname);
    // 新增项目通过 Web IPC 动态注册，本轮 gateway 不重启也要立刻放行其 app://fs 资源。
    if (!filePath || !isAllowedAppFsFile(filePath, getWorkspaceRoots())) {
      return send(res, 404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }, "File not allowed.");
    }
    try {
      const stats = fs.statSync(filePath);
      if (!stats.isFile()) {
        return send(res, 404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }, "Not a file.");
      }
      return await sendFileStream(
        res,
        200,
        {
          "content-type": mimeType(filePath),
          "cache-control": "no-store",
          // 明确返回实际字节数，避免浏览器把未知文件大小显示成 0。
          "content-length": String(stats.size),
          "content-disposition": `inline; filename="${safeInlineFilename(filePath)}"`,
        },
        filePath
      );
    } catch {
      if (!res.headersSent) {
        return send(res, 404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }, "File not found.");
      }
      try {
        res.destroy();
      } catch {}
    }
  }

  async function serveLocalFile(pathname, res, options = {}) {
    // /api/local-file/:token/:name 里的 name 只用于浏览器展示，真实路径只来自 token 映射。
    const parts = pathname.split("/");
    const token = parts[3] || "";
    const entry = localFileTokens.get(token);
    if (!entry || entry.expiresAtMs <= Date.now()) {
      // 过期 token 立即删除，防止同一链接反复探测本机文件状态。
      deleteLocalFileToken(token, entry);
      return send(res, 404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }, "File preview expired.");
    }
    try {
      const stats = fs.statSync(entry.filePath);
      if (!stats.isFile()) {
        return send(res, 404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }, "Not a file.");
      }
      const disposition = options.download ? "attachment" : "inline";
      return await sendFileStream(
        res,
        200,
        {
          "content-type": mimeType(entry.filePath),
          "cache-control": "no-store",
          // 下载和预览都带上长度，保证浏览器 UI 能显示真实文件大小。
          "content-length": String(stats.size),
          "content-disposition": `${disposition}; filename="${safeInlineFilename(entry.filePath)}"`,
        },
        entry.filePath
      );
    } catch {
      deleteLocalFileToken(token, entry);
      if (!res.headersSent) {
        return send(res, 404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }, "File not found.");
      }
      try {
        res.destroy();
      } catch {}
    }
  }

  function dispose() {
    // server shutdown 时清空 token，避免测试或重启时旧链接继续可用。
    clearInterval(localFileTokenTimer);
    for (const entry of localFileTokens.values()) removeTemporaryPath(entry && entry.temporaryPath);
    localFileTokens.clear();
  }

  return {
    createLocalFileDownload,
    createLocalPathDownload,
    createLocalFilePreview,
    dispose,
    isAllowedLocalDownloadPath: (filePath) => isAllowedLocalDownloadPath(filePath, currentWorkspaceRoots()),
    resolveLocalDownloadPath,
    serveAppFsFile,
    serveLocalFile,
  };
}

module.exports = { createLocalFileService, isAllowedAppFsFile, isAllowedLocalDownloadPath, safeInlineFilename };
