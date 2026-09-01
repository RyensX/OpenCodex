# OpenCodex 虚拟修改骨架

> Schema：v2
> 适用范围：官方 Renderer、Electron Main、App Server、静态资源和 Runner 产物

新增修改点、选择适配器和实现 Provider 的具体步骤见 [虚拟修改骨架开发指南](./MODIFICATION_SKELETON.md)。

## 1. 不可变约束

虚拟骨架只改变代码边界、执行编排和诊断方式。102 个修改点原有的触发条件、参数、`this`、返回值、异常、Promise、事件顺序、缓存、节流、回退和 UI 表现不得变化。

- 修改点声明工程不包含 DOM 或 Node 类型，不能访问真实 DOM、Bridge、Electron、文件系统、静态资源正文或原始传输。
- 真实环境只由 internal Provider 接触。浏览器 Provider 位于 `web-shell/internal/providers` 和 `web-shell/src/modification-browser-host.ts`。
- 分类组只用于开发者查看，不参与启用、回退、依赖和运行决策。
- 适配器、分类组、修改点、Signal、Capability 和实现绑定均使用带私有品牌的对象引用。字符串 ID 只用于报告、日志和跨进程序列化。
- 旧式外部 `index.js` 是唯一有意停止兼容的契约。

## 2. 结构

```text
PointGroupRef（纯展示）
        │
ModificationPointRef
        │ Contribution
        ▼
高级语义 AdapterRef ── expand ──┐
底层 AdapterRef ────────────────┤
                                ▼
                       Provider.compile(batch)
                                │
                    修改点级定位 / 应用 / 验证
                                │
                    真实语义命中 / 逆序回滚 / 销毁
```

主要实现：

- `gateway/src/modification/sdk.ts`：不可伪造引用和声明对象。
- `gateway/src/modification/contracts.ts`：七类底层适配器的严格 TypeScript 参数契约。
- `gateway/src/modification/kernel.ts`：依赖展开、批量编译、修改点原子事务、故障隔离和快照。
- `gateway/src/modification/catalog.ts`：102 点、17 个分类组、23 个适配器及带宿主约束的语义目标唯一目录。
- `gateway/src/modification/production.ts`：Gateway、静态资源和 Runner 的生产批次协调器。
- `web-shell/src/modification-browser-host.ts`：共享 DOM Observer、全局事件、函数 Wrapper、协议解码、Scheduler 和页面代际。
- `gateway/runtime/compatibility/*`：跨进程 Schema v2 状态、脱敏报告和只读 v1 兼容读取。

## 3. 底层与高级适配器

固定底层适配器：

1. `RuntimeView`：视图 Locator、观察、虚拟节点和挂载。
2. `ProtocolPipeline`：共享解码、Schema、观察和转换。
3. `RuntimeHook`：函数、属性、构造器和模块 Hook。
4. `StaticResource`：HTML、JS、文本资源的事务定位、修改和验证。
5. `RuntimeEnvironment`：环境、启动开关和提交边界。
6. `ProcessInterception`：进程启动与系统打开行为的有序拦截。
7. `ArtifactBuild`：Runner 暂存、复制、ASAR、签名与原子提交。

目录中的高级适配器包括语义视图、桌面 Bridge、浏览器原生能力、网络请求、移动交互、官方 Runtime、Gateway IPC、App Server 协议、进程桥、语义协议、官方 Main/Renderer 补丁和 Runner 产物。

高级适配器只展开声明，不能接触真实环境。修改点可直接使用当前宿主支持的底层适配器；高级适配器只是优先选择，不是权限层。

## 4. 编译与事务

Kernel 分为注册、`compile`、`activate`：

- compile 校验重复 ID、未注册引用、依赖环、未声明的展开依赖和缺失 Provider。
- 同一终端 Provider 一次收到完整批次，可共享扫描、解析器、Listener 和 Wrapper。
- 后续阶段以单个 Contribution 执行；同一修改点的多个 Contribution 是一个原子事务。
- 应用或验证失败时，只逆序回滚该修改点已经应用的 Contribution；同批 Provider 中的无关修改点继续执行。
- Provider 必须明确报告每个 Contribution 的定位、应用和验证结果，漏报按失败处理。
- 安装成功不等于命中。多 Contribution 修改点只有全部发生真实语义效果才派生为“已命中”。
- 激活返回统一 disposer；共享资源由 Provider 引用计数，最后一个消费者销毁后才恢复真实对象。

