const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createRecoverableSessions, __test } = require("../runtime/ipc/recoverable-sessions.cjs");

function createHarness(t) {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocx-recoverable-sessions-"));
  t.after(() => fs.rmSync(runtimeDir, { recursive: true, force: true }));
  return createRecoverableSessions({
    runtimeDir,
    isAuthed: () => true,
    deliver: () => true,
    dispose: () => {},
    log: () => {},
  });
}

function createRequest({ headers = {}, remoteAddress = "127.0.0.1", url = "/api/rpc/page" } = {}) {
  return {
    method: "POST",
    url,
    headers: { host: "example.com", ...headers },
    socket: { remoteAddress, encrypted: false },
  };
}

function createResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: null,
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(body) {
      this.body = JSON.parse(body);
    },
  };
}

function createSocket() {
  return {
    readyState: 1,
    bufferedAmount: 0,
    sent: [],
    send(data) { this.sent.push(JSON.parse(data)); },
    close() { this.readyState = 3; },
    terminate() { this.readyState = 3; },
  };
}

function initializeSession(sessions, headers = {}, remoteAddress = "127.0.0.1") {
  const response = createResponse();
  sessions.initialize(createRequest({
    headers: { authorization: "Bearer test-token", origin: "https://example.com", host: "example.com", ...headers },
    remoteAddress,
  }), response);
  return response;
}

test("recovers a session from the auth token when the browser cookie is missing", (t) => {
  const sessions = createHarness(t);
  const initialized = initializeSession(sessions);
  assert.equal(initialized.statusCode, 200);
  const socket = createSocket();
  const attached = sessions.attach(socket, createRequest({
    headers: { authorization: "Bearer test-token" },
    url: "/ws?token=test-token",
  }), {
    pageId: initialized.body.pageId,
    generation: initialized.body.generation,
    credential: initialized.body.credential,
    clientId: "client-1",
    ack: 0,
  });
  assert.equal(attached, true);
  sessions.ready(socket);
  assert.equal(socket.sent[0].type, "rpc-ready");
});

test("rejects a token fallback attach with the wrong credential", (t) => {
  const sessions = createHarness(t);
  const initialized = initializeSession(sessions);
  const socket = createSocket();
  const attached = sessions.attach(socket, createRequest({
    headers: { authorization: "Bearer test-token" },
    url: "/ws?token=test-token",
  }), {
    pageId: initialized.body.pageId,
    generation: initialized.body.generation,
    credential: "wrong-credential",
    clientId: "client-1",
    ack: 0,
  });
  assert.equal(attached, false);
  assert.equal(socket.sent[0].type, "rpc-reset");
});

test("rejects a spoofed forwarded host from an untrusted direct client", (t) => {
  const sessions = createHarness(t);
  const response = createResponse();
  sessions.initialize(createRequest({
    headers: {
      authorization: "Bearer test-token",
      host: "internal.local",
      origin: "https://evil.example",
      "x-forwarded-host": "evil.example",
    },
    remoteAddress: "203.0.113.10",
  }), response);
  assert.equal(response.statusCode, 403);
});

test("accepts a forwarded host only from an explicitly trusted proxy", (t) => {
  const previous = process.env.OPENCODEX_TRUSTED_PROXIES;
  process.env.OPENCODEX_TRUSTED_PROXIES = "203.0.113.10";
  t.after(() => {
    if (previous == null) delete process.env.OPENCODEX_TRUSTED_PROXIES;
    else process.env.OPENCODEX_TRUSTED_PROXIES = previous;
  });
  const sessions = createHarness(t);
  const response = createResponse();
  sessions.initialize(createRequest({
    headers: {
      authorization: "Bearer test-token",
      host: "internal.local",
      origin: "https://public.example",
      "x-forwarded-host": "public.example",
      "x-forwarded-proto": "https",
    },
    remoteAddress: "203.0.113.10",
  }), response);
  assert.equal(response.statusCode, 200);
  assert.match(response.headers["Set-Cookie"], /; Secure$/);
});

test("keeps same-origin direct requests working without trusted proxies", (t) => {
  const sessions = createHarness(t);
  const response = createResponse();
  sessions.initialize(createRequest({
    headers: { authorization: "Bearer test-token", host: "example.com", origin: "https://example.com" },
    remoteAddress: "203.0.113.10",
  }), response);
  assert.equal(response.statusCode, 200);
  assert.doesNotMatch(response.headers["Set-Cookie"], /; Secure$/);
});

test("matches trusted proxy IPv4 CIDR ranges", () => {
  assert.equal(__test.matchesTrustedProxy("100.73.232.17", "100.73.232.0/24"), true);
  assert.equal(__test.matchesTrustedProxy("100.73.233.17", "100.73.232.0/24"), false);
  assert.equal(__test.matchesTrustedProxy("::ffff:100.73.232.17", "100.73.232.17"), true);
  assert.equal(__test.isTrustedProxy({ socket: { remoteAddress: "127.0.0.1" } }), true);
});
