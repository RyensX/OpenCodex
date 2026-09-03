const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createProductionModificationCoordinator,
} = require("../dist/modification/production.js");
const {
  gateway: gatewayPoints,
  runner: runnerPoints,
  staticRenderer: staticRendererPoints,
} = require("../runtime/modification/point-refs.cjs");

test("production coordinator executes a real capability through Kernel and reports semantic hits", () => {
  const snapshots = new Map();
  const coordinator = createProductionModificationCoordinator({
    host: "gateway",
    publish(point) {
      snapshots.set(point.id, point);
    },
  });
  const receiver = { offset: 4 };
  const capability = coordinator.bind(
    gatewayPoints.appServerLaunch,
    function (value) {
      return this.offset + value;
    },
  );
  let snapshot = snapshots.get(gatewayPoints.appServerLaunch.id);
  assert.equal(snapshot.status, "ready");
  assert.equal(snapshot.contributions.every((item) => item.activation === "ready"), true);
  assert.equal(capability.call(receiver, 3), 7);
  snapshot = snapshots.get(gatewayPoints.appServerLaunch.id);
  assert.equal(snapshot.status, "active");
  assert.equal(snapshot.contributions.every((item) => item.exercise === "active"), true);
});

test("production coordinator preserves Promise identity and does not hit rejected or thrown calls", async () => {
  const snapshots = new Map();
  const coordinator = createProductionModificationCoordinator({
    host: "gateway",
    publish(point) {
      snapshots.set(point.id, point);
    },
  });
  let resolvePromise;
  const promise = new Promise((resolve) => { resolvePromise = resolve; });
  const asyncCapability = coordinator.bind(gatewayPoints.liveObserver, () => promise);
  assert.equal(asyncCapability(), promise);
  assert.equal(snapshots.get(gatewayPoints.liveObserver.id).status, "ready");
  resolvePromise("ok");
  await promise;
  await Promise.resolve();
  assert.equal(snapshots.get(gatewayPoints.liveObserver.id).status, "active");

  const error = new Error("expected");
  const throwingCapability = coordinator.bind(gatewayPoints.dialogOpen, () => { throw error; });
  assert.throws(() => throwingCapability(), (actual) => actual === error);
  assert.equal(snapshots.get(gatewayPoints.dialogOpen.id).status, "ready");
});

test("production wrapper preserves objects whose then getter throws", () => {
  const snapshots = new Map();
  const coordinator = createProductionModificationCoordinator({
    host: "gateway",
    publish(point) { snapshots.set(point.id, point); },
  });
  const value = {};
  Object.defineProperty(value, "then", {
    get() { throw new Error("then getter must stay untouched"); },
  });
  const capability = coordinator.bind(gatewayPoints.dialogOpen, () => value);
  assert.equal(capability(), value);
  assert.equal(snapshots.get(gatewayPoints.dialogOpen.id).status, "active");
});

test("production installer binding stays ready until a separate semantic effect occurs", () => {
  const snapshots = new Map();
  const coordinator = createProductionModificationCoordinator({
    host: "gateway",
    publish(point) { snapshots.set(point.id, point); },
  });
  const install = coordinator.bind(gatewayPoints.ipcMain, () => "installed", { hitOnSuccess: false });
  assert.equal(install(), "installed");
  assert.equal(snapshots.get(gatewayPoints.ipcMain.id).status, "ready");
  coordinator.effect(gatewayPoints.ipcMain).emit();
  assert.equal(snapshots.get(gatewayPoints.ipcMain.id).status, "active");
});

test("production binding can require a real output change before reporting a hit", () => {
  const snapshots = new Map();
  const coordinator = createProductionModificationCoordinator({
    host: "static",
    publish(point) { snapshots.set(point.id, point); },
  });
  const point = staticRendererPoints.htmlLang;
  const patch = coordinator.bind(point, (source, replacement) => replacement || source, {
    hitWhen: (args, result) => result !== args[0],
  });
  assert.equal(patch("same", ""), "same");
  assert.equal(snapshots.get(point.id).status, "ready");
  assert.equal(patch("before", "after"), "after");
  assert.equal(snapshots.get(point.id).status, "active");
});

test("production coordinator rolls back verification failures and rejects cross-host points", () => {
  const coordinator = createProductionModificationCoordinator({ host: "gateway", publish() {} });
  const events = [];
  assert.throws(() => coordinator.execute(
    gatewayPoints.ipcMain,
    () => {
      events.push("apply");
      return "receipt";
    },
    {
      verify: () => false,
      rollback(value) {
        events.push(`rollback:${value}`);
      },
    },
  ), /验证失败/);
  assert.deepEqual(events, ["apply", "rollback:receipt"]);
  assert.throws(
    () => coordinator.execute(runnerPoints.gatewayAsar, () => undefined),
    /不能由 gateway Provider 执行/,
  );
});

