// @ts-nocheck
export {};

const path = require("path");
const { OfficialRuntimeEntryResolver } = require("./OfficialRuntimeEntryResolver");

/** 校验 asar entry 解压目标，只允许写入目标运行时目录内部。 */
class WebviewExtractionPathGuard {
  resolve(bundleDestDir: string, relativeEntryPath: string): string {
    if (this.isUnsafeRelativePath(relativeEntryPath)) {
      throw new Error(`拒绝解压可疑 webview 路径：${relativeEntryPath}`);
    }
    const root = path.resolve(bundleDestDir);
    const dest = path.resolve(root, relativeEntryPath);
    const relativeToRoot = path.relative(root, dest);
    if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
      throw new Error(`拒绝解压越界 webview 路径：${relativeEntryPath}`);
    }
    return dest;
  }

  private isUnsafeRelativePath(relativeEntryPath: string): boolean {
    if (!relativeEntryPath) return true;
    if (path.isAbsolute(relativeEntryPath) || path.win32.isAbsolute(relativeEntryPath) || path.posix.isAbsolute(relativeEntryPath)) {
      return true;
    }
    return relativeEntryPath.split(/[\\/]+/).some((part) => part === "..");
  }
}

const RUNTIME_DIR_PREFIXES = [".vite/build/", "webview/", "node_modules/"];
const RUNTIME_FILE_ENTRIES = new Set(["package.json"]);

/**
 * 只允许解压 official gateway 运行官方 main/renderer 必需的白名单资源。
 *
 * 这是运行时工作副本生成逻辑，不是对官方 bundle 做补丁，也不会进入 OpenCodex dist。
 */
class AsarWebviewExtractor {
  constructor({
    archive,
    fileSystem,
    pathGuard = new WebviewExtractionPathGuard(),
    runtimeEntryResolver = new OfficialRuntimeEntryResolver(),
  }: {
    archive: any;
    fileSystem: any;
    pathGuard?: WebviewExtractionPathGuard;
    runtimeEntryResolver?: OfficialRuntimeEntryResolver;
  }) {
    this.archive = archive;
    this.fileSystem = fileSystem;
    this.pathGuard = pathGuard;
    this.runtimeEntryResolver = runtimeEntryResolver;
  }

  extract(asarPath: string, bundleDestDir: string): any {
    /**
     * 解压策略是“白名单复制”，不是完整展开 app.asar：
     * - .vite/build/ 保存 package.json.main 指向的旧版 bootstrap 或新版 early-bootstrap。
     * - webview/ 提供官方 renderer 静态资源。
     * - node_modules/ 和 package.json 满足官方 bootstrap 的运行时依赖。
     *
     * 复制出来的文件只放在用户 runtime cache；官方安装源保持只读语义。
    */
    const entries = this.archive.listPackage(asarPath);
    const packageInfo = this.archive.extractJson(asarPath, "package.json");
    if (!packageInfo || typeof packageInfo !== "object" || Array.isArray(packageInfo)) {
      throw new Error(`无法从 ${asarPath} 读取有效的官方 package.json`);
    }
    const runtimeEntryPath = this.runtimeEntryResolver.resolve({ packageInfo, availableEntries: entries });
    let fileCount = 0;
    let byteCount = 0;

    for (const rawEntry of entries) {
      const entry = String(rawEntry).replace(/^[\\/]+/, "");
      // Windows 下 @electron/asar 会返回反斜杠路径；统一成 POSIX 形式后再判断运行时白名单。
      const normalizedEntry = this.runtimeEntryResolver.normalizeArchiveEntry(entry);
      if (!this.shouldExtractEntry(normalizedEntry)) continue;

      // asar 目录项没有内容，真正需要写盘的是文件项。
      const stat = this.archive.statFile(asarPath, entry);
      if (stat && stat.files) continue;

      const data = this.archive.extractFile(asarPath, entry);
      const dest = this.pathGuard.resolve(bundleDestDir, normalizedEntry);
      this.fileSystem.writeFile(dest, data);
      fileCount += 1;
      byteCount += data.length;
    }

    // renderer、动态 main 和 package metadata 是 hidden runtime 能跑起来的最低要求，缺一就让缓存刷新失败。
    if (!this.fileSystem.exists(path.join(bundleDestDir, "webview", "index.html"))) {
      throw new Error(`从 ${asarPath} 解压出的 Codex webview 缺少 index.html`);
    }
    if (!this.fileSystem.exists(path.join(bundleDestDir, ...runtimeEntryPath.split("/")))) {
      throw new Error(`从 ${asarPath} 解压出的 Codex/ChatGPT Desktop 运行时缺少 ${runtimeEntryPath}`);
    }
    if (!this.fileSystem.exists(path.join(bundleDestDir, "package.json"))) {
      throw new Error(`从 ${asarPath} 解压出的 Codex 运行时缺少 package.json`);
    }
    return { fileCount, byteCount, runtimeEntryPath };
  }

  private shouldExtractEntry(normalizedEntry: string): boolean {
    // 只解压白名单前缀，避免把整个 app.asar 展开到项目缓存里。
    if (RUNTIME_FILE_ENTRIES.has(normalizedEntry)) return true;
    return RUNTIME_DIR_PREFIXES.some((prefix) => normalizedEntry.startsWith(prefix));
  }
}

module.exports = {
  AsarWebviewExtractor,
  WebviewExtractionPathGuard,
};
