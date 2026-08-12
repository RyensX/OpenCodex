const assert = require("node:assert/strict");
const { once } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Writable } = require("node:stream");
const test = require("node:test");
const zlib = require("node:zlib");
const { LOCAL_DOWNLOAD_ARCHIVE_MAX_BYTES, LOCAL_DOWNLOAD_ARCHIVE_MAX_FILES } = require("../runtime/core/config.cjs");
const { createLocalFileService } = require("../runtime/http/local-files.cjs");

function makeTempFile(t, fileName, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodex-local-file-test-"));
  t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
  const filePath = path.join(dir, fileName);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return filePath;
}

function makeTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodex-local-file-test-"));
  t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
  return dir;
}

function createResponseRecorder() {
  const chunks = [];
  // local-files 现在通过 stream.pipeline 写响应，测试响应对象需要实现 Writable。
  const response = new Writable({
    write(chunk, encoding, callback) {
      chunks.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk, encoding));
      callback();
    },
  });
  response.body = Buffer.alloc(0);
  response.headers = null;
  response.headersSent = false;
  response.status = null;
  response.writeHead = (status, headers) => {
    response.status = status;
    response.headers = headers;
    response.headersSent = true;
  };
  response.on("finish", () => {
    response.body = Buffer.concat(chunks);
  });
  return response;
}

async function waitForResponseBody(response) {
  if (!response.writableFinished) await once(response, "finish");
  return response.body;
}

function pathnameFromLocalFileUrl(url) {
  return new URL(url, "http://opencodex.local").pathname;
}

function localZipEntries(zipBuffer) {
  const entries = new Map();
  let offset = 0;
  while (offset + 4 <= zipBuffer.length) {
    const signature = zipBuffer.readUInt32LE(offset);
    if (signature === 0x02014b50 || signature === 0x06054b50) break;
    assert.equal(signature, 0x04034b50);
    const method = zipBuffer.readUInt16LE(offset + 8);
    const compressedSize = zipBuffer.readUInt32LE(offset + 18);
    const uncompressedSize = zipBuffer.readUInt32LE(offset + 22);
    const nameLength = zipBuffer.readUInt16LE(offset + 26);
    const extraLength = zipBuffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = zipBuffer.subarray(nameStart, nameStart + nameLength).toString("utf-8");
    const compressed = zipBuffer.subarray(dataStart, dataStart + compressedSize);
    // 流式 zip writer 会回填 local header，这里按 header size 直接解压验证内容。
    const content = method === 8 ? zlib.inflateRawSync(compressed) : compressed;
    assert.equal(content.length, uncompressedSize);
    entries.set(name, content);
    offset = dataStart + compressedSize;
  }
  return entries;
}

test("serves local file tokens inline or as attachment", async (t) => {
  const service = createLocalFileService();
  t.after(() => service.dispose());
  const fileName = process.platform === "win32" ? "report final.txt" : 'report "final".txt';
  const headerFileName = process.platform === "win32" ? "report final.txt" : "report _final_.txt";
  const filePath = makeTempFile(t, fileName, "hello");

  const preview = service.createLocalFilePreview(filePath);
  assert.equal(preview.url.includes("?download=1"), false);
  assert.equal(preview.downloadUrl.endsWith("?download=1"), true);

  const previewResponse = createResponseRecorder();
  await service.serveLocalFile(pathnameFromLocalFileUrl(preview.url), previewResponse);
  const previewBody = await waitForResponseBody(previewResponse);
  assert.equal(previewResponse.status, 200);
  assert.equal(previewResponse.headers["content-disposition"], `inline; filename="${headerFileName}"`);
  assert.equal(previewResponse.headers["content-length"], "5");
  assert.equal(Buffer.compare(previewBody, Buffer.from("hello")), 0);

  const download = service.createLocalFileDownload(filePath);
  assert.equal(download.url, download.downloadUrl);
  assert.equal(download.downloadUrl.endsWith("?download=1"), true);

  const downloadResponse = createResponseRecorder();
  await service.serveLocalFile(pathnameFromLocalFileUrl(download.downloadUrl), downloadResponse, { download: true });
  const downloadBody = await waitForResponseBody(downloadResponse);
  assert.equal(downloadResponse.status, 200);
  assert.equal(downloadResponse.headers["content-disposition"], `attachment; filename="${headerFileName}"`);
  assert.equal(downloadResponse.headers["content-length"], "5");
  assert.equal(Buffer.compare(downloadBody, Buffer.from("hello")), 0);

  const pathDownload = await service.createLocalPathDownload(filePath);
  assert.equal(pathDownload.name, fileName);
  assert.equal(pathDownload.downloadUrl.endsWith("?download=1"), true);
});

