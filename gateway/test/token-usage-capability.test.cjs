const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const CAPABILITY_SOURCE = fs.readFileSync(
  path.resolve(__dirname, "..", "..", "web-shell", "internal", "providers", "codex-token-usage-capability.js"),
  "utf8"
);

function createCapability() {
  const window = {
    location: { pathname: "/thread/thread-1" },
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext(CAPABILITY_SOURCE, { window, console, setTimeout, clearTimeout });
  return window.__OpenCodexCreateTokenUsageCapability();
}

test("token usage capability handles structured and legacy AppHost messages", () => {
  const capability = createCapability();
  const updates = [];
  const release = capability.acquireConsumer("test-consumer");
  const unsubscribe = capability.onUpdate((usage) => updates.push(usage));

  // 新结构化对象和旧字符串 RPC 必须进入同一归一化回调，升级不能破坏旧版 Codex。
  capability.handleAppHostData({
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      tokenUsage: { inputTokens: 10, outputTokens: 20, cachedInputTokens: 3 },
    },
  });

  const legacy = {
    type: "event_msg",
    threadId: "thread-1",
    turnId: "turn-2",
    payload: {
      type: "token_count",
      info: { last_token_usage: { input_tokens: 11, output_tokens: 21 } },
    },
  };
  capability.handleAppHostData(JSON.stringify(legacy));

  assert.ok(updates.some(({ threadId, turnId, inputTokens, outputTokens }) =>
    threadId === "thread-1" && turnId === "turn-1" && inputTokens === 10 && outputTokens === 20
  ));
  assert.ok(updates.some(({ threadId, turnId, inputTokens, outputTokens }) =>
    threadId === "thread-1" && turnId === "turn-2" && inputTokens === 11 && outputTokens === 21
  ));

  unsubscribe();
  release();
});
