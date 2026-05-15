// @ts-nocheck
export {};

const fs = require("fs");

function createFilePreviewIpcHandlers(deps) {
  const appServerBridge = deps.appServerBridge;
  const workspaceIpc = deps.workspaceIpc;

  function readPreview(payload) {
    if (payload && typeof payload === "object" && payload.path && workspaceIpc.isWithinAllowedRoots(payload.path)) {
      try {
        const raw = fs.readFileSync(payload.path, "utf8");
        return {
          path: payload.path,
          text: raw.slice(0, 4000),
          truncated: raw.length > 4000,
        };
      } catch {
        return null;
      }
    }
    return appServerBridge.callAppServer("file/readPreview", payload);
  }

  function stat(payload) {
    if (payload && typeof payload === "object" && payload.path && workspaceIpc.isWithinAllowedRoots(payload.path)) {
      try {
        const stats = fs.statSync(payload.path);
        return {
          path: payload.path,
          isFile: stats.isFile(),
          isDirectory: stats.isDirectory(),
          size: stats.size,
          mtimeMs: stats.mtimeMs,
        };
      } catch {
        return null;
      }
    }
    return appServerBridge.callAppServer("file/stat", payload);
  }

  return {
    readPreview,
    stat,
  };
}

module.exports = {
  createFilePreviewIpcHandlers,
};
