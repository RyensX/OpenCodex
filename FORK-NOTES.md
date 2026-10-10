# FORK-NOTES — OpenCodex fork 改动与合并手册

本 fork（upstream = `RyensX/OpenCodex`）在原项目上新增了
**「服务器中继」远程管控能力**（PC 端主动反连 VPS，浏览器经 VPS 统一入口访问各设备）。
本文档是合并 upstream 时的**唯一权威改动清单**：所有侵入 upstream 文件的位置都带
`[OCX-FORK]` 注释标记，可用全文搜索 `[OCX-FORK]` 快速定位。

## 改动分层总览

| 层级 | 位置 | 合并冲突风险 |
| --- | --- | --- |
| 全新目录（upstream 完全没有） | `launcher/fork/`、`gateway/runtime/relay/`、`proxy/`、`codex-gateway/` | **零冲突** |
| 薄改动（1~5 处，均带标记） | `launcher/main.cjs`、`launcher/preload.cjs`、`gateway/runtime/ipc/official-runtime.cjs`、`pnpm-workspace.yaml` | 低 |
| UI 整块新增（带 BEGIN/END 标记） | `launcher/index.html`、`launcher/renderer.js`、`launcher/styles.css` | 中（upstream 改设置页时） |
| i18n 纯 key 追加 | `shared/i18n/locales/zh-CN.json`、`en-US.json` | 低（JSON 追加） |

## 一、全新文件（合并零冲突，无需处理）

| 文件 | 职责 |
| --- | --- |
| `launcher/fork/relay-core.cjs` | launcher 主进程的**全部中继业务逻辑**：字段 normalize、relay settings schema（`RELAY_DEFAULT_FIELDS`/`normalizeRelayFields`）、随机设备身份（`ensureRelayIdentity`）、env 转译（`relayChildEnv`）、访问地址拼接（`relayPrimaryUrl`）、`launcher:update-relay` IPC handler（`createRelayIpcHandler`）。通过 `createRelayCore(deps)` 依赖注入，不反向依赖 main.cjs |
| `launcher/fork/dev-debug.cjs` | dev 期诊断：CDP 9222 端口（`enableDevRemoteDebugging`）、renderer console 转发 + 捕获阶段事件探针（`attachWindowDiagnostics`）。仅 `!app.isPackaged` 生效 |
| `gateway/runtime/relay/relay-config.cjs` | 反连客户端配置（读 `OCX_RELAY_*` 环境变量，浏览器登录态独立校验） |
| `gateway/runtime/relay/reverse-tunnel-client.cjs` | 反向隧道客户端：出站 WS 反连 VPS，多路复用 HTTP/WS（帧协议 register/open/head/data/end/ws-open/ws-close/ping，**逐帧保真含 `bin` 帧类型**） |
| `proxy/deploy.sh` | Linux/systemd 部署管理（安装、启动、停止、重启、更新、状态、日志）；默认 HTTP，更新保留用户数据并支持启动失败回滚 |
| `proxy/server.js` | VPS 中继服务端：看板（账号密码登录、AES-256-GCM 加密存储 auth.json、改密码/改用户名、登录失败 5 次冻结该 IP 10 分钟带倒计时）、`/d/<id>/` 透明反代（HTTP+WS，逐帧保真）、设备 cookie 根路径通配反代、re-bind 冲突保护 |
| `gateway/test/proxy.integration.cjs` | 中继服务 36 项集成检查（`pnpm test:proxy`，含 WS 帧类型严格校验、改用户名/重名/冻结回归） |
| `docs/PROXY_DEPLOYMENT.md`、`codex-gateway/**` | 部署文档（`codex-gateway/` 内方案 A 遗留文件已废弃可删） |

## 二、薄改动的 upstream 文件（合并时按标记处理）

### `launcher/main.cjs`（改动收敛后 +69/-4，全部带 `[OCX-FORK]` 标记）

