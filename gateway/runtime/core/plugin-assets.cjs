const fs = require("fs");
const path = require("path");
const { WEB_SHELL_DIR, exists, isWithinRoot, readText } = require("./config.cjs");
const { DEFAULT_LOCALE, EN_US, ZH_CN, normalizeLocale } = require("../../../shared/i18n/index.cjs");
const { pluginManifestFile, readPluginManifest } = require("../plugins/manifest.cjs");

const EXTERNAL_PLUGIN_DIRS_ENV = "OPENCODEX_PLUGIN_DIRS";
const OPENCODEX_PLUGIN_URL_PREFIX = "/opencodex-plugins/";
const WEB_SHELL_PLUGINS_DIR = path.join(WEB_SHELL_DIR, "plugins");
const PLUGIN_ENTRY_FILE = "index.js";
const PLUGIN_I18N_FILES = {
  [ZH_CN]: "i18.zh.json",
  [EN_US]: "i18.en.json",
};
const SAFE_PLUGIN_DIR_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SAFE_PLUGIN_SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const warnedExternalPluginRoots = new Set();

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

function pluginEntryFile(root, dirName) {
  return path.join(pluginDir(root, dirName), PLUGIN_ENTRY_FILE);
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
      const entryFile = pluginEntryFile(root, entry.name);
      const manifestFile = pluginManifestFile(pluginDirectory);
      const hasEntryFile = exists(entryFile) && isWithinRoot(entryFile, root.rootDir);
      const hasManifestFile = exists(manifestFile) && isWithinRoot(manifestFile, root.rootDir);
      // 新插件可以只有声明式 manifest；旧插件仍然只需要 index.js，二者都不存在时才跳过目录。
      if (!hasEntryFile && !hasManifestFile) return null;
      const pluginEntry = {
        name: entry.name,
        sourceId: root.sourceId,
        pluginDir: pluginDirectory,
        rootDir: root.rootDir,
        entryFile: hasEntryFile ? entryFile : null,
        manifestFile: hasManifestFile ? manifestFile : null,
        i18nFiles: [],
        urlPath: hasEntryFile ? `${root.sourceId}/${entry.name}/${PLUGIN_ENTRY_FILE}` : "",
      };
      const manifest = hasManifestFile ? readPluginManifest(pluginEntry, manifestFile) : null;
      // 纯 manifest 插件若声明无效，没有任何可加载内容，不能出现在目录中。
      if (!hasEntryFile && !manifest) return null;
      const i18nFiles = pluginI18nFiles(pluginEntry).filter((file) => exists(file) && isWithinRoot(file, root.rootDir));
      const versionFiles = [hasEntryFile ? entryFile : null, hasManifestFile ? manifestFile : null, ...i18nFiles].filter(Boolean);
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
  return pluginRoots().flatMap(listPluginEntriesInRoot);
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
  // 插件公开资源目前只暴露目录入口 index.js，避免 URL 拼接读到任意插件内文件。
  if (
    parts.length !== 3 ||
    parts[2] !== PLUGIN_ENTRY_FILE ||
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
  withPluginI18nMessages,
};
