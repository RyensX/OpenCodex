// @ts-nocheck
export {};

const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");

function createDesktopState(deps) {
  const desktopGlobalStatePath = deps.desktopGlobalStatePath;
  const DESKTOP_PROJECT_ROOTS_KEY = deps.desktopProjectRootsKey;
  const DESKTOP_WORKSPACE_LABELS_KEY = deps.desktopWorkspaceLabelsKey;
  const DESKTOP_PERSISTED_ATOMS_KEY = deps.desktopPersistedAtomsKey;
  const DESKTOP_ARCHIVED_THREADS_KEY = deps.desktopArchivedThreadsKey;
  const CONFIGURATION_RAW_DESKTOP_KEYS = deps.configurationRawDesktopKeys;
  const PINNED_THREAD_IDS_STATE_KEY = deps.pinnedThreadIdsStateKey;
  const COMPOSER_PERMISSION_MODE_VISIBILITY_KEY = deps.composerPermissionModeVisibilityKey;
  const DEFAULT_COMPOSER_PERMISSION_MODE_VISIBILITY = deps.defaultComposerPermissionModeVisibility;
  const STATSIG_DEFAULT_FEATURES_CONFIG = deps.statsigDefaultFeaturesConfig;
  const GLOBAL_STATE = deps.globalState;
  const PERSISTED_STATE = deps.persistedState;
  const SETTINGS_STATE = deps.settingsState;
  const SHARED_OBJECT_SNAPSHOT = deps.sharedObjectSnapshot;
  const isPlainObject = deps.isPlainObject;
  const patchStatsigDefaultFeatureSnapshot = deps.patchStatsigDefaultFeatureSnapshot;
  const workspaceIpc = deps.workspaceIpc;
  const workspaceRuntime = deps.workspaceRuntime;
  let DESKTOP_GLOBAL_STATE = {};

  /** 写入 persisted atom 前做兼容修正，例如强制显示审批模式。 */
  function normalizePersistedAtomValue(key, value) {
    if (key === COMPOSER_PERMISSION_MODE_VISIBILITY_KEY) {
      return {
        ...DEFAULT_COMPOSER_PERMISSION_MODE_VISIBILITY,
        ...(isPlainObject(value) ? value : {}),
      };
    }
    return value;
  }
  
  /** shared-object snapshot 写入前做兼容修正。 */
  function normalizeSharedObjectSnapshotValue(key, value) {
    if (key === STATSIG_DEFAULT_FEATURES_CONFIG) {
      return patchStatsigDefaultFeatureSnapshot(value);
    }
    return value;
  }
  
  /** 保存 shared-object snapshot，并统一套用 normalize。 */
  function setSharedObjectSnapshotValue(key, value) {
    SHARED_OBJECT_SNAPSHOT.set(key, normalizeSharedObjectSnapshotValue(key, value));
  }
  
  /** 确保 renderer 首次订阅时能拿到 Web 端默认 shared-object 值。 */
  function ensureSharedObjectDefaults() {
    setSharedObjectSnapshotValue(
      STATSIG_DEFAULT_FEATURES_CONFIG,
      SHARED_OBJECT_SNAPSHOT.get(STATSIG_DEFAULT_FEATURES_CONFIG)
    );
  }

  /** 安全读取 JSON 文件，读失败直接返回 fallback。 */
  function loadJsonFile(filePath, fallback) {
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      return fallback;
    }
  }
  
  /** 读取 Codex Desktop 的 globalState 文件，复用本机已有项目/设置状态。 */
  function loadDesktopGlobalState() {
    const snapshot = loadJsonFile(desktopGlobalStatePath, {});
    DESKTOP_GLOBAL_STATE = snapshot && typeof snapshot === "object" && !Array.isArray(snapshot) ? snapshot : {};
    return DESKTOP_GLOBAL_STATE;
  }
  
  /** 生成和目标文件同目录的临时文件名，rename 时才能保持原子替换语义。 */
  function temporaryWritePath(filePath) {
    return path.join(path.dirname(filePath), `.${path.basename(filePath)}.tmp-${Date.now()}-${randomUUID()}`);
  }
  
  /** 原子写入文件：先写临时文件，再 rename 覆盖目标，失败时清理临时文件。 */
  function writeFileAtomically(filePath, content) {
    const tempPath = temporaryWritePath(filePath);
    try {
      fs.writeFileSync(tempPath, content, "utf8");
      fs.renameSync(tempPath, filePath);
    } catch (error) {
      try {
        fs.rmSync(tempPath, { force: true });
      } catch {}
      throw error;
    }
  }
  
  /** 写回 Codex Desktop globalState，让 Web 端设置能和本机状态共享。 */
  function persistDesktopGlobalState() {
    try {
      fs.mkdirSync(path.dirname(desktopGlobalStatePath), { recursive: true });
      const content = JSON.stringify(DESKTOP_GLOBAL_STATE);
      writeFileAtomically(desktopGlobalStatePath, content);
      writeFileAtomically(`${desktopGlobalStatePath}.bak`, content);
    } catch (error) {
      console.warn(`[gateway] failed to persist Codex global state: ${desktopGlobalStatePath}`, error);
    }
  }
  
  /** 获取 Desktop globalState 中的单个 key。 */
  function getDesktopGlobalStateValue(key) {
    loadDesktopGlobalState();
    return Object.prototype.hasOwnProperty.call(DESKTOP_GLOBAL_STATE, key) ? DESKTOP_GLOBAL_STATE[key] : undefined;
  }
  
  /** 设置 Desktop globalState 中的单个 key 并落盘。 */
  function setDesktopGlobalStateValue(key, value) {
    loadDesktopGlobalState();
    DESKTOP_GLOBAL_STATE[key] = value;
    persistDesktopGlobalState();
  }
  
  /** 读取官方 renderer 使用的 persisted atom 存储。 */
  function getDesktopPersistedAtoms() {
    const atoms = getDesktopGlobalStateValue(DESKTOP_PERSISTED_ATOMS_KEY);
    return atoms && typeof atoms === "object" && !Array.isArray(atoms) ? atoms : {};
  }
  
  /** 更新 persisted atom，保持 Web 设置与本地 Codex Desktop 的存储形态一致。 */
  function setDesktopPersistedAtom(key, value, deleted = false) {
    const atoms = { ...getDesktopPersistedAtoms() };
    if (deleted) {
      delete atoms[key];
    } else {
      atoms[key] = valueForDesktopPersistedAtom(key, value, atoms[key]);
    }
    setDesktopGlobalStateValue(DESKTOP_PERSISTED_ATOMS_KEY, atoms);
  }
  
  /** Desktop 的 prompt-history 可能是分组对象，renderer 这里需要数组。 */
  function normalizePromptHistoryForRenderer(value) {
    if (Array.isArray(value)) return value.filter((item) => typeof item === "string");
    if (!value || typeof value !== "object") return [];
    const globalHistory = value.global;
    if (Array.isArray(globalHistory)) return globalHistory.filter((item) => typeof item === "string");
    const newConversationHistory = value["new-conversation"];
    if (Array.isArray(newConversationHistory)) {
      return newConversationHistory.filter((item) => typeof item === "string");
    }
    return [];
  }
  
  /** 从本地状态读给 renderer 前做形态转换。 */
  function valueForRendererPersistedAtom(key, value) {
    if (key === "prompt-history") return normalizePromptHistoryForRenderer(value);
    return normalizePersistedAtomValue(key, value);
  }
  
  /** 构造 renderer 可直接消费的 persisted atom 快照。 */
  function persistedStateForRenderer() {
    return Object.fromEntries(
      Object.entries(PERSISTED_STATE).map(([key, value]) => [key, valueForRendererPersistedAtom(key, value)])
    );
  }
  
  /** 写回 Desktop 状态前做形态转换，尽量不破坏 Desktop 自己的数据结构。 */
  function valueForDesktopPersistedAtom(key, value, previousValue) {
    if (key === COMPOSER_PERMISSION_MODE_VISIBILITY_KEY) {
      return normalizePersistedAtomValue(key, value);
    }
    if (key !== "prompt-history" || !Array.isArray(value)) return value;
    if (!previousValue || typeof previousValue !== "object" || Array.isArray(previousValue)) return value;
    return {
      ...previousValue,
      global: value.filter((item) => typeof item === "string"),
    };
  }
  
  /** 启动时只加载本机 Codex Desktop 状态，并做 Web renderer 需要的兼容归一化。 */
  function loadPersistentState() {
    loadDesktopGlobalState();
    Object.assign(PERSISTED_STATE, getDesktopPersistedAtoms());
    for (const [key, value] of Object.entries(DESKTOP_GLOBAL_STATE)) {
      GLOBAL_STATE.set(key, value);
    }
    ensureSharedObjectDefaults();
    for (const key of ["THREAD_WORKSPACE_ROOT_HINTS", "thread-workspace-root-hints"]) {
      if (Array.isArray(GLOBAL_STATE.get(key))) {
        GLOBAL_STATE.set(key, {});
      }
    }
    const normalizedVisibility = normalizePersistedAtomValue(
      COMPOSER_PERMISSION_MODE_VISIBILITY_KEY,
      PERSISTED_STATE[COMPOSER_PERMISSION_MODE_VISIBILITY_KEY]
    );
    if (JSON.stringify(PERSISTED_STATE[COMPOSER_PERMISSION_MODE_VISIBILITY_KEY]) !== JSON.stringify(normalizedVisibility)) {
      PERSISTED_STATE[COMPOSER_PERMISSION_MODE_VISIBILITY_KEY] = normalizedVisibility;
    }
  }

  /** get-global-state 的兼容实现，优先复用 Desktop 状态，再提供 Web 默认值。 */
  function getGlobalStateValue(key) {
    if (key == null) return null;
    const normalized = String(key).toLowerCase();
    if (normalized.includes("workspace-root-options") || normalized.includes("saved-workspace-roots")) {
      return workspaceIpc.listWorkspaceRoots().map((root) => root.path);
    }
    if (normalized.includes("workspace-root-labels")) {
      return workspaceIpc.workspaceRootOptions().labels;
    }
    if (normalized.includes("active-workspace-roots")) return workspaceIpc.activeWorkspaceRootPaths();
    if (normalized.includes("project-order")) {
      const desktopProjectOrder = getDesktopGlobalStateValue("project-order");
      if (Array.isArray(desktopProjectOrder)) return desktopProjectOrder;
    }
    if (normalized.includes("remote-projects")) {
      const desktopRemoteProjects = getDesktopGlobalStateValue("remote-projects");
      if (Array.isArray(desktopRemoteProjects)) return desktopRemoteProjects;
    }
    if (normalized.includes("active-remote-project-id")) {
      const activeRemoteProjectId = getDesktopGlobalStateValue("active-remote-project-id");
      return activeRemoteProjectId === undefined ? null : activeRemoteProjectId;
    }
    if (normalized.includes("projectless-thread-ids")) {
      const projectlessThreadIds = getDesktopGlobalStateValue("projectless-thread-ids");
      if (Array.isArray(projectlessThreadIds)) return projectlessThreadIds;
    }
    if (normalized.includes("thread_workspace_root_hints") || normalized.includes("thread-workspace-root-hints")) {
      const hints = getDesktopGlobalStateValue("thread-workspace-root-hints");
      return hints && typeof hints === "object" && !Array.isArray(hints) ? hints : {};
    }
    if (GLOBAL_STATE.has(key)) return GLOBAL_STATE.get(key);
    // 未特殊处理的 Electron globalState 也要回落到 Desktop 文件，否则 renderer 的宿主 UI 状态刷新后会丢。
    const desktopValue = getDesktopGlobalStateValue(key);
    if (desktopValue !== undefined) return desktopValue;
    if (normalized.includes("use-copilot-auth-if-available")) return false;
    if (normalized.includes("project-order")) return [];
    if (normalized.includes("remote-projects")) return [];
    if (normalized.includes("selected-remote-host-id")) return null;
    if (normalized.includes("active-remote-project-id")) return null;
    if (normalized.includes("copilot-default-model")) return null;
    if (normalized.includes("notifications-turn-mode")) return "unfocused";
    if (normalized.includes("notifications-permissions-enabled")) return false;
    if (normalized.includes("notifications-questions-enabled")) return false;
    if (normalized.includes("mac-menu-bar-enabled")) return false;
    if (normalized.includes("pinned-project-ids")) return [];
    if (normalized.includes("connection-group-order")) return [];
    if (normalized.includes("ambient-suggestions-enabled")) return false;
    if (normalized.includes("follow_ups") || normalized.includes("follow-ups")) return {};
    if (normalized.includes("queued-follow-ups")) return {};
    return null;
  }
  
  // ===== Hover Card / Pinned Threads BEGIN: 状态读写与参数归一化 =====
  // 下方函数只服务官方首页 hover card/pin，不参与 Thread Overlay、HUD 或会话内容渲染。
  
  /** pinned thread 列表只保存字符串 id，并去重保序，避免官方 hover card 读到脏数据。 */
  function normalizePinnedThreadIds(value) {
    const source = Array.isArray(value) ? value : [];
    const seen = new Set();
    const ids = [];
    for (const item of source) {
      if (typeof item !== "string" || !item) continue;
      if (seen.has(item)) continue;
      seen.add(item);
      ids.push(item);
    }
    return ids;
  }
  
  /** 读取官方首页 hover/pin 入口需要的 pinned thread 列表。 */
  function readPinnedThreadIds() {
    const desktopValue = getDesktopGlobalStateValue(PINNED_THREAD_IDS_STATE_KEY);
    if (Array.isArray(desktopValue)) return normalizePinnedThreadIds(desktopValue);
    const memoryValue = GLOBAL_STATE.get(PINNED_THREAD_IDS_STATE_KEY);
    return normalizePinnedThreadIds(memoryValue);
  }
  
  /** 写入 pinned thread 列表，并同步到 Desktop globalState 供刷新后复用。 */
  function writePinnedThreadIds(threadIds) {
    const normalized = normalizePinnedThreadIds(threadIds);
    setGlobalStateValue({ key: PINNED_THREAD_IDS_STATE_KEY, value: normalized });
    return normalized;
  }
  
  /** 实现官方 set-thread-pinned IPC：支持置顶、取消置顶和插入到指定 thread 前。 */
  function setThreadPinnedValue(payload) {
    const params = payload && typeof payload === "object" && payload.params ? payload.params : payload;
    const input = params && typeof params === "object" ? params : {};
    const threadId =
      typeof input.threadId === "string"
        ? input.threadId
        : typeof input.conversationId === "string"
          ? input.conversationId
          : "";
    if (!threadId) return { threadIds: readPinnedThreadIds() };
    const beforeThreadId = typeof input.beforeThreadId === "string" ? input.beforeThreadId : null;
    const nextIds = readPinnedThreadIds().filter((id) => id !== threadId);
    if (input.pinned !== false) {
      const beforeIndex = beforeThreadId ? nextIds.indexOf(beforeThreadId) : -1;
      if (beforeIndex >= 0) {
        nextIds.splice(beforeIndex, 0, threadId);
      } else {
        nextIds.unshift(threadId);
      }
    }
    return { threadIds: writePinnedThreadIds(nextIds) };
  }
  
  /** 实现官方 set-pinned-threads-order IPC：拖拽排序后直接保存前端给出的顺序。 */
  function setPinnedThreadsOrderValue(payload) {
    const params = payload && typeof payload === "object" && payload.params ? payload.params : payload;
    const threadIds = params && typeof params === "object" ? params.threadIds : null;
    return { threadIds: writePinnedThreadIds(threadIds) };
  }
  
  // ===== Hover Card / Pinned Threads END: 状态读写与参数归一化 =====
  
  /** set-global-state 的兼容实现，关键状态会同步写回 Desktop globalState。 */
  function setGlobalStateValue(payload) {
    if (!payload || typeof payload !== "object") return { success: true };
    const key = payload.key;
    if (typeof key !== "string" || !key) return { success: true };
    const value = Object.prototype.hasOwnProperty.call(payload, "value") ? payload.value : null;
    GLOBAL_STATE.set(key, value);
    setDesktopGlobalStateValue(key, value);
    const normalized = key.toLowerCase();
    if (normalized.includes("workspace-root-options") || normalized.includes("saved-workspace-roots")) {
      GLOBAL_STATE.set(DESKTOP_PROJECT_ROOTS_KEY, Array.isArray(value) ? value : []);
      setDesktopGlobalStateValue(DESKTOP_PROJECT_ROOTS_KEY, Array.isArray(value) ? value : []);
    } else if (normalized.includes("workspace-root-labels")) {
      GLOBAL_STATE.set(DESKTOP_WORKSPACE_LABELS_KEY, value && typeof value === "object" ? value : {});
      setDesktopGlobalStateValue(DESKTOP_WORKSPACE_LABELS_KEY, value && typeof value === "object" ? value : {});
    }
    return { success: true };
  }
  
  /** 从 settings payload 中提取 key，兼容 key/name/setting 等多种字段。 */
  function getSettingKey(payload) {
    if (!payload || typeof payload !== "object") return null;
    return payload.key || payload.name || payload.setting || payload.settingKey || null;
  }
  
  /** configuration 在 Desktop globalState 中的兼容 key，优先读 configuration:*，必要时兼容官方裸 key。 */
  function desktopConfigurationKeys(key) {
    const normalized = String(key || "");
    const keys = [`configuration:${normalized}`];
    if (CONFIGURATION_RAW_DESKTOP_KEYS.has(normalized)) keys.push(normalized);
    return keys;
  }
  
  /** 读取 Desktop-backed configuration 值。 */
  function getDesktopConfigurationValue(key) {
    for (const storageKey of desktopConfigurationKeys(key)) {
      const value = getDesktopGlobalStateValue(storageKey);
      if (value !== undefined) return value;
    }
    const memoryKey = `configuration:${String(key || "")}`;
    return Object.prototype.hasOwnProperty.call(SETTINGS_STATE, memoryKey) ? SETTINGS_STATE[memoryKey] : undefined;
  }
  
  /** 写入 Desktop-backed configuration 值，保证 Web 改动能同步给本机 Codex Desktop 状态。 */
  function setDesktopConfigurationValue(key, value) {
    const normalized = String(key || "");
    SETTINGS_STATE[`configuration:${normalized}`] = value;
    for (const storageKey of desktopConfigurationKeys(normalized)) {
      setDesktopGlobalStateValue(storageKey, value);
    }
  }
  
  /** 校验并保留 app-server config/batchWrite 的 edit 结构，避免 gateway 猜测配置层级。 */
  function normalizeCodexConfigEdit(edit, index = 0) {
    if (!isPlainObject(edit)) {
      throw new Error(`settings:set codexConfig edit at index ${index} must be an object`);
    }
    const keyPath = typeof edit.keyPath === "string" ? edit.keyPath.trim() : "";
    if (keyPath.length === 0) {
      throw new Error(`settings:set codexConfig edit at index ${index} is missing keyPath`);
    }
    if (!Object.prototype.hasOwnProperty.call(edit, "value")) {
      throw new Error(`settings:set codexConfig edit at index ${index} is missing value`);
    }
    return { ...edit, keyPath };
  }
  
  /**
   * 将 settings:set 的 codexConfig 写入规范化为 app-server config/batchWrite edits。
   * 嵌套配置必须由调用方显式给出 keyPath/mergeStrategy，避免把动态 key 误拆成点路径。
   */
  function normalizeCodexConfigEdits(value) {
    if (!isPlainObject(value)) return [];
  
    if (Array.isArray(value.edits)) {
      return value.edits.map((edit, index) => normalizeCodexConfigEdit(edit, index));
    }
  
    if (Object.prototype.hasOwnProperty.call(value, "edits")) {
      throw new Error("settings:set codexConfig edits must be an array");
    }
  
    if (typeof value.keyPath === "string" && Object.prototype.hasOwnProperty.call(value, "value")) {
      return [normalizeCodexConfigEdit(value)];
    }
  
    const edits = [];
    for (const [key, item] of Object.entries(value)) {
      if (isPlainObject(item)) {
        throw new Error(
          `settings:set codexConfig cannot infer nested keyPath for "${key}"; pass explicit config/batchWrite edits`
        );
      }
      edits.push({ keyPath: key, value: item });
    }
    return edits;
  }
  
  /** 通过 app-server 写 Codex 业务配置，gateway 不直接持久化 config.toml。 */
  async function writeCodexConfigSetting(value, { callAppServer }) {
    if (!isPlainObject(value)) return false;
    if (typeof callAppServer !== "function") {
      throw new Error("app-server is required to persist Codex config");
    }
    const edits = normalizeCodexConfigEdits(value);
    if (edits.length === 0) return true;
    await callAppServer("config/batchWrite", { edits });
    return true;
  }
  
  /** 读取 Codex 业务配置必须走 app-server；app-server 不可用时让错误直接暴露给 Web。 */
  async function readCodexConfigSetting({ readCodexConfig } = {}) {
    if (typeof readCodexConfig !== "function") {
      throw new Error("app-server is required to read Codex config");
    }
    const result = await readCodexConfig({ includeLayers: false });
    if (result && typeof result === "object" && isPlainObject(result.config)) {
      return result.config;
    }
    throw new Error("app-server config/read returned an invalid config response");
  }
  
  /** 写入 Desktop-backed setting；codexConfig 交给 app-server，其他 UI 状态走 Desktop globalState。 */
  async function setDesktopSettingValue(key, value, options = {}) {
    if (key === "codexConfig") {
      return writeCodexConfigSetting(value, options);
    }
    SETTINGS_STATE[key] = value;
    setDesktopGlobalStateValue(key, value);
    return true;
  }
  
  /** settings:get 实现：Codex config 读 app-server，Electron UI 设置读 Desktop globalState。 */
  async function getSettingValue(payload, options = {}) {
    const key = getSettingKey(payload);
    if (key == null) {
      if (payload != null) return null;
      loadDesktopGlobalState();
      const snapshot = { ...SETTINGS_STATE, codexConfig: await readCodexConfigSetting(options) };
      for (const rawKey of CONFIGURATION_RAW_DESKTOP_KEYS) {
        const value = getDesktopConfigurationValue(rawKey);
        if (value !== undefined) {
          snapshot[rawKey] = value;
          snapshot[`configuration:${rawKey}`] = value;
        }
      }
      const archivedThreads = workspaceRuntime.listArchivedThreads();
      if (archivedThreads.length > 0) snapshot[DESKTOP_ARCHIVED_THREADS_KEY] = archivedThreads;
      return snapshot;
    }
    if (key === "codexConfig") return readCodexConfigSetting(options);
    const desktopValue = getDesktopGlobalStateValue(key);
    if (desktopValue !== undefined) return desktopValue;
    return Object.prototype.hasOwnProperty.call(SETTINGS_STATE, key) ? SETTINGS_STATE[key] : null;
  }
  
  /** settings:set 实现：Codex config 写 app-server，Electron UI 设置写 Desktop globalState。 */
  async function setSettingValue(payload, options = {}) {
    if (!payload || typeof payload !== "object") return true;
    if (payload.key && Object.prototype.hasOwnProperty.call(payload, "value")) {
      return setDesktopSettingValue(payload.key, payload.value, options);
    }
    if (payload.name && Object.prototype.hasOwnProperty.call(payload, "value")) {
      return setDesktopSettingValue(payload.name, payload.value, options);
    }
    if (payload.settings && typeof payload.settings === "object") {
      for (const [key, value] of Object.entries(payload.settings)) {
        await setDesktopSettingValue(key, value, options);
      }
      return true;
    }
    for (const [key, value] of Object.entries(payload)) {
      await setDesktopSettingValue(key, value, options);
    }
    return true;
  }
  
  /** get-configuration 兜底值，优先复用 Desktop-backed 设置，再关闭 Web 当前没有实现的原生能力。 */
  function getConfigurationValue(payload) {
    const key =
      payload && typeof payload === "object"
        ? payload.key || payload.name || payload.configurationKey || null
        : null;
    if (key == null) return null;
    const normalized = String(key);
    const desktopValue = getDesktopConfigurationValue(normalized);
    if (desktopValue !== undefined) return desktopValue;
    const known = new Map([
      ["browserAgent", false],
      ["browserAgentAvailable", false],
      ["browserPane", false],
      ["computerUse", false],
      ["multiWindow", false],
      ["ambientSuggestions", false],
      ["artifactsPane", false],
      ["avatarOverlay", false],
      ["control", false],
      ["localeOverride", process.env.CODEX_WEB_LOCALE || "zh-CN"],
    ]);
    if (known.has(normalized)) return known.get(normalized);
    if (normalized.includes("enabled")) return false;
    if (normalized.includes("mode")) return "off";
    if (normalized.includes("path")) return null;
    if (normalized.includes("origins")) return [];
    return null;
  }
  
  /** set-configuration 的本地持久化实现。 */
  function setConfigurationValue(payload) {
    if (!payload || typeof payload !== "object") return { success: true };
    const key = payload.key || payload.name || payload.configurationKey || null;
    if (typeof key !== "string" || !key) return { success: true };
    setDesktopConfigurationValue(key, Object.prototype.hasOwnProperty.call(payload, "value") ? payload.value : null);
    return { success: true };
  }
  
  /** 把 shared-object snapshot Map 转成可序列化对象。 */
  function sharedObjectSnapshotObject() {
    ensureSharedObjectDefaults();
    return Object.fromEntries(SHARED_OBJECT_SNAPSHOT.entries());
  }

  return {
    getConfigurationValue,
    getDesktopGlobalStateValue,
    getDesktopPersistedAtoms,
    getGlobalStateValue,
    getSettingValue,
    loadPersistentState,
    normalizeSharedObjectSnapshotValue,
    persistedStateForRenderer,
    readPinnedThreadIds,
    setConfigurationValue,
    setDesktopGlobalStateValue,
    setDesktopPersistedAtom,
    setGlobalStateValue,
    setPinnedThreadsOrderValue,
    setSettingValue,
    setSharedObjectSnapshotValue,
    setThreadPinnedValue,
    sharedObjectSnapshotObject,
  };
}

module.exports = {
  createDesktopState,
};
