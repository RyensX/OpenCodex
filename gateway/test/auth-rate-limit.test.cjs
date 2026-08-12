const assert = require("node:assert/strict");
const test = require("node:test");
const { createAuthRateLimiter, normalizeClientAddress } = require("../runtime/http/auth-rate-limit.cjs");

function requestFrom(address) {
  return { socket: { remoteAddress: address } };
}

function createLimiterWithClock(options = {}) {
  let now = 0;
  const limiter = createAuthRateLimiter({
    logger: null,
    now: () => now,
    ...options,
  });
  return {
    advance(ms) {
      now += ms;
    },
    limiter,
  };
}

test("normalizeClientAddress collapses IPv4-mapped IPv6 addresses", () => {
  assert.equal(normalizeClientAddress("::ffff:192.168.1.9"), "192.168.1.9");
  assert.equal(normalizeClientAddress("::1"), "::1");
  assert.equal(normalizeClientAddress(""), "unknown");
});

test("records exponential backoff and caps retry delay", () => {
  const { limiter } = createLimiterWithClock();
  const req = requestFrom("10.0.0.2");

  // 直接测试纯状态机：登录接口会在真实请求路径上先用 check 拦截退避期请求。
  assert.equal(limiter.recordFailure(req).retryAfterMs, 1_000);
  assert.equal(limiter.recordFailure(req).retryAfterMs, 2_000);
  assert.equal(limiter.recordFailure(req).retryAfterMs, 4_000);
  assert.equal(limiter.recordFailure(req).retryAfterMs, 8_000);
  assert.equal(limiter.recordFailure(req).retryAfterMs, 16_000);
  assert.equal(limiter.recordFailure(req).retryAfterMs, 30_000);
});

test("locks a client after the threshold and releases after lock expiry", () => {
  const { advance, limiter } = createLimiterWithClock();
  const req = requestFrom("10.0.0.3");

  for (let i = 0; i < 9; i += 1) {
    const failure = limiter.recordFailure(req);
    assert.equal(failure.limited, false);
  }
  const locked = limiter.recordFailure(req);
  assert.equal(locked.limited, true);
  assert.equal(locked.reason, "client_locked");
  assert.equal(locked.retryAfterMs, 15 * 60 * 1_000);

  const blocked = limiter.check(req);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, "client_locked");

  advance(15 * 60 * 1_000);
  assert.equal(limiter.check(req).allowed, true);
});

test("successful login clears the client failure state", () => {
  const { limiter } = createLimiterWithClock();
  const req = requestFrom("10.0.0.4");

  limiter.recordFailure(req);
  assert.equal(limiter.check(req).allowed, false);
  limiter.recordSuccess(req);
  assert.equal(limiter.check(req).allowed, true);
  assert.equal(limiter.recordFailure(req).failureCount, 1);
});

test("prunes expired clients and enforces the client map cap", () => {
  const { advance, limiter } = createLimiterWithClock({ maxClients: 2, pruneIntervalMs: 0, windowMs: 1_000 });

  limiter.recordFailure(requestFrom("10.0.0.5"));
  limiter.recordFailure(requestFrom("10.0.0.6"));
  limiter.recordFailure(requestFrom("10.0.0.7"));
  assert.equal(limiter.snapshot().clientCount, 2);

  advance(16 * 60 * 1_000);
  limiter.check(requestFrom("10.0.0.8"));
  assert.equal(limiter.snapshot().clientCount, 0);
});

test("bounds log throttle keys independently from client state", () => {
  const { limiter } = createLimiterWithClock({
    logger() {},
    logThrottleMs: 0,
    maxLogThrottleEntries: 2,
  });

  limiter.recordFailure(requestFrom("10.0.2.1"));
  limiter.recordFailure(requestFrom("10.0.2.2"));
  limiter.recordFailure(requestFrom("10.0.2.3"));
  assert.equal(limiter.snapshot().logThrottleCount, 2);
});

test("global backpressure blocks new attempts only after the threshold is exceeded", () => {
  const { advance, limiter } = createLimiterWithClock({
    globalBackpressureMs: 5_000,
    globalFailureThreshold: 3,
    windowMs: 10 * 60 * 1_000,
  });

  limiter.recordFailure(requestFrom("10.0.1.1"));
  limiter.recordFailure(requestFrom("10.0.1.2"));
  limiter.recordFailure(requestFrom("10.0.1.3"));
  assert.equal(limiter.check(requestFrom("10.0.1.4")).allowed, true);
  limiter.recordFailure(requestFrom("10.0.1.5"));

  const blocked = limiter.check(requestFrom("10.0.1.4"));
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, "global_backpressure");
  assert.equal(blocked.retryAfterMs, 5_000);

  advance(10 * 60 * 1_000 + 1);
  assert.equal(limiter.check(requestFrom("10.0.1.4")).allowed, true);
});
