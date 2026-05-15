import type { GatewayElectronHandler, GatewayInvokeContext, GatewayWebClient } from "../types";

/**
 * Electron IPC 语义层抽象。
 *
 * 这里刻意只描述 Electron 的通用语义：handle/invoke/send/客户端连接。
 * Codex 业务 channel 不应该散落在这一层，这样后续可以在自研实现和
 * electron-to-web 实现之间切换，而不影响业务 IPC。
 */
export abstract class IGatewayElectronIpcPort {
  /** 注册一个类似 ipcMain.handle(channel, handler) 的 invoke handler。 */
  abstract registerElectronHandler(channel: string, handler: GatewayElectronHandler): void;

  /** 发起一个类似 ipcRenderer.invoke(channel, ...args) 的请求。 */
  abstract invokeElectron(channel: string, args: unknown[], context: GatewayInvokeContext): Promise<unknown>;

  /** 广播一个类似 webContents.send(channel, ...args) 的事件。 */
  abstract emitElectronEvent(channel: string, args: unknown[]): boolean;

  /** 定向给某个浏览器客户端发送事件，避免多端连接时互相干扰。 */
  abstract emitElectronEventTo(clientId: string, channel: string, args: unknown[]): boolean;

  /** 浏览器连接接入 Electron IPC 语义层。 */
  abstract attachElectronClient(client: GatewayWebClient): void;

  /** 浏览器连接断开时从 Electron IPC 语义层移除。 */
  abstract detachElectronClient(clientId: string): void;

  /** 查询客户端是否还在线，用于判断定向事件是否可以投递。 */
  abstract hasElectronClient(clientId: string): boolean;

  /** 可选生命周期钩子，默认实现无资源需要释放。 */
  dispose(): void {}
}
