// @ts-nocheck
export {};

/** 封装 asar 读操作，避免扫描、元信息读取和解压器各自 require。 */
class AsarArchiveReader {
  private asarModule: any | null = null;

  listPackage(asarPath: string): string[] {
    return this.loadAsar().listPackage(asarPath);
  }

  statFile(asarPath: string, entry: string): any {
    return this.loadAsar().statFile(asarPath, entry);
  }

  extractFile(asarPath: string, entry: string): Buffer {
    return this.loadAsar().extractFile(asarPath, entry);
  }

  extractJson(asarPath: string, entry: string): any | null {
    try {
      const raw = this.extractFile(asarPath, entry);
      return JSON.parse(String(raw));
    } catch {
      return null;
    }
  }

  private loadAsar(): any {
    if (this.asarModule) return this.asarModule;
    try {
      this.asarModule = require("@electron/asar");
      return this.asarModule;
    } catch (error) {
      throw new Error(`需要 @electron/asar 才能读取 Codex app.asar：${error instanceof Error ? error.message : error}`);
    }
  }
}

module.exports = { AsarArchiveReader };
