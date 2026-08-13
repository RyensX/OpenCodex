(function () {
  const w = window;
  if (w.OpenCodexGatewayPluginSwitches) return;

  const PENDING_STORAGE_KEY = "opencodex_gateway_plugin_enable_pending_v1";
  const PENDING_COOKIE_NAME = "opencodex_gateway_plugin_sync_pending";

  function loadPending() {
    try {
      const value = JSON.parse(localStorage.getItem(PENDING_STORAGE_KEY) || "{}");
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch {
      return {};
    }
  }

  function savePending(value) {
    const pending = value && typeof value === "object" ? value : {};
    try {
      localStorage.setItem(PENDING_STORAGE_KEY, JSON.stringify(pending));
    } catch {}
    try {
      // 服务端只读取“是否存在待同步操作”，具体插件和值仍留在同源 localStorage 中。
      document.cookie = Object.keys(pending).length > 0
        ? `${PENDING_COOKIE_NAME}=1; Path=/; SameSite=Lax`
        : `${PENDING_COOKIE_NAME}=; Path=/; SameSite=Lax; Max-Age=0`;
    } catch {}
  }

  function create({ pluginSystem, plugins, request }) {
    if (!pluginSystem?.plugins || typeof plugins !== "function" || typeof request !== "function") return null;

    function gatewayPlugins() {
      return plugins().filter((plugin) => plugin.persistence === "gateway");
    }

    function localEnabled(plugin) {
      return pluginSystem.plugins.isEnabled(plugin.id);
    }

    function setLocalEnabled(plugin, enabled) {
      pluginSystem.plugins.setEnabled(plugin.id, enabled === true);
    }

    function markPending(pluginId, enabled) {
      const pending = loadPending();
      pending[pluginId] = enabled !== false;
      savePending(pending);
    }

    async function patchEnabled(plugin, enabled, config) {
      try {
        return await request(`/api/opencodex/plugins/${encodeURIComponent(plugin.id)}/config`, {
          method: "PATCH",
          body: JSON.stringify({ expectedRevision: config.revision, enabled }),
        });
      } catch (error) {
        if (error.status !== 409 || !error.value?.current) throw error;
        const latest = error.value.current;
        const remote = (latest.plugins || []).find((item) => item.id === plugin.id);
        if (remote?.enabled === enabled) return latest;
        // revision 冲突只基于服务端返回的新快照重试一次，防止多个登录页互相死循环覆盖。
        return request(`/api/opencodex/plugins/${encodeURIComponent(plugin.id)}/config`, {
          method: "PATCH",
          body: JSON.stringify({ expectedRevision: latest.revision, enabled }),
        });
      }
    }

    async function sync() {
      const available = gatewayPlugins();
      const pending = loadPending();
      const availableIds = new Set(available.map((plugin) => plugin.id));
      // 已卸载插件不再有可提交目标，清掉其遗留意图，避免认证入口永久退回兼容壳。
      for (const pluginId of Object.keys(pending)) {
        if (!availableIds.has(pluginId)) delete pending[pluginId];
      }
      savePending(pending);
      if (available.length === 0) return;
      let config = await request("/api/opencodex/plugins/config");
      for (const plugin of available) {
        const remote = (config.plugins || []).find((item) => item.id === plugin.id);
        if (!remote) continue;
        if (!Object.prototype.hasOwnProperty.call(pending, plugin.id)) {
          // 没有待提交操作时以网关为准，旧浏览器不会在下次登录时覆盖其它设备的新选择。
          setLocalEnabled(plugin, remote.enabled);
          continue;
        }
        const enabled = localEnabled(plugin);
        if (remote.enabled !== enabled) config = await patchEnabled(plugin, enabled, config);
        delete pending[plugin.id];
        savePending(pending);
      }
    }

    return Object.freeze({ markPending, sync });
  }

  w.OpenCodexGatewayPluginSwitches = Object.freeze({ PENDING_COOKIE_NAME, PENDING_STORAGE_KEY, create });
})();
