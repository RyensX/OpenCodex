const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { CODEX_HOME, isWithinRoot } = require("../core/config.cjs");

const READ_CHUNK_BYTES = 64 * 1024;
const ACTIVE_LIFECYCLE_EVENTS = new Set(["task_started", "turn_started"]);
const IDLE_LIFECYCLE_EVENTS = new Set([
  "task_complete",
  "task_completed",
  "task_failed",
  "task_interrupted",
  "task_cancelled",
  "turn_completed",
  "turn_failed",
  "turn_aborted",
  "turn_cancelled",
]);

function lifecycleStatusFromLine(line) {
  if (!line.trim()) return null;
  let row;
  try {
    row = JSON.parse(line);
  } catch {
    return null;
  }
  if (row?.type !== "event_msg" || !row.payload || typeof row.payload !== "object") return null;
  const eventType = row.payload.type;
  if (ACTIVE_LIFECYCLE_EVENTS.has(eventType)) return { type: "active", activeFlags: [] };
  if (IDLE_LIFECYCLE_EVENTS.has(eventType)) return { type: "idle" };
  return null;
}

function readLatestTranscriptStatus(filePath) {
  let fileDescriptor;
  try {
    fileDescriptor = fs.openSync(filePath, "r");
    let cursor = fs.fstatSync(fileDescriptor).size;
    let fragment = "";
    while (cursor > 0) {
      const start = Math.max(0, cursor - READ_CHUNK_BYTES);
      const buffer = Buffer.allocUnsafe(cursor - start);
      fs.readSync(fileDescriptor, buffer, 0, buffer.length, start);
      const lines = `${buffer.toString("utf8")}${fragment}`.split("\n");
      // 非首块的第一段可能只是半行，留给更早的块补齐后再解析。
      fragment = start > 0 ? lines.shift() || "" : "";
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const status = lifecycleStatusFromLine(lines[index]);
        if (status) return status;
      }
      cursor = start;
    }
  } catch {
    return { type: "notLoaded" };
  } finally {
    if (fileDescriptor !== undefined) {
      try {
        fs.closeSync(fileDescriptor);
      } catch {}
    }
  }
  return { type: "notLoaded" };
}

function resolveTranscriptPath(threadId, codexHome = CODEX_HOME) {
  if (typeof threadId !== "string" || !threadId) return null;
  let databaseNames;
  try {
    databaseNames = fs
      .readdirSync(codexHome)
      .filter((name) => /^state_\d+\.sqlite$/.test(name))
      .sort((left, right) => Number(right.match(/\d+/)?.[0] || 0) - Number(left.match(/\d+/)?.[0] || 0));
  } catch {
    return null;
  }
  const allowedRoots = [path.join(codexHome, "sessions"), path.join(codexHome, "archived_sessions")];
  for (const databaseName of databaseNames) {
    let database;
    try {
      database = new DatabaseSync(path.join(codexHome, databaseName), { readOnly: true });
      const row = database.prepare("SELECT rollout_path AS rolloutPath FROM threads WHERE id = ? LIMIT 1").get(threadId);
      const rolloutPath = typeof row?.rolloutPath === "string" ? row.rolloutPath : "";
      if (rolloutPath && allowedRoots.some((root) => isWithinRoot(rolloutPath, root))) return rolloutPath;
    } catch {
      continue;
    } finally {
      try {
        database?.close();
      } catch {}
    }
  }
  return null;
}

