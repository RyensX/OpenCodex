import { AdapterRef, AdapterUse, CapabilityRef, SignalRef } from "./sdk";

const VIEW_LOCATOR_BRAND: unique symbol = Symbol("opencodex.view-locator");
const VIEW_TARGET_BRAND: unique symbol = Symbol("opencodex.view-target");
const VIEW_SLOT_BRAND: unique symbol = Symbol("opencodex.view-slot");
const PROTOCOL_CHANNEL_BRAND: unique symbol = Symbol("opencodex.protocol-channel");
const PROTOCOL_SCHEMA_BRAND: unique symbol = Symbol("opencodex.protocol-schema");
const HOOK_TARGET_BRAND: unique symbol = Symbol("opencodex.hook-target");
const RESOURCE_TARGET_BRAND: unique symbol = Symbol("opencodex.resource-target");
const RESOURCE_LOCATOR_BRAND: unique symbol = Symbol("opencodex.resource-locator");
const ENVIRONMENT_KEY_BRAND: unique symbol = Symbol("opencodex.environment-key");
const PROCESS_TARGET_BRAND: unique symbol = Symbol("opencodex.process-target");
const ARTIFACT_TARGET_BRAND: unique symbol = Symbol("opencodex.artifact-target");

export interface VirtualView {
  readonly kind: "text" | "icon" | "inline" | "badge" | "container";
  readonly properties: Readonly<Record<string, unknown>>;
  readonly children: readonly VirtualView[];
}

export interface VirtualUi {
  text(value: string): VirtualView;
  icon(icon: string): VirtualView;
  inline(children: readonly VirtualView[]): VirtualView;
  badge(properties: Readonly<Record<string, unknown>>, children: readonly VirtualView[]): VirtualView;
  container(properties: Readonly<Record<string, unknown>>, children: readonly VirtualView[]): VirtualView;
}

export interface ViewLocatorRef<TModel> {
  readonly [VIEW_LOCATOR_BRAND]: true;
  readonly id: string;
  readonly __model?: TModel;
}

export interface ViewTargetRef<TId extends string, TModel> {
  readonly [VIEW_TARGET_BRAND]: true;
  readonly id: TId;
  readonly locator: ViewLocatorRef<TModel>;
}

export interface ViewSlotRef<TTarget extends ViewTargetRef<string, unknown>> {
  readonly [VIEW_SLOT_BRAND]: true;
  readonly id: string;
  readonly target: TTarget;
}

export interface ViewPlacementRef {
  readonly id: string;
}

export interface ViewRenderContext<TData, TModel> {
  readonly data: Readonly<TData>;
  readonly model: Readonly<TModel>;
  readonly ui: VirtualUi;
}

type ViewTargetModel<TTarget> = TTarget extends ViewTargetRef<string, infer TModel> ? TModel : never;

export type RuntimeViewDeclaration =
  | {
      readonly operation: "mount";
      readonly locator: ViewLocatorRef<unknown>;
      readonly slot: ViewSlotRef<ViewTargetRef<string, unknown>> | ViewPlacementRef;
      readonly source: SignalRef<unknown>;
      readonly render: (context: ViewRenderContext<unknown, unknown>) => VirtualView;
    }
  | {
      readonly operation: "observe";
      readonly locator: ViewLocatorRef<unknown>;
      readonly handle: (model: Readonly<unknown>) => void;
    };

export interface RuntimeViewApi {
  mount<TTarget extends ViewTargetRef<string, unknown>, TData>(declaration: {
    target: TTarget;
    slot: ViewSlotRef<NoInfer<TTarget>>;
    source: SignalRef<TData>;
    render(context: ViewRenderContext<TData, ViewTargetModel<TTarget>>): VirtualView;
  }): AdapterUse<RuntimeViewDeclaration>;
  mountLowLevel<TModel, TData>(declaration: {
    locator: ViewLocatorRef<TModel>;
    placement: ViewPlacementRef;
    source: SignalRef<TData>;
    render(context: ViewRenderContext<TData, TModel>): VirtualView;
  }): AdapterUse<RuntimeViewDeclaration>;
  observe<TModel>(declaration: {
    locator: ViewLocatorRef<TModel>;
    handle(model: Readonly<TModel>): void;
  }): AdapterUse<RuntimeViewDeclaration>;
}

