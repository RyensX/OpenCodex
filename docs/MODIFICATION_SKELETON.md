# OpenCodex 虚拟修改骨架开发指南

本文说明虚拟修改骨架的实际架构、状态监测方式，以及如何新增内置修改点或外部插件修改点。外部插件的目录和构建方式另见 [插件 v2](./PLUGINS.md)。

## 1. 设计目标

虚拟骨架把“业务上要产生什么效果”和“怎样接触真实运行环境”分开：

```text
分类组（只负责展示）
        │
修改点 + 强类型 Contribution 声明
        │
高级适配器 expand
        ▼
底层适配器批次
        │
Provider.compile(batch)
        ▼
定位 → 应用 → 验证 → 激活 → 真实命中
        │
DOM / 协议 / Hook / 静态资源 / 环境 / 进程 / 产物
```

不可变约束：

- 迁移不能改变原有触发条件、参数、`this`、返回值、Promise 身份、异常、事件顺序、缓存、节流、回退和 UI。
- 修改点声明不能直接访问 DOM、Bridge、Electron、Node、文件系统、静态资源正文或原始传输。
- 分类组只用于开发者查看，不参与启用、回退、依赖和运行决策。
- 适配器、分类组、修改点和语义目标在进程内都用不可伪造的对象引用；字符串 ID 只用于目录绑定、日志、报告和跨进程序列化。
- 安装成功只表示“已就绪”，不能冒充“已命中”。

## 2. 四个核心角色

### 2.1 修改点

`ModificationPointDefinition` 是最小事务和诊断单元。它引用：

- 一个 `PointGroupRef`；
- 一个或多个直接 `AdapterRef`；
- 每个适配器对应的冻结声明对象。

同一修改点的多个直接 Contribution 默认原子执行。任何一个定位、应用、验证或激活失败，Kernel 都会逆序释放和回滚该点已经成功的部分；同批次中的其他修改点不受影响。

能够独立失败或独立诊断的行为必须拆成不同修改点。例如“解析 Token 数据”和“把 Token 显示到消息操作区”是两个修改点。

### 2.2 适配器

适配器是修改点可见的强类型声明接口：

- `terminal`：底层适配器，对应一种真实接入机制。
- `composite`：高级适配器，把领域声明展开为显式依赖的底层声明。

高级适配器只是更方便、更精确的封装，不是权限层。没有合适语义时，修改点可以直接使用当前宿主支持的底层适配器。

当前七类底层适配器：

| 适配器 | 真实机制 |
|---|---|
| `RuntimeView` | 视图定位、观察、虚拟节点和挂载 |
| `ProtocolPipeline` | IPC、WebSocket、NDJSON 的解析、观察和转换 |
| `RuntimeHook` | 函数、属性、构造器和模块 Hook |
| `StaticResource` | HTML、JS、文本资源的定位、事务改写和验证 |
| `RuntimeEnvironment` | 环境变量、Chromium 开关和启动边界 |
| `ProcessInterception` | 子进程和系统打开行为的有序拦截 |
| `ArtifactBuild` | Runner 暂存、复制、ASAR、签名和提交 |

底层适配器带宿主类型约束。例如只接受 `browser` 目标的适配器不能接收 `gateway` 目标；错误跨宿主组合会在 TypeScript 编译期失败。

### 2.3 Provider

适配器描述“能做什么”，Provider 负责“在当前宿主里怎样真实做到”。

Provider 的职责是：

1. 在 `compile(batch)` 中接收同一底层适配器的完整 Contribution 批次；
2. 一次性建立定位索引、共享 Observer、协议解析器或 Hook 链；
3. 对每个 Contribution 执行定位、应用、验证和激活；
4. 在业务效果真正发生时通知 Kernel 命中；
5. 失败时回滚，销毁时释放共享资源；
6. 暴露只读性能计数器。

Provider 不是修改点之外的第二套业务逻辑，也不是通过字符串查找适配器的注册表。Kernel 用真实 `AdapterRef` 对象作为 Provider Map 的键。

浏览器中的受信脚本资源 key 属于静态资源加载边界，不是适配器引用。脚本进入 Kernel 后仍按 `AdapterRef` 对象编译执行。

### 2.4 Kernel

`gateway/src/modification/kernel.ts` 是唯一状态机，负责：

- 注册对象身份和重复 ID 校验；
- 高级适配器依赖展开和依赖环检测；
- 按底层适配器批量编译；
- 修改点级原子应用和逆序回滚；
- 同步启动边界与异步执行边界；
- 激活、销毁、命中和 Provider 诊断快照；
- 阻止同一计划重复激活或激活后继续写入。

