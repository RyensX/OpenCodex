const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const PROVIDER_SOURCE = fs.readFileSync(
  path.join(REPO_ROOT, "web-shell", "internal", "providers", "codex-statsig-telemetry-guard.js"),
  "utf8"
);
const POLYFILL_SOURCE = fs.readFileSync(
  path.join(REPO_ROOT, "web-shell", "internal", "providers", "codex-bridge-polyfill.js"),
  "utf8"
);
const STATIC_ASSETS_SOURCE = fs.readFileSync(
  path.join(REPO_ROOT, "gateway", "runtime", "http", "static-assets.cjs"),
  "utf8"
);
const CATALOG_SOURCE = fs.readFileSync(
  path.join(REPO_ROOT, "gateway", "src", "modification", "catalog.ts"),
  "utf8"
);
const BROWSER_HOST_SOURCE = fs.readFileSync(
  path.join(REPO_ROOT, "web-shell", "src", "modification-browser-host.ts"),
  "utf8"
);
const { createStaticAssetService } = require("../runtime/http/static-assets.cjs");
const { messagesForLocale } = require("../../shared/i18n/index.cjs");

const POINT_ID = "web.runtime.network.telemetry-guard";
const PROVIDER_KEY = "statsig-telemetry-guard";
const GUARD_URL_PATH = "/codex-statsig-telemetry-guard.js";
const I18N_KEY = "web.runtimeCompatibility.point." + POINT_ID + ".description";
const NATIVE_BEACON_RESULT = "native-beacon-result";
const NEWLINE = String.fromCharCode(10);

/** 可控计时器：验证模拟响应确实被推迟到 send 返回之后。 */
function createScheduler() {
  let nextId = 1;
  const timers = new Map();
  const api = {
    setTimeout(callback, delay) {
      const id = nextId++;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  };
  return {
    api,
    timers,
    capture() {
      return {
        setTimeout: (callback, delay) => api.setTimeout(callback, delay),
        clearTimeout: (id) => api.clearTimeout(id),
      };
    },
    flush() {
      const pending = Array.from(timers.values());
      timers.clear();
      for (const timer of pending) timer.callback();
    },
  };
}

function createHarness() {
  const calls = { open: [], send: [], beacon: [] };

  class FakeXHR {
    constructor() {
      this.listeners = new Map();
      this.events = [];
    }
    open(method, url) {
      calls.open.push({ target: this, method, url });
    }
    send(body) {
      calls.send.push({ target: this, body });
    }
    setRequestHeader() {}
    addEventListener(type, handler) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(handler);
    }
    removeEventListener(type, handler) {
      const handlers = this.listeners.get(type);
      if (handlers) handlers.delete(handler);
    }
    dispatchEvent(event) {
      this.events.push(event.type);
      for (const handler of Array.from(this.listeners.get(event.type) || [])) {
        handler({ type: event.type, target: this });
      }
      return true;
    }
  }

  // 真实浏览器里 status/responseText/readyState 是原型上的只读 IDL getter，
  // 给实例属性直接赋值会被静默忽略，所以测试必须复刻这个形状，
  // 才能证明 Provider 的 defineProperty 覆盖真的生效。
  const readonlyProperties = [
    ["status", 0],
    ["statusText", ""],
    ["response", null],
    ["responseText", ""],
    ["readyState", 0],
  ];
  for (const entry of readonlyProperties) {
    Object.defineProperty(FakeXHR.prototype, entry[0], {
      configurable: true,
      get: () => entry[1],
    });
  }

  const nativeBeacon = (url, data) => {
    calls.beacon.push({ url, data });
    return NATIVE_BEACON_RESULT;
  };

  const scheduler = createScheduler();
  const scope = {
    generation: 7,
    emits: 0,
    owned: [],
    effects: { primary: { emit: () => { scope.emits += 1; } } },
    own(dispose) {
      scope.owned.push(dispose);
      return () => {
        const index = scope.owned.indexOf(dispose);
        if (index >= 0) scope.owned.splice(index, 1);
      };
    },
  };

  const window = {
    XMLHttpRequest: FakeXHR,
    navigator: { sendBeacon: nativeBeacon },
    location: { href: "https://chatgpt.com/developer-mode" },
    setTimeout: (callback, delay) => scheduler.api.setTimeout(callback, delay),
  };
  window.__OpenCodexAdapterHost = { scheduler: { capture: () => scheduler.capture() } };
  window.__OpenCodexCurrentProviderScope = scope;

  const sandbox = {
    URL,
    Event: class TestEvent {
      constructor(type) {
        this.type = type;
      }
    },
    console,
    document: {},
    location: window.location,
    navigator: window.navigator,
    window,
    XMLHttpRequest: FakeXHR,
  };

  return {
    FakeXHR,
    calls,
    nativeBeacon,
    scheduler,
    scope,
    timers: scheduler.timers,
    window,
    install() {
      vm.runInNewContext(PROVIDER_SOURCE, sandbox);
    },
  };
}

