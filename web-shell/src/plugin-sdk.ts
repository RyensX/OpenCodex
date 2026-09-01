import { ADAPTERS, POINT_DEFINITIONS, POINT_GROUPS } from "../../gateway/src/modification/catalog";
import {
  AdapterRef,
  AdapterUse,
  ModificationPointDefinition,
  PluginRef,
  PointGroupRef,
  defineAdapter,
  defineModificationPoint,
  definePlugin,
  definePointGroup,
  isAdapterRef,
  isAdapterUse,
  isPointGroupRef,
} from "../../gateway/src/modification/sdk";
import {
  AdapterExecutionReporter,
  BoundContribution,
  RuntimeSnapshot,
  TerminalAdapterProvider,
  createModificationRuntime,
} from "../../gateway/src/modification/kernel";

interface BrowserAdapterHost {
  readonly lifecycle: {
    createScope(): {
      run<TResult>(operation: () => TResult): TResult;
      dispose(): void;
    };
  };
  readonly dom: {
    observe(input: {
      key: object;
      root: Node;
      options: MutationObserverInit;
      callback: MutationCallback;
    }): () => void;
  };
  readonly events: {
    observe(input: {
      key: object;
      target: EventTarget;
      type: string;
      capture?: boolean;
      passive?: boolean;
      once?: boolean;
      callback: EventListener;
    }): () => void;
  };
  readonly hooks: {
    around(input: {
      key: object;
      target: Record<PropertyKey, unknown>;
      property: PropertyKey;
      order?: number;
      handle(thisValue: unknown, args: readonly unknown[], proceed: (args?: readonly unknown[]) => unknown): unknown;
    }): () => void;
  };
  readonly protocol: {
    readonly channels: Readonly<Record<string, object>>;
    observe(input: {
      key: object;
      channel: object;
      callback(frame: { readonly value: unknown }): unknown;
    }): () => void;
  };
}

interface PluginManifestV2 {
  readonly id: string;
  readonly apiVersion: 2;
  readonly sdkVersion: string;
  readonly name?: string;
  readonly label?: string;
  readonly desc?: string;
  readonly settings?: readonly unknown[];
  readonly [key: string]: unknown;
}

type ViewPlacement = "append" | "prepend" | "before" | "after";

interface ViewLocatorRef {
  readonly id: string;
}

interface ViewPlacementRef {
  readonly id: string;
}

interface VirtualViewNode {
  readonly kind: "element" | "text";
  readonly tag?: string;
  readonly text?: string;
  readonly attributes?: Readonly<Record<string, string>>;
  readonly children?: readonly VirtualViewNode[];
  readonly onPress?: () => void;
}

interface BrowserViewMountDeclaration {
  readonly operation: "browser-view-mount";
  readonly locator: ViewLocatorRef;
  readonly placement: ViewPlacementRef;
  readonly content: VirtualViewNode;
}

interface BrowserHookTargetRef {
  readonly id: string;
}

interface BrowserHookDeclaration {
  readonly operation: "browser-hook";
  readonly mode: "before" | "after" | "around";
  readonly target: BrowserHookTargetRef;
  readonly order: number;
  readonly handle: (context: {
    readonly args: readonly unknown[];
    readonly result?: unknown;
    proceed?(args?: readonly unknown[]): unknown;
  }) => unknown;
}

interface BrowserProtocolChannelRef {
  readonly id: string;
}

interface BrowserProtocolSchemaRef<TMessage = unknown> {
  readonly id: string;
  readonly parse: (value: unknown) => TMessage | null;
}

interface BrowserProtocolDeclaration {
  readonly operation: "browser-protocol-observe";
  readonly channel: BrowserProtocolChannelRef;
  readonly schema: BrowserProtocolSchemaRef;
  readonly handle: (message: Readonly<unknown>) => unknown;
}

type BrowserTerminalDeclaration = BrowserViewMountDeclaration | BrowserHookDeclaration | BrowserProtocolDeclaration;

const runtimeViewAdapter = ADAPTERS.runtimeView as unknown as AdapterRef<BrowserViewMountDeclaration>;
const semanticViewAdapter = ADAPTERS.semanticView as unknown as AdapterRef<BrowserViewMountDeclaration>;
const runtimeHookAdapter = ADAPTERS.runtimeHook as unknown as AdapterRef<BrowserHookDeclaration>;
const protocolPipelineAdapter = ADAPTERS.protocolPipeline as unknown as AdapterRef<BrowserProtocolDeclaration>;

interface PluginActivation {
  snapshot(): RuntimeSnapshot;
  dispose(): void;
}

interface PluginDiagnosticsTransport {
  ingestSnapshot(
    snapshot: RuntimeSnapshot,
    options: { readonly plugin: Readonly<{ id: string; name: string }>; readonly disabled?: boolean; readonly reason?: string },
  ): void;
}