test("keeps local file token pruning idle until a token exists", (t) => {
  const service = createLocalFileService();
  t.after(() => service.dispose());
  assert.equal(service.__test.timerActive(), false);
  assert.equal(service.__test.tokenCount(), 0);

  const filePath = makeTempFile(t, "lazy-timer.txt", "idle");
  service.createLocalFilePreview(filePath);
  assert.equal(service.__test.timerActive(), true);
  assert.equal(service.__test.tokenCount(), 1);

  service.dispose();
  assert.equal(service.__test.timerActive(), false);
  assert.equal(service.__test.tokenCount(), 0);
});

test("bounds local file tokens and expires the oldest preview", async (t) => {
  const service = createLocalFileService({ maxTokens: 2 });
  t.after(() => service.dispose());
  const firstFile = makeTempFile(t, "first.txt", "first");
  const secondFile = makeTempFile(t, "second.txt", "second");
  const thirdFile = makeTempFile(t, "third.txt", "third");

  const first = service.createLocalFilePreview(firstFile);
  service.createLocalFilePreview(secondFile);
  const third = service.createLocalFilePreview(thirdFile);
  assert.equal(service.__test.tokenCount(), 2);

  const expiredResponse = createResponseRecorder();
  await service.serveLocalFile(pathnameFromLocalFileUrl(first.url), expiredResponse);
  await waitForResponseBody(expiredResponse);
  assert.equal(expiredResponse.status, 404);

  const currentResponse = createResponseRecorder();
  await service.serveLocalFile(pathnameFromLocalFileUrl(third.url), currentResponse);
  const currentBody = await waitForResponseBody(currentResponse);
  assert.equal(currentResponse.status, 200);
  assert.equal(currentBody.toString("utf8"), "third");
});

test("streams plugin summary images as cacheable binary responses", async (t) => {
  const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const imagePath = makeTempFile(t, "plugin-logo.png", imageBytes);
  const service = createLocalFileService();
  t.after(() => service.dispose());
  const url = new URL(`/api/plugin-image?path=${encodeURIComponent(imagePath)}`, "http://opencodex.local");

  const response = createResponseRecorder();
  await service.servePluginImage(url, { headers: {} }, response);
  const body = await waitForResponseBody(response);
  assert.equal(response.status, 200);
  assert.equal(response.headers["content-type"], "image/png");
  assert.equal(response.headers["content-length"], String(imageBytes.length));
  assert.equal(response.headers["cache-control"], "private, no-cache");
  assert.equal(response.headers["cross-origin-resource-policy"], "same-origin");
  assert.equal(Buffer.compare(body, imageBytes), 0);

  const cachedResponse = createResponseRecorder();
  await service.servePluginImage(
    url,
    { headers: { "if-none-match": response.headers.etag } },
    cachedResponse
  );
  await waitForResponseBody(cachedResponse);
  assert.equal(cachedResponse.status, 304);
  assert.equal(cachedResponse.headers["content-length"], undefined);
});

test("rejects non-image and oversized plugin summary files", async (t) => {
  const textPath = makeTempFile(t, "private.txt", "not an image");
  const imagePath = makeTempFile(t, "oversized.png", Buffer.alloc(9));
  const service = createLocalFileService({ pluginImageMaxBytes: 8 });
  t.after(() => service.dispose());

  for (const filePath of [textPath, imagePath]) {
    const response = createResponseRecorder();
    const url = new URL(`/api/plugin-image?path=${encodeURIComponent(filePath)}`, "http://opencodex.local");
    await service.servePluginImage(url, { headers: {} }, response);
    await waitForResponseBody(response);
    assert.equal(response.status, 404);
  }
});