test("telemetry XHR is swallowed locally and answered with a mock successful response", () => {
  const harness = createHarness();
  harness.install();
  // 骨架约定：安装完成只代表 ready，没有真实遥测流量时不该上报命中。
  assert.equal(harness.scope.emits, 0);

  const xhr = new harness.FakeXHR();
  const handled = [];
  xhr.addEventListener("load", () => handled.push("load"));
  xhr.addEventListener("loadend", () => handled.push("loadend"));
  xhr.open("POST", "https://chatgpt.com/ces/v1/rgstr");
  assert.equal(harness.calls.open.length, 1);

  xhr.send("telemetry-payload");
  assert.equal(harness.calls.send.length, 0, "telemetry must not reach the native send");
  // 真实吞掉一条遥测才计一次命中，调试页据此从 ready 变为 active。
  assert.equal(harness.scope.emits, 1);
  assert.deepEqual(xhr.events, ["loadstart"]);
  // 状态补齐必须延后：SDK 通常在 send 返回之后才挂 load 监听器。
  assert.equal(harness.timers.size, 1);

  harness.scheduler.flush();
  assert.equal(xhr.status, 200);
  assert.equal(xhr.statusText, "OK");
  assert.equal(xhr.readyState, 4);
  assert.equal(xhr.responseText, "{}");
  assert.equal(xhr.response, "{}");
  assert.deepEqual(xhr.events, ["loadstart", "readystatechange", "load", "loadend"]);
  assert.deepEqual(handled, ["load", "loadend"]);
  assert.equal(harness.timers.size, 0);
  // 覆盖只发生在实例上，原型 getter 仍是初始值，说明没有污染其他 XHR。
  const fresh = new harness.FakeXHR();
  assert.equal(Object.getOwnPropertyDescriptor(harness.FakeXHR.prototype, "status").get.call(fresh), 0);
});

test("non-telemetry XHR keeps using the native send", () => {
  const harness = createHarness();
  harness.install();

  const passthroughUrls = [
    "https://chatgpt.com/v1/models",
    "https://chatgpt.com.evil.example/ces/v1/rgstr",
    "https://example.com/ces/v1/rgstr",
  ];
  passthroughUrls.forEach((url, index) => {
    const xhr = new harness.FakeXHR();
    xhr.open("GET", url);
    xhr.send(null);
    assert.equal(harness.calls.send.length, index + 1, "passthrough url: " + url);
    assert.equal(harness.timers.size, 0);
    assert.equal(xhr.readyState, 0);
    assert.deepEqual(xhr.events, []);
  });
  assert.equal(harness.scope.emits, 0, "passthrough traffic must not report a hit");
});

test("telemetry beacons report success without touching the native API", () => {
  const harness = createHarness();
  harness.install();

  assert.equal(
    harness.window.navigator.sendBeacon("https://chatgpt.com/ces/v1/rgstr", "payload"),
    true
  );
  assert.equal(harness.window.navigator.sendBeacon("/ces/v1/log_event", "payload"), true);
  assert.equal(harness.calls.beacon.length, 0);
  assert.equal(harness.scope.emits, 2, "each swallowed beacon reports one hit");

  assert.equal(
    harness.window.navigator.sendBeacon("https://example.com/ces/v1/rgstr", "payload"),
    NATIVE_BEACON_RESULT
  );
  assert.equal(harness.calls.beacon.length, 1);
  assert.equal(harness.calls.beacon[0].url, "https://example.com/ces/v1/rgstr");
  assert.equal(harness.scope.emits, 2, "a forwarded beacon must not report a hit");
});

