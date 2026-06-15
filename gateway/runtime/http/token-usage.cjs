const fs = require("fs");
const path = require("path");
const { CODEX_HOME, isWithinRoot } = require("../core/config.cjs");
const { sendJson } = require("./http-utils.cjs");

const THREAD_USAGE_CACHE_LIMIT = 80;
const TURN_THREAD_CACHE_LIMIT = 300;
const SESSION_FILE_INDEX_TTL_MS = 5 * 1000;
const MAX_SCAN_FILES = 8000;
const MAX_ID_LENGTH = 200;

// 后端只保存 token 数字和文件定位信息，不缓存 session 正文，避免把 prompt/回复内容常驻内存。
const parsedThreadCache = new Map();
const turnThreadCache = new Map();
let sessionFileIndexCache = { expiresAt: 0, files: [] };

function validTokenUsageId(value) {
  const text = String(value || "").trim();
  if (!text || text.length > MAX_ID_LENGTH) return "";
  // threadId/turnId 只接受 Codex 当前会话里会出现的安全字符，避免被拼进路径或 JSONL 搜索条件时扩大输入面。
  return /^[a-zA-Z0-9._:-]+$/.test(text) ? text : "";
}

function tokenUsageNumber(value) {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : null;
}

function tokenUsageAtPath(object, pathParts) {
  let cursor = object;
  for (const part of pathParts) {
    if (!cursor || typeof cursor !== "object" || !Object.prototype.hasOwnProperty.call(cursor, part)) return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

function firstTokenUsageNumber(object, paths) {
  // 官方不同版本字段名不完全一致，按兼容路径取第一个可用数字。
  for (const pathParts of paths) {
    const number = tokenUsageNumber(tokenUsageAtPath(object, pathParts));
    if (number != null) return number;
  }
  return null;
}

function normalizeSessionUsage(rawUsage) {
  if (!rawUsage || typeof rawUsage !== "object") return null;
  // 这里归一化为插件稳定消费的字段名，屏蔽 session/event 结构差异。
  const inputTokens = firstTokenUsageNumber(rawUsage, [
    ["inputTokens"],
    ["input_tokens"],
    ["promptTokens"],
    ["prompt_tokens"],
  ]);
  const outputTokens = firstTokenUsageNumber(rawUsage, [
    ["outputTokens"],
    ["output_tokens"],
    ["completionTokens"],
    ["completion_tokens"],
  ]);
  const cachedInputTokens = firstTokenUsageNumber(rawUsage, [
    ["cachedInputTokens"],
    ["cached_input_tokens"],
    ["cacheReadInputTokens"],
    ["cache_read_input_tokens"],
  ]);
  if (inputTokens == null && outputTokens == null && cachedInputTokens == null) return null;
  const cacheHitRate =
    inputTokens != null && inputTokens > 0 && cachedInputTokens != null
      ? Math.max(0, Math.min(1, cachedInputTokens / inputTokens))
      : null;
  return { cacheHitRate, cachedInputTokens, inputTokens, outputTokens };
}

function cacheSet(threadId, value) {
  parsedThreadCache.delete(threadId);
  parsedThreadCache.set(threadId, value);
  // 解析 thread 文件时已经拿到全部 turn，用反向索引服务后续“只有 turnId”的查询。
  cacheTurnsForThreadFile(threadId, value);
  while (parsedThreadCache.size > THREAD_USAGE_CACHE_LIMIT) {
    const oldestKey = parsedThreadCache.keys().next().value;
    if (!oldestKey) break;
    parsedThreadCache.delete(oldestKey);
  }
}

function cacheTurnsForThreadFile(threadId, value) {
  if (!threadId || !value?.filePath || !(value.usagesByTurn instanceof Map)) return;
  const turnFile = { filePath: value.filePath, mtimeMs: value.mtimeMs, size: value.size, threadId };
  // 解析一次会话后顺手索引该会话内所有 turn，避免可见多条回复同时懒加载时重复扫 sessions。
  for (const turnId of value.usagesByTurn.keys()) {
    turnThreadCacheSet(turnId, turnFile);
  }
}

function turnThreadCacheSet(turnId, value) {
  turnThreadCache.delete(turnId);
  turnThreadCache.set(turnId, value);
  while (turnThreadCache.size > TURN_THREAD_CACHE_LIMIT) {
    const oldestKey = turnThreadCache.keys().next().value;
    if (!oldestKey) break;
    turnThreadCache.delete(oldestKey);
  }
}

function candidateRoots() {
  return [path.join(CODEX_HOME, "sessions"), path.join(CODEX_HOME, "archived_sessions")];
}

function collectSessionFileIndex(root, currentPath, state, files) {
  if (!fs.existsSync(currentPath)) return;
  let entries;
  try {
    entries = fs.readdirSync(currentPath, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    // 扫描上限保护异常目录规模，避免一次懒查询拖慢整个 gateway。
    if (++state.scanned > MAX_SCAN_FILES) return;
    const entryPath = path.join(currentPath, entry.name);
    if (entry.isDirectory()) {
      collectSessionFileIndex(root, entryPath, state, files);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".jsonl") || !isWithinRoot(entryPath, root)) continue;
    try {
      const stat = fs.statSync(entryPath);
      files.push({ filePath: entryPath, mtimeMs: stat.mtimeMs, size: stat.size });
    } catch {}
  }
}

function sessionFileIndex() {
  const now = Date.now();
  if (sessionFileIndexCache.expiresAt > now) return sessionFileIndexCache.files;
  const files = [];
  const state = { scanned: 0 };
  for (const root of candidateRoots()) {
    collectSessionFileIndex(root, root, state, files);
    if (state.scanned > MAX_SCAN_FILES) break;
  }
  // 当前页面可能没有 threadId；按最近修改的 session 先查，避免从旧目录开始逐个读大文件。
  files.sort((left, right) => right.mtimeMs - left.mtimeMs);
  sessionFileIndexCache = { expiresAt: now + SESSION_FILE_INDEX_TTL_MS, files };
  return files;
}

function threadIdFromSessionPath(filePath) {
  const match = /([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.jsonl$/i.exec(
    path.basename(filePath)
  );
  return validTokenUsageId(match?.[1]);
}

function sessionFileContainsTurnId(filePath, turnId) {
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return false;
  }
  // 只匹配 JSONL 真实字段，避免调试输出或命令参数里的 turnId 字符串被误认为会话归属。
  return text.includes(`"turn_id":"${turnId}"`) || text.includes(`"turnId":"${turnId}"`);
}

function sessionFileForThread(threadId) {
  for (const file of sessionFileIndex()) {
    if (path.basename(file.filePath).includes(threadId)) return file.filePath;
  }
  return null;
}

function parsedSessionFileForTurn(turnId) {
  // 先复用已解析 thread 的内存结果；同屏多条回复触发时这里通常直接命中。
  for (const [threadId, cached] of Array.from(parsedThreadCache.entries())) {
    if (!cached?.filePath || !(cached.usagesByTurn instanceof Map) || !cached.usagesByTurn.has(turnId)) continue;
    try {
      const stat = fs.statSync(cached.filePath);
      if (stat.mtimeMs === cached.mtimeMs && stat.size === cached.size) {
        const value = { filePath: cached.filePath, mtimeMs: cached.mtimeMs, size: cached.size, threadId };
        turnThreadCacheSet(turnId, value);
        return value;
      }
    } catch {}
    parsedThreadCache.delete(threadId);
  }
  return null;
}

function sessionFileForTurn(turnId) {
  const cached = turnThreadCache.get(turnId);
  if (cached?.filePath && cached?.threadId) {
    try {
      const stat = fs.statSync(cached.filePath);
      if (stat.mtimeMs === cached.mtimeMs && stat.size === cached.size) return cached;
    } catch {}
    turnThreadCache.delete(turnId);
  }

  const parsed = parsedSessionFileForTurn(turnId);
  if (parsed) return parsed;

  for (const file of sessionFileIndex()) {
    const filePath = file.filePath;
    if (!sessionFileContainsTurnId(filePath, turnId)) continue;
    const threadId = threadIdFromSessionPath(filePath);
    if (!threadId) return null;
    const value = { filePath, mtimeMs: file.mtimeMs, size: file.size, threadId };
    // 当前官方页面根路径不暴露 threadId；按 turnId 反查后做有界缓存，避免重复全量扫 sessions。
    turnThreadCacheSet(turnId, value);
    return value;
  }
  return null;
}

function eventPayload(row) {
  if (!row || typeof row !== "object") return null;
  if (row.type === "event_msg" && row.payload && typeof row.payload === "object") return row.payload;
  if (typeof row.type === "string") return row;
  return null;
}

function turnIdFromEvent(event) {
  return validTokenUsageId(event?.turn_id ?? event?.turnId ?? event?.turn?.id);
}

function rawUsageFromEvent(event) {
  // token_count 事件只取 last usage；total usage 是会话累计值，不适合展示到单条回复上。
  return (
    event?.info?.last_token_usage ??
    event?.info?.lastTokenUsage ??
    event?.last_token_usage ??
    event?.lastTokenUsage ??
    null
  );
}

function parseThreadUsageFile(filePath) {
  const usagesByTurn = new Map();
  let activeTurnId = "";
  let recentTurnId = "";
  const text = fs.readFileSync(filePath, "utf8");
  // JSONL 顺序即事件顺序；通过 started/completed/context 维护最近 turn，再把 token_count 归属到回复。
  for (const line of text.split(/\n/)) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const contextTurnId = row.type === "turn_context" ? validTokenUsageId(row.payload?.turn_id ?? row.payload?.turnId) : "";
    if (contextTurnId) {
      // turn_context 通常在用户消息前写入，可作为后续 token_count 的候选 turn。
      activeTurnId = contextTurnId;
      recentTurnId = contextTurnId;
    }

    const event = eventPayload(row);
    const eventType = typeof event?.type === "string" ? event.type : "";
    const eventTurnId = turnIdFromEvent(event);
    if (eventTurnId && (eventType === "task_started" || eventType === "turn_started")) {
      activeTurnId = eventTurnId;
      recentTurnId = eventTurnId;
      continue;
    }
    if (eventType === "token_count") {
      const turnId = eventTurnId || activeTurnId || recentTurnId;
      const usage = normalizeSessionUsage(rawUsageFromEvent(event));
      if (turnId && usage) usagesByTurn.set(turnId, usage);
      continue;
    }
    if (
      eventTurnId &&
      (eventType === "task_complete" ||
        eventType === "task_completed" ||
        eventType === "task_failed" ||
        eventType === "task_interrupted" ||
        eventType === "turn_completed")
    ) {
      recentTurnId = eventTurnId;
      if (activeTurnId === eventTurnId) activeTurnId = "";
    }
  }
  return usagesByTurn;
}

function usageForThreadTurn(threadId, turnId) {
  const filePath = sessionFileForThread(threadId);
  if (!filePath) return null;
  return usageFromSessionFile(threadId, turnId, filePath);
}

function usageFromSessionFile(threadId, turnId, filePath) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }
  const cached = parsedThreadCache.get(threadId);
  // 文件 mtime/size 未变化时复用解析结果；变化后重新解析，兼顾正在追加中的会话。
  if (cached && cached.filePath === filePath && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.usagesByTurn.get(turnId) || null;
  }
  // 只解析 token_count 相关数字，不把消息正文、工具输出或 prompt 暴露给前端。
  const usagesByTurn = parseThreadUsageFile(filePath);
  cacheSet(threadId, { filePath, mtimeMs: stat.mtimeMs, size: stat.size, usagesByTurn });
  return usagesByTurn.get(turnId) || null;
}

