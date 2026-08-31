# OpenCodex 插件 v2

**中文** | [English](PLUGINS_EN.md)

OpenCodex 只执行 `apiVersion: 2` 的 ESM 插件。旧式 `index.js` 不再加载；即使目录里同时存在新 manifest 和 `index.js`，Gateway 也只会忽略旧入口并输出诊断。

插件仍按可信代码运行，没有 Worker/iframe 沙箱。架构边界由宿主 SDK、强类型对象引用和 Provider 隔离保证，不应把它理解为恶意代码安全隔离。

## 目录与 manifest

```text
/path/to/plugins/
  my-plugin/
    plugin.json
    dist/index.mjs
    i18.zh.json
    i18.en.json
```

```json
{
  "id": "example.my-plugin",
  "apiVersion": 2,
  "entry": "dist/index.mjs",
  "sdkVersion": "^2.0.0",
  "name": "My plugin",
  "label": "示例插件",
  "desc": "通过虚拟修改骨架扩展 OpenCodex。",
  "defaultEnabled": true,
  "order": 900
}
```

- `entry` 必须是插件目录内的相对 `.mjs` 文件，不能包含 `..` 或绝对路径。
- `sdkVersion` 必须兼容宿主 v2；当前支持 `2.0.0`、`^2.0.0`、`2.x` 和 `>=2 <3`。
- 外部根目录通过 `OPENCODEX_PLUGIN_DIRS` 配置，可使用系统路径分隔符或 JSON 数组。
- Gateway 先读取 manifest 和 i18n，使认证页设置能立即显示；ESM 随后以增量批次注册修改点。

## ESM 工厂

```ts
import type { OpenCodexPluginFactory } from "@opencodex/plugin-sdk";

export default ((sdk) => {
  const group = sdk.groups.register({
    id: "example.message-tools",
    name: "消息工具",
    description: "示例插件的开发者分类组。",
    order: 900,
  });
  const locator = sdk.view.locators.css(
    "locator.example-message-actions",
    '[data-app-action="message-actions"]',
  );

  sdk.points.register({
    id: "example.message-tools.hello",
    description: "在消息操作区追加文本",
    group,
    contributions: [sdk.adapters.semanticView.mount({
      locator,
      placement: sdk.view.placements.append,
      content: sdk.view.ui.text("Hello"),
    })],
  });
}) satisfies OpenCodexPluginFactory;
```

Loader 会给每个插件创建独立 SDK 作用域，并在工厂成功返回后原子提交。工厂抛错、依赖形成环、引用不是 SDK 对象、ID 重复或使用当前宿主不支持的终端适配器时，整批注册失败，不留下半批次状态。

完整可类型检查的示例位于 `examples/plugin-v2-hello`，公开类型位于 `sdk/plugin-v2`。示例检查命令：

```bash
pnpm exec tsc -p examples/plugin-v2-hello/tsconfig.json
pnpm exec esbuild examples/plugin-v2-hello/src/index.ts \
  --bundle --format=esm --platform=browser \
  --outfile=examples/plugin-v2-hello/dist/index.mjs
```

## 强类型注册模型

- `sdk.groups.register()` 返回 `PointGroupRef`。分类组只负责开发者查看，不参与启用、回退或依赖决策。
- `sdk.adapters.*` 暴露宿主创建的适配器引用。修改点优先使用高级语义适配器，没有合适语义时可使用当前宿主支持的底层适配器。
- `sdk.adapters.compose()` 创建高级适配器；`dependencies` 必须传 `AdapterRef` 对象，不能写字符串 ID。
- `sdk.points.register()` 只接受 `PointGroupRef` 和由适配器 API 创建的 Contribution。
- `sdk.view.locators.css()` 返回 Locator 对象；修改点不会收到真实 DOM。选择器只保存在 Provider 私有映射中。
- `sdk.view.ui` 创建虚拟节点。Provider 负责真实节点、监听器、重挂载和清理。

浏览器宿主当前可执行声明式 `RuntimeView` / `SemanticView`、`RuntimeHook` 和 `ProtocolPipeline.observe` Contribution，并统一共享 DOM Observer、全局事件、函数 Wrapper 和协议解码。跨宿主的静态资源、进程和 Runner 适配器仍会出现在完整目录中，但浏览器插件若把它们展开为终端声明，会在提交阶段以“宿主不提供该适配器”明确失败。

## 设置、开关与生命周期

manifest 会先注册到原有设置系统。插件提交后，宿主为它补充 `activate`：

- 只有插件开关启用且进入 `renderer` scope 时才激活修改点。
- 关闭插件会逆序销毁挂载、监听和共享资源引用。
- 重新开启会重新定位和挂载，不复用已失效的真实节点。
- 同一插件重复提交会被拒绝，避免新旧实现同时运行。

开关仍保存在 `opencodex_web_settings_v1`，默认键为 `plugin.<plugin-id>.enabled`。语言文件先加载中文，再用当前语言覆盖同名 key。

## 禁止的旧契约

以下入口不再受支持：

```text
<plugin>/index.js
window.OpenCodexPluginSystem.registerPlugin({ activate() { /* 直接改 DOM */ } })
```

内置增强的真实 DOM、Bridge 和协议实现已移入 `web-shell/internal/providers`，`web-shell/plugins` 只保留设置 manifest 与 i18n。外部插件也应只通过 v2 SDK 声明修改点。
