export type GatewayClientId = string;

/** 单次 IPC 调用的上下文，来自当前 WebSocket/HTTP 请求。 */
export interface GatewayInvokeContext {
  /** 发起请求的浏览器连接 ID，用于把审批、fetch 等响应定向发回同一个页面。 */
  clientId?: GatewayClientId;
  /** 远端地址只在 gateway 内部做审计/策略判断，不传给浏览器底层能力。 */
  remoteAddress?: string;
  /** Electron window.setTitle 的语义适配，由 gateway 决定如何落地。 */
  setTitle?: (title: unknown) => boolean;
  /** Electron shell.openExternal 的语义适配，避免远端设备直接接触本机 shell。 */
  openExternal?: (url: unknown) => boolean;
  /** 本地文件预览入口，返回的是 gateway 授权过的临时 URL。 */
  openFile?: (filePath: string, payload?: unknown) => unknown;
}

/** gateway 向浏览器广播的统一消息格式。 */
export interface GatewayIpcBroadcastMessage {
  channel: string;
  payload?: unknown;
  /** 有值时优先只发给指定客户端，避免多设备访问时串台。 */
  targetClientId?: GatewayClientId;
}

/** gateway 眼里的一个浏览器客户端，底层通常是 WebSocket。 */
export interface GatewayWebClient {
  readonly clientId: GatewayClientId;
  /** 发送前必须检查连接是否还活着，避免向断开的浏览器写数据。 */
  isOpen(): boolean;
  /** 以 { channel, payload } 的形式投递给 web-shell。 */
  sendGatewayEvent(channel: string, payload: unknown): boolean;
}

/** Electron IPC handler 的统一函数签名，args 保持 Electron invoke/send 的参数数组语义。 */
export type GatewayElectronHandler = (
  args: unknown[],
  context: GatewayInvokeContext
) => Promise<unknown> | unknown;
