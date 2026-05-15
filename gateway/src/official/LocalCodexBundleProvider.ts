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

type EnsureOfficialBundleResult = {
  bundleDir: string;
  webviewDir: string;
  manifest: any;
  sourceAppPath: string;
  sourceAsarPath: string;
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
};

/**
 * 网关启动时使用的本地官方资源包提供器。
 *
 * 职责：
 * 1. 读取缓存清单，并把上次 app.asar 位置作为快速路径交给扫描器。
 * 2. 如果记录文件不存在，用跨平台扫描器定位当前可用的 app.asar。
 * 3. 从 plist 或 package.json 读取展示用版本信息。
 * 4. 用统一的 app.asar 文件身份判断缓存是否过期。
 * 5. 只在缓存过期时从 app.asar 解压 webview。
 *
 * 网关入口继续使用 ensureOfficialBundle()。
 * 具体扫描、缓存、manifest 和解压逻辑拆到同目录下的独立类中。
 */
class LocalCodexBundleProvider {
  constructor(options: LocalCodexBundleProviderOptions = {}) {
    const fileSystem = options.fileSystem || new OfficialBundleFileSystem();
    const archive = new AsarArchiveReader();
    this.defaultBundleDir = options.defaultBundleDir || DEFAULT_BUNDLE_DIR;
    this.bundleDirEnv = options.bundleDirEnv || process.env.CODEX_WEB_OFFICIAL_BUNDLE_DIR || "";
    this.logger = options.logger || new OfficialBundleLogger();
    this.fileSystem = fileSystem;
    this.scanner = new CodexAsarScanner({
      configuredPath: options.appPathEnv || process.env.CODEX_DESKTOP_APP_PATH || "",
      defaultCandidates: options.appCandidates || null,
      fileSystem,
    });
    this.sourceInfoReader = new CodexBundleSourceInfoReader({ logger: this.logger, archive, fileSystem });
    this.extractor = new AsarWebviewExtractor({ archive, fileSystem });
    this.manifestFactory = new OfficialBundleManifestFactory();
    this.byteFormatter = new BundleByteFormatter();
  }

  ensure({ projectRoot }: { projectRoot: string }): EnsureOfficialBundleResult {
    const cache = this.createCache(projectRoot);
    const manifest = cache.readManifest();
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
      manifest: activeManifest,
      sourceAppPath: sourceInfo.installRoot,
      sourceAsarPath: sourceInfo.asarPath,
      codexBinaryPath: sourceInfo.codexBinaryPath,
      version: sourceInfo.version,
      build: sourceInfo.build,
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
    const startedAt = Date.now();
    const tmpDir = `${cache.bundleDir}.tmp-${process.pid}-${Date.now()}`;
    this.fileSystem.removeTree(tmpDir);
    this.fileSystem.ensureDir(tmpDir);

    this.logger.info(`需要刷新缓存：${reason}`);
    this.logger.info(`从 ${sourceInfo.asarPath} 解压 webview`);
    try {
      const webviewDir = path.join(tmpDir, "webview");
      const result = this.extractor.extract(sourceInfo.asarPath, webviewDir);
      const manifest = this.manifestFactory.create(sourceInfo);
      this.fileSystem.writeJson(path.join(tmpDir, "manifest.json"), manifest);
      cache.replaceWith(tmpDir);
      this.logger.info(
        `已解压 ${result.fileCount} 个 webview 文件（${this.byteFormatter.format(result.byteCount)}），耗时 ${Date.now() - startedAt}ms`
      );
      return manifest;
    } catch (error) {
      this.fileSystem.removeTree(tmpDir);
      throw error;
    }
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
};
