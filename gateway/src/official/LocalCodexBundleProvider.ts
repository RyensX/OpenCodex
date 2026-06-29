// @ts-nocheck
export {};

const path = require("path");
const { DEFAULT_BUNDLE_DIR } = require("./constants");
const { OfficialBundleLogger } = require("./OfficialBundleLogger");
const { OfficialBundleFileSystem } = require("./OfficialBundleFileSystem");
const { BundleByteFormatter } = require("./BundleByteFormatter");
const { CodexAsarScanner } = require("./CodexAsarScanner");
const { AsarArchiveReader } = require("./AsarArchiveReader");
const { CodexBundleSourceInfoReader } = require("./CodexBundleSourceInfoReader");
const { OfficialBundleCache, OfficialBundleManifestFactory } = require("./OfficialBundleCache");
const { AsarWebviewExtractor } = require("./AsarWebviewExtractor");

const OFFICIAL_AUTO_SCAN_UPGRADE_ENV = "CODEX_WEB_OFFICIAL_AUTO_SCAN_UPGRADE";

type EnsureOfficialBundleResult = {
  bundleDir: string;
  webviewDir: string;
  bootstrapPath: string;
  packageJsonPath: string;
  manifest: any;
  sourceAppPath: string;
  sourceAsarPath: string;
  sourceResourcesPath: string;
  codexBinaryPath: string | null;
  version: string;
  build: string;
};

type LocalCodexBundleProviderOptions = {
  appPathEnv?: string;
  bundleDirEnv?: string;
  defaultBundleDir?: string;
  appCandidates?: string[];
  logger?: any;
  fileSystem?: any;
  env?: Record<string, string | undefined>;
};

/**
 * 网关启动时使用的本地官方资源包提供器。
 *
 * 职责：
 * 1. 读取缓存清单，并把上次 app.asar 位置作为快速路径交给扫描器。
 * 2. 如果记录文件不存在，用跨平台扫描器定位当前可用的 app.asar。
 * 3. 从 plist 或 package.json 读取展示用版本信息。
 * 4. 用统一的 app.asar 文件身份判断缓存是否过期。
 * 5. 只在缓存过期时从 app.asar 解压运行时工作副本。
 *
 * 注意：这里不会修改官方 Codex.app / app.asar，也不会要求打包产物内置官方 bundle。
 * 抽取结果只落到 OpenCodex 的用户可写 runtime cache，作为 gateway 启动官方代码的临时工作副本。
 *
 * 网关入口继续使用 ensureOfficialBundle()。
 * 具体扫描、缓存、manifest 和解压逻辑拆到同目录下的独立类中。
 */
class LocalCodexBundleProvider {
  constructor(options: LocalCodexBundleProviderOptions = {}) {
    const fileSystem = options.fileSystem || new OfficialBundleFileSystem();
    const archive = new AsarArchiveReader();
    this.env = options.env || process.env;
    this.defaultBundleDir = options.defaultBundleDir || DEFAULT_BUNDLE_DIR;
    this.bundleDirEnv =
      options.bundleDirEnv ||
      this.env.CODEX_WEB_OFFICIAL_BUNDLE_DIR ||
      (this.env.CODEX_WEB_RUNTIME_DIR
        ? path.join(this.env.CODEX_WEB_RUNTIME_DIR, "cache", "codex-official-bundle")
        : "");
    this.autoScanUpgrade = this.env[OFFICIAL_AUTO_SCAN_UPGRADE_ENV] !== "0";
    this.logger = options.logger || new OfficialBundleLogger();
    this.fileSystem = fileSystem;
    this.scanner = new CodexAsarScanner({
      configuredPath: options.appPathEnv || this.env.CODEX_DESKTOP_APP_PATH || "",
      defaultCandidates: options.appCandidates || null,
      fileSystem,
    });
    this.sourceInfoReader = new CodexBundleSourceInfoReader({ logger: this.logger, archive, fileSystem });
    this.extractor = new AsarWebviewExtractor({ archive, fileSystem });
    this.manifestFactory = new OfficialBundleManifestFactory();
    this.byteFormatter = new BundleByteFormatter();
  }

  ensure({ projectRoot }: { projectRoot: string }): EnsureOfficialBundleResult {
    /**
     * ensure 是 official gateway 启动前的唯一入口。
     * 它会尽量复用缓存；只有 app.asar 文件身份或缓存完整性不满足时才重新解压。
     */
    const cache = this.createCache(projectRoot);
    const manifest = cache.readManifest();
    if (!this.autoScanUpgrade) {
      const blockReason = cache.reuseWithoutSourceScanBlockReason(manifest);
      if (!blockReason) {
        return this.resultFromCachedManifest({ cache, manifest });
      }
      this.logger.info(`自动扫描官方运行时更新已关闭，但${blockReason}，将扫描一次以重建缓存`);
    }

    const layout = this.scanner.find({ cachedAsarPath: manifest?.sourceAsarPath });
    const sourceInfo = this.sourceInfoReader.read(layout);
    const reason = cache.refreshReason(manifest, sourceInfo);

    this.logSourceInfo({ sourceInfo, cache });

    let activeManifest = manifest;
    if (reason) {
      activeManifest = this.refreshBundle({ cache, sourceInfo, reason });
    } else {
      this.logCacheHit({ manifest, sourceInfo });
    }

    return {
      bundleDir: cache.bundleDir,
      webviewDir: cache.webviewDir,
      // Electron gateway 直接 require 官方 bootstrap，因此 provider 需要把入口路径暴露给运行时层。
      bootstrapPath: cache.bootstrapPath,
      packageJsonPath: path.join(cache.bundleDir, "package.json"),
      manifest: activeManifest,
      sourceAppPath: sourceInfo.installRoot,
      sourceAsarPath: sourceInfo.asarPath,
      // process.resourcesPath 会对齐到官方 Resources，保证官方代码能找到 codex 二进制等资源。
      sourceResourcesPath: sourceInfo.resourcesDir,
      codexBinaryPath: sourceInfo.codexBinaryPath,
      version: sourceInfo.version,
      build: sourceInfo.build,
    };
  }

