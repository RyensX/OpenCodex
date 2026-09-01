import { ModificationRuntime } from "./kernel";
import {
  ModificationHost,
  ModificationTargetRef,
  defineModificationTarget,
} from "./implementation";
import {
  AdapterRef,
  ModificationPointDefinition,
  PointGroupRef,
  defineAdapter,
  defineModificationPoint,
  definePointGroup,
} from "./sdk";

interface CatalogDeclaration<THost extends ModificationHost = ModificationHost> {
  readonly target: ModificationTargetRef<THost>;
}

function group(id: string, name: string, description: string, order: number): PointGroupRef {
  return definePointGroup({ id, name, description, order });
}

export const POINT_GROUPS = Object.freeze({
  rendererCore: group("renderer-core", "官方 Renderer 与 Gateway 核心桥", "承载官方 Renderer 运行所需的桌面能力、Bridge 和消息通道。", 10),
  startupHistory: group("startup-history", "首屏、历史会话和侧栏同步", "处理首屏预载、历史会话信号与侧栏快照交接。", 20),
  workspace: group("workspace-creation", "新项目和新工作树创建", "处理远端目录选择、工作区上下文和工作树环境。", 30),
  remoteFiles: group("remote-files", "远端文件预览和下载", "把官方本机文件行为转换为远端预览和下载。", 40),
  smartRouting: group("smart-routing", "Auto 模型智能调度", "提供模型目录、路由、摘要和设置界面的智能调度能力。", 50),
  notificationPower: group("notification-power", "通知和隐藏 Runtime 后台节能", "适配通知并限制隐藏 Runtime 的无效后台活动。", 60),
  tokenUsage: group("token-usage", "Token 用量", "提取并在消息界面展示线程 Token 使用情况。", 70),
  mobileInteraction: group("mobile-interaction", "移动端交互", "处理移动侧栏、软键盘、iOS 视口和触控行为。", 80),
  rendererUi: group("renderer-ui", "Renderer 界面兼容", "适配官方界面结构、浮层、标题栏和 Web 容器。", 90),
  browserPlatform: group("browser-platform", "浏览器平台能力", "把桌面原生能力映射为浏览器可用能力。", 100),
  webNetwork: group("web-network", "Web 网络适配", "处理浏览器网络请求和协议数据的兼容行为。", 110),
  projectNavigation: group("project-navigation", "项目与会话导航", "调整项目、会话和导航相关行为。", 120),
  gatewayRuntime: group("gateway-runtime", "Gateway Runtime", "管理隐藏官方 Runtime 的环境、Electron 和进程生命周期。", 130),
  gatewayIpc: group("gateway-ipc", "Gateway IPC", "处理 Gateway 与官方 Runtime 之间的 IPC 路由和消息整形。", 140),
  officialMain: group("official-main", "官方 main 优化", "对官方 main bundle 中的后台任务实施可验证优化。", 150),
  rendererResources: group("renderer-resources", "Renderer 静态资源", "对官方 Renderer HTML、CSP 和静态 chunk 实施可验证改写。", 160),
  runnerPackaging: group("runner-packaging", "Runner 打包", "生成、签名并组装各平台后台 Runner 产物。", 170),
});

function terminal<THost extends ModificationHost>(
  id: string,
  name: string,
  description: string,
): AdapterRef<CatalogDeclaration<THost>> {
  return defineAdapter({ id, name, description, kind: "terminal" });
}

function composite<THost extends ModificationHost>(
  id: string,
  name: string,
  description: string,
  dependencies: readonly AdapterRef<unknown>[],
): AdapterRef<CatalogDeclaration<THost>> {
  return defineAdapter({ id, name, description, kind: "composite", dependencies });
}

