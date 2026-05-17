# Codex IPC桥接映射

| Renderer channel/method | Gateway 处理器 | App-server 方法 | 状态 | 说明 |
| --- | --- | --- | --- | --- |
| app:getPlatform | host:platform | n/a | 已桥接 | 返回 Web 运行平台标识。 |
| app:getVersion | host:version | n/a | 已桥接 | 返回 Web gateway 的版本占位值。 |
| app:getConfig | host:config | n/a | 已桥接 | 返回 renderer 启动所需的最小运行时配置。 |
| workspace-root-options | workspace-root-options | n/a | 已桥接 | 返回允许暴露给 Web 的工作区根目录。 |
| add-workspace-root-option | add-workspace-root-option | n/a | 已桥接 | 把本地项目根目录保存到兼容 Electron globalState 的存储中。 |
| paths-exist | paths-exist | n/a | 已桥接 | 检查本地路径是否存在，避免项目根目录被误判为已删除。 |
| workspace-directory-entries | workspace-directory-entries | n/a | 已桥接 | 只列出 allowlist 工作区内的文件目录。 |
| get-global-state | get-global-state | n/a | 已桥接 | 按 key 返回 renderer 启动所需的最小全局状态。 |
| set-global-state | set-global-state | n/a | 已桥接 | 把 Electron globalState 风格 UI 状态写回本机 Codex Desktop globalState。 |
| list-pinned-threads | list-pinned-threads | n/a | 已桥接 | 由 gateway 本地处理。 |
| extension-info | extension-info | n/a | 已桥接 | 由 gateway 本地处理。 |
| os-info | os-info | n/a | 已桥接 | 返回运行浏览器宿主机的系统信息。 |
| is-copilot-api-available | is-copilot-api-available | n/a | 已桥接 | 从 Web bridge 侧报告 Copilot API 是否可用。 |
| list-automations | list-automations | n/a | 已桥接 | 由 gateway 本地处理。 |
| list-pending-automation-run-threads | list-pending-automation-run-threads | n/a | 已桥接 | 由 gateway 本地处理。 |
| active-workspace-roots | active-workspace-roots | n/a | 已桥接 | 以字符串数组返回当前允许使用的工作区根目录。 |
| local-environments | local-environments | n/a | 已桥接 | 返回空的本地环境列表，用于兼容 Desktop renderer。 |
| has-custom-cli-executable | has-custom-cli-executable | n/a | 已桥接 | 报告是否配置了自定义 CLI 可执行文件。 |
| open-in-targets | open-in-targets | n/a | 已桥接 | 浏览器 gateway 不提供原生打开目标，因此返回空列表。 |
| native-desktop-app-by-bundle-id | native-desktop-app-by-bundle-id | n/a | 已桥接 | 解析 Desktop 工具/文件行需要的 macOS 应用元数据。 |
| native-desktop-app-icon | native-desktop-app-icon | n/a | 已桥接 | 返回安全的原生应用图标占位数据，兼容浏览器 renderer。 |
| open-file | open-file | n/a | 已桥接 | 可预览时返回由 gateway 授权托管的文件 URL。 |
| read-file | read-file | n/a | 已桥接 | 按官方 `{ contents }` 结构读取 allowlist 内 UTF-8 文本文件，供审查侧栏源码 tab 使用。 |
| read-file-metadata | read-file-metadata | n/a | 已桥接 | 按官方 `{ isFile, sizeBytes }` 结构读取真实文件状态，供审查侧栏判断源码、rich 或 binary preview。 |
| read-file-binary | read-file-binary | n/a | 已桥接 | 按官方 `{ contentsBase64 }` 结构读取 allowlist 内文件 base64 内容，供图片、PDF、artifact 和附件预览。 |
| set-open-review-file-source-tabs | set-open-review-file-source-tabs | n/a | 已桥接 | 记录审查侧栏当前打开的源码 tab 并 ACK。 |
| set-open-file-tabs | set-open-file-tabs | n/a | 已桥接 | 记录普通文件侧栏当前打开的文件 tab 并 ACK。 |
| set-review-pane-snapshot-metrics-for-host | set-review-pane-snapshot-metrics-for-host | n/a | 已桥接 | 记录审查 diff 指标并 ACK。 |
| get-configuration | get-configuration | n/a | 已桥接 | 为 renderer 配置开关返回保守默认值。 |
| set-configuration | set-configuration | n/a | 已桥接 | 把 Electron configuration 风格 UI 设置写回本机 Codex Desktop globalState。 |
| set-remote-control-connections-enabled | set-remote-control-connections-enabled | n/a | 已桥接 | 把远程控制开关同步写回本机 Codex Desktop globalState。 |
| git-origins | git-origins | n/a | 已桥接 | 由 gateway 本地处理。 |
| inbox-items | inbox-items | n/a | 已桥接 | 由 gateway 本地处理。 |
| ambient-suggestions | ambient-suggestions | n/a | 已桥接 | 由 gateway 本地处理。 |
| ambient-suggestions-refresh | ambient-suggestions-refresh | n/a | 已桥接 | 确认手动刷新 ambient suggestions 的请求。 |
| projectless-workspace-root | projectless-workspace-root | n/a | 已桥接 | 有可用工作区时返回第一个 allowlist 根目录。 |
| email-domain-mail-provider | email-domain-mail-provider | n/a | 已桥接 | 为注册流程返回尽力推断的邮箱服务商提示。 |
| codex-home | codex-home | n/a | 已桥接 | 返回本机 Codex home 路径。 |
| locale-info | locale-info | n/a | 已桥接 | 返回浏览器宿主机的语言和时区信息。 |
| projects:list | projects:list | n/a | 已桥接 | 把 allowlist 工作区根目录作为本地项目候选返回。 |
| projects:browse | projects:browse | n/a | 已桥接 | 只允许浏览 allowlist 工作区内的目录项。 |
| threads:list | threads:list | thread/list | 已桥接 | 转发到真实 app-server 的 thread/list 方法。 |
| thread:list | thread:list | thread/list | 已桥接 | 转发到真实 app-server 的 thread/list 方法。 |
| settings:get | settings:get | config/read (for codexConfig) | 已桥接 | codexConfig 读 app-server，Electron UI 设置读本机 Desktop globalState。 |
| settings:set | settings:set | config/batchWrite (for codexConfig) | 已桥接 | codexConfig 通过明确 edits 写 app-server，Electron UI 设置写本机 Desktop globalState。 |
| window:setTitle | window:setTitle | n/a | 已桥接 | 在浏览器 shell 内处理。 |
| shell:openExternal | shell:openExternal | n/a | 已桥接 | 委托给浏览器 window.open。 |
| codex:initialize | codex:initialize | initialize | 已桥接 | 首次 app-server 握手转发。 |
| codex_desktop:message-from-view | codex_desktop:message-from-view | n/a | 已桥接 | 浏览器 shell 接收并确认 renderer 发往 host 的消息。 |
| mcp-request | mcp-request | account/read and related MCP methods | 已桥接 | 把 renderer 发起的 MCP 请求处理后以 mcp-response 返回。 |
| fetch /wham/accounts/check | fetch -> /wham/accounts/check | n/a | 已桥接 | 由 gateway 本地处理。 |
| fetch /wham/* | fetch -> ChatGPT backend | getAuthStatus | 已桥接 | 由 gateway 使用真实 app-server auth token 代理认证后的 ChatGPT backend 请求。 |
| fetch /aip/* | fetch -> ChatGPT backend | getAuthStatus | 已桥接 | 由 gateway 使用真实 app-server auth token 代理认证后的 ChatGPT backend 请求。 |
| account/login/start (via mcp-request) | mcp-request -> account/login/start | account/login/start | 已桥接 | 通过 app-server 转发 account/login/start。 |
| account/login/cancel (via mcp-request) | mcp-request -> account/login/cancel | account/login/cancel | 已桥接 | 通过 app-server 转发 account/login/cancel。 |
| config/read (via mcp-request) | mcp-request -> config/read | config/read | 已桥接 | 直接转发 app-server；app-server 不可用时返回真实错误。 |
| configRequirements/read (via mcp-request) | mcp-request -> configRequirements/read | configRequirements/read | 已桥接 | 可用时从当前 app-server 返回配置要求。 |
| persisted-atom-sync-request | persisted-atom-sync | n/a | 已桥接 | host 返回 persisted state 快照。 |
| persisted-atom-update | persisted-atom-updated | n/a | 已桥接 | 更新会同步写回本机 Codex Desktop 的 persisted atom。 |
| codex_desktop:get-shared-object-snapshot | codex_desktop:get-shared-object-snapshot | n/a | 已桥接 | 返回本地 shared-object 快照。 |
| shared-object-set | shared-object-set | n/a | 已桥接 | 更新本地 shared-object 快照。 |
| shared-object-subscribe | shared-object-subscribe | n/a | 已桥接 | gateway 确认该订阅请求，用于兼容 renderer。 |
| codex_desktop:worker:*:from-view | codex_desktop:worker:*:from-view | n/a | 已桥接 | 接收 worker 消息，并在需要时稍后回传响应。 |
| codex_desktop:worker:*:for-view | codex_desktop:worker:*:for-view | n/a | 已桥接 | worker 消息订阅通道。 |
| codex_desktop:system-theme-variant-updated | codex_desktop:system-theme-variant-updated | n/a | 已桥接 | 浏览器主题变化可通过该通道广播。 |
| codex_desktop:trigger-sentry-test | codex_desktop:trigger-sentry-test | n/a | 已桥接 | 由 gateway 本地处理。 |
| thread:start | thread:start | thread/start | 已桥接 | 尽力映射到 app-server JSON-RPC 方法。 |
| send-cli-request-for-host | send-cli-request-for-host | requested method | 已桥接 | 官方 AppServerRequestClient host bridge，按 payload.method 转发到 app-server。 |
| prewarm-thread-start-for-host | prewarm-thread-start-for-host | thread/start | 已桥接 | 官方预热线程创建入口，转发 thread/start 并记录 workspace 元数据。 |
| refresh-recent-conversations-for-host | refresh-recent-conversations-for-host | thread/list | 已桥接 | 官方会话列表刷新入口，转发 thread/list。 |
| unsubscribe-thread-for-host | unsubscribe-thread-for-host | n/a | 已桥接 | 确认非活跃会话取消订阅请求，Web 侧无需额外释放原生资源。 |
| broadcast-conversation-snapshot | broadcast-conversation-snapshot | n/a | 已桥接 | 确认官方 renderer 的会话快照广播请求。 |
| capture-browser-use-turn-route | capture-browser-use-turn-route | n/a | 已桥接 | 确认 Browser Use turn route 捕获请求。 |
| capture-computer-use-turn-route | capture-computer-use-turn-route | n/a | 已桥接 | 确认 Computer Use turn route 捕获请求。 |
| update-thread-git-branch | update-thread-git-branch | n/a | 已桥接 | 确认 turn 完成后的 git branch 展示更新请求。 |
| start-windows-sandbox-setup-for-host | start-windows-sandbox-setup-for-host | n/a | 已桥接 | Windows sandbox setup 在 Web gateway 中暂不执行，返回稳定 ACK。 |
| start-conversation | start-conversation | thread/start + turn/start | 已桥接 | 把 Desktop host 动作适配为真实 app-server 的 thread/turn 请求。 |
| turn:start | turn:start | turn/start | 已桥接 | 尽力映射到 app-server JSON-RPC 方法。 |
| turn:interrupt | turn:interrupt | turn/interrupt | 已桥接 | 尽力映射到 app-server JSON-RPC 方法。 |
| approval:respond | approval:respond | approval/respond | 已桥接 | 尽力映射到 app-server JSON-RPC 方法。 |
| file:readPreview | file:readPreview | file/readPreview | 已桥接 | 在 gateway 内做 workspace-root 校验后处理。 |
| file:stat | file:stat | file/stat | 已桥接 | 在 gateway 内做 workspace-root 校验后处理。 |
| git:status | git:status | git/status | 已桥接 | 先在允许的工作区内尝试本地 git status 兜底，再按需转发 app-server。 |
| apply-patch | apply-patch | n/a | 已桥接 | 按官方 `review_patch`/`thread_diff` payload 在 allowlist 内执行 `git apply`，返回 applied/skipped/conflicted 路径。 |
| list-archived-threads | list-archived-threads | n/a | 已桥接 | 从本机 Codex Desktop globalState 返回归档会话列表。 |
| archive-conversation | archive-conversation | n/a | 已桥接 | 在本机 Codex Desktop globalState 中把会话标记为归档。 |
| unarchive-conversation | unarchive-conversation | n/a | 已桥接 | 从本机 Codex Desktop globalState 的归档列表中移除该会话。 |
| worktree-delete | worktree-delete | n/a | 已桥接 | 由 gateway 本地处理。 |
