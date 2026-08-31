const assert = require("node:assert/strict");
const test = require("node:test");

const { POINT_DEFINITIONS } = require("../dist/modification/catalog.js");
const { createCompatibilityService } = require("../runtime/compatibility/service.cjs");

test("all 102 modification points preserve synchronous call contracts through the skeleton", () => {
  const service = createCompatibilityService();
  const calls = new Map();
  const wrappers = new Map();
  for (const point of POINT_DEFINITIONS) {
    wrappers.set(point.id, service.bindCapability(point.id, function (...args) {
      const result = Object.freeze({ id: point.id, args });
      calls.set(point.id, { args, result, thisValue: this });
      return result;
    }, {
      locatorRevision: "equivalence-sync-v1",
      verify: () => true,
    }));
    // 安装和验证不能提前误报真实命中。
    assert.equal(service.registry.point(point.id).status, "ready", point.id);
  }

  for (const point of POINT_DEFINITIONS) {
    const receiver = { pointId: point.id };
    const firstArgument = { marker: point.id };
    const result = wrappers.get(point.id).call(receiver, firstArgument, 2, false);
    const call = calls.get(point.id);
    assert.equal(call.thisValue, receiver, point.id);
    assert.equal(call.args[0], firstArgument, point.id);
    assert.deepEqual(call.args.slice(1), [2, false], point.id);
    assert.equal(result, call.result, point.id);
    assert.equal(service.registry.point(point.id).status, "healthy", point.id);
    assert.equal(service.registry.point(point.id).exercise.hitCount, 1, point.id);
  }
  service.dispose();
});

test("all 102 modification points preserve Promise identity and thrown errors", async () => {
  const service = createCompatibilityService();
  const contracts = new Map();
  for (const [index, point] of POINT_DEFINITIONS.entries()) {
    if (index % 2 === 0) {
      const promise = Promise.resolve(point.id);
      const wrapper = service.bindCapability(point.id, () => promise, {
        locatorRevision: "equivalence-async-v1",
        verify: () => true,
      });
      contracts.set(point.id, { kind: "promise", promise, wrapper });
    } else {
      const error = new Error(`expected:${point.id}`);
      const wrapper = service.bindCapability(point.id, () => {
        throw error;
      }, {
        locatorRevision: "equivalence-error-v1",
        verify: () => true,
      });
      contracts.set(point.id, { error, kind: "error", wrapper });
    }
  }

  for (const point of POINT_DEFINITIONS) {
    const contract = contracts.get(point.id);
    if (contract.kind === "promise") {
      const returned = contract.wrapper();
      assert.equal(returned, contract.promise, point.id);
      assert.equal(await returned, point.id);
      assert.equal(service.registry.point(point.id).exercise.hitCount, 1, point.id);
    } else {
      assert.throws(() => contract.wrapper(), (error) => error === contract.error, point.id);
      assert.equal(service.registry.point(point.id).status, "ready", point.id);
      assert.equal(service.registry.point(point.id).exercise.hitCount, 0, point.id);
    }
  }
  service.dispose();
});
