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

  get bootstrapPath(): string {
    // 官方 Electron main 的入口文件，gateway 通过它启动 hidden runtime。
    return path.join(this.bundleDir, ".vite", "build", "bootstrap.js");
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

  replaceWith(sourceDir: string): void {
    // 先备份旧缓存，再把新缓存 rename 到位；失败时尽量恢复旧缓存。
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
    const packagePath = path.join(this.bundleDir, "package.json");
    const nodeModulesDir = path.join(this.bundleDir, "node_modules");
    // 缓存完整性同时检查 renderer 和 main runtime，防止旧版只含 webview 的缓存被误复用。
    if (!this.fileSystem.exists(indexPath)) return false;
    if (!this.fileSystem.exists(assetsDir)) return false;
    if (!this.fileSystem.exists(this.bootstrapPath)) return false;
    if (!this.fileSystem.exists(packagePath)) return false;
    if (!this.fileSystem.exists(nodeModulesDir)) return false;
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
      sourceUnpackedAsarPath: sourceInfo.unpackedAsarDir,
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
