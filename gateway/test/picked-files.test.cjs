const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

// picked-files 的目录常量在 require 时固定，测试必须先隔离 CODEX_HOME，避免碰到真实用户数据。
const testCodexHome = fs.mkdtempSync(path.join(os.tmpdir(), "opencodex-picked-files-test-"));
process.env.CODEX_HOME = testCodexHome;
process.env.CODEX_WEB_PICKED_FILE_TTL_MS = "1000";

const { createPickedFilesService } = require("../runtime/ipc/picked-files.cjs");

test.after(() => fs.rmSync(testCodexHome, { force: true, recursive: true }));

test("keeps picked-file pruning idle until an attachment is persisted", (t) => {
  const service = createPickedFilesService();
  t.after(() => service.dispose());
  assert.equal(service.__test.timerActive(), false);

  const result = service.handlePickFilesPayload({
    params: {
      files: [
        {
          name: "attachment.txt",
          type: "text/plain",
          size: 5,
          lastModified: 0,
          contentsBase64: Buffer.from("hello").toString("base64"),
        },
      ],
    },
  });
  assert.equal(result.files.length, 1);
  assert.equal(fs.readFileSync(result.files[0].path, "utf-8"), "hello");
  assert.equal(service.__test.timerActive(), true);

  service.dispose();
  assert.equal(service.__test.timerActive(), false);
});
