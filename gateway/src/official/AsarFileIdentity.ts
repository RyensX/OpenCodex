// @ts-nocheck
export {};

/** app.asar 的轻量文件身份；三端统一用 size + mtimeMs 判断缓存是否过期。 */
class AsarFileIdentity {
  constructor({ size, mtimeMs }: { size: number; mtimeMs: number }) {
    this.size = size;
    this.mtimeMs = mtimeMs;
  }

  static read(asarPath: string, fileSystem: any): AsarFileIdentity {
    const stat = fileSystem.stat(asarPath);
    return new AsarFileIdentity({
      size: stat.size,
      mtimeMs: Math.trunc(stat.mtimeMs),
    });
  }

  equals(other: AsarFileIdentity): boolean {
    return this.size === other.size && this.mtimeMs === other.mtimeMs;
  }
}

module.exports = { AsarFileIdentity };
