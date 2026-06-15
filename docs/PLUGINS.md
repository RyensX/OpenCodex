# OpenCodex 插件

**中文** | [English](PLUGINS_EN.md)

OpenCodex 支持把插件 JS 文件放进固定目录后自动发现、加载并在设置页生成插件开关。当前插件系统用于承载 OpenCodex 自有增强能力，例如移动端软键盘优化和移动端侧栏优化。

> 当前插件以可信同页脚本方式运行，没有沙箱隔离。插件可以访问 `window`、`document` 和页面运行时对象，所以只应放入你信任的插件文件。

## 插件目录

插件文件放在：

```text
web-shell/plugins/*.js
```

gateway 会在请求 `/opencodex-plugin-loader.js` 时扫描该目录，并加载符合安全文件名规则的顶层 `.js` 文件。刷新页面即可重新扫描插件目录。

有效文件名示例：

```text
my-plugin.js
mobile-helper.v1.js
```

插件文件会通过以下 URL 加载：

```text
/opencodex-plugins/<file-name>.js
```

## 加载时机

插件系统分为注册和激活两个阶段：

1. 登录页会加载插件系统和插件 loader，所以插件 JS 会在认证前完成 `registerPlugin()` 注册，设置页也能显示插件开关。
2. 认证通过并加载 Codex renderer 后，`codex-bridge-polyfill.js` 会调用 `activate("renderer", capabilities)`，插件的 `activate(context)` 才会执行，插件功能才真正生效。

## 最小插件

```js
(function () {
  const pluginSystem = window.OpenCodexPluginSystem || window.__OpenCodexPluginSystem;
  if (!pluginSystem || typeof pluginSystem.registerPlugin !== "function") return;

  pluginSystem.registerPlugin({
    id: "example.hello",
    name: "Hello plugin",
    label: "示例插件",
    desc: "这段描述会显示在插件标题下面；为空时不显示。",
    defaultEnabled: true,
    order: 100,
    activate(context) {
      if (context.scope !== "renderer") return null;
      if (!context.plugin.isEnabled()) return null;

      console.log("[example.hello] activated");

      return () => {
        console.log("[example.hello] disposed");
      };
    },
  });
})();
```

## registerPlugin 字段

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | 是 | 插件唯一 ID。建议使用反向域名或命名空间，例如 `opencodex.mobile-keyboard-optimization`。 |
| `name` | 否 | 插件内部名称。 |
| `label` | 否 | 设置页插件开关标题。未提供时回退到 `name` 或 `id`。 |
| `desc` | 否 | 设置页标题下方描述。为空时不显示描述。插件文案应由插件 JS 自己提供。 |
| `defaultEnabled` | 否 | 插件总开关默认值。未声明时默认 `true`。 |
| `enableStorageKey` | 否 | 插件总开关在本地设置里的字段名。未声明时使用 `plugin.<id>.enabled`。 |
| `builtin` | 否 | 是否内置插件。当前主要用于元信息标记。 |
| `order` | 否 | 设置页排序值，数字越小越靠前。 |
| `settings` | 否 | 插件自定义设置声明。当前设置页只自动渲染插件总开关，该字段暂作扩展预留。 |
| `activate(context)` | 否 | 插件激活函数。启用状态下进入对应 scope 时调用。可返回 dispose 函数。 |

`labelKey` 目前仍存在于宿主实现中，主要服务 OpenCodex 内置文案。普通插件应优先使用 `label` 和 `desc`，避免把插件文案写进主项目 locale。

## 开关存储

插件开关保存在浏览器 `localStorage`：

```text
opencodex_web_settings_v1
```

如果插件没有配置 `enableStorageKey`，默认字段名是：

```text
plugin.<plugin-id>.enabled
```

示例：

```json
{
  "plugin.example.hello.enabled": true
}
```

如果需要兼容旧设置名，可以显式指定：

```js
pluginSystem.registerPlugin({
  id: "example.legacy",
  label: "兼容旧设置",
  enableStorageKey: "legacyPluginEnabled",
});
```

## PluginContext

`activate(context)` 当前可以使用以下能力：

