const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const test = require("node:test");
const { openFileTargetFromIpc } = require("../runtime/ipc/open-file-context.cjs");
const {
  createIpcFrameParser,
  createOfficialLiveObserver,
  encodeIpcFrame,
  __test: observerTest,
} = require("../runtime/ipc/official-live-observer.cjs");
const { __test, requestContext } = require("../runtime/ipc/official-runtime.cjs");
const { __test: portableRunnerTest } = require("../runner/platform/portable.cjs");

function threadStreamStateMessage(conversationId, sourceClientId, change) {
  return {
    type: "broadcast",
    method: "thread-stream-state-changed",
    sourceClientId,
    params: { conversationId, hostId: "local", change },
  };
}

test("bridges only the primary official renderer to the Web client", () => {
  const primary = { id: 1, isDestroyed: () => false };
  const samePrimaryWrapper = { id: 1, isDestroyed: () => false };
  const auxiliary = { id: 2, isDestroyed: () => false };

  assert.equal(__test.shouldBridgeOfficialWebContents(primary, null), true);
  assert.equal(__test.shouldBridgeOfficialWebContents(samePrimaryWrapper, primary), true);
  assert.equal(__test.shouldBridgeOfficialWebContents(auxiliary, primary), false);
  assert.equal(
    __test.shouldBridgeOfficialWebContents(auxiliary, { id: 1, isDestroyed: () => true }),
    true
  );
});

test("remote file manager interception condition is target and host based", () => {
  assert.equal(
    __test.shouldInterceptRemoteFileManagerStore({
      isLoopbackBrowserHost: false,
      openFileTarget: "fileManager",
    }),
    true
  );
  assert.equal(
    __test.shouldInterceptRemoteFileManagerStore({
      isLoopbackBrowserHost: true,
      openFileTarget: "fileManager",
    }),
    false
  );
  assert.equal(
    __test.shouldInterceptRemoteFileManagerStore({
      isLoopbackBrowserHost: false,
      openFileTarget: "vscode",
    }),
    false
  );
});

test("recognizes platform file manager spawn targets", () => {
  // macOS 官方实现用 open -R 定位文件；其它平台适配只负责提取路径，业务条件仍由统一 helper 判断。
  assert.equal(__test.fileManagerPathFromSpawn("open", ["-R", "/tmp/report.txt"]), "/tmp/report.txt");
  assert.equal(__test.fileManagerPathFromSpawn("open", ["/tmp/report.txt"]), "");
  assert.equal(__test.fileManagerPathFromSpawn("xdg-open", ["/tmp/report.txt"]), "/tmp/report.txt");
  assert.equal(__test.fileManagerPathFromSpawn("node", ["script.js"]), "");
});

test("recognizes app-server after official Codex global options", () => {
  // 官方 Desktop 会按版本在子命令前插入全局配置，hook 需要兼容两种参数布局。
  assert.equal(__test.isHiddenOfficialAppServerArgs(["app-server", "--analytics-default-enabled"]), true);
  assert.equal(
    __test.isHiddenOfficialAppServerArgs([
      "-c",
      "features.code_mode_host=true",
      "app-server",
      "--analytics-default-enabled",
    ]),
    true
  );
  assert.equal(__test.isHiddenOfficialAppServerArgs(["exec", "app-server-like-value"]), false);
});

test("vscode fetch open-file payloads feed the same interception condition", () => {
  const openFileTarget = openFileTargetFromIpc("codex_desktop:message-from-view", {
    type: "fetch",
    url: "vscode://codex/open-file",
    body: JSON.stringify({ path: "/tmp/report.txt", target: "fileManager" }),
  });
  assert.equal(
    __test.shouldInterceptRemoteFileManagerStore({
      isLoopbackBrowserHost: false,
      openFileTarget,
    }),
    true
  );
});

