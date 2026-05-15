// @ts-nocheck
export {};

const fs = require("fs");
const path = require("path");
const os = require("os");
const toml = require("smol-toml");
const { isPlainObject } = require("./featurePatches");

const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const CODEX_AUTOMATIONS_DIR = path.join(CODEX_HOME, "automations");

// Web 只读取 Desktop 写在本机的自动化 TOML；创建、修改、删除仍归 Desktop 负责。
const AUTOMATION_READ_ONLY_ERROR =
  "Web环境目前只支持查看自动化和立即运行。创建、修改、删除和归档运行记录只能在 Codex Desktop 中操作。";
// Heartbeat 立即运行时复用 Desktop 的输入形态，把自动化上下文注入到目标会话。
const HEARTBEAT_AUTOMATION_PROMPT = `<heartbeat>
  <automation_id>{{AUTOMATION_ID}}</automation_id>
  <current_time_iso>{{NOW_ISO}}</current_time_iso>
  <instructions>
{{AUTOMATION_PROMPT}}
  </instructions>
</heartbeat>
`;

/** 将可选字符串字段归一成 null，避免把空串当成有效配置。 */
function stringOrNull(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** 将 TOML/JSON 里可能出现的秒、毫秒、Date、ISO 字符串统一成毫秒时间戳。 */
function timestampMsOrNull(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 0 && value < 10_000_000_000 ? value * 1000 : value;
  }
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : null;
  }
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return timestampMsOrNull(numeric);
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** 只保留数组里的有效字符串，用于 cwds 这类列表字段。 */
function stringArray(value) {
  if (Array.isArray(value)) {
    return value.filter((item) => typeof item === "string" && item.length > 0);
  }
  return [];
}

/** 解析 RRULE 字符串，兼容有无 RRULE: 前缀的存储形式。 */
function parseRruleParts(rrule) {
  const raw = String(rrule || "").trim().replace(/^RRULE:/i, "");
  const parts = {};
  for (const segment of raw.split(";")) {
    const eq = segment.indexOf("=");
    if (eq <= 0) continue;
    const key = segment.slice(0, eq).trim().toUpperCase();
    const value = segment.slice(eq + 1).trim();
    if (key) parts[key] = value;
  }
  return parts;
}

/** 解析 RRULE 中 BYHOUR/BYMINUTE/BYSECOND 这类数字列表，并做范围过滤。 */
function parseRruleNumberList(value, min, max) {
  const values = String(value || "")
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isInteger(item) && item >= min && item <= max);
  return [...new Set(values)].sort((a, b) => a - b);
}

/** 解析正整数配置；非法值回退到调用方给定的默认值。 */
function parsePositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

/** 将 RRULE 的英文星期缩写转换成本地 Date.getDay() 使用的索引。 */
function rruleWeekdayIndex(day) {
  return { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 }[String(day || "").slice(0, 2).toUpperCase()];
}

/** 解析 RRULE 的 BYDAY 字段；没有限制时返回 null 表示每天都可候选。 */
function parseRruleWeekdays(value) {
  if (!value) return null;
  const days = String(value)
    .split(",")
    .map(rruleWeekdayIndex)
    .filter((day) => Number.isInteger(day));
  return days.length > 0 ? new Set(days) : null;
}

