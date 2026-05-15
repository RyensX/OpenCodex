// @ts-nocheck
export {};

const util = require("util");

function createViewMessageHandlers(deps) {
  const DEBUG_LOGS = deps.debugLogs;
  const DESKTOP_VIEW_NOOP_MESSAGE_TYPES = deps.desktopViewNoopMessageTypes;
  const STATSIG_DEFAULT_FEATURES_CONFIG = deps.statsigDefaultFeaturesConfig;
  const SHARED_OBJECT_SNAPSHOT = deps.sharedObjectSnapshot;
  const PERSISTED_STATE = deps.persistedState;
  const appServerBridge = deps.appServerBridge;
  const desktopState = deps.desktopState;
  const diagnostics = deps.diagnostics;
  const fetchIpc = deps.fetchIpc;
  const logger = deps.logger;
  const terminalIpc = deps.terminalIpc;
  const workspaceIpc = deps.workspaceIpc;
  const workspaceRuntime = deps.workspaceRuntime;
  const broadcast = deps.broadcast;
  const contextClientId = deps.contextClientId;
  const targetClientIdForContext = deps.targetClientIdForContext;
  const withTargetClient = deps.withTargetClient;
  const runDetached = deps.runDetached;
  const patchCodexConfigResult = deps.patchCodexConfigResult;
  const patchConfigRequirementsResult = deps.patchConfigRequirementsResult;

  async function handleViewMessage(payload, context = {}) {
    if (payload && typeof payload === "object") {
      const keys = Object.keys(payload).join(",");
      const type = String(payload.type || "");
      if (type === "log-message") {
        const level = String(payload.level || "info");
        const message = String(payload.message || "");
        if (level === "error" || level === "warning") {
          console.warn(
            `[renderer:${level}] ${message}`,
            util.inspect(payload.tags || {}, {
              colors: false,
              depth: 4,
              maxArrayLength: 10,
              maxStringLength: 600,
              breakLength: 120,
            })
          );
        }
        // log-message 是 renderer 的通知型消息；处理完必须 ACK，避免落到未知消息报错分支。
        return true;
      } else {
        if (DEBUG_LOGS) {
          console.log(
            `[gateway] view message type=${type} keys=${keys}`
          );
        }
      }
      if (
        (payload.type === "mcp-request" || payload.type === "thread-prewarm-start") &&
        payload.request
      ) {
        if (DEBUG_LOGS) {
          console.log(
            `[gateway] mcp request id=${String(payload.request.id || "")} method=${String(
              payload.type === "thread-prewarm-start" ? "thread/start" : payload.request.method || ""
            )}`
          );
        }
      }
    }
    if (payload && typeof payload === "object") {
      if (payload.type === "electron-set-active-workspace-root") {
        const changed = workspaceIpc.setActiveWorkspaceRoot(payload.root);
        if (changed && typeof broadcast === "function") {
          broadcast({ channel: "workspace-root-options-updated", payload: {} });
          broadcast({ channel: "active-workspace-roots-updated", payload: {} });
        }
        return true;
      }
      if (payload.type === "workspace-root-option-picked") {
        const result = workspaceIpc.addWorkspaceRootOption({
          root: payload.root,
          label: payload.label,
          setActive: payload.setActive !== false,
        });
        if (typeof broadcast === "function") {
          broadcast({ channel: "workspace-root-options-updated", payload: {} });
          broadcast({ channel: "active-workspace-roots-updated", payload: {} });
        }
        return !!result.success;
      }
      if (payload.type === "electron-update-workspace-root-options") {
        // 官方 renderer 移除项目会发送完整 roots 列表，这里同步 Desktop globalState 并广播刷新。
        const result = workspaceIpc.setWorkspaceRootOptions(payload.roots);
        if (typeof broadcast === "function") {
          broadcast({ channel: "workspace-root-options-updated", payload: {} });
          if (result.activeRootsChanged) {
            broadcast({ channel: "active-workspace-roots-updated", payload: {} });
          }
        }
        return true;
      }
      if (payload.type === "electron-rename-workspace-root-option") {
        // 重命名只影响 label，不改变 active roots，因此只广播项目列表刷新。
        const result = workspaceIpc.renameWorkspaceRootOption(payload);
        if (typeof broadcast === "function") {
          broadcast({ channel: "workspace-root-options-updated", payload: {} });
        }
        return !!result.success;
      }
      if (payload.type === "electron-clear-active-workspace-root") {
        workspaceIpc.clearActiveWorkspaceRoot();
        if (typeof broadcast === "function") {
          broadcast({ channel: "active-workspace-roots-updated", payload: {} });
        }
        return true;
      }
      if (payload.type === "electron-request-microphone-permission") {
        return true;
      }
      if (payload.type === "thread-read-state-changed") {
        const conversationId =
          typeof payload.conversationId === "string" && payload.conversationId
            ? payload.conversationId
            : null;
        if (conversationId && typeof broadcast === "function") {
          broadcast({
            channel: "thread-read-state-changed",
            payload: {
              params: {
                hostId: typeof payload.hostId === "string" && payload.hostId ? payload.hostId : "local",
                conversationId,
                hasUnreadTurn: payload.hasUnreadTurn === true,
              },
              sourceClientId: contextClientId(context) || null,
            },
          });
        }
        return true;
      }
      if (DESKTOP_VIEW_NOOP_MESSAGE_TYPES.has(String(payload.type || ""))) {
        // 这些是 Desktop 主进程/系统 UI 状态同步消息。Web 没有对应原生窗口、
        // 托盘、遥测或系统电源能力，ACK 即可；返回 500 会让官方 renderer
        // 额外序列化整棵 thread state 生成 warning，明显拖慢会话切换。
        return true;
      }
      if (payload.type === "shared-object-set" && payload.key) {
        const value = desktopState.normalizeSharedObjectSnapshotValue(payload.key, payload.value);
        SHARED_OBJECT_SNAPSHOT.set(payload.key, value);
        if (typeof broadcast === "function") {
          broadcast({ channel: "shared-object-updated", payload: { ...payload, value } });
        }
        // shared-object-set 是本地状态同步消息，广播完成后即视为已处理。
        return true;
      }
      if (payload.type === "shared-object-subscribe" && payload.key) {
        if (payload.key === STATSIG_DEFAULT_FEATURES_CONFIG || SHARED_OBJECT_SNAPSHOT.has(payload.key)) {
          const value = desktopState.normalizeSharedObjectSnapshotValue(payload.key, SHARED_OBJECT_SNAPSHOT.get(payload.key));
          SHARED_OBJECT_SNAPSHOT.set(payload.key, value);
          if (typeof broadcast === "function") {
            broadcast({ channel: "shared-object-updated", payload: { key: payload.key, value } });
          }
        }
        return true;
      }
      if (payload.type === "persisted-atom-sync-request") {
        Object.assign(PERSISTED_STATE, desktopState.getDesktopPersistedAtoms());
        if (typeof broadcast === "function") {
          broadcast({ channel: "persisted-atom-sync", payload: { state: desktopState.persistedStateForRenderer() } });
        }
        return true;
      }
      if (payload.type === "persisted-atom-update" && payload.key) {
        if (payload.deleted) {
          delete PERSISTED_STATE[payload.key];
        } else {
          PERSISTED_STATE[payload.key] = payload.value;
        }
        desktopState.setDesktopPersistedAtom(payload.key, payload.value, !!payload.deleted);
        if (typeof broadcast === "function") {
          broadcast({
            channel: "persisted-atom-updated",
            payload: { key: payload.key, value: payload.value, deleted: !!payload.deleted },
          });
        }
        return true;
      }
      if (payload.type === "mcp-response") {
        await appServerBridge.respondToAppServerRequest(payload);
        return true;
      }
      if (String(payload.type || "").startsWith("terminal-")) {
        const handled = terminalIpc.handleTerminalMessage(payload, context);
        if (!handled) {
          // terminal-* 以前静默 false 会让前端无感，现在按未支持消息显式报错。
          throw new Error(`Unsupported Codex message type: ${payload.type}`);
        }
        return true;
      }
      if (
        (payload.type === "mcp-request" || payload.type === "thread-prewarm-start") &&
        payload.request
      ) {
        const targetClientId = targetClientIdForContext(context);
        // mcp-request 要立即 ACK 给 renderer，真正 app-server 调用完成后再广播 mcp-response。
        return runDetached("mcp-request", async () => {
          const requestId = String(payload.request.id || "");
          const method =
            payload.type === "thread-prewarm-start"
              ? "thread/start"
              : String(payload.request.method || "");
          const requestPayload =
            payload.request.params === undefined ? null : payload.request.params;
          let result = null;
          let mcpError = null;
          try {
            if (method === "config/read" || method === "read-config") {
              result = await appServerBridge.readCodexConfig({ params: requestPayload });
            } else if (method === "list-models-for-host") {
              result = await appServerBridge.listModelsForHost(requestPayload);
            } else {
              result = await appServerBridge.callAppServer(method, requestPayload);
              if (method === "thread/start") {
                // renderer 自己走 AppServerManager.startConversation/prewarm 时会从这里创建真实 thread。
                workspaceRuntime.recordThreadStartMetadata(result, requestPayload);
              }
            }
            if (method === "config/read" || method === "read-config") {
              result = patchCodexConfigResult(result);
            } else if (method === "configRequirements/read") {
              result = patchConfigRequirementsResult(result);
            }
          } catch (caughtError) {
            logger.warn(`[ipc] mcp request failed: ${method}`, caughtError);
            mcpError = caughtError instanceof Error ? caughtError : new Error(String(caughtError));
          }
          if (typeof broadcast === "function") {
            if (DEBUG_LOGS) {
              console.log(
                `[gateway] mcp response id=${requestId} method=${method} resultShape=${diagnostics.payloadShape(
                  mcpError ? { error: mcpError.message } : result
                )}`
              );
            }
            broadcast(withTargetClient({
              channel: "mcp-response",
              payload: {
                hostId: payload.hostId ?? null,
                message: {
                  id: requestId,
                  ...(mcpError ? { error: { message: mcpError.message } } : { result }),
                },
              },
            }, targetClientId));
          }
        });
      }
      if (payload.type === "fetch") {
        return runDetached("fetch", async () => {
          await fetchIpc.handleFetchMessage(payload, context);
        });
      }
      if (payload.type === "fetch-stream") {
        return runDetached("fetch-stream", async () => {
          await fetchIpc.handleFetchStreamMessage(payload, context);
        });
      }
      if (payload.type === "cancel-fetch" || payload.type === "cancel-fetch-stream") {
        return true;
      }
    }
    // 未识别的 view message 不能再静默吞掉，必须让 /api/ipc/invoke 返回错误给前端 toast。
    throw new Error(
      `Unsupported Codex message type: ${
        payload && typeof payload === "object" && payload.type ? payload.type : diagnostics.payloadShape(payload)
      }`
    );
  }

  return {
    handleViewMessage,
  };
}

module.exports = {
  createViewMessageHandlers,
};
