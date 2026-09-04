const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const asar = require("@electron/asar");

const {
  CodexAsarScanner,
  CodexAsarCandidateProvider,
} = require("../dist/official/CodexAsarScanner.js");
const { AsarWebviewExtractor } = require("../dist/official/AsarWebviewExtractor.js");
const { LocalCodexBundleProvider } = require("../dist/official/LocalCodexBundleProvider.js");
const { OfficialBundleCache } = require("../dist/official/OfficialBundleCache.js");
const { OfficialBundleFileSystem } = require("../dist/official/OfficialBundleFileSystem.js");
const { OfficialRuntimeOptimizer } = require("../dist/official/OfficialRuntimeOptimizer.js");
const {
  configureHiddenRuntimeCommandLine,
  configureHiddenRuntimeEnvironment,
  hiddenRuntimeGcmCommandLineArgs,
  isolateHiddenRuntimeGcmStore,
  isolateHiddenRuntimeGcmStoresForUserData,
} = require("../runtime/electron/hidden-runtime-command-line.cjs");
const {
  createRequestHandler,
  __test: hiddenRuntimeServerTest,
} = require("../runtime/server.cjs");
const {
  LEGACY_RUNTIME_ENTRY_PATH,
  OfficialRuntimeEntryResolver,
} = require("../dist/official/OfficialRuntimeEntryResolver.js");
const { __test: layoutTest } = require("../runner/official-layout.cjs");
const { createMacRunner } = require("../runner/platform/macos.cjs");
const { MANIFEST_SCHEMA_VERSION } = require("../dist/official/constants.js");
const { createCompatibilityService } = require("../runtime/compatibility/service.cjs");
const { runner: runnerPoints, staticMain: staticMainPoints } = require("../runtime/modification/point-refs.cjs");

function temporaryDirectory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodex-desktop-compat-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeFile(filePath, content = "fixture") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

test("gateway compatibility service initializes from configured runtime paths", (t) => {
  const configuredPaths = hiddenRuntimeServerTest.gatewayCompatibilityPaths();
  assert.equal(path.isAbsolute(configuredPaths.runtimeDir), true);
  assert.equal(path.isAbsolute(configuredPaths.reportsDir), true);

  // 使用临时目录走一遍真实初始化入口，避免测试污染开发态运行报告。
  const root = temporaryDirectory(t);
  const compatibilityService = hiddenRuntimeServerTest.createGatewayCompatibilityService({
    runtimeDir: path.join(root, "runtime"),
    reportsDir: path.join(root, "reports"),
  });
  try {
    const snapshot = compatibilityService.snapshot();
    assert.equal(snapshot.points.length, 103);
    assert.equal(snapshot.groups.length, 17);
    assert.equal(snapshot.adapterTypes.length, 23);
    assert.equal(Object.hasOwn(snapshot, "features"), false);
  } finally {
    compatibilityService.dispose();
  }
});

test("macOS default candidates prefer ChatGPT while retaining Codex paths", () => {
  const fileSystem = { normalizePath: (value) => value };
  const provider = new CodexAsarCandidateProvider({
    fileSystem,
    platform: "darwin",
    homeDir: "/Users/example",
  });

  assert.deepEqual(provider.toList(), [
    "/Applications/ChatGPT.app",
    path.join("/Users/example", "Applications", "ChatGPT.app"),
    "/Applications/Codex.app",
    path.join("/Users/example", "Applications", "Codex.app"),
  ]);

  const configuredProvider = new CodexAsarCandidateProvider({
    fileSystem,
    configuredPath: "/custom/Codex.app",
    platform: "darwin",
    homeDir: "/Users/example",
  });
  assert.equal(configuredProvider.toList()[0], "/custom/Codex.app");
});

test("scanner falls back from a missing cached Codex source to ChatGPT and still supports Codex only", (t) => {
  const root = temporaryDirectory(t);
  const chatGptRoot = path.join(root, "ChatGPT.app");
  const codexRoot = path.join(root, "Codex.app");
  const chatGptAsar = path.join(chatGptRoot, "Contents", "Resources", "app.asar");
  const codexAsar = path.join(codexRoot, "Contents", "Resources", "app.asar");
  writeFile(chatGptAsar);
  writeFile(codexAsar);

  const scanner = new CodexAsarScanner({ defaultCandidates: [chatGptRoot, codexRoot] });
  assert.equal(
    scanner.find({ cachedAsarPath: path.join(root, "missing", "app.asar") }).asarPath,
    fs.realpathSync(chatGptAsar)
  );

  fs.rmSync(chatGptRoot, { recursive: true, force: true });
  assert.equal(scanner.find().asarPath, fs.realpathSync(codexAsar));
});

test("runtime entry resolver accepts legacy and early bootstrap across ASAR separators", () => {
  const resolver = new OfficialRuntimeEntryResolver();

  assert.equal(
    resolver.resolve({
      packageInfo: { main: ".vite/build/bootstrap.js" },
      availableEntries: ["/.vite/build/bootstrap.js"],
    }),
    ".vite/build/bootstrap.js"
  );
  assert.equal(
    resolver.resolve({
      packageInfo: { main: ".vite/build/early-bootstrap.js" },
      availableEntries: ["\\.vite\\build\\early-bootstrap.js"],
    }),
    ".vite/build/early-bootstrap.js"
  );
  assert.equal(
    resolver.resolve({ packageInfo: {}, availableEntries: ["/.vite/build/bootstrap.js"] }),
    LEGACY_RUNTIME_ENTRY_PATH
  );
});

test("runtime entry resolver rejects unsafe, unsupported, and missing declared entries", () => {
  const resolver = new OfficialRuntimeEntryResolver();

  assert.throws(() => resolver.resolve({ packageInfo: { main: "../bootstrap.js" } }), /越界/);
  assert.throws(
    () => resolver.resolve({ packageInfo: { main: ".vite/build/nested/../bootstrap.js" } }),
    /越界/
  );
  assert.throws(() => resolver.resolve({ packageInfo: { main: "C:\\runtime\\bootstrap.js" } }), /不安全/);
  assert.throws(() => resolver.resolve({ packageInfo: { main: "main.js" } }), /允许的构建目录/);
  assert.throws(() => resolver.resolve({ packageInfo: { main: "" } }), /非空字符串/);
  assert.throws(() => resolver.resolve({ packageInfo: { main: 123 } }), /非空字符串/);
  assert.throws(
    () => resolver.resolve({ packageInfo: { main: ".vite/build/missing.js" }, availableEntries: [] }),
    /不存在/
  );
});

test("ASAR extractor normalizes Windows entries and returns the declared early bootstrap", (t) => {
  const destDir = temporaryDirectory(t);
  const packageInfo = { name: "openai-codex-electron", main: ".vite/build/early-bootstrap.js" };
  const files = new Map([
    ["package.json", Buffer.from(JSON.stringify(packageInfo))],
    [".vite/build/early-bootstrap.js", Buffer.from("require('./bootstrap-hash.js')")],
    [".vite/build/bootstrap-hash.js", Buffer.from("module.exports = {}")],
    ["webview/index.html", Buffer.from("<html></html>")],
    ["webview/assets/app.js", Buffer.from("console.log('fixture')")],
  ]);
  const normalize = (entry) => String(entry).replace(/\\/g, "/").replace(/^\/+/, "");
  const archive = {
    listPackage: () => Array.from(files.keys(), (entry) => `\\${entry.replace(/\//g, "\\")}`),
    extractJson: () => packageInfo,
    statFile: () => ({ size: 1 }),
    extractFile: (_asarPath, entry) => files.get(normalize(entry)),
  };
  const extractor = new AsarWebviewExtractor({
    archive,
    fileSystem: new OfficialBundleFileSystem(),
  });

  const result = extractor.extract("fixture.asar", destDir);

  assert.equal(result.runtimeEntryPath, ".vite/build/early-bootstrap.js");
  assert.equal(fs.existsSync(path.join(destDir, ".vite", "build", "early-bootstrap.js")), true);
});