test("loading the provider twice in one page generation installs a single patch", () => {
  const harness = createHarness();
  harness.install();
  const patchedOpen = harness.FakeXHR.prototype.open;
  const patchedSend = harness.FakeXHR.prototype.send;
  const patchedBeacon = harness.window.navigator.sendBeacon;

  harness.install();
  assert.equal(harness.FakeXHR.prototype.open, patchedOpen);
  assert.equal(harness.FakeXHR.prototype.send, patchedSend);
  assert.equal(harness.window.navigator.sendBeacon, patchedBeacon);
  assert.equal(harness.scope.emits, 0, "installing alone never reports a hit");
  assert.equal(harness.scope.owned.length, 1);
});

test("the dispose registered through own() restores the native prototypes", () => {
  const harness = createHarness();
  const originalOpen = harness.FakeXHR.prototype.open;
  const originalSend = harness.FakeXHR.prototype.send;
  harness.install();
  assert.equal(harness.scope.owned.length, 1);

  // 宿主在换页时逆序 dispose 所有 own 登记的资源。
  harness.scope.owned[0]();
  assert.equal(harness.FakeXHR.prototype.open, originalOpen);
  assert.equal(harness.FakeXHR.prototype.send, originalSend);
  assert.equal(harness.window.navigator.sendBeacon, harness.nativeBeacon);
  assert.equal(harness.window.__opencodexStatsigTelemetryGuardInstalled, undefined);

  const xhr = new harness.FakeXHR();
  xhr.open("POST", "https://chatgpt.com/ces/v1/rgstr");
  xhr.send("payload");
  assert.equal(harness.calls.send.length, 1, "restored prototype must stop swallowing");
  assert.equal(harness.timers.size, 0);
  assert.equal(harness.scope.emits, 0, "traffic after dispose went through the native send");

  // 还原标记后新页面可以重新安装补丁。
  harness.install();
  assert.notEqual(harness.FakeXHR.prototype.open, originalOpen, "reinstall must patch again");
  assert.equal(harness.scope.emits, 0);
});

test("the guard lives in its own provider while the upstream polyfill keeps no telemetry patch", () => {
  // 装配层负责把正文包成 providers.register 调用，脚本自身不得自注册。
  assert.ok(!PROVIDER_SOURCE.includes("providers.register"));
  assert.ok(PROVIDER_SOURCE.includes("__opencodexStatsigTelemetryGuardInstalled"));
  assert.ok(PROVIDER_SOURCE.includes("modificationScope?.own?.("));
  assert.ok(PROVIDER_SOURCE.includes("modificationEffects?.primary?.emit()"));
  // fetch 通道的遥测拦截仍归上游 polyfill；XHR/Beacon 通道已搬进独立 Provider。
  assert.ok(POLYFILL_SOURCE.includes("isTelemetryRegisterUrl"));
  const forbiddenPolyfillMarkers = [
    "__codexWebXhrPatched",
    "__codexWebBeaconPatched",
    "sendBeacon",
    "XMLHttpRequest.prototype.open",
  ];
  for (const marker of forbiddenPolyfillMarkers) {
    assert.ok(!POLYFILL_SOURCE.includes(marker), "polyfill must stay free of " + marker);
  }
});

