const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { createBoundedLogWriter, resolveLogMaxBytes } = require("../log-writer.cjs");

function tempLogPath(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodex-log-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "gateway.log");
}

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

async function waitFor(assertion, timeoutMs = 1_000) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError;
}

function createWriter(t, options = {}) {
  const writer = createBoundedLogWriter({
    flushIntervalMs: 60_000,
    flushBatchBytes: 1_024 * 1_024,
    ...options,
  });
  t.after(() => writer.close());
  return writer;
}

test("ordinary append waits for an explicit flush before touching disk", async (t) => {
  const logPath = tempLogPath(t);
  const writer = createWriter(t);

  writer.append(logPath, "hello\n");
  assert.equal(fs.existsSync(logPath), false);

  await writer.flush();
  assert.equal(readText(logPath), "hello\n");
});

test("rotates to a single old file and replaces it on the next rotation", async (t) => {
  const logPath = tempLogPath(t);
  const writer = createWriter(t, { maxBytes: 30 });

  writer.append(logPath, `${"a".repeat(20)}\n`);
  await writer.flush();
  writer.append(logPath, `${"b".repeat(20)}\n`);
  await writer.flush();

  assert.equal(readText(logPath), `${"b".repeat(20)}\n`);
  assert.equal(readText(`${logPath}.old`), `${"a".repeat(20)}\n`);

  writer.append(logPath, `${"c".repeat(20)}\n`);
  await writer.flush();

  assert.equal(readText(logPath), `${"c".repeat(20)}\n`);
  assert.equal(readText(`${logPath}.old`), `${"b".repeat(20)}\n`);
  assert.deepEqual(fs.readdirSync(path.dirname(logPath)).sort(), ["gateway.log", "gateway.log.old"]);
});

test("urgent append triggers an immediate asynchronous flush", async (t) => {
  const logPath = tempLogPath(t);
  const writer = createWriter(t, { flushIntervalMs: 60_000 });

  writer.append(logPath, "urgent\n", { urgent: true });

  await waitFor(() => {
    assert.equal(readText(logPath), "urgent\n");
  });
});

test("urgent append during an active flush causes a follow-up flush", async (t) => {
  const logPath = tempLogPath(t);
  let releaseFirstWrite;
  let startedFirstWrite;
  const firstWriteStarted = new Promise((resolve) => {
    startedFirstWrite = resolve;
  });
  let appendFileCalls = 0;
  const delayedFs = {
    ...fs,
    promises: {
      ...fs.promises,
      appendFile: async (...args) => {
        appendFileCalls += 1;
        if (appendFileCalls === 1) {
          startedFirstWrite();
          await new Promise((resolve) => {
            releaseFirstWrite = resolve;
          });
        }
        return fs.promises.appendFile(...args);
      },
    },
  };
  const writer = createWriter(t, { fileSystem: delayedFs });

  writer.append(logPath, "first\n");
  const flushPromise = writer.flush();
  await firstWriteStarted;

  writer.append(logPath, "second\n", { urgent: true });
  releaseFirstWrite();
  await flushPromise;

  assert.equal(readText(logPath), "first\nsecond\n");
});

test("drops old buffered entries when the in-memory queue is too large", async (t) => {
  const logPath = tempLogPath(t);
  const writer = createWriter(t, {
    bufferMaxBytes: 72,
    bufferKeepBytes: 36,
  });

  for (let index = 0; index < 10; index += 1) {
    writer.append(logPath, `line-${index}-xxxxxxxx\n`);
  }
  await writer.flush();

  const text = readText(logPath);
  assert.match(text, /dropped buffered log entries/);
  assert.doesNotMatch(text, /line-0-/);
  assert.match(text, /line-9-/);
});

test("resolves log size limits from OPENCODEX_LOG_MAX_MB", () => {
  assert.equal(resolveLogMaxBytes({}), 10 * 1_024 * 1_024);
  assert.equal(resolveLogMaxBytes({ OPENCODEX_LOG_MAX_MB: "0.5" }), 512 * 1_024);
  assert.equal(resolveLogMaxBytes({ OPENCODEX_LOG_MAX_MB: "2" }), 2 * 1_024 * 1_024);
  assert.equal(resolveLogMaxBytes({ OPENCODEX_LOG_MAX_MB: "invalid" }), 10 * 1_024 * 1_024);
  assert.equal(resolveLogMaxBytes({ OPENCODEX_LOG_MAX_MB: "0" }), 10 * 1_024 * 1_024);
  assert.equal(resolveLogMaxBytes({ OPENCODEX_LOG_MAX_MB: "-1" }), 10 * 1_024 * 1_024);
});

test("keeps a single log entry intact even when it is larger than the limit", async (t) => {
  const logPath = tempLogPath(t);
  const writer = createWriter(t, { maxBytes: 10 });
  const largeLine = `${"x".repeat(64)}\n`;

  writer.append(logPath, largeLine);
  await writer.flush();

  assert.equal(readText(logPath), largeLine);
  assert.equal(fs.existsSync(`${logPath}.old`), false);
});