浏览器内置点、Gateway、静态资源、Runner 和外部 ESM v2 插件都使用这套 Kernel，不再各自维护简化状态机。

## 3. 代码布局

| 路径 | 作用 |
|---|---|
| `gateway/src/modification/sdk.ts` | 分类组、适配器、修改点、Signal、Capability 的品牌引用 |
| `gateway/src/modification/contracts.ts` | 七类底层适配器的严格参数契约 |
| `gateway/src/modification/implementation.ts` | 带宿主泛型的 `ModificationTargetRef` |
| `gateway/src/modification/catalog.ts` | 17 个分类组、23 个适配器和 102 个内置修改点的唯一目录 |
| `gateway/src/modification/kernel.ts` | 编译、事务、状态、命中和销毁 |
| `gateway/src/modification/production.ts` | Gateway、静态和 Runner 的生产批次协调器 |
| `gateway/runtime/modification/point-refs.cjs` | CJS 边界的命名强类型修改点对象 |
| `web-shell/src/modification-browser-host.ts` | 浏览器 Provider、共享资源和页面代际 |
| `web-shell/internal/providers/` | 允许接触真实浏览器环境的内置 Provider 脚本 |
| `gateway/runtime/compatibility/` | Schema v2 聚合、脱敏、持久化和 v1 只读兼容 |
| `scripts/check-modification-boundaries.cjs` | 禁止绕过骨架的静态边界检查 |

修改点严格工程没有 DOM/Node 类型库。浏览器 Provider 工程允许 DOM，Gateway Provider 工程允许 Node/Electron。

## 4. 统一编译和执行

### 4.1 注册与 compile

顺序固定为：

```text
register groups
→ register adapters / expanders
→ register terminal Providers
→ register points
→ compile
```

`compile` 会递归展开高级适配器，然后按终端 `AdapterRef` 聚合。一个 Provider 在一个批次中只调用一次 `compile(contributions)`。

生产协调器的 `executeBatch` 和 `bindBatch` 用于同步宿主批量安装。Renderer 的 17 个静态修改点会在一个 `StaticResource` 批次中注册；Gateway 的补注册也会合并为一个批次。

同步启动阶段使用 `activateSync`。Provider 若在同步边界返回 Promise，Kernel 会直接拒绝，避免悄悄改变官方 bootstrap 顺序。

### 4.2 状态如何监测

每个编译后的叶子 Contribution 都独立保存五个阶段：

| 阶段 | Kernel 如何判定 | 主要状态 |
|---|---|---|
| 定位 `location` | Provider 检查强类型目标、候选和宿主实现 | unresolved、resolving、resolved、unsupported、ambiguous、failed、stale |
| 应用 `application` | Provider 完成真实安装或资源事务 | pending、applying、applied、rolled-back、failed、disabled |
| 验证 `verification` | Provider 检查安装结果或输出约束 | pending、verified、not-required、failed |
| 激活 `activation` | Kernel 安装命中回调和生命周期 disposer | inactive、activating、ready、failed、disposed |
| 命中 `exercise` | 真实业务效果发生 | not-exercised、active、disabled |

叶子还保存 `fallbackActive` 和 `fallbackReason`。定位或验证失败但业务继续使用官方行为时，Provider 必须同时报告精确失败状态和回退；不能把仍可工作的回退路径误报为完全不可用。

执行顺序：

```text
整个 Provider 批次 locate
          ↓
按修改点 apply
          ↓
按修改点 verify
          ↓
按修改点 activate
          ↓
运行期间等待真实 semantic hit
```

Provider 必须明确报告结果。漏报定位、应用或验证会被 Kernel 当成失败，不能默认为成功。

### 4.3 聚合规则

修改点状态：

- `pending`：尚未完成定位、应用、验证或激活；
- `unavailable`：任何必要 Contribution 失败、不支持、歧义、过期或回滚；
- `degraded`：必要 Contribution 未能接管，但已确认使用官方行为或其他回退路径；
- `disabled`：插件或配置直接关闭该修改点；
- `ready`：全部安装、验证、激活完成，但尚未全部真实命中；
- `active`：所有直接 Contribution 对应的语义效果都已真实命中。

高级适配器展开的多个底层叶子共同实现一个直接 Contribution。内置高级 Provider 在高层语义效果完成时统一确认其叶子；一个修改点包含多个直接 Contribution 时，必须每个直接效果都发生后才会成为 `active`。

分类组状态由成员最严重状态派生，仅供组头展示。总体状态和顶部统计只计算修改点。

### 4.4 什么才算命中

这些情况可以报告命中：

