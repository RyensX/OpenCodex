/**
 * Statsig 遥测本地拦截 Provider。
 *
 * 官方 Statsig SDK 的上报通道是 XMLHttpRequest 与 navigator.sendBeacon，而不是 fetch，
 * 因此只改写 fetch 拦不住它：网络受限环境下每条 XHR 都会在控制台反复刷 NetworkError，
 * 并且 SDK 会持续重试。这里把 XHR 与 Beacon 两条通道一起接管，命中遥测地址时本地模拟
 * 一次成功响应，让 SDK 认为上报已完成、不再重试。
 *
 * 该 Provider 独立成文件，由骨架装配层按 provider key 自动注册，因此上游
 * codex-bridge-polyfill.js 可以保持零改动。
 */
(function () {
  const w = window;
  const modificationScope = w.__OpenCodexCurrentProviderScope;
  const modificationEffects = modificationScope?.effects;
  const providerGeneration = modificationScope?.generation || document;
  if (w.__opencodexStatsigTelemetryGuardInstalled === providerGeneration) return;
  const adapterHost = w.__OpenCodexAdapterHost;
  // 本 Provider 唯一依赖的宿主能力是定时器：模拟响应要等 SDK 在 send 返回后挂好监听器
  // 再派发，不能同步触发；宿主没给 scheduler 时退回 window 计时器。
  const scheduler = adapterHost?.scheduler?.capture?.() || w;
  if (!scheduler || typeof scheduler.setTimeout !== "function") return;
  w.__opencodexStatsigTelemetryGuardInstalled = providerGeneration;

  const MOCK_RESPONSE_BODY = "{}";

  /** 只认官方 Statsig 上报端点，其余 URL 一律透传原实现。 */
  function isTelemetryUrl(url) {
    try {
      const parsed = new URL(url, location.href);
      const pathname = parsed.pathname.replace(/\/+$/, "");
      return (
        parsed.hostname === "chatgpt.com" &&
        (pathname === "/ces/v1/rgstr" || pathname === "/ces/v1/log_event")
      );
    } catch {
      return false;
    }
  }

  /**
   * XHR 的 status/statusText/response/responseText/readyState 是只读 IDL 属性，
   * 非严格模式下直接赋值会被静默忽略，SDK 读到的仍是 readyState=0/status=0，
   * 永远走不到“上报成功”分支。必须在实例上 defineProperty 覆盖只读 getter。
   */
  function defineReadOnly(target, name, value) {
    try {
      Object.defineProperty(target, name, {
        configurable: true,
        enumerable: true,
        get: () => value,
      });
    } catch {}
  }

  function safeDispatch(target, type) {
    try {
      target.dispatchEvent(new Event(type));
    } catch {}
  }

  const disposers = [];

  if (typeof w.XMLHttpRequest === "function") {
    const originalOpen = w.XMLHttpRequest.prototype.open;
    const originalSend = w.XMLHttpRequest.prototype.send;

    w.XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      // open 是唯一能拿到目标 URL 的时机，先记在实例上供 send 判定。
      this.__opencodexTelemetryUrl = typeof url === "string" ? url : "";
      return originalOpen.apply(this, [method, url, ...rest]);
    };
    disposers.push(() => {
      w.XMLHttpRequest.prototype.open = originalOpen;
    });

    w.XMLHttpRequest.prototype.send = function (body) {
      const xhr = this;
      let url = "";
      try {
        url = new URL(String(xhr.__opencodexTelemetryUrl || ""), location.href).toString();
      } catch {
        url = String(xhr.__opencodexTelemetryUrl || "");
      }
      if (!isTelemetryUrl(url)) {
        return originalSend.call(this, body);
      }

      // 按骨架约定，安装完成只代表 ready，命中只能在真实拦截发生时上报。
      modificationEffects?.primary?.emit();
      // 跳过真实网络请求：loadstart 同步补发，其余状态异步补齐，
      // 因为 SDK 通常在 send 返回之后才注册 load 监听器。
      safeDispatch(xhr, "loadstart");
      scheduler.setTimeout(() => {
        defineReadOnly(xhr, "status", 200);
        defineReadOnly(xhr, "statusText", "OK");
        defineReadOnly(xhr, "response", MOCK_RESPONSE_BODY);
        defineReadOnly(xhr, "responseText", MOCK_RESPONSE_BODY);
        defineReadOnly(xhr, "readyState", 4);
        safeDispatch(xhr, "readystatechange");
        safeDispatch(xhr, "load");
        safeDispatch(xhr, "loadend");
      }, 0);
      return undefined;
    };
    disposers.push(() => {
      w.XMLHttpRequest.prototype.send = originalSend;
    });
  }

  if (w.navigator && typeof w.navigator.sendBeacon === "function") {
    const originalSendBeacon = w.navigator.sendBeacon;
    // Beacon 的 this 绑定 navigator，转发前先固定接收者，避免 dispose 后仍引用补丁。
    const boundSendBeacon = originalSendBeacon.bind(w.navigator);
    // Beacon 没有响应可模拟，本地吞掉并按“已送达”返回 true，即可阻止 SDK 重试。
    w.navigator.sendBeacon = (url, ...rest) => {
      let target = "";
      try {
        target = new URL(String(url || ""), location.href).toString();
      } catch {
        target = String(url || "");
      }
      if (isTelemetryUrl(target)) {
        modificationEffects?.primary?.emit();
        return true;
      }
      return boundSendBeacon(url, ...rest);
    };
    disposers.push(() => {
      w.navigator.sendBeacon = originalSendBeacon;
    });
  }

  // 安装完成只代表 ready：命中改到 send/sendBeacon 真正吞掉遥测时逐次上报，
  // 运行时兼容调试页因此反映真实遥测流量，而不是"脚本装上了"。
  // 换页或关闭时由宿主逆序 dispose：还原原型与 Beacon，避免旧补丁继续吃掉新页面请求。
  modificationScope?.own?.(() => {
    for (const dispose of disposers.splice(0).reverse()) {
      try {
        dispose();
      } catch {}
    }
    if (w.__opencodexStatsigTelemetryGuardInstalled === providerGeneration) {
      w.__opencodexStatsigTelemetryGuardInstalled = undefined;
    }
  });
})();