  private resultFromCachedManifest({ cache, manifest }: { cache: any; manifest: any }): EnsureOfficialBundleResult {
    const sourceAsarPath = manifest.sourceAsarPath || "";
    const sourceResourcesPath = manifest.sourceResourcesPath || path.dirname(sourceAsarPath);
    this.logger.info("自动扫描官方运行时更新已关闭，复用现有官方运行时缓存");
    this.logger.info(`缓存命中：${manifest.version || "unknown"} (build ${manifest.build || "unknown"})`);
    return {
      bundleDir: cache.bundleDir,
      webviewDir: cache.webviewDir,
      // 关闭扫描时不读取安装源文件身份，直接使用已处理缓存中的官方 bootstrap。
      bootstrapPath: cache.bootstrapPath,
      packageJsonPath: path.join(cache.bundleDir, "package.json"),
      manifest,
      sourceAppPath: manifest.sourceAppPath || "",
      sourceAsarPath,
      sourceResourcesPath,
      codexBinaryPath: manifest.sourceCodexBinaryPath || null,
      version: String(manifest.version || "unknown"),
      build: String(manifest.build || "unknown"),
    };
  }

  private createCache(projectRoot: string): any {
    return new OfficialBundleCache({
      projectRoot,
      configuredBundleDir: this.bundleDirEnv || this.defaultBundleDir,
      logger: this.logger,
      fileSystem: this.fileSystem,
    });
  }

  private logSourceInfo({ sourceInfo, cache }: { sourceInfo: any; cache: any }): void {
    this.logger.info(`安装根目录：${sourceInfo.installRoot}`);
    this.logger.info(`app.asar：${sourceInfo.asarPath}`);
    this.logger.info(`安装布局：${sourceInfo.layoutKind} (${sourceInfo.platformHint})`);
    this.logger.info(`已安装版本：${sourceInfo.version} (build ${sourceInfo.build})`);
    this.logger.info(`缓存目录：${cache.bundleDir}`);
  }

  private logCacheHit({ manifest, sourceInfo }: { manifest: any; sourceInfo: any }): void {
    if (manifest.sourceAsarPath && manifest.sourceAsarPath !== sourceInfo.asarPath) {
      this.logger.info(`缓存来源路径不同但 app.asar 文件身份一致，复用 ${manifest.sourceAsarPath}`);
    }
    this.logger.info(`缓存命中：${manifest.version} (build ${manifest.build})`);
  }

  private refreshBundle({
    cache,
    sourceInfo,
    reason,
  }: {
    cache: any;
    sourceInfo: any;
    reason: string;
  }): any {
    // 刷新使用临时目录 + 原子替换，避免 gateway 在半解压状态下读到不完整 runtime。
    const startedAt = Date.now();
    const tmpDir = `${cache.bundleDir}.tmp-${process.pid}-${Date.now()}`;
    this.fileSystem.removeTree(tmpDir);
    this.fileSystem.ensureDir(tmpDir);

    this.logger.info(`需要刷新缓存：${reason}`);
    this.logger.info(`从 ${sourceInfo.asarPath} 解压官方运行时`);
    try {
      // 这里解压的是完整运行时白名单；目标是 OpenCodex runtime cache，不会回写官方安装目录。
      const result = this.extractor.extract(sourceInfo.asarPath, tmpDir);
      const unpackedResult = this.copyUnpackedRuntime({ sourceInfo, tmpDir });
      const manifest = this.manifestFactory.create(sourceInfo);
      this.fileSystem.writeJson(path.join(tmpDir, "manifest.json"), manifest);
      cache.replaceWith(tmpDir);
      this.logger.info(
        `已解压 ${result.fileCount} 个官方运行时文件（${this.byteFormatter.format(result.byteCount)}），同步 unpacked=${unpackedResult.copied ? "yes" : "no"}，耗时 ${Date.now() - startedAt}ms`
      );
      return manifest;
    } catch (error) {
      this.fileSystem.removeTree(tmpDir);
      throw error;
    }
  }

  private copyUnpackedRuntime({ sourceInfo, tmpDir }: { sourceInfo: any; tmpDir: string }): any {
    const unpackedDir = sourceInfo.unpackedAsarDir;
    if (!unpackedDir || !this.fileSystem.isDirectory(unpackedDir)) {
      return { copied: false };
    }
    /**
     * app.asar 只包含 JS/静态资源，better-sqlite3 这类 native addon 会在官方安装目录的
     * app.asar.unpacked 中。刷新缓存时必须把 unpacked 同步进工作副本，否则旧 .node 残留会导致
     * NODE_MODULE_VERSION 不匹配，表现为 Codex 无法访问本地 SQLite。
     */
    this.fileSystem.copyTree(unpackedDir, tmpDir);
    return { copied: true };
  }
}

function ensureOfficialBundle({ projectRoot }: { projectRoot: string }): EnsureOfficialBundleResult {
  return new LocalCodexBundleProvider().ensure({ projectRoot });
}

module.exports = {
  ensureOfficialBundle,
  LocalCodexBundleProvider,
  CodexAsarScanner,
  CodexBundleSourceInfoReader,
  AsarArchiveReader,
  OFFICIAL_AUTO_SCAN_UPGRADE_ENV,
};