/** 获取本地时区的一天起点，保持和 Desktop 展示的本地时间语义一致。 */
function localDayStart(date) {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

/** 计算 DAILY/WEEKLY RRULE 的下一次运行时间，最多向后扫描一年避免无限循环。 */
function nextDailyOrWeeklyRunAt(parts, nowMs) {
  const now = new Date(nowMs);
  const hours = parseRruleNumberList(parts.BYHOUR, 0, 23);
  const minutes = parseRruleNumberList(parts.BYMINUTE, 0, 59);
  const seconds = parseRruleNumberList(parts.BYSECOND, 0, 59);
  const weekdays = parts.FREQ === "WEEKLY" ? parseRruleWeekdays(parts.BYDAY) : null;
  const candidateHours = hours.length > 0 ? hours : [now.getHours()];
  const candidateMinutes = minutes.length > 0 ? minutes : [0];
  const candidateSeconds = seconds.length > 0 ? seconds : [0];

  for (let dayOffset = 0; dayOffset <= 370; dayOffset += 1) {
    const day = localDayStart(now);
    day.setDate(day.getDate() + dayOffset);
    if (weekdays && !weekdays.has(day.getDay())) continue;
    for (const hour of candidateHours) {
      for (const minute of candidateMinutes) {
        for (const second of candidateSeconds) {
          const candidate = new Date(day);
          candidate.setHours(hour, minute, second, 0);
          const time = candidate.getTime();
          if (time > nowMs) return time;
        }
      }
    }
  }
  return null;
}

/** 计算 HOURLY RRULE 的下一次运行时间，按绝对小时数处理 interval。 */
function nextHourlyRunAt(parts, nowMs) {
  const interval = parsePositiveInteger(parts.INTERVAL, 1);
  const minutes = parseRruleNumberList(parts.BYMINUTE, 0, 59);
  const seconds = parseRruleNumberList(parts.BYSECOND, 0, 59);
  const candidateMinutes = minutes.length > 0 ? minutes : [0];
  const candidateSeconds = seconds.length > 0 ? seconds : [0];
  const start = new Date(nowMs);
  start.setMinutes(0, 0, 0);

  for (let hourOffset = 0; hourOffset <= 24 * 14; hourOffset += 1) {
    const hourBase = new Date(start);
    hourBase.setHours(hourBase.getHours() + hourOffset);
    const absoluteHour = Math.floor(hourBase.getTime() / (60 * 60 * 1000));
    if (absoluteHour % interval !== 0) continue;
    for (const minute of candidateMinutes) {
      for (const second of candidateSeconds) {
        const candidate = new Date(hourBase);
        candidate.setMinutes(minute, second, 0);
        const time = candidate.getTime();
        if (time > nowMs) return time;
      }
    }
  }
  return null;
}

/** 根据自动化状态和 RRULE 估算 nextRunAt；暂停状态不显示下一次运行。 */
function computeNextRunAt(rrule, status) {
  if (status === "PAUSED") return null;
  const parts = parseRruleParts(rrule);
  switch (parts.FREQ) {
    case "DAILY":
    case "WEEKLY":
      return nextDailyOrWeeklyRunAt(parts, Date.now());
    case "HOURLY":
      return nextHourlyRunAt(parts, Date.now());
    case "MINUTELY": {
      const interval = parsePositiveInteger(parts.INTERVAL, 1);
      return Date.now() + interval * 60 * 1000;
    }
    default:
      return null;
  }
}

/** 自动化状态只接受 Desktop 当前使用的 ACTIVE/PAUSED 两态。 */
function normalizeAutomationStatus(value) {
  return value === "PAUSED" ? "PAUSED" : "ACTIVE";
}

/** 枚举 $CODEX_HOME/automations/<id>/automation.toml，作为 Web 自动化列表的数据源。 */
function automationTomlFiles() {
  let entries = [];
  try {
    entries = fs.readdirSync(CODEX_AUTOMATIONS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(CODEX_AUTOMATIONS_DIR, entry.name, "automation.toml"))
    .filter((filePath) => {
      try {
        return fs.statSync(filePath).isFile();
      } catch {
        return false;
      }
    })
    .sort();
}

/** 将 Desktop 自动化 TOML 转成前端列表需要的统一对象；坏文件跳过但不阻断列表。 */
function automationFromToml(filePath) {
  let parsed;
  let stats = null;
  try {
    stats = fs.statSync(filePath);
    parsed = toml.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    console.warn(`[gateway] failed to read automation: ${filePath}`, error);
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  const kind = parsed.kind === "heartbeat" ? "heartbeat" : parsed.kind === "cron" ? "cron" : null;
  if (!kind) return null;
  const id = stringOrNull(parsed.id) || path.basename(path.dirname(filePath));
  const status = normalizeAutomationStatus(parsed.status);
  const createdAt = timestampMsOrNull(parsed.created_at ?? parsed.createdAt) ?? stats.mtimeMs;
  const updatedAt = timestampMsOrNull(parsed.updated_at ?? parsed.updatedAt) ?? stats.mtimeMs;
  const rrule = stringOrNull(parsed.rrule) || "";
  // 旧 TOML 可能没有 next_run_at，Web 只做展示层估算，不写回 Desktop 状态。
  const nextRunAt = timestampMsOrNull(parsed.next_run_at ?? parsed.nextRunAt) ?? computeNextRunAt(rrule, status);
  const base = {
    id,
    kind,
    name: stringOrNull(parsed.name) || id,
    prompt: stringOrNull(parsed.prompt) || "",
    status,
    rrule,
    nextRunAt,
    lastRunAt: timestampMsOrNull(parsed.last_run_at ?? parsed.lastRunAt),
    createdAt,
    updatedAt,
  };
  if (kind === "heartbeat") {
    return {
      ...base,
      targetThreadId: stringOrNull(parsed.target_thread_id ?? parsed.targetThreadId),
      model: null,
      reasoningEffort: null,
    };
  }
  return {
    ...base,
    cwds: stringArray(parsed.cwds),
    executionEnvironment: parsed.execution_environment === "local" || parsed.executionEnvironment === "local" ? "local" : "worktree",
    localEnvironmentConfigPath:
      stringOrNull(parsed.local_environment_config_path ?? parsed.localEnvironmentConfigPath) || null,
    model: stringOrNull(parsed.model),
    reasoningEffort: stringOrNull(parsed.reasoning_effort ?? parsed.reasoningEffort),
  };
}

/** 读取本机 Desktop 自动化列表；Web 只暴露只读视图。 */
function listAutomations() {
  return { items: automationTomlFiles().map(automationFromToml).filter(Boolean) };
}

/** 兼容前端可能传 id 或 automationId 两种字段名。 */
function automationIdFromPayload(payload) {
  const params = payload && typeof payload === "object" ? payload : {};
  return stringOrNull(params.id) || stringOrNull(params.automationId);
}

/** 按 id 读取单个自动化；立即运行前必须重新从文件读取最新配置。 */
function readAutomationById(id) {
  const automationId = stringOrNull(id);
  if (!automationId) throw new Error("Automation not found.");
  for (const filePath of automationTomlFiles()) {
    const automation = automationFromToml(filePath);
    if (automation && automation.id === automationId) return automation;
  }
  throw new Error("Automation not found.");
}

/** app-server turn/start 需要 text input item，这里集中构造避免各路径散写。 */
function automationTextInput(text) {
  return [{ type: "text", text, text_elements: [] }];
}

/** 构造 cron 提示里的 last run 文案；文件里没有记录时明确显示 never。 */
function automationLastRunText(automation) {
  return automation.lastRunAt == null
    ? "never"
    : `${new Date(automation.lastRunAt).toISOString()} (${automation.lastRunAt})`;
}

/** 构造 heartbeat 立即运行的输入，目标是继续已有 thread。 */
function buildHeartbeatAutomationPrompt(automation) {
  return HEARTBEAT_AUTOMATION_PROMPT
    .replaceAll("{{AUTOMATION_ID}}", automation.id)
    .replaceAll("{{NOW_ISO}}", new Date().toISOString())
    .replaceAll("{{AUTOMATION_PROMPT}}", automation.prompt);
}

/** 构造 cron 立即运行的输入，目标是创建新 thread 并带上自动化元信息。 */
function buildCronAutomationPrompt(automation) {
  return [
    `Automation: ${automation.name}`,
    `Automation ID: ${automation.id}`,
    `Automation memory: $CODEX_HOME/automations/${automation.id}/memory.md`,
    `Last run: ${automationLastRunText(automation)}`,
    "",
    automation.prompt,
  ].join("\n");
}

/** 从前端 payload 透传 collaborationMode；没有时让 app-server 使用默认值。 */
function collaborationModeFromPayload(payload) {
  return payload && typeof payload === "object" && payload.collaborationMode && typeof payload.collaborationMode === "object"
    ? payload.collaborationMode
    : null;
}

/** 从前端 payload 透传 serviceTier；没有时让 app-server 使用默认值。 */
function serviceTierFromPayload(payload) {
  return payload && typeof payload === "object" ? payload.serviceTier ?? null : null;
}

/** 判断会话是否正在运行，避免 heartbeat 立即运行打断已有 turn。 */
function threadIsBusy(thread) {
  const status = thread && typeof thread === "object" ? thread.status : null;
  return status && typeof status === "object" && status.type === "active";
}

/** 立即运行 heartbeat 自动化：恢复目标会话并向同一 thread 发起一次 turn。 */
async function runHeartbeatAutomationNow(automation, payload, deps) {
  if (!automation.targetThreadId) throw new Error("Heartbeat thread not found.");
  // 先读目标 thread，确认 Desktop 记录的 heartbeat 目标仍存在。
  const readResult = await deps.callAppServer("thread/read", { threadId: automation.targetThreadId }).catch(() => null);
  const thread = readResult && typeof readResult === "object" ? readResult.thread : null;
  if (!thread) throw new Error("Heartbeat thread not found.");
  if (threadIsBusy(thread)) throw new Error("Heartbeat thread is busy right now.");

  // heartbeat 必须接在原会话上，所以先 resume，再用返回的 cwd/threadId 发 turn/start。
  const resumeResult = await deps.callAppServer("thread/resume", {
    threadId: automation.targetThreadId,
    cwd: thread.cwd || null,
    path: thread.path || null,
  });
  const resumedThread = resumeResult && typeof resumeResult === "object" && resumeResult.thread ? resumeResult.thread : thread;
  if (threadIsBusy(resumedThread)) throw new Error("Heartbeat thread is busy right now.");

  const threadId = resumedThread.id || automation.targetThreadId;
  const cwd = resumedThread.cwd || (resumeResult && resumeResult.cwd) || thread.cwd || deps.projectRoot;
  const permissions = deps.permissionsForAppServer(payload);
  deps.recordThreadWorkspaceRoot(threadId, cwd, "project");

  // 立即运行本质是一次普通 turn/start，不在 Web 里实现 Electron 调度循环。
  await deps.callAppServer("turn/start", {
    threadId,
    input: automationTextInput(buildHeartbeatAutomationPrompt(automation)),
    cwd,
    approvalPolicy: permissions.approvalPolicy,
    approvalsReviewer: permissions.approvalsReviewer,
    sandboxPolicy: permissions.sandboxPolicy,
    permissionProfile: permissions.permissionProfile,
    model: null,
    effort: null,
    serviceTier: serviceTierFromPayload(payload),
    summary: "auto",
    personality: null,
    outputSchema: null,
    collaborationMode: collaborationModeFromPayload(payload),
  });
  return { success: true, threadId };
}

/** 立即运行 local cron 自动化：为每个 cwd 新建 thread 并发起一次 turn。 */
async function runCronAutomationNow(automation, payload, deps) {
  if (automation.executionEnvironment === "worktree" || automation.localEnvironmentConfigPath) {
    throw new Error("Web环境暂不支持立即运行 worktree 自动化，请在 Codex Desktop 中操作。");
  }
  const cwds = Array.isArray(automation.cwds) ? automation.cwds : [];
  if (cwds.length === 0) throw new Error("Automation has no workspace folders configured.");

  const permissions = deps.permissionsForAppServer(payload);
  const threadIds = [];
  for (const configuredCwd of cwds) {
    const cwd = deps.normalizeWorkspacePath(configuredCwd) || configuredCwd;
    // cron 立即运行按 cwd 创建新会话，避免把一次性运行混进用户当前会话。
    const threadStartResult = await deps.callAppServer("thread/start", {
      model: automation.model || null,
      modelProvider: null,
      serviceTier: serviceTierFromPayload(payload),
      cwd,
      approvalPolicy: permissions.approvalPolicy,
      approvalsReviewer: permissions.approvalsReviewer,
      sandbox: permissions.sandboxMode,
      permissionProfile: permissions.permissionProfile,
      config: null,
      personality: null,
      ephemeral: null,
      experimentalRawEvents: false,
      persistExtendedHistory: false,
    });
    const threadId =
      threadStartResult &&
      typeof threadStartResult === "object" &&
      threadStartResult.thread &&
      typeof threadStartResult.thread.id === "string"
        ? threadStartResult.thread.id
        : null;
    if (!threadId) throw new Error("Automation thread start failed.");
    threadIds.push(threadId);
    deps.recordThreadWorkspaceRoot(threadId, cwd, "project");
    // 命名失败不影响 turn 启动，和 Desktop 一样把它当作非关键装饰信息。
    deps.callAppServer("thread/name/set", { threadId, name: automation.name }).catch(() => {});
    // 自动化 prompt 包含名称、id、memory 路径和原始 instructions，方便运行线程自解释。
    await deps.callAppServer("turn/start", {
      threadId,
      input: automationTextInput(buildCronAutomationPrompt(automation)),
      cwd,
      approvalPolicy: permissions.approvalPolicy,
      approvalsReviewer: permissions.approvalsReviewer,
      sandboxPolicy: permissions.sandboxPolicy,
      permissionProfile: permissions.permissionProfile,
      model: automation.model || null,
      effort: automation.reasoningEffort || null,
      serviceTier: serviceTierFromPayload(payload),
      summary: "auto",
      personality: null,
      outputSchema: null,
      collaborationMode: null,
    });
  }
  return { success: true, threadIds };
}

/** 根据自动化类型分发立即运行；Web 不接管后台调度，只处理用户主动触发。 */
async function runAutomationNow(payload, deps) {
  const automation = readAutomationById(automationIdFromPayload(payload));
  if (automation.kind === "heartbeat") {
    return runHeartbeatAutomationNow(automation, payload, deps);
  }
  return runCronAutomationNow(automation, payload, deps);
}

/** 统一抛出只读错误，交给前端既有 IPC 错误 toast 展示。 */
function throwAutomationReadOnlyError() {
  throw new Error(AUTOMATION_READ_ONLY_ERROR);
}


function createAutomationIpcHandlers(deps) {
  const projectRoot = deps.projectRoot || process.cwd();
  return {
    listAutomations,
    runAutomationNow: (payload) => runAutomationNow(payload, { ...deps, projectRoot }),
    throwAutomationReadOnlyError,
  };
}

module.exports = {
  createAutomationIpcHandlers,
  listAutomations,
};
