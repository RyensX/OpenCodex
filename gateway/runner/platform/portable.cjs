const fs = require("fs");
const path = require("path");
const {
  RUNNER_LINUX_EXECUTABLE_NAME,
  RUNNER_WINDOWS_EXECUTABLE_NAME,
} = require("../shared/constants.cjs");
const {
  fileFingerprint,
  isDirectory,
  isFile,
  realpathSafe,
  readJsonIfPresent,
  writeJson,
} = require("../shared/fs-utils.cjs");
const { logLine } = require("../shared/logging.cjs");
const { writeGatewayAsar } = require("../shared/runner-asar.cjs");
const { patchWindowsRunnerAsarIntegrity } = require("./windows-integrity.cjs");
const { runner: runnerPoints } = require("../../runtime/modification/point-refs.cjs");

const WINDOWS_READ_WRITE_COPY_BUFFER_SIZE = 8 * 1024 * 1024;

function runnerExecutableNameForPlatform() {
  if (process.platform === "win32") return RUNNER_WINDOWS_EXECUTABLE_NAME;
  if (process.platform === "linux") return RUNNER_LINUX_EXECUTABLE_NAME;
  throw new Error(`portable runner 不支持平台：${process.platform}`);
}

function shouldSkipPortableRuntimeEntry(entry, sourcePath, layout) {
  const name = entry.name.toLowerCase();
  const sourceRealPath = realpathSafe(sourcePath);
  const runtimeRootRealPath = realpathSafe(layout.runtimeRoot);
  const appRootRealPath = realpathSafe(layout.appRoot);
  const asarRealPath = realpathSafe(layout.asarPath);
  // runner 自己生成 resources/app.asar；不能把官方 app.asar 或 app.asar.unpacked 复制进 OpenCodex runtime。
  if (entry.isDirectory() && name === "resources") return true;
  if (sourceRealPath === asarRealPath || sourcePath === `${layout.asarPath}.unpacked`) return true;
  if (sourceRealPath === realpathSafe(`${layout.asarPath}.unpacked`)) return true;
  // MSIX 可能是“包根目录放 exe，app/resources 放官方 bundle”；复制运行时时要避开这个 app 子目录。
  if (entry.isDirectory() && runtimeRootRealPath !== appRootRealPath && sourceRealPath === appRootRealPath) return true;
  if (sourceRealPath === realpathSafe(layout.executablePath)) return true;
  return false;
}

function portableRuntimeFingerprint(layout) {
  const entries = [];
  try {
    for (const entry of fs.readdirSync(layout.runtimeRoot, { withFileTypes: true })) {
      const sourcePath = path.join(layout.runtimeRoot, entry.name);
      if (shouldSkipPortableRuntimeEntry(entry, sourcePath, layout)) continue;
      entries.push({
        name: entry.name,
        kind: entry.isDirectory() ? "dir" : entry.isFile() ? "file" : entry.isSymbolicLink() ? "symlink" : "other",
        stat: fileFingerprint(sourcePath),
      });
    }
  } catch {}
  return {
    platform: process.platform,
    arch: process.arch,
    source: realpathSafe(layout.runtimeRoot),
    appRoot: realpathSafe(layout.appRoot),
    executable: fileFingerprint(layout.executablePath),
    asar: fileFingerprint(layout.asarPath),
    entries,
  };
}

function samePortableRuntimeFingerprint(left, right) {
  return JSON.stringify(left || null) === JSON.stringify(right || null);
}

function copyFileByReadWriteSync(sourcePath, targetPath) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const buffer = Buffer.allocUnsafe(WINDOWS_READ_WRITE_COPY_BUFFER_SIZE);
  let sourceFd = null;
  let targetFd = null;

  try {
    sourceFd = fs.openSync(sourcePath, "r");
    targetFd = fs.openSync(targetPath, "w");

    for (;;) {
      const bytesRead = fs.readSync(sourceFd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;

      let offset = 0;
      while (offset < bytesRead) {
        offset += fs.writeSync(targetFd, buffer, offset, bytesRead - offset);
      }
    }
  } finally {
    if (targetFd !== null) fs.closeSync(targetFd);
    if (sourceFd !== null) fs.closeSync(sourceFd);
  }

  try {
    const stat = fs.statSync(sourcePath);
    fs.chmodSync(targetPath, stat.mode);
    fs.utimesSync(targetPath, stat.atime, stat.mtime);
  } catch {}
}