export interface ProtocolChannelRef<TWire> {
  readonly [PROTOCOL_CHANNEL_BRAND]: true;
  readonly id: string;
  readonly __wire?: TWire;
}

export interface ProtocolSchemaRef<TWire, TMessage> {
  readonly [PROTOCOL_SCHEMA_BRAND]: true;
  readonly id: string;
  readonly parse: (wire: Readonly<TWire>) => TMessage | null;
}

export type ProtocolDeclaration = {
  readonly operation: "observe";
  readonly channel: ProtocolChannelRef<unknown>;
  readonly schema: ProtocolSchemaRef<unknown, unknown>;
  readonly publishTo: SignalRef<unknown>;
  readonly map: (message: Readonly<unknown>) => unknown;
} | {
  readonly operation: "transform";
  readonly channel: ProtocolChannelRef<unknown>;
  readonly schema: ProtocolSchemaRef<unknown, unknown>;
  readonly transform: (message: Readonly<unknown>) => unknown;
};

export interface ProtocolPipelineApi {
  observe<TWire, TMessage, TOutput>(declaration: {
    channel: ProtocolChannelRef<TWire>;
    schema: ProtocolSchemaRef<NoInfer<TWire>, TMessage>;
    publishTo: SignalRef<TOutput>;
    map(message: Readonly<TMessage>): TOutput;
  }): AdapterUse<ProtocolDeclaration>;
  transform<TWire, TMessage>(declaration: {
    channel: ProtocolChannelRef<TWire>;
    schema: ProtocolSchemaRef<NoInfer<TWire>, TMessage>;
    transform(message: Readonly<TMessage>): TMessage;
  }): AdapterUse<ProtocolDeclaration>;
}

export interface HookTargetRef<TArgs extends readonly unknown[], TResult> {
  readonly [HOOK_TARGET_BRAND]: true;
  readonly id: string;
  readonly kind: "function" | "constructor";
  readonly __args?: TArgs;
  readonly __result?: TResult;
}

interface RuntimeHookContext {
  readonly thisValue: unknown;
  readonly args: readonly unknown[];
}

export type RuntimeHookDeclaration =
  | {
      readonly operation: "before";
      readonly target: HookTargetRef<readonly unknown[], unknown>;
      readonly order: number;
      readonly handle: (context: RuntimeHookContext) => readonly unknown[] | void;
    }
  | {
      readonly operation: "after";
      readonly target: HookTargetRef<readonly unknown[], unknown>;
      readonly order: number;
      readonly handle: (context: RuntimeHookContext & { readonly result: unknown }) => unknown;
    }
  | {
      readonly operation: "around";
      readonly target: HookTargetRef<readonly unknown[], unknown>;
      readonly order: number;
      readonly handle: (context: RuntimeHookContext & {
        proceed(args?: readonly unknown[]): unknown;
      }) => unknown;
    };

export interface RuntimeHookApi {
  before<TArgs extends readonly unknown[], TResult>(declaration: {
    target: HookTargetRef<TArgs, TResult>;
    order?: number;
    handle(context: { readonly thisValue: unknown; readonly args: TArgs }): TArgs | void;
  }): AdapterUse<RuntimeHookDeclaration>;
  after<TArgs extends readonly unknown[], TResult>(declaration: {
    target: HookTargetRef<TArgs, TResult>;
    order?: number;
    handle(context: { readonly thisValue: unknown; readonly args: TArgs; readonly result: TResult }): TResult;
  }): AdapterUse<RuntimeHookDeclaration>;
  around<TArgs extends readonly unknown[], TResult>(declaration: {
    target: HookTargetRef<TArgs, TResult>;
    order?: number;
    handle(context: { readonly thisValue: unknown; readonly args: TArgs; proceed(args?: TArgs): TResult }): TResult;
  }): AdapterUse<RuntimeHookDeclaration>;
}

