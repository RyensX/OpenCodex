const fs = require("fs");
const path = require("path");

const DEFAULT_LOG_MAX_MB = 10;
const LOG_FLUSH_INTERVAL_MS = 2_000;
const LOG_FLUSH_BATCH_BYTES = 256 * 1_024;
const LOG_BUFFER_MAX_BYTES = 2 * 1_024 * 1_024;
const LOG_BUFFER_KEEP_BYTES = 1 * 1_024 * 1_024;
const LOG_MAX_MB_ENV = "OPENCODEX_LOG_MAX_MB";

function byteLength(value) {
  // 文件大小和缓冲阈值都按 UTF-8 字节计算，避免中文日志按字符数估算偏小。
  return Buffer.byteLength(String(value || ""), "utf8");
}

function resolveLogMaxBytes(env = process.env) {
  // 只暴露 MB 级配置给用户；非法值统一回退默认值，避免把日志上限解析成 0。
  const value = Number(env && env[LOG_MAX_MB_ENV]);
  const maxMb = Number.isFinite(value) && value > 0 ? value : DEFAULT_LOG_MAX_MB;
  return Math.max(1, Math.floor(maxMb * 1_024 * 1_024));
}

function maybeUnref(timer) {
  // 日志 flush 定时器不应该阻止 Launcher 进程自然退出。
  if (timer && typeof timer.unref === "function") timer.unref();
}

function errorCode(error) {
  return error && typeof error === "object" ? error.code : "";
}

