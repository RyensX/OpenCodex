// @ts-nocheck
export {};

const path = require("path");

// manifest schema 只在缓存字段语义变化时递增，避免误复用旧缓存。
const MANIFEST_SCHEMA_VERSION = 8;
// 默认使用非隐藏目录，便于用户在 Finder / Explorer 中直接查看。
// 开发态默认缓存统一收敛到 .data，避免官方工作副本散落在项目根目录。
const DEFAULT_BUNDLE_DIR = path.join(".data", "cache", "codex-official-bundle");
const ASAR_FILE_NAME = "app.asar";

module.exports = {
  MANIFEST_SCHEMA_VERSION,
  DEFAULT_BUNDLE_DIR,
  ASAR_FILE_NAME,
};
