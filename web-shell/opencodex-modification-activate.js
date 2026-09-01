(() => {
  // 所有受信 Provider 脚本只注册实现；统一由 Kernel 在官方主模块前完成编译和激活。
  const activation = window.__OpenCodexAdapterHost?.providers?.activate?.();
  void activation?.catch?.((error) => {
    console.warn("[opencodex-adapter] browser Kernel activation failed", error);
  });
})();
