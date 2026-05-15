// @ts-nocheck
export {};

let nodePty = null;
try {
  nodePty = require("node-pty");
} catch {}

const TERMINAL_REPLAY_BUFFER_LIMIT = 128 * 1024;
const TERMINAL_IDLE_CLEANUP_MS = Math.max(
  1_000,
  Number(process.env.CODEX_WEB_TERMINAL_IDLE_CLEANUP_MS || 30 * 60 * 1000)
);
const TERMINAL_IDLE_SWEEP_MS = Math.max(
  1_000,
  Number(process.env.CODEX_WEB_TERMINAL_IDLE_SWEEP_MS || Math.min(60 * 1000, TERMINAL_IDLE_CLEANUP_MS))
);

function createTerminalIpcHandlers(deps) {
  const terminalSessions = new Map();
  /** 终端事件广播给 web-shell，最终由 renderer 的终端组件消费。 */
  function broadcastTerminal(channel, payload) {
    if (typeof deps.broadcast === "function") {
      deps.broadcast({ channel, payload });
    }
  }


  /** 选择 PTY shell，默认跟随用户 SHELL。 */
  function getTerminalShell() {
    return process.env.SHELL || (process.platform === "win32" ? "powershell.exe" : "/bin/zsh");
  }

  /** 从 invoke context 中取浏览器 clientId。 */
  function contextClientId(context) {
    return context && typeof context === "object" && typeof context.clientId === "string"
      ? context.clientId
      : "";
  }

  /** 更新终端会话活跃时间，并记录最近使用它的浏览器 clientId。 */
  function touchTerminalSession(session, context) {
    if (!session) return;
    session.lastActivityMs = Date.now();
    const clientId = contextClientId(context);
    if (clientId) session.clientIds.add(clientId);
  }

  /** 判断终端会话是否仍有任何在线浏览器在使用。 */
  function terminalSessionHasConnectedClient(session) {
    if (!session || !session.clientIds || session.clientIds.size === 0) return false;
    for (const clientId of session.clientIds) {
      if (deps.isClientConnected(clientId)) return true;
    }
    return false;
  }

  /** 浏览器断开后，超过 idle 时间无人使用的 PTY 会被自动释放。 */
  function cleanupIdleTerminalSessions() {
    const now = Date.now();
    for (const [sessionId, session] of terminalSessions) {
      if (!session || session.clientIds.size === 0) continue;
      if (terminalSessionHasConnectedClient(session)) continue;
      if (now - session.lastActivityMs < TERMINAL_IDLE_CLEANUP_MS) continue;
      terminalSessions.delete(sessionId);
      try {
        session.ptyProcess.kill();
      } catch {}
      deps.logger &&
        deps.logger.info &&
        deps.logger.info(
          `[terminal] cleaned up idle disconnected session ${sessionId} after ${TERMINAL_IDLE_CLEANUP_MS}ms`
        );
    }
  }

  const terminalIdleCleanupTimer = setInterval(cleanupIdleTerminalSessions, TERMINAL_IDLE_SWEEP_MS);
  if (terminalIdleCleanupTimer && typeof terminalIdleCleanupTimer.unref === "function") {
    terminalIdleCleanupTimer.unref();
  }

  /** 创建或重新附着到 PTY 会话，并回放已有输出缓冲。 */
  function createTerminalSession(payload, context = {}) {
    if (!nodePty || typeof nodePty.spawn !== "function") {
      broadcastTerminal("terminal-error", {
        sessionId: payload && typeof payload === "object" ? payload.sessionId : null,
        message: "node-pty is not available",
      });
      return false;
    }
    if (!payload || typeof payload !== "object" || typeof payload.sessionId !== "string") return false;
    const existing = terminalSessions.get(payload.sessionId);
    if (existing) {
      touchTerminalSession(existing, context);
      const cols = Number.isFinite(Number(payload.cols)) ? Math.max(2, Number(payload.cols)) : null;
      const rows = Number.isFinite(Number(payload.rows)) ? Math.max(2, Number(payload.rows)) : null;
      if (cols && rows) {
        try {
          existing.ptyProcess.resize(cols, rows);
        } catch {}
      }
      broadcastTerminal("terminal-attached", {
        sessionId: payload.sessionId,
        cwd: existing.cwd,
        shell: existing.shell,
      });
      if (existing.outputBuffer) {
        broadcastTerminal("terminal-init-log", {
          sessionId: payload.sessionId,
          log: existing.outputBuffer,
        });
      }
      return true;
    }

    const cwd = deps.resolveGatewayTerminalCwd(payload);
    const shell = getTerminalShell();
    const cols = Number.isFinite(Number(payload.cols)) ? Math.max(2, Number(payload.cols)) : 80;
    const rows = Number.isFinite(Number(payload.rows)) ? Math.max(2, Number(payload.rows)) : 24;
    let ptyProcess;
    try {
      ptyProcess = nodePty.spawn(shell, [], {
        name: "xterm-256color",
        cols,
        rows,
        cwd,
        env: {
          ...process.env,
          TERM: "xterm-256color",
          COLORTERM: "truecolor",
        },
      });
    } catch (error) {
      broadcastTerminal("terminal-error", {
        sessionId: payload.sessionId,
        message: error instanceof Error ? error.message : String(error),
      });
      return false;
    }

    const session = {
      ptyProcess,
      cwd,
      shell,
      outputBuffer: "",
      lastActivityMs: Date.now(),
      clientIds: new Set(),
    };
    touchTerminalSession(session, context);
    terminalSessions.set(payload.sessionId, session);
    broadcastTerminal("terminal-attached", {
      sessionId: payload.sessionId,
      cwd,
      shell,
    });
    ptyProcess.onData((data) => {
      if (!data) return;
      session.outputBuffer += data;
      if (session.outputBuffer.length > TERMINAL_REPLAY_BUFFER_LIMIT) {
        session.outputBuffer = session.outputBuffer.slice(-TERMINAL_REPLAY_BUFFER_LIMIT);
      }
      broadcastTerminal("terminal-data", { sessionId: payload.sessionId, data });
    });
    ptyProcess.onExit(({ exitCode, signal }) => {
      terminalSessions.delete(payload.sessionId);
      broadcastTerminal("terminal-exit", {
        sessionId: payload.sessionId,
        code: exitCode,
        signal: signal == null ? null : String(signal),
      });
    });
    return true;
  }

  /** 主动关闭 PTY 会话。 */
  function closeTerminalSession(sessionId) {
    const session = terminalSessions.get(sessionId);
    if (!session) return true;
    terminalSessions.delete(sessionId);
    try {
      session.ptyProcess.kill();
    } catch {}
    return true;
  }

  /** 处理 terminal-* 消息，包括 create/write/resize/close/run-action。 */
  function handleTerminalMessage(payload, context = {}) {
    if (!payload || typeof payload !== "object") return false;
    const type = String(payload.type || "");
    const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : "";
    switch (type) {
      case "terminal-create":
      case "terminal-attach":
        return createTerminalSession(payload, context);
      case "terminal-write": {
        const session = terminalSessions.get(sessionId);
        if (!session) return false;
        touchTerminalSession(session, context);
        const data = typeof payload.data === "string" ? payload.data : "";
        if (data) session.ptyProcess.write(data);
        return true;
      }
      case "terminal-run-action": {
        const session = terminalSessions.get(sessionId);
        if (!session) return false;
        touchTerminalSession(session, context);
        const command = typeof payload.command === "string" ? payload.command : "";
        const cwd =
          typeof payload.cwd === "string" && payload.cwd && deps.isWithinAllowedRoots(payload.cwd)
            ? deps.normalizeWorkspacePath(payload.cwd)
            : null;
        session.ptyProcess.write(`${cwd ? `cd ${deps.shellQuote(cwd)} && ` : ""}${command}\r`);
        return true;
      }
      case "terminal-resize": {
        const session = terminalSessions.get(sessionId);
        if (!session) return false;
        touchTerminalSession(session, context);
        const cols = Number.isFinite(Number(payload.cols)) ? Math.max(2, Number(payload.cols)) : 80;
        const rows = Number.isFinite(Number(payload.rows)) ? Math.max(2, Number(payload.rows)) : 24;
        try {
          session.ptyProcess.resize(cols, rows);
        } catch {}
        return true;
      }
      case "terminal-close":
        return closeTerminalSession(sessionId);
      default:
        return false;
    }
  }


  return {
    handleTerminalMessage,
  };
}

module.exports = {
  createTerminalIpcHandlers,
};
