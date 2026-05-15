import type { GatewayWebClient as GatewayWebClientContract } from "./types";

/** 对单个浏览器 WebSocket 连接的轻量包装。 */
export class GatewayWebClient implements GatewayWebClientContract {
  readonly clientId: string;
  private readonly socket: any;

  constructor({ clientId, socket }: { clientId: string; socket: any }) {
    this.clientId = clientId;
    this.socket = socket;
  }

  isOpen(): boolean {
    return !!this.socket && this.socket.readyState === this.socket.OPEN;
  }

  /** gateway 统一以 channel/payload 消息投递给 web-shell，由前端再还原成 Electron 事件。 */
  sendGatewayEvent(channel: string, payload: unknown): boolean {
    if (!this.isOpen()) return false;
    try {
      this.socket.send(JSON.stringify({ channel, payload }));
      return true;
    } catch {
      return false;
    }
  }
}