test("falls back to read/write copy for WindowsApps encrypted runtime files", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodex-runner-copy-"));
  const sourcePath = path.join(tmpDir, "chrome.dll");
  const targetPath = path.join(tmpDir, "runner", "chrome.dll");
  const previousCpSync = fs.cpSync;
  const logs = [];
  try {
    fs.writeFileSync(sourcePath, "encrypted-runtime-content");
    fs.cpSync = () => {
      const error = new Error("UNKNOWN: unknown error, copyfile");
      error.code = "UNKNOWN";
      throw error;
    };

    const result = portableRunnerTest.copyPortableRuntimeEntry({
      entry: {
        name: "chrome.dll",
        isFile: () => true,
      },
      sourcePath,
      targetPath,
      logger: (line) => logs.push(line),
      platform: "win32",
    });

    assert.deepEqual(result, { copied: true, synthesized: false });
    assert.equal(fs.readFileSync(targetPath, "utf8"), "encrypted-runtime-content");
    assert.match(logs.join(""), /read\/write fallback/);
  } finally {
    fs.cpSync = previousCpSync;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("falls back to recursive read/write copy for WindowsApps encrypted runtime directories", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodex-runner-dir-"));
  const sourcePath = path.join(tmpDir, "angledata");
  const targetPath = path.join(tmpDir, "runner", "angledata");
  const previousCpSync = fs.cpSync;
  const logs = [];
  try {
    fs.mkdirSync(sourcePath, { recursive: true });
    fs.writeFileSync(path.join(sourcePath, "VkICD_mock_icd.json"), "{\"ok\":true}");
    fs.cpSync = () => {
      const error = new Error("UNKNOWN: unknown error, copyfile");
      error.code = "UNKNOWN";
      throw error;
    };

    const result = portableRunnerTest.copyPortableRuntimeEntry({
      entry: {
        name: "angledata",
        isFile: () => false,
        isDirectory: () => true,
      },
      sourcePath,
      targetPath,
      logger: (line) => logs.push(line),
      platform: "win32",
    });

    assert.deepEqual(result, { copied: true, synthesized: false });
    assert.equal(fs.readFileSync(path.join(targetPath, "VkICD_mock_icd.json"), "utf8"), "{\"ok\":true}");
    assert.match(logs.join(""), /Windows directory/);
  } finally {
    fs.cpSync = previousCpSync;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("falls back to read/write copy for WindowsApps encrypted runner executable", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodex-runner-exe-"));
  const sourcePath = path.join(tmpDir, "Codex.exe");
  const targetPath = path.join(tmpDir, "OpenCodex.exe");
  const previousCopyFileSync = fs.copyFileSync;
  try {
    fs.writeFileSync(sourcePath, "encrypted-exe-content");
    fs.copyFileSync = () => {
      const error = new Error("UNKNOWN: unknown error, copyfile");
      error.code = "UNKNOWN";
      throw error;
    };

    portableRunnerTest.copyPortableRuntimeExecutable({
      sourcePath,
      targetPath,
      platform: "win32",
    });

    assert.equal(fs.readFileSync(targetPath, "utf8"), "encrypted-exe-content");
  } finally {
    fs.copyFileSync = previousCopyFileSync;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("sidebar bootstrap accepts only the synchronous renderer-safe shape", () => {
  const bootstrap = {
    catalogSnapshot: { revision: 7, isComplete: true, hosts: [], entries: [] },
    globalStateEntries: [{ key: "pinned-thread-ids", value: [] }],
    projectlessWorkspaceRoot: { workspaceRoot: null },
    workspaceRootOptions: [],
  };

  // 合法快照必须原样保留；Promise 或缺失数组字段都不能交给 renderer 同步遍历。
  assert.equal(__test.normalizeInitialSidebarBootstrap(bootstrap), bootstrap);
  assert.equal(__test.normalizeInitialSidebarBootstrap(Promise.resolve(bootstrap)), null);
  assert.equal(__test.normalizeInitialSidebarBootstrap({ globalStateEntries: {} }), null);
  assert.equal(__test.normalizeInitialSidebarBootstrap(null), null);
});

test("uses the Desktop named pipe on Windows", () => {
  assert.deepEqual(__test.officialDesktopIpcSocketPaths("win32"), ["\\\\.\\pipe\\codex-ipc"]);
  assert.match(__test.officialDesktopIpcSocketPaths("darwin")[0], /ipc[\\/]ipc\.sock$/);
});

test("official IPC parser handles fragmented headers and payloads", () => {
  const messages = [];
  const errors = [];
  const parser = createIpcFrameParser((message) => messages.push(message), (error) => errors.push(error));
  const first = encodeIpcFrame({ type: "first", payload: "x".repeat(32) });
  const second = encodeIpcFrame({ type: "second" });

  parser.consume(first.subarray(0, 2));
  parser.consume(first.subarray(2, 9));
  parser.consume(Buffer.concat([first.subarray(9), second]));

  assert.deepEqual(messages, [
    { type: "first", payload: "x".repeat(32) },
    { type: "second" },
  ]);
  assert.deepEqual(errors, []);
});

test("official observer caps reconnect backoff and treats an absent Desktop socket as expected", () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4].map((attempt) => observerTest.reconnectDelayForAttempt(5_000, 30_000, attempt)),
    [5_000, 10_000, 20_000, 30_000, 30_000]
  );
  assert.equal(observerTest.isExpectedSocketUnavailableError({ code: "ENOENT" }), true);
  assert.equal(observerTest.isExpectedSocketUnavailableError({ code: "ECONNREFUSED" }), true);
  assert.equal(observerTest.isExpectedSocketUnavailableError({ code: "EACCES" }), false);
});

test("official observer suppresses expected connection errors when Desktop is not running", () => {
  const { EventEmitter } = require("node:events");
  const errors = [];
  const socket = new EventEmitter();
  socket.writable = true;
  socket.destroyed = false;
  socket.destroy = () => {
    socket.destroyed = true;
  };
  const observer = createOfficialLiveObserver({
    socketPaths: ["/tmp/missing-codex.sock"],
    socketFactory: () => socket,
    onError: (error) => errors.push(error),
    reconnectDelayMs: -1,
  });

  observer.start();
  socket.emit("error", Object.assign(new Error("missing"), { code: "ENOENT" }));

  assert.deepEqual(errors, []);
  observer.stop();
});

test("sidebar bootstrap reconciles threads that are no longer visible", () => {
  const observer = createOfficialLiveObserver({ reconnectDelayMs: -1 });
  observer.observeSidebarBootstrap({
    catalogSnapshot: { isComplete: true, entries: [{ threadId: "thread-old" }, { threadId: "thread-kept" }] },
  });
  observer.observeSidebarBootstrap({
    catalogSnapshot: { isComplete: true, entries: [{ threadId: "thread-kept" }, { threadId: "thread-new" }] },
  });

  assert.deepEqual([...observer.__test.getKnownThreads().keys()], ["local\u0000thread-kept", "local\u0000thread-new"]);
  observer.stop();
});

test("official chunked messages are acknowledged and restored before browser routing", () => {
  const receiver = new __test.OfficialChunkedMessageReceiver();
  const marker = "codex-host-chunked-message-v1";

  const started = receiver.receive({
    marker,
    transferId: "transfer-1",
    sequence: 4,
    kind: "start",
  });
  assert.deepEqual(started, {
    type: "pending",
    acknowledgement: { transferId: "transfer-1", sequence: 4 },
  });

  const chunked = receiver.receive({
    marker,
    transferId: "transfer-1",
    sequence: 5,
    kind: "chunk",
    tokens: [
      { type: "object-start" },
      { type: "key", value: "type" },
      { type: "value", value: "fetch-response" },
      { type: "key", value: "body" },
      { type: "string-start", target: "value" },
      { type: "string-chunk", value: "large-" },
      { type: "string-chunk", value: "payload" },
      { type: "string-end" },
      { type: "key", value: "optional" },
      // 官方协议用缺失 value 字段表示 undefined，接收器必须保留而不是拒绝整个分块。
      { type: "value" },
      { type: "container-end" },
    ],
  });
  assert.deepEqual(chunked, {
    type: "pending",
    acknowledgement: { transferId: "transfer-1", sequence: 5 },
  });

  const completed = receiver.receive({
    marker,
    transferId: "transfer-1",
    sequence: 6,
    kind: "end",
  });
  assert.deepEqual(completed, {
    type: "complete",
    acknowledgement: { transferId: "transfer-1", sequence: 6 },
    message: { type: "fetch-response", body: "large-payload", optional: undefined },
  });
});

test("official chunk receiver rejects an out-of-order continuation without acknowledging it", () => {
  const receiver = new __test.OfficialChunkedMessageReceiver();
  const marker = "codex-host-chunked-message-v1";
  receiver.receive({ marker, transferId: "transfer-2", sequence: 0, kind: "start" });

  // 序号不连续时必须和官方 preload 一样停止确认，避免把已损坏的消息误组装后交给 renderer。
  assert.deepEqual(
    receiver.receive({
      marker,
      transferId: "transfer-2",
      sequence: 2,
      kind: "chunk",
      tokens: [{ type: "value", value: null }],
    }),
    { type: "pending", acknowledgement: null }
  );
});

test("official live observer follows known threads without sending control requests", () => {
  const { EventEmitter } = require("node:events");
  const writes = [];
  const published = [];
  const socket = new EventEmitter();
  socket.writable = true;
  socket.destroyed = false;
  socket.write = (frame) => writes.push(JSON.parse(frame.subarray(4).toString("utf8")));
  socket.destroy = () => {
    socket.destroyed = true;
  };

  const observer = createOfficialLiveObserver({
    socketPaths: ["/tmp/original-codex.sock"],
    socketFactory: () => socket,
    publish: (payload) => published.push(payload),
    reconnectDelayMs: -1,
  });

  observer.start();
  observer.observeThread("thread-known");
  socket.emit("connect");
  socket.emit(
    "data",
    encodeIpcFrame({
      type: "response",
      method: "initialize",
      resultType: "success",
      handledByClientId: "observer-client",
    })
  );

  assert.deepEqual(
    writes.map((message) => message.method),
    ["initialize", "thread-stream-following-changed"]
  );
  assert.equal(writes.some((message) => String(message.method).startsWith("thread-follower-")), false);

  socket.emit(
    "data",
    encodeIpcFrame({
      type: "broadcast",
      method: "thread-stream-state-changed",
      sourceClientId: "desktop-owner",
      params: {
        conversationId: "thread-known",
        hostId: "local",
        change: { type: "snapshot", revision: 1 },
      },
    })
  );
  assert.equal(published.at(-1).channel, "thread-stream-state-changed");
  assert.equal(observer.__test.getActiveOwners().get("local\u0000thread-known"), "desktop-owner");

  const followingCountBeforeSnapshot = writes.filter(
    (message) => message.method === "thread-stream-following-changed"
  ).length;
  socket.emit(
    "data",
    encodeIpcFrame({
      type: "broadcast",
      method: "thread-stream-state-changed",
      params: {
        conversationId: "thread-snapshot-first",
        hostId: "local",
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: { threadRuntimeStatus: { type: "idle" } },
        },
      },
    })
  );
  socket.emit(
    "data",
    encodeIpcFrame({
      type: "broadcast",
      method: "thread-stream-following-status-requested",
      params: { conversationId: "thread-snapshot-first", hostId: "local" },
    })
  );
  const snapshotFollowingMessages = writes.filter(
    (message) =>
      message.method === "thread-stream-following-changed" &&
      message.params.conversationId === "thread-snapshot-first"
  );
  assert.equal(snapshotFollowingMessages.length, 1);
  assert.equal(
    writes.filter((message) => message.method === "thread-stream-following-changed").length,
    followingCountBeforeSnapshot + 1
  );

  socket.emit(
    "data",
    encodeIpcFrame({
      type: "broadcast",
      method: "thread-stream-following-status-requested",
      sourceClientId: "desktop-owner",
      params: { conversationId: "thread-second", hostId: "local" },
    })
  );
  assert.equal(writes.at(-1).method, "thread-stream-following-changed");
  assert.equal(writes.at(-1).params.conversationId, "thread-second");
  socket.emit(
    "data",
    encodeIpcFrame({
      type: "broadcast",
      method: "thread-stream-state-changed",
      sourceClientId: "desktop-owner",
      params: {
        conversationId: "thread-second",
        hostId: "local",
        change: { type: "snapshot", revision: 1 },
      },
    })
  );
  socket.emit(
    "data",
    encodeIpcFrame({
      type: "broadcast",
      method: "client-status-changed",
      params: { clientId: "desktop-owner", status: "disconnected" },
    })
  );
  assert.equal(observer.__test.getActiveOwners().size, 0);
  assert.equal(published.at(-1).channel, "client-status-changed");
  assert.equal(
    published.filter((payload) => payload.channel === "client-status-changed").length,
    1
  );
  assert.deepEqual(
    published
      .filter((payload) => payload.channel === "thread-status-evidence")
      .map((payload) => payload.payload.params),
    [
      { threadId: "thread-known", status: { type: "notLoaded" } },
      { threadId: "thread-snapshot-first", status: { type: "idle" } },
      { threadId: "thread-second", status: { type: "notLoaded" } },
    ]
  );
  observer.stop();
});

test("official live observer uses a unique initialize request id across instances", () => {
  const { EventEmitter } = require("node:events");

  function initializeRequestId() {
    const writes = [];
    const socket = new EventEmitter();
    socket.writable = true;
    socket.destroyed = false;
    socket.write = (frame) => writes.push(JSON.parse(frame.subarray(4).toString("utf8")));
    socket.destroy = () => {
      socket.destroyed = true;
    };
    const observer = createOfficialLiveObserver({
      socketPaths: ["/tmp/original-codex.sock"],
      socketFactory: () => socket,
      reconnectDelayMs: -1,
    });

    observer.start();
    socket.emit("connect");
    observer.stop();
    return writes[0].requestId;
  }

  assert.notEqual(initializeRequestId(), initializeRequestId());
});

test("restores an active thread from the latest transcript lifecycle event", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "opencodex-transcript-status-"));
  const filePath = path.join(directory, "thread-active.jsonl");
  t.after(() => fs.rmSync(directory, { recursive: true }));
  fs.writeFileSync(
    filePath,
    [
      JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "turn-2" } }),
      JSON.stringify({ type: "response_item", payload: { type: "reasoning" } }),
      "",
    ].join("\n")
  );

  assert.deepEqual(__test.readLatestTranscriptStatus?.(filePath), { type: "active", activeFlags: [] });
});

