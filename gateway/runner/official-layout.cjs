const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { RUNNER_EXECUTABLE_NAME } = require("./shared/constants.cjs");
const {
  isFile,
  isDirectory,
  readJsonIfPresent,
  realpathSafe,
  statSummary,
  uniqueNonEmpty,
} = require("./shared/fs-utils.cjs");
const { logJsonLine } = require("./shared/logging.cjs");

function gatewayScannerModulePath() {
  return path.resolve(__dirname, "..", "dist", "official", "CodexAsarScanner.js");
}

function loadGatewayCodexAsarScanner() {
  const scannerModulePath = gatewayScannerModulePath();
  try {
    return require(scannerModulePath);
  } catch (error) {
    /**
     * 官方安装包扫描器属于 gateway 模块。runner 只依赖这一个扫描入口，
     * 避免 desktop / dev runner / 平台适配器各自维护候选路径。
     */
    const message = error instanceof Error ? error.message : String(error || "");
    throw new Error(`无法加载 gateway 官方安装包扫描器：${scannerModulePath}；请先运行 pnpm run build。${message}`);
  }
}

function cachedOfficialAsarPath(officialBundleDir) {
  const manifest = readJsonIfPresent(path.join(officialBundleDir || "", "manifest.json"));
  return manifest && typeof manifest.sourceAsarPath === "string" ? manifest.sourceAsarPath : "";
}

function scanOfficialInstallLayout({ officialBundleDir }) {
  const { CodexAsarScanner } = loadGatewayCodexAsarScanner();
  const scanner = new CodexAsarScanner({
    configuredPath: process.env.CODEX_DESKTOP_APP_PATH || "",
  });
  return scanner.find({ cachedAsarPath: cachedOfficialAsarPath(officialBundleDir) });
}

