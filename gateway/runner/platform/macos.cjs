const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const asar = require("@electron/asar");
const { execFileSync } = require("child_process");
const {
  RUNNER_APP_NAME,
  RUNNER_BUNDLE_IDENTIFIER,
  RUNNER_EXECUTABLE_NAME,
} = require("../shared/constants.cjs");
const {
  fileFingerprint,
  isDirectory,
  realpathSafe,
  readJsonIfPresent,
  withPhysicalAsarAccess,
  writeJson,
} = require("../shared/fs-utils.cjs");
const { logLine } = require("../shared/logging.cjs");
const { writeGatewayAsar } = require("../shared/runner-asar.cjs");
const { runner: runnerPoints } = require("../../runtime/modification/point-refs.cjs");

const INTEGRITY_DIGEST_SENTINEL = Buffer.from("AGbevlPCksUGKNL8TSn7wGmJEuJsXb2A");

function escapePlistString(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function runnerInfoPlist(runnerAsarPath) {
  // 新版官方 Electron 会校验 ASAR header；必须读取本次生成的 runner，不能沿用官方包或旧缓存的哈希。
  const header = withPhysicalAsarAccess(() => asar.getRawHeader(runnerAsarPath).headerString);
  const headerHash = crypto.createHash("sha256").update(header).digest("hex");
  /**
   * runner 是后台 gateway 进程，不应该在 Dock 里出现第二个图标。
   * LSUIElement 会让当前官方 Electron runtime 在 ChromeMain 阶段 SIGTRAP；
   * LSBackgroundOnly 可以让进程成为真正的后台进程，同时仍能创建隐藏 webContents 承接官方 IPC。
   */
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>${escapePlistString(RUNNER_EXECUTABLE_NAME)}</string>
  <key>CFBundleIdentifier</key>
  <string>${escapePlistString(RUNNER_BUNDLE_IDENTIFIER)}</string>
  <key>CFBundleName</key>
  <string>OpenCodex Gateway</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>LSMinimumSystemVersion</key>
  <string>12.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSPrincipalClass</key>
  <string>AtomApplication</string>
  <key>LSBackgroundOnly</key>
  <true/>
  <key>ElectronAsarIntegrity</key>
  <dict>
    <key>Resources/app.asar</key>
    <dict>
      <key>algorithm</key>
      <string>SHA256</string>
      <key>hash</key>
      <string>${headerHash}</string>
    </dict>
  </dict>
</dict>
</plist>
`;
}

function officialFrameworksFingerprint(layout) {
  const entries = [];
  try {
    for (const entry of fs.readdirSync(layout.frameworksDir, { withFileTypes: true })) {
      entries.push({
        name: entry.name,
        kind: entry.isDirectory() ? "dir" : entry.isFile() ? "file" : entry.isSymbolicLink() ? "symlink" : "other",
        stat: fileFingerprint(path.join(layout.frameworksDir, entry.name)),
      });
    }
  } catch {}
  return {
    source: realpathSafe(layout.frameworksDir),
    appRoot: realpathSafe(layout.appRoot),
    executable: fileFingerprint(layout.executablePath),
    asar: fileFingerprint(layout.asarPath),
    entries,
  };
}

function sameFrameworksFingerprint(left, right) {
  return JSON.stringify(left || null) === JSON.stringify(right || null);
}

function hasExternalSymlinks(dirPath, rootDir = dirPath) {
  try {
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isSymbolicLink()) {
        const target = fs.readlinkSync(fullPath);
        if (path.isAbsolute(target) && !target.startsWith(rootDir)) {
          return true;
        }
      } else if (entry.isDirectory()) {
        if (hasExternalSymlinks(fullPath, rootDir)) return true;
      }
    }
  } catch {}
  return false;
}

function patchFrameworkBinaryIntegrity(binaryPath, frameworkDir, logger) {
  try {
    const data = fs.readFileSync(binaryPath);
    let patched = false;
    let index = data.indexOf(INTEGRITY_DIGEST_SENTINEL);
    while (index !== -1) {
      const usedOffset = index + INTEGRITY_DIGEST_SENTINEL.length;
      if (usedOffset < data.length && data[usedOffset] !== 0) {
        data[usedOffset] = 0;
        data[usedOffset + 1] = 0;
        patched = true;
      }
      index = data.indexOf(INTEGRITY_DIGEST_SENTINEL, index + 1);
    }
    if (patched) {
      fs.writeFileSync(binaryPath, data);
      logLine(logger, `patched macOS ElectronAsar integrity digest sentinel: ${binaryPath}`);
      /**
       * 修改二进制后原签名会失效；必须对 Framework 进行 deep 签名，
       * 以便同步重签 Helpers/ 目录下的辅助进程 bundle（如 Renderer），
       * 保证 helper 与 framework 均为 ad-hoc 签名，避免因 Team ID 不一致被 macOS 拦截。
       */
      try {
        execFileSync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", frameworkDir], {
          stdio: ["ignore", "ignore", "pipe"],
        });
      } catch {
        execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", binaryPath], {
          stdio: ["ignore", "ignore", "pipe"],
        });
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || "");
    logLine(logger, `[warning] failed to patch framework integrity: ${binaryPath}: ${message}`);
  }
}

function patchRunnerFrameworksIntegrity({ runnerFrameworksDir, logger }) {
  if (!isDirectory(runnerFrameworksDir)) return;
  try {
    for (const entry of fs.readdirSync(runnerFrameworksDir, { withFileTypes: true })) {
      if (!entry.name.endsWith(".framework")) continue;
      const frameworkDir = path.join(runnerFrameworksDir, entry.name);
      const frameworkName = path.basename(entry.name, ".framework");
      const versionsDir = path.join(frameworkDir, "Versions");
      if (isDirectory(versionsDir)) {
        for (const vEntry of fs.readdirSync(versionsDir, { withFileTypes: true })) {
          if (vEntry.isSymbolicLink()) continue;
          const candidateBinary = path.join(versionsDir, vEntry.name, frameworkName);
          if (fs.existsSync(candidateBinary)) {
            patchFrameworkBinaryIntegrity(candidateBinary, frameworkDir, logger);
          }
        }
      } else {
        const candidateBinary = path.join(frameworkDir, frameworkName);
        if (fs.existsSync(candidateBinary)) {
          patchFrameworkBinaryIntegrity(candidateBinary, frameworkDir, logger);
        }
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || "");
    logLine(logger, `[warning] patchRunnerFrameworksIntegrity error: ${message}`);
  }
}

function ensureFrameworksCopy({ layout, runnerFrameworksDir, markerPath, logger }) {
  const nextFingerprint = officialFrameworksFingerprint(layout);
  const previous = readJsonIfPresent(markerPath);
  if (
    previous &&
    sameFrameworksFingerprint(previous.fingerprint, nextFingerprint) &&
    isDirectory(runnerFrameworksDir) &&
    !hasExternalSymlinks(runnerFrameworksDir, runnerFrameworksDir)
  ) {
    logLine(logger, `official Electron Frameworks cache hit: ${runnerFrameworksDir}`);
    patchRunnerFrameworksIntegrity({ runnerFrameworksDir, logger });
    return { copied: false };
  }

  /**
   * 不能把 Contents/Frameworks 做成指向 /Applications 的符号链接：官方 helper 进程会按 runner
   * 内部路径回溯加载 framework，macOS sandbox 会拒绝跨 bundle symlink。这里复制到运行态 cache。
   *
   * Node.js fs.cpSync 默认会将相对符号链接解析并转为指向原目录的绝对链接；必须启用
   * verbatimSymlinks 以保持相对符号链接，确保 runner 加载的是独立副本。
   */
  fs.rmSync(runnerFrameworksDir, { recursive: true, force: true });
  fs.cpSync(layout.frameworksDir, runnerFrameworksDir, {
    recursive: true,
    force: true,
    verbatimSymlinks: true,
  });
  patchRunnerFrameworksIntegrity({ runnerFrameworksDir, logger });
  writeJson(markerPath, {
    fingerprint: nextFingerprint,
    copiedAt: new Date().toISOString(),
  });
  logLine(logger, `official Electron Frameworks copied: ${layout.frameworksDir} -> ${runnerFrameworksDir}`);
  return { copied: true };
}

function signRunnerExecutable(executablePath) {
  /**
   * 官方主二进制复制到 runner 后原签名会失效；只重签这个入口壳。
   * Frameworks 保留官方签名副本，避免 deep 签名破坏 Chromium framework 的封装结构。
   */
  execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", executablePath], {
    stdio: ["ignore", "ignore", "pipe"],
  });
}

async function createMacRunner({ layout, runtimeDir, logger, runCompatibility = (_point, operation) => operation() }) {
  const workDir = path.join(runtimeDir, "official-electron-runner");
  const runnerAppPath = path.join(workDir, RUNNER_APP_NAME);
  const contentsDir = path.join(runnerAppPath, "Contents");
  const runnerMacosDir = path.join(contentsDir, "MacOS");
  const runnerResourcesDir = path.join(contentsDir, "Resources");
  const runnerFrameworksDir = path.join(contentsDir, "Frameworks");
  const frameworksMarkerPath = path.join(workDir, "frameworks-manifest.json");
  const runnerExecutablePath = path.join(runnerMacosDir, RUNNER_EXECUTABLE_NAME);

  // 官方升级后 framework/ABI 可能变化，Frameworks 由 fingerprint 控制；入口和 app.asar 每次重写。
  fs.rmSync(runnerMacosDir, { recursive: true, force: true });
  fs.rmSync(runnerResourcesDir, { recursive: true, force: true });
  fs.mkdirSync(runnerMacosDir, { recursive: true });
  fs.mkdirSync(runnerResourcesDir, { recursive: true });

  fs.copyFileSync(layout.executablePath, runnerExecutablePath);
  fs.chmodSync(runnerExecutablePath, 0o755);
  ensureFrameworksCopy({ layout, runnerFrameworksDir, markerPath: frameworksMarkerPath, logger });
  // ASAR 完成后才能生成包含最终哈希的 plist；签名必须放在这两步之后。
  const runnerAsarPath = await runCompatibility(
    runnerPoints.gatewayAsar,
    () => writeGatewayAsar({ runnerResourcesDir, workDir })
  );
  runCompatibility(
    runnerPoints.macosBackgroundBundle,
    () => {
      fs.writeFileSync(path.join(contentsDir, "Info.plist"), runnerInfoPlist(runnerAsarPath), "utf8");
      fs.writeFileSync(path.join(contentsDir, "PkgInfo"), "APPL????", "utf8");
    }
  );
  runCompatibility(
    runnerPoints.macosEntrySignature,
    () => signRunnerExecutable(runnerExecutablePath)
  );

  logLine(logger, `prepared official Electron runner: app=${runnerAppPath}`);
  logLine(logger, `official Electron source: app=${layout.appRoot} asar=${layout.asarPath}`);

  return {
    compatibilityPoints: [
      runnerPoints.macosBackgroundBundle.id,
      runnerPoints.macosEntrySignature.id,
      runnerPoints.gatewayAsar.id,
    ],
    executablePath: runnerExecutablePath,
    runnerAppPath,
    officialAppPath: layout.appRoot,
    officialAsarPath: layout.asarPath,
  };
}

module.exports = {
  createMacRunner,
  __test: {
    hasExternalSymlinks,
    patchRunnerFrameworksIntegrity,
    INTEGRITY_DIGEST_SENTINEL,
  },
};
