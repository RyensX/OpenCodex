import { IGatewayElectronIpcPort } from "./IGatewayElectronIpcPort";
import type { GatewayElectronHandler, GatewayInvokeContext, GatewayWebClient } from "../types";

/**
 * 自研的最小 Electron IPC 语义层实现。
 *
 * 当前主要作为 electron-to-web 不可用时的兜底，或者调试时通过
 * CODEX_WEB_IPC_IMPL=direct 强制启用。
 */
export class DirectGatewayElectronIpcPort extends IGatewayElectronIpcPort {
  private readonly handlers = new Map<string, GatewayElectronHandler>();
  private readonly clients = new Map<string, GatewayWebClient>();

  /** 直接把 handler 存到 Map，模拟 ipcMain.handle 的注册表。 */
  registerElectronHandler(channel: string, handler: GatewayElectronHandler): void {
    this.handlers.set(channel, handler);
  }

  /** 直接查表并调用 handler；未知 channel 会显式抛错，不能静默返回 null。 */
  async invokeElectron(channel: string, args: unknown[], context: GatewayInvokeContext): Promise<unknown> {
    const handler = this.handlers.get(channel);
    if (!handler) throw new Error(`No Electron IPC handler registered for ${channel}`);
    return handler(args, context);
  }

  /** 向所有当前在线的浏览器客户端广播事件。 */
  emitElectronEvent(channel: string, args: unknown[]): boolean {
    const payload = args.length <= 1 ? (args[0] ?? null) : args;
    let delivered = false;
    for (const client of this.clients.values()) {
      delivered = client.sendGatewayEvent(channel, payload) || delivered;
    }
    return delivered;
  }

  /** 向指定浏览器客户端发送事件。 */
  emitElectronEventTo(clientId: string, channel: string, args: unknown[]): boolean {
    const client = this.clients.get(clientId);
    const payload = args.length <= 1 ? (args[0] ?? null) : args;
    return client ? client.sendGatewayEvent(channel, payload) : false;
  }

  /** 连接建立时注册客户端。 */
  attachElectronClient(client: GatewayWebClient): void {
    this.clients.set(client.clientId, client);
  }

  /** 连接断开时释放客户端引用。 */
  detachElectronClient(clientId: string): void {
    this.clients.delete(clientId);
  }

  /** 判断客户端是否还在线。 */
  hasElectronClient(clientId: string): boolean {
    const client = this.clients.get(clientId);
    return !!client && client.isOpen();
  }
}