test("restores an idle thread from the latest transcript lifecycle event", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "opencodex-transcript-status-"));
  const filePath = path.join(directory, "thread-idle.jsonl");
  t.after(() => fs.rmSync(directory, { recursive: true }));
  fs.writeFileSync(
    filePath,
    [
      JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "turn_aborted", turn_id: "turn-1" } }),
      "",
    ].join("\n")
  );

  assert.deepEqual(__test.readLatestTranscriptStatus?.(filePath), { type: "idle" });
});

test("transcript status observer publishes and replays lifecycle changes", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "opencodex-transcript-observer-"));
  const filePath = path.join(directory, "thread-live.jsonl");
  t.after(() => fs.rmSync(directory, { recursive: true }));
  fs.writeFileSync(
    filePath,
    `${JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } })}\n`
  );
  const published = [];
  const observer = __test.createTranscriptStatusObserver?.({
    resolveSessionFile: () => filePath,
    publish: (message) => published.push(message),
    watchFile: () => {},
    unwatchFile: () => {},
  });

  assert.equal(observer?.observeThread("thread-live", "local"), true);
  assert.deepEqual(published.at(-1)?.payload.params.status, { type: "active", activeFlags: [] });

  fs.appendFileSync(
    filePath,
    `${JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1" } })}\n`
  );
  observer.refreshThread("thread-live", "local");

  assert.deepEqual(published.at(-1)?.payload.params.status, { type: "idle" });
  assert.deepEqual(observer.replayMessages().map((message) => message.payload.params.status), [{ type: "idle" }]);
  observer.stop();
});

test("resolves a transcript path from the Codex state database", (t) => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "opencodex-state-db-"));
  const sessionDirectory = path.join(codexHome, "sessions", "2026", "08", "01");
  const transcriptPath = path.join(sessionDirectory, "rollout-thread-db.jsonl");
  fs.mkdirSync(sessionDirectory, { recursive: true });
  fs.writeFileSync(transcriptPath, "");
  const database = new DatabaseSync(path.join(codexHome, "state_5.sqlite"));
  database.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)");
  database.prepare("INSERT INTO threads (id, rollout_path) VALUES (?, ?)").run("thread-db", transcriptPath);
  database.close();
  t.after(() => fs.rmSync(codexHome, { recursive: true }));

  assert.equal(__test.resolveTranscriptPath?.("thread-db", codexHome), transcriptPath);
});

test("official live observer forwards reset and clears active owners when the IPC disconnects", () => {
  const { EventEmitter } = require("node:events");
  const published = [];
  const socket = new EventEmitter();
  socket.writable = true;
  socket.destroyed = false;
  socket.write = () => true;
  socket.destroy = () => {
    socket.destroyed = true;
  };
  const observer = createOfficialLiveObserver({
    socketPaths: ["/tmp/original-codex.sock"],
    socketFactory: () => socket,
    publish: (payload) => published.push(payload),
    reconnectDelayMs: -1,
  });

  observer.start();
  observer.observeThread("thread-known");
  socket.emit("connect");
  socket.emit(
    "data",
    encodeIpcFrame({
      type: "response",
      method: "initialize",
      resultType: "success",
      handledByClientId: "observer-client",
    })
  );
  socket.emit(
    "data",
    encodeIpcFrame({
      type: "broadcast",
      method: "thread-stream-state-changed",
      sourceClientId: "desktop-owner",
      params: {
        conversationId: "thread-known",
        hostId: "local",
        change: { type: "snapshot", revision: 1 },
      },
    })
  );

  socket.emit("close");

  assert.equal(observer.__test.getActiveOwners().size, 0);
  assert.equal(published.at(-1).channel, "ipc-connection-reset");
  assert.deepEqual(
    published.find((payload) => payload.channel === "thread-status-evidence")?.payload.params,
    { threadId: "thread-known", status: { type: "notLoaded" } }
  );
  observer.stop();
});

test("official live observer forwards the authoritative thread read state", () => {
  const published = [];
  const observer = createOfficialLiveObserver({
    publish: (payload) => published.push(payload),
    reconnectDelayMs: -1,
  });

  observer.__test.handleMessage({
    type: "broadcast",
    method: "thread-read-state-changed",
    sourceClientId: "desktop-owner",
    params: {
      conversationId: "thread-unread",
      hostId: "local",
      hasUnreadTurn: true,
    },
  });

  assert.deepEqual(published.at(-1), {
      channel: "thread-read-state-changed",
      payload: {
        type: "broadcast",
        method: "thread-read-state-changed",
        sourceClientId: "desktop-owner",
        params: {
          conversationId: "thread-unread",
          hostId: "local",
          hasUnreadTurn: true,
        },
      },
    });
  observer.stop();
});

