const assert = require("node:assert/strict");
const test = require("node:test");
const { openFileTargetFromIpc } = require("../runtime/ipc/open-file-context.cjs");
const { __test } = require("../runtime/ipc/official-runtime.cjs");

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

test("recognizes official app-server arguments after global config flags", () => {
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
  assert.equal(__test.isHiddenOfficialAppServerArgs(["-c", "app-server"]), false);
  assert.equal(__test.isHiddenOfficialAppServerArgs(["exec", "app-server"]), false);
});

test("shares the official live IPC bus unless isolation is explicitly requested", () => {
  assert.equal(__test.shouldIsolateOfficialLiveIpc({}), false);
  assert.equal(__test.shouldIsolateOfficialLiveIpc({ CODEX_WEB_ISOLATE_OFFICIAL_LIVE_IPC: "0" }), false);
  assert.equal(__test.shouldIsolateOfficialLiveIpc({ CODEX_WEB_ISOLATE_OFFICIAL_LIVE_IPC: "1" }), true);
});

test("drops corrupted thread stream snapshots from stale browser clients", () => {
  const channel = "codex_desktop:message-from-view";
  assert.equal(
    __test.shouldDropCorruptedThreadStreamStateChange(channel, [
      {
        type: "thread-stream-state-changed",
        conversationId: "thread-1",
        change: {
          type: "snapshot",
          conversationState: {
            currentPermissions: { runtimeWorkspaceRoots: ["C:\\workspace"] },
            latestThreadSettings: { runtimeWorkspaceRoots: "[Circular]" },
          },
        },
      },
    ]),
    true
  );
  assert.equal(
    __test.shouldDropCorruptedThreadStreamStateChange(channel, [
      {
        type: "thread-stream-state-changed",
        change: {
          type: "snapshot",
          conversationState: { runtimeWorkspaceRoots: ["C:\\workspace"], title: "[Circular]" },
        },
      },
    ]),
    false
  );
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
