const GROUP_BRAND: unique symbol = Symbol("opencodex.point-group");
const PLUGIN_BRAND: unique symbol = Symbol("opencodex.plugin");
const ADAPTER_BRAND: unique symbol = Symbol("opencodex.adapter");
const CONTRIBUTION_BRAND: unique symbol = Symbol("opencodex.contribution");
const POINT_BRAND: unique symbol = Symbol("opencodex.modification-point");
const SIGNAL_BRAND: unique symbol = Symbol("opencodex.signal");
const CAPABILITY_BRAND: unique symbol = Symbol("opencodex.capability");

const STABLE_ID_RE = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

export type AdapterKind = "terminal" | "composite";

export interface PointGroupRef {
  readonly [GROUP_BRAND]: true;
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly order: number;
}

export interface PluginRef {
  readonly [PLUGIN_BRAND]: true;
  readonly id: string;
  readonly name: string;
}

export interface AdapterUse<TDeclaration = unknown> {
  readonly [CONTRIBUTION_BRAND]: true;
  readonly adapter: AdapterRef<TDeclaration>;
  readonly declaration: Readonly<TDeclaration>;
}

export interface AdapterRef<TDeclaration = unknown> {
  readonly [ADAPTER_BRAND]: true;
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly kind: AdapterKind;
  readonly dependencies: readonly AdapterRef<unknown>[];
  use(declaration: TDeclaration): AdapterUse<TDeclaration>;
}

export interface ModificationPointDefinition {
  readonly [POINT_BRAND]: true;
  readonly id: string;
  readonly description: string;
  readonly owner: string;
  readonly plugin: PluginRef | null;
  readonly group: PointGroupRef;
  readonly contributions: readonly AdapterUse<unknown>[];
}

export interface SignalRef<TValue> {
  readonly [SIGNAL_BRAND]: true;
  readonly id: string;
  readonly __value?: TValue;
}

export interface CapabilityRef<TCapability> {
  readonly [CAPABILITY_BRAND]: true;
  readonly id: string;
  readonly __capability?: TCapability;
}

function stableId(value: string, label: string): string {
  const normalized = String(value || "").trim();
  if (!STABLE_ID_RE.test(normalized)) throw new TypeError(`${label} 必须是稳定的小写标识：${normalized || "<empty>"}`);
  return normalized;
}

function normalizedText(value: string, label: string): string {
  const normalized = String(value || "").trim();
  if (!normalized) throw new TypeError(`${label} 不能为空`);
  return normalized;
}

export function definePointGroup(definition: {
  id: string;
  name: string;
  description: string;
  order: number;
}): PointGroupRef {
  const order = Number(definition.order);
  if (!Number.isFinite(order)) throw new TypeError("分类组 order 必须是有限数字");
  return Object.freeze({
    [GROUP_BRAND]: true as const,
    id: stableId(definition.id, "分类组 ID"),
    name: normalizedText(definition.name, "分类组名称"),
    description: normalizedText(definition.description, "分类组说明"),
    order,
  });
}

export function definePlugin(definition: { id: string; name: string }): PluginRef {
  return Object.freeze({
    [PLUGIN_BRAND]: true as const,
    id: stableId(definition.id, "插件 ID"),
    name: normalizedText(definition.name, "插件名称"),
  });
}

