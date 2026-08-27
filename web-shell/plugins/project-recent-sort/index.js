(function () {
  const w = window;
  const pluginSystem = w.OpenCodexPluginSystem || w.__OpenCodexPluginSystem;
  if (!pluginSystem || typeof pluginSystem.registerPlugin !== "function") return;

  const FLAT_SIDEBAR_PREFERENCES_KEY = "flat-project-sidebar-preferences-v1";
  const LEGACY_SIDEBAR_SORT_MODE_KEY = "codex-sidebar-sort-mode-v1";
  const PROJECT_ORDER_KEY = "project-order";
  const RECENT_SORT_MODES = new Set(["created_at", "updated_at"]);
  const GET_GLOBAL_STATE_URL = "vscode://codex/get-global-state";
  const BRIDGE_INSTALL_RETRY_MS = 20;
  const BRIDGE_INSTALL_MAX_ATTEMPTS = 100;

  function plainObject(value) {
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
    if (typeof value !== "string" || value.trim() === "") return null;
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  function normalizedSortMode(value) {
    return typeof value === "string" ? value : null;
  }

  function fetchParams(payload) {
    if (!payload || typeof payload !== "object" || payload.type !== "fetch") return null;
    if (String(payload.url || "").replace(/\/+$/, "").toLowerCase() !== GET_GLOBAL_STATE_URL) return null;
    return plainObject(payload.body);
  }

  function isProjectOrderFetch(payload) {
    return fetchParams(payload)?.key === PROJECT_ORDER_KEY;
  }

  function cloneBootstrapWithRecentProjectOrder(bootstrap) {
    if (!bootstrap || typeof bootstrap !== "object" || !Array.isArray(bootstrap.globalStateEntries)) {
      return bootstrap;
    }

    let replaced = false;
    const globalStateEntries = bootstrap.globalStateEntries.map((entry) => {
      if (!entry || typeof entry !== "object" || entry.key !== PROJECT_ORDER_KEY) return entry;
      replaced = true;
      return { ...entry, value: [] };
    });
    if (!replaced) globalStateEntries.push({ key: PROJECT_ORDER_KEY, value: [] });
    return { ...bootstrap, globalStateEntries };
  }

  pluginSystem.registerPlugin({
    id: "opencodex.project-recent-sort",
    name: "Project recent sort",
    labelKey: "plugin.projectRecentSort.label",
    label: "项目最近更新排序",
    descKey: "plugin.projectRecentSort.desc",
    desc: "让“最近更新”同时按项目最新活动排序，并保留“手动排序”的项目顺序。",
    enableStorageKey: "projectRecentSort",
    defaultEnabled: true,
    builtin: true,
    order: 40,
    activate(context) {
      if (context.scope !== "renderer") return null;
      w.OpenCodexRuntimeCompatibility?.active?.("web.runtime.plugin.project-recent-sort");

      const persistedSnapshot =
        w.__CODEX_WEB_CONFIG__?.persistedAtomSnapshot &&
        typeof w.__CODEX_WEB_CONFIG__.persistedAtomSnapshot === "object"
          ? w.__CODEX_WEB_CONFIG__.persistedAtomSnapshot
          : {};
      let flatSidebarPreferences = plainObject(persistedSnapshot[FLAT_SIDEBAR_PREFERENCES_KEY]);
      let legacySidebarSortMode = normalizedSortMode(persistedSnapshot[LEGACY_SIDEBAR_SORT_MODE_KEY]);
      let disposed = false;
      let installAttempts = 0;
      let installTimer = null;
      let unsubscribePersistedAtom = null;
      const bridgePatches = [];

      function usesRecentProjectSort() {
        // 旧版统一排序状态仍会覆盖新版项目排序状态，因此必须按官方优先级一起判断。
        const effectiveSortMode =
          legacySidebarSortMode ?? normalizedSortMode(flatSidebarPreferences?.projectSortMode) ?? "priority";
        return RECENT_SORT_MODES.has(effectiveSortMode);
      }

      function emitRendererMessage(type, payload) {
        const detail = payload && typeof payload === "object" ? payload : {};
        try {
          w.__codexWebDispatch?.(type, detail);
        } catch {}
        try {
          w.postMessage({ type, ...detail }, w.location?.origin || "*");
        } catch {}
      }

      function emitProjectOrderInvalidation() {
        // 官方 renderer 已支持该事件；触发失效后会重新读取 project-order 并立即重排项目。
        emitRendererMessage("global-state-updated", { keys: [PROJECT_ORDER_KEY] });
      }

      function emitProjectOrderFetchResponse(requestId) {
        if (requestId == null || requestId === "") return;
        emitRendererMessage("fetch-response", {
          requestId: String(requestId),
          responseType: "success",
          status: 200,
          headers: { "content-type": "application/json" },
          bodyJsonString: JSON.stringify({ value: [] }),
        });
      }

      function updateSidebarPreference(payload) {
        if (!payload || typeof payload !== "object" || payload.type !== "persisted-atom-update") return;
        if (
          payload.key !== FLAT_SIDEBAR_PREFERENCES_KEY &&
          payload.key !== LEGACY_SIDEBAR_SORT_MODE_KEY
        ) {
          return;
        }

        const wasRecent = usesRecentProjectSort();
        if (payload.key === FLAT_SIDEBAR_PREFERENCES_KEY) {
          flatSidebarPreferences = payload.deleted ? null : plainObject(payload.value);
        } else {
          legacySidebarSortMode = payload.deleted ? null : normalizedSortMode(payload.value);
        }
        if (wasRecent !== usesRecentProjectSort()) emitProjectOrderInvalidation();
      }

      function handlePersistedAtomUpdated(...args) {
        const payload = args.length > 1 ? args[args.length - 1] : args[0];
        updateSidebarPreference({
          type: "persisted-atom-update",
          ...(payload && typeof payload === "object" ? payload : {}),
        });
      }

      function patchBridge(bridge) {
        if (!bridge || typeof bridge !== "object") return false;
        const patch = {
          bridge,
          originalBootstrap: null,
          originalSend: null,
          wrappedBootstrap: null,
          wrappedSend: null,
        };

        if (typeof bridge.sendMessageFromView === "function") {
          patch.originalSend = bridge.sendMessageFromView;
          patch.wrappedSend = function (...args) {
            const payload = args[0];
            // 在官方 atom 广播到达前先更新模式，确保紧随其后的项目顺序读取使用正确语义。
            updateSidebarPreference(payload);
            if (usesRecentProjectSort() && isProjectOrderFetch(payload)) {
              emitProjectOrderFetchResponse(payload.requestId);
              return Promise.resolve(true);
            }
            return patch.originalSend.apply(this, args);
          };
          bridge.sendMessageFromView = patch.wrappedSend;
        }

        if (typeof bridge.getInitialSidebarBootstrap === "function") {
          patch.originalBootstrap = bridge.getInitialSidebarBootstrap;
          patch.wrappedBootstrap = function (...args) {
            const bootstrap = patch.originalBootstrap.apply(this, args);
            return usesRecentProjectSort() ? cloneBootstrapWithRecentProjectOrder(bootstrap) : bootstrap;
          };
          bridge.getInitialSidebarBootstrap = patch.wrappedBootstrap;
        }

        if (!patch.originalSend && !patch.originalBootstrap) return false;
        bridgePatches.push(patch);
        return true;
      }

      function restoreBridges() {
        for (const patch of bridgePatches.splice(0)) {
          if (patch.originalSend && patch.bridge.sendMessageFromView === patch.wrappedSend) {
            patch.bridge.sendMessageFromView = patch.originalSend;
          }
          if (patch.originalBootstrap && patch.bridge.getInitialSidebarBootstrap === patch.wrappedBootstrap) {
            patch.bridge.getInitialSidebarBootstrap = patch.originalBootstrap;
          }
        }
      }

      function installBridgePatches() {
        if (disposed) return;
        installAttempts += 1;
        const bridges = Array.from(
          new Set([w.electronBridge, w.codexBridge, w.electronAPI].filter((bridge) => bridge && typeof bridge === "object"))
        );
        let installed = false;
        for (const bridge of bridges) installed = patchBridge(bridge) || installed;
        if (!installed) {
          if (installAttempts < BRIDGE_INSTALL_MAX_ATTEMPTS && typeof w.setTimeout === "function") {
            installTimer = w.setTimeout(installBridgePatches, BRIDGE_INSTALL_RETRY_MS);
          }
          return;
        }

        const eventBridge = w.electronBridge || bridges[0];
        if (typeof eventBridge?.on === "function") {
          const unsubscribe = eventBridge.on("persisted-atom-updated", handlePersistedAtomUpdated);
          if (typeof unsubscribe === "function") unsubscribePersistedAtom = unsubscribe;
        }
        // 插件也支持在 renderer 已启动后启用；主动失效一次即可覆盖已有 query 缓存。
        emitProjectOrderInvalidation();
      }

      if (typeof w.queueMicrotask === "function") {
        w.queueMicrotask(installBridgePatches);
      } else {
        Promise.resolve().then(installBridgePatches);
      }

      return () => {
        disposed = true;
        if (installTimer != null && typeof w.clearTimeout === "function") w.clearTimeout(installTimer);
        unsubscribePersistedAtom?.();
        restoreBridges();
        // 停用插件后让官方重新读取真实项目顺序，避免虚拟空顺序残留在 query 缓存中。
        emitProjectOrderInvalidation();
      };
    },
  });
})();
