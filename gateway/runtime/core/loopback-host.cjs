function normalizedHostname(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  const bracketed = raw.match(/^\[([^\]]+)]$/);
  return (bracketed ? bracketed[1] : raw).replace(/\.$/, "");
}

function validIpv4Address(hostname) {
  const parts = String(hostname || "").split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    const value = Number(part);
    return value >= 0 && value <= 255;
  });
}

function isIpv4Loopback(hostname) {
  // IPv4 loopback 是完整的 127.0.0.0/8，不只包含 127.0.0.1。
  const normalized = normalizedHostname(hostname);
  return validIpv4Address(normalized) && normalized.split(".")[0] === "127";
}

function loopbackHostname(hostname) {
  const normalized = normalizedHostname(hostname);
  if (!normalized) return false;
  if (normalized === "localhost" || normalized === "::1") return true;
  if (isIpv4Loopback(normalized)) return true;
  if (normalized.startsWith("::ffff:")) return isIpv4Loopback(normalized.slice("::ffff:".length));
  return false;
}

function hostnameFromHostHeader(hostHeader) {
  const rawValue = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
  const raw = String(rawValue || "").trim();
  if (!raw) return "";
  const bracketed = raw.match(/^\[([^\]]+)](?::\d+)?$/);
  if (bracketed) return normalizedHostname(bracketed[1]);
  try {
    // Host header 可能带端口；交给 URL 解析能覆盖域名、IPv4 和标准 bracket IPv6。
    return normalizedHostname(new URL(`http://${raw}`).hostname);
  } catch {}
  const colonCount = (raw.match(/:/g) || []).length;
  if (colonCount === 1) return normalizedHostname(raw.slice(0, raw.lastIndexOf(":")));
  return normalizedHostname(raw);
}

function isLoopbackHostHeader(hostHeader) {
  return loopbackHostname(hostnameFromHostHeader(hostHeader));
}

module.exports = {
  hostnameFromHostHeader,
  isLoopbackHostHeader,
  loopbackHostname,
};
