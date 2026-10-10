const launcher = window.openCodexLauncher;
let currentState = null;
let pendingHostMode = "";
let currentLocale = "zh-CN";
let currentMessages = {};
// [OCX-FORK] 服务器中继面板「编辑中」标记：编辑期间禁止用已保存设置回填，否则状态推送会抹掉未保存的输入。
let relayEditing = false;

function $(id) {
  return document.getElementById(id);
}

function text(id, value) {
  const node = $(id);
  if (node) node.textContent = value || t("common.unknown");
}

function pathButton(id, value, fallbackKey) {
  const node = $(id);
  if (!node) return;
  node.textContent = value || t(fallbackKey || "common.notFound");
  node.title = value || "";
  node.dataset.path = value || "";
  node.disabled = !value;
}

function linkButton(id, value, fallbackKey) {
  const node = $(id);
  if (!node) return;
  // 关于区链接只负责展示地址；真实打开由主进程固定到可信仓库地址。
  node.textContent = value || t(fallbackKey || "common.notFound");
  node.title = value || "";
  node.disabled = !value;
}

function t(key, values) {
  const template = currentMessages[key] || key;
  if (!values || typeof values !== "object") return template;
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match
  );
}

function applyI18n() {
  // 静态 HTML 只保留中文 fallback；真实语言随 launcher state 到达后统一刷新。
  document.documentElement.lang = currentLocale;
  for (const node of document.querySelectorAll("[data-i18n]")) {
    node.textContent = t(node.dataset.i18n);
  }
  for (const node of document.querySelectorAll("[data-i18n-placeholder]")) {
    node.setAttribute("placeholder", t(node.dataset.i18nPlaceholder));
  }
  for (const node of document.querySelectorAll("[data-i18n-title]")) {
    node.setAttribute("title", t(node.dataset.i18nTitle));
  }
  for (const node of document.querySelectorAll("[data-i18n-aria-label]")) {
    node.setAttribute("aria-label", t(node.dataset.i18nAriaLabel));
  }
}

function syncI18n(state) {
  currentLocale = state.locale || currentLocale;
  currentMessages = state.messages && typeof state.messages === "object" ? state.messages : currentMessages;
  applyI18n();
}

function renderAuthStatus(enabled) {
  const node = $("authStatus");
  if (!node) return;
  const isEnabled = !!enabled;
  node.textContent = isEnabled ? t("launcher.settings.auth.enabled") : t("launcher.settings.auth.disabled");
  // 访问控制关闭是需要显眼提示的安全状态，单独加 class，避免影响其它 setting-status。
  node.classList.toggle("is-enabled", isEnabled);
  node.classList.toggle("is-disabled", !isEnabled);
}

function renderExternalPluginStatus(status) {
  const node = $("pluginDirsStatus");
  if (!node) return;
  const configured = !!(status && status.configured);
  const count = status && Number.isFinite(Number(status.count)) ? Number(status.count) : 0;
  node.textContent = configured
    ? t("launcher.settings.pluginDirs.enabled", { count })
    : t("launcher.settings.pluginDirs.disabled");
  // 外部目录为空是正常状态，不使用红色告警；配置后按启用状态显示绿色。
  node.classList.toggle("is-enabled", configured);
  node.classList.remove("is-disabled");
}

function renderLatestRelease(latestRelease) {
  const button = $("latestReleaseButton");
  if (!button) return;
  const available = !!(latestRelease && latestRelease.available && latestRelease.tagName);

  // 更新按钮只在 GitHub latest tag 与本地版本不同且链接已由主进程校验后显示。
  button.hidden = !available;
  button.disabled = !available;
  if (!available) {
    button.textContent = t("launcher.update.available");
    button.removeAttribute("title");
    button.removeAttribute("aria-label");
    return;
  }

  button.textContent = t("launcher.update.available");
  button.title = t("launcher.update.available");
  button.setAttribute("aria-label", t("launcher.update.available"));
}