test("current cache schema resolves both dynamic and legacy bootstrap paths", (t) => {
  const projectRoot = temporaryDirectory(t);
  const fileSystem = new OfficialBundleFileSystem();
  const bundleDir = path.join(projectRoot, "bundle");
  const sourceResourcesPath = path.join(projectRoot, "source-resources");
  const sourceAsarPath = path.join(sourceResourcesPath, "app.asar");
  const logger = { warn() {} };
  const cache = new OfficialBundleCache({
    projectRoot,
    configuredBundleDir: bundleDir,
    logger,
    fileSystem,
  });
  const manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    sourceAsarPath,
    sourceResourcesPath,
    runtimeOptimizations: {
      nativePetComposition: "not-present",
      nativePetPrewarm: "not-present",
      macPushRegistration: "not-present",
      patchedFileCount: 0,
      unsupportedFiles: [],
    },
  };

  // 构造最小可复用缓存，先验证新版 main，再切换到无 main 的旧版 package。
  writeFile(sourceAsarPath);
  writeFile(path.join(bundleDir, "webview", "index.html"));
  writeFile(path.join(bundleDir, "webview", "assets", "app.js"));
  writeFile(path.join(bundleDir, "node_modules", "fixture", "index.js"));
  writeFile(path.join(bundleDir, ".vite", "build", "early-bootstrap.js"));
  writeFile(path.join(bundleDir, "package.json"), JSON.stringify({ main: ".vite/build/early-bootstrap.js" }));

  assert.equal(cache.reuseWithoutSourceScanBlockReason(manifest), "");
  assert.equal(cache.bootstrapPath, path.join(bundleDir, ".vite", "build", "early-bootstrap.js"));

  fs.rmSync(path.join(bundleDir, ".vite", "build", "early-bootstrap.js"));
  writeFile(path.join(bundleDir, ".vite", "build", "bootstrap.js"));
  writeFile(path.join(bundleDir, "package.json"), JSON.stringify({ name: "legacy-codex" }));

  assert.equal(cache.reuseWithoutSourceScanBlockReason(manifest), "");
  assert.equal(cache.bootstrapPath, path.join(bundleDir, ".vite", "build", "bootstrap.js"));
});

test("hidden gateway disables Web Push without dropping existing Chromium feature switches", () => {
  const switchValues = new Map([
    ["disable-features", "ExistingFeature"],
    ["disable-blink-features", "ExistingBlinkFeature"],
  ]);
  const app = {
    commandLine: {
      appendSwitch(name, value) {
        switchValues.set(name, value);
      },
      getSwitchValue(name) {
        return switchValues.get(name) || "";
      },
    },
  };

  assert.deepEqual(configureHiddenRuntimeCommandLine(app, { PORT: "43895" }), ["ExistingFeature", "PushMessaging"]);
  assert.equal(switchValues.get("disable-features"), "ExistingFeature,PushMessaging");
  assert.equal(
    switchValues.get("disable-blink-features"),
    "ExistingBlinkFeature,PushMessaging"
  );
  assert.equal(switchValues.has("disable-notifications"), true);
  assert.equal(switchValues.get("disable-notifications"), undefined);
  assert.equal(switchValues.has("disable-background-networking"), true);
  const gcmHoldUrl = "http://127.0.0.1:43895/__opencodex-internal/gcm-checkin-hold";
  assert.equal(switchValues.get("gcm-checkin-url"), gcmHoldUrl);
  assert.equal(switchValues.get("gcm-mcs-endpoint"), gcmHoldUrl);
  assert.equal(switchValues.get("gcm-registration-url"), gcmHoldUrl);
  // 重复初始化不得堆叠同名特性，保证开发重载和测试环境行为稳定。
  assert.deepEqual(configureHiddenRuntimeCommandLine(app, { PORT: "43895" }), ["ExistingFeature", "PushMessaging"]);
  assert.deepEqual(configureHiddenRuntimeCommandLine(null), []);
});

test("hidden gateway preserves the original GCM store once and removes only transient copies", (t) => {
  const userDataPath = temporaryDirectory(t);
  const profilePath = path.join(userDataPath, "Default");
  const storePath = path.join(profilePath, "GCM Store");
  const backupPath = path.join(profilePath, "GCM Store.opencodex-disabled");
  const partitionPath = path.join(profilePath, "Partitions", "codex-browser-app");
  const partitionStorePath = path.join(partitionPath, "GCM Store");
  const partitionBackupPath = path.join(partitionPath, "GCM Store.opencodex-disabled");
  writeFile(path.join(storePath, "CURRENT"), "original");
  writeFile(path.join(partitionStorePath, "CURRENT"), "partition-original");
  const app = { getPath: (name) => (name === "userData" ? userDataPath : "") };

  // launcher 在 spawn 前走路径接口，Electron main 启动后走 app 接口；两者必须共享完全相同的隔离语义。
  assert.deepEqual(isolateHiddenRuntimeGcmStoresForUserData(userDataPath), {
    backedUpCount: 2,
    isolated: true,
    reason: "store-backed-up",
    removedCount: 0,
  });
  assert.equal(fs.readFileSync(path.join(backupPath, "CURRENT"), "utf8"), "original");
  assert.equal(
    fs.readFileSync(path.join(partitionBackupPath, "CURRENT"), "utf8"),
    "partition-original"
  );
  assert.equal(fs.existsSync(storePath), false);
  assert.equal(fs.existsSync(partitionStorePath), false);

  writeFile(path.join(storePath, "CURRENT"), "transient");
  writeFile(path.join(partitionStorePath, "CURRENT"), "partition-transient");
  assert.deepEqual(isolateHiddenRuntimeGcmStore(app), {
    backedUpCount: 0,
    isolated: true,
    reason: "transient-store-removed",
    removedCount: 2,
  });
  assert.equal(fs.existsSync(storePath), false);
  assert.equal(fs.existsSync(partitionStorePath), false);
  assert.equal(fs.readFileSync(path.join(backupPath, "CURRENT"), "utf8"), "original");
  assert.equal(
    fs.readFileSync(path.join(partitionBackupPath, "CURRENT"), "utf8"),
    "partition-original"
  );

  assert.deepEqual(hiddenRuntimeGcmCommandLineArgs({ PORT: "43895" }), [
    "--disable-background-networking",
    "--gcm-checkin-url=http://127.0.0.1:43895/__opencodex-internal/gcm-checkin-hold",
    "--gcm-mcs-endpoint=http://127.0.0.1:43895/__opencodex-internal/gcm-checkin-hold",
    "--gcm-registration-url=http://127.0.0.1:43895/__opencodex-internal/gcm-checkin-hold",
  ]);
  assert.match(hiddenRuntimeGcmCommandLineArgs({})[1], /127\.0\.0\.1:3737/);
});

test("hidden GCM hold route accepts only loopback POST and releases tracked sockets", async () => {
  const socket = new EventEmitter();
  socket.remoteAddress = "127.0.0.1";
  let timeoutMs = null;
  socket.setTimeout = (value) => {
    timeoutMs = value;
  };
  let resumed = false;
  const request = {
    headers: { host: "127.0.0.1:43895" },
    method: "POST",
    resume() {
      resumed = true;
    },
    socket,
    url: "/__opencodex-internal/gcm-checkin-hold",
  };
  const sockets = new Set();

  // 先验证双重 loopback 约束，避免伪造 Host 的远端请求占用长连接。
  assert.equal(hiddenRuntimeServerTest.isHiddenRuntimeGcmHoldRequest(request, request.url), true);
  assert.equal(
    hiddenRuntimeServerTest.isHiddenRuntimeGcmHoldRequest(
      { ...request, socket: { ...socket, remoteAddress: "192.0.2.5" } },
      request.url
    ),
    false
  );
  assert.equal(
    hiddenRuntimeServerTest.isHiddenRuntimeGcmHoldRequest(
      { ...request, headers: { host: "example.com" } },
      request.url
    ),
    false
  );
  assert.equal(
    hiddenRuntimeServerTest.isHiddenRuntimeGcmHoldRequest({ ...request, method: "GET" }, request.url),
    false
  );

  const handler = createRequestHandler({ hiddenRuntimeGcmSockets: sockets });
  const pending = handler(request, {});
  assert.equal(resumed, true);
  assert.equal(timeoutMs, 0);
  assert.equal(sockets.has(socket), true);
  socket.emit("close");
  await pending;
  assert.equal(sockets.size, 0);
});

