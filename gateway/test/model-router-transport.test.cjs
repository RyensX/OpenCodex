const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const test = require("node:test");
const { createAppServerTransport } = require("../runtime/model-router/transport.cjs");

function fakeChild() {
  const child = new EventEmitter();
  const serverInput = new PassThrough();
  const serverOutput = new PassThrough();
  child.stdin = serverInput;
  child.stdout = serverOutput;
  child.stderr = new PassThrough();
  child.stdio = [serverInput, serverOutput, child.stderr];
  child.kill = () => true;
  return { child, serverInput, serverOutput };
}

function lineStream(stream, onMessage) {
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += chunk.toString("utf-8");
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (line) onMessage(JSON.parse(line));
    }
  });
}

function waitFor(predicate, timeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const poll = () => {
      const value = predicate();
      if (value) return resolve(value);
      if (Date.now() - startedAt >= timeoutMs) return reject(new Error("condition timed out"));
      setTimeout(poll, 5);
    };
    poll();
  });
}

function writeClient(stream, value) {
  return new Promise((resolve, reject) => {
    stream.write(value, (error) => (error ? reject(error) : resolve()));
  });
}

test("NDJSON transport handles fragments, concurrent internal requests and hidden notifications", async (t) => {
  let transport;
  const serverMessages = [];
  const publicMessages = [];
  transport = createAppServerTransport({
    async processClientMessage(message) {
      if (message.method === "turn/start" && message.params.model === "auto") {
        const route = await transport.request("router/classify", { threadId: message.params.threadId });
        message.params.model = route.model;
        message.params.effort = route.effort;
      }
      return message;
    },
  });
  const fake = fakeChild();
  transport.decorateChild(fake.child);
  t.after(() => fake.child.emit("close"));
  lineStream(fake.child.stdout, (message) => publicMessages.push(message));
  lineStream(fake.serverInput, (message) => {
    serverMessages.push(message);
    if (message.method === "router/classify") {
      const response = `${JSON.stringify({ id: message.id, result: { model: "terra", effort: "high" } })}\n`;
      // 服务端响应故意跨 chunk，验证 parser 不依赖单次 data 边界。
      fake.serverOutput.write(response.slice(0, 11));
      fake.serverOutput.write(response.slice(11));
      return;
    }
    fake.serverOutput.write(`${JSON.stringify({ id: message.id, result: { ok: true } })}\n`);
  });

  const frame = `${JSON.stringify({
    id: "external-turn",
    method: "turn/start",
    params: { threadId: "thread-1", model: "auto", input: [] },
  })}\n`;
  await writeClient(fake.child.stdin, frame.slice(0, 19));
  await writeClient(fake.child.stdin, frame.slice(19));
  const forwarded = await waitFor(() => serverMessages.find((message) => message.id === "external-turn"));
  assert.equal(forwarded.params.model, "terra");
  assert.equal(forwarded.params.effort, "high");
  await waitFor(() => publicMessages.some((message) => message.id === "external-turn"));
  assert.equal(publicMessages.some((message) => String(message.id || "").startsWith("opencodex.router:")), false);

  transport.registerInternalThread("internal-thread");
  fake.serverOutput.write(
    [
      JSON.stringify({ method: "item/completed", params: { threadId: "internal-thread", turnId: "internal-turn" } }),
      JSON.stringify({ method: "account/usage/updated", params: { total: 1 } }),
      "",
    ].join("\n")
  );
  await waitFor(() => publicMessages.some((message) => message.method === "account/usage/updated"));
  assert.equal(publicMessages.some((message) => message.params?.threadId === "internal-thread"), false);
});

test("manual model requests pass through without an internal classification request", async (t) => {
  const serverMessages = [];
  const transport = createAppServerTransport({ processClientMessage: (message) => message });
  const fake = fakeChild();
  transport.decorateChild(fake.child);
  t.after(() => fake.child.emit("close"));
  lineStream(fake.serverInput, (message) => serverMessages.push(message));
  await writeClient(
    fake.child.stdin,
    `${JSON.stringify({ id: 7, method: "turn/start", params: { threadId: "thread", model: "luna" } })}\n`
  );
  const forwarded = await waitFor(() => serverMessages[0]);
  assert.equal(forwarded.params.model, "luna");
  assert.equal(serverMessages.length, 1);
});

