const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const test = require("node:test");

// 测试使用独立配置文件，避免认证模块加载时读取或改写开发者真实的 config.yaml。
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodex-auth-request-test-"));
const configPath = path.join(tempDir, "config.yaml");
const passwordHash = crypto.createHash("sha256").update("restart-secret", "utf8").digest("hex");
fs.writeFileSync(configPath, `auth:\n  password: "sha256-v1:${passwordHash}"\n`, "utf8");
process.env.CODEX_WEB_CONFIG_PATH = configPath;

const { authRateLimiter } = require("../runtime/http/auth-rate-limit.cjs");
const {
  __test: { makeAuthStore },
  verifyAccessPasswordRequest,
} = require("../runtime/http/auth.cjs");

test.after(() => {
  fs.rmSync(tempDir, { force: true, recursive: true });
});

test.beforeEach(() => {
  authRateLimiter.reset();
});

function makeRequest(submittedHash, remoteAddress) {
  // IncomingMessage 的 data 事件提供 Buffer，测试夹具保持相同行为以覆盖真实 readBody 路径。
  const req = Readable.from([Buffer.from(JSON.stringify({ passwordHash: submittedHash }), "utf8")]);
  req.headers = { "content-type": "application/json" };
  req.socket = { remoteAddress };
  return req;
}

function makeResponseRecorder() {
  return {
    body: "",
    headers: {},
    status: 0,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers || {};
    },
    end(body) {
      this.body = String(body || "");
    },
  };
}

test("verifies the access password hash for a sensitive action", async () => {
  const res = makeResponseRecorder();

  const verified = await verifyAccessPasswordRequest(makeRequest(passwordHash, "10.0.0.10"), res);

  assert.equal(verified, true);
  assert.equal(res.status, 0);
});

test("rejects an incorrect action password through the shared auth limiter", async () => {
  const res = makeResponseRecorder();

  const verified = await verifyAccessPasswordRequest(makeRequest("0".repeat(64), "10.0.0.11"), res);

  assert.equal(verified, false);
  assert.equal(res.status, 401);
  assert.equal(JSON.parse(res.body).error, "Invalid password");
  assert.equal(authRateLimiter.check({ socket: { remoteAddress: "10.0.0.11" } }).allowed, false);
});

test("auth token store is bounded, LRU refreshed, and expiry pruned", () => {
  let now = 1_000;
  const store = makeAuthStore({ maxTokens: 2, now: () => now });
  const first = store.issue();
  const second = store.issue();
  assert.ok(store.validate(first.token));
  const third = store.issue();

  assert.equal(store.size(), 2);
  assert.equal(store.validate(second.token), null);
  assert.ok(store.validate(first.token));
  assert.ok(store.validate(third.token));

  now = Math.max(first.expiresAtMs, third.expiresAtMs) + 1;
  assert.equal(store.size(), 0);
});