- 虚拟节点确实挂载到当前有效页面；
- Hook 的该层真实处理了一次调用；
- 协议帧通过 Schema，并产生了声明的观察或转换结果；
- 静态资源改写真实进入输出；
- 环境或进程拦截实际影响了一次目标行为；
- Runner 构建步骤真实完成并提交产物。

仅注册 Provider、创建 Observer、安装 Listener、包一层函数或收到普通协议帧，都不能算命中。

## 5. 浏览器共享 Provider

`window.__OpenCodexAdapterHost` 提供：

- `dom.observe`：每个根最多一个真实 `MutationObserver`；
- `events.observe`：相同 target/type/capture 只有一个真实 Listener；
- `hooks.around`：每个真实目标只有一层 Wrapper；
- `protocol.observe/publish`：每帧只解码一次；
- `scheduler.capture`：Provider 定时器和动画帧归属当前页面代际；
- `lifecycle.createScope`：插件 Kernel 的资源作用域；
- `plugins.register`：延迟启用的内置插件仍保留原 Provider 所有权；
- `diagnostics`：Observer、Listener、Wrapper、解析和分发计数。

登录壳通过 `document.write` 进入官方页面时，Host 会开始新页面代际：

1. 关闭旧 Provider scope；
2. 释放旧 Observer、Listener、Hook、协议订阅和 Scheduler 任务；
3. 销毁旧 Kernel 激活句柄；
4. 清空旧命中；
5. 重新注册并编译新页面 Provider。

Provider 的安装标记使用页面 generation，而不是永久布尔值，因此旧 Window 不会阻止新 Document 重新注入。

浏览器 Provider 禁止自行创建全局 Observer、全局 Listener或直接使用全局定时器。必须使用共享 Host；边界检查会拒绝绕过。

## 6. Gateway、静态资源与 Runner

CJS 业务模块从 `gateway/runtime/modification/point-refs.cjs` 取得修改点对象，不能散落解析修改点 ID：

```js
const { gateway: points } = require("../modification/point-refs.cjs");

const capability = compatibilityService.modifications.bind(
  points.dialogOpen,
  originalOperation,
);
```

`bind` 保留原 `this`、参数、同步返回、Promise 对象和异常；只有成功返回或 Promise resolve 后才产生语义命中。

如果包装的是 Hook、Observer 等“安装函数”，必须传 `{ hitOnSuccess: false }`。安装完成后保持 `ready`，等真实拦截、消息或视图效果发生时再通过 effect sink 命中；不能把安装函数的成功返回当成业务命中。

同一启动阶段有多个能力时使用批量接口：

```js
const capabilities = coordinator.bindBatch([
  { point: points.first, operation: firstOperation },
  { point: points.second, operation: secondOperation },
]);
```

静态资源 Provider 必须保留未命中时的原始字节，并在候选约束或输出验证失败时报告对应阶段失败；继续输出官方原文时还要通过 `useFallback` 报告回退。Runner 回传全部五个 Runner 修改点的 Kernel 快照：当前平台实际执行的点为真实结果，其他平台点为 `disabled`。

## 7. 新增内置修改点

### 第一步：划定事务边界

明确：

- 真正的业务效果是什么；
- 它何时才算命中；
- 失败是否要与其他效果一起回滚；
- 清理时要恢复哪些节点、函数或资源。

### 第二步：选择分类组

在 `POINT_GROUPS` 中选择现有领域组。只有出现新领域时才注册新组；不要向组增加 `required`、`fallback`、`enabled` 等运行语义。

### 第三步：选择适配器

优先选能表达目标的高级适配器，没有对应语义时直接选底层适配器：

```ts
point(
  "web.runtime.dom.example-badge",
  "在消息操作区展示示例标记",
  "web-shell",
  POINT_GROUPS.rendererUi,
  ADAPTERS.semanticView,
);
```

`point` 会按稳定 ID 前缀推导宿主，并创建带宿主泛型的 `ModificationTargetRef`。如果适配器与宿主不匹配，目录本身无法通过类型检查。

需要两个独立且必须同时成功的效果时，传入两个直接适配器；不要为了展示“完整链”而人为增加 Contribution，依赖链由 Expander 自动产生。

### 第四步：接入真实 Provider

浏览器点需要：

1. 在 `BROWSER_PROVIDER_DEFINITIONS` 中把点绑定到受信 Provider 资源；
2. 在 `gateway/runtime/http/static-assets.cjs` 的内置 Provider 文件表中加入资源；
3. 在 `web-shell/internal/providers/` 实现真实行为；
4. 只在真实效果发生时调用当前 Provider scope 的 `effects.<alias>.emit()`。

