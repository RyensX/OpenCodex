const assert = require("node:assert/strict");
const test = require("node:test");

const { createModificationRuntime } = require("../dist/modification/kernel.js");
const {
  defineAdapter,
  defineModificationPoint,
  definePointGroup,
} = require("../dist/modification/sdk.js");
const {
  ADAPTER_DEFINITIONS,
  POINT_DEFINITIONS,
  POINT_GROUP_DEFINITIONS,
  POINT_TARGETS,
  MIGRATION_MATRIX,
} = require("../dist/modification/catalog.js");

test("typed modification catalog assigns every point to a group and adapter chain", () => {
  assert.equal(POINT_GROUP_DEFINITIONS.length, 17);
  assert.equal(ADAPTER_DEFINITIONS.length, 23);
  assert.equal(POINT_DEFINITIONS.length, 102);
  assert.equal(POINT_TARGETS.length, 102);
  assert.equal(MIGRATION_MATRIX.length, 102);
  assert.equal(MIGRATION_MATRIX.every((entry) => entry.migrationStatus === "migrated"), true);
  assert.deepEqual(
    ["browser", "gateway", "static", "runner"].map(
      (host) => MIGRATION_MATRIX.filter((entry) => entry.host === host).length
    ),
    [36, 36, 25, 5]
  );
  assert.equal(new Set(POINT_TARGETS).size, 102);
  assert.equal(new Set(POINT_DEFINITIONS.map((point) => point.id)).size, 102);
  assert.deepEqual(
    ["web.runtime.", "gateway.runtime.", "static.cache."].map(
      (prefix) => POINT_DEFINITIONS.filter((point) => point.id.startsWith(prefix)).length
    ),
    [36, 36, 30]
  );
  assert.equal(POINT_DEFINITIONS.every((point) => point.group && point.contributions.length > 0), true);
  assert.equal(POINT_DEFINITIONS.every((point) => point.contributions.every((item) => {
    return item.declaration.target &&
      !Object.hasOwn(item.declaration, "pointId") &&
      !Object.hasOwn(item.declaration, "implementation");
  })), true);
  const groupById = new Map(POINT_GROUP_DEFINITIONS.map((group) => [group.id, group]));
  assert.equal(groupById.get("workspace-creation").name, "新项目和新工作树创建");
  assert.equal(groupById.get("notification-power").name, "通知和隐藏 Runtime 后台节能");
  assert.equal(
    POINT_DEFINITIONS.find((point) => point.id === "web.runtime.bridge.feature-gates").group.id,
    "workspace-creation"
  );
});

test("kernel expands composite adapters and compiles terminal declarations in one batch", async () => {
  const runtime = createModificationRuntime();
  const group = runtime.registerGroup(definePointGroup({
    id: "test-group",
    name: "测试组",
    description: "验证适配器批量编译",
    order: 1,
  }));
  const terminal = defineAdapter({
    id: "adapter.test-terminal",
    name: "测试底层适配器",
    description: "批量执行测试声明",
    kind: "terminal",
  });
  const semantic = runtime.registerAdapter(defineAdapter({
    id: "adapter.test-semantic",
    name: "测试语义适配器",
    description: "展开到底层适配器",
    kind: "composite",
    dependencies: [terminal],
  }));
  runtime.expand({
    adapter: semantic,
    expand(declaration) {
      return [terminal.use(declaration)];
    },
  });
  let compileCount = 0;
  let batchSize = 0;
  runtime.provide({
    adapter: terminal,
    compile(contributions) {
      compileCount += 1;
      batchSize = contributions.length;
      return {
        locate(reporter) {
          for (const contribution of contributions) reporter.resolved(contribution);
        },
        apply(contribution, reporter) {
          reporter.applied(contribution);
        },
        verify(contribution, reporter) {
          reporter.verified(contribution);
        },
        activate(contribution, reporter) {
          reporter.hit(contribution);
        },
        diagnostics() {
          return { compileCount, batchSize };
        },
      };
    },
  });
  for (const id of ["web.runtime.test.one", "web.runtime.test.two"]) {
    runtime.registerPoint(defineModificationPoint({
      id,
      description: id,
      owner: "test",
      group,
      contributions: [semantic.use({ id })],
    }));
  }

  const plan = runtime.compile();
  assert.equal(compileCount, 1);
  assert.equal(batchSize, 2);
  const active = await runtime.activate(plan);
  assert.deepEqual(active.failures, []);
  const snapshot = runtime.snapshot();
  assert.deepEqual(snapshot.providerDiagnostics, [{
    adapterId: "adapter.test-terminal",
    metrics: { compileCount: 1, batchSize: 2 },
  }]);
  assert.deepEqual(snapshot.points[0].adapterChainIds, ["adapter.test-semantic", "adapter.test-terminal"]);
  assert.equal(snapshot.points.every((point) => point.contributions[0].exercise === "active"), true);
});

