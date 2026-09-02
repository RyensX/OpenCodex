const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const WebSocket = require("ws");

const { createWsHub, __test } = require("../runtime/ipc/ws-hub.cjs");
const appHostMessageCodec = require("../../web-shell/codex-app-host-message-codec.js");

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

function waitForCondition(predicate, description) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${description}`)), 2000);
    const check = () => {
      let matched = false;
      try {
        matched = predicate();
      } catch (error) {
        clearTimeout(timer);
        reject(error);
        return;
      }
      if (matched) {
        clearTimeout(timer);
        resolve();
        return;
      }
      setImmediate(check);
    };
    check();
  });
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

test("bridges structured AppHost values while retaining legacy frames", async (t) => {
  const server = http.createServer();
  const relays = [];
  createWsHub(server, {
    createAppHostRelay({ onMessage, onError, onClose }) {
      const relay = {
        messages: [],
        emitClose: onClose,
        emitError: onError,
        emitMessage: onMessage,
        close(reason) {
          this.closeReason = reason;
        },
        postMessage(value) {
          this.messages.push(value);
          return true;
        },
      };
      relays.push(relay);
      return relay;
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
  const clientId = "structured-client";
  const portId = "structured-port";
  socket.send(JSON.stringify({ type: "hello", clientId }));
  await waitForMessage(socket, (message) => message.type === "hello-ack");
  socket.send(JSON.stringify({ type: "app-host-connect", clientId, portId }));
  await waitForMessage(socket, (message) => message.type === "app-host-port-connected");

  const value = { type: "turn/start", nested: [undefined, 7n] };
  socket.send(
    JSON.stringify({
      type: "app-host-port-message",
      clientId,
      portId,
      ...appHostMessageCodec.encodeMessageData(value),
    })
  );
  await waitForCondition(() => relays[0].messages.length >= 1, "first AppHost relay message");
  assert.deepEqual(relays[0].messages[0], value);

  socket.send(JSON.stringify({ type: "app-host-port-message", clientId, portId, data: "legacy" }));
  await waitForCondition(() => relays[0].messages.length >= 2, "legacy AppHost relay message");
  assert.equal(relays[0].messages[1], "legacy");

  const downlink = waitForMessage(socket, (message) => message.type === "app-host-port-message");
  relays[0].emitMessage(value);
  const wire = await downlink;
  assert.equal(wire.dataEncoding, appHostMessageCodec.encoding);
  assert.deepEqual(appHostMessageCodec.decodeMessageData(wire), value);
});

test("reports one relay error and isolates stale replacement callbacks", async (t) => {
  const server = http.createServer();
  const relays = [];
  createWsHub(server, {
    createAppHostRelay({ onMessage, onError, onClose }) {
      const relayIndex = relays.length;
      const relay = {
        emitClose: onClose,
        emitError: onError,
        emitMessage: onMessage,
        close(reason) {
          onClose(reason);
        },
        postMessage() {
          if (relayIndex === 0) throw new Error("post failed");
          return true;
        },
      };
      relays.push(relay);
      return relay;
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
  const clientId = "failure-client";
  const portId = "failure-port";
  socket.send(JSON.stringify({ type: "hello", clientId }));
  await waitForMessage(socket, (message) => message.type === "hello-ack");
  socket.send(JSON.stringify({ type: "app-host-connect", clientId, portId }));
  await waitForMessage(socket, (message) => message.type === "app-host-port-connected");
  socket.send(
    JSON.stringify({
      type: "app-host-port-message",
      clientId,
      portId,
      ...appHostMessageCodec.encodeMessageData({ request: "fails" }),
    })
  );
  const error = await waitForMessage(socket, (message) => message.type === "app-host-port-error");
  assert.match(error.error, /post failed/);
  socket.send(JSON.stringify({ type: "app-host-connect", clientId, portId }));
  await waitForMessage(socket, (message) => message.type === "app-host-port-connected");
  assert.equal(relays.length, 2);
  relays[0].emitClose("late-close");
  relays[0].emitError(new Error("late-error"));
  const downlink = waitForMessage(socket, (message) => message.type === "app-host-port-message");
  relays[1].emitMessage({ type: "replacement/ok" });
  await downlink;
  assert.equal(relays.length, 2);
});

test("reports one terminal error for official encode and browser decode failures", async (t) => {
  const server = http.createServer();
  const relays = [];
  const events = [];
  createWsHub(server, {
    createAppHostRelay({ onMessage, onError, onClose }) {
      const relay = {
        emitClose: onClose,
        emitError: onError,
        emitMessage: onMessage,
        close(reason) {
          // 真实 MessagePort close 会触发 onClose，测试不能只检查 map 是否删除。
          onClose(reason);
        },
        postMessage() {
          return true;
        },
      };
      relays.push(relay);
      return relay;
    },
    handleNotificationEvent() {},
    isAuthed: () => true,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/ws`);
  socket.on("message", (raw) => events.push(JSON.parse(String(raw))));
  t.after(async () => {
    socket.close();
    await new Promise((resolve) => server.close(resolve));
  });
  await waitForOpen(socket);
  const clientId = "terminal-event-client";
  const portId = "terminal-event-port";
  socket.send(JSON.stringify({ type: "hello", clientId }));
  await waitForMessage(socket, (message) => message.type === "hello-ack");
  socket.send(JSON.stringify({ type: "app-host-connect", clientId, portId }));
  await waitForMessage(socket, (message) => message.type === "app-host-port-connected");

  relays[0].emitMessage(Symbol("unsupported"));
  await waitForMessage(socket, (message) => message.type === "app-host-port-error");
  relays[0].emitError(new Error("late-error"));
  relays[0].emitClose("late-close");
  assert.equal(events.filter((message) => message.type === "app-host-port-error").length, 1);
  assert.equal(events.filter((message) => message.type === "app-host-port-close").length, 0);

  socket.send(JSON.stringify({ type: "app-host-connect", clientId, portId }));
  await waitForMessage(socket, (message) => message.type === "app-host-port-connected");
  socket.send(JSON.stringify({ type: "app-host-port-message", clientId, portId, dataEncoding: "unknown", data: null }));
  await waitForMessage(
    socket,
    (message) => message.type === "app-host-port-error" && message.portId === portId
  );
  assert.equal(events.filter((message) => message.type === "app-host-port-error").length, 2);
  assert.equal(events.filter((message) => message.type === "app-host-port-close").length, 0);
});