async function statOrNull(fileSystem, filePath) {
  try {
    return await fileSystem.promises.stat(filePath);
  } catch (error) {
    // 日志文件首次写入前不存在是正常状态，调用方按空文件处理即可。
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

function statOrNullSync(fileSystem, filePath) {
  try {
    return fileSystem.statSync(filePath);
  } catch (error) {
    // 同步 flush 也复用相同语义：文件不存在不算写入失败。
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

async function rotateLogIfNeeded(fileSystem, logPath, nextBytes, maxBytes) {
  const stat = await statOrNull(fileSystem, logPath);
  if (!stat || stat.size + nextBytes <= maxBytes) return;

  const oldPath = `${logPath}.old`;
  try {
    // 单备份策略：新一轮轮转前先移除更老的日志，保证最多只有两个文件。
    await fileSystem.promises.rm(oldPath, { force: true });
  } catch {}
  try {
    await fileSystem.promises.rename(logPath, oldPath);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

function rotateLogIfNeededSync(fileSystem, logPath, nextBytes, maxBytes) {
  const stat = statOrNullSync(fileSystem, logPath);
  if (!stat || stat.size + nextBytes <= maxBytes) return;

  const oldPath = `${logPath}.old`;
  try {
    // 退出路径同样只保留一个 .old，避免同步 flush 破坏文件数量约束。
    fileSystem.rmSync(oldPath, { force: true });
  } catch {}
  try {
    fileSystem.renameSync(logPath, oldPath);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

function dropOldBufferedEntries(state, options) {
  if (state.pendingBytes <= options.bufferMaxBytes) return;

  let droppedEntries = 0;
  let droppedBytes = 0;
  // 队列过大时丢弃旧日志，保证日志系统不会因为磁盘过慢持续吃内存。
  while (state.queue.length > 1 && state.pendingBytes > options.bufferKeepBytes) {
    const entry = state.queue.shift();
    state.pendingBytes -= entry.bytes;
    droppedEntries += 1;
    droppedBytes += entry.bytes;
  }
  if (droppedEntries === 0) return;

  state.droppedEntries += droppedEntries;
  state.droppedBytes += droppedBytes;
  state.dropSummaryLogPath = state.queue[0] ? state.queue[0].logPath : state.dropSummaryLogPath;
}

function takeFlushBatch(state) {
  if (state.queue.length === 0 && state.droppedEntries === 0) return null;

  // flush 时一次性接管当前队列；期间新 append 的日志会进入下一批，避免长时间持有可变数组。
  const entries = state.queue.splice(0, state.queue.length);
  state.pendingBytes = 0;

  if (state.droppedEntries > 0 && (entries.length > 0 || state.dropSummaryLogPath)) {
    const logPath = entries[0] ? entries[0].logPath : state.dropSummaryLogPath;
    // 丢弃旧缓冲后补一条摘要，让排障时能看到日志中间发生过背压。
    const line = `[launcher] dropped buffered log entries: count=${state.droppedEntries} bytes=${state.droppedBytes}\n`;
    entries.unshift({ logPath, line, bytes: byteLength(line) });
    state.droppedEntries = 0;
    state.droppedBytes = 0;
    state.dropSummaryLogPath = "";
  }

  return entries.length > 0 ? entries : null;
}

function groupEntriesByPath(entries) {
  const groups = [];
  for (const entry of entries) {
    const last = groups[groups.length - 1];
    if (last && last.logPath === entry.logPath) {
      // 相邻同路径日志合并成一次 appendFile，减少高频日志造成的持续小写入。
      last.lines.push(entry.line);
      last.bytes += entry.bytes;
    } else {
      groups.push({ logPath: entry.logPath, lines: [entry.line], bytes: entry.bytes });
    }
  }
  return groups;
}

function createBoundedLogWriter(options = {}) {
  const fileSystem = options.fileSystem || fs;
  const config = {
    env: options.env || process.env,
    flushIntervalMs: Math.max(0, Number(options.flushIntervalMs ?? LOG_FLUSH_INTERVAL_MS)),
    flushBatchBytes: Math.max(1, Number(options.flushBatchBytes ?? LOG_FLUSH_BATCH_BYTES)),
    bufferMaxBytes: Math.max(1, Number(options.bufferMaxBytes ?? LOG_BUFFER_MAX_BYTES)),
    bufferKeepBytes: Math.max(1, Number(options.bufferKeepBytes ?? LOG_BUFFER_KEEP_BYTES)),
    maxBytes: Number.isFinite(options.maxBytes) && options.maxBytes > 0 ? Math.floor(options.maxBytes) : null,
  };
  // keep 阈值不能大于 max，否则背压触发后无法真正把队列压回安全范围。
  if (config.bufferKeepBytes > config.bufferMaxBytes) config.bufferKeepBytes = config.bufferMaxBytes;

  const state = {
    queue: [],
    pendingBytes: 0,
    droppedEntries: 0,
    droppedBytes: 0,
    dropSummaryLogPath: "",
    flushTimer: null,
    // activeFlush 用来串行化异步写入，避免两个 flush 同时轮转同一个 gateway.log。
    activeFlush: null,
    // flushAgain 表示当前写盘期间又来了 urgent 或大批量日志，结束后需要立刻补一轮。
    flushAgain: false,
    closed: false,
  };

  function maxBytes() {
    return config.maxBytes || resolveLogMaxBytes(config.env);
  }

  function clearFlushTimer() {
    if (!state.flushTimer) return;
    clearTimeout(state.flushTimer);
    state.flushTimer = null;
  }

  async function writeEntries(entries) {
    for (const group of groupEntriesByPath(entries)) {
      const content = group.lines.join("");
      await fileSystem.promises.mkdir(path.dirname(group.logPath), { recursive: true });
      // 轮转只在后台 flush 执行，appendLog 调用路径不会被 stat/rename/write 阻塞。
      await rotateLogIfNeeded(fileSystem, group.logPath, group.bytes, maxBytes());
      await fileSystem.promises.appendFile(group.logPath, content, "utf8");
    }
  }

  function writeEntriesSync(entries) {
    for (const group of groupEntriesByPath(entries)) {
      const content = group.lines.join("");
      fileSystem.mkdirSync(path.dirname(group.logPath), { recursive: true });
      // 同步写盘只用于退出和已捕获异常，优先保留故障现场日志。
      rotateLogIfNeededSync(fileSystem, group.logPath, group.bytes, maxBytes());
      fileSystem.appendFileSync(group.logPath, content, "utf8");
    }
  }

  function scheduleFlush(immediate) {
    if (state.closed) return;
    if (state.activeFlush) {
      // 写盘中收到 urgent 不并发开新写入，而是标记当前 flush 完成后马上续写。
      if (immediate || state.pendingBytes >= config.flushBatchBytes) state.flushAgain = true;
      return;
    }

    if (immediate || state.pendingBytes >= config.flushBatchBytes) {
      clearFlushTimer();
      // urgent 仍保持异步，用 0ms timer 跳过普通 2s 等待但不阻塞调用方。
      state.flushTimer = setTimeout(() => {
        state.flushTimer = null;
        void flush();
      }, 0);
      maybeUnref(state.flushTimer);
      return;
    }

    if (state.flushTimer) return;
    // 普通日志走低频定时 flush，减少持续小块磁盘写入。
    state.flushTimer = setTimeout(() => {
      state.flushTimer = null;
      void flush();
    }, config.flushIntervalMs);
    maybeUnref(state.flushTimer);
  }

  function append(logPath, line, appendOptions = {}) {
    if (!logPath || state.closed) return;
    const text = String(line || "");
    const entry = { logPath, line: text, bytes: byteLength(text) };
    state.queue.push(entry);
    state.pendingBytes += entry.bytes;
    state.dropSummaryLogPath = logPath;
    dropOldBufferedEntries(state, config);
    // 普通路径只安排后台 flush，不做任何文件系统操作，避免日志调用方被磁盘拖慢。
    scheduleFlush(Boolean(appendOptions.urgent));
  }

  function flush() {
    clearFlushTimer();
    if (state.activeFlush) {
      // 外部显式 flush 等待当前写盘，并要求当前写盘后继续检查新增队列。
      state.flushAgain = true;
      return state.activeFlush;
    }

    state.activeFlush = (async () => {
      try {
        do {
          state.flushAgain = false;
          const entries = takeFlushBatch(state);
          if (!entries) break;
          await writeEntries(entries);
        } while (state.flushAgain);
      } catch {
        // 日志系统不能影响 Launcher 主流程；失败时丢弃本批日志并等待后续日志再次触发写入。
      } finally {
        state.activeFlush = null;
        if (!state.closed && state.queue.length > 0) {
          // flush 失败或写盘期间有新日志时，按当前队列大小重新选择立即/定时写入。
          scheduleFlush(state.pendingBytes >= config.flushBatchBytes);
        }
      }
    })();
    return state.activeFlush;
  }

  function flushSync() {
    clearFlushTimer();
    const entries = takeFlushBatch(state);
    if (!entries) return;
    try {
      writeEntriesSync(entries);
    } catch {
      // 退出或异常路径只能尽力写日志，失败时保持和旧实现一致：不抛出。
    }
  }

  function close() {
    state.closed = true;
    // close 用于生命周期收尾，清掉 timer 后同步写掉剩余缓冲。
    flushSync();
  }

  return {
    append,
    close,
    flush,
    flushSync,
    _state: state,
  };
}

module.exports = {
  DEFAULT_LOG_MAX_MB,
  LOG_BUFFER_KEEP_BYTES,
  LOG_BUFFER_MAX_BYTES,
  LOG_FLUSH_BATCH_BYTES,
  LOG_FLUSH_INTERVAL_MS,
  LOG_MAX_MB_ENV,
  createBoundedLogWriter,
  resolveLogMaxBytes,
};