| 能力 | 说明 |
| --- | --- |
| `context.scope` | 当前激活范围。目前 renderer 使用 `"renderer"`。 |
| `context.capabilities` | 宿主传入的原始能力对象。 |
| `context.events.on(name, handler)` | 监听插件事件，返回取消监听函数。 |
| `context.events.emit(name, payload)` | 发出插件事件。 |
| `context.plugin.id` | 当前插件 ID。 |
| `context.plugin.isEnabled()` | 读取当前插件总开关状态。 |
| `context.preferences.get(id)` | 读取设置值。 |
| `context.preferences.set(id, value)` | 写入设置值。 |
| `context.preferences.isEnabled(id)` | 按 `!== false` 判断设置是否启用。 |
| `context.preferences.load()` | 读取完整设置对象。 |
| `context.preferences.save(next)` | 保存完整设置对象。 |
| `context.preferences.defaults()` | 获取当前默认设置对象。 |
| `context.settings.list(options)` | 读取插件设置声明。 |
| `context.settings.register(setting)` | 动态注册插件设置声明。当前 UI 暂未自动渲染这些子设置。 |
| `context.platform.isMobile()` | 判断当前环境是否更像移动端输入设备。 |
| `context.capabilities.tokenUsage` | 按 `threadId + turnId` 读取归一化后的回复 token 用量。 |

### tokenUsage capability

`tokenUsage` 是 bridge 挂载的专用能力，具体逻辑位于 `codex-token-usage-capability.js`，用于插件按需读取 AI 回复的 token 消耗。它不会向插件暴露原始 gateway、app-host 消息或 session 正文。只有插件调用 `acquireConsumer` 后，bridge 才会监听/解析相关数据；`getForTurn` 在运行期缓存未命中时才会读取对应回复的 session token 记录。运行期缓存会按全局和会话维度裁剪，不会无限增长。

```js
const release = context.capabilities.tokenUsage.acquireConsumer("example.token-usage");
const disposeUpdate = context.capabilities.tokenUsage.onUpdate((usage) => {
  console.log(usage.threadId, usage.turnId, usage.inputTokens, usage.outputTokens, usage.cacheHitRate);
});

context.capabilities.tokenUsage
  .getForTurn({ threadId, turnId })
  .then((usage) => {
    // usage 可能为 null，表示当前没有可安全关联到该回复的数据。
  });
```

返回值字段：

| 字段 | 说明 |
| --- | --- |
| `threadId` | 会话 ID。 |
| `turnId` | 回复对应的 turn ID。 |
| `inputTokens` | 输入 token 数；未知时为 `null`。 |
| `outputTokens` | 输出 token 数；未知时为 `null`。 |
| `cachedInputTokens` | 命中缓存的输入 token 数；未知时为 `null`。 |
| `cacheHitRate` | `cachedInputTokens / inputTokens`；无法计算时为 `null`。 |
| `updatedAt` | bridge 归一化该记录的时间戳。 |
| `source` | 数据来源标记，例如 `app-host`、`gateway` 或 `session-api`。 |

## 当前事件

| 事件 | 来源 | 说明 |
| --- | --- | --- |
| `plugin:enabled-changed` | 插件系统 | 插件总开关变化时触发。 |
| `preference:changed` | 插件系统 | 设置值变化时触发。 |
| `ipc:invoke` | bridge polyfill | renderer 调用 gateway IPC 前触发。 |
| `view:message` | bridge polyfill | renderer 处理 view message 时触发。 |

示例：

```js
activate(context) {
  const dispose = context.events.on("plugin:enabled-changed", (payload) => {
    if (payload.id === context.plugin.id) {
      console.log("enabled:", payload.enabled);
    }
  });

  return dispose;
}
```

## 生命周期

- 插件注册后，如果当前 scope 已经激活并且插件开关为启用，插件会立即执行 `activate(context)`。
- 插件关闭时，插件系统会调用 `activate()` 返回的 dispose 函数。
- 插件再次打开时，插件系统会重新调用 `activate(context)`。
- 同一个 scope 只会激活一次，避免重复安装监听器。

## 当前限制

- 插件是普通 `<script>`，没有沙箱和权限隔离。
- 插件可以直接访问 DOM，但这也意味着插件需要自己承担兼容性和安全风险。
- 设置页目前只自动渲染每个插件的总开关，插件子设置声明还没有完整 UI。
- 插件描述暂不接入主项目 i18n，建议插件自己提供最终展示文案。
