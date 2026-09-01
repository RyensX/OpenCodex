import {
  ArtifactBuildDeclaration,
  ProcessInterceptionDeclaration,
  RuntimeEnvironmentDeclaration,
  StaticResourceDeclaration,
  RuntimeViewDeclaration,
  createArtifactBuildApi,
  createProcessInterceptionApi,
  createProtocolPipelineApi,
  createRuntimeEnvironmentApi,
  createRuntimeViewApi,
  createStaticResourceApi,
  defineArtifactTarget,
  defineEnvironmentKey,
  defineProcessTarget,
  defineResourceLocator,
  defineResourceTarget,
  defineProtocolChannel,
  defineProtocolSchema,
  defineViewLocator,
  defineViewSlot,
  defineViewTarget,
} from "./contracts";
import { ProtocolDeclaration } from "./contracts";
import {
  defineAdapter,
  defineCapability,
  defineModificationPoint,
  definePlugin,
  definePointGroup,
  defineSignal,
} from "./sdk";
import { ModificationTargetRef, defineModificationTarget } from "./implementation";

const browserOnlyAdapter = defineAdapter<{ readonly target: ModificationTargetRef<"browser"> }>({
  id: "adapter.type-test-browser-host",
  name: "浏览器宿主约束",
  description: "只接受浏览器语义目标",
  kind: "terminal",
});
const gatewayTarget = defineModificationTarget("gateway.runtime.type-test", "gateway");
browserOnlyAdapter.use({
  // @ts-expect-error Gateway 目标不能传给只允许浏览器宿主的适配器。
  target: gatewayTarget,
});

const pluginGroup = definePointGroup({
  id: "type-test-plugin-group",
  name: "插件类型测试",
  description: "验证修改点只能引用强类型插件对象",
  order: 1,
});
const pluginRef = definePlugin({ id: "type-test.plugin", name: "类型测试插件" });
defineModificationPoint({
  id: "type-test.plugin.point",
  description: "强类型插件修改点",
  owner: pluginRef.id,
  plugin: pluginRef,
  group: pluginGroup,
  contributions: [browserOnlyAdapter.use({ target: defineModificationTarget("web.runtime.type-test-plugin", "browser") })],
});
defineModificationPoint({
  id: "type-test.plugin.invalid-point",
  description: "伪造插件引用",
  owner: "type-test.plugin",
  // @ts-expect-error 插件归属必须引用 definePlugin 返回的不可伪造对象。
  plugin: { id: "type-test.plugin", name: "类型测试插件" },
  group: pluginGroup,
  contributions: [browserOnlyAdapter.use({ target: defineModificationTarget("web.runtime.type-test-plugin-invalid", "browser") })],
});

interface ThreadActionModel {
  readonly turnId: string;
}

interface SidebarModel {
  readonly threadId: string;
}

const viewAdapter = defineAdapter<RuntimeViewDeclaration>({
  id: "adapter.type-test-view",
  name: "类型测试视图",
  description: "只用于编译期接口约束",
  kind: "terminal",
});
const view = createRuntimeViewApi(viewAdapter);
const threadTarget = defineViewTarget("view.thread-actions", defineViewLocator<ThreadActionModel>("locator.thread-actions"));
const sidebarTarget = defineViewTarget("view.sidebar", defineViewLocator<SidebarModel>("locator.sidebar"));
const threadSlot = defineViewSlot("slot.thread-after-fork", threadTarget);
const sidebarSlot = defineViewSlot("slot.sidebar-footer", sidebarTarget);
const usageSignal = defineSignal<{ readonly input: number }>("signal.token-usage");

view.mount({
  target: threadTarget,
  slot: threadSlot,
  source: usageSignal,
  render({ data, model, ui }) {
    return ui.text(`${model.turnId}:${data.input}`);
  },
});

view.mountLowLevel({
  locator: defineViewLocator<ThreadActionModel>("locator.low-level-thread"),
  // @ts-expect-error 挂载位置必须由工厂创建，不能伪造同形字符串对象。
  placement: { id: "slot.fake" },
  source: usageSignal,
  render({ ui }) {
    return ui.text("invalid placement");
  },
});

view.mount({
  target: threadTarget,
  // @ts-expect-error Sidebar 槽位不能挂载到线程操作区。
  slot: sidebarSlot,
  source: usageSignal,
  render({ ui }) {
    return ui.text("invalid");
  },
});

const protocolAdapter = defineAdapter<ProtocolDeclaration>({
  id: "adapter.type-test-protocol",
  name: "类型测试协议",
  description: "只用于编译期 Schema 约束",
  kind: "terminal",
});
const protocol = createProtocolPipelineApi(protocolAdapter);
const numberChannel = defineProtocolChannel<number>("channel.number");
const stringSchema = defineProtocolSchema<string, string>("schema.string", (value) => value);

protocol.observe({
  channel: numberChannel,
  // @ts-expect-error number Channel 不能使用 string Schema。
  schema: stringSchema,
  publishTo: defineSignal<string>("signal.string"),
  map: (value) => value,
});

void sidebarTarget;

const environmentAdapter = defineAdapter<RuntimeEnvironmentDeclaration>({
  id: "adapter.type-test-environment",
  name: "类型测试环境",
  description: "只用于编译期环境值约束",
  kind: "terminal",
});
const environment = createRuntimeEnvironmentApi(environmentAdapter);
const timeoutKey = defineEnvironmentKey<number>("environment.timeout", "pre-bootstrap");
environment.provide({
  key: timeoutKey,
  // @ts-expect-error number 环境键不能接收 string。
  value: "slow",
});

interface LaunchRequest {
  readonly executable: string;
}
const processAdapter = defineAdapter<ProcessInterceptionDeclaration>({
  id: "adapter.type-test-process",
  name: "类型测试进程",
  description: "只用于编译期进程请求约束",
  kind: "terminal",
});
const processApi = createProcessInterceptionApi(processAdapter);
const launchTarget = defineProcessTarget<LaunchRequest, number>("process.launch");
processApi.intercept({
  target: launchTarget,
  handle({ proceed }) {
    // @ts-expect-error 进程目标的请求结构不能用字符串替代。
    return proceed("invalid");
  },
});

interface BundleSpec {
  readonly platform: "mac" | "win";
}
const artifactAdapter = defineAdapter<ArtifactBuildDeclaration>({
  id: "adapter.type-test-artifact",
  name: "类型测试产物",
  description: "只用于编译期产物规格约束",
  kind: "terminal",
});
const artifacts = createArtifactBuildApi(artifactAdapter);
const bundleTarget = defineArtifactTarget<BundleSpec, Uint8Array>("artifact.runner-bundle");
artifacts.build({
  target: bundleTarget,
  // @ts-expect-error platform 必须是目标声明允许的平台。
  spec: { platform: "linux" },
  publishTo: defineCapability<Uint8Array>("capability.runner-bytes"),
});

const staticAdapter = defineAdapter<StaticResourceDeclaration>({
  id: "adapter.type-test-static",
  name: "类型测试静态资源",
  description: "只用于编译期资源与 Locator 约束",
  kind: "terminal",
});
const staticResources = createStaticResourceApi(staticAdapter);
const htmlResource = defineResourceTarget<{ html: string }>("resource.renderer-html");
const binaryLocator = defineResourceLocator<Uint8Array, number>("locator.binary-offset");
staticResources.transform({
  resource: htmlResource,
  // @ts-expect-error HTML 资源不能使用二进制偏移 Locator。
  locator: binaryLocator,
  expectedCandidates: 1,
  transform(document) {
    return document;
  },
  verify: () => true,
});
