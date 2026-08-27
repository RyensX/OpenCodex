(() => {
  const state = { snapshot: null, timer: null };
  const labels = {
    healthy: "已命中",
    ready: "已就绪",
    pending: "待检测",
    degraded: "已降级",
    unavailable: "不可用",
    disabled: "已关闭",
  };

  const byId = (id) => document.getElementById(id);

  function badge(status) {
    const span = document.createElement("span");
    span.className = `badge badge--${status}`;
    span.textContent = labels[status] || status;
    return span;
  }

  function summaryCounts(points) {
    const counts = { healthy: 0, ready: 0, pending: 0, degraded: 0, unavailable: 0, disabled: 0 };
    for (const point of points) counts[point.status] = (counts[point.status] || 0) + 1;
    return counts;
  }

  function renderSummary(snapshot) {
    const container = byId("summaryCards");
    container.replaceChildren();
    const counts = summaryCounts(snapshot.points || []);
    const cards = [
      ["总体", labels[snapshot.status] || snapshot.status],
      ["已命中", counts.healthy],
      ["已就绪", counts.ready],
      ["降级 / 不可用", counts.degraded + counts.unavailable],
      ["待检测", counts.pending],
    ];
    for (const [label, value] of cards) {
      const card = document.createElement("article");
      card.className = "summary-card";
      const caption = document.createElement("span");
      caption.className = "muted";
      caption.textContent = label;
      const strong = document.createElement("strong");
      strong.textContent = String(value);
      card.append(caption, strong);
      container.append(card);
    }
  }

  function renderFeatures(features) {
    const container = byId("featureList");
    container.replaceChildren();
    for (const feature of features || []) {
      const article = document.createElement("article");
      article.className = "feature";
      const head = document.createElement("div");
      head.className = "feature-head";
      const identity = document.createElement("div");
      const code = document.createElement("code");
      code.textContent = feature.id;
      const title = document.createElement("p");
      title.textContent = feature.description;
      identity.append(code, title);
      head.append(identity, badge(feature.status));
      const details = document.createElement("p");
      details.className = "muted";
      details.textContent = `必需 ${feature.required.length} · 可选 ${feature.optional.length} · 回退：${feature.fallback || "无"}`;
      article.append(head, details);
      container.append(article);
    }
  }

  function statusCell(status) {
    const cell = document.createElement("td");
    cell.textContent = status || "-";
    return cell;
  }

  function renderPoints(points) {
    const category = byId("categoryFilter").value;
    const status = byId("statusFilter").value;
    const visible = (points || []).filter((point) => {
      return (!category || point.category === category) && (!status || point.status === status);
    });
    const rows = byId("pointRows");
    rows.replaceChildren();
    for (const point of visible) {
      const row = document.createElement("tr");
      const identity = document.createElement("td");
      const code = document.createElement("code");
      code.textContent = point.id;
      const description = document.createElement("div");
      description.className = "point-description";
      description.textContent = point.description;
      identity.append(code, description);
      const reasonText = point.location.reason || point.application.lastError || point.verification.lastError || point.fallback.reason;
      if (reasonText) {
        const reason = document.createElement("div");
        reason.className = "point-reason";
        reason.textContent = reasonText;
        identity.append(reason);
      }
      const overall = document.createElement("td");
      overall.append(badge(point.status));
      const hits = document.createElement("td");
      hits.textContent = point.exercise.status === "active" ? String(point.exercise.hitCount) : "未命中";
      row.append(
        identity,
        overall,
        statusCell(point.location.status),
        statusCell(point.application.status),
        statusCell(point.verification.status),
        hits
      );
      rows.append(row);
    }
    byId("emptyState").hidden = visible.length > 0;
  }

  function render(snapshot) {
    state.snapshot = snapshot;
    const runtime = snapshot.runtime || {};
    byId("runtimeIdentity").textContent = `Codex ${runtime.version || "unknown"} · build ${runtime.build || "unknown"} · 报告 ${new Date(snapshot.generatedAt).toLocaleString()}`;
    renderSummary(snapshot);
    renderFeatures(snapshot.features);
    renderPoints(snapshot.points);
  }

  async function refresh() {
    try {
      const response = await fetch("/api/opencodex/runtime-compatibility", { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      if (!payload.ok || !payload.compatibility) throw new Error(payload.error || "Invalid compatibility response");
      render(payload.compatibility);
      byId("errorBanner").hidden = true;
    } catch (error) {
      const banner = byId("errorBanner");
      banner.textContent = `兼容性状态读取失败：${error instanceof Error ? error.message : String(error)}`;
      banner.hidden = false;
    }
  }

  function scheduleRefresh() {
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    if (document.visibilityState !== "visible") return;
    // 调试页可见时低频刷新；切到后台立即停止，避免诊断功能本身制造持续唤醒。
    state.timer = setTimeout(async () => {
      await refresh();
      scheduleRefresh();
    }, 5000);
  }

  byId("refreshButton").addEventListener("click", () => void refresh());
  byId("backButton").addEventListener("click", () => history.length > 1 ? history.back() : location.assign("/"));
  byId("categoryFilter").addEventListener("change", () => renderPoints(state.snapshot?.points || []));
  byId("statusFilter").addEventListener("change", () => renderPoints(state.snapshot?.points || []));
  document.addEventListener("visibilitychange", scheduleRefresh);
  void refresh().finally(scheduleRefresh);
})();
