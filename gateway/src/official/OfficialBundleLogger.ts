// @ts-nocheck
export {};

/** 统一官方资源包日志前缀，方便在网关启动输出中单独检索。 */
class OfficialBundleLogger {
  info(message: string, extra?: unknown): void {
    if (extra === undefined) {
      console.log(`[official-bundle] ${message}`);
    } else {
      console.log(`[official-bundle] ${message}`, extra);
    }
  }

  warn(message: string, extra?: unknown): void {
    if (extra === undefined) {
      console.warn(`[official-bundle] ${message}`);
    } else {
      console.warn(`[official-bundle] ${message}`, extra);
    }
  }
}

module.exports = { OfficialBundleLogger };
