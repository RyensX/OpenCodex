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

function normalizeCompatibilityReportForRead(value) {
  if (!value || typeof value !== "object") return null;
  if (Number(value.schemaVersion) !== 1) return value;
  const legacyAdapter = Object.freeze({
    id: "adapter.legacy-report",
    name: "旧报告执行策略",
    description: "Schema v1 没有强类型适配器链，仅保留原始诊断状态供只读查看。",
    kind: "terminal",
    dependencies: [],
  });
  const groupDefinitions = [
    ["legacy-web-runtime", "Web 运行时"],
    ["legacy-gateway-runtime", "Gateway 运行时"],
    ["legacy-static-cache", "静态缓存"],
  ];
  const groupForPoint = (point) => {
    const id = String(point?.id || "");
    if (id.startsWith("web.runtime.")) return "legacy-web-runtime";
    if (id.startsWith("gateway.runtime.")) return "legacy-gateway-runtime";
    return "legacy-static-cache";
  };
  const points = (Array.isArray(value.points) ? value.points : []).map((point) => ({
    ...point,
    plugin: null,
    groupId: groupForPoint(point),
    directAdapterIds: [legacyAdapter.id],
    adapterChainIds: [legacyAdapter.id],
  }));
  const groups = groupDefinitions.map(([id, name], index) => {
    const members = points.filter((point) => point.groupId === id);
    const statuses = members.map((point) => point.status);
    const status = statuses.length > 0 && statuses.every((item) => item === "disabled")
      ? "disabled"
      : statuses.includes("unavailable")
        ? "unavailable"
        : statuses.includes("degraded") || statuses.includes("disabled")
          ? "degraded"
          : statuses.includes("pending")
            ? "pending"
            : statuses.includes("ready")
              ? "ready"
              : statuses.includes("healthy")
                ? "healthy"
                : "pending";
    return {
      id,
      name,
      description: "从 Schema v1 分类字段生成的只读兼容分组。",
      order: 900 + index,
      status,
      pointIds: members.map((point) => point.id),
    };
  });
  // 归一化只发生在读取边界，不会把旧报告重新写回或参与当前运行时决策。
  return {
    ...value,
    schemaVersion: 2,
    sourceSchemaVersion: 1,
    readOnly: true,
    points,
    groups,
    adapterTypes: [legacyAdapter],
  };
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
      return normalizeCompatibilityReportForRead(JSON.parse(fileSystem.readFileSync(filePath, "utf8")));
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
  normalizeCompatibilityReportForRead,
  safeFilePart,
};