const locatorTokens = new WeakSet<object>();
const placementTokens = new WeakSet<object>();
const locatorSelectors = new WeakMap<object, string>();
const placementValues = new WeakMap<object, ViewPlacement>();
const virtualNodes = new WeakSet<object>();
const hookTargetTokens = new WeakSet<object>();
const hookTargetPaths = new WeakMap<object, readonly string[]>();
const protocolChannelTokens = new WeakSet<object>();
const protocolChannels = new WeakMap<object, object>();
const protocolSchemaTokens = new WeakSet<object>();

function stableId(value: unknown, label: string): string {
  const id = String(value || "").trim();
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(id)) throw new TypeError(`${label} 必须是稳定的小写标识`);
  return id;
}

function nonEmptyText(value: unknown, label: string): string {
  const text = String(value || "").trim();
  if (!text) throw new TypeError(`${label} 不能为空`);
  return text;
}

function createLocator(id: string, selector: string): ViewLocatorRef {
  const normalizedSelector = nonEmptyText(selector, "视图选择器");
  // 修改点只持有不可伪造的 Locator；真实 selector 仅保存在 Provider 私有 WeakMap 中。
  const token = Object.freeze({ id: stableId(id, "Locator ID") });
  locatorTokens.add(token);
  locatorSelectors.set(token, normalizedSelector);
  return token;
}

function createPlacement(id: string, placement: ViewPlacement): ViewPlacementRef {
  const token = Object.freeze({ id: stableId(id, "挂载槽 ID") });
  placementTokens.add(token);
  placementValues.set(token, placement);
  return token;
}

function createWindowHookTarget(id: string, path: readonly string[]): BrowserHookTargetRef {
  const normalizedPath = Object.freeze([...(path || [])].map((part) => String(part || "").trim()));
  if (
    normalizedPath.length === 0 ||
    normalizedPath.length > 8 ||
    normalizedPath.some((part) => !/^[A-Za-z_$][\w$]*$/.test(part) || ["__proto__", "prototype", "constructor"].includes(part))
  ) {
    throw new TypeError("Hook 目标路径不合法");
  }
  const token = Object.freeze({ id: stableId(id, "Hook Target ID") });
  hookTargetTokens.add(token);
  hookTargetPaths.set(token, normalizedPath);
  return token;
}

function createProtocolSchema<TMessage>(
  id: string,
  parse: (value: unknown) => TMessage | null,
): BrowserProtocolSchemaRef<TMessage> {
  if (typeof parse !== "function") throw new TypeError("协议 Schema 必须提供 parse 函数");
  const schema = Object.freeze({ id: stableId(id, "Protocol Schema ID"), parse });
  protocolSchemaTokens.add(schema);
  return schema;
}

function textNode(value: unknown): VirtualViewNode {
  const node = Object.freeze<VirtualViewNode>({ kind: "text", text: String(value ?? "") });
  virtualNodes.add(node);
  return node;
}

function elementNode(input: {
  tag?: string;
  text?: string;
  attributes?: Readonly<Record<string, string>>;
  children?: readonly VirtualViewNode[];
  onPress?: () => void;
}): VirtualViewNode {
  const tag = String(input?.tag || "span").toLowerCase();
  if (!/^[a-z][a-z0-9-]*$/.test(tag) || ["script", "style", "iframe", "object", "embed"].includes(tag)) {
    throw new TypeError(`虚拟视图标签不受支持：${tag}`);
  }
  const attributes: Record<string, string> = {};
  for (const [name, value] of Object.entries(input?.attributes || {})) {
    const normalizedName = String(name).toLowerCase();
    if (!/^(?:class|title|role|aria-[a-z0-9-]+|data-[a-z0-9-]+)$/.test(normalizedName)) {
      throw new TypeError(`虚拟视图属性不受支持：${name}`);
    }
    attributes[normalizedName] = String(value);
  }
  const children = Object.freeze([...(input?.children || [])]);
  if (children.some((child) => !virtualNodes.has(child as object))) throw new TypeError("虚拟视图只能包含 SDK 创建的子节点");
  if (input?.onPress != null && typeof input.onPress !== "function") throw new TypeError("onPress 必须是函数");
  const node = Object.freeze<VirtualViewNode>({
    kind: "element",
    tag,
    ...(input?.text == null ? {} : { text: String(input.text) }),
    ...(Object.keys(attributes).length === 0 ? {} : { attributes: Object.freeze(attributes) }),
    ...(children.length === 0 ? {} : { children }),
    ...(input?.onPress ? { onPress: input.onPress } : {}),
  });
  virtualNodes.add(node);
  return node;
}

