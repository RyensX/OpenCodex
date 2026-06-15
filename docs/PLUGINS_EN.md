# OpenCodex Plugins

[中文](PLUGINS.md) | **English**

OpenCodex supports plugin JavaScript files that can be dropped into a fixed directory, discovered automatically, loaded automatically, and shown as plugin switches in Settings. The current plugin system hosts OpenCodex-owned enhancements such as mobile keyboard optimization and mobile sidebar optimization.

> Plugins currently run as trusted same-page scripts without sandbox isolation. They can access `window`, `document`, and page runtime objects, so only place plugin files that you trust in the plugin directory.

## Plugin Directory

Place plugin files in:

```text
web-shell/plugins/*.js
```

The gateway scans this directory when `/opencodex-plugin-loader.js` is requested, then loads top-level `.js` files whose names match the safe file-name rule. Refresh the page to rescan the plugin directory.

Valid file-name examples:

```text
my-plugin.js
mobile-helper.v1.js
```

Plugin files are served from:

```text
/opencodex-plugins/<file-name>.js
```

## Load Timing

The plugin system has two phases: registration and activation.

1. The login page loads the plugin system and plugin loader, so plugin JS files run and call `registerPlugin()` before authentication. This allows Settings to show plugin switches before Codex is loaded.
2. After authentication succeeds and the Codex renderer is loaded, `codex-bridge-polyfill.js` calls `activate("renderer", capabilities)`. Only then does the plugin's `activate(context)` function run and install its behavior.

## Minimal Plugin

```js
(function () {
  const pluginSystem = window.OpenCodexPluginSystem || window.__OpenCodexPluginSystem;
  if (!pluginSystem || typeof pluginSystem.registerPlugin !== "function") return;

  pluginSystem.registerPlugin({
    id: "example.hello",
    name: "Hello plugin",
    label: "Example plugin",
    desc: "This description appears below the plugin title; empty descriptions are hidden.",
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

## registerPlugin Fields

| Field | Required | Description |
| --- | --- | --- |
| `id` | Yes | Unique plugin ID. Prefer a namespace or reverse-domain style name, for example `opencodex.mobile-keyboard-optimization`. |
| `name` | No | Internal plugin name. |
| `label` | No | Plugin switch title in Settings. Falls back to `name` or `id`. |
| `desc` | No | Description shown below the title in Settings. Empty descriptions are hidden. Plugin copy should be provided by the plugin JS itself. |
| `defaultEnabled` | No | Default value of the plugin's main switch. Defaults to `true` when omitted. |
| `enableStorageKey` | No | Field name used for this plugin's main switch in local settings. Defaults to `plugin.<id>.enabled`. |
| `builtin` | No | Marks a built-in plugin. Currently used mainly as metadata. |
| `order` | No | Sort order in Settings. Smaller numbers appear first. |
| `settings` | No | Custom plugin setting descriptors. The current Settings UI only auto-renders the plugin's main switch; this field is reserved for future expansion. |
| `activate(context)` | No | Plugin activation function. Called for an active scope when the plugin is enabled. May return a dispose function. |

`labelKey` still exists in the host implementation, mainly for OpenCodex built-in copy. Regular plugins should prefer `label` and `desc`, and should not add plugin copy to the main project locale files.

## Switch Storage

Plugin switches are stored in browser `localStorage`:

```text
opencodex_web_settings_v1
```

If a plugin does not configure `enableStorageKey`, the default field name is:

```text
plugin.<plugin-id>.enabled
```

Example:

```json
{
  "plugin.example.hello.enabled": true
}
```

To preserve compatibility with an old setting name, configure it explicitly:

```js
pluginSystem.registerPlugin({
  id: "example.legacy",
  label: "Legacy-compatible setting",
  enableStorageKey: "legacyPluginEnabled",
});
```

## PluginContext

`activate(context)` currently exposes these capabilities:

| Capability | Description |
| --- | --- |
| `context.scope` | Current activation scope. The renderer currently uses `"renderer"`. |
| `context.capabilities` | Raw capabilities object passed by the host. |
| `context.events.on(name, handler)` | Listen for a plugin event. Returns an unsubscribe function. |
| `context.events.emit(name, payload)` | Emit a plugin event. |
| `context.plugin.id` | Current plugin ID. |
| `context.plugin.isEnabled()` | Read the current plugin main-switch state. |
| `context.preferences.get(id)` | Read a setting value. |
| `context.preferences.set(id, value)` | Write a setting value. |
| `context.preferences.isEnabled(id)` | Treat a setting as enabled when it is not `false`. |
| `context.preferences.load()` | Read the full settings object. |
| `context.preferences.save(next)` | Save the full settings object. |
| `context.preferences.defaults()` | Get the current default settings object. |
| `context.settings.list(options)` | Read plugin setting descriptors. |
| `context.settings.register(setting)` | Register a plugin setting descriptor dynamically. The current UI does not auto-render these child settings yet. |
| `context.platform.isMobile()` | Returns whether the environment looks like a mobile input device. |
| `context.capabilities.tokenUsage` | Reads normalized reply token usage by `threadId + turnId`. |

### tokenUsage capability

`tokenUsage` is a dedicated capability mounted by the bridge, with the implementation kept in `codex-token-usage-capability.js`, for reading AI reply token usage on demand. It does not expose raw gateway, app-host messages, or session text to plugins. The bridge listens for and parses token data only after a plugin calls `acquireConsumer`; `getForTurn` reads the matching reply's session token record only on a runtime cache miss. Runtime caches are pruned globally and per thread so they do not grow without bounds.

```js
const release = context.capabilities.tokenUsage.acquireConsumer("example.token-usage");
const disposeUpdate = context.capabilities.tokenUsage.onUpdate((usage) => {
  console.log(usage.threadId, usage.turnId, usage.inputTokens, usage.outputTokens, usage.cacheHitRate);
});

