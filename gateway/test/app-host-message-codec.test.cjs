const assert = require("node:assert/strict");
const test = require("node:test");

const codecPath = require.resolve("../../web-shell/codex-app-host-message-codec.js");
const codec = require(codecPath);

test("round-trips AppHost primitives and byte views", () => {
  // 每种二进制 view 都必须恢复为同名构造类型，不能退化成普通数组。
  const typedViews = {
    Int8Array: new Int8Array([-1, 2]),
    Uint8Array: new Uint8Array([0, 255]),
    Uint8ClampedArray: new Uint8ClampedArray([0, 255]),
    Int16Array: new Int16Array([-3, 4]),
    Uint16Array: new Uint16Array([5, 6]),
    Int32Array: new Int32Array([-7, 8]),
    Uint32Array: new Uint32Array([9, 10]),
    Float32Array: new Float32Array([1.5, -2.5]),
    Float64Array: new Float64Array([3.5, -4.5]),
    BigInt64Array: new BigInt64Array([-11n, 12n]),
    BigUint64Array: new BigUint64Array([13n, 14n]),
  };
  const source = {
    array: [undefined, null, true, "text", NaN, Infinity, -Infinity, -0],
    date: new Date("2026-09-01T00:00:00.000Z"),
    bigint: 12345678901234567890n,
    buffer: Uint8Array.from([0, 1, 255]).buffer,
    dataView: new DataView(Uint8Array.from([9, 2, 3, 8]).buffer, 1, 2),
    typedViews,
  };
  const value = codec.decode(codec.encode(source));
  assert.equal(value.array[0], undefined);
  assert.equal(value.array[4], NaN);
  assert.equal(value.array[5], Infinity);
  assert.equal(value.array[6], -Infinity);
  assert.equal(Object.is(value.array[7], -0), true);
  assert.equal(value.date.toISOString(), source.date.toISOString());
  assert.equal(value.bigint, source.bigint);
  assert.deepEqual([...new Uint8Array(value.buffer)], [0, 1, 255]);
  assert.deepEqual([...new Uint8Array(value.dataView.buffer)], [2, 3]);
  for (const [name, view] of Object.entries(typedViews)) {
    assert.equal(value.typedViews[name].constructor.name, name);
    assert.deepEqual([...value.typedViews[name]], [...view]);
  }
});

test("preserves legacy string/null and root undefined transport semantics", () => {
  assert.deepEqual(codec.encodeMessageData("legacy"), { data: "legacy" });
  assert.deepEqual(codec.encodeMessageData(null), { data: null });
  const encodedUndefined = codec.encodeMessageData(undefined);
  assert.equal(encodedUndefined.dataEncoding, codec.encoding);
  assert.equal(codec.decodeMessageData(encodedUndefined), undefined);
  assert.equal(codec.decodeMessageData({ data: "legacy" }), "legacy");
  assert.equal(codec.decodeMessageData({ data: null }), null);
});

test("enforces official depth and BigInt guardrails", () => {
  let depth255 = 0;
  for (let index = 0; index < 255; index += 1) depth255 = [depth255];
  assert.doesNotThrow(() => codec.encode(depth255));
  assert.doesNotThrow(() => codec.decode(codec.encode(depth255)));
  let depth256 = 0;
  for (let index = 0; index < 256; index += 1) depth256 = [depth256];
  assert.throws(() => codec.encode(depth256), /depth limit/);

  const maxDigits = BigInt("9".repeat(16_384));
  assert.doesNotThrow(() => codec.encode(maxDigits));
  assert.throws(() => codec.encode(BigInt(`1${"0".repeat(16_384)}`)), /BigInt digit limit/);
  assert.equal(codec.decode(["bigint", `-${"9".repeat(16_384)}`]) < 0n, true);
  assert.throws(() => codec.decode(["bigint", `1${"0".repeat(16_384)}`]), /bigint node/);
  assert.doesNotThrow(() => codec.encode(-maxDigits));
  let wireDepth256 = ["null"];
  for (let index = 0; index < 256; index += 1) wireDepth256 = ["array", [wireDepth256]];
  assert.throws(() => codec.decode(wireDepth256), /depth limit/);
});

test("rejects cycles, malformed tuples, invalid bytes and unknown tags", () => {
  const cycle = {};
  cycle.self = cycle;
  assert.throws(() => codec.encode(cycle), /cycle/);
  assert.throws(() => codec.decode(["string"]), /string node/);
  assert.throws(() => codec.decode(["number", 1, 2]), /number node/);
  assert.throws(() => codec.decode(["bytes", "Uint8Array", "bad"]), /base64/);
  assert.throws(() => codec.decode(["bytes", "Int16Array", "AA=="]), /byte length/);
  assert.throws(() => codec.decode(["bytes", "UnknownArray", ""]), /Unsupported app-host byte view/);
  assert.throws(() => codec.decode(["object", [["duplicate", ["null"]], ["duplicate", ["null"]]]]), /Duplicate/);
  assert.throws(() => codec.decode(["unknown"]), /Unknown app-host wire tag/);
  assert.throws(() => codec.decodeMessageData({ dataEncoding: "unknown", data: null }), /Unsupported app-host data encoding/);
});

test("caps wide payloads and does not pollute CommonJS global scope", () => {
  assert.doesNotThrow(() => codec.encode(Array.from({ length: 10_000 }, (_, index) => index)));
  assert.throws(() => codec.encode(new Array(1_000_000)), /node limit/);
  const wideWire = ["array", Array.from({ length: 1_000_000 }, () => ["undefined"])];
  assert.throws(() => codec.decode(wideWire), /node limit/);
  assert.equal(Object.prototype.hasOwnProperty.call(globalThis, "__OpenCodexAppHostMessageCodec"), false);
});