test("creates temporary zip downloads for directories", async (t) => {
  const dir = makeTempDir(t);
  const folder = path.join(dir, "bundle");
  fs.mkdirSync(path.join(folder, "nested"), { recursive: true });
  fs.writeFileSync(path.join(folder, "nested", "a.txt"), "alpha");
  fs.writeFileSync(path.join(folder, "b.txt"), "beta");

  const service = createLocalFileService();
  t.after(() => service.dispose());

  const download = await service.createLocalPathDownload(folder);
  assert.equal(download.name, "bundle.zip");
  assert.equal(download.downloadUrl.endsWith("?download=1"), true);

  const response = createResponseRecorder();
  await service.serveLocalFile(pathnameFromLocalFileUrl(download.downloadUrl), response, { download: true });
  const responseBody = await waitForResponseBody(response);
  assert.equal(response.status, 200);
  assert.equal(response.headers["content-type"], "application/zip");
  assert.equal(response.headers["content-disposition"], 'attachment; filename="bundle.zip"');
  assert.equal(response.headers["content-length"], String(responseBody.length));
  assert.equal(Buffer.compare(responseBody.subarray(0, 4), Buffer.from([0x50, 0x4b, 0x03, 0x04])), 0);
  assert.equal(responseBody.includes(Buffer.from("bundle/nested/a.txt")), true);
  assert.equal(responseBody.includes(Buffer.from("bundle/b.txt")), true);
  const entries = localZipEntries(responseBody);
  assert.equal(entries.get("bundle/nested/a.txt").toString("utf-8"), "alpha");
  assert.equal(entries.get("bundle/b.txt").toString("utf-8"), "beta");
});

test("uses higher default archive limits for remote directory downloads", () => {
  assert.equal(LOCAL_DOWNLOAD_ARCHIVE_MAX_FILES, 30000);
  assert.equal(LOCAL_DOWNLOAD_ARCHIVE_MAX_BYTES, 1024 * 1024 * 1024);
});

test("resolves relative download paths inside workspace roots only", (t) => {
  const workspaceRoot = makeTempDir(t);
  fs.mkdirSync(path.join(workspaceRoot, "src"), { recursive: true });
  const filePath = path.join(workspaceRoot, "src", "index.js");
  fs.writeFileSync(filePath, "console.log('ok');");

  const service = createLocalFileService({ getWorkspaceRoots: () => [workspaceRoot] });
  t.after(() => service.dispose());

  assert.equal(service.resolveLocalDownloadPath("src/index.js"), filePath);
  assert.equal(service.resolveLocalDownloadPath("src/../src/index.js"), filePath);
  assert.equal(service.resolveLocalDownloadPath("."), workspaceRoot);
  assert.equal(service.resolveLocalDownloadPath(".", { workspaceRoot }), workspaceRoot);
  assert.equal(service.resolveLocalDownloadPath("../outside.txt"), "");
  assert.equal(service.resolveLocalDownloadPath("src/index.js", { workspaceRoot }), filePath);
});

test("prefers an existing relative download path across workspace roots", (t) => {
  const firstRoot = makeTempDir(t);
  const secondRoot = makeTempDir(t);
  fs.mkdirSync(path.join(secondRoot, "src"), { recursive: true });
  const filePath = path.join(secondRoot, "src", "index.js");
  fs.writeFileSync(filePath, "console.log('ok');");

  const service = createLocalFileService({ getWorkspaceRoots: () => [firstRoot, secondRoot] });
  t.after(() => service.dispose());

  assert.equal(service.resolveLocalDownloadPath("src/index.js"), filePath);
});

test("does not use the gateway cwd as a fallback relative download root", (t) => {
  const service = createLocalFileService();
  t.after(() => service.dispose());

  assert.equal(service.resolveLocalDownloadPath("package.json"), "");
});

test("ignores an unregistered requested workspace root", (t) => {
  const workspaceRoot = makeTempDir(t);
  const filePath = path.join(workspaceRoot, "package.json");
  fs.writeFileSync(filePath, "{}");

  const service = createLocalFileService();
  t.after(() => service.dispose());

  assert.equal(service.resolveLocalDownloadPath("package.json", { workspaceRoot }), "");
});
