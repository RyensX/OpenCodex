import { HookTargetRef, RuntimeHookDeclaration } from "../modification/contracts";
import {
  BoundContribution,
  CompiledAdapterPlan,
  TerminalAdapterProvider,
} from "../modification/kernel";
import { AdapterRef } from "../modification/sdk";

export interface ResolvedFunctionTarget {
  readonly object: Record<PropertyKey, unknown>;
  readonly property: PropertyKey;
}

export interface NodeRuntimeHookProviderDiagnostics {
  readonly invocationCount: number;
  readonly wrapperCount: number;
}

interface HookLayer {
  readonly contribution: BoundContribution<RuntimeHookDeclaration>;
  readonly declaration: Readonly<RuntimeHookDeclaration>;
  onHit: () => void;
}

interface SharedHook {
  readonly target: ResolvedFunctionTarget;
  readonly original: (...args: readonly unknown[]) => unknown;
  readonly wrapper: (...args: readonly unknown[]) => unknown;
  readonly layers: Map<symbol, HookLayer>;
}

/**
 * Node 终端 Provider 只接收强类型 HookTargetRef，并由宿主 resolver 映射到真实模块对象。
 * 修改点看不到模块路径、属性名和原函数；同一真实目标始终只有一层 Wrapper。
 */
export function createNodeRuntimeHookProvider(options: {
  adapter: AdapterRef<RuntimeHookDeclaration>;
  resolve(target: HookTargetRef<readonly unknown[], unknown>): ResolvedFunctionTarget | null;
}): TerminalAdapterProvider<RuntimeHookDeclaration> & { diagnostics(): NodeRuntimeHookProviderDiagnostics } {
  const sharedHooks = new Map<Record<PropertyKey, unknown>, Map<PropertyKey, SharedHook>>();
  const sharedHookSet = new Set<SharedHook>();
  let invocationCount = 0;

  function hookFor(target: ResolvedFunctionTarget): SharedHook {
    let targetHooks = sharedHooks.get(target.object);
    if (!targetHooks) {
      targetHooks = new Map();
      sharedHooks.set(target.object, targetHooks);
    }
    const existing = targetHooks.get(target.property);
    if (existing) return existing;
    const originalValue = target.object[target.property];
    if (typeof originalValue !== "function") throw new TypeError(`Hook 目标不是函数：${String(target.property)}`);
    const original = originalValue as (...args: readonly unknown[]) => unknown;
    const layers = new Map<symbol, HookLayer>();
    const hook: SharedHook = {
      target,
      original,
      layers,
      wrapper: function (this: unknown, ...args: readonly unknown[]): unknown {
        invocationCount += 1;
        const constructorTarget = new.target;
        const ordered = [...layers.values()].sort((left, right) => {
          return left.declaration.order - right.declaration.order;
        });
        const invoke = (index: number, currentArgs: readonly unknown[]): unknown => {
          const layer = ordered[index];
          if (!layer) {
            return constructorTarget
              ? Reflect.construct(original, [...currentArgs], constructorTarget)
              : original.apply(this, [...currentArgs]);
          }
          layer.onHit();
          const context = { thisValue: this, args: currentArgs };
          if (layer.declaration.operation === "before") {
            const nextArgs = layer.declaration.handle(context);
            return invoke(index + 1, nextArgs || currentArgs);
          }
          if (layer.declaration.operation === "after") {
            const result = invoke(index + 1, currentArgs);
            return layer.declaration.handle({ ...context, result });
          }
          return layer.declaration.handle({
            ...context,
            proceed: (nextArgs = currentArgs) => invoke(index + 1, nextArgs),
          });
        };
        return invoke(0, args);
      },
    };
    try {
      Object.setPrototypeOf(hook.wrapper, original);
      const originalPrototype = (original as { prototype?: unknown }).prototype;
      if (originalPrototype && typeof originalPrototype === "object") {
        (hook.wrapper as { prototype?: unknown }).prototype = originalPrototype;
      }
    } catch {
      // 某些宿主函数禁止修改函数对象元数据；调用语义仍由 apply/Reflect.construct 保证。
    }
    target.object[target.property] = hook.wrapper;
    if (target.object[target.property] !== hook.wrapper) throw new TypeError(`Hook 目标不可写：${String(target.property)}`);
    targetHooks.set(target.property, hook);
    sharedHookSet.add(hook);
    return hook;
  }

  function releaseLayer(hook: SharedHook, contribution: BoundContribution<RuntimeHookDeclaration>): void {
    hook.layers.delete(contribution.key);
    if (hook.layers.size > 0) return;
    if (hook.target.object[hook.target.property] === hook.wrapper) {
      hook.target.object[hook.target.property] = hook.original;
    }
    sharedHooks.get(hook.target.object)?.delete(hook.target.property);
    sharedHookSet.delete(hook);
  }

  const provider = {
    adapter: options.adapter,
    compile(contributions: readonly BoundContribution<RuntimeHookDeclaration>[]): CompiledAdapterPlan {
      const located = new Map<symbol, ResolvedFunctionTarget>();
      const installed = new Map<symbol, SharedHook>();
      return {
        locate(reporter) {
          for (const contribution of contributions) {
            const target = options.resolve(contribution.declaration.target);
            if (!target) {
              reporter.unsupported(contribution, "当前 Node 宿主没有注册该 HookTargetRef");
              continue;
            }
            located.set(contribution.key, target);
            reporter.resolved(contribution);
          }
        },
        apply(contribution, reporter) {
          const typedContribution = contribution as BoundContribution<RuntimeHookDeclaration>;
          const target = located.get(contribution.key);
          if (!target) throw new Error("Hook Contribution 尚未定位");
          const hook = hookFor(target);
          const declaration = typedContribution.declaration;
          hook.layers.set(contribution.key, { contribution: typedContribution, declaration, onHit: () => {} });
          installed.set(contribution.key, hook);
          reporter.applied(contribution);
        },
        verify(contribution, reporter) {
          const hook = installed.get(contribution.key);
          if (!hook || hook.target.object[hook.target.property] !== hook.wrapper) {
            throw new Error("Hook Wrapper 安装后验证失败");
          }
          reporter.verified(contribution);
        },
        activate(contribution, reporter) {
          const hook = installed.get(contribution.key);
          const layer = hook?.layers.get(contribution.key);
          if (!hook || !layer) throw new Error("Hook Contribution 未安装");
          // 命中必须发生在 Wrapper 真正执行该层时，不能在 activate 阶段提前上报。
          layer.onHit = () => reporter.hit(contribution);
        },
        rollback(contribution) {
          const typedContribution = contribution as BoundContribution<RuntimeHookDeclaration>;
          const hook = installed.get(contribution.key);
          if (!hook) return;
          installed.delete(contribution.key);
          releaseLayer(hook, typedContribution);
        },
        dispose() {
          for (const contribution of [...contributions].reverse()) {
            const hook = installed.get(contribution.key);
            if (!hook) continue;
            installed.delete(contribution.key);
            releaseLayer(hook, contribution);
          }
        },
        diagnostics() {
          return { invocationCount, wrapperCount: sharedHookSet.size };
        },
      };
    },
    diagnostics(): NodeRuntimeHookProviderDiagnostics {
      return Object.freeze({ invocationCount, wrapperCount: sharedHookSet.size });
    },
  };
  return Object.freeze(provider);
}
