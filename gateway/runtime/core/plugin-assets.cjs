const fs = require("fs");
const path = require("path");
const { WEB_SHELL_DIR, exists, isWithinRoot, readText } = require("./config.cjs");
const { DEFAULT_LOCALE, EN_US, ZH_CN, normalizeLocale } = require("../../../shared/i18n/index.cjs");
const { pluginManifestFile, readPluginManifest } = require("../plugins/manifest.cjs");

const EXTERNAL_PLUGIN_DIRS_ENV = "OPENCODEX_PLUGIN_DIRS";
const OPENCODEX_PLUGIN_URL_PREFIX = "/opencodex-plugins/";
const WEB_SHELL_PLUGINS_DIR = path.join(WEB_SHELL_DIR, "plugins");
const LEGACY_PLUGIN_ENTRY_FILE = "index.js";
const SERVED_PLUGIN_ENTRY_FILE = "entry.mjs";
const PLUGIN_SDK_VERSION = "2.0.0";
const PLUGIN_I18N_FILES = {
  [ZH_CN]: "i18.zh.json",
  [EN_US]: "i18.en.json",
};
const SAFE_PLUGIN_DIR_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SAFE_PLUGIN_SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const warnedExternalPluginRoots = new Set();
const warnedPluginDiagnostics = new Set();

function isSafePluginDirName(name) {
  return SAFE_PLUGIN_DIR_NAME.test(String(name || ""));
}

function isSafePluginSourceId(sourceId) {
  return SAFE_PLUGIN_SOURCE_ID.test(String(sourceId || ""));
}

function realpathSafe(filePath) {
  try {
    return fs.realpathSync.native ? fs.realpathSync.native(filePath) : fs.realpathSync(filePath);
  } catch {
    return null;
  }
}

function warnExternalPluginRootOnce(reason, rootDir) {
  const key = `${reason}:${rootDir}`;
  if (warnedExternalPluginRoots.has(key)) return;
  warnedExternalPluginRoots.add(key);
  console.warn(`[gateway] external plugin directory skipped: ${reason}`, rootDir);
}

function warnPluginOnce(key, message) {
  if (warnedPluginDiagnostics.has(key)) return;
  warnedPluginDiagnostics.add(key);
  console.warn(message);
}

function splitExternalPluginDirs(raw, structured = false) {
  if (Array.isArray(raw)) return raw.flatMap((item) => splitExternalPluginDirs(item, true));
  if (raw == null) return [];
  const text = String(raw).trim();
  if (!text) return [];
  if (structured) return [text];
  try {
    const parsed = JSON.parse(text);
    // 支持 JSON 数组，避免路径里包含分隔符时无法表达。
    if (Array.isArray(parsed)) return splitExternalPluginDirs(parsed, true);
    if (typeof parsed === "string") return splitExternalPluginDirs(parsed, true);
  } catch {}
  return text
    .split(path.delimiter)
    .flatMap((part) => part.split(","))
    .map((part) => part.trim())
    .filter(Boolean);
}

function externalPluginRootDirsFromEnv(env = process.env) {
  const seen = new Set();
  const result = [];
  for (const candidate of splitExternalPluginDirs(env && env[EXTERNAL_PLUGIN_DIRS_ENV])) {
    const rootDir = path.resolve(candidate);
    const realRoot = realpathSafe(rootDir);
    if (!realRoot) {
      warnExternalPluginRootOnce("not found", rootDir);
      continue;
    }
    try {
      if (!fs.statSync(realRoot).isDirectory()) {
        warnExternalPluginRootOnce("not a directory", rootDir);
        continue;
      }
    } catch {
      warnExternalPluginRootOnce("unreadable", rootDir);
      continue;
    }
    if (seen.has(realRoot)) continue;
    seen.add(realRoot);
    result.push(realRoot);
  }
  return result;
}

function pluginRoots(env = process.env) {
  const roots = [];
  const seen = new Set();

  const addRoot = (sourceId, rootDir) => {
    const realRoot = realpathSafe(rootDir) || path.resolve(rootDir);
    if (seen.has(realRoot)) return;
    seen.add(realRoot);
    roots.push({ sourceId, rootDir });
  };

  addRoot("builtin", WEB_SHELL_PLUGINS_DIR);
  externalPluginRootDirsFromEnv(env).forEach((rootDir) => {
    addRoot(`external-${roots.length}`, rootDir);
  });
  return roots;
}

function pluginDir(root, dirName) {
  return path.join(root.rootDir, dirName);
}