export interface ResourceTargetRef<TDocument> {
  readonly [RESOURCE_TARGET_BRAND]: true;
  readonly id: string;
  readonly __document?: TDocument;
}

export interface ResourceLocatorRef<TDocument, TMatch> {
  readonly [RESOURCE_LOCATOR_BRAND]: true;
  readonly id: string;
  readonly __document?: TDocument;
  readonly __match?: TMatch;
}

export type StaticResourceDeclaration = {
  readonly operation: "transform";
  readonly resource: ResourceTargetRef<unknown>;
  readonly locator: ResourceLocatorRef<unknown, unknown>;
  readonly expectedCandidates: number;
  readonly transform: (document: Readonly<unknown>, match: Readonly<unknown>) => unknown;
  readonly verify: (document: Readonly<unknown>) => boolean;
};

export interface StaticResourceApi {
  transform<TDocument, TMatch>(declaration: {
    resource: ResourceTargetRef<TDocument>;
    locator: ResourceLocatorRef<NoInfer<TDocument>, TMatch>;
    expectedCandidates: number;
    transform(document: Readonly<TDocument>, match: Readonly<TMatch>): TDocument;
    verify(document: Readonly<TDocument>): boolean;
  }): AdapterUse<StaticResourceDeclaration>;
}

export interface EnvironmentKeyRef<TValue> {
  readonly [ENVIRONMENT_KEY_BRAND]: true;
  readonly id: string;
  readonly commitBoundary: "pre-bootstrap" | "pre-ready" | "runtime";
  readonly __value?: TValue;
}

export type RuntimeEnvironmentDeclaration = {
  readonly operation: "provide";
  readonly key: EnvironmentKeyRef<unknown>;
  readonly value: unknown;
};

export interface RuntimeEnvironmentApi {
  provide<TValue>(declaration: {
    key: EnvironmentKeyRef<TValue>;
    value: NoInfer<TValue>;
  }): AdapterUse<RuntimeEnvironmentDeclaration>;
}

export interface ProcessTargetRef<TRequest, TResult> {
  readonly [PROCESS_TARGET_BRAND]: true;
  readonly id: string;
  readonly __request?: TRequest;
  readonly __result?: TResult;
}

export type ProcessInterceptionDeclaration = {
  readonly operation: "intercept";
  readonly target: ProcessTargetRef<unknown, unknown>;
  readonly order: number;
  readonly handle: (context: {
    readonly request: Readonly<unknown>;
    proceed(request?: Readonly<unknown>): unknown;
  }) => unknown;
};

export interface ProcessInterceptionApi {
  intercept<TRequest, TResult>(declaration: {
    target: ProcessTargetRef<TRequest, TResult>;
    order?: number;
    handle(context: {
      readonly request: Readonly<TRequest>;
      proceed(request?: Readonly<TRequest>): TResult;
    }): TResult;
  }): AdapterUse<ProcessInterceptionDeclaration>;
}

export interface ArtifactTargetRef<TSpec, TResult> {
  readonly [ARTIFACT_TARGET_BRAND]: true;
  readonly id: string;
  readonly __spec?: TSpec;
  readonly __result?: TResult;
}

export type ArtifactBuildDeclaration = {
  readonly operation: "build";
  readonly target: ArtifactTargetRef<unknown, unknown>;
  readonly spec: unknown;
  readonly publishTo: CapabilityRef<unknown>;
};

export interface ArtifactBuildApi {
  build<TSpec, TResult>(declaration: {
    target: ArtifactTargetRef<TSpec, TResult>;
    spec: NoInfer<TSpec>;
    publishTo: CapabilityRef<NoInfer<TResult>>;
  }): AdapterUse<ArtifactBuildDeclaration>;
}

function stableRefId(id: string): string {
  const value = String(id || "").trim();
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(value)) throw new TypeError(`无效的强类型引用 ID：${value || "<empty>"}`);
  return value;
}

export function defineViewLocator<TModel>(id: string): ViewLocatorRef<TModel> {
  return Object.freeze({ [VIEW_LOCATOR_BRAND]: true as const, id: stableRefId(id) });
}

