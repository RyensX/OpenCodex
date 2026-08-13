const assert = require("node:assert/strict");
const test = require("node:test");
const {
  HISTORY_PREVIEW_LIMIT,
  createHistoryPreviewService,
  normalizePreviewThread,
} = require("../runtime/history-preview.cjs");

test("normalizes bounded history preview fields", () => {
  const normalized = normalizePreviewThread({
    id: `thread-${"x".repeat(300)}`,
    name: `title-${"y".repeat(300)}`,
    cwd: `/${"z".repeat(3_000)}`,
    updatedAt: "123",
  });

  assert.equal(normalized.id.length, 200);
  assert.equal(normalized.title.length, 240);
  assert.equal(normalized.cwd.length, 2_048);
  assert.equal(normalized.updatedAt, 123);
  assert.equal(normalizePreviewThread({ name: "missing id" }), null);
});

test("loads one recent thread page and removes internal or duplicate rows", async () => {
  const requests = [];
  const transport = {
    isAttached: () => true,
    isInternalThreadId: (id) => id === "internal",
    async request(method, params, options) {
      requests.push({ method, options, params });
      return {
        data: [
          { id: "first", name: "第一条", cwd: "/work/a", updatedAt: 20 },
          { id: "first", name: "重复", cwd: "/work/a", updatedAt: 19 },
          { id: "internal", name: "内部线程", cwd: "/work/b", updatedAt: 18 },
          { id: "second", title: "第二条", cwd: "/work/b", updatedAt: 17 },
        ],
      };
    },
  };
  const service = createHistoryPreviewService({ transport });

  const snapshot = await service.snapshot({ maxWaitMs: 100 });

  assert.deepEqual(snapshot.threads.map((thread) => thread.id), ["first", "second"]);
  assert.equal(snapshot.threads[1].title, "第二条");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "thread/list");
  assert.deepEqual(requests[0].params, {
    archived: false,
    cursor: null,
    limit: HISTORY_PREVIEW_LIMIT,
    modelProviders: null,
    sortKey: "updated_at",
    useStateDbOnly: true,
  });
});

test("coalesces concurrent preview reads and never blocks navigation on an unattached transport", async () => {
  let resolveRequest;
  let requestCount = 0;
  const attachedTransport = {
    isAttached: () => true,
    isInternalThreadId: () => false,
    request() {
      requestCount += 1;
      return new Promise((resolve) => {
        resolveRequest = resolve;
      });
    },
  };
  const service = createHistoryPreviewService({ transport: attachedTransport });
  const first = service.snapshot({ maxWaitMs: 100 });
  const second = service.snapshot({ maxWaitMs: 100 });
  await Promise.resolve();
  resolveRequest({ data: [{ id: "shared", name: "共享结果" }] });

  assert.deepEqual((await first).threads.map((thread) => thread.id), ["shared"]);
  assert.deepEqual((await second).threads.map((thread) => thread.id), ["shared"]);
  assert.equal(requestCount, 1);

  const unavailable = createHistoryPreviewService({
    transport: { isAttached: () => false },
  });
  const startedAt = Date.now();
  assert.deepEqual(await unavailable.snapshot({ maxWaitMs: 20 }), { generatedAtMs: 0, threads: [] });
  assert.ok(Date.now() - startedAt < 100);
});

test("does not repopulate the preview cache after disposal", async () => {
  let resolveRequest;
  const service = createHistoryPreviewService({
    transport: {
      isAttached: () => true,
      isInternalThreadId: () => false,
      request() {
        return new Promise((resolve) => {
          resolveRequest = resolve;
        });
      },
    },
  });
  const pendingSnapshot = service.snapshot({ maxWaitMs: 100 });
  await Promise.resolve();

  service.dispose();
  resolveRequest({ data: [{ id: "late-thread", name: "迟到结果" }] });

  assert.deepEqual(await pendingSnapshot, { generatedAtMs: 0, threads: [] });
  assert.deepEqual(await service.snapshot({ maxWaitMs: 10 }), { generatedAtMs: 0, threads: [] });
});

test("returns an expired snapshot immediately while refreshing it in the background", async () => {
  let nowMs = 1_000;
  let requestCount = 0;
  let resolveRefresh;
  const service = createHistoryPreviewService({
    now: () => nowMs,
    transport: {
      isAttached: () => true,
      isInternalThreadId: () => false,
      request() {
        requestCount += 1;
        if (requestCount === 1) return Promise.resolve({ data: [{ id: "old", name: "旧快照" }] });
        return new Promise((resolve) => {
          resolveRefresh = resolve;
        });
      },
    },
  });
  assert.deepEqual((await service.snapshot()).threads.map((thread) => thread.id), ["old"]);

  nowMs += 2_000;
  const stale = await service.snapshot({ maxWaitMs: 700 });
  assert.deepEqual(stale.threads.map((thread) => thread.id), ["old"]);
  await Promise.resolve();
  assert.equal(requestCount, 2);

  resolveRefresh({ data: [{ id: "new", name: "新快照" }] });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual((await service.snapshot()).threads.map((thread) => thread.id), ["new"]);
});
