const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { openFileTargetFromIpc } = require("../runtime/ipc/open-file-context.cjs");
const {
  createIpcFrameParser,
  createOfficialLiveObserver,
  encodeIpcFrame,
  __test: observerTest,
} = require("../runtime/ipc/official-live-observer.cjs");
const {
  __test,
  requestContext,
  setWsHub,
} = require("../runtime/ipc/official-runtime.cjs");
const { __test: portableRunnerTest } = require("../runner/platform/portable.cjs");

test("forwards structured official app-host messages and preserves close signals", () => {
  const forwarded = [];
  const closed = [];
  const payload = { id: 1n, sentAt: new Date(1234), value: new Uint8Array([1, 2]) };

  assert.equal(
    __test.deliverOfficialAppHostMessage(
      Object.create({ data: payload }),
      (data) => forwarded.push(data),
      (reason) => closed.push(reason)
    ),
    true
  );
  assert.equal(forwarded[0], payload);
  assert.deepEqual(closed, []);

  assert.equal(
    __test.deliverOfficialAppHostMessage(
      { data: undefined },
      (data) => forwarded.push(data),
      (reason) => closed.push(reason)
    ),
    true
  );
  assert.equal(forwarded[1], undefined);
  assert.deepEqual(closed, []);

  assert.equal(
    __test.deliverOfficialAppHostMessage(
      { data: null },
      (data) => forwarded.push(data),
      (reason) => closed.push(reason)
    ),
    false
  );
  assert.deepEqual(closed, ["official_closed"]);
});

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

test("raises only a bounded listener budget for the hidden official renderer", () => {
  let maxListeners = 10;
  const webContents = {
    getMaxListeners: () => maxListeners,
    setMaxListeners: (value) => {
      maxListeners = value;
    },
  };

  assert.equal(__test.configureOfficialWebContentsListenerBudget(webContents), true);
  assert.equal(maxListeners, 64);
  assert.equal(__test.configureOfficialWebContentsListenerBudget(webContents), false);
  assert.equal(__test.configureOfficialWebContentsListenerBudget({}), false);
});

test("bounds stalled official IPC routes and refreshes their LRU order", () => {
  const routes = new Map();
  const summaries = new Map();
  __test.storeBoundedRequestRoute(routes, summaries, "request-1", "client-1", { url: "/one" }, 2);
  __test.storeBoundedRequestRoute(routes, summaries, "request-2", "client-2", { url: "/two" }, 2);
  __test.storeBoundedRequestRoute(routes, summaries, "request-1", "client-1b", { url: "/one-new" }, 2);
  __test.storeBoundedRequestRoute(routes, summaries, "request-3", "client-3", { url: "/three" }, 2);

  assert.deepEqual(Array.from(routes.entries()), [
    ["request-1", "client-1b"],
    ["request-3", "client-3"],
  ]);
  assert.equal(summaries.has("request-2"), false);
  assert.equal(summaries.get("request-1").url, "/one-new");
});

test("bounds route id extraction across wide and cyclic IPC arguments", () => {
  assert.equal(__test.routeIdFromValue([{ payload: { requestId: "request-nested" } }]), "request-nested");
  let reads = 0;
  const wide = new Proxy(Array.from({ length: 50_000 }, () => ({})), {
    get(target, key, receiver) {
      if (/^\d+$/.test(String(key))) reads += 1;
      return Reflect.get(target, key, receiver);
    },
  });
  assert.equal(__test.routeIdFromValue(wide), "");
  assert.ok(reads > 0 && reads <= 256, `route scan read ${reads} array items`);
  const cyclic = {};
  cyclic.payload = cyclic;
  assert.equal(__test.routeIdFromValue(cyclic), "");
});

test("omits only a recoverable duplicate args copy from outgoing WebSocket envelopes", () => {
  const payload = { type: "mcp-notification", params: { apps: [1, 2, 3] } };

  assert.deepEqual(__test.outgoingWsEnvelope("message", [payload]), {
    channel: "message",
    payload,
  });
  assert.deepEqual(__test.outgoingWsEnvelope("message", []), {
    channel: "message",
    payload: null,
    args: [],
  });
  assert.deepEqual(__test.outgoingWsEnvelope("message", [undefined]), {
    channel: "message",
    payload: null,
    args: [undefined],
  });
  assert.deepEqual(__test.outgoingWsEnvelope("message", ["first", "second"]), {
    channel: "message",
    payload: ["first", "second"],
    args: ["first", "second"],
  });
});