test("isolates a failed AppHost port from sibling ports and clients", async (t) => {
  const server = http.createServer();
  const relays = [];
  createWsHub(server, {
    createAppHostRelay({ onMessage, onError, onClose, clientId, portId }) {
      const relay = {
        clientId,
        emitClose: onClose,
        emitError: onError,
        emitMessage: onMessage,
        portId,
        close(reason) {
          onClose(reason);
        },
        postMessage() {
          return true;
        },
      };
      relays.push(relay);
      return relay;
    },
    handleNotificationEvent() {},
    isAuthed: () => true,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const first = new WebSocket(`ws://127.0.0.1:${server.address().port}/ws`);
  const second = new WebSocket(`ws://127.0.0.1:${server.address().port}/ws`);
  t.after(async () => {
    first.close();
    second.close();
    await new Promise((resolve) => server.close(resolve));
  });
  await Promise.all([waitForOpen(first), waitForOpen(second)]);
  const firstClient = "isolated-client-one";
  const secondClient = "isolated-client-two";
  first.send(JSON.stringify({ type: "hello", clientId: firstClient }));
  second.send(JSON.stringify({ type: "hello", clientId: secondClient }));
  await Promise.all([
    waitForMessage(first, (message) => message.type === "hello-ack"),
    waitForMessage(second, (message) => message.type === "hello-ack"),
  ]);
  const connect = (socket, clientId, portId) => {
    socket.send(JSON.stringify({ type: "app-host-connect", clientId, portId }));
    return waitForMessage(socket, (message) => message.type === "app-host-port-connected" && message.portId === portId);
  };
  await Promise.all([
    connect(first, firstClient, "isolated-port-one"),
    connect(first, firstClient, "isolated-port-two"),
    connect(second, secondClient, "isolated-port-three"),
  ]);

  const firstPortError = waitForMessage(
    first,
    (message) => message.type === "app-host-port-error" && message.portId === "isolated-port-one"
  );
  const firstRelay = relays.find((relay) => relay.portId === "isolated-port-one");
  const secondRelay = relays.find((relay) => relay.portId === "isolated-port-two");
  const thirdRelay = relays.find((relay) => relay.portId === "isolated-port-three");
  assert.ok(firstRelay && secondRelay && thirdRelay);
  firstRelay.emitError(new Error("isolated failure"));
  await firstPortError;

  const secondPortMessage = waitForMessage(
    first,
    (message) => message.type === "app-host-port-message" && message.portId === "isolated-port-two"
  );
  const thirdPortMessage = waitForMessage(
    second,
    (message) => message.type === "app-host-port-message" && message.portId === "isolated-port-three"
  );
  secondRelay.emitMessage({ method: "thread/list" });
  thirdRelay.emitMessage({ method: "thread/read" });
  assert.deepEqual(await secondPortMessage, {
    type: "app-host-port-message",
    portId: "isolated-port-two",
    data: ["object", [["method", ["string", "thread/list"]]]],
    dataEncoding: appHostMessageCodec.encoding,
  });
  assert.deepEqual(await thirdPortMessage, {
    type: "app-host-port-message",
    portId: "isolated-port-three",
    data: ["object", [["method", ["string", "thread/read"]]]],
    dataEncoding: appHostMessageCodec.encoding,
  });
});

test("closes only the relay when forwarding to the browser websocket fails", async (t) => {
  const server = http.createServer();
  const relays = [];
  const hub = createWsHub(server, {
    createAppHostRelay({ onMessage, onError, onClose }) {
      const relay = {
        closeReason: "",
        emitMessage: onMessage,
        close(reason) {
          this.closeReason = reason;
          onClose(reason);
        },
        postMessage() {
          return true;
        },
      };
      relays.push(relay);
      return relay;
    },
    handleNotificationEvent() {},
    isAuthed: () => true,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/ws`);
  const originalSend = socket.send.bind(socket);
  t.after(async () => {
    socket.send = originalSend;
    socket.close();
    await new Promise((resolve) => server.close(resolve));
  });
  await waitForOpen(socket);
  const clientId = "send-failure-client";
  const portId = "send-failure-port";
  socket.send(JSON.stringify({ type: "hello", clientId }));
  await waitForMessage(socket, (message) => message.type === "hello-ack");
  socket.send(JSON.stringify({ type: "app-host-connect", clientId, portId }));
  await waitForMessage(socket, (message) => message.type === "app-host-port-connected");

  const serverSocket = [...hub.clients][0];
  const originalServerSend = serverSocket.send.bind(serverSocket);
  serverSocket.send = () => {
    throw new Error("browser websocket send failed");
  };
  relays[0].emitMessage({ method: "turn/start" });
  assert.equal(relays[0].closeReason, "forward_to_browser_failed");
  serverSocket.send = originalServerSend;
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

test("keeps the WebSocket ingress boundary at 64 MiB", () => {
  assert.equal(__test.webSocketServerOptions().maxPayload, 64 * 1024 * 1024);
  assert.equal(__test.webSocketServerOptions({ maxPayloadBytes: 2 * 1024 * 1024 }).maxPayload, 2 * 1024 * 1024);
});
