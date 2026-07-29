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
  const server = http.createServer();
  const hub = createWsHub(server, {
    createAppHostRelay() {},
    handleNotificationEvent() {},
    isAuthed: () => true,
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
});
