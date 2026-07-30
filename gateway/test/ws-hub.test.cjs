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
