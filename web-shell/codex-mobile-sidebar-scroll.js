(function () {
  const installedKey = "__opencodexMobileSidebarScrollGuardInstalled";
  if (document[installedKey]) return;
  document[installedKey] = true;

  document.addEventListener(
    "pointerdown",
    (event) => {
      if (event.pointerType !== "touch") return;
      const target = event.target;
      if (!target || typeof target.closest !== "function") return;
      if (!target.closest("[data-app-action-sidebar-thread-row]")) return;
      // 官方 dnd-kit 移动 6px 就激活拖拽；在 capture 阶段隔离触摸起点，让浏览器保留纵向滚动。
      event.stopPropagation();
    },
    true
  );
})();
