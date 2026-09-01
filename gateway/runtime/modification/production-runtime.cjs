const {
  createProductionModificationCoordinator,
} = require("../../dist/modification/production.js");
const pointRefs = require("./point-refs.cjs");

function createHostModificationRuntime({ host, compatibilityService = null, publish = null }) {
  const coordinator = createProductionModificationCoordinator({
    host,
    publish(point) {
      try {
        compatibilityService?.registry?.ingestKernelPoint(point.id, point);
      } catch {
        // 诊断聚合失败不能反向改变真实 Provider 的参数、返回值或异常。
      }
      try {
        publish?.(point);
      } catch {}
    },
  });
  return Object.freeze({ coordinator, points: pointRefs });
}

module.exports = { createHostModificationRuntime };
