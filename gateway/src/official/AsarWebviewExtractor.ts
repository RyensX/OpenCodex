// @ts-nocheck
export {};

const path = require("path");

/** 校验 asar entry 解压目标，只允许写入目标 webview 目录内部。 */
class WebviewExtractionPathGuard {
  resolve(webviewDestDir: string, relativeEntryPath: string): string {
    if (this.isUnsafeRelativePath(relativeEntryPath)) {
      throw new Error(`拒绝解压可疑 webview 路径：${relativeEntryPath}`);
    }
    const root = path.resolve(webviewDestDir);
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

/** 只从 app.asar 中解压官方渲染器的 webview 资源，其他入口全部忽略。 */
class AsarWebviewExtractor {
  constructor({
    archive,
    fileSystem,
    pathGuard = new WebviewExtractionPathGuard(),
  }: {
    archive: any;
    fileSystem: any;
    pathGuard?: WebviewExtractionPathGuard;
  }) {
    this.archive = archive;
    this.fileSystem = fileSystem;
    this.pathGuard = pathGuard;
  }

  extract(asarPath: string, webviewDestDir: string): any {
    const entries = this.archive.listPackage(asarPath);
    let fileCount = 0;
    let byteCount = 0;

    for (const rawEntry of entries) {
      const archiveEntry = this.stripArchiveRoot(rawEntry);
      const entry = this.normalizeArchiveEntry(archiveEntry);
      if (!entry.startsWith("webview/")) continue;
      const rel = entry.slice("webview/".length);
      if (!rel) continue;

      const stat = this.archive.statFile(asarPath, archiveEntry);
      if (stat && stat.files) continue;

      const data = this.archive.extractFile(asarPath, archiveEntry);
      const dest = this.pathGuard.resolve(webviewDestDir, rel);
      this.fileSystem.writeFile(dest, data);
      fileCount += 1;
      byteCount += data.length;
    }

    if (!this.fileSystem.exists(path.join(webviewDestDir, "index.html"))) {
      throw new Error(`从 ${asarPath} 解压出的 Codex webview 缺少 index.html`);
    }
    return { fileCount, byteCount };
  }

  private normalizeArchiveEntry(rawEntry: unknown): string {
    return String(rawEntry).replace(/\\/g, "/");
  }

  private stripArchiveRoot(rawEntry: unknown): string {
    return String(rawEntry).replace(/^[\\/]+/, "");
  }
}

module.exports = {
  AsarWebviewExtractor,
  WebviewExtractionPathGuard,
};