test("client frames classify concurrently while their real stdin order stays stable", async (t) => {
  let active = 0;
  let maximumActive = 0;
  const releases = new Map();
  const serverMessages = [];
  const transport = createAppServerTransport({
    async processClientMessage(message) {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => releases.set(message.id, resolve));
      active -= 1;
      return message;
    },
  });
  const fake = fakeChild();
  transport.decorateChild(fake.child);
  t.after(() => fake.child.emit("close"));
  lineStream(fake.serverInput, (message) => serverMessages.push(message));

  await Promise.all([
    writeClient(fake.child.stdin, `${JSON.stringify({ id: "first", method: "turn/start", params: {} })}\n`),
    writeClient(fake.child.stdin, `${JSON.stringify({ id: "second", method: "turn/start", params: {} })}\n`),
  ]);
  await waitFor(() => releases.size === 2);
  releases.get("second")();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(serverMessages.length, 0);
  releases.get("first")();
  await waitFor(() => serverMessages.length === 2);
  assert.equal(maximumActive, 2);
  assert.deepEqual(serverMessages.map((message) => message.id), ["first", "second"]);
});

test("unrelated thread hydration bypasses a pending turn while same-thread control stays ordered", async (t) => {
  let releaseTurn;
  const serverMessages = [];
  const transport = createAppServerTransport({
    async processClientMessage(message) {
      if (message.id === "turn-a") await new Promise((resolve) => (releaseTurn = resolve));
      return message;
    },
  });
  const fake = fakeChild();
  transport.decorateChild(fake.child);
  t.after(() => fake.child.emit("close"));
  lineStream(fake.serverInput, (message) => serverMessages.push(message));

  await Promise.all([
    writeClient(
      fake.child.stdin,
      `${JSON.stringify({ id: "turn-a", method: "turn/start", params: { threadId: "thread-a", input: [] } })}\n`
    ),
    writeClient(
      fake.child.stdin,
      `${JSON.stringify({ id: "interrupt-a", method: "turn/interrupt", params: { threadId: "thread-a", turnId: "a" } })}\n`
    ),
    writeClient(
      fake.child.stdin,
      `${JSON.stringify({ id: "read-b", method: "thread/read", params: { threadId: "thread-b" } })}\n`
    ),
  ]);

  await waitFor(() => serverMessages.length === 1);
  assert.deepEqual(serverMessages.map((message) => message.id), ["read-b"]);
  releaseTurn();
  await waitFor(() => serverMessages.length === 3);
  // A 的控制请求仍在 A 的 turn/start 之后，只有完全独立的 B 被提前发送。
  assert.deepEqual(serverMessages.map((message) => message.id), ["read-b", "turn-a", "interrupt-a"]);
});

test("hydration requests for the same thread cannot overtake each other", async (t) => {
  const releases = new Map();
  const serverMessages = [];
  const transport = createAppServerTransport({
    async processClientMessage(message) {
      await new Promise((resolve) => releases.set(message.id, resolve));
      return message;
    },
  });
  const fake = fakeChild();
  transport.decorateChild(fake.child);
  t.after(() => fake.child.emit("close"));
  lineStream(fake.serverInput, (message) => serverMessages.push(message));

  await Promise.all([
    writeClient(
      fake.child.stdin,
      `${JSON.stringify({ id: "turn-a", method: "turn/start", params: { threadId: "thread-a", input: [] } })}\n`
    ),
    writeClient(
      fake.child.stdin,
      `${JSON.stringify({ id: "read-b", method: "thread/read", params: { threadId: "thread-b" } })}\n`
    ),
    writeClient(
      fake.child.stdin,
      `${JSON.stringify({ id: "resume-b", method: "thread/resume", params: { threadId: "thread-b" } })}\n`
    ),
    writeClient(
      fake.child.stdin,
      `${JSON.stringify({ id: "goal-b", method: "thread/goal/get", params: { threadId: "thread-b" } })}\n`
    ),
  ]);
  await waitFor(() => releases.size === 4);

  releases.get("goal-b")();
  releases.get("resume-b")();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(serverMessages.length, 0);
  releases.get("read-b")();
  await waitFor(() => serverMessages.length === 3);
  assert.deepEqual(serverMessages.map((message) => message.id), ["read-b", "resume-b", "goal-b"]);
  releases.get("turn-a")();
  await waitFor(() => serverMessages.length === 4);
  assert.deepEqual(serverMessages.map((message) => message.id), ["read-b", "resume-b", "goal-b", "turn-a"]);
});