test("production coordinator compiles same-adapter points as one host batch", async () => {
  const snapshots = new Map();
  const coordinator = createProductionModificationCoordinator({
    host: "gateway",
    publish(point) { snapshots.set(point.id, point); },
  });
  const batch = coordinator.executeBatch([
    { point: gatewayPoints.dialogOpen, operation: () => "dialog" },
    { point: gatewayPoints.browserWindow, operation: () => "window" },
  ]);

  assert.deepEqual(batch.failures, []);
  assert.equal(batch.executions.get(gatewayPoints.dialogOpen).value, "dialog");
  assert.equal(batch.executions.get(gatewayPoints.browserWindow).value, "window");
  const hookDiagnostics = batch.diagnostics().find((item) => item.adapterId === "adapter.runtime-hook");
  assert.equal(hookDiagnostics.metrics.contributionCount, 2);
  assert.equal(hookDiagnostics.metrics.installedPointCount, 2);
  assert.equal(snapshots.get(gatewayPoints.dialogOpen.id).status, "ready");
  await batch.dispose();
  assert.equal(snapshots.get(gatewayPoints.dialogOpen.id).contributions[0].activation, "disposed");
});

test("production coordinator replays every active snapshot without applying operations again", () => {
  const published = [];
  let applicationCount = 0;
  const coordinator = createProductionModificationCoordinator({
    host: "gateway",
    publish(point) { published.push(point); },
  });
  for (const point of [gatewayPoints.dialogOpen, gatewayPoints.browserWindow]) {
    coordinator.execute(point, () => {
      applicationCount += 1;
      return point.id;
    });
  }
  assert.equal(applicationCount, 2);

  published.length = 0;
  coordinator.refreshAll();

  // Runtime 身份重置只需要恢复诊断快照，不能再次安装真实 Hook 或重复业务副作用。
  assert.equal(applicationCount, 2);
  assert.deepEqual(new Set(published.map((point) => point.id)), new Set([
    gatewayPoints.dialogOpen.id,
    gatewayPoints.browserWindow.id,
  ]));
  assert.equal(published.every((point) => point.status === "ready"), true);
});

test("production coordinator resets semantic hits across modification enable cycles", () => {
  const snapshots = new Map();
  const coordinator = createProductionModificationCoordinator({
    host: "gateway",
    publish(point) { snapshots.set(point.id, point); },
  });
  const capability = coordinator.bind(gatewayPoints.turnRouter, () => "routed");
  capability();
  assert.equal(snapshots.get(gatewayPoints.turnRouter.id).status, "active");

  coordinator.setEnabled(gatewayPoints.turnRouter, false, "disabled by test");
  assert.equal(snapshots.get(gatewayPoints.turnRouter.id).status, "disabled");
  coordinator.setEnabled(gatewayPoints.turnRouter, true);
  let snapshot = snapshots.get(gatewayPoints.turnRouter.id);
  assert.equal(snapshot.status, "ready");
  assert.equal(snapshot.contributions.every((item) => item.hitCount === 0), true);
  capability();
  snapshot = snapshots.get(gatewayPoints.turnRouter.id);
  assert.equal(snapshot.status, "active");
});

test("production coordinator preserves precise location failures and official fallback state", () => {
  const snapshots = new Map();
  const coordinator = createProductionModificationCoordinator({
    host: "gateway",
    publish(point) { snapshots.set(point.id, point); },
  });
  const point = gatewayPoints.notification;
  coordinator.execute(point, () => undefined, { verify: () => true });
  coordinator.locationFailure(point, "unsupported", new Error("official target is absent"));
  coordinator.useFallback(point, "Official runtime behavior");

  const snapshot = snapshots.get(point.id);
  assert.equal(snapshot.status, "degraded");
  assert.equal(snapshot.contributions.every((item) => item.location === "unsupported"), true);
  assert.equal(snapshot.contributions.every((item) => item.fallbackActive), true);
  assert.equal(snapshot.contributions[0].fallbackReason, "Official runtime behavior");
});

test("production execution dispose releases an installed operation through Provider rollback", async () => {
  const coordinator = createProductionModificationCoordinator({ host: "gateway", publish() {} });
  const events = [];
  const execution = coordinator.execute(
    gatewayPoints.dialogOpen,
    () => {
      events.push("apply");
      return "receipt";
    },
    {
      rollback(value) { events.push(`rollback:${value}`); },
    },
  );
  await execution.dispose();
  assert.deepEqual(events, ["apply", "rollback:receipt"]);
  assert.throws(() => coordinator.effect(gatewayPoints.dialogOpen), /尚未由生产 Provider 激活/);
});

test("production batch continues cleanup after one business rollback fails", async () => {
  const coordinator = createProductionModificationCoordinator({ host: "gateway", publish() {} });
  const applications = [];
  const rollbacks = [];
  const operation = (name) => () => {
    applications.push(name);
    return name;
  };
  const rollback = (name) => () => {
    rollbacks.push(name);
    // 实际最后应用的状态会最先回滚；故意让它失败，验证后续清理仍会继续。
    if (name === applications.at(-1)) throw new Error(`${name} cleanup failed`);
  };
  const batch = coordinator.executeBatch([
    {
      point: gatewayPoints.dialogOpen,
      operation: operation("dialog"),
      options: { rollback: rollback("dialog") },
    },
    {
      point: gatewayPoints.browserWindow,
      operation: operation("window"),
      options: { rollback: rollback("window") },
    },
  ]);

  await assert.rejects(batch.dispose(), /cleanup failed/);
  assert.deepEqual(rollbacks, [...applications].reverse());
  await assert.doesNotReject(batch.dispose());
  assert.deepEqual(rollbacks, [...applications].reverse());
});
