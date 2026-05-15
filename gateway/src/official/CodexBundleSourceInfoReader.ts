// @ts-nocheck
export {};

const { execFileSync } = require("child_process");
const { AsarFileIdentity } = require("./AsarFileIdentity");

/** 读取安装源元信息；version/build 只用于日志展示，缓存刷新统一看 app.asar 文件身份。 */
class CodexBundleSourceInfoReader {
  constructor({
    logger,
    archive,
    fileSystem,
  }: {
    logger: any;
    archive: any;
    fileSystem: any;
  }) {
    this.logger = logger;
    this.archive = archive;
    this.fileSystem = fileSystem;
  }

  read(layout: any): any {
    const plistInfo = layout.infoPlistPath ? this.readInfoPlist(layout.infoPlistPath) : null;
    const packageInfo = this.archive.extractJson(layout.asarPath, "package.json") || {};
    const asarIdentity = AsarFileIdentity.read(layout.asarPath, this.fileSystem);
    const bundleIdentifier = String(
      plistInfo?.CFBundleIdentifier ||
        packageInfo.build?.appId ||
        packageInfo.appId ||
        packageInfo.name ||
        ""
    );
    if (bundleIdentifier && !bundleIdentifier.toLowerCase().includes("codex")) {
      this.logger.warn(`安装包标识 ${bundleIdentifier} 看起来不像 Codex，仍继续尝试读取官方资源`);
    }

    return {
      installRoot: layout.installRoot,
      resourcesDir: layout.resourcesDir,
      asarPath: layout.asarPath,
      codexBinaryPath: layout.codexBinaryPath,
      bundleIdentifier,
      version: String(plistInfo?.CFBundleShortVersionString || packageInfo.version || "unknown"),
      build: String(
        plistInfo?.CFBundleVersion ||
          packageInfo.buildNumber ||
          packageInfo.buildVersion ||
          packageInfo.codexBuild ||
          `${asarIdentity.size}-${asarIdentity.mtimeMs}`
      ),
      sourceAsarSize: asarIdentity.size,
      sourceAsarMtimeMs: asarIdentity.mtimeMs,
      layoutKind: layout.layoutKind,
      platformHint: layout.platformHint,
    };
  }

  private readInfoPlist(infoPlistPath: string): any | null {
    if (process.platform === "darwin") {
      try {
        const raw = execFileSync("plutil", ["-convert", "json", "-o", "-", infoPlistPath], {
          encoding: "utf-8",
          maxBuffer: 1024 * 1024,
        });
        return JSON.parse(raw);
      } catch (error) {
        this.logger.warn(`读取 Info.plist 失败，将尝试降级读取：${infoPlistPath}`, error);
      }
    }
    return this.readXmlPlist(infoPlistPath);
  }

  private readXmlPlist(infoPlistPath: string): any | null {
    let raw = "";
    try {
      raw = this.fileSystem.readText(infoPlistPath);
    } catch {
      return null;
    }
    if (!raw.includes("<plist")) return null;
    const result = {};
    const pattern = /<key>([^<]+)<\/key>\s*<(string|integer)>([^<]*)<\/\2>/g;
    for (const match of raw.matchAll(pattern)) {
      result[match[1]] = match[3];
    }
    return result;
  }
}

module.exports = { CodexBundleSourceInfoReader };
