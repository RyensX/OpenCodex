const assert = require("node:assert/strict");
const test = require("node:test");

const { MIGRATION_MATRIX, POINT_DEFINITIONS } = require("../dist/modification/catalog.js");
const { createProductionModificationCoordinator } = require("../dist/modification/production.js");

const hostByPoint = new Map(MIGRATION_MATRIX.map((entry) => [entry.pointId, entry.host]));

function bindPoint(point, operation, snapshots) {
  const coordinator = createProductionModificationCoordinator({
    host: hostByPoint.get(point.id),
    publish(snapshot) { snapshots.set(point.id, snapshot); },
  });
  return coordinator.bind(point, operation);
}

test("all 103 modification points preserve synchronous call contracts through the production Kernel", () => {
  const calls = new Map();
  const wrappers = new Map();
  const snapshots = new Map();
  for (const point of POINT_DEFINITIONS) {
    wrappers.set(point.id, bindPoint(point, function (...args) {
      const result = Object.freeze({ id: point.id, args });
      calls.set(point.id, { args, result, thisValue: this });
      return result;
    }, snapshots));
    assert.equal(snapshots.get(point.id).status, "ready", point.id);
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
    assert.equal(snapshots.get(point.id).status, "active", point.id);
    assert.equal(snapshots.get(point.id).contributions.every((item) => item.hitCount === 1), true, point.id);
  }
});

test("all 103 modification points preserve Promise identity and thrown errors in production Kernel", async () => {
  const contracts = new Map();
  const snapshots = new Map();
  for (const [index, point] of POINT_DEFINITIONS.entries()) {
    if (index % 2 === 0) {
      const promise = Promise.resolve(point.id);
      contracts.set(point.id, {
        kind: "promise",
        promise,
        wrapper: bindPoint(point, () => promise, snapshots),
      });
    } else {
      const error = new Error(`expected:${point.id}`);
      contracts.set(point.id, {
        error,
        kind: "error",
        wrapper: bindPoint(point, () => { throw error; }, snapshots),
      });
    }
  }

  for (const point of POINT_DEFINITIONS) {
    const contract = contracts.get(point.id);
    if (contract.kind === "promise") {
      const returned = contract.wrapper();
      assert.equal(returned, contract.promise, point.id);
      assert.equal(await returned, point.id);
      await Promise.resolve();
      assert.equal(snapshots.get(point.id).status, "active", point.id);
    } else {
      assert.throws(() => contract.wrapper(), (error) => error === contract.error, point.id);
      assert.equal(snapshots.get(point.id).status, "ready", point.id);
      assert.equal(snapshots.get(point.id).contributions.every((item) => item.hitCount === 0), true, point.id);
    }
  }
});
