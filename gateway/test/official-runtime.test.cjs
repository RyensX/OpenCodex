const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { openFileTargetFromIpc } = require("../runtime/ipc/open-file-context.cjs");
const { __test } = require("../runtime/ipc/official-runtime.cjs");
const { __test: portableRunnerTest } = require("../runner/platform/portable.cjs");

test("remote file manager interception condition is target and host based", () => {
  assert.equal(
    __test.shouldInterceptRemoteFileManagerStore({
      isLoopbackBrowserHost: false,
      openFileTarget: "fileManager",
    }),
    true
  );
  assert.equal(
    __test.shouldInterceptRemoteFileManagerStore({
      isLoopbackBrowserHost: true,
      openFileTarget: "fileManager",
    }),
    false
  );
  assert.equal(
    __test.shouldInterceptRemoteFileManagerStore({
      isLoopbackBrowserHost: false,
      openFileTarget: "vscode",
    }),
    false
  );
});

test("recognizes platform file manager spawn targets", () => {
  // macOS 官方实现用 open -R 定位文件；其它平台适配只负责提取路径，业务条件仍由统一 helper 判断。
  assert.equal(__test.fileManagerPathFromSpawn("open", ["-R", "/tmp/report.txt"]), "/tmp/report.txt");
  assert.equal(__test.fileManagerPathFromSpawn("open", ["/tmp/report.txt"]), "");
  assert.equal(__test.fileManagerPathFromSpawn("xdg-open", ["/tmp/report.txt"]), "/tmp/report.txt");
  assert.equal(__test.fileManagerPathFromSpawn("node", ["script.js"]), "");
});

test("vscode fetch open-file payloads feed the same interception condition", () => {
  const openFileTarget = openFileTargetFromIpc("codex_desktop:message-from-view", {
    type: "fetch",
    url: "vscode://codex/open-file",
    body: JSON.stringify({ path: "/tmp/report.txt", target: "fileManager" }),
  });
  assert.equal(
    __test.shouldInterceptRemoteFileManagerStore({
      isLoopbackBrowserHost: false,
      openFileTarget,
    }),
    true
  );
});

test("synthesizes Windows version assembly manifest when copyfile fails", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodex-runner-manifest-"));
  const targetPath = path.join(tmpDir, "149.0.7827.197.manifest");
  const previousCpSync = fs.cpSync;
  const logs = [];
  try {
    // 模拟 WindowsApps 中版本号 manifest 可 stat 但 copyfile 返回 UNKNOWN 的用户环境。
    fs.cpSync = () => {
      const error = new Error("UNKNOWN: unknown error, copyfile");
      error.code = "UNKNOWN";
      throw error;
    };

    const result = portableRunnerTest.copyPortableRuntimeEntry({
      entry: {
        name: "149.0.7827.197.manifest",
        isFile: () => true,
      },
      sourcePath: "D:\\WindowsApps\\OpenAI.Codex\\app\\149.0.7827.197.manifest",
      targetPath,
      logger: (line) => logs.push(line),
      platform: "win32",
    });

    assert.deepEqual(result, { copied: false, synthesized: true });
    const manifest = fs.readFileSync(targetPath, "utf8");
    assert.match(manifest, /name='149\.0\.7827\.197'/);
    assert.match(manifest, /version='149\.0\.7827\.197'/);
    assert.match(manifest, /<file name='chrome_elf\.dll'\/>/);
    assert.match(logs.join(""), /synthesized Windows assembly manifest/);
  } finally {
    fs.cpSync = previousCpSync;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("keeps non-version manifest copy failures fatal", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodex-runner-manifest-"));
  const previousCpSync = fs.cpSync;
  try {
    // 只有 Chromium 版本号 assembly manifest 能安全重建，其它复制错误仍要暴露给启动日志。
    fs.cpSync = () => {
      const error = new Error("access denied");
      error.code = "EACCES";
      throw error;
    };

    assert.throws(
      () =>
        portableRunnerTest.copyPortableRuntimeEntry({
          entry: {
            name: "Codex.exe.manifest",
            isFile: () => true,
          },
          sourcePath: "D:\\WindowsApps\\OpenAI.Codex\\app\\Codex.exe.manifest",
          targetPath: path.join(tmpDir, "Codex.exe.manifest"),
          platform: "win32",
        }),
      /access denied/
    );
  } finally {
    fs.cpSync = previousCpSync;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
