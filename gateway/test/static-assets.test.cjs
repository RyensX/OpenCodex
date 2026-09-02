const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { PATCHED_OFFICIAL_PREFIX } = require("../runtime/core/config.cjs");
const {
  listPluginEntries,
  pluginEntryFileFromRequestPath,
  pluginMessagesForLocale,
  pluginSdkRangeCompatible,
} = require("../runtime/core/plugin-assets.cjs");
const { createCompatibilityService } = require("../runtime/compatibility/service.cjs");
const {
  ADAPTER_DEFINITIONS,
  POINT_DEFINITIONS,
  POINT_GROUP_DEFINITIONS,
} = require("../runtime/compatibility/catalog.cjs");
const {
  OPENCODEX_RUNTIME_BOOTSTRAP_PATH,
  createStaticAssetService,
} = require("../runtime/http/static-assets.cjs");
const {
  messagesForLocale,
  runtimeCompatibilityMessagesForLocale,
} = require("../../shared/i18n/index.cjs");

const WEB_SHELL_INDEX = path.resolve(__dirname, "..", "..", "web-shell", "index.html");
const INTERNAL_PROVIDER_DIR = path.resolve(__dirname, "..", "..", "web-shell", "internal", "providers");
const BRIDGE_POLYFILL = path.join(INTERNAL_PROVIDER_DIR, "codex-bridge-polyfill.js");
const APP_HOST_MESSAGE_CODEC = path.resolve(__dirname, "..", "..", "web-shell", "codex-app-host-message-codec.js");
const SMART_SCHEDULING_SETTINGS = path.join(INTERNAL_PROVIDER_DIR, "codex-smart-model-router-settings.js");
const SMART_SCHEDULING_INJECTION_HEALTH = path.join(INTERNAL_PROVIDER_DIR, "codex-smart-scheduling-injection-health.js");
const SMART_SCHEDULING_COMPOSER = path.join(INTERNAL_PROVIDER_DIR, "codex-smart-model-router-composer.js");
const SMART_SCHEDULING_SUMMARY = path.join(INTERNAL_PROVIDER_DIR, "codex-smart-scheduling-summary.js");
const SMART_SCHEDULING_SUMMARY_CSS = path.resolve(
  __dirname,
  "..",
  "..",
  "web-shell",
  "codex-smart-scheduling-summary.css"
);
const SMART_SCHEDULING_PLUGIN_DIR = path.resolve(
  __dirname,
  "..",
  "..",
  "web-shell",
  "plugins",
  "smart-model-router"
);
const TOKEN_USAGE_INLINE_PLUGIN = path.resolve(
  __dirname,
  "..",
  "..",
  "web-shell",
  "internal",
  "providers",
  "token-usage-inline.js"
);
const MESSAGE_FOR_VIEW_CHANNEL = "codex_desktop:message-for-view";
const WINDOW_FOCUS_CHANGED_MESSAGE = "electron-window-focus-changed";