export const BASE_ADAPTERS = Object.freeze({
  runtimeView: terminal<"browser">("adapter.runtime-view", "运行时视图", "统一定位、观察、测量和修改浏览器视图。"),
  protocolPipeline: terminal<"browser" | "gateway">("adapter.protocol-pipeline", "协议管线", "统一解析、观察、转换和路由运行时消息。"),
  runtimeHook: terminal<"browser" | "gateway">("adapter.runtime-hook", "运行时 Hook", "统一包装函数、属性、构造器和模块导出。"),
  staticResource: terminal<"static">("adapter.static-resource", "静态资源改写", "统一定位、事务修改和验证静态资源。"),
  runtimeEnvironment: terminal<"gateway">("adapter.runtime-environment", "运行环境覆盖", "统一管理环境、启动开关和全局能力。"),
  processInterception: terminal<"gateway">("adapter.process-interception", "进程行为接管", "统一拦截子进程和系统打开行为。"),
  artifactBuild: terminal<"runner">("adapter.artifact-build", "产物构建", "统一暂存、组装、签名和提交 Runner 产物。"),
});

export const SEMANTIC_ADAPTERS = Object.freeze({
  semanticView: composite<"browser">(
    "adapter.semantic-view",
    "语义视图",
    "以稳定视图、槽位和虚拟内容描述界面修改。",
    [BASE_ADAPTERS.runtimeView],
  ),
  desktopBridge: composite<"browser">(
    "adapter.desktop-bridge",
    "桌面 Bridge",
    "把官方桌面接口映射到浏览器和 Gateway 能力。",
    [BASE_ADAPTERS.runtimeHook, BASE_ADAPTERS.protocolPipeline],
  ),
  browserNative: composite<"browser">(
    "adapter.browser-native",
    "浏览器原生能力",
    "使用浏览器视图和 Hook 模拟桌面原生能力。",
    [BASE_ADAPTERS.runtimeHook, BASE_ADAPTERS.runtimeView],
  ),
  networkRequest: composite<"browser">(
    "adapter.network-request",
    "网络请求适配",
    "通过共享 Hook 和协议管线接管网络请求。",
    [BASE_ADAPTERS.runtimeHook, BASE_ADAPTERS.protocolPipeline],
  ),
  mobileInteraction: composite<"browser">(
    "adapter.mobile-interaction",
    "移动端交互适配",
    "在语义视图之上统一移动端事件、视口和键盘行为。",
    [],
  ),
  officialRuntime: composite<"gateway">(
    "adapter.official-runtime",
    "官方 Runtime 适配",
    "组合环境、Hook 和进程能力以承载隐藏官方 Runtime。",
    [BASE_ADAPTERS.runtimeEnvironment, BASE_ADAPTERS.runtimeHook, BASE_ADAPTERS.processInterception],
  ),
  officialEnvironment: composite<"gateway">(
    "adapter.official-environment",
    "官方运行环境",
    "以官方 Runtime 语义声明启动前环境和 Chromium 开关。",
    [BASE_ADAPTERS.runtimeEnvironment],
  ),
  electronApi: composite<"gateway">(
    "adapter.electron-api",
    "Electron API",
    "以 Electron 模块和 API 语义声明运行时 Hook。",
    [BASE_ADAPTERS.runtimeHook],
  ),
  projectOrdering: composite<"browser">(
    "adapter.project-ordering",
    "项目排序",
    "以项目和会话排序语义声明 Bridge Hook。",
    [BASE_ADAPTERS.runtimeHook],
  ),
  gatewayIpc: composite<"gateway">(
    "adapter.gateway-ipc",
    "Gateway IPC 适配",
    "组合 Hook 与协议管线处理官方 IPC。",
    [BASE_ADAPTERS.runtimeHook, BASE_ADAPTERS.protocolPipeline],
  ),
  appServerProtocol: composite<"gateway">(
    "adapter.app-server-protocol",
    "App Server 协议适配",
    "在统一协议管线上实现 App Server 观察与转换。",
    [BASE_ADAPTERS.protocolPipeline],
  ),
  processBridge: composite<"gateway">(
    "adapter.process-bridge",
    "进程桥接",
    "组合进程接管和运行时 Hook 处理系统行为。",
    [BASE_ADAPTERS.processInterception, BASE_ADAPTERS.runtimeHook],
  ),
  semanticProtocol: composite<"browser">(
    "adapter.semantic-protocol",
    "语义协议",
    "把原始协议帧归一化为稳定的领域消息。",
    [BASE_ADAPTERS.protocolPipeline],
  ),
  officialMainPatch: composite<"static">(
    "adapter.official-main-patch",
    "官方 main 补丁",
    "在静态资源事务上定位并改写官方 main bundle。",
    [BASE_ADAPTERS.staticResource],
  ),
  officialRendererPatch: composite<"static">(
    "adapter.official-renderer-patch",
    "官方 Renderer 补丁",
    "在静态资源事务上定位并改写 Renderer HTML 和 chunk。",
    [BASE_ADAPTERS.staticResource],
  ),
  runnerArtifact: composite<"runner">(
    "adapter.runner-artifact",
    "Runner 产物",
    "在产物构建事务上组装各平台 Runner。",
    [BASE_ADAPTERS.artifactBuild],
  ),
});