test("hidden gateway disables the official updater before loading the copied runtime", () => {
  const env = { CODEX_SPARKLE_ENABLED: "true", UNRELATED_SETTING: "preserved" };

  assert.deepEqual(configureHiddenRuntimeEnvironment(env), { CODEX_SPARKLE_ENABLED: "false" });
  assert.deepEqual(env, {
    CODEX_SPARKLE_ENABLED: "false",
    UNRELATED_SETTING: "preserved",
  });
});

test("runtime optimizer keeps native pet lazy and disables composition only for the hidden gateway", (t) => {
  const bundleDir = temporaryDirectory(t);
  const buildDir = path.join(bundleDir, ".vite", "build");
  const mainPath = path.join(buildDir, "main-fixture.js");
  const source =
    "function L_e({devAppPath:e,platform:t=process.platform}={}){" +
    "if(t!==`darwin`)return null;return{log:`Native pet material attachment completed`}}" +
    "class Pet{async restoreOpenState(e){this.globalState.get(`electron-avatar-overlay-open`)===!0&&await this.open(e)}" +
    "async prewarm(e){if(this.window!=null||this.openingWindowPromise!=null||this.isAppQuitting)return;this.open(e)}}";
  writeFile(mainPath, source);

  const optimizer = new OfficialRuntimeOptimizer({
    fileSystem: new OfficialBundleFileSystem(),
  });
  const result = optimizer.optimize(bundleDir);
  const optimized = fs.readFileSync(mainPath, "utf8");

  assert.deepEqual(result, {
    nativePetComposition: "gateway-css-fallback",
    nativePetPrewarm: "gateway-lazy",
    macPushRegistration: "not-present",
    patchedFileCount: 1,
    unsupportedFiles: [],
  });
  assert.match(
    optimized,
    /t!==`darwin`\|\|process\.env\.OPENCODEX_GATEWAY_HIDDEN_RUNTIME===`1`/
  );
  assert.match(optimized, /Native pet material attachment completed/);
  assert.match(
    optimized,
    /process\.env\.OPENCODEX_GATEWAY_HIDDEN_RUNTIME===`1`\|\|this\.window!=null/
  );
  assert.match(
    optimized,
    /process\.env\.OPENCODEX_GATEWAY_HIDDEN_RUNTIME!==`1`&&this\.globalState\.get\(`electron-avatar-overlay-open`\)/
  );
});

test("runtime optimizer patches every native pet factory and prewarm in one chunk", (t) => {
  const bundleDir = temporaryDirectory(t);
  const mainPath = path.join(bundleDir, ".vite", "build", "main-multiple.js");
  const factory = (name, platform) =>
    `function ${name}({devAppPath:e,platform:${platform}=process.platform}={}){` +
    `if(${platform}!==\`darwin\`)return null;return{log:\`Native pet material attachment completed\`}}`;
  const prewarm = (name, argument) =>
    `class ${name}{async prewarm(${argument}){if(this.window!=null||this.openingWindowPromise!=null||this.isAppQuitting)return;this.open(${argument})}}`;
  writeFile(
    mainPath,
    `${factory("First", "t")}${prewarm("FirstPet", "e")}${factory("Second", "p")}${prewarm("SecondPet", "n")}`
  );
  const optimizer = new OfficialRuntimeOptimizer({ fileSystem: new OfficialBundleFileSystem() });

  const result = optimizer.optimize(bundleDir);
  const optimized = fs.readFileSync(mainPath, "utf8");

  assert.equal(result.nativePetComposition, "gateway-css-fallback");
  assert.equal(result.nativePetPrewarm, "gateway-lazy");
  assert.equal(
    (optimized.match(/OPENCODEX_GATEWAY_HIDDEN_RUNTIME===`1`/g) || []).length,
    4
  );
  assert.doesNotMatch(optimized, /if\([tp]!==`darwin`\)return null/);
  assert.doesNotMatch(
    optimized,
    /if\(this\.window!=null\|\|this\.openingWindowPromise!=null\|\|this\.isAppQuitting\)return/
  );
});