Gateway、静态和 Runner 点需要：

1. 在 `point-refs.cjs` 暴露命名对象引用；
2. 在真实 internal 模块通过 `bind`、`bindBatch`、`execute` 或 `executeBatch` 进入生产 Provider；
3. 提供真实验证和需要时的回滚；
4. 在实际调用或产物完成时由返回包装器或 effect sink 产生命中。

目标不存在、候选不唯一或定位过期时使用 `locationFailure` 保留精确定位状态；如果业务随后继续走官方行为，再调用 `useFallback`，该点会显示为 `degraded`。

业务代码不得调用旧式 `installPoint`、`recordHit`、`active` 等手工状态接口。

### 第五步：测试

每个点至少有一个直接行为测试。按机制覆盖：

- DOM 结果、重挂载、隐藏页面、插件启停和页面代际清理；
- Hook 的 `this`、参数、返回、Promise、异常、顺序和恢复；
- 协议 Schema、一次解码、消息顺序和无关帧；
- 静态补丁的候选数、逐字节输出、缓存键和未命中原文；
- Runner 的目录、ASAR、签名和平台适用性。

新增点时同步更新目录总数、宿主分布、Provider 覆盖断言和迁移矩阵，不能只改数字。

## 8. 新增高级适配器

高级适配器只做强类型展开：

```ts
const MessageActions = defineAdapter<MessageActionsDeclaration>({
  id: "adapter.message-actions",
  name: "消息操作区",
  description: "定位稳定消息操作区并挂载虚拟内容。",
  kind: "composite",
  dependencies: [BASE_ADAPTERS.runtimeView],
});

runtime.expand({
  adapter: MessageActions,
  expand(declaration) {
    return [BASE_ADAPTERS.runtimeView.use(toRuntimeViewDeclaration(declaration))];
  },
});
```

要求：

- 参数必须有明确类型；
- dependencies 必须传真实 `AdapterRef`；
- expand 只能使用已声明依赖；
- 不得读取真实环境；
- 至少有依赖展开、错误引用和完整链测试。

只有现有七类底层机制无法表达新接入方式时，才新增底层适配器和终端 Provider。

## 9. 外部插件

外部 ESM v2 插件得到宿主冻结的真实 SDK 门面。插件：

- 可注册分类组、高级适配器和修改点；
- 可使用浏览器宿主公开的 RuntimeView、RuntimeHook 和 ProtocolPipeline；
- 不能提供终端 Provider；
- 不能直接取得真实 DOM、Event、Bridge 或协议连接；
- 工厂完成后才原子提交；
- 每个插件批次通过正式 Kernel 编译、激活、回滚和快照。

页面替换会使旧插件注册 generation 失效；晚到的旧异步工厂无法提交到新页面。

## 10. 报告与调试页面

Schema v2 输出：

- `groups`；
- `adapterTypes`；
- 修改点的 `groupId`、`directAdapterIds`、`adapterChainIds`；
- 每个叶子 Contribution 的稳定 ID、直接适配器、终端适配器、完整链、五阶段状态和回退状态；

Kernel 本地快照还包含 `providerDiagnostics` 只读计数器，用于性能测试和宿主诊断；兼容性跨进程报告只传状态数据，不重复传输高频计数器。

浏览器回执使用 client ID、页面 generation 和单调 sequence。新页面成为当前报告者后，旧标签页的延迟回执只做幂等确认，不会覆盖当前页面状态。

调试入口：

```text
/settings/developer/runtime-compatibility
/opencodex/runtime-compatibility
```

GET 快照匿名只读；浏览器写入回执仍位于认证边界内。

## 11. 提交前检查

- [ ] 分类组只负责展示。
- [ ] 修改点引用真实组、适配器和宿主目标对象。
- [ ] 修改点没有直接访问真实环境。
- [ ] 同类声明使用批量 Provider，而不是逐点重复扫描。
- [ ] 安装、激活和真实命中严格分开。
- [ ] 插件关闭时显示 `disabled`，重新开启后等待新命中。
- [ ] 页面替换和销毁释放 Observer、Listener、Hook、协议订阅与 Scheduler。
- [ ] 参数、返回值、Promise、异常和事件顺序与改造前一致。
- [ ] 有直接行为测试和失败/回滚测试。
- [ ] 调试页显示正确组、适配器链和 Contribution 状态。

执行：

```bash
pnpm run typecheck:skeleton
pnpm run check:skeleton-boundaries
pnpm test
git diff --check
```

边界检查失败时，应修正声明或 Provider 分层，不能用字符串查找、手工状态回执或把真实环境访问移回修改点来绕过。
