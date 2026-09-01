(() => {
  const AUTO_REFRESH_STORAGE_KEY = "opencodex_runtime_compatibility_auto_refresh";
  const runtimeConfig = window.__CODEX_WEB_CONFIG__ || {};
  const locale = String(runtimeConfig.locale || "zh-CN");
  const messages = runtimeConfig.messages && typeof runtimeConfig.messages === "object"
    ? runtimeConfig.messages
    : {};

  function t(key, fallback = key, values = null) {
    const template = messages[key] || fallback || key;
    if (!values || typeof values !== "object") return template;
    return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name) =>
      Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match
    );
  }

  function metadataText(kind, id, field, fallback) {
    return t(`web.runtimeCompatibility.${kind}.${id}.${field}`, fallback);
  }

  function readAutoRefreshPreference() {
    try {
      return localStorage.getItem(AUTO_REFRESH_STORAGE_KEY) !== "disabled";
    } catch {
      // 浏览器禁用存储时仍保持旧版默认自动刷新行为。
      return true;
    }
  }

  const state = {
    snapshot: null,
    timer: null,
    refreshPromise: null,
    helpTrigger: null,
    autoRefresh: readAutoRefreshPreference(),
  };
  const overallLabels = {
    healthy: t("web.runtimeCompatibility.status.healthy", "已命中"),
    ready: t("web.runtimeCompatibility.status.ready", "已就绪"),
    pending: t("web.runtimeCompatibility.status.pending", "待检测"),
    degraded: t("web.runtimeCompatibility.status.degraded", "已降级"),
    unavailable: t("web.runtimeCompatibility.status.unavailable", "不可用"),
    disabled: t("web.runtimeCompatibility.status.disabled", "已关闭"),
  };
  const phaseLabels = {
    location: {
      unresolved: t("web.runtimeCompatibility.location.unresolved", "未定位"),
      resolving: t("web.runtimeCompatibility.location.resolving", "定位中"),
      resolved: t("web.runtimeCompatibility.location.resolved", "已定位"),
      unsupported: t("web.runtimeCompatibility.location.unsupported", "不支持"),
      ambiguous: t("web.runtimeCompatibility.location.ambiguous", "不唯一"),
      failed: t("web.runtimeCompatibility.location.failed", "定位失败"),
      stale: t("web.runtimeCompatibility.location.stale", "已失效"),
    },
    application: {
      pending: t("web.runtimeCompatibility.application.pending", "待应用"),
      applying: t("web.runtimeCompatibility.application.applying", "应用中"),
      applied: t("web.runtimeCompatibility.application.applied", "已应用"),
      "rolled-back": t("web.runtimeCompatibility.application.rolledBack", "已回滚"),
      failed: t("web.runtimeCompatibility.application.failed", "应用失败"),
      disabled: overallLabels.disabled,
    },
    verification: {
      pending: t("web.runtimeCompatibility.verification.pending", "待验证"),
      verified: t("web.runtimeCompatibility.verification.verified", "已验证"),
      "not-required": t("web.runtimeCompatibility.verification.notRequired", "无需验证"),
      failed: t("web.runtimeCompatibility.verification.failed", "验证失败"),
    },
    activation: {
      inactive: t("web.runtimeCompatibility.activation.inactive", "未激活"),
      activating: t("web.runtimeCompatibility.activation.activating", "激活中"),
      ready: t("web.runtimeCompatibility.activation.ready", "已激活"),
      failed: t("web.runtimeCompatibility.activation.failed", "激活失败"),
      disposed: t("web.runtimeCompatibility.activation.disposed", "已销毁"),
    },
    exercise: {
      "not-exercised": t("web.runtimeCompatibility.exercise.notExercised", "未命中"),
      active: overallLabels.healthy,
      disabled: overallLabels.disabled,
    },
  };
  const helpContent = {
    overall: {
      title: t("web.runtimeCompatibility.help.overallTitle", "总状态"),
      description: t("web.runtimeCompatibility.help.overallDescription", "综合单个修改点的定位、应用、验证、激活、实际命中和回退结果；分类组只负责展示，不参与总体状态计算。"),
      statuses: [
        ["healthy", overallLabels.healthy, t("web.runtimeCompatibility.help.overall.healthy", "修改点已经就绪，并且对应代码路径在本次运行中至少实际执行过一次。")],
        ["ready", overallLabels.ready, t("web.runtimeCompatibility.help.overall.ready", "定位、应用和验证已经完成，但对应路径尚未在本次运行中实际执行；这不代表失败。")],
        ["pending", overallLabels.pending, t("web.runtimeCompatibility.help.overall.pending", "定位、应用、验证或激活仍未完成，当前还不能得出最终结论。")],
        ["degraded", overallLabels.degraded, t("web.runtimeCompatibility.help.overall.degraded", "修改点正在使用官方行为或其他回退方案；功能仍可继续，但增强能力可能不可用。")],
        ["unavailable", overallLabels.unavailable, t("web.runtimeCompatibility.help.overall.unavailable", "修改点的定位、应用、验证或激活失败。")],
        ["disabled", overallLabels.disabled, t("web.runtimeCompatibility.help.overall.disabled", "修改点被配置关闭，或不适用于当前平台和运行时。")],
      ],
    },
    adapter: {
      title: t("web.runtimeCompatibility.help.adapterTitle", "注入类别"),
      description: t("web.runtimeCompatibility.help.adapterDescription", "展示修改点使用的完整适配器链路，包括直接使用的适配器及其依赖的适配器。"),
      statuses: [],
    },
    location: {
      title: t("web.runtimeCompatibility.help.locationTitle", "定位状态"),
      description: t("web.runtimeCompatibility.help.locationDescription", "定位用于在当前官方运行时中寻找唯一且满足约束的目标代码或能力。只有定位成功后才会进入应用阶段。"),
      statuses: [
        ["unresolved", phaseLabels.location.unresolved, t("web.runtimeCompatibility.help.location.unresolved", "尚未开始寻找目标。")],
        ["resolving", phaseLabels.location.resolving, t("web.runtimeCompatibility.help.location.resolving", "正在扫描候选目标并检查约束。")],
        ["resolved", phaseLabels.location.resolved, t("web.runtimeCompatibility.help.location.resolved", "找到了数量正确且约束通过的目标。")],
        ["unsupported", phaseLabels.location.unsupported, t("web.runtimeCompatibility.help.location.unsupported", "没有找到足够候选，通常表示当前官方版本不包含该目标。")],
        ["ambiguous", phaseLabels.location.ambiguous, t("web.runtimeCompatibility.help.location.ambiguous", "找到多个候选，无法安全判断应该修改哪一个。")],
        ["failed", phaseLabels.location.failed, t("web.runtimeCompatibility.help.location.failed", "候选存在，但结构、指纹或其他强约束未通过。")],
        ["stale", phaseLabels.location.stale, t("web.runtimeCompatibility.help.location.stale", "定位后目标又发生变化，旧定位结果已被拒绝使用。")],
      ],
    },
    application: {
      title: t("web.runtimeCompatibility.help.applicationTitle", "应用状态"),
      description: t("web.runtimeCompatibility.help.applicationDescription", "应用表示把兼容实现安装到已定位的目标上，例如挂接函数、注入桥接或改写缓存内容。"),
      statuses: [
        ["pending", phaseLabels.application.pending, t("web.runtimeCompatibility.help.application.pending", "已经登记修改点，但还没有开始应用。")],
        ["applying", phaseLabels.application.applying, t("web.runtimeCompatibility.help.application.applying", "兼容实现正在安装。")],
        ["applied", phaseLabels.application.applied, t("web.runtimeCompatibility.help.application.applied", "兼容实现已经成功安装。")],
        ["rolled-back", phaseLabels.application["rolled-back"], t("web.runtimeCompatibility.help.application.rolledBack", "后续应用、验证或激活失败，已经按相反顺序撤销本次修改。")],
        ["failed", phaseLabels.application.failed, t("web.runtimeCompatibility.help.application.failed", "安装过程抛出错误或未能完成。")],
        ["disabled", phaseLabels.application.disabled, t("web.runtimeCompatibility.help.application.disabled", "该修改点被配置关闭或不适用于当前环境，不会执行应用。")],
      ],
    },
    verification: {
      title: t("web.runtimeCompatibility.help.verificationTitle", "验证状态"),
      description: t("web.runtimeCompatibility.help.verificationDescription", "验证在应用之后检查目标结构或能力是否符合预期，防止“已经执行修改”被误当成“修改确实生效”。"),
      statuses: [
        ["pending", phaseLabels.verification.pending, t("web.runtimeCompatibility.help.verification.pending", "尚未完成应用后检查。")],
        ["verified", phaseLabels.verification.verified, t("web.runtimeCompatibility.help.verification.verified", "应用后的结构或行为检查已经通过。")],
        ["not-required", phaseLabels.verification["not-required"], t("web.runtimeCompatibility.help.verification.notRequired", "该修改点没有额外验证步骤；应用成功即可进入就绪状态。")],
        ["failed", phaseLabels.verification.failed, t("web.runtimeCompatibility.help.verification.failed", "应用后的检查未通过，修改点会被判定为不可用。")],
      ],
    },
    activation: {
      title: t("web.runtimeCompatibility.help.activationTitle", "激活状态"),
      description: t("web.runtimeCompatibility.help.activationDescription", "激活表示 Provider 已启动持续运行能力，例如 Observer、Listener、Hook 层或协议订阅；激活成功只代表已就绪，不等于真实命中。"),
      statuses: [
        ["inactive", phaseLabels.activation.inactive, t("web.runtimeCompatibility.help.activation.inactive", "尚未启动持续运行能力。")],
        ["activating", phaseLabels.activation.activating, t("web.runtimeCompatibility.help.activation.activating", "正在启动 Observer、Listener、Hook 或协议订阅。")],
        ["ready", phaseLabels.activation.ready, t("web.runtimeCompatibility.help.activation.ready", "持续运行能力已经启动，正在等待真实业务效果。")],
        ["failed", phaseLabels.activation.failed, t("web.runtimeCompatibility.help.activation.failed", "持续运行能力启动失败，修改点不可用。")],
        ["disposed", phaseLabels.activation.disposed, t("web.runtimeCompatibility.help.activation.disposed", "页面、运行时或插件生命周期结束后已经释放。")],
      ],
    },
    exercise: {
      title: t("web.runtimeCompatibility.help.exerciseTitle", "命中状态"),
      description: t("web.runtimeCompatibility.help.exerciseDescription", "命中记录兼容代码路径是否在本次运行中被真实业务调用，并累计调用次数。它用于区分“已经准备好”和“已经实际工作过”。"),
      statuses: [
        ["not-exercised", phaseLabels.exercise["not-exercised"], t("web.runtimeCompatibility.help.exercise.notExercised", "兼容实现可能已经就绪，但当前运行中还没有业务操作走到该路径；这不代表失败。")],
        ["active", phaseLabels.exercise.active, t("web.runtimeCompatibility.help.exercise.active", "对应路径已经实际执行；页面同时显示累计命中次数。")],
        ["disabled", phaseLabels.exercise.disabled, t("web.runtimeCompatibility.help.exercise.disabled", "修改点被配置关闭或不适用于当前环境，不累计业务命中。")],
      ],
    },
  };

  const byId = (id) => document.getElementById(id);

  function applyI18n() {
    document.documentElement.lang = locale;
    for (const node of document.querySelectorAll("[data-i18n]")) {
      node.textContent = t(node.dataset.i18n, node.textContent);
    }
    for (const node of document.querySelectorAll("[data-i18n-aria-label]")) {
      node.setAttribute("aria-label", t(node.dataset.i18nAriaLabel, node.getAttribute("aria-label") || ""));
    }
  }

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
    const points = snapshot.points || [];
    const counts = summaryCounts(points);
    const percentage = (value) => points.length > 0 ? `${Math.round((value / points.length) * 100)}%` : "0%";
    const cards = [
      {
        label: t("web.runtimeCompatibility.summary.overall", "总体"),
        value: overallLabels[snapshot.status] || snapshot.status,
        detail: t(
          "web.runtimeCompatibility.summary.total",
          "共 {count} 个修改点{disabled}",
          {
            count: points.length,
            disabled: counts.disabled > 0
              ? t("web.runtimeCompatibility.summary.disabledSuffix", " · 已关闭 {count}", { count: counts.disabled })
              : "",
          }
        ),
      },
      {
        label: overallLabels.healthy,
        value: counts.healthy,
        detail: t("web.runtimeCompatibility.summary.percentage", "占全部 {percentage}", { percentage: percentage(counts.healthy) }),
      },
      {
        label: overallLabels.ready,
        value: counts.ready,
        detail: t("web.runtimeCompatibility.summary.readyDetail", "已安装，尚未实际命中"),
      },
      {
        label: t("web.runtimeCompatibility.summary.exceptions", "异常"),
        value: counts.degraded + counts.unavailable,
        detail: t(
          "web.runtimeCompatibility.summary.exceptionDetail",
          "降级 {degraded} · 不可用 {unavailable}",
          { degraded: counts.degraded, unavailable: counts.unavailable }
        ),
      },
      {
        label: overallLabels.pending,
        value: counts.pending,
        detail: t("web.runtimeCompatibility.summary.percentage", "占全部 {percentage}", { percentage: percentage(counts.pending) }),
      },
    ];
    for (const [index, item] of cards.entries()) {
      const card = document.createElement("article");
      card.className = "summary-card";
      if (index === 0) {
        card.classList.add("summary-card--overall");
        card.dataset.status = snapshot.status;
      }
      const caption = document.createElement("span");
      caption.className = "muted";
      caption.textContent = item.label;
      const strong = document.createElement("strong");
      strong.textContent = String(item.value);
      const detail = document.createElement("span");
      detail.className = "summary-card-detail muted";
      detail.textContent = item.detail;
      card.append(caption, strong, detail);
      container.append(card);
    }
  }

  function groupedPoints(snapshot) {
    const points = snapshot.points || [];
    const pointById = new Map(points.map((point) => [point.id, point]));
    return (snapshot.groups || []).map((group) => ({
      group,
      entries: (group.pointIds || []).map((id) => pointById.get(id)).filter(Boolean),
    }));
  }

  function pointMatchesFilters(point) {
    const adapter = byId("adapterFilter").value;
    const status = byId("statusFilter").value;
    return (!adapter || (point.adapterChainIds || []).includes(adapter)) && (!status || point.status === status);
  }

  function populateAdapterFilter(snapshot) {
    const select = byId("adapterFilter");
    const selected = select.value;
    const options = [new Option(t("common.all", "全部"), "")];
    for (const adapter of snapshot.adapterTypes || []) {
      options.push(new Option(metadataText("adapter", adapter.id, "name", adapter.name), adapter.id));
    }
    select.replaceChildren(...options);
    if (options.some((option) => option.value === selected)) select.value = selected;
  }

  function adapterCell(point, adapterById) {
    const cell = document.createElement("td");
    const chain = document.createElement("div");
    chain.className = "adapter-chain";
    for (const [index, id] of (point.adapterChainIds || []).entries()) {
      const adapter = adapterById.get(id);
      if (index > 0) {
        const arrow = document.createElement("span");
        arrow.className = "adapter-chain-arrow";
        arrow.textContent = "›";
        chain.append(arrow);
      }
      const item = document.createElement("span");
      item.className = `adapter-chain-item adapter-chain-item--${adapter?.kind || "unknown"}`;
      item.textContent = metadataText("adapter", id, "name", adapter?.name || id);
      item.title = metadataText("adapter", id, "description", adapter?.description || id);
      chain.append(item);
    }
    cell.append(chain);
    return cell;
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

  function pointRow(point, adapterById) {
    const row = document.createElement("tr");
    row.className = "point-row";
    const identity = document.createElement("td");
    const identityLine = document.createElement("div");
    identityLine.className = "point-identity";
    const code = document.createElement("code");
    code.textContent = point.id;
    identityLine.append(code);
    const description = document.createElement("div");
    description.className = "point-description";
    description.textContent = metadataText("point", point.id, "description", point.description);
    identity.append(identityLine, description);
    const reasonText =
      point.location?.reason ||
      point.application?.lastError ||
      point.verification?.lastError ||
      point.activation?.lastError ||
      point.fallback?.reason;
    if (reasonText) {
      const reason = document.createElement("div");
      reason.className = "point-reason";
      reason.textContent = reasonText;
      identity.append(reason);
    }
    if (Array.isArray(point.contributions) && point.contributions.length > 0) {
      const details = document.createElement("details");
      details.className = "contribution-details";
      const summary = document.createElement("summary");
      summary.textContent = t(
        "web.runtimeCompatibility.contributions",
        "{count} 个 Contribution",
        { count: point.contributions.length }
      );
      const list = document.createElement("div");
      list.className = "contribution-list";
      for (const contribution of point.contributions) {
        const item = document.createElement("article");
        item.className = "contribution-item";
        const title = document.createElement("code");
        title.textContent = contribution.id;
        const adapter = document.createElement("span");
        adapter.textContent = metadataText(
          "adapter",
          contribution.adapterId,
          "name",
          adapterById.get(contribution.adapterId)?.name || contribution.adapterId
        );
        const phases = document.createElement("span");
        phases.className = "contribution-phases";
        phases.textContent = [
          phaseLabels.location[contribution.location] || contribution.location,
          phaseLabels.application[contribution.application] || contribution.application,
          phaseLabels.verification[contribution.verification] || contribution.verification,
          phaseLabels.activation[contribution.activation] || contribution.activation,
          contribution.exercise === "active"
            ? t("web.runtimeCompatibility.hitCount", "已命中 {count} 次", { count: Number(contribution.hitCount || 0) })
            : phaseLabels.exercise[contribution.exercise] || contribution.exercise,
        ].join(" · ");
        item.append(title, adapter, phases);
        if (contribution.reason) {
          const reason = document.createElement("span");
          reason.className = "contribution-reason";
          reason.textContent = contribution.reason;
          item.append(reason);
        }
        if (contribution.fallbackActive) {
          const fallback = document.createElement("span");
          fallback.className = "contribution-reason";
          fallback.textContent = t(
            "web.runtimeCompatibility.fallback",
            "回退：{reason}",
            {
              reason: contribution.fallbackReason || t("web.runtimeCompatibility.officialBehavior", "使用官方行为"),
            }
          );
          item.append(fallback);
        }
        list.append(item);
      }
      details.append(summary, list);
      identity.append(details);
    }

    const overall = document.createElement("td");
    overall.append(badge(point.status));
    const hitCount = Number(point.exercise?.hitCount || 0);
    const hitText = point.exercise?.status === "active"
      ? t("web.runtimeCompatibility.hitCountShort", "{label} · {count} 次", { label: phaseLabels.exercise.active, count: hitCount })
      : phaseLabels.exercise[point.exercise?.status] || phaseLabels.exercise["not-exercised"];
    row.append(
      identity,
      adapterCell(point, adapterById),
      overall,
      phaseCell("location", point.location?.status),
      phaseCell("application", point.application?.status),
      phaseCell("verification", point.verification?.status),
      phaseCell("activation", point.activation?.status),
      phaseCell("exercise", point.exercise?.status, hitText)
    );
    return row;
  }

  function groupHeader(group, visibleCount) {
    const definition = group.group;
    const row = document.createElement("tr");
    row.className = "feature-group-row";
    row.dataset.status = definition.status;
    const cell = document.createElement("td");
    cell.colSpan = 8;
    const section = document.createElement("section");
    section.className = "feature-group";
    const main = document.createElement("div");
    main.className = "feature-main";
    const identity = document.createElement("div");
    identity.className = "feature-identity";
    const title = document.createElement("h3");
    title.textContent = metadataText("group", definition.id, "name", definition.name);
    const code = document.createElement("code");
    code.textContent = definition.id;
    const titleLine = document.createElement("div");
    titleLine.className = "feature-title-line";
    titleLine.append(title, code);
    identity.append(titleLine);

    const overview = document.createElement("div");
    overview.className = "feature-overview";
    overview.append(badge(definition.status));
    const counts = document.createElement("span");
    counts.className = "feature-counts";
    counts.textContent = t("web.runtimeCompatibility.pointCount", "{count} 个修改点", { count: group.entries.length });
    overview.append(counts);
    main.append(identity, overview);

    const details = document.createElement("div");
    details.className = "feature-details";
    const description = document.createElement("span");
    description.className = "feature-description";
    description.textContent = metadataText("group", definition.id, "description", definition.description);
    const visible = document.createElement("span");
    visible.className = "feature-visible muted";
    visible.textContent = visibleCount === group.entries.length
      ? ""
      : t(
        "web.runtimeCompatibility.filteredCount",
        "筛选后显示 {visible} / {total}",
        { visible: visibleCount, total: group.entries.length }
      );
    details.append(description, visible);
    section.append(main, details);
    cell.append(section);
    row.append(cell);
    return row;
  }

  function renderPoints(snapshot) {
    const table = byId("pointsTable");
    const adapterById = new Map((snapshot.adapterTypes || []).map((adapter) => [adapter.id, adapter]));
    for (const body of Array.from(table.tBodies)) body.remove();
    let visiblePointCount = 0;
    for (const group of groupedPoints(snapshot)) {
      const visibleEntries = group.entries.filter(pointMatchesFilters);
      if (visibleEntries.length === 0) continue;
      const body = document.createElement("tbody");
      body.className = "point-group";
      body.append(groupHeader(group, visibleEntries.length));
      for (const point of visibleEntries) body.append(pointRow(point, adapterById));
      table.append(body);
      visiblePointCount += visibleEntries.length;
    }
    byId("emptyState").hidden = visiblePointCount > 0;
  }

  function render(snapshot) {
    state.snapshot = snapshot;
    const runtime = snapshot.runtime || {};
    const generatedAt = new Date(snapshot.generatedAt);
    const reportTime = Number.isNaN(generatedAt.getTime())
      ? t("web.runtimeCompatibility.unknownTime", "未知时间")
      : generatedAt.toLocaleString(locale);
    const legacySuffix = snapshot.sourceSchemaVersion === 1
      ? t("web.runtimeCompatibility.legacySuffix", " · 旧版报告（只读）")
      : "";
    byId("runtimeIdentity").textContent = t(
      "web.runtimeCompatibility.runtimeIdentity",
      "Codex {version} · build {build} · 报告 {time}{legacy}",
      {
        version: runtime.version || "unknown",
        build: runtime.build || "unknown",
        time: reportTime,
        legacy: legacySuffix,
      }
    );
    populateAdapterFilter(snapshot);
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
    if (state.refreshPromise) return state.refreshPromise;
    state.refreshPromise = (async () => {
      try {
        const response = await fetch("/api/opencodex/runtime-compatibility", {
          credentials: "omit",
          cache: "no-store",
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json();
        if (!payload.ok || !payload.compatibility) {
          throw new Error(payload.error || t("web.runtimeCompatibility.invalidResponse", "无效的兼容性响应"));
        }
        render(payload.compatibility);
        byId("errorBanner").hidden = true;
      } catch (error) {
        const banner = byId("errorBanner");
        banner.textContent = t(
          "web.runtimeCompatibility.readFailed",
          "兼容性状态读取失败：{error}",
          { error: error instanceof Error ? error.message : String(error) }
        );
        banner.hidden = false;
      }
    })();
    try {
      return await state.refreshPromise;
    } finally {
      state.refreshPromise = null;
    }
  }

  function scheduleRefresh() {
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    if (!state.autoRefresh || document.visibilityState !== "visible") return;
    // 调试页可见时低频刷新；切到后台立即停止，避免诊断功能本身制造持续唤醒。
    state.timer = setTimeout(() => {
      void refresh().finally(scheduleRefresh);
    }, 5000);
  }

  function setAutoRefresh(enabled, { refreshImmediately = false } = {}) {
    state.autoRefresh = enabled === true;
    byId("autoRefreshToggle").checked = state.autoRefresh;
    try {
      localStorage.setItem(AUTO_REFRESH_STORAGE_KEY, state.autoRefresh ? "enabled" : "disabled");
    } catch {
      // 存储失败只影响偏好持久化，不影响当前页面的刷新控制。
    }
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    if (!state.autoRefresh) return;
    if (refreshImmediately && document.visibilityState === "visible") {
      void refresh().finally(scheduleRefresh);
    } else scheduleRefresh();
  }

  applyI18n();
  byId("autoRefreshToggle").checked = state.autoRefresh;
  byId("autoRefreshToggle").addEventListener("change", (event) => {
    setAutoRefresh(event.currentTarget.checked, { refreshImmediately: true });
  });
  byId("refreshButton").addEventListener("click", () => void refresh().finally(scheduleRefresh));
  byId("backButton").addEventListener("click", () => history.length > 1 ? history.back() : location.assign("/"));
  byId("adapterFilter").addEventListener("change", () => renderPoints(state.snapshot || { points: [], groups: [], adapterTypes: [] }));
  byId("statusFilter").addEventListener("change", () => renderPoints(state.snapshot || { points: [], groups: [], adapterTypes: [] }));
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
  window.addEventListener("pagehide", () => {
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
  }, { once: true });
  void refresh().finally(scheduleRefresh);
})();
