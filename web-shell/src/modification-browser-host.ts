import {
  ADAPTER_DEFINITIONS,
  BASE_ADAPTERS,
  BUILTIN_BROWSER_TARGETS,
  POINT_DEFINITIONS,
  POINT_GROUP_DEFINITIONS,
  registerModificationCatalog,
} from "../../gateway/src/modification/catalog";
import {
  AdapterExecutionReporter,
  BoundContribution,
  ModificationRuntime,
  TerminalAdapterProvider,
  createModificationRuntime,
} from "../../gateway/src/modification/kernel";
import { AdapterRef } from "../../gateway/src/modification/sdk";
import { installPluginSdk } from "./plugin-sdk";

interface DomSubscription {
  readonly key: object;
  readonly owner: BrowserProviderScope | null;
  readonly root: Node;
  readonly options: MutationObserverInit;
  readonly callback: MutationCallback;
}

interface ObserverEntry {
  readonly root: Node;
  readonly observer: MutationObserver;
  readonly subscriptions: Map<object, DomSubscription>;
  readonly dispatch: (records: readonly MutationRecord[], observer: MutationObserver) => void;
  options: MutationObserverInit;
}

interface EventSubscription {
  readonly key: object;
  readonly owner: BrowserProviderScope | null;
  readonly callback: EventListener;
  readonly once: boolean;
}

interface ProtocolChannelRef {
  readonly id: string;
}

interface ProtocolFrame {
  readonly raw: unknown;
  readonly value: unknown;
  readonly metadata: Readonly<Record<string, unknown>>;
  decode(): unknown;
}

interface ProtocolSubscription {
  readonly key: object;
  readonly owner: BrowserProviderScope | null;
  readonly callback: (frame: ProtocolFrame) => unknown;
  readonly propagateErrors: boolean;
}

interface ProtocolTransformSubscription {
  readonly key: object;
  readonly owner: BrowserProviderScope | null;
  readonly order: number;
  readonly callback: (frame: ProtocolFrame) => unknown;
  readonly propagateErrors: boolean;
}

interface EventEntry {
  readonly target: EventTarget;
  readonly type: string;
  readonly capture: boolean;
  passive: boolean;
  readonly listener: EventListener;
  readonly subscriptions: Map<object, EventSubscription>;
}

interface HookLayer {
  readonly key: object;
  readonly owner: BrowserProviderScope | null;
  readonly order: number;
  readonly handle: (thisValue: unknown, args: readonly unknown[], proceed: (args?: readonly unknown[]) => unknown) => unknown;
}

interface HookEntry {
  readonly target: Record<PropertyKey, unknown>;
  readonly property: PropertyKey;
  readonly original: (...args: readonly unknown[]) => unknown;
  readonly wrapper: (...args: readonly unknown[]) => unknown;
  readonly layers: Map<object, HookLayer>;
}

interface AdapterHostDiagnostics {
  readonly mutationObserverCount: number;
  readonly mutationDispatchCount: number;
  readonly eventListenerCount: number;
  readonly eventDispatchCount: number;
  readonly hookTargetCount: number;
  readonly hookInvocationCount: number;
  readonly protocolDecodeCount: number;
  readonly protocolDispatchCount: number;
  readonly protocolSubscriberCount: number;
  readonly protocolTransformCount: number;
  readonly protocolTransformerCount: number;
}

interface BrowserKernelTransport {
  readonly clientId: string;
  beginGeneration?(): void;
  ingestSnapshot(snapshot: ReturnType<ModificationRuntime["snapshot"]>): void;
}

interface BrowserProviderInstaller {
  (): void | (() => void);
}

interface BrowserManagedContributionContext {
  readonly onHit: () => void;
}

interface BrowserManagedContributionFactory {
  (context: BrowserManagedContributionContext): ManagedBrowserContribution;
}

interface BrowserProviderDefinition {
  readonly key: string;
  readonly points: Readonly<Record<string, string>>;
  readonly effects?: Readonly<Record<string, string>>;
}

interface BrowserProviderEffect {
  emit(count?: number): void;
}

interface BrowserProviderScope {
  readonly clientId: string;
  readonly generation: number;
  readonly effects: Readonly<Record<string, BrowserProviderEffect>>;
  /** Provider 通过共享宿主取得的资源统一归属当前页面代际。 */
  own(dispose: () => void): () => void;
  active(): boolean;
  setEnabled(enabled: boolean, reason?: string): void;
  close(): void;
}

interface BrowserProviderState {
  readonly definition: BrowserProviderDefinition;
  readonly installers: BrowserProviderInstaller[];
  readonly disposers: (() => void)[];
  readonly applications: Set<symbol>;
  readonly enabledCallbacks: Set<(enabled: boolean, reason: string) => void>;
  readonly lifecycleCallbacks: Set<(enabled: boolean) => void>;
  readonly managedFactories: Map<string, BrowserManagedContributionFactory>;
  scope: BrowserProviderScope | null;
  enabled: boolean | null;
  installed: boolean;
  installing: boolean;
  failure: unknown;
}

interface BrowserResourceScope {
  run<TResult>(operation: () => TResult): TResult;
  dispose(): void;
}

interface BrowserScheduler {
  setTimeout(callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]): number;
  clearTimeout(handle: number): void;
  setInterval(callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]): number;
  clearInterval(handle: number): void;
  requestAnimationFrame(callback: FrameRequestCallback): number;
  cancelAnimationFrame(handle: number): void;
}

/**
 * Provider key 只标识受信脚本资源；修改点仍以目录里的强类型对象参与 Kernel。
 * effects 允许一个 Provider 触发另一个 Provider 所属点的真实语义，例如 Bridge 触发目录选择。
 */