test("kernel rolls already applied adapter plans back in reverse order", async () => {
  const runtime = createModificationRuntime();
  const group = runtime.registerGroup(definePointGroup({
    id: "rollback-group",
    name: "回滚组",
    description: "验证原子回滚",
    order: 1,
  }));
  const first = defineAdapter({ id: "adapter.rollback-first", name: "第一适配器", description: "先应用", kind: "terminal" });
  const second = defineAdapter({ id: "adapter.rollback-second", name: "第二适配器", description: "后失败", kind: "terminal" });
  const events = [];
  runtime.provide({
    adapter: first,
    compile(contributions) {
      return {
        locate(reporter) { contributions.forEach((item) => reporter.resolved(item)); },
        apply(contribution, reporter) { reporter.applied(contribution); events.push("apply-first"); },
        rollback() { events.push("rollback-first"); },
      };
    },
  });
  runtime.provide({
    adapter: second,
    compile(contributions) {
      return {
        locate(reporter) { contributions.forEach((item) => reporter.resolved(item)); },
        apply() { events.push("apply-second"); throw new Error("apply failed"); },
      };
    },
  });
  runtime.registerPoint(defineModificationPoint({
    id: "gateway.runtime.test.rollback",
    description: "回滚测试",
    owner: "test",
    group,
    contributions: [first.use({}), second.use({})],
  }));

  const active = await runtime.activate(runtime.compile());
  assert.equal(active.failures.length, 1);
  assert.match(active.failures[0].reason, /apply failed/);
  assert.deepEqual(events, ["apply-first", "apply-second", "rollback-first"]);
  const contributionStates = runtime.snapshot().points[0].contributions;
  assert.equal(contributionStates[0].application, "rolled-back");
  assert.equal(contributionStates[1].application, "failed");
});

test("synchronous activation continues reverse rollback after one cleanup fails", () => {
  const runtime = createModificationRuntime();
  const group = runtime.registerGroup(definePointGroup({
    id: "sync-rollback-group",
    name: "同步回滚组",
    description: "验证同步启动边界的尽力回滚",
    order: 1,
  }));
  const first = defineAdapter({ id: "adapter.sync-rollback-first", name: "第一适配器", description: "最先应用", kind: "terminal" });
  const second = defineAdapter({ id: "adapter.sync-rollback-second", name: "第二适配器", description: "随后应用", kind: "terminal" });
  const third = defineAdapter({ id: "adapter.sync-rollback-third", name: "第三适配器", description: "触发失败", kind: "terminal" });
  const events = [];
  for (const adapter of [first, second]) {
    runtime.provide({
      adapter,
      compile(contributions) {
        return {
          locate(reporter) { contributions.forEach((item) => reporter.resolved(item)); },
          apply(contribution, reporter) {
            events.push(`apply:${adapter.id}`);
            reporter.applied(contribution);
          },
          rollback() {
            events.push(`rollback:${adapter.id}`);
            if (adapter === second) throw new Error("cleanup failed");
          },
        };
      },
    });
  }
  runtime.provide({
    adapter: third,
    compile(contributions) {
      return {
        locate(reporter) { contributions.forEach((item) => reporter.resolved(item)); },
        apply() {
          events.push(`apply:${third.id}`);
          throw new Error("business failed");
        },
      };
    },
  });
  runtime.registerPoint(defineModificationPoint({
    id: "gateway.runtime.test.sync-rollback",
    description: "同步回滚测试",
    owner: "test",
    group,
    contributions: [first.use({}), second.use({}), third.use({})],
  }));

  const active = runtime.activateSync(runtime.compile());
  assert.equal(active.failures.length, 1);
  assert.match(active.failures[0].reason, /business failed/);
  assert.deepEqual(events, [
    `apply:${first.id}`,
    `apply:${second.id}`,
    `apply:${third.id}`,
    `rollback:${second.id}`,
    `rollback:${first.id}`,
  ]);
});

