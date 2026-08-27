(function () {
  const w = window;
  if (w.__OpenCodexSmartSchedulingInjectionHealthInstalled) return;
  w.__OpenCodexSmartSchedulingInjectionHealthInstalled = true;

  const ENDPOINT = "/api/opencodex/model-router/injections";
  const MOUNT_SELECTOR = "[data-opencodex-smart-scheduling-injection-health]";
  const SETTINGS_VISIBILITY_EVENT = "opencodex:smart-scheduling-settings-visibility-changed";
  const POLL_INTERVAL_MS = 4_000;
  const POINTS = [
    "app-server-router",
    "auto-model-catalog",
    "settings-page",
    "composer-adapter",
    "summary-adapter",
    "route-presentation",
  ];
  const messages = w.__CODEX_WEB_CONFIG__?.messages || {};
  const locale = String(w.__CODEX_WEB_CONFIG__?.locale || document.documentElement.lang || "zh-CN");
  const isEnglish = locale.toLowerCase().startsWith("en");
  const clientId =
    w.OpenCodexRuntimeCompatibility?.clientId ||
    w.crypto?.randomUUID?.() ||
    `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 14)}`;
  const fallback = {
    title: isEnglish ? "Feature health" : "功能健康",
    checking: isEnglish ? "Checking injection status…" : "正在检查注入状态…",
    allOk: isEnglish ? "All injection points are healthy" : "全部注入正常",
    error: isEnglish ? "%count% injection points have issues" : "%count% 个注入点异常",
    disabled: isEnglish ? "Smart scheduling is off" : "智能调度未开启",
    unavailable: isEnglish ? "Could not read injection status" : "无法读取注入状态",
    version: isEnglish ? "Codex %version% · Build %build%" : "Codex %version% · 构建 %build%",
    points: {
      "app-server-router": isEnglish ? "Router decorator" : "路由装饰器",
      "auto-model-catalog": isEnglish ? "Model injection" : "模型注入",
      "settings-page": isEnglish ? "Smart scheduling settings injection" : "智能调度设置注入",
      "composer-adapter": isEnglish ? "Adapter injection" : "适配器注入",
      "summary-adapter": isEnglish ? "Summary adapter injection" : "摘要适配器注入",
      "route-presentation": isEnglish ? "Route status presentation bridge binding" : "路由状态展示桥绑定",
    },
  };
  const pendingReports = new Map();
  let refreshPromise = null;
  let pollTimer = 0;
  let syncScheduled = false;

  function localized(key, fallbackValue) {
    return (typeof messages[key] === "string" && messages[key]) || fallbackValue;
  }

  const copy = {
    title: localized("plugin.smartModelRouter.health.title", fallback.title),
    checking: localized("plugin.smartModelRouter.health.checking", fallback.checking),
    allOk: localized("plugin.smartModelRouter.health.summary.ok", fallback.allOk),
    error: localized("plugin.smartModelRouter.health.summary.error", fallback.error),
    disabled: localized("plugin.smartModelRouter.health.summary.disabled", fallback.disabled),
    unavailable: localized("plugin.smartModelRouter.health.summary.unavailable", fallback.unavailable),
    version: localized("plugin.smartModelRouter.health.version", fallback.version),
    points: Object.fromEntries(
      POINTS.map((point) => [
        point,
        localized(`plugin.smartModelRouter.health.point.${point}`, fallback.points[point]),
      ])
    ),
  };

  function interpolate(template, values) {
    return Object.entries(values).reduce(
      (result, [key, value]) => result.replaceAll(`%${key}%`, String(value)),
      String(template || "")
    );
  }

  function createElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text != null) element.textContent = text;
    return element;
  }

  async function request(path, options = {}) {
    const response = await fetch(path, {
      cache: "no-store",
      credentials: "same-origin",
      ...options,
      headers: { "content-type": "application/json", ...(options.headers || {}) },
    });
    if (!response.ok) throw new Error(`injection_health_${response.status}`);
    return response.json();
  }

  function report(point) {
    if (!POINTS.includes(point)) return Promise.resolve(false);
    if (pendingReports.has(point)) return pendingReports.get(point);
    const task = (async () => {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        try {
          await request(ENDPOINT, {
            method: "POST",
            body: JSON.stringify({ point, clientId }),
          });
          void refresh();
          return true;
        } catch {
          // renderer 初始化和认证状态可能有短暂竞态，有限重试后仍保持旁路失败。
          if (attempt < 3) await new Promise((resolve) => w.setTimeout(resolve, 400 * 2 ** attempt));
        }
      }
      return false;
    })();
    pendingReports.set(point, task);
    return task;
  }

  function normalizedHealth(value) {
    if (!value || typeof value !== "object" || !Array.isArray(value.items)) return null;
    const byId = new Map(value.items.map((item) => [item?.id, item]));
    return {
      enabled: value.enabled === true,
      status: ["ok", "error", "disabled"].includes(value.status) ? value.status : "error",
      runtime: value.runtime && typeof value.runtime === "object" ? value.runtime : {},
      items: POINTS.map((id) => {
        const item = byId.get(id) || {};
        return {
          id,
          status: ["ok", "missing", "disabled"].includes(item.status) ? item.status : "missing",
          reportedAt: Number(item.reportedAt) || 0,
        };
      }),
    };
  }

  function renderHealth(root, health, unavailable = false) {
    root.textContent = "";
    const card = createElement("section", "opencodex-router-settings-card opencodex-router-health-card");
    const header = createElement("div", "opencodex-router-health-header");
    header.appendChild(createElement("h2", "opencodex-router-settings-group-title", copy.title));

    const missingCount = health?.items.filter((item) => item.status === "missing").length || 0;
    const status = unavailable ? "error" : health?.status || "error";
    const summaryText = unavailable
      ? copy.unavailable
      : status === "ok"
        ? copy.allOk
        : status === "disabled"
          ? copy.disabled
          : interpolate(copy.error, { count: missingCount });
    const summary = createElement("span", "opencodex-router-health-summary", summaryText);
    summary.dataset.status = status;
    summary.prepend(createElement("span", "opencodex-router-health-dot"));
    header.appendChild(summary);
    card.appendChild(header);

    const version = String(health?.runtime?.version || "unknown");
    const build = String(health?.runtime?.build || "unknown");
    card.appendChild(
      createElement("p", "opencodex-router-health-version", interpolate(copy.version, { version, build }))
    );

    const rows = createElement("div", "opencodex-router-health-rows");
    const items = health?.items || POINTS.map((id) => ({ id, status: "missing", reportedAt: 0 }));
    for (const item of items) {
      const row = createElement("div", "opencodex-router-health-row");
      row.dataset.status = unavailable ? "missing" : item.status;
      // 每项只展示名称和右侧状态点，避免回执时间等实现细节干扰健康判断。
      row.append(
        createElement("span", "opencodex-router-health-label", copy.points[item.id] || item.id),
        createElement("span", "opencodex-router-health-dot")
      );
      rows.appendChild(row);
    }
    card.appendChild(rows);
    // 健康标题属于卡片内容，整体与后续配置卡片保持同一层级和间距。
    root.appendChild(card);
  }

  async function refresh() {
    const roots = Array.from(document.querySelectorAll(MOUNT_SELECTOR));
    if (roots.length === 0) return null;
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      try {
        const payload = await request(`${ENDPOINT}?clientId=${encodeURIComponent(clientId)}`);
        const health = normalizedHealth(payload?.health);
        if (!health) throw new Error("invalid_injection_health");
        for (const root of roots) renderHealth(root, health);
        return health;
      } catch {
        for (const root of roots) renderHealth(root, null, true);
        return null;
      } finally {
        refreshPromise = null;
      }
    })();
    return refreshPromise;
  }

  function syncPolling() {
    syncScheduled = false;
    const roots = Array.from(document.querySelectorAll(MOUNT_SELECTOR));
    const active =
      document.visibilityState !== "hidden" &&
      roots.some((root) => root.closest(".opencodex-router-settings-page")?.dataset.active === "true");
    if (active) {
      void refresh();
      if (!pollTimer) pollTimer = w.setInterval(() => void refresh(), POLL_INTERVAL_MS);
    } else if (pollTimer) {
      w.clearInterval(pollTimer);
      pollTimer = 0;
    }
  }

  function schedulePollingSync() {
    if (syncScheduled) return;
    syncScheduled = true;
    w.requestAnimationFrame(syncPolling);
  }

  // 设置页由同仓脚本创建，直接消费其生命周期事件，避免为一个低频页面常驻整页 DOM observer。
  w.addEventListener(SETTINGS_VISIBILITY_EVENT, schedulePollingSync);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      // 后台标签的 rAF 可能暂停，必须同步停掉分钟轮询，不能等待下一帧。
      if (pollTimer) w.clearInterval(pollTimer);
      pollTimer = 0;
      return;
    }
    schedulePollingSync();
  });

  w.__OpenCodexSmartSchedulingInjectionHealth = Object.freeze({
    clientId,
    refresh,
    report,
  });
  schedulePollingSync();
})();