test("official live observer forwards the authoritative thread read acknowledgement", () => {
  const published = [];
  const observer = createOfficialLiveObserver({
    publish: (payload) => published.push(payload),
    reconnectDelayMs: -1,
  });

  observer.__test.handleMessage({
    type: "broadcast",
    method: "thread-read-state-changed",
    params: {
      conversationId: "thread-read",
      hostId: "local",
      hasUnreadTurn: false,
    },
  });

  assert.equal(published.at(-1).payload.params.hasUnreadTurn, false);
  observer.stop();
});

test("official live observer rejects malformed thread read state", () => {
  const published = [];
  const observer = createOfficialLiveObserver({
    publish: (payload) => published.push(payload),
    reconnectDelayMs: -1,
  });

  observer.__test.handleMessage({
    type: "broadcast",
    method: "thread-read-state-changed",
    params: {
      conversationId: "thread-read",
      hostId: "local",
      hasUnreadTurn: "false",
    },
  });

  assert.deepEqual(published, []);
  observer.stop();
});

test("official live observer publishes verified status from a stream snapshot", () => {
  const published = [];
  const observer = createOfficialLiveObserver({
    publish: (payload) => published.push(payload),
    reconnectDelayMs: -1,
  });

  observer.__test.handleMessage(threadStreamStateMessage("thread-active", "desktop-owner", {
    type: "snapshot",
    revision: 1,
    conversationState: { threadRuntimeStatus: { type: "active", activeFlags: [] } },
  }));

  assert.deepEqual(
    published.find((payload) => payload.channel === "thread-status-evidence")?.payload.params,
    { threadId: "thread-active", status: { type: "active", activeFlags: [] } }
  );
  observer.stop();
});

test("official live observer ignores renderer-local read state from a stream snapshot", () => {
  const observer = createOfficialLiveObserver({ reconnectDelayMs: -1 });

  observer.__test.handleMessage(threadStreamStateMessage("thread-snapshot-read", "desktop-owner", {
    type: "snapshot",
    revision: 1,
    conversationState: {
      hasUnreadTurn: false,
      threadRuntimeStatus: { type: "active", activeFlags: [] },
    },
  }));

  assert.deepEqual(observer.replayMessages().map(({ payload }) => ({
    method: payload.method,
    hasUnreadTurn: payload.params.hasUnreadTurn,
  })), [
    { method: "thread/status/changed", hasUnreadTurn: undefined },
  ]);
  observer.stop();
});

test("official live observer does not replay read state after a revision gap", () => {
  const observer = createOfficialLiveObserver({ reconnectDelayMs: -1 });

  observer.__test.handleMessage({
    type: "broadcast",
    method: "thread-read-state-changed",
    params: { conversationId: "thread-read-gap", hostId: "local", hasUnreadTurn: true },
  });
  observer.__test.handleMessage(threadStreamStateMessage("thread-read-gap", "desktop-owner", {
    type: "snapshot",
    revision: 1,
    conversationState: {
      threadRuntimeStatus: { type: "active", activeFlags: [] },
    },
  }));
  observer.__test.handleMessage(threadStreamStateMessage("thread-read-gap", "desktop-owner", {
    type: "patches",
    baseRevision: 0,
    revision: 2,
    patches: [],
  }));

  assert.deepEqual(
    observer.replayMessages().map(({ payload }) => payload.method),
    ["thread/status/changed"]
  );
  observer.stop();
});

test("official live observer does not overwrite direct read state from a stream snapshot", () => {
  const observer = createOfficialLiveObserver({ reconnectDelayMs: -1 });

  observer.__test.handleMessage({
    type: "broadcast",
    method: "thread-read-state-changed",
    params: { conversationId: "thread-read-missing", hostId: "local", hasUnreadTurn: true },
  });
  observer.__test.handleMessage(threadStreamStateMessage("thread-read-missing", "desktop-owner", {
    type: "snapshot",
    revision: 1,
    conversationState: {
      threadRuntimeStatus: { type: "active", activeFlags: [] },
    },
  }));
  observer.__test.handleMessage(threadStreamStateMessage("thread-read-missing", "desktop-owner", {
    type: "snapshot",
    revision: 2,
    conversationState: {
      hasUnreadTurn: false,
      threadRuntimeStatus: { type: "idle" },
    },
  }));

  assert.equal(observer.replayMessages()[1].payload.params.hasUnreadTurn, true);
  observer.stop();
});

test("official live observer clears read state on IPC reset", () => {
  const observer = createOfficialLiveObserver({ reconnectDelayMs: -1 });

  observer.__test.handleMessage({
    type: "broadcast",
    method: "thread-read-state-changed",
    params: { conversationId: "thread-read-reset", hostId: "local", hasUnreadTurn: true },
  });
  observer.__test.handleMessage({ type: "ipc-connection-reset" });

  assert.deepEqual(
    observer.replayMessages().map(({ payload }) => payload.method),
    ["thread/status/changed"]
  );
  observer.stop();
});

test("official live observer stays pending until a snapshot contains a valid runtime status", () => {
  const published = [];
  const observer = createOfficialLiveObserver({
    publish: (payload) => published.push(payload),
    reconnectDelayMs: -1,
  });

  observer.observeThread("thread-unknown", "local");
  observer.__test.handleMessage(threadStreamStateMessage("thread-unknown", "desktop-owner", {
    type: "snapshot",
    revision: 1,
  }));

  assert.deepEqual(observer.replayMessages(), [
    {
      channel: "thread-status-evidence",
      payload: {
        type: "mcp-notification",
        hostId: "local",
        method: "thread/status/changed",
        params: { threadId: "thread-unknown", status: { type: "notLoaded" } },
      },
    },
  ]);
  assert.equal(
    published.filter((payload) => payload.channel === "thread-status-evidence").length,
    1
  );
  observer.stop();
});

test("replays the latest transcript status only to the browser that completed hello", () => {
  const sent = [];
  const liveObserver = { replayMessages: () => [] };
  const transcriptObserver = {
    replayMessages: () => [{
      channel: "thread-status-evidence",
      payload: {
        type: "mcp-notification",
        hostId: "local",
        method: "thread/status/changed",
        params: { threadId: "thread-active", status: { type: "active", activeFlags: [] } },
      },
    }],
  };
  const hub = {
    sendTo: (clientId, envelope, options) => {
      sent.push({ clientId, envelope, options });
      return true;
    },
  };

  assert.equal(__test.sendOfficialThreadStatuses("browser-a", hub, liveObserver, null, transcriptObserver), 1);
  assert.deepEqual(sent, [{
    clientId: "browser-a",
    envelope: {
      channel: "codex_desktop:message-for-view",
      payload: transcriptObserver.replayMessages()[0].payload,
      args: [transcriptObserver.replayMessages()[0].payload],
    },
    options: { suppressDiagnostic: true },
  }]);
});

