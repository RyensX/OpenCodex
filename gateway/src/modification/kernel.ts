import {
  AdapterRef,
  AdapterUse,
  ModificationPointDefinition,
  PointGroupRef,
  isAdapterRef,
  isAdapterUse,
  isModificationPoint,
  isPointGroupRef,
} from "./sdk";

export type PhaseName = "location" | "application" | "verification" | "exercise";
export type PhaseStatus =
  | "unresolved"
  | "resolving"
  | "resolved"
  | "unsupported"
  | "ambiguous"
  | "failed"
  | "stale"
  | "pending"
  | "applying"
  | "applied"
  | "rolled-back"
  | "verified"
  | "not-required"
  | "not-exercised"
  | "active"
  | "disabled";

export interface BoundContribution<TDeclaration = unknown> {
  readonly key: symbol;
  readonly point: ModificationPointDefinition;
  readonly directAdapter: AdapterRef<unknown>;
  readonly adapter: AdapterRef<TDeclaration>;
  readonly declaration: Readonly<TDeclaration>;
  readonly chain: readonly AdapterRef<unknown>[];
}

export interface AdapterExecutionReporter {
  resolving(contribution: BoundContribution): void;
  resolved(contribution: BoundContribution, detail?: { candidateCount?: number; fingerprint?: string }): void;
  unsupported(contribution: BoundContribution, reason: string): void;
  ambiguous(contribution: BoundContribution, reason: string): void;
  applying(contribution: BoundContribution): void;
  applied(contribution: BoundContribution): void;
  verified(contribution: BoundContribution): void;
  verificationNotRequired(contribution: BoundContribution): void;
  rolledBack(contribution: BoundContribution, reason?: string): void;
  hit(contribution: BoundContribution, count?: number): void;
  failed(contribution: BoundContribution, phase: Exclude<PhaseName, "exercise">, error: unknown): void;
}

/**
 * Provider 在 compile 时拿到完整批次，因此可以共享扫描、解析器和 Wrapper；
 * 后续阶段仍以单个 Contribution 为边界，Kernel 才能保证修改点级原子回滚。
 */
export interface CompiledAdapterPlan {
  locate?(reporter: AdapterExecutionReporter): void | Promise<void>;
  apply?(contribution: BoundContribution, reporter: AdapterExecutionReporter): void | Promise<void>;
  verify?(contribution: BoundContribution, reporter: AdapterExecutionReporter): void | Promise<void>;
  activate?(
    contribution: BoundContribution,
    reporter: AdapterExecutionReporter,
  ): void | (() => void) | Promise<void | (() => void)>;
  rollback?(contribution: BoundContribution): void | Promise<void>;
  dispose?(): void | Promise<void>;
  diagnostics?(): Readonly<Record<string, number>>;
}

export interface TerminalAdapterProvider<TDeclaration = unknown> {
  readonly adapter: AdapterRef<TDeclaration>;
  compile(contributions: readonly BoundContribution<TDeclaration>[]): CompiledAdapterPlan;
}

export interface CompositeAdapterExpander<TDeclaration = unknown> {
  readonly adapter: AdapterRef<TDeclaration>;
  expand(declaration: Readonly<TDeclaration>): readonly AdapterUse<unknown>[];
}

interface ContributionState {
  location: PhaseStatus;
  application: PhaseStatus;
  verification: PhaseStatus;
  exercise: PhaseStatus;
  hitCount: number;
  reason: string;
}

interface CompiledRuntimePlan {
  readonly revision: number;
  readonly plans: readonly CompiledAdapterPlan[];
  readonly contributions: readonly BoundContribution[];
  readonly points: readonly ModificationPointDefinition[];
  readonly planByAdapter: ReadonlyMap<AdapterRef<unknown>, CompiledAdapterPlan>;
}

export interface ActivationFailure {
  readonly pointId: string;
  readonly phase: "location" | "application" | "verification" | "activation";
  readonly reason: string;
}

