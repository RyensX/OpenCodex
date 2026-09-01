const MODIFICATION_TARGET_BRAND: unique symbol = Symbol("opencodex.modification-target");

export type ModificationHost = "browser" | "gateway" | "static" | "runner";

/**
 * 修改点声明只引用语义目标；具体 Provider 由终端 AdapterRef 在当前宿主中决定。
 * target 不包含模块路径、DOM 选择器或文件路径，真实解析逻辑只能位于 internal Provider。
 */
export interface ModificationTargetRef<THost extends ModificationHost = ModificationHost> {
  readonly [MODIFICATION_TARGET_BRAND]: true;
  readonly id: string;
  readonly host: THost;
}

function stableId(value: string): string {
  const normalized = String(value || "").trim();
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(normalized)) {
    throw new TypeError(`修改目标 ID 必须是稳定的小写标识：${normalized || "<empty>"}`);
  }
  return normalized;
}

export function defineModificationTarget<THost extends ModificationHost>(
  id: string,
  host: THost,
): ModificationTargetRef<THost> {
  return Object.freeze({
    [MODIFICATION_TARGET_BRAND]: true as const,
    id: stableId(id),
    host,
  });
}

export function isModificationTargetRef(value: unknown): value is ModificationTargetRef {
  return !!value && typeof value === "object" && (value as ModificationTargetRef)[MODIFICATION_TARGET_BRAND] === true;
}