const BROWSER_PROVIDER_DEFINITIONS: readonly BrowserProviderDefinition[] = Object.freeze([
  { key: "runtime-host", points: { primary: "web.runtime.shell.legacy-document-replace" } },
  {
    key: "sidebar-preview",
    points: {
      handoff: "web.runtime.dom.sidebar-preview-handoff",
      lateModulePreload: "web.runtime.dom.late-module-preload",
    },
  },
  { key: "offscreen-animation", points: { primary: "web.runtime.dom.offscreen-animation" } },
  { key: "mobile-keyboard", points: { primary: "web.runtime.plugin.mobile-keyboard" } },
  { key: "ios-layout", points: { primary: "web.runtime.plugin.ios-layout" } },
  {
    key: "mobile-sidebar",
    points: {
      primary: "web.runtime.plugin.mobile-sidebar",
      touchScroll: "web.runtime.plugin.mobile-sidebar-touch-scroll",
    },
  },
  { key: "token-usage-inline", points: { primary: "web.runtime.dom.token-usage-inline" } },
  { key: "project-recent-sort", points: { primary: "web.runtime.plugin.project-recent-sort" } },
  { key: "smart-settings", points: { primary: "web.runtime.smart-router.settings" } },
  { key: "smart-composer", points: { primary: "web.runtime.smart-router.composer" } },
  { key: "smart-summary", points: { primary: "web.runtime.smart-router.summary" } },
  { key: "token-usage-capability", points: { primary: "web.runtime.protocol.token-usage" } },
  { key: "window-controls", points: { primary: "web.runtime.dom.window-controls-overlay" } },
  {
    key: "bridge",
    points: {
      appFsImage: "web.runtime.dom.app-fs-image",
      appHostPort: "web.runtime.bridge.app-host-port",
      connectorLogo: "web.runtime.protocol.connector-logo",
      desktopApi: "web.runtime.bridge.desktop-api",
      desktopGlobals: "web.runtime.platform.desktop-globals",
      externalOpen: "web.runtime.native.external-open",
      featureGates: "web.runtime.bridge.feature-gates",
      filePicker: "web.runtime.native.file-picker",
      gatewayAuthMenu: "web.runtime.dom.gateway-auth-menu",
      ideContext: "web.runtime.native.ide-context",
      initialSidebar: "web.runtime.bridge.initial-sidebar",
      ipcTransport: "web.runtime.bridge.ipc-transport",
      nativeNotification: "web.runtime.native.notification",
      persistedAtom: "web.runtime.bridge.persisted-atom",
      sharedObject: "web.runtime.bridge.shared-object",
      statsig: "web.runtime.network.statsig",
      telemetry: "web.runtime.network.telemetry",
      terminal: "web.runtime.native.terminal",
      webviewShim: "web.runtime.dom.webview-shim",
    },
    effects: {
      workspaceRootPicker: "web.runtime.workspace.root-picker",
    },
  },
  { key: "remote-file-actions", points: { primary: "web.runtime.dom.remote-file-menu" } },
  { key: "workspace-root-picker", points: { primary: "web.runtime.workspace.root-picker" } },
  { key: "tooltip-dismiss", points: { primary: "web.runtime.dom.tooltip-dismiss" } },
]);

const MOBILE_SIDEBAR_TOUCH_SCROLL_STYLE_ID = "opencodex-mobile-sidebar-touch-scroll-styles";
const MOBILE_SIDEBAR_TOUCH_SCROLL_CSS = `
  @media (max-width: 820px), (pointer: coarse) {
    /* 官方可排序列表项会设置 touch-action:none；必须在手势开始前允许纵向原生滚动。 */
    [data-app-action-sidebar-scroll] [role="listitem"],
    [data-app-action-sidebar-scroll] [data-app-action-sidebar-thread-row] {
      touch-action: pan-y !important;
    }
  }
`;

interface ManagedBrowserContribution {
  verify(): void;
  dispose(): void;
}

function isMobileSidebarTouchScrollContribution(contribution: BoundContribution): boolean {
  const declaration = contribution.declaration as { readonly target?: unknown };
  return contribution.adapter === BASE_ADAPTERS.runtimeView &&
    declaration.target === BUILTIN_BROWSER_TARGETS.mobileSidebarTouchScroll;
}

function isWindowControlsOverlayContribution(contribution: BoundContribution): boolean {
  const declaration = contribution.declaration as { readonly target?: unknown };
  return contribution.adapter === BASE_ADAPTERS.runtimeView &&
    declaration.target === BUILTIN_BROWSER_TARGETS.windowControlsOverlay;
}

function installMobileSidebarTouchScrollContribution(
  state: BrowserProviderState,
  onHit: () => void,
): ManagedBrowserContribution {
  let active = true;
  let style: HTMLStyleElement | null = null;

  const unmount = () => {
    style?.parentNode?.removeChild(style);
    style = null;
  };
  const synchronize = (enabled: boolean) => {
    if (!active || !enabled || style) {
      if (!enabled) unmount();
      return;
    }
    const node = document.createElement("style");
    node.id = MOBILE_SIDEBAR_TOUCH_SCROLL_STYLE_ID;
    node.textContent = MOBILE_SIDEBAR_TOUCH_SCROLL_CSS;
    (document.head || document.documentElement).appendChild(node);
    style = node;
    onHit();
  };

  state.lifecycleCallbacks.add(synchronize);
  if (state.enabled != null) synchronize(state.enabled);
  return Object.freeze({
    verify() {
      if (!active) throw new Error("移动端侧栏触摸滚动 Contribution 已经释放");
      if (state.enabled === true && !style?.isConnected) {
        throw new Error("移动端侧栏触摸滚动样式没有连接到当前页面");
      }
    },
    dispose() {
      if (!active) return;
      active = false;
      state.lifecycleCallbacks.delete(synchronize);
      unmount();
    },
  });
}

const observerEntries = new Map<Node, ObserverEntry>();
const eventEntries = new Map<string, EventEntry>();
const eventTargetIds = new WeakMap<object, number>();
const hookEntries = new WeakMap<object, Map<PropertyKey, HookEntry>>();
const hookEntrySet = new Set<HookEntry>();
let mutationDispatchCount = 0;
let eventDispatchCount = 0;
let hookInvocationCount = 0;
let protocolDecodeCount = 0;
let protocolDispatchCount = 0;
let protocolTransformCount = 0;
let eventTargetSequence = 0;
const protocolChannelTokens = new WeakSet<object>();
const protocolSubscriptions = new Map<ProtocolChannelRef, Map<object, ProtocolSubscription>>();
const protocolTransformSubscriptions = new Map<ProtocolChannelRef, Map<object, ProtocolTransformSubscription>>();

function ownProviderDisposer(dispose: () => void): () => void {
  const scope = window.__OpenCodexCurrentProviderScope;
  return scope ? scope.own(dispose) : dispose;
}

function runInProviderScope<TResult>(
  scope: BrowserProviderScope | null,
  operation: () => TResult,
): TResult {
  if (!scope) return operation();
  const previousScope = window.__OpenCodexCurrentProviderScope;
  window.__OpenCodexCurrentProviderScope = scope;
  try {
    return operation();
  } finally {
    window.__OpenCodexCurrentProviderScope = previousScope;
  }
}

