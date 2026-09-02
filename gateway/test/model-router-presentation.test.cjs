const assert = require("node:assert/strict");
const test = require("node:test");
const {
  MAX_PROTOCOL_SCAN_NODES,
  createSmartSchedulingPresentation,
  visitProtocolMessages,
} = require("../runtime/model-router/presentation.cjs");

function fakeRouter() {
  let listener = null;
  return {
    emit(event) {
      listener?.(event);
    },
    onRouteStatus(nextListener) {
      listener = nextListener;
      return () => {
        listener = null;
      };
    },
    modelDisplayName(model) {
      return model === "luna" ? "GPT-5.6-Luna" : model;
    },
  };
}

test("presentation correlates turns and model selections and sends safe route state only to their client", () => {
  const router = fakeRouter();
  const sent = [];
  let removedListener = null;
  const presentation = createSmartSchedulingPresentation({
    modelRouter: router,
    onClientRemoved(listener) {
      removedListener = listener;
      return () => {
        removedListener = null;
      };
    },
    sendTo: (clientId, payload) => sent.push({ clientId, payload }),
  });

  presentation.observeAppHostFrame({
    clientId: "client-1",
    data: JSON.stringify({
      payload: {
        method: "turn/start",
        params: { threadId: "thread-1", input: [{ type: "text", text: "private prompt" }] },
      },
    }),
  });
  presentation.observeIpcInvoke({
    clientId: "client-2",
    args: [
      {
        type: "mcp-request",
        request: {
          method: "turn/start",
          params: { threadId: "thread-2", input: [{ type: "text", text: "another private prompt" }] },
        },
      },
    ],
  });
  presentation.observeAppHostFrame({
    clientId: "client-3",
    data: JSON.stringify({
      method: "thread/settings/update",
      params: { threadId: "thread-3", model: "auto" },
    }),
  });
  router.emit({ status: "classifying", threadId: "thread-1" });
  router.emit({
    status: "selected",
    threadId: "thread-1",
    route: { tier: "balanced", model: "luna", effort: "high", fallback: false, rationale: "private" },
  });
  router.emit({ status: "classifying", threadId: "thread-2" });
  router.emit({ status: "selected", threadId: "unmapped", route: { model: "spark", effort: "low" } });
  router.emit({
    status: "idle",
    threadId: "thread-3",
    route: { tier: "balanced", model: "luna", effort: "high", rationale: "private" },
  });

  assert.equal(sent.length, 4);
  assert.equal(sent[0].clientId, "client-1");
  assert.equal(sent[0].payload.event.status, "classifying");
  assert.deepEqual(sent[1].payload.event.route, {
    tier: "balanced",
    model: "luna",
    displayName: "GPT-5.6-Luna",
    effort: "high",
    fallback: false,
  });
  assert.equal(sent[2].clientId, "client-2");
  assert.equal(sent[2].payload.event.status, "classifying");
  assert.equal(sent[3].clientId, "client-3");
  assert.equal(sent[3].payload.event.status, "idle");
  assert.equal(sent[3].payload.event.route.displayName, "GPT-5.6-Luna");
  assert.equal(JSON.stringify(sent).includes("private"), false);
  removedListener({ clientId: "client-1" });
  router.emit({ status: "classifying", threadId: "thread-1" });
  assert.equal(sent.length, 4);
  assert.deepEqual(presentation.snapshot(), { trackedThreadCount: 2 });
  presentation.dispose();
  assert.equal(removedListener, null);
});

test("presentation correlates structured AppHost objects and nested envelopes", () => {
  const router = fakeRouter();
  const sent = [];
  const presentation = createSmartSchedulingPresentation({
    modelRouter: router,
    sendTo: (clientId, payload) => sent.push({ clientId, payload }),
  });

  presentation.observeAppHostFrame({
    clientId: "structured-client",
    data: {
      payload: {
        method: "turn/start",
        params: { threadId: "structured-thread" },
      },
    },
  });
  presentation.observeAppHostFrame({
    clientId: "nested-client",
    data: {
      message: {
        body: {
          method: "thread/settings/update",
          params: { threadId: "nested-thread" },
        },
      },
    },
  });

  router.emit({ status: "classifying", threadId: "structured-thread" });
  router.emit({ status: "classifying", threadId: "nested-thread" });

  assert.deepEqual(sent.map((entry) => entry.clientId), ["structured-client", "nested-client"]);
  presentation.dispose();
});

test("presentation protocol traversal bounds wide and cyclic batches", () => {
  let reads = 0;
  let visits = 0;
  const wide = new Proxy(Array.from({ length: 50_000 }, () => ({ method: "thread/read" })), {
    get(target, key, receiver) {
      if (/^\d+$/.test(String(key))) reads += 1;
      return Reflect.get(target, key, receiver);
    },
  });
  visitProtocolMessages(wide, () => {
    visits += 1;
  });
  assert.ok(reads > 0);
  assert.ok(reads <= MAX_PROTOCOL_SCAN_NODES);
  assert.ok(visits <= MAX_PROTOCOL_SCAN_NODES);

  const cyclic = { method: "turn/start" };
  cyclic.payload = cyclic;
  let cyclicVisits = 0;
  visitProtocolMessages(cyclic, () => {
    cyclicVisits += 1;
  });
  // envelope 环只能访问一次，不能在深度上限前重复处理同一个请求。
  assert.equal(cyclicVisits, 1);
});
