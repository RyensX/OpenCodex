// @ts-nocheck
export {};

function createConversationIpcHandlers(deps) {
  const appServerBridge = deps.appServerBridge;
  const workspaceRuntime = deps.workspaceRuntime;

  /** 创建新会话：先 thread/start，再按需 turn/start，并记录 thread 到 workspace 的映射。 */
  async function startConversation(payload) {
    const params = payload && typeof payload === "object" ? payload : {};
    const { cwd, workspaceRoots } = workspaceRuntime.normalizeStartConversationRoots(params);
    const workspaceKind = params.workspaceKind === "projectless" ? "projectless" : "project";
    const permissions = workspaceRuntime.permissionsForAppServer(params);
    const collaborationMode =
      params.collaborationMode && typeof params.collaborationMode === "object" ? params.collaborationMode : null;
    const threadStartParams = {
      model:
        (collaborationMode &&
          collaborationMode.settings &&
          typeof collaborationMode.settings.model === "string" &&
          collaborationMode.settings.model) ||
        (typeof params.model === "string" ? params.model : null),
      modelProvider: typeof params.modelProvider === "string" ? params.modelProvider : null,
      serviceTier: params.serviceTier ?? null,
      cwd,
      approvalPolicy: permissions.approvalPolicy,
      approvalsReviewer: permissions.approvalsReviewer,
      sandbox: permissions.sandboxMode,
      permissionProfile: permissions.permissionProfile,
      config: params.config && typeof params.config === "object" ? params.config : null,
      personality: params.personality ?? null,
      ephemeral: params.ephemeral ?? null,
      experimentalRawEvents: params.experimentalRawEvents === true,
      persistExtendedHistory: params.persistExtendedHistory !== false,
    };
    const threadStartResult = await appServerBridge.callAppServer("thread/start", threadStartParams);
    const threadId = workspaceRuntime.recordThreadStartMetadata(threadStartResult, {
      ...threadStartParams,
      workspaceRoots,
      workspaceKind,
    }, {
      workspaceRoot: workspaceRoots[0] || cwd,
      workspaceKind,
    });
    if (!threadId) {
      throw new Error("app-server thread/start did not return a thread id");
    }

    const input = Array.isArray(params.input) ? params.input : [];
    const attachments = Array.isArray(params.attachments) ? params.attachments : [];
    const commentAttachments = Array.isArray(params.commentAttachments) ? params.commentAttachments : [];
    if (input.length > 0 || attachments.length > 0 || commentAttachments.length > 0) {
      await appServerBridge.callAppServer("turn/start", {
        threadId,
        input,
        cwd,
        approvalPolicy: workspaceKind === "projectless" ? permissions.approvalPolicy : null,
        approvalsReviewer: permissions.approvalsReviewer,
        sandboxPolicy: workspaceKind === "projectless" ? permissions.sandboxPolicy : null,
        permissionProfile: permissions.permissionProfile,
        model: collaborationMode ? null : threadStartParams.model,
        serviceTier: params.serviceTier ?? null,
        effort:
          collaborationMode &&
          collaborationMode.settings &&
          typeof collaborationMode.settings.reasoning_effort === "string"
            ? null
            : params.reasoningEffort ?? params.effort ?? null,
        summary: "none",
        personality: params.personality ?? null,
        outputSchema: params.outputSchema ?? null,
        collaborationMode,
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(commentAttachments.length > 0 ? { commentAttachments } : {}),
      });
    }
    return threadId;
  }

  return {
    startConversation,
  };
}

module.exports = {
  createConversationIpcHandlers,
};
