const assert = require("node:assert/strict");
const test = require("node:test");
const { workspaceRootsFromIpcPayload } = require("../runtime/ipc/workspace-root-context.cjs");

test("extracts cwd from nested open-in-targets fetch payloads", () => {
  const payload = {
    type: "fetch",
    url: "vscode://codex/open-in-targets",
    body: JSON.stringify({
      params: {
        cwd: "/tmp/project-a",
        path: "src/index.js",
      },
    }),
  };

  assert.deepEqual(workspaceRootsFromIpcPayload("codex_desktop:message-from-view", payload), ["/tmp/project-a"]);
});

test("extracts workspaceRoot from directory entry payloads", () => {
  const payload = {
    params: {
      directoryPath: "src",
      includeHidden: true,
      workspaceRoot: "/tmp/project-b",
    },
  };

  assert.deepEqual(workspaceRootsFromIpcPayload("workspace-directory-entries", payload), ["/tmp/project-b"]);
});

test("ignores relative roots and cwd values without file tree context", () => {
  assert.deepEqual(
    workspaceRootsFromIpcPayload("codex_desktop:message-from-view", {
      params: { cwd: "relative/project", path: "src/index.js" },
    }),
    []
  );
  assert.deepEqual(
    workspaceRootsFromIpcPayload("codex_desktop:message-from-view", {
      params: { cwd: "/tmp/project-c", prompt: "hello" },
    }),
    []
  );
});

test("bounds wide IPC traversal, handles cycles, and prioritizes protocol envelopes", () => {
  let candidateReads = 0;
  const payload = {};
  payload.self = payload;
  payload.items = Array.from({ length: 2000 }, (_, index) =>
    Object.defineProperty({}, "value", {
      enumerable: true,
      get() {
        candidateReads += 1;
        return index;
      },
    })
  );
  payload.body = JSON.stringify({ params: { cwd: "/tmp/prioritized-project", path: "src/index.js" } });

  assert.deepEqual(
    workspaceRootsFromIpcPayload("codex_desktop:message-from-view", payload),
    ["/tmp/prioritized-project"]
  );
  assert.ok(candidateReads > 0 && candidateReads < 1024);
});
