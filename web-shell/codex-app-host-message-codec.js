(function (root, factory) {
  const codec = factory();
  // CommonJS 只导出模块；浏览器脚本才挂全局，避免网关加载时污染 Node globalThis。
  if (typeof module === "object" && module && module.exports) {
    module.exports = codec;
  } else if (root) {
    root.__OpenCodexAppHostMessageCodec = codec;
  }
})(typeof globalThis === "undefined" ? this : globalThis, function () {
  "use strict";

  const ENCODING = "opencodex-structured-clone-v1";
  const MAX_DEPTH = 256;
  // 官方字符串 decoder 的 BigInt 防御边界为 16384 位，transport adapter 复用该上限。
  const MAX_BIGINT_DIGITS = 16_384;
  // 节点上限只保护 gateway 的 CPU 和内存，不改变 WebSocket 的帧大小边界。
  const MAX_NODES = 1_000_000;
  const TYPED_ARRAY_NAMES = new Set([
    "Int8Array",
    "Uint8Array",
    "Uint8ClampedArray",
    "Int16Array",
    "Uint16Array",
    "Int32Array",
    "Uint32Array",
    "Float32Array",
    "Float64Array",
    "BigInt64Array",
    "BigUint64Array",
  ]);

  function traversalState() {
    return { nodes: 0, seen: new WeakSet() };
  }

  function visitNode(state, depth) {
    state.nodes += 1;
    if (state.nodes > MAX_NODES) throw new TypeError("App-host message exceeds the node limit");
    // 官方 serializer 在 depth >= 256 时拒绝当前节点，因此允许深度为 0..255。
    if (depth >= MAX_DEPTH) throw new TypeError("App-host message exceeds the depth limit");
  }

  function bigintDigitCount(value) {
    const text = typeof value === "string" ? value : value.toString();
    return text.startsWith("-") ? text.length - 1 : text.length;
  }

  function rememberContainer(value, state) {
    if (state.seen.has(value)) throw new TypeError("App-host message contains a cycle");
    state.seen.add(value);
  }

  function bytesFromView(value) {
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }

  function bytesToBase64(bytes) {
    if (typeof Buffer !== "undefined" && typeof Buffer.from === "function") {
      return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
    }
    let binary = "";
    // 分块转换，避免大型 RPC 二进制参数触发浏览器调用栈或参数数量限制。
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
  }

  function base64ToBytes(value) {
    if (
      typeof value !== "string" ||
      value.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
    ) {
      throw new TypeError("Invalid app-host base64 payload");
    }
    if (typeof Buffer !== "undefined" && typeof Buffer.from === "function") {
      const buffer = Buffer.from(value, "base64");
      return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    }
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  function byteViewName(value) {
    if (value instanceof ArrayBuffer) return "ArrayBuffer";
    if (value instanceof DataView) return "DataView";
    const name = value && value.constructor && value.constructor.name;
    // Node Buffer 在 MessagePort 边界会恢复为 Uint8Array，这里主动使用同一语义。
    if (name === "Buffer") return "Uint8Array";
    return TYPED_ARRAY_NAMES.has(name) ? name : "";
  }

  function encodeNode(value, state, depth) {
    visitNode(state, depth);
    if (value === null) return ["null"];
    if (value === undefined) return ["undefined"];
    if (typeof value === "string") return ["string", value];
    if (typeof value === "boolean") return ["boolean", value];
    if (typeof value === "bigint") {
      if (bigintDigitCount(value) > MAX_BIGINT_DIGITS) {
        throw new TypeError("App-host message exceeds the BigInt digit limit");
      }
      return ["bigint", value.toString()];
    }
    if (typeof value === "number") {
      if (Number.isNaN(value)) return ["number", "nan"];
      if (value === Infinity) return ["number", "infinity"];
      if (value === -Infinity) return ["number", "-infinity"];
      if (Object.is(value, -0)) return ["number", "-0"];
      return ["number", value];
    }
    if (!value || typeof value !== "object") {
      throw new TypeError(`Unsupported app-host value type: ${typeof value}`);
    }

    if (Object.prototype.toString.call(value) === "[object Date]") {
      const timestamp = value.getTime();
      return ["date", Number.isNaN(timestamp) ? null : timestamp];
    }

    const viewName = byteViewName(value);
    if (viewName) return ["bytes", viewName, bytesToBase64(bytesFromView(value))];

    rememberContainer(value, state);
    if (Array.isArray(value)) {
      // 稀疏数组按官方 serializer 的逐索引读取规则编码为显式 undefined。
      const items = Array.from(value, (item) => encodeNode(item, state, depth + 1));
      state.seen.delete(value);
      return ["array", items];
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      state.seen.delete(value);
      throw new TypeError(`Unsupported app-host object: ${value.constructor?.name || "unknown"}`);
    }
    const entries = Object.keys(value).map((key) => [key, encodeNode(value[key], state, depth + 1)]);
    state.seen.delete(value);
    return ["object", entries];
  }

  function decodedByteView(name, base64) {
    if (typeof name !== "string" || !TYPED_ARRAY_NAMES.has(name) && name !== "ArrayBuffer" && name !== "DataView") {
      throw new TypeError(`Unsupported app-host byte view: ${String(name)}`);
    }
    const bytes = base64ToBytes(base64);
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    if (name === "ArrayBuffer") return buffer;
    if (name === "DataView") return new DataView(buffer);
    if (typeof globalThis[name] !== "function") throw new TypeError(`Unsupported app-host byte view: ${name}`);
    try {
      return new globalThis[name](buffer);
    } catch (error) {
      throw new TypeError(`Invalid ${name} byte length: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function decodeNode(node, state, depth) {
    visitNode(state, depth);
    if (!Array.isArray(node) || typeof node[0] !== "string") throw new TypeError("Invalid app-host wire node");
    const requireNodeLength = (length) => {
      if (node.length !== length) throw new TypeError(`Invalid app-host ${node[0]} node`);
    };
    switch (node[0]) {
      case "null":
        requireNodeLength(1);
        return null;
      case "undefined":
        requireNodeLength(1);
        return undefined;
      case "string":
        requireNodeLength(2);
        if (typeof node[1] !== "string") throw new TypeError("Invalid app-host string node");
        return node[1];
      case "boolean":
        requireNodeLength(2);
        if (typeof node[1] !== "boolean") throw new TypeError("Invalid app-host boolean node");
        return node[1];
      case "bigint":
        requireNodeLength(2);
        if (
          typeof node[1] !== "string" ||
          !/^-?\d+$/.test(node[1]) ||
          bigintDigitCount(node[1]) > MAX_BIGINT_DIGITS
        ) {
          throw new TypeError("Invalid app-host bigint node");
        }
        return BigInt(node[1]);
      case "number":
        requireNodeLength(2);
        if (typeof node[1] === "number" && Number.isFinite(node[1])) return node[1];
        if (node[1] === "nan") return NaN;
        if (node[1] === "infinity") return Infinity;
        if (node[1] === "-infinity") return -Infinity;
        if (node[1] === "-0") return -0;
        throw new TypeError("Invalid app-host number node");
      case "date":
        requireNodeLength(2);
        if (!(node[1] === null || (typeof node[1] === "number" && Number.isFinite(node[1])))) {
          throw new TypeError("Invalid app-host date node");
        }
        return new Date(node[1] === null ? NaN : node[1]);
      case "bytes":
        requireNodeLength(3);
        return decodedByteView(node[1], node[2]);
      case "array":
        requireNodeLength(2);
        if (!Array.isArray(node[1])) throw new TypeError("Invalid app-host array node");
        return node[1].map((item) => decodeNode(item, state, depth + 1));
      case "object": {
        requireNodeLength(2);
        if (!Array.isArray(node[1])) throw new TypeError("Invalid app-host object node");
        const value = {};
        for (const entry of node[1]) {
          if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string") {
            throw new TypeError("Invalid app-host object entry");
          }
          if (Object.prototype.hasOwnProperty.call(value, entry[0])) throw new TypeError("Duplicate app-host object key");
          Object.defineProperty(value, entry[0], {
            configurable: true,
            enumerable: true,
            value: decodeNode(entry[1], state, depth + 1),
            writable: true,
          });
        }
        return value;
      }
      default:
        throw new TypeError(`Unknown app-host wire tag: ${node[0]}`);
    }
  }

  function encode(value) {
    return encodeNode(value, traversalState(), 0);
  }

  function decode(value) {
    return decodeNode(value, traversalState(), 0);
  }

  function encodeMessageData(data) {
    // 旧版字符串 RPC 保持原始帧，只有新版结构化值进入 codec。
    if (data === null || typeof data === "string") return { data };
    return { data: encode(data), dataEncoding: ENCODING };
  }

  function decodeMessageData(message) {
    if (!message || typeof message !== "object") throw new TypeError("Invalid app-host transport message");
    if (message.dataEncoding === ENCODING) return decode(message.data);
    if (message.dataEncoding != null) throw new TypeError(`Unsupported app-host data encoding: ${String(message.dataEncoding)}`);
    if (message.data === null || typeof message.data === "string") return message.data;
    throw new TypeError("Unencoded app-host data must be a string or null");
  }

  return { decode, decodeMessageData, encode, encodeMessageData, encoding: ENCODING };
});
