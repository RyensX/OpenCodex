const assert = require("node:assert/strict");
const test = require("node:test");
const {
  BROWSER_INJECTION_POINTS,
  GLOBAL_INJECTION_POINTS,
  createInjectionHealthRegistry,
} = require("../runtime/model-router/injection-health.cjs");

test("injection health requires every gateway and current-browser receipt", () => {
  const registry = createInjectionHealthRegistry({
    getRuntimeIdentity: () => ({ version: "26.7", build: "52143" }),
  });
  const clientId = "browser_page_123";

  for (const point of GLOBAL_INJECTION_POINTS) assert.equal(registry.reportGateway(point), true);
  for (const point of BROWSER_INJECTION_POINTS) assert.equal(registry.reportBrowser(point, clientId), true);

  const healthy = registry.snapshot({ clientId, enabled: true });
  assert.equal(healthy.status, "ok");
  assert.equal(healthy.items.every((item) => item.status === "ok" && item.reportedAt > 0), true);
  assert.deepEqual(healthy.runtime, { version: "26.7", build: "52143" });

  // 浏览器回执按页面隔离，另一个页面不能借用已经报绿的 renderer 注入状态。
  const anotherPage = registry.snapshot({ clientId: "browser_page_456", enabled: true });
  assert.equal(anotherPage.status, "error");
  assert.equal(anotherPage.items.filter((item) => item.scope === "browser").every((item) => item.status === "missing"), true);
  assert.equal(registry.reportBrowser("app-server-router", clientId), false);
});

test("injection health resets receipts when the Codex runtime version changes", () => {
  let identity = { version: "26.7", build: "1" };
  const registry = createInjectionHealthRegistry({ getRuntimeIdentity: () => identity });
  registry.reportGateway("app-server-router");
  assert.equal(
    registry.snapshot({ clientId: "browser_page_123", enabled: true }).items.find((item) => item.id === "app-server-router")
      .status,
    "ok"
  );

  identity = { version: "26.8", build: "2" };
  const reset = registry.snapshot({ clientId: "browser_page_123", enabled: true });
  assert.deepEqual(reset.runtime, identity);
  assert.equal(reset.items.every((item) => item.status === "missing"), true);
  assert.equal(registry.snapshot({ clientId: "browser_page_123", enabled: false }).status, "disabled");
});
