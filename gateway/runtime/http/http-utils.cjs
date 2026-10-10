const zlib = require("zlib");

// HTTP helper 保持无业务状态，供认证、静态资源和 server 路由复用。
class RequestBodyTooLargeError extends Error {
  constructor(maxBytes) {
    super(`Request body is larger than ${maxBytes} bytes`);
    this.code = "ERR_REQUEST_BODY_TOO_LARGE";
    this.maxBytes = maxBytes;
    this.statusCode = 413;
  }
}

function headerValue(headers, name) {
  // Node 会把大多数 header 规范化为小写，但这里仍做一次大小写无关查找，兼容测试构造对象。
  const normalized = String(name).toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (key.toLowerCase() === normalized) return value;
  }
  return undefined;
}

function send(res, status, headers, body) {
  // 所有响应都走这个出口，便于后续统一加安全 header 或日志。
  res.writeHead(status, headers);
  res.end(body);
}

function sendJson(res, status, value, extraHeaders = {}) {
  // 统一 JSON 缩进，方便直接 curl /api/health 时读状态。
  send(
    res,
    status,
    { "content-type": "application/json; charset=utf-8", ...extraHeaders },
    JSON.stringify(value, null, 2)
  );
}

function gzipIfUseful(req, headers, body) {
  // 小响应压缩收益低，且会增加调试成本，只对较大的文本/wasm 类资源启用 gzip。
  if (process.env.CODEX_WEB_DISABLE_GZIP === "1" || !Buffer.isBuffer(body) || body.length < 1024) return { headers, body };
  if (!String(req.headers["accept-encoding"] || "").includes("gzip")) return { headers, body };
  const contentType = String(headers["content-type"] || "");
  if (!/javascript|css|html|json|svg|wasm/i.test(contentType)) return { headers, body };
  // 压缩响应必须保留上游按账号和设备设置的 Vary 维度，避免共享缓存复用错误的会话快照。
  const varyValues = String(headerValue(headers, "vary") || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!varyValues.some((value) => value.toLowerCase() === "accept-encoding")) varyValues.push("Accept-Encoding");
  return {
    headers: { ...headers, "content-encoding": "gzip", vary: varyValues.join(", ") },
    body: zlib.gzipSync(body),
  };
}

function isRequestBodyTooLargeError(error) {
  return !!error && error.code === "ERR_REQUEST_BODY_TOO_LARGE";
}

/** 读取完整请求体，用于 JSON POST 和登录表单；可选 maxBytes 只限制缓冲体积，不改变其它调用方行为。 */
function readBody(req, options = {}) {
  const maxBytes = Math.max(0, Number(options.maxBytes || 0));
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let tooLarge = false;
    req.on("data", (chunk) => {
      totalBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
      if (maxBytes > 0 && totalBytes > maxBytes) {
        // 超限后继续让 Node 消费请求流，但不再缓存后续 chunk，避免登录接口被大 body 撑爆内存。
        tooLarge = true;
        return;
      }
      if (!tooLarge) chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) {
        reject(new RequestBodyTooLargeError(maxBytes));
        return;
      }
      resolve(Buffer.concat(chunks).toString("utf-8"));
    });
    req.on("error", reject);
  });
}

module.exports = {
  RequestBodyTooLargeError,
  gzipIfUseful,
  headerValue,
  isRequestBodyTooLargeError,
  readBody,
  send,
  sendJson,
};
