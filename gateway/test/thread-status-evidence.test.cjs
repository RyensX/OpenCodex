const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createPendingThreadStore,
  statusKeyFromRow,
  threadIdFromRow,
} = require("../../web-shell/codex-thread-status-evidence.js");

function statusMessage(threadId, status) {
  return {
    type: "mcp-notification",
    method: "thread/status/changed",
    params: { threadId, status },
  };
}

test("tracks only authoritative notLoaded thread status as pending", () => {
  const changes = [];
  const store = createPendingThreadStore(() => changes.push([...store.pendingThreadKeys()]));

  assert.equal(store.handle(statusMessage("thread-1", { type: "notLoaded" })), true);
  assert.deepEqual([...store.pendingThreadKeys()], ['["local","thread-1"]']);
  assert.equal(store.handle(statusMessage("thread-1", { type: "active", activeFlags: [] })), true);
  assert.deepEqual([...store.pendingThreadKeys()], []);
  assert.deepEqual(changes, [['["local","thread-1"]'], []]);
});

test("ignores malformed and unrelated messages without clearing pending evidence", () => {
  const store = createPendingThreadStore();
  store.handle(statusMessage("thread-1", { type: "notLoaded" }));

  assert.equal(store.handle({ type: "mcp-notification", method: "thread/name/updated", params: {} }), false);
  assert.equal(store.handle(statusMessage("", { type: "idle" })), false);
  assert.equal(store.handle(statusMessage("thread-1", { type: "made-up" })), false);
  assert.deepEqual([...store.pendingThreadKeys()], ['["local","thread-1"]']);
});

test("confirmed terminal statuses clear pending evidence", () => {
  for (const type of ["idle", "systemError"]) {
    const store = createPendingThreadStore();
    store.handle(statusMessage("thread-1", { type: "notLoaded" }));
    store.handle(statusMessage("thread-1", { type }));
    assert.deepEqual([...store.pendingThreadKeys()], []);
  }
});

test("uses the existing sidebar row thread id contract", () => {
  const row = (threadId, hostId = "local") => ({
    getAttribute: (name) => {
      if (name === "data-app-action-sidebar-thread-id") return threadId;
      if (name === "data-app-action-sidebar-thread-host-id") return hostId;
      return null;
    },
  });
  assert.equal(threadIdFromRow(row("thread-1")), "thread-1");
  assert.equal(statusKeyFromRow(row("thread-1", "remote-a")), '["remote-a","thread-1"]');
  assert.equal(statusKeyFromRow(row("thread-1", "")), '["local","thread-1"]');
  assert.equal(threadIdFromRow(row("")), "");
  assert.equal(threadIdFromRow(null), "");
});

test("normalizes the local host prefix used by official sidebar row ids", () => {
  const row = {
    getAttribute: (name) => {
      if (name === "data-app-action-sidebar-thread-id") return "local:thread-1";
      if (name === "data-app-action-sidebar-thread-host-id") return "local";
      return null;
    },
  };

  assert.equal(threadIdFromRow(row), "thread-1");
  assert.equal(statusKeyFromRow(row), '["local","thread-1"]');
});

test("isolates pending status for identical thread ids on different hosts", () => {
  const store = createPendingThreadStore();
  store.handle({ ...statusMessage("same-id", { type: "notLoaded" }), hostId: "remote-a" });
  store.handle({ ...statusMessage("same-id", { type: "idle" }), hostId: "local" });
  assert.deepEqual([...store.pendingThreadKeys()], ['["remote-a","same-id"]']);
});