// 移动端高级适配器依赖语义视图；单独赋值可避免对象初始化时引用尚未完成的字段。
const mobileInteractionAdapter = defineAdapter<CatalogDeclaration<"browser">>({
  ...SEMANTIC_ADAPTERS.mobileInteraction,
  dependencies: [SEMANTIC_ADAPTERS.semanticView],
});

export const ADAPTERS = Object.freeze({
  ...BASE_ADAPTERS,
  ...SEMANTIC_ADAPTERS,
  mobileInteraction: mobileInteractionAdapter,
});

type HostForPointId<TId extends string> =
  TId extends `static.cache.runner.${string}` ? "runner" :
  TId extends `static.cache.${string}` ? "static" :
  TId extends `gateway.runtime.${string}` ? "gateway" :
  TId extends `web.runtime.${string}` ? "browser" : never;

function hostForPoint<TId extends string>(id: TId): HostForPointId<TId> {
  if (id.startsWith("static.cache.runner.")) return "runner" as HostForPointId<TId>;
  if (id.startsWith("static.cache.")) return "static" as HostForPointId<TId>;
  if (id.startsWith("gateway.runtime.")) return "gateway" as HostForPointId<TId>;
  return "browser" as HostForPointId<TId>;
}

const pointTargets: ModificationTargetRef[] = [];

function point<const TId extends string>(
  id: TId,
  description: string,
  owner: string,
  pointGroup: PointGroupRef,
  ...pointAdapters: readonly AdapterRef<CatalogDeclaration<HostForPointId<TId>>>[]
): ModificationPointDefinition {
  const target = defineModificationTarget(id, hostForPoint(id));
  pointTargets.push(target);
  return defineModificationPoint({
    id,
    description,
    owner,
    group: pointGroup,
    // 修改点只携带强类型语义目标；终端 Provider 由 AdapterRef 对象身份自动选择。
    contributions: pointAdapters.map((adapter) => adapter.use({ target })),
  });
}

const G = POINT_GROUPS;
const A = ADAPTERS;

/**
 * 迁移矩阵是所有修改点的唯一目录：每个点必须显式绑定分类组和直接适配器。
 * 稳定 ID 沿用旧值，以保证报告历史、测试和跨进程回执继续兼容。
 */
