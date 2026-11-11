const { EventEmitter } = require("node:events");

/** 为每个浏览器端口创建独立 renderer 身份，保留真实 sender 的可信来源和 frame。 */
async function connectGitWorkerRelay({ sender, port, requestId, invoke }) {
  const lifecycle = new EventEmitter();
  let closed = false;
  let workerPort = null;
  const forwarders = new Map();
  function close() {
    if (closed) return;
    closed = true;
    // 官方 cleanup 监听 destroyed；触发它以断开 worker，而不销毁真实隐藏窗口。
    lifecycle.emit("destroyed");
    for (const [event, listener] of forwarders) sender.removeListener(event, listener);
    lifecycle.removeAllListeners();
    workerPort?.close();
    port.close();
  }
  for (const event of ["destroyed", "render-process-gone", "did-start-navigation"]) {
    const listener = (...args) => event === "did-start-navigation" ? lifecycle.emit(event, ...args) : close();
    forwarders.set(event, listener);
    sender.on(event, listener);
  }
  const proxy = new Proxy(sender, {
    get(target, key) {
      if (key === "isDestroyed") return () => closed || target.isDestroyed();
      if (["on", "once", "removeListener", "off"].includes(key)) return lifecycle[key].bind(lifecycle);
      if (key === "postMessage") return (channel, payload, transfers = []) => {
        if (channel !== "codex_desktop:git-worker-port" || payload?.requestId !== requestId) return;
        if (payload.closed || closed) { transfers[0]?.close(); close(); return; }
        if (workerPort || !transfers[0]) throw new Error("Invalid Git worker port handoff");
        workerPort = transfers[0];
        workerPort.on("message", (event) => { if (!closed) port.postMessage(event.data); });
        port.on("message", (event) => { if (!closed) workerPort.postMessage(event.data); });
        workerPort.on("close", close);
        workerPort.start();
        port.start();
      };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  port.on("close", close);
  try {
    const connected = await invoke(proxy, requestId);
    if (!connected || !workerPort) throw new Error("Official Git worker did not provide a port");
    return close;
  } catch (error) {
    close();
    throw error;
  }
}

module.exports = { connectGitWorkerRelay };
