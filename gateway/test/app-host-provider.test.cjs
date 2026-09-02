const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const BRIDGE_SOURCE = fs.readFileSync(
  path.resolve(__dirname, "..", "..", "web-shell", "internal", "providers", "codex-bridge-polyfill.js"),
  "utf8"
);
const CODEC = require("../../web-shell/codex-app-host-message-codec.js");

function sourceFunctionDeclaration(source, name) {
  // 测试只抽取生产函数本身，避免为浏览器 Provider 搭建完整 DOM 环境。
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing function ${name}`);
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  assert.fail(`unterminated function ${name}`);
}

class FakePort {
  constructor() {
    this.listeners = new Map();
    this.posted = [];
    this.closed = false;
    this.started = false;
    this.throwOnPost = false;
  }
  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(callback);
  }
  start() {
    this.started = true;
  }
  close() {
    this.closed = true;
  }
  postMessage(value) {
    if (this.throwOnPost) throw new Error("browser post failed");
    this.posted.push(value);
    return true;
  }
  emit(type, data) {
    for (const callback of this.listeners.get(type) || []) callback({ data });
  }
}

function createHarness({ countStringify = false } = {}) {
  const windowListeners = new Map();
  const sent = [];
  const diagnostics = [];
  const published = [];
  let stringifyCount = 0;
  let portSequence = 0;
  const nativeStringify = JSON.stringify;
  const ws = {
    readyState: 1,
    send(payload) {
      sent.push(JSON.parse(payload));
    },
  };
  const w = {
    WebSocket: { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 },
    crypto: { randomUUID: () => `provider-port-${++portSequence}` },
    __OpenCodexAppHostMessageCodec: CODEC,
  };
  const adapterHost = {
    events: {
      observe({ target, type, callback }) {
        if (target !== w) throw new Error("unexpected event target");
        windowListeners.set(type, callback);
        return () => windowListeners.delete(type);
      },
    },
  };
  const declarations = [
    "appHostMessageCodec",
    "encodeAppHostMessageData",
    "decodeAppHostMessageData",
    "appHostPortId",
    "appHostWsPayload",
    "sendAppHostWsPayload",
    "flushAppHostRelayMessages",
    "flushAllAppHostRelayMessages",
    "markGatewayWsReady",
    "appHostPendingPayloadChars",
    "prepareAppHostRelayPayload",
    "queueAppHostRelayPayload",
    "sendAppHostRelayError",
    "forceFinalizeAppHostRelay",
    "failAppHostRelay",
    "finalizeAppHostRelay",
    "closeAppHostRelay",
    "handleAppHostGatewayMessage",
    "installAppHostMessagePortBridge",
  ].map((name) => sourceFunctionDeclaration(BRIDGE_SOURCE, name)).join("\n");
  const context = {
    w,
    window: w,
    adapterHost,
    modificationScope: null,
    modificationEffects: null,
    providerGeneration: {},
    ws,
    wsReady: true,
    clientId: "provider-client",
    appHostPortRelays: new Map(),
    APP_HOST_RELAY_MAX_ENTRIES: 64,
    APP_HOST_PENDING_MESSAGE_LIMIT: 2000,
    APP_HOST_PENDING_MESSAGE_CHARS_LIMIT: 16 * 1024 * 1024,
    diagnostics,
    published,
    clientDiagnostic(event, data) {
      diagnostics.push({ event, data });
    },
    publishAppHostData(data, direction) {
      published.push({ data, direction });
    },
    payloadShape(value) {
      return Array.isArray(value) ? `array(${value.length})` : typeof value;
    },
    websocketStateName() {
      return "open";
    },
    settleWsReadyWaiters() {},
  };
  if (countStringify) {
    // 统计 Provider 自己的序列化次数，不把 fake WebSocket 的 JSON.parse 算进去。
    context.JSON = {
      parse: JSON.parse,
      stringify(value) {
        stringifyCount += 1;
        return nativeStringify(value);
      },
    };
  }
  const install = vm.runInNewContext(
    `${declarations}\n({ installAppHostMessagePortBridge, handleAppHostGatewayMessage, markGatewayWsReady })`,
    context
  );
  return { context, install, sent, windowListeners, published, get stringifyCount() { return stringifyCount; } };
}

function connectHarness(harness) {
  const port = new FakePort();
  harness.install.installAppHostMessagePortBridge();
  harness.windowListeners.get("message")({
    source: harness.context.w,
    data: { type: "connect-app-host" },
    ports: [port],
  });
  assert.equal(port.started, true);
  const connectFrame = harness.sent.at(-1);
  assert.equal(connectFrame.type, "app-host-connect");
  const portId = connectFrame.portId;
  return { port, portId };
}

test("production AppHost provider encodes structured values and sends undefined exactly once", () => {
  const harness = createHarness();
  const { port, portId } = connectHarness(harness);
  const value = { method: "turn/start", args: [undefined, 3n] };
  port.emit("message", value);
  const structured = harness.sent.at(-1);
  assert.equal(structured.type, "app-host-port-message");
  assert.equal(structured.portId, portId);
  assert.equal(structured.dataEncoding, CODEC.encoding);
  assert.deepEqual(CODEC.decodeMessageData(structured), value);
  port.emit("message", "legacy");
  assert.equal(harness.sent.at(-1).data, "legacy");
  port.emit("message", undefined);
  const terminalFrames = harness.sent.filter((message) => message.type === "app-host-port-message").slice(-1);
  assert.equal(terminalFrames.length, 1);
  assert.equal(CODEC.decodeMessageData(terminalFrames[0]), undefined);
  assert.equal(harness.sent.some((message) => message.data === null), false);
  assert.equal(port.closed, true);
  assert.deepEqual(harness.published.at(-1), { data: undefined, direction: "client" });
});

test("production AppHost provider reports downlink decode and post failures locally", () => {
  const malformedHarness = createHarness();
  const malformed = connectHarness(malformedHarness);
  malformedHarness.install.handleAppHostGatewayMessage({
    type: "app-host-port-message",
    portId: malformed.portId,
    dataEncoding: "unknown",
    data: ["undefined"],
  });
  assert.equal(malformed.port.closed, true);
  assert.equal(malformedHarness.sent.filter((message) => message.type === "app-host-port-error").length, 1);
  assert.equal(malformedHarness.sent.some((message) => message.data === null), false);

  const postHarness = createHarness();
  const post = connectHarness(postHarness);
  post.port.throwOnPost = true;
  postHarness.install.handleAppHostGatewayMessage({
    type: "app-host-port-message",
    portId: post.portId,
    ...CODEC.encodeMessageData({ method: "thread/settings/update" }),
  });
  assert.equal(post.port.closed, true);
  assert.equal(postHarness.sent.filter((message) => message.type === "app-host-port-error").length, 1);
  assert.equal(postHarness.sent.some((message) => message.data === null), false);
});

test("production AppHost provider reports repeated browser failures only once", () => {
  const messageErrorHarness = createHarness();
  const messageError = connectHarness(messageErrorHarness);
  messageError.port.emit("messageerror");
  messageError.port.emit("messageerror");
  assert.equal(
    messageErrorHarness.sent.filter((message) => message.type === "app-host-port-error").length,
    1
  );

  const encodeHarness = createHarness();
  const encodeFailure = connectHarness(encodeHarness);
  encodeFailure.port.emit("message", Symbol("unsupported"));
  encodeFailure.port.emit("message", Symbol("unsupported-again"));
  assert.equal(encodeHarness.sent.filter((message) => message.type === "app-host-port-error").length, 1);
  assert.equal(encodeFailure.port.closed, true);
});

test("production AppHost provider keeps a terminal frame FIFO across websocket reconnect", () => {
  const harness = createHarness();
  harness.context.wsReady = false;
  const port = new FakePort();
  harness.install.installAppHostMessagePortBridge();
  harness.windowListeners.get("message")({
    source: harness.context.w,
    data: { type: "connect-app-host" },
    ports: [port],
  });
  const state = [...harness.context.appHostPortRelays.values()][0];
  assert.equal(harness.sent.length, 0);
  port.emit("message", null);
  assert.equal(state.closing, true);
  assert.equal(state.pending.length, 2);
  harness.context.wsReady = true;
  harness.install.markGatewayWsReady();
  assert.deepEqual(harness.sent.map((message) => message.type), ["app-host-connect", "app-host-port-message"]);
  assert.equal(harness.sent[1].data, null);
  assert.equal(port.closed, true);
});

test("production AppHost provider force-closes a closing relay on gateway terminal events", () => {
  const harness = createHarness();
  const { port, portId } = connectHarness(harness);
  harness.context.wsReady = false;
  port.emit("message", null);
  const state = harness.context.appHostPortRelays.get(portId);
  assert.equal(state.closing, true);
  assert.equal(state.pending.length, 1);

  harness.install.handleAppHostGatewayMessage({ type: "app-host-port-error", portId, error: "relay failed" });
  assert.equal(state.closed, true);
  assert.equal(state.pending.length, 0);
  assert.equal(harness.context.appHostPortRelays.has(portId), false);
  assert.equal(port.closed, true);

  // 关闭后的迟到 MessagePort 事件不得再次发布到消费者。
  const publishedCount = harness.published.length;
  port.emit("message", { method: "turn/start" });
  assert.equal(harness.published.length, publishedCount);

  const secondPort = new FakePort();
  harness.windowListeners.get("message")({
    source: harness.context.w,
    data: { type: "connect-app-host" },
    ports: [secondPort],
  });
  const secondState = [...harness.context.appHostPortRelays.values()].find((candidate) => candidate.port !== port);
  secondPort.emit("message", null);
  harness.install.handleAppHostGatewayMessage({
    type: "app-host-port-close",
    portId: secondState.portId,
    reason: "official_closed",
  });
  assert.equal(secondState.closed, true);
  assert.equal(secondPort.closed, true);
});

test("production AppHost provider evicts closing relays without stalling at the relay limit", () => {
  const harness = createHarness();
  harness.context.wsReady = false;
  harness.install.installAppHostMessagePortBridge();
  const ports = [];
  const connectEvent = harness.windowListeners.get("message");
  for (let index = 0; index < harness.context.APP_HOST_RELAY_MAX_ENTRIES; index += 1) {
    const port = new FakePort();
    ports.push(port);
    connectEvent({ source: harness.context.w, data: { type: "connect-app-host" }, ports: [port] });
  }
  ports[0].emit("message", null);
  assert.equal([...harness.context.appHostPortRelays.values()][0].closing, true);

  assert.doesNotThrow(() => {
    connectEvent({ source: harness.context.w, data: { type: "connect-app-host" }, ports: [new FakePort()] });
  });
  assert.equal(ports[0].closed, true);
  assert.equal(harness.context.appHostPortRelays.size, harness.context.APP_HOST_RELAY_MAX_ENTRIES);
});

test("production AppHost provider serializes queued frames once and reuses them after reconnect", () => {
  const harness = createHarness({ countStringify: true });
  harness.context.wsReady = false;
  const port = new FakePort();
  harness.install.installAppHostMessagePortBridge();
  harness.windowListeners.get("message")({
    source: harness.context.w,
    data: { type: "connect-app-host" },
    ports: [port],
  });
  port.emit("message", { method: "turn/start", params: { threadId: "thread-1" } });
  assert.equal(harness.sent.length, 0);
  assert.equal(harness.stringifyCount, 2);

  // hello-ack 只发送已缓存字符串，不应再次遍历结构化 wire 数据。
  harness.context.wsReady = true;
  harness.install.markGatewayWsReady();
  assert.equal(harness.stringifyCount, 2);
  assert.deepEqual(harness.sent.map((message) => message.type), ["app-host-connect", "app-host-port-message"]);
});