export const POINT_DEFINITIONS = Object.freeze([
  point("web.runtime.platform.desktop-globals", "补齐官方 Renderer 依赖的桌面全局对象", "web-shell", G.rendererCore, A.desktopBridge),
  point("web.runtime.bridge.desktop-api", "代理官方桌面 Bridge API", "web-shell", G.rendererCore, A.desktopBridge),
  point("web.runtime.bridge.ipc-transport", "把 Renderer IPC 转换为 Gateway HTTP 或 WebSocket", "web-shell", G.rendererCore, A.desktopBridge),
  point("web.runtime.bridge.app-host-port", "把浏览器 MessagePort 接入官方 app-host", "web-shell", G.rendererCore, A.desktopBridge),
  point("web.runtime.bridge.persisted-atom", "同步官方 persisted atom", "web-shell", G.rendererCore, A.desktopBridge),
  point("web.runtime.bridge.shared-object", "模拟官方 shared-object 快照和订阅", "web-shell", G.rendererCore, A.desktopBridge),
  point("web.runtime.bridge.initial-sidebar", "暴露初始侧栏快照", "web-shell", G.rendererCore, A.desktopBridge),
  point("web.runtime.bridge.feature-gates", "注入 Web 环境所需桌面能力开关", "web-shell", G.workspace, A.desktopBridge),
  point("web.runtime.network.statsig", "本地响应 Statsig 初始化请求", "web-shell", G.webNetwork, A.networkRequest),
  point("web.runtime.network.telemetry", "阻止隐藏 Web 环境发送无效遥测", "web-shell", G.webNetwork, A.networkRequest),
  point("web.runtime.protocol.connector-logo", "合并 connector logo IPC 请求", "web-shell", G.webNetwork, A.semanticProtocol),
  point("web.runtime.dom.webview-shim", "使用 iframe 模拟 Electron webview", "web-shell", G.rendererUi, A.semanticView),
  point("web.runtime.native.file-picker", "把 Electron 文件选择转换为浏览器文件选择", "web-shell", G.browserPlatform, A.browserNative),
  point("web.runtime.native.ide-context", "为 Web 环境合成 IDE context", "web-shell", G.browserPlatform, A.browserNative),
  point("web.runtime.native.notification", "把 Gateway 通知映射为浏览器 Notification", "web-shell", G.notificationPower, A.browserNative),
  point("web.runtime.native.terminal", "有序转发官方终端消息", "web-shell", G.browserPlatform, A.browserNative),
  point("web.runtime.native.external-open", "把桌面打开行为转换为浏览器行为", "web-shell", G.remoteFiles, A.browserNative),
  point("web.runtime.dom.app-fs-image", "改写官方 app 文件图片地址", "web-shell", G.rendererUi, A.semanticView),
  point("web.runtime.dom.gateway-auth-menu", "向官方账号菜单插入 Gateway 退出入口", "web-shell", G.rendererUi, A.semanticView),
  point("web.runtime.workspace.root-picker", "接管远端项目和会话的目录选择", "web-shell", G.workspace, A.browserNative),
  point("web.runtime.dom.remote-file-menu", "向官方文件树菜单注入远端下载", "web-shell", G.remoteFiles, A.semanticView),
  point("web.runtime.dom.sidebar-preview-handoff", "把预渲染侧栏交接给官方侧栏", "web-shell", G.startupHistory, A.semanticView),
  point("web.runtime.dom.late-module-preload", "延迟加载非首屏官方模块", "web-shell", G.startupHistory, A.semanticView),
  point("web.runtime.dom.offscreen-animation", "暂停离屏官方动画", "web-shell", G.notificationPower, A.semanticView),
  point("web.runtime.dom.tooltip-dismiss", "适配官方 Tooltip 挂载和关闭", "web-shell", G.rendererUi, A.semanticView),
  point("web.runtime.dom.window-controls-overlay", "适配 PWA 标题栏和安全区", "web-shell", G.rendererUi, A.semanticView),
  point("web.runtime.smart-router.composer", "定位并适配官方模型选择器", "smart-router", G.smartRouting, A.semanticView),
  point("web.runtime.smart-router.settings", "向官方设置注入智能调度页面", "smart-router", G.smartRouting, A.semanticView),
  point("web.runtime.smart-router.summary", "在官方线程界面展示调度结果", "smart-router", G.smartRouting, A.semanticView),
  point("web.runtime.plugin.project-recent-sort", "调整项目和会话最近使用排序", "web-plugins", G.projectNavigation, A.projectOrdering),
  point("web.runtime.protocol.token-usage", "从官方协议提取线程 Token 用量", "web-shell", G.tokenUsage, A.semanticProtocol),
  point("web.runtime.dom.token-usage-inline", "在官方消息操作区插入 Token 用量", "web-plugins", G.tokenUsage, A.semanticView),
  point("web.runtime.plugin.mobile-sidebar", "移动端新会话后自动收起侧栏", "web-plugins", G.mobileInteraction, A.mobileInteraction),
  point("web.runtime.plugin.mobile-keyboard", "修正移动端发送后的键盘行为", "web-plugins", G.mobileInteraction, A.mobileInteraction),
  point("web.runtime.plugin.ios-layout", "修正 iOS 视口和键盘避让", "web-plugins", G.mobileInteraction, A.mobileInteraction),
  point("web.runtime.shell.legacy-document-replace", "兼容旧登录壳替换官方文档", "web-shell", G.rendererUi, A.semanticView),

  point("gateway.runtime.environment.official-app", "把 Gateway 环境对齐到官方桌面应用", "official-runtime", G.gatewayRuntime, A.officialEnvironment),
  point("gateway.runtime.environment.no-asar", "允许隐藏 Runtime 访问抽取目录", "official-runtime", G.gatewayRuntime, A.officialEnvironment),
  point("gateway.runtime.chromium.hidden-services", "关闭隐藏 Runtime 无效后台服务", "official-runtime", G.notificationPower, A.officialEnvironment),
  point("gateway.runtime.chromium.gcm-profile", "隔离隐藏 Runtime 的 GCM Profile", "official-runtime", G.notificationPower, A.officialEnvironment),
  point("gateway.runtime.node.electron-module-loader", "包装官方 electron 模块导出", "official-runtime", G.gatewayRuntime, A.electronApi),
  point("gateway.runtime.electron.notification", "替换官方 Notification", "official-runtime", G.notificationPower, A.electronApi),
  point("gateway.runtime.electron.tray", "替换官方 Tray", "official-runtime", G.notificationPower, A.electronApi),
  point("gateway.runtime.electron.ipc-main", "捕获官方 ipcMain 注册", "official-runtime", G.rendererCore, A.gatewayIpc),
  point("gateway.runtime.electron.ipc-event", "构造兼容的 Electron IPC 事件", "official-runtime", G.rendererCore, A.gatewayIpc),
  point("gateway.runtime.electron.browser-window", "隐藏官方 BrowserWindow", "official-runtime", G.gatewayRuntime, A.electronApi),
  point("gateway.runtime.electron.web-contents-send", "把官方 webContents 消息转发到浏览器", "official-runtime", G.rendererCore, A.gatewayIpc),
  point("gateway.runtime.electron.dialog-open", "接管隐藏窗口目录选择", "official-runtime", G.workspace, A.electronApi),
  point("gateway.runtime.electron.shell-open", "接管官方文件和外部地址打开行为", "official-runtime", G.remoteFiles, A.electronApi),
  point("gateway.runtime.electron.single-instance", "允许 Gateway 与官方桌面端并存", "official-runtime", G.gatewayRuntime, A.electronApi),
  point("gateway.runtime.electron.quit-dialog", "抑制隐藏 Runtime 退出确认框", "official-runtime", G.gatewayRuntime, A.electronApi),
  point("gateway.runtime.electron.dock-visibility", "保持隐藏 Runtime 不出现在 Dock", "official-runtime", G.gatewayRuntime, A.electronApi),
  point("gateway.runtime.process.app-server-launch", "重定向官方 App Server 可执行文件", "official-runtime", G.gatewayRuntime, A.processBridge),
  point("gateway.runtime.process.remote-file-manager", "把系统文件管理器命令转换为远端下载", "official-runtime", G.remoteFiles, A.processBridge),
  point("gateway.runtime.process.computer-use-installer", "兼容 Computer Use Installer 执行合约", "official-runtime", G.gatewayRuntime, A.processBridge),
  point("gateway.runtime.app-server.transport", "建立 App Server NDJSON 中间层", "smart-router", G.smartRouting, A.appServerProtocol),
  point("gateway.runtime.app-server.virtual-model", "向官方协议注入 Auto 模型", "smart-router", G.smartRouting, A.appServerProtocol),
  point("gateway.runtime.app-server.turn-router", "替换 turn/start 的真实模型和强度", "smart-router", G.smartRouting, A.appServerProtocol),
  point("gateway.runtime.app-server.internal-session", "隔离智能分类内部会话", "smart-router", G.smartRouting, A.appServerProtocol),
  point("gateway.runtime.app-server.route-metadata", "向官方通知注入调度元数据", "smart-router", G.smartRouting, A.appServerProtocol),
  point("gateway.runtime.app-server.history-context", "维护智能分类的有界历史上下文", "smart-router", G.smartRouting, A.appServerProtocol),
  point("gateway.runtime.app-host.relay", "中继浏览器与官方 app-host", "official-runtime", G.rendererCore, A.gatewayIpc),
  point("gateway.runtime.ipc.request-route", "按请求和客户端定向官方 IPC 响应", "official-runtime", G.gatewayIpc, A.gatewayIpc),
  point("gateway.runtime.ipc.chunked-message", "重组官方分块 IPC 并确认", "official-runtime", G.gatewayIpc, A.gatewayIpc),
  point("gateway.runtime.ipc.app-catalog-compaction", "压缩 Web 侧应用和插件目录", "official-runtime", G.gatewayIpc, A.gatewayIpc),
  point("gateway.runtime.ipc.hidden-renderer-suppression", "避免隐藏 Renderer 重复消费代理消息", "official-runtime", G.gatewayIpc, A.gatewayIpc),
  point("gateway.runtime.ipc.initial-sidebar-bootstrap", "读取并缓存官方初始侧栏快照", "official-runtime", G.startupHistory, A.gatewayIpc),
  point("gateway.runtime.ipc.thread-list-invalidation", "补发最近会话缓存失效", "official-runtime", G.startupHistory, A.gatewayIpc),
  point("gateway.runtime.ipc.live-observer", "观察官方 Desktop 本地实时协议", "official-runtime", G.startupHistory, A.gatewayIpc),
  point("gateway.runtime.ipc.workspace-context", "从官方 IPC 提取工作区上下文", "official-runtime", G.workspace, A.gatewayIpc),
  point("gateway.runtime.ipc.open-file-context", "把官方打开文件转换为浏览器预览", "official-runtime", G.remoteFiles, A.gatewayIpc),
  point("gateway.runtime.ipc.computer-use-auth", "短路已满足目标的 Computer Use 安装操作", "official-runtime", G.gatewayIpc, A.gatewayIpc),

  point("static.cache.main.native-pet.factory", "禁用隐藏 Runtime 的 Native Pet 工厂", "official-cache", G.notificationPower, A.officialMainPatch),
  point("static.cache.main.native-pet.prewarm", "跳过隐藏 Native Pet 预热", "official-cache", G.notificationPower, A.officialMainPatch),
  point("static.cache.main.native-pet.restore", "阻止隐藏 Profile 恢复 Native Pet", "official-cache", G.notificationPower, A.officialMainPatch),
  point("static.cache.main.macos-push-registration", "跳过隐藏 Runtime 的 macOS Push 注册", "official-cache", G.notificationPower, A.officialMainPatch),
  point("static.cache.main.git-origin-resolver", "合并侧栏 Git Origin 探测", "official-cache", G.officialMain, A.officialMainPatch),
  point("static.cache.main.git-local-prefilter", "在 Git 探测前执行本地仓库预检", "official-cache", G.officialMain, A.officialMainPatch),
  point("static.cache.main.git-background-command", "限制并缓存后台 Git 命令", "official-cache", G.officialMain, A.officialMainPatch),
  point("static.cache.main.worktree-shell-environment", "限制并缓存 Worktree Shell 环境请求", "official-cache", G.workspace, A.officialMainPatch),
  point("static.cache.renderer.html.lang", "改写官方 HTML 语言", "renderer-cache", G.rendererResources, A.officialRendererPatch),
  point("static.cache.renderer.html.viewport", "改写官方移动端 viewport", "renderer-cache", G.mobileInteraction, A.officialRendererPatch),
  point("static.cache.renderer.html.icon-pwa", "注入 Web 和 PWA 图标", "renderer-cache", G.rendererResources, A.officialRendererPatch),
  point("static.cache.renderer.html.asset-path-map", "映射官方静态资源路径", "renderer-cache", G.rendererResources, A.officialRendererPatch),
  point("static.cache.renderer.html.font-preload", "移除无法复用的字体预载", "renderer-cache", G.rendererResources, A.officialRendererPatch),
  point("static.cache.renderer.html.runtime-bootstrap", "注入 OpenCodex Web 运行时", "renderer-cache", G.rendererCore, A.officialRendererPatch),
  point("static.cache.renderer.html.startup-preload", "注入首屏静态资源预载", "renderer-cache", G.startupHistory, A.officialRendererPatch),
  point("static.cache.renderer.html.sidebar-preview", "注入首屏侧栏预览", "renderer-cache", G.startupHistory, A.officialRendererPatch),
  point("static.cache.renderer.html.loading-animation", "限制官方加载动画耗电", "renderer-cache", G.notificationPower, A.officialRendererPatch),
  point("static.cache.renderer.asset-namespace", "隔离修改后的官方资源缓存命名空间", "renderer-cache", G.rendererResources, A.officialRendererPatch),
  point("static.cache.renderer.csp.unsafe-eval", "允许官方 Web 运行时所需 unsafe-eval", "renderer-cache", G.rendererResources, A.officialRendererPatch),
  point("static.cache.renderer.csp.manifest-src", "允许同源 PWA Manifest", "renderer-cache", G.rendererResources, A.officialRendererPatch),
  point("static.cache.renderer.history-turn-signals", "补齐历史会话 Turn 信号", "renderer-cache", G.startupHistory, A.officialRendererPatch),
  point("static.cache.renderer.application-menu", "适配 Web 环境 Application Menu 能力", "renderer-cache", G.rendererResources, A.officialRendererPatch),
  point("static.cache.renderer.app-server-request-scheduling", "调整 App Server 后台请求调度", "renderer-cache", G.rendererResources, A.officialRendererPatch),
  point("static.cache.renderer.plugin-image-lazy-load", "延迟加载插件图片", "renderer-cache", G.rendererResources, A.officialRendererPatch),
  point("static.cache.renderer.open-in-folder-locale", "把打开文件夹文案改为远端下载", "renderer-cache", G.remoteFiles, A.officialRendererPatch),
  point("static.cache.runner.macos-background-bundle", "生成 macOS 后台 Runner Bundle", "runner-cache", G.runnerPackaging, A.runnerArtifact),
  point("static.cache.runner.macos-entry-signature", "签名 macOS Runner 入口副本", "runner-cache", G.runnerPackaging, A.runnerArtifact),
  point("static.cache.runner.portable-layout", "构建 Windows 和 Linux Runner 布局", "runner-cache", G.runnerPackaging, A.runnerArtifact),
  point("static.cache.runner.gateway-asar", "生成 OpenCodex Runner app.asar", "runner-cache", G.runnerPackaging, A.runnerArtifact),
  point("static.cache.runner.windows-asar-integrity", "修正 Windows Runner ASAR 完整性资源", "runner-cache", G.runnerPackaging, A.runnerArtifact),
]);

