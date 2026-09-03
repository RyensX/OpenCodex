import { BASE_ADAPTERS, MIGRATION_MATRIX, registerModificationCatalog } from "./catalog";
import {
  ActivationFailure,
  AdapterExecutionReporter,
  BoundContribution,
  ModificationRuntime,
  RuntimeSnapshot,
  TerminalAdapterProvider,
  createModificationRuntime,
} from "./kernel";
import { AdapterRef, ModificationPointDefinition } from "./sdk";
import { ModificationHost } from "./implementation";

type RuntimePointSnapshot = RuntimeSnapshot["points"][number];
type FailurePhase = "location" | "application" | "verification" | "activation";

export interface ProductionEffectSink {
  emit(count?: number): void;
}

export interface ProductionExecution<TValue> {
  readonly value: TValue;
  readonly effects: ProductionEffectSink;
  dispose(): Promise<void>;
}

export interface ProductionExecutionOptions<TValue> {
  readonly verify?: (value: TValue) => boolean;
  readonly rollback?: (value: TValue) => void;
  readonly hitOnSuccess?: boolean;
}

export interface ProductionBatchEntry<TValue = unknown> {
  readonly point: ModificationPointDefinition;
  readonly operation: () => TValue;
  readonly options?: ProductionExecutionOptions<TValue>;
}

export interface ProductionBatchExecution {
  readonly executions: ReadonlyMap<ModificationPointDefinition, ProductionExecution<unknown>>;
  readonly failures: readonly ActivationFailure[];
  diagnostics(): RuntimeSnapshot["providerDiagnostics"];
  dispose(): Promise<void>;
}

export interface ProductionCapabilityEntry {
  readonly point: ModificationPointDefinition;
  readonly operation: (this: unknown, ...args: readonly unknown[]) => unknown;
  readonly hitOnSuccess?: boolean;
  readonly hitWhen?: (args: readonly unknown[], result: unknown) => boolean;
}

export interface ProductionModificationCoordinator {
  execute<TValue>(
    point: ModificationPointDefinition,
    operation: () => TValue,
    options?: ProductionExecutionOptions<TValue>,
  ): ProductionExecution<TValue>;
  executeBatch(entries: readonly ProductionBatchEntry[]): ProductionBatchExecution;
  bindBatch(entries: readonly ProductionCapabilityEntry[]): ReadonlyMap<
    ModificationPointDefinition,
    (this: unknown, ...args: readonly unknown[]) => unknown
  >;
  bind<TArgs extends readonly unknown[], TResult>(
    point: ModificationPointDefinition,
    operation: (this: unknown, ...args: TArgs) => TResult,
    options?: {
      readonly hitOnSuccess?: boolean;
      readonly hitWhen?: (args: TArgs, result: Awaited<TResult>) => boolean;
    },
  ): (this: unknown, ...args: TArgs) => TResult;
  effect(point: ModificationPointDefinition): ProductionEffectSink;
  fail(point: ModificationPointDefinition, phase: FailurePhase, error: unknown): void;
  locationFailure(
    point: ModificationPointDefinition,
    status: "unsupported" | "ambiguous" | "stale" | "failed",
    error: unknown,
  ): void;
  useFallback(point: ModificationPointDefinition, reason?: string): void;
  setEnabled(point: ModificationPointDefinition, enabled: boolean, reason?: string): void;
  refresh(point: ModificationPointDefinition): void;
  refreshAll(): void;
  dispose(): Promise<void>;
}

interface PointExecutionState {
  readonly point: ModificationPointDefinition;
  readonly callbacks: Set<(count: number) => void>;
  readonly failureCallbacks: Set<(phase: FailurePhase, error: unknown) => void>;
  readonly locationCallbacks: Set<(
    status: "unsupported" | "ambiguous" | "stale" | "failed",
    error: unknown,
  ) => void>;
  readonly fallbackCallbacks: Set<(reason: string) => void>;
  readonly enabledCallbacks: Set<(enabled: boolean, reason: string) => void>;
  readonly verify: (value: unknown) => boolean;
  readonly rollback?: (value: unknown) => void;
  readonly operation: () => unknown;
  batch: BatchExecutionState | null;
  value: unknown;
  installed: boolean;
  enabled: boolean | null;
  hitCount: number;
  failure: unknown;
}

