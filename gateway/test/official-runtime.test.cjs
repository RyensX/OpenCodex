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

test("recognizes app-server after official Codex global options", () => {
  // 官方 Desktop 会按版本在子命令前插入全局配置，hook 需要兼容两种参数布局。
  assert.equal(__test.isHiddenOfficialAppServerArgs(["app-server", "--analytics-default-enabled"]), true);
  assert.equal(
    __test.isHiddenOfficialAppServerArgs([
      "-c",
      "features.code_mode_host=true",
      "app-server",
      "--analytics-default-enabled",
    ]),
    true
  );
  assert.equal(__test.isHiddenOfficialAppServerArgs(["exec", "app-server-like-value"]), false);
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

test("sidebar bootstrap accepts only the synchronous renderer-safe shape", () => {
  const bootstrap = {
    catalogSnapshot: { revision: 7, isComplete: true, hosts: [], entries: [] },
    globalStateEntries: [{ key: "pinned-thread-ids", value: [] }],
    projectlessWorkspaceRoot: { workspaceRoot: null },
    workspaceRootOptions: [],
  };

  // 合法快照必须原样保留；Promise 或缺失数组字段都不能交给 renderer 同步遍历。
  assert.equal(__test.normalizeInitialSidebarBootstrap(bootstrap), bootstrap);
  assert.equal(__test.normalizeInitialSidebarBootstrap(Promise.resolve(bootstrap)), null);
  assert.equal(__test.normalizeInitialSidebarBootstrap({ globalStateEntries: {} }), null);
  assert.equal(__test.normalizeInitialSidebarBootstrap(null), null);
});

test("official chunked messages are acknowledged and restored before browser routing", () => {
  const receiver = new __test.OfficialChunkedMessageReceiver();
  const marker = "codex-host-chunked-message-v1";

  const started = receiver.receive({
    marker,
    transferId: "transfer-1",
    sequence: 4,
    kind: "start",
  });
  assert.deepEqual(started, {
    type: "pending",
    acknowledgement: { transferId: "transfer-1", sequence: 4 },
  });

  const chunked = receiver.receive({
    marker,
    transferId: "transfer-1",
    sequence: 5,
    kind: "chunk",
    tokens: [
      { type: "object-start" },
      { type: "key", value: "type" },
      { type: "value", value: "fetch-response" },
      { type: "key", value: "body" },
      { type: "string-start", target: "value" },
      { type: "string-chunk", value: "large-" },
      { type: "string-chunk", value: "payload" },
      { type: "string-end" },
      { type: "key", value: "optional" },
      // 官方协议用缺失 value 字段表示 undefined，接收器必须保留而不是拒绝整个分块。
      { type: "value" },
      { type: "container-end" },
    ],
  });
  assert.deepEqual(chunked, {
    type: "pending",
    acknowledgement: { transferId: "transfer-1", sequence: 5 },
  });

  const completed = receiver.receive({
    marker,
    transferId: "transfer-1",
    sequence: 6,
    kind: "end",
  });
  assert.deepEqual(completed, {
    type: "complete",
    acknowledgement: { transferId: "transfer-1", sequence: 6 },
    message: { type: "fetch-response", body: "large-payload", optional: undefined },
  });
});

test("official chunk receiver rejects an out-of-order continuation without acknowledging it", () => {
  const receiver = new __test.OfficialChunkedMessageReceiver();
  const marker = "codex-host-chunked-message-v1";
  receiver.receive({ marker, transferId: "transfer-2", sequence: 0, kind: "start" });

  // 序号不连续时必须和官方 preload 一样停止确认，避免把已损坏的消息误组装后交给 renderer。
  assert.deepEqual(
    receiver.receive({
      marker,
      transferId: "transfer-2",
      sequence: 2,
      kind: "chunk",
      tokens: [{ type: "value", value: null }],
    }),
    { type: "pending", acknowledgement: null }
  );
});
