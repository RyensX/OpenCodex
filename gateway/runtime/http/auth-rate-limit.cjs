const crypto = require("crypto");
const { diagnosticWarn } = require("../core/diagnostics.cjs");

const DEFAULT_LIMIT_OPTIONS = {
  backoffBaseMs: 1_000,
  backoffMaxMs: 30_000,
  clientLockThreshold: 10,
  globalBackpressureMs: 5_000,
  globalFailureThreshold: 80,
  lockMs: 15 * 60 * 1_000,
  logThrottleMs: 10_000,
  maxClients: 512,
  maxLogThrottleEntries: 2048,
  pruneIntervalMs: 60_000,
  windowMs: 10 * 60 * 1_000,
};

function normalizeClientAddress(value) {
  const raw = String(value || "").trim();
  if (!raw) return "unknown";
  // Node 在 IPv6 socket 上可能把 IPv4 表示成 ::ffff:127.0.0.1；限速 key 统一归一化。
  const ipv4Mapped = raw.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (ipv4Mapped) return ipv4Mapped[1];
  return raw;
}

function clientKeyFromRequest(req) {
  // 默认只信任 TCP 连接上的 remoteAddress，不读取 X-Forwarded-For，避免客户端伪造来源绕过限速。
  return normalizeClientAddress(req && req.socket ? req.socket.remoteAddress : "");
}

function shortClientKey(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, 12);
}

function retryAfterMs(value) {
  return Math.max(1, Math.ceil(Number(value) || 0));
}

