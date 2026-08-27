const fs = require("fs");
const path = require("path");

const DEFAULT_HISTORY_LIMIT = 10;

function safeFilePart(value) {
  return String(value || "unknown")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "unknown";
}

function historyFileName(snapshot) {
  const runtime = snapshot?.runtime || {};
  return `compatibility-${safeFilePart(runtime.version)}-${safeFilePart(runtime.build)}-${safeFilePart(runtime.bundleHash)}.json`;
}

function createCompatibilityReportStore({
  filePath,
  historyDir,
  historyLimit = DEFAULT_HISTORY_LIMIT,
  fileSystem = fs,
} = {}) {
  if (!filePath) throw new TypeError("Compatibility report filePath is required");
  if (!historyDir) throw new TypeError("Compatibility report historyDir is required");
  const maxHistory = Math.max(1, Math.trunc(Number(historyLimit)) || DEFAULT_HISTORY_LIMIT);

  function writeFileAtomically(targetPath, data) {
    fileSystem.mkdirSync(path.dirname(targetPath), { recursive: true });
    const tmpPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
    try {
      fileSystem.writeFileSync(tmpPath, data, { encoding: "utf8", mode: 0o600 });
      fileSystem.renameSync(tmpPath, targetPath);
    } catch (error) {
      try {
        fileSystem.rmSync(tmpPath, { force: true });
      } catch {}
      throw error;
    }
  }

  function pruneHistory(currentPath) {
    let entries = [];
    try {
      entries = fileSystem
        .readdirSync(historyDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && /^compatibility-.*\.json$/.test(entry.name))
        .map((entry) => {
          const entryPath = path.join(historyDir, entry.name);
          return { path: entryPath, mtimeMs: fileSystem.statSync(entryPath).mtimeMs };
        })
        .sort((left, right) => right.mtimeMs - left.mtimeMs);
    } catch {
      return;
    }
    // 多个报告可能在同一毫秒写入；始终显式保留本次版本，不能依赖相同 mtime 下的目录顺序。
    const retained = new Set([currentPath]);
    for (const entry of entries) {
      if (retained.size >= maxHistory) break;
      retained.add(entry.path);
    }
    for (const entry of entries.filter((item) => !retained.has(item.path))) {
      try {
        fileSystem.rmSync(entry.path, { force: true });
      } catch {
        // 历史清理失败不影响最新报告写入，下次状态变化时会再次尝试。
      }
    }
  }

  function write(snapshot) {
    if (!snapshot || typeof snapshot !== "object") throw new TypeError("Compatibility snapshot is required");
    const data = `${JSON.stringify(snapshot, null, 2)}\n`;
    const currentHistoryPath = path.join(historyDir, historyFileName(snapshot));
    writeFileAtomically(filePath, data);
    writeFileAtomically(currentHistoryPath, data);
    pruneHistory(currentHistoryPath);
    return snapshot;
  }

  function read() {
    try {
      return JSON.parse(fileSystem.readFileSync(filePath, "utf8"));
    } catch {
      return null;
    }
  }

  return Object.freeze({
    filePath,
    historyDir,
    read,
    write,
  });
}

module.exports = {
  DEFAULT_HISTORY_LIMIT,
  createCompatibilityReportStore,
  historyFileName,
  safeFilePart,
};
