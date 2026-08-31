const { findOfficialRuntimeLayout } = require("./official-layout.cjs");
const { createMacRunner } = require("./platform/macos.cjs");
const { createPortableRunner } = require("./platform/portable.cjs");
const { createCompatibilityService } = require("../runtime/compatibility/service.cjs");

async function prepareOfficialElectronRuntime({ runtimeDir, officialBundleDir, logger }) {
  const layout = findOfficialRuntimeLayout({ officialBundleDir, logger });
  let compatibilityService = null;
  try {
    compatibilityService = createCompatibilityService();
  } catch {
    // 兼容骨架属于诊断旁路，初始化失败时 Runner 仍按原流程构建。
  }
  const runCompatibility = (id, operation) => {
    if (!compatibilityService) return operation();
    let capability = operation;
    try {
      capability = compatibilityService.bindCapability(id, operation, {
        locatorRevision: "runner-cache-v1",
        fallback: operation,
        verify: () => typeof operation === "function",
      });
    } catch {}
    return capability();
  };
  if (process.platform === "darwin") {
    return createMacRunner({ layout, runtimeDir, logger, runCompatibility });
  }
  if (process.platform === "win32" || process.platform === "linux") {
    return createPortableRunner({ layout, runtimeDir, logger, runCompatibility });
  }
  throw new Error(`当前 official Electron runner 不支持平台：${process.platform}`);
}

module.exports = {
  prepareOfficialElectronRuntime,
};