test("compacts only renderer-unused app catalog subfields without mutating official payloads", () => {
  const entry = {
    id: "app-1",
    name: "App One",
    description: "kept",
    iconAssets: {
      "256_square": "square-light",
      "256_circle": "circle-light",
      original: "original-light",
    },
    iconDarkAssets: {
      "256_square": "square-dark",
      "256_circle": "circle-dark",
    },
    appMetadata: {
      categories: ["productivity"],
      firstPartyType: "first-party",
      review: { status: "approved" },
      screenshots: null,
    },
  };
  const payload = {
    type: "mcp-response",
    message: { id: "request-1", result: { data: [entry], nextCursor: null } },
  };

  const compacted = __test.compactOfficialAppCatalogPayload(
    "codex_desktop:message-for-view",
    payload,
    { requestMethod: "app/list" }
  );

  assert.notEqual(compacted, payload);
  assert.notEqual(compacted.message.result.data[0], entry);
  assert.deepEqual(compacted.message.result.data[0], {
    id: "app-1",
    name: "App One",
    description: "kept",
    iconAssets: { "256_square": "square-light" },
    iconDarkAssets: { "256_square": "square-dark" },
    appMetadata: {
      categories: ["productivity"],
      firstPartyType: "first-party",
    },
  });
  assert.equal(entry.iconAssets["256_circle"], "circle-light");
  assert.equal(entry.appMetadata.review.status, "approved");
  assert.equal(
    __test.compactOfficialAppCatalogPayload(
      "codex_desktop:message-for-view",
      payload,
      { requestMethod: "thread/list" }
    ),
    payload
  );
});

test("compacts full app catalog update notifications with the same renderer shape", () => {
  const payload = {
    type: "mcp-notification",
    method: "app/list/updated",
    params: {
      data: [
        {
          id: "app-2",
          iconAssets: { "256_square": "square", "256_circle": "circle" },
          iconDarkAssets: null,
          appMetadata: { categories: ["tools"], review: null },
        },
      ],
    },
  };

  const compacted = __test.compactOfficialAppCatalogPayload(
    "codex_desktop:message-for-view",
    payload
  );

  assert.deepEqual(compacted.params.data[0], {
    id: "app-2",
    iconAssets: { "256_square": "square" },
    iconDarkAssets: null,
    appMetadata: { categories: ["tools"] },
  });
  assert.equal(payload.params.data[0].iconAssets["256_circle"], "circle");
});

test("never broadcasts a targeted official response when its browser is offline", (t) => {
  const sends = [];
  const broadcasts = [];
  setWsHub({
    broadcast(payload) {
      broadcasts.push(payload);
      return 1;
    },
    sendTo(clientId, payload) {
      sends.push({ clientId, payload });
      return false;
    },
  });
  t.after(() => setWsHub(null));

  const delivered = requestContext.run({ clientId: "offline-client" }, () =>
    __test.routeOfficialWebContentsSend("fetch-response", [
      { type: "fetch-response", requestId: "offline-request", responseType: "success" },
    ])
  );

  assert.equal(delivered, false);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].clientId, "offline-client");
  assert.equal(broadcasts.length, 0);

  const hiddenRuntimeResponseDelivered = __test.routeOfficialWebContentsSend(
    "codex_desktop:message-for-view",
    [
      {
        type: "mcp-response",
        message: { id: "hidden-runtime-thread-list", result: { data: [] } },
      },
    ]
  );
  assert.equal(hiddenRuntimeResponseDelivered, false);
  assert.equal(broadcasts.length, 0);

  __test.routeOfficialWebContentsSend("account-updated", [{ type: "account-updated" }]);
  assert.equal(broadcasts.length, 1);
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
    catalogSnapshot: { entries: [{ threadId: "thread-old" }, { threadId: "thread-kept" }] },
  });
  observer.observeSidebarBootstrap({
    catalogSnapshot: { entries: [{ threadId: "thread-kept" }, { threadId: "thread-new" }] },
  });

  assert.deepEqual([...observer.__test.getKnownThreads().keys()], ["local\u0000thread-kept", "local\u0000thread-new"]);
  observer.stop();
});

test("official observer bounds known threads and unsubscribes the least recently used stream", () => {
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
    maxKnownThreads: 2,
  });

  observer.start();
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
  observer.observeThread("thread-one");
  observer.observeThread("thread-two");
  observer.__test.handleMessage({
    type: "broadcast",
    method: "thread-stream-state-changed",
    sourceClientId: "desktop-owner",
    params: {
      conversationId: "thread-two",
      hostId: "local",
      change: { type: "snapshot", revision: 1 },
    },
  });
  // 再次观察 thread-one 会刷新 LRU，因此第三条线程应淘汰 thread-two。
  observer.observeThread("thread-one");
  observer.observeThread("thread-three");

  assert.deepEqual([...observer.__test.getKnownThreads().keys()], ["local\u0000thread-one", "local\u0000thread-three"]);
  assert.equal(observer.__test.getActiveOwners().has("local\u0000thread-two"), false);
  assert.deepEqual(
    writes
      .filter((message) => message.method === "thread-stream-following-changed")
      .slice(-2)
      .map((message) => [message.params.conversationId, message.params.following]),
    [["thread-two", false], ["thread-three", true]]
  );
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
  observer.stop();
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
  observer.stop();
});

test("bridges official thread list changes to recent conversation metadata invalidation", () => {
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
  });
  assert.deepEqual(__test.threadListInvalidationRequest(), {
    type: "query-cache-invalidate",
    queryKey: ["recent-conversations-meta"],
  });
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
