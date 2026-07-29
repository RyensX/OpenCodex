const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const http = require("node:http");
const test = require("node:test");
const vm = require("node:vm");
const { WebSocketServer } = require("ws");
const { openFileTargetFromIpc } = require("../runtime/ipc/open-file-context.cjs");
const { createOfficialLiveObserver, encodeIpcFrame } = require("../runtime/ipc/official-live-observer.cjs");
const {
  __test: desktopStatusBridgeTest,
  connectDesktopStatusBridge,
  createDesktopStatusSynchronizer,
  desktopRunningThreadIds,
} = require("../runtime/ipc/desktop-status-bridge.cjs");
const { __test, requestContext } = require("../runtime/ipc/official-runtime.cjs");

function threadStreamStateMessage(conversationId, sourceClientId, change) {
  return {
    type: "broadcast",
    method: "thread-stream-state-changed",
    sourceClientId,
    params: { conversationId, hostId: "local", change },
  };
}

test("parses only canonical local thread paths from the Desktop tray snapshot", () => {
  assert.deepEqual(
    desktopRunningThreadIds({
      trayMenuThreads: {
        runningThreads: [
          { path: "/local/019fb13e-0199-7152-9b50-76e84b203076" },
          { path: "/local/019fb13e-0199-7152-9b50-76e84b203076" },
          { path: "/remote/task-1" },
          { path: "/local/not-a-thread-id" },
        ],
      },
    }),
    new Set(["019fb13e-0199-7152-9b50-76e84b203076"])
  );
  assert.equal(desktopRunningThreadIds({ trayMenuThreads: {} }), null);
});

test("publishes authoritative Desktop active and idle changes for visible local threads", () => {
  const published = [];
  const sync = createDesktopStatusSynchronizer({
    getVisibleThreads: () => [
      { hostId: "local", threadId: "019fb13e-0199-7152-9b50-76e84b203076" },
      { hostId: "local", threadId: "019fb137-3c7f-7c70-988d-305f938adbeb" },
      { hostId: "remote", threadId: "remote-thread" },
    ],
    publish: (envelope) => published.push(envelope),
  });

  sync.applyTraySnapshot({
    trayMenuThreads: {
      runningThreads: [{ path: "/local/019fb13e-0199-7152-9b50-76e84b203076" }],
    },
  });
  sync.applyTraySnapshot({
    trayMenuThreads: {
      runningThreads: [{ path: "/local/019fb137-3c7f-7c70-988d-305f938adbeb" }],
    },
  });

  assert.deepEqual(
    published.map(({ payload }) => ({ threadId: payload.params.threadId, status: payload.params.status })),
    [
      {
        threadId: "019fb13e-0199-7152-9b50-76e84b203076",
        status: { type: "active", activeFlags: [] },
      },
      { threadId: "019fb137-3c7f-7c70-988d-305f938adbeb", status: { type: "idle" } },
      { threadId: "019fb13e-0199-7152-9b50-76e84b203076", status: { type: "idle" } },
      {
        threadId: "019fb137-3c7f-7c70-988d-305f938adbeb",
        status: { type: "active", activeFlags: [] },
      },
    ]
  );
  assert.equal(
    published.every(
      ({ channel, payload }) =>
        channel === "codex_desktop:message-for-view" &&
        payload.type === "mcp-notification" &&
        payload.hostId === "local" &&
        payload.method === "thread/status/changed"
    ),
    true
  );
});

test("replays the last Desktop active set when the visible catalog arrives later", () => {
  let visibleThreads = [];
  const published = [];
  const sync = createDesktopStatusSynchronizer({
    getVisibleThreads: () => visibleThreads,
    publish: (envelope) => published.push(envelope),
  });

  sync.applyTraySnapshot({
    trayMenuThreads: {
      runningThreads: [{ path: "/local/019fb13e-0199-7152-9b50-76e84b203076" }],
    },
  });
  visibleThreads = [{ hostId: "local", threadId: "019fb13e-0199-7152-9b50-76e84b203076" }];
  sync.refresh();

  assert.equal(published.length, 1);
  assert.deepEqual(published[0].payload.params.status, { type: "active", activeFlags: [] });
});

test("replays all known Desktop statuses to a client that connects later", () => {
  const visibleThreads = [
    { hostId: "local", threadId: "019fb13e-0199-7152-9b50-76e84b203076" },
    { hostId: "local", threadId: "019fb137-3c7f-7c70-988d-305f938adbeb" },
  ];
  const sync = createDesktopStatusSynchronizer({ getVisibleThreads: () => visibleThreads, publish() {} });
  sync.applyTraySnapshot({
    trayMenuThreads: {
      runningThreads: [{ path: "/local/019fb13e-0199-7152-9b50-76e84b203076" }],
    },
  });

  const replayed = [];
  sync.replay((envelope) => replayed.push(envelope.payload.params));

  assert.deepEqual(replayed, [
    {
      threadId: "019fb13e-0199-7152-9b50-76e84b203076",
      status: { type: "active", activeFlags: [] },
    },
    { threadId: "019fb137-3c7f-7c70-988d-305f938adbeb", status: { type: "idle" } },
  ]);
});

