import type { IGatewayCodexIpcPort } from "./codex/IGatewayCodexIpcPort";
import type { IGatewayElectronIpcPort } from "./electron/IGatewayElectronIpcPort";
import { IGatewayIpcPort } from "./IGatewayIpcPort";
import type { GatewayInvokeContext, GatewayIpcBroadcastMessage, GatewayWebClient } from "./types";

const TARGETED_EVENT_QUEUE_TTL_MS = 15_000;
const MAX_PENDING_TARGETED_EVENTS_PER_CLIENT = 100;

interface PendingTargetedEvent {
  channel: string;
  args: unknown[];
  expiresAtMs: number;
}

/**
 * gateway IPC 的组合实现。
 *
 * 它把两类能力组合在一起：
 * - electronIpcPort：只负责 Electron 通用 IPC 语义。
 * - codexIpcPort：只负责 Codex 业务 channel。
 */
export class GatewayIpcPort extends IGatewayIpcPort {
  private readonly electronIpcPort: IGatewayElectronIpcPort;
  private readonly codexIpcPort: IGatewayCodexIpcPort;
  private readonly requestContext: any;
  private readonly targetedChannels: Set<string>;
  private readonly createInvokeContext: (context: GatewayInvokeContext) => GatewayInvokeContext;
  private readonly pendingTargetedEvents = new Map<string, PendingTargetedEvent[]>();

  /** 构造时注入具体 IPC 实现，避免业务代码依赖 electron-to-web 或 direct 的细节。 */
  constructor({
    electronIpcPort,
    codexIpcPort,
    requestContext,
    targetedChannels,
    createInvokeContext,
  }: {
    electronIpcPort: IGatewayElectronIpcPort;
    codexIpcPort: IGatewayCodexIpcPort;
    requestContext: any;
    targetedChannels: Set<string>;
    createInvokeContext: (context: GatewayInvokeContext) => GatewayInvokeContext;
  }) {
    super();
    this.electronIpcPort = electronIpcPort;
    this.codexIpcPort = codexIpcPort;
    this.requestContext = requestContext;
    this.targetedChannels = targetedChannels;
    this.createInvokeContext = createInvokeContext;
    this.registerCodexHandlers();
  }

  /**
   * 把 Codex 业务 channel 注册进 Electron IPC 语义层。
   *
   * 这样前端仍然可以按 Electron 的 invoke/send 方式调用，但真正的业务处理
   * 会被转交给 codexIpcPort。
   */
  private registerCodexHandlers(): void {
    for (const channel of this.codexIpcPort.listCodexChannels()) {
      this.electronIpcPort.registerElectronHandler(channel, async (args, context) => {
        // Electron IPC 是可变参数语义；Codex 业务层多数只需要单个 payload。
        const payload = args.length <= 1 ? (args[0] ?? null) : args;
        return this.codexIpcPort.handleCodexRequest(
          channel,
          payload,
          this.createInvokeContext(context || {})
        );
      });
    }
  }

  /** 统一入口：先判断是否为明确的 Codex 业务 IPC，否则交给 Electron 语义层。 */
  async invokeGatewayIpc(channel: string, payload: unknown, context: GatewayInvokeContext): Promise<unknown> {
    const invokeContext = this.createInvokeContext(context || {});
    if (this.codexIpcPort.canHandleCodexChannel(channel)) {
      return this.codexIpcPort.handleCodexRequest(channel, payload, invokeContext);
    }
    return this.electronIpcPort.invokeElectron(channel, [payload], invokeContext);
  }

  /** 清理过期的定向事件，避免刷新/关闭页面后残留无主响应。 */
  private prunePendingTargetedEvents(clientId?: string): void {
    const now = Date.now();
    const clientIds = clientId ? [clientId] : [...this.pendingTargetedEvents.keys()];
    for (const id of clientIds) {
      const pending = this.pendingTargetedEvents.get(id);
      if (!pending) continue;
      const fresh = pending.filter((entry) => entry.expiresAtMs > now);
      if (fresh.length > 0) {
        this.pendingTargetedEvents.set(id, fresh);
      } else {
        this.pendingTargetedEvents.delete(id);
      }
    }
  }

  /** WebSocket hello 之前产生的 mcp/fetch 响应先暂存，客户端注册后再投递。 */
  private enqueuePendingTargetedEvent(clientId: string, channel: string, args: unknown[]): void {
    this.prunePendingTargetedEvents(clientId);
    const pending = this.pendingTargetedEvents.get(clientId) || [];
    pending.push({
      channel,
      args,
      expiresAtMs: Date.now() + TARGETED_EVENT_QUEUE_TTL_MS,
    });
    if (pending.length > MAX_PENDING_TARGETED_EVENTS_PER_CLIENT) {
      pending.splice(0, pending.length - MAX_PENDING_TARGETED_EVENTS_PER_CLIENT);
    }
    this.pendingTargetedEvents.set(clientId, pending);
  }

  /** 客户端完成 hello/attach 后，补发它在握手窗口内错过的定向响应。 */
  private flushPendingTargetedEvents(clientId: string): void {
    this.prunePendingTargetedEvents(clientId);
    const pending = this.pendingTargetedEvents.get(clientId);
    if (!pending || pending.length === 0) return;
    const remaining: PendingTargetedEvent[] = [];
    for (const entry of pending) {
      if (!this.electronIpcPort.emitElectronEventTo(clientId, entry.channel, entry.args)) {
        remaining.push(entry);
      }
    }
    if (remaining.length > 0) {
      this.pendingTargetedEvents.set(clientId, remaining);
    } else {
      this.pendingTargetedEvents.delete(clientId);
    }
  }

  /** 将 app-server 或本地业务事件发回浏览器，优先使用定向投递避免多端串台。 */
  broadcastGatewayIpc(message: GatewayIpcBroadcastMessage): boolean {
    if (!message || typeof message !== "object") return false;
    const channel = String(message.channel || "");
    if (!channel) return false;
    const explicitClientId = typeof message.targetClientId === "string" ? message.targetClientId : "";
    const store = (this.requestContext && this.requestContext.getStore && this.requestContext.getStore()) || {};
    const clientId = explicitClientId || store.clientId || "";
    if (clientId && this.targetedChannels.has(channel)) {
      // 审批、fetch、文件预览等事件必须尽量回到触发它的那台浏览器。
      const delivered = this.electronIpcPort.emitElectronEventTo(clientId, channel, [message.payload ?? null]);
      if (delivered) return true;
      this.enqueuePendingTargetedEvent(clientId, channel, [message.payload ?? null]);
      return true;
    }
    return this.electronIpcPort.emitElectronEvent(channel, [message.payload ?? null]);
  }

  attachGatewayClient(client: GatewayWebClient): void {
    this.electronIpcPort.attachElectronClient(client);
    this.flushPendingTargetedEvents(client.clientId);
  }

  detachGatewayClient(clientId: string): void {
    this.electronIpcPort.detachElectronClient(clientId);
  }

  isGatewayClientConnected(clientId: string): boolean {
    return this.electronIpcPort.hasElectronClient(clientId);
  }
}
