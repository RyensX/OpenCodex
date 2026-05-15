// @ts-nocheck
export {};

const fs = require("fs");

function createCodexDiagnostics(deps) {
  const REPORTS_DIR = deps.reportsDir;
  const DOCS_DIR = deps.docsDir;
  const UNKNOWN_IPC_PATH = deps.unknownIpcPath;
  const CODEX_BRIDGE_MAP_PATH = deps.codexBridgeMapPath;
  const BRIDGE_MAP_ENTRIES = deps.bridgeMapEntries;

  // Codex renderer 使用的业务 IPC 映射表，也是生成 docs/codex-bridge-map.md 的来源。
  /** 确保 reports 目录存在；这里仅保留诊断日志，不再存放 Web 独立业务状态。 */
  function ensureReportsDir() {
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
  }
  
  /** 确保 docs 目录存在，Codex IPC 桥接映射文档写在这里。 */
  function ensureDocsDir() {
    fs.mkdirSync(DOCS_DIR, { recursive: true });
  }
  
  /** 未知 IPC 只记录 payload 形状，不落敏感内容。 */
  function payloadShape(payload) {
    if (payload === null) return "null";
    if (Array.isArray(payload)) return `array(${payload.length})`;
    if (typeof payload === "object") return `object(${Object.keys(payload).length})`;
    return typeof payload;
  }
  
  /** 把未知 IPC 追加到 reports/unknown-ipc.jsonl，方便后续补齐桥接。 */
  function appendUnknownIpc(channel, payload) {
    ensureReportsDir();
    const entry = {
      time: new Date().toISOString(),
      channel,
      payloadShape: payloadShape(payload),
    };
    fs.appendFileSync(UNKNOWN_IPC_PATH, JSON.stringify(entry) + "\n");
  }

  /** 生成 Codex IPC 桥接映射报告，帮助后续补齐 renderer channel 覆盖。 */
  function renderCodexBridgeMapMarkdown() {
    const lines = [];
    lines.push("# Codex IPC桥接映射");
    lines.push("");
    lines.push("| Renderer channel/method | Gateway 处理器 | App-server 方法 | 状态 | 说明 |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const row of BRIDGE_MAP_ENTRIES) {
      const status = row.status === "bridge" ? "已桥接" : row.status;
      lines.push(
        `| ${row.renderer} | ${row.gateway} | ${row.appServer} | ${status} | ${row.notes} |`
      );
    }
    lines.push("");
    return lines.join("\n");
  }
  
  /** 写出 docs/codex-bridge-map.md。 */
  function writeCodexBridgeMapReport() {
    ensureDocsDir();
    fs.writeFileSync(CODEX_BRIDGE_MAP_PATH, renderCodexBridgeMapMarkdown());
    return CODEX_BRIDGE_MAP_PATH;
  }

  return {
    appendUnknownIpc,
    payloadShape,
    renderCodexBridgeMapMarkdown,
    writeCodexBridgeMapReport,
  };
}

module.exports = {
  createCodexDiagnostics,
};