export interface ActiveModificationRuntime {
  readonly failures: readonly ActivationFailure[];
  dispose(): Promise<void>;
}

export interface ModificationRuntime {
  registerGroup(group: PointGroupRef): PointGroupRef;
  registerAdapter(adapter: AdapterRef<unknown>): AdapterRef<unknown>;
  provide<TDeclaration>(provider: TerminalAdapterProvider<TDeclaration>): void;
  expand<TDeclaration>(expander: CompositeAdapterExpander<TDeclaration>): void;
  registerPoint(point: ModificationPointDefinition): ModificationPointDefinition;
  compile(): CompiledRuntimePlan;
  activate(plan?: CompiledRuntimePlan): Promise<ActiveModificationRuntime>;
  snapshot(): RuntimeSnapshot;
}

export interface RuntimeSnapshot {
  readonly revision: number;
  readonly groups: readonly {
    id: string;
    name: string;
    description: string;
    order: number;
    pointIds: readonly string[];
  }[];
  readonly adapterTypes: readonly {
    id: string;
    name: string;
    description: string;
    kind: "terminal" | "composite";
    dependencies: readonly string[];
  }[];
  readonly points: readonly {
    id: string;
    groupId: string;
    status: "pending" | "unavailable" | "ready" | "active";
    directAdapterIds: readonly string[];
    adapterChainIds: readonly string[];
    contributions: readonly Readonly<ContributionState>[];
  }[];
}

function failureReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "适配器执行失败");
}