test("replays transcript status instead of an IPC pending placeholder", () => {
  const sent = [];
  const liveObserver = {
    replayMessages: () => [
      {
        channel: "thread-status-evidence",
        payload: {
          type: "mcp-notification",
          hostId: "local",
          method: "thread/status/changed",
          params: { threadId: "thread-live", status: { type: "notLoaded" } },
        },
      },
      {
        channel: "thread-read-state-changed",
        payload: {
          type: "broadcast",
          method: "thread-read-state-changed",
          params: { conversationId: "thread-live", hostId: "local", hasUnreadTurn: true },
        },
      },
    ],
  };
  const transcriptObserver = {
    replayMessages: () => [{
      channel: "thread-status-evidence",
      payload: {
        type: "mcp-notification",
        hostId: "local",
        method: "thread/status/changed",
        params: { threadId: "thread-live", status: { type: "active", activeFlags: [] } },
      },
    }],
  };
  const hub = {
    sendTo(clientId, envelope) {
      sent.push({ clientId, envelope });
      return true;
    },
  };

  assert.equal(__test.sendOfficialThreadStatuses("browser-a", hub, liveObserver, null, transcriptObserver), 2);
  assert.deepEqual(
    sent.map(({ envelope }) => envelope.payload.method),
    ["thread-read-state-changed", "thread/status/changed"]
  );
  assert.deepEqual(sent.at(-1).envelope.payload.params.status, { type: "active", activeFlags: [] });
});

test("replay reads the current Desktop unread atom when the browser renderer is ready", () => {
  const sent = [];
  const observer = { replayMessages: () => [] };
  const unreadByHost = { local: ["thread-current-unread"] };

  __test.sendOfficialThreadStatuses("browser-a", {
    sendTo(clientId, envelope) {
      sent.push({ clientId, envelope });
      return true;
    },
  }, observer, unreadByHost);

  assert.deepEqual(sent, [{
    clientId: "browser-a",
    envelope: {
      channel: "persisted-atom-updated",
      payload: {
        key: "unread-thread-ids-by-host-v1",
        value: unreadByHost,
        deleted: false,
      },
      args: [{
        key: "unread-thread-ids-by-host-v1",
        value: unreadByHost,
        deleted: false,
      }],
    },
  }]);
});

test("applies the Desktop unread atom to known transcript conversations", () => {
  const sent = [];
  const transcriptObserver = {
    replayMessages: () => [{
      channel: "thread-status-evidence",
      payload: {
        type: "mcp-notification",
        hostId: "local",
        method: "thread/status/changed",
        params: { threadId: "thread-unread", status: { type: "idle" } },
      },
    }],
  };

  assert.equal(__test.sendOfficialThreadStatuses(
    "browser-a",
    {
      sendTo(_clientId, envelope) {
        sent.push(envelope);
        return true;
      },
    },
    { replayMessages: () => [] },
    { local: ["thread-unread"] },
    transcriptObserver
  ), 3);
  assert.deepEqual(sent.map((envelope) => envelope.payload.method || envelope.channel), [
    "thread/status/changed",
    "thread-read-state-changed",
    "persisted-atom-updated",
  ]);
  assert.equal(sent[1].payload.params.hasUnreadTurn, true);
});

test("replays the latest authoritative read state after runtime status", () => {
  const observer = createOfficialLiveObserver({ reconnectDelayMs: -1 });
  observer.observeThread("thread-read-replay", "local");
  observer.__test.handleMessage(threadStreamStateMessage("thread-read-replay", "desktop-owner", {
    type: "snapshot",
    revision: 1,
    conversationState: { threadRuntimeStatus: { type: "idle" } },
  }));
  observer.__test.handleMessage({
    type: "broadcast",
    method: "thread-read-state-changed",
    sourceClientId: "desktop-owner",
    params: { conversationId: "thread-read-replay", hostId: "local", hasUnreadTurn: false },
  });

  assert.deepEqual(observer.replayMessages().map((message) => message.payload.method), [
    "thread/status/changed",
    "thread-read-state-changed",
  ]);
  assert.equal(observer.replayMessages()[1].payload.params.hasUnreadTurn, false);
  observer.stop();
});

test("stopping the observer does not publish another uncertain runtime status", () => {
  const published = [];
  const observer = createOfficialLiveObserver({
    publish: (payload) => published.push(payload),
    reconnectDelayMs: -1,
  });

  observer.__test.handleMessage(threadStreamStateMessage("thread-stop", "desktop-owner", {
    type: "snapshot",
    revision: 1,
  }));
  const beforeStop = published.filter((payload) => payload.channel === "thread-status-evidence").length;
  observer.stop();

  assert.equal(
    published.filter((payload) => payload.channel === "thread-status-evidence").length,
    beforeStop
  );
});

test("only invalidates recent conversation metadata for actual thread list changes", () => {
  const channel = "codex_desktop:message-for-view";
  const expected = { type: "query-cache-invalidate", queryKey: ["recent-conversations-meta"] };
  const startedArgs = [
    {
      type: "mcp-notification",
      hostId: "local",
      method: "thread/started",
      params: { thread: { id: "thread-1" } },
    },
  ];

  assert.deepEqual(__test.threadListInvalidationForOfficialMessage(channel, startedArgs, {}), expected);
  for (const method of [
    "thread/name",
    "thread/name/updated",
    "thread/archived",
    "thread/unarchived",
    "thread/deleted",
  ]) {
    assert.deepEqual(
      __test.threadListInvalidationForOfficialMessage(channel, [
        { type: "mcp-notification", method, params: { threadId: "thread-1" } },
      ]),
      expected
    );
  }
  assert.deepEqual(
    __test.threadListInvalidationForOfficialMessage(channel, [
      {
        type: "ipc-broadcast",
        method: "thread-stream-state-changed",
        params: { conversationId: "thread-2", change: { type: "snapshot" } },
      },
    ]),
    expected
  );
  assert.equal(
    __test.threadListInvalidationForOfficialMessage(channel, [
      {
        type: "ipc-broadcast",
        method: "thread-stream-state-changed",
        params: { conversationId: "thread-2", change: { type: "delta" } },
      },
    ]),
    null
  );
  assert.deepEqual(
    __test.threadListInvalidationForOfficialMessage(channel, [
      { type: "ipc-broadcast", method: "thread-archived", params: { conversationId: "thread-2" } },
    ]),
    expected
  );
});

test("uses the renderer-specific invalidation shape for Web and hidden native renderers", () => {
  const payload = {
    type: "ipc-broadcast",
    method: "query-cache-invalidate",
    params: { queryKey: ["recent-conversations-meta"] },
  };
  assert.deepEqual(__test.threadListInvalidationEnvelope(), {
    channel: "codex_desktop:message-for-view",
    payload,
    args: [payload],
  });
  assert.deepEqual(__test.threadListInvalidationRequest(), {
    type: "query-cache-invalidate",
    queryKey: ["recent-conversations-meta"],
  });
});

test("routes live observer broadcasts through the renderer IPC envelope", () => {
  const payload = {
    type: "broadcast",
    method: "thread-stream-state-changed",
    sourceClientId: "desktop-owner",
    targetClientIds: ["observer-client"],
    version: 11,
    params: {
      conversationId: "thread-live",
      hostId: "local",
      change: { type: "snapshot", revision: 1 },
    },
  };

  const envelope = __test.officialLiveObserverEnvelope({
    channel: "thread-stream-state-changed",
    payload,
  });

  assert.deepEqual(envelope, {
    channel: "codex_desktop:message-for-view",
    payload: {
      type: "ipc-broadcast",
      method: "thread-stream-state-changed",
      sourceClientId: "desktop-owner",
      version: 11,
      params: payload.params,
    },
    args: [
      {
        type: "ipc-broadcast",
        method: "thread-stream-state-changed",
        sourceClientId: "desktop-owner",
        version: 11,
        params: payload.params,
      },
    ],
  });

  assert.deepEqual(
    __test.officialLiveObserverEnvelope({
      channel: "ipc-connection-reset",
      payload: { type: "ipc-connection-reset", method: "ipc-connection-reset", params: { reason: "peer-reset" } },
    }),
    {
      channel: "codex_desktop:message-for-view",
      payload: { type: "ipc-broadcast", method: "ipc-connection-reset", params: { reason: "peer-reset" } },
      args: [{ type: "ipc-broadcast", method: "ipc-connection-reset", params: { reason: "peer-reset" } }],
    }
  );

  const status = {
    type: "mcp-notification",
    hostId: "local",
    method: "thread/status/changed",
    params: { threadId: "thread-live", status: { type: "notLoaded" } },
  };
  assert.deepEqual(
    __test.officialLiveObserverEnvelope({ channel: "thread-status-evidence", payload: status }),
    {
      channel: "codex_desktop:message-for-view",
      payload: status,
      args: [status],
    }
  );
});