export function defineAdapter<TDeclaration>(definition: {
  id: string;
  name: string;
  description: string;
  kind: AdapterKind;
  dependencies?: readonly AdapterRef<unknown>[];
}): AdapterRef<TDeclaration> {
  const dependencies = Object.freeze([...(definition.dependencies || [])]);
  if (dependencies.some((dependency) => !isAdapterRef(dependency))) {
    throw new TypeError(`适配器 ${definition.id} 的依赖必须使用强类型 AdapterRef`);
  }
  if (new Set(dependencies).size !== dependencies.length) {
    throw new TypeError(`适配器 ${definition.id} 不能重复声明同一个依赖对象`);
  }
  const adapter: AdapterRef<TDeclaration> = Object.freeze({
    [ADAPTER_BRAND]: true as const,
    id: stableId(definition.id, "适配器 ID"),
    name: normalizedText(definition.name, "适配器名称"),
    description: normalizedText(definition.description, "适配器说明"),
    kind: definition.kind,
    dependencies,
    use(declaration: TDeclaration): AdapterUse<TDeclaration> {
      if (declaration == null) throw new TypeError(`适配器 ${definition.id} 的声明不能为空`);
      const frozenDeclaration =
        typeof declaration === "object" ? Object.freeze({ ...(declaration as Record<string, unknown>) }) : declaration;
      return Object.freeze({
        [CONTRIBUTION_BRAND]: true as const,
        adapter,
        declaration: frozenDeclaration as Readonly<TDeclaration>,
      });
    },
  });
  return adapter;
}

export function defineModificationPoint(definition: {
  id: string;
  description: string;
  owner: string;
  plugin?: PluginRef | null;
  group: PointGroupRef;
  contributions: readonly AdapterUse<unknown>[];
}): ModificationPointDefinition {
  if (!isPointGroupRef(definition.group)) throw new TypeError(`修改点 ${definition.id} 必须引用已定义的分类组对象`);
  if (definition.plugin != null && !isPluginRef(definition.plugin)) {
    throw new TypeError(`修改点 ${definition.id} 必须引用由 definePlugin 创建的插件对象`);
  }
  if (!Array.isArray(definition.contributions) || definition.contributions.length === 0) {
    throw new TypeError(`修改点 ${definition.id} 至少需要一个适配器 Contribution`);
  }
  for (const contribution of definition.contributions) {
    if (!isAdapterUse(contribution)) throw new TypeError(`修改点 ${definition.id} 包含无效的适配器 Contribution`);
  }
  return Object.freeze({
    [POINT_BRAND]: true as const,
    id: stableId(definition.id, "修改点 ID"),
    description: normalizedText(definition.description, "修改点说明"),
    owner: normalizedText(definition.owner, "修改点 owner"),
    // 核心修改点显式归一化为 null，跨进程报告无需再通过 ID 或 owner 猜测来源。
    plugin: definition.plugin || null,
    group: definition.group,
    contributions: Object.freeze([...definition.contributions]),
  });
}

export function defineSignal<TValue>(id: string): SignalRef<TValue> {
  return Object.freeze({ [SIGNAL_BRAND]: true as const, id: stableId(id, "Signal ID") });
}

export function defineCapability<TCapability>(id: string): CapabilityRef<TCapability> {
  return Object.freeze({ [CAPABILITY_BRAND]: true as const, id: stableId(id, "Capability ID") });
}

export function isPointGroupRef(value: unknown): value is PointGroupRef {
  return !!value && typeof value === "object" && (value as PointGroupRef)[GROUP_BRAND] === true;
}

export function isPluginRef(value: unknown): value is PluginRef {
  return !!value && typeof value === "object" && (value as PluginRef)[PLUGIN_BRAND] === true;
}

export function isAdapterRef(value: unknown): value is AdapterRef<unknown> {
  return !!value && typeof value === "object" && (value as AdapterRef<unknown>)[ADAPTER_BRAND] === true;
}

export function isAdapterUse(value: unknown): value is AdapterUse<unknown> {
  return !!value && typeof value === "object" && (value as AdapterUse<unknown>)[CONTRIBUTION_BRAND] === true;
}

export function isModificationPoint(value: unknown): value is ModificationPointDefinition {
  return !!value && typeof value === "object" && (value as ModificationPointDefinition)[POINT_BRAND] === true;
}

export function isSignalRef<TValue = unknown>(value: unknown): value is SignalRef<TValue> {
  return !!value && typeof value === "object" && (value as SignalRef<TValue>)[SIGNAL_BRAND] === true;
}

export function isCapabilityRef<TCapability = unknown>(value: unknown): value is CapabilityRef<TCapability> {
  return !!value && typeof value === "object" && (value as CapabilityRef<TCapability>)[CAPABILITY_BRAND] === true;
}
