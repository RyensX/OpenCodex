const { parentPort } = require("worker_threads");
const { createStaticAssetService } = require("./static-assets.cjs");

let i18nSnapshot = { locale: "en-US", messages: {} };
const patcher = createStaticAssetService({
  getI18nSnapshot: () => i18nSnapshot,
  // Worker 只调用纯资源改写入口，不做 URL 到官方目录的映射。
  getOfficialBundle: () => null,
});

parentPort.on("message", (message) => {
  const id = message?.id;
  try {
    i18nSnapshot = {
      locale: String(message?.locale || "en-US"),
      messages: { "web.remoteFile.downloadFile": String(message?.downloadMessage || "Download file") },
    };
    const bytes = message.data;
    const sourceData = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const data = patcher.patchOfficialAssetData(
      String(message.reqPath || ""),
      sourceData,
      { headers: { host: String(message.host || "") } }
    );
    const patched = data !== sourceData;
    const transferable =
      data.byteOffset === 0 && data.byteLength === data.buffer.byteLength ? data : Buffer.from(data);
    parentPort.postMessage({ data: transferable, id, patched }, [transferable.buffer]);
  } catch (error) {
    parentPort.postMessage({ error: error instanceof Error ? error.message : String(error), id });
  }
});
