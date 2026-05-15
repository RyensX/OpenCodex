import { IGatewayElectronIpcPort } from "./IGatewayElectronIpcPort";
import type { GatewayElectronHandler, GatewayInvokeContext, GatewayWebClient } from "../types";

/** 把 gateway 的 WebSocket 客户端适配成 electron-to-web 期望的 socket 形状。 */
class ElectronToWebClientSocketAdapter {
  readonly OPEN = 1;
  private readonly client: GatewayWebClient;

  constructor(client: GatewayWebClient) {
    this.client = client;
  }

  get readyState(): number {
    return this.client.isOpen() ? this.OPEN : 3;
  }

  /** electron-to-web 发出的 JSON-RPC notification 会在这里转成 web-shell 的 channel 事件。 */
  send(raw: unknown): void {
    let message: any = null;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!message || typeof message !== "object") return;
    if (message.method && !Object.prototype.hasOwnProperty.call(message, "id")) {
      const params = Array.isArray(message.params) ? message.params : [];
      const payload = params.length <= 1 ? (params[0] ?? null) : params;
      this.client.sendGatewayEvent(String(message.method), payload);
    }
  }
}

/**
 * 基于 electron-to-web 的 Electron IPC 语义层实现。
 *
 * gateway 仍然只依赖 IGatewayElectronIpcPort；这里负责把抽象方法映射到
 * electron-to-web 的 ipcMain/BrowserWindow 能力。
 */
export class ElectronToWebGatewayElectronIpcPort extends IGatewayElectronIpcPort {
  private readonly ipcMain: any;
  private readonly window: any;
  private readonly requestContext: any;
  private readonly clientIds = new Set<string>();
  private nextRequestId = 1;

  constructor({ electronToWeb, requestContext }: { electronToWeb: any; requestContext: any }) {
    super();
    this.ipcMain = electronToWeb.ipcMain;
    this.window = new electronToWeb.BrowserWindow();
    this.requestContext = requestContext;
  }

  /** 注册 ipcMain.handle，handler 执行时会带上当前请求上下文。 */
  registerElectronHandler(channel: string, handler: GatewayElectronHandler): void {
    this.ipcMain.handle(channel, async (_event: unknown, ...args: unknown[]) => {
      const context = (this.requestContext && this.requestContext.getStore && this.requestContext.getStore()) || {};
      return handler(args, context);
    });
  }

  /**
   * 模拟 renderer 发起 ipcRenderer.invoke。
   *
   * electron-to-web 内部走 JSON-RPC，这里用一个 fake websocket 捕获响应，
   * 从而保持 gateway 对外仍然是 Promise 返回值。
   */
  async invokeElectron(channel: string, args: unknown[], context: GatewayInvokeContext): Promise<unknown> {
    const id = this.nextRequestId++;
    let response: any = null;
    const fakeWs = {
      OPEN: 1,
      readyState: 1,
      send(raw: unknown) {
        response = JSON.parse(String(raw));
      },
    };
    const request = {
      jsonrpc: "2.0",
      id,
      method: channel,
      params: args,
    };
    const clientId = context.clientId || "gateway";
    await this.requestContext.run(context, () =>
      this.ipcMain.handleMessage(fakeWs, JSON.stringify(request), clientId)
    );
    if (!response) throw new Error(`No Electron IPC response for ${channel}`);
    if (response.error) throw new Error(response.error.message || `Electron IPC failed: ${channel}`);
    return response.result;
  }

  /** 使用 electron-to-web 的 BrowserWindow.webContents.send 广播事件。 */
  emitElectronEvent(channel: string, args: unknown[]): boolean {
    let delivered = false;
    for (const clientId of this.clientIds) {
      delivered = this.hasElectronClient(clientId) || delivered;
    }
    if (!delivered) return false;
    try {
      this.window.webContents.send(channel, ...args);
      return true;
    } catch {
      return false;
    }
  }

  /** 只向某个 clientId 对应的浏览器连接发送事件。 */
  emitElectronEventTo(clientId: string, channel: string, args: unknown[]): boolean {
    if (!this.hasElectronClient(clientId)) return false;
    try {
      this.window.webContents.sendTo(clientId, channel, ...args);
      return true;
    } catch {
      return false;
    }
  }

  /** 新浏览器连接进入时，同时注册到 electron-to-web 的 ipcMain 客户端表。 */
  attachElectronClient(client: GatewayWebClient): void {
    this.clientIds.add(client.clientId);
    this.ipcMain.addClient(client.clientId, new ElectronToWebClientSocketAdapter(client));
  }

  /** 浏览器断开时同步清理 electron-to-web 的客户端引用。 */
  detachElectronClient(clientId: string): void {
    this.clientIds.delete(clientId);
    this.ipcMain.removeClient(clientId);
  }

  /** 以 electron-to-web 的客户端表为准判断连接是否可用。 */
  hasElectronClient(clientId: string): boolean {
    const socket = this.ipcMain.getClient(clientId);
    return !!socket && socket.readyState === socket.OPEN;
  }
}