test("learns live observer subscriptions from structured thread list responses", () => {
  const observed = [];
  const count = __test.observeLiveThreadsFromAppServerResponse(
    "codex_desktop:message-for-view",
    {
      type: "mcp-response",
      hostId: "local",
      message: {
        result: {
          data: [{ id: "thread-a" }, { id: "thread-b" }, { name: "missing-id" }],
        },
      },
    },
    { requestMethod: "thread/list" },
    { observeThread: (threadId, hostId) => observed.push({ threadId, hostId }) }
  );

  assert.equal(count, 2);
  assert.deepEqual(observed, [
    { threadId: "thread-a", hostId: "local" },
    { threadId: "thread-b", hostId: "local" },
  ]);
  assert.equal(
    __test.observeLiveThreadsFromAppServerResponse(
      "codex_desktop:message-for-view",
      { type: "mcp-response", message: { result: { data: [{ id: "thread-c" }] } } },
      { requestMethod: "thread/read" },
      { observeThread() {} }
    ),
    0
  );
});

test("learns sidebar threads from app-host thread/list JSON-RPC responses", () => {
  const observed = [];
  const tracker = __test.createAppHostThreadListTracker((threads, hostId) => {
    observed.push({ threads, hostId });
    return threads.length;
  });

  assert.equal(
    tracker.observeRequest(JSON.stringify({ id: 41, method: "thread/list", params: { limit: 50 } })),
    true
  );
  assert.equal(
    tracker.observeResponse(
      JSON.stringify({
        id: 41,
        result: { data: [{ id: "thread-app-host" }, { id: "thread-desktop" }] },
      })
    ),
    2
  );
  assert.deepEqual(observed, [
    {
      hostId: "local",
      threads: [{ id: "thread-app-host" }, { id: "thread-desktop" }],
    },
  ]);
  assert.equal(tracker.observeResponse(JSON.stringify({ id: 41, result: { data: [] } })), null);
});

test("replays authoritative statuses after forwarding an app-host thread list response", () => {
  const events = [];
  const tracker = __test.createAppHostThreadListTracker(() => {
    events.push("observe-thread-list");
    return 0;
  });
  tracker.observeRequest(JSON.stringify({ id: 42, method: "thread/list", params: {} }));

  assert.equal(
    __test.forwardAppHostResponse(
      JSON.stringify({ id: 42, result: { data: [{ id: "thread-existing" }] } }),
      tracker,
      () => events.push("forward-response"),
      () => events.push("replay-status")
    ),
    0
  );
  assert.deepEqual(events, ["observe-thread-list", "forward-response", "replay-status"]);
});

test("does not forward app-host thread status notifications past the transcript authority", () => {
  const forwarded = [];
  const tracker = __test.createAppHostThreadListTracker();

  __test.forwardAppHostResponse(
    JSON.stringify({
      method: "thread/status/changed",
      params: { threadId: "thread-stale", status: { type: "active", activeFlags: [] } },
    }),
    tracker,
    (message) => forwarded.push(message),
    () => {}
  );

  assert.deepEqual(forwarded, []);
});

test("delays authoritative status replay until the renderer applies thread list state", () => {
  const events = [];
  const timer = { unref: () => events.push("unref") };

  assert.equal(
    __test.scheduleOfficialThreadStatuses(
      "browser-a",
      (callback, delayMs) => {
        events.push(["scheduled", delayMs]);
        callback();
        return timer;
      },
      (clientId) => events.push(["replayed", clientId])
    ),
    true
  );
  assert.deepEqual(events, [["scheduled", 1_000], ["replayed", "browser-a"], "unref"]);
});

test("replaces stale app-host thread list statuses before the renderer sees them", () => {
  const forwarded = [];
  const tracker = __test.createAppHostThreadListTracker(() => 1);
  tracker.observeRequest(JSON.stringify({ id: 43, method: "thread/list", params: {} }));
  const statusObserver = {
    replayMessages: () => [{
      payload: {
        method: "thread/status/changed",
        params: { threadId: "thread-idle", status: { type: "idle" } },
      },
    }],
  };

  __test.forwardAppHostResponse(
    JSON.stringify({
      id: 43,
      result: { data: [{ id: "thread-idle", status: { type: "active", activeFlags: [] } }] },
    }),
    tracker,
    (message) => forwarded.push(JSON.parse(message)),
    () => {},
    statusObserver
  );

  assert.deepEqual(forwarded[0].result.data[0].status, { type: "idle" });
});

test("falls back to direct thread subscriptions when sidebar bootstrap is unavailable", () => {
  let observedBootstrap = null;
  const count = __test.observeLiveThreadsFromAppServerResponse(
    "codex_desktop:message-for-view",
    {
      type: "mcp-response",
      message: {
        result: {
          data: [
            {
              id: "thread-without-bootstrap",
              createdAt: 10,
              updatedAt: 20,
              cwd: "/tmp/project",
              source: "cli",
            },
          ],
        },
      },
    },
    { requestMethod: "thread/list" },
    {
      observeSidebarBootstrap(bootstrap) {
        observedBootstrap = bootstrap;
        return bootstrap.catalogSnapshot.entries.length;
      },
      observeThread() {},
    }
  );

  assert.equal(count, 1);
  assert.equal(observedBootstrap.catalogSnapshot.isComplete, false);
  assert.equal(observedBootstrap.catalogSnapshot.entries[0].threadId, "thread-without-bootstrap");
});

test("caches structured thread list entries for the next sidebar bootstrap", () => {
  const bootstrap = {
    catalogSnapshot: {
      revision: 7,
      isComplete: false,
      hosts: [{ hostId: "local", isComplete: false }],
      entries: [],
    },
    globalStateEntries: [],
  };

  const next = __test.mergeThreadListIntoSidebarBootstrap(bootstrap, "local", [
    {
      id: "thread-a",
      name: "Cached title",
      createdAt: 10,
      updatedAt: 20,
      cwd: "/tmp/project",
      source: { custom: "desktop" },
      threadSource: "user",
      modelProvider: "openai",
      gitInfo: { branch: "main" },
    },
    { id: "thread-exec", createdAt: 1, updatedAt: 2, cwd: "/tmp", source: "exec" },
    { id: "thread-child", createdAt: 1, updatedAt: 2, cwd: "/tmp", source: "cli", parentThreadId: "parent" },
  ]);

  assert.deepEqual(next.catalogSnapshot.entries, [
    {
      hostId: "local",
      threadId: "thread-a",
      displayTitle: "Cached title",
      sourceCreatedAt: 10,
      sourceUpdatedAt: 20,
      cwd: "/tmp/project",
      sourceKind: "custom",
      sourceDetail: "desktop",
      threadSource: "user",
      modelProvider: "openai",
      gitBranch: "main",
    },
  ]);
  assert.equal(next.catalogSnapshot.revision, 8);
  assert.equal(next.catalogSnapshot.isComplete, false);
  assert.deepEqual(bootstrap.catalogSnapshot.entries, []);
});

