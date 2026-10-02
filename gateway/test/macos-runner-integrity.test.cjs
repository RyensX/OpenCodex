const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const asar = require("@electron/asar");
const { createMacRunner } = require("../runner/platform/macos.cjs");
const { refreshMacIntegrity } = require("../runner/platform/macos-integrity.cjs");
const { runner: runnerPoints } = require("../runtime/modification/point-refs.cjs");

function temporaryDirectory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodex-macos-runner-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeFile(file, content = "") {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

// Windows 不执行 macOS runner；其创建符号链接所需权限与本次回归无关。
test("macOS runner refreshes embedded digests and preserves internal links across cache reuse", { skip: process.platform === "win32" }, async (t) => {
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
  // 官方 Framework 带有绑定原版 plist 的摘要，复制后必须更新为 runner 的摘要。
  const framework = path.join(layout.frameworksDir, "Codex Framework.framework");
  const frameworkBinary = path.join(framework, "Versions", "A", "Codex Framework");
  const sentinel = Buffer.from("AGbevlPCksUGKNL8TSn7wGmJEuJsXb2A");
  const officialBinary = Buffer.concat([sentinel, Buffer.from([1, 1]), Buffer.alloc(32, 7)]);
  fs.mkdirSync(path.dirname(frameworkBinary), { recursive: true });
  fs.writeFileSync(frameworkBinary, officialBinary);
  fs.symlinkSync("A", path.join(framework, "Versions", "Current"));
  fs.symlinkSync("Versions/Current/Codex Framework", path.join(framework, "Codex Framework"));
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
          const copiedFramework = path.join(contentsDir, "Frameworks", "Codex Framework.framework", "Codex Framework");
          assert.ok(fs.realpathSync(copiedFramework).startsWith(fs.realpathSync(contentsDir) + path.sep));
          const digest = crypto.createHash("sha256").update("Resources/app.asarSHA256" + hash).digest();
          assert.deepEqual(fs.readFileSync(copiedFramework).subarray(34, 66), digest);
          assert.deepEqual(fs.readFileSync(frameworkBinary), officialBinary);
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

async function integrityFixture(t, binary) {
  const root = temporaryDirectory(t);
  const frameworks = path.join(root, "Frameworks");
  const file = path.join(frameworks, "Codex Framework.framework", "Codex Framework");
  writeFile(file, binary);
  const sourceDir = path.join(root, "source");
  writeFile(path.join(sourceDir, "main.cjs"), "module.exports = 1;");
  const archive = path.join(root, "app.asar");
  await asar.createPackage(sourceDir, archive);
  return { root, frameworks, file, archive };
}

test("embedded digest refresh updates every architecture and is idempotent", async (t) => {
  // Universal 的每个架构各有一个摘要槽，不能只修改首个匹配位置。
  const slot = Buffer.concat([Buffer.from("AGbevlPCksUGKNL8TSn7wGmJEuJsXb2A"), Buffer.from([1, 1]), Buffer.alloc(32)]);
  const fixture = await integrityFixture(t, Buffer.concat([slot, Buffer.from("slice boundary"), slot]));
  assert.deepEqual(refreshMacIntegrity(fixture.frameworks, fixture.archive), [fs.realpathSync(fixture.file)]);
  const headerHash = crypto.createHash("sha256").update(asar.getRawHeader(fixture.archive).headerString).digest("hex");
  const digest = crypto.createHash("sha256").update(`Resources/app.asarSHA256${headerHash}`).digest();
  const updated = fs.readFileSync(fixture.file);
  assert.deepEqual(updated.subarray(34, 66), digest);
  assert.deepEqual(updated.subarray(updated.length - 32), digest);
  assert.deepEqual(refreshMacIntegrity(fixture.frameworks, fixture.archive), []);
});

test("older and disabled framework digests are left untouched", async (t) => {
  for (const binary of [Buffer.from("legacy framework"), Buffer.concat([
    Buffer.from("AGbevlPCksUGKNL8TSn7wGmJEuJsXb2A"), Buffer.from([0, 0]), Buffer.alloc(32),
  ])]) {
    const fixture = await integrityFixture(t, binary);
    assert.deepEqual(refreshMacIntegrity(fixture.frameworks, fixture.archive), []);
    assert.deepEqual(fs.readFileSync(fixture.file), binary);
  }
});

test("unknown enabled digest versions fail without overwriting the binary", async (t) => {
  const binary = Buffer.concat([Buffer.from("AGbevlPCksUGKNL8TSn7wGmJEuJsXb2A"), Buffer.from([1, 2]), Buffer.alloc(32)]);
  const fixture = await integrityFixture(t, binary);
  assert.throws(() => refreshMacIntegrity(fixture.frameworks, fixture.archive), /Unsupported integrity digest version/);
  assert.deepEqual(fs.readFileSync(fixture.file), binary);
});

test("framework links outside the runner are rejected without changing their target", { skip: process.platform === "win32" }, async (t) => {
  // 覆盖旧缓存链接到官方安装目录的实际错误形态。
  const binary = Buffer.concat([Buffer.from("AGbevlPCksUGKNL8TSn7wGmJEuJsXb2A"), Buffer.from([1, 1]), Buffer.alloc(32)]);
  const fixture = await integrityFixture(t, binary);
  const external = path.join(fixture.root, "official-framework");
  fs.renameSync(fixture.file, external);
  fs.symlinkSync(external, fixture.file);
  assert.throws(() => refreshMacIntegrity(fixture.frameworks, fixture.archive), /escapes its cache directory/);
  assert.deepEqual(fs.readFileSync(external), binary);
});

test("a failed signature invalidates the framework cache before retry", async (t) => {
  const root = temporaryDirectory(t);
  const layout = {
    appRoot: path.join(root, "ChatGPT.app"),
    executablePath: path.join(root, "ChatGPT.app", "Contents", "MacOS", "ChatGPT"),
    asarPath: path.join(root, "ChatGPT.app", "Contents", "Resources", "app.asar"),
    frameworksDir: path.join(root, "ChatGPT.app", "Contents", "Frameworks"),
  };
  writeFile(layout.executablePath, "official executable");
  writeFile(layout.asarPath, "official archive");
  fs.mkdirSync(layout.frameworksDir, { recursive: true });
  const runtimeDir = path.join(root, "runtime");
  const logs = [];
  let failSignature = true;
  const options = {
    layout, runtimeDir, logger: (line) => logs.push(line),
    runCompatibility(point, operation) {
      if (point !== runnerPoints.macosEntrySignature) return operation();
      // 模拟系统签名失败，不替换真实打包和缓存流程。
      if (failSignature) throw new Error("fixture codesign failed");
    },
  };
  await assert.rejects(createMacRunner(options), /fixture codesign failed/);
  assert.equal(fs.existsSync(path.join(runtimeDir, "official-electron-runner", "frameworks-manifest.json")), false);
  failSignature = false;
  await createMacRunner(options);
  assert.equal(logs.filter((line) => line.includes("Frameworks copied:")).length, 2);
  assert.equal(logs.some((line) => line.includes("Frameworks cache hit:")), false);
});