function renderVirtualNode(node: VirtualViewNode, host: BrowserAdapterHost, disposers: (() => void)[]): Node {
  if (!virtualNodes.has(node as object)) throw new TypeError("视图内容必须由 SDK 的 ui API 创建");
  if (node.kind === "text") return document.createTextNode(node.text || "");
  const element = document.createElement(node.tag || "span");
  for (const [name, value] of Object.entries(node.attributes || {})) element.setAttribute(name, value);
  if (node.text != null) element.textContent = node.text;
  for (const child of node.children || []) element.appendChild(renderVirtualNode(child, host, disposers));
  if (node.onPress) {
    disposers.push(host.events.observe({
      key: {},
      target: element,
      type: "click",
      callback() {
        // 插件只收到语义化按压回调，真实 Event 和 DOM 节点不会越过适配器边界。
        node.onPress?.();
      },
    }));
  }
  return element;
}

function mountNode(target: Element, node: Node, placement: ViewPlacement): void {
  if (placement === "append") target.append(node);
  else if (placement === "prepend") target.prepend(node);
  else if (placement === "before") target.before(node);
  else target.after(node);
}

function installViewContribution(
  declaration: BrowserViewMountDeclaration,
  host: BrowserAdapterHost,
  onHit: () => void,
): () => void {
  if (!locatorTokens.has(declaration.locator as object)) throw new TypeError("视图声明引用了无效 Locator");
  if (!placementTokens.has(declaration.placement as object)) throw new TypeError("视图声明引用了无效挂载槽");
  if (!virtualNodes.has(declaration.content as object)) throw new TypeError("视图声明引用了无效虚拟节点");
  const selector = locatorSelectors.get(declaration.locator as object);
  const placement = placementValues.get(declaration.placement as object);
  if (!selector || !placement) throw new TypeError("视图声明无法解析");
  const mounted = new Map<Element, { node: Node; disposers: (() => void)[] }>();

  const synchronize = () => {
    const targets = new Set(Array.from(document.querySelectorAll(selector)));
    for (const [target, entry] of mounted) {
      if (targets.has(target) && entry.node.isConnected) continue;
      for (const dispose of entry.disposers.reverse()) dispose();
      entry.node.parentNode?.removeChild(entry.node);
      mounted.delete(target);
    }
    for (const target of targets) {
      if (mounted.has(target)) continue;
      const disposers: (() => void)[] = [];
      const node = renderVirtualNode(declaration.content, host, disposers);
      mountNode(target, node, placement);
      mounted.set(target, { node, disposers });
      onHit();
    }
  };

  synchronize();
  const disposeObservation = host.dom.observe({
    key: {},
    root: document.documentElement,
    options: { childList: true, subtree: true },
    callback: synchronize,
  });
  return () => {
    disposeObservation();
    for (const entry of [...mounted.values()].reverse()) {
      for (const dispose of entry.disposers.reverse()) dispose();
      entry.node.parentNode?.removeChild(entry.node);
    }
    mounted.clear();
  };
}

function installHookContribution(
  declaration: BrowserHookDeclaration,
  host: BrowserAdapterHost,
  onHit: () => void,
): () => void {
  if (!hookTargetTokens.has(declaration.target as object)) throw new TypeError("Hook 声明引用了无效目标");
  const path = hookTargetPaths.get(declaration.target as object);
  if (!path) throw new TypeError("Hook 目标无法解析");
  let target: unknown = window;
  for (const part of path.slice(0, -1)) {
    if (!target || (typeof target !== "object" && typeof target !== "function")) {
      throw new TypeError(`Hook 目标不存在：${declaration.target.id}`);
    }
    target = (target as Record<string, unknown>)[part];
  }
  const property = path[path.length - 1];
  if (!property || !target || (typeof target !== "object" && typeof target !== "function")) {
    throw new TypeError(`Hook 目标不存在：${declaration.target.id}`);
  }
  return host.hooks.around({
    key: {},
    target: target as Record<PropertyKey, unknown>,
    property,
    order: declaration.order,
    handle(_thisValue, args, proceed) {
      let result: unknown;
      if (declaration.mode === "before") {
        const nextArgs = declaration.handle({ args });
        result = proceed(Array.isArray(nextArgs) ? nextArgs : args);
      } else if (declaration.mode === "after") {
        result = declaration.handle({ args, result: proceed(args) });
      } else {
        result = declaration.handle({ args, proceed });
      }
      onHit();
      return result;
    },
  });
}

function installProtocolContribution(
  declaration: BrowserProtocolDeclaration,
  host: BrowserAdapterHost,
  onHit: () => void,
): () => void {
  if (!protocolChannelTokens.has(declaration.channel as object)) throw new TypeError("协议声明引用了无效 Channel");
  if (!protocolSchemaTokens.has(declaration.schema as object)) throw new TypeError("协议声明引用了无效 Schema");
  const channel = protocolChannels.get(declaration.channel as object);
  if (!channel) throw new TypeError("协议 Channel 无法解析");
  return host.protocol.observe({
    key: {},
    channel,
    callback(frame) {
      const message = declaration.schema.parse(frame.value);
      if (message == null) return;
      const result = declaration.handle(message);
      onHit();
      return result;
    },
  });
}

