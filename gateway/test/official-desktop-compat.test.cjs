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
const {
  LEGACY_RUNTIME_ENTRY_PATH,
  OfficialRuntimeEntryResolver,
} = require("../dist/official/OfficialRuntimeEntryResolver.js");
const { __test: layoutTest } = require("../runner/official-layout.cjs");

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
    "/Users/example/Applications/ChatGPT.app",
    "/Applications/Codex.app",
    "/Users/example/Applications/Codex.app",
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

test("schema 4 cache resolves both dynamic and legacy bootstrap paths", (t) => {
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
    schemaVersion: 4,
    sourceAsarPath,
    sourceResourcesPath,
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