test("runtime optimizer patches the renamed avatar overlay paths in new official runtimes", (t) => {
  const bundleDir = temporaryDirectory(t);
  const mainPath = path.join(bundleDir, ".vite", "build", "main-avatar-overlay.js");
  writeFile(
    mainPath,
    "var Overlay=class{logger=log(`avatar-overlay`);supportsInputShape=BrowserWindow.isInputShapeSupported();" +
      "async restoreOpenState(e){this.globalState.get(`electron-avatar-overlay-open`)===!0&&await this.open(e)}" +
      "async prewarm(e){if(this.window!=null||this.openingWindowPromise!=null||this.isAppQuitting)return;await this.ensureWindow(e)}" +
      "async ensureWindow(e){if(this.isAppQuitting)return null;return this.createWindow(e)}}"
  );
  const compatibilityService = createCompatibilityService();
  const optimizer = new OfficialRuntimeOptimizer({
    fileSystem: new OfficialBundleFileSystem(),
    compatibilityService,
  });

  try {
    assert.deepEqual(optimizer.optimize(bundleDir), {
      nativePetComposition: "gateway-css-fallback",
      nativePetPrewarm: "gateway-lazy",
      macPushRegistration: "not-present",
      patchedFileCount: 1,
      unsupportedFiles: [],
    });
    const optimized = fs.readFileSync(mainPath, "utf8");
    // 新版保留 Manager 对象协议，但窗口创建、预热和 Profile 恢复都不能在隐藏 runtime 中发生。
    assert.match(
      optimized,
      /async ensureWindow\(e\)\{if\(process\.env\.OPENCODEX_GATEWAY_HIDDEN_RUNTIME===`1`\|\|this\.isAppQuitting\)return null;/
    );
    assert.match(
      optimized,
      /async prewarm\(e\)\{if\(process\.env\.OPENCODEX_GATEWAY_HIDDEN_RUNTIME===`1`\|\|this\.window!=null/
    );
    assert.match(
      optimized,
      /async restoreOpenState\(e\)\{process\.env\.OPENCODEX_GATEWAY_HIDDEN_RUNTIME!==`1`&&this\.globalState/
    );
    for (const pointId of [
      "static.cache.main.native-pet.factory",
      "static.cache.main.native-pet.prewarm",
      "static.cache.main.native-pet.restore",
    ]) {
      assert.equal(compatibilityService.registry.point(pointId).status, "healthy");
    }
  } finally {
    compatibilityService.dispose();
  }
});

test("runtime optimizer reports a partially recognized native pet chunk", (t) => {
  const bundleDir = temporaryDirectory(t);
  const mainPath = path.join(bundleDir, ".vite", "build", "main-partial.js");
  const supported =
    "function Supported({devAppPath:e,platform:t=process.platform}={}){" +
    "if(t!==`darwin`)return null;return{log:`Native pet material attachment completed`}}" +
    "class SupportedPet{async prewarm(e){if(this.window!=null||this.openingWindowPromise!=null||this.isAppQuitting)return;this.open(e)}}";
  const changed =
    "function Changed({platform:p=process.platform}={}){" +
    "if(p!==`darwin`)return null;return{log:`Native pet material attachment completed`}}" +
    "class ChangedPet{async prewarm(e){if(this.window||this.isAppQuitting)return;this.open(e)}}";
  writeFile(mainPath, `${supported}${changed}`);
  const optimizer = new OfficialRuntimeOptimizer({ fileSystem: new OfficialBundleFileSystem() });

  const result = optimizer.optimize(bundleDir);
  const optimized = fs.readFileSync(mainPath, "utf8");

  // 保持旧行为：已识别部分仍安全改写，但骨架和 manifest 必须明确报告当前处于降级状态。
  assert.deepEqual(result, {
    nativePetComposition: "unsupported-layout",
    nativePetPrewarm: "unsupported-layout",
    macPushRegistration: "not-present",
    patchedFileCount: 1,
    unsupportedFiles: ["main-partial.js:native-bridge,prewarm"],
  });
  assert.equal((optimized.match(/OPENCODEX_GATEWAY_HIDDEN_RUNTIME===`1`/g) || []).length, 2);
  assert.match(optimized, /function Changed\(\{platform:p=process\.platform\}/);
});

test("compatibility capability preserves official main optimization bytes", (t) => {
  const baselineDir = temporaryDirectory(t);
  const migratedDir = temporaryDirectory(t);
  const relativePath = path.join(".vite", "build", "main-equivalent.js");
  const source =
    "function PetFactory({devAppPath:e,platform:t=process.platform}={}){" +
    "if(t!==`darwin`)return null;return{log:`Native pet material attachment completed`}}" +
    "class Pet{async prewarm(e){if(this.window!=null||this.openingWindowPromise!=null||this.isAppQuitting)return;this.open(e)}}";
  writeFile(path.join(baselineDir, relativePath), source);
  writeFile(path.join(migratedDir, relativePath), source);

  const fileSystem = new OfficialBundleFileSystem();
  const baselineResult = new OfficialRuntimeOptimizer({ fileSystem }).optimize(baselineDir);
  const compatibilityService = createCompatibilityService();
  const migratedResult = new OfficialRuntimeOptimizer({ fileSystem, compatibilityService }).optimize(migratedDir);

  assert.deepEqual(migratedResult, baselineResult);
  assert.equal(
    fs.readFileSync(path.join(migratedDir, relativePath), "utf8"),
    fs.readFileSync(path.join(baselineDir, relativePath), "utf8")
  );
  assert.equal(compatibilityService.registry.point("static.cache.main.native-pet.factory").status, "healthy");
  compatibilityService.dispose();
});

test("official optimizer never retries a patcher that throws through the Kernel wrapper", () => {
  const optimizer = new OfficialRuntimeOptimizer({ fileSystem: new OfficialBundleFileSystem() });
  const expected = new Error("expected patch failure");
  let calls = 0;
  assert.throws(() => optimizer.runPatchPoint({
    point: staticMainPoints.nativePetFactory,
    source: "fixture",
    fileName: "main.js",
    candidateCount: 1,
    expectedCandidates: 1,
    supported: true,
    patcher() {
      calls += 1;
      throw expected;
    },
  }), (error) => error === expected);
  assert.equal(calls, 1);
});

test("runtime optimizer is idempotent for an already optimized cache", (t) => {
  const bundleDir = temporaryDirectory(t);
  const mainPath = path.join(bundleDir, ".vite", "build", "main-idempotent.js");
  writeFile(
    mainPath,
    "function PetFactory({devAppPath:e,platform:t=process.platform}={}){" +
      "if(t!==`darwin`)return null;return{log:`Native pet material attachment completed`}}" +
      "class Pet{async prewarm(e){if(this.window!=null||this.openingWindowPromise!=null||this.isAppQuitting)return;this.open(e)}}"
  );
  const optimizer = new OfficialRuntimeOptimizer({ fileSystem: new OfficialBundleFileSystem() });

  assert.equal(optimizer.optimize(bundleDir).nativePetComposition, "gateway-css-fallback");
  const once = fs.readFileSync(mainPath, "utf8");
  const second = optimizer.optimize(bundleDir);

  assert.equal(second.nativePetComposition, "gateway-css-fallback");
  assert.equal(second.nativePetPrewarm, "gateway-lazy");
  assert.equal(second.macPushRegistration, "not-present");
  assert.equal(second.patchedFileCount, 0);
  assert.deepEqual(second.unsupportedFiles, []);
  assert.equal(fs.readFileSync(mainPath, "utf8"), once);
});

test("runtime optimizer skips unavailable macOS push registration only in the hidden gateway", (t) => {
  const bundleDir = temporaryDirectory(t);
  const mainPath = path.join(bundleDir, ".vite", "build", "main-push.js");
  writeFile(
    mainPath,
    "const register=()=>{process.platform!==`darwin`||g!==a.a.Prod||Lie({appServerClient:ce,desktopApiOptions:le})" +
      ".catch(e=>logger.warning(`Failed to register macOS push notifications`,e))};"
  );
  const optimizer = new OfficialRuntimeOptimizer({ fileSystem: new OfficialBundleFileSystem() });

  assert.deepEqual(optimizer.optimize(bundleDir), {
    nativePetComposition: "not-present",
    nativePetPrewarm: "not-present",
    macPushRegistration: "gateway-disabled",
    patchedFileCount: 1,
    unsupportedFiles: [],
  });
  const optimized = fs.readFileSync(mainPath, "utf8");
  assert.match(
    optimized,
    /process\.platform!==`darwin`\|\|process\.env\.OPENCODEX_GATEWAY_HIDDEN_RUNTIME===`1`/
  );
  // 二次执行必须识别已优化结构，不能重复改写缓存文件。
  assert.equal(optimizer.optimize(bundleDir).patchedFileCount, 0);
  assert.equal(fs.readFileSync(mainPath, "utf8"), optimized);
});

test("runtime optimizer bounds hidden gateway sidebar Git discovery without changing explicit timeouts", async (t) => {
  const bundleDir = temporaryDirectory(t);
  const workerPath = path.join(bundleDir, ".vite", "build", "worker.js");
  writeFile(
    workerPath,
    "var O2=oW(`git`),k2=1e3,A2=6e4,j2=`safe`;" +
      "var commandRunCount=0,activeKind=`git-origins`,activeSource=`sidebar_workspace_groups`;" +
      "function ace(){return{metadataCommonDir:null,requestKind:activeKind,source:activeSource}}" +
      "async function $(e,t,n,r={}){let{timeoutMs:o}=r,g=t[0],_=!0," +
      "v=Object.is(o,null)?void 0:o??(_?A2:void 0),y=crypto.randomUUID().slice(0,8)," +
      "b=Date.now(),x=v==null?void 0:b+v,S=ace(),C=_||S.metadataCommonDir!=null?S.metadataCommonDir:void 0,w=!n.isLocal;" +
      "let preflightDeadline=x-b;let Se=v==null?null:setTimeout(()=>{},Math.max(0,(x??Date.now()+v)-Date.now()));" +
      "Se&&clearTimeout(Se);commandRunCount++;return{preflightDeadline,timeout:v}}" +
      "async function vde(e,t,n){let r=await t.getStableMetadata(e,n);if(r==null)return null;" +
      "let i=t.getWorktreeRepositoryForRoot(r.root,n),a=await t.getRepoRepository(e,n);" +
      "return a==null?null:{dir:e,root:i.root,originUrl:await a.getOriginUrl(),commonDir:a.getCommonDir()}}" +
      "var yde=[`.git`,`HEAD`];async function Sde(e,t,n){if(!n.isAbsolute(e)||n.normalize(e)!==e||e.endsWith(n.sep)&&e!==n.parse(e).root)return!0;" +
      "let r=e;for(;;){try{let e=await t.stat(r,{bypassCache:!0,followSymlinks:!1});if(e.isSymbolicLink()||!e.isDirectory())return!0}catch{return!0}" +
      "for(let e of yde)try{return await t.stat(n.join(r,e),{bypassCache:!0,followSymlinks:!1}),!0}catch(e){if(!K1(e))return!0}" +
      "let e=n.dirname(r);if(e===r)return!1;r=e}}" +
      "function log(){logger.info(`[git-origins] worker-complete`)}"
  );
  const optimizer = new OfficialRuntimeOptimizer({ fileSystem: new OfficialBundleFileSystem() });

  assert.deepEqual(optimizer.optimize(bundleDir), {
    nativePetComposition: "not-present",
    nativePetPrewarm: "not-present",
    macPushRegistration: "not-present",
    patchedFileCount: 1,
    unsupportedFiles: [],
    gitDiscovery: "gateway-coalesced",
  });
  const optimized = fs.readFileSync(workerPath, "utf8");
  assert.match(optimized, /v=Object\.is\(o,null\)\?void 0:o\?\?\(_\?A2:void 0\)/);
  assert.doesNotMatch(optimized, /wce\(\)/);
  assert.match(optimized, /A2=6e4/);
  assert.match(optimized, /var __opencodexGitOriginCache=new Map/);
  assert.match(optimized, /var __opencodexGitStatCache=new Map/);
  assert.match(optimized, /__opencodexBackgroundGitTimeout/);
  assert.match(optimized, /__opencodexGitRepositoryPreflight/);
  assert.match(optimized, /__opencodexSidebarGitPreflight/);
  assert.ok(
    optimized.indexOf("__opencodexBackgroundGitTimeout") < optimized.indexOf("let preflightDeadline"),
    "后台 deadline 必须在任何 Git 前置等待前收紧"
  );
  assert.match(optimized, /async function __opencodexUncached_vde/);
  assert.match(
    optimized,
    /process\.env\.OPENCODEX_GATEWAY_HIDDEN_RUNTIME!==`1`\)return __opencodexUncached_vde/
  );

  // 精确验证补丁只约束隐藏运行时的后台探测，不改变显式超时和其他 Git 命令。
  const createFixture = new Function(
    "process",
    "oW",
    "require",
    `${optimized};return{run:$,runCount:()=>commandRunCount,commandCache:__opencodexSidebarGitCommandCache,resolveOrigin:vde,shouldDiscover:Sde,preflight:__opencodexGitHasRepositoryMarker,originCache:__opencodexGitOriginCache,originActive:()=>__opencodexGitOriginActive,originQueued:()=>__opencodexGitOriginQueue.length,setContext:(e,t)=>{activeKind=e,activeSource=t}}`
  );
  const hiddenFixture = createFixture(
    { env: { OPENCODEX_GATEWAY_HIDDEN_RUNTIME: "1" } },
    () => null,
    require
  );
  const localHost = {
    id: "local",
    isLocal: true,
    async stat(candidate) {
      // fixture 中的 /repo 是有效仓库，验证预检通过后仍执行官方 Git 主体。
      if (candidate === "/repo" || candidate === "/repo/.git") {
        return {
          isDirectory: () => true,
          isSymbolicLink: () => false,
        };
      }
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
  };
  assert.deepEqual(await hiddenFixture.run("/repo", [], localHost), {
    preflightDeadline: 1_000,
    timeout: 1_000,
  });
  assert.deepEqual(await hiddenFixture.run("/repo", [], localHost), {
    preflightDeadline: 1_000,
    timeout: 1_000,
  });
  // 完全相同的后台 Git 命令复用结果，第二次调用不再进入官方执行主体。
  assert.equal(hiddenFixture.runCount(), 1);
  assert.deepEqual(await hiddenFixture.run("/repo", [], localHost, { timeoutMs: 321 }), {
    preflightDeadline: 321,
    timeout: 321,
  });
  hiddenFixture.setContext("status", "sidebar_workspace_groups");
  assert.deepEqual(await hiddenFixture.run("/repo", [], localHost), {
    preflightDeadline: 60_000,
    timeout: 60_000,
  });
  hiddenFixture.setContext("stable-metadata", "sidebar_task_pr_chip");
  assert.deepEqual(await hiddenFixture.run("/repo", [], localHost), {
    preflightDeadline: 1_000,
    timeout: 1_000,
  });
  // git-origins 与侧栏 stable-metadata 的相同底层命令也应跨调用场景复用。
  assert.equal(hiddenFixture.runCount(), 3);
  let skippedStatCount = 0;
  const skippedHost = {
    id: "cloud-missing",
    isLocal: true,
    async stat() {
      skippedStatCount += 1;
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
  };
  const notRepositoryMessage = "fatal: not a git repository";
  assert.deepEqual(await hiddenFixture.run("/cloud-missing", [], skippedHost), {
    command: "git",
    success: false,
    code: 128,
    stdout: "",
    stdoutBytes: 0,
    stderr: notRepositoryMessage,
    stderrBytes: notRepositoryMessage.length,
  });
  // 相同失效目录直接复用失败缓存，既不再次触碰云盘，也不会进入 Git spawn 主体。
  assert.deepEqual(await hiddenFixture.run("/cloud-missing", [], skippedHost), {
    command: "git",
    success: false,
    code: 128,
    stdout: "",
    stdoutBytes: 0,
    stderr: notRepositoryMessage,
    stderrBytes: notRepositoryMessage.length,
  });
  assert.equal(skippedStatCount, 1);
  const failedCommandEntry = Array.from(hiddenFixture.commandCache.values()).find(
    (entry) => entry.failure?.success === false
  );
  assert.ok(failedCommandEntry?.expiresAt - Date.now() > 59_000, "后台失败结果必须退避一分钟");
  failedCommandEntry.expiresAt = Date.now() - 1;
  const staleStartedAt = Date.now();
  assert.deepEqual(await hiddenFixture.run("/cloud-missing", [], skippedHost), {
    command: "git",
    success: false,
    code: 128,
    stdout: "",
    stdoutBytes: 0,
    stderr: notRepositoryMessage,
    stderrBytes: notRepositoryMessage.length,
  });
  // 过期失败必须立即返回旧值；后台失败后退避翻倍，但不会永久阻止仓库恢复。
  assert.ok(Date.now() - staleStartedAt < 50);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const refreshedFailureEntry = Array.from(hiddenFixture.commandCache.values()).find(
    (entry) => entry.failure?.success === false && entry.failureCount === 2
  );
  assert.equal(refreshedFailureEntry?.failureCount, 2);
  assert.ok(refreshedFailureEntry.expiresAt - Date.now() > 119_000);
  hiddenFixture.setContext("stable-metadata", "active_thread");
  assert.deepEqual(await hiddenFixture.run("/repo", [], localHost), {
    preflightDeadline: 60_000,
    timeout: 60_000,
  });
  hiddenFixture.setContext("git-origins", "sidebar_workspace_groups");
  assert.deepEqual(
    await hiddenFixture.run("/repo", [], { id: "remote", isLocal: false }),
    { preflightDeadline: 60_000, timeout: 60_000 }
  );
  assert.equal(hiddenFixture.runCount(), 5);
  const pathApi = {
    dirname: () => "/",
    isAbsolute: () => true,
    join: (...parts) => parts.join("/"),
    normalize: (value) => value,
    parse: () => ({ root: "/" }),
    sep: "/",
  };
  let missingStatCount = 0;
  const missingHost = {
    async stat() {
      missingStatCount += 1;
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
  };
  const deniedHost = {
    async stat() {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    },
  };
  assert.equal(await hiddenFixture.shouldDiscover("/missing", missingHost, pathApi), false);
  assert.equal(await hiddenFixture.shouldDiscover("/missing", missingHost, pathApi), false);
  assert.equal(missingStatCount, 1);
  assert.equal(await hiddenFixture.shouldDiscover("/denied", deniedHost, pathApi), true);
  let slowStatCount = 0;
  const slowHost = {
    id: "slow",
    stat() {
      slowStatCount += 1;
      return new Promise(() => {});
    },
  };
  const slowStartedAt = Date.now();
  assert.deepEqual(
    await Promise.all([
      hiddenFixture.shouldDiscover("/slow", slowHost, pathApi),
      hiddenFixture.shouldDiscover("/slow", slowHost, pathApi),
    ]),
    [false, false]
  );
  assert.equal(slowStatCount, 1);
  assert.ok(Date.now() - slowStartedAt < 2_500);
  const cachedSlowStartedAt = Date.now();
  assert.equal(await hiddenFixture.shouldDiscover("/slow", slowHost, pathApi), false);
  assert.ok(Date.now() - cachedSlowStartedAt < 100);
  assert.equal(slowStatCount, 1);
  let failedDiscoveryCount = 0;
  const rejectingManager = {
    getStableMetadata() {
      failedDiscoveryCount += 1;
      return Promise.reject(new Error("missing workspace"));
    },
  };
  await assert.rejects(hiddenFixture.resolveOrigin("/missing", rejectingManager, { id: "local" }));
  await assert.rejects(hiddenFixture.resolveOrigin("/missing", rejectingManager, { id: "local" }));
  // 失败探测也要在官方五秒 staleTime 内复用，否则多个页面会反复拉起同一路径的 Git 子进程。
  assert.equal(failedDiscoveryCount, 1);
  const pendingManager = {
    getStableMetadata() {
      return new Promise(() => {});
    },
  };
  // 即使同时探测的目录都未返回，缓存仍必须保持硬上限，后台 Git 任务也只能有四个处于执行态。
  for (let index = 0; index < 300; index += 1) {
    void hiddenFixture.resolveOrigin(`/pending/${index}`, pendingManager, { id: "local" });
  }
  assert.equal(hiddenFixture.originCache.size, 256);
  assert.equal(hiddenFixture.originActive(), 4);
  assert.equal(hiddenFixture.originQueued(), 252);
  const desktopFixture = createFixture({ env: {} }, () => null, require);
  assert.deepEqual(await desktopFixture.run("/repo", [], localHost), {
    preflightDeadline: 60_000,
    timeout: 60_000,
  });
  // 非隐藏官方运行时完全保留原来的 discovery 判断。
  assert.equal(await desktopFixture.shouldDiscover("/missing", missingHost, pathApi), true);

  // 二次执行必须完整识别已改写结构，不能继续增加 wrapper 或改变缓存内容。
  const second = optimizer.optimize(bundleDir);
  assert.equal(second.gitDiscovery, "gateway-coalesced");
  assert.equal(second.patchedFileCount, 0);
  assert.equal(fs.readFileSync(workerPath, "utf8"), optimized);
});

test("runtime optimizer coalesces slow worktree shell environment reads in the hidden gateway", async (t) => {
  const bundleDir = temporaryDirectory(t);
  const mainPath = path.join(bundleDir, ".vite", "build", "main.js");
  writeFile(
    mainPath,
    'var services={"worktree-shell-environment-config":async({cwd:e,hostId:t})=>{' +
      "let r=manager;return{shellEnvironment:await r(e,t)}}}"
  );
  const optimizer = new OfficialRuntimeOptimizer({ fileSystem: new OfficialBundleFileSystem() });

  assert.deepEqual(optimizer.optimize(bundleDir), {
    nativePetComposition: "not-present",
    nativePetPrewarm: "not-present",
    macPushRegistration: "not-present",
    patchedFileCount: 1,
    unsupportedFiles: [],
    worktreeShellEnvironment: "gateway-coalesced",
  });
  const optimized = fs.readFileSync(mainPath, "utf8");
  assert.match(optimized, /__opencodexWorktreeShellEnvironmentCache/);
  assert.match(optimized, /shellEnvironment:null/);

  const createHandler = new Function(
    "process",
    "manager",
    `${optimized};return services["worktree-shell-environment-config"]`
  );
  let hiddenCallCount = 0;
  let resolveHidden;
  const hiddenHandler = createHandler(
    { env: { OPENCODEX_GATEWAY_HIDDEN_RUNTIME: "1" } },
    () => {
      hiddenCallCount += 1;
      return new Promise((resolve) => {
        resolveHidden = resolve;
      });
    }
  );
  const first = hiddenHandler({ cwd: "/workspace", hostId: "local" });
  const second = hiddenHandler({ cwd: "/workspace", hostId: "local" });
  await Promise.resolve();
  assert.equal(hiddenCallCount, 1);
  resolveHidden({ PATH: "/bin" });
  assert.deepEqual(await first, { shellEnvironment: { PATH: "/bin" } });
  assert.deepEqual(await second, { shellEnvironment: { PATH: "/bin" } });
  assert.deepEqual(await hiddenHandler({ cwd: "/workspace", hostId: "local" }), {
    shellEnvironment: { PATH: "/bin" },
  });
  assert.equal(hiddenCallCount, 1);

  let fireTimeout;
  let rejectSlowRead;
  let slowCallCount = 0;
  const slowHandler = new Function(
    "process",
    "manager",
    "setTimeout",
    "clearTimeout",
    `${optimized};return services["worktree-shell-environment-config"]`
  )(
    { env: { OPENCODEX_GATEWAY_HIDDEN_RUNTIME: "1" } },
    () => {
      slowCallCount += 1;
      return new Promise((_resolve, reject) => {
        rejectSlowRead = reject;
      });
    },
    (callback) => {
      fireTimeout = callback;
      return { unref() {} };
    },
    () => {}
  );
  const timedOut = slowHandler({ cwd: "/slow", hostId: "local" });
  await Promise.resolve();
  fireTimeout();
  assert.deepEqual(await timedOut, { shellEnvironment: null });
  rejectSlowRead(new Error("late shell failure"));
  await Promise.resolve();
  await Promise.resolve();
  // 超时后的迟到失败必须保留降级退避，不能立刻启动第二个相同 shell 读取。
  assert.deepEqual(await slowHandler({ cwd: "/slow", hostId: "local" }), {
    shellEnvironment: null,
  });
  assert.equal(slowCallCount, 1);

  let desktopCallCount = 0;
  const desktopHandler = createHandler({ env: {} }, async () => {
    desktopCallCount += 1;
    return { PATH: "/usr/bin" };
  });
  await desktopHandler({ cwd: "/workspace", hostId: "local" });
  await desktopHandler({ cwd: "/workspace", hostId: "local" });
  assert.equal(desktopCallCount, 2);

  const secondOptimization = optimizer.optimize(bundleDir);
  assert.equal(secondOptimization.worktreeShellEnvironment, "gateway-coalesced");
  assert.equal(secondOptimization.patchedFileCount, 0);
  assert.equal(fs.readFileSync(mainPath, "utf8"), optimized);
});

test("runtime optimizer reports an unsupported Git discovery layout without partial assumptions", (t) => {
  const bundleDir = temporaryDirectory(t);
  const workerPath = path.join(bundleDir, ".vite", "build", "worker-new-layout.js");
  const source = "logger.info(`[git-origins] worker-complete`)";
  writeFile(workerPath, source);
  const optimizer = new OfficialRuntimeOptimizer({ fileSystem: new OfficialBundleFileSystem() });

  assert.deepEqual(optimizer.optimize(bundleDir), {
    nativePetComposition: "not-present",
    nativePetPrewarm: "not-present",
    macPushRegistration: "not-present",
    patchedFileCount: 0,
    unsupportedFiles: ["worker-new-layout.js:git-discovery"],
    gitDiscovery: "unsupported-layout",
  });
  assert.equal(fs.readFileSync(workerPath, "utf8"), source);
});

test("runtime optimizer reports an unsupported macOS push layout without unsafe rewriting", (t) => {
  const bundleDir = temporaryDirectory(t);
  const mainPath = path.join(bundleDir, ".vite", "build", "main-push-changed.js");
  const source = 'logger.warning("Failed to register macOS push notifications");';
  writeFile(mainPath, source);
  const optimizer = new OfficialRuntimeOptimizer({ fileSystem: new OfficialBundleFileSystem() });

  assert.deepEqual(optimizer.optimize(bundleDir), {
    nativePetComposition: "not-present",
    nativePetPrewarm: "not-present",
    macPushRegistration: "unsupported-layout",
    patchedFileCount: 0,
    unsupportedFiles: ["main-push-changed.js:mac-push"],
  });
  assert.equal(fs.readFileSync(mainPath, "utf8"), source);
});

test("runtime optimizer leaves bundles without native pet composition unchanged", (t) => {
  const bundleDir = temporaryDirectory(t);
  const mainPath = path.join(bundleDir, ".vite", "build", "main-fixture.js");
  writeFile(mainPath, "module.exports = { ok: true };");
  const optimizer = new OfficialRuntimeOptimizer({
    fileSystem: new OfficialBundleFileSystem(),
  });

  assert.deepEqual(optimizer.optimize(bundleDir), {
    nativePetComposition: "not-present",
    nativePetPrewarm: "not-present",
    macPushRegistration: "not-present",
    patchedFileCount: 0,
    unsupportedFiles: [],
  });
  assert.equal(fs.readFileSync(mainPath, "utf8"), "module.exports = { ok: true };");
});

test("runtime optimizer disables removed native pet points without degrading new official runtimes", (t) => {
  const bundleDir = temporaryDirectory(t);
  writeFile(path.join(bundleDir, ".vite", "build", "main.js"), "module.exports = { ok: true };");
  const compatibilityService = createCompatibilityService();
  const optimizer = new OfficialRuntimeOptimizer({
    fileSystem: new OfficialBundleFileSystem(),
    compatibilityService,
  });

  try {
    optimizer.optimize(bundleDir);
    // 新版完全移除 Native Pet 时没有可执行补丁，三个点都应显示为不适用而不是降级。
    for (const pointId of [
      "static.cache.main.native-pet.factory",
      "static.cache.main.native-pet.prewarm",
      "static.cache.main.native-pet.restore",
    ]) {
      assert.equal(compatibilityService.registry.point(pointId).status, "disabled");
    }
  } finally {
    compatibilityService.dispose();
  }
});

test("cached optimization preserves removed native pet points as disabled", () => {
  const compatibilityService = createCompatibilityService();
  const provider = new LocalCodexBundleProvider({ compatibilityService });

  try {
    provider.reportCachedOptimizationCompatibility({
      nativePetComposition: "not-present",
      nativePetPrewarm: "not-present",
      macPushRegistration: "gateway-disabled",
      patchedFileCount: 0,
      unsupportedFiles: [],
    });
    // 缓存命中不能把首次扫描得到的“不适用”重新解释成“不支持”。
    for (const pointId of [
      "static.cache.main.native-pet.factory",
      "static.cache.main.native-pet.prewarm",
      "static.cache.main.native-pet.restore",
    ]) {
      assert.equal(compatibilityService.registry.point(pointId).status, "disabled");
    }
  } finally {
    compatibilityService.dispose();
  }
});

test("runtime optimizer keeps gateway compatible when an official native pet layout changes", (t) => {
  const bundleDir = temporaryDirectory(t);
  const mainPath = path.join(bundleDir, ".vite", "build", "main-new-layout.js");
  writeFile(mainPath, 'console.log("Native pet material attachment completed");');
  const compatibilityService = createCompatibilityService();
  const optimizer = new OfficialRuntimeOptimizer({
    fileSystem: new OfficialBundleFileSystem(),
    compatibilityService,
  });

  assert.deepEqual(optimizer.optimize(bundleDir), {
    nativePetComposition: "unsupported-layout",
    nativePetPrewarm: "unsupported-layout",
    macPushRegistration: "not-present",
    patchedFileCount: 0,
    unsupportedFiles: ["main-new-layout.js:native-bridge,prewarm"],
  });
  assert.equal(
    fs.readFileSync(mainPath, "utf8"),
    'console.log("Native pet material attachment completed");'
  );
  // 能力仍存在但定位器失配时继续报告真实降级，不能被“新版不适用”分支掩盖。
  for (const pointId of [
    "static.cache.main.native-pet.factory",
    "static.cache.main.native-pet.prewarm",
    "static.cache.main.native-pet.restore",
  ]) {
    assert.equal(compatibilityService.registry.point(pointId).status, "degraded");
  }
  compatibilityService.dispose();
});

test("runtime optimizer reports unsupported when any native pet marker file cannot be fully patched", (t) => {
  const bundleDir = temporaryDirectory(t);
  const buildDir = path.join(bundleDir, ".vite", "build");
  const supportedPath = path.join(buildDir, "main-supported.js");
  const unsupportedPath = path.join(buildDir, "main-unsupported.js");
  const supportedSource =
    "function L_e({devAppPath:e,platform:t=process.platform}={}){" +
    "if(t!==`darwin`)return null;return{log:`Native pet material attachment completed`}}" +
    "class Pet{async prewarm(e){if(this.window!=null||this.openingWindowPromise!=null||this.isAppQuitting)return;this.open(e)}}";
  writeFile(supportedPath, supportedSource);
  writeFile(unsupportedPath, 'console.log("Native pet material attachment completed");');
  const optimizer = new OfficialRuntimeOptimizer({
    fileSystem: new OfficialBundleFileSystem(),
  });

  // 多个官方产物只要有一个布局不受支持，聚合状态就必须触发上层兼容性告警。
  assert.deepEqual(optimizer.optimize(bundleDir), {
    nativePetComposition: "unsupported-layout",
    nativePetPrewarm: "unsupported-layout",
    macPushRegistration: "not-present",
    patchedFileCount: 1,
    unsupportedFiles: ["main-unsupported.js:native-bridge,prewarm"],
  });
  assert.match(
    fs.readFileSync(supportedPath, "utf8"),
    /process\.env\.OPENCODEX_GATEWAY_HIDDEN_RUNTIME===`1`/
  );
  assert.equal(
    fs.readFileSync(unsupportedPath, "utf8"),
    'console.log("Native pet material attachment completed");'
  );
});

test("Windows unpacked fallback merges into an existing runtime bundle", (t) => {
  const root = temporaryDirectory(t);
  const sourceDir = path.join(root, "app.asar.unpacked");
  const targetDir = path.join(root, "bundle");
  const previousCpSync = fs.cpSync;

  // 目标工作副本已经包含 ASAR 解压结果；fallback 只能覆盖同名文件，不能删除其它运行时内容。
  writeFile(path.join(targetDir, ".vite", "build", "bootstrap.js"), "bootstrap");
  writeFile(path.join(targetDir, "webview", "index.html"), "webview");
  writeFile(path.join(targetDir, "node_modules", "existing", "index.js"), "existing");
  writeFile(path.join(targetDir, "node_modules", "shared", "binding.node"), "old-native");
  writeFile(path.join(sourceDir, "node_modules", "shared", "binding.node"), "new-native");
  writeFile(path.join(sourceDir, "node_modules", "added", "binding.node"), "added-native");

  try {
    fs.cpSync = () => {
      const error = new Error("UNKNOWN: unknown error, copyfile");
      error.code = "UNKNOWN";
      throw error;
    };

    const fileSystem = new OfficialBundleFileSystem({ platform: "win32" });
    fileSystem.copyTree(sourceDir, targetDir);
  } finally {
    fs.cpSync = previousCpSync;
  }

  assert.equal(fs.readFileSync(path.join(targetDir, ".vite", "build", "bootstrap.js"), "utf8"), "bootstrap");
  assert.equal(fs.readFileSync(path.join(targetDir, "webview", "index.html"), "utf8"), "webview");
  assert.equal(fs.readFileSync(path.join(targetDir, "node_modules", "existing", "index.js"), "utf8"), "existing");
  assert.equal(fs.readFileSync(path.join(targetDir, "node_modules", "shared", "binding.node"), "utf8"), "new-native");
  assert.equal(fs.readFileSync(path.join(targetDir, "node_modules", "added", "binding.node"), "utf8"), "added-native");
});

test("Windows Appx manifest selects ChatGPT for new packages and Codex for legacy packages", (t) => {
  const packageRoot = temporaryDirectory(t);
  const appRoot = path.join(packageRoot, "app");
  const manifestPath = path.join(packageRoot, "AppxManifest.xml");
  const chatGptExecutable = path.join(appRoot, "ChatGPT.exe");
  const codexExecutable = path.join(appRoot, "Codex.exe");
  const helperExecutable = path.join(packageRoot, "tools", "Helper.exe");
  writeFile(chatGptExecutable);
  writeFile(codexExecutable);
  writeFile(helperExecutable);

  // 属性顺序与额外 application 均不应影响 Id=App 的权威选择。
  writeFile(
    manifestPath,
    `<Package><Applications><Application Executable="tools/Helper.exe" Id="Helper"/><Application EntryPoint="Windows.FullTrustApplication" Executable="app/ChatGPT.exe" Id="App"/></Applications></Package>`
  );
  assert.equal(layoutTest.windowsManifestExecutablePath(appRoot), chatGptExecutable);

  writeFile(
    manifestPath,
    `<Package><Applications><Application Id="App" Executable="app/Codex.exe" EntryPoint="Windows.FullTrustApplication"/></Applications></Package>`
  );
  assert.equal(layoutTest.windowsManifestExecutablePath(appRoot), codexExecutable);
});

test("Windows Appx manifest rejects escaped paths and falls back to ChatGPT before Codex", (t) => {
  const packageRoot = temporaryDirectory(t);
  const appRoot = path.join(packageRoot, "app");
  const manifestPath = path.join(packageRoot, "AppxManifest.xml");
  const chatGptExecutable = path.join(appRoot, "ChatGPT.exe");
  const codexExecutable = path.join(appRoot, "Codex.exe");
  const helperExecutable = path.join(packageRoot, "tools", "Helper.exe");
  writeFile(chatGptExecutable);
  writeFile(codexExecutable);
  writeFile(helperExecutable);
  writeFile(
    manifestPath,
    `<Package><Applications><Application Id="App" Executable="../outside.exe"/></Applications></Package>`
  );

  assert.equal(layoutTest.windowsManifestExecutablePath(appRoot), "");
  const candidates = layoutTest.windowsElectronExecutableCandidates(appRoot);
  assert.ok(candidates.indexOf(chatGptExecutable) < candidates.indexOf(codexExecutable));
  assert.equal(layoutTest.safeAppxExecutablePath({ packageRoot, executable: "C:\\Windows\\System32\\cmd.exe" }), "");

  // manifest 指向缺失的新入口或完全不存在时，候选列表仍应回退到旧版 Codex.exe。
  fs.rmSync(chatGptExecutable);
  writeFile(
    manifestPath,
    `<Package><Applications><Application Id="Helper" Executable="tools/Helper.exe"/><Application Id="App" Executable="app/ChatGPT.exe"/></Applications></Package>`
  );
  // Id=App 已存在时不得误选仍然存在的 helper application。
  assert.equal(layoutTest.windowsManifestExecutablePath(appRoot), "");
  assert.equal(layoutTest.windowsElectronExecutableCandidates(appRoot).find(fs.existsSync), codexExecutable);
  fs.rmSync(manifestPath);
  assert.equal(layoutTest.windowsManifestExecutablePath(appRoot), "");
});

test("macOS layout reads both ChatGPT and Codex executables from Info.plist", (t) => {
  const root = temporaryDirectory(t);

  for (const appName of ["ChatGPT", "Codex"]) {
    const appRoot = path.join(root, `${appName}.app`);
    writeFile(
      path.join(appRoot, "Contents", "Info.plist"),
      `<plist><dict><key>CFBundleExecutable</key><string>${appName}</string></dict></plist>`
    );
    writeFile(path.join(appRoot, "Contents", "MacOS", appName));
    writeFile(path.join(appRoot, "Contents", "Resources", "app.asar"));
    fs.mkdirSync(path.join(appRoot, "Contents", "Frameworks"), { recursive: true });

    const layout = layoutTest.macRuntimeLayoutFromAppRoot(appRoot);
    assert.equal(layout.executablePath, path.join(appRoot, "Contents", "MacOS", appName));
  }
});

test("macOS runner embeds its current ASAR header hash before signing, including cache reuse", async (t) => {
  const root = temporaryDirectory(t);
  const appRoot = path.join(root, "ChatGPT.app");
  const layout = {
    appRoot,
    executablePath: path.join(appRoot, "Contents", "MacOS", "ChatGPT"),
    asarPath: path.join(appRoot, "Contents", "Resources", "app.asar"),
    frameworksDir: path.join(appRoot, "Contents", "Frameworks"),
  };
  writeFile(layout.executablePath, "official executable");
  writeFile(layout.asarPath, "official archive must remain unchanged");
  fs.mkdirSync(layout.frameworksDir, { recursive: true });
  const runtimeDir = path.join(root, "runtime");
  const logs = [];
  const hashes = [];

  for (const revision of [1, 2]) {
    const points = [];
    await createMacRunner({
      layout,
      runtimeDir,
      logger: (line) => logs.push(line),
      runCompatibility(point, operation) {
        points.push(point.id);
        if (point === runnerPoints.gatewayAsar) {
          return (async () => {
            const asarPath = await operation();
            // 模拟入口升级，让第二次构建的哈希发生变化，覆盖 Frameworks 缓存命中后的重新计算。
            const sourceDir = path.join(runtimeDir, "official-electron-runner", "app-src");
            fs.appendFileSync(path.join(sourceDir, "main.cjs"), `\n// fixture revision ${revision}\n`);
            await asar.createPackage(sourceDir, asarPath);
            return asarPath;
          })();
        }
        if (point === runnerPoints.macosEntrySignature) {
          // 只替换平台签名操作；真实执行打包与 plist 生成，并在签名前检查最终产物。
          const workDir = path.join(runtimeDir, "official-electron-runner");
          const runnerApp = fs.readdirSync(workDir).find((name) => name.endsWith(".app"));
          const contentsDir = path.join(workDir, runnerApp, "Contents");
          const asarPath = path.join(contentsDir, "Resources", "app.asar");
          const hash = crypto.createHash("sha256").update(asar.getRawHeader(asarPath).headerString).digest("hex");
          const plist = fs.readFileSync(path.join(contentsDir, "Info.plist"), "utf8");
          assert.match(plist, /<key>ElectronAsarIntegrity<\/key>\s*<dict>\s*<key>Resources\/app\.asar<\/key>\s*<dict>\s*<key>algorithm<\/key>\s*<string>SHA256<\/string>\s*<key>hash<\/key>/);
          assert.ok(plist.includes(`<string>${hash}</string>`));
          assert.match(plist, /<key>LSBackgroundOnly<\/key>\s*<true\/>/);
          hashes.push(hash);
          return;
        }
        return operation();
      },
    });
    assert.deepEqual(points, [runnerPoints.gatewayAsar.id, runnerPoints.macosBackgroundBundle.id, runnerPoints.macosEntrySignature.id]);
  }

  assert.notEqual(hashes[0], hashes[1]);
  assert.ok(logs.some((line) => line.includes("Frameworks cache hit")));
  assert.equal(fs.readFileSync(layout.asarPath, "utf8"), "official archive must remain unchanged");
  assert.equal(fs.readFileSync(layout.executablePath, "utf8"), "official executable");
});

test("Linux executable candidates retain Codex names and add electron fallback", () => {
  const appRoot = "/opt/codex-app";
  const candidates = layoutTest.linuxElectronExecutableCandidates(appRoot);

  assert.ok(candidates.includes(path.join(appRoot, "codex")));
  assert.ok(candidates.includes(path.join(appRoot, "Codex")));
  assert.ok(candidates.includes(path.join(appRoot, "codex-desktop")));
  assert.ok(candidates.includes(path.join(appRoot, "electron")));
});