function expandAdapterUse(
  use: AdapterUse<unknown>,
  expanders: ReadonlyMap<AdapterRef<unknown>, (declaration: Readonly<unknown>) => readonly AdapterUse<unknown>[]>,
  visiting = new Set<AdapterRef<unknown>>(),
): AdapterUse<unknown>[] {
  if (visiting.has(use.adapter)) throw new Error(`插件适配器依赖形成环：${use.adapter.id}`);
  if (use.adapter.kind === "terminal") return [use];
  const expand = expanders.get(use.adapter);
  if (!expand) throw new Error(`插件高级适配器缺少展开器：${use.adapter.id}`);
  const next = new Set(visiting);
  next.add(use.adapter);
  const children = expand(use.declaration);
  if (!Array.isArray(children) || children.length === 0) {
    throw new Error(`插件高级适配器没有产生底层声明：${use.adapter.id}`);
  }
  for (const child of children) {
    if (!isAdapterUse(child)) throw new TypeError(`插件高级适配器 ${use.adapter.id} 产生了无效 Contribution`);
    if (!use.adapter.dependencies.includes(child.adapter)) {
      throw new Error(`插件高级适配器 ${use.adapter.id} 使用了未声明依赖：${child.adapter.id}`);
    }
  }
  return children.flatMap((child) => expandAdapterUse(child, expanders, next));
}

function adapterDependencyChain(
  adapter: AdapterRef<unknown>,
  visiting = new Set<AdapterRef<unknown>>(),
): readonly AdapterRef<unknown>[] {
  if (visiting.has(adapter)) throw new Error(`插件适配器依赖形成环：${adapter.id}`);
  const next = new Set(visiting);
  next.add(adapter);
  return [adapter, ...adapter.dependencies.flatMap((dependency) => adapterDependencyChain(dependency, next))];
}

function pluginDiagnosticsTransport(): PluginDiagnosticsTransport | null {
  const value = (window as unknown as { OpenCodexRuntimeCompatibility?: PluginDiagnosticsTransport })
    .OpenCodexRuntimeCompatibility;
  return value && typeof value.ingestSnapshot === "function" ? value : null;
}

function pluginMetadata(plugin: PluginRef): Readonly<{ id: string; name: string }> {
  return Object.freeze({ id: plugin.id, name: plugin.name });
}

function publishPluginDiagnostics(
  snapshot: RuntimeSnapshot,
  plugin: PluginRef,
  options: { readonly disabled?: boolean; readonly reason?: string } = {},
): void {
  try {
    pluginDiagnosticsTransport()?.ingestSnapshot(snapshot, { plugin: pluginMetadata(plugin), ...options });
  } catch {
    // 调试上报是旁路能力，任何上报器异常都不能影响插件注册、启用或资源清理。
  }
}

function createPluginDiagnosticSnapshot(
  plugin: PluginRef,
  points: readonly ModificationPointDefinition[],
  expanders: ReadonlyMap<AdapterRef<unknown>, (declaration: Readonly<unknown>) => readonly AdapterUse<unknown>[]>,
): RuntimeSnapshot {
  const chainAdapters = [...new Map(
    points
      .flatMap((point) => point.contributions.flatMap((use) => adapterDependencyChain(use.adapter)))
      .map((adapter) => [adapter.id, adapter]),
  ).values()];
  const pointItems = points.map((point) => {
    const directAdapters = [...new Map(point.contributions.map((use) => [use.adapter.id, use.adapter])).values()];
    const fullChain = [...new Map(
      directAdapters.flatMap((adapter) => adapterDependencyChain(adapter)).map((adapter) => [adapter.id, adapter]),
    ).values()];
    const contributions = point.contributions.flatMap((use, directIndex) => {
      const terminalUses = expandAdapterUse(use, expanders);
      return terminalUses.map((terminalUse, leafIndex) => Object.freeze({
        id: `${point.id}::${directIndex}.${leafIndex}`,
        directAdapterId: use.adapter.id,
        adapterId: terminalUse.adapter.id,
        adapterChainIds: Object.freeze(fullChain.map((adapter) => adapter.id)),
        location: "unresolved" as const,
        application: "pending" as const,
        verification: "pending" as const,
        activation: "inactive" as const,
        exercise: "not-exercised" as const,
        hitCount: 0,
        fallbackActive: false,
        fallbackReason: "",
        reason: "",
      }));
    });
    return Object.freeze({
      id: point.id,
      description: point.description,
      owner: point.owner,
      plugin: Object.freeze({ id: plugin.id, name: plugin.name }),
      groupId: point.group.id,
      status: "disabled" as const,
      directAdapterIds: Object.freeze(directAdapters.map((adapter) => adapter.id)),
      adapterChainIds: Object.freeze(fullChain.map((adapter) => adapter.id)),
      contributions: Object.freeze(contributions),
    });
  });
  const pointGroups = [...new Map(points.map((point) => [point.group.id, point.group])).values()];
  return Object.freeze({
    revision: 0,
    providerDiagnostics: Object.freeze([]),
    groups: Object.freeze(pointGroups.map((group) => Object.freeze({
      id: group.id,
      name: group.name,
      description: group.description,
      order: group.order,
      pointIds: Object.freeze(pointItems.filter((point) => point.groupId === group.id).map((point) => point.id)),
    }))),
    adapterTypes: Object.freeze(chainAdapters.map((adapter) => Object.freeze({
      id: adapter.id,
      name: adapter.name,
      description: adapter.description,
      kind: adapter.kind,
      dependencies: Object.freeze(adapter.dependencies.map((dependency) => dependency.id)),
    }))),
    points: Object.freeze(pointItems),
  });
}

