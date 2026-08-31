# OpenCodex Plugins v2

[中文](PLUGINS.md) | **English**

OpenCodex executes only ESM plugins with `apiVersion: 2`. Legacy `index.js` entries are no longer loaded. If a directory contains both a v2 manifest and `index.js`, the gateway ignores the legacy entry and emits a diagnostic.

Plugins remain trusted code and are not isolated in a Worker or iframe. The host SDK, strongly typed object references, and Provider boundaries are architectural constraints, not a malicious-code sandbox.

## Directory and manifest

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
  "label": "Example plugin",
  "desc": "Extends OpenCodex through the virtual modification skeleton.",
  "defaultEnabled": true,
  "order": 900
}
```

- `entry` must be a relative `.mjs` path inside the plugin directory. Absolute paths and `..` are rejected.
- `sdkVersion` must support host v2. Accepted forms include `2.0.0`, `^2.0.0`, `2.x`, and `>=2 <3`.
- Add external roots with `OPENCODEX_PLUGIN_DIRS`, using the platform path separator or a JSON array.
- The gateway reads manifests and translations first so settings are available on the authentication page, then loads ESM contributions as an incremental batch.

## ESM factory

```ts
import type { OpenCodexPluginFactory } from "@opencodex/plugin-sdk";

export default ((sdk) => {
  const group = sdk.groups.register({
    id: "example.message-tools",
    name: "Message tools",
    description: "Developer-facing classification for this plugin.",
    order: 900,
  });
  const locator = sdk.view.locators.css(
    "locator.example-message-actions",
    '[data-app-action="message-actions"]',
  );

  sdk.points.register({
    id: "example.message-tools.hello",
    description: "Append text to the message action area",
    group,
    contributions: [sdk.adapters.semanticView.mount({
      locator,
      placement: sdk.view.placements.append,
      content: sdk.view.ui.text("Hello"),
    })],
  });
}) satisfies OpenCodexPluginFactory;
```

The loader creates a scoped SDK for each plugin and commits only after the factory returns successfully. A thrown error, dependency cycle, forged reference, duplicate ID, or terminal adapter unavailable in the current host rejects the whole batch.

The type-checked example is in `examples/plugin-v2-hello`; public types are in `sdk/plugin-v2`.

```bash
pnpm exec tsc -p examples/plugin-v2-hello/tsconfig.json
pnpm exec esbuild examples/plugin-v2-hello/src/index.ts \
  --bundle --format=esm --platform=browser \
  --outfile=examples/plugin-v2-hello/dist/index.mjs
```

## Strong registration model

- `sdk.groups.register()` returns a `PointGroupRef`. Groups are display-only and never control activation, fallback, or dependencies.
- `sdk.adapters.*` exposes host-created adapter references. Prefer semantic adapters; use a supported base adapter when no semantic abstraction fits.
- `sdk.adapters.compose()` requires `AdapterRef` dependency objects, never string IDs.
- `sdk.points.register()` accepts only SDK group references and adapter-created Contributions.
- `sdk.view.locators.css()` returns an opaque Locator; the modification point never receives a real DOM node.
- `sdk.view.ui` creates virtual nodes. The Provider owns real nodes, listeners, remounting, and cleanup.

The browser host currently executes declarative `RuntimeView` / `SemanticView`, `RuntimeHook`, and `ProtocolPipeline.observe` Contributions while sharing DOM observers, global event listeners, function wrappers, and protocol decoding. Cross-host static-resource, process, and Runner adapters remain visible in the complete catalog; expanding one to a terminal declaration in a browser plugin fails explicitly at commit time.

## Settings and lifecycle

The manifest is registered with the existing settings system first. Once committed, the host activates the plugin only when it is enabled and the `renderer` scope is active. Disabling it disposes mounts, listeners, and shared-resource references in reverse order. Re-enabling performs fresh location and mounting.

Preferences remain in `opencodex_web_settings_v1`, under `plugin.<plugin-id>.enabled` by default. Chinese translations are loaded as the fallback, then the active locale overrides matching keys.

## Removed legacy contract

These entry styles are no longer supported:

```text
<plugin>/index.js
window.OpenCodexPluginSystem.registerPlugin({ activate() { /* direct DOM access */ } })
```

Built-in DOM, Bridge, and protocol implementations now live under `web-shell/internal/providers`; `web-shell/plugins` contains settings manifests and translations only. External plugins should declare modifications exclusively through the v2 SDK.