function tryCopyWindowsFileByReadWrite({
  sourcePath,
  targetPath,
  name,
  logger,
  error,
  platform = process.platform,
  logFallback = true,
}) {
  if (platform !== "win32") return false;

  try {
    if (!fs.statSync(sourcePath).isFile()) return false;
  } catch {
    return false;
  }

  /**
   * WindowsApps/MSIX 文件可能可读却无法通过 CopyFile 复制；分块读写避免一次性加载大型 DLL。
   * 该兜底只处理 runner 工作副本，不改变官方 resources 仍是唯一数据源的语义。
   */
  copyFileByReadWriteSync(sourcePath, targetPath);
  if (logFallback) {
    const reason = error && error.code ? error.code : error instanceof Error ? error.message : String(error || "");
    logLine(logger, `official Electron runtime copied Windows file via read/write fallback: ${name || path.basename(sourcePath)} (${reason})`);
  }
  return true;
}

function recoverPortableRuntimeFileCopy({
  entry,
  sourcePath,
  targetPath,
  logger,
  error,
  platform = process.platform,
  logFallback = true,
}) {
  if (tryCopyWindowsFileByReadWrite({ sourcePath, targetPath, name: entry.name, logger, error, platform, logFallback })) {
    return { copied: true, synthesized: false };
  }
  return null;
}

function copyPortableRuntimeFile({ entry, sourcePath, targetPath, logger, platform = process.platform, logFallback = true }) {
  try {
    fs.copyFileSync(sourcePath, targetPath);
    return { copied: true, synthesized: false };
  } catch (error) {
    const recovered = recoverPortableRuntimeFileCopy({ entry, sourcePath, targetPath, logger, error, platform, logFallback });
    if (recovered) return recovered;
    throw error;
  }
}

function copyPortableRuntimeDirectoryByReadWrite({
  sourcePath,
  targetPath,
  logger,
  error,
  platform = process.platform,
  logDirectory = true,
}) {
  if (platform !== "win32") return false;

  try {
    if (!fs.statSync(sourcePath).isDirectory()) return false;
  } catch {
    return false;
  }

  // 目标目录可能已被原生复制部分写入；逐项覆盖并保留来源中不存在的已有文件。
  fs.mkdirSync(targetPath, { recursive: true });
  for (const child of fs.readdirSync(sourcePath, { withFileTypes: true })) {
    const childSourcePath = path.join(sourcePath, child.name);
    const childTargetPath = path.join(targetPath, child.name);

    if (child.isDirectory()) {
      copyPortableRuntimeDirectoryByReadWrite({
        sourcePath: childSourcePath,
        targetPath: childTargetPath,
        logger,
        error,
        platform,
        logDirectory: false,
      });
    } else if (child.isFile()) {
      copyPortableRuntimeFile({
        entry: child,
        sourcePath: childSourcePath,
        targetPath: childTargetPath,
        logger,
        platform,
        logFallback: false,
      });
    } else {
      fs.cpSync(childSourcePath, childTargetPath, {
        recursive: true,
        force: true,
        verbatimSymlinks: true,
      });
    }
  }

  if (logDirectory) {
    const reason = error && error.code ? error.code : error instanceof Error ? error.message : String(error || "");
    logLine(logger, `official Electron runtime copied Windows directory via read/write fallback: ${path.basename(sourcePath)} (${reason})`);
  }
  return true;
}

function copyPortableRuntimeEntry({ entry, sourcePath, targetPath, logger, platform = process.platform }) {
  try {
    fs.cpSync(sourcePath, targetPath, {
      recursive: true,
      force: true,
      verbatimSymlinks: true,
    });
    return { copied: true, synthesized: false };
  } catch (error) {
    if (entry.isFile()) {
      const recovered = recoverPortableRuntimeFileCopy({ entry, sourcePath, targetPath, logger, error, platform });
      if (recovered) return recovered;
    }
    if (
      typeof entry.isDirectory === "function" &&
      entry.isDirectory() &&
      copyPortableRuntimeDirectoryByReadWrite({ sourcePath, targetPath, logger, error, platform })
    ) {
      return { copied: true, synthesized: false };
    }
    throw error;
  }
}

function copyPortableRuntimeExecutable({ sourcePath, targetPath, logger, platform = process.platform }) {
  copyPortableRuntimeFile({
    entry: {
      name: path.basename(sourcePath),
      isFile: () => true,
    },
    sourcePath,
    targetPath,
    logger,
    platform,
  });
}