test("reads Desktop tray snapshots from a loopback app renderer CDP target", async (t) => {
  const methods = [];
  const server = http.createServer((req, res) => {
    if (req.url !== "/json/list") return res.writeHead(404).end();
    const port = server.address().port;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify([
        { type: "page", url: "https://example.com", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/ignored` },
        {
          type: "page",
          url: "app://-/index.html?initialRoute=%2Favatar-overlay",
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}/overlay`,
        },
        { type: "page", url: "app://-/index.html", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/desktop` },
      ])
    );
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });
  wss.on("connection", (ws, req) => {
    assert.equal(req.url, "/desktop");
    ws.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      methods.push(message.method);
      ws.send(JSON.stringify({ id: message.id, result: {} }));
      if (message.method === "Page.reload") {
        ws.send(
          JSON.stringify({
            method: "Runtime.bindingCalled",
            params: {
              name: "opencodexDesktopStatus",
              payload: JSON.stringify({
                type: "tray-menu-threads-changed",
                trayMenuThreads: {
                  runningThreads: [{ path: "/local/019fb13e-0199-7152-9b50-76e84b203076" }],
                },
              }),
            },
          })
        );
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const client of wss.clients) client.terminate();
    wss.close();
    await new Promise((resolve) => server.close(resolve));
  });

  const snapshots = [];
  let resolveSnapshot;
  let rejectSnapshot;
  const snapshotReady = new Promise((resolve, reject) => {
    resolveSnapshot = resolve;
    rejectSnapshot = reject;
  });
  const snapshotTimeout = setTimeout(() => {
    rejectSnapshot(new Error("Timed out waiting for Desktop tray snapshot"));
  }, 1000);
  snapshotTimeout.unref?.();
  const bridge = await connectDesktopStatusBridge({
    endpoint: `http://127.0.0.1:${server.address().port}`,
    onSnapshot: (snapshot) => {
      snapshots.push(snapshot);
      if (snapshots.length === 1) {
        clearTimeout(snapshotTimeout);
        resolveSnapshot();
      }
    },
  });
  t.after(() => bridge.close());
  await snapshotReady;

  assert.deepEqual(methods, [
    "Runtime.enable",
    "Page.enable",
    "Runtime.addBinding",
    "Page.addScriptToEvaluateOnNewDocument",
    "Runtime.evaluate",
    "Page.reload",
  ]);
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].type, "tray-menu-threads-changed");

  for (const client of wss.clients) client._socket.write(Buffer.from([0x83, 0x00]));
  await bridge.closed;
});

test("rejects a malformed CDP frame sent with the upgrade without crashing the process", async (t) => {
  const server = http.createServer((req, res) => {
    if (req.url !== "/json/list") return res.writeHead(404).end();
    const port = server.address().port;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify([
        {
          type: "page",
          url: "app://-/index.html",
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}/desktop`,
        },
      ])
    );
  });
  let upgradeSocket;
  server.on("upgrade", (req, socket) => {
    upgradeSocket = socket;
    const accept = crypto
      .createHash("sha1")
      .update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    const handshake = [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "",
      "",
    ].join("\r\n");
    socket.write(Buffer.concat([Buffer.from(handshake), Buffer.from([0x83, 0x00])]));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    upgradeSocket?.destroy();
    return new Promise((resolve) => server.close(resolve));
  });

  await assert.rejects(
    connectDesktopStatusBridge({
      endpoint: `http://127.0.0.1:${server.address().port}`,
      onSnapshot() {},
    }),
    /Desktop CDP connection closed|WebSocket|opcode|frame/i
  );
  assert.equal(server.listening, true);
});

test("rejects non-loopback Desktop CDP endpoints", async () => {
  await assert.rejects(
    connectDesktopStatusBridge({ endpoint: "http://192.0.2.10:9222", onSnapshot: () => {} }),
    /loopback/
  );
});

test("rejects redirects during Desktop CDP discovery", async (t) => {
  const server = http.createServer((_req, res) => {
    res.writeHead(302, { location: "https://example.com/json/list" }).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  await assert.rejects(
    connectDesktopStatusBridge({ endpoint: `http://127.0.0.1:${server.address().port}`, onSnapshot() {} }),
    /fetch failed|redirect/i
  );
});

test("captures the structured tray object when Electron exposes a frozen bridge", () => {
  const snapshots = [];
  const sandbox = {
    JSON: { parse: JSON.parse, stringify: JSON.stringify },
    window: {
      electronBridge: Object.freeze({ sendMessageFromView() {} }),
      opencodexDesktopStatus: (payload) => snapshots.push(JSON.parse(payload)),
    },
  };
  vm.runInNewContext(desktopStatusBridgeTest.INSTALL_STATUS_HOOK, sandbox);

  sandbox.JSON.stringify({
    runningThreads: [{ path: "/local/019fb13e-0199-7152-9b50-76e84b203076" }],
    unreadThreads: [],
    pinnedThreads: [],
    recentThreads: [],
    usageLimits: [],
  });
  sandbox.JSON.stringify({
    runningThreads: [{ path: "/local/019fb13e-0199-7152-9b50-76e84b203076" }],
    unreadThreads: [],
    pinnedThreads: [],
    recentThreads: [],
    usageLimits: [],
  });

  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].type, "tray-menu-threads-changed");
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

test("answers trusted Statsig bootstrap without replaying another session", () => {
  assert.deepEqual(
    __test.nonBlockingFetchResponse(
      { type: "fetch", requestId: 42, url: "https://chatgpt.com/wham/statsig/bootstrap" }
    ),
    {
      type: "fetch-response",
      responseType: "success",
      requestId: 42,
      status: 200,
      headers: { "content-type": "application/json" },
      bodyJsonString: "{}",
    }
  );
  assert.equal(
    __test.nonBlockingFetchResponse({ type: "fetch", requestId: "untrusted", url: "https://evil.example/ces/v1/rgstr" }),
    null
  );
  assert.equal(
    __test.nonBlockingFetchResponse({ type: "fetch", requestId: "untrusted", url: "https://evil.example/wham/statsig/bootstrap" }),
    null
  );
  assert.deepEqual(
    __test.nonBlockingFetchResponse(
      { type: "fetch", requestId: 43, url: "https://chatgpt.com/ces/v1/rgstr?k=client" }
    ),
    {
      type: "fetch-response",
      responseType: "success",
      requestId: 43,
      status: 200,
      headers: {},
      bodyJsonString: "{}",
    }
  );
  assert.equal(__test.nonBlockingFetchResponse({ type: "fetch", requestId: "business", url: "/wham/accounts/check" }), null);
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

test("releases renderer lifecycle listeners when their browser client disconnects", () => {
  const sender = new EventEmitter();
  sender.send = () => true;
  let releasedA = 0;
  let releasedB = 0;

  __test.patchOfficialWebContents(sender);
  assert.equal(sender.getMaxListeners(), 0);
  requestContext.run({ clientId: "client-a" }, () => sender.once("destroyed", () => (releasedA += 1)));
  requestContext.run({ clientId: "client-b" }, () => sender.once("destroyed", () => (releasedB += 1)));

  assert.equal(sender.listenerCount("destroyed"), 2);
  assert.equal(__test.releaseOfficialRendererClient("client-a"), 1);
  assert.equal(releasedA, 1);
  assert.equal(releasedB, 0);
  assert.equal(sender.listenerCount("destroyed"), 1);
  assert.equal(__test.releaseOfficialRendererClient("client-a"), 0);

  __test.releaseOfficialRendererClient("client-b");
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
  observer.observeThread("thread-known");
  assert.equal(writes.length, 2);
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
  assert.equal(tracker.observeResponse(JSON.stringify({ id: 41, result: { data: [] } })), 0);
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

test("keeps cached catalog entries while the official bootstrap is incomplete", () => {
  const cached = {
    catalogSnapshot: {
      revision: 8,
      isComplete: false,
      hosts: [{ hostId: "local", isComplete: false }],
      entries: [{ hostId: "local", threadId: "thread-a" }],
    },
    globalStateEntries: [{ key: "old", value: true }],
  };
  const fresh = {
    catalogSnapshot: {
      revision: 0,
      isComplete: false,
      hosts: [{ hostId: "local", isComplete: false }],
      entries: [{ hostId: "local", threadId: "thread-b" }],
    },
    globalStateEntries: [{ key: "new", value: true }],
  };

  const merged = __test.retainCachedSidebarCatalog(fresh, cached);
  assert.deepEqual(
    merged.catalogSnapshot.entries.map((entry) => entry.threadId),
    ["thread-b", "thread-a"]
  );
  assert.equal(merged.globalStateEntries, fresh.globalStateEntries);
  const mergedHosts = __test.retainCachedSidebarCatalog(fresh, {
    ...cached,
    catalogSnapshot: {
      ...cached.catalogSnapshot,
      hosts: [{ hostId: "remote", isComplete: false }],
      entries: [],
    },
  });
  assert.deepEqual(
    mergedHosts.catalogSnapshot.hosts.map((host) => host.hostId),
    ["local", "remote"]
  );
  assert.equal(
    __test.retainCachedSidebarCatalog(
      { ...fresh, catalogSnapshot: { ...fresh.catalogSnapshot, isComplete: true } },
      cached
    ).catalogSnapshot.isComplete,
    true
  );
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
  observer.observeSidebarBootstrap({ catalogSnapshot: { entries: [{ hostId: "local", threadId: "thread-a" }, { hostId: "local", threadId: "thread-b" }] } });
  observer.observeSidebarBootstrap({ catalogSnapshot: { entries: [{ hostId: "local", threadId: "thread-b" }, { hostId: "local", threadId: "thread-c" }] } });

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