interface BatchExecutionState {
  readonly runtime: ModificationRuntime;
  readonly states: readonly PointExecutionState[];
  activeRuntime: ReturnType<ModificationRuntime["activateSync"]> | null;
  disposed: boolean;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return false;
  try {
    return typeof (value as { then?: unknown }).then === "function";
  } catch {
    // 诊断包装不能因为业务对象的 then getter 抛错而改变原返回语义。
    return false;
  }
}

/**
 * Gateway、静态资源和 Runner 都通过这个协调器进入同一 Kernel 状态机。
 * 同一批次的修改点共享一次 Adapter compile，调用点只传强类型修改点对象。
 */
export function createProductionModificationCoordinator(options: {
  readonly host: ModificationHost;
  readonly publish: (point: RuntimePointSnapshot) => void;
}): ProductionModificationCoordinator {
  const hostByPointId = new Map(MIGRATION_MATRIX.map((entry) => [entry.pointId, entry.host]));
  const states = new Map<ModificationPointDefinition, PointExecutionState>();
  const batches = new Set<BatchExecutionState>();

  function assertHost(point: ModificationPointDefinition): void {
    const host = hostByPointId.get(point.id);
    if (host !== options.host) {
      throw new TypeError(`修改点 ${point.id} 属于 ${host || "unknown"}，不能由 ${options.host} Provider 执行`);
    }
  }

  function publish(state: PointExecutionState): void {
    if (state.batch) options.publish(state.batch.runtime.snapshotPoint(state.point));
  }

  function emit(state: PointExecutionState, count = 1): void {
    const increment = Math.max(1, Math.trunc(Number(count) || 1));
    state.hitCount += increment;
    for (const callback of state.callbacks) callback(increment);
    publish(state);
  }

  function providerFor(
    adapter: AdapterRef<unknown>,
    batch: BatchExecutionState,
  ): TerminalAdapterProvider<unknown> {
    const stateByPoint = new Map(batch.states.map((state) => [state.point, state]));
    return Object.freeze({
      adapter,
      compile(contributions: readonly BoundContribution[]) {
        const contributionStates = new Set(
          contributions.map((contribution) => stateByPoint.get(contribution.point)).filter(Boolean),
        );
        return {
          locate(reporter: AdapterExecutionReporter) {
            for (const contribution of contributions) {
              const state = stateByPoint.get(contribution.point);
              if (!state) {
                reporter.unsupported(contribution, "当前宿主没有注册对应生产实现");
                continue;
              }
              reporter.resolved(contribution, {
                candidateCount: 1,
                fingerprint: `${options.host}:${state.point.id}`,
              });
            }
          },
          apply(contribution: BoundContribution, reporter: AdapterExecutionReporter) {
            const state = stateByPoint.get(contribution.point);
            if (!state) throw new Error(`修改点没有生产实现：${contribution.point.id}`);
            if (!state.installed && !state.failure) {
              try {
                state.value = state.operation();
                state.installed = true;
              } catch (error) {
                state.failure = error;
                throw error;
              }
            }
            if (state.failure) throw state.failure;
            reporter.applied(contribution);
          },
          verify(contribution: BoundContribution, reporter: AdapterExecutionReporter) {
            const state = stateByPoint.get(contribution.point);
            if (!state?.installed || state.failure || !state.verify(state.value)) {
              throw state?.failure || new Error(`修改点 ${contribution.point.id} 应用后验证失败`);
            }
            reporter.verified(contribution);
          },
          activate(contribution: BoundContribution, reporter: AdapterExecutionReporter) {
            const state = stateByPoint.get(contribution.point);
            if (!state) throw new Error(`修改点没有生产实现：${contribution.point.id}`);
            const callback = (count: number) => reporter.hit(contribution, count);
            const fail = (phase: FailurePhase, error: unknown) => reporter.failed(contribution, phase, error);
            const locationFailure = (
              status: "unsupported" | "ambiguous" | "stale" | "failed",
              error: unknown,
            ) => {
              const reason = error instanceof Error ? error.message : String(error || status);
              if (status === "unsupported") reporter.unsupported(contribution, reason);
              else if (status === "ambiguous") reporter.ambiguous(contribution, reason);
              else if (status === "stale") reporter.stale(contribution, reason);
              else reporter.failed(contribution, "location", error);
            };
            const fallback = (reason: string) => reporter.fallback(contribution, reason);
            const enabledCallback = (enabled: boolean, reason: string) => {
              if (enabled) reporter.enabled(contribution);
              else reporter.disabled(contribution, reason);
            };
            state.callbacks.add(callback);
            state.failureCallbacks.add(fail);
            state.locationCallbacks.add(locationFailure);
            state.fallbackCallbacks.add(fallback);
            state.enabledCallbacks.add(enabledCallback);
            if (state.enabled != null) enabledCallback(state.enabled, "修改点已关闭");
            if (state.enabled !== false && state.hitCount > 0) callback(state.hitCount);
            return () => {
              state.callbacks.delete(callback);
              state.failureCallbacks.delete(fail);
              state.locationCallbacks.delete(locationFailure);
              state.fallbackCallbacks.delete(fallback);
              state.enabledCallbacks.delete(enabledCallback);
            };
          },
          rollback(contribution: BoundContribution) {
            const state = stateByPoint.get(contribution.point);
            if (!state) return;
            if (!state.installed) return;
            try {
              state.rollback?.(state.value);
            } finally {
              // 回滚函数即使失败也已经消耗本次安装状态，不能在后续 dispose 中重复执行业务清理。
              state.installed = false;
            }
          },
          dispose() {
            let firstError: unknown = null;
            for (const state of [...contributionStates].reverse()) {
              if (!state?.installed) continue;
              try {
                state.rollback?.(state.value);
              } catch (error) {
                firstError ||= error;
              } finally {
                state.installed = false;
              }
            }
            if (firstError) throw firstError;
          },
          diagnostics() {
            return Object.freeze({
              contributionCount: contributions.length,
              installedPointCount: [...contributionStates].filter((state) => state?.installed).length,
              hitCount: [...contributionStates].reduce((total, state) => total + (state?.hitCount || 0), 0),
            });
          },
        };
      },
    });
  }

  function disposeBatch(batch: BatchExecutionState): Promise<void> {
    if (batch.disposed) return Promise.resolve();
    batch.disposed = true;
    batches.delete(batch);
    const completion = batch.activeRuntime?.dispose() || Promise.resolve();
    for (const state of batch.states) {
      states.delete(state.point);
      publish(state);
    }
    return completion;
  }

  function executeBatch(entries: readonly ProductionBatchEntry[]): ProductionBatchExecution {
    if (!Array.isArray(entries) || entries.length === 0) throw new TypeError("生产执行批次不能为空");
    const pointSet = new Set<ModificationPointDefinition>();
    const batchStates = entries.map<PointExecutionState>((entry) => {
      assertHost(entry.point);
      if (pointSet.has(entry.point) || states.has(entry.point)) {
        throw new Error(`修改点已经绑定生产实现：${entry.point.id}`);
      }
      pointSet.add(entry.point);
      const executionOptions = entry.options || {};
      return {
        point: entry.point,
        callbacks: new Set<(count: number) => void>(),
        failureCallbacks: new Set<(phase: FailurePhase, error: unknown) => void>(),
        locationCallbacks: new Set(),
        fallbackCallbacks: new Set(),
        enabledCallbacks: new Set<(enabled: boolean, reason: string) => void>(),
        verify: executionOptions.verify
          ? (value: unknown) => executionOptions.verify?.(value) === true
          : () => true,
        ...(executionOptions.rollback ? { rollback: executionOptions.rollback as (value: unknown) => void } : {}),
        operation: entry.operation,
        batch: null,
        value: undefined,
        installed: false,
        enabled: null,
        hitCount: 0,
        failure: null,
      } satisfies PointExecutionState;
    });
    const runtime = createModificationRuntime();
    const batch: BatchExecutionState = {
      runtime,
      states: Object.freeze(batchStates),
      activeRuntime: null,
      disposed: false,
    };
    batches.add(batch);
    for (const state of batchStates) {
      state.batch = batch;
      states.set(state.point, state);
    }
    try {
      registerModificationCatalog(runtime, { pointIds: new Set([...pointSet].map((point) => point.id)) });
      for (const adapter of Object.values(BASE_ADAPTERS)) {
        runtime.provide(providerFor(adapter as AdapterRef<unknown>, batch));
      }
      batch.activeRuntime = runtime.activateSync(runtime.compile());
    } catch (error) {
      batches.delete(batch);
      for (const state of batchStates) states.delete(state.point);
      throw error;
    }
    for (const state of batchStates) publish(state);

    const executions = new Map<ModificationPointDefinition, ProductionExecution<unknown>>();
    for (const [index, state] of batchStates.entries()) {
      const entry = entries[index];
      if (entry?.options?.hitOnSuccess) {
        if (isThenable(state.value)) {
          void Promise.resolve(state.value).then(() => emit(state), () => undefined);
        } else emit(state);
      }
      executions.set(state.point, Object.freeze({
        value: state.value,
        effects: Object.freeze({ emit: (count = 1) => emit(state, count) }),
        dispose: () => disposeBatch(batch),
      }));
    }
    return Object.freeze({
      executions,
      failures: batch.activeRuntime.failures,
      diagnostics: () => batch.runtime.snapshot().providerDiagnostics,
      dispose: () => disposeBatch(batch),
    });
  }

  function execute<TValue>(
    point: ModificationPointDefinition,
    operation: () => TValue,
    executionOptions: ProductionExecutionOptions<TValue> = {},
  ): ProductionExecution<TValue> {
    const batch = executeBatch([{
      point,
      operation: operation as () => unknown,
      options: executionOptions as ProductionExecutionOptions<unknown>,
    }]);
    const execution = batch.executions.get(point) as ProductionExecution<TValue> | undefined;
    const state = states.get(point);
    if (!execution || !state) throw new Error(`修改点 ${point.id} 没有生成生产执行结果`);
    if (state.failure || batch.failures.length > 0) {
      void batch.dispose().catch(() => undefined);
      throw state.failure || new Error(batch.failures[0]?.reason || `修改点 ${point.id} 执行失败`);
    }
    return execution;
  }

  function bind<TArgs extends readonly unknown[], TResult>(
    point: ModificationPointDefinition,
    operation: (this: unknown, ...args: TArgs) => TResult,
    bindOptions: {
      readonly hitOnSuccess?: boolean;
      readonly hitWhen?: (args: TArgs, result: Awaited<TResult>) => boolean;
    } = {},
  ): (this: unknown, ...args: TArgs) => TResult {
    const result = bindBatch([{
      point,
      operation: operation as (this: unknown, ...args: readonly unknown[]) => unknown,
      ...(bindOptions.hitOnSuccess == null ? {} : { hitOnSuccess: bindOptions.hitOnSuccess }),
      ...(bindOptions.hitWhen
        ? {
            hitWhen: bindOptions.hitWhen as (args: readonly unknown[], result: unknown) => boolean,
          }
        : {}),
    }]).get(point);
    if (!result) throw new Error(`修改点 ${point.id} 没有生成生产能力`);
    return result as (this: unknown, ...args: TArgs) => TResult;
  }

  function bindBatch(entries: readonly ProductionCapabilityEntry[]): ReadonlyMap<
    ModificationPointDefinition,
    (this: unknown, ...args: readonly unknown[]) => unknown
  > {
    if (!Array.isArray(entries) || entries.length === 0) throw new TypeError("生产能力批次不能为空");
    const wrappers = new Map<ModificationPointDefinition, (this: unknown, ...args: readonly unknown[]) => unknown>();
    const effectsByPoint = new Map<ModificationPointDefinition, ProductionEffectSink | null>();
    const pending: ProductionBatchEntry[] = [];
    for (const entry of entries) {
      assertHost(entry.point);
      let effects: ProductionEffectSink | null = states.has(entry.point) ? effect(entry.point) : null;
      effectsByPoint.set(entry.point, effects);
      const wrapper = function (this: unknown, ...args: readonly unknown[]): unknown {
        const result = entry.operation.call(this, ...args);
        if (entry.hitOnSuccess === false) return result;
        const activeEffects = effectsByPoint.get(entry.point);
        const reportHit = (resolved: unknown) => {
          try {
            if (entry.hitWhen && !entry.hitWhen(args, resolved)) return;
          } catch {
            // 命中判定只影响诊断，不能改变业务函数的返回值或异常。
            return;
          }
          activeEffects?.emit();
        };
        if (isThenable(result)) {
          void Promise.resolve(result).then(reportHit, () => undefined);
        } else reportHit(result);
        return result;
      };
      wrappers.set(entry.point, wrapper);
      if (!effects) pending.push({
        point: entry.point,
        operation: () => wrapper,
        options: { verify: (value) => typeof value === "function" },
      });
    }
    if (pending.length > 0) {
      const batch = executeBatch(pending);
      if (batch.failures.length > 0) {
        void batch.dispose().catch(() => undefined);
        throw new Error(batch.failures[0]?.reason || "生产能力批量激活失败");
      }
      for (const entry of pending) {
        effectsByPoint.set(entry.point, batch.executions.get(entry.point)?.effects || null);
      }
    }
    return wrappers;
  }

  function effect(point: ModificationPointDefinition): ProductionEffectSink {
    const state = states.get(point);
    if (!state || state.batch?.disposed) throw new Error(`修改点尚未由生产 Provider 激活：${point.id}`);
    return Object.freeze({ emit: (count = 1) => emit(state, count) });
  }

  function fail(point: ModificationPointDefinition, phase: FailurePhase, error: unknown): void {
    const state = states.get(point);
    if (!state) throw new Error(`修改点尚未由生产 Provider 激活：${point.id}`);
    for (const callback of state.failureCallbacks) callback(phase, error);
    publish(state);
  }

  function locationFailure(
    point: ModificationPointDefinition,
    status: "unsupported" | "ambiguous" | "stale" | "failed",
    error: unknown,
  ): void {
    const state = states.get(point);
    if (!state) throw new Error(`修改点尚未由生产 Provider 激活：${point.id}`);
    for (const callback of state.locationCallbacks) callback(status, error);
    publish(state);
  }

  function useFallback(point: ModificationPointDefinition, reason = "使用官方行为"): void {
    const state = states.get(point);
    if (!state) throw new Error(`修改点尚未由生产 Provider 激活：${point.id}`);
    for (const callback of state.fallbackCallbacks) callback(String(reason || "使用官方行为"));
    publish(state);
  }

  function setEnabled(point: ModificationPointDefinition, enabled: boolean, reason = "修改点已关闭"): void {
    const state = states.get(point);
    if (!state) throw new Error(`修改点尚未由生产 Provider 激活：${point.id}`);
    if (state.enabled !== enabled) state.hitCount = 0;
    state.enabled = enabled;
    for (const callback of state.enabledCallbacks) callback(enabled, reason);
    publish(state);
  }

  function refresh(point: ModificationPointDefinition): void {
    const state = states.get(point);
    if (!state) throw new Error(`修改点尚未由生产 Provider 激活：${point.id}`);
    publish(state);
  }

  function refreshAll(): void {
    // Registry 因运行时身份变化清空状态后，从仍存活的生产批次重放完整快照，不重复执行业务安装逻辑。
    for (const state of states.values()) publish(state);
  }

  async function dispose(): Promise<void> {
    const results = await Promise.allSettled([...batches].reverse().map(disposeBatch));
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) throw failure.reason;
  }

  return Object.freeze({
    execute,
    executeBatch,
    bindBatch,
    bind,
    effect,
    fail,
    locationFailure,
    useFallback,
    setEnabled,
    refresh,
    refreshAll,
    dispose,
  });
}