function createAuthRateLimiter(options = {}) {
  const config = { ...DEFAULT_LIMIT_OPTIONS, ...options };
  const clients = new Map();
  const globalFailures = [];
  const logThrottle = new Map();
  let globalBackpressureUntilMs = 0;
  let lastPruneAtMs = 0;

  function nowMs() {
    return typeof config.now === "function" ? Number(config.now()) || 0 : Date.now();
  }

  function logWarn(event, details, now) {
    if (config.logger === null) return;
    const key = `${event}:${details.client || "global"}`;
    const lastAt = logThrottle.get(key) || 0;
    if (now - lastAt < config.logThrottleMs) return;
    logThrottle.delete(key);
    logThrottle.set(key, now);
    // 来源地址不断变化时也只保留最近告警键，避免日志节流表绕过 client map 上限无限增长。
    while (logThrottle.size > config.maxLogThrottleEntries) {
      logThrottle.delete(logThrottle.keys().next().value);
    }
    const logger = typeof config.logger === "function" ? config.logger : diagnosticWarn;
    logger("auth-rate-limit", event, details);
  }

  function pruneFailureWindow(failures, now) {
    const cutoff = now - config.windowMs;
    while (failures.length > 0 && failures[0] <= cutoff) failures.shift();
    return failures;
  }

  function pruneGlobalFailures(now) {
    pruneFailureWindow(globalFailures, now);
    if (globalBackpressureUntilMs <= now && globalFailures.length <= config.globalFailureThreshold) {
      globalBackpressureUntilMs = 0;
    }
  }

  function pruneClients(now, force = false) {
    pruneGlobalFailures(now);
    if (!force && now - lastPruneAtMs < config.pruneIntervalMs && clients.size <= config.maxClients) return;
    lastPruneAtMs = now;
    const inactiveCutoff = now - Math.max(config.windowMs, config.lockMs, config.backoffMaxMs);
    for (const [key, client] of clients.entries()) {
      pruneFailureWindow(client.failures, now);
      if (client.lockedUntilMs <= now) client.lockedUntilMs = 0;
      if (client.nextAllowedAtMs <= now) client.nextAllowedAtMs = 0;
      if (
        client.failures.length === 0 &&
        client.lockedUntilMs === 0 &&
        client.nextAllowedAtMs === 0 &&
        client.lastSeenAtMs <= inactiveCutoff
      ) {
        clients.delete(key);
      }
    }
    if (clients.size <= config.maxClients) return;
    // 超过上限时按最近访问时间淘汰最旧 key，防止攻击者制造无限来源耗尽内存。
    const ordered = Array.from(clients.entries()).sort((left, right) => left[1].lastSeenAtMs - right[1].lastSeenAtMs);
    for (const [key] of ordered) {
      if (clients.size <= config.maxClients) break;
      clients.delete(key);
    }
  }

  function clientForKey(key, now) {
    let client = clients.get(key);
    if (!client) {
      client = {
        failures: [],
        lastSeenAtMs: now,
        lockedUntilMs: 0,
        nextAllowedAtMs: 0,
      };
      clients.set(key, client);
    }
    client.lastSeenAtMs = now;
    return client;
  }

  function backoffForFailureCount(count) {
    const exponent = Math.max(0, count - 1);
    return Math.min(config.backoffMaxMs, config.backoffBaseMs * 2 ** exponent);
  }

  function blockedDecision(reason, clientKey, retryMs, failureCount, now) {
    const decision = {
      allowed: false,
      clientKey,
      failureCount,
      reason,
      retryAfterMs: retryAfterMs(retryMs),
    };
    logWarn(
      reason,
      {
        client: shortClientKey(clientKey),
        failureCount,
        retryAfterMs: decision.retryAfterMs,
      },
      now
    );
    return decision;
  }

  function globalBackpressureDecision(clientKey, now) {
    pruneGlobalFailures(now);
    if (globalFailures.length > config.globalFailureThreshold && globalBackpressureUntilMs <= now) {
      globalBackpressureUntilMs = now + config.globalBackpressureMs;
    }
    if (globalBackpressureUntilMs <= now) return null;
    return blockedDecision(
      "global_backpressure",
      clientKey,
      globalBackpressureUntilMs - now,
      globalFailures.length,
      now
    );
  }

  function check(req) {
    const now = nowMs();
    pruneClients(now);
    const clientKey = clientKeyFromRequest(req);
    const client = clients.get(clientKey);
    if (client) {
      client.lastSeenAtMs = now;
      pruneFailureWindow(client.failures, now);
      if (client.lockedUntilMs > now) {
        return blockedDecision("client_locked", clientKey, client.lockedUntilMs - now, client.failures.length, now);
      }
      if (client.nextAllowedAtMs > now) {
        return blockedDecision("client_backoff", clientKey, client.nextAllowedAtMs - now, client.failures.length, now);
      }
    }
    const globalDecision = globalBackpressureDecision(clientKey, now);
    if (globalDecision) return globalDecision;
    return { allowed: true, clientKey, retryAfterMs: 0 };
  }

  function recordFailure(req) {
    const now = nowMs();
    pruneClients(now);
    const clientKey = clientKeyFromRequest(req);
    const client = clientForKey(clientKey, now);
    if (clients.size > config.maxClients) pruneClients(now, true);
    pruneFailureWindow(client.failures, now);
    client.failures.push(now);
    globalFailures.push(now);
    pruneGlobalFailures(now);

    const failureCount = client.failures.length;
    let reason = "client_backoff";
    let retryMs = backoffForFailureCount(failureCount);
    let limited = false;
    if (failureCount >= config.clientLockThreshold) {
      reason = "client_locked";
      retryMs = config.lockMs;
      limited = true;
      client.lockedUntilMs = now + config.lockMs;
      client.nextAllowedAtMs = client.lockedUntilMs;
    } else {
      client.nextAllowedAtMs = now + retryMs;
    }
    if (globalFailures.length > config.globalFailureThreshold) {
      globalBackpressureUntilMs = Math.max(globalBackpressureUntilMs, now + config.globalBackpressureMs);
    }

    logWarn(
      "login_failed",
      {
        client: shortClientKey(clientKey),
        failureCount,
        limited,
        retryAfterMs: retryMs,
      },
      now
    );
    return {
      allowed: !limited,
      clientKey,
      failureCount,
      limited,
      reason,
      retryAfterMs: retryAfterMs(retryMs),
    };
  }

  function recordSuccess(req) {
    const clientKey = clientKeyFromRequest(req);
    clients.delete(clientKey);
    return { clientKey };
  }

  function reset() {
    clients.clear();
    globalFailures.length = 0;
    logThrottle.clear();
    globalBackpressureUntilMs = 0;
    lastPruneAtMs = 0;
  }

  function snapshot() {
    return {
      clientCount: clients.size,
      globalBackpressureUntilMs,
      globalFailureCount: globalFailures.length,
      logThrottleCount: logThrottle.size,
    };
  }

  return {
    check,
    recordFailure,
    recordSuccess,
    reset,
    snapshot,
  };
}

const authRateLimiter = createAuthRateLimiter();

module.exports = {
  DEFAULT_LIMIT_OPTIONS,
  authRateLimiter,
  clientKeyFromRequest,
  createAuthRateLimiter,
  normalizeClientAddress,
};