function decodeXmlText(value) {
  return String(value || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function readBundleExecutable(appRoot) {
  const infoPlistPath = path.join(appRoot, "Contents", "Info.plist");
  try {
    const text = fs.readFileSync(infoPlistPath, "utf8");
    const match = text.match(/<key>\s*CFBundleExecutable\s*<\/key>\s*<string>([^<]+)<\/string>/);
    if (match) return decodeXmlText(match[1]);
  } catch {}
  if (process.platform === "darwin" && isFile("/usr/bin/plutil")) {
    try {
      /**
       * Codex.app / ChatGPT.app 的 Info.plist 可能是二进制 plist。直接读 XML 正则不一定可靠，
       * 这里用系统 plutil 兜底读取 CFBundleExecutable，避免未来官方包结构变化时误判可执行文件路径。
       */
      const output = execFileSync("/usr/bin/plutil", ["-extract", "CFBundleExecutable", "raw", "-o", "-", infoPlistPath], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (output) return output;
    } catch {}
  }
  return path.basename(appRoot, ".app") || RUNNER_EXECUTABLE_NAME;
}

function macRuntimeLayoutFromAppRoot(appRoot, logger = null) {
  const resourcesDir = path.join(appRoot, "Contents", "Resources");
  const frameworksDir = path.join(appRoot, "Contents", "Frameworks");
  const asarPath = path.join(resourcesDir, "app.asar");
  const executablePath = path.join(appRoot, "Contents", "MacOS", readBundleExecutable(appRoot));
  const asar = statSummary(asarPath);
  const frameworks = statSummary(frameworksDir);
  const executable = statSummary(executablePath);
  if (!asar.isFile || !frameworks.isDirectory || !executable.isFile) {
    logJsonLine(logger, "official Electron candidate layout rejected:", {
      appRoot,
      resourcesDir,
      asarPath,
      frameworksDir,
      executablePath,
      asar,
      frameworks,
      executable,
    });
    return null;
  }
  return {
    platform: "darwin",
    appRoot,
    resourcesDir,
    frameworksDir,
    asarPath,
    executablePath,
  };
}

function resourcesDirForPortableAppRoot(appRoot) {
  if (isFile(path.join(appRoot, "resources", "app.asar"))) return path.join(appRoot, "resources");
  if (isFile(path.join(appRoot, "Resources", "app.asar"))) return path.join(appRoot, "Resources");
  if (isFile(path.join(appRoot, "app.asar"))) return appRoot;
  return path.join(appRoot, "resources");
}

function xmlAttribute(tag, attributeName) {
  const escapedName = String(attributeName || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(tag || "").match(new RegExp(`\\b${escapedName}\\s*=\\s*(["'])(.*?)\\1`, "i"));
  return match ? decodeXmlText(match[2]) : "";
}

function appxApplicationDefinitions(manifestText) {
  const definitions = [];
  for (const match of String(manifestText || "").matchAll(/<Application\b[^>]*>/gi)) {
    const id = xmlAttribute(match[0], "Id");
    const executable = xmlAttribute(match[0], "Executable");
    if (executable) definitions.push({ id, executable });
  }
  return definitions;
}

function safeAppxExecutablePath({ packageRoot, executable }) {
  const rawExecutable = String(executable || "").trim();
  if (!rawExecutable || path.win32.isAbsolute(rawExecutable) || path.posix.isAbsolute(rawExecutable)) return "";
  const normalizedParts = rawExecutable.replace(/\\/g, "/").split("/");
  if (normalizedParts.some((part) => !part || part === "." || part === "..")) return "";
  const executablePath = path.resolve(packageRoot, ...normalizedParts);
  const relative = path.relative(path.resolve(packageRoot), executablePath);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return "";
  return executablePath;
}

function windowsManifestExecutablePath(appRoot, logger = null) {
  const manifestPaths = uniqueNonEmpty([
    path.join(appRoot, "AppxManifest.xml"),
    path.join(path.dirname(appRoot), "AppxManifest.xml"),
  ]);
  for (const manifestPath of manifestPaths) {
    if (!isFile(manifestPath)) continue;
    let manifestText = "";
    try {
      manifestText = fs.readFileSync(manifestPath, "utf8");
    } catch (error) {
      logJsonLine(logger, "Windows AppxManifest read failed:", {
        manifestPath,
        error: error instanceof Error ? error.message : String(error || ""),
      });
      continue;
    }
    const packageRoot = path.dirname(manifestPath);
    const definitions = appxApplicationDefinitions(manifestText);
    const appDefinitions = definitions.filter((definition) => definition.id.toLowerCase() === "app");
    // manifest 声明 Id=App 时只信任该桌面入口，避免错误地把 helper application 当成 Electron 主程序。
    const executableDefinitions = appDefinitions.length > 0 ? appDefinitions : definitions;
    for (const definition of executableDefinitions) {
      const executablePath = safeAppxExecutablePath({ packageRoot, executable: definition.executable });
      if (executablePath && isFile(executablePath)) return executablePath;
      logJsonLine(logger, "Windows AppxManifest executable rejected:", {
        manifestPath,
        applicationId: definition.id,
        executable: definition.executable,
        executablePath,
      });
    }
  }
  return "";
}

function windowsElectronExecutableCandidates(appRoot, logger = null) {
  return uniqueNonEmpty([
    process.env.CODEX_DESKTOP_EXECUTABLE_PATH,
    windowsManifestExecutablePath(appRoot, logger),
    // 新版 MSIX 同时保留 Codex.exe 兼容壳，必须在 manifest 失效时优先尝试真正的 ChatGPT Electron 入口。
    path.join(appRoot, "ChatGPT.exe"),
    path.join(appRoot, "chatgpt.exe"),
    path.join(appRoot, "Codex.exe"),
    path.join(appRoot, "codex.exe"),
    path.join(appRoot, "OpenAI Codex.exe"),
    path.join(appRoot, "app", "ChatGPT.exe"),
    path.join(appRoot, "app", "chatgpt.exe"),
    path.join(appRoot, "app", "Codex.exe"),
    path.join(appRoot, "app", "codex.exe"),
    path.join(path.dirname(appRoot), "ChatGPT.exe"),
    path.join(path.dirname(appRoot), "chatgpt.exe"),
    path.join(path.dirname(appRoot), "Codex.exe"),
    path.join(path.dirname(appRoot), "codex.exe"),
  ]);
}

function linuxElectronExecutableCandidates(appRoot) {
  return uniqueNonEmpty([
    process.env.CODEX_DESKTOP_EXECUTABLE_PATH,
    path.join(appRoot, "codex"),
    path.join(appRoot, "Codex"),
    path.join(appRoot, "codex-desktop"),
    // 社区 Linux 包的原始 Electron layout 可能直接保留 electron 文件名。
    path.join(appRoot, "electron"),
    path.join(path.dirname(appRoot), "codex"),
    path.join(path.dirname(appRoot), "Codex"),
    path.join(path.dirname(appRoot), "electron"),
  ]);
}

function portableRuntimeLayoutFromInstallLayout(scannedLayout, logger = null) {
  const appRoot = scannedLayout.installRoot;
  const resourcesDir = scannedLayout.resourcesDir || resourcesDirForPortableAppRoot(appRoot);
  const asarPath = scannedLayout.asarPath || path.join(resourcesDir, "app.asar");
  const executableCandidates =
    process.platform === "win32"
      ? windowsElectronExecutableCandidates(appRoot, logger)
      : linuxElectronExecutableCandidates(appRoot);
  const executablePath = executableCandidates.find(isFile) || "";
  const runtimeRoot = executablePath ? path.dirname(executablePath) : appRoot;
  const asar = statSummary(asarPath);
  const executable = statSummary(executablePath);
  const runtime = statSummary(runtimeRoot);
  if (!asar.isFile || !executable.isFile || !runtime.isDirectory) {
    logJsonLine(logger, "official Electron candidate layout rejected:", {
      platform: process.platform,
      appRoot,
      resourcesDir,
      asarPath,
      executableCandidates,
      executablePath,
      runtimeRoot,
      asar,
      executable,
      runtime,
    });
    return null;
  }
  return {
    platform: process.platform,
    appRoot,
    resourcesDir,
    asarPath,
    executablePath,
    runtimeRoot,
  };
}

function officialRuntimeLayoutFromScannedLayout(scannedLayout, logger = null) {
  if (process.platform === "darwin") return macRuntimeLayoutFromAppRoot(scannedLayout.installRoot, logger);
  if (process.platform === "win32" || process.platform === "linux") {
    return portableRuntimeLayoutFromInstallLayout(scannedLayout, logger);
  }
  return null;
}

function findOfficialRuntimeLayout({ officialBundleDir, logger }) {
  const scannedLayout = scanOfficialInstallLayout({ officialBundleDir });
  logJsonLine(logger, "official Electron install scanned:", {
    installRoot: scannedLayout.installRoot,
    resourcesDir: scannedLayout.resourcesDir,
    asarPath: scannedLayout.asarPath,
    layoutKind: scannedLayout.layoutKind,
    platformHint: scannedLayout.platformHint,
  });
  const layout = officialRuntimeLayoutFromScannedLayout(scannedLayout, logger);
  if (layout) return layout;
  throw new Error(
    `已找到 Codex/ChatGPT Desktop 官方 app.asar，但未找到可复用的官方 Electron 运行时：${JSON.stringify({
      installRoot: scannedLayout.installRoot,
      resourcesDir: scannedLayout.resourcesDir,
      asarPath: scannedLayout.asarPath,
    })}`
  );
}

module.exports = {
  findOfficialRuntimeLayout,
  __test: {
    appxApplicationDefinitions,
    linuxElectronExecutableCandidates,
    macRuntimeLayoutFromAppRoot,
    safeAppxExecutablePath,
    windowsElectronExecutableCandidates,
    windowsManifestExecutablePath,
  },
};
