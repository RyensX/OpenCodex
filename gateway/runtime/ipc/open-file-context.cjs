const OPEN_FILE_FETCH_PATH = "/open-file";
const VSCODE_CODEX_ORIGIN = "vscode://codex";

function parseObjectJson(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function openFileTargetFromCandidate(candidate) {
  if (!candidate || typeof candidate !== "object") return "";
  if (typeof candidate.target === "string") return candidate.target;
  if (candidate.params && typeof candidate.params === "object" && typeof candidate.params.target === "string") {
    return candidate.params.target;
  }
  return "";
}

function fetchPayloadUrlPath(payload) {
  if (!payload || typeof payload !== "object" || payload.type !== "fetch" || typeof payload.url !== "string") {
    return "";
  }
  try {
    // 官方 renderer 把 vscode://codex/open-file 包在 fetch IPC 里发给 main。
    return new URL(payload.url, VSCODE_CODEX_ORIGIN).pathname;
  } catch {
    return "";
  }
}

function openFileTargetFromFetchPayload(payload) {
  if (fetchPayloadUrlPath(payload) !== OPEN_FILE_FETCH_PATH) return "";
  const body = parseObjectJson(payload.body);
  return openFileTargetFromCandidate(body);
}

function openFileTargetFromPayload(payload) {
  const candidates = Array.isArray(payload) ? payload : [payload];
  for (const candidate of candidates) {
    const directTarget = openFileTargetFromCandidate(candidate);
    if (directTarget) return directTarget;
    const fetchTarget = openFileTargetFromFetchPayload(candidate);
    if (fetchTarget) return fetchTarget;
  }
  return "";
}

function openFileTargetFromIpc(channel, payload) {
  if (channel === "open-file") return openFileTargetFromPayload(payload);
  // 当前官方 bundle 的菜单点击会走 message-from-view + fetch(vscode://codex/open-file)。
  return openFileTargetFromPayload(payload);
}

module.exports = {
  openFileTargetFromIpc,
  openFileTargetFromPayload,
};