context.capabilities.tokenUsage
  .getForTurn({ threadId, turnId })
  .then((usage) => {
    // usage may be null when no data can be safely associated with this reply.
  });
```

Returned fields:

| Field | Description |
| --- | --- |
| `threadId` | Conversation ID. |
| `turnId` | Turn ID for the reply. |
| `inputTokens` | Input tokens, or `null` when unknown. |
| `outputTokens` | Output tokens, or `null` when unknown. |
| `cachedInputTokens` | Cached input tokens, or `null` when unknown. |
| `cacheHitRate` | `cachedInputTokens / inputTokens`, or `null` when it cannot be computed. |
| `updatedAt` | Timestamp when the bridge normalized the record. |
| `source` | Data source marker, for example `app-host`, `gateway`, or `session-api`. |

## Current Events

| Event | Source | Description |
| --- | --- | --- |
| `plugin:enabled-changed` | Plugin system | Fired when a plugin main switch changes. |
| `preference:changed` | Plugin system | Fired when a setting value changes. |
| `ipc:invoke` | bridge polyfill | Fired before the renderer invokes gateway IPC. |
| `view:message` | bridge polyfill | Fired when the renderer handles a view message. |

Example:

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

## Lifecycle

- After registration, if the current scope is already active and the plugin switch is enabled, the plugin runs `activate(context)` immediately.
- When a plugin is disabled, the plugin system calls the dispose function returned by `activate()`.
- When a plugin is enabled again, the plugin system calls `activate(context)` again.
- A scope is activated only once to avoid duplicate listeners.

## Current Limits

- Plugins are normal `<script>` files, with no sandbox or permission isolation.
- Plugins can access the DOM directly, which also means they are responsible for compatibility and security risks.
- Settings currently auto-renders only the main switch for each plugin. Custom plugin setting descriptors do not have a complete UI yet.
- Plugin descriptions are not wired into the main project i18n. Plugins should provide the final display copy themselves.
