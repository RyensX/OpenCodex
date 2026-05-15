import type { GatewayInvokeContext } from "../types";

/**
 * Codex 业务 IPC 抽象。
 *
 * 这一层只关心 Codex 自身的业务 channel，例如会话、模型、设置、
 * 终端、审批等。它不负责实现 Electron 的通用 IPC 语义。
 */
export abstract class IGatewayCodexIpcPort {
  /** 返回当前业务层明确接管的 channel，用于注册到 Electron IPC 语义层。 */
  abstract listCodexChannels(): readonly string[];

  /** 判断某个 channel 是否应该由 Codex 业务层处理，避免未知 Electron IPC 被误吞。 */
  abstract canHandleCodexChannel(channel: string): boolean;

  /** 执行业务 IPC，必要时会转发给 codex app-server 或本地 gateway 能力。 */
  abstract handleCodexRequest(
    channel: string,
    payload: unknown,
    context: GatewayInvokeContext
  ): Promise<unknown> | unknown;
}
