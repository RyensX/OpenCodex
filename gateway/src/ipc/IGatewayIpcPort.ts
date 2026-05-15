import type { GatewayInvokeContext, GatewayIpcBroadcastMessage, GatewayWebClient } from "./types";

/**
 * gateway 对外暴露的总 IPC 端口。
 *
 * 这一层不关心底层 Electron IPC 是自研还是 electron-to-web，也不关心
 * Codex 业务请求最终是本地处理还是转发到 app-server。调用方只需要按
 * channel/payload 进来，具体分流由实现类完成。
 */
export abstract class IGatewayIpcPort {
  /** 处理浏览器发起的 invoke/send，返回结果或抛出可展示给前端的错误。 */
  abstract invokeGatewayIpc(
    channel: string,
    payload: unknown,
    context: GatewayInvokeContext
  ): Promise<unknown>;

  /** 处理 app-server/Codex 业务侧主动推给浏览器的事件。 */
  abstract broadcastGatewayIpc(message: GatewayIpcBroadcastMessage): boolean;

  /** 浏览器 WebSocket 建连后注册到 IPC 端口，后续才能收到广播事件。 */
  abstract attachGatewayClient(client: GatewayWebClient): void;

  /** 浏览器断开时释放连接引用，避免后续广播命中失效连接。 */
  abstract detachGatewayClient(clientId: string): void;

  /** 给业务层判断“某个目标浏览器是否还在线”，审批/终端等场景会用到。 */
  abstract isGatewayClientConnected(clientId: string): boolean;
}
