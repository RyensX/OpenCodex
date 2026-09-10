// @ts-nocheck
export {};

const path = require("path");
const { MANIFEST_SCHEMA_VERSION } = require("./constants");
const { OfficialRuntimeEntryResolver } = require("./OfficialRuntimeEntryResolver");

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
    if (!manifest.runtimeOptimizations || typeof manifest.runtimeOptimizations !== "object") {
      return "缓存清单缺少运行时优化信息";
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
    if (!webviewReady) return "已处理的官方运行时缓存缺失或不完整";
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
    runtimeEntryResolver = new OfficialRuntimeEntryResolver(),
  }: {
    projectRoot: string;
    configuredBundleDir: string;
    logger: any;
    fileSystem: any;
    refreshPolicy?: OfficialBundleRefreshPolicy;
    runtimeEntryResolver?: OfficialRuntimeEntryResolver;
  }) {
    this.projectRoot = projectRoot;
    this.configuredBundleDir = configuredBundleDir;
    this.logger = logger;
    this.fileSystem = fileSystem;
    this.refreshPolicy = refreshPolicy;
    this.runtimeEntryResolver = runtimeEntryResolver;
  }

  get bundleDir(): string {
    return path.isAbsolute(this.configuredBundleDir)
      ? this.configuredBundleDir
      : path.resolve(this.projectRoot, this.configuredBundleDir);
  }

  get webviewDir(): string {
    return path.join(this.bundleDir, "webview");
  }

  get bootstrapPath(): string {
    // 保留 bootstrapPath 对外字段名；实际值按官方 package.json.main 兼容新旧入口。
    const runtimeEntryPath = this.runtimeEntryResolver.resolveFromPackageFile({
      packageJsonPath: path.join(this.bundleDir, "package.json"),
      fileSystem: this.fileSystem,
    });
    return path.join(this.bundleDir, ...runtimeEntryPath.split("/"));
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

  reuseWithoutSourceScanBlockReason(manifest: any | null): string {
    if (!manifest) return "缓存清单不存在";
    const schemaVersion = Number.isFinite(Number(this.refreshPolicy?.schemaVersion))
      ? this.refreshPolicy.schemaVersion
      : MANIFEST_SCHEMA_VERSION;
    if (manifest.schemaVersion !== schemaVersion) {
      return `缓存清单版本变化：${manifest.schemaVersion || "none"} -> ${schemaVersion}`;
    }
    if (!manifest.runtimeOptimizations || typeof manifest.runtimeOptimizations !== "object") {
      return "缓存清单缺少运行时优化信息";
    }
    if (!this.isWebviewReady()) return "已处理的官方运行时缓存缺失或不完整";

    const sourceAsarPath = typeof manifest.sourceAsarPath === "string" ? manifest.sourceAsarPath : "";
    if (!sourceAsarPath) return "缓存清单缺少 app.asar 来源路径";
    if (!this.fileSystem.isFile(sourceAsarPath)) return "缓存记录的 app.asar 不存在";

    const sourceResourcesPath =
      typeof manifest.sourceResourcesPath === "string" && manifest.sourceResourcesPath
        ? manifest.sourceResourcesPath
        : path.dirname(sourceAsarPath);
    // 即使不扫描升级，官方 resources 目录仍要给 hidden runtime 查找 CLI、插件等配套资源。
    if (!this.fileSystem.isDirectory(sourceResourcesPath)) return "缓存记录的官方 resources 目录不存在";

    const sourceCodexBinaryPath =
      typeof manifest.sourceCodexBinaryPath === "string" ? manifest.sourceCodexBinaryPath : "";
    // 如果 manifest 记录了 CLI 路径，就必须确认它仍可用，避免 app-server hook 指向失效二进制。
    if (sourceCodexBinaryPath && !this.fileSystem.isFile(sourceCodexBinaryPath)) return "缓存记录的 Codex CLI 不存在";
    return "";
  }

  refreshReason(manifest: any | null, sourceInfo: any): string {
    return this.refreshPolicy.reason({
      manifest,
      sourceInfo,
      webviewReady: this.isWebviewReady(),
    });
  }

  get backupDir(): string {
    return `${this.bundleDir}-bak`;
  }

  backupState(): any {
    // 使用同一套缓存校验，避免还原后因备份不完整而自动重新解压新版。
    const backup = new OfficialBundleCache({
      projectRoot: this.projectRoot,
      configuredBundleDir: this.backupDir,
      logger: this.logger,
      fileSystem: this.fileSystem,
      refreshPolicy: this.refreshPolicy,
      runtimeEntryResolver: this.runtimeEntryResolver,
    });
    const manifest = backup.readManifest();
    const reason = backup.reuseWithoutSourceScanBlockReason(manifest);
    return { available: !reason, version: manifest?.version || "", reason };
  }

  restoreBackup(): void {
    const backup = this.backupState();
    if (!backup.available) throw new Error(`无法还原备份：${backup.reason}`);
    // 先暂存当前目录，备份改名失败时仍能恢复当前版本；成功后才删除新版。
    const discardedDir = `${this.bundleDir}.restore-${process.pid}-${Date.now()}`;
    const hadCurrent = this.fileSystem.exists(this.bundleDir);
    if (hadCurrent) this.fileSystem.rename(this.bundleDir, discardedDir);
    try {
      this.fileSystem.rename(this.backupDir, this.bundleDir);
    } catch (error) {
      if (hadCurrent) this.fileSystem.rename(discardedDir, this.bundleDir);
      throw error;
    }
    this.cleanupRetiredDirectory(discardedDir);
  }

  replaceWith(sourceDir: string): void {
    // 仅保留上一版；新目录安装失败时，同时保住当前版本和原有备份。
    const retiredBackup = `${this.backupDir}.tmp-${process.pid}-${Date.now()}`;
    const hadCurrent = this.fileSystem.exists(this.bundleDir);
    const hadBackup = this.fileSystem.exists(this.backupDir);
    if (hadCurrent && hadBackup) this.fileSystem.rename(this.backupDir, retiredBackup);
    let movedCurrent = false;
    try {
      if (hadCurrent) {
        this.fileSystem.rename(this.bundleDir, this.backupDir);
        movedCurrent = true;
      }
      this.fileSystem.rename(sourceDir, this.bundleDir);
    } catch (error) {
      if (movedCurrent) this.fileSystem.rename(this.backupDir, this.bundleDir);
      if (hadCurrent && hadBackup) this.fileSystem.rename(retiredBackup, this.backupDir);
      throw error;
    }
    this.cleanupRetiredDirectory(retiredBackup);
  }

  private cleanupRetiredDirectory(directory: string): void {
    // 切换已成功，清理失败仅记录日志，不把已完成的切换误报成失败。
    try {
      this.fileSystem.removeTree(directory);
    } catch (error) {
      this.logger.warn(`旧缓存目录清理失败：${directory}`, error);
    }
  }

  private isWebviewReady(): boolean {
    const indexPath = path.join(this.webviewDir, "index.html");
    const assetsDir = path.join(this.webviewDir, "assets");
    const packagePath = path.join(this.bundleDir, "package.json");
    const nodeModulesDir = path.join(this.bundleDir, "node_modules");
    // 缓存完整性同时检查 renderer 和 main runtime，防止旧版只含 webview 的缓存被误复用。
    if (!this.fileSystem.exists(indexPath)) return false;
    if (!this.fileSystem.exists(assetsDir)) return false;
    if (!this.fileSystem.exists(packagePath)) return false;
    if (!this.fileSystem.exists(nodeModulesDir)) return false;
    try {
      if (!this.fileSystem.exists(this.bootstrapPath)) return false;
    } catch {
      return false;
    }
    try {
      return this.fileSystem.readDir(assetsDir).length > 0;
    } catch {
      return false;
    }
  }
}

/** 根据当前安装源生成 cache manifest，provider 不直接拼 manifest 字段。 */
class OfficialBundleManifestFactory {
  create(sourceInfo: any, runtimeOptimizations: any = null): any {
    return {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      sourceAppPath: sourceInfo.installRoot,
      sourceResourcesPath: sourceInfo.resourcesDir,
      sourceAsarPath: sourceInfo.asarPath,
      sourceUnpackedAsarPath: sourceInfo.unpackedAsarDir,
      sourceCodexBinaryPath: sourceInfo.codexBinaryPath,
      sourceLayoutKind: sourceInfo.layoutKind,
      sourcePlatformHint: sourceInfo.platformHint,
      bundleIdentifier: sourceInfo.bundleIdentifier,
      version: sourceInfo.version,
      build: sourceInfo.build,
      sourceAsarSize: sourceInfo.sourceAsarSize,
      sourceAsarMtimeMs: sourceInfo.sourceAsarMtimeMs,
      runtimeOptimizations,
      processedAt: new Date().toISOString(),
    };
  }
}

module.exports = {
  OfficialBundleCache,
  OfficialBundleRefreshPolicy,
  OfficialBundleManifestFactory,
};
