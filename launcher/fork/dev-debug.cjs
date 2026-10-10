// launcher/fork/dev-debug.cjs
// [OCX-FORK] 开发期诊断基建：CDP 调试端口 + renderer 事件探针 + console 转发。
// 只在 dev（未打包）环境生效，打包版零行为差异。
// 集中成单文件的目的：fork 合并 upstream 时，main.cjs 的 createWindow 只留一行调用点。
//
// 组成：
// 1. enableDevRemoteDebugging(app) —— dev 直跑时开放 CDP 9222 端口，供自动化脚本验证 UI 链路。
// 2. attachWindowDiagnostics(win, appendLog) —— 把 renderer console 转发进 launcher 日志
//    （带本地时间戳，方便把用户操作时间与日志对齐）；并在每次页面加载完成后注入
//    捕获阶段事件探针。捕获阶段挂在 window 上，任何 CSS 遮挡/pointer-events/事件提前
//    拦截都逃不过这一层；同时捕获 renderer 未捕获异常，避免「监听器没注册」这类问题无迹可寻。
const PROBE_SCRIPT = `
(function () {
  try {
    window.addEventListener('error', function (e) {
      console.log('[relay-probe] window.error: ' + (e.message || e.error));
    });
    window.addEventListener('unhandledrejection', function (e) {
      console.log('[relay-probe] unhandledrejection: ' + ((e.reason && e.reason.message) || e.reason));
    });
    ['pointerdown', 'pointerup', 'click', 'focusin'].forEach(function (type) {
      window.addEventListener(type, function (e) {
        var t = e.target;
        var id = t && t.id ? t.id : (t && t.tagName) || '?';
        console.log('[relay-probe] ' + type + ' target=' + id + ' trusted=' + e.isTrusted);
      }, true);
    });
    console.log('[relay-probe] installed');
  } catch (err) {
    console.log('[relay-probe] install failed: ' + err.message);
  }
})();
`;

function enableDevRemoteDebugging(app) {
  if (!app.isPackaged) {
    app.commandLine.appendSwitch("remote-debugging-port", "9222");
  }
}

function attachWindowDiagnostics(win, appendLog) {
  win.webContents.on("console-message", (_event, _level, message) => {
    const stamp = new Date().toTimeString().slice(0, 8);
    appendLog(`[renderer-console ${stamp}] ${message}\n`);
  });
  win.webContents.on("did-finish-load", () => {
    win.webContents.executeJavaScript(PROBE_SCRIPT).catch(() => {});
  });
}

module.exports = { enableDevRemoteDebugging, attachWindowDiagnostics };
