const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { PATCHED_OFFICIAL_PREFIX } = require("../runtime/core/config.cjs");
const { createStaticAssetService } = require("../runtime/http/static-assets.cjs");

const WEB_SHELL_INDEX = path.resolve(__dirname, "..", "..", "web-shell", "index.html");
const BRIDGE_POLYFILL = path.resolve(__dirname, "..", "..", "web-shell", "codex-bridge-polyfill.js");
const SMART_SCHEDULING_SETTINGS = path.resolve(
  __dirname,
  "..",
  "..",
  "web-shell",
  "codex-smart-model-router-settings.js"
);
const SMART_SCHEDULING_INJECTION_HEALTH = path.resolve(
  __dirname,
  "..",
  "..",
  "web-shell",
  "codex-smart-scheduling-injection-health.js"
);
const SMART_SCHEDULING_COMPOSER = path.resolve(
  __dirname,
  "..",
  "..",
  "web-shell",
  "codex-smart-model-router-composer.js"
);
const SMART_SCHEDULING_SUMMARY = path.resolve(
  __dirname,
  "..",
  "..",
  "web-shell",
  "codex-smart-scheduling-summary.js"
);
const SMART_SCHEDULING_SUMMARY_CSS = path.resolve(
  __dirname,
  "..",
  "..",
  "web-shell",
  "codex-smart-scheduling-summary.css"
);
const SMART_SCHEDULING_PLUGIN_DIR = path.resolve(
  __dirname,
  "..",
  "..",
  "web-shell",
  "plugins",
  "smart-model-router"
);

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

function serveOfficialAssetResponse(service, reqPath, host = "localhost:3737") {
  const file = service.staticFile(reqPath);
  const res = makeResponseRecorder();
  service.serveFile({ headers: { host } }, res, file, 200, reqPath);
  return res;
}

test("web shell manifest requests credentials for protected origins", () => {
  const html = fs.readFileSync(WEB_SHELL_INDEX, "utf-8");

  assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest" crossorigin="use-credentials" \/>/);
});

test("bridge keeps synchronous official preload methods out of the adaptive IPC fallback", () => {
  const source = fs.readFileSync(BRIDGE_POLYFILL, "utf-8");

  // 这两个官方 preload 方法必须同步返回基础值；一旦返回 Promise，最新版 renderer 会在首屏直接崩溃。
  assert.match(source, /target\.getPreloadStartedAtMs = \(\) => preloadStartedAtMs;/);
  assert.match(source, /target\.getInitialSidebarBootstrap = \(\) => cfg\.initialSidebarBootstrap \?\? null;/);
  assert.match(source, /target\.isDeviceCheckSupported = \(\) => false;/);
  assert.match(source, /target\.startFileDrag = \(\) => false;/);
  assert.ok(source.indexOf("target.getInitialSidebarBootstrap") < source.indexOf("createAdaptiveBridgeProxy"));
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
  assert.equal(
    service.staticFile("/codex-remote-file-actions.js"),
    path.resolve(__dirname, "..", "..", "web-shell", "codex-remote-file-actions.js")
  );
});

test("injects smart scheduling settings and summary into the authenticated renderer", (t) => {
  const webviewDir = makeOfficialWebviewDir(t);
  const service = createService(webviewDir);
  const html = service.createRendererResponse();

  assert.match(html, /codex-smart-model-router-settings\.css/);
  assert.match(html, /codex-smart-scheduling-injection-health\.js/);
  assert.match(html, /codex-smart-model-router-settings\.js/);
  assert.match(html, /codex-smart-model-router-composer\.js/);
  assert.match(html, /codex-smart-scheduling-summary\.css/);
  assert.match(html, /codex-smart-scheduling-summary\.js/);
  assert.equal(
    html.indexOf("codex-smart-scheduling-injection-health.js") < html.indexOf("codex-smart-model-router-settings.js"),
    true
  );
  assert.equal(
    service.staticFile("/codex-smart-scheduling-injection-health.js"),
    SMART_SCHEDULING_INJECTION_HEALTH
  );
  assert.equal(
    service.staticFile("/codex-smart-model-router-settings.js"),
    path.resolve(__dirname, "..", "..", "web-shell", "codex-smart-model-router-settings.js")
  );
  assert.equal(
    service.staticFile("/codex-smart-scheduling-summary.js"),
    path.resolve(__dirname, "..", "..", "web-shell", "codex-smart-scheduling-summary.js")
  );
});

test("smart scheduling hides placeholder effort only while the composer model is Auto", () => {
  const source = fs.readFileSync(SMART_SCHEDULING_COMPOSER, "utf-8");

  // 适配器依赖官方模型触发器和模型行标记，并在切回具体模型时主动移除自己的状态。
  assert.match(source, /data-codex-intelligence-trigger/);
  assert.match(source, /data-model-picker-model-row/);
  assert.match(source, /removeAttribute\("data-opencodex-auto-model"\)/);
  assert.match(source, /opencodexAutoEffortItem/);
  assert.match(source, /get autoSelected\(\)/);
});

