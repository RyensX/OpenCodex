(function () {
  const w = window;
  const modificationEffects = w.__OpenCodexCurrentProviderScope?.effects;
  const adapterHost = w.__OpenCodexAdapterHost;
  const scheduler = adapterHost?.scheduler?.capture?.() || w;
  const pluginSystem = w.OpenCodexPluginSystem || w.__OpenCodexPluginSystem;
  if (!pluginSystem || typeof pluginSystem.registerPlugin !== "function") return;
  const registerPlugin = adapterHost?.plugins?.register
    ? (plugin) => adapterHost.plugins.register(pluginSystem, plugin)
    : pluginSystem.registerPlugin.bind(pluginSystem);

  const FLAT_SIDEBAR_PREFERENCES_KEY = "flat-project-sidebar-preferences-v1";
  const LEGACY_SIDEBAR_SORT_MODE_KEY = "codex-sidebar-sort-mode-v1";
  const LOCAL_PROJECTS_KEY = "local-projects";
  const REMOTE_PROJECTS_KEY = "remote-projects";
  const PROJECT_ORDER_KEY = "project-order";
  const THREAD_PROJECT_ASSIGNMENTS_KEY = "thread-project-assignments";
  const RECENT_SORT_MODES = new Set(["created_at", "updated_at"]);
  const TRACKED_GLOBAL_STATE_KEYS = new Set([
    LOCAL_PROJECTS_KEY,
    REMOTE_PROJECTS_KEY,
    PROJECT_ORDER_KEY,
    THREAD_PROJECT_ASSIGNMENTS_KEY,
  ]);
  const PROTOCOL_ENVELOPE_KEYS = ["message", "request", "response", "payload", "notification"];
  const GET_GLOBAL_STATE_URL = "vscode://codex/get-global-state";
  const BRIDGE_INSTALL_RETRY_MS = 20;
  const BRIDGE_INSTALL_MAX_ATTEMPTS = 100;
  const MAX_PENDING_REQUESTS = 1024;
  const MAX_PROJECTS = 2048;
  const MAX_PROTOCOL_SCAN_NODES = 256;
  const MAX_THREADS = 8192;

  function parsedJson(value) {
    if (typeof value !== "string") return value;
    const source = value.trim();
    if (!source || (!source.startsWith("{") && !source.startsWith("["))) return value;
    try {
      return JSON.parse(source);
    } catch {
      return value;
    }
  }

  function plainObject(value) {
    const parsed = parsedJson(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  }

  function stringArray(value) {
    return Array.isArray(value) ? value.filter((item) => typeof item === "string" && item) : [];
  }

  function normalizedSortMode(value) {
    return typeof value === "string" ? value : null;
  }

  function timestampMs(value) {
    if (typeof value === "string" && value.trim()) {
      const numeric = Number(value);
      if (Number.isFinite(numeric)) return timestampMs(numeric);
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) ? parsed : null;
    }
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
    // App Server 的 thread 时间使用秒，renderer/project 快照通常已经使用毫秒。
    return value < 100_000_000_000 ? value * 1000 : value;
  }

  function normalizedPath(value) {
    if (typeof value !== "string" || !value.trim()) return null;
    let path = value.trim();
    if (/^file:\/\//i.test(path)) {
      try {
        path = decodeURIComponent(new URL(path).pathname);
      } catch {}
    }
    path = path.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
    if (path.length > 1) path = path.replace(/\/+$/, "");
    const windowsPath = /^\/?[A-Za-z]:\//.test(path);
    return { comparable: windowsPath ? path.toLowerCase() : path, path };
  }

  function pathContains(root, candidate) {
    if (!root || !candidate) return false;
    return candidate === root || candidate.startsWith(root === "/" ? root : `${root}/`);
  }

  function sameArray(left, right) {
    return left === right ||
      (Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => item === right[index]));
  }

  function trimMap(map, limit) {
    while (map.size > limit) map.delete(map.keys().next().value);
  }

  function fetchRequestKey(payload) {
    if (!payload || typeof payload !== "object" || payload.type !== "fetch") return null;
    if (String(payload.url || "").replace(/\/+$/, "").toLowerCase() !== GET_GLOBAL_STATE_URL) return null;
    const body = plainObject(payload.body);
    const key = body?.key ?? plainObject(body?.params)?.key;
    return typeof key === "string" ? key : null;
  }

  function responseBody(payload) {
    if (!payload || typeof payload !== "object") return null;
    if (Object.prototype.hasOwnProperty.call(payload, "body")) return plainObject(payload.body);
    return plainObject(payload.bodyJsonString);
  }

  function withResponseBody(payload, body) {
    if (Object.prototype.hasOwnProperty.call(payload, "body")) return { ...payload, body };
    return { ...payload, bodyJsonString: JSON.stringify(body) };
  }

  registerPlugin({
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
      if (!adapterHost?.hooks?.around || !adapterHost?.protocol?.transform) return null;

      const persistedSnapshot =
        w.__CODEX_WEB_CONFIG__?.persistedAtomSnapshot &&
        typeof w.__CODEX_WEB_CONFIG__.persistedAtomSnapshot === "object"
          ? w.__CODEX_WEB_CONFIG__.persistedAtomSnapshot
          : {};
      let flatSidebarPreferences = plainObject(persistedSnapshot[FLAT_SIDEBAR_PREFERENCES_KEY]);
      let legacySidebarSortMode = normalizedSortMode(persistedSnapshot[LEGACY_SIDEBAR_SORT_MODE_KEY]);
      let officialProjectOrder = [];
      let projectSequence = 0;
      let threadSequence = 0;
      let disposed = false;
      let installAttempts = 0;
      let installTimer = null;
      let invalidationScheduled = false;
      let unsubscribePersistedAtom = null;
      const projects = new Map();
      const threads = new Map();
      const threadProjectAssignments = new Map();
      const pendingFetchKeys = new Map();
      const pendingRpcRequests = new Map();
      const bridgePatches = [];
      const transformedProtocols = [];
      const patchedBridges = new WeakSet();

      function effectiveSortMode() {
        // 与官方优先级一致：升级前的统一排序状态仍然可以覆盖新版项目排序状态。
        return legacySidebarSortMode ?? normalizedSortMode(flatSidebarPreferences?.projectSortMode) ?? "priority";
      }

      function usesRecentProjectSort() {
        return RECENT_SORT_MODES.has(effectiveSortMode());
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
        emitRendererMessage("global-state-updated", { keys: [PROJECT_ORDER_KEY] });
      }

      function scheduleProjectOrderInvalidation() {
        if (disposed || invalidationScheduled || !usesRecentProjectSort()) return;
        invalidationScheduled = true;
        const flush = () => {
          invalidationScheduled = false;
          if (!disposed && usesRecentProjectSort()) emitProjectOrderInvalidation();
        };
        if (typeof w.queueMicrotask === "function") w.queueMicrotask(flush);
        else Promise.resolve().then(flush);
      }

      function projectPaths(project) {
        const roots = [
          ...(Array.isArray(project?.rootPaths) ? project.rootPaths : []),
          project?.path,
          project?.remotePath,
          ...(Array.isArray(project?.rootPathAliases)
            ? project.rootPathAliases.flatMap((entry) => [entry?.path, entry?.alias])
            : []),
        ];
        const seen = new Set();
        return roots.flatMap((root) => {
          const normalized = normalizedPath(root);
          if (!normalized || seen.has(normalized.comparable)) return [];
          seen.add(normalized.comparable);
          return [normalized];
        });
      }

      function rememberProject(projectId, value, kind) {
        const id = typeof projectId === "string" && projectId ? projectId : value?.projectId || value?.id;
        if (typeof id !== "string" || !id) return false;
        const previous = projects.get(id);
        const paths = projectPaths(value);
        const next = {
          createdAt: timestampMs(value?.projectCreatedAt ?? value?.createdAt),
          hostId: typeof value?.hostId === "string" && value.hostId ? value.hostId : kind === "local" ? "local" : "",
          id,
          kind,
          paths,
          sequence: previous?.sequence ?? projectSequence++,
          updatedAt: timestampMs(value?.projectUpdatedAt ?? value?.updatedAt),
        };
        const unchanged =
          previous &&
          previous.createdAt === next.createdAt &&
          previous.hostId === next.hostId &&
          previous.kind === next.kind &&
          previous.updatedAt === next.updatedAt &&
          sameArray(previous.paths.map((entry) => entry.comparable), next.paths.map((entry) => entry.comparable));
        if (unchanged) return false;
        projects.delete(id);
        projects.set(id, next);
        trimMap(projects, MAX_PROJECTS);
        return true;
      }

      function replaceProjects(kind, value) {
        const seen = new Set();
        let changed = false;
        if (kind === "local") {
          const entries = plainObject(value) || {};
          for (const [projectId, project] of Object.entries(entries)) {
            if (!project || typeof project !== "object") continue;
            seen.add(projectId);
            changed = rememberProject(projectId, project, kind) || changed;
          }
        } else {
          const entries = Array.isArray(value) ? value : Object.values(plainObject(value) || {});
          for (const project of entries) {
            if (!project || typeof project !== "object") continue;
            const projectId = project.id ?? project.projectId;
            if (typeof projectId !== "string" || !projectId) continue;
            seen.add(projectId);
            changed = rememberProject(projectId, project, kind) || changed;
          }
        }
        for (const [projectId, project] of [...projects]) {
          if (project.kind !== kind || seen.has(projectId)) continue;
          projects.delete(projectId);
          changed = true;
        }
        return changed;
      }

      function replaceThreadProjectAssignments(value) {
        const entries = plainObject(value) || {};
        const next = new Map();
        for (const [threadId, assignment] of Object.entries(entries)) {
          if (!assignment || typeof assignment !== "object") continue;
          const projectId = assignment.projectId;
          if (typeof projectId !== "string" || !projectId) continue;
          next.set(threadId, {
            hostId: typeof assignment.hostId === "string" ? assignment.hostId : "",
            projectId,
          });
        }
        const unchanged =
          next.size === threadProjectAssignments.size &&
          [...next].every(([threadId, assignment]) => {
            const previous = threadProjectAssignments.get(threadId);
            return previous?.projectId === assignment.projectId && previous?.hostId === assignment.hostId;
          });
        if (unchanged) return false;
        threadProjectAssignments.clear();
        for (const [threadId, assignment] of next) threadProjectAssignments.set(threadId, assignment);
        return true;
      }

      function rememberGlobalState(key, value) {
        if (key === LOCAL_PROJECTS_KEY) return replaceProjects("local", value);
        if (key === REMOTE_PROJECTS_KEY) return replaceProjects("remote", value);
        if (key === THREAD_PROJECT_ASSIGNMENTS_KEY) return replaceThreadProjectAssignments(value);
        if (key === PROJECT_ORDER_KEY) {
          const nextOrder = stringArray(value);
          const changed = !sameArray(officialProjectOrder, nextOrder);
          officialProjectOrder = nextOrder;
          return changed;
        }
        return false;
      }

      function directProjectId(thread, threadId) {
        const direct = thread?.projectId ?? thread?.project?.id ?? thread?.project?.projectId;
        if (typeof direct === "string" && direct) return direct;
        return threadProjectAssignments.get(threadId)?.projectId || null;
      }

      function rememberThread(value, fallbackHostId = "", activityOverride = null) {
        const source = value?.thread ?? value?.task?.conversation ?? value?.task ?? value;
        if (!source || typeof source !== "object") return false;
        const id = source.id ?? source.threadId ?? source.conversationId ?? value?.threadId ?? value?.conversationId;
        if (typeof id !== "string" || !id) return false;
        const previous = threads.get(id);
        const recencyAt = timestampMs(source.recencyAt ?? source.recency_at);
        const updatedAt = timestampMs(source.updatedAt ?? source.updated_at);
        const override = timestampMs(activityOverride);
        const next = {
          createdAt: timestampMs(source.createdAt ?? source.created_at) ?? previous?.createdAt ?? null,
          cwd: typeof source.cwd === "string" && source.cwd ? source.cwd : previous?.cwd ?? "",
          hostId:
            (typeof source.hostId === "string" && source.hostId) ||
            (typeof fallbackHostId === "string" && fallbackHostId) ||
            previous?.hostId ||
            "",
          id,
          projectId: directProjectId(source, id) ?? previous?.projectId ?? null,
          recencyAt: Math.max(previous?.recencyAt || 0, recencyAt || 0, updatedAt || 0, override || 0) || null,
          sequence: previous?.sequence ?? threadSequence++,
          updatedAt: Math.max(previous?.updatedAt || 0, updatedAt || 0, override || 0) || null,
        };
        const unchanged =
          previous &&
          previous.createdAt === next.createdAt &&
          previous.cwd === next.cwd &&
          previous.hostId === next.hostId &&
          previous.projectId === next.projectId &&
          previous.recencyAt === next.recencyAt &&
          previous.updatedAt === next.updatedAt;
        if (unchanged) return false;
        threads.delete(id);
        threads.set(id, next);
        trimMap(threads, MAX_THREADS);
        return true;
      }

      function resolveThreadProjectId(thread) {
        if (thread.projectId) return thread.projectId;
        const assignment = threadProjectAssignments.get(thread.id);
        if (assignment?.projectId) return assignment.projectId;
        const cwd = normalizedPath(thread.cwd);
        if (!cwd) return null;
        let best = null;
        for (const project of projects.values()) {
          if (
            thread.hostId &&
            project.hostId &&
            thread.hostId !== project.hostId &&
            !(thread.hostId === "local" && project.kind === "local")
          ) {
            continue;
          }
          for (const root of project.paths) {
            if (!pathContains(root.comparable, cwd.comparable)) continue;
            if (!best || root.comparable.length > best.pathLength) {
              best = { pathLength: root.comparable.length, projectId: project.id };
            }
          }
        }
        return best?.projectId || null;
      }

      function projectOrderForRecent(sourceOrder = officialProjectOrder) {
        const sortMode = effectiveSortMode();
        const candidates = new Map();
        const sourceIndex = new Map(stringArray(sourceOrder).map((projectId, index) => [projectId, index]));
        const addCandidate = (projectId) => {
          if (typeof projectId !== "string" || !projectId || candidates.has(projectId)) return;
          candidates.set(projectId, candidates.size);
        };
        for (const projectId of stringArray(sourceOrder)) addCandidate(projectId);
        for (const projectId of projects.keys()) addCandidate(projectId);
        for (const assignment of threadProjectAssignments.values()) addCandidate(assignment.projectId);
        for (const thread of threads.values()) addCandidate(resolveThreadProjectId(thread));

        const threadScores = new Map();
        for (const thread of threads.values()) {
          const projectId = resolveThreadProjectId(thread);
          if (!projectId) continue;
          const score = sortMode === "created_at"
            ? thread.createdAt
            : thread.recencyAt ?? thread.updatedAt;
          if (score == null) continue;
          threadScores.set(projectId, Math.max(threadScores.get(projectId) || 0, score));
        }

        return [...candidates.keys()].sort((leftId, rightId) => {
          const leftProject = projects.get(leftId);
          const rightProject = projects.get(rightId);
          const leftScore = threadScores.get(leftId) ??
            (sortMode === "created_at" ? leftProject?.createdAt : leftProject?.updatedAt ?? leftProject?.createdAt) ??
            Number.NEGATIVE_INFINITY;
          const rightScore = threadScores.get(rightId) ??
            (sortMode === "created_at" ? rightProject?.createdAt : rightProject?.updatedAt ?? rightProject?.createdAt) ??
            Number.NEGATIVE_INFINITY;
          if (leftScore !== rightScore) return rightScore - leftScore;
          const leftSourceIndex = sourceIndex.get(leftId);
          const rightSourceIndex = sourceIndex.get(rightId);
          if (leftSourceIndex != null || rightSourceIndex != null) {
            return (leftSourceIndex ?? Number.MAX_SAFE_INTEGER) - (rightSourceIndex ?? Number.MAX_SAFE_INTEGER);
          }
          return (leftProject?.sequence ?? candidates.get(leftId) ?? 0) -
            (rightProject?.sequence ?? candidates.get(rightId) ?? 0);
        });
      }

      function captureBootstrap(bootstrap) {
        if (!bootstrap || typeof bootstrap !== "object") return false;
        let changed = false;
        for (const entry of Array.isArray(bootstrap.globalStateEntries) ? bootstrap.globalStateEntries : []) {
          if (!entry || typeof entry !== "object" || typeof entry.key !== "string") continue;
          changed = rememberGlobalState(entry.key, entry.value) || changed;
        }
        for (const entry of Array.isArray(bootstrap.catalogSnapshot?.entries) ? bootstrap.catalogSnapshot.entries : []) {
          changed = rememberThread(entry, entry?.hostId) || changed;
        }
        return changed;
      }

      function bootstrapWithRecentProjectOrder(bootstrap) {
        if (!bootstrap || typeof bootstrap !== "object" || !Array.isArray(bootstrap.globalStateEntries)) return bootstrap;
        captureBootstrap(bootstrap);
        const projectOrder = projectOrderForRecent(officialProjectOrder);
        let replaced = false;
        const globalStateEntries = bootstrap.globalStateEntries.map((entry) => {
          if (!entry || typeof entry !== "object" || entry.key !== PROJECT_ORDER_KEY) return entry;
          replaced = true;
          return { ...entry, value: projectOrder };
        });
        if (!replaced) globalStateEntries.push({ key: PROJECT_ORDER_KEY, value: projectOrder });
        modificationEffects?.primary?.emit();
        return { ...bootstrap, globalStateEntries };
      }

      function updateSidebarPreference(payload) {
        if (!payload || typeof payload !== "object" || payload.type !== "persisted-atom-update") return false;
        if (payload.key !== FLAT_SIDEBAR_PREFERENCES_KEY && payload.key !== LEGACY_SIDEBAR_SORT_MODE_KEY) return false;
        const wasRecent = usesRecentProjectSort();
        if (payload.key === FLAT_SIDEBAR_PREFERENCES_KEY) {
          flatSidebarPreferences = payload.deleted ? null : plainObject(payload.value);
        } else {
          legacySidebarSortMode = payload.deleted ? null : normalizedSortMode(payload.value);
        }
        const isRecent = usesRecentProjectSort();
        if (wasRecent !== isRecent) {
          if (isRecent) scheduleProjectOrderInvalidation();
          else emitProjectOrderInvalidation();
        } else if (isRecent) {
          scheduleProjectOrderInvalidation();
        }
        return true;
      }

      function rememberPendingFetch(payload) {
        const key = fetchRequestKey(payload);
        const requestId = payload?.requestId;
        if (!TRACKED_GLOBAL_STATE_KEYS.has(key) || requestId == null || requestId === "") return key;
        pendingFetchKeys.delete(String(requestId));
        pendingFetchKeys.set(String(requestId), key);
        trimMap(pendingFetchKeys, MAX_PENDING_REQUESTS);
        return key;
      }

      function handleFetchResponse(payload) {
        if (!payload || typeof payload !== "object") return payload;
        const requestId = payload.requestId == null ? "" : String(payload.requestId);
        const key = requestId ? pendingFetchKeys.get(requestId) : null;
        if (requestId) pendingFetchKeys.delete(requestId);
        if (!key || payload.responseType === "error") return payload;
        const body = responseBody(payload);
        if (!body) return payload;
        if (rememberGlobalState(key, body.value) && key !== PROJECT_ORDER_KEY) scheduleProjectOrderInvalidation();
        if (key !== PROJECT_ORDER_KEY || !usesRecentProjectSort()) return payload;
        const projectOrder = projectOrderForRecent(stringArray(body.value));
        officialProjectOrder = stringArray(body.value);
        modificationEffects?.primary?.emit();
        return withResponseBody(payload, { ...body, value: projectOrder });
      }

      function requestIdOf(value) {
        const id = value?.id ?? value?.requestId;
        return id == null || id === "" ? "" : String(id);
      }

      function hostIdOf(value, fallback = "") {
        return typeof value?.hostId === "string" && value.hostId ? value.hostId : fallback;
      }

      function rememberRpcRequest(request, hostId) {
        if (!request || typeof request !== "object" || typeof request.method !== "string") return false;
        const requestId = requestIdOf(request);
        if (requestId) {
          pendingRpcRequests.delete(requestId);
          pendingRpcRequests.set(requestId, { hostId, method: request.method, params: request.params });
          trimMap(pendingRpcRequests, MAX_PENDING_REQUESTS);
        }
        if (request.method === "turn/start") {
          const threadId = request.params?.threadId ?? request.params?.conversationId;
          if (typeof threadId === "string" && rememberThread({ id: threadId }, hostId, Date.now())) {
            scheduleProjectOrderInvalidation();
          }
        }
        return true;
      }

      function rememberThreadCollection(value, hostId) {
        const candidates = [value?.data, value?.threads, value?.items];
        const list = candidates.find(Array.isArray) || [];
        let changed = false;
        for (const thread of list) changed = rememberThread(thread, hostId) || changed;
        if (changed) scheduleProjectOrderInvalidation();
      }

      function handleRpcResponse(message, fallbackHostId) {
        if (!message || typeof message !== "object") return;
        const requestId = requestIdOf(message);
        const pending = requestId ? pendingRpcRequests.get(requestId) : null;
        if (requestId) pendingRpcRequests.delete(requestId);
        if (!pending || message.error) return;
        const result = message.result ?? message.response?.result ?? message.response;
        const hostId = pending.hostId || fallbackHostId;
        if (["thread/list", "thread/search", "thread/loaded/list"].includes(pending.method)) {
          rememberThreadCollection(result, hostId);
          return;
        }
        if (["thread/start", "thread/read", "thread/resume", "thread/fork"].includes(pending.method)) {
          const thread = result?.thread ?? result?.response?.thread ?? result;
          if (rememberThread(thread, hostId, pending.method === "thread/start" ? Date.now() : null)) {
            scheduleProjectOrderInvalidation();
          }
        }
      }

      function handleNotification(message, fallbackHostId) {
        if (!message || typeof message !== "object" || typeof message.method !== "string") return;
        const params = message.params && typeof message.params === "object" ? message.params : {};
        const hostId = hostIdOf(message, fallbackHostId);
        if (message.method === "thread/started") {
          if (rememberThread(params.thread, hostId, Date.now())) scheduleProjectOrderInvalidation();
          return;
        }
        if (message.method === "thread/project/updated") {
          const threadId = params.threadId ?? params.conversationId;
          const assignment = params.assignment ?? params.project ?? params;
          if (typeof threadId === "string" && typeof assignment?.projectId === "string") {
            threadProjectAssignments.set(threadId, {
              hostId: typeof assignment.hostId === "string" ? assignment.hostId : hostId,
              projectId: assignment.projectId,
            });
            const thread = threads.get(threadId);
            if (thread) threads.set(threadId, { ...thread, projectId: assignment.projectId });
            scheduleProjectOrderInvalidation();
          }
          return;
        }
        if (["turn/started", "turn/completed"].includes(message.method)) {
          const threadId = params.threadId ?? params.conversationId ?? params.turn?.threadId;
          if (typeof threadId === "string" && rememberThread({ id: threadId }, hostId, Date.now())) {
            scheduleProjectOrderInvalidation();
          }
          return;
        }
        if (message.method === "thread/deleted") {
          const threadId = params.threadId ?? params.conversationId;
          if (typeof threadId === "string" && threads.delete(threadId)) scheduleProjectOrderInvalidation();
          return;
        }
        if (message.method === "thread/unarchived" && params.thread) {
          if (rememberThread(params.thread, hostId)) scheduleProjectOrderInvalidation();
        }
      }

      function processProtocolValue(value, direction, channel, fallbackHostId = "", depth = 0, state = null) {
        const traversal = state || { remaining: MAX_PROTOCOL_SCAN_NODES, seen: new WeakSet() };
        if (depth > 4 || traversal.remaining <= 0) return value;
        if (Array.isArray(value)) {
          if (traversal.seen.has(value)) return value;
          traversal.seen.add(value);
          traversal.remaining -= 1;
          let changed = false;
          const transformed = value.slice(0, traversal.remaining).map((item) => {
            const next = processProtocolValue(item, direction, channel, fallbackHostId, depth + 1, traversal);
            changed = changed || next !== item;
            return next;
          });
          if (transformed.length < value.length) transformed.push(...value.slice(transformed.length));
          return changed ? transformed : value;
        }
        if (!value || typeof value !== "object") return value;
        if (traversal.seen.has(value)) return value;
        traversal.seen.add(value);
        traversal.remaining -= 1;
        const hostId = hostIdOf(value, fallbackHostId);
        let transformedValue = value;
        if (direction === "client") {
          updateSidebarPreference(value);
          rememberPendingFetch(value);
          if (value.type === "mcp-request") rememberRpcRequest(value.request, hostId);
          else if (typeof value.method === "string" && value.id != null) rememberRpcRequest(value, hostId);
        } else if (
          channel === "thread-project-assignments-updated" ||
          value.type === "thread-project-assignments-updated"
        ) {
          if (replaceThreadProjectAssignments(value.assignments)) scheduleProjectOrderInvalidation();
        } else if (channel === "fetch-response" || value.type === "fetch-response") {
          transformedValue = handleFetchResponse(value);
        } else if (value.type === "mcp-response") {
          handleRpcResponse(value.message ?? value.response ?? value, hostId);
        } else if (value.type === "mcp-notification") {
          handleNotification(value, hostId);
        } else if (value.id != null && (Object.prototype.hasOwnProperty.call(value, "result") || value.error)) {
          handleRpcResponse(value, hostId);
        } else if (typeof value.method === "string") {
          handleNotification(value, hostId);
        }

        // 只沿明确协议 envelope 有界下钻，避免扫描 thread 文本、工具结果或其它用户内容。
        for (const key of PROTOCOL_ENVELOPE_KEYS) {
          const nested = transformedValue[key];
          let decodedNested = nested;
          if (typeof nested === "string") {
            const firstCharacter = nested.trim()[0];
            if (
              (firstCharacter !== "{" && firstCharacter !== "[") ||
              !/(?:thread\/|turn\/|fetch-response|mcp-)/.test(nested)
            ) {
              continue;
            }
            decodedNested = parsedJson(nested);
          }
          if (!decodedNested || typeof decodedNested !== "object") continue;
          const next = processProtocolValue(
            decodedNested,
            direction,
            channel,
            hostId,
            depth + 1,
            traversal,
          );
          if (next === decodedNested) continue;
          const encodedNext = typeof nested === "string" ? JSON.stringify(next) : next;
          transformedValue = { ...transformedValue, [key]: encodedNext };
        }
        return transformedValue;
      }

      function gatewayProtocolTransform(frame) {
        const envelope = frame.value;
        if (!envelope || typeof envelope !== "object" || typeof envelope.channel !== "string") return undefined;
        const direction = frame.metadata.direction === "client" ? "client" : "server";
        const nextPayload = processProtocolValue(
          envelope.payload,
          direction,
          envelope.channel,
          hostIdOf(envelope.payload),
        );
        return nextPayload === envelope.payload ? undefined : { ...envelope, payload: nextPayload };
      }

      function appHostProtocolTransform(frame) {
        const direction = frame.metadata.direction === "client" ? "client" : "server";
        const value = frame.value;
        const transformed = processProtocolValue(value, direction, "app-host", hostIdOf(value));
        if (transformed === value) return undefined;
        if (typeof frame.raw !== "string") return transformed;
        const source = frame.raw.trim();
        if (Array.isArray(transformed) && !source.startsWith("[") && /\r?\n/.test(source)) {
          return transformed.map((entry) => JSON.stringify(entry)).join("\n");
        }
        return JSON.stringify(transformed);
      }

      function installProtocolTransforms() {
        const gatewayChannel = adapterHost.protocol.channels?.gateway;
        const appHostChannel = adapterHost.protocol.channels?.appHost;
        if (gatewayChannel) {
          transformedProtocols.push(adapterHost.protocol.transform({
            key: {},
            channel: gatewayChannel,
            order: 40,
            callback: gatewayProtocolTransform,
          }));
        }
        if (appHostChannel) {
          transformedProtocols.push(adapterHost.protocol.transform({
            key: {},
            channel: appHostChannel,
            order: 40,
            callback: appHostProtocolTransform,
          }));
        }
      }

      function emitProjectOrderFetchResponse(requestId) {
        if (requestId == null || requestId === "") return;
        pendingFetchKeys.delete(String(requestId));
        emitRendererMessage("fetch-response", {
          requestId: String(requestId),
          responseType: "success",
          status: 200,
          headers: { "content-type": "application/json" },
          bodyJsonString: JSON.stringify({ value: projectOrderForRecent(officialProjectOrder) }),
        });
        modificationEffects?.primary?.emit();
      }

      function handlePersistedAtomUpdated(...args) {
        const payload = args.length > 1 ? args[args.length - 1] : args[0];
        updateSidebarPreference({
          type: "persisted-atom-update",
          ...(payload && typeof payload === "object" ? payload : {}),
        });
      }

      function patchBridge(bridge) {
        if (!bridge || typeof bridge !== "object" || patchedBridges.has(bridge)) return false;
        const disposers = [];
        if (typeof bridge.sendMessageFromView === "function") {
          disposers.push(adapterHost.hooks.around({
            key: {},
            target: bridge,
            property: "sendMessageFromView",
            handle(_thisValue, args, proceed) {
              const payload = args[0];
              processProtocolValue(payload, "client", payload?.type || "view:message", hostIdOf(payload));
              if (usesRecentProjectSort() && fetchRequestKey(payload) === PROJECT_ORDER_KEY) {
                emitProjectOrderFetchResponse(payload.requestId);
                return Promise.resolve(true);
              }
              return proceed(args);
            },
          }));
        }
        if (typeof bridge.getInitialSidebarBootstrap === "function") {
          disposers.push(adapterHost.hooks.around({
            key: {},
            target: bridge,
            property: "getInitialSidebarBootstrap",
            handle(_thisValue, args, proceed) {
              const bootstrap = proceed(args);
              captureBootstrap(bootstrap);
              return usesRecentProjectSort() ? bootstrapWithRecentProjectOrder(bootstrap) : bootstrap;
            },
          }));
        }
        if (disposers.length === 0) return false;
        patchedBridges.add(bridge);
        bridgePatches.push(...disposers);
        return true;
      }

      function restoreBridges() {
        for (const dispose of bridgePatches.splice(0).reverse()) dispose();
      }

      function installBridgePatches() {
        if (disposed) return;
        installAttempts += 1;
        const bridges = Array.from(
          new Set([w.electronBridge, w.codexBridge, w.electronAPI].filter((bridge) => bridge && typeof bridge === "object")),
        );
        let installed = false;
        for (const bridge of bridges) installed = patchBridge(bridge) || patchedBridges.has(bridge) || installed;
        if (!installed) {
          if (installAttempts < BRIDGE_INSTALL_MAX_ATTEMPTS && typeof w.setTimeout === "function") {
            installTimer = scheduler.setTimeout(installBridgePatches, BRIDGE_INSTALL_RETRY_MS);
          }
          return;
        }
        const eventBridge = w.electronBridge || bridges[0];
        if (typeof eventBridge?.on === "function") {
          const unsubscribe = eventBridge.on("persisted-atom-updated", handlePersistedAtomUpdated);
          if (typeof unsubscribe === "function") unsubscribePersistedAtom = unsubscribe;
        }
        scheduleProjectOrderInvalidation();
      }

      captureBootstrap(w.__CODEX_WEB_CONFIG__?.initialSidebarBootstrap);
      installProtocolTransforms();
      if (typeof w.queueMicrotask === "function") w.queueMicrotask(installBridgePatches);
      else Promise.resolve().then(installBridgePatches);

      return () => {
        disposed = true;
        if (installTimer != null && typeof w.clearTimeout === "function") scheduler.clearTimeout(installTimer);
        unsubscribePersistedAtom?.();
        restoreBridges();
        for (const dispose of transformedProtocols.splice(0).reverse()) dispose();
        pendingFetchKeys.clear();
        pendingRpcRequests.clear();
        projects.clear();
        threads.clear();
        threadProjectAssignments.clear();
        // 停用插件后让官方重新读取真实 project-order，避免虚拟结果残留在 query 缓存中。
        emitProjectOrderInvalidation();
      };
    },
  });
})();