function pluginEntryFileFromManifest(pluginDirectory, manifest) {
  if (manifest?.apiVersion !== 2 || !manifest.entry || !pluginSdkRangeCompatible(manifest.sdkVersion)) return null;
  const normalizedEntry = String(manifest.entry).replace(/\\/g, "/");
  if (
    normalizedEntry.startsWith("/") ||
    normalizedEntry.split("/").some((part) => !part || part === "." || part === "..") ||
    !normalizedEntry.endsWith(".mjs")
  ) {
    return null;
  }
  const candidate = path.resolve(pluginDirectory, normalizedEntry);
  return isWithinRoot(candidate, pluginDirectory) ? candidate : null;
}

function pluginSdkRangeCompatible(range) {
  const normalized = String(range || "").trim().replace(/\s+/g, " ");
  if (!normalized) return false;
  // v2 首版只承诺同一主版本兼容；支持文档中给出的常用精确值和范围写法。
  if (/^(?:\^|~)?2(?:\.0(?:\.0)?)?(?:\.x)?$/i.test(normalized)) return true;
  if (/^2\.x(?:\.x)?$/i.test(normalized)) return true;
  return /^>=\s*2(?:\.0(?:\.0)?)?\s+<\s*3(?:\.0(?:\.0)?)?$/.test(normalized);
}

function pluginI18nFile(entry, locale) {
  const fileName = PLUGIN_I18N_FILES[normalizeLocale(locale, DEFAULT_LOCALE)] || PLUGIN_I18N_FILES[DEFAULT_LOCALE];
  return path.join(entry.pluginDir, fileName);
}

function pluginI18nFiles(entry) {
  return Object.values(PLUGIN_I18N_FILES).map((fileName) => path.join(entry.pluginDir, fileName));
}

function pluginVersionForFiles(files) {
  let latestMtime = 0;
  let totalSize = 0;
  for (const file of files) {
    try {
      const stat = fs.statSync(file);
      latestMtime = Math.max(latestMtime, Math.round(stat.mtimeMs));
      totalSize += stat.size;
    } catch {}
  }
  return `${latestMtime}-${totalSize}`;
}

