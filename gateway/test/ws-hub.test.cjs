const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const WebSocket = require("ws");

const { createWsHub, __test } = require("../runtime/ipc/ws-hub.cjs");

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

test("recreates an app-host relay when the browser WebSocket reconnects", async (t) => {
  const server = http.createServer();
  const relays = [];
  const sockets = [];
  createWsHub(server, {
    createAppHostRelay() {
      let resolveClosed;
      const relay = {
        closed: false,
        closedPromise: new Promise((resolve) => {
          resolveClosed = resolve;
        }),
        messages: [],
        close() {
          this.closed = true;
          resolveClosed();
        },
        postMessage(message) {
          this.messages.push(message);
        },
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
  assert.equal(relays.length, 1);

  // 服务端会在旧 WS 关闭时释放 relay；新 WS 的第一帧必须能恢复同一个浏览器 MessagePort。
  first.close();
  await waitForClose(first);
  await relays[0].closedPromise;
  assert.equal(relays[0].closed, true);

  const second = new WebSocket(url);
  sockets.push(second);
  await waitForOpen(second);
  second.send(JSON.stringify({ type: "hello", clientId }));
  await waitForMessage(second, (message) => message.type === "hello-ack");
  second.send(JSON.stringify({ type: "app-host-port-message", clientId, portId, data: "thread/list" }));
  await waitForMessage(second, (message) => message.type === "app-host-port-connected");

  assert.equal(relays.length, 2);
  assert.deepEqual(relays[1].messages, ["thread/list"]);
});

test("caps app-host relays per browser socket", async (t) => {
  const server = http.createServer();
  const relays = [];
  createWsHub(server, {
    createAppHostRelay() {
      const relay = {
        closeReason: "",
        close(reason) {
          this.closeReason = reason;
        },
        postMessage() {},
      };
      relays.push(relay);
      return relay;
    },
    handleNotificationEvent() {},
    isAuthed: () => true,
    maxAppHostRelays: 2,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/ws`);
  t.after(async () => {
    socket.close();
    await new Promise((resolve) => server.close(resolve));
  });
  await waitForOpen(socket);
  socket.send(JSON.stringify({ type: "hello", clientId: "relay-limit-client" }));
  await waitForMessage(socket, (message) => message.type === "hello-ack");

  for (let index = 0; index < 3; index += 1) {
    const portId = `relay-limit-${index}`;
    socket.send(JSON.stringify({ type: "app-host-connect", clientId: "relay-limit-client", portId }));
    await waitForMessage(
      socket,
      (message) => message.type === "app-host-port-connected" && message.portId === portId
    );
  }

  assert.equal(relays.length, 3);
  assert.equal(relays[0].closeReason, "relay_limit");
  assert.equal(relays[1].closeReason, "");
});

test("routes browser IPC over the authenticated websocket and preserves request identity", async (t) => {
  const server = http.createServer();
  const invocations = [];
  createWsHub(server, {
    createAppHostRelay() {},
    async handleIpcInvoke(invocation) {
      invocations.push(invocation);
      // 即使底层 handler 意外返回同名字段，hub 也必须保留已认证请求自己的回包身份。
      return {
        ok: true,
        requestId: "forged-request-id",
        type: "forged-result-type",
        value: { channel: invocation.request.channel },
      };
    },
    handleNotificationEvent() {},
    isAuthed: () => true,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/ws`);
  t.after(async () => {
    socket.close();
    await new Promise((resolve) => server.close(resolve));
  });
  await waitForOpen(socket);
  socket.send(JSON.stringify({ type: "hello", clientId: "ipc-client" }));
  await waitForMessage(socket, (message) => message.type === "hello-ack");

  // clientId 必须来自 hello 后的 socket 身份；业务 request 只携带 channel/args。
  socket.send(
    JSON.stringify({
      type: "opencodex:ipc-invoke",
      clientId: "ipc-client",
      requestId: "ipc-request-1",
      request: { channel: "account-info", args: [] },
    })
  );
  const response = await waitForMessage(
    socket,
    (message) => message.type === "opencodex:ipc-result" && message.requestId === "ipc-request-1"
  );

  assert.deepEqual(response.value, { channel: "account-info" });
  assert.equal(response.ok, true);
  assert.equal(response.type, "opencodex:ipc-result");
  assert.equal(response.requestId, "ipc-request-1");
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0].clientId, "ipc-client");
});

test("skips serialization without clients and terminates a heavily backpressured socket", () => {
  const server = http.createServer();
  const hub = createWsHub(server, {
    createAppHostRelay() {},
    handleNotificationEvent() {},
    isAuthed: () => true,
    maxBufferedBytes: 1024,
  });
  const unserializable = {
    toJSON() {
      throw new Error("must not serialize without a client");
    },
  };
  assert.equal(hub.broadcast(unserializable), 0);

  const slowSocket = {
    OPEN: 1,
    readyState: 1,
    bufferedAmount: 2048,
    terminated: false,
    terminate() {
      this.terminated = true;
      this.readyState = 3;
    },
  };
  hub.clients.add(slowSocket);
  assert.equal(hub.broadcast(unserializable), 0);
  assert.equal(slowSocket.terminated, true);
  assert.equal(slowSocket.__opencodexBackpressureTerminated, true);
  hub.clients.delete(slowSocket);
  server.close();
});

test("deduplicates only identical short-window broadcasts per browser socket", () => {
  const server = http.createServer();
  const hub = createWsHub(server, {
    createAppHostRelay() {},
    handleNotificationEvent() {},
    isAuthed: () => true,
  });
  const messages = [];
  const socket = {
    OPEN: 1,
    bufferedAmount: 0,
    readyState: 1,
    send(message) {
      messages.push(message);
    },
  };
  hub.clients.add(socket);
  const options = { dedupeKey: "app-list", dedupeWindowMs: 10_000 };

  assert.equal(hub.broadcast({ type: "app-list", revision: 1 }, options), 1);
  assert.equal(hub.broadcast({ type: "app-list", revision: 1 }, options), 0);
  assert.equal(hub.broadcast({ type: "app-list", revision: 2 }, options), 1);
  assert.equal(messages.length, 2);
  assert.notEqual(messages[0], messages[1]);

  hub.clients.delete(socket);
  server.close();
});

test("bounds diagnostic route extraction for wide payload arrays", () => {
  assert.equal(__test.routeIdFromPayload({ payload: [{ requestId: "route-1" }] }), "route-1");
  let reads = 0;
  const wide = new Proxy(Array.from({ length: 50_000 }, () => ({})), {
    get(target, key, receiver) {
      if (/^\d+$/.test(String(key))) reads += 1;
      return Reflect.get(target, key, receiver);
    },
  });
  assert.equal(__test.routeIdFromPayload(wide), "");
  assert.ok(reads > 0 && reads <= 128, `diagnostic route scan read ${reads} array items`);
});