test("marks a sidebar catalog incomplete after merging a paginated thread list", () => {
  const bootstrap = {
    catalogSnapshot: {
      revision: 7,
      isComplete: true,
      hosts: [{ hostId: "local", isComplete: true }],
      entries: [],
    },
    globalStateEntries: [],
  };

  const next = __test.mergeThreadListIntoSidebarBootstrap(bootstrap, "local", [
    { id: "thread-page", createdAt: 10, updatedAt: 20, cwd: "/tmp/project", source: "cli" },
  ]);

  assert.equal(next.catalogSnapshot.isComplete, false);
  assert.deepEqual(next.catalogSnapshot.hosts, [{ hostId: "local", isComplete: false }]);
});

test("bounds the sidebar bootstrap cache while retaining pinned threads", () => {
  const bootstrap = {
    catalogSnapshot: {
      revision: 1,
      isComplete: false,
      hosts: [{ hostId: "local", isComplete: false }],
      entries: [
        {
          hostId: "local",
          threadId: "pinned-old",
          displayTitle: "Pinned",
          sourceCreatedAt: 1,
          sourceUpdatedAt: 1,
        },
      ],
    },
    globalStateEntries: [{ key: "pinned-thread-ids", value: ["pinned-old"] }],
  };
  const threads = Array.from({ length: 250 }, (_, index) => ({
    id: `recent-${index}`,
    name: `Recent ${index}`,
    createdAt: index + 10,
    updatedAt: index + 10,
    cwd: "/tmp/project",
    source: "cli",
  }));

  const next = __test.mergeThreadListIntoSidebarBootstrap(bootstrap, "local", threads);
  assert.equal(next.catalogSnapshot.entries.length, 51);
  assert.equal(next.catalogSnapshot.entries.some((entry) => entry.threadId === "pinned-old"), true);
  assert.equal(next.catalogSnapshot.entries.some((entry) => entry.threadId === "recent-0"), false);
});

test("evicts archived and deleted threads from the sidebar bootstrap cache", () => {
  const bootstrap = {
    catalogSnapshot: {
      revision: 8,
      isComplete: false,
      hosts: [{ hostId: "local", isComplete: false }],
      entries: [
        { hostId: "local", threadId: "thread-archive" },
        { hostId: "local", threadId: "thread-delete" },
        { hostId: "remote", threadId: "thread-archive" },
      ],
    },
    globalStateEntries: [],
  };

  const archived = __test.evictSidebarCatalogFromOfficialMessage(
    bootstrap,
    "codex_desktop:message-for-view",
    [{ type: "mcp-notification", method: "thread/archived", hostId: "local", params: { threadId: "thread-archive" } }]
  );
  assert.deepEqual(
    archived.catalogSnapshot.entries.map((entry) => `${entry.hostId}:${entry.threadId}`),
    ["local:thread-delete", "remote:thread-archive"]
  );

  const deleted = __test.evictSidebarCatalogFromOfficialMessage(
    archived,
    "codex_desktop:message-for-view",
    [{ type: "mcp-notification", method: "thread/deleted", params: { threadId: "thread-delete" } }]
  );
  assert.deepEqual(
    deleted.catalogSnapshot.entries.map((entry) => `${entry.hostId}:${entry.threadId}`),
    ["remote:thread-archive"]
  );
});

test("synchronizes live observer follows to the current sidebar catalog", () => {
  const { EventEmitter } = require("node:events");
  const writes = [];
  const socket = new EventEmitter();
  socket.writable = true;
  socket.destroyed = false;
  socket.write = (frame) => writes.push(JSON.parse(frame.subarray(4).toString("utf8")));
  socket.destroy = () => {
    socket.destroyed = true;
  };
  const observer = createOfficialLiveObserver({
    socketPaths: ["/tmp/original-codex.sock"],
    socketFactory: () => socket,
    reconnectDelayMs: -1,
  });
  observer.start();
  socket.emit("connect");
  socket.emit(
    "data",
    encodeIpcFrame({ type: "response", method: "initialize", resultType: "success", handledByClientId: "observer-client" })
  );
  observer.observeSidebarBootstrap({ catalogSnapshot: { isComplete: true, entries: [{ hostId: "local", threadId: "thread-a" }, { hostId: "local", threadId: "thread-b" }] } });
  observer.observeSidebarBootstrap({ catalogSnapshot: { isComplete: true, entries: [{ hostId: "local", threadId: "thread-b" }, { hostId: "local", threadId: "thread-c" }] } });

  assert.deepEqual(
    [...observer.__test.getKnownThreads().keys()],
    ["local\u0000thread-b", "local\u0000thread-c"]
  );
  assert.deepEqual(
    writes.filter((message) => message.method === "thread-stream-following-changed").map((message) => [message.params.conversationId, message.params.following]),
    [
      ["thread-a", true],
      ["thread-b", true],
      ["thread-a", false],
      ["thread-c", true],
    ]
  );
  observer.stop();
});

test("keeps following threads omitted from an incomplete sidebar catalog", () => {
  const observer = createOfficialLiveObserver({ reconnectDelayMs: -1 });
  observer.observeSidebarBootstrap({
    catalogSnapshot: {
      isComplete: false,
      entries: [
        { hostId: "local", threadId: "thread-running" },
        { hostId: "local", threadId: "thread-newer" },
      ],
    },
  });

  observer.observeSidebarBootstrap({
    catalogSnapshot: {
      isComplete: false,
      entries: [{ hostId: "local", threadId: "thread-newer" }],
    },
  });

  assert.deepEqual([...observer.__test.getKnownThreads().keys()], [
    "local\u0000thread-running",
    "local\u0000thread-newer",
  ]);
  observer.stop();
});

test("ignores an unknown thread stream patch", () => {
  const published = [];
  const observer = createOfficialLiveObserver({
    publish: (payload) => published.push(payload),
    reconnectDelayMs: -1,
  });

  observer.__test.handleMessage({
    type: "broadcast",
    method: "thread-stream-state-changed",
    sourceClientId: "desktop-owner",
    params: {
      conversationId: "thread-new",
      hostId: "local",
      change: { type: "patches", baseRevision: 1, revision: 2, patches: [{ op: "replace" }] },
    },
  });

  assert.equal(published.length, 0);
  assert.equal(observer.__test.getKnownThreads().size, 0);
  assert.equal(observer.__test.getActiveOwners().size, 0);
  observer.stop();
});

test("accepts and tracks an unknown thread stream snapshot without replaying it on refresh", () => {
  const published = [];
  const observer = createOfficialLiveObserver({
    publish: (payload) => published.push(payload),
    reconnectDelayMs: -1,
  });
  const snapshot = {
    type: "broadcast",
    method: "thread-stream-state-changed",
    sourceClientId: "desktop-owner",
    params: {
      conversationId: "thread-new",
      hostId: "local",
      change: { type: "snapshot", revision: 1 },
    },
  };

  observer.__test.handleMessage(snapshot);

  assert.equal(observer.__test.getKnownThreads().has("local\u0000thread-new"), true);
  assert.equal(observer.__test.getActiveOwners().get("local\u0000thread-new"), "desktop-owner");
  observer.refresh();
  assert.equal(
    published.filter((payload) => payload.channel === "thread-stream-state-changed").length,
    1
  );
  observer.stop();
});

