// @ts-nocheck
export {};

const path = require("path");
const os = require("os");
const { ASAR_FILE_NAME } = require("./constants");
const { OfficialBundleFileSystem } = require("./OfficialBundleFileSystem");

/** 负责产出跨平台 app.asar 搜索候选；manifest 里的快速路径不混入这里。 */
class CodexAsarCandidateProvider {
  constructor({
    fileSystem,
    configuredPath = process.env.CODEX_DESKTOP_APP_PATH || "",
    defaultCandidates = null,
    platform = process.platform,
    env = process.env,
    homeDir = os.homedir(),
  }: {
    fileSystem: OfficialBundleFileSystem;
    configuredPath?: string;
    defaultCandidates?: string[] | null;
    platform?: string;
    env?: Record<string, string | undefined>;
    homeDir?: string;
  }) {
    this.fileSystem = fileSystem;
    this.configuredPath = configuredPath;
    this.defaultCandidates = defaultCandidates;
    this.platform = platform;
    this.env = env;
    this.homeDir = homeDir;
  }

  toList(): string[] {
    return this.uniqueNonEmpty([
      ...(this.configuredPath ? [this.configuredPath] : []),
      ...(this.defaultCandidates || this.defaultInstallCandidates()),
    ]).map((candidate) => this.fileSystem.normalizePath(candidate));
  }

  private defaultInstallCandidates(): string[] {
    if (this.platform === "darwin") {
      return [
        "/Applications/Codex.app",
        path.join(this.homeDir, "Applications", "Codex.app"),
      ];
    }
    if (this.platform === "win32") {
      return this.uniqueNonEmpty([
        this.env.LOCALAPPDATA && path.join(this.env.LOCALAPPDATA, "Programs", "Codex"),
        this.env.LOCALAPPDATA && path.join(this.env.LOCALAPPDATA, "Programs", "Codex", "resources"),
        this.env.PROGRAMFILES && path.join(this.env.PROGRAMFILES, "Codex"),
        this.env["PROGRAMFILES(X86)"] && path.join(this.env["PROGRAMFILES(X86)"], "Codex"),
      ]);
    }
    return [
      "/opt/Codex",
      "/opt/codex",
      "/usr/lib/codex",
      "/usr/share/codex",
      path.join(this.homeDir, ".local", "share", "Codex"),
      path.join(this.homeDir, ".local", "share", "codex"),
    ];
  }

  private uniqueNonEmpty(values: Array<string | null | undefined>): string[] {
    return Array.from(new Set(values.filter((value) => typeof value === "string" && value.trim()).map(String)));
  }
}

/** 只在 CLI 常见位置查找可执行文件，避免把安装根目录的 Electron 桌面入口当作 app-server 命令。 */
class CodexBinaryLocator {
  constructor({
    fileSystem,
    platform = process.platform,
  }: {
    fileSystem: OfficialBundleFileSystem;
    platform?: string;
  }) {
    this.fileSystem = fileSystem;
    this.platform = platform;
  }

  find({
    installRoot,
    resourcesDir,
  }: {
    installRoot: string;
    resourcesDir: string;
  }): string | null {
    return this.candidates({ installRoot, resourcesDir }).find((candidate) => this.fileSystem.isFile(candidate)) || null;
  }

  private candidates({
    installRoot,
    resourcesDir,
  }: {
    installRoot: string;
    resourcesDir: string;
  }): string[] {
    if (this.platform === "win32") {
      return [
        path.join(resourcesDir, "codex.exe"),
        path.join(resourcesDir, "Codex.exe"),
        path.join(resourcesDir, "codex.cmd"),
        path.join(resourcesDir, "bin", "codex.exe"),
      ];
    }
    return [
      path.join(resourcesDir, "codex"),
      path.join(resourcesDir, "Codex"),
      path.join(installRoot, "Contents", "Resources", "codex"),
      path.join(installRoot, "codex"),
    ];
  }
}

/** 根据 app.asar 所在位置推导安装根、resources 目录和布局类型。 */
class CodexInstallLayoutResolver {
  constructor({
    fileSystem,
    binaryLocator = new CodexBinaryLocator({ fileSystem }),
    platform = process.platform,
  }: {
    fileSystem: OfficialBundleFileSystem;
    binaryLocator?: CodexBinaryLocator;
    platform?: string;
  }) {
    this.fileSystem = fileSystem;
    this.binaryLocator = binaryLocator;
    this.platform = platform;
  }

  knownAsarPaths(candidateDir: string): string[] {
    return [
      path.join(candidateDir, ASAR_FILE_NAME),
      path.join(candidateDir, "resources", ASAR_FILE_NAME),
      path.join(candidateDir, "Resources", ASAR_FILE_NAME),
      path.join(candidateDir, "Contents", "Resources", ASAR_FILE_NAME),
    ];
  }

  fromAsar(rawAsarPath: string): any {
    const asarPath = this.fileSystem.realpath(rawAsarPath);
    const resourcesDir = path.dirname(asarPath);
    const installRoot = this.inferInstallRoot(resourcesDir);
    const infoPlistPath = path.join(installRoot, "Contents", "Info.plist");
    return {
      installRoot,
      resourcesDir,
      asarPath,
      codexBinaryPath: this.binaryLocator.find({ installRoot, resourcesDir }),
      infoPlistPath: this.fileSystem.isFile(infoPlistPath) ? infoPlistPath : null,
      layoutKind: this.inferLayoutKind({ installRoot, resourcesDir }),
      platformHint: this.platform,
    };
  }