function captureProviderScheduler(): BrowserScheduler {
  const owner = window.__OpenCodexCurrentProviderScope || null;
  const timeoutCancellations = new Map<number, () => void>();
  const intervalCancellations = new Map<number, () => void>();
  const frameCancellations = new Map<number, () => void>();
  const ownTimer = (
    schedule: (callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => number,
    cancel: (handle: number) => void,
    callback: (...args: unknown[]) => void,
    delay: number | undefined,
    args: readonly unknown[],
    once: boolean,
    cancellations: Map<number, () => void>,
  ): number => {
    let active = true;
    let handle = 0;
    let cancelOwned = () => {};
    const wrapped = (...callbackArgs: unknown[]) => {
      if (!active) return;
      if (once) {
        active = false;
        cancellations.delete(handle);
        cancelOwned();
      }
      runInProviderScope(owner, () => callback(...callbackArgs));
    };
    handle = schedule(wrapped, delay, ...args);
    cancelOwned = owner?.own(() => {
      if (!active) return;
      active = false;
      cancellations.delete(handle);
      cancel(handle);
    }) || (() => {
      if (!active) return;
      active = false;
      cancellations.delete(handle);
      cancel(handle);
    });
    cancellations.set(handle, cancelOwned);
    return handle;
  };
  return Object.freeze({
    setTimeout(callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) {
      return ownTimer(
        window.setTimeout.bind(window), window.clearTimeout.bind(window), callback, delay, args, true, timeoutCancellations,
      );
    },
    clearTimeout(handle: number) {
      const cancel = timeoutCancellations.get(handle);
      if (cancel) cancel();
      else window.clearTimeout(handle);
    },
    setInterval(callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) {
      return ownTimer(
        window.setInterval.bind(window), window.clearInterval.bind(window), callback, delay, args, false, intervalCancellations,
      );
    },
    clearInterval(handle: number) {
      const cancel = intervalCancellations.get(handle);
      if (cancel) cancel();
      else window.clearInterval(handle);
    },
    requestAnimationFrame(callback: FrameRequestCallback) {
      if (typeof window.requestAnimationFrame !== "function") {
        return ownTimer(
          window.setTimeout.bind(window),
          window.clearTimeout.bind(window),
          (timestamp: unknown) => callback(Number(timestamp) || Date.now()),
          16,
          [],
          true,
          frameCancellations,
        );
      }
      let active = true;
      let handle = 0;
      let cancelOwned = () => {};
      handle = window.requestAnimationFrame((timestamp) => {
        if (!active) return;
        active = false;
        frameCancellations.delete(handle);
        cancelOwned();
        runInProviderScope(owner, () => callback(timestamp));
      });
      cancelOwned = owner?.own(() => {
        if (!active) return;
        active = false;
        frameCancellations.delete(handle);
        window.cancelAnimationFrame(handle);
      }) || (() => {
        if (!active) return;
        active = false;
        frameCancellations.delete(handle);
        window.cancelAnimationFrame(handle);
      });
      frameCancellations.set(handle, cancelOwned);
      return handle;
    },
    cancelAnimationFrame(handle: number) {
      const cancel = frameCancellations.get(handle);
      if (cancel) cancel();
      else if (typeof window.cancelAnimationFrame === "function") window.cancelAnimationFrame(handle);
      else window.clearTimeout(handle);
    },
  });
}

function createBrowserResourceScope(): BrowserResourceScope {
  const disposers: (() => void)[] = [];
  let active = true;
  const scope: BrowserProviderScope = Object.freeze({
    clientId: "",
    generation: 0,
    effects: Object.freeze({}),
    own(dispose: () => void) {
      if (!active) {
        dispose();
        return () => {};
      }
      let ownedActive = true;
      const owned = () => {
        if (!ownedActive) return;
        ownedActive = false;
        const index = disposers.indexOf(owned);
        if (index >= 0) disposers.splice(index, 1);
        dispose();
      };
      disposers.push(owned);
      return owned;
    },
    active() {
      return active;
    },
    setEnabled() {
      // 独立资源作用域不对应内置修改点，启停状态由其所属 Kernel 自己管理。
    },
    close() {
      active = false;
    },
  });
  return Object.freeze({
    run<TResult>(operation: () => TResult): TResult {
      if (!active) throw new Error("浏览器资源作用域已经释放");
      return runInProviderScope(scope, operation);
    },
    dispose() {
      if (!active) return;
      active = false;
      scope.close();
      for (const dispose of disposers.splice(0).reverse()) dispose();
    },
  });
}

function registerOwnedPlugin(
  pluginSystem: { registerPlugin(plugin: Readonly<Record<string, unknown>>): unknown },
  plugin: Readonly<Record<string, unknown>>,
): unknown {
  if (!pluginSystem || typeof pluginSystem.registerPlugin !== "function") {
    throw new TypeError("插件系统没有提供 registerPlugin");
  }
  const owner = window.__OpenCodexCurrentProviderScope || null;
  const activate = plugin.activate;
  if (!owner || typeof activate !== "function") return pluginSystem.registerPlugin(plugin);
  owner.setEnabled(false, "插件已关闭");
  const wrapped = Object.freeze({
    ...plugin,
    activate(this: unknown, ...args: readonly unknown[]) {
      if (!owner.active()) return null;
      owner.setEnabled(true);
      try {
        const result = runInProviderScope(owner, () => activate.apply(this, args));
        if (result == null) {
          owner.setEnabled(false, "当前环境未启用插件");
          return result;
        }
        if (typeof result !== "function") return result;
        return owner.own(() => {
          try {
            (result as () => void)();
          } finally {
            owner.setEnabled(false, "插件已关闭");
          }
        });
      } catch (error) {
        owner.setEnabled(false, "插件激活失败");
        throw error;
      }
    },
  });
  return pluginSystem.registerPlugin(wrapped);
}

function defineProtocolChannel(id: string): ProtocolChannelRef {
  const channel = Object.freeze({ id });
  protocolChannelTokens.add(channel);
  protocolSubscriptions.set(channel, new Map());
  protocolTransformSubscriptions.set(channel, new Map());
  return channel;
}

const protocolChannels = Object.freeze({
  appHost: defineProtocolChannel("channel.app-host"),
  gateway: defineProtocolChannel("channel.gateway"),
});

function mergedObserverOptions(subscriptions: Iterable<DomSubscription>): MutationObserverInit {
  const result: MutationObserverInit = {};
  const attributeFilter = new Set<string>();
  let observesAllAttributes = false;
  for (const subscription of subscriptions) {
    const options = subscription.options;
    const observesAttributes = options.attributes === true || options.attributeOldValue === true || !!options.attributeFilter;
    result.attributes ||= observesAttributes;
    result.attributeOldValue ||= options.attributeOldValue === true;
    result.characterData ||= options.characterData === true || options.characterDataOldValue === true;
    result.characterDataOldValue ||= options.characterDataOldValue === true;
    result.childList ||= options.childList === true;
    result.subtree ||= options.subtree === true;
    if (observesAttributes && (!options.attributeFilter || options.attributeFilter.length === 0)) observesAllAttributes = true;
    for (const attribute of options.attributeFilter || []) attributeFilter.add(attribute);
  }
  if (!observesAllAttributes && attributeFilter.size > 0) result.attributeFilter = [...attributeFilter];
  return result;
}

function sameObserverOptions(left: MutationObserverInit, right: MutationObserverInit): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function restartObserver(entry: ObserverEntry): void {
  const options = mergedObserverOptions(entry.subscriptions.values());
  if (sameObserverOptions(options, entry.options)) return;
  entry.observer.disconnect();
  entry.options = options;
  if (entry.subscriptions.size > 0) entry.observer.observe(entry.root, options);
}

function flushPendingObserverRecords(entry: ObserverEntry): void {
  const records = entry.observer.takeRecords?.() || [];
  if (records.length > 0) entry.dispatch(records, entry.observer);
}

function recordsForSubscription(records: readonly MutationRecord[], subscription: DomSubscription): MutationRecord[] {
  const { options, root } = subscription;
  return records.filter((record) => {
    if (options.subtree !== true && record.target !== root) return false;
    if (record.type === "childList") return options.childList === true;
    if (record.type === "characterData") return options.characterData === true;
    const observesAttributes = options.attributes === true || options.attributeOldValue === true || !!options.attributeFilter;
    if (record.type !== "attributes" || !observesAttributes) return false;
    if (!options.attributeFilter || options.attributeFilter.length === 0) return true;
    return !!record.attributeName && options.attributeFilter.includes(record.attributeName);
  });
}

function observeDom(input: {
  key: object;
  root: Node;
  options: MutationObserverInit;
  callback: MutationCallback;
}): () => void {
  if (!input.key || !input.root || typeof input.callback !== "function") throw new TypeError("DOM 观察声明不完整");
  let entry = observerEntries.get(input.root);
  if (!entry) {
    const subscriptions = new Map<object, DomSubscription>();
    const dispatch = (records: readonly MutationRecord[], activeObserver: MutationObserver) => {
      mutationDispatchCount += 1;
      // 同一批真实 mutations 只接收一次，再按订阅分发，避免每个修改点各自创建 Observer。
      for (const subscription of [...subscriptions.values()]) {
        try {
          const scopedRecords = recordsForSubscription(records, subscription);
          if (scopedRecords.length > 0) {
            runInProviderScope(subscription.owner, () => subscription.callback(scopedRecords, activeObserver));
          }
        } catch (error) {
          console.warn("[opencodex-adapter] mutation subscriber failed", error);
        }
      }
    };
    const observer = new MutationObserver(dispatch);
    entry = { root: input.root, observer, subscriptions, dispatch, options: {} };
    observerEntries.set(input.root, entry);
  } else {
    // 新订阅不能收到注册前已经排队的记录；先按旧订阅集合同步清空，再合并 options。
    flushPendingObserverRecords(entry);
  }
  entry.subscriptions.set(input.key, Object.freeze({
    ...input,
    owner: window.__OpenCodexCurrentProviderScope || null,
  }));
  restartObserver(entry);
  let active = true;
  return ownProviderDisposer(() => {
    if (!active) return;
    active = false;
    const current = observerEntries.get(input.root);
    if (!current) return;
    current.subscriptions.delete(input.key);
    if (current.subscriptions.size === 0) {
      current.observer.disconnect();
      observerEntries.delete(input.root);
    } else restartObserver(current);
  });
}

function eventEntryKey(target: EventTarget, type: string, capture: boolean): string {
  const objectTarget = target as object;
  let targetId = eventTargetIds.get(objectTarget);
  if (!targetId) {
    targetId = ++eventTargetSequence;
    eventTargetIds.set(objectTarget, targetId);
  }
  return `${targetId}\0${type}\0${capture ? 1 : 0}`;
}

function observeEvent(input: {
  key: object;
  target: EventTarget;
  type: string;
  capture?: boolean;
  passive?: boolean;
  once?: boolean;
  callback: EventListener;
}): () => void {
  const capture = input.capture === true;
  const passive = input.passive === true;
  const mapKey = eventEntryKey(input.target, input.type, capture);
  let entry = eventEntries.get(mapKey);
  if (!entry || entry.target !== input.target) {
    const subscriptions = new Map<object, EventSubscription>();
    const listener: EventListener = (event) => {
      eventDispatchCount += 1;
      for (const subscription of [...subscriptions.values()]) {
        if (subscription.once) subscriptions.delete(subscription.key);
        try {
          runInProviderScope(subscription.owner, () => subscription.callback(event));
        } catch (error) {
          console.warn("[opencodex-adapter] event subscriber failed", error);
        }
      }
      if (subscriptions.size === 0) {
        input.target.removeEventListener(input.type, listener, { capture });
        eventEntries.delete(mapKey);
      }
    };
    entry = { target: input.target, type: input.type, capture, passive, listener, subscriptions };
    eventEntries.set(mapKey, entry);
    input.target.addEventListener(input.type, listener, { capture, passive });
  } else if (entry.passive && !passive) {
    // passive=false 能承载两类订阅；降级为可 preventDefault 的单一真实 Listener，避免同事件安装两层。
    entry.target.removeEventListener(entry.type, entry.listener, { capture: entry.capture });
    entry.passive = false;
    entry.target.addEventListener(entry.type, entry.listener, { capture: entry.capture, passive: false });
  }
  entry.subscriptions.set(input.key, {
    key: input.key,
    owner: window.__OpenCodexCurrentProviderScope || null,
    callback: input.callback,
    once: input.once === true,
  });
  let active = true;
  return ownProviderDisposer(() => {
    if (!active) return;
    active = false;
    const current = eventEntries.get(mapKey);
    if (!current) return;
    current.subscriptions.delete(input.key);
    if (current.subscriptions.size > 0) return;
    current.target.removeEventListener(current.type, current.listener, { capture: current.capture });
    eventEntries.delete(mapKey);
  });
}

function decodeProtocolValue(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  const source = raw.trim();
  if (!source || (!source.startsWith("{") && !source.startsWith("["))) return raw;
  protocolDecodeCount += 1;
  try {
    return JSON.parse(source) as unknown;
  } catch {
    // App Server 也会通过同一端口发送 NDJSON；一次切行解析后把数组交给所有订阅者复用。
    const values: unknown[] = [];
    for (const line of source.split(/\r?\n/)) {
      const normalized = line.trim();
      if (!normalized) continue;
      try {
        values.push(JSON.parse(normalized) as unknown);
      } catch {
        return raw;
      }
    }
    return values.length > 0 ? values : raw;
  }
}

function createProtocolFrame(
  raw: unknown,
  metadata: Readonly<Record<string, unknown>> = {},
): ProtocolFrame {
  let decoded = false;
  let decodedValue: unknown;
  const decodeOnce = () => {
    if (!decoded) {
      decodedValue = decodeProtocolValue(raw);
      decoded = true;
    }
    return decodedValue;
  };
  return Object.freeze(Object.defineProperties({}, {
    raw: { enumerable: true, value: raw },
    metadata: { enumerable: true, value: Object.freeze({ ...metadata }) },
    value: {
      enumerable: true,
      get: decodeOnce,
    },
    decode: {
      enumerable: false,
      value: decodeOnce,
    },
  })) as ProtocolFrame;
}

function observeProtocol(input: {
  key: object;
  channel: ProtocolChannelRef;
  propagateErrors?: boolean;
  callback: (frame: ProtocolFrame) => unknown;
}): () => void {
  if (!protocolChannelTokens.has(input.channel as object)) throw new TypeError("协议订阅必须引用宿主 Channel 对象");
  const subscriptions = protocolSubscriptions.get(input.channel);
  if (!subscriptions) throw new TypeError("协议 Channel 未注册");
  subscriptions.set(input.key, {
    key: input.key,
    owner: window.__OpenCodexCurrentProviderScope || null,
    callback: input.callback,
    propagateErrors: input.propagateErrors === true,
  });
  let active = true;
  return ownProviderDisposer(() => {
    if (!active) return;
    active = false;
    subscriptions.delete(input.key);
  });
}

function transformProtocol(input: {
  key: object;
  channel: ProtocolChannelRef;
  order?: number;
  propagateErrors?: boolean;
  callback: (frame: ProtocolFrame) => unknown;
}): () => void {
  if (!protocolChannelTokens.has(input.channel as object)) throw new TypeError("协议转换必须引用宿主 Channel 对象");
  if (!input.key || typeof input.callback !== "function") throw new TypeError("协议转换声明不完整");
  const subscriptions = protocolTransformSubscriptions.get(input.channel);
  if (!subscriptions) throw new TypeError("协议 Channel 未注册");
  const order = Number(input.order || 0);
  if (!Number.isFinite(order)) throw new TypeError("协议转换顺序必须是有限数字");
  subscriptions.set(input.key, {
    key: input.key,
    owner: window.__OpenCodexCurrentProviderScope || null,
    order,
    callback: input.callback,
    propagateErrors: input.propagateErrors === true,
  });
  let active = true;
  return ownProviderDisposer(() => {
    if (!active) return;
    active = false;
    subscriptions.delete(input.key);
  });
}

function processProtocol(input: {
  channel: ProtocolChannelRef;
  value: unknown;
  metadata?: Readonly<Record<string, unknown>>;
}): unknown {
  if (!protocolChannelTokens.has(input.channel as object)) throw new TypeError("协议转换必须引用宿主 Channel 对象");
  const subscriptions = protocolTransformSubscriptions.get(input.channel);
  if (!subscriptions) throw new TypeError("协议 Channel 未注册");
  if (subscriptions.size === 0) return input.value;

  let currentValue = input.value;
  let currentFrame = createProtocolFrame(currentValue, input.metadata);
  const ordered = [...subscriptions.values()].sort((left, right) => left.order - right.order);
  for (const subscription of ordered) {
    try {
      protocolTransformCount += 1;
      const transformed = runInProviderScope(
        subscription.owner,
        () => subscription.callback(currentFrame),
      );
      // undefined 明确表示“保持原值”，避免只观察消息的转换器意外改变传输形态。
      if (transformed !== undefined && transformed !== currentValue) {
        currentValue = transformed;
        currentFrame = createProtocolFrame(currentValue, input.metadata);
      }
    } catch (error) {
      if (subscription.propagateErrors) throw error;
      console.warn("[opencodex-adapter] protocol transformer failed", error);
    }
  }
  return currentValue;
}

function publishProtocol(input: {
  channel: ProtocolChannelRef;
  value: unknown;
  metadata?: Readonly<Record<string, unknown>>;
}): readonly unknown[] {
  if (!protocolChannelTokens.has(input.channel as object)) throw new TypeError("协议发布必须引用宿主 Channel 对象");
  const subscriptions = protocolSubscriptions.get(input.channel);
  if (!subscriptions) throw new TypeError("协议 Channel 未注册");
  protocolDispatchCount += 1;
  const frame = createProtocolFrame(input.value, input.metadata);
  const results: unknown[] = [];
  for (const subscription of [...subscriptions.values()]) {
    try {
      results.push(runInProviderScope(subscription.owner, () => subscription.callback(frame)));
    } catch (error) {
      if (subscription.propagateErrors) throw error;
      console.warn("[opencodex-adapter] protocol subscriber failed", error);
    }
  }
  return Object.freeze(results);
}

function installAroundHook<TArgs extends readonly unknown[], TResult>(input: {
  key: object;
  target: Record<PropertyKey, unknown>;
  property: PropertyKey;
  order?: number;
  handle(thisValue: unknown, args: TArgs, proceed: (args?: TArgs) => TResult): TResult;
}): () => void {
  let targetEntries = hookEntries.get(input.target);
  if (!targetEntries) {
    targetEntries = new Map();
    hookEntries.set(input.target, targetEntries);
  }
  let entry = targetEntries.get(input.property);
  if (!entry) {
    const originalValue = input.target[input.property];
    if (typeof originalValue !== "function") throw new TypeError(`Hook 目标不是函数：${String(input.property)}`);
    const original = originalValue as (...args: readonly unknown[]) => unknown;
    const layers = new Map<object, HookLayer>();
    const wrapper = function (this: unknown, ...args: readonly unknown[]): unknown {
      hookInvocationCount += 1;
      const constructorTarget = new.target;
      const ordered = [...layers.values()].sort((left, right) => left.order - right.order);
      const invoke = (index: number, currentArgs: readonly unknown[]): unknown => {
        const layer = ordered[index];
        if (!layer) {
          return constructorTarget
            ? Reflect.construct(original, [...currentArgs], constructorTarget)
            : original.apply(this, [...currentArgs]);
        }
        return runInProviderScope(
          layer.owner,
          () => layer.handle(this, currentArgs, (nextArgs = currentArgs) => invoke(index + 1, nextArgs)),
        );
      };
      return invoke(0, args);
    };
    try {
      Object.setPrototypeOf(wrapper, original);
      const originalPrototype = (original as { prototype?: unknown }).prototype;
      if (originalPrototype && typeof originalPrototype === "object") wrapper.prototype = originalPrototype;
    } catch {
      // 某些宿主函数不允许修改函数对象元数据；调用和构造语义仍由 apply/Reflect.construct 保证。
    }
    entry = { target: input.target, property: input.property, original, wrapper, layers };
    targetEntries.set(input.property, entry);
    hookEntrySet.add(entry);
    input.target[input.property] = wrapper;
  }
  entry.layers.set(input.key, {
    key: input.key,
    owner: window.__OpenCodexCurrentProviderScope || null,
    order: Number.isFinite(Number(input.order)) ? Number(input.order) : 0,
    handle: input.handle as HookLayer["handle"],
  });
  let active = true;
  return ownProviderDisposer(() => {
    if (!active) return;
    active = false;
    const currentEntries = hookEntries.get(input.target);
    const current = currentEntries?.get(input.property);
    if (!current) return;
    current.layers.delete(input.key);
    if (current.layers.size > 0) return;
    if (input.target[input.property] === current.wrapper) input.target[input.property] = current.original;
    currentEntries?.delete(input.property);
    hookEntrySet.delete(current);
  });
}

function createBrowserProviderRegistry() {
  const definitions = new Map(BROWSER_PROVIDER_DEFINITIONS.map((definition) => [definition.key, definition]));
  const stateByKey = new Map<string, BrowserProviderState>();
  const stateByPointId = new Map<string, BrowserProviderState>();
  const callbacksByPointId = new Map<string, Set<(count: number) => void>>();
  const hitTotalsByPointId = new Map<string, number>();
  let registrationOrder: BrowserProviderState[] = [];
  let pageRoot: Element | null = null;
  let runtime: ModificationRuntime | null = null;
  let activeRuntime: Awaited<ReturnType<ModificationRuntime["activate"]>> | null = null;
  let activationPromise: Promise<void> | null = null;
  let snapshotScheduled = false;
  let pageGeneration = 0;

  for (const definition of BROWSER_PROVIDER_DEFINITIONS) {
    const state: BrowserProviderState = {
      definition,
      installers: [],
      disposers: [],
      applications: new Set(),
      enabledCallbacks: new Set(),
      lifecycleCallbacks: new Set(),
      managedFactories: new Map(),
      scope: null,
      enabled: null,
      installed: false,
      installing: false,
      failure: null,
    };
    stateByKey.set(definition.key, state);
    for (const pointId of Object.values(definition.points)) {
      if (stateByPointId.has(pointId)) throw new Error(`浏览器修改点重复绑定 Provider：${pointId}`);
      stateByPointId.set(pointId, state);
    }
  }

  const knownBrowserPointIds = new Set(
    POINT_DEFINITIONS.filter((point) => point.id.startsWith("web.runtime.")).map((point) => point.id),
  );
  for (const definition of BROWSER_PROVIDER_DEFINITIONS) {
    for (const pointId of [...Object.values(definition.points), ...Object.values(definition.effects || {})]) {
      if (!knownBrowserPointIds.has(pointId)) throw new Error(`浏览器 Provider 引用了未知修改点：${pointId}`);
    }
  }
  if (stateByPointId.size !== knownBrowserPointIds.size) {
    const missing = [...knownBrowserPointIds].filter((pointId) => !stateByPointId.has(pointId));
    throw new Error(`浏览器修改点没有 Provider：${missing.join(", ")}`);
  }

  function transport(): BrowserKernelTransport | null {
    const value = (window as Window & {
      OpenCodexRuntimeCompatibility?: BrowserKernelTransport;
    }).OpenCodexRuntimeCompatibility;
    return value && typeof value.ingestSnapshot === "function" ? value : null;
  }

  function publishSnapshot(): void {
    if (!runtime || snapshotScheduled) return;
    snapshotScheduled = true;
    queueMicrotask(() => {
      snapshotScheduled = false;
      if (runtime) transport()?.ingestSnapshot(runtime.snapshot());
    });
  }

  function emit(pointId: string, count = 1): void {
    const increment = Math.max(1, Math.trunc(Number(count) || 1));
    hitTotalsByPointId.set(pointId, (hitTotalsByPointId.get(pointId) || 0) + increment);
    for (const callback of callbacksByPointId.get(pointId) || []) callback(increment);
    publishSnapshot();
  }

  function scopeFor(state: BrowserProviderState): BrowserProviderScope {
    if (state.scope) return state.scope;
    const pointByAlias = { ...state.definition.points, ...(state.definition.effects || {}) };
    const effects = Object.fromEntries(
      Object.entries(pointByAlias).map(([alias, pointId]) => [
        alias,
        Object.freeze<BrowserProviderEffect>({ emit: (count = 1) => emit(pointId, count) }),
      ]),
    );
    const scope: BrowserProviderScope = Object.freeze({
      clientId: transport()?.clientId || "",
      generation: pageGeneration,
      effects: Object.freeze(effects),
      own(dispose: () => void) {
        if (state.scope !== scope) {
          dispose();
          return () => {};
        }
        if (typeof dispose !== "function") throw new TypeError("Provider 资源必须提供清理函数");
        let active = true;
        const owned = () => {
          if (!active) return;
          active = false;
          const index = state.disposers.indexOf(owned);
          if (index >= 0) state.disposers.splice(index, 1);
          dispose();
        };
        state.disposers.push(owned);
        return owned;
      },
      active() {
        return state.scope === scope;
      },
      setEnabled(enabled: boolean, reason = "插件已关闭") {
        if (state.scope !== scope) return;
        state.enabled = enabled;
        // Kernel 先恢复或关闭 Contribution 状态，随后资源层再挂载并上报真实命中。
        for (const callback of state.enabledCallbacks) callback(enabled, reason);
        for (const callback of state.lifecycleCallbacks) callback(enabled);
        publishSnapshot();
      },
      close() {
        if (state.scope === scope) state.scope = null;
      },
    });
    state.scope = scope;
    return scope;
  }

  function releaseStateResources(state: BrowserProviderState): void {
    state.scope?.close();
    state.scope = null;
    state.installed = false;
    state.managedFactories.clear();
    let firstError: unknown = null;
    for (const dispose of state.disposers.splice(0).reverse()) {
      try {
        dispose();
      } catch (error) {
        firstError ||= error;
      }
    }
    if (firstError) throw firstError;
  }

  function installState(state: BrowserProviderState): void {
    if (state.installed) return;
    if (state.failure) throw state.failure;
    if (state.installing) throw new Error(`浏览器 Provider 形成安装环：${state.definition.key}`);
    state.installing = true;
    const scope = scopeFor(state);
    try {
      for (const installer of state.installers) {
        const previousScope = window.__OpenCodexCurrentProviderScope;
        window.__OpenCodexCurrentProviderScope = scope;
        try {
          const dispose = installer();
          if (typeof dispose === "function" && !state.disposers.includes(dispose)) {
            state.disposers.push(dispose);
          }
        } finally {
          window.__OpenCodexCurrentProviderScope = previousScope;
        }
      }
      state.installed = true;
    } catch (error) {
      state.failure = error;
      try {
        releaseStateResources(state);
      } catch {
        // 部分安装的清理错误不能覆盖最初的 Provider 安装失败。
      }
      throw error;
    } finally {
      state.installing = false;
    }
  }

  function ensureInstalled(target: BrowserProviderState): void {
    // Provider 的真实安装顺序保持与 HTML/聚合运行时中的脚本注册顺序一致。
    for (const state of registrationOrder) {
      installState(state);
      if (state === target) return;
    }
    throw new Error(`浏览器 Provider 尚未注册实现：${target.definition.key}`);
  }

  function createManagedProvider(adapter: AdapterRef<unknown>): TerminalAdapterProvider<unknown> {
    return Object.freeze({
      adapter,
      compile(contributions: readonly BoundContribution[]) {
        const managedContributions = new Map<symbol, ManagedBrowserContribution>();
        return {
          locate(reporter: AdapterExecutionReporter) {
            for (const contribution of contributions) {
              const state = stateByPointId.get(contribution.point.id);
              if (!state || state.installers.length === 0) {
                reporter.unsupported(contribution, "当前页面没有注册对应的浏览器 Provider 实现");
              } else reporter.resolved(contribution, { candidateCount: 1, fingerprint: state.definition.key });
            }
          },
          apply(contribution: BoundContribution, reporter: AdapterExecutionReporter) {
            const state = stateByPointId.get(contribution.point.id);
            if (!state) throw new Error(`修改点没有浏览器 Provider：${contribution.point.id}`);
            ensureInstalled(state);
            if (isMobileSidebarTouchScrollContribution(contribution)) {
              const managed = installMobileSidebarTouchScrollContribution(state, () => emit(contribution.point.id));
              managedContributions.set(contribution.key, managed);
            }
            if (isWindowControlsOverlayContribution(contribution)) {
              const factory = state.managedFactories.get(contribution.point.id);
              if (!factory) throw new Error("PWA 标题栏 Provider 没有注册托管 Contribution 工厂");
              // 工厂也在当前 Provider scope 中运行，DOM 监听、计时器等资源因此归属于同一页面代际。
              try {
                const managed = runInProviderScope(state.scope, () => factory({
                  onHit: () => emit(contribution.point.id),
                }));
                managedContributions.set(contribution.key, managed);
              } catch (error) {
                // 工厂可能已申请部分共享资源；apply 失败时立即释放，不能等待下一次页面切换兜底。
                releaseStateResources(state);
                throw error;
              }
            }
            state.applications.add(contribution.key);
            reporter.applied(contribution);
          },
          verify(contribution: BoundContribution, reporter: AdapterExecutionReporter) {
            const state = stateByPointId.get(contribution.point.id);
            if (!state?.installed || state.failure) throw state?.failure || new Error("浏览器 Provider 安装后验证失败");
            managedContributions.get(contribution.key)?.verify();
            reporter.verified(contribution);
          },
          activate(contribution: BoundContribution, reporter: AdapterExecutionReporter) {
            const state = stateByPointId.get(contribution.point.id);
            if (!state) throw new Error(`修改点没有浏览器 Provider：${contribution.point.id}`);
            let callbacks = callbacksByPointId.get(contribution.point.id);
            if (!callbacks) {
              callbacks = new Set();
              callbacksByPointId.set(contribution.point.id, callbacks);
            }
            const callback = (count: number) => reporter.hit(contribution, count);
            const enabledCallback = (enabled: boolean, reason: string) => {
              if (enabled) reporter.enabled(contribution);
              else reporter.disabled(contribution, reason);
            };
            state.enabledCallbacks.add(enabledCallback);
            if (state.enabled != null) enabledCallback(state.enabled, "插件已关闭");
            callbacks.add(callback);
            const existingHits = hitTotalsByPointId.get(contribution.point.id) || 0;
            if (state.enabled !== false && existingHits > 0) callback(existingHits);
            return () => {
              callbacks?.delete(callback);
              state.enabledCallbacks.delete(enabledCallback);
            };
          },
          rollback(contribution: BoundContribution) {
            const state = stateByPointId.get(contribution.point.id);
            if (!state) return;
            managedContributions.get(contribution.key)?.dispose();
            managedContributions.delete(contribution.key);
            state.applications.delete(contribution.key);
            // 同一 Provider 可被多个修改点和多个底层适配器共享，最后一个引用回滚时才释放真实资源。
            if (state.applications.size === 0) releaseStateResources(state);
          },
          dispose() {
            const affectedStates = new Set<BrowserProviderState>();
            for (const contribution of contributions) {
              const state = stateByPointId.get(contribution.point.id);
              if (!state) continue;
              managedContributions.get(contribution.key)?.dispose();
              managedContributions.delete(contribution.key);
              state.applications.delete(contribution.key);
              affectedStates.add(state);
            }
            let firstError: unknown = null;
            for (const state of affectedStates) {
              if (state.applications.size > 0) continue;
              try {
                releaseStateResources(state);
              } catch (error) {
                firstError ||= error;
              }
            }
            if (firstError) throw firstError;
          },
          diagnostics() {
            const ownedStates = new Set(
              contributions.map((contribution) => stateByPointId.get(contribution.point.id)).filter(Boolean),
            );
            return {
              contributionCount: contributions.length,
              installedProviderCount: [...ownedStates].filter((state) => state?.installed).length,
              registeredProviderCount: ownedStates.size,
              ...diagnostics(),
            };
          },
        };
      },
    });
  }

  function register(key: string, installer: BrowserProviderInstaller): void {
    const state = stateByKey.get(String(key || ""));
    if (!state) throw new TypeError(`未知浏览器 Provider key：${key}`);
    if (typeof installer !== "function") throw new TypeError(`浏览器 Provider ${key} 缺少安装函数`);
    if (state.installers.length === 0) registrationOrder.push(state);
    state.installers.push(installer);
  }

  function registerManaged(
    key: string,
    pointAlias: string,
    factory: BrowserManagedContributionFactory,
  ): void {
    const state = stateByKey.get(String(key || ""));
    if (!state) throw new TypeError(`未知浏览器 Provider key：${key}`);
    const pointId = state.definition.points[String(pointAlias || "")];
    if (!pointId) throw new TypeError(`浏览器 Provider ${key} 没有修改点别名：${pointAlias}`);
    if (typeof factory !== "function") throw new TypeError(`浏览器 Provider ${key} 缺少托管工厂`);
    if (window.__OpenCodexCurrentProviderScope !== state.scope || !state.installing) {
      throw new Error(`浏览器 Provider ${key} 只能在安装阶段注册托管工厂`);
    }
    if (state.managedFactories.has(pointId)) {
      throw new Error(`浏览器 Provider ${key} 重复注册托管工厂：${pointAlias}`);
    }
    state.managedFactories.set(pointId, factory);
  }

  function beginPage(root: Element | null): void {
    if (pageRoot === root) return;
    if (pageRoot) transport()?.beginGeneration?.();
    pageGeneration += 1;
    pageRoot = root;
    window.OpenCodexPluginSystem?.beginPage?.(root);
    void activeRuntime?.dispose().catch((error) => {
      console.warn("[opencodex-adapter] browser Kernel cleanup failed", error);
    });
    activeRuntime = null;
    runtime = null;
    activationPromise = null;
    registrationOrder = [];
    callbacksByPointId.clear();
    hitTotalsByPointId.clear();
    for (const state of stateByKey.values()) {
      state.applications.clear();
      try {
        releaseStateResources(state);
      } catch (error) {
        console.warn("[opencodex-adapter] browser Provider cleanup failed", state.definition.key, error);
      }
      state.installers.splice(0);
      state.managedFactories.clear();
      state.enabled = null;
      state.enabledCallbacks.clear();
      state.installing = false;
      state.failure = null;
    }
    register("runtime-host", () => {
      try {
        if (sessionStorage.getItem("opencodex_legacy_document_replace_hit") === "1") {
          sessionStorage.removeItem("opencodex_legacy_document_replace_hit");
          scopeFor(stateByKey.get("runtime-host")!).effects.primary?.emit();
        }
      } catch {
        // sessionStorage 在受限浏览器环境可能不可用，不影响其他 Provider 激活。
      }
    });
  }

  function activate(): Promise<void> {
    if (activationPromise) return activationPromise;
    const selectedPointIds = new Set(
      registrationOrder.flatMap((state) => Object.values(state.definition.points)),
    );
    runtime = createModificationRuntime();
    registerModificationCatalog(runtime, { pointIds: selectedPointIds });
    for (const adapter of Object.values(BASE_ADAPTERS)) {
      runtime.provide(createManagedProvider(adapter as AdapterRef<unknown>));
    }
    activationPromise = runtime.activate(runtime.compile()).then((active) => {
      activeRuntime = active;
      publishSnapshot();
    }, (error) => {
      publishSnapshot();
      throw error;
    });
    return activationPromise;
  }

  return Object.freeze({ beginPage, register, registerManaged, activate });
}

const browserProviders = createBrowserProviderRegistry();

function diagnostics(): AdapterHostDiagnostics {
  return Object.freeze({
    mutationObserverCount: observerEntries.size,
    mutationDispatchCount,
    eventListenerCount: eventEntries.size,
    eventDispatchCount,
    hookTargetCount: hookEntrySet.size,
    hookInvocationCount,
    protocolDecodeCount,
    protocolDispatchCount,
    protocolSubscriberCount: [...protocolSubscriptions.values()].reduce((total, entries) => total + entries.size, 0),
    protocolTransformCount,
    protocolTransformerCount: [...protocolTransformSubscriptions.values()].reduce(
      (total, entries) => total + entries.size,
      0,
    ),
  });
}

const adapterHost = Object.freeze({
  dom: Object.freeze({ observe: observeDom }),
  events: Object.freeze({ observe: observeEvent }),
  hooks: Object.freeze({ around: installAroundHook }),
  protocol: Object.freeze({
    channels: protocolChannels,
    observe: observeProtocol,
    process: processProtocol,
    publish: publishProtocol,
    transform: transformProtocol,
  }),
  lifecycle: Object.freeze({ createScope: createBrowserResourceScope }),
  plugins: Object.freeze({ register: registerOwnedPlugin }),
  scheduler: Object.freeze({ capture: captureProviderScheduler }),
  providers: browserProviders,
  diagnostics,
});

const publicCatalog = Object.freeze({
  groups: Object.freeze(POINT_GROUP_DEFINITIONS.map((group) => Object.freeze({
    id: group.id,
    name: group.name,
    description: group.description,
    order: group.order,
  }))),
  adapters: Object.freeze(ADAPTER_DEFINITIONS.map((adapter) => Object.freeze({
    id: adapter.id,
    name: adapter.name,
    description: adapter.description,
    kind: adapter.kind,
    dependencies: Object.freeze(adapter.dependencies.map((dependency) => dependency.id)),
  }))),
  points: Object.freeze(POINT_DEFINITIONS.map((point) => Object.freeze({
    id: point.id,
    groupId: point.group.id,
    directAdapterIds: Object.freeze(point.contributions.map((contribution) => contribution.adapter.id)),
  }))),
});

if (!window.__OpenCodexAdapterHost) {
  Object.defineProperty(window, "__OpenCodexAdapterHost", {
    configurable: false,
    enumerable: false,
    writable: false,
    value: adapterHost,
  });
}
if (!window.OpenCodexModificationCatalog) {
  Object.defineProperty(window, "OpenCodexModificationCatalog", {
    configurable: false,
    enumerable: false,
    writable: false,
    value: publicCatalog,
  });
}
// 登录壳 document.write 官方页面后会再次执行 bundle；必须复用同一宿主和其引用计数状态。
window.__OpenCodexAdapterHost.providers.beginPage(document.documentElement);
installPluginSdk(window.__OpenCodexAdapterHost);

declare global {
  interface Window {
    readonly __OpenCodexAdapterHost: typeof adapterHost;
    __OpenCodexCurrentProviderScope: BrowserProviderScope | undefined;
    OpenCodexRuntimeCompatibility?: BrowserKernelTransport;
    readonly OpenCodexModificationCatalog: typeof publicCatalog;
    readonly OpenCodexPluginSystem?: {
      beginPage?(root: Element | null): void;
      registerPlugin(plugin: Readonly<Record<string, unknown>>): unknown;
    };
  }
}
