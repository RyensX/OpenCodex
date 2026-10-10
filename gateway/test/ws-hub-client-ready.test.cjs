const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const WebSocket = require("ws");

const { createWsHub } = require("../runtime/ipc/ws-hub.cjs");

function waitForMessage(socket, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for WebSocket message"));
    }, 2000);
    const onMessage = (raw) => {
      const message = JSON.parse(String(raw));
      if (!predicate(message)) return;
      cleanup();
      resolve(message);
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("message", onMessage);
    };
    socket.on("message", onMessage);
  });
}

function waitForOpen(socket) {
  return new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

function waitForClose(socket) {
  return new Promise((resolve) => socket.once("close", resolve));
}

test("notifies runtime listeners after a browser client completes hello", async (t) => {
  const server = http.createServer();
  const hub = createWsHub(server, {
    createAppHostRelay() {},
    handleNotificationEvent() {},
    isAuthed: () => true,
  });
  const readyClients = [];
  const removedClients = [];
  let resolveRemoved;
  const clientRemoved = new Promise((resolve) => {
    resolveRemoved = resolve;
  });
  hub.onClientReady(({ clientId }) => readyClients.push(clientId));
  hub.onClientRemoved(({ clientId }) => {
    removedClients.push(clientId);
    resolveRemoved();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/ws`);
  t.after(async () => {
    socket.close();
    await new Promise((resolve) => server.close(resolve));
  });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.send(JSON.stringify({ type: "hello", clientId: "ready-client" }));
  await waitForMessage(socket, (message) => message.type === "hello-ack");

  assert.deepEqual(readyClients, ["ready-client"]);
  socket.close();
  await waitForClose(socket);
  await clientRemoved;
  assert.deepEqual(removedClients, ["ready-client"]);
});

test("restores app-host downlink before the first post-reconnect data frame", async (t) => {
  const server = http.createServer();
  const relays = [];
  const sockets = [];
  createWsHub(server, {
    createAppHostRelay({ onMessage }) {
      let resolveClosed;
      const relay = {
        closed: false,
        closedPromise: new Promise((resolve) => {
          resolveClosed = resolve;
        }),
        close() {
          this.closed = true;
          resolveClosed();
        },
        emitMessage: onMessage,
        postMessage() {},
      };
      relays.push(relay);
      return relay;
    },
    handleNotificationEvent() {},
    isAuthed: () => true,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const socket of sockets) socket.close();
    await new Promise((resolve) => server.close(resolve));
  });

  const url = `ws://127.0.0.1:${server.address().port}/ws`;
  const clientId = "reconnecting-client";
  const portId = `app-host-${clientId}-fixture`;
  const first = new WebSocket(url);
  sockets.push(first);
  await waitForOpen(first);
  first.send(JSON.stringify({ type: "hello", clientId }));
  await waitForMessage(first, (message) => message.type === "hello-ack");
  first.send(JSON.stringify({ type: "app-host-connect", clientId, portId }));
  await waitForMessage(first, (message) => message.type === "app-host-port-connected");

  first.close();
  await waitForClose(first);
  assert.equal(relays[0].closed, false);

  const second = new WebSocket(url);
  sockets.push(second);
  await waitForOpen(second);
  second.send(JSON.stringify({ type: "hello", clientId }));
  await waitForMessage(second, (message) => message.type === "hello-ack");
  // bridge 在 hello-ack 后主动重发 connect，不依赖新的 browser-to-official RPC 数据。
  second.send(JSON.stringify({ type: "app-host-connect", clientId, portId }));
  await waitForMessage(second, (message) => message.type === "app-host-port-connected");

  const officialMessage = waitForMessage(
    second,
    (message) => message.type === "app-host-port-message" && message.data === "thread/updated"
  );
  relays[0].emitMessage("thread/updated");
  await officialMessage;
  assert.equal(relays.length, 1);
});

test("keeps the detached relay when the old socket closes after replacement hello", async (t) => {
  const server = http.createServer();
  const relays = [];
  const sockets = [];
  createWsHub(server, {
    createAppHostRelay({ onMessage }) {
      const relay = {
        closed: false,
        emitMessage: onMessage,
        close() {
          this.closed = true;
        },
        postMessage() {},
      };
      relays.push(relay);
      return relay;
    },
    handleNotificationEvent() {},
    isAuthed: () => true,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const socket of sockets) socket.close();
    await new Promise((resolve) => server.close(resolve));
  });

  const url = `ws://127.0.0.1:${server.address().port}/ws`;
  const clientId = "replacement-race-client";
  const portId = `app-host-${clientId}-fixture`;
  const first = new WebSocket(url);
  sockets.push(first);
  await waitForOpen(first);
  first.send(JSON.stringify({ type: "hello", clientId }));
  await waitForMessage(first, (message) => message.type === "hello-ack");
  first.send(JSON.stringify({ type: "app-host-connect", clientId, portId }));
  await waitForMessage(first, (message) => message.type === "app-host-port-connected");

  const second = new WebSocket(url);
  sockets.push(second);
  await waitForOpen(second);
  second.send(JSON.stringify({ type: "hello", clientId }));
  await waitForMessage(second, (message) => message.type === "hello-ack");
  await waitForClose(first);
  assert.equal(relays[0].closed, false);

  second.send(JSON.stringify({ type: "app-host-connect", clientId, portId }));
  await waitForMessage(second, (message) => message.type === "app-host-port-connected");
  const downlink = waitForMessage(
    second,
    (message) => message.type === "app-host-port-message" && message.data === "thread/read-result"
  );
  relays[0].emitMessage("thread/read-result");
  await downlink;
  assert.equal(relays.length, 1);
});

test("replaces an overlapping socket for the same browser client before broadcasts", async (t) => {
  const server = http.createServer();
  const hub = createWsHub(server, {
    createAppHostRelay() {},
    handleNotificationEvent() {},
    isAuthed: () => true,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const sockets = [];
  t.after(async () => {
    for (const socket of sockets) socket.close();
    await new Promise((resolve) => server.close(resolve));
  });

  const url = `ws://127.0.0.1:${server.address().port}/ws`;
  const first = new WebSocket(url);
  sockets.push(first);
  await waitForOpen(first);
  first.send(JSON.stringify({ type: "hello", clientId: "same-client" }));
  await waitForMessage(first, (message) => message.type === "hello-ack");

  const firstClosed = waitForClose(first);
  const second = new WebSocket(url);
  sockets.push(second);
  await waitForOpen(second);
  second.send(JSON.stringify({ type: "hello", clientId: "same-client" }));
  await waitForMessage(second, (message) => message.type === "hello-ack");
  await firstClosed;

  const broadcast = waitForMessage(second, (message) => message.type === "state-update");
  assert.equal(hub.broadcast({ type: "state-update" }), 1);
  await broadcast;
  assert.equal(hub.clients.size, 1);
});

// 覆盖手机断网时仍有 RPC 回包、多个官方端口恢复和重复握手，避免只测空闲重连。
for (const scenario of ["offline-response", "multiple-ports", "overlapping-connect", "offline-overflow", "repeated-reconnect"]) {
  test(`preserves RPC sessions across ${scenario}`, async (t) => {
    const server = http.createServer();
    const relays = [];
    const sockets = [];
    const hub = createWsHub(server, {
      maxBufferedBytes: scenario === "offline-overflow" ? 1024 : undefined,
      createAppHostRelay({ portId, onMessage }) {
        const relay = {
          portId, closed: false, messages: [], emit: onMessage,
          close() { this.closed = true; },
          postMessage(data) { this.messages.push(data); return true; },
        };
        relays.push(relay);
        return relay;
      },
      isAuthed: () => true,
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(async () => {
      for (const socket of sockets) socket.close();
      await new Promise((resolve) => server.close(resolve));
    });
    const url = `ws://127.0.0.1:${server.address().port}/ws`;
    const clientId = `rpc-${scenario}`;
    const first = new WebSocket(url);
    sockets.push(first);
    await waitForOpen(first);
    first.send(JSON.stringify({ type: "hello", clientId }));
    await waitForMessage(first, (m) => m.type === "hello-ack");
    const ports = scenario === "multiple-ports" || scenario === "repeated-reconnect" ? ["port-a", "port-b"] : ["port-a"];
    for (const portId of ports) {
      first.send(JSON.stringify({ type: "app-host-connect", clientId, portId }));
      await waitForMessage(first, (m) => m.type === "app-host-port-connected" && m.portId === portId);
    }
    if (scenario !== "overlapping-connect") {
      const removed = new Promise((resolve) => hub.onClientRemoved(resolve));
      first.close();
      await removed;
      if (scenario === "offline-response") {
        // RPC 回包必须保留；静默丢帧会使页面的历史读取 Promise 永远等不到完成。
        relays[0].emit("history-response");
        assert.equal(relays[0].closed, false);
      }
      if (scenario === "offline-overflow") {
        // 超过离线字节上限后明确关闭旧会话，后续连接应新建端口且不能重放不完整结果。
        relays[0].emit("x".repeat(2048));
        assert.equal(relays[0].closed, true);
      }
      if (scenario === "repeated-reconnect") {
        // 两个端口各保留三条回包，后续断线再次验证旧队列已清空。
        for (const relay of relays) {
          for (let index = 0; index < 3; index++) relay.emit(`${relay.portId}:1:${index}`);
        }
      }
    }
    const second = new WebSocket(url);
    sockets.push(second);
    const received = [];
    second.on("message", (raw) => received.push(JSON.parse(String(raw))));
    await waitForOpen(second);
    second.send(JSON.stringify({ type: "hello", clientId }));
    await waitForMessage(second, (m) => m.type === "hello-ack");
    for (const portId of ports) {
      second.send(JSON.stringify({ type: "app-host-connect", clientId, portId }));
      await waitForMessage(second, (m) => m.type === "app-host-port-connected" && m.portId === portId);
    }
    const response = waitForMessage(second, (m) => m.type === "app-host-port-message" && m.data === "model-response");
    const activeRelay = scenario === "offline-overflow" ? relays[1] : relays[0];
    activeRelay.emit("model-response");
    await response;
    assert.equal(relays.length, ports.length + (scenario === "offline-overflow" ? 1 : 0));
    assert.equal(activeRelay.closed, false);
    if (scenario === "offline-response") {
      assert.equal(received.some((m) => m.data === "history-response"), true);
    }
    if (scenario === "offline-overflow") {
      assert.equal(received.some((m) => typeof m.data === "string" && m.data.startsWith("xxx")), false);
    }
    if (scenario === "repeated-reconnect") {
      for (const portId of ports) {
        const frames = received.filter((m) => m.portId === portId && m.type === "app-host-port-message");
        assert.deepEqual(frames.slice(0, 3).map((m) => m.data), [0, 1, 2].map((index) => `${portId}:1:${index}`));
        const connectedIndex = received.findIndex((m) => m.portId === portId && m.type === "app-host-port-connected");
        const firstDataIndex = received.findIndex((m) => m.portId === portId && m.type === "app-host-port-message");
        assert.ok(connectedIndex < firstDataIndex);
      }
      // 再断开并由第三个 socket 接管，断线期间端口间的结果不能串流或重复投递。
      const removedAgain = new Promise((resolve) => hub.onClientRemoved(resolve));
      second.close();
      await removedAgain;
      for (const relay of relays) relay.emit(`${relay.portId}:2`);
      const third = new WebSocket(url);
      sockets.push(third);
      const thirdReceived = [];
      third.on("message", (raw) => thirdReceived.push(JSON.parse(String(raw))));
      await waitForOpen(third);
      third.send(JSON.stringify({ type: "hello", clientId }));
      await waitForMessage(third, (m) => m.type === "hello-ack");
      for (const portId of ports) {
        const replay = waitForMessage(third, (m) => m.portId === portId && m.data === `${portId}:2`);
        third.send(JSON.stringify({ type: "app-host-connect", clientId, portId }));
        await replay;
      }
      assert.deepEqual(thirdReceived.filter((m) => m.type === "app-host-port-message").map((m) => m.data), ["port-a:2", "port-b:2"]);
      assert.equal(relays.length, 2);
      assert.equal(relays.every((relay) => !relay.closed), true);
    }
  });
}