test("asynchronous activation continues reverse rollback after one cleanup fails", async () => {
  const runtime = createModificationRuntime();
  const group = runtime.registerGroup(definePointGroup({
    id: "async-rollback-group",
    name: "异步回滚组",
    description: "验证异步启动边界的尽力回滚",
    order: 1,
  }));
  const first = defineAdapter({ id: "adapter.async-rollback-first", name: "第一适配器", description: "最先应用", kind: "terminal" });
  const second = defineAdapter({ id: "adapter.async-rollback-second", name: "第二适配器", description: "随后应用", kind: "terminal" });
  const third = defineAdapter({ id: "adapter.async-rollback-third", name: "第三适配器", description: "触发失败", kind: "terminal" });
  const events = [];
  for (const adapter of [first, second]) {
    runtime.provide({
      adapter,
      compile(contributions) {
        return {
          locate(reporter) { contributions.forEach((item) => reporter.resolved(item)); },
          async apply(contribution, reporter) {
            events.push(`apply:${adapter.id}`);
            reporter.applied(contribution);
          },
          async rollback() {
            events.push(`rollback:${adapter.id}`);
            if (adapter === second) throw new Error("cleanup failed");
          },
        };
      },
    });
  }
  runtime.provide({
    adapter: third,
    compile(contributions) {
      return {
        locate(reporter) { contributions.forEach((item) => reporter.resolved(item)); },
        async apply() {
          events.push(`apply:${third.id}`);
          throw new Error("business failed");
        },
      };
    },
  });
  runtime.registerPoint(defineModificationPoint({
    id: "gateway.runtime.test.async-rollback",
    description: "异步回滚测试",
    owner: "test",
    group,
    contributions: [first.use({}), second.use({}), third.use({})],
  }));

  const active = await runtime.activate(runtime.compile());
  assert.equal(active.failures.length, 1);
  assert.match(active.failures[0].reason, /business failed/);
  assert.deepEqual(events, [
    `apply:${first.id}`,
    `apply:${second.id}`,
    `apply:${third.id}`,
    `rollback:${second.id}`,
    `rollback:${first.id}`,
  ]);
});

test("kernel isolates a failed point while preserving another point in the same provider batch", async () => {
  const runtime = createModificationRuntime();
  const group = runtime.registerGroup(definePointGroup({
    id: "isolation-group",
    name: "隔离组",
    description: "验证修改点级故障隔离",
    order: 1,
  }));
  const adapter = defineAdapter({
    id: "adapter.isolation",
    name: "隔离适配器",
    description: "同一批次内按修改点执行",
    kind: "terminal",
  });
  const events = [];
  runtime.provide({
    adapter,
    compile(contributions) {
      assert.equal(contributions.length, 2);
      return {
        locate(reporter) { contributions.forEach((item) => reporter.resolved(item)); },
        apply(contribution, reporter) {
          events.push(`apply:${contribution.point.id}`);
          if (contribution.declaration.fail) throw new Error("expected failure");
          reporter.applied(contribution);
        },
        activate(contribution, reporter) { reporter.hit(contribution); },
      };
    },
  });
  runtime.registerPoint(defineModificationPoint({
    id: "web.runtime.test.isolation-failed",
    description: "失败点",
    owner: "test",
    group,
    contributions: [adapter.use({ fail: true })],
  }));
  runtime.registerPoint(defineModificationPoint({
    id: "web.runtime.test.isolation-active",
    description: "正常点",
    owner: "test",
    group,
    contributions: [adapter.use({ fail: false })],
  }));

  const active = await runtime.activate(runtime.compile());
  assert.equal(active.failures.length, 1);
  assert.deepEqual(events, [
    "apply:web.runtime.test.isolation-failed",
    "apply:web.runtime.test.isolation-active",
  ]);
  const snapshot = runtime.snapshot();
  assert.equal(snapshot.points.find((point) => point.id.endsWith("failed")).status, "unavailable");
  assert.equal(snapshot.points.find((point) => point.id.endsWith("active")).status, "active");
});

