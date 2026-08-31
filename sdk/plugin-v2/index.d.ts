declare const groupBrand: unique symbol;
declare const adapterBrand: unique symbol;
declare const contributionBrand: unique symbol;
declare const pointBrand: unique symbol;
declare const locatorBrand: unique symbol;
declare const placementBrand: unique symbol;
declare const virtualNodeBrand: unique symbol;

export interface PointGroupRef {
  readonly [groupBrand]: true;
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly order: number;
}

export interface AdapterUse<TDeclaration = unknown> {
  readonly [contributionBrand]: true;
  readonly adapter: AdapterRef<TDeclaration>;
  readonly declaration: Readonly<TDeclaration>;
}

export interface AdapterRef<TDeclaration = unknown> {
  readonly [adapterBrand]: true;
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly kind: "terminal" | "composite";
  readonly dependencies: readonly AdapterRef<unknown>[];
  use(declaration: TDeclaration): AdapterUse<TDeclaration>;
}

export interface ModificationPointRef {
  readonly [pointBrand]: true;
  readonly id: string;
}

export interface ViewLocatorRef {
  readonly [locatorBrand]: true;
  readonly id: string;
}

export interface ViewPlacementRef {
  readonly [placementBrand]: true;
  readonly id: string;
}

export interface VirtualViewNode {
  readonly [virtualNodeBrand]: true;
  readonly kind: "element" | "text";
}

export interface BrowserHookTargetRef {
  readonly id: string;
}

export interface BrowserProtocolChannelRef {
  readonly id: string;
}

export interface BrowserProtocolSchemaRef<TMessage> {
  readonly id: string;
  parse(value: unknown): TMessage | null;
}

export interface BrowserViewMountDeclaration {
  readonly locator: ViewLocatorRef;
  readonly placement: ViewPlacementRef;
  readonly content: VirtualViewNode;
}

export interface OpenCodexPluginManifestV2 {
  readonly id: string;
  readonly apiVersion: 2;
  readonly entry: string;
  readonly sdkVersion: string;
  readonly name?: string;
  readonly label?: string;
  readonly desc?: string;
  readonly defaultEnabled?: boolean;
  readonly order?: number;
}

interface ViewAdapterApi {
  readonly ref: AdapterRef<BrowserViewMountDeclaration>;
  mount(declaration: BrowserViewMountDeclaration): AdapterUse<BrowserViewMountDeclaration>;
}

interface HookAdapterApi {
  readonly ref: AdapterRef<unknown>;
  before(declaration: {
    target: BrowserHookTargetRef;
    order?: number;
    handle(context: { readonly args: readonly unknown[] }): readonly unknown[] | void;
  }): AdapterUse<unknown>;
  after(declaration: {
    target: BrowserHookTargetRef;
    order?: number;
    handle(context: { readonly args: readonly unknown[]; readonly result: unknown }): unknown;
  }): AdapterUse<unknown>;
  around(declaration: {
    target: BrowserHookTargetRef;
    order?: number;
    handle(context: {
      readonly args: readonly unknown[];
      proceed(args?: readonly unknown[]): unknown;
    }): unknown;
  }): AdapterUse<unknown>;
}

interface ProtocolAdapterApi {
  readonly ref: AdapterRef<unknown>;
  observe<TMessage>(declaration: {
    channel: BrowserProtocolChannelRef;
    schema: BrowserProtocolSchemaRef<TMessage>;
    handle(message: Readonly<TMessage>): unknown;
  }): AdapterUse<unknown>;
}

export interface OpenCodexPluginSdk {
  readonly apiVersion: 2;
  readonly sdkVersion: "2.0.0";
  readonly plugin: { readonly id: string };
  readonly groups: {
    readonly rendererCore: PointGroupRef;
    readonly startupHistory: PointGroupRef;
    readonly workspace: PointGroupRef;
    readonly remoteFiles: PointGroupRef;
    readonly smartRouting: PointGroupRef;
    readonly notificationPower: PointGroupRef;
    readonly tokenUsage: PointGroupRef;
    readonly mobileInteraction: PointGroupRef;
    readonly rendererUi: PointGroupRef;
    readonly browserPlatform: PointGroupRef;
    readonly webNetwork: PointGroupRef;
    readonly projectNavigation: PointGroupRef;
    readonly gatewayRuntime: PointGroupRef;
    readonly gatewayIpc: PointGroupRef;
    readonly officialMain: PointGroupRef;
    readonly rendererResources: PointGroupRef;
    readonly runnerPackaging: PointGroupRef;
    register(definition: { id: string; name: string; description: string; order: number }): PointGroupRef;
  };
  readonly adapters: {
    readonly runtimeView: ViewAdapterApi;
    readonly semanticView: ViewAdapterApi;
    readonly protocolPipeline: ProtocolAdapterApi;
    readonly runtimeHook: HookAdapterApi;
    readonly staticResource: AdapterRef<unknown>;
    readonly runtimeEnvironment: AdapterRef<unknown>;
    readonly processInterception: AdapterRef<unknown>;
    readonly artifactBuild: AdapterRef<unknown>;
    readonly desktopBridge: AdapterRef<unknown>;
    readonly browserNative: AdapterRef<unknown>;
    readonly networkRequest: AdapterRef<unknown>;
    readonly mobileInteraction: AdapterRef<unknown>;
    readonly officialRuntime: AdapterRef<unknown>;
    readonly officialEnvironment: AdapterRef<unknown>;
    readonly electronApi: AdapterRef<unknown>;
    readonly projectOrdering: AdapterRef<unknown>;
    readonly gatewayIpc: AdapterRef<unknown>;
    readonly appServerProtocol: AdapterRef<unknown>;
    readonly processBridge: AdapterRef<unknown>;
    readonly semanticProtocol: AdapterRef<unknown>;
    readonly officialMainPatch: AdapterRef<unknown>;
    readonly officialRendererPatch: AdapterRef<unknown>;
    readonly runnerArtifact: AdapterRef<unknown>;
    compose<TDeclaration>(definition: {
      id: string;
      name: string;
      description: string;
      dependencies: readonly AdapterRef<unknown>[];
      expand(declaration: Readonly<TDeclaration>): readonly AdapterUse<unknown>[];
    }): AdapterRef<TDeclaration>;
  };
  readonly points: {
    register(definition: {
      id: string;
      description: string;
      group: PointGroupRef;
      contributions: readonly AdapterUse<unknown>[];
    }): ModificationPointRef;
  };
  readonly view: {
    readonly locators: {
      css(id: string, selector: string): ViewLocatorRef;
    };
    readonly placements: {
      readonly append: ViewPlacementRef;
      readonly prepend: ViewPlacementRef;
      readonly before: ViewPlacementRef;
      readonly after: ViewPlacementRef;
    };
    readonly ui: {
      text(value: unknown): VirtualViewNode;
      element(input: {
        tag?: string;
        text?: string;
        attributes?: Readonly<Record<string, string>>;
        children?: readonly VirtualViewNode[];
        onPress?: () => void;
      }): VirtualViewNode;
    };
  };
  readonly hooks: {
    readonly targets: {
      windowMethod(id: string, path: readonly string[]): BrowserHookTargetRef;
    };
  };
  readonly protocol: {
    readonly channels: {
      readonly appHost: BrowserProtocolChannelRef;
      readonly gateway: BrowserProtocolChannelRef;
    };
    readonly schemas: {
      define<TMessage>(id: string, parse: (value: unknown) => TMessage | null): BrowserProtocolSchemaRef<TMessage>;
    };
  };
}

export type OpenCodexPluginFactory = (sdk: OpenCodexPluginSdk) => void | Promise<void>;