export function defineViewTarget<const TId extends string, TModel>(id: TId, locator: ViewLocatorRef<TModel>): ViewTargetRef<TId, TModel> {
  return Object.freeze({ [VIEW_TARGET_BRAND]: true as const, id: stableRefId(id) as TId, locator });
}

export function defineViewSlot<TTarget extends ViewTargetRef<string, unknown>>(id: string, target: TTarget): ViewSlotRef<TTarget> {
  return Object.freeze({ [VIEW_SLOT_BRAND]: true as const, id: stableRefId(id), target });
}

export function defineViewPlacement(id: string): ViewPlacementRef {
  return Object.freeze({ id: stableRefId(id) });
}

export function defineProtocolChannel<TWire>(id: string): ProtocolChannelRef<TWire> {
  return Object.freeze({ [PROTOCOL_CHANNEL_BRAND]: true as const, id: stableRefId(id) });
}

export function defineProtocolSchema<TWire, TMessage>(
  id: string,
  parse: (wire: Readonly<TWire>) => TMessage | null,
): ProtocolSchemaRef<TWire, TMessage> {
  return Object.freeze({ [PROTOCOL_SCHEMA_BRAND]: true as const, id: stableRefId(id), parse });
}

export function defineHookTarget<TArgs extends readonly unknown[], TResult>(
  id: string,
  kind: HookTargetRef<TArgs, TResult>["kind"] = "function",
): HookTargetRef<TArgs, TResult> {
  return Object.freeze({ [HOOK_TARGET_BRAND]: true as const, id: stableRefId(id), kind });
}

export function defineResourceTarget<TDocument>(id: string): ResourceTargetRef<TDocument> {
  return Object.freeze({ [RESOURCE_TARGET_BRAND]: true as const, id: stableRefId(id) });
}

export function defineResourceLocator<TDocument, TMatch>(id: string): ResourceLocatorRef<TDocument, TMatch> {
  return Object.freeze({ [RESOURCE_LOCATOR_BRAND]: true as const, id: stableRefId(id) });
}

export function defineEnvironmentKey<TValue>(
  id: string,
  commitBoundary: EnvironmentKeyRef<TValue>["commitBoundary"],
): EnvironmentKeyRef<TValue> {
  return Object.freeze({ [ENVIRONMENT_KEY_BRAND]: true as const, id: stableRefId(id), commitBoundary });
}

export function defineProcessTarget<TRequest, TResult>(id: string): ProcessTargetRef<TRequest, TResult> {
  return Object.freeze({ [PROCESS_TARGET_BRAND]: true as const, id: stableRefId(id) });
}

export function defineArtifactTarget<TSpec, TResult>(id: string): ArtifactTargetRef<TSpec, TResult> {
  return Object.freeze({ [ARTIFACT_TARGET_BRAND]: true as const, id: stableRefId(id) });
}

export function createRuntimeViewApi(adapter: AdapterRef<RuntimeViewDeclaration>): RuntimeViewApi {
  return Object.freeze<RuntimeViewApi>({
    mount(declaration) {
      return adapter.use({
        operation: "mount",
        locator: declaration.target.locator,
        slot: declaration.slot as ViewSlotRef<ViewTargetRef<string, unknown>>,
        source: declaration.source as SignalRef<unknown>,
        render: declaration.render as (context: ViewRenderContext<unknown, unknown>) => VirtualView,
      });
    },
    mountLowLevel(declaration) {
      return adapter.use({
        operation: "mount",
        locator: declaration.locator,
        slot: declaration.placement,
        source: declaration.source as SignalRef<unknown>,
        render: declaration.render as (context: ViewRenderContext<unknown, unknown>) => VirtualView,
      });
    },
    observe(declaration) {
      return adapter.use({
        operation: "observe",
        locator: declaration.locator,
        handle: declaration.handle as (model: Readonly<unknown>) => void,
      });
    },
  });
}