test("multi-contribution points become active only after every semantic effect is hit", async () => {
  const runtime = createModificationRuntime();
  const group = runtime.registerGroup(definePointGroup({
    id: "multi-hit-group",
    name: "多命中组",
    description: "验证全部 Contribution 命中语义",
    order: 1,
  }));
  const adapter = defineAdapter({
    id: "adapter.multi-hit",
    name: "多命中适配器",
    description: "延迟第二个语义效果",
    kind: "terminal",
  });
  let hitSecond = null;
  runtime.provide({
    adapter,
    compile(contributions) {
      return {
        locate(reporter) { contributions.forEach((item) => reporter.resolved(item)); },
        apply(contribution, reporter) { reporter.applied(contribution); },
        verify(contribution, reporter) { reporter.verified(contribution); },
        activate(contribution, reporter) {
          if (contribution.declaration.immediate) reporter.hit(contribution);
          else hitSecond = () => reporter.hit(contribution);
        },
      };
    },
  });
  runtime.registerPoint(defineModificationPoint({
    id: "web.runtime.test.multi-hit",
    description: "两个效果必须都命中",
    owner: "test",
    group,
    contributions: [adapter.use({ immediate: true }), adapter.use({ immediate: false })],
  }));

  await runtime.activate(runtime.compile());
  assert.equal(runtime.snapshot().points[0].status, "ready");
  hitSecond();
  assert.equal(runtime.snapshot().points[0].status, "active");
});

test("kernel rejects duplicate ids, unregistered groups and adapter cycles", () => {
  const runtime = createModificationRuntime();
  const group = definePointGroup({ id: "guard-group", name: "约束组", description: "验证注册约束", order: 1 });
  runtime.registerGroup(group);
  assert.throws(() => runtime.registerGroup(definePointGroup({
    id: "guard-group",
    name: "重复组",
    description: "重复 ID",
    order: 2,
  })), /重复/);

  const missingAdapter = defineAdapter({
    id: "adapter.missing",
    name: "缺失适配器",
    description: "未注册",
    kind: "terminal",
  });
  assert.throws(() => runtime.registerPoint(defineModificationPoint({
    id: "web.runtime.test.missing-adapter",
    description: "缺少适配器",
    owner: "test",
    group,
    contributions: [missingAdapter.use({})],
  })), /未注册适配器/);
});

test("kernel freezes registration after activation and cannot execute one plan twice", () => {
  const runtime = createModificationRuntime();
  const group = runtime.registerGroup(definePointGroup({
    id: "lifecycle-group",
    name: "生命周期组",
    description: "验证执行计划只激活一次",
    order: 1,
  }));
  const adapter = defineAdapter({
    id: "adapter.lifecycle",
    name: "生命周期适配器",
    description: "验证注册冻结",
    kind: "terminal",
  });
  runtime.provide({
    adapter,
    compile(contributions) {
      return {
        locate(reporter) { contributions.forEach((item) => reporter.resolved(item)); },
        apply(contribution, reporter) { reporter.applied(contribution); },
      };
    },
  });
  runtime.registerPoint(defineModificationPoint({
    id: "gateway.runtime.test.lifecycle",
    description: "生命周期测试",
    owner: "test",
    group,
    contributions: [adapter.use({})],
  }));
  const plan = runtime.compile();
  runtime.activateSync(plan);
  assert.throws(() => runtime.activateSync(plan), /不能重复激活/);
  assert.throws(() => runtime.registerGroup(definePointGroup({
    id: "late-group",
    name: "晚到组",
    description: "不允许写入已经激活的批次",
    order: 2,
  })), /不能继续注册/);
});

test("kernel continues reverse disposal after one Provider cleanup fails", async () => {
  const runtime = createModificationRuntime();
  const group = runtime.registerGroup(definePointGroup({
    id: "dispose-group",
    name: "销毁组",
    description: "验证尽力释放全部 Provider",
    order: 1,
  }));
  const first = defineAdapter({ id: "adapter.dispose-first", name: "第一销毁", description: "第一销毁", kind: "terminal" });
  const second = defineAdapter({ id: "adapter.dispose-second", name: "第二销毁", description: "第二销毁", kind: "terminal" });
  const events = [];
  for (const adapter of [first, second]) {
    runtime.provide({
      adapter,
      compile(contributions) {
        return {
          locate(reporter) { contributions.forEach((item) => reporter.resolved(item)); },
          apply(contribution, reporter) { reporter.applied(contribution); },
          dispose() {
            events.push(adapter.id);
            if (adapter === second) throw new Error("dispose failed");
          },
        };
      },
    });
  }
  runtime.registerPoint(defineModificationPoint({
    id: "gateway.runtime.test.dispose",
    description: "销毁测试",
    owner: "test",
    group,
    contributions: [first.use({}), second.use({})],
  }));
  const active = runtime.activateSync(runtime.compile());
  await assert.rejects(active.dispose(), /dispose failed/);
  assert.deepEqual(events, ["adapter.dispose-second", "adapter.dispose-first"]);
});
