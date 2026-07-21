const { isRequestBodyTooLargeError, readBody, sendJson } = require("./http-utils.cjs");
const { PluginConfigError } = require("../plugins/config-store.cjs");

const PLUGIN_CONFIG_BODY_MAX_BYTES = 128 * 1024;
const PLUGIN_CONFIG_PREFIX = "/api/opencodex/plugins/";

function pluginIdFromPath(pathname) {
  if (!pathname.startsWith(PLUGIN_CONFIG_PREFIX) || !pathname.endsWith("/config")) return "";
  const encoded = pathname.slice(PLUGIN_CONFIG_PREFIX.length, -"/config".length);
  if (!encoded || encoded.includes("/")) return "";
  try {
    return decodeURIComponent(encoded);
  } catch {
    return "";
  }
}

async function handlePluginConfigPatch(req, res, pluginService, pluginId) {
  let parsed;
  try {
    parsed = JSON.parse((await readBody(req, { maxBytes: PLUGIN_CONFIG_BODY_MAX_BYTES })) || "{}");
  } catch (error) {
    const status = isRequestBodyTooLargeError(error) ? 413 : 400;
    return sendJson(res, status, { ok: false, error: status === 413 ? "Request body is too large" : "Invalid JSON body" });
  }
  try {
    const snapshot = pluginService.configStore.update(pluginId, parsed);
    return sendJson(res, 200, { ok: true, ...snapshot }, { "cache-control": "no-store" });
  } catch (error) {
    const status = error instanceof PluginConfigError ? error.status : 500;
    const response = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      ...(error?.errorKey ? { errorKey: error.errorKey } : {}),
    };
    if (status === 409) response.current = pluginService.configStore.snapshot();
    return sendJson(res, status, response, { "cache-control": "no-store" });
  }
}

async function handleOpenCodexPluginApi(req, res, url, pluginService) {
  if (!pluginService) return false;
  const pathname = url.pathname;
  if (pathname === "/api/opencodex/plugins/config") {
    if (req.method !== "GET") {
      sendJson(res, 405, { ok: false, error: "Method Not Allowed" }, { allow: "GET" });
      return true;
    }
    sendJson(res, 200, { ok: true, ...pluginService.configStore.snapshot() }, { "cache-control": "no-store" });
    return true;
  }
  if (pathname === "/api/opencodex/models") {
    if (req.method !== "GET") {
      sendJson(res, 405, { ok: false, error: "Method Not Allowed" }, { allow: "GET" });
      return true;
    }
    const models = await pluginService.modelRouter.listModels();
    sendJson(
      res,
      200,
      { ok: true, models, router: pluginService.modelRouter.diagnostics() },
      { "cache-control": "no-store" }
    );
    return true;
  }
  const pluginId = pluginIdFromPath(pathname);
  if (!pluginId) return false;
  if (req.method !== "PATCH") {
    sendJson(res, 405, { ok: false, error: "Method Not Allowed" }, { allow: "PATCH" });
    return true;
  }
  await handlePluginConfigPatch(req, res, pluginService, pluginId);
  return true;
}

module.exports = {
  PLUGIN_CONFIG_BODY_MAX_BYTES,
  handleOpenCodexPluginApi,
  handlePluginConfigPatch,
  pluginIdFromPath,
};
