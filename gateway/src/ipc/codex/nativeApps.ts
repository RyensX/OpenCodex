// @ts-nocheck
export {};

const path = require("path");
const { execFileSync } = require("child_process");

const NATIVE_APP_BY_BUNDLE_ID_CACHE = new Map();

/** 从 .app 路径中提取应用显示名。 */
function normalizeNativeAppDisplayName(appPath) {
  const baseName = path.basename(appPath || "", ".app");
  return baseName || null;
}

/** macOS 下通过 bundle id 查找本机 .app 路径，并做内存缓存。 */
function findNativeAppBundlePath(bundleId) {
  if (typeof bundleId !== "string" || !bundleId.trim() || process.platform !== "darwin") return null;
  const normalizedBundleId = bundleId.trim();
  if (NATIVE_APP_BY_BUNDLE_ID_CACHE.has(normalizedBundleId)) {
    return NATIVE_APP_BY_BUNDLE_ID_CACHE.get(normalizedBundleId);
  }
  let appPath = null;
  try {
    const query = `kMDItemCFBundleIdentifier == '${normalizedBundleId.replaceAll("'", "\\'")}'`;
    const output = execFileSync("mdfind", [query], {
      encoding: "utf8",
      timeout: 1500,
      stdio: ["ignore", "pipe", "ignore"],
    });
    appPath =
      output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.endsWith(".app")) || null;
  } catch {}
  NATIVE_APP_BY_BUNDLE_ID_CACHE.set(normalizedBundleId, appPath);
  return appPath;
}

/** native-desktop-app-by-bundle-id IPC 的本地实现。 */
function nativeDesktopAppByBundleId(payload) {
  const params = payload && typeof payload === "object" && payload.params ? payload.params : payload;
  const bundleId = params && typeof params === "object" ? params.bundleId : null;
  const appPath = findNativeAppBundlePath(bundleId);
  if (!appPath) return { app: null };
  const displayName = normalizeNativeAppDisplayName(appPath);
  return {
    app: {
      bundleId: bundleId.trim(),
      displayName,
      name: displayName,
      path: appPath,
      appPath,
      logoUrl: null,
      logoUrlDark: null,
    },
  };
}

/** native app icon 暂不抽取真实图标，返回 renderer 可接受的空结构。 */
function nativeDesktopAppIcon(payload) {
  const params = payload && typeof payload === "object" && payload.params ? payload.params : payload;
  const appPath = params && typeof params === "object" && typeof params.appPath === "string" ? params.appPath : null;
  const normalizedPath = appPath && appPath.endsWith(".app") ? appPath : null;
  return {
    appPath: normalizedPath,
    icon: "",
    iconSmall: "",
    iconLarge: "",
    logoUrl: null,
    logoUrlDark: null,
  };
}

module.exports = {
  nativeDesktopAppByBundleId,
  nativeDesktopAppIcon,
};