function listPluginEntriesInRoot(root) {
  if (!exists(root.rootDir)) return [];
  let dirEntries = [];
  try {
    dirEntries = fs.readdirSync(root.rootDir, { withFileTypes: true });
  } catch (error) {
    console.warn(
      "[gateway] plugin root skipped:",
      root.rootDir,
      error instanceof Error ? error.message : String(error)
    );
    return [];
  }
  return dirEntries
    .filter((entry) => entry.isDirectory() && isSafePluginDirName(entry.name))
    .map((entry) => {
      const pluginDirectory = pluginDir(root, entry.name);
      const manifestFile = pluginManifestFile(pluginDirectory);
      const legacyEntryFile = path.join(pluginDirectory, LEGACY_PLUGIN_ENTRY_FILE);
      const hasManifestFile = exists(manifestFile) && isWithinRoot(manifestFile, root.rootDir);
      if (!hasManifestFile) {
        if (exists(legacyEntryFile)) {
          warnPluginOnce(`${pluginDirectory}:missing-manifest`, `[gateway] legacy plugin rejected: ${entry.name}; apiVersion 2 manifest is required`);
        }
        return null;
      }
      const pluginEntry = {
        name: entry.name,
        sourceId: root.sourceId,
        pluginDir: pluginDirectory,
        rootDir: root.rootDir,
        entryFile: null,
        manifestFile,
        i18nFiles: [],
        urlPath: "",
      };
      const manifest = readPluginManifest(pluginEntry, manifestFile);
      if (!manifest) return null;
      if (exists(legacyEntryFile)) {
        // 即使同时提供 manifest，也绝不回退执行旧入口，避免新旧插件实现双重激活。
        warnPluginOnce(`${pluginDirectory}:legacy-entry`, `[gateway] legacy plugin entry ignored: ${entry.name}/${LEGACY_PLUGIN_ENTRY_FILE}`);
      }
      const entryFile = pluginEntryFileFromManifest(pluginDirectory, manifest);
      const hasEntryFile = !!entryFile && exists(entryFile) && isWithinRoot(entryFile, pluginDirectory);
      if (manifest.entry && !hasEntryFile) {
        const reason = manifest.apiVersion !== 2
          ? "apiVersion 2 is required"
          : !pluginSdkRangeCompatible(manifest.sdkVersion)
            ? `incompatible sdkVersion ${manifest.sdkVersion || "<empty>"}; host is ${PLUGIN_SDK_VERSION}`
            : "invalid or missing ESM entry";
        warnPluginOnce(`${pluginDirectory}:entry:${reason}`, `[gateway] plugin module skipped: ${entry.name}; ${reason}`);
      }
      pluginEntry.entryFile = hasEntryFile ? entryFile : null;
      pluginEntry.urlPath = hasEntryFile ? `${root.sourceId}/${entry.name}/${SERVED_PLUGIN_ENTRY_FILE}` : "";
      const i18nFiles = pluginI18nFiles(pluginEntry).filter((file) => exists(file) && isWithinRoot(file, root.rootDir));
      const versionFiles = [hasEntryFile ? entryFile : null, manifestFile, ...i18nFiles].filter(Boolean);
      return {
        ...pluginEntry,
        i18nFiles,
        manifest,
        version: pluginVersionForFiles(versionFiles),
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.name.localeCompare(right.name));
}

function listPluginEntries() {
  // 内置插件始终先加载，外部插件按环境变量里的根目录顺序追加。
  const result = [];
  const manifestIds = new Set();
  for (const entry of pluginRoots().flatMap(listPluginEntriesInRoot)) {
    const manifestId = String(entry.manifest?.id || "");
    if (manifestIds.has(manifestId)) {
      warnPluginOnce(`${entry.pluginDir}:duplicate-id`, `[gateway] plugin skipped: duplicate manifest id ${manifestId}`);
      continue;
    }
    manifestIds.add(manifestId);
    result.push(entry);
  }
  return result;
}

function listPluginManifests() {
  return listPluginEntries()
    .map((entry) => entry.manifest)
    .filter(Boolean);
}

function pluginEntryFileFromRequestPath(reqPath) {
  if (!String(reqPath || "").startsWith(OPENCODEX_PLUGIN_URL_PREFIX)) return null;
  const rel = String(reqPath).slice(OPENCODEX_PLUGIN_URL_PREFIX.length);
  const parts = rel.split("/");
  // URL 始终使用网关生成的固定 entry.mjs，不暴露 manifest 中的真实相对路径。
  if (
    parts.length !== 3 ||
    parts[2] !== SERVED_PLUGIN_ENTRY_FILE ||
    !isSafePluginSourceId(parts[0]) ||
    !isSafePluginDirName(parts[1])
  ) {
    return null;
  }
  const entry = listPluginEntries().find((plugin) => plugin.sourceId === parts[0] && plugin.name === parts[1]);
  if (!entry || !exists(entry.entryFile)) return null;
  return isWithinRoot(entry.entryFile, entry.rootDir) ? entry.entryFile : null;
}

function readPluginI18nFile(entry, file) {
  if (!entry || !file || !exists(file)) return {};
  try {
    return normalizeMessageMap(JSON.parse(readText(file)));
  } catch (error) {
    console.warn(
      "[gateway] plugin i18n skipped:",
      entry.name,
      path.basename(file),
      error instanceof Error ? error.message : String(error)
    );
    return {};
  }
}

function normalizeMessageMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result = {};
  for (const [key, message] of Object.entries(value)) {
    if (typeof message === "string") result[key] = message;
  }
  return result;
}

function messagesForPluginLocale(entry, locale) {
  const normalizedLocale = normalizeLocale(locale, DEFAULT_LOCALE);
  const fallbackFile = pluginI18nFile(entry, DEFAULT_LOCALE);
  const localeFile = pluginI18nFile(entry, normalizedLocale);
  // 插件语言缺项时先回退到中文默认文件，再叠加当前语言文件，和宿主 i18n 的兜底策略保持一致。
  return {
    ...readPluginI18nFile(entry, fallbackFile),
    ...(localeFile === fallbackFile ? {} : readPluginI18nFile(entry, localeFile)),
  };
}

function pluginMessagesForLocale(locale) {
  const messages = {};
  for (const entry of listPluginEntries()) {
    Object.assign(messages, messagesForPluginLocale(entry, locale));
  }
  return messages;
}

function withPluginI18nMessages(i18n) {
  const snapshot = i18n && typeof i18n === "object" ? i18n : { locale: DEFAULT_LOCALE, messages: {} };
  const pluginMessages = pluginMessagesForLocale(snapshot.locale);
  return {
    ...snapshot,
    // 插件 i18n 只补充插件自己的 key；宿主已有 key 优先，避免插件覆盖宿主文案。
    messages: {
      ...pluginMessages,
      ...(snapshot.messages && typeof snapshot.messages === "object" ? snapshot.messages : {}),
    },
  };
}

module.exports = {
  EXTERNAL_PLUGIN_DIRS_ENV,
  OPENCODEX_PLUGIN_URL_PREFIX,
  externalPluginRootDirsFromEnv,
  listPluginEntries,
  listPluginManifests,
  pluginEntryFileFromRequestPath,
  pluginMessagesForLocale,
  pluginSdkRangeCompatible,
  withPluginI18nMessages,
};