test("ignores the first patches after an IPC reset until a fresh snapshot arrives", () => {
  const published = [];
  const observer = createOfficialLiveObserver({
    publish: (payload) => published.push(payload),
    reconnectDelayMs: -1,
  });

  observer.__test.handleMessage(threadStreamStateMessage("thread-reset-patches", "desktop-owner", {
    type: "snapshot",
    revision: 7,
  }));
  observer.__test.handleMessage({
    type: "broadcast",
    method: "ipc-connection-reset",
    params: { reason: "peer-reset" },
  });
  observer.__test.handleMessage(threadStreamStateMessage("thread-reset-patches", "desktop-owner", {
    type: "patches",
    baseRevision: 7,
    revision: 8,
    patches: [{ op: "replace" }],
  }));

  assert.equal(
    published.filter((payload) => payload.channel === "thread-stream-state-changed").length,
    1
  );
  observer.stop();
});

test("ignores patches whose baseRevision does not match the accepted snapshot", () => {
  const published = [];
  const observer = createOfficialLiveObserver({
    publish: (payload) => published.push(payload),
    reconnectDelayMs: -1,
  });

  observer.__test.handleMessage(threadStreamStateMessage("thread-base-mismatch", "desktop-owner", {
    type: "snapshot",
    revision: 7,
    conversationState: { threadRuntimeStatus: { type: "active", activeFlags: [] } },
  }));
  observer.__test.handleMessage(threadStreamStateMessage("thread-base-mismatch", "desktop-owner", {
    type: "patches",
    baseRevision: 6,
    revision: 8,
    patches: [{ op: "replace" }],
  }));

  assert.equal(
    published.filter((payload) => payload.channel === "thread-stream-state-changed").length,
    1
  );
  assert.deepEqual(
    published
      .filter((payload) => payload.channel === "thread-status-evidence")
      .map((payload) => payload.payload.params.status),
    [{ type: "active", activeFlags: [] }, { type: "notLoaded" }]
  );

  observer.__test.handleMessage(threadStreamStateMessage("thread-base-mismatch", "desktop-owner", {
    type: "snapshot",
    revision: 9,
    conversationState: { threadRuntimeStatus: { type: "idle" } },
  }));
  assert.deepEqual(
    published
      .filter((payload) => payload.channel === "thread-status-evidence")
      .map((payload) => payload.payload.params.status),
    [{ type: "active", activeFlags: [] }, { type: "notLoaded" }, { type: "idle" }]
  );
  observer.stop();
});

test("ignores patches when no stream revision has been accepted", () => {
  const published = [];
  const observer = createOfficialLiveObserver({
    publish: (payload) => published.push(payload),
    reconnectDelayMs: -1,
  });

  observer.__test.handleMessage(threadStreamStateMessage("thread-no-revision", "desktop-owner", {
    type: "snapshot",
  }));
  observer.__test.handleMessage(threadStreamStateMessage("thread-no-revision", "desktop-owner", {
    type: "patches",
    baseRevision: undefined,
    revision: 1,
    patches: [{ op: "replace" }],
  }));

  assert.equal(
    published.filter((payload) => payload.channel === "thread-stream-state-changed").length,
    1
  );
  observer.stop();
});

test("forwards matching patches and advances the accepted stream revision", () => {
  const published = [];
  const observer = createOfficialLiveObserver({
    publish: (payload) => published.push(payload),
    reconnectDelayMs: -1,
  });

  observer.__test.handleMessage(threadStreamStateMessage("thread-revisions", "desktop-owner", {
    type: "snapshot",
    revision: 7,
  }));
  observer.__test.handleMessage(threadStreamStateMessage("thread-revisions", "desktop-owner", {
    type: "patches",
    baseRevision: 7,
    revision: 8,
    patches: [{ op: "replace", path: "/status", value: "running" }],
  }));
  observer.__test.handleMessage(threadStreamStateMessage("thread-revisions", "desktop-owner", {
    type: "patches",
    baseRevision: 8,
    revision: 9,
    patches: [{ op: "replace", path: "/status", value: "completed" }],
  }));

  const states = published.filter((payload) => payload.channel === "thread-stream-state-changed");
  assert.equal(states.length, 3);
  assert.equal(states.at(-1).payload.params.change.revision, 9);
  observer.stop();
});

test("ignores patches from a different stream owner", () => {
  const published = [];
  const observer = createOfficialLiveObserver({
    publish: (payload) => published.push(payload),
    reconnectDelayMs: -1,
  });

  observer.__test.handleMessage(threadStreamStateMessage("thread-owner-mismatch", "desktop-owner", {
    type: "snapshot",
    revision: 7,
  }));
  observer.__test.handleMessage(threadStreamStateMessage("thread-owner-mismatch", "other-owner", {
    type: "patches",
    baseRevision: 7,
    revision: 8,
    patches: [{ op: "replace" }],
  }));

  assert.equal(
    published.filter((payload) => payload.channel === "thread-stream-state-changed").length,
    1
  );
  observer.stop();
});

test("owner disconnect clears the owner and forwards the disconnect", () => {
  const published = [];
  const observer = createOfficialLiveObserver({
    publish: (payload) => published.push(payload),
    reconnectDelayMs: -1,
  });

  observer.__test.handleMessage({
    type: "broadcast",
    method: "thread-stream-state-changed",
    sourceClientId: "desktop-owner",
    params: { conversationId: "thread-finished", change: { type: "snapshot" } },
  });
  observer.__test.handleMessage({
    type: "broadcast",
    method: "client-status-changed",
    params: { clientId: "desktop-owner", status: "disconnected" },
  });

  assert.equal(observer.__test.getActiveOwners().size, 0);
  assert.equal(published.at(-1).channel, "client-status-changed");
  observer.stop();
});

test("re-subscribes known threads after a peer reset without follower control requests", () => {
  const { EventEmitter } = require("node:events");
  const writes = [];
  const published = [];
  const socket = new EventEmitter();
  socket.writable = true;
  socket.destroyed = false;
  socket.write = (frame) => writes.push(JSON.parse(frame.subarray(4).toString("utf8")));
  socket.destroy = () => {
    socket.destroyed = true;
  };
  const observer = createOfficialLiveObserver({
    socketPaths: ["/tmp/original-codex.sock"],
    socketFactory: () => socket,
    publish: (payload) => published.push(payload),
    reconnectDelayMs: -1,
  });

  observer.start();
  observer.observeThread("thread-reset");
  socket.emit("connect");
  socket.emit(
    "data",
    encodeIpcFrame({
      type: "response",
      method: "initialize",
      resultType: "success",
      handledByClientId: "observer-client",
    })
  );
  writes.length = 0;

  observer.__test.handleMessage({
    type: "broadcast",
    method: "thread-stream-state-changed",
    sourceClientId: "desktop-owner",
    params: { conversationId: "thread-reset", change: { type: "snapshot" } },
  });
  observer.__test.handleMessage({
    type: "broadcast",
    method: "ipc-connection-reset",
    params: { reason: "peer-reset" },
  });

  assert.equal(observer.__test.getActiveOwners().size, 0);
  assert.equal(published.at(-1).channel, "ipc-connection-reset");
  assert.deepEqual(writes.map((message) => message.method), ["thread-stream-following-changed"]);
  assert.equal(writes.some((message) => String(message.method).startsWith("thread-follower-")), false);
  const stateCount = published.filter((payload) => payload.channel === "thread-stream-state-changed").length;
  observer.refresh();
  assert.equal(
    published.filter((payload) => payload.channel === "thread-stream-state-changed").length,
    stateCount
  );
  observer.stop();
});