export const POINT_GROUP_DEFINITIONS = Object.freeze(Object.values(POINT_GROUPS));
export const POINT_TARGETS = Object.freeze(pointTargets);
export const ADAPTER_DEFINITIONS = Object.freeze(
  [...new Map(Object.values(ADAPTERS).map((adapter) => [adapter.id, adapter])).values()],
);

export const MIGRATION_MATRIX = Object.freeze(
  POINT_DEFINITIONS.map((definition, index) => {
    const target = POINT_TARGETS[index];
    if (!target) throw new Error(`修改点缺少语义目标：${definition.id}`);
    return Object.freeze({
      pointId: definition.id,
      groupId: definition.group.id,
      directAdapterIds: Object.freeze(definition.contributions.map((item) => item.adapter.id)),
      targetId: target.id,
      host: target.host,
      migrationStatus: "migrated" as const,
    });
  }),
);

export const POINT_DEFINITION_BY_ID: ReadonlyMap<string, ModificationPointDefinition> = new Map(
  POINT_DEFINITIONS.map((definition) => [definition.id, definition]),
);

export function registerModificationCatalog(
  runtime: ModificationRuntime,
  options: { readonly pointIds?: ReadonlySet<string> } = {},
): ModificationRuntime {
  for (const pointGroup of POINT_GROUP_DEFINITIONS) runtime.registerGroup(pointGroup);
  for (const adapter of ADAPTER_DEFINITIONS) runtime.registerAdapter(adapter);
  for (const adapter of ADAPTER_DEFINITIONS) {
    if (adapter.kind !== "composite") continue;
    const compositeAdapter = adapter as AdapterRef<unknown>;
    runtime.expand({
      adapter: compositeAdapter,
      expand(declaration) {
        return compositeAdapter.dependencies.map((dependency) => dependency.use(declaration));
      },
    });
  }
  for (const definition of POINT_DEFINITIONS) {
    if (!options.pointIds || options.pointIds.has(definition.id)) runtime.registerPoint(definition);
  }
  return runtime;
}