function sourceFunctionDeclaration(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing function ${name}`);
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] !== "}") continue;
    depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  assert.fail(`unterminated function ${name}`);
}

function createBrowserFocusHarness(bridge) {
  const windowListeners = new Map();
  const documentListeners = new Map();
  const emitted = [];
  let hasFocus = true;
  const document = {
    visibilityState: "visible",
    hasFocus: () => hasFocus,
  };
  const w = {};
  const context = {
    adapterHost: {
      events: {
        observe({ target, type, callback }) {
          const listeners = target === w ? windowListeners : documentListeners;
          listeners.set(type, callback);
          return () => listeners.delete(type);
        },
      },
    },
    document,
    emitWindowMessage: (channel, payload) => emitted.push({ channel, payload }),
    w,
  };
  const functionNames = [
    "browserWindowIsFocused",
    "emitBrowserWindowFocusChanged",
    "browserRendererMessagePayload",
    "installBrowserWindowFocusBridge",
    "effectiveGatewayMessageChannel",
  ];
  const declarations = functionNames.map((name) => sourceFunctionDeclaration(bridge, name)).join("\n");
  // 执行生产函数本身，避免只验证源码字符串存在而漏掉 focus payload 行为回归。
  const focusBridge = vm.runInNewContext(
    `const MESSAGE_FOR_VIEW_CHANNEL = ${JSON.stringify(MESSAGE_FOR_VIEW_CHANNEL)};
     const WINDOW_FOCUS_CHANGED_MESSAGE = ${JSON.stringify(WINDOW_FOCUS_CHANGED_MESSAGE)};
     ${declarations}
     ({ ${functionNames.join(", ")} })`,
    context
  );
  return {
    context,
    documentListeners,
    emitted,
    focusBridge,
    setFocus: (value) => {
      hasFocus = value;
    },
    windowListeners,
  };
}

function createAppHostWireHarness(bridge) {
  const codec = require(APP_HOST_MESSAGE_CODEC);
  const functionNames = ["appHostMessageCodec", "encodeAppHostMessageData", "decodeAppHostMessageData"];
  const declarations = functionNames.map((name) => sourceFunctionDeclaration(bridge, name)).join("\n");
  // 执行 bridge 生产 helper，验证 provider 实际读取提前注入的全局 codec。
  return vm.runInNewContext(
    `${declarations}\n({ ${functionNames.join(", ")} })`,
    { w: { __OpenCodexAppHostMessageCodec: codec } }
  );
}

function createAppHostBridgeBehaviorHarness(bridge, { wsReady = true } = {}) {
  const codec = require(APP_HOST_MESSAGE_CODEC);
  const windowListeners = new Map();
  const portListeners = new Map();
  const wsMessages = [];
  const diagnostics = [];
  const publishedData = [];
  const fakeWindow = {
    __OpenCodexAppHostMessageCodec: codec,
    WebSocket: { OPEN: 1 },
    crypto: { randomUUID: () => "app-host-test-port" },
  };
  const fakeSocket = {
    OPEN: 1,
    readyState: wsReady ? 1 : 0,
    send(raw) {
      wsMessages.push(JSON.parse(String(raw)));
    },
  };
  const fakePort = {
    closed: false,
    posted: [],
    started: false,
    addEventListener(type, handler) {
      portListeners.set(type, handler);
    },
    close() {
      this.closed = true;
    },
    postMessage(message) {
      this.posted.push(message);
    },
    start() {
      this.started = true;
    },
  };
  const functionNames = [
    "appHostPortId",
    "appHostMessageCodec",
    "encodeAppHostMessageData",
    "decodeAppHostMessageData",
    "appHostWsPayload",
    "sendAppHostWsPayload",
    "flushAppHostRelayMessages",
    "flushAllAppHostRelayMessages",
    "appHostPendingPayloadChars",
    "queueAppHostRelayPayload",
    "finalizeAppHostRelay",
    "closeAppHostRelay",
    "handleAppHostGatewayMessage",
    "installAppHostMessagePortBridge",
  ];
  const declarations = functionNames.map((name) => sourceFunctionDeclaration(bridge, name)).join("\n");
  // 用最小依赖执行生产 bridge，覆盖 provider 生命周期下的 MessagePort/WS 事件闭环。
  const result = vm.runInNewContext(
    `
      const w = windowContext;
      const ws = socketContext;
      const wsReady = wsReadyContext;
      const clientId = "app-host-test-client";
      const providerGeneration = {};
      const modificationEffects = null;
      const APP_HOST_RELAY_MAX_ENTRIES = 64;
      const APP_HOST_PENDING_MESSAGE_LIMIT = 2000;
      const APP_HOST_PENDING_MESSAGE_CHARS_LIMIT = 16 * 1024 * 1024;
      const appHostPortRelays = new Map();
      const adapterHost = {
        events: {
          observe({ target, type, callback }) {
            if (target === w) windowListeners.set(type, callback);
          },
        },
      };
      function clientDiagnostic(name, payload) { diagnostics.push({ name, payload }); }
      function publishAppHostData(data, direction) { publishedData.push({ data, direction }); }
      function payloadShape(value) { return value === null ? "null" : typeof value; }
      function websocketStateName() { return "open"; }
      ${declarations}
      ({ appHostPortRelays, installAppHostMessagePortBridge, handleAppHostGatewayMessage, w })
    `,
    {
      diagnostics,
      publishedData,
      socketContext: fakeSocket,
      windowContext: fakeWindow,
      windowListeners,
      wsReadyContext: wsReady,
    }
  );
  return { ...result, diagnostics, fakePort, portListeners, publishedData, windowListeners, wsMessages };
}

function makeTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodex-static-assets-test-"));
  t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
  return dir;
}

function makeOfficialWebviewDir(t) {
  const dir = makeTempDir(t);
  // 只构造最小官方 renderer 入口，测试注入顺序，不依赖真实官方缓存。
  fs.writeFileSync(path.join(dir, "index.html"), "<html><head><title>Codex</title></head><body></body></html>");
  return dir;
}

function createService(webviewDir, compatibilityService = null, locale = "en-US") {
  return createStaticAssetService({
    compatibilityService,
    getI18nSnapshot: () => ({ locale, messages: messagesForLocale(locale) }),
    getOfficialBundle: () => ({ webviewDir }),
  });
}

function makeResponseRecorder() {
  return {
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
}

function serveOfficialAsset(service, reqPath, host) {
  const file = service.staticFile(reqPath);
  const res = makeResponseRecorder();
  service.serveFile({ headers: { host } }, res, file, 200, reqPath);
  return res.body.toString("utf-8");
}

function serveOfficialAssetResponse(service, reqPath, host = "localhost:3737", headers = {}) {
  const file = service.staticFile(reqPath);
  const res = makeResponseRecorder();
  service.serveFile({ headers: { host, ...headers } }, res, file, 200, reqPath);
  return res;
}

function runtimeBootstrapSource(service) {
  const res = makeResponseRecorder();
  service.serveRuntimeBootstrap({ headers: {} }, res);
  assert.equal(res.status, 200);
  return res.body.toString("utf-8");
}

test("runtime compatibility diagnostics are public, grouped, explained, and reported before feature scripts", (t) => {
  const webviewDir = makeOfficialWebviewDir(t);
  const service = createService(webviewDir);
  const pagePath = "/opencodex/runtime-compatibility";
  const settingsPath = "/settings/developer/runtime-compatibility";
  assert.equal(service.isPublicStaticPath(pagePath), true);
  assert.equal(service.isPublicStaticPath(settingsPath), true);
  assert.match(service.staticFile(pagePath), /runtime-compatibility\.html$/);
  assert.equal(fs.existsSync(service.staticFile(settingsPath)), true);

  const page = fs.readFileSync(service.staticFile(pagePath), "utf8");
  assert.match(page, /id="pointsTable"/);
  assert.doesNotMatch(page, /id="featureList"/);
  for (const help of ["adapter", "overall", "location", "application", "verification", "activation", "exercise"]) {
    assert.match(page, new RegExp(`data-help="${help}"`));
  }
  assert.match(page, /分组只用于查看，不影响启用、回退或执行决策/);
  assert.doesNotMatch(page, /未归组|独立修改点/);
  const diagnosticsScript = fs.readFileSync(service.staticFile("/opencodex/runtime-compatibility.js"), "utf8");
  const diagnosticsStyles = fs.readFileSync(service.staticFile("/opencodex/runtime-compatibility.css"), "utf8");
  assert.match(diagnosticsScript, /point\.adapterChainIds/);
  assert.match(diagnosticsScript, /snapshot\.adapterTypes/);
  assert.match(diagnosticsScript, /point\.contributions/);
  assert.match(diagnosticsScript, /feature-title-line/);
  assert.doesNotMatch(diagnosticsScript, /snapshot\.features/);
  assert.match(diagnosticsStyles, /\.feature-title-line/);
  const loginShell = fs.readFileSync(WEB_SHELL_INDEX, "utf8");
  assert.match(loginShell, /href="\/settings\/developer\/runtime-compatibility"/);

  const bootstrap = runtimeBootstrapSource(service);
  const compatibilityIndex = bootstrap.indexOf("OpenCodexRuntimeCompatibility");
  const sidebarIndex = bootstrap.indexOf("__opencodexSidebarPreviewInstalled");
  assert.ok(compatibilityIndex >= 0);
  assert.ok(sidebarIndex > compatibilityIndex);
});

test("runtime compatibility page follows the public authentication locale", (t) => {
  const webviewDir = makeOfficialWebviewDir(t);
  for (const [locale, expectedTitle] of [
    ["zh-CN", "OpenCodex虚拟骨架调试"],
    ["en-US", "OpenCodex Virtual Skeleton Diagnostics"],
  ]) {
    const service = createService(webviewDir, null, locale);
    const reqPath = "/settings/developer/runtime-compatibility";
    const response = serveOfficialAssetResponse(service, reqPath, "localhost:3737", {
      "accept-encoding": "identity",
    });
    const page = response.body.toString("utf8");
    assert.equal(response.status, 200);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.match(response.headers["content-type"], /^text\/html/);
    assert.match(page, new RegExp(`<html lang="${locale}">`));
    assert.match(page, new RegExp(JSON.stringify(expectedTitle).slice(1, -1)));
    assert.match(page, new RegExp(`"locale":"${locale}"`));
    assert.doesNotMatch(page, /opencodex-runtime-config/);
  }
});

test("English diagnostics metadata covers every built-in group, adapter, and point", () => {
  const messages = runtimeCompatibilityMessagesForLocale("en-US");
  for (const group of POINT_GROUP_DEFINITIONS) {
    assert.ok(messages[`web.runtimeCompatibility.group.${group.id}.name`], `missing group name: ${group.id}`);
    assert.ok(messages[`web.runtimeCompatibility.group.${group.id}.description`], `missing group description: ${group.id}`);
  }
  for (const adapter of ADAPTER_DEFINITIONS) {
    assert.ok(messages[`web.runtimeCompatibility.adapter.${adapter.id}.name`], `missing adapter name: ${adapter.id}`);
    assert.ok(messages[`web.runtimeCompatibility.adapter.${adapter.id}.description`], `missing adapter description: ${adapter.id}`);
  }
  for (const point of POINT_DEFINITIONS) {
    assert.ok(messages[`web.runtimeCompatibility.point.${point.id}.description`], `missing point: ${point.id}`);
  }
});

test("compatibility capabilities preserve renderer HTML output byte for byte", (t) => {
  const webviewDir = makeOfficialWebviewDir(t);
  const baseline = createService(webviewDir).createRendererResponse();
  const compatibilityService = createCompatibilityService();
  const migrated = createService(webviewDir, compatibilityService).createRendererResponse();
  assert.equal(migrated, baseline);
  assert.equal(
    compatibilityService.registry.point("static.cache.renderer.html.runtime-bootstrap").status,
    "healthy"
  );
  compatibilityService.dispose();
});

test("runtime bootstrap honors an explicit gzip rejection", (t) => {
  const service = createService(makeOfficialWebviewDir(t));
  const identity = makeResponseRecorder();
  service.serveRuntimeBootstrap({ headers: { "accept-encoding": "gzip;q=0, br;q=0, *;q=1" } }, identity);
  const compressed = makeResponseRecorder();
  service.serveRuntimeBootstrap({ headers: { "accept-encoding": "gzip" } }, compressed);
  const brotli = makeResponseRecorder();
  service.serveRuntimeBootstrap({ headers: { "accept-encoding": "br,gzip" } }, brotli);

  assert.equal(identity.status, 200);
  assert.equal(identity.headers["content-encoding"], undefined);
  assert.match(identity.headers.etag, /^W\//);
  assert.equal(identity.body.toString("utf-8"), runtimeBootstrapSource(service));
  assert.equal(compressed.headers["content-encoding"], "gzip");
  assert.ok(compressed.body.length < identity.body.length);
  assert.equal(brotli.headers["content-encoding"], "br");
  assert.ok(brotli.body.length < compressed.body.length);
});

async function serveOfficialAssetResponseAsync(service, reqPath, host = "localhost:3737", headers = {}) {
  const file = service.staticFile(reqPath);
  const res = makeResponseRecorder();
  // 压缩表示会异步完成；identity 表示仍可同步返回，await 对两种路径保持同一测试接口。
  await service.serveFile({ headers: { host, ...headers } }, res, file, 200, reqPath);
  return res;
}

test("web shell manifest requests credentials for protected origins", () => {
  const html = fs.readFileSync(WEB_SHELL_INDEX, "utf-8");

  assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest" crossorigin="use-credentials" \/>/);
});

test("web shell scripts revalidate unchanged content instead of retransferring it", (t) => {
  const service = createService(makeOfficialWebviewDir(t));
  const first = serveOfficialAssetResponse(
    service,
    "/codex-bridge-polyfill.js",
    "192.168.1.20:3737",
    { "accept-encoding": "gzip" }
  );
  const validated = serveOfficialAssetResponse(
    service,
    "/codex-bridge-polyfill.js",
    "192.168.1.20:3737",
    { "accept-encoding": "gzip", "if-none-match": first.headers.etag }
  );

  assert.equal(first.status, 200);
  assert.equal(first.headers["cache-control"], "private, no-cache, must-revalidate");
  assert.equal(first.headers["content-encoding"], "gzip");
  assert.match(first.headers.etag, /^W\//);
  assert.equal(validated.status, 304);
  assert.equal(validated.headers.etag, first.headers.etag);
  assert.equal(validated.body.length, 0);
});

test("web shell keeps restart controls visible, recoverable and bound to a new gateway instance", () => {
  const html = fs.readFileSync(WEB_SHELL_INDEX, "utf-8");

  assert.match(html, /id="settings-restart" class="settings-restart"/);
  assert.match(html, /id="restart-dialog" class="restart-dialog"/);
  assert.match(html, /id="restart-password" type="password"/);
  assert.match(html, /restartButton\.disabled = true/);
  assert.match(html, /restartButtonSpinner\.hidden = false/);
  assert.match(html, /state\.instanceId !== previousInstanceId/);
  assert.match(html, /GATEWAY_RESTART_TIMEOUT_MS = 120_000/);
  assert.match(html, /GATEWAY_RESTART_STATUS_TIMEOUT_MS = 5_000/);
  assert.match(html, /new AbortController\(\)/);
  assert.match(html, /document\.visibilityState === "hidden"/);
  assert.match(html, /window\.location\.reload\(\)/);
  assert.match(html, /showRestartWaitFailure\(t\("web\.settings\.restartTimeout"\)\)/);
  assert.match(html, /overflow-y: auto/);
  assert.match(html, /env\(safe-area-inset-bottom, 0px\)/);
});

test("bridge keeps synchronous official preload methods out of the adaptive IPC fallback", () => {
  const source = fs.readFileSync(BRIDGE_POLYFILL, "utf-8");

  // 这两个官方 preload 方法必须同步返回基础值；一旦返回 Promise，最新版 renderer 会在首屏直接崩溃。
  assert.match(source, /target\.getPreloadStartedAtMs = \(\) => preloadStartedAtMs;/);
  assert.match(
    source,
    /target\.getInitialSidebarBootstrap = \(\) => \{[\s\S]*return cfg\.initialSidebarBootstrap \?\? null;[\s\S]*\};/
  );
  assert.match(source, /target\.isDeviceCheckSupported = \(\) => false;/);
  assert.match(source, /target\.startFileDrag = \(\) => false;/);
  assert.ok(source.indexOf("target.getInitialSidebarBootstrap") < source.indexOf("createAdaptiveBridgeProxy"));
});

test("bridge hides the legacy Electron application menu capability", () => {
  const source = fs.readFileSync(BRIDGE_POLYFILL, "utf-8");

  // 旧版 renderer 只要发现此方法存在就会展示“文件/编辑/视图/帮助”，两层兜底都必须保留。
  assert.match(source, /delete target\.showApplicationMenu;/);
  assert.match(source, /BRIDGE_FALLBACK_UNDEFINED_PROPS[\s\S]*"showApplicationMenu"/);
});

test("patched official renderer hides the app-host application menu capability", (t) => {
  const webviewDir = makeOfficialWebviewDir(t);
  const assetsDir = path.join(webviewDir, "assets");
  fs.mkdirSync(assetsDir, { recursive: true });
  const assetName = "app-initial-menu-test.js";
  fs.writeFileSync(
    path.join(assetsDir, assetName),
    [
      'const labels={file:{id:"windowsMenuBar.file"}};',
      "function isMenuEnabled(){return isWindows()&&services.applicationMenu!=null}",
      "function isSecondaryMenuEnabled(){return isLinux() && host?.applicationMenu !== void 0}",
      "function getMenu(){return services.applicationMenu.getSnapshot()}",
      "const capabilitySnapshot=services.applicationMenu!=null;",
    ].join("")
  );
  const service = createService(webviewDir);

  const source = serveOfficialAsset(service, `${PATCHED_OFFICIAL_PREFIX}assets/${assetName}`, "localhost:3737");

  // 只关闭新版 renderer 的菜单展示判定，app-host 的其它服务和调用链保持原样。
  assert.match(source, /function isMenuEnabled\(\)\{return false\}/);
  assert.match(source, /function isSecondaryMenuEnabled\(\)\{return false\}/);
  assert.match(source, /services\.applicationMenu\.getSnapshot\(\)/);
  assert.match(source, /capabilitySnapshot=services\.applicationMenu!=null/);
  assert.doesNotMatch(source, /isWindows\(\)&&services\.applicationMenu!=null/);
});

test("large official renderer patches complete off the gateway event loop", async (t) => {
  const webviewDir = makeOfficialWebviewDir(t);
  const assetsDir = path.join(webviewDir, "assets");
  fs.mkdirSync(assetsDir, { recursive: true });
  const assetName = "app-initial-large-menu-test.js";
  fs.writeFileSync(
    path.join(assetsDir, assetName),
    `${"/* padding */".repeat(48 * 1024)}function isMenuEnabled(){return isWindows()&&services.applicationMenu!=null}`
  );
  const service = createService(webviewDir);
  const reqPath = `${PATCHED_OFFICIAL_PREFIX}assets/${assetName}`;
  const response = makeResponseRecorder();

  const completion = service.serveFile(
    { headers: { host: "localhost:3737" } },
    response,
    service.staticFile(reqPath),
    200,
    reqPath
  );
  // 大资源在当前调用栈内既不做文本解码，也不提前写响应。
  assert.equal(response.status, 0);
  assert.equal(typeof completion?.then, "function");
  await completion;

  assert.equal(response.status, 200);
  assert.match(response.body.toString("utf8"), /function isMenuEnabled\(\)\{return false\}/);
  assert.deepEqual(service.assetCacheDiagnostics(), {
    bytes: service.assetCacheDiagnostics().bytes,
    compressionRuns: 0,
    entries: 1,
    hits: 0,
    maxBytes: service.assetCacheDiagnostics().maxBytes,
    misses: 1,
    notModified: 0,
    patchRuns: 1,
  });
});

test("patched official renderer prioritizes first-screen reads without delaying capability initialization", async (t) => {
  const webviewDir = makeOfficialWebviewDir(t);
  const assetsDir = path.join(webviewDir, "assets");
  fs.mkdirSync(assetsDir, { recursive: true });
  const assetName = "app-initial-request-scheduler-test.js";
  fs.writeFileSync(
    path.join(assetsDir, assetName),
    [
      "const criticalMethods=new Set([`thread/approveGuardianDeniedAction`,`thread/start`,`turn/interrupt`,`turn/start`,`turn/steer`]);",
      "const backgroundMethods=new Set([`app/list`,`collaborationMode/list`,`config/read`,`configRequirements/read`,`experimentalFeature/list`,`hooks/list`,`mcpServerStatus/list`,`model/list`,`permissionProfile/list`,`plugin/list`,`skills/list`]);",
      "class RequestClient{",
      "dispatchMessage=()=>{};requestPromises=new Map;inFlightRequests=new Set;pendingConfigReadRequests=new Map;queuedRequests=[];",
      "constructor(){this.calls=[];this.pending=[]}",
      "sendConfigReadRequest(params,options){return this.enqueueRequest(`config/read`,params,options)}",
      "enqueueRequest(method,params,options){this.calls.push({method,params,options});return new Promise((resolve,reject)=>this.pending.push({resolve,reject}))}",
      "async sendRequest(e,t,n){if(this.dispatchMessage==null)throw Error(`AppServerRequestClient is missing a message dispatcher`);return e===`config/read`?this.sendConfigReadRequest(t,n):this.enqueueRequest(e,t,n)}",
      "}",
    ].join("")
  );
  const service = createService(webviewDir);
  const patched = serveOfficialAsset(
    service,
    `${PATCHED_OFFICIAL_PREFIX}assets/${assetName}`,
    "localhost:3737"
  );
  const { RequestClient, backgroundMethods, criticalMethods } = new Function(
    `${patched};return {RequestClient,backgroundMethods,criticalMethods};`
  )();

  // 插件、MCP 与 Apps 的首个请求必须立即发出；只有参数相同且尚未完成的重复请求共享 Promise。
  for (const method of ["plugin/list", "mcpServerStatus/list", "app/list"]) {
    const client = new RequestClient();
    const params = { cursor: null, limit: 100 };
    const options = { priority: "background", source: method };
    const first = client.sendRequest(method, params, options);
    const duplicate = client.sendRequest(method, params, options);
    assert.equal(client.calls.length, 1);
    client.pending[0].resolve({ method });
    assert.deepEqual(await first, { method });
    assert.deepEqual(await duplicate, { method });

    // 完成后映射立即删除；下一次请求必须重新访问 App Server，不能命中结果缓存。
    const next = client.sendRequest(method, params, options);
    assert.equal(client.calls.length, 2);
    client.pending[1].resolve({ method, refreshed: true });
    assert.deepEqual(await next, { method, refreshed: true });
  }

  // 首屏读取升为 interactive，但不占用 turn/start 的 critical 通道；能力清单保持 background。
  for (const method of ["config/read", "model/list", "thread/list", "thread/read"]) {
    assert.equal(backgroundMethods.has(method), false);
    assert.equal(criticalMethods.has(method), false);
  }
  assert.equal(criticalMethods.has("turn/start"), true);
  assert.equal(backgroundMethods.has("plugin/list"), true);
  assert.equal(backgroundMethods.has("mcpServerStatus/list"), true);
  assert.equal(backgroundMethods.has("app/list"), true);
});

test("patched request scheduler supports the current expanded official background method set", (t) => {
  const webviewDir = makeOfficialWebviewDir(t);
  const assetsDir = path.join(webviewDir, "assets");
  fs.mkdirSync(assetsDir, { recursive: true });
  const assetName = "app-initial-current-request-scheduler-test.js";
  fs.writeFileSync(
    path.join(assetsDir, assetName),
    [
      "const backgroundMethods=new Set([`app/installed`,`app/list`,`app/read`,`collaborationMode/list`,`config/read`,`configRequirements/read`,`experimentalFeature/list`,`hooks/list`,`mcpServerStatus/list`,`model/list`,`permissionProfile/list`,`plugin/list`,`skills/list`]);",
      "class RequestClient{",
      "dispatchMessage=()=>{};pendingConfigReadRequests=new Map;queuedRequests=[];",
      "sendConfigReadRequest(params,options){return this.enqueueRequest(`config/read`,params,options)}",
      "enqueueRequest(method,params,options){return Promise.resolve({method,params,options})}",
      "async sendRequest(e,t,n){if(this.dispatchMessage==null)throw Error(`AppServerRequestClient is missing a message dispatcher`);return e===`config/read`?this.sendConfigReadRequest(t,n):this.enqueueRequest(e,t,n)}",
      "}",
    ].join("")
  );
  const patched = serveOfficialAsset(
    createService(webviewDir),
    `${PATCHED_OFFICIAL_PREFIX}assets/${assetName}`,
    "localhost:3737"
  );

  // 当前官方版本增加了 app/installed 与 app/read，仍应完整命中而不是静默跳过整段优化。
  assert.match(patched, /opencodexInFlightCapabilityReads=new Map/);
  assert.match(patched, /trace:n\?\.trace===void 0\?`auto`:n\.trace/);
  assert.match(patched, /widget:n\?\.widget\?\?null/);
  assert.match(
    patched,
    /backgroundMethods=new Set\(\[`app\/list`,`hooks\/list`,`mcpServerStatus\/list`,`plugin\/list`,`skills\/list`\]\)/
  );
  assert.doesNotMatch(patched, /backgroundMethods=new Set\(\[`app\/installed`/);
});

test("remote renderer defers plugin summary image bytes until an image mounts", async (t) => {
  const webviewDir = makeOfficialWebviewDir(t);
  const assetsDir = path.join(webviewDir, "assets");
  fs.mkdirSync(assetsDir, { recursive: true });
  const assetName = "plugin-summary-image-test.js";
  fs.writeFileSync(
    path.join(assetsDir, assetName),
    [
      "const protocol=`read-file-binary`;",
      "async function loadPluginImages(o,e,n){",
      "return Promise.all([BI(o.composerIconPath,e,n),BI(o.logoPath,e,n),BI(o.logoDarkPath,e,n)])",
      "}",
    ].join("")
  );
  const service = createService(webviewDir);
  const reqPath = `${PATCHED_OFFICIAL_PREFIX}assets/${assetName}`;
  const remote = serveOfficialAsset(service, reqPath, "192.168.1.25:3737");
  const loopback = serveOfficialAsset(service, reqPath, "localhost:3737");

  assert.match(remote, /window\.__opencodexPluginImageUrl\?\.\(o\.composerIconPath,e\)\?\?BI/);
  assert.match(remote, /window\.__opencodexPluginImageUrl\?\.\(o\.logoPath,e\)\?\?BI/);
  assert.match(remote, /window\.__opencodexPluginImageUrl\?\.\(o\.logoDarkPath,e\)\?\?BI/);
  assert.doesNotMatch(loopback, /__opencodexPluginImageUrl/);

  let inlineReadCount = 0;
  const loadPluginImages = new Function(
    "window",
    "BI",
    `${remote};return loadPluginImages;`
  )(
    {
      __opencodexPluginImageUrl(value, hostId) {
        return hostId === "local" && value.startsWith("/") ? `/api/plugin-image?path=${value}` : null;
      },
    },
    async (value) => {
      inlineReadCount += 1;
      return `data:image/png;base64,${value}`;
    }
  );
  assert.deepEqual(
    await loadPluginImages(
      { composerIconPath: "/icons/composer.png", logoPath: "/icons/light.png", logoDarkPath: "/icons/dark.png" },
      "local",
      {}
    ),
    [
      "/api/plugin-image?path=/icons/composer.png",
      "/api/plugin-image?path=/icons/light.png",
      "/api/plugin-image?path=/icons/dark.png",
    ]
  );
  assert.equal(inlineReadCount, 0);
});

test("bridge reconnects active app-host ports after websocket hello", () => {
  const bridge = fs.readFileSync(BRIDGE_POLYFILL, "utf-8");

  assert.match(bridge, /state\.pending\.unshift\(connectPayload\)/);
  assert.match(bridge, /state\.pendingChars \+= appHostPendingPayloadChars\(connectPayload\)/);
  assert.match(bridge, /for \(const state of appHostPortRelays\.values\(\)\) state\.connected = false/);
  // 新旧 WS close 事件可能交错；在途 IPC 必须按实际发送 socket 隔离清理。
  assert.match(bridge, /if \(socket && pending\.socket !== socket\) continue/);
  assert.match(bridge, /socket: requestSocket/);
  assert.match(bridge, /rejectPendingGatewayIpc\(new Error\("Gateway WebSocket disconnected"\), socket\)/);
  // WS 瞬时断线只能让升级前已允许重试的安全读取回退 HTTP，写操作不得重复提交。
  assert.match(bridge, /clientDiagnostic\("ipc-ws-fallback"/);
  assert.match(bridge, /retryDelays\.length === 1 \|\| !isTransientGatewayFetchError\(error\)/);
});

test("injects the app-host codec before the bridge provider", (t) => {
  const webviewDir = makeOfficialWebviewDir(t);
  const service = createService(webviewDir);
  const runtime = runtimeBootstrapSource(service);
  const codecIndex = runtime.indexOf("__OpenCodexAppHostMessageCodec");
  const bridgeIndex = runtime.indexOf("__codexBridgePolyfillInstalled");

  assert.notEqual(codecIndex, -1);
  assert.notEqual(bridgeIndex, -1);
  assert.equal(codecIndex < bridgeIndex, true);
  assert.equal(service.staticFile("/codex-app-host-message-codec.js"), APP_HOST_MESSAGE_CODEC);
});

test("bridge encodes and decodes structured app-host message data", () => {
  const bridge = fs.readFileSync(BRIDGE_POLYFILL, "utf-8");
  const harness = createAppHostWireHarness(bridge);
  const wireData = harness.encodeAppHostMessageData({ id: 7n, sentAt: new Date(1234) });
  const restored = harness.decodeAppHostMessageData(JSON.parse(JSON.stringify(wireData)));

  assert.equal(wireData.dataEncoding, "opencodex-structured-clone-v1");
  assert.equal(restored.id, 7n);
  assert.equal(restored.sentAt.getTime(), 1234);
});

test("bridge forwards structured and legacy app-host frames with compatible close semantics", () => {
  const bridge = fs.readFileSync(BRIDGE_POLYFILL, "utf-8");
  const codec = require(APP_HOST_MESSAGE_CODEC);

  function connectPort(harness) {
    harness.installAppHostMessagePortBridge();
    harness.windowListeners.get("message")({
      source: harness.w,
      data: { type: "connect-app-host", port: harness.fakePort },
      ports: [harness.fakePort],
    });
    assert.equal(harness.fakePort.started, true);
    return harness.portListeners.get("message");
  }

  const structuredHarness = createAppHostBridgeBehaviorHarness(bridge);
  const structuredMessage = connectPort(structuredHarness);
  structuredMessage({ data: { id: 7n, sentAt: new Date(1234) } });
  const structuredFrames = structuredHarness.wsMessages.filter((message) => message.type === "app-host-port-message");
  assert.equal(structuredFrames.length, 1);
  assert.equal(structuredFrames[0].dataEncoding, codec.encoding);
  assert.deepEqual(codec.decodeMessageData(structuredFrames[0]), { id: 7n, sentAt: new Date(1234) });

  structuredMessage({ data: "legacy-json-rpc" });
  const legacyFrames = structuredHarness.wsMessages.filter((message) => message.type === "app-host-port-message");
  assert.equal(legacyFrames[1].data, "legacy-json-rpc");
  assert.equal(Object.prototype.hasOwnProperty.call(legacyFrames[1], "dataEncoding"), false);

  const undefinedHarness = createAppHostBridgeBehaviorHarness(bridge);
  const undefinedMessage = connectPort(undefinedHarness);
  undefinedMessage({ data: undefined });
  const undefinedFrames = undefinedHarness.wsMessages.filter((message) => message.type === "app-host-port-message");
  assert.equal(undefinedFrames.length, 1);
  assert.equal(codec.decodeMessageData(undefinedFrames[0]), undefined);
  assert.equal(undefinedHarness.fakePort.closed, true);

  const nullHarness = createAppHostBridgeBehaviorHarness(bridge);
  const nullMessage = connectPort(nullHarness);
  nullMessage({ data: null });
  const nullFrames = nullHarness.wsMessages.filter((message) => message.type === "app-host-port-message");
  assert.deepEqual(nullFrames.map((message) => message.data), [null]);
  assert.equal(nullHarness.fakePort.closed, true);
});

test("bridge closes malformed app-host frames and retains offline terminal data", () => {
  const bridge = fs.readFileSync(BRIDGE_POLYFILL, "utf-8");
  const codec = require(APP_HOST_MESSAGE_CODEC);

  function connectedHarness(options) {
    const harness = createAppHostBridgeBehaviorHarness(bridge, options);
    harness.installAppHostMessagePortBridge();
    harness.windowListeners.get("message")({
      source: harness.w,
      data: { type: "connect-app-host", port: harness.fakePort },
      ports: [harness.fakePort],
    });
    return { harness, state: [...harness.appHostPortRelays.values()][0] };
  }

  const malformed = connectedHarness();
  malformed.harness.handleAppHostGatewayMessage({
    type: "app-host-port-message",
    portId: malformed.state.portId,
    dataEncoding: codec.encoding,
    data: ["unknown"],
  });
  assert.equal(malformed.state.closed, true);
  assert.equal(malformed.harness.fakePort.closed, true);
  assert.equal(
    malformed.harness.wsMessages.filter((message) => message.type === "app-host-port-message" && message.data === null).length,
    1
  );

  const offline = connectedHarness({ wsReady: false });
  offline.harness.portListeners.get("message")({ data: undefined });
  assert.equal(offline.state.closed, false);
  assert.equal(offline.state.closing, true);
  assert.equal(offline.harness.fakePort.closed, true);
  assert.equal(offline.state.pending.some((payload) => payload.dataEncoding === codec.encoding), true);
  assert.equal(offline.harness.wsMessages.length, 0);
});

test("bridge resolves window focus from the browser instead of the hidden Electron proxy", () => {
  const bridge = fs.readFileSync(BRIDGE_POLYFILL, "utf-8");
  const { context, documentListeners, emitted, focusBridge, setFocus, windowListeners } =
    createBrowserFocusHarness(bridge);

  const effectiveChannel = focusBridge.effectiveGatewayMessageChannel(MESSAGE_FOR_VIEW_CHANNEL, {
    type: WINDOW_FOCUS_CHANGED_MESSAGE,
    isFocused: false,
  });
  assert.equal(effectiveChannel, WINDOW_FOCUS_CHANGED_MESSAGE);

  const electronPayload = { isFocused: false, source: "hidden-electron-window" };
  const browserPayload = focusBridge.browserRendererMessagePayload(effectiveChannel, electronPayload);
  assert.equal(browserPayload.isFocused, true);
  assert.equal(browserPayload.source, "hidden-electron-window");
  assert.notEqual(browserPayload, electronPayload);

  const unrelatedPayload = { value: 1 };
  assert.equal(focusBridge.browserRendererMessagePayload("unrelated-message", unrelatedPayload), unrelatedPayload);

  setFocus(false);
  assert.equal(focusBridge.browserRendererMessagePayload(WINDOW_FOCUS_CHANGED_MESSAGE, null).isFocused, false);
  setFocus(true);
  context.document.visibilityState = "hidden";
  assert.equal(focusBridge.browserRendererMessagePayload(WINDOW_FOCUS_CHANGED_MESSAGE, {}).isFocused, false);

  context.document.visibilityState = "visible";
  focusBridge.installBrowserWindowFocusBridge();
  assert.deepEqual([...windowListeners.keys()], ["focus", "blur"]);
  assert.deepEqual([...documentListeners.keys()], ["visibilitychange"]);
  windowListeners.get("focus")();
  assert.equal(emitted.at(-1).channel, WINDOW_FOCUS_CHANGED_MESSAGE);
  assert.equal(emitted.at(-1).payload.isFocused, true);
  setFocus(false);
  windowListeners.get("blur")();
  assert.equal(emitted.at(-1).payload.isFocused, false);
  documentListeners.get("visibilitychange")();
  assert.equal(emitted.at(-1).payload.isFocused, false);

  // 保留一条 wiring 断言，确保 WebSocket 入站数据实际经过已执行验证的 normalizer。
  assert.match(
    bridge,
    /browserRendererMessagePayload\(\s*effectiveChannel,\s*authoritativeMessagePayload\s*\)/
  );
  assert.match(bridge, /dispatch\(effectiveChannel, rendererMessagePayload\)/);
  assert.match(bridge, /emitWindowMessage\(effectiveChannel, rendererMessagePayload\)/);
});

test("patched official renderer CSP allows the injected PWA manifest", (t) => {
  const webviewDir = makeTempDir(t);
  fs.writeFileSync(
    path.join(webviewDir, "index.html"),
    [
      "<!doctype html>",
      '<html><head><meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; worker-src &#39;self&#39; blob:; script-src &#39;self&#39; &#39;wasm-unsafe-eval&#39;;">',
      "<title>Codex</title></head><body></body></html>",
    ].join("")
  );

  const html = createService(webviewDir).createRendererResponse();

  assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest" crossorigin="use-credentials">/);
  assert.match(html, /manifest-src &#39;self&#39;;/);
  assert.match(html, /&#39;wasm-unsafe-eval&#39; &#39;unsafe-eval&#39;/);
});

test("patched official renderer removes eager font preloads but preserves other preloads", (t) => {
  const webviewDir = makeTempDir(t);
  fs.writeFileSync(
    path.join(webviewDir, "index.html"),
    [
      "<!doctype html>",
      '<html><head><link rel="preload" href="./assets/font.woff2" as="font" type="font/woff2">',
      '<link rel="preload" href="./assets/app.js" as="script">',
      '<link rel="preload" href="./assets/other.woff2" as="font" crossorigin="use-credentials">',
      "<title>Codex</title></head><body></body></html>",
    ].join("")
  );

  const html = createService(webviewDir).createRendererResponse();

  assert.doesNotMatch(html, /<link[^>]+as="font"/);
  assert.ok(
    html.includes(`<link rel="preload" href="${PATCHED_OFFICIAL_PREFIX}assets/app.js" as="script">`)
  );
});

test("patched official renderer does not invent an eager medium-font request", (t) => {
  const webviewDir = makeOfficialWebviewDir(t);
  const assetsDir = path.join(webviewDir, "assets");
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.writeFileSync(path.join(assetsDir, "OpenAISans-Medium-test.woff2"), "font");

  const html = createService(webviewDir).createRendererResponse();

  assert.doesNotMatch(html, /OpenAISans-Medium-test\.woff2/);
});

test("patched official renderer CSP does not duplicate an existing manifest-src", (t) => {
  const webviewDir = makeTempDir(t);
  fs.writeFileSync(
    path.join(webviewDir, "index.html"),
    [
      "<!doctype html>",
      '<html><head><meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; manifest-src &#39;self&#39;; script-src &#39;self&#39; &#39;wasm-unsafe-eval&#39;;">',
      "<title>Codex</title></head><body></body></html>",
    ].join("")
  );

  const html = createService(webviewDir).createRendererResponse();
  const manifestDirectiveCount = html.match(/\bmanifest-src\b/g).length;

  assert.equal(manifestDirectiveCount, 1);
});

test("patched official renderer stops the loading shimmer after initial feedback", (t) => {
  const webviewDir = makeOfficialWebviewDir(t);
  const html = createService(webviewDir).createRendererResponse();

  // 官方 Logo 的背景位置动画保留三轮视觉反馈，但不能在启动受阻时永久以刷新率驱动样式重算。
  assert.match(html, /id="codex-web-loading-shimmer-power-guard"/);
  assert.match(
    html,
    /#root > \.relative\.size-full \[aria-hidden="true"\]\.size-14 > \[class\*="_Overlay_"\]\[style\*="mask-image"\] \{ animation-iteration-count: 3 !important; \}/
  );
});

test("injects remote file actions after the bridge polyfill", (t) => {
  const webviewDir = makeOfficialWebviewDir(t);
  const service = createStaticAssetService({
    getI18nSnapshot: () => ({ locale: "zh-CN", messages: {} }),
    getOfficialBundle: () => ({ webviewDir }),
  });

  const html = service.createRendererResponse();
  const runtime = runtimeBootstrapSource(service);
  const bridgeIndex = runtime.indexOf("__codexBridgePolyfillInstalled");
  const remoteFileIndex = runtime.indexOf("__codexRemoteFileActionsInstalled");
  assert.match(html, new RegExp(OPENCODEX_RUNTIME_BOOTSTRAP_PATH.replace(".", "\\.")));
  assert.notEqual(bridgeIndex, -1);
  assert.notEqual(remoteFileIndex, -1);
  assert.equal(remoteFileIndex > bridgeIndex, true);
  assert.equal(
    service.staticFile("/codex-remote-file-actions.js"),
    path.join(INTERNAL_PROVIDER_DIR, "codex-remote-file-actions.js")
  );
});

test("injects smart scheduling settings and summary into the authenticated renderer", (t) => {
  const webviewDir = makeOfficialWebviewDir(t);
  const service = createService(webviewDir);
  const html = service.createRendererResponse();
  const runtime = runtimeBootstrapSource(service);

  assert.match(html, /codex-smart-model-router-settings\.css/);
  assert.match(html, /codex-smart-scheduling-summary\.css/);
  assert.match(runtime, /__OpenCodexSmartSchedulingInjectionHealthInstalled/);
  assert.match(runtime, /__OpenCodexSmartModelRouterSettingsInstalled/);
  assert.match(runtime, /__OpenCodexSmartModelRouterComposerInstalled/);
  assert.match(runtime, /__OpenCodexSmartSchedulingSummaryInstalled/);
  assert.match(runtime, /gatewayPluginConfig/);
  assert.match(runtime, /opencodex_gateway_plugin_sync_pending=1/);
  assert.ok(runtime.indexOf("gatewayPluginConfig") < runtime.indexOf("__OpenCodexSmartSchedulingInjectionHealthInstalled"));
  assert.equal(
    runtime.indexOf("__OpenCodexSmartSchedulingInjectionHealthInstalled") < runtime.indexOf("__OpenCodexSmartModelRouterSettingsInstalled"),
    true
  );
  assert.equal(
    service.staticFile("/codex-smart-scheduling-injection-health.js"),
    SMART_SCHEDULING_INJECTION_HEALTH
  );
  assert.equal(
    service.staticFile("/codex-smart-model-router-settings.js"),
    path.join(INTERNAL_PROVIDER_DIR, "codex-smart-model-router-settings.js")
  );
  assert.equal(
    service.staticFile("/codex-smart-scheduling-summary.js"),
    path.join(INTERNAL_PROVIDER_DIR, "codex-smart-scheduling-summary.js")
  );
});

test("pre-renders escaped recent threads and preloads official startup modules", (t) => {
  const webviewDir = makeTempDir(t);
  fs.mkdirSync(path.join(webviewDir, "assets"), { recursive: true });
  fs.writeFileSync(path.join(webviewDir, "assets", "zh-CN-Locale01.js"), "export default {};");
  fs.writeFileSync(path.join(webviewDir, "assets", "thread-app-shell-chrome-Wrapper01.js"), "export {};");
  fs.writeFileSync(
    path.join(webviewDir, "assets", "thread-app-shell-chrome-Implementation01.js"),
    `export default "${"implementation".repeat(20)}";`
  );
  fs.writeFileSync(path.join(webviewDir, "assets", "home-ambient-suggestions-content-Home01.js"), "export {};");
  fs.writeFileSync(path.join(webviewDir, "assets", "codex-home-announcements-Wrapper01.js"), "export {};");
  fs.writeFileSync(
    path.join(webviewDir, "index.html"),
    [
      "<html><head>",
      '<script type="module" src="./assets/index-test.js"></script>',
      '<link rel="modulepreload" href="./assets/app-initial-test.js">',
      '<link rel="stylesheet" crossorigin href="./assets/app-initial-test.css">',
      "<title>Codex</title></head><body><div id=\"root\"></div></body></html>",
    ].join("")
  );
  const html = createStaticAssetService({
    getI18nSnapshot: () => ({ locale: "zh-CN", messages: {} }),
    getOfficialBundle: () => ({ webviewDir }),
  }).createRendererResponse({
    sidebarPreview: {
      threads: [{ id: 'thread-\"<unsafe>', title: '<img src=x onerror="bad">' }],
    },
  });

  assert.match(html, /data-opencodex-sidebar-preview-ready/);
  assert.match(html, /&lt;img src=x onerror=&quot;bad&quot;&gt;/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, new RegExp(`${PATCHED_OFFICIAL_PREFIX}assets/index-test\\.js`));
  assert.match(html, new RegExp(`${PATCHED_OFFICIAL_PREFIX}assets/app-initial-test\\.js`));
  assert.match(html, new RegExp(`${PATCHED_OFFICIAL_PREFIX}assets/app-initial-test\\.css`));
  // preload 必须继承正式样式的 CORS 模式，否则浏览器会把同一份首屏 CSS 下载两次。
  assert.match(
    html,
    new RegExp(
      `link rel="preload" as="style" crossorigin href="${PATCHED_OFFICIAL_PREFIX}assets/app-initial-test\\.css"`
    )
  );
  assert.match(
    html,
    new RegExp(`meta name="opencodex-late-modulepreload" content="${PATCHED_OFFICIAL_PREFIX}assets/zh-CN-Locale01\\.js"`)
  );
  assert.match(html, new RegExp(`${PATCHED_OFFICIAL_PREFIX}assets/thread-app-shell-chrome-Wrapper01\\.js`));
  assert.doesNotMatch(html, /thread-app-shell-chrome-Implementation01\.js/);
  assert.match(html, new RegExp(`${PATCHED_OFFICIAL_PREFIX}assets/home-ambient-suggestions-content-Home01\\.js`));
  assert.match(html, new RegExp(`${PATCHED_OFFICIAL_PREFIX}assets/codex-home-announcements-Wrapper01\\.js`));
  assert.doesNotMatch(
    html,
    new RegExp(`link rel="modulepreload"[^>]+${PATCHED_OFFICIAL_PREFIX}assets/zh-CN-Locale01\\.js`)
  );
  assert.ok(html.indexOf('rel="modulepreload"') < html.indexOf('/codex-web-config.js'));
});

test("prewarms local and remote main bundle Brotli and gzip representations before first navigation", async (t) => {
  const webviewDir = makeOfficialWebviewDir(t);
  const assetsDir = path.join(webviewDir, "assets");
  fs.mkdirSync(assetsDir, { recursive: true });
  const assetName = "app-initial-Prewarm01.js";
  fs.writeFileSync(path.join(assetsDir, assetName), `export default "${"x".repeat(4096)}";`);
  const service = createService(webviewDir);

  await service.prewarmRendererAssets();
  const beforeRequest = service.assetCacheDiagnostics();
  const response = await serveOfficialAssetResponseAsync(
    service,
    `${PATCHED_OFFICIAL_PREFIX}assets/${assetName}`,
    "127.0.0.1:3737",
    { "accept-encoding": "br,gzip" }
  );

  assert.equal(beforeRequest.entries, 2);
  assert.equal(beforeRequest.compressionRuns, 4);
  assert.equal(response.status, 200);
  assert.equal(response.headers["content-encoding"], "br");
  assert.equal(service.assetCacheDiagnostics().compressionRuns, 4);
  assert.equal(service.assetCacheDiagnostics().hits, 1);
});

test("smart scheduling hides placeholder effort only while the composer model is Auto", () => {
  const source = fs.readFileSync(SMART_SCHEDULING_COMPOSER, "utf-8");

  // 适配器依赖官方模型触发器和模型行标记，并在切回具体模型时主动移除自己的状态。
  assert.match(source, /data-codex-intelligence-trigger/);
  assert.match(source, /data-model-picker-model-row/);
  assert.match(source, /removeAttribute\("data-opencodex-auto-model"\)/);
  assert.match(source, /opencodexAutoEffortItem/);
  assert.match(source, /get autoSelected\(\)/);
});

test("smart scheduling reuses Codex picker styling without repeated model identities", () => {
  const source = fs.readFileSync(SMART_SCHEDULING_SETTINGS, "utf-8");

  // 锁定官方选择器样式复用和账户图标来源，避免后续回退成原生 select 或重复拼接名称与 ID。
  assert.match(source, /NATIVE_PICKER_TRIGGER_FALLBACK_CLASS/);
  assert.match(source, /aria-haspopup\", \"menu/);
  assert.match(source, /normalizedModelIdentity/);
  assert.match(source, /opencodexIconSource = "account"/);
  assert.match(source, /data-settings-panel-slug=\"personalization\"/);
  assert.doesNotMatch(source, /accountNavLabel/);
  assert.doesNotMatch(source, /createElement\("select"/);
});

test("smart scheduling injection health reports every renderer injection point", () => {
  const health = fs.readFileSync(SMART_SCHEDULING_INJECTION_HEALTH, "utf-8");
  const settings = fs.readFileSync(SMART_SCHEDULING_SETTINGS, "utf-8");
  const composer = fs.readFileSync(SMART_SCHEDULING_COMPOSER, "utf-8");
  const summary = fs.readFileSync(SMART_SCHEDULING_SUMMARY, "utf-8");

  assert.match(health, /api\/opencodex\/model-router\/injections/);
  assert.match(health, /data-opencodex-smart-scheduling-injection-health/);
  assert.match(settings, /report\("settings-page"\)/);
  assert.match(composer, /report\("composer-adapter"\)/);
  assert.match(summary, /report\("summary-adapter"\)/);
});

test("smart scheduling settings localize and render dynamic tier controls", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(SMART_SCHEDULING_PLUGIN_DIR, "plugin.json"), "utf-8"));
  const zh = JSON.parse(fs.readFileSync(path.join(SMART_SCHEDULING_PLUGIN_DIR, "i18.zh.json"), "utf-8"));
  const en = JSON.parse(fs.readFileSync(path.join(SMART_SCHEDULING_PLUGIN_DIR, "i18.en.json"), "utf-8"));

  // 档位标题和字段名分别翻译，字段不再重复档位名称；auto 保持协议中的小写形式。
  assert.equal(zh["plugin.smartModelRouter.group.balanced"], "均衡");
  assert.equal(en["plugin.smartModelRouter.group.balanced"], "Balanced");
  assert.equal(zh["plugin.smartModelRouter.setting.model"], "模型");
  assert.equal(en["plugin.smartModelRouter.setting.effort"], "Reasoning effort");
  assert.equal(zh["plugin.smartModelRouter.tiers.add"], "添加档位");
  assert.equal(en["plugin.smartModelRouter.tier.prompt"], "Classification prompt");
  assert.equal(
    zh["plugin.smartModelRouter.settings.description"],
    "智能调度会在模型列表中加入 Auto。选择 Auto 后，系统会根据每轮任务自动选择合适的模型和推理强度，以适应不同使用场景，减少额度消耗和等待时间。"
  );
  assert.match(en["plugin.smartModelRouter.settings.description"], /adds Auto to the model list/);
  assert.match(zh["plugin.smartModelRouter.tiers.description"], /内置档位可调整模型和推理强度/);
  assert.equal(zh["plugin.smartModelRouter.tiers.builtin"], "内置");
  // 认证前插件页必须明确说明选择 Auto 后会同时自动选择模型与推理强度。
  assert.match(zh["plugin.smartModelRouter.desc"], /选择 Auto.*自动选择模型和推理强度/);
  assert.match(en["plugin.smartModelRouter.desc"], /Selecting Auto.*model and reasoning effort/);
  assert.equal(zh["plugin.smartModelRouter.group.display"], "显示");
  assert.equal(zh["plugin.smartModelRouter.summary.title"], "智能调度");
  assert.equal(zh["plugin.smartModelRouter.summary.model"], "模型");
  assert.equal(zh["plugin.smartModelRouter.summary.effort"], "推理强度");
  assert.equal(zh["plugin.smartModelRouter.summary.status"], "调度结果");
  assert.equal(zh["plugin.smartModelRouter.summary.fallback"], "失败回退");
  assert.equal(zh["plugin.smartModelRouter.summary.determining"], "正在判断…");
  assert.equal(
    zh["plugin.smartModelRouter.setting.showRouteInSummary.description"],
    "开启 Auto 后，在任务摘要中持续显示最近一次调度采用的模型和推理强度。"
  );
  assert.equal(en["plugin.smartModelRouter.summary.title"], "Smart scheduling");
  assert.equal(en["plugin.smartModelRouter.summary.model"], "Model");
  assert.equal(en["plugin.smartModelRouter.summary.effort"], "Reasoning effort");
  assert.equal(en["plugin.smartModelRouter.summary.status"], "Scheduling result");
  assert.equal(en["plugin.smartModelRouter.summary.fallback"], "failure");
  assert.equal(en["plugin.smartModelRouter.summary.determining"], "Determining…");
  assert.equal(zh["plugin.smartModelRouter.health.title"], "功能健康");
  assert.equal(zh["plugin.smartModelRouter.health.point.app-server-router"], "路由装饰器");
  assert.equal(zh["plugin.smartModelRouter.health.point.auto-model-catalog"], "模型注入");
  assert.equal(zh["plugin.smartModelRouter.health.point.settings-page"], "智能调度设置注入");
  assert.equal(zh["plugin.smartModelRouter.health.point.composer-adapter"], "适配器注入");
  assert.equal(zh["plugin.smartModelRouter.health.point.summary-adapter"], "摘要适配器注入");
  assert.equal(zh["plugin.smartModelRouter.health.point.route-presentation"], "路由状态展示桥绑定");
  assert.equal(en["plugin.smartModelRouter.health.summary.ok"], "All injection points are healthy");
  const injectionHealthSource = fs.readFileSync(SMART_SCHEDULING_INJECTION_HEALTH, "utf-8");
  assert.doesNotMatch(injectionHealthSource, /health-detail/);
  // 健康标题必须保留在卡片内部，并与其他设置卡片处于同一层级。
  assert.match(injectionHealthSource, /card\.appendChild\(header\)/);
  assert.match(injectionHealthSource, /root\.appendChild\(card\)/);
  assert.equal(manifest.settings.find((setting) => setting.id === "showRouteInSummary").defaultValue, true);
  const historyCountSetting = manifest.settings.find((setting) => setting.id === "classifierHistoryCount");
  assert.equal(historyCountSetting.type, "select");
  assert.equal(historyCountSetting.defaultValue, "3");
  assert.deepEqual(historyCountSetting.options, Array.from({ length: 20 }, (_value, index) => String(index + 1)));
  assert.equal(zh[historyCountSetting.labelKey], "分类参考对话数");
  assert.match(zh[historyCountSetting.descriptionKey], /不包含当前输入/);
  assert.match(en[historyCountSetting.descriptionKey], /excluding the current input/);
  assert.equal(manifest.settings.some((setting) => setting.id === "balancedModel"), false);
  assert.equal(manifest.settings.find((setting) => setting.id === "fallbackModel").labelKey, "plugin.smartModelRouter.setting.model");
  const settingsSource = fs.readFileSync(SMART_SCHEDULING_SETTINGS, "utf-8");
  // 设置页固定文案必须只来自插件语言包，避免脚本重新引入一套中英文 copy 兜底。
  assert.doesNotMatch(settingsSource, /\bconst copy\s*=/);
  assert.doesNotMatch(settingsSource, /\bfallbackCopy\b/);
  assert.match(settingsSource, /function localized\(key\)/);
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
  const sourceMessageKeys = [...settingsSource.matchAll(/localized\("([^"]+)"\)/g)].map((match) => match[1]);
  const manifestMessageKeys = manifest.settings.flatMap((setting) => [setting.labelKey, setting.descriptionKey]).filter(Boolean);
  const tierGroupMessageKeys = ["display", "classifier", "economy", "balanced", "complex", "frontier", "fallback"].map(
    (group) => `plugin.smartModelRouter.group.${group}`
  );
  for (const key of [...new Set([...sourceMessageKeys, ...manifestMessageKeys, ...tierGroupMessageKeys])]) {
    assert.equal(typeof zh[key], "string", `missing Chinese plugin message: ${key}`);
    assert.equal(typeof en[key], "string", `missing English plugin message: ${key}`);
  }
  assert.match(settingsSource, /function addTier\(\)/);
  assert.match(settingsSource, /function deleteTier\(tierId\)/);
  // 内置档位的名称和提示词仍只读，但模型与推理强度不再由前端禁用。
  assert.match(settingsSource, /control\.disabled = tier\.builtin === true/);
  assert.doesNotMatch(settingsSource, /modelControl\.control\.disabled = tier\.builtin === true/);
  assert.doesNotMatch(settingsSource, /effortControl\.control\.disabled = tier\.builtin === true/);
  assert.match(settingsSource, /if \(!tier\.builtin\) \{/);
  assert.match(settingsSource, /body: JSON\.stringify\(\{ expectedRevision: snapshot\.revision, \.\.\.patch \}\)/);
});

test("plugin i18n falls back to Chinese when the current locale omits a key", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencodex-plugin-i18n-fallback-test-"));
  const pluginDir = path.join(root, "only-chinese-plugin");
  const messageKey = "plugin.onlyChinesePlugin.fallback";
  fs.mkdirSync(pluginDir);
  fs.writeFileSync(path.join(pluginDir, "plugin.json"), JSON.stringify({
    id: "example.only-chinese-plugin",
    name: "Only Chinese plugin",
    defaultEnabled: true,
  }));
  fs.writeFileSync(path.join(pluginDir, "i18.zh.json"), JSON.stringify({ [messageKey]: "中文默认文案" }));

  const previousRoots = process.env.OPENCODEX_PLUGIN_DIRS;
  try {
    // 临时外部插件只提供中文语言包，用来验证英文环境会继承中文默认文案。
    process.env.OPENCODEX_PLUGIN_DIRS = root;
    assert.equal(pluginMessagesForLocale("en-US")[messageKey], "中文默认文案");
  } finally {
    if (previousRoots === undefined) delete process.env.OPENCODEX_PLUGIN_DIRS;
    else process.env.OPENCODEX_PLUGIN_DIRS = previousRoots;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("smart scheduling summary follows root-path task context while Auto remains enabled", () => {
  const source = fs.readFileSync(SMART_SCHEDULING_SUMMARY, "utf-8");
  const styles = fs.readFileSync(SMART_SCHEDULING_SUMMARY_CSS, "utf-8");
  const bridge = fs.readFileSync(path.join(INTERNAL_PROVIDER_DIR, "codex-bridge-polyfill.js"), "utf-8");

  // 独立分类复用官方摘要面板结构，所有文案读取插件 i18n，并覆盖三类终止路径。
  assert.match(source, /data-pip-obstacle="thread-summary-panel/);
  assert.match(source, /data-radix-popper-content-wrapper/);
  assert.match(source, /plugin\.smartModelRouter\.summary\.title/);
  assert.match(source, /plugin\.smartModelRouter\.summary\.model/);
  assert.match(source, /plugin\.smartModelRouter\.summary\.effort/);
  assert.match(source, /plugin\.smartModelRouter\.summary\.determining/);
  assert.match(source, /thread-summary-panel-item-label/);
  assert.match(source, /opencodex\/smart-scheduling/);
  assert.match(source, /turn\/started/);
  assert.match(source, /turn\/completed/);
  assert.match(source, /turn\/failed/);
  assert.match(source, /turn\/interrupted/);
  assert.match(source, /VISIBLE_THREAD_METHODS/);
  assert.match(source, /direction === "client"/);
  assert.match(source, /visibleThreadId/);
  assert.match(source, /isAutoTurn/);
  assert.match(source, /PROTOCOL_ENVELOPE_KEYS/);
  assert.match(source, /commitVisibleThread/);
  assert.match(source, /pendingNavigationThreadId/);
  assert.match(source, /handleMutations/);
  assert.match(source, /invalidateHydration/);
  assert.match(source, /pending\?\.pending \|\| autoSelected/);
  assert.match(source, /pendingModelSelections/);
  assert.match(source, /\["selected", "started", "idle"\]/);
  assert.match(source, /turnId: "", pending: false/);
  assert.match(source, /active-route\?threadId=/);
  assert.match(source, /get diagnostics\(\)/);
  assert.doesNotMatch(source, /environmentTitles|findEnvironment/);
  assert.doesNotMatch(source, /rationale/);
  assert.match(bridge, /OpenCodexSmartSchedulingBridgeDiagnostics/);
  assert.match(bridge, /protocolFrames/);
  assert.match(bridge, /handleSmartSchedulingGatewayMessage/);
  assert.match(source, /handleRouteEvent/);
  assert.match(source, /value\.displayName \|\| modelId/);
  assert.match(styles, /max-width: 75% !important/);
  assert.doesNotMatch(styles, /flex: 1 1 auto/);
});

test("inline token usage shares the assistant action group visibility", () => {
  const source = fs.readFileSync(TOKEN_USAGE_INLINE_PLUGIN, "utf-8");
  const functionDeclaration = (name) => sourceFunctionDeclaration(source, name);

  const { insertUsageBadge } = new Function(
    `${functionDeclaration("directChildForInsert")}
     ${functionDeclaration("insertUsageBadge")}
     return { insertUsageBadge };`
  )();
  const element = () => ({
    children: [],
    parentElement: null,
    appendChild(child) {
      child.parentElement = this;
      this.children.push(child);
      return child;
    },
  });
  const row = element();
  const actionGroup = row.appendChild(element());
  const forkWrapper = actionGroup.appendChild(element());
  const forkButton = forkWrapper.appendChild(element());
  const badge = element();

  insertUsageBadge(row, forkButton, badge);

  // badge 与按钮同处 action group，父级 opacity 变化会同时作用到二者。
  assert.equal(badge.parentElement, actionGroup);
  assert.deepEqual(actionGroup.children, [forkWrapper, badge]);
  assert.match(source, /insertUsageBadge\(row, forkButton, badge\);/);
  // 字号和行高必须跟随官方时间戳的 text-xs，图标也同步缩小，不能回退到聊天正文尺寸。
  assert.match(source, /badge\.className = "opencodex-token-usage-inline text-xs";/);
  assert.doesNotMatch(source, /text-size-chat/);
  assert.doesNotMatch(source, /line-height: 1\.25rem/);
  assert.match(source, /height: 0\.75rem;[\s\S]*width: 0\.75rem;/);
});

test("inline token usage retries transient empty results with a bounded queue", () => {
  const source = fs.readFileSync(TOKEN_USAGE_INLINE_PLUGIN, "utf-8");
  const start = source.indexOf("  function createUsageRetryQueue(");
  assert.notEqual(start, -1);
  const bodyStart = source.indexOf(") {", start) + 2;
  let depth = 0;
  let end = -1;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] !== "}") continue;
    depth -= 1;
    if (depth === 0) {
      end = index + 1;
      break;
    }
  }
  assert.notEqual(end, -1);
  const createUsageRetryQueue = new Function(
    `${source.slice(start, end)}; return createUsageRetryQueue;`
  )();
  const timers = new Map();
  const cleared = [];
  const retried = [];
  let timerId = 0;
  const scheduler = {
    setTimeout(callback, delay) {
      const id = ++timerId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) {
      cleared.push(id);
      timers.delete(id);
    },
  };
  const queue = createUsageRetryQueue({
    scheduler,
    delays: [2500, 10000],
    maxEntries: 2,
    canRetry: () => true,
    onRetry(row, ids) { retried.push([row, ids]); },
  });
  const row = {};
  const ids = { key: "thread\0turn" };

  assert.equal(queue.schedule(ids.key, row, ids), true);
  assert.equal(queue.schedule(ids.key, row, ids), false, "同一回复不能并发保留多个重试定时器");
  assert.equal([...timers.values()][0].delay, 2500);
  const firstTimer = timers.get(1);
  timers.delete(1);
  firstTimer.callback();
  assert.deepEqual(retried, [[row, ids]]);
  assert.equal(queue.schedule(ids.key, row, ids), true);
  assert.equal(timers.get(2).delay, 10000);
  queue.cancel(ids.key);
  assert.deepEqual(cleared, [2]);
  assert.equal(timers.size, 0);

  // 空响应、请求异常和页面隐藏都必须接入同一个有界清理流程。
  assert.match(source, /diagnostics\.nullResponses \+= 1;\s*scheduleUsageRetry\(row, ids\);/);
  assert.match(source, /lastError = error[\s\S]*scheduleUsageRetry\(row, ids\);/);
  assert.match(source, /usageRetries\?\.clear\(\);\s*\/\/ capability 在零消费者时会清缓存/);
  assert.match(source, /intersectingRows\.delete\(row\);\s*usageRetries\?\.cancelRow\(row\);/);
  assert.match(source, /const USAGE_RETRY_DELAYS_MS = Object\.freeze\(\[2500, 10 \* 1000, 60 \* 1000\]\)/);
});

test("inline token usage resolves current official history and thread keys", () => {
  const source = fs.readFileSync(TOKEN_USAGE_INLINE_PLUGIN, "utf-8");

  function functionDeclaration(name) {
    const start = source.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `missing ${name}`);
    const bodyStart = source.indexOf("{", start);
    let depth = 0;
    for (let index = bodyStart; index < source.length; index += 1) {
      if (source[index] === "{") depth += 1;
      if (source[index] !== "}") continue;
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
    throw new Error(`unterminated ${name}`);
  }

  const threadId = "01a055d3-f290-7cf3-8076-5bfff5c23249";
  const turnId = "01a05628-ec86-7e91-b107-a8051613816e";
  const activeThread = {
    getAttribute(name) {
      return name === "data-app-action-sidebar-thread-id" ? `local:${threadId}` : null;
    },
  };
  const document = {
    querySelector(selector) {
      assert.equal(
        selector,
        '[data-app-action-sidebar-thread-row][data-app-action-sidebar-thread-active="true"]'
      );
      return activeThread;
    },
  };
  const w = { location: { pathname: "/" } };
  const { idsForElement } = new Function(
    "w",
    "document",
    `const HISTORY_TURN_KEY_PREFIX = "history-content:turn:";
     const LOCAL_THREAD_KEY_PREFIX = "local:";
     ${functionDeclaration("decodePathSegment")}
     ${functionDeclaration("currentThreadId")}
     ${functionDeclaration("turnIdFromSearchKey")}
     ${functionDeclaration("idsForElement")}
     return { idsForElement };`
  )(w, document);
  const turnElement = {
    getAttribute(name) {
      if (name === "data-content-search-turn-key") return `history-content:turn:${turnId}`;
      return null;
    },
  };
  const element = {
    closest(selector) {
      if (selector === "[data-content-search-turn-key]") return turnElement;
      return null;
    },
  };

  assert.deepEqual(idsForElement(element), {
    key: `${threadId}\0${turnId}`,
    threadId,
    turnId,
  });

  const legacyThreadId = "01a01899-beec-7513-8602-78156664392a";
  const legacyTurnId = "01a01922-0ee2-7820-8425-728f2a9d9a3c";
  w.location.pathname = `/local/${legacyThreadId}`;
  const legacyTurnElement = {
    getAttribute(name) {
      return name === "data-turn-key" ? legacyTurnId : null;
    },
  };
  const legacyElement = {
    closest(selector) {
      return selector === "[data-turn-key]" ? legacyTurnElement : null;
    },
  };
  // 旧版原始 ID 与显式路由必须保持原有行为，不能被新版前缀适配改写。
  assert.deepEqual(idsForElement(legacyElement), {
    key: `${legacyThreadId}\0${legacyTurnId}`,
    threadId: legacyThreadId,
    turnId: legacyTurnId,
  });
});

test("inline token usage reports a hit only after a connected badge is rendered", () => {
  const source = fs.readFileSync(TOKEN_USAGE_INLINE_PLUGIN, "utf-8");
  const activationStart = source.indexOf("    activate(context) {");
  const observationStart = source.indexOf("      const observedRows =", activationStart);
  const renderStart = source.indexOf("      const renderUsage =", observationStart);
  const requestStart = source.indexOf("      const requestUsageForRow =", renderStart);
  assert.notEqual(activationStart, -1);
  assert.notEqual(observationStart, -1);
  assert.notEqual(renderStart, -1);
  assert.notEqual(requestStart, -1);

  const activation = source.slice(activationStart, observationStart);
  const render = source.slice(renderStart, requestStart);
  assert.doesNotMatch(activation, /modificationEffects\?\.primary\?\.emit/);
  assert.doesNotMatch(activation, /OpenCodexRuntimeCompatibility/);
  assert.match(
    render,
    /renderUsageContent\(badge, usage\);[\s\S]*if \(!badge\.isConnected\) return;[\s\S]*modificationEffects\?\.primary\?\.emit\(\)/
  );
});

test("web shell exposes only the smart router gateway switch before authentication", () => {
  const html = fs.readFileSync(WEB_SHELL_INDEX, "utf-8");

  assert.match(html, /plugin\.feature === "smart-model-router"/);
  assert.match(html, /opencodex-gateway-plugin-switches\.js/);
  assert.match(html, /gatewayPluginSwitches\?\.sync/);
});

test("plugin loader registers manifest-only plugins without inventing an index script", (t) => {
  const webviewDir = makeOfficialWebviewDir(t);
  const service = createService(webviewDir);
  const response = makeResponseRecorder();
  service.servePluginLoader(response);
  const source = response.body.toString("utf-8");

  assert.match(source, /opencodex\.smart-model-router/);
  assert.doesNotMatch(source, /smart-model-router\/index\.js/);
  assert.match(source, /registerPlugin\(manifest\)/);
  assert.match(source, /createPluginScope\(entry\.manifest\)/);
  assert.match(source, /sdk\.commit\(\)/);

  function executeWithConfig(gatewayPluginConfig) {
    let reloadCount = 0;
    const document = {
      readyState: "loading",
      set cookie(_value) {},
      write() {},
    };
    const window = {
      __CODEX_WEB_CONFIG__: { gatewayPluginConfig },
      OpenCodexPluginSystem: { registerPlugin() {}, plugins: { setEnabled() {} } },
    };
    window.window = window;
    vm.runInNewContext(source, {
      console,
      document,
      localStorage: {
        getItem: () => JSON.stringify({ "opencodex.smart-model-router": false }),
      },
      location: { reload: () => { reloadCount += 1; } },
      window,
    });
    return reloadCount;
  }

  // 公开登录壳没有受保护配置，必须等待用户认证，不能因 pending 状态形成刷新循环。
  assert.equal(executeWithConfig(undefined), 0);
  // 已认证直达页发现升级前遗留操作时只回退一次，让原同步壳提交该操作。
  assert.equal(executeWithConfig({ plugins: [] }), 1);
});

test("external plugins require an SDK-compatible ESM v2 entry and never execute index.js", (t) => {
  const root = makeTempDir(t);
  const modernDir = path.join(root, "modern-plugin");
  const legacyDir = path.join(root, "legacy-plugin");
  fs.mkdirSync(path.join(modernDir, "dist"), { recursive: true });
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(path.join(modernDir, "plugin.json"), JSON.stringify({
    id: "example.modern",
    apiVersion: 2,
    entry: "dist/index.mjs",
    sdkVersion: "^2.0.0",
  }));
  fs.writeFileSync(path.join(modernDir, "dist", "index.mjs"), "export default sdk => void sdk;");
  fs.writeFileSync(path.join(legacyDir, "plugin.json"), JSON.stringify({ id: "example.legacy" }));
  fs.writeFileSync(path.join(legacyDir, "index.js"), "throw new Error('must not execute');");

  const previousRoots = process.env.OPENCODEX_PLUGIN_DIRS;
  try {
    process.env.OPENCODEX_PLUGIN_DIRS = root;
    const entries = listPluginEntries();
    const modern = entries.find((entry) => entry.manifest.id === "example.modern");
    const legacy = entries.find((entry) => entry.manifest.id === "example.legacy");
    assert.equal(modern.entryFile, fs.realpathSync(path.join(modernDir, "dist", "index.mjs")));
    assert.match(modern.urlPath, /modern-plugin\/entry\.mjs$/);
    assert.equal(pluginEntryFileFromRequestPath(`/opencodex-plugins/${modern.urlPath}`), modern.entryFile);
    assert.equal(legacy.entryFile, null);
    assert.equal(legacy.urlPath, "");
    const service = createService(makeOfficialWebviewDir(t));
    const aggregateSource = runtimeBootstrapSource(service);
    assert.match(aggregateSource, /createPluginScope\(entry\.manifest\)/);
    assert.match(aggregateSource, /modern-plugin\/entry\.mjs/);
    assert.doesNotMatch(aggregateSource, /must not execute/);
    const html = service.createRendererResponse();
    const codecIndex = html.indexOf('<script src="/codex-app-host-message-codec.js"></script>');
    const bridgeIndex = html.indexOf('<script src="/codex-bridge-polyfill.js"></script>');
    assert.ok(codecIndex >= 0 && bridgeIndex > codecIndex);
  } finally {
    if (previousRoots === undefined) delete process.env.OPENCODEX_PLUGIN_DIRS;
    else process.env.OPENCODEX_PLUGIN_DIRS = previousRoots;
  }

  assert.equal(pluginSdkRangeCompatible("2.0.0"), true);
  assert.equal(pluginSdkRangeCompatible("^2.0.0"), true);
  assert.equal(pluginSdkRangeCompatible(">=2 <3"), true);
  assert.equal(pluginSdkRangeCompatible("^3.0.0"), false);
  assert.equal(pluginSdkRangeCompatible(""), false);
});

test("renames official open-in-folder locale message only for remote browser hosts", (t) => {
  const webviewDir = makeOfficialWebviewDir(t);
  const assetsDir = path.join(webviewDir, "assets");
  fs.mkdirSync(assetsDir, { recursive: true });
  const assetName = "zh-CN-test.js";
  fs.writeFileSync(
    path.join(assetsDir, assetName),
    'export default {"artifactTab.preview.openInFolder":`打开所在文件夹`,"other.key":`保持不变`};'
  );
  const service = createStaticAssetService({
    getI18nSnapshot: () => ({
      locale: "zh-CN",
      messages: { "web.remoteFile.downloadFile": "下载文件" },
    }),
    getOfficialBundle: () => ({ webviewDir }),
  });
  const reqPath = `${PATCHED_OFFICIAL_PREFIX}assets/${assetName}`;

  const remoteSource = serveOfficialAsset(service, reqPath, "192.168.60.218:3737");
  assert.match(remoteSource, /"artifactTab\.preview\.openInFolder"\s*:\s*"下载文件"/);
  assert.match(remoteSource, /"other\.key":`保持不变`/);

  const loopbackSource = serveOfficialAsset(service, reqPath, "localhost:3737");
  assert.match(loopbackSource, /"artifactTab\.preview\.openInFolder":`打开所在文件夹`/);
});

test("only caches content-hashed patched assets as immutable", (t) => {
  const webviewDir = makeOfficialWebviewDir(t);
  const assetsDir = path.join(webviewDir, "assets");
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.writeFileSync(path.join(assetsDir, "app-Dk3EPlSk.js"), "export const ready = true;");
  fs.writeFileSync(path.join(assetsDir, "OpenAISans-Medium-B7nJY_kG.woff2"), "font");
  fs.writeFileSync(
    path.join(assetsDir, "locale-Ab1_cdEF.js"),
    'export default {"artifactTab.preview.openInFolder":"Open in folder"};'
  );
  fs.writeFileSync(path.join(assetsDir, "dotnet.js"), "export const runtime = true;");
  const service = createService(webviewDir);
  const patchedService = createStaticAssetService({
    getI18nSnapshot: () => ({
      locale: "zh-CN",
      messages: { "web.remoteFile.downloadFile": "下载文件" },
    }),
    getOfficialBundle: () => ({ webviewDir }),
  });

  const current = serveOfficialAssetResponse(service, `${PATCHED_OFFICIAL_PREFIX}assets/app-Dk3EPlSk.js`);
  const dynamic = serveOfficialAssetResponse(
    patchedService,
    `${PATCHED_OFFICIAL_PREFIX}assets/locale-Ab1_cdEF.js`,
    "192.168.60.218:3737"
  );
  const fixedName = serveOfficialAssetResponse(service, `${PATCHED_OFFICIAL_PREFIX}assets/dotnet.js`);
  const font = serveOfficialAssetResponse(
    service,
    `${PATCHED_OFFICIAL_PREFIX}assets/OpenAISans-Medium-B7nJY_kG.woff2`
  );
  const legacy = serveOfficialAssetResponse(service, "/official-patched/assets/app-Dk3EPlSk.js");

  assert.equal(current.headers["cache-control"], "public, max-age=31536000, immutable");
  assert.equal(font.headers["cache-control"], "public, max-age=31536000, immutable");
  assert.equal(dynamic.headers["cache-control"], "private, no-cache, must-revalidate");
  assert.match(dynamic.body.toString("utf-8"), /下载文件/);
  assert.equal(fixedName.headers["cache-control"], "no-store");
  assert.equal(legacy.headers["cache-control"], "no-store");
});

test("patched asset cache coalesces asynchronous compression and reuses it for ETag validation", async (t) => {
  const webviewDir = makeOfficialWebviewDir(t);
  const assetsDir = path.join(webviewDir, "assets");
  fs.mkdirSync(assetsDir, { recursive: true });
  const assetName = "locale-Cache001.js";
  fs.writeFileSync(
    path.join(assetsDir, assetName),
    `export default {"artifactTab.preview.openInFolder":"Open in folder","padding":"${"x".repeat(4096)}"};`
  );
  const service = createStaticAssetService({
    getI18nSnapshot: () => ({
      locale: "zh-CN",
      messages: { "web.remoteFile.downloadFile": "下载文件" },
    }),
    getOfficialBundle: () => ({ webviewDir }),
  });
  const reqPath = `${PATCHED_OFFICIAL_PREFIX}assets/${assetName}`;

  const file = service.staticFile(reqPath);
  const first = makeResponseRecorder();
  const firstCompletion = service.serveFile(
    { headers: { host: "192.168.1.20:3737", "accept-encoding": "gzip;q=0.5, br;q=1" } },
    first,
    file,
    200,
    reqPath
  );
  // 冷压缩不能在 serveFile 调用栈内阻塞并直接写回响应。
  assert.equal(first.status, 0);
  assert.equal(typeof firstCompletion?.then, "function");
  const secondCompletion = serveOfficialAssetResponseAsync(service, reqPath, "192.168.1.20:3737", {
    "accept-encoding": "gzip;q=0.5, br;q=1",
  });
  const [, second] = await Promise.all([firstCompletion, secondCompletion]);
  const validated = await serveOfficialAssetResponseAsync(service, reqPath, "192.168.1.20:3737", {
    "accept-encoding": "br",
    "if-none-match": first.headers.etag,
  });

  assert.equal(first.status, 200);
  assert.equal(first.headers["content-encoding"], "br");
  assert.equal(first.headers.vary, "Accept-Encoding");
  assert.match(require("node:zlib").brotliDecompressSync(first.body).toString("utf8"), /下载文件/);
  assert.deepEqual(second.body, first.body);
  assert.equal(second.headers.etag, first.headers.etag);
  assert.equal(validated.status, 304);
  assert.equal(validated.body.length, 0);
  assert.deepEqual(service.assetCacheDiagnostics(), {
    bytes: service.assetCacheDiagnostics().bytes,
    compressionRuns: 1,
    entries: 1,
    hits: 2,
    maxBytes: service.assetCacheDiagnostics().maxBytes,
    misses: 1,
    notModified: 1,
    patchRuns: 1,
  });
});

test("patched asset cache isolates host and locale variants and invalidates changed files", (t) => {
  const webviewDir = makeOfficialWebviewDir(t);
  const assetsDir = path.join(webviewDir, "assets");
  fs.mkdirSync(assetsDir, { recursive: true });
  const assetName = "locale-Variant1.js";
  const assetPath = path.join(assetsDir, assetName);
  fs.writeFileSync(
    assetPath,
    'export default {"artifactTab.preview.openInFolder":"Open in folder","revision":1};'
  );
  let locale = "zh-CN";
  let message = "下载文件";
  const service = createStaticAssetService({
    getI18nSnapshot: () => ({
      locale,
      messages: { "web.remoteFile.downloadFile": message },
    }),
    getOfficialBundle: () => ({ webviewDir }),
  });
  const reqPath = `${PATCHED_OFFICIAL_PREFIX}assets/${assetName}`;

  const local = serveOfficialAssetResponse(service, reqPath);
  const remote = serveOfficialAssetResponse(service, reqPath, "10.0.0.8:3737");
  const sameRemoteDifferentHost = serveOfficialAssetResponse(service, reqPath, "192.168.60.218:3737");
  locale = "en-US";
  const sameMessageDifferentLocale = serveOfficialAssetResponse(service, reqPath, "10.0.0.8:3737");
  message = "保存到设备";
  const relocalized = serveOfficialAssetResponse(service, reqPath, "10.0.0.8:3737");
  fs.writeFileSync(
    assetPath,
    'export default {"artifactTab.preview.openInFolder":"Open in folder","revision":22};'
  );
  const changed = serveOfficialAssetResponse(service, reqPath, "10.0.0.8:3737");

  assert.match(local.body.toString("utf8"), /Open in folder/);
  assert.match(remote.body.toString("utf8"), /下载文件/);
  assert.deepEqual(sameRemoteDifferentHost.body, remote.body);
  assert.deepEqual(sameMessageDifferentLocale.body, remote.body);
  assert.match(relocalized.body.toString("utf8"), /保存到设备/);
  assert.match(changed.body.toString("utf8"), /"revision":22/);
  assert.equal(service.assetCacheDiagnostics().patchRuns, 4);
  assert.equal(service.assetCacheDiagnostics().entries, 4);
  assert.equal(service.assetCacheDiagnostics().hits, 2);
});

test("patched asset cache honors explicit encoding exclusions and evicts old variants", async (t) => {
  const webviewDir = makeOfficialWebviewDir(t);
  const assetsDir = path.join(webviewDir, "assets");
  fs.mkdirSync(assetsDir, { recursive: true });
  for (const name of ["chunk-Evict001.js", "chunk-Evict002.js"]) {
    fs.writeFileSync(path.join(assetsDir, name), `export const value = "${name}-${"x".repeat(1600)}";`);
  }
  const service = createStaticAssetService({
    getI18nSnapshot: () => ({ locale: "en-US", messages: {} }),
    getOfficialBundle: () => ({ webviewDir }),
    patchedAssetCacheMaxBytes: 2200,
  });

  const first = await serveOfficialAssetResponseAsync(
    service,
    `${PATCHED_OFFICIAL_PREFIX}assets/chunk-Evict001.js`,
    "localhost:3737",
    { "accept-encoding": "br;q=0, gzip;q=1" }
  );
  serveOfficialAssetResponse(
    service,
    `${PATCHED_OFFICIAL_PREFIX}assets/chunk-Evict002.js`,
    "localhost:3737",
    { "accept-encoding": "identity" }
  );

  assert.equal(first.headers["content-encoding"], "gzip");
  assert.equal(service.assetCacheDiagnostics().entries, 1);
  assert.equal(service.assetCacheDiagnostics().bytes <= service.assetCacheDiagnostics().maxBytes, true);
});
