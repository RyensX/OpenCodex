const assert = require("node:assert/strict");
const test = require("node:test");
const {
  openFileTargetFromIpc,
  openFileTargetFromPayload,
} = require("../runtime/ipc/open-file-context.cjs");

test("extracts open-file target from direct IPC payloads", () => {
  assert.equal(openFileTargetFromIpc("open-file", { path: "/tmp/a.txt", target: "fileManager" }), "fileManager");
  assert.equal(
    openFileTargetFromIpc("open-file", { params: { path: "/tmp/a.txt", target: "fileManager" } }),
    "fileManager"
  );
  assert.equal(openFileTargetFromPayload([{ target: "vscode" }]), "vscode");
});

test("extracts open-file target from vscode fetch payloads", () => {
  const payload = {
    type: "fetch",
    url: "vscode://codex/open-file",
    body: JSON.stringify({
      path: "/tmp/a.txt",
      target: "fileManager",
    }),
  };

  // 官方菜单点击会先被 vscode-api 包成 fetch，再通过 message-from-view 发给 main。
  assert.equal(openFileTargetFromIpc("codex_desktop:message-from-view", payload), "fileManager");
});

test("ignores non open-file fetch payloads", () => {
  assert.equal(
    openFileTargetFromIpc("codex_desktop:message-from-view", {
      type: "fetch",
      url: "vscode://codex/open-in-targets",
      body: JSON.stringify({ target: "fileManager" }),
    }),
    ""
  );
  assert.equal(
    openFileTargetFromIpc("codex_desktop:message-from-view", {
      type: "fetch",
      url: "vscode://codex/open-file",
      body: "{",
    }),
    ""
  );
});
