const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  CodexAsarScanner,
  CodexAsarCandidateProvider,
} = require("../dist/official/CodexAsarScanner.js");
const { AsarWebviewExtractor } = require("../dist/official/AsarWebviewExtractor.js");
const { OfficialBundleCache } = require("../dist/official/OfficialBundleCache.js");
const { OfficialBundleFileSystem } = require("../dist/official/OfficialBundleFileSystem.js");
const { OfficialRuntimeOptimizer } = require("../dist/official/OfficialRuntimeOptimizer.js");
const {
  LEGACY_RUNTIME_ENTRY_PATH,
  OfficialRuntimeEntryResolver,
} = require("../dist/official/OfficialRuntimeEntryResolver.js");
const { __test: layoutTest } = require("../runner/official-layout.cjs");
const { MANIFEST_SCHEMA_VERSION } = require("../dist/official/constants.js");

function temporaryDirectory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodex-desktop-compat-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeFile(filePath, content = "fixture") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

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

  // 已识别部分仍安全改写，但 manifest 必须明确告警，不能把混合新旧布局误报为全部成功。
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

test("runtime optimizer keeps gateway compatible when an official native pet layout changes", (t) => {
  const bundleDir = temporaryDirectory(t);
  const mainPath = path.join(bundleDir, ".vite", "build", "main-new-layout.js");
  writeFile(mainPath, 'console.log("Native pet material attachment completed");');
  const optimizer = new OfficialRuntimeOptimizer({
    fileSystem: new OfficialBundleFileSystem(),
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

test("Linux executable candidates retain Codex names and add electron fallback", () => {
  const appRoot = "/opt/codex-app";
  const candidates = layoutTest.linuxElectronExecutableCandidates(appRoot);

  assert.ok(candidates.includes(path.join(appRoot, "codex")));
  assert.ok(candidates.includes(path.join(appRoot, "Codex")));
  assert.ok(candidates.includes(path.join(appRoot, "codex-desktop")));
  assert.ok(candidates.includes(path.join(appRoot, "electron")));
});
