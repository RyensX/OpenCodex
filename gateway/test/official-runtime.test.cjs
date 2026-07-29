const assert = require("node:assert/strict");
const test = require("node:test");
const { openFileTargetFromIpc } = require("../runtime/ipc/open-file-context.cjs");
const { createOfficialLiveObserver, encodeIpcFrame } = require("../runtime/ipc/official-live-observer.cjs");
const { __test } = require("../runtime/ipc/official-runtime.cjs");

function threadStreamStateMessage(conversationId, sourceClientId, change) {
  return {
    type: "broadcast",
    method: "thread-stream-state-changed",
    sourceClientId,
    params: { conversationId, hostId: "local", change },
  };
}

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
    args: [payload],
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
