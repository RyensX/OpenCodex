const assert = require("node:assert/strict");
const test = require("node:test");
const {
  hostnameFromHostHeader,
  isLoopbackHostHeader,
  loopbackHostname,
} = require("../runtime/core/loopback-host.cjs");

test("detects loopback browser hosts", () => {
  const loopbackHosts = [
    "localhost",
    "localhost:3737",
    "127.0.0.1",
    "127.0.0.1:3737",
    "127.1.2.3",
    "[::1]:3737",
    "::1",
    "[::ffff:127.0.0.1]:3737",
    "::ffff:127.0.0.1",
  ];
  for (const host of loopbackHosts) {
    assert.equal(isLoopbackHostHeader(host), true, host);
  }

  const remoteHosts = ["192.168.1.8:3737", "10.0.0.2", "example.com:3737", "codex.internal"];
  for (const host of remoteHosts) {
    assert.equal(isLoopbackHostHeader(host), false, host);
  }
});

test("normalizes host headers before loopback checks", () => {
  // Host header 带端口或 IPv6 bracket 时先抽出页面实际 hostname，再做业务判断。
  assert.equal(hostnameFromHostHeader("LOCALHOST:3737"), "localhost");
  assert.equal(hostnameFromHostHeader("[::1]:3737"), "::1");
  assert.equal(hostnameFromHostHeader("192.168.1.8:3737"), "192.168.1.8");
  assert.equal(loopbackHostname("127.999.0.1"), false);
});
