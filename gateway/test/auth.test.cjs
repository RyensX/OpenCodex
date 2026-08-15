const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { __test } = require("../runtime/http/auth.cjs");

test("persists only hashed login tokens and expires a secure browser cookie", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "opencodex-auth-"));
  const filePath = path.join(directory, "auth-tokens.json");
  const ttlMs = 7 * 24 * 60 * 60 * 1_000;
  let now = Date.UTC(2026, 7, 15);
  const issuedAt = now;
  t.after(() => fs.rmSync(directory, { recursive: true }));

  const options = {
    filePath,
    now: () => now,
    passwordHash: "a".repeat(64),
    persistIntervalMs: 0,
    ttlMs,
  };
  const issued = __test.makeAuthStore(options).issue();
  assert.equal(fs.readFileSync(filePath, "utf8").includes(issued.token), false);
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
  const productionOptions = { ...options, persistIntervalMs: 60 * 60 * 1_000 };
  now += 30 * 60 * 1_000;
  assert.equal(__test.makeAuthStore(productionOptions).validate(issued.token).expiresAtMs, issued.expiresAtMs);
  assert.equal(__test.makeAuthStore(productionOptions).validate(issued.token).expiresAtMs, issued.expiresAtMs);

  const cookie = __test.authCookieHeader(issued.token, issued.expiresAtMs, issuedAt, true);
  assert.match(cookie, /Max-Age=604800/);
  assert.match(cookie, /Expires=Sat, 22 Aug 2026 00:00:00 GMT/);
  assert.match(cookie, /; Secure$/);
  assert.equal(__test.isSecureRequest({ headers: { "x-forwarded-proto": "https" }, socket: {} }), true);

  now += ttlMs;
  assert.equal(__test.makeAuthStore(options).validate(issued.token), null);
});

test("password changes and logout permanently revoke persisted tokens", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "opencodex-auth-revoke-"));
  const filePath = path.join(directory, "auth-tokens.json");
  const options = {
    filePath,
    now: () => Date.UTC(2026, 7, 15),
    passwordHash: "a".repeat(64),
    ttlMs: 7 * 24 * 60 * 60 * 1_000,
  };
  t.after(() => fs.rmSync(directory, { recursive: true }));

  const store = __test.makeAuthStore(options);
  const issued = store.issue();
  const originalRenameSync = fs.renameSync;
  try {
    fs.renameSync = () => {
      throw new Error("simulated rename failure");
    };
    assert.throws(
      () => __test.makeAuthStore({ ...options, passwordHash: "b".repeat(64) }),
      /simulated rename failure/,
    );
  } finally {
    fs.renameSync = originalRenameSync;
  }
  assert.ok(__test.makeAuthStore(options).validate(issued.token));
  __test.makeAuthStore({ ...options, passwordHash: "b".repeat(64) });
  assert.equal(__test.makeAuthStore(options).validate(issued.token), null);

  const replacementStore = __test.makeAuthStore(options);
  const replacement = replacementStore.issue();
  try {
    fs.renameSync = () => {
      throw new Error("simulated rename failure");
    };
    assert.throws(() => replacementStore.revoke(replacement.token), /simulated rename failure/);
  } finally {
    fs.renameSync = originalRenameSync;
  }
  replacementStore.revoke(replacement.token);
  assert.equal(__test.makeAuthStore(options).validate(replacement.token), null);
});

test("batches sliding expiry writes without starving active tokens", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "opencodex-auth-throttle-"));
  const filePath = path.join(directory, "auth-tokens.json");
  const ttlMs = 7 * 24 * 60 * 60 * 1_000;
  let now = Date.UTC(2026, 7, 15);
  const store = __test.makeAuthStore({
    filePath,
    now: () => now,
    passwordHash: "a".repeat(64),
    persistIntervalMs: 60 * 60 * 1_000,
    ttlMs,
  });
  t.after(() => fs.rmSync(directory, { recursive: true }));

  const first = store.issue();
  now += 30 * 60 * 1_000;
  const second = store.issue();
  now += 10 * 60 * 1_000;
  assert.equal(store.validate(first.token).expiresAtMs, first.expiresAtMs);
  now += 21 * 60 * 1_000;
  const refreshedSecond = store.validate(second.token);
  const refreshedFirst = store.validate(first.token);
  assert.equal(refreshedFirst.expiresAtMs, Date.UTC(2026, 7, 15) + 40 * 60 * 1_000 + ttlMs);
  assert.equal(refreshedSecond.expiresAtMs, now + ttlMs);
  const persistedRefreshAt = JSON.parse(fs.readFileSync(filePath, "utf8")).lastRefreshAtMs;
  now += 30 * 60 * 1_000;
  store.validate(first.token);
  assert.equal(JSON.parse(fs.readFileSync(filePath, "utf8")).lastRefreshAtMs, persistedRefreshAt);

  for (let elapsedMs = 0; elapsedMs < ttlMs + 24 * 60 * 60 * 1_000; elapsedMs += 61 * 60 * 1_000) {
    now += 61 * 60 * 1_000;
    assert.ok(store.validate(first.token));
    assert.ok(store.validate(second.token));
  }
});

test("browser WebSocket authentication only uses a non-refreshing cookie", (t) => {
  const source = fs.readFileSync(path.join(__dirname, "../../web-shell/codex-bridge-polyfill.js"), "utf8");
  assert.doesNotMatch(source, /searchParams\.set\(["']token["']/);
  assert.doesNotMatch(source, /[?&]token=/);

  assert.equal(__test.authTokenFromWebSocketRequest({ headers: {}, url: "/ws?token=secret" }), "");
  assert.equal(
    __test.authTokenFromWebSocketRequest({ headers: { cookie: `${__test.COOKIE_NAME}=cookie-token` } }),
    "cookie-token",
  );

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "opencodex-auth-ws-"));
  const filePath = path.join(directory, "auth-tokens.json");
  const ttlMs = 7 * 24 * 60 * 60 * 1_000;
  let now = Date.UTC(2026, 7, 15);
  const store = __test.makeAuthStore({ filePath, now: () => now, passwordHash: "a".repeat(64), ttlMs });
  t.after(() => fs.rmSync(directory, { recursive: true }));
  const issued = store.issue();
  now += 6 * 24 * 60 * 60 * 1_000;
  assert.equal(store.validate(issued.token, { refresh: false }).expiresAtMs, issued.expiresAtMs);
  assert.equal(JSON.parse(fs.readFileSync(filePath, "utf8")).tokens[0].expiresAtMs, issued.expiresAtMs);
});
