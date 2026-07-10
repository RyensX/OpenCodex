// @ts-nocheck
export {};

const path = require("path");

const LEGACY_RUNTIME_ENTRY_PATH = ".vite/build/bootstrap.js";
const RUNTIME_ENTRY_PREFIX = ".vite/build/";

/**
 * 统一解析官方 Electron package.json 的 main，兼容旧版 bootstrap 和新版 early-bootstrap。
 * 返回值始终是安全的 POSIX 相对路径，供 ASAR、缓存目录和最终 require 共用。
 */
class OfficialRuntimeEntryResolver {
  resolve({
    packageInfo,
    availableEntries = null,
  }: {
    packageInfo?: any;
    availableEntries?: string[] | null;
  } = {}): string {
    const hasDeclaredMain =
      packageInfo && typeof packageInfo === "object" && Object.prototype.hasOwnProperty.call(packageInfo, "main");
    if (hasDeclaredMain && (typeof packageInfo.main !== "string" || !packageInfo.main.trim())) {
      throw new Error("官方 package.json.main 不是有效的非空字符串");
    }
    const runtimeEntryPath = hasDeclaredMain
      ? this.normalizeDeclaredMain(packageInfo.main.trim())
      : LEGACY_RUNTIME_ENTRY_PATH;

    if (!runtimeEntryPath.startsWith(RUNTIME_ENTRY_PREFIX)) {
      throw new Error(`官方 runtime main 不在允许的构建目录中：${runtimeEntryPath}`);
    }
    if (availableEntries && !this.normalizedEntrySet(availableEntries).has(runtimeEntryPath)) {
      throw new Error(`官方 runtime main 在 app.asar 中不存在：${runtimeEntryPath}`);
    }
    return runtimeEntryPath;
  }

  resolveFromPackageFile({
    packageJsonPath,
    fileSystem,
  }: {
    packageJsonPath: string;
    fileSystem: any;
  }): string {
    // 缺少 main 可以回退旧入口，但 package.json 本身损坏时必须暴露错误，避免复用不完整缓存。
    const packageInfo = JSON.parse(fileSystem.readText(packageJsonPath));
    return this.resolve({ packageInfo });
  }

  normalizeArchiveEntry(rawEntry: string): string {
    return String(rawEntry || "")
      .replace(/\\/g, "/")
      .replace(/^\/+/, "");
  }

  private normalizeDeclaredMain(rawMain: string): string {
    const withPosixSeparators = String(rawMain || "").replace(/\\/g, "/");
    if (
      !withPosixSeparators ||
      path.posix.isAbsolute(withPosixSeparators) ||
      path.win32.isAbsolute(rawMain) ||
      /^[A-Za-z]:\//.test(withPosixSeparators) ||
      withPosixSeparators.split("/").some((part) => part === "..")
    ) {
      throw new Error(`拒绝不安全或越界的官方 runtime main：${rawMain}`);
    }

    const normalized = path.posix.normalize(withPosixSeparators).replace(/^(?:\.\/)+/, "");
    if (!normalized || normalized === ".") {
      throw new Error(`拒绝越界的官方 runtime main：${rawMain}`);
    }
    return normalized;
  }

  private normalizedEntrySet(entries: string[]): Set<string> {
    return new Set(entries.map((entry) => this.normalizeArchiveEntry(entry)).filter(Boolean));
  }
}

module.exports = {
  LEGACY_RUNTIME_ENTRY_PATH,
  RUNTIME_ENTRY_PREFIX,
  OfficialRuntimeEntryResolver,
};