test("audited reads and server responses bypass a pending turn but global writes remain barriers", async (t) => {
  let releaseTurn;
  const serverMessages = [];
  const transport = createAppServerTransport({
    async processClientMessage(message) {
      if (message.id === "turn-a") await new Promise((resolve) => (releaseTurn = resolve));
      return message;
    },
  });
  const fake = fakeChild();
  transport.decorateChild(fake.child);
  t.after(() => fake.child.emit("close"));
  lineStream(fake.serverInput, (message) => serverMessages.push(message));

  await Promise.all([
    writeClient(
      fake.child.stdin,
      `${JSON.stringify({ id: "turn-a", method: "turn/start", params: { threadId: "thread-a", input: [] } })}\n`
    ),
    writeClient(fake.child.stdin, `${JSON.stringify({ id: "list", method: "thread/list", params: {} })}\n`),
    writeClient(fake.child.stdin, `${JSON.stringify({ id: "auth", method: "getAuthStatus", params: {} })}\n`),
    writeClient(
      fake.child.stdin,
      `${JSON.stringify({ id: "config-write", method: "config/value/write", params: { keyPath: "model", value: "x" } })}\n`
    ),
    writeClient(fake.child.stdin, `${JSON.stringify({ id: "approval", result: { decision: "accept" } })}\n`),
    writeClient(
      fake.child.stdin,
      `${JSON.stringify({ id: "read-b", method: "thread/read", params: { threadId: "thread-b" } })}\n`
    ),
  ]);

  await waitFor(() => serverMessages.length === 3);
  assert.deepEqual(serverMessages.map((message) => message.id), ["list", "auth", "approval"]);
  releaseTurn();
  await waitFor(() => serverMessages.length === 6);
  assert.deepEqual(serverMessages.map((message) => message.id), [
    "list",
    "auth",
    "approval",
    "turn-a",
    "config-write",
    "read-b",
  ]);
});

test("resume by path and unknown methods stay conservative global barriers", async (t) => {
  let releaseTurn;
  const serverMessages = [];
  const transport = createAppServerTransport({
    async processClientMessage(message) {
      if (message.id === "turn-a") await new Promise((resolve) => (releaseTurn = resolve));
      return message;
    },
  });
  const fake = fakeChild();
  transport.decorateChild(fake.child);
  t.after(() => fake.child.emit("close"));
  lineStream(fake.serverInput, (message) => serverMessages.push(message));

  await Promise.all([
    writeClient(
      fake.child.stdin,
      `${JSON.stringify({ id: "turn-a", method: "turn/start", params: { threadId: "thread-a", input: [] } })}\n`
    ),
    writeClient(
      fake.child.stdin,
      `${JSON.stringify({ id: "resume-b", method: "thread/resume", params: { threadId: "thread-b", path: "/tmp/b" } })}\n`
    ),
    writeClient(
      fake.child.stdin,
      `${JSON.stringify({ id: "unknown-c", method: "thread/futureMutation", params: { threadId: "thread-c" } })}\n`
    ),
    writeClient(
      fake.child.stdin,
      `${JSON.stringify({ id: "read-d", method: "thread/read", params: { threadId: "thread-d" } })}\n`
    ),
  ]);

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(serverMessages.length, 0);
  releaseTurn();
  await waitFor(() => serverMessages.length === 4);
  assert.deepEqual(serverMessages.map((message) => message.id), ["turn-a", "resume-b", "unknown-c", "read-d"]);
});

test("client stdin final waits for deferred frames after later independent frames bypass", async (t) => {
  let releaseTurn;
  let serverEnded = false;
  const serverMessages = [];
  const transport = createAppServerTransport({
    async processClientMessage(message) {
      if (message.id === "turn-a") await new Promise((resolve) => (releaseTurn = resolve));
      if (message.id === "drop") return null;
      return message;
    },
  });
  const fake = fakeChild();
  transport.decorateChild(fake.child);
  t.after(() => fake.child.emit("close"));
  lineStream(fake.serverInput, (message) => serverMessages.push(message));
  fake.serverInput.on("end", () => {
    serverEnded = true;
  });

  await Promise.all([
    writeClient(
      fake.child.stdin,
      `${JSON.stringify({ id: "turn-a", method: "turn/start", params: { threadId: "thread-a", input: [] } })}\n`
    ),
    writeClient(
      fake.child.stdin,
      `${JSON.stringify({ id: "read-b", method: "thread/read", params: { threadId: "thread-b" } })}\n`
    ),
    writeClient(fake.child.stdin, `${JSON.stringify({ id: "drop", method: "getAuthStatus", params: {} })}\n`),
  ]);
  const clientEnded = new Promise((resolve, reject) => {
    fake.child.stdin.end((error) => (error ? reject(error) : resolve()));
  });

  await waitFor(() => serverMessages.some((message) => message.id === "read-b"));
  assert.equal(serverEnded, false);
  releaseTurn();
  await clientEnded;
  await waitFor(() => serverEnded);
  assert.deepEqual(serverMessages.map((message) => message.id), ["read-b", "turn-a"]);
});

