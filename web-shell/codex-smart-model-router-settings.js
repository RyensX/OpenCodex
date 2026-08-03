(function () {
  const w = window;
  if (w.__OpenCodexSmartModelRouterSettingsInstalled) return;
  w.__OpenCodexSmartModelRouterSettingsInstalled = true;

  const FEATURE = "smart-model-router";
  const NAV_SLUG = "opencodex-smart-model-router";
  const EFFORTS = ["auto", "low", "medium", "high", "xhigh", "max", "ultra"];
  const GROUPS = ["display", "classifier", "fallback"];
  // 官方 React 组件没有向注入脚本导出构造入口，因此复用其实际 trigger/menu DOM 约定和 Tailwind 样式类。
  const NATIVE_PICKER_TRIGGER_FALLBACK_CLASS = [
    "border-token-border no-drag cursor-interaction items-center gap-1 border whitespace-nowrap select-none",
    "focus:outline-none disabled:cursor-not-allowed disabled:opacity-40 flex rounded-lg",
    "text-token-button-tertiary-foreground bg-token-bg-fog enabled:hover:bg-token-list-hover-background",
    "data-[state=open]:bg-token-list-hover-background h-token-button-composer px-3 py-0 text-base",
    "leading-[18px] max-w-full justify-between outline-hidden",
  ].join(" ");
  const NATIVE_PICKER_MENU_CLASS = [
    "no-drag fixed z-50 m-px flex select-none flex-col overflow-y-auto px-1 py-1",
    "bg-token-dropdown-background/90 text-token-foreground ring-token-border rounded-xl ring-[0.5px]",
    "shadow-xl-spread backdrop-blur-sm",
  ].join(" ");
  const NATIVE_PICKER_ITEM_CLASS = [
    "no-drag text-token-foreground outline-hidden rounded-lg px-[var(--padding-row-x)]",
    "py-[var(--padding-row-y)] text-sm group hover:bg-token-list-hover-background",
    "focus:bg-token-list-hover-background cursor-interaction flex flex-col",
  ].join(" ");
  const messages = w.__CODEX_WEB_CONFIG__?.messages || {};
  let snapshot = { revision: 0, plugins: [] };
  let models = [];
  let active = false;
  let navigationItem = null;
  let suppressedOfficialNavigationItem = null;
  let page = null;
  let statusTimer = 0;
  let observerScheduled = false;
  let pickerSequence = 0;
  let activeChoicePopover = null;
  let updateQueue = Promise.resolve();

  function localized(key) {
    return (key && typeof messages[key] === "string" && messages[key]) || key || "";
  }

  function configuredText(key, fallback) {
    return (key && typeof messages[key] === "string" && messages[key]) || fallback || key || "";
  }

  // 设置页的固定文案统一读取插件语言包，避免语言包和脚本各维护一份文案。
  const c = {
    title: localized("plugin.smartModelRouter.label"),
    navLabel: localized("plugin.smartModelRouter.label"),
    description: localized("plugin.smartModelRouter.settings.description"),
    disabled: localized("plugin.smartModelRouter.settings.disabled"),
    loading: localized("plugin.smartModelRouter.settings.loading"),
    missing: localized("plugin.smartModelRouter.settings.missing"),
    unavailable: localized("plugin.smartModelRouter.settings.unavailable"),
    unavailableSuffix: localized("plugin.smartModelRouter.settings.unavailableSuffix"),
    saved: localized("plugin.smartModelRouter.settings.saved"),
    conflict: localized("plugin.smartModelRouter.settings.conflict"),
    failed: localized("plugin.smartModelRouter.settings.failed"),
    tiersTitle: localized("plugin.smartModelRouter.tiers.title"),
    tiersDescription: localized("plugin.smartModelRouter.tiers.description"),
    addTier: localized("plugin.smartModelRouter.tiers.add"),
    builtinTier: localized("plugin.smartModelRouter.tiers.builtin"),
    tierEnabled: localized("plugin.smartModelRouter.tier.enabled"),
    tierName: localized("plugin.smartModelRouter.tier.name"),
    tierPrompt: localized("plugin.smartModelRouter.tier.prompt"),
    tierModel: localized("plugin.smartModelRouter.tier.model"),
    tierEffort: localized("plugin.smartModelRouter.tier.effort"),
    moveTierUp: localized("plugin.smartModelRouter.tier.moveUp"),
    moveTierDown: localized("plugin.smartModelRouter.tier.moveDown"),
    deleteTier: localized("plugin.smartModelRouter.tier.delete"),
    deleteTierConfirm: localized("plugin.smartModelRouter.tier.deleteConfirm"),
    newTierName: localized("plugin.smartModelRouter.tier.newName"),
    newTierPrompt: localized("plugin.smartModelRouter.tier.newPrompt"),
    noEnabledTiers: localized("plugin.smartModelRouter.tiers.noneEnabled"),
    groups: Object.fromEntries(
      GROUPS.map((group) => [
        group,
        localized(`plugin.smartModelRouter.group.${group}`),
      ])
    ),
  };

  function createElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text != null) element.textContent = text;
    return element;
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      credentials: "same-origin",
      cache: "no-store",
      ...options,
      headers: { "content-type": "application/json", ...(options.headers || {}) },
    });
    let value = {};
    try {
      value = await response.json();
    } catch {}
    if (!response.ok) {
      const error = new Error(value.error || `${response.status}`);
      error.status = response.status;
      error.value = value;
      throw error;
    }
    return value;
  }

  function routerPlugin() {
    return (snapshot.plugins || []).find((plugin) => plugin.feature === FEATURE) || null;
  }

  function reportInjection() {
    // 只回执设置入口已真正插入官方导航；上报失败不能影响设置页本身。
    void w.__OpenCodexSmartSchedulingInjectionHealth?.report("settings-page");
  }

  function modelValue(model) {
    return String(model?.model || model?.id || "");
  }

  function realModels() {
    const seen = new Set();
    return models.filter((model) => {
      const value = modelValue(model);
      if (!value || value.toLowerCase() === "auto" || model.hidden === true || seen.has(value)) return false;
      seen.add(value);
      return true;
    });
  }

  function normalizedModelIdentity(value) {
    return String(value || "")
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "");
  }

  function modelChoice(model) {
    const value = modelValue(model);
    const label = String(model?.displayName || value).trim() || value;
    // displayName 经常只是模型 ID 的大小写或分隔符变体，此时不再重复展示第二行。
    const detail = normalizedModelIdentity(label) === normalizedModelIdentity(value) ? "" : value;
    return { value, label, detail };
  }

  function nativeDropdownButton() {
    return Array.from(document.querySelectorAll('button[aria-haspopup="menu"][data-state]')).find(
      (button) => !button.classList.contains("opencodex-router-choice-trigger")
    );
  }

  function createSvgIcon({ width, height, viewBox, className, path, strokeWidth }) {
    const namespace = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(namespace, "svg");
    svg.setAttribute("width", String(width));
    svg.setAttribute("height", String(height));
    svg.setAttribute("viewBox", viewBox);
    svg.setAttribute("fill", "none");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("class", className);
    const pathNode = document.createElementNS(namespace, "path");
    pathNode.setAttribute("d", path);
    pathNode.setAttribute("fill", "currentColor");
    if (strokeWidth) {
      pathNode.setAttribute("stroke", "currentColor");
      pathNode.setAttribute("stroke-width", String(strokeWidth));
    }
    svg.appendChild(pathNode);
    return svg;
  }

  function createNativeChevron() {
    const sourceButton = nativeDropdownButton();
    const sourceIcon = Array.from(sourceButton?.children || []).find((child) => child.tagName === "svg");
    if (sourceIcon) {
      const clone = sourceIcon.cloneNode(true);
      clone.removeAttribute("id");
      clone.setAttribute("aria-hidden", "true");
      return clone;
    }
    return createSvgIcon({
      width: 20,
      height: 21,
      viewBox: "0 0 20 21",
      className: "icon-2xs shrink-0 text-token-input-placeholder-foreground",
      path: "M15.2793 7.71101C15.539 7.45131 15.961 7.45131 16.2207 7.71101C16.4804 7.97071 16.4804 8.39272 16.2207 8.65242L10.4707 14.4024C10.211 14.6621 9.78902 14.6621 9.52932 14.4024L3.77932 8.65242L3.69436 8.54792C3.52385 8.28979 3.55205 7.93828 3.77932 7.71101C4.00659 7.48374 4.3581 7.45554 4.61623 7.62605L4.72073 7.71101L10 12.9903L15.2793 7.71101Z",
      strokeWidth: 0.6,
    });
  }

  function createNativeCheck() {
    return createSvgIcon({
      width: 17,
      height: 17,
      viewBox: "0 0 17 17",
      className: "icon-xs shrink-0 opacity-75 group-focus:opacity-100 group-hover:opacity-100",
      path: "M12.8961 3.64101C13.1297 3.41418 13.4984 3.37523 13.7779 3.56581C14.0571 3.75635 14.1554 4.11331 14.0299 4.41347L13.9615 4.53847L7.71151 13.7045C7.59411 13.8767 7.4063 13.9877 7.19881 14.0072C6.99136 14.0267 6.78564 13.9533 6.63826 13.806L2.88826 10.056L2.79842 9.9457C2.6192 9.67407 2.64927 9.30496 2.88826 9.06581C3.12738 8.82669 3.49647 8.79676 3.76815 8.97597L3.8785 9.06581L7.03084 12.2182L12.8053 3.74941L12.8961 3.64101Z",
    });
  }

  function renderChoiceTriggerValue(button, choice) {
    button.textContent = "";
    button.append(
      createElement("span", "flex min-w-0 flex-1 items-center gap-1.5 truncate", choice?.label || ""),
      createNativeChevron()
    );
    button.title = choice?.detail ? `${choice.label} · ${choice.detail}` : choice?.label || "";
  }

  function closeChoicePopover({ restoreFocus = false } = {}) {
    if (!activeChoicePopover) return;
    const current = activeChoicePopover;
    activeChoicePopover = null;
    current.close(restoreFocus);
  }

  function positionChoicePopover(button, menu) {
    const rect = button.getBoundingClientRect();
    const viewportGap = 8;
    const menuGap = 6;
    const width = Math.min(Math.max(rect.width, 248), window.innerWidth - viewportGap * 2);
    const left = Math.min(Math.max(viewportGap, rect.left), window.innerWidth - width - viewportGap);
    const spaceBelow = window.innerHeight - rect.bottom - viewportGap - menuGap;
    const spaceAbove = rect.top - viewportGap - menuGap;
    const openBelow = spaceBelow >= Math.min(240, Math.max(spaceAbove, 0));
    const maxHeight = Math.max(120, Math.min(320, openBelow ? spaceBelow : spaceAbove));

    menu.style.left = `${left}px`;
    menu.style.width = `${width}px`;
    menu.style.maxHeight = `${maxHeight}px`;
    menu.dataset.side = openBelow ? "bottom" : "top";
    menu.dataset.align = "end";
    menu.style.top = openBelow
      ? `${Math.min(window.innerHeight - viewportGap, rect.bottom + menuGap)}px`
      : `${Math.max(viewportGap, rect.top - menuGap - Math.min(menu.scrollHeight, maxHeight))}px`;
  }

  function openChoicePopover(button, choices, selectedValue, onSelect) {
    closeChoicePopover();
    const menu = createElement("div", `${NATIVE_PICKER_MENU_CLASS} opencodex-router-choice-popover`);
    const menuId = `opencodex-router-choice-${++pickerSequence}`;
    menu.id = menuId;
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-orientation", "vertical");
    menu.setAttribute("aria-label", button.getAttribute("aria-label") || "");
    menu.dataset.state = "open";
    menu.dataset.orientation = "vertical";
    button.setAttribute("aria-controls", menuId);
    button.setAttribute("aria-expanded", "true");
    button.dataset.state = "open";
    let highlightedIndex = Math.max(
      0,
      choices.findIndex((choice) => choice.value === selectedValue)
    );
    const optionNodes = choices.map((choice, index) => {
      const option = createElement("div", `${NATIVE_PICKER_ITEM_CLASS} opencodex-router-choice-option`);
      option.tabIndex = -1;
      option.setAttribute("role", "menuitemradio");
      option.setAttribute("aria-checked", choice.value === selectedValue ? "true" : "false");
      option.dataset.orientation = "vertical";
      const row = createElement("div", "flex w-full items-center gap-1.5");
      const text = createElement("span", "flex-1 min-w-0 truncate");
      text.appendChild(createElement("span", "block truncate opencodex-router-choice-label", choice.label));
      if (choice.detail) {
        text.appendChild(
          createElement(
            "span",
            "block truncate text-xs text-token-description-foreground opencodex-router-choice-detail",
            choice.detail
          )
        );
      }
      row.appendChild(text);
      if (choice.value === selectedValue) row.appendChild(createNativeCheck());
      option.appendChild(row);
      option.addEventListener("pointerenter", () => setHighlighted(index));
      option.addEventListener("click", () => {
        closeChoicePopover({ restoreFocus: true });
        onSelect(choice);
      });
      menu.appendChild(option);
      return option;
    });

    function setHighlighted(index) {
      if (optionNodes.length === 0) return;
      highlightedIndex = (index + optionNodes.length) % optionNodes.length;
      const option = optionNodes[highlightedIndex];
      option.focus({ preventScroll: true });
      option.scrollIntoView({ block: "nearest" });
    }

    function handlePointerDown(event) {
      if (!menu.contains(event.target) && !button.contains(event.target)) closeChoicePopover();
    }

    function handleKeyDown(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeChoicePopover({ restoreFocus: true });
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setHighlighted(highlightedIndex + (event.key === "ArrowDown" ? 1 : -1));
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        optionNodes[highlightedIndex]?.click();
      } else if (event.key === "Tab") {
        closeChoicePopover();
      }
    }

    function reposition() {
      if (menu.isConnected) positionChoicePopover(button, menu);
    }

    function close(restoreFocus) {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
      document.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
      menu.remove();
      button.setAttribute("aria-expanded", "false");
      button.removeAttribute("aria-controls");
      button.dataset.state = "closed";
      if (restoreFocus && button.isConnected) button.focus();
    }

    document.body.appendChild(menu);
    positionChoicePopover(button, menu);
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    activeChoicePopover = { button, close };
    requestAnimationFrame(() => {
      if (activeChoicePopover?.button === button) setHighlighted(highlightedIndex);
    });
  }

  function emitChoiceChange(control, setting, choice) {
    if (choice.value === control.value) return;
    control.value = choice.value;
    renderChoiceTriggerValue(control, choice);
    control.dispatchEvent(
      new CustomEvent("opencodex-setting-change", {
        bubbles: true,
        detail: { settingId: setting.id, value: choice.value },
      })
    );
  }

  function setBooleanControlState(control, enabled) {
    const checked = enabled === true;
    control.setAttribute("aria-checked", checked ? "true" : "false");
    control.dataset.state = checked ? "checked" : "unchecked";
  }

  function createBooleanControl(setting, configuredValue) {
    const control = createElement("button", "opencodex-router-setting-control opencodex-router-switch");
    control.type = "button";
    control.setAttribute("role", "switch");
    control.setAttribute("aria-label", configuredText(setting.labelKey, setting.label || setting.id));
    control.appendChild(createElement("span", "opencodex-router-switch-thumb"));
    setBooleanControlState(control, configuredValue === true);
    control.addEventListener("click", () => {
      const next = control.getAttribute("aria-checked") !== "true";
      setBooleanControlState(control, next);
      control.dispatchEvent(
        new CustomEvent("opencodex-setting-change", {
          bubbles: true,
          detail: { settingId: setting.id, value: next },
        })
      );
    });
    return control;
  }

  function createControl(setting, configuredValue) {
    let control;
    let unavailable = false;
    if (setting.type === "boolean") {
      // 布尔配置使用与 Codex token 一致的 switch，不退化成文本输入框。
      control = createBooleanControl(setting, configuredValue);
    } else if (["model", "reasoning-effort", "select"].includes(setting.type)) {
      const choices = [];
      if (setting.type === "model") {
        const available = realModels();
        const configuredAvailable = available.some((model) => modelValue(model) === configuredValue);
        if (configuredValue && !configuredAvailable) {
          choices.push({ value: configuredValue, label: `${configuredValue}${c.unavailableSuffix}`, detail: "" });
          unavailable = true;
        }
        choices.push(...available.map(modelChoice));
      } else if (setting.type === "reasoning-effort") {
        choices.push(...EFFORTS.map((effort) => ({ value: effort, label: effort, detail: "" })));
      } else {
        for (const option of setting.options || []) {
          choices.push({
            value: option.value,
            label: configuredText(option.labelKey, option.label || option.value),
            detail: "",
          });
        }
      }
      const selectedChoice = choices.find((choice) => choice.value === configuredValue) || choices[0];
      const nativeClass = nativeDropdownButton()?.className || NATIVE_PICKER_TRIGGER_FALLBACK_CLASS;
      control = createElement(
        "button",
        `${nativeClass} opencodex-router-setting-control opencodex-router-choice-trigger w-full min-w-0`
      );
      control.type = "button";
      control.value = configuredValue;
      renderChoiceTriggerValue(control, selectedChoice || { label: String(configuredValue || ""), detail: "" });
      control.setAttribute("aria-haspopup", "menu");
      control.setAttribute("aria-expanded", "false");
      control.dataset.state = "closed";
      control.setAttribute("aria-label", configuredText(setting.labelKey, setting.label || setting.id));
      const selectChoice = (choice) => emitChoiceChange(control, setting, choice);
      control.addEventListener("click", () => {
        if (activeChoicePopover?.button === control) {
          closeChoicePopover();
          return;
        }
        openChoicePopover(control, choices, control.value, selectChoice);
      });
      control.addEventListener("keydown", (event) => {
        if (activeChoicePopover?.button === control) return;
        if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
          event.preventDefault();
          openChoicePopover(control, choices, control.value, selectChoice);
        }
      });
    } else {
      control = createElement("input", "opencodex-router-setting-control");
      control.type = "text";
      control.value = String(configuredValue ?? "");
    }
    control.dataset.settingId = setting.id;
    control.dataset.settingType = setting.type;
    return { control, unavailable };
  }

  function settingGroup(settingId) {
    const normalized = String(settingId || "").toLowerCase();
    if (normalized === "showrouteinsummary") return "display";
    return GROUPS.find((group) => normalized.startsWith(group)) || "fallback";
  }

  function editableTiers(plugin = routerPlugin()) {
    // API 回传的 builtin/default 元数据由服务端维护，保存时只提交校验所需的档位字段。
    return (Array.isArray(plugin?.tiers) ? plugin.tiers : []).map((tier) => ({
      id: String(tier.id || ""),
      enabled: tier.enabled === true,
      name: String(tier.name || ""),
      prompt: String(tier.prompt || ""),
      model: String(tier.model || ""),
      effort: String(tier.effort || "auto"),
    }));
  }

  function tierDisplayName(tier) {
    if (tier?.builtin && tier.name === tier.defaultName) return configuredText(tier.nameKey, tier.name);
    return String(tier?.name || tier?.id || "");
  }

  function tierSettingId(tierId, field) {
    return `tier:${tierId}:${field}`;
  }

  function parseTierSettingId(settingId) {
    const match = /^tier:([a-z][a-z0-9_-]{1,63}):(enabled|model|effort)$/.exec(String(settingId || ""));
    return match ? { tierId: match[1], field: match[2] } : null;
  }

  function createTierTextControl(tier, field, multiline = false) {
    const control = createElement(
      multiline ? "textarea" : "input",
      `opencodex-router-setting-control${multiline ? " opencodex-router-tier-prompt" : ""}`
    );
    if (!multiline) control.type = "text";
    // 输入框展示实际参与分类的名称；本地化名称只用于未修改内置档位的卡片标题。
    control.value = String(tier[field] || "");
    control.maxLength = field === "name" ? 80 : 2_000;
    control.disabled = tier.builtin === true;
    control.dataset.tierId = tier.id;
    control.dataset.tierField = field;
    return control;
  }

  function createTierField(label, control, { full = false, warning = "" } = {}) {
    const field = createElement(
      "label",
      `opencodex-router-tier-field${full ? " opencodex-router-tier-field-full" : ""}`
    );
    const text = createElement("span", "opencodex-router-setting-label", label);
    if (warning) text.appendChild(createElement("span", "opencodex-router-setting-warning", warning));
    field.append(text, control);
    return field;
  }

  function createTierAction(label, text, handler, disabled = false) {
    const button = createElement("button", "opencodex-router-tier-action", text);
    button.type = "button";
    button.title = label;
    button.setAttribute("aria-label", label);
    button.disabled = disabled;
    button.addEventListener("click", handler);
    return button;
  }

  function notifySummaryConfiguration() {
    const plugin = routerPlugin();
    try {
      w.dispatchEvent(
        new CustomEvent("opencodex:smart-scheduling-config-changed", {
          detail: {
            enabled: plugin?.enabled === true,
            showRouteInSummary: plugin?.values?.showRouteInSummary !== false,
            // 档位名称变更后同步给摘要，确保自定义档位不会继续显示旧名称。
            tiers: Array.isArray(plugin?.tiers) ? plugin.tiers : undefined,
          },
        })
      );
    } catch {}
  }

  function setStatus(text, error = false) {
    const node = page?.querySelector(".opencodex-router-settings-status");
    if (!node) return;
    node.textContent = text;
    node.dataset.error = error ? "true" : "false";
    if (statusTimer) clearTimeout(statusTimer);
    if (text && !error) statusTimer = setTimeout(() => setStatus(""), 2_000);
  }

  function renderTierSection(content, plugin) {
    const section = createElement("section", "opencodex-router-settings-card opencodex-router-tiers-card");
    const sectionHeader = createElement("div", "opencodex-router-tiers-header");
    const heading = createElement("div", "opencodex-router-tiers-heading");
    heading.append(
      createElement("h2", "opencodex-router-settings-group-title", c.tiersTitle),
      createElement("p", "opencodex-router-tiers-description", c.tiersDescription)
    );
    const addButton = createElement("button", "opencodex-router-tier-add", c.addTier);
    addButton.type = "button";
    addButton.addEventListener("click", () => void addTier());
    sectionHeader.append(heading, addButton);
    section.appendChild(sectionHeader);

    const tiers = Array.isArray(plugin.tiers) ? plugin.tiers : [];
    if (!tiers.some((tier) => tier.enabled === true)) {
      section.appendChild(createElement("p", "opencodex-router-tier-empty-warning", c.noEnabledTiers));
    }
    const list = createElement("div", "opencodex-router-tier-list");
    tiers.forEach((tier, index) => {
      const card = createElement("article", "opencodex-router-tier-card");
      card.dataset.enabled = tier.enabled === true ? "true" : "false";
      card.dataset.builtin = tier.builtin === true ? "true" : "false";
      const header = createElement("header", "opencodex-router-tier-header");
      const title = createElement("div", "opencodex-router-tier-title");
      title.appendChild(createElement("span", "opencodex-router-tier-name", tierDisplayName(tier)));
      if (tier.builtin) title.appendChild(createElement("span", "opencodex-router-tier-badge", c.builtinTier));

      const actions = createElement("div", "opencodex-router-tier-actions");
      if (!tier.builtin) {
        actions.append(
          createTierAction(c.moveTierUp, "↑", () => void moveTier(tier.id, -1), index === 0),
          createTierAction(c.moveTierDown, "↓", () => void moveTier(tier.id, 1), index === tiers.length - 1)
        );
      }
      const enabledLabel = createElement("span", "opencodex-router-tier-enabled-label", c.tierEnabled);
      const enabledControl = createBooleanControl(
        { id: tierSettingId(tier.id, "enabled"), label: c.tierEnabled },
        tier.enabled
      );
      actions.append(enabledLabel, enabledControl);
      if (!tier.builtin) {
        actions.appendChild(
          createTierAction(c.deleteTier, "×", () => void deleteTier(tier.id), false)
        );
      }
      header.append(title, actions);

      const fields = createElement("div", "opencodex-router-tier-fields");
      fields.appendChild(createTierField(c.tierName, createTierTextControl(tier, "name")));
      const modelControl = createControl(
        { id: tierSettingId(tier.id, "model"), type: "model", label: c.tierModel },
        tier.model
      );
      fields.appendChild(
        createTierField(c.tierModel, modelControl.control, {
          warning: modelControl.unavailable ? c.unavailable : "",
        })
      );
      const effortControl = createControl(
        { id: tierSettingId(tier.id, "effort"), type: "reasoning-effort", label: c.tierEffort },
        tier.effort
      );
      fields.appendChild(createTierField(c.tierEffort, effortControl.control));
      fields.appendChild(
        createTierField(c.tierPrompt, createTierTextControl(tier, "prompt", true), { full: true })
      );
      card.append(header, fields);
      list.appendChild(card);
    });
    section.appendChild(list);
    content.appendChild(section);
  }

  function renderConfiguration() {
    const content = page?.querySelector(".opencodex-router-settings-groups");
    if (!content) return;
    closeChoicePopover();
    content.textContent = "";
    const plugin = routerPlugin();
    const notice = page.querySelector(".opencodex-router-settings-disabled");
    notice.hidden = !plugin || plugin.enabled === true;
    if (!plugin) {
      content.appendChild(createElement("p", "opencodex-router-settings-empty", c.missing));
      notifySummaryConfiguration();
      return;
    }

    const settingsByGroup = new Map(GROUPS.map((group) => [group, []]));
    for (const setting of plugin.settings || []) settingsByGroup.get(settingGroup(setting.id)).push(setting);
    for (const group of GROUPS) {
      if (group === "fallback") renderTierSection(content, plugin);
      const settings = settingsByGroup.get(group);
      if (!settings || settings.length === 0) continue;
      const section = createElement("section", "opencodex-router-settings-card");
      section.appendChild(createElement("h2", "opencodex-router-settings-group-title", c.groups[group]));
      const rows = createElement("div", "opencodex-router-settings-rows");
      for (const setting of settings) {
        const row = createElement("div", "opencodex-router-setting-row");
        const settingText = createElement("span", "opencodex-router-setting-text");
        settingText.appendChild(
          createElement("span", "opencodex-router-setting-label", configuredText(setting.labelKey, setting.label || setting.id))
        );
        const settingDescription = configuredText(setting.descriptionKey, setting.description || "");
        if (settingDescription) {
          settingText.appendChild(createElement("span", "opencodex-router-setting-description", settingDescription));
        }
        const { control, unavailable } = createControl(setting, plugin.values?.[setting.id]);
        if (unavailable) settingText.appendChild(createElement("span", "opencodex-router-setting-warning", c.unavailable));
        row.append(settingText, control);
        rows.appendChild(row);
      }
      section.appendChild(rows);
      content.appendChild(section);
    }
    notifySummaryConfiguration();
  }

  async function loadConfiguration() {
    setStatus(c.loading);
    try {
      const [configValue, modelValueResponse] = await Promise.all([
        api("/api/opencodex/plugins/config"),
        api("/api/opencodex/models"),
      ]);
      snapshot = { revision: configValue.revision, plugins: configValue.plugins || [] };
      models = Array.isArray(modelValueResponse.models) ? modelValueResponse.models : [];
      renderConfiguration();
      setStatus("");
    } catch (error) {
      setStatus(`${c.failed}: ${error.message}`, true);
    }
  }

  async function persistPluginUpdate(patchFactory) {
    const plugin = routerPlugin();
    if (!plugin) return;
    try {
      const patch = typeof patchFactory === "function" ? patchFactory(plugin) : patchFactory;
      if (!patch) return;
      const result = await api(`/api/opencodex/plugins/${encodeURIComponent(plugin.id)}/config`, {
        method: "PATCH",
        body: JSON.stringify({ expectedRevision: snapshot.revision, ...patch }),
      });
      snapshot = { revision: result.revision, plugins: result.plugins || [] };
      renderConfiguration();
      setStatus(c.saved);
    } catch (error) {
      if (error.status === 409 && error.value?.current) {
        snapshot = error.value.current;
        renderConfiguration();
        setStatus(c.conflict, true);
        return;
      }
      renderConfiguration();
      setStatus(`${c.failed}: ${error.message}`, true);
    }
  }

  function updatePlugin(patchFactory) {
    // 所有写入按 revision 串行执行；档位变更函数会在执行时读取最新快照，防止快速操作互相覆盖。
    const pending = updateQueue.catch(() => {}).then(() => persistPluginUpdate(patchFactory));
    updateQueue = pending;
    return pending;
  }

  async function updateSetting(settingId, value) {
    await updatePlugin({ values: { [settingId]: value } });
  }

  async function updateTiers(mutator) {
    await updatePlugin((plugin) => {
      const nextTiers = mutator(editableTiers(plugin), plugin);
      return Array.isArray(nextTiers) ? { tiers: nextTiers } : null;
    });
  }

  function updateTierField(tierId, field, value) {
    void updateTiers((tiers) => {
      const target = tiers.find((tier) => tier.id === tierId);
      if (!target) return null;
      target[field] = value;
      return tiers;
    });
  }

  function moveTier(tierId, delta) {
    void updateTiers((tiers) => {
      const index = tiers.findIndex((tier) => tier.id === tierId);
      const targetIndex = index + delta;
      if (index < 0 || targetIndex < 0 || targetIndex >= tiers.length) return null;
      [tiers[index], tiers[targetIndex]] = [tiers[targetIndex], tiers[index]];
      return tiers;
    });
  }

  function deleteTier(tierId) {
    const plugin = routerPlugin();
    const tier = plugin?.tiers?.find((candidate) => candidate.id === tierId);
    if (!tier || tier.builtin) return;
    if (typeof w.confirm === "function" && !w.confirm(c.deleteTierConfirm)) return;
    void updateTiers((tiers, latestPlugin) => {
      const latestTier = latestPlugin?.tiers?.find((candidate) => candidate.id === tierId);
      if (!latestTier || latestTier.builtin) return null;
      return tiers.filter((candidate) => candidate.id !== tierId);
    });
  }

  function addTier() {
    void updateTiers((tiers, plugin) => {
      const ids = new Set(tiers.map((tier) => tier.id));
      const prefix = `custom-${Date.now().toString(36)}`;
      let id = prefix;
      let suffix = 1;
      while (ids.has(id)) id = `${prefix}-${suffix++}`;
      const firstModel = modelValue(realModels()[0]);
      tiers.push({
        id,
        enabled: true,
        name: c.newTierName,
        prompt: c.newTierPrompt,
        model: String(plugin.values?.fallbackModel || firstModel || "gpt-5.3-codex-spark"),
        effort: "auto",
      });
      return tiers;
    });
  }

  function ensurePage() {
    if (page?.isConnected) return page;
    page = createElement("main", "opencodex-router-settings-page");
    page.dataset.active = "false";
    const scroll = createElement("div", "opencodex-router-settings-scroll");
    const content = createElement("div", "opencodex-router-settings-content");
    const header = createElement("header", "opencodex-router-settings-header");
    header.append(
      createElement("h1", "opencodex-router-settings-title", c.title),
      createElement("p", "opencodex-router-settings-description", c.description)
    );
    const disabled = createElement("p", "opencodex-router-settings-disabled", c.disabled);
    disabled.hidden = true;
    const injectionHealth = createElement("div", "opencodex-router-injection-health");
    injectionHealth.dataset.opencodexSmartSchedulingInjectionHealth = "true";
    content.append(
      header,
      disabled,
      injectionHealth,
      createElement("p", "opencodex-router-settings-status", ""),
      createElement("div", "opencodex-router-settings-groups")
    );
    scroll.appendChild(content);
    page.appendChild(scroll);
    page.addEventListener("change", (event) => {
      const control = event.target;
      if (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement) {
        const tierId = control.dataset.tierId;
        const tierField = control.dataset.tierField;
        if (tierId && tierField) {
          updateTierField(tierId, tierField, control.value);
          return;
        }
      }
      if (!(control instanceof HTMLInputElement)) return;
      const settingId = control.dataset.settingId;
      if (!settingId) return;
      const value = control.dataset.settingType === "boolean" ? control.checked : control.value;
      void updateSetting(settingId, value);
    });
    page.addEventListener("opencodex-setting-change", (event) => {
      const { settingId, value } = event.detail || {};
      if (!settingId) return;
      const tierSetting = parseTierSettingId(settingId);
      if (tierSetting) {
        updateTierField(tierSetting.tierId, tierSetting.field, value);
        return;
      }
      void updateSetting(settingId, value);
    });
    document.body.appendChild(page);
    return page;
  }

  function navigationRoot(button) {
    let node = button;
    const nav = button.closest("nav");
    while (node.parentElement && node.parentElement !== nav) {
      const parent = node.parentElement;
      const siblingHasNavigationItem = Array.from(parent.children).some(
        (child) =>
          child !== node &&
          (child.matches?.("[data-settings-panel-slug]") || child.querySelector?.("[data-settings-panel-slug]"))
      );
      if (siblingHasNavigationItem) return node;
      node = parent;
    }
    return button;
  }

  function clonedNavigationButton(root) {
    return root.matches?.("[data-settings-panel-slug]")
      ? root
      : root.querySelector?.("[data-settings-panel-slug]");
  }

  function replaceNavigationLabel(button) {
    const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    while (walker.nextNode()) {
      if (walker.currentNode.nodeValue.trim()) textNodes.push(walker.currentNode);
    }
    for (const node of textNodes) node.nodeValue = c.navLabel;
  }

  function stripDuplicatedIds(root) {
    if (root.removeAttribute) root.removeAttribute("id");
    for (const element of root.querySelectorAll?.("[id]") || []) element.removeAttribute("id");
  }

  function applyAccountNavigationIcon(button) {
    const nav = button.closest("nav") || document;
    const personalAnchor =
      nav.querySelector('[data-settings-panel-slug="personalization"]') ||
      nav.querySelector('[data-settings-panel-slug="agent"]');
    let scope = personalAnchor?.parentElement || null;
    let accountButton = null;

    // 官方账户入口追加在“个人”设置组末尾且没有 panel slug；逐层收窄在该组内定位，避免依赖本地化名称。
    while (scope && scope !== nav) {
      const candidates = Array.from(scope.querySelectorAll("button")).filter((candidate) => {
        if (candidate === button || candidate.hasAttribute("data-settings-panel-slug")) return false;
        if (!candidate.querySelector("svg")) return false;
        return Boolean(personalAnchor.compareDocumentPosition(candidate) & Node.DOCUMENT_POSITION_FOLLOWING);
      });
      if (candidates.length > 0) {
        // 普通设置项始终先于账户入口渲染；取组内最后一个无 slug 按钮可兼容其中的外部设置项。
        accountButton = candidates[candidates.length - 1];
        break;
      }
      scope = scope.parentElement;
    }
    const sourceIcon = accountButton?.querySelector("svg");
    const targetIcon = button.querySelector("svg");
    if (!sourceIcon || !targetIcon) return;
    const clone = sourceIcon.cloneNode(true);
    stripDuplicatedIds(clone);
    targetIcon.replaceWith(clone);
    button.dataset.opencodexIconSource = "account";
  }

  function installNavigationItem(anchorButton) {
    const existing = document.querySelector(`[data-settings-panel-slug="${NAV_SLUG}"]`);
    if (existing) {
      navigationItem = existing;
      applyAccountNavigationIcon(existing);
      reportInjection();
      return existing;
    }
    const anchorRoot = navigationRoot(anchorButton);
    const cloneRoot = anchorRoot.cloneNode(true);
    stripDuplicatedIds(cloneRoot);
    const button = clonedNavigationButton(cloneRoot);
    if (!button) return null;
    button.dataset.settingsPanelSlug = NAV_SLUG;
    button.dataset.opencodexActive = active ? "true" : "false";
    button.setAttribute("aria-label", c.navLabel);
    button.setAttribute("title", c.navLabel);
    button.removeAttribute("aria-current");
    button.removeAttribute("aria-pressed");
    replaceNavigationLabel(button);
    // 导航位置跟随“配置”，图标则直接复用官方“账户”图标，避免维护另一份图形资源。
    applyAccountNavigationIcon(button);
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      activateSettings();
    });
    anchorRoot.parentElement?.insertBefore(cloneRoot, anchorRoot.nextSibling);
    navigationItem = button;
    if (button.isConnected) reportInjection();
    return button;
  }

  function contentBounds(nav) {
    const legacySidebar = nav.closest(".app-shell-left-panel");
    const legacyContent = legacySidebar?.nextElementSibling;
    if (legacyContent) return legacyContent.getBoundingClientRect();

    // 新版设置布局由官方 split panel 组件承载；逐层寻找与导航并列的大尺寸内容节点。
    let branch = nav;
    while (branch.parentElement && branch.parentElement !== document.body) {
      const parent = branch.parentElement;
      const candidate = Array.from(parent.children).find((child) => {
        if (child === branch || child.contains(nav)) return false;
        const rect = child.getBoundingClientRect();
        return rect.width >= Math.min(360, window.innerWidth * 0.35) && rect.height >= window.innerHeight * 0.55;
      });
      if (candidate) return candidate.getBoundingClientRect();
      branch = parent;
    }
    const navRect = nav.getBoundingClientRect();
    return { left: navRect.right, top: 0, width: window.innerWidth - navRect.right, height: window.innerHeight };
  }

  function positionPage() {
    if (!active || !page?.isConnected) return;
    const nav = navigationItem?.closest("nav");
    if (!nav) return;
    const rect = contentBounds(nav);
    page.style.left = `${Math.max(0, rect.left)}px`;
    page.style.top = `${Math.max(0, rect.top)}px`;
    page.style.width = `${Math.max(320, rect.width)}px`;
    page.style.height = `${Math.max(320, rect.height)}px`;
  }

  function suppressOfficialNavigationSelection() {
    const selected = document.querySelector(
      `[data-settings-panel-slug][aria-current="page"]:not([data-settings-panel-slug="${NAV_SLUG}"])`
    );
    if (!selected) return;
    if (suppressedOfficialNavigationItem && suppressedOfficialNavigationItem !== selected) {
      suppressedOfficialNavigationItem.removeAttribute("data-opencodex-suppressed-active");
    }
    suppressedOfficialNavigationItem = selected;
    selected.dataset.opencodexSuppressedActive = "true";
    selected.removeAttribute("aria-current");
  }

  function restoreOfficialNavigationSelection() {
    if (!suppressedOfficialNavigationItem) return;
    suppressedOfficialNavigationItem.removeAttribute("data-opencodex-suppressed-active");
    if (suppressedOfficialNavigationItem.isConnected) {
      suppressedOfficialNavigationItem.setAttribute("aria-current", "page");
    }
    suppressedOfficialNavigationItem = null;
  }

  function activateSettings() {
    active = true;
    const current = ensurePage();
    current.dataset.active = "true";
    navigationItem?.setAttribute("data-opencodex-active", "true");
    navigationItem?.setAttribute("aria-current", "page");
    suppressOfficialNavigationSelection();
    positionPage();
    void loadConfiguration();
  }

  function deactivateSettings() {
    active = false;
    closeChoicePopover();
    if (page) page.dataset.active = "false";
    navigationItem?.setAttribute("data-opencodex-active", "false");
    navigationItem?.removeAttribute("aria-current");
    restoreOfficialNavigationSelection();
  }

  function syncWithOfficialSettings() {
    observerScheduled = false;
    const anchor =
      document.querySelector('[data-settings-panel-slug="agent"]') ||
      document.querySelector('[data-settings-panel-slug="personalization"]');
    if (!anchor) {
      navigationItem = null;
      deactivateSettings();
      return;
    }
    installNavigationItem(anchor);
    if (active) {
      suppressOfficialNavigationSelection();
      positionPage();
    }
  }

  function scheduleSync() {
    if (observerScheduled) return;
    observerScheduled = true;
    requestAnimationFrame(syncWithOfficialSettings);
  }

  function install() {
    const observer = new MutationObserver(scheduleSync);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    document.addEventListener(
      "click",
      (event) => {
        const button = event.target?.closest?.("[data-settings-panel-slug]");
        if (button && button.dataset.settingsPanelSlug !== NAV_SLUG) deactivateSettings();
      },
      true
    );
    window.addEventListener("resize", positionPage);
    scheduleSync();
  }

  // 暴露只读诊断入口，便于 UI 冒烟测试确认注入状态，不向插件开放任何路由实现能力。
  w.__OpenCodexSmartModelRouterSettings = Object.freeze({
    get active() {
      return active;
    },
    get installed() {
      return !!document.querySelector(`[data-settings-panel-slug="${NAV_SLUG}"]`);
    },
  });

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install, { once: true });
  else install();
})();
