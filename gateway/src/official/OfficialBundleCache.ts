// @ts-nocheck
export {};

const path = require("path");
const { MANIFEST_SCHEMA_VERSION } = require("./constants");

/** 按统一 schema 和 app.asar 文件身份判断缓存是否需要刷新。 */
class OfficialBundleRefreshPolicy {
  constructor({ schemaVersion = MANIFEST_SCHEMA_VERSION }: { schemaVersion?: number } = {}) {
    this.schemaVersion = schemaVersion;
  }

  reason({
    manifest,
    sourceInfo,
    webviewReady,
  }: {
    manifest: any | null;
    sourceInfo: any;
    webviewReady: boolean;
  }): string {
    if (!manifest) return "缓存清单不存在";
    if (manifest.schemaVersion !== this.schemaVersion) {
      return `缓存清单版本变化：${manifest.schemaVersion || "none"} -> ${this.schemaVersion}`;
    }
    if (!Number.isFinite(Number(manifest.sourceAsarSize))) {
      return "缓存清单缺少 app.asar 文件大小";
    }
    if (!Number.isFinite(Number(manifest.sourceAsarMtimeMs))) {
      return "缓存清单缺少 app.asar 修改时间";
    }
    if (Number(manifest.sourceAsarSize) !== sourceInfo.sourceAsarSize) {
      return `app.asar 文件大小变化：${manifest.sourceAsarSize} -> ${sourceInfo.sourceAsarSize}`;
    }
    if (Number(manifest.sourceAsarMtimeMs) !== sourceInfo.sourceAsarMtimeMs) {
      return `app.asar 修改时间变化：${manifest.sourceAsarMtimeMs} -> ${sourceInfo.sourceAsarMtimeMs}`;
    }
    if (!webviewReady) return "已处理的 webview 缓存缺失或不完整";
    return "";
  }
}

/**
 * 管理已处理的官方渲染器缓存目录。
 *
 * 这个类负责缓存目录定位、manifest 读取、缓存完整性检查和刷新时的原子替换。
 * manifest 生成和 app.asar 解压分别由 manifest factory / extractor 负责。
 */
class OfficialBundleCache {
  constructor({
    projectRoot,
    configuredBundleDir,
    logger,
    fileSystem,
    refreshPolicy = new OfficialBundleRefreshPolicy(),
  }: {
    projectRoot: string;
    configuredBundleDir: string;
    logger: any;
    fileSystem: any;
    refreshPolicy?: OfficialBundleRefreshPolicy;
  }) {
    this.projectRoot = projectRoot;
    this.configuredBundleDir = configuredBundleDir;
    this.logger = logger;
    this.fileSystem = fileSystem;
    this.refreshPolicy = refreshPolicy;
  }

  get bundleDir(): string {
    return path.isAbsolute(this.configuredBundleDir)
      ? this.configuredBundleDir
      : path.resolve(this.projectRoot, this.configuredBundleDir);
  }

  get webviewDir(): string {
    return path.join(this.bundleDir, "webview");
  }

  readManifest(): any | null {
    const manifestPath = path.join(this.bundleDir, "manifest.json");
    if (!this.fileSystem.exists(manifestPath)) return null;
    try {
      return JSON.parse(this.fileSystem.readText(manifestPath));
    } catch (error) {
      this.logger.warn(`缓存清单无法读取，将重新生成：${manifestPath}`, error);
      return null;
    }
  }

  refreshReason(manifest: any | null, sourceInfo: any): string {
    return this.refreshPolicy.reason({
      manifest,
      sourceInfo,
      webviewReady: this.isWebviewReady(),
    });
  }

  replaceWith(sourceDir: string): void {
    const backupDir = `${this.bundleDir}.bak-${process.pid}-${Date.now()}`;
    this.fileSystem.removeTree(backupDir);
    if (this.fileSystem.exists(this.bundleDir)) {
      this.fileSystem.rename(this.bundleDir, backupDir);
    }
    try {
      this.fileSystem.rename(sourceDir, this.bundleDir);
      this.fileSystem.removeTree(backupDir);
    } catch (error) {
      if (this.fileSystem.exists(backupDir) && !this.fileSystem.exists(this.bundleDir)) {
        this.fileSystem.rename(backupDir, this.bundleDir);
      }
      throw error;
    }
  }

  private isWebviewReady(): boolean {
    const indexPath = path.join(this.webviewDir, "index.html");
    const assetsDir = path.join(this.webviewDir, "assets");
    if (!this.fileSystem.exists(indexPath)) return false;
    if (!this.fileSystem.exists(assetsDir)) return false;
    try {
      return this.fileSystem.readDir(assetsDir).length > 0;
    } catch {
      return false;
    }
  }
}

/** 根据当前安装源生成 cache manifest，provider 不直接拼 manifest 字段。 */
class OfficialBundleManifestFactory {
  create(sourceInfo: any): any {
    return {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      sourceAppPath: sourceInfo.installRoot,
      sourceResourcesPath: sourceInfo.resourcesDir,
      sourceAsarPath: sourceInfo.asarPath,
      sourceCodexBinaryPath: sourceInfo.codexBinaryPath,
      sourceLayoutKind: sourceInfo.layoutKind,
      sourcePlatformHint: sourceInfo.platformHint,
      bundleIdentifier: sourceInfo.bundleIdentifier,
      version: sourceInfo.version,
      build: sourceInfo.build,
      sourceAsarSize: sourceInfo.sourceAsarSize,
      sourceAsarMtimeMs: sourceInfo.sourceAsarMtimeMs,
      processedAt: new Date().toISOString(),
    };
  }
}

module.exports = {
  OfficialBundleCache,
  OfficialBundleRefreshPolicy,
  OfficialBundleManifestFactory,
};