  private inferInstallRoot(resourcesDir: string): string {
    if (path.basename(resourcesDir) === "Resources" && path.basename(path.dirname(resourcesDir)) === "Contents") {
      return path.dirname(path.dirname(resourcesDir));
    }
    if (path.basename(resourcesDir).toLowerCase() === "resources") {
      return path.dirname(resourcesDir);
    }
    return resourcesDir;
  }

  private inferLayoutKind({
    installRoot,
    resourcesDir,
  }: {
    installRoot: string;
    resourcesDir: string;
  }): string {
    if (path.basename(installRoot).endsWith(".app")) return "macos-app";
    if (path.basename(resourcesDir).toLowerCase() === "resources") return "electron-resources";
    return "asar-directory";
  }
}

/**
 * 从候选路径中解析 app.asar；每个路径都会先校验 app.asar 是否存在。
 *
 * 支持的输入：
 * 1. 直接指向 app.asar。
 * 2. 指向 macOS 的 Codex.app、Contents 或 Resources。
 * 3. 指向 Windows/Linux Electron 安装根或 resources 目录。
 * 4. 指向自定义目录时，做有限深度扫描，不全盘递归。
 *
 * manifest 里记录的 sourceAsarPath 是快速路径：文件存在就直接使用。
 * 如果记录文件不存在，再走 CodexAsarCandidateProvider 生成的跨平台搜索候选。
 */
class CodexAsarScanner {
  constructor({
    configuredPath = process.env.CODEX_DESKTOP_APP_PATH || "",
    defaultCandidates = null,
    fileSystem = new OfficialBundleFileSystem(),
    candidateProvider = null,
    layoutResolver = null,
  }: {
    configuredPath?: string;
    defaultCandidates?: string[] | null;
    fileSystem?: OfficialBundleFileSystem;
    candidateProvider?: CodexAsarCandidateProvider | null;
    layoutResolver?: CodexInstallLayoutResolver | null;
  } = {}) {
    this.fileSystem = fileSystem;
    this.candidateProvider =
      candidateProvider ||
      new CodexAsarCandidateProvider({
        fileSystem,
        configuredPath,
        defaultCandidates,
      });
    this.layoutResolver = layoutResolver || new CodexInstallLayoutResolver({ fileSystem });
    this.skippedDirectoryNames = new Set(["node_modules", "Cache", "GPUCache", "logs", "tmp", "temp"]);
  }

  find({ cachedAsarPath = "" }: { cachedAsarPath?: string | null } = {}): any {
    const cachedLayout = this.layoutFromCachedAsarPath(cachedAsarPath);
    if (cachedLayout) return cachedLayout;

    const candidates = this.candidateProvider.toList();
    for (const candidate of candidates) {
      const layout = this.layoutFromCandidate(candidate);
      if (layout) return layout;
    }
    throw new Error(
      `未找到 Codex 官方 app.asar。请将 CODEX_DESKTOP_APP_PATH 指向 Codex 安装目录、resources 目录或 app.asar。已尝试：${candidates.join(", ")}`
    );
  }

  private layoutFromCachedAsarPath(cachedAsarPath: string | null | undefined): any | null {
    if (!cachedAsarPath) return null;
    const candidate = this.fileSystem.normalizePath(cachedAsarPath);
    if (!this.fileSystem.isFile(candidate)) return null;
    if (path.basename(candidate) !== ASAR_FILE_NAME) return null;
    return this.layoutResolver.fromAsar(candidate);
  }

  private layoutFromCandidate(candidate: string): any | null {
    if (this.fileSystem.isFile(candidate) && path.basename(candidate) === ASAR_FILE_NAME) {
      return this.layoutResolver.fromAsar(candidate);
    }
    if (!this.fileSystem.isDirectory(candidate)) return null;

    for (const asarPath of this.layoutResolver.knownAsarPaths(candidate)) {
      if (this.fileSystem.isFile(asarPath)) return this.layoutResolver.fromAsar(asarPath);
    }

    const scanned = this.findAsarBelow(candidate, 4);
    return scanned ? this.layoutResolver.fromAsar(scanned) : null;
  }

  private findAsarBelow(rootDir: string, maxDepth: number): string | null {
    const queue = [{ dir: rootDir, depth: 0 }];
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item || item.depth > maxDepth) continue;
      let entries = [];
      try {
        entries = this.fileSystem.readDir(item.dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const fullPath = path.join(item.dir, entry.name);
        if (entry.isFile() && entry.name === ASAR_FILE_NAME) return fullPath;
        if (!entry.isDirectory() || item.depth === maxDepth) continue;
        if (this.skippedDirectoryNames.has(entry.name)) continue;
        queue.push({ dir: fullPath, depth: item.depth + 1 });
      }
    }
    return null;
  }
}

module.exports = {
  CodexAsarScanner,
  CodexAsarCandidateProvider,
  CodexBinaryLocator,
  CodexInstallLayoutResolver,
};