function validateBrowserTerminalUse(use: AdapterUse<unknown>): BrowserTerminalDeclaration {
  if (use.adapter === runtimeViewAdapter) {
    const declaration = use.declaration as Partial<BrowserViewMountDeclaration>;
    if (declaration.operation !== "browser-view-mount") throw new TypeError("RuntimeView 声明不受支持");
    if (!locatorTokens.has(declaration.locator as object)) throw new TypeError("视图声明引用了无效 Locator");
    if (!placementTokens.has(declaration.placement as object)) throw new TypeError("视图声明引用了无效挂载槽");
    if (!virtualNodes.has(declaration.content as object)) throw new TypeError("视图声明引用了无效虚拟节点");
    return declaration as BrowserViewMountDeclaration;
  }
  if (use.adapter === runtimeHookAdapter) {
    const declaration = use.declaration as Partial<BrowserHookDeclaration>;
    if (declaration.operation !== "browser-hook" || !hookTargetTokens.has(declaration.target as object)) {
      throw new TypeError("RuntimeHook 声明不受支持");
    }
    return declaration as BrowserHookDeclaration;
  }
  if (use.adapter === protocolPipelineAdapter) {
    const declaration = use.declaration as Partial<BrowserProtocolDeclaration>;
    if (
      declaration.operation !== "browser-protocol-observe" ||
      !protocolChannelTokens.has(declaration.channel as object) ||
      !protocolSchemaTokens.has(declaration.schema as object)
    ) {
      throw new TypeError("ProtocolPipeline 声明不受支持");
    }
    return declaration as BrowserProtocolDeclaration;
  }
  throw new Error(`浏览器插件宿主不提供终端适配器：${use.adapter.id}`);
}

function validateBrowserTerminalContribution(contribution: BoundContribution): BrowserTerminalDeclaration {
  return validateBrowserTerminalUse({
    adapter: contribution.adapter,
    declaration: contribution.declaration,
  } as AdapterUse<unknown>);
}

function createPluginTerminalProvider(
  adapter: AdapterRef<unknown>,
  host: BrowserAdapterHost,
  publishSnapshot: () => void,
): TerminalAdapterProvider<unknown> {
  return Object.freeze({
    adapter,
    compile(contributions: readonly BoundContribution[]) {
      const disposers = new Map<symbol, () => void>();
      const resources = host.lifecycle.createScope();
      return {
        locate(reporter: AdapterExecutionReporter) {
          for (const contribution of contributions) {
            try {
              validateBrowserTerminalContribution(contribution);
              reporter.resolved(contribution, { candidateCount: 1, fingerprint: contribution.adapter.id });
            } catch (error) {
              reporter.unsupported(
                contribution,
                error instanceof Error ? error.message : String(error),
              );
            }
          }
        },
        apply(contribution: BoundContribution, reporter: AdapterExecutionReporter) {
          const declaration = validateBrowserTerminalContribution(contribution);
          const onHit = () => {
            reporter.hit(contribution);
            publishSnapshot();
          };
          let dispose: () => void;
          dispose = resources.run(() => {
            if (declaration.operation === "browser-view-mount") {
              return installViewContribution(declaration, host, onHit);
            }
            if (declaration.operation === "browser-hook") {
              return installHookContribution(declaration, host, onHit);
            }
            return installProtocolContribution(declaration, host, onHit);
          });
          disposers.set(contribution.key, dispose);
          reporter.applied(contribution);
        },
        verify(contribution: BoundContribution, reporter: AdapterExecutionReporter) {
          if (!disposers.has(contribution.key)) throw new Error("插件 Contribution 未完成真实安装");
          reporter.verified(contribution);
        },
        rollback(contribution: BoundContribution) {
          disposers.get(contribution.key)?.();
          disposers.delete(contribution.key);
        },
        dispose() {
          for (const dispose of [...disposers.values()].reverse()) dispose();
          disposers.clear();
          resources.dispose();
        },
        diagnostics() {
          return Object.freeze({ installedContributionCount: disposers.size });
        },
      };
    },
  });
}