| 位置 | 改动 | 合并建议 |
| --- | --- | --- |
| 文件头 | require fork/ 两文件 + `enableDevRemoteDebugging(app)` | 保留（纯追加，紧跟 electron require 后） |
| `defaultSettings()` | `...RELAY_DEFAULT_FIELDS` 1 行 | 保留 spread 行 |
| `loadLauncherSettings()` | `delete parsed.relayUrl`（迁移清理）+ `...normalizeRelayFields(parsed)` | 保留两处 |
| `saveLauncherSettings()` | `...normalizeRelayFields(settings)` + `delete nextSettings.relayUrl` | 保留 |
| `updateGatewayUrls()` | `primaryUrl = relayPrimaryUrl(settings) \|\| (原表达式)` | **注意保留 upstream 对原表达式的修改**，fork 只是前缀一个 `\|\|` 分支 |
| `openOpenCodex()` | 开头 6 行：服务器模式直接打开 VPS 设备页 | 保留分支 |
| `startGatewayOnce()` | spawn 前 5 行：`relayChildEnv` 转译注入 | 保留 |
| `createWindow()` | `attachWindowDiagnostics(mainWindow, appendLog)` 1 行 | 保留 |
| `ipcMain.handle("launcher:update-relay", ...)` | 工厂调用（deps 清单见 relay-core.cjs） | 保留整块 |

### `launcher/preload.cjs`（1 行）

`updateRelay: (relay) => ipcRenderer.invoke("launcher:update-relay", relay),` —— contextBridge 必须内嵌，合并时保留。

### `gateway/runtime/ipc/official-runtime.cjs`（1 行表达式）

`buildGatewayStatus()` 的 `ok:` 判定改为「纯 unsupported 降级不算异常」。若 upstream 重构了
compatibility 结构，按语义移植：只有真实故障（location/application/verification/activation 失败且无兜底）才让 `ok=false`。

### `pnpm-workspace.yaml`（1 行）

`esbuild: true`（allowBuilds）—— pnpm v11 构建脚本白名单必需，保留。

### `README.md`（+22 行，整块新增）

「### 远程访问」章节末尾的「### 服务器中继部署（多设备统一入口）」小节（`[OCX-FORK] BEGIN/END` 包裹），
介绍服务器中继模式并跳转 `docs/PROXY_DEPLOYMENT.md`。合并时保留整块；若 upstream 改动该章节周边文字，块外正常合并即可。

## 三、UI 整块新增（带标记，合并冲突时保留 fork 块）

- `launcher/index.html`：hostModeGroup 新增「服务器」选项 + `relayPanel` 面板（`[OCX-FORK] BEGIN/END` 包裹）。
- `launcher/renderer.js`：`relayEditing` 状态、`renderRelay()` 函数、`render()` 内 1 行调用、
  `saveRelay` 点击分支（保存失败保持编辑态）、focusin 编辑态、`renderHostMode` 内 relayPanel 显隐。
- `launcher/styles.css`：`.setting-item[hidden]` 修复 + `.relay-*` 样式块（`BEGIN/END` 包裹）。

## 四、合并操作建议

```bash
git fetch upstream
git merge upstream/main          # 或 rebase，看个人习惯
# 冲突文件几乎只会出现在「二、三」两节清单里：
# 1. 先 grep -n "[OCX-FORK]" <冲突文件> 定位 fork 改动语义
# 2. fork 逻辑本体都在 fork/ 或 relay/ 新文件，冲突大概率是 upstream 改了周边行
# 3. 解冲突原则：fork 的新增块（标记内）保留；upstream 对同一函数的重构照常接受，
#    再把 fork 薄调用点（1~3 行）接到新结构上
# 4. 合并后必跑验证（见下）
```

## 五、改动守则（给未来的自己）

1. **新逻辑一律进新文件**：launcher 侧进 `launcher/fork/`，gateway 侧进 `gateway/runtime/relay/`，
   服务端进 `proxy/`；main.cjs 只允许出现 1~3 行的薄调用点。
2. **凡是动到 upstream 原文件，必须加 `[OCX-FORK]` 注释标记**（并同步更新本文档）。
3. 修改 relay/WS 协议时，`gateway/test/proxy.integration.cjs` 必须同步补用例（协议级断言，不只是内容断言）。
4. 改完必跑验证：`pnpm run build:gateway` + 仓库根目录 `pnpm test:proxy`（36 项集成检查）+ dev 冒烟。

## 六、验证命令

```bash
# 1) gateway 编译（含 modification-boundaries 检查）
pnpm run build:gateway
# 2) 中继服务端自测（36 项集成检查 ALL PASS）
pnpm test:proxy
# 3) launcher dev 冒烟
pnpm run launcher:dev
```
