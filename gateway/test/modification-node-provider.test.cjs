const assert = require("node:assert/strict");
const test = require("node:test");

const { createRuntimeHookApi, defineHookTarget } = require("../dist/modification/contracts.js");
const { createModificationRuntime } = require("../dist/modification/kernel.js");
const { defineAdapter, defineModificationPoint, definePointGroup } = require("../dist/modification/sdk.js");
const { createNodeRuntimeHookProvider } = require("../dist/providers/node-adapter-providers.js");

test("Node RuntimeHook Provider shares one wrapper and reports hits only on invocation", async () => {
  const runtime = createModificationRuntime();
  const group = runtime.registerGroup(definePointGroup({
    id: "node-hook-group",
    name: "Node Hook 组",
    description: "验证 Node Provider 的共享 Wrapper",
    order: 1,
  }));
  const adapter = defineAdapter({
    id: "adapter.node-hook-test",
    name: "Node Hook 测试适配器",
    description: "验证真实函数 Hook Provider",
    kind: "terminal",
  });
  const hooks = createRuntimeHookApi(adapter);
  const targetRef = defineHookTarget("hook.calculator", undefined);
  const target = {
    offset: 1,
    calculate(value) {
      return this.offset + value;
    },
  };
  const thisValues = [];
  const original = target.calculate;
  const provider = createNodeRuntimeHookProvider({
    adapter,
    resolve(ref) {
      return ref === targetRef ? { object: target, property: "calculate" } : null;
    },
  });
  runtime.provide(provider);
  runtime.registerPoint(defineModificationPoint({
    id: "gateway.runtime.test.node-hook-first",
    description: "先调整参数",
    owner: "test",
    group,
    contributions: [hooks.before({
      target: targetRef,
      order: 10,
      handle({ args, thisValue }) {
        thisValues.push(thisValue);
        return [args[0] * 2];
      },
    })],
  }));
  runtime.registerPoint(defineModificationPoint({
    id: "gateway.runtime.test.node-hook-second",
    description: "再调整结果",
    owner: "test",
    group,
    contributions: [hooks.after({
      target: targetRef,
      order: 20,
      handle({ result, thisValue }) {
        thisValues.push(thisValue);
        return result + 3;
      },
    })],
  }));

  const active = await runtime.activate(runtime.compile());
  assert.deepEqual(active.failures, []);
  assert.notEqual(target.calculate, original);
  assert.equal(provider.diagnostics().wrapperCount, 1);
  assert.equal(runtime.snapshot().points.every((point) => point.status === "ready"), true);
  assert.equal(target.calculate(4), 12);
  assert.deepEqual(thisValues, [target, target]);
  assert.equal(provider.diagnostics().invocationCount, 1);
  assert.equal(runtime.snapshot().points.every((point) => point.status === "active"), true);

  await active.dispose();
  assert.equal(target.calculate, original);
  assert.equal(provider.diagnostics().wrapperCount, 0);
});

test("Node RuntimeHook Provider preserves constructor prototypes and new semantics", async () => {
  const runtime = createModificationRuntime();
  const group = runtime.registerGroup(definePointGroup({
    id: "constructor-hook-group",
    name: "构造器 Hook 组",
    description: "验证构造器语义",
    order: 1,
  }));
  const adapter = defineAdapter({
    id: "adapter.constructor-hook-test",
    name: "构造器 Hook 测试",
    description: "验证 Reflect.construct 路径",
    kind: "terminal",
  });
  const hooks = createRuntimeHookApi(adapter);
  class Box {
    constructor(value) {
      this.value = value;
    }
  }
  const target = { Box };
  const targetRef = defineHookTarget("hook.box-constructor", "constructor");
  runtime.provide(createNodeRuntimeHookProvider({
    adapter,
    resolve(ref) {
      return ref === targetRef ? { object: target, property: "Box" } : null;
    },
  }));
  runtime.registerPoint(defineModificationPoint({
    id: "gateway.runtime.test.constructor-hook",
    description: "构造前调整参数",
    owner: "test",
    group,
    contributions: [hooks.before({
      target: targetRef,
      handle({ args }) {
        return [args[0] * 2];
      },
    })],
  }));

  const active = await runtime.activate(runtime.compile());
  const instance = new target.Box(4);
  assert.equal(instance.value, 8);
  assert.equal(instance instanceof Box, true);
  await active.dispose();
  assert.equal(target.Box, Box);
});
