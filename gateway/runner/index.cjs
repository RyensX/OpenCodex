const { findOfficialRuntimeLayout } = require("./official-layout.cjs");
const { createMacRunner } = require("./platform/macos.cjs");
const { createPortableRunner } = require("./platform/portable.cjs");
const { createCompatibilityService } = require("../runtime/compatibility/service.cjs");
const { createHostModificationRuntime } = require("../runtime/modification/production-runtime.cjs");

async function prepareOfficialElectronRuntime({ runtimeDir, officialBundleDir, logger }) {
  const layout = findOfficialRuntimeLayout({ officialBundleDir, logger });
  let compatibilityService = null;
  try {
    compatibilityService = createCompatibilityService();
  } catch {
    // 兼容骨架属于诊断旁路，初始化失败时 Runner 仍按原流程构建。
  }
  const modificationSnapshots = new Map();
  const modificationRuntime = createHostModificationRuntime({
    host: "runner",
    compatibilityService,
    publish(point) {
      modificationSnapshots.set(point.id, point);
    },
  });
  const runCompatibility = (point, operation) => {
    let capability = operation;
    try {
      capability = modificationRuntime.coordinator.bind(point, operation);
    } catch {}
    return capability();
  };
  try {
    let result;
    if (process.platform === "darwin") {
      result = await createMacRunner({ layout, runtimeDir, logger, runCompatibility });
    } else if (process.platform === "win32" || process.platform === "linux") {
      result = await createPortableRunner({ layout, runtimeDir, logger, runCompatibility });
    } else {
      throw new Error(`当前 official Electron runner 不支持平台：${process.platform}`);
    }

    const applicablePointIds = new Set(result.compatibilityPoints || []);
    for (const point of Object.values(modificationRuntime.points.runner)) {
      if (applicablePointIds.has(point.id)) continue;
      try {
        modificationRuntime.coordinator.execute(point, () => undefined, { verify: () => true });
        modificationRuntime.coordinator.setEnabled(point, false, "Not applicable on the current platform");
      } catch {}
    }
    return { ...result, modificationPoints: [...modificationSnapshots.values()] };
  } finally {
    // 先持久化最后一个可运行快照，再释放只服务于本次 Runner 构建的 Provider 状态。
    compatibilityService?.dispose();
    try {
      await modificationRuntime.coordinator.dispose();
    } catch {
      // Runner 已完成或已失败的业务结果优先；退出清理异常不能改变原构建返回值。
    }
  }
}

module.exports = {
  prepareOfficialElectronRuntime,
};