export function createProtocolPipelineApi(adapter: AdapterRef<ProtocolDeclaration>): ProtocolPipelineApi {
  return Object.freeze<ProtocolPipelineApi>({
    observe(declaration) {
      return adapter.use({
        operation: "observe",
        channel: declaration.channel as ProtocolChannelRef<unknown>,
        schema: declaration.schema as ProtocolSchemaRef<unknown, unknown>,
        publishTo: declaration.publishTo as SignalRef<unknown>,
        map: declaration.map as (message: Readonly<unknown>) => unknown,
      });
    },
    transform(declaration) {
      return adapter.use({
        operation: "transform",
        channel: declaration.channel as ProtocolChannelRef<unknown>,
        schema: declaration.schema as ProtocolSchemaRef<unknown, unknown>,
        transform: declaration.transform as (message: Readonly<unknown>) => unknown,
      });
    },
  });
}

export function createRuntimeHookApi(adapter: AdapterRef<RuntimeHookDeclaration>): RuntimeHookApi {
  const orderOf = (value: number | undefined) => {
    const order = Number(value || 0);
    if (!Number.isFinite(order)) throw new TypeError("Hook 顺序必须是有限数字");
    return order;
  };
  return Object.freeze<RuntimeHookApi>({
    before(declaration) {
      return adapter.use({
        operation: "before",
        target: declaration.target as HookTargetRef<readonly unknown[], unknown>,
        order: orderOf(declaration.order),
        handle: declaration.handle as Extract<RuntimeHookDeclaration, { operation: "before" }>["handle"],
      });
    },
    after(declaration) {
      return adapter.use({
        operation: "after",
        target: declaration.target as HookTargetRef<readonly unknown[], unknown>,
        order: orderOf(declaration.order),
        handle: declaration.handle as Extract<RuntimeHookDeclaration, { operation: "after" }>["handle"],
      });
    },
    around(declaration) {
      return adapter.use({
        operation: "around",
        target: declaration.target as HookTargetRef<readonly unknown[], unknown>,
        order: orderOf(declaration.order),
        handle: declaration.handle as Extract<RuntimeHookDeclaration, { operation: "around" }>["handle"],
      });
    },
  });
}

export function createStaticResourceApi(adapter: AdapterRef<StaticResourceDeclaration>): StaticResourceApi {
  return Object.freeze<StaticResourceApi>({
    transform(declaration) {
      return adapter.use({
        operation: "transform",
        resource: declaration.resource as ResourceTargetRef<unknown>,
        locator: declaration.locator as ResourceLocatorRef<unknown, unknown>,
        expectedCandidates: declaration.expectedCandidates,
        transform: declaration.transform as (document: Readonly<unknown>, match: Readonly<unknown>) => unknown,
        verify: declaration.verify as (document: Readonly<unknown>) => boolean,
      });
    },
  });
}

export function createRuntimeEnvironmentApi(
  adapter: AdapterRef<RuntimeEnvironmentDeclaration>,
): RuntimeEnvironmentApi {
  return Object.freeze<RuntimeEnvironmentApi>({
    provide(declaration) {
      return adapter.use({
        operation: "provide",
        key: declaration.key as EnvironmentKeyRef<unknown>,
        value: declaration.value,
      });
    },
  });
}

export function createProcessInterceptionApi(
  adapter: AdapterRef<ProcessInterceptionDeclaration>,
): ProcessInterceptionApi {
  return Object.freeze<ProcessInterceptionApi>({
    intercept(declaration) {
      const order = Number(declaration.order || 0);
      if (!Number.isFinite(order)) throw new TypeError("进程拦截顺序必须是有限数字");
      return adapter.use({
        operation: "intercept",
        target: declaration.target as ProcessTargetRef<unknown, unknown>,
        order,
        handle: declaration.handle as ProcessInterceptionDeclaration["handle"],
      });
    },
  });
}

export function createArtifactBuildApi(adapter: AdapterRef<ArtifactBuildDeclaration>): ArtifactBuildApi {
  return Object.freeze<ArtifactBuildApi>({
    build(declaration) {
      return adapter.use({
        operation: "build",
        target: declaration.target as ArtifactTargetRef<unknown, unknown>,
        spec: declaration.spec,
        publishTo: declaration.publishTo as CapabilityRef<unknown>,
      });
    },
  });
}