test("smart scheduling reuses Codex picker styling without repeated model identities", () => {
  const source = fs.readFileSync(SMART_SCHEDULING_SETTINGS, "utf-8");

  // 锁定官方选择器样式复用和账户图标来源，避免后续回退成原生 select 或重复拼接名称与 ID。
  assert.match(source, /NATIVE_PICKER_TRIGGER_FALLBACK_CLASS/);
  assert.match(source, /aria-haspopup\", \"menu/);
  assert.match(source, /normalizedModelIdentity/);
  assert.match(source, /opencodexIconSource = "account"/);
  assert.match(source, /data-settings-panel-slug=\"personalization\"/);
  assert.doesNotMatch(source, /accountNavLabel/);
  assert.doesNotMatch(source, /createElement\("select"/);
});

test("smart scheduling injection health reports every renderer injection point", () => {
  const health = fs.readFileSync(SMART_SCHEDULING_INJECTION_HEALTH, "utf-8");
  const settings = fs.readFileSync(SMART_SCHEDULING_SETTINGS, "utf-8");
  const composer = fs.readFileSync(SMART_SCHEDULING_COMPOSER, "utf-8");
  const summary = fs.readFileSync(SMART_SCHEDULING_SUMMARY, "utf-8");

  assert.match(health, /api\/opencodex\/model-router\/injections/);
  assert.match(health, /data-opencodex-smart-scheduling-injection-health/);
  assert.match(settings, /report\("settings-page"\)/);
  assert.match(composer, /report\("composer-adapter"\)/);
  assert.match(summary, /report\("summary-adapter"\)/);
});

test("smart scheduling settings localize tier and field labels", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(SMART_SCHEDULING_PLUGIN_DIR, "plugin.json"), "utf-8"));
  const zh = JSON.parse(fs.readFileSync(path.join(SMART_SCHEDULING_PLUGIN_DIR, "i18.zh.json"), "utf-8"));
  const en = JSON.parse(fs.readFileSync(path.join(SMART_SCHEDULING_PLUGIN_DIR, "i18.en.json"), "utf-8"));

  // 档位标题和字段名分别翻译，字段不再重复档位名称；auto 保持协议中的小写形式。
  assert.equal(zh["plugin.smartModelRouter.group.balanced"], "均衡");
  assert.equal(en["plugin.smartModelRouter.group.balanced"], "Balanced");
  assert.equal(zh["plugin.smartModelRouter.setting.model"], "模型");
  assert.equal(en["plugin.smartModelRouter.setting.effort"], "Reasoning effort");
  // 认证前插件页必须明确说明选择 Auto 后会同时自动选择模型与推理强度。
  assert.match(zh["plugin.smartModelRouter.desc"], /选择 Auto.*自动选择模型和推理强度/);
  assert.match(en["plugin.smartModelRouter.desc"], /Selecting Auto.*model and reasoning effort/);
  assert.equal(zh["plugin.smartModelRouter.group.display"], "显示");
  assert.equal(zh["plugin.smartModelRouter.summary.title"], "智能调度");
  assert.equal(zh["plugin.smartModelRouter.summary.model"], "模型");
  assert.equal(zh["plugin.smartModelRouter.summary.effort"], "推理强度");
  assert.equal(zh["plugin.smartModelRouter.summary.determining"], "正在判断…");
  assert.equal(en["plugin.smartModelRouter.summary.title"], "Smart scheduling");
  assert.equal(en["plugin.smartModelRouter.summary.model"], "Model");
  assert.equal(en["plugin.smartModelRouter.summary.effort"], "Reasoning effort");
  assert.equal(en["plugin.smartModelRouter.summary.determining"], "Determining…");
  assert.equal(zh["plugin.smartModelRouter.health.title"], "功能健康");
  assert.equal(zh["plugin.smartModelRouter.health.point.app-server-router"], "路由装饰器");
  assert.equal(zh["plugin.smartModelRouter.health.point.auto-model-catalog"], "模型注入");
  assert.equal(zh["plugin.smartModelRouter.health.point.settings-page"], "智能调度设置注入");
  assert.equal(zh["plugin.smartModelRouter.health.point.composer-adapter"], "适配器注入");
  assert.equal(zh["plugin.smartModelRouter.health.point.summary-adapter"], "摘要适配器注入");
  assert.equal(zh["plugin.smartModelRouter.health.point.route-presentation"], "路由状态展示桥绑定");
  assert.equal(en["plugin.smartModelRouter.health.summary.ok"], "All injection points are healthy");
  const injectionHealthSource = fs.readFileSync(SMART_SCHEDULING_INJECTION_HEALTH, "utf-8");
  assert.doesNotMatch(injectionHealthSource, /health-detail/);
  // 健康标题必须保留在卡片内部，并与其他设置卡片处于同一层级。
  assert.match(injectionHealthSource, /card\.appendChild\(header\)/);
  assert.match(injectionHealthSource, /root\.appendChild\(card\)/);
  assert.equal(manifest.settings.find((setting) => setting.id === "showRouteInSummary").defaultValue, true);
  assert.equal(manifest.settings.find((setting) => setting.id === "balancedModel").labelKey, "plugin.smartModelRouter.setting.model");
  assert.match(fs.readFileSync(SMART_SCHEDULING_SETTINGS, "utf-8"), /label: effort/);
});