浏览器共享宿主保证：

- 同一观察根只有一个真实 `MutationObserver`，不同订阅按各自 options 过滤记录。
- 同一 target/type/capture 只有一个真实事件 Listener；passive 需求合并为兼容的单层 Listener。
- 同一函数目标只有一层 Wrapper，内部按 order 执行拦截器链。
- 同一协议帧只进行一次 JSON/NDJSON 解码，再向 Channel 订阅者分发同一对象。
- Provider 定时器和动画帧属于当前页面代际，页面替换时统一取消。
- 延迟激活的内置插件保留原 Provider 所有权，关闭时修改点直接显示为 disabled。

## 5. 迁移目录

稳定点数量保持不变：

| 宿主 | 数量 | 稳定前缀 |
|---|---:|---|
| 浏览器 Renderer | 36 | `web.runtime.*` |
| Gateway Runtime | 36 | `gateway.runtime.*` |
| 静态资源与 Runner | 30 | `static.cache.*` |

每点显式引用：

- 一个 `PointGroupRef`；
- 一个或多个直接 `AdapterRef`；
- 完整适配器依赖链；
- 一个独立且带 `browser/gateway/static/runner` 泛型约束的 `ModificationTargetRef`。

内置插件目录不再含可执行 `index.js`。原实现移动到 internal Provider，插件目录只保留 manifest/i18n，因此修改点声明不会直接操作真实页面。边界检查会拒绝修改点工程中的 DOM/Node 全局、Provider 目录中的独立 MutationObserver/全局事件监听，以及旧插件入口。

## 6. 分类组与报告 v2

当前 17 个分类组覆盖 Renderer 核心桥、首屏历史、工作区、远端文件、智能调度、通知节能、Token、移动交互、Renderer UI、浏览器平台、Web 网络、项目导航、Gateway Runtime/IPC、官方 Main、Renderer 静态资源和 Runner。

组状态仅由成员最严重状态派生：

```text
不可用 > 降级 > 待检测 > 已就绪 > 已命中
```

总体状态和顶部统计只计算修改点。Schema v2 包含 `groups`、`adapterTypes`、`groupId`、`directAdapterIds` 和 `adapterChainIds`。Schema v1 只在报告读取边界归一化为带 `readOnly/sourceSchemaVersion` 的 v2 视图，不会重新写回或参与当前运行决策。

调试入口公开且只读：

```text
/settings/developer/runtime-compatibility
/opencodex/runtime-compatibility
```

入口位于认证页“设置”，Launcher 不提供入口。页面按分类组展示完整“高级 → 底层”适配器链，筛选器匹配链中任意适配器；总状态、定位、应用、验证、激活、命中和注入类别均有可点击说明。

## 7. 构建、插件与边界

`pnpm build` 顺序为：版本同步、清理派生目录、严格骨架类型检查、Node Provider CommonJS 编译、浏览器 IIFE bundle、边界检查、现有 Gateway 编译、版本一致性检查。骨架工程使用 `strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`，且不继承旧 Gateway 的宽松配置。

外部插件必须声明：

```json
{
  "apiVersion": 2,
  "entry": "dist/index.mjs",
  "sdkVersion": "^2.0.0"
}
```

ESM 默认导出工厂接收宿主创建的冻结 SDK 作用域。插件不能提供终端 Provider；注册批次在工厂返回后原子提交。公开类型、无 DOM/Node 类型的示例工程和构建命令见 `docs/PLUGINS.md`。

## 8. 验收

完成改动后必须同时满足：

- 102/102 点均有组、直接适配器、依赖链和宿主语义目标，无 legacy/unassigned 项。
- 编译期错误覆盖错误 Slot、Schema、环境值、进程请求和产物规格。
- Kernel 覆盖批量编译、依赖环、原子回滚、故障隔离、全量真实命中语义和销毁。
- 浏览器覆盖共享 Observer/Event/Hook/Protocol 计数与后台暂停。
- 静态补丁、Gateway Hook、Token、智能调度、远端文件、移动端和 Runner 的原有回归测试全部通过。
- `git diff --check`、完整测试、签名结构检查、`hdiutil verify` 和 SHA-256 校验通过后才生成最终 DMG。
