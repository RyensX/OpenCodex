(function () {
  const w = window;
  if (w.__codexWorkspaceRootPickerInstalled) return;
  const adapterHost = w.__OpenCodexAdapterHost;
  if (!adapterHost?.events?.observe) return;
  w.__codexWorkspaceRootPickerInstalled = true;

  // 这个模块只负责“远端浏览器输入路径”的交互，真正的 Electron/官方 IPC 仍由 bridge 转发。
  const WORKSPACE_ROOT_VALIDATE_CHANNEL = "opencodex:validate-workspace-root";
  const ADD_WORKSPACE_ROOT_MESSAGE = "electron-add-new-workspace-root-option";
  const PICK_WORKSPACE_ROOT_MESSAGE = "electron-pick-workspace-root-option";
  const WORKSPACE_ROOT_PICKED_MESSAGE = "workspace-root-option-picked";
  const MESSAGE_MODE_ADD = "add";
  const MESSAGE_MODE_PICK = "pick";
  const dialogState = {
    focusInput: null,
    promise: null,
  };

  function bridgeHelpers() {
    // polyfill 先暴露最小 helper 面，picker 不直接复制 IPC、toast 和 i18n 的底层实现。
    return w.__codexWebBridgeHelpers && typeof w.__codexWebBridgeHelpers === "object"
      ? w.__codexWebBridgeHelpers
      : {};
  }

  function runtimeMessages() {
    // bridge 尚未准备好时仍可从公开运行时配置读取文案，保证弹窗不会裸露 key。
    const cfg = w.__CODEX_WEB_CONFIG__ || {};
    return cfg.messages && typeof cfg.messages === "object" ? cfg.messages : {};
  }

  function t(key, values) {
    const helper = bridgeHelpers().t;
    if (typeof helper === "function") return helper(key, values);
    const template = runtimeMessages()[key] || key;
    if (!values || typeof values !== "object") return template;
    return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name) =>
      Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match
    );
  }

  function invoke(channel, ...args) {
    const helper = bridgeHelpers().invoke;
    if (typeof helper === "function") return helper(channel, ...args);
    return Promise.reject(new Error("OpenCodex bridge is not ready."));
  }

  function deliverLocalRendererMessage(channel, payload) {
    const helper = bridgeHelpers().deliverLocalRendererMessage;
    if (typeof helper === "function") return helper(channel, payload);
    throw new Error("OpenCodex renderer message bridge is not ready.");
  }

  function normalizeErrorMessage(error) {
    const helper = bridgeHelpers().normalizeErrorMessage;
    if (typeof helper === "function") return helper(error);
    if (!error) return "";
    if (typeof error === "string") return error;
    if (error instanceof Error && error.message) return error.message;
    if (error && typeof error === "object" && typeof error.error === "string") return error.error;
    return String(error);
  }

  function showToast(payload) {
    // 正常走 bridge 的官方 toast 兼容层；兜底只发 window message，避免这里再造 toast DOM。
    const helper = bridgeHelpers().showToast;
    if (typeof helper === "function") {
      helper(payload);
      return;
    }
    try {
      w.dispatchEvent(new MessageEvent("message", { data: { type: "codex-web:toast", ...payload } }));
    } catch {}
  }

  function loopbackHostname(hostname) {
    // localhost 场景应该继续走官方 Electron 目录选择器，只有远端访问才接管为路径输入。
    const normalized = String(hostname || "").trim().toLowerCase();
    if (!normalized) return false;
    if (normalized === "localhost" || normalized === "::1" || normalized === "[::1]") return true;
    if (/^127(?:\.\d{1,3}){3}$/.test(normalized)) return true;
    return normalized === "::ffff:127.0.0.1" || normalized === "[::ffff:127.0.0.1]";
  }

  function shouldUseNativeWorkspaceRootPicker() {
    try {
      return loopbackHostname(w.location && w.location.hostname);
    } catch {
      return false;
    }
  }

  function hasWorkspaceRootPayload(payload) {
    return !!payload && typeof payload === "object" && typeof payload.root === "string" && payload.root.trim();
  }

  function messageMode(payload) {
    if (!payload || typeof payload !== "object" || shouldUseNativeWorkspaceRootPicker()) return "";
    // 旧协议带 root 的消息是适配器校验后的二次转发，不能再次接管形成循环。
    if (payload.type === ADD_WORKSPACE_ROOT_MESSAGE && !hasWorkspaceRootPayload(payload)) return MESSAGE_MODE_ADD;
    // 新协议是“只选择、不持久化”，官方 Main 会忽略 root 并打开原生目录框，所以远端必须完整接管。
    if (payload.type === PICK_WORKSPACE_ROOT_MESSAGE) return MESSAGE_MODE_PICK;
    return "";
  }

  function shouldHandleMessage(payload) {
    return !!messageMode(payload);
  }

  function allowsMultipleWorkspaceRoots(payload) {
    if (!payload || typeof payload !== "object") return false;
    if (payload.allowMultiple === true) return true;
    return !!(payload.params && typeof payload.params === "object" && payload.params.allowMultiple === true);
  }

  function workspaceRootPaths(rawValue, allowMultiple) {
    const value = String(rawValue || "");
    if (!allowMultiple) return [value];
    // 原生 multiSelections 的等价 Web 输入是一行一个路径；去重时保留用户填写顺序。
    const uniquePaths = [];
    const seen = new Set();
    for (const line of value.split(/\r?\n/)) {
      const candidate = line.trim();
      if (!candidate || seen.has(candidate)) continue;
      seen.add(candidate);
      uniquePaths.push(candidate);
    }
    // 空输入仍交给 gateway 返回统一的本地化错误，避免前后端出现两套校验文案。
    return uniquePaths.length > 0 ? uniquePaths : [""];
  }

  function localizedError(error) {
    // gateway 优先返回 errorKey；未知错误才降级到原始 message，便于排查异常链路。
    const response = error && error.response && typeof error.response === "object" ? error.response : null;
    const responseKey = response && typeof response.errorKey === "string" ? response.errorKey : "";
    const fallbackKey =
      error && typeof error.workspaceRootErrorKey === "string"
        ? error.workspaceRootErrorKey
        : "web.workspaceRoot.error.unavailable";
    const fallbackMessage = normalizeErrorMessage((response && response.error) || error);
    const key = responseKey || fallbackKey;
    const message = t(key, { error: fallbackMessage });
    if (message && message !== key) return message;
    return fallbackMessage || t("web.workspaceRoot.error.unavailable");
  }

  function showErrorToast(error) {
    showToast({
      level: "danger",
      source: "codex-web-workspace-root",
      description: localizedError(error),
    });
  }

  function showDialog(options) {
    const allowMultiple = !!(options && options.allowMultiple);
    const onSubmit = options && options.onSubmit;
    if (dialogState.promise) {
      // 同一时刻只允许一个路径弹窗，重复点击只把焦点拉回输入框。
      if (typeof dialogState.focusInput === "function") dialogState.focusInput();
      return dialogState.promise;
    }

    dialogState.promise = new Promise((resolve) => {
      const backdrop = document.createElement("div");
      backdrop.className = "codex-web-workspace-root-backdrop";
      backdrop.setAttribute("role", "presentation");

      const panel = document.createElement("form");
      panel.className = "codex-web-workspace-root-panel";
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-modal", "true");
      panel.setAttribute("aria-labelledby", "codex-web-workspace-root-title");

      // DOM 结构刻意贴近官方 compact dialog：标题、说明、路径输入、底部操作按钮。
      const header = document.createElement("div");
      header.className = "codex-web-workspace-root-header";

      const title = document.createElement("h2");
      title.id = "codex-web-workspace-root-title";
      title.className = "codex-web-workspace-root-title";
      title.textContent = t("web.workspaceRoot.dialog.title");
      header.appendChild(title);

      const closeButton = document.createElement("button");
      closeButton.type = "button";
      closeButton.className = "codex-web-workspace-root-close";
      closeButton.setAttribute("aria-label", t("web.workspaceRoot.dialog.close"));
      closeButton.textContent = "x";
      header.appendChild(closeButton);
      panel.appendChild(header);

      const description = document.createElement("p");
      description.className = "codex-web-workspace-root-description";
      description.textContent = t(
        allowMultiple ? "web.workspaceRoot.dialog.multipleDescription" : "web.workspaceRoot.dialog.description"
      );
      panel.appendChild(description);

      const input = document.createElement(allowMultiple ? "textarea" : "input");
      input.className = "codex-web-workspace-root-input";
      if (allowMultiple) input.className += " codex-web-workspace-root-input-multiple";
      if (!allowMultiple) input.type = "text";
      input.autocomplete = "off";
      input.spellcheck = false;
      input.placeholder = t(
        allowMultiple ? "web.workspaceRoot.dialog.multiplePlaceholder" : "web.workspaceRoot.dialog.placeholder"
      );
      input.setAttribute(
        "aria-label",
        t(allowMultiple ? "web.workspaceRoot.dialog.multiplePathLabel" : "web.workspaceRoot.dialog.pathLabel")
      );
      panel.appendChild(input);

      const actions = document.createElement("div");
      actions.className = "codex-web-workspace-root-actions";

      const cancelButton = document.createElement("button");
      cancelButton.type = "button";
      cancelButton.className = "codex-web-workspace-root-button";
      cancelButton.textContent = t("common.cancel");
      actions.appendChild(cancelButton);

      const submitButton = document.createElement("button");
      submitButton.type = "submit";
      submitButton.className = "codex-web-workspace-root-button codex-web-workspace-root-button-primary";
      submitButton.textContent = t("web.workspaceRoot.dialog.confirm");
      actions.appendChild(submitButton);
      panel.appendChild(actions);

      function setBusy(busy) {
        // 提交期间锁住控件，避免重复发起校验或重复添加同一个项目。
        input.disabled = busy;
        cancelButton.disabled = busy;
        closeButton.disabled = busy;
        submitButton.disabled = busy;
        submitButton.textContent = busy
          ? t("web.workspaceRoot.dialog.confirming")
          : t("web.workspaceRoot.dialog.confirm");
      }

      function close(result) {
        // 弹窗关闭时必须清理全局 keydown 监听和单例状态，避免下次打开失焦。
        dialogState.focusInput = null;
        dialogState.promise = null;
        disposeKeydown?.();
        try {
          backdrop.remove();
        } catch {}
        resolve(result);
      }

      function cancel() {
        close(true);
      }

      function onKeyDown(event) {
        if (event.key === "Escape") {
          event.preventDefault();
          cancel();
        }
      }

      let disposeKeydown = null;

      panel.addEventListener("submit", async (event) => {
        event.preventDefault();
        setBusy(true);
        try {
          // 路径选择结果成功交给官方 Renderer/Main 后才关闭；失败只吐司并保留输入内容。
          await onSubmit(input.value);
          close(true);
        } catch (error) {
          showErrorToast(error);
          setBusy(false);
          w.requestAnimationFrame(() => {
            input.focus();
            input.select();
          });
        }
      });
      closeButton.addEventListener("click", cancel);
      cancelButton.addEventListener("click", cancel);
      backdrop.appendChild(panel);
      document.body.appendChild(backdrop);
      dialogState.focusInput = () => input.focus();
      disposeKeydown = adapterHost.events.observe({ key: {}, target: w, type: "keydown", capture: true, callback: onKeyDown });
      w.requestAnimationFrame(() => input.focus());
    });

    return dialogState.promise;
  }

  async function validateRemoteWorkspaceRoot(rawPath) {
    // 所有目录都先由运行 OpenCodex 的机器校验并注册到本地文件访问白名单。
    const validation = await invoke(WORKSPACE_ROOT_VALIDATE_CHANNEL, { path: rawPath });
    const root = validation && typeof validation.root === "string" ? validation.root : "";
    if (!root) {
      const error = new Error("Workspace root validation returned no path.");
      error.workspaceRootErrorKey = "web.workspaceRoot.error.unavailable";
      throw error;
    }
    return root;
  }

  async function submitRemoteWorkspaceRoots(payload, rawValue, mode, allowMultiple) {
    const paths = workspaceRootPaths(rawValue, allowMultiple);
    const roots = [];
    // 全部校验成功后才通知官方 Renderer，避免多选中途失败造成半完成的工程表单状态。
    for (const rawPath of paths) roots.push(await validateRemoteWorkspaceRoot(rawPath));

    if (mode === MESSAGE_MODE_PICK) {
      try {
        // 新协议由官方 Renderer 自己维护工程表单；逐条模拟 Main 的选择结果即可。
        for (const root of roots) deliverLocalRendererMessage(WORKSPACE_ROOT_PICKED_MESSAGE, { root });
        return;
      } catch (error) {
        error.workspaceRootErrorKey = "web.workspaceRoot.error.addFailed";
        throw error;
      }
    }

    try {
      // 旧协议仍交给官方 Main 持久化、刷新项目列表和切换选中状态。
      await invoke("codex_desktop:message-from-view", { ...payload, root: roots[0] });
    } catch (error) {
      error.workspaceRootErrorKey = "web.workspaceRoot.error.addFailed";
      throw error;
    }
  }

  function handleMessage(payload) {
    const mode = messageMode(payload);
    if (!mode) return null;
    const allowMultiple = mode === MESSAGE_MODE_PICK && allowsMultipleWorkspaceRoots(payload);
    return showDialog({
      allowMultiple,
      onSubmit: (rawValue) => submitRemoteWorkspaceRoots(payload, rawValue, mode, allowMultiple),
    });
  }

  w.OpenCodexWorkspaceRootPicker = {
    // polyfill 只调用这个公开入口，降低后续拆迁或替换 UI 实现的耦合。
    handleMessage,
    shouldHandleMessage,
  };
  w.OpenCodexRuntimeCompatibility?.installed?.("web.runtime.workspace.root-picker");
})();