function formatDateTime(value) {
  if (!value) return t("common.unknown");
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return t("common.unknown");
  return date.toLocaleString(currentLocale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function selectedHostMode() {
  const checked = document.querySelector('input[name="hostMode"]:checked');
  return checked ? checked.value : "local";
}

function renderHostMode(hostMode) {
  const value = pendingHostMode || (hostMode === "lan" ? "lan" : hostMode === "server" ? "server" : "local");
  for (const input of document.querySelectorAll('input[name="hostMode"]')) {
    input.checked = input.value === value;
    input.disabled = !!pendingHostMode;
  }
  // 服务器中继配置面板只在「启动地址 = 服务器」时展示。
  const panel = $("relayPanel");
  if (panel) panel.hidden = value !== "server";
}

// [OCX-FORK] 服务器中继面板渲染（upstream 无此函数；配套 DOM 见 index.html 的 relayPanel）。
function renderRelay(settings, authEnabled) {
  // 用户正在面板里编辑时跳过回填：launcher 会高频推送状态，回填会清掉未保存的输入。
  if (relayEditing) return;
  const relay = settings || {};
  const setVal = (id, v) => {
    const node = $(id);
    if (node && document.activeElement !== node) node.value = v;
  };
  setVal("relayHostInput", relay.relayHost || "");
  setVal("relayPortInput", relay.relayPort ? String(relay.relayPort) : "");
  setVal("relayCustomPathInput", relay.relayCustomPath || "");
  const deviceIdText = $("relayDeviceIdText");
  if (deviceIdText) {
    // 展示设备 MAC；访问后缀独立保存，不作为设备身份。
    deviceIdText.value = String(relay.relayDeviceId || "");
  }
  setVal("relayDeviceNameInput", relay.relayDeviceName || "");
  setVal("relaySecretInput", relay.relaySecret || "");
  const httpsToggle = $("relayUseHttpsInput");
  // 仅明确开启 HTTPS 时勾选，缺省使用 HTTP。
  if (httpsToggle) httpsToggle.checked = relay.relayUseHttps === true;
  // 服务器模式下未设置访问密码时提前提示（保存时主进程也会硬性拦截）。
  const errNode = $("relayErrorText");
  if (errNode) {
    const needPassword =
      (relay.hostMode || selectedHostMode()) === "server" && (relay.relayHost || "") !== "" && authEnabled === false;
    errNode.hidden = !needPassword;
    if (needPassword) errNode.textContent = t("launcher.settings.relay.needPassword");
  }
}

function renderPort(port) {
  const input = $("portInput");
  if (!input || document.activeElement === input) return;
  input.value = port ? String(port) : "";
}

function renderPluginDirs(pluginDirs) {
  const input = $("pluginDirsInput");
  if (!input || document.activeElement === input) return;
  input.value = pluginDirs || "";
}

function renderPreventSleep(preventSleep) {
  const input = $("preventSleepInput");
  if (!input) return;
  // 防睡眠开关只反映 launcher 持久化设置，真实系统能力由主进程同步。
  input.checked = !!preventSleep;
}

function renderOfficialAutoScanUpgrade(officialAutoScanUpgrade) {
  const input = $("officialAutoScanUpgradeInput");
  if (!input) return;
  // 旧版设置没有该字段时按默认开启展示，保持升级前后的启动行为一致。
  input.checked = officialAutoScanUpgrade !== false;
}

function renderUrls(state) {
  const urls = state.urls || {};
  const primary = urls.primary || state.url || "";

  const list = $("lanUrls");
  list.innerHTML = "";
  if (!primary) {
    list.hidden = true;
    return;
  }
  list.hidden = false;
  const button = document.createElement("button");
  button.className = "url-chip";
  button.type = "button";
  button.textContent = primary;
  button.title = primary;
  button.dataset.copyUrl = primary;
  list.appendChild(button);
}

function renderStatus(state) {
  const pill = $("statusPill");
  const running = !!state.running;
  // 服务已响应与整体健康分别展示，修改点失败不应让 Gateway 回到启动中。
  const connected = !!state.status;
  $("healthWarning").hidden = !(state.status ? state.status.ok !== true : !!state.lastError);
  const appServerMode = state.status && state.status.appServer ? state.status.appServer.mode : "";

  if (connected) {
    pill.textContent = appServerMode === "connected" ? t("launcher.status.ready") : t("launcher.status.gatewayStarted");
    pill.classList.remove("offline");
  } else if (running) {
    pill.textContent = t("launcher.status.starting");
    pill.classList.remove("offline");
  } else {
    pill.textContent = t("launcher.status.stopped");
    pill.classList.add("offline");
  }
}

function render(state) {
  currentState = state;
  syncI18n(state);
  const status = state.status || {};
  const gateway = status.gateway || {};
  const runtime = status.runtime || {};
  const official = status.officialBundle || {};
  const appServer = status.appServer || {};
  const paths = state.paths || {};
  const settings = state.settings || {};
  const appInfo = state.app || {};

  renderStatus(state);
  renderUrls(state);
  if (pendingHostMode && settings.hostMode === pendingHostMode) pendingHostMode = "";
  renderHostMode(settings.hostMode);
  renderRelay(settings, state.auth && state.auth.enabled);
  renderPort(settings.port || state.port);
  renderPluginDirs(settings.pluginDirs);
  renderPreventSleep(settings.preventSleep);
  renderOfficialAutoScanUpgrade(settings.officialAutoScanUpgrade);
  renderExternalPluginStatus(state.externalPlugins);

  // launcher 自身版本固定展示在左上角品牌区，避免占用设置列表空间。
  text("openCodexVersion", appInfo.version || t("common.unknown"));
  renderLatestRelease(state.latestRelease);
  // 底部关于区展示应用元信息，随 package.json 与主进程状态同步。
  linkButton("authorLink", appInfo.author, "common.unknown");
  linkButton("githubLink", appInfo.githubUrl, "common.notFound");
  const backup = state.bundleBackup || {};
  // 无可用备份时隐藏入口，还原期间保留禁用状态以防重复操作。
  $("restoreBundleBackup").disabled = !backup.available || backup.restoring;
  $("restoreBundleBackup").hidden = !backup.available;
  text("codexVersion", official.version || t("common.unknown"));
  text("codexBuild", official.build || t("common.unknown"));
  text("cacheUpdatedAt", formatDateTime(official.cacheProcessedAt));
  pathButton("codexAppPath", official.sourceAppPath);
  pathButton("sourceAsarPath", official.sourceAsarPath);
  pathButton("codexBinaryPath", official.codexBinaryPath);

  text("gatewayPid", state.pid ? String(state.pid) : t("common.notRunning"));
  text("gatewayStartedAt", formatDateTime(state.startedAt));
  text("gatewayListen", gateway.host && gateway.port ? `${gateway.host}:${gateway.port}` : `${state.host}:${state.port}`);
  text("appServerMode", appServer.mode || t("common.unknown"));
  text("nodeVersion", gateway.nodeVersion || t("common.unknown"));
  text("electronVersion", gateway.electronVersion || t("common.unknown"));
  pathButton("configPath", runtime.configPath || paths.configPath, "common.notCreated");
  pathButton("logPath", paths.logPath, "common.notCreated");
  pathButton("reportsDir", runtime.reportsDir || paths.reportsDir, "common.notCreated");
  pathButton("officialBundleDir", official.bundleDir || paths.officialBundleDir, "common.notCreated");
  renderAuthStatus(state.auth && state.auth.enabled);

  const error = $("lastError");
  const message = state.lastError || (appServer.lastError ? `app-server: ${appServer.lastError}` : "");
  if (message) {
    error.hidden = false;
    error.textContent = message;
  } else {
    error.hidden = true;
    error.textContent = "";
  }
}

async function refresh() {
  render(await launcher.getState());
}

document.addEventListener("click", async (event) => {
  const target = event.target;
  if (!target) return;

  if (target.id === "openCodex") {
    await launcher.openUrl();
    return;
  }
  if (target.id === "copyUrl") {
    const urls = currentState && currentState.urls ? currentState.urls : {};
    await launcher.copy(urls.primary || (currentState && currentState.url) || "");
    return;
  }
  if (target.dataset && target.dataset.copyUrl) {
    await launcher.copy(target.dataset.copyUrl);
    return;
  }
  if (target.id === "restoreBundleBackup") {
    target.disabled = true;
    try {
      render(await launcher.restoreBundleBackup());
    } finally {
      await refresh();
    }
    return;
  }
  if (target.id === "restart") {
    render(await launcher.restart());
    return;
  }
  if (target.id === "savePort") {
    const input = $("portInput");
    render(await launcher.updatePort(input ? input.value : ""));
    return;
  }
  if (target.id === "savePassword") {
    const input = $("passwordInput");
    render(await launcher.updatePassword(input ? input.value : ""));
    if (input) input.value = "";
    return;
  }
  if (target.id === "clearPassword") {
    const input = $("passwordInput");
    if (input) input.value = "";
    render(await launcher.updatePassword(""));
    return;
  }
  if (target.id === "choosePluginDir") {
    render(await launcher.choosePluginDir());
    return;
  }
  if (target.id === "savePluginDirs") {
    const input = $("pluginDirsInput");
    render(await launcher.updatePluginDirs(input ? input.value : ""));
    return;
  }
  if (target.id === "clearPluginDirs") {
    const input = $("pluginDirsInput");
    if (input) input.value = "";
    render(await launcher.updatePluginDirs(""));
    return;
  }
  // [OCX-FORK] 中继配置保存：失败保持编辑态并展示原因（如服务器模式未设访问密码）。
  if (target.id === "saveRelay") {
    const collect = (id) => {
      const node = $(id);
      return node ? node.value : "";
    };
    const httpsToggle = $("relayUseHttpsInput");
    // 保存成功后解除编辑态，用保存结果（含自动生成的设备 ID）回填面板。
    relayEditing = false;
    const errNode = $("relayErrorText");
    try {
      render(
        await launcher.updateRelay({
          relayHost: collect("relayHostInput"),
          relayPort: collect("relayPortInput"),
          relayDeviceName: collect("relayDeviceNameInput"),
          relayCustomPath: collect("relayCustomPathInput"),
          relaySecret: collect("relaySecretInput"),
          relayUseHttps: !!(httpsToggle && httpsToggle.checked),
        })
      );
      if (errNode) errNode.hidden = true;
    } catch (error) {
      // 主进程拒绝保存（如服务器模式未设置访问密码）：保持编辑态并展示原因。
      relayEditing = true;
      if (errNode) {
        errNode.hidden = false;
        const raw = (error && error.message) || String(error);
        errNode.textContent = raw.replace(/^Error invoking remote method '[^']*':\s*/i, "").replace(/^Error:\s*/i, "");
      }
    }
    return;
  }
  if (target.id === "openLogs") {
    await launcher.openLogs();
    return;
  }
  if (target.id === "githubLink") {
    await launcher.openGitHub();
    return;
  }
  if (target.id === "authorLink") {
    await launcher.openAuthor();
    return;
  }
  if (target.id === "latestReleaseButton") {
    await launcher.openLatestRelease();
    return;
  }
  if (target.id === "healthWarning") {
    await launcher.openHealth();
    return;
  }
  if (target.classList && target.classList.contains("path")) {
    const targetPath = target.dataset.path;
    if (targetPath) await launcher.revealPath(targetPath);
  }
});

document.addEventListener("focusin", (event) => {
  // 点进中继面板任意输入框即视为编辑开始，直到保存或切换模式才恢复回填。
  const target = event.target;
  if (target && typeof target.closest === "function" && target.closest("#relayPanel")) {
    relayEditing = true;
  }
});

document.addEventListener("keydown", async (event) => {
  const target = event.target;
  if (!target || event.key !== "Enter") return;
  if (target.id === "portInput") {
    event.preventDefault();
    render(await launcher.updatePort(target.value));
  }
  if (target.id === "pluginDirsInput") {
    event.preventDefault();
    render(await launcher.updatePluginDirs(target.value));
  }
});

document.addEventListener("change", async (event) => {
  const target = event.target;
  if (!target) return;
  if (target.name === "hostMode") {
    const hostMode = selectedHostMode();
    pendingHostMode = hostMode;
    // 切换启动地址时放弃未保存的中继编辑，恢复为已保存值。
    relayEditing = false;
    renderHostMode(hostMode);
    render(await launcher.updateHostMode(hostMode));
    return;
  }
  if (target.id === "preventSleepInput") {
    target.disabled = true;
    try {
      render(await launcher.updatePreventSleep(target.checked));
    } finally {
      target.disabled = false;
    }
    return;
  }
  if (target.id === "officialAutoScanUpgradeInput") {
    target.disabled = true;
    try {
      render(await launcher.updateOfficialAutoScanUpgrade(target.checked));
    } finally {
      target.disabled = false;
    }
    return;
  }
});

launcher.onState(render);
refresh().catch((error) => {
  render({
    running: false,
    url: "",
    paths: {},
    status: null,
    lastError: error instanceof Error ? error.message : String(error),
  });
});
