// @ts-nocheck
export {};

/** 格式化启动日志中的字节数。 */
class BundleByteFormatter {
  format(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }
}

module.exports = { BundleByteFormatter };