function createTranscriptStatusObserver(options = {}) {
  const resolveSessionFile =
    typeof options.resolveSessionFile === "function" ? options.resolveSessionFile : () => null;
  const publish = typeof options.publish === "function" ? options.publish : () => {};
  const watchFile = typeof options.watchFile === "function" ? options.watchFile : fs.watchFile.bind(fs);
  const unwatchFile = typeof options.unwatchFile === "function" ? options.unwatchFile : fs.unwatchFile.bind(fs);
  const threads = new Map();
  const latestStatuses = new Map();

  function threadKey(threadId, hostId) {
    return `${hostId}\u0000${threadId}`;
  }

  function statusMessage(threadId, hostId, status) {
    return {
      channel: "thread-status-evidence",
      payload: {
        type: "mcp-notification",
        hostId,
        method: "thread/status/changed",
        params: { threadId, status },
      },
    };
  }

  function publishStatus(thread, status) {
    const previous = latestStatuses.get(thread.key);
    if (previous?.type === status.type) return;
    latestStatuses.set(thread.key, status);
    publish(statusMessage(thread.threadId, thread.hostId, status));
  }

  function readAppendedText(filePath, start, end) {
    const length = end - start;
    if (length <= 0) return "";
    const fileDescriptor = fs.openSync(filePath, "r");
    try {
      const buffer = Buffer.allocUnsafe(length);
      fs.readSync(fileDescriptor, buffer, 0, length, start);
      return buffer.toString("utf8");
    } finally {
      fs.closeSync(fileDescriptor);
    }
  }

  function refreshThread(threadId, hostId = "local") {
    const key = threadKey(threadId, hostId);
    const thread = threads.get(key);
    if (!thread) return false;
    const resolvedPath = resolveSessionFile(threadId, hostId);
    if (!resolvedPath) {
      publishStatus(thread, { type: "notLoaded" });
      return false;
    }

    let stat;
    try {
      stat = fs.statSync(resolvedPath);
    } catch {
      publishStatus(thread, { type: "notLoaded" });
      return false;
    }

    if (thread.filePath !== resolvedPath || thread.offset == null || stat.size < thread.offset) {
      if (thread.filePath && thread.filePath !== resolvedPath && thread.watching) {
        unwatchFile(thread.filePath, thread.onChange);
        thread.watching = false;
      }
      thread.filePath = resolvedPath;
      thread.offset = stat.size;
      thread.tail = "";
      publishStatus(thread, readLatestTranscriptStatus(resolvedPath));
      if (!thread.watching) {
        thread.onChange = () => refreshThread(thread.threadId, thread.hostId);
        watchFile(resolvedPath, { interval: 1_000, persistent: false }, thread.onChange);
        thread.watching = true;
      }
      return true;
    }

    if (stat.size === thread.offset) return true;
    let text;
    try {
      text = `${thread.tail}${readAppendedText(resolvedPath, thread.offset, stat.size)}`;
    } catch {
      publishStatus(thread, { type: "notLoaded" });
      return false;
    }
    thread.offset = stat.size;
    const lines = text.split("\n");
    thread.tail = text.endsWith("\n") ? "" : lines.pop() || "";
    for (const line of lines) {
      const status = lifecycleStatusFromLine(line);
      if (status) publishStatus(thread, status);
    }
    return true;
  }

  function observeThread(threadId, hostId = "local") {
    if (typeof threadId !== "string" || !threadId || hostId !== "local") return false;
    const key = threadKey(threadId, hostId);
    if (!threads.has(key)) {
      threads.set(key, { key, threadId, hostId, filePath: "", offset: null, tail: "", watching: false, onChange: null });
    }
    refreshThread(threadId, hostId);
    return true;
  }

  function forgetThread(threadId, hostId = "local") {
    const key = threadKey(threadId, hostId);
    const thread = threads.get(key);
    if (!thread) return false;
    if (thread.filePath && thread.watching) unwatchFile(thread.filePath, thread.onChange);
    threads.delete(key);
    latestStatuses.delete(key);
    return true;
  }

  function observeSidebarBootstrap(bootstrap) {
    const snapshot = bootstrap?.catalogSnapshot;
    const entries = snapshot?.entries;
    if (!Array.isArray(entries)) return 0;
    const currentKeys = new Set();
    for (const entry of entries) {
      const threadId = entry?.threadId || entry?.conversationId;
      const hostId = entry?.hostId || "local";
      if (typeof threadId !== "string" || !threadId || hostId !== "local") continue;
      currentKeys.add(threadKey(threadId, hostId));
      observeThread(threadId, hostId);
    }
    if (snapshot.isComplete === true) {
      for (const thread of [...threads.values()]) {
        if (!currentKeys.has(thread.key)) forgetThread(thread.threadId, thread.hostId);
      }
    }
    return currentKeys.size;
  }

  function replayMessages() {
    return [...latestStatuses.entries()]
      .map(([key, status]) => ({ thread: threads.get(key), status }))
      .filter(({ thread }) => !!thread)
      .map(({ thread, status }) => statusMessage(thread.threadId, thread.hostId, status));
  }

  function stop() {
    for (const thread of [...threads.values()]) forgetThread(thread.threadId, thread.hostId);
  }

  return {
    forgetThread,
    observeSidebarBootstrap,
    observeThread,
    refreshThread,
    replayMessages,
    stop,
  };
}

module.exports = {
  createTranscriptStatusObserver,
  readLatestTranscriptStatus,
  resolveTranscriptPath,
};
