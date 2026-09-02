const assert = require("node:assert/strict");
const test = require("node:test");

const codec = require("../../web-shell/codex-app-host-message-codec.js");

test("round-trips structured app-host values through JSON wire data", () => {
  const arrayBuffer = Uint8Array.from([1, 2, 3, 255]).buffer;
  const dataView = new DataView(Uint8Array.from([4, 5, 6, 7]).buffer);
  const original = {
    arrayBuffer,
    bigint: 9_007_199_254_740_993n,
    dataView,
    date: new Date("2026-08-31T08:34:36.921Z"),
    infinity: Infinity,
    invalidDate: new Date(NaN),
    nan: NaN,
    negativeInfinity: -Infinity,
    negativeZero: -0,
    nested: [undefined, null, true, "rpc"],
    uint16: new Uint16Array([1, 65_535]),
    uint8: new Uint8Array([8, 9, 10]),
    undefinedValue: undefined,
  };

  // 必须先经过真实 JSON stringify/parse，才能证明 wire 数据不会依赖进程内对象身份。
  const wireData = codec.encodeMessageData(original);
  const parsed = JSON.parse(JSON.stringify(wireData));
  const restored = codec.decodeMessageData(parsed);

  assert.equal(codec.encoding, "opencodex-structured-clone-v1");
  assert.equal(restored.bigint, original.bigint);
  assert.equal(restored.date.getTime(), original.date.getTime());
  assert.equal(Number.isNaN(restored.invalidDate.getTime()), true);
  assert.equal(Number.isNaN(restored.nan), true);
  assert.equal(restored.infinity, Infinity);
  assert.equal(restored.negativeInfinity, -Infinity);
  assert.equal(Object.is(restored.negativeZero, -0), true);
  assert.deepEqual(restored.nested, original.nested);
  assert.deepEqual(Array.from(new Uint8Array(restored.arrayBuffer)), [1, 2, 3, 255]);
  assert.deepEqual(Array.from(new Uint8Array(restored.dataView.buffer)), [4, 5, 6, 7]);
  assert.deepEqual(Array.from(restored.uint16), [1, 65_535]);
  assert.deepEqual(Array.from(restored.uint8), [8, 9, 10]);
  assert.equal(Object.prototype.hasOwnProperty.call(restored, "undefinedValue"), true);
});
test("keeps legacy string and null app-host frames unchanged", () => {
  assert.deepEqual(codec.encodeMessageData("legacy-json-rpc"), { data: "legacy-json-rpc" });
  assert.equal(codec.decodeMessageData({ data: "legacy-json-rpc" }), "legacy-json-rpc");
  assert.deepEqual(codec.encodeMessageData(null), { data: null });
  assert.equal(codec.decodeMessageData({ data: null }), null);

  const undefinedWire = codec.encodeMessageData(undefined);
  assert.equal(undefinedWire.dataEncoding, codec.encoding);
  assert.equal(codec.decodeMessageData(JSON.parse(JSON.stringify(undefinedWire))), undefined);
});

test("matches official depth, bigint, and wide-array limits", () => {
  // 官方限制允许 16384 位十进制 BigInt；负号不计入位数。
  const acceptedBigInt = BigInt(`1${"0".repeat(16_383)}`);
  const acceptedNegativeBigInt = BigInt(`-1${"0".repeat(16_383)}`);
  const rejectedBigInt = BigInt(`1${"0".repeat(16_384)}`);
  assert.doesNotThrow(() => codec.encode(acceptedBigInt));
  assert.doesNotThrow(() => codec.encode(acceptedNegativeBigInt));
  assert.throws(() => codec.encode(rejectedBigInt), /BigInt digit limit/);

  function nestedArrays(depth) {
    let value = "leaf";
    for (let index = 0; index < depth; index += 1) value = [value];
    return value;
  }

  // 根节点深度为 0，官方 serializer 在深度 256 开始拒绝，因此 255 是最后一个可用深度。
  const depth255 = codec.encode(nestedArrays(255));
  assert.doesNotThrow(() => codec.decode(depth255));
  assert.throws(() => codec.encode(nestedArrays(256)), /depth limit/);
  assert.throws(() => codec.decode(["array", [depth255]]), /depth limit/);

  // 节点护栏必须允许明显超过旧 100000 上限的宽数组。
  const wideArray = new Array(120_000).fill(true);
  assert.doesNotThrow(() => codec.encode(wideArray));
  assert.equal(codec.decode(codec.encode(wideArray)).length, wideArray.length);

  // 节点上限阻止恶意宽数组在 JSON/WS 边界持续消耗 CPU。
  const overNodeLimit = new Array(1_000_001).fill(null);
  assert.throws(() => codec.encode(overNodeLimit), /node limit/);
  const overWireNodeLimit = new Array(1_000_001).fill(["null"]);
  assert.throws(() => codec.decode(["array", overWireNodeLimit]), /node limit/);
});

test("does not publish a CommonJS codec on globalThis", () => {
  assert.equal(Object.prototype.hasOwnProperty.call(globalThis, "__OpenCodexAppHostMessageCodec"), false);
});

test("normalizes sparse arrays to the official explicit undefined semantics", () => {
  const sparse = Array(2);
  sparse[1] = "value";

  const restored = codec.decodeMessageData(JSON.parse(JSON.stringify(codec.encodeMessageData(sparse))));

  assert.deepEqual(restored, [undefined, "value"]);
  assert.equal(0 in restored, true);
});

test("preserves object keys without prototype mutation", () => {
  const value = {};
  Object.defineProperty(value, "__proto__", { enumerable: true, value: { polluted: true } });

  const restored = codec.decode(codec.encode(value));

  assert.equal(Object.getPrototypeOf(restored), Object.prototype);
  assert.equal(Object.prototype.polluted, undefined);
  assert.deepEqual(restored.__proto__, { polluted: true });
});

test("rejects cycles, unsupported objects, and malformed wire data", () => {
  const cyclic = {};
  cyclic.self = cyclic;

  assert.throws(() => codec.encode(cyclic), /cycle/);
  assert.throws(() => codec.encode(new Map([["key", "value"]])), /Unsupported app-host object/);
  assert.throws(() => codec.decodeMessageData({ data: {} }), /Unencoded app-host data/);
  assert.throws(
    () => codec.decodeMessageData({ dataEncoding: "future-codec", data: [] }),
    /Unsupported app-host data encoding/
  );
  assert.throws(() => codec.decode(["bytes", "Uint16Array", "AQ=="]), /Invalid Uint16Array byte length/);
  assert.throws(() => codec.decode(["bytes", "Uint8Array", "!!!!"]), /Invalid app-host base64 payload/);
  assert.throws(() => codec.decode(["object", [["key", ["string", "one"]], ["key", ["string", "two"]]]]), /Duplicate app-host object key/);
  assert.doesNotThrow(() => codec.decode(["bigint", `-1${"0".repeat(16_383)}`]));
  assert.throws(() => codec.decode(["bigint", "1".repeat(16_385)]), /Invalid app-host bigint node/);
  assert.throws(() => codec.decode(["null", false]), /Invalid app-host null node/);
  assert.throws(() => codec.decode(["string", "value", "extra"]), /Invalid app-host string node/);
  assert.throws(() => codec.decode(["bytes", "Uint8Array"]), /Invalid app-host bytes node/);
  assert.throws(() => codec.decode(["unknown"]), /Unknown app-host wire tag/);
});