function usageForTurn(turnId) {
  const located = sessionFileForTurn(turnId);
  if (!located?.threadId || !located?.filePath) return null;
  const usage = usageFromSessionFile(located.threadId, turnId, located.filePath);
  return usage ? { threadId: located.threadId, usage } : { threadId: located.threadId, usage: null };
}

function handleTokenUsageRequest(req, res, url) {
  // 认证在 server.cjs 的 auth gate 中完成；这里仅处理参数校验和只读查询。
  if (req.method !== "GET") {
    return sendJson(res, 405, { ok: false, error: "Method Not Allowed" }, { "cache-control": "no-store" });
  }
  const requestedThreadId = String(url.searchParams.get("threadId") || "").trim()
    ? validTokenUsageId(url.searchParams.get("threadId"))
    : "";
  const turnId = validTokenUsageId(url.searchParams.get("turnId"));
  if (!turnId || (String(url.searchParams.get("threadId") || "").trim() && !requestedThreadId)) {
    return sendJson(res, 400, { ok: false, error: "Invalid token usage request" }, { "cache-control": "no-store" });
  }
  const resolved = requestedThreadId
    ? { threadId: requestedThreadId, usage: usageForThreadTurn(requestedThreadId, turnId) }
    : usageForTurn(turnId);
  const threadId = resolved?.threadId || requestedThreadId || null;
  const usage = resolved?.usage ? { ...resolved.usage, threadId, turnId } : null;
  return sendJson(res, 200, { ok: true, threadId, turnId, usage }, { "cache-control": "no-store" });
}

module.exports = {
  handleTokenUsageRequest,
  usageForTurn,
  usageForThreadTurn,
};
