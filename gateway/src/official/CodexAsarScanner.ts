// @ts-nocheck
export {};

const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");
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
        ...this.windowsAppxInstallCandidates(),
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

  private windowsAppxInstallCandidates(): string[] {
    // Windows Store/MSIX 版 Codex 会装到 WindowsApps，app.asar 在 app/resources 下。
    const installRoots = this.uniqueNonEmpty([
      ...this.windowsAppxInstallLocationsFromCodexLogs(),
      ...this.windowsAppxInstallLocationsFromPowerShell(),
      ...this.windowsAppxInstallLocationsFromWindowsAppsDir(),
    ]);
    return installRoots.flatMap((installRoot) => [
      path.join(installRoot, "app", "resources"),
      path.join(installRoot, "app"),
      path.join(installRoot, "resources"),
      installRoot,
    ]);
  }

  private windowsAppxInstallLocationsFromCodexLogs(): string[] {
    // 某些权限上下文下 Get-AppxPackage 和 WindowsApps 枚举都拿不到路径；Codex 自己的日志会记录真实 executablePath。
    const logFiles = this.windowsCodexLogDirs()
      .flatMap((logDir) => this.findLogFilesBelow(logDir, 4))
      .sort((left, right) => this.fileMtimeMs(right) - this.fileMtimeMs(left))
      .slice(0, 30);
    const installRoots = [];
    for (const logFile of logFiles) {
      let text = "";
      try {
        text =
          typeof this.fileSystem.readTextPrefix === "function"
            ? this.fileSystem.readTextPrefix(logFile, 256 * 1024)
            : this.fileSystem.readText(logFile).slice(0, 256 * 1024);
      } catch {
        continue;
      }
      installRoots.push(...this.parseWindowsAppxInstallLocations(text));
    }
    return this.sortWindowsAppxInstallLocations(this.uniqueNonEmpty(installRoots));
  }

  private windowsCodexLogDirs(): string[] {
    return this.windowsCodexPackageDataRoots().flatMap((packageRoot) => [
      path.join(packageRoot, "LocalCache", "Local", "Codex", "Logs"),
      path.join(packageRoot, "LocalCache", "Roaming", "Codex", "Logs"),
    ]);
  }

  private windowsCodexPackageDataRoots(): string[] {
    return this.uniqueNonEmpty([
      this.env.LOCALAPPDATA && path.join(this.env.LOCALAPPDATA, "Packages", "OpenAI.Codex_2p2nqsd0c76g0"),
      path.join(this.homeDir, "AppData", "Local", "Packages", "OpenAI.Codex_2p2nqsd0c76g0"),
    ]);
  }

  private findLogFilesBelow(rootDir: string, maxDepth: number): string[] {
    const result = [];
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
        if (entry.isFile() && entry.name.toLowerCase().endsWith(".log")) {
          result.push(fullPath);
        } else if (entry.isDirectory() && item.depth < maxDepth) {
          queue.push({ dir: fullPath, depth: item.depth + 1 });
        }
      }
    }
    return result;
  }

  private parseWindowsAppxInstallLocations(text: string): string[] {
    // 日志里常见 JSON 转义的反斜杠，先还原再提取 MSIX 安装根。
    const normalized = String(text || "").replace(/\\\\/g, "\\");
    const pattern =
      /([A-Z]:\\(?:[^\\\r\n"]+\\)*WindowsApps\\OpenAI\.Codex_[^\\\r\n"]+)\\app\\resources\\(?:app\.asar|codex\.exe)/gi;
    const result = [];
    for (const match of normalized.matchAll(pattern)) {
      result.push(match[1]);
    }
    return result;
  }

  private windowsAppxInstallLocationsFromPowerShell(): string[] {
    // 优先问系统包管理器；失败时静默降级，避免影响 macOS/Linux 或非 Store 安装。
    const command =
      "$ErrorActionPreference = 'SilentlyContinue'; " +
      "Get-AppxPackage -Name OpenAI.Codex | Sort-Object Version -Descending | ForEach-Object { $_.InstallLocation }";
    for (const executable of ["powershell.exe", "pwsh.exe"]) {
      try {
        const output = execFileSync(executable, ["-NoProfile", "-NonInteractive", "-Command", command], {
          encoding: "utf-8",
          maxBuffer: 1024 * 1024,
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 5000,
          windowsHide: true,
        });
        const locations = this.lines(output);
        if (locations.length > 0) return locations;
      } catch {}
    }
    return [];
  }

  private windowsAppxInstallLocationsFromWindowsAppsDir(): string[] {
    // PowerShell 不可用时尝试直接枚举 WindowsApps；无权限访问时继续走其它候选。
    const roots = this.uniqueNonEmpty([
      this.env.PROGRAMFILES && path.join(this.env.PROGRAMFILES, "WindowsApps"),
      this.env.ProgramW6432 && path.join(this.env.ProgramW6432, "WindowsApps"),
    ]);
    const packageDirs = [];
    for (const root of roots) {
      let entries = [];
      try {
        entries = this.fileSystem.readDir(root, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (!/^OpenAI\.Codex_/i.test(entry.name)) continue;
        packageDirs.push(path.join(root, entry.name));
      }
    }
    return this.sortWindowsAppxInstallLocations(packageDirs);
  }

  private sortWindowsAppxInstallLocations(locations: string[]): string[] {
    return locations.slice().sort((left, right) => {
      const versionCompare = this.compareVersionParts(
        this.windowsAppxVersionParts(path.basename(right)),
        this.windowsAppxVersionParts(path.basename(left))
      );
      return versionCompare || right.localeCompare(left);
    });
  }

  private fileMtimeMs(filePath: string): number {
    try {
      return Number(this.fileSystem.stat(filePath).mtimeMs) || 0;
    } catch {
      return 0;
    }
  }

  private windowsAppxVersionParts(packageDirName: string): number[] {
    const match = packageDirName.match(/^OpenAI\.Codex_([^_]+)/i);
    return match ? match[1].split(".").map((part) => Number(part) || 0) : [];
  }

  private compareVersionParts(left: number[], right: number[]): number {
    const length = Math.max(left.length, right.length);
    for (let index = 0; index < length; index += 1) {
      const diff = (left[index] || 0) - (right[index] || 0);
      if (diff) return diff;
    }
    return 0;
  }

  private lines(output: string): string[] {
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
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
    env = process.env,
    homeDir = os.homedir(),
  }: {
    fileSystem: OfficialBundleFileSystem;
    platform?: string;
    env?: Record<string, string | undefined>;
    homeDir?: string;
  }) {
    this.fileSystem = fileSystem;
    this.platform = platform;
    this.env = env;
    this.homeDir = homeDir;
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
        this.env.CODEX_APP_SERVER_BINARY_PATH,
        this.env.CODEX_CLI_PATH,
        // app-server 优先使用用户目录里的 CLI 运行时；Store 包 resources 下的 codex.exe 在独立启动时可能直接退出。
        ...this.windowsCliCandidates(),
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

  private windowsCliCandidates(): string[] {
    const binRoots = this.uniqueNonEmpty([
      this.env.LOCALAPPDATA && path.join(this.env.LOCALAPPDATA, "OpenAI", "Codex", "bin"),
      path.join(this.homeDir, "AppData", "Local", "OpenAI", "Codex", "bin"),
    ]);
    const candidates = [];
    for (const binRoot of binRoots) {
      candidates.push(path.join(binRoot, "codex.exe"));
      candidates.push(...this.versionedWindowsCliCandidates(binRoot));
    }
    return this.uniqueNonEmpty(candidates);
  }

  private versionedWindowsCliCandidates(binRoot: string): string[] {
    let entries = [];
    try {
      entries = this.fileSystem.readDir(binRoot, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(binRoot, entry.name, "codex.exe"))
      .filter((candidate) => this.fileSystem.isFile(candidate))
      .sort((left, right) => this.fileMtimeMs(right) - this.fileMtimeMs(left));
  }

  private fileMtimeMs(filePath: string): number {
    try {
      return Number(this.fileSystem.stat(filePath).mtimeMs) || 0;
    } catch {
      return 0;
    }
  }

  private uniqueNonEmpty(values: Array<string | null | undefined>): string[] {
    return Array.from(new Set(values.filter((value) => typeof value === "string" && value.trim()).map(String)));
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
