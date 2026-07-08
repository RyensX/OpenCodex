const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { PATCHED_OFFICIAL_PREFIX } = require("../runtime/core/config.cjs");
const { createStaticAssetService } = require("../runtime/http/static-assets.cjs");

const WEB_SHELL_INDEX = path.resolve(__dirname, "..", "..", "web-shell", "index.html");

function makeTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodex-static-assets-test-"));
  t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
  return dir;
}

function makeOfficialWebviewDir(t) {
  const dir = makeTempDir(t);
  // 只构造最小官方 renderer 入口，测试注入顺序，不依赖真实官方缓存。
  fs.writeFileSync(path.join(dir, "index.html"), "<html><head><title>Codex</title></head><body></body></html>");
  return dir;
}

function createService(webviewDir) {
  return createStaticAssetService({
    getI18nSnapshot: () => ({ locale: "en-US", messages: {} }),
    getOfficialBundle: () => ({ webviewDir }),
  });
}

function makeResponseRecorder() {
  return {
    body: Buffer.alloc(0),
    headers: {},
    status: 0,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers || {};
    },
    end(body) {
      this.body = Buffer.isBuffer(body) ? body : Buffer.from(String(body || ""), "utf-8");
    },
  };
}

function serveOfficialAsset(service, reqPath, host) {
  const file = service.staticFile(reqPath);
  const res = makeResponseRecorder();
  service.serveFile({ headers: { host } }, res, file, 200, reqPath);
  return res.body.toString("utf-8");
}

test("web shell manifest requests credentials for protected origins", () => {
  const html = fs.readFileSync(WEB_SHELL_INDEX, "utf-8");

  assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest" crossorigin="use-credentials" \/>/);
});

test("patched official renderer CSP allows the injected PWA manifest", (t) => {
  const webviewDir = makeTempDir(t);
  fs.writeFileSync(
    path.join(webviewDir, "index.html"),
    [
      "<!doctype html>",
      '<html><head><meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; worker-src &#39;self&#39; blob:; script-src &#39;self&#39; &#39;wasm-unsafe-eval&#39;;">',
      "<title>Codex</title></head><body></body></html>",
    ].join("")
  );

  const html = createService(webviewDir).createRendererResponse();

  assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest" crossorigin="use-credentials">/);
  assert.match(html, /manifest-src &#39;self&#39;;/);
  assert.match(html, /&#39;wasm-unsafe-eval&#39; &#39;unsafe-eval&#39;/);
});

test("patched official renderer CSP does not duplicate an existing manifest-src", (t) => {
  const webviewDir = makeTempDir(t);
  fs.writeFileSync(
    path.join(webviewDir, "index.html"),
    [
      "<!doctype html>",
      '<html><head><meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; manifest-src &#39;self&#39;; script-src &#39;self&#39; &#39;wasm-unsafe-eval&#39;;">',
      "<title>Codex</title></head><body></body></html>",
    ].join("")
  );

  const html = createService(webviewDir).createRendererResponse();
  const manifestDirectiveCount = html.match(/\bmanifest-src\b/g).length;

  assert.equal(manifestDirectiveCount, 1);
});

test("injects remote file actions after the bridge polyfill", (t) => {
  const webviewDir = makeOfficialWebviewDir(t);
  const service = createStaticAssetService({
    getI18nSnapshot: () => ({ locale: "zh-CN", messages: {} }),
    getOfficialBundle: () => ({ webviewDir }),
  });

  const html = service.createRendererResponse();
  const bridgeIndex = html.indexOf('<script src="/codex-bridge-polyfill.js"></script>');
  const remoteFileIndex = html.indexOf('<script src="/codex-remote-file-actions.js"></script>');
  assert.notEqual(bridgeIndex, -1);
  assert.notEqual(remoteFileIndex, -1);
  assert.equal(remoteFileIndex > bridgeIndex, true);
  assert.equal(service.staticFile("/codex-remote-file-actions.js").endsWith("web-shell/codex-remote-file-actions.js"), true);
});

test("renames official open-in-folder locale message only for remote browser hosts", (t) => {
  const webviewDir = makeOfficialWebviewDir(t);
  const assetsDir = path.join(webviewDir, "assets");
  fs.mkdirSync(assetsDir, { recursive: true });
  const assetName = "zh-CN-test.js";
  fs.writeFileSync(
    path.join(assetsDir, assetName),
    'export default {"artifactTab.preview.openInFolder":`打开所在文件夹`,"other.key":`保持不变`};'
  );
  const service = createStaticAssetService({
    getI18nSnapshot: () => ({
      locale: "zh-CN",
      messages: { "web.remoteFile.downloadFile": "下载文件" },
    }),
    getOfficialBundle: () => ({ webviewDir }),
  });
  const reqPath = `${PATCHED_OFFICIAL_PREFIX}assets/${assetName}`;

  const remoteSource = serveOfficialAsset(service, reqPath, "192.168.60.218:3737");
  assert.match(remoteSource, /"artifactTab\.preview\.openInFolder"\s*:\s*"下载文件"/);
  assert.match(remoteSource, /"other\.key":`保持不变`/);

  const loopbackSource = serveOfficialAsset(service, reqPath, "localhost:3737");
  assert.match(loopbackSource, /"artifactTab\.preview\.openInFolder":`打开所在文件夹`/);
});
