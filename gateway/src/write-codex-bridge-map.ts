export {};

const { writeCodexBridgeMapReport } = require("./ipc/codex/GatewayCodexIpcPort");

// 手动生成 Codex IPC 桥接映射报告；不要放到 gateway 启动流程里自动执行。
const outputPath = writeCodexBridgeMapReport();
console.log(`[gateway] Codex IPC bridge map written: ${outputPath}`);
