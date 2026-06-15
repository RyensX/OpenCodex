(function () {
  const w = window;
  if (typeof w.__OpenCodexCreateTokenUsageCapability === "function") return;

  w.__OpenCodexCreateTokenUsageCapability = function createOpenCodexTokenUsageCapability(options = {}) {
    // 这里集中管理 token 用量数据的惰性查询、被动解析和有界缓存，避免 bridge polyfill 继续膨胀。
    const TOKEN_USAGE_GLOBAL_CACHE_LIMIT = 500;
    const TOKEN_USAGE_THREAD_CACHE_LIMIT = 100;
    const TOKEN_USAGE_TTL_MS = 24 * 60 * 60 * 1000;
    const TOKEN_USAGE_NEGATIVE_TTL_MS = 60 * 1000;
    const TOKEN_USAGE_TURN_ASSOCIATION_WINDOW_MS = 10 * 60 * 1000;
    const TOKEN_USAGE_TREE_SCAN_LIMIT = 2000;
    const TOKEN_USAGE_FETCH_TIMEOUT_MS = 12 * 1000;
    const TOKEN_USAGE_PASSIVE_HINT_SCAN_LIMIT = 80;
    const TOKEN_USAGE_PASSIVE_HINT_DEPTH_LIMIT = 3;
    const TOKEN_USAGE_PASSIVE_HINT_RE =
      /token_count|last_token_usage|lastTokenUsage|total_token_usage|totalTokenUsage|tokenUsage|token_usage|thread\/tokenUsage\/updated|turn\/started|turn\/completed|task_started|turn_started|task_complete|task_completed|task_failed|task_interrupted|turn_completed/;

    function tokenUsageAuthHeaders(headers) {
      if (typeof options.getAuthHeaders === "function") return options.getAuthHeaders(headers);
      // capability 独立运行时仍保持同源请求；没有 bridge 认证助手时只透传调用方 headers。
      return typeof Headers === "function" ? new Headers(headers || {}) : headers || {};
    }

    const tokenUsageState = {
      activeTurnsByThread: new Map(),
      // 主缓存按 threadId+turnId 存归一化后的数字；不保存原始 IPC payload 或消息正文。
      cache: new Map(),
      consumers: new Set(),
      pendingQueries: new Map(),
      pendingUsageByThread: new Map(),
      recentTurnsByThread: new Map(),
      subscribers: new Set(),
      // threadKeys/turnKeys 是裁剪索引：支持按会话限额清理，也支持页面缺 threadId 时反查缓存。
      threadKeys: new Map(),
      turnKeys: new Map(),
    };

    const tokenUsageDiagnostics = {
      cacheSize: 0,
      consumers: 0,
      lastFetchAt: 0,
      lastFetchError: "",
      lastFetchStatus: null,
      lastFetchThreadId: "",
      lastFetchTurnId: "",
      lastFetchUsageFound: null,
      passiveHandled: 0,
      passiveSkipped: 0,
      pendingQueries: 0,
    };

    w.__OpenCodexTokenUsage = tokenUsageDiagnostics;

    function updateTokenUsageDiagnostics(values = {}) {
      // 诊断对象只记录状态和数字，不记录 prompt、回复正文或工具输出。
      Object.assign(tokenUsageDiagnostics, values, {
        cacheSize: tokenUsageState.cache.size,
        consumers: tokenUsageState.consumers.size,
        pendingQueries: tokenUsageState.pendingQueries.size,
      });
    }

    function normalizeTokenUsageId(value) {
      if (value == null) return null;
      const raw = String(value).trim();
      if (!raw) return null;
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    }

    function tokenUsageCacheKey(threadId, turnId) {
      const normalizedThreadId = normalizeTokenUsageId(threadId);
      const normalizedTurnId = normalizeTokenUsageId(turnId);
      if (!normalizedThreadId || !normalizedTurnId) return null;
      // 使用不会出现在 ID 中的分隔符，避免普通字符串拼接造成 key 冲突。
      return `${normalizedThreadId}\0${normalizedTurnId}`;
    }

    function tokenUsageQueryKey(threadId, turnId) {
      const normalizedTurnId = normalizeTokenUsageId(turnId);
      if (!normalizedTurnId) return null;
      return `${normalizeTokenUsageId(threadId) || "__unknown_thread__"}\0${normalizedTurnId}`;
    }

    function tokenUsageConsumerActive() {
      return tokenUsageState.consumers.size > 0;
    }

    function currentTokenUsageThreadId() {
      const pathname = String(w.location?.pathname || "");
      const patterns = [
        /\/local\/([^/?#]+)/,
        /\/hotkey-window\/thread\/([^/?#]+)/,
        /\/thread\/([^/?#]+)/,
        /\/conversation\/([^/?#]+)/,
      ];
      for (const pattern of patterns) {
        const match = pattern.exec(pathname);
        if (match?.[1]) return normalizeTokenUsageId(match[1]);
      }
      return null;
    }

    function tokenUsageNumber(value) {
      const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
      return Number.isFinite(number) && number >= 0 ? Math.floor(number) : null;
    }

    function tokenUsageValueAtPath(object, path) {
      let cursor = object;
      for (const part of path) {
        if (!cursor || typeof cursor !== "object" || !Object.prototype.hasOwnProperty.call(cursor, part)) {
          return undefined;
        }
        cursor = cursor[part];
      }
      return cursor;
    }

    function tokenUsageNumberFromPaths(object, paths) {
      if (!object || typeof object !== "object") return null;
      for (const path of paths) {
        const number = tokenUsageNumber(tokenUsageValueAtPath(object, path));
        if (number != null) return number;
      }
      return null;
    }

    function normalizeTokenUsagePayload(rawUsage, threadId, turnId, source) {
      if (!rawUsage || typeof rawUsage !== "object") return null;
      const normalizedThreadId = normalizeTokenUsageId(threadId);
      const normalizedTurnId = normalizeTokenUsageId(turnId);
      if (!normalizedThreadId || !normalizedTurnId) return null;
      // 官方/网关/会话文件可能使用不同命名风格；统一兼容后只向插件输出稳定字段。
      const inputTokens = tokenUsageNumberFromPaths(rawUsage, [
        ["inputTokens"],
        ["input_tokens"],
        ["promptTokens"],
        ["prompt_tokens"],
        ["inputTokenCount"],
        ["input_token_count"],
        ["promptTokenCount"],
        ["prompt_token_count"],
        ["input", "tokens"],
        ["input", "totalTokens"],
        ["input", "total_tokens"],
        ["input", "total"],
        ["prompt", "tokens"],
        ["prompt", "totalTokens"],
        ["prompt", "total_tokens"],
        ["prompt", "total"],
      ]);
      const outputTokens = tokenUsageNumberFromPaths(rawUsage, [
        ["outputTokens"],
        ["output_tokens"],
        ["completionTokens"],
        ["completion_tokens"],
        ["outputTokenCount"],
        ["output_token_count"],
        ["completionTokenCount"],
        ["completion_token_count"],
        ["output", "tokens"],
        ["output", "totalTokens"],
        ["output", "total_tokens"],
        ["output", "total"],
        ["completion", "tokens"],
        ["completion", "totalTokens"],
        ["completion", "total_tokens"],
        ["completion", "total"],
      ]);
      const cachedInputTokens = tokenUsageNumberFromPaths(rawUsage, [
        ["cachedInputTokens"],
        ["cached_input_tokens"],
        ["cacheReadInputTokens"],
        ["cache_read_input_tokens"],
        ["cachedTokens"],
        ["cached_tokens"],
        ["inputTokensDetails", "cachedTokens"],
        ["inputTokensDetails", "cached_tokens"],
        ["input_tokens_details", "cachedTokens"],
        ["input_tokens_details", "cached_tokens"],
        ["promptTokensDetails", "cachedTokens"],
        ["promptTokensDetails", "cached_tokens"],
        ["prompt_tokens_details", "cachedTokens"],
        ["prompt_tokens_details", "cached_tokens"],
        ["input", "cachedTokens"],
        ["input", "cached_tokens"],
        ["prompt", "cachedTokens"],
        ["prompt", "cached_tokens"],
      ]);
      if (inputTokens == null && outputTokens == null && cachedInputTokens == null) return null;
      const cacheHitRate =
        inputTokens != null && inputTokens > 0 && cachedInputTokens != null
          ? Math.max(0, Math.min(1, cachedInputTokens / inputTokens))
          : null;
      return {
        cacheHitRate,
        cachedInputTokens,
        inputTokens,
        outputTokens,
        source: String(source || "unknown"),
        threadId: normalizedThreadId,
        turnId: normalizedTurnId,
        updatedAt: Date.now(),
      };
    }

    function deleteTokenUsageCacheKey(key) {
      const entry = tokenUsageState.cache.get(key);
      tokenUsageState.cache.delete(key);
      const threadId = entry?.threadId;
      const turnId = entry?.value?.turnId;
      if (turnId && tokenUsageState.turnKeys.get(turnId) === key) tokenUsageState.turnKeys.delete(turnId);
      if (!threadId) return;
      const keys = tokenUsageState.threadKeys.get(threadId);
      if (!keys) return;
      keys.delete(key);
      if (keys.size === 0) tokenUsageState.threadKeys.delete(threadId);
    }

    function pruneTokenUsageCache(now = Date.now()) {
      // 先清过期项，再按 Map 插入顺序裁剪最旧项，维持近似 LRU。
      for (const [key, entry] of Array.from(tokenUsageState.cache.entries())) {
        if (entry.expiresAt <= now) deleteTokenUsageCacheKey(key);
      }
      while (tokenUsageState.cache.size > TOKEN_USAGE_GLOBAL_CACHE_LIMIT) {
        const oldestKey = tokenUsageState.cache.keys().next().value;
        if (!oldestKey) break;
        deleteTokenUsageCacheKey(oldestKey);
      }
    }

    function pruneTokenUsageThreadCache(threadId) {
      const keys = tokenUsageState.threadKeys.get(threadId);
      if (!keys) return;
      while (keys.size > TOKEN_USAGE_THREAD_CACHE_LIMIT) {
        const oldestKey = keys.values().next().value;
        if (!oldestKey) break;
        deleteTokenUsageCacheKey(oldestKey);
      }
    }

    function setTokenUsageCacheEntry(value) {
      const key = tokenUsageCacheKey(value?.threadId, value?.turnId);
      if (!key) return;
      deleteTokenUsageCacheKey(key);
      // 正向缓存命中后通知订阅者，已渲染的回复可以不用再发起 session API 请求。
      const entry = {
        expiresAt: Date.now() + TOKEN_USAGE_TTL_MS,
        negative: false,
        threadId: value.threadId,
        updatedAt: Date.now(),
        value,
      };
      tokenUsageState.cache.set(key, entry);
      if (!tokenUsageState.threadKeys.has(value.threadId)) tokenUsageState.threadKeys.set(value.threadId, new Set());
      tokenUsageState.threadKeys.get(value.threadId).add(key);
      tokenUsageState.turnKeys.set(value.turnId, key);
      pruneTokenUsageThreadCache(value.threadId);
      pruneTokenUsageCache();
      for (const subscriber of Array.from(tokenUsageState.subscribers)) {
        try {
          subscriber(value);
        } catch (error) {
          console.warn("[opencodex-token-usage] subscriber failed", error);
        }
      }
    }

    function setTokenUsageNegativeCache(threadId, turnId) {
      const normalizedThreadId = normalizeTokenUsageId(threadId);
      const normalizedTurnId = normalizeTokenUsageId(turnId);
      const key = tokenUsageCacheKey(normalizedThreadId, normalizedTurnId);
      if (!key || !normalizedThreadId) return;
      deleteTokenUsageCacheKey(key);
      // 负缓存只保存短 TTL，避免不可用 turn 在滚动/重渲染时反复打后端。
      tokenUsageState.cache.set(key, {
        expiresAt: Date.now() + TOKEN_USAGE_NEGATIVE_TTL_MS,
        negative: true,
        threadId: normalizedThreadId,
        updatedAt: Date.now(),
        value: null,
      });
      if (!tokenUsageState.threadKeys.has(normalizedThreadId)) tokenUsageState.threadKeys.set(normalizedThreadId, new Set());
      tokenUsageState.threadKeys.get(normalizedThreadId).add(key);
      pruneTokenUsageThreadCache(normalizedThreadId);
      pruneTokenUsageCache();
    }

    function getTokenUsageCacheEntry(threadId, turnId) {
      // 页面没有 threadId 时按 turnId 找已解析缓存；后端响应会补齐真实 threadId。
      const key = tokenUsageCacheKey(threadId, turnId) || tokenUsageState.turnKeys.get(normalizeTokenUsageId(turnId));
      if (!key) return null;
      const entry = tokenUsageState.cache.get(key);
      if (!entry) return null;
      if (entry.expiresAt <= Date.now()) {
        deleteTokenUsageCacheKey(key);
        return null;
      }
      // Map 重新插入即可维持 LRU 顺序，避免额外维护访问时间索引。
      tokenUsageState.cache.delete(key);
      tokenUsageState.cache.set(key, entry);
      return entry;
    }

    function clearTokenUsageThread(threadId) {
      const normalizedThreadId = normalizeTokenUsageId(threadId);
      if (!normalizedThreadId) return;
      for (const key of Array.from(tokenUsageState.threadKeys.get(normalizedThreadId) || [])) {
        deleteTokenUsageCacheKey(key);
      }
      tokenUsageState.activeTurnsByThread.delete(normalizedThreadId);
      tokenUsageState.recentTurnsByThread.delete(normalizedThreadId);
      tokenUsageState.pendingUsageByThread.delete(normalizedThreadId);
    }

    function rememberTokenUsageTurn(threadId, turnId, status) {
      const normalizedThreadId = normalizeTokenUsageId(threadId);
      const normalizedTurnId = normalizeTokenUsageId(turnId);
      if (!normalizedThreadId || !normalizedTurnId) return;
      const record = { status: status || "unknown", seenAt: Date.now(), turnId: normalizedTurnId };
      if (status === "completed" || status === "failed" || status === "interrupted") {
        // 有些 token usage 通知先于 completed 到达；完成事件出现后再把暂存 usage 绑定到确定的 turn。
        tokenUsageState.activeTurnsByThread.delete(normalizedThreadId);
        tokenUsageState.recentTurnsByThread.set(normalizedThreadId, record);
        const pending = tokenUsageState.pendingUsageByThread.get(normalizedThreadId);
        if (pending && Date.now() - pending.seenAt <= TOKEN_USAGE_TURN_ASSOCIATION_WINDOW_MS) {
          const normalized = normalizeTokenUsagePayload(pending.rawUsage, normalizedThreadId, normalizedTurnId, pending.source);
          if (normalized) setTokenUsageCacheEntry(normalized);
          tokenUsageState.pendingUsageByThread.delete(normalizedThreadId);
        }
        return;
      }
      tokenUsageState.activeTurnsByThread.set(normalizedThreadId, record);
      tokenUsageState.recentTurnsByThread.set(normalizedThreadId, record);
    }

    function recentTokenUsageTurnId(threadId) {
      const normalizedThreadId = normalizeTokenUsageId(threadId);
      if (!normalizedThreadId) return null;
      const active = tokenUsageState.activeTurnsByThread.get(normalizedThreadId);
      if (active && Date.now() - active.seenAt <= TOKEN_USAGE_TURN_ASSOCIATION_WINDOW_MS) return active.turnId;
      const recent = tokenUsageState.recentTurnsByThread.get(normalizedThreadId);
      if (recent && Date.now() - recent.seenAt <= TOKEN_USAGE_TURN_ASSOCIATION_WINDOW_MS) return recent.turnId;
      return null;
    }

    function tokenUsageNotificationFromObject(message) {
      if (!message || typeof message !== "object") return [];
      // 兼容 JSON-RPC、gateway 包装和 notification 包装三种通知形态。
      if (typeof message.method === "string") return [message];
      const notification = message.notification && typeof message.notification === "object" ? message.notification : null;
      if (notification && typeof notification.method === "string") return [notification];
      if (message.type === "notification" && message.params && typeof message.params === "object") {
        const nested = message.params;
        if (typeof nested.method === "string") {
          return [{ method: nested.method, params: nested.params }];
        }
      }
      return [];
    }

    function handleTokenUsageNotification(notification, source) {
      if (!tokenUsageConsumerActive() || !notification || typeof notification !== "object") return;
      const method = typeof notification.method === "string" ? notification.method : "";
      const params = notification.params && typeof notification.params === "object" ? notification.params : {};
      if (method === "turn/started") {
        rememberTokenUsageTurn(params.threadId, params.turn?.id ?? params.turnId, params.turn?.status ?? "inProgress");
        return;
      }
      if (method === "turn/completed") {
        rememberTokenUsageTurn(params.threadId, params.turn?.id ?? params.turnId, params.turn?.status ?? "completed");
        return;
      }
      if (method === "thread/archived" || method === "thread/deleted" || method === "thread/unsubscribed") {
        clearTokenUsageThread(params.threadId);
        return;
      }
      if (method !== "thread/tokenUsage/updated") return;
      const threadId = normalizeTokenUsageId(params.threadId);
      if (!threadId) return;
      const rawUsage = params.tokenUsage || params.token_usage || params.usage;
      const explicitTurnId =
        params.turnId ??
        params.turn_id ??
        rawUsage?.turnId ??
        rawUsage?.turn_id ??
        rawUsage?.turn?.id ??
        null;
      const turnId = normalizeTokenUsageId(explicitTurnId) || recentTokenUsageTurnId(threadId);
      if (!turnId) {
        // 官方当前通知可能只有 threadId；没有活跃 turn 时先短暂暂存，等待 turn/completed 再绑定。
        tokenUsageState.pendingUsageByThread.set(threadId, { rawUsage, seenAt: Date.now(), source });
        return;
      }
      const normalized = normalizeTokenUsagePayload(rawUsage, threadId, turnId, source);
      if (normalized) setTokenUsageCacheEntry(normalized);
    }

    function tokenUsageEventPayloadFromMessage(message) {
      if (!message || typeof message !== "object") return null;
      if (message.type === "event_msg" && message.payload && typeof message.payload === "object") return message.payload;
      if (typeof message.type === "string") return message;
      return null;
    }

    function handleTokenUsageEventMessage(message, source, parentThreadId) {
      if (!tokenUsageConsumerActive() || !message || typeof message !== "object") return;
      const event = tokenUsageEventPayloadFromMessage(message);
      if (!event || typeof event !== "object") return;
      const eventType = typeof event.type === "string" ? event.type : "";
      // 被动事件不一定每层都带 threadId，向上继承容器 threadId，最后才回退到当前 URL。
      const threadId =
        normalizeTokenUsageId(
          event.threadId ??
            event.thread_id ??
            event.conversationId ??
            event.conversation_id ??
            message.threadId ??
            message.thread_id ??
            message.conversationId ??
            message.conversation_id ??
            parentThreadId
        ) || currentTokenUsageThreadId();
      if (!threadId) return;
      const turnId = normalizeTokenUsageId(
        event.turnId ?? event.turn_id ?? message.turnId ?? message.turn_id ?? event.turn?.id ?? message.turn?.id
      );

      if (eventType === "task_started" || eventType === "turn_started") {
        rememberTokenUsageTurn(threadId, turnId, "inProgress");
        return;
      }
      if (
        eventType === "task_complete" ||
        eventType === "task_completed" ||
        eventType === "task_failed" ||
        eventType === "task_interrupted" ||
        eventType === "turn_completed"
      ) {
        rememberTokenUsageTurn(threadId, turnId, "completed");
        return;
      }
      if (eventType !== "token_count") return;

      // Codex 会话真实落盘的是 event_msg/token_count；按 last_token_usage 绑定到最近活跃 turn。
      const rawUsage =
        event.info?.last_token_usage ??
        event.info?.lastTokenUsage ??
        event.last_token_usage ??
        event.lastTokenUsage ??
        event.info?.total_token_usage ??
        event.info?.totalTokenUsage ??
        event.total_token_usage ??
        event.totalTokenUsage ??
        null;
      const associatedTurnId = turnId || recentTokenUsageTurnId(threadId);
      if (!associatedTurnId) {
        tokenUsageState.pendingUsageByThread.set(threadId, { rawUsage, seenAt: Date.now(), source });
        return;
      }
      const normalized = normalizeTokenUsagePayload(rawUsage, threadId, associatedTurnId, source);
      if (normalized) setTokenUsageCacheEntry(normalized);
    }

    function maybeTokenUsageContainerThreadId(object, parentThreadId) {
      if (!object || typeof object !== "object") return parentThreadId;
      const direct = object.threadId ?? object.thread_id ?? object.conversationId ?? object.conversation_id;
      if (direct != null) return normalizeTokenUsageId(direct) || parentThreadId;
      if (Array.isArray(object.turns) && object.id != null) return normalizeTokenUsageId(object.id) || parentThreadId;
      return parentThreadId;
    }

    function maybeTokenUsageContainerTurnId(object, parentTurnId) {
      if (!object || typeof object !== "object") return parentTurnId;
      const direct = object.turnId ?? object.turn_id ?? object.turn?.id;
      if (direct != null) return normalizeTokenUsageId(direct) || parentTurnId;
      return parentTurnId;
    }

    function tokenUsagePayloadFromContainer(object) {
      if (!object || typeof object !== "object") return null;
      return object.tokenUsage || object.token_usage || object.usage || null;
    }

    function tokenUsageTextHasPassiveHint(value) {
      return typeof value === "string" && TOKEN_USAGE_PASSIVE_HINT_RE.test(value);
    }

    function tokenUsageObjectHasPassiveHint(root) {
      if (tokenUsageTextHasPassiveHint(root)) return true;
      if (!root || typeof root !== "object") return false;
      // 只做浅层、限量探测；没有 token 线索的 IPC 不进入昂贵 JSON 树遍历。
      const visited = new WeakSet();
      const stack = [{ depth: 0, value: root }];
      let scanned = 0;
      while (stack.length && scanned < TOKEN_USAGE_PASSIVE_HINT_SCAN_LIMIT) {
        const current = stack.pop();
        const value = current.value;
        if (tokenUsageTextHasPassiveHint(value)) return true;
        if (!value || typeof value !== "object") continue;
        if (visited.has(value)) continue;
        visited.add(value);
        scanned += 1;
        if (Array.isArray(value)) {
          if (current.depth >= TOKEN_USAGE_PASSIVE_HINT_DEPTH_LIMIT) continue;
          for (let index = value.length - 1; index >= 0; index -= 1) {
            stack.push({ depth: current.depth + 1, value: value[index] });
          }
          continue;
        }
        for (const [key, child] of Object.entries(value)) {
          if (tokenUsageTextHasPassiveHint(key) || tokenUsageTextHasPassiveHint(child)) return true;
          if (child && typeof child === "object" && current.depth < TOKEN_USAGE_PASSIVE_HINT_DEPTH_LIMIT) {
            stack.push({ depth: current.depth + 1, value: child });
          }
        }
      }
      return false;
    }

    function shouldHandleTokenUsagePassiveMessage(message) {
      // 被动通道只做轻量表层筛选；真正展示仍以按 turnId 懒查询为主，避免每条官方 IPC 都深扫对象树。
      if (Array.isArray(message)) return message.some((item) => tokenUsageObjectHasPassiveHint(item));
      return tokenUsageObjectHasPassiveHint(message);
    }

    function markTokenUsagePassiveSkipped() {
      tokenUsageDiagnostics.passiveSkipped += 1;
    }

    function markTokenUsagePassiveHandled() {
      tokenUsageDiagnostics.passiveHandled += 1;
    }

    function collectTokenUsageFromTree(root, source) {
      if (!tokenUsageConsumerActive() || !root || typeof root !== "object") return;
      // 被动解析是优化路径：能从实时 IPC 里拿到就提前缓存，拿不到仍由 getForTurn 懒查 session API。
      const visited = new WeakSet();
      const stack = [{ depth: 0, threadId: null, turnId: null, value: root }];
      let scanned = 0;
      while (stack.length && scanned < TOKEN_USAGE_TREE_SCAN_LIMIT) {
        const current = stack.pop();
        const value = current.value;
        if (!value || typeof value !== "object") continue;
        if (visited.has(value)) continue;
        visited.add(value);
        scanned += 1;
        const threadId = maybeTokenUsageContainerThreadId(value, current.threadId);
        const turnId = maybeTokenUsageContainerTurnId(value, current.turnId);
        handleTokenUsageEventMessage(value, source, threadId);
        const rawUsage = tokenUsagePayloadFromContainer(value);
        if (rawUsage && threadId && turnId) {
          const normalized = normalizeTokenUsagePayload(rawUsage, threadId, turnId, source);
          if (normalized) setTokenUsageCacheEntry(normalized);
        }
        if (current.depth >= 6) continue;
        if (Array.isArray(value)) {
          for (let index = value.length - 1; index >= 0; index -= 1) {
            stack.push({ depth: current.depth + 1, threadId, turnId, value: value[index] });
          }
          continue;
        }
        for (const child of Object.values(value)) {
          if (child && typeof child === "object") {
            stack.push({ depth: current.depth + 1, threadId, turnId, value: child });
          }
        }
      }
    }

    function handleTokenUsageProtocolMessage(message, source, prechecked) {
      if (!tokenUsageConsumerActive() || !message) return;
      if (!prechecked && !shouldHandleTokenUsagePassiveMessage(message)) {
        markTokenUsagePassiveSkipped();
        return;
      }
      if (Array.isArray(message)) {
        message.forEach((item) => handleTokenUsageProtocolMessage(item, source, false));
        return;
      }
      if (typeof message !== "object") return;
      markTokenUsagePassiveHandled();
      tokenUsageNotificationFromObject(message).forEach((notification) => handleTokenUsageNotification(notification, source));
      collectTokenUsageFromTree(message.result ?? message.payload ?? message, source);
    }

    function handleTokenUsageAppHostData(data) {
      if (!tokenUsageConsumerActive() || typeof data !== "string" || !data.trim()) return;
      if (!tokenUsageTextHasPassiveHint(data)) {
        markTokenUsagePassiveSkipped();
        return;
      }
      try {
        // app-host 通道是字符串帧，只有命中 token 关键词后才 parse，避免每条 RPC 都 JSON.parse。
        handleTokenUsageProtocolMessage(JSON.parse(data), "app-host", true);
      } catch {}
    }

    function handleTokenUsageGatewayPayload(payload) {
      if (!tokenUsageConsumerActive() || !payload || typeof payload !== "object") return;
      if (!shouldHandleTokenUsagePassiveMessage(payload)) {
        markTokenUsagePassiveSkipped();
        return;
      }
      handleTokenUsageProtocolMessage(payload, "gateway", true);
    }

    async function fetchTokenUsageForTurn(threadId, turnId) {
      if (!tokenUsageConsumerActive()) return null;
      // 使用当前页面同源 API，避免 gatewayBaseUrl 主机名差异导致鉴权 cookie 没有随请求发送。
      const url = new URL("/api/token-usage", w.location.origin);
      if (threadId) url.searchParams.set("threadId", threadId);
      url.searchParams.set("turnId", turnId);
      updateTokenUsageDiagnostics({
        lastFetchAt: Date.now(),
        lastFetchError: "",
        lastFetchStatus: "pending",
        lastFetchThreadId: String(threadId || ""),
        lastFetchTurnId: String(turnId || ""),
        lastFetchUsageFound: null,
      });
      const controller = typeof AbortController === "function" ? new AbortController() : null;
      // 未知 threadId 的冷查询可能需要索引 sessions；后端命中缓存后同屏后续请求会快速返回。
      const timer = controller ? w.setTimeout(() => controller.abort(), TOKEN_USAGE_FETCH_TIMEOUT_MS) : null;
      try {
        const response = await fetch(url.toString(), {
          cache: "no-store",
          credentials: "same-origin",
          // token 用量接口在 auth gate 后面；显式带运行期 token，避免 cookie 竞态导致静默 401。
          headers: tokenUsageAuthHeaders(),
          signal: controller?.signal,
        });
        if (!response.ok) {
          updateTokenUsageDiagnostics({ lastFetchStatus: response.status, lastFetchUsageFound: false });
          return null;
        }
        const payload = await response.json();
        const resolvedThreadId = payload?.usage?.threadId ?? payload?.threadId ?? threadId;
        const resolvedTurnId = payload?.usage?.turnId ?? payload?.turnId ?? turnId;
        const usage = normalizeTokenUsagePayload(payload?.usage, resolvedThreadId, resolvedTurnId, "session-api");
        updateTokenUsageDiagnostics({ lastFetchStatus: response.status, lastFetchUsageFound: !!usage });
        return usage;
      } catch (error) {
        updateTokenUsageDiagnostics({
          lastFetchError: error?.message || String(error || "token usage fetch failed"),
          lastFetchStatus: "error",
          lastFetchUsageFound: false,
        });
        return null;
      } finally {
        if (timer) w.clearTimeout(timer);
      }
    }

    const tokenUsageCapability = Object.freeze({
      handleAppHostData: handleTokenUsageAppHostData,
      handleGatewayPayload: handleTokenUsageGatewayPayload,
      acquireConsumer(consumerId) {
        const id = String(consumerId || "").trim();
        if (!id) return () => {};
        tokenUsageState.consumers.add(id);
        pruneTokenUsageCache();
        updateTokenUsageDiagnostics();
        return () => tokenUsageCapability.releaseConsumer(id);
      },
      getForTurn(request) {
        const threadId = normalizeTokenUsageId(request?.threadId);
        const turnId = normalizeTokenUsageId(request?.turnId);
        const key = tokenUsageQueryKey(threadId, turnId);
        if (!key || !turnId) return Promise.resolve(null);
        const cached = getTokenUsageCacheEntry(threadId, turnId);
        updateTokenUsageDiagnostics();
        if (cached) return Promise.resolve(cached.negative ? null : cached.value);
        // 同一回复的并发请求共用一个 Promise，避免多个可见 badge 同时触发重复后端查询。
        if (tokenUsageState.pendingQueries.has(key)) return tokenUsageState.pendingQueries.get(key);
        const pending = fetchTokenUsageForTurn(threadId, turnId)
          .then((usage) => {
            const refreshed = getTokenUsageCacheEntry(threadId, turnId);
            if (refreshed) return refreshed.negative ? null : refreshed.value;
            if (usage) {
              setTokenUsageCacheEntry(usage);
              return usage;
            }
            if (!tokenUsageConsumerActive()) return null;
            if (threadId) setTokenUsageNegativeCache(threadId, turnId);
            return null;
          })
          .finally(() => {
            tokenUsageState.pendingQueries.delete(key);
            updateTokenUsageDiagnostics();
          });
        tokenUsageState.pendingQueries.set(key, pending);
        updateTokenUsageDiagnostics();
        return pending;
      },
      onUpdate(handler) {
        if (typeof handler !== "function") return () => {};
        tokenUsageState.subscribers.add(handler);
        return () => tokenUsageState.subscribers.delete(handler);
      },
      releaseConsumer(consumerId) {
        const id = String(consumerId || "").trim();
        if (!id) return;
        tokenUsageState.consumers.delete(id);
        if (tokenUsageState.consumers.size === 0) {
          // 没有插件消费时清空运行期 token 数据，避免后台继续持有无需展示的用量记录。
          tokenUsageState.activeTurnsByThread.clear();
          tokenUsageState.cache.clear();
          tokenUsageState.pendingUsageByThread.clear();
          tokenUsageState.pendingQueries.clear();
          tokenUsageState.recentTurnsByThread.clear();
          tokenUsageState.threadKeys.clear();
          tokenUsageState.turnKeys.clear();
        }
        updateTokenUsageDiagnostics();
      },
    });

    return tokenUsageCapability;
  };
})();
