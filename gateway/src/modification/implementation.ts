const PROVIDER_BINDING_BRAND: unique symbol = Symbol("opencodex.provider-binding");
const IMPLEMENTATION_BRAND: unique symbol = Symbol("opencodex.point-implementation");

export type ModificationHost = "browser" | "gateway" | "static" | "runner";

export interface ProviderBindingRef {
  readonly [PROVIDER_BINDING_BRAND]: true;
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly host: ModificationHost;
}

export interface ModificationImplementationRef {
  readonly [IMPLEMENTATION_BRAND]: true;
  readonly id: string;
  readonly provider: ProviderBindingRef;
}

function stableId(value: string, label: string): string {
  const normalized = String(value || "").trim();
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(normalized)) {
    throw new TypeError(`${label} 必须是稳定的小写标识：${normalized || "<empty>"}`);
  }
  return normalized;
}

export function defineProviderBinding(definition: {
  id: string;
  name: string;
  description: string;
  host: ModificationHost;
}): ProviderBindingRef {
  return Object.freeze({
    [PROVIDER_BINDING_BRAND]: true as const,
    id: stableId(definition.id, "Provider Binding ID"),
    name: String(definition.name || "").trim(),
    description: String(definition.description || "").trim(),
    host: definition.host,
  });
}

export function defineModificationImplementation(
  id: string,
  provider: ProviderBindingRef,
): ModificationImplementationRef {
  if (!isProviderBindingRef(provider)) throw new TypeError("修改实现必须引用已定义的 Provider Binding 对象");
  return Object.freeze({
    [IMPLEMENTATION_BRAND]: true as const,
    id: stableId(id, "修改实现 ID"),
    provider,
  });
}

export function isProviderBindingRef(value: unknown): value is ProviderBindingRef {
  return !!value && typeof value === "object" && (value as ProviderBindingRef)[PROVIDER_BINDING_BRAND] === true;
}

export function isModificationImplementationRef(value: unknown): value is ModificationImplementationRef {
  return !!value && typeof value === "object" && (value as ModificationImplementationRef)[IMPLEMENTATION_BRAND] === true;
}