export function createModificationRuntime(): ModificationRuntime {
  const groups = new Map<PointGroupRef, PointGroupRef>();
  const groupIds = new Map<string, PointGroupRef>();
  const adapters = new Map<AdapterRef<unknown>, AdapterRef<unknown>>();
  const adapterIds = new Map<string, AdapterRef<unknown>>();
  const providers = new Map<AdapterRef<unknown>, TerminalAdapterProvider<unknown>>();
  const expanders = new Map<AdapterRef<unknown>, CompositeAdapterExpander<unknown>>();
  const points = new Map<ModificationPointDefinition, ModificationPointDefinition>();
  const pointIds = new Map<string, ModificationPointDefinition>();
  const states = new Map<symbol, ContributionState>();
  let compiled: CompiledRuntimePlan | null = null;
  let revision = 0;

  function markChanged(): void {
    revision += 1;
    compiled = null;
  }

  function registerGroup(group: PointGroupRef): PointGroupRef {
    if (!isPointGroupRef(group)) throw new TypeError("只能注册由 definePointGroup 创建的分类组对象");
    const sameId = groupIds.get(group.id);
    if (sameId && sameId !== group) throw new Error(`分类组 ID 重复：${group.id}`);
    if (groups.has(group)) return group;
    groups.set(group, group);
    groupIds.set(group.id, group);
    markChanged();
    return group;
  }

  function registerAdapter(adapter: AdapterRef<unknown>): AdapterRef<unknown> {
    if (!isAdapterRef(adapter)) throw new TypeError("只能注册由 defineAdapter 创建的适配器对象");
    const sameId = adapterIds.get(adapter.id);
    if (sameId && sameId !== adapter) throw new Error(`适配器 ID 重复：${adapter.id}`);
    if (adapters.has(adapter)) return adapter;
    adapters.set(adapter, adapter);
    adapterIds.set(adapter.id, adapter);
    markChanged();
    return adapter;
  }

  function provide<TDeclaration>(provider: TerminalAdapterProvider<TDeclaration>): void {
    if (!provider || !isAdapterRef(provider.adapter)) throw new TypeError("终端 Provider 必须引用强类型适配器对象");
    if (provider.adapter.kind !== "terminal") throw new TypeError(`适配器 ${provider.adapter.id} 不是终端适配器`);
    registerAdapter(provider.adapter);
    if (providers.has(provider.adapter)) throw new Error(`终端 Provider 重复：${provider.adapter.id}`);
    providers.set(provider.adapter, provider as TerminalAdapterProvider<unknown>);
    markChanged();
  }

  function expand<TDeclaration>(expander: CompositeAdapterExpander<TDeclaration>): void {
    if (!expander || !isAdapterRef(expander.adapter)) throw new TypeError("高级适配器必须引用强类型适配器对象");
    if (expander.adapter.kind !== "composite") throw new TypeError(`适配器 ${expander.adapter.id} 不是高级适配器`);
    registerAdapter(expander.adapter);
    if (expanders.has(expander.adapter)) throw new Error(`高级适配器 Expander 重复：${expander.adapter.id}`);
    expanders.set(expander.adapter, expander as CompositeAdapterExpander<unknown>);
    markChanged();
  }

  function registerPoint(point: ModificationPointDefinition): ModificationPointDefinition {
    if (!isModificationPoint(point)) throw new TypeError("只能注册由 defineModificationPoint 创建的修改点对象");
    if (!groups.has(point.group)) throw new Error(`修改点 ${point.id} 引用了未注册分类组：${point.group.id}`);
    const sameId = pointIds.get(point.id);
    if (sameId && sameId !== point) throw new Error(`修改点 ID 重复：${point.id}`);
    for (const contribution of point.contributions) {
      if (!adapters.has(contribution.adapter)) {
        throw new Error(`修改点 ${point.id} 引用了未注册适配器：${contribution.adapter.id}`);
      }
    }
    if (points.has(point)) return point;
    points.set(point, point);
    pointIds.set(point.id, point);
    markChanged();
    return point;
  }

  function validateAdapterGraph(adapter: AdapterRef<unknown>, visiting = new Set<AdapterRef<unknown>>()): void {
    if (visiting.has(adapter)) throw new Error(`适配器依赖形成环：${[...visiting, adapter].map((item) => item.id).join(" -> ")}`);
    if (!adapters.has(adapter)) throw new Error(`适配器依赖未注册：${adapter.id}`);
    const next = new Set(visiting);
    next.add(adapter);
    for (const dependency of adapter.dependencies) validateAdapterGraph(dependency, next);
  }

  function keyFor(use: AdapterUse<unknown>, point: ModificationPointDefinition, index: number): symbol {
    // 一个高级 Contribution 可以展开为多个底层声明，叶子状态必须各自独立。
    void use;
    return Symbol(`${point.id}:${index}`);
  }

  function expandUse(
    point: ModificationPointDefinition,
    directAdapter: AdapterRef<unknown>,
    directUse: AdapterUse<unknown>,
    use: AdapterUse<unknown>,
    chain: readonly AdapterRef<unknown>[],
    visiting: ReadonlySet<AdapterRef<unknown>>,
    output: BoundContribution[],
  ): void {
    if (visiting.has(use.adapter)) {
      throw new Error(`适配器依赖形成环：${[...chain, use.adapter].map((item) => item.id).join(" -> ")}`);
    }
    if (!adapters.has(use.adapter)) throw new Error(`适配器未注册：${use.adapter.id}`);
    const nextChain = [...chain, use.adapter];
    if (use.adapter.kind === "terminal") {
      const key = keyFor(directUse, point, output.length);
      const bound: BoundContribution = Object.freeze({
        key,
        point,
        directAdapter,
        adapter: use.adapter,
        declaration: use.declaration,
        chain: Object.freeze(nextChain),
      });
      output.push(bound);
      states.set(key, {
        location: "unresolved",
        application: "pending",
        verification: "pending",
        exercise: "not-exercised",
        hitCount: 0,
        reason: "",
      });
      return;
    }
    const expander = expanders.get(use.adapter);
    if (!expander) throw new Error(`高级适配器缺少 Expander：${use.adapter.id}`);
    const expanded = expander.expand(use.declaration);
    if (!Array.isArray(expanded) || expanded.length === 0) {
      throw new Error(`高级适配器没有产生底层声明：${use.adapter.id}`);
    }
    const allowedDependencies = new Set(use.adapter.dependencies);
    for (const child of expanded) {
      if (!isAdapterUse(child)) throw new TypeError(`高级适配器 ${use.adapter.id} 产生了无效 Contribution`);
      if (!allowedDependencies.has(child.adapter)) {
        throw new Error(`高级适配器 ${use.adapter.id} 使用了未声明依赖：${child.adapter.id}`);
      }
    }
    const nextVisiting = new Set(visiting);
    nextVisiting.add(use.adapter);
    for (const child of expanded) {
      expandUse(point, directAdapter, directUse, child, nextChain, nextVisiting, output);
    }
  }

  function compile(): CompiledRuntimePlan {
    if (compiled) return compiled;
    for (const adapter of adapters.values()) validateAdapterGraph(adapter);
    const contributions: BoundContribution[] = [];
    states.clear();
    for (const point of points.values()) {
      for (const contribution of point.contributions) {
        expandUse(point, contribution.adapter, contribution, contribution, [], new Set(), contributions);
      }
    }
    const byAdapter = new Map<AdapterRef<unknown>, BoundContribution[]>();
    for (const contribution of contributions) {
      const entries = byAdapter.get(contribution.adapter) || [];
      entries.push(contribution);
      byAdapter.set(contribution.adapter, entries);
    }
    const planByAdapter = new Map<AdapterRef<unknown>, CompiledAdapterPlan>();
    for (const [adapter, entries] of byAdapter) {
      const provider = providers.get(adapter);
      if (!provider) throw new Error(`终端适配器缺少 Provider：${adapter.id}`);
      const providerPlan = provider.compile(Object.freeze(entries));
      if (!providerPlan || typeof providerPlan !== "object") throw new TypeError(`Provider ${adapter.id} 没有返回执行计划`);
      planByAdapter.set(adapter, providerPlan);
    }
    compiled = Object.freeze({
      revision,
      plans: Object.freeze([...planByAdapter.values()]),
      contributions: Object.freeze(contributions),
      points: Object.freeze([...points.values()]),
      planByAdapter,
    });
    return compiled;
  }

  function stateFor(contribution: BoundContribution): ContributionState {
    const state = states.get(contribution.key);
    if (!state) throw new Error(`Contribution 状态不存在：${contribution.point.id}`);
    return state;
  }

  const reporter = Object.freeze<AdapterExecutionReporter>({
    resolving(contribution) {
      stateFor(contribution).location = "resolving";
    },
    resolved(contribution) {
      const state = stateFor(contribution);
      state.location = "resolved";
      state.reason = "";
    },
    unsupported(contribution, reason) {
      const state = stateFor(contribution);
      state.location = "unsupported";
      state.reason = String(reason || "当前运行时不支持该目标");
    },
    ambiguous(contribution, reason) {
      const state = stateFor(contribution);
      state.location = "ambiguous";
      state.reason = String(reason || "定位结果不唯一");
    },
    applying(contribution) {
      stateFor(contribution).application = "applying";
    },
    applied(contribution) {
      stateFor(contribution).application = "applied";
    },
    verified(contribution) {
      stateFor(contribution).verification = "verified";
    },
    verificationNotRequired(contribution) {
      stateFor(contribution).verification = "not-required";
    },
    rolledBack(contribution, reason = "") {
      const state = stateFor(contribution);
      state.application = "rolled-back";
      if (reason) state.reason = String(reason);
    },
    hit(contribution, count = 1) {
      const state = stateFor(contribution);
      state.exercise = "active";
      state.hitCount += Math.max(1, Math.trunc(Number(count) || 1));
    },
    failed(contribution, phase, error) {
      const state = stateFor(contribution);
      state[phase] = "failed";
      state.reason = failureReason(error);
    },
  });

  function recordFailure(
    failures: ActivationFailure[],
    point: ModificationPointDefinition,
    phase: ActivationFailure["phase"],
    error: unknown,
  ): void {
    failures.push(Object.freeze({ pointId: point.id, phase, reason: failureReason(error) }));
  }

  async function activate(plan = compiled || compile()): Promise<ActiveModificationRuntime> {
    if (plan.revision !== revision) throw new Error("执行计划已因新注册内容失效，请重新 compile");
    const failures: ActivationFailure[] = [];
    const activeDisposers: (() => void)[] = [];
    const contributionsByPoint = new Map<ModificationPointDefinition, BoundContribution[]>();
    for (const contribution of plan.contributions) {
      const entries = contributionsByPoint.get(contribution.point) || [];
      entries.push(contribution);
      contributionsByPoint.set(contribution.point, entries);
    }

    for (const contribution of plan.contributions) reporter.resolving(contribution);
    for (const [adapter, adapterPlan] of plan.planByAdapter) {
      const entries = plan.contributions.filter((item) => item.adapter === adapter);
      try {
        if (adapterPlan.locate) await adapterPlan.locate(reporter);
        else for (const contribution of entries) reporter.resolved(contribution);
      } catch (error) {
        for (const contribution of entries) {
          if (stateFor(contribution).location === "resolving") reporter.failed(contribution, "location", error);
        }
      }
      // Provider 必须明确报告每个候选；漏报不能被误判为已经定位。
      for (const contribution of entries) {
        if (stateFor(contribution).location === "resolving") {
          reporter.failed(contribution, "location", new Error(`Provider ${adapter.id} 未报告定位结果`));
        }
      }
    }

    for (const point of plan.points) {
      const pointContributions = contributionsByPoint.get(point) || [];
      const unresolved = pointContributions.find((item) => stateFor(item).location !== "resolved");
      if (unresolved) {
        recordFailure(failures, point, "location", stateFor(unresolved).reason || "修改点定位失败");
        continue;
      }

      const attempted: BoundContribution[] = [];
      const pointDisposers: (() => void)[] = [];
      let failedPhase: ActivationFailure["phase"] | null = null;
      let failedError: unknown = null;
      let failedContribution: BoundContribution | null = null;
      try {
        for (const contribution of pointContributions) {
          failedContribution = contribution;
          const adapterPlan = plan.planByAdapter.get(contribution.adapter);
          if (!adapterPlan) throw new Error(`Contribution 缺少执行计划：${contribution.adapter.id}`);
          reporter.applying(contribution);
          attempted.push(contribution);
          if (adapterPlan.apply) await adapterPlan.apply(contribution, reporter);
          else reporter.applied(contribution);
          if (stateFor(contribution).application !== "applied") {
            throw new Error(`Provider ${contribution.adapter.id} 未报告应用完成`);
          }
        }
        failedContribution = null;
      } catch (error) {
        failedPhase = "application";
        failedError = error;
      }

      if (!failedPhase) {
        try {
          for (const contribution of pointContributions) {
            failedContribution = contribution;
            const adapterPlan = plan.planByAdapter.get(contribution.adapter);
            if (adapterPlan?.verify) await adapterPlan.verify(contribution, reporter);
            else reporter.verificationNotRequired(contribution);
            if (!["verified", "not-required"].includes(stateFor(contribution).verification)) {
              throw new Error(`Provider ${contribution.adapter.id} 未报告验证结果`);
            }
          }
          failedContribution = null;
        } catch (error) {
          failedPhase = "verification";
          failedError = error;
        }
      }

      if (!failedPhase) {
        try {
          for (const contribution of pointContributions) {
            failedContribution = contribution;
            const dispose = await plan.planByAdapter.get(contribution.adapter)?.activate?.(contribution, reporter);
            if (typeof dispose === "function") pointDisposers.push(dispose);
          }
          failedContribution = null;
        } catch (error) {
          failedPhase = "activation";
          failedError = error;
        }
      }

      if (!failedPhase) {
        activeDisposers.push(...pointDisposers);
        continue;
      }

      for (const dispose of pointDisposers.reverse()) {
        try {
          dispose();
        } catch {
          // 激活清理与应用回滚都采用尽力语义，首个业务失败仍保留在报告里。
        }
      }
      for (const contribution of attempted.reverse()) {
        try {
          await plan.planByAdapter.get(contribution.adapter)?.rollback?.(contribution);
        } finally {
          reporter.rolledBack(contribution, failureReason(failedError));
        }
      }
      if (failedContribution) {
        reporter.failed(
          failedContribution,
          failedPhase === "verification" ? "verification" : "application",
          failedError,
        );
      }
      recordFailure(failures, point, failedPhase, failedError);
    }

    let active = true;
    return Object.freeze({
      failures: Object.freeze(failures),
      async dispose() {
        if (!active) return;
        active = false;
        for (const dispose of activeDisposers.reverse()) dispose();
        for (const adapterPlan of [...plan.plans].reverse()) await adapterPlan.dispose?.();
      },
    });
  }

  function dependencyChain(adapter: AdapterRef<unknown>, visiting = new Set<AdapterRef<unknown>>()): AdapterRef<unknown>[] {
    if (visiting.has(adapter)) throw new Error(`适配器元数据依赖形成环：${adapter.id}`);
    visiting.add(adapter);
    const result = [adapter];
    for (const dependency of adapter.dependencies) result.push(...dependencyChain(dependency, new Set(visiting)));
    return result;
  }

  function pointStatus(contributionStates: readonly ContributionState[]): "pending" | "unavailable" | "ready" | "active" {
    if (contributionStates.length === 0) return "pending";
    if (contributionStates.some((state) =>
      [state.location, state.application, state.verification].some((status) =>
        ["failed", "unsupported", "ambiguous", "stale", "rolled-back"].includes(status)
      )
    )) return "unavailable";
    if (contributionStates.some((state) =>
      ["unresolved", "resolving"].includes(state.location) ||
      ["pending", "applying"].includes(state.application) ||
      state.verification === "pending"
    )) return "pending";
    // 多 Contribution 修改点必须全部出现真实语义效果，不能因其中一个命中就误报。
    return contributionStates.every((state) => state.exercise === "active") ? "active" : "ready";
  }

  function snapshot(): RuntimeSnapshot {
    const activePlan = compiled;
    const pointItems = [...points.values()].map((point) => {
      const directAdapters = point.contributions.map((item) => item.adapter);
      const chain = directAdapters.flatMap((adapter) => dependencyChain(adapter));
      const uniqueChain = [...new Map(chain.map((adapter) => [adapter.id, adapter])).values()];
      const contributionStates = (activePlan?.contributions || [])
        .filter((item) => item.point === point)
        .map((item) => Object.freeze({ ...stateFor(item) }));
      return Object.freeze({
        id: point.id,
        groupId: point.group.id,
        status: pointStatus(contributionStates),
        directAdapterIds: Object.freeze([...new Set(directAdapters.map((adapter) => adapter.id))]),
        adapterChainIds: Object.freeze(uniqueChain.map((adapter) => adapter.id)),
        contributions: Object.freeze(contributionStates),
      });
    });
    return Object.freeze({
      revision,
      groups: Object.freeze(
        [...groups.values()]
          .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
          .map((group) => Object.freeze({
            id: group.id,
            name: group.name,
            description: group.description,
            order: group.order,
            pointIds: Object.freeze(pointItems.filter((point) => point.groupId === group.id).map((point) => point.id)),
          })),
      ),
      adapterTypes: Object.freeze(
        [...adapters.values()]
          .sort((left, right) => left.id.localeCompare(right.id))
          .map((adapter) => Object.freeze({
            id: adapter.id,
            name: adapter.name,
            description: adapter.description,
            kind: adapter.kind,
            dependencies: Object.freeze(adapter.dependencies.map((dependency) => dependency.id)),
          })),
      ),
      points: Object.freeze(pointItems),
    });
  }

  return Object.freeze({
    registerGroup,
    registerAdapter,
    provide,
    expand,
    registerPoint,
    compile,
    activate,
    snapshot,
  });
}