function ensurePortableRuntimeCopy({ layout, runnerRootDir, runnerExecutablePath, markerPath, logger }) {
  const nextFingerprint = portableRuntimeFingerprint(layout);
  const previous = readJsonIfPresent(markerPath);
  if (
    previous &&
    samePortableRuntimeFingerprint(previous.fingerprint, nextFingerprint) &&
    isDirectory(runnerRootDir) &&
    isFile(runnerExecutablePath)
  ) {
    logLine(logger, `official Electron runtime cache hit: ${runnerRootDir}`);
    return { copied: false };
  }

  /**
   * Windows/Linux 没有 macOS bundle 的 Frameworks 分层，Electron DLL/.pak/locales 等都在可执行文件同级目录。
   * 这里复制“运行时文件”，但跳过官方 resources 目录；官方 bundle 只作为外部资源路径复用，不进入 OpenCodex dist/cache。
   */
  fs.rmSync(runnerRootDir, { recursive: true, force: true });
  fs.mkdirSync(runnerRootDir, { recursive: true });
  for (const entry of fs.readdirSync(layout.runtimeRoot, { withFileTypes: true })) {
    const sourcePath = path.join(layout.runtimeRoot, entry.name);
    if (shouldSkipPortableRuntimeEntry(entry, sourcePath, layout)) continue;
    copyPortableRuntimeEntry({ entry, sourcePath, targetPath: path.join(runnerRootDir, entry.name), logger });
  }
  copyPortableRuntimeExecutable({ sourcePath: layout.executablePath, targetPath: runnerExecutablePath, logger });
  if (process.platform !== "win32") fs.chmodSync(runnerExecutablePath, 0o755);
  writeJson(markerPath, {
    fingerprint: nextFingerprint,
    copiedAt: new Date().toISOString(),
  });
  logLine(logger, `official Electron runtime copied: ${layout.runtimeRoot} -> ${runnerRootDir}`);
  return { copied: true };
}

async function createPortableRunner({ layout, runtimeDir, logger, runCompatibility = (_point, operation) => operation() }) {
  const workDir = path.join(runtimeDir, "official-electron-runner");
  const runnerRootDir = path.join(workDir, `${process.platform}-${process.arch}`);
  const runnerResourcesDir = path.join(runnerRootDir, "resources");
  const runnerExecutablePath = path.join(runnerRootDir, runnerExecutableNameForPlatform());
  const markerPath = path.join(workDir, `runtime-manifest-${process.platform}-${process.arch}.json`);

  runCompatibility(
    runnerPoints.portableLayout,
    () => ensurePortableRuntimeCopy({ layout, runnerRootDir, runnerExecutablePath, markerPath, logger })
  );
  // app.asar 是 OpenCodex gateway 壳，必须每次按当前代码路径重写；官方资源目录只通过 env/process.resourcesPath 指回原安装包。
  fs.rmSync(runnerResourcesDir, { recursive: true, force: true });
  fs.mkdirSync(runnerResourcesDir, { recursive: true });
  const runnerAsarPath = await runCompatibility(
    runnerPoints.gatewayAsar,
    () => writeGatewayAsar({ runnerResourcesDir, workDir })
  );
  if (process.platform === "win32") {
    runCompatibility(
      runnerPoints.windowsAsarIntegrity,
      () => patchWindowsRunnerAsarIntegrity({
        runnerRootDir,
        runnerExecutablePath,
        sourceExecutablePath: layout.executablePath,
        runnerAsarPath,
        logger,
      })
    );
  }

  logLine(logger, `prepared official Electron runner: root=${runnerRootDir}`);
  logLine(logger, `official Electron source: app=${layout.appRoot} asar=${layout.asarPath}`);

  return {
    compatibilityPoints: [
      runnerPoints.portableLayout.id,
      runnerPoints.gatewayAsar.id,
      ...(process.platform === "win32" ? [runnerPoints.windowsAsarIntegrity.id] : []),
    ],
    executablePath: runnerExecutablePath,
    runnerAppPath: runnerRootDir,
    officialAppPath: layout.appRoot,
    officialAsarPath: layout.asarPath,
  };
}

module.exports = {
  createPortableRunner,
  __test: {
    copyPortableRuntimeEntry,
    copyPortableRuntimeExecutable,
  },
};