function createPluginActivation(
  plugin: PluginRef,
  points: readonly ModificationPointDefinition[],
  groups: readonly PointGroupRef[],
  adapters: readonly AdapterRef<unknown>[],
  expanders: ReadonlyMap<AdapterRef<unknown>, (declaration: Readonly<unknown>) => readonly AdapterUse<unknown>[]>,
  host: BrowserAdapterHost,
): PluginActivation {
  const runtime = createModificationRuntime();
  let snapshotScheduled = false;
  let disposed = false;
  const publishSnapshot = () => {
    if (disposed || snapshotScheduled) return;
    snapshotScheduled = true;
    queueMicrotask(() => {
      snapshotScheduled = false;
      if (disposed) return;
      publishPluginDiagnostics(runtime.snapshot(), plugin);
    });
  };
  for (const group of [...Object.values(POINT_GROUPS), ...groups]) runtime.registerGroup(group);
  for (const adapter of [...Object.values(ADAPTERS), ...adapters]) runtime.registerAdapter(adapter);
  for (const [adapter, expand] of expanders) runtime.expand({ adapter, expand });
  for (const point of points) runtime.registerPoint(point);
  runtime.provide(createPluginTerminalProvider(runtimeViewAdapter, host, publishSnapshot));
  runtime.provide(createPluginTerminalProvider(runtimeHookAdapter, host, publishSnapshot));
  runtime.provide(createPluginTerminalProvider(protocolPipelineAdapter, host, publishSnapshot));
  const activeRuntime = runtime.activateSync(runtime.compile());
  for (const failure of activeRuntime.failures) {
    console.warn("[opencodex-plugin] modification point activation failed", failure.pointId, failure.reason);
  }
  publishSnapshot();

  return Object.freeze({
    snapshot() {
      return runtime.snapshot();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      // 禁用回执先基于仍完整的 Contribution 快照生成，避免清理后丢失插件目录或适配器链。
      publishPluginDiagnostics(runtime.snapshot(), plugin, {
        disabled: true,
        reason: "Plugin disabled",
      });
      // 同步 Kernel 会先同步释放所有真实资源，再返回已经完成的 Promise。
      void activeRuntime.dispose().catch((error) => {
        console.warn("[opencodex-plugin] Kernel cleanup failed", error);
      });
    },
  });
}

