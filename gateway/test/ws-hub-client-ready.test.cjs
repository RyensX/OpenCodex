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

test("notifies runtime listeners after a browser client completes hello", async (t) => {
  const disconnectedClients = [];
  let resolveDisconnected;
  const disconnected = new Promise((resolve) => {
    resolveDisconnected = resolve;
  });
  const server = http.createServer();
  const hub = createWsHub(server, {
    clientDisconnectGraceMs: 20,
    createAppHostRelay() {},
    handleNotificationEvent() {},
    isAuthed: () => true,
    onClientDisconnected({ clientId }) {
      disconnectedClients.push(clientId);
      resolveDisconnected();
    },
  });
  const readyClients = [];
  hub.onClientReady(({ clientId }) => readyClients.push(clientId));
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
  await disconnected;
  assert.deepEqual(disconnectedClients, ["ready-client"]);
});

test("only the newest socket owns client disconnect lifecycle", async (t) => {
  const disconnectedClients = [];
  let resolveFinalDisconnect;
  const finalDisconnect = new Promise((resolve) => {
    resolveFinalDisconnect = resolve;
  });
  const server = http.createServer();
  createWsHub(server, {
    clientDisconnectGraceMs: 20,
    createAppHostRelay() {},
    handleNotificationEvent() {},
    isAuthed: () => true,
    onClientDisconnected({ clientId }) {
      disconnectedClients.push(clientId);
      resolveFinalDisconnect();
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const url = `ws://127.0.0.1:${server.address().port}/ws`;
  const first = new WebSocket(url);
  const second = new WebSocket(url);
  t.after(async () => {
    first.close();
    second.close();
    await new Promise((resolve) => server.close(resolve));
  });

  await Promise.all([
    new Promise((resolve, reject) => {
      first.once("open", resolve);
      first.once("error", reject);
    }),
    new Promise((resolve, reject) => {
      second.once("open", resolve);
      second.once("error", reject);
    }),
  ]);
  first.send(JSON.stringify({ type: "hello", clientId: "reconnect-client" }));
  await waitForMessage(first, (message) => message.type === "hello-ack");
  second.send(JSON.stringify({ type: "hello", clientId: "reconnect-client" }));
  await waitForMessage(second, (message) => message.type === "hello-ack");
  assert.deepEqual(disconnectedClients, []);

  first.close();
  await new Promise((resolve) => first.once("close", resolve));
  assert.deepEqual(disconnectedClients, []);

  second.close();
  await new Promise((resolve) => second.once("close", resolve));
  await finalDisconnect;
  assert.deepEqual(disconnectedClients, ["reconnect-client"]);
});

test("closes a socket that tries to change its client identity", async (t) => {
  const disconnectedClients = [];
  let resolveDisconnected;
  const disconnected = new Promise((resolve) => {
    resolveDisconnected = resolve;
  });
  const server = http.createServer();
  createWsHub(server, {
    clientDisconnectGraceMs: 20,
    createAppHostRelay() {},
    handleNotificationEvent() {},
    isAuthed: () => true,
    onClientDisconnected({ clientId }) {
      disconnectedClients.push(clientId);
      resolveDisconnected();
    },
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
  socket.send(JSON.stringify({ type: "hello", clientId: "first-client" }));
  await waitForMessage(socket, (message) => message.type === "hello-ack");

  const closed = new Promise((resolve) => socket.once("close", (code) => resolve(code)));
  socket.send(JSON.stringify({ type: "hello", clientId: "second-client" }));

  assert.equal(await closed, 1008);
  await disconnected;
  assert.deepEqual(disconnectedClients, ["first-client"]);
});

test("keeps renderer subscriptions across a transient WebSocket reconnect", async (t) => {
  const disconnectedClients = [];
  const server = http.createServer();
  createWsHub(server, {
    clientDisconnectGraceMs: 50,
    createAppHostRelay() {},
    handleNotificationEvent() {},
    isAuthed: () => true,
    onClientDisconnected({ clientId }) {
      disconnectedClients.push(clientId);
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const url = `ws://127.0.0.1:${server.address().port}/ws`;
  const first = new WebSocket(url);
  let second;
  t.after(async () => {
    first.close();
    second?.close();
    await new Promise((resolve) => server.close(resolve));
  });
  await new Promise((resolve, reject) => {
    first.once("open", resolve);
    first.once("error", reject);
  });
  first.send(JSON.stringify({ type: "hello", clientId: "transient-client" }));
  await waitForMessage(first, (message) => message.type === "hello-ack");
  first.close();
  await new Promise((resolve) => first.once("close", resolve));

  second = new WebSocket(url);
  await new Promise((resolve, reject) => {
    second.once("open", resolve);
    second.once("error", reject);
  });
  second.send(JSON.stringify({ type: "hello", clientId: "transient-client" }));
  await waitForMessage(second, (message) => message.type === "hello-ack");
  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.deepEqual(disconnectedClients, []);
});