test("client input backpressure releases as soon as the pending frame count drops below the cap", async (t) => {
  const releases = new Map();
  const serverMessages = [];
  const transport = createAppServerTransport({
    async processClientMessage(message) {
      await new Promise((resolve) => releases.set(message.id, resolve));
      return message;
    },
  });
  const fake = fakeChild();
  transport.decorateChild(fake.child);
  t.after(() => fake.child.emit("close"));
  lineStream(fake.serverInput, (message) => serverMessages.push(message));

  const frames = Array.from({ length: 64 }, (_, index) =>
    JSON.stringify({
      id: `frame-${index}`,
      method: "turn/start",
      params: { threadId: "thread-a", input: [] },
    })
  ).join("\n");
  let writeSettled = false;
  const writePromise = writeClient(fake.child.stdin, `${frames}\n`).then(() => {
    writeSettled = true;
  });
  await waitFor(() => releases.size === 64);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writeSettled, false);

  // 第一帧提交后 Map 实际只剩 63 帧，此时必须及时解除 Writable 背压。
  releases.get("frame-0")();
  await writePromise;
  assert.equal(writeSettled, true);
  for (let index = 1; index < 64; index += 1) releases.get(`frame-${index}`)();
  await waitFor(() => serverMessages.length === 64);
  assert.deepEqual(
    serverMessages.map((message) => message.id),
    Array.from({ length: 64 }, (_, index) => `frame-${index}`)
  );
});

test("UTF-8 characters survive byte-level chunk splits in both directions", async (t) => {
  const received = [];
  const visible = [];
  const transport = createAppServerTransport({
    processClientMessage: (message) => message,
    processServerMessage: (message) => message,
  });
  const fake = fakeChild();
  transport.decorateChild(fake.child);
  t.after(() => fake.child.emit("close"));
  lineStream(fake.serverInput, (message) => received.push(message));
  lineStream(fake.child.stdout, (message) => visible.push(message));

  const clientFrame = Buffer.from(`${JSON.stringify({ id: "utf8", method: "echo", params: { text: "中文" } })}\n`);
  const clientSplit = clientFrame.indexOf(Buffer.from("中")) + 1;
  await writeClient(fake.child.stdin, clientFrame.subarray(0, clientSplit));
  await writeClient(fake.child.stdin, clientFrame.subarray(clientSplit));
  await waitFor(() => received.length === 1);
  assert.equal(received[0].params.text, "中文");

  const serverFrame = Buffer.from(`${JSON.stringify({ id: "utf8", result: { text: "路由" } })}\n`);
  const serverSplit = serverFrame.indexOf(Buffer.from("路")) + 1;
  fake.serverOutput.write(serverFrame.subarray(0, serverSplit));
  fake.serverOutput.write(serverFrame.subarray(serverSplit));
  await waitFor(() => visible.length === 1);
  assert.equal(visible[0].result.text, "路由");
});

test("server output pauses at the public stream backpressure boundary and resumes after draining", async (t) => {
  const transport = createAppServerTransport({ processServerMessage: (message) => message });
  const fake = fakeChild();
  transport.decorateChild(fake.child);
  t.after(() => fake.child.emit("close"));
  const payload = "x".repeat(4_096);
  for (let index = 0; index < 80; index += 1) {
    fake.serverOutput.write(`${JSON.stringify({ method: "test/event", params: { index, payload } })}\n`);
  }
  await waitFor(() => fake.serverOutput.isPaused());
  let bytes = 0;
  fake.child.stdout.on("data", (chunk) => {
    bytes += chunk.length;
  });
  fake.child.stdout.resume();
  await waitFor(() => !fake.serverOutput.isPaused() && bytes > 100_000);
  assert.equal(bytes > 100_000, true);
});
