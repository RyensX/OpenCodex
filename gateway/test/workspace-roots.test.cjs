const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { isAllowedAppFsFile } = require("../runtime/http/local-files.cjs");
const { createWorkspaceRootsService, resolveWorkspaceRoot } = require("../runtime/ipc/workspace-roots.cjs");

function makeTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodex-workspace-root-test-"));
  t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
  return dir;
}

function assertWorkspaceRootError(fn, status, errorKey) {
  assert.throws(fn, (error) => {
    assert.equal(error.status, status);
    assert.equal(error.errorKey, errorKey);
    return true;
  });
}

test("rejects an empty workspace root path", () => {
  assertWorkspaceRootError(() => resolveWorkspaceRoot("  "), 400, "web.workspaceRoot.error.empty");
});

test("rejects a relative workspace root path", () => {
  assertWorkspaceRootError(() => resolveWorkspaceRoot("relative/project"), 400, "web.workspaceRoot.error.relative");
});

test("rejects a missing workspace root path", (t) => {
  const dir = makeTempDir(t);
  assertWorkspaceRootError(
    () => resolveWorkspaceRoot(path.join(dir, "missing")),
    400,
    "web.workspaceRoot.error.notFound"
  );
});

test("rejects a file as workspace root path", (t) => {
  const dir = makeTempDir(t);
  const filePath = path.join(dir, "file.txt");
  fs.writeFileSync(filePath, "not a directory");
  assertWorkspaceRootError(
    () => resolveWorkspaceRoot(filePath),
    400,
    "web.workspaceRoot.error.notDirectory"
  );
});

test("expands home directory shortcuts", () => {
  const expected = fs.realpathSync.native ? fs.realpathSync.native(os.homedir()) : fs.realpathSync(os.homedir());
  assert.equal(resolveWorkspaceRoot("~"), expected);
});

test("validates and registers a dynamic workspace root", (t) => {
  const dir = makeTempDir(t);
  const service = createWorkspaceRootsService();
  const result = service.handleValidateWorkspaceRootPayload({ params: { path: dir } });

  assert.deepEqual(result, { root: service.resolveWorkspaceRoot(dir) });
  assert.deepEqual(service.workspaceRoots(), [result.root]);
});

test("dynamic workspace roots are allowed by app-fs checks", (t) => {
  const dir = makeTempDir(t);
  const outsideDir = makeTempDir(t);
  const service = createWorkspaceRootsService();
  const root = service.registerWorkspaceRoot(dir);
  const insideFile = path.join(root, "image.png");
  const outsideFile = path.join(outsideDir, "outside.png");
  fs.writeFileSync(insideFile, "");
  fs.writeFileSync(outsideFile, "");

  assert.equal(isAllowedAppFsFile(insideFile, service.workspaceRoots()), true);
  assert.equal(isAllowedAppFsFile(outsideFile, service.workspaceRoots()), false);
});

test("bounds dynamic workspace roots by recent registration order", (t) => {
  const roots = [makeTempDir(t), makeTempDir(t), makeTempDir(t)];
  const service = createWorkspaceRootsService({ maxRoots: 2 });
  const resolved = roots.map((root) => service.registerWorkspaceRoot(root));

  assert.deepEqual(service.workspaceRoots(), resolved.slice(1));
});