test("smart scheduling summary follows root-path task context and only active Auto turns", () => {
  const source = fs.readFileSync(SMART_SCHEDULING_SUMMARY, "utf-8");
  const styles = fs.readFileSync(SMART_SCHEDULING_SUMMARY_CSS, "utf-8");
  const bridge = fs.readFileSync(path.resolve(__dirname, "..", "..", "web-shell", "codex-bridge-polyfill.js"), "utf-8");

  // 独立分类复用官方摘要面板结构，所有文案读取插件 i18n，并覆盖三类终止路径。
  assert.match(source, /data-pip-obstacle="thread-summary-panel/);
  assert.match(source, /plugin\.smartModelRouter\.summary\.title/);
  assert.match(source, /plugin\.smartModelRouter\.summary\.model/);
  assert.match(source, /plugin\.smartModelRouter\.summary\.effort/);
  assert.match(source, /plugin\.smartModelRouter\.summary\.determining/);
  assert.match(source, /thread-summary-panel-item-label/);
  assert.match(source, /opencodex\/smart-scheduling/);
  assert.match(source, /turn\/started/);
  assert.match(source, /turn\/completed/);
  assert.match(source, /turn\/failed/);
  assert.match(source, /turn\/interrupted/);
  assert.match(source, /VISIBLE_THREAD_METHODS/);
  assert.match(source, /direction === "client"/);
  assert.match(source, /visibleThreadId/);
  assert.match(source, /isAutoTurn/);
  assert.match(source, /PROTOCOL_ENVELOPE_KEYS/);
  assert.match(source, /selectVisibleThread\(threadId\)/);
  assert.match(source, /pending\?\.pending \|\| autoSelected/);
  assert.match(source, /active-route\?threadId=/);
  assert.match(source, /get diagnostics\(\)/);
  assert.doesNotMatch(source, /environmentTitles|findEnvironment/);
  assert.doesNotMatch(source, /rationale/);
  assert.match(bridge, /OpenCodexSmartSchedulingBridgeDiagnostics/);
  assert.match(bridge, /protocolFrames/);
  assert.match(bridge, /handleSmartSchedulingGatewayMessage/);
  assert.match(source, /handleRouteEvent/);
  assert.match(source, /value\.displayName \|\| modelId/);
  assert.match(styles, /max-width: 75% !important/);
  assert.doesNotMatch(styles, /flex: 1 1 auto/);
});

test("web shell exposes only the smart router gateway switch before authentication", () => {
  const html = fs.readFileSync(WEB_SHELL_INDEX, "utf-8");

  assert.match(html, /plugin\.feature === "smart-model-router"/);
  assert.match(html, /opencodex-gateway-plugin-switches\.js/);
  assert.match(html, /gatewayPluginSwitches\?\.sync/);
});

test("plugin loader registers manifest-only plugins without inventing an index script", (t) => {
  const webviewDir = makeOfficialWebviewDir(t);
  const service = createService(webviewDir);
  const response = makeResponseRecorder();
  service.servePluginLoader(response);
  const source = response.body.toString("utf-8");

  assert.match(source, /opencodex\.smart-model-router/);
  assert.doesNotMatch(source, /smart-model-router\/index\.js/);
  assert.match(source, /registerPlugin\(manifest\)/);
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

test("caches current patched assets without making the legacy prefix immutable", (t) => {
  const webviewDir = makeOfficialWebviewDir(t);
  const assetsDir = path.join(webviewDir, "assets");
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.writeFileSync(path.join(assetsDir, "app-test.js"), "export const ready = true;");
  const service = createService(webviewDir);

  const current = serveOfficialAssetResponse(service, `${PATCHED_OFFICIAL_PREFIX}assets/app-test.js`);
  const legacy = serveOfficialAssetResponse(service, "/official-patched/assets/app-test.js");

  assert.equal(current.headers["cache-control"], "public, max-age=31536000, immutable");
  assert.equal(legacy.headers["cache-control"], "no-store");
});
