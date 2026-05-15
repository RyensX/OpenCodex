// @ts-nocheck
export {};

function createWorkerIpcHandlers(deps) {
  /** 回复 renderer worker 请求，例如 git worker 的分支/状态查询。 */
  function respondToWorkerRequest(workerId, request, result) {
    if (typeof deps.broadcast !== "function") return;
    deps.broadcast({
      channel: `codex_desktop:worker:${workerId}:for-view`,
      payload: {
        type: "worker-response",
        workerId,
        response: {
          id: request.id,
          method: request.method,
          result,
        },
      },
    });
  }

  /** 处理 codex_desktop:worker:*:from-view 的 worker 请求。 */
  function handleWorkerMessage(channel, payload) {
    const match = channel.match(/^codex_desktop:worker:([^:]+):from-view$/);
    const workerId = match ? match[1] : null;
    if (!workerId || !payload || typeof payload !== "object") return false;
    if (payload.type === "worker-request-cancel") return true;
    if (payload.type !== "worker-request" || !payload.request || typeof payload.request !== "object") {
      return false;
    }

    const request = payload.request;
    const method = String(request.method || "");
    try {
      const value =
        workerId === "git"
          ? deps.handleGitWorkerMethod(method, request.params || {})
          : (() => {
              throw new Error(`Unsupported worker: ${workerId}`);
            })();
      respondToWorkerRequest(workerId, request, { type: "ok", value });
    } catch (error) {
      deps.logger && deps.logger.warn(`[worker:${workerId}] request failed: ${method}`, error);
      respondToWorkerRequest(workerId, request, {
        type: "error",
        error: {
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
    return true;
  }

  return {
    handleWorkerMessage,
  };
}

module.exports = {
  createWorkerIpcHandlers,
};
