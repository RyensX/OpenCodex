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
        closedPromise: new Promise((resolve) => {
          resolveClosed = resolve;
        }),
        close: resolveClosed,
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
  await relays[0].closedPromise;

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
  relays[1].emitMessage("thread/updated");
  await officialMessage;
  assert.equal(relays.length, 2);
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
