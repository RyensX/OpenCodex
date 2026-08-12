const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const {
  CODEX_WEB_PICKED_FILE_MAX_BYTES,
  CODEX_WEB_PICKED_FILE_TTL_MS,
  CODEX_WEB_PICKED_FILES_DIR,
  CODEX_WEB_PICKED_FILES_MAX_COUNT,
  CODEX_WEB_PICKED_FILES_MAX_TOTAL_BYTES,
  ensureDir,
} = require("../core/config.cjs");

// Node 单次定时器的安全上限；更长 TTL 通过再次调度分段等待。
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

class PickedFilesError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "PickedFilesError";
    this.status = status;
  }
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function paramsFromPayload(payload) {
  // 前端可能传 { params }，旧 polyfill 也可能直接传参数对象，这里统一成 params。
  const params = isPlainObject(payload) && isPlainObject(payload.params) ? payload.params : payload;
  return isPlainObject(params) ? params : {};
}

function pickedFilesFromPayload(payload) {
  const params = paramsFromPayload(payload);
  return Array.isArray(params.files) ? params.files : [];
}

function safePickedFileName(value, index) {
  const raw = String(value || "attachment").replace(/\\/g, "/");
  let name = path.basename(raw).replace(/[\u0000-\u001f\u007f"<>:|?*]+/g, "_").trim();
  if (!name || name === "." || name === "..") name = "attachment";
  const ext = path.extname(name).slice(0, 32);
  const stem = path.basename(name, ext).slice(0, Math.max(1, 140 - ext.length)) || "attachment";
  return `${String(index + 1).padStart(3, "0")}-${stem}${ext}`;
}

function pathIsInside(child, root) {
  const relative = path.relative(path.resolve(root), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function dateSegment(now = Date.now()) {
  const date = new Date(now);
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

function createRequestDir(now = Date.now()) {
  ensureDir(CODEX_WEB_PICKED_FILES_DIR);
  const dayDir = path.join(CODEX_WEB_PICKED_FILES_DIR, dateSegment(now));
  ensureDir(dayDir);
  const requestDir = fs.mkdtempSync(path.join(dayDir, "pick-"));
  if (!pathIsInside(requestDir, CODEX_WEB_PICKED_FILES_DIR)) {
    throw new PickedFilesError(500, "Picked files directory escaped the configured root.");
  }
  return requestDir;
}

function validatePickedFileShape(file, index) {
  if (!isPlainObject(file)) {
    throw new PickedFilesError(400, `Picked file #${index + 1} is invalid.`);
  }
  if (typeof file.contentsBase64 !== "string") {
    throw new PickedFilesError(400, `Picked file #${index + 1} is missing contents.`);
  }
  const size = Number(file.size);
  if (!Number.isFinite(size) || size < 0) {
    throw new PickedFilesError(400, `Picked file #${index + 1} has invalid size.`);
  }
  if (size > CODEX_WEB_PICKED_FILE_MAX_BYTES) {
    throw new PickedFilesError(413, `Picked file #${index + 1} exceeds the per-file size limit.`);
  }
  return size;
}

function decodePickedFile(file, index, declaredSize) {
  const normalized = file.contentsBase64.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 === 1) {
    throw new PickedFilesError(400, `Picked file #${index + 1} has invalid base64 contents.`);
  }
  const maxEncodedLength = Math.ceil(CODEX_WEB_PICKED_FILE_MAX_BYTES / 3) * 4 + 4;
  if (normalized.length > maxEncodedLength) {
    throw new PickedFilesError(413, `Picked file #${index + 1} exceeds the per-file size limit.`);
  }
  const data = Buffer.from(normalized, "base64");
  if (data.length !== declaredSize) {
    throw new PickedFilesError(400, `Picked file #${index + 1} size does not match its contents.`);
  }
  return data;
}

function normalizedLastModified(value) {
  const lastModified = Number(value);
  return Number.isFinite(lastModified) && lastModified >= 0 ? lastModified : 0;
}

function safeRemoveTree(targetPath) {
  if (!pathIsInside(targetPath, CODEX_WEB_PICKED_FILES_DIR)) return;
  fs.rmSync(targetPath, { force: true, recursive: true });
}

function prunePickedFiles() {
  if (!fs.existsSync(CODEX_WEB_PICKED_FILES_DIR)) return 0;
  const now = Date.now();
  let nextExpiryAtMs = Infinity;
  for (const dayEntry of fs.readdirSync(CODEX_WEB_PICKED_FILES_DIR, { withFileTypes: true })) {
    const dayPath = path.join(CODEX_WEB_PICKED_FILES_DIR, dayEntry.name);
    if (!pathIsInside(dayPath, CODEX_WEB_PICKED_FILES_DIR)) continue;
    if (!dayEntry.isDirectory()) continue;
    for (const requestEntry of fs.readdirSync(dayPath, { withFileTypes: true })) {
      const requestPath = path.join(dayPath, requestEntry.name);
      if (!pathIsInside(requestPath, CODEX_WEB_PICKED_FILES_DIR)) continue;
      let stats = null;
      try {
        stats = fs.statSync(requestPath);
      } catch {
        continue;
      }
      const expiryAtMs = stats.mtimeMs + CODEX_WEB_PICKED_FILE_TTL_MS;
      if (expiryAtMs <= now) {
        safeRemoveTree(requestPath);
      } else {
        nextExpiryAtMs = Math.min(nextExpiryAtMs, expiryAtMs);
      }
    }
    try {
      if (fs.readdirSync(dayPath).length === 0) fs.rmdirSync(dayPath);
    } catch {}
  }
  return Number.isFinite(nextExpiryAtMs) ? nextExpiryAtMs : 0;
}

function createPickedFilesService() {
  ensureDir(CODEX_WEB_PICKED_FILES_DIR);
  let pruneTimer = null;
  let scheduledExpiryAtMs = 0;
  let disposed = false;

  function schedulePickedFilesPrune(expiryAtMs) {
    if (disposed || !Number.isFinite(expiryAtMs) || expiryAtMs <= 0) return;
    // 已有更早的清理任务时无需重排；新附件只会把到期时间向后延伸。
    if (pruneTimer && scheduledExpiryAtMs <= expiryAtMs) return;
    if (pruneTimer) clearTimeout(pruneTimer);
    scheduledExpiryAtMs = expiryAtMs;
    pruneTimer = setTimeout(
      () => {
        pruneTimer = null;
        scheduledExpiryAtMs = 0;
        schedulePickedFilesPrune(prunePickedFiles());
      },
      Math.min(MAX_TIMER_DELAY_MS, Math.max(1, expiryAtMs - Date.now()))
    );
    if (typeof pruneTimer.unref === "function") pruneTimer.unref();
  }

  // 启动时只为实际存在的未过期附件安排清理，空目录不再每小时扫描磁盘。
  schedulePickedFilesPrune(prunePickedFiles());

  function handlePickFilesPayload(payload) {
    const files = pickedFilesFromPayload(payload);
    if (files.length === 0) return { files: [] };
    if (files.length > CODEX_WEB_PICKED_FILES_MAX_COUNT) {
      throw new PickedFilesError(413, "Picked files exceed the file count limit.");
    }

    const declaredSizes = files.map((file, index) => validatePickedFileShape(file, index));
    const totalSize = declaredSizes.reduce((sum, size) => sum + size, 0);
    if (totalSize > CODEX_WEB_PICKED_FILES_MAX_TOTAL_BYTES) {
      throw new PickedFilesError(413, "Picked files exceed the total size limit.");
    }

    const requestDir = createRequestDir();
    const resultFiles = [];
    try {
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        const data = decodePickedFile(file, index, declaredSizes[index]);
        const filePath = path.join(requestDir, safePickedFileName(file.name, index));
        if (!pathIsInside(filePath, requestDir)) {
          throw new PickedFilesError(500, "Picked file path escaped the request directory.");
        }
        // 浏览器端 File 没有真实路径，必须先落盘成官方 renderer 可读取的本机路径。
        fs.writeFileSync(filePath, data);
        const label = path.basename(filePath).replace(/^\d+-/, "");
        const result = {
          path: filePath,
          fsPath: filePath,
          filePath,
          // 普通文件附件的 metadata 同步会读取 label 来解析扩展名，缺失时会触发 renderer error boundary。
          label,
          name: label,
          type: typeof file.type === "string" ? file.type : "",
          size: data.length,
          lastModified: normalizedLastModified(file.lastModified),
        };
        resultFiles.push(result);
      }
    } catch (error) {
      safeRemoveTree(requestDir);
      throw error;
    }

    schedulePickedFilesPrune(Date.now() + CODEX_WEB_PICKED_FILE_TTL_MS);
    return { files: resultFiles };
  }

  function dispose() {
    disposed = true;
    if (pruneTimer) clearTimeout(pruneTimer);
    pruneTimer = null;
    scheduledExpiryAtMs = 0;
  }

  return {
    dispose,
    handlePickFilesPayload,
    prunePickedFiles,
    __test: {
      timerActive: () => !!pruneTimer,
    },
  };
}

module.exports = {
  PickedFilesError,
  createPickedFilesService,
};