test("the gateway serves the guard and registers it in the aggregated runtime bootstrap", (t) => {
  const webviewDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodex-statsig-"));
  t.after(() => fs.rmSync(webviewDir, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(webviewDir, "index.html"),
    "<html><head><title>Codex</title></head><body></body></html>"
  );
  const service = createStaticAssetService({
    compatibilityService: null,
    getI18nSnapshot: () => ({ locale: "en-US", messages: messagesForLocale("en-US") }),
    getOfficialBundle: () => ({ webviewDir }),
  });

  assert.equal(
    path.basename(service.staticFile(GUARD_URL_PATH)),
    "codex-statsig-telemetry-guard.js"
  );

  const res = {
    body: Buffer.alloc(0),
    headers: {},
    status: 0,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers || {};
    },
    end(body) {
      this.body = Buffer.isBuffer(body) ? body : Buffer.from(String(body || ""), "utf-8");
    },
  };
  service.serveRuntimeBootstrap({ headers: {} }, res);
  assert.equal(res.status, 200);
  const bootstrap = res.body.toString("utf-8");

  const guardIndex = bootstrap.indexOf('providers.register("' + PROVIDER_KEY + '"');
  const tooltipIndex = bootstrap.indexOf('providers.register("tooltip-dismiss"');
  assert.ok(guardIndex > 0, "guard must be wrapped by the provider registry");
  assert.ok(tooltipIndex >= 0 && guardIndex > tooltipIndex, "guard loads after the tooltip guard");
  // 正文必须原样嵌进 register 回调，装配层不会改写实现。
  assert.ok(bootstrap.includes("__opencodexStatsigTelemetryGuardInstalled"));

  // 启动顺序：补丁要在 Kernel 激活脚本之前装上，官方 SDK 初始化时 XHR 原型才已被接管。
  const groups = STATIC_ASSETS_SOURCE.slice(STATIC_ASSETS_SOURCE.indexOf("function runtimeBootstrapFileGroups"));
  const guardOrder = groups.indexOf("CODEX_STATSIG_TELEMETRY_GUARD_PATH");
  const activateOrder = groups.indexOf("OPENCODEX_MODIFICATION_ACTIVATE_PATH");
  assert.ok(guardOrder >= 0 && activateOrder > guardOrder, "guard must load before kernel activation");
});

test("the new point is cataloged once, bound once, and localized in both locales", () => {
  const declaration = '"' + POINT_ID + '"';
  const catalogLines = CATALOG_SOURCE.split(NEWLINE).filter((line) => line.includes(declaration));
  assert.equal(catalogLines.length, 1, "the point must be declared exactly once");
  assert.ok(catalogLines[0].includes("web-shell"));
  assert.ok(catalogLines[0].includes("G.webNetwork"));
  assert.ok(catalogLines[0].includes("A.networkRequest"));

  // 同一个点被两个 provider 绑定会在加载期抛错，这里按源码行守住唯一绑定。
  const bindingLines = BROWSER_HOST_SOURCE.split(NEWLINE).filter((line) => line.includes(POINT_ID));
  assert.equal(bindingLines.length, 1, "the point must bind exactly one provider");
  assert.ok(bindingLines[0].includes('key: "' + PROVIDER_KEY + '"'));
  assert.ok(bindingLines[0].includes('primary: "' + POINT_ID + '"'));

  assert.ok(
    STATIC_ASSETS_SOURCE.includes(
      '[path.join(INTERNAL_PROVIDER_DIR, "codex-statsig-telemetry-guard.js"), "' + PROVIDER_KEY + '"]'
    ),
    "static assets must map the file to the provider key"
  );
  assert.ok(
    STATIC_ASSETS_SOURCE.includes('const CODEX_STATSIG_TELEMETRY_GUARD_PATH = "' + GUARD_URL_PATH + '"')
  );
  assert.ok(
    STATIC_ASSETS_SOURCE.includes(
      "[CODEX_STATSIG_TELEMETRY_GUARD_PATH, path.join(INTERNAL_PROVIDER_DIR, \"codex-statsig-telemetry-guard.js\")]"
    ),
    "the guard file must be exposed as a static asset"
  );

  // 英文必须显式给描述；zh-CN 语言包按仓库约定不承载任何修改点文案（中文取自 catalog.ts 的
  // 中文描述并经 metadataText 回退），这里守住该约定不被悄悄破坏。
  const localeDir = path.join(REPO_ROOT, "shared", "i18n", "locales");
  const enMessages = JSON.parse(
    fs.readFileSync(path.join(localeDir, "runtime-compatibility-en-US.json"), "utf8")
  );
  assert.ok(String(enMessages[I18N_KEY] || "").trim(), "missing " + I18N_KEY + " for en-US");
  const zhMessages = JSON.parse(
    fs.readFileSync(path.join(localeDir, "runtime-compatibility-zh-CN.json"), "utf8")
  );
  const zhPointKeys = Object.keys(zhMessages).filter((key) =>
    key.startsWith("web.runtimeCompatibility.point.")
  );
  assert.deepEqual(zhPointKeys, [], "zh-CN keeps point descriptions in catalog.ts only");
});
