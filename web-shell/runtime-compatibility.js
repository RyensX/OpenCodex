(() => {
  const state = { snapshot: null, timer: null, helpTrigger: null };
  const overallLabels = {
    healthy: "已命中",
    ready: "已就绪",
    pending: "待检测",
    degraded: "已降级",
    unavailable: "不可用",
    disabled: "已关闭",
  };
  const phaseLabels = {
    location: {
      unresolved: "未定位",
      resolving: "定位中",
      resolved: "已定位",
      unsupported: "不支持",
      ambiguous: "不唯一",
      failed: "定位失败",
      stale: "已失效",
    },
    application: {
      pending: "待应用",
      applying: "应用中",
      applied: "已应用",
      failed: "应用失败",
      disabled: "已关闭",
    },
    verification: {
      pending: "待验证",
      verified: "已验证",
      "not-required": "无需验证",
      failed: "验证失败",
    },
    exercise: {
      "not-exercised": "未命中",
      active: "已命中",
    },
  };
  const helpContent = {
    overall: {
      title: "总状态",
      description: "综合定位、应用、验证、实际命中和回退结果。功能组会原子检查必需修改点；可选点失败时，功能组显示降级而不是直接不可用。",
      statuses: [
        ["healthy", "已命中", "修改点已经就绪，并且对应代码路径在本次运行中至少实际执行过一次。"],
        ["ready", "已就绪", "定位、应用和验证已经完成，但对应路径尚未在本次运行中实际执行；这不代表失败。"],
        ["pending", "待检测", "定位、应用或验证仍未完成，当前还不能得出最终结论。"],
        ["degraded", "已降级", "修改点正在使用官方行为或其他回退方案；功能仍可继续，但增强能力可能不可用。"],
        ["unavailable", "不可用", "定位、应用或验证失败，或者功能组中的必需修改点不可用。"],
        ["disabled", "已关闭", "修改点或功能组被配置关闭，或不适用于当前平台和运行时。"],
      ],
    },
    location: {
      title: "定位状态",
      description: "定位用于在当前官方运行时中寻找唯一且满足约束的目标代码或能力。只有定位成功后才会进入应用阶段。",
      statuses: [
        ["unresolved", "未定位", "尚未开始寻找目标。"],
        ["resolving", "定位中", "正在扫描候选目标并检查约束。"],
        ["resolved", "已定位", "找到了数量正确且约束通过的目标。"],
        ["unsupported", "不支持", "没有找到足够候选，通常表示当前官方版本不包含该目标。"],
        ["ambiguous", "不唯一", "找到多个候选，无法安全判断应该修改哪一个。"],
        ["failed", "定位失败", "候选存在，但结构、指纹或其他强约束未通过。"],
        ["stale", "已失效", "定位后目标又发生变化，旧定位结果已被拒绝使用。"],
      ],
    },
    application: {
      title: "应用状态",
      description: "应用表示把兼容实现安装到已定位的目标上，例如挂接函数、注入桥接或改写缓存内容。",
      statuses: [
        ["pending", "待应用", "已经登记修改点，但还没有开始应用。"],
        ["applying", "应用中", "兼容实现正在安装。"],
        ["applied", "已应用", "兼容实现已经成功安装。"],
        ["failed", "应用失败", "安装过程抛出错误或未能完成。"],
        ["disabled", "已关闭", "该修改点被配置关闭或不适用于当前环境，不会执行应用。"],
      ],
    },
    verification: {
      title: "验证状态",
      description: "验证在应用之后检查目标结构或能力是否符合预期，防止“已经执行修改”被误当成“修改确实生效”。",
      statuses: [
        ["pending", "待验证", "尚未完成应用后检查。"],
        ["verified", "已验证", "应用后的结构或行为检查已经通过。"],
        ["not-required", "无需验证", "该修改点没有额外验证步骤；应用成功即可进入就绪状态。"],
        ["failed", "验证失败", "应用后的检查未通过，修改点会被判定为不可用。"],
      ],
    },
    exercise: {
      title: "命中状态",
      description: "命中记录兼容代码路径是否在本次运行中被真实业务调用，并累计调用次数。它用于区分“已经准备好”和“已经实际工作过”。",
      statuses: [
        ["not-exercised", "未命中", "兼容实现可能已经就绪，但当前运行中还没有业务操作走到该路径；这不代表失败。"],
        ["active", "已命中", "对应路径已经实际执行；页面同时显示累计命中次数。"],
      ],
    },
  };

  const byId = (id) => document.getElementById(id);

  function badge(status) {
    const span = document.createElement("span");
    span.className = `badge badge--${status}`;
    span.textContent = overallLabels[status] || status;
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
      ["总体", overallLabels[snapshot.status] || snapshot.status],
      ["已命中", counts.healthy],
      ["已就绪", counts.ready],
      ["降级 / 不可用", counts.degraded + counts.unavailable],
      ["待检测", counts.pending],
    ];
    for (const [index, [label, value]] of cards.entries()) {
      const card = document.createElement("article");
      card.className = "summary-card";
      if (index === 0) {
        card.classList.add("summary-card--overall");
        card.dataset.status = snapshot.status;
      }
      const caption = document.createElement("span");
      caption.className = "muted";
      caption.textContent = label;
      const strong = document.createElement("strong");
      strong.textContent = String(value);
      card.append(caption, strong);
      container.append(card);
    }
  }

  function statusFromIndependentPoints(points) {
    const statuses = points.map((point) => point.status);
    if (statuses.length === 0) return "pending";
    if (statuses.every((status) => status === "disabled")) return "disabled";
    if (statuses.includes("unavailable")) return "unavailable";
    if (statuses.includes("degraded") || statuses.includes("disabled")) return "degraded";
    if (statuses.includes("pending")) return "pending";
    if (statuses.includes("ready")) return "ready";
    return "healthy";
  }

  function groupedPoints(snapshot) {
    const points = snapshot.points || [];
    const pointById = new Map(points.map((point) => [point.id, point]));
    const assigned = new Set();
    const groups = [];
    for (const feature of snapshot.features || []) {
      const entries = [];
      for (const id of feature.required || []) {
        const point = pointById.get(id);
        if (!point) continue;
        assigned.add(id);
        entries.push({ point, role: "required" });
      }
      for (const id of feature.optional || []) {
        const point = pointById.get(id);
        if (!point) continue;
        assigned.add(id);
        entries.push({ point, role: "optional" });
      }
      groups.push({ feature, entries, independent: false });
    }

    const independentEntries = points
      .filter((point) => !assigned.has(point.id))
      .map((point) => ({ point, role: "independent" }));
    if (independentEntries.length > 0) {
      const independentPoints = independentEntries.map((entry) => entry.point);
      groups.push({
        independent: true,
        feature: {
          id: "feature.independent-points",
          description: "基础与独立兼容修改点",
          status: statusFromIndependentPoints(independentPoints),
          fallback: "各修改点按自身策略独立回退",
          required: [],
          optional: [],
        },
        entries: independentEntries,
      });
    }
    return groups;
  }

  function pointMatchesFilters(point) {
    const category = byId("categoryFilter").value;
    const status = byId("statusFilter").value;
    return (!category || point.category === category) && (!status || point.status === status);
  }

  function pointRole(role) {
    const label = document.createElement("span");
    label.className = `point-role point-role--${role}`;
    label.textContent = role === "required" ? "必需" : role === "optional" ? "可选" : "独立";
    return label;
  }

  function phaseCell(kind, status, textOverride = "") {
    const cell = document.createElement("td");
    const value = document.createElement("span");
    value.className = `phase-status phase-status--${String(status || "unknown").replace(/[^a-z-]/g, "")}`;
    value.textContent = textOverride || phaseLabels[kind]?.[status] || status || "-";
    value.title = status || "";
    cell.append(value);
    return cell;
  }

  function pointRow(entry) {
    const point = entry.point;
    const row = document.createElement("tr");
    row.className = "point-row";
    const identity = document.createElement("td");
    const identityLine = document.createElement("div");
    identityLine.className = "point-identity";
    const code = document.createElement("code");
    code.textContent = point.id;
    identityLine.append(code, pointRole(entry.role));
    const description = document.createElement("div");
    description.className = "point-description";
    description.textContent = point.description;
    identity.append(identityLine, description);
    const reasonText =
      point.location?.reason ||
      point.application?.lastError ||
      point.verification?.lastError ||
      point.fallback?.reason;
    if (reasonText) {
      const reason = document.createElement("div");
      reason.className = "point-reason";
      reason.textContent = reasonText;
      identity.append(reason);
    }

    const overall = document.createElement("td");
    overall.append(badge(point.status));
    const hitCount = Number(point.exercise?.hitCount || 0);
    const hitText = point.exercise?.status === "active"
      ? `${phaseLabels.exercise.active} · ${hitCount} 次`
      : phaseLabels.exercise[point.exercise?.status] || "未命中";
    row.append(
      identity,
      overall,
      phaseCell("location", point.location?.status),
      phaseCell("application", point.application?.status),
      phaseCell("verification", point.verification?.status),
      phaseCell("exercise", point.exercise?.status, hitText)
    );
    return row;
  }

  function groupHeader(group, visibleCount) {
    const feature = group.feature;
    const row = document.createElement("tr");
    row.className = "feature-group-row";
    row.dataset.status = feature.status;
    const cell = document.createElement("td");
    cell.colSpan = 6;
    const section = document.createElement("section");
    section.className = "feature-group";
    const main = document.createElement("div");
    main.className = "feature-main";
    const identity = document.createElement("div");
    identity.className = "feature-identity";
    const title = document.createElement("h3");
    title.textContent = feature.description;
    const code = document.createElement("code");
    code.textContent = feature.id;
    identity.append(title, code);

    const overview = document.createElement("div");
    overview.className = "feature-overview";
    overview.append(badge(feature.status));
    const counts = document.createElement("span");
    counts.className = "feature-counts";
    counts.textContent = group.independent
      ? `${group.entries.length} 个独立点`
      : `${feature.required.length} 个必需 · ${feature.optional.length} 个可选`;
    overview.append(counts);
    main.append(identity, overview);

    const details = document.createElement("div");
    details.className = "feature-details";
    const fallbackLabel = document.createElement("span");
    fallbackLabel.className = "feature-details-label";
    fallbackLabel.textContent = "回退策略";
    const fallback = document.createElement("span");
    fallback.className = "feature-fallback";
    fallback.textContent = feature.fallback || "无";
    const visible = document.createElement("span");
    visible.className = "feature-visible muted";
    visible.textContent = `显示 ${visibleCount} / ${group.entries.length}`;
    details.append(fallbackLabel, fallback, visible);
    section.append(main, details);
    if (!feature.enabled && feature.disabledReason) {
      const disabledReason = document.createElement("p");
      disabledReason.className = "feature-disabled-reason point-reason";
      disabledReason.textContent = feature.disabledReason;
      section.append(disabledReason);
    }
    cell.append(section);
    row.append(cell);
    return row;
  }

  function renderPoints(snapshot) {
    const table = byId("pointsTable");
    for (const body of Array.from(table.tBodies)) body.remove();
    let visiblePointCount = 0;
    for (const group of groupedPoints(snapshot)) {
      const visibleEntries = group.entries.filter((entry) => pointMatchesFilters(entry.point));
      if (visibleEntries.length === 0) continue;
      const body = document.createElement("tbody");
      body.className = "point-group";
      body.append(groupHeader(group, visibleEntries.length));
      for (const entry of visibleEntries) body.append(pointRow(entry));
      table.append(body);
      visiblePointCount += visibleEntries.length;
    }
    byId("emptyState").hidden = visiblePointCount > 0;
  }

  function render(snapshot) {
    state.snapshot = snapshot;
    const runtime = snapshot.runtime || {};
    const generatedAt = new Date(snapshot.generatedAt);
    const reportTime = Number.isNaN(generatedAt.getTime()) ? "未知时间" : generatedAt.toLocaleString();
    byId("runtimeIdentity").textContent = `Codex ${runtime.version || "unknown"} · build ${runtime.build || "unknown"} · 报告 ${reportTime}`;
    renderSummary(snapshot);
    renderPoints(snapshot);
  }

  function openHelp(key, trigger) {
    const content = helpContent[key];
    if (!content) return;
    state.helpTrigger = trigger || null;
    byId("helpDialogTitle").textContent = content.title;
    byId("helpDialogDescription").textContent = content.description;
    const list = byId("helpDialogStatuses");
    list.replaceChildren();
    for (const [status, label, description] of content.statuses) {
      const item = document.createElement("div");
      item.className = "help-status-item";
      const heading = document.createElement("div");
      heading.className = "help-status-heading";
      const strong = document.createElement("strong");
      strong.textContent = label;
      const code = document.createElement("code");
      code.textContent = status;
      heading.append(strong, code);
      const text = document.createElement("p");
      text.textContent = description;
      item.append(heading, text);
      list.append(item);
    }
    const dialog = byId("helpDialog");
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  }

  function closeHelp() {
    const dialog = byId("helpDialog");
    if (typeof dialog.close === "function" && dialog.open) dialog.close();
    else {
      dialog.removeAttribute("open");
      state.helpTrigger?.focus?.();
      state.helpTrigger = null;
    }
  }

  async function refresh() {
    try {
      const response = await fetch("/api/opencodex/runtime-compatibility", {
        credentials: "omit",
        cache: "no-store",
      });
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
  byId("categoryFilter").addEventListener("change", () => renderPoints(state.snapshot || { points: [], features: [] }));
  byId("statusFilter").addEventListener("change", () => renderPoints(state.snapshot || { points: [], features: [] }));
  document.addEventListener("click", (event) => {
    const trigger = event.target.closest?.("[data-help]");
    if (trigger) openHelp(trigger.dataset.help, trigger);
  });
  byId("helpDialogClose").addEventListener("click", closeHelp);
  byId("helpDialog").addEventListener("click", (event) => {
    if (event.target === byId("helpDialog")) closeHelp();
  });
  byId("helpDialog").addEventListener("close", () => {
    state.helpTrigger?.focus?.();
    state.helpTrigger = null;
  });
  document.addEventListener("visibilitychange", scheduleRefresh);
  void refresh().finally(scheduleRefresh);
})();
