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

test("falls back to read/write copy for WindowsApps encrypted runtime files", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodex-runner-copy-"));
  const sourcePath = path.join(tmpDir, "chrome.dll");
  const targetPath = path.join(tmpDir, "runner", "chrome.dll");
  const previousCpSync = fs.cpSync;
  const logs = [];
  try {
    fs.writeFileSync(sourcePath, "encrypted-runtime-content");
    fs.cpSync = () => {
      const error = new Error("UNKNOWN: unknown error, copyfile");
      error.code = "UNKNOWN";
      throw error;
    };

    const result = portableRunnerTest.copyPortableRuntimeEntry({
      entry: {
        name: "chrome.dll",
        isFile: () => true,
      },
      sourcePath,
      targetPath,
      logger: (line) => logs.push(line),
      platform: "win32",
    });

    assert.deepEqual(result, { copied: true, synthesized: false });
    assert.equal(fs.readFileSync(targetPath, "utf8"), "encrypted-runtime-content");
    assert.match(logs.join(""), /read\/write fallback/);
  } finally {
    fs.cpSync = previousCpSync;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("falls back to recursive read/write copy for WindowsApps encrypted runtime directories", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodex-runner-dir-"));
  const sourcePath = path.join(tmpDir, "angledata");
  const targetPath = path.join(tmpDir, "runner", "angledata");
  const previousCpSync = fs.cpSync;
  const logs = [];
  try {
    fs.mkdirSync(sourcePath, { recursive: true });
    fs.writeFileSync(path.join(sourcePath, "VkICD_mock_icd.json"), "{\"ok\":true}");
    fs.cpSync = () => {
      const error = new Error("UNKNOWN: unknown error, copyfile");
      error.code = "UNKNOWN";
      throw error;
    };

    const result = portableRunnerTest.copyPortableRuntimeEntry({
      entry: {
        name: "angledata",
        isFile: () => false,
        isDirectory: () => true,
      },
      sourcePath,
      targetPath,
      logger: (line) => logs.push(line),
      platform: "win32",
    });

    assert.deepEqual(result, { copied: true, synthesized: false });
    assert.equal(fs.readFileSync(path.join(targetPath, "VkICD_mock_icd.json"), "utf8"), "{\"ok\":true}");
    assert.match(logs.join(""), /Windows directory/);
  } finally {
    fs.cpSync = previousCpSync;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("falls back to read/write copy for WindowsApps encrypted runner executable", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodex-runner-exe-"));
  const sourcePath = path.join(tmpDir, "Codex.exe");
  const targetPath = path.join(tmpDir, "OpenCodex.exe");
  const previousCopyFileSync = fs.copyFileSync;
  try {
    fs.writeFileSync(sourcePath, "encrypted-exe-content");
    fs.copyFileSync = () => {
      const error = new Error("UNKNOWN: unknown error, copyfile");
      error.code = "UNKNOWN";
      throw error;
    };

    portableRunnerTest.copyPortableRuntimeExecutable({
      sourcePath,
      targetPath,
      platform: "win32",
    });

    assert.equal(fs.readFileSync(targetPath, "utf8"), "encrypted-exe-content");
  } finally {
    fs.copyFileSync = previousCopyFileSync;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