export function installPluginSdk(host: BrowserAdapterHost): void {
  if (window.OpenCodexPluginSdk) {
    window.OpenCodexPluginSdk.__beginPage(document.documentElement);
    return;
  }
  const committedGroupIds = new Set(Object.values(POINT_GROUPS).map((group) => group.id));
  const committedAdapterIds = new Set(Object.values(ADAPTERS).map((adapter) => adapter.id));
  const committedPointIds = new Set(POINT_DEFINITIONS.map((point) => point.id));
  const activations = new Map<string, PluginActivation>();
  let pageRoot: Element | null = document.documentElement;
  let sdkGeneration = 1;
  const publicProtocolChannels = Object.freeze(Object.fromEntries(
    Object.entries(host.protocol.channels).map(([name, channel]) => {
      const id = `channel.${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
      const token = Object.freeze({ id });
      protocolChannelTokens.add(token);
      protocolChannels.set(token, channel);
      return [name, token];
    }),
  ));

  const builtinExpanders = new Map<AdapterRef<unknown>, (declaration: Readonly<unknown>) => readonly AdapterUse<unknown>[]>();
  for (const adapter of Object.values(ADAPTERS)) {
    if (adapter.kind !== "composite") continue;
    builtinExpanders.set(adapter, (declaration) => adapter.dependencies.map((dependency) => dependency.use(declaration)));
  }

  function createPluginScope(manifestInput: PluginManifestV2) {
    if (!manifestInput || manifestInput.apiVersion !== 2) throw new TypeError("插件 manifest 必须使用 apiVersion 2");
    const manifest = Object.freeze({ ...manifestInput, id: stableId(manifestInput.id, "插件 ID") });
    const plugin = definePlugin({
      id: manifest.id,
      name: String(manifest.label || manifest.name || manifest.id),
    });
    const groups: PointGroupRef[] = [];
    const adapters: AdapterRef<unknown>[] = [];
    const points: ModificationPointDefinition[] = [];
    const expanders = new Map(builtinExpanders);
    const scopeGeneration = sdkGeneration;
    let committed = false;

    function assertCurrentGeneration(): void {
      if (scopeGeneration !== sdkGeneration) throw new Error("插件注册批次所属页面已经失效");
    }

    const hookUse = (
      mode: BrowserHookDeclaration["mode"],
      declaration: {
        target: BrowserHookTargetRef;
        order?: number;
        handle: BrowserHookDeclaration["handle"];
      },
    ) => {
      const order = Number(declaration.order || 0);
      if (!Number.isFinite(order)) throw new TypeError("Hook 顺序必须是有限数字");
      if (!hookTargetTokens.has(declaration.target as object)) throw new TypeError("Hook 必须引用 SDK Target 对象");
      if (typeof declaration.handle !== "function") throw new TypeError("Hook 必须提供 handle 函数");
      return runtimeHookAdapter.use({
        operation: "browser-hook",
        mode,
        target: declaration.target,
        order,
        handle: declaration.handle,
      });
    };

    const groupApi = Object.freeze({
      ...POINT_GROUPS,
      // 旧名称只作为 SDK 源码兼容别名，不参与当前分类组目录和调试页展示。
      notificationPower: POINT_GROUPS.backgroundEfficiency,
      projectNavigation: POINT_GROUPS.startupHistory,
      register(definition: { id: string; name: string; description: string; order: number }): PointGroupRef {
        assertCurrentGeneration();
        if (committed) throw new Error("插件注册批次已经提交");
        const group = definePointGroup(definition);
        if (committedGroupIds.has(group.id) || groups.some((item) => item.id === group.id)) {
          throw new Error(`分类组 ID 重复：${group.id}`);
        }
        groups.push(group);
        return group;
      },
    });

    const adapterApi = Object.freeze({
      ...ADAPTERS,
      compose<TDeclaration>(definition: {
        id: string;
        name: string;
        description: string;
        dependencies: readonly AdapterRef<unknown>[];
        expand(declaration: Readonly<TDeclaration>): readonly AdapterUse<unknown>[];
      }): AdapterRef<TDeclaration> {
        assertCurrentGeneration();
        if (committed) throw new Error("插件注册批次已经提交");
        if (!Array.isArray(definition.dependencies) || definition.dependencies.some((item) => !isAdapterRef(item))) {
          throw new TypeError("高级适配器必须通过强类型对象引用声明依赖");
        }
        const adapter = defineAdapter<TDeclaration>({ ...definition, kind: "composite" });
        if (committedAdapterIds.has(adapter.id) || adapters.some((item) => item.id === adapter.id)) {
          throw new Error(`适配器 ID 重复：${adapter.id}`);
        }
        adapters.push(adapter as AdapterRef<unknown>);
        expanders.set(adapter as AdapterRef<unknown>, definition.expand as (value: Readonly<unknown>) => readonly AdapterUse<unknown>[]);
        return adapter;
      },
      runtimeView: Object.freeze({
        ref: runtimeViewAdapter,
        mount(declaration: { locator: ViewLocatorRef; placement: ViewPlacementRef; content: VirtualViewNode }) {
          return runtimeViewAdapter.use({ operation: "browser-view-mount", ...declaration });
        },
      }),
      runtimeHook: Object.freeze({
        ref: runtimeHookAdapter,
        before(declaration: { target: BrowserHookTargetRef; order?: number; handle: BrowserHookDeclaration["handle"] }) {
          return hookUse("before", declaration);
        },
        after(declaration: { target: BrowserHookTargetRef; order?: number; handle: BrowserHookDeclaration["handle"] }) {
          return hookUse("after", declaration);
        },
        around(declaration: { target: BrowserHookTargetRef; order?: number; handle: BrowserHookDeclaration["handle"] }) {
          return hookUse("around", declaration);
        },
      }),
      protocolPipeline: Object.freeze({
        ref: protocolPipelineAdapter,
        observe<TMessage>(declaration: {
          channel: BrowserProtocolChannelRef;
          schema: BrowserProtocolSchemaRef<TMessage>;
          handle(message: Readonly<TMessage>): unknown;
        }) {
          if (!protocolChannelTokens.has(declaration.channel as object)) throw new TypeError("协议必须引用 SDK Channel 对象");
          if (!protocolSchemaTokens.has(declaration.schema as object)) throw new TypeError("协议必须引用 SDK Schema 对象");
          return protocolPipelineAdapter.use({
            operation: "browser-protocol-observe",
            channel: declaration.channel,
            schema: declaration.schema,
            handle: declaration.handle as (message: Readonly<unknown>) => unknown,
          });
        },
      }),
      semanticView: Object.freeze({
        ref: semanticViewAdapter,
        mount(declaration: { locator: ViewLocatorRef; placement: ViewPlacementRef; content: VirtualViewNode }) {
          return semanticViewAdapter.use({ operation: "browser-view-mount", ...declaration });
        },
      }),
    });

    const pointApi = Object.freeze({
      register(definition: {
        id: string;
        description: string;
        group: PointGroupRef;
        contributions: readonly AdapterUse<unknown>[];
      }): ModificationPointDefinition {
        assertCurrentGeneration();
        if (committed) throw new Error("插件注册批次已经提交");
        if (!isPointGroupRef(definition.group)) throw new TypeError("修改点必须引用 SDK 返回的分类组对象");
        if (!groups.includes(definition.group) && !Object.values(POINT_GROUPS).includes(definition.group as never)) {
          throw new TypeError("修改点引用了当前插件不可见的分类组");
        }
        if (definition.contributions.some((item) => !isAdapterUse(item))) {
          throw new TypeError("修改点 Contribution 必须由适配器 API 创建");
        }
        // PluginRef 由宿主根据当前 manifest 注入，插件代码既不能遗漏，也不能伪造归属。
        const point = defineModificationPoint({ ...definition, owner: manifest.id, plugin });
        if (committedPointIds.has(point.id) || points.some((item) => item.id === point.id)) {
          throw new Error(`修改点 ID 重复：${point.id}`);
        }
        points.push(point);
        return point;
      },
    });

    const scope = Object.freeze({
      apiVersion: 2 as const,
      sdkVersion: "2.0.0",
      plugin: Object.freeze({ id: manifest.id }),
      groups: groupApi,
      adapters: adapterApi,
      points: pointApi,
      view: Object.freeze({
        locators: Object.freeze({ css: createLocator }),
        placements: Object.freeze({
          append: createPlacement("slot.append", "append"),
          prepend: createPlacement("slot.prepend", "prepend"),
          before: createPlacement("slot.before", "before"),
          after: createPlacement("slot.after", "after"),
        }),
        ui: Object.freeze({ element: elementNode, text: textNode }),
      }),
      hooks: Object.freeze({
        targets: Object.freeze({ windowMethod: createWindowHookTarget }),
      }),
      protocol: Object.freeze({
        channels: publicProtocolChannels,
        schemas: Object.freeze({ define: createProtocolSchema }),
      }),
      commit() {
        assertCurrentGeneration();
        if (committed) throw new Error("插件注册批次已经提交");
        // 先完整展开并校验，再修改全局注册表，保证插件注册失败时没有半批次残留。
        for (const point of points) {
          for (const use of point.contributions.flatMap((item) => expandAdapterUse(item, expanders))) {
            validateBrowserTerminalUse(use);
          }
        }
        const pluginSystem = window.OpenCodexPluginSystem || window.__OpenCodexPluginSystem;
        if (!pluginSystem?.registerPlugin) throw new Error("插件设置宿主尚未就绪");
        const pluginRegistration = {
          ...manifest,
          activate(context: { scope?: string }) {
            if (context?.scope !== "renderer") return null;
            const previous = activations.get(manifest.id);
            previous?.dispose();
            const activation = createPluginActivation(plugin, points, groups, adapters, expanders, host);
            activations.set(manifest.id, activation);
            return () => {
              activation.dispose();
              if (activations.get(manifest.id) === activation) activations.delete(manifest.id);
            };
          },
        };
        const disabledSnapshot = createPluginDiagnosticSnapshot(plugin, points, expanders);
        // 设置宿主可能在注册时同步激活；只有它成功接纳完整批次后才占用全局 ID。
        pluginSystem.registerPlugin(pluginRegistration);
        publishPluginDiagnostics(disabledSnapshot, plugin, {
          disabled: true,
          reason: "Plugin disabled",
        });
        for (const group of groups) committedGroupIds.add(group.id);
        for (const adapter of adapters) committedAdapterIds.add(adapter.id);
        for (const point of points) committedPointIds.add(point.id);
        committed = true;
      },
    });
    return scope;
  }

  const root = Object.freeze({
    apiVersion: 2 as const,
    sdkVersion: "2.0.0",
    createPluginScope,
    snapshot() {
      return Object.freeze([...activations.entries()].map(([pluginId, activation]) => Object.freeze({
        pluginId,
        points: Object.freeze(activation.snapshot().points),
      })));
    },
    __beginPage(root: Element | null) {
      if (pageRoot === root) return;
      pageRoot = root;
      sdkGeneration += 1;
      for (const activation of activations.values()) activation.dispose();
      activations.clear();
      committedGroupIds.clear();
      committedAdapterIds.clear();
      committedPointIds.clear();
      for (const group of Object.values(POINT_GROUPS)) committedGroupIds.add(group.id);
      for (const adapter of Object.values(ADAPTERS)) committedAdapterIds.add(adapter.id);
      for (const point of POINT_DEFINITIONS) committedPointIds.add(point.id);
    },
  });
  Object.defineProperty(window, "OpenCodexPluginSdk", {
    configurable: false,
    enumerable: false,
    writable: false,
    value: root,
  });
}

declare global {
  interface Window {
    readonly OpenCodexPluginSdk?: {
      readonly apiVersion: 2;
      readonly sdkVersion: string;
      createPluginScope(manifest: PluginManifestV2): ReturnType<typeof createScopeShape>;
      snapshot(): readonly unknown[];
      __beginPage(root: Element | null): void;
    };
    readonly OpenCodexPluginSystem?: {
      beginPage?(root: Element | null): void;
      registerPlugin(plugin: Readonly<Record<string, unknown>>): unknown;
    };
    readonly __OpenCodexPluginSystem?: {
      registerPlugin(plugin: Readonly<Record<string, unknown>>): unknown;
    };
  }
}

// 仅用于让全局声明保留 createPluginScope 的结构类型，不会生成运行时代码。
declare function createScopeShape(manifest: PluginManifestV2): unknown;
