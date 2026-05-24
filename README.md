# OpenCodex

**中文** | [English](docs/README_EN.md)

OpenCodex 是一个 Codex 运行环境的轻量实现，通过它能把官方 Codex Renderer 运行在普通 Web 环境中，使用户可以通过任意设备、任意网络，远程访问并操作目标机器上运行的 Codex。

一句话概括：

```text
browser -> web-shell -> official Codex renderer -> bridge polyfill -> gateway -> Codex app-server / local host capabilities
```

---
天塌了😭刚准备开源，谁知道一觉醒来ChatGPT App就对Codex做了支持

但对比官方还是有优势的：
1. 无需魔法上网
2. 无需Google Play账号
3. Codex完整功能支持，例如文件树、终端、审查等，便于随时随地AI Coding。


> 目前本软件仅为测试版，可能还存在不少问题，如若发现可issue反馈至开发者修复。

<p align="center">
  <img src="docs/image/start.jpg" alt="OpenCodex start" width="23%" />
  &nbsp;
  <img src="docs/image/settings.jpg" alt="OpenCodex settings" width="23%" />
  &nbsp;
  <img src="docs/image/home.jpg" alt="OpenCodex home" width="23%" />
  &nbsp;
  <img src="docs/image/new.jpg" alt="OpenCodex new session" width="23%" />
</p>

## 核心内容

本项目包含三部分核心内容：

| 模块 | 作用 |
| --- | --- |
| `web-shell/` | 浏览器入口，用于加载官方 renderer 和搭建Render运行环境。 |
| `gateway/` | 本地 Node gateway，提供 HTTP、WebSocket、IPC 兼容、本地文件、git、终端、状态同步和 app-server 转发。 |
| `/electron-to-web/` | Electron 语义适配层，gateway 默认优先使用它来复用 Electron IPC 行为，另有自实现的DirectGatewayElectronIpcPort。 |

本软件**不会修改**Codex的代码，仅使用对应Render产物。

Gateway启动时会自动检查本地Codex是否有更新，有更新时会自动更新使用的Render产物（也就是会自动更新到对应Codex版本）

## 架构概览

```mermaid
flowchart TB
  L1["访问层<br/>远程设备浏览器<br/>负责发起访问与展示交互界面"]

  L2["Web 宿主层<br/>web-shell<br/>负责在普通 Web 环境中承载官方 Renderer"]

  L3["Renderer 兼容层<br/>codex-bridge-polyfill<br/>负责补齐 Electron Renderer 运行依赖<br/>并把 Renderer 调用转换为 Web IPC"]

  L4["Gateway 层<br/>gateway<br/>负责认证、HTTP / WebSocket、IPC 分发<br/>以及目标机器侧的统一入口"]

  L5["宿主能力适配层<br/>Gateway IPC / electron-to-web / Direct IPC<br/>负责适配 Desktop 宿主语义、本地状态、文件、终端、Git 等能力"]

  L6["Codex 业务能力层<br/>Codex app-server<br/>负责会话、模型、配置、MCP、任务执行等核心业务能力"]

  L7["官方产物层<br/>Codex Desktop / Renderer Bundle<br/>负责提供官方 Renderer 产物与版本来源"]

  L1 --> L2
  L2 --> L3
  L3 --> L4
  L4 --> L5
  L5 --> L6

  L7 -.提供 Renderer 产物.-> L2
```

关键原则：

- 复用官方 Renderer，不重写主界面。
- 浏览器侧只补宿主环境，不承接业务语义。
- gateway 负责本地能力和 app-server 代理，避免远端浏览器直接接触本机 token 或 app-server。
- 未覆盖的 Desktop IPC 通过 `reports/unknown-ipc.jsonl` 持续记录并补齐。

## 环境要求

- Node.js 20 或更高版本
- pnpm
- 本机已安装 Codex Desktop（推荐），或通过环境变量显式指定 Codex Desktop / official bundle 路径。
- macOS / Windows。macOS、Windows 均提供 Launcher 构建命令。
- Windows 打包需要安装 Visual Studio 2022 C++ 构建工具，以及对应架构的 Spectre-mitigated VC++ 库，否则 `node-pty` 原生模块重编译会失败。

依赖安装：

注意要子模块取
```
git clone --recursive xxx
```

```bash
pnpm install
```

## 如何使用

### 桌面一键启动包

当前已提供 Launcher 打包入口。它会在启动时自动拉起 gateway，并在窗口里展示：

- 本机访问地址、gateway 进程和监听端口。
- 当前使用的 Codex 版本、build、Codex 安装路径、`app.asar` 路径和 CLI 路径。
- 配置文件、日志、报告和 official renderer 缓存目录。
- app-server 当前连接状态。
- 访问密码设置；密码为空时不启用认证。
- 启动地址设置；本机模式监听 `127.0.0.1`，局域网模式监听 `0.0.0.0` 并展示可访问的局域网地址。
- 端口设置；首次启动会随机选择一个可用端口并持久化，后续可手动指定端口。

安装依赖并构建后，可以本地调试 Launcher：

```bash
pnpm run desktop:dev
```

生成 macOS 安装产物：

```bash
pnpm run desktop:dist:mac
```

生成 Windows 安装产物：

```bash
pnpm run desktop:dist:win
```

产物会输出到 `release/`。Launcher 默认只监听 `127.0.0.1`，首次启动会随机选择一个可用端口，运行时数据放在系统用户数据目录中，不再写入安装目录。修改监听地址、端口或访问密码后，Launcher 会重启 gateway 让配置生效。

> 打包前仍需要本机已安装 Codex Desktop。Launcher 会复用本机 Codex Desktop 的 official renderer 和 app-server 能力。

#### 构建 macOS 安装包

从干净仓库构建 macOS 产物：

```bash
git clone --recursive xxx
cd OpenCodex
pnpm install
pnpm run build
pnpm run desktop:dist:mac
```

`desktop:dist:mac` 会先编译 `vendor/electron-to-web` 和 `gateway`，再通过 `electron-builder` 生成 `.dmg` 和 `.zip`。产物位于 `release/`：

```text
release/OpenCodex-<version>-arm64.dmg
release/OpenCodex-<version>-arm64-mac.zip
```

本机只验证当前架构时，可以直接指定架构，例如 Apple Silicon：

```bash
pnpm run build
pnpm exec electron-builder --mac dmg zip --arm64
```

调试未压缩 `.app`：

```bash
pnpm run build
pnpm exec electron-builder --mac --dir --arm64
```

生成的 `.app` 会在启动时创建用户数据目录，保存 Launcher 设置、访问密码配置、gateway 日志和 official renderer 缓存。

#### 构建 Windows 安装包

从干净仓库构建 Windows 产物：

```powershell
git clone --recursive xxx
cd OpenCodex
pnpm install
pnpm run build
pnpm run desktop:dist:win
```

`desktop:dist:win` 会先编译 `vendor/electron-to-web` 和 `gateway`，再通过 `electron-builder` 生成 x64 NSIS 安装器和 `.zip`。产物位于 `release/`。

调试未压缩 Windows 应用目录：

```powershell
pnpm run build
pnpm run desktop:pack:win
```

### 命令行启动

先编译

```bash
pnpm build
```

启动服务：

**强烈建议设置访问密码**。可以直接复制示例配置并编辑其中的密码：

```bash
cp config.example.yaml config.yaml
```

也可以手动在当前目录创建 `config.yaml`：

```yaml
auth:
  password: "你的密码"
```

首次启动后，gateway 会自动把该字段改写为 `sha256-v1:<hash>`，避免明文密码留在配置文件里。没有 `config.yaml`、没有 `auth.password` 或字段为空时，不启用访问密码认证。
目前只支持上面的块状 YAML 写法，不支持 `auth: { password: "..." }` 这类 inline 写法。

```bash
HOST=0.0.0.0 PORT=3737 pnpm run web:dev
```

健康检查：

```text
curl http://127.0.0.1:3737/api/health
```

远端访问：

配合Tailscale、ZeroTier、企业自建VPN等实现**远程局域网**安全访问，**不建议直接暴露公网**。


## 常用环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | gateway 监听地址，默认面向远程访问。 |
| `PORT` | `3737` | gateway 监听端口。 |
| `CODEX_WEB_AUTH_TOKEN_TTL_MS` | `43200000` | gateway 访问 token 有效期，默认 12 小时。 |
| `CODEX_WEB_DEBUG` | 空 | 设为 `1` 或 `true` 后输出更多调试日志。 |
| `CODEX_WEB_SLOW_LOG_MS` | `750` | IPC 慢调用日志阈值。 |
| `CODEX_WEB_LOCAL_FILE_TOKEN_TTL_MS` | `300000` | 本地文件预览 URL token 有效期。 |
| `CODEX_DESKTOP_APP_PATH` | 自动扫描 | 指定 Codex Desktop 安装路径或 `app.asar` 所在路径。 |
| `CODEX_WEB_RUNTIME_DIR` | 项目目录 | 指定 gateway 运行时目录；Launcher 会设置到用户数据目录。 |
| `CODEX_WEB_CONFIG_PATH` | `config.yaml` | 指定访问密码配置文件路径。 |
| `CODEX_WEB_REPORTS_DIR` | `reports` | 指定诊断报告目录。 |
| `CODEX_WEB_OFFICIAL_BUNDLE_DIR` | `cache/codex-official-bundle` | 指定官方 webview 解包缓存目录。 |
| `CODEX_WEB_IPC_IMPL` | `electron-to-web` | 设为 `direct` 可使用 direct IPC 兜底实现。 |


## 文件/目录说明

| 路径 | 说明 |
| --- | --- |
| `gateway/src/server.ts` | gateway 启动入口，组装 HTTP、WebSocket、认证、official bundle、IPC 和 app-server。 |
| `gateway/src/codex-app-server.ts` | Codex app-server 客户端，负责连接、请求转发、缓存预热和健康状态。 |
| `gateway/src/ipc/` | gateway IPC 抽象和 Electron/Codex 兼容实现。 |
| `gateway/src/official/` | Codex Desktop app.asar 扫描、识别、缓存和 webview 解包逻辑。 |
| `web-shell/index.html` | 浏览器 bootstrap shell，负责登录页、设置入口和加载 patched official renderer。 |
| `web-shell/codex-bridge-polyfill.js` | 浏览器侧 Electron/Codex bridge polyfill。 |
| `reports/unknown-ipc.jsonl` | 运行时记录的未知 IPC。 |

## pnpm 脚本

| 脚本 | 说明 |
| --- | --- |
| `pnpm run build:gateway` | 编译 `gateway/src` 到 `gateway/dist`。 |
| `pnpm run web:dev` | 启动已编译的 gateway。 |
| `pnpm run build:vendor` | 编译 `vendor/electron-to-web`。 |
| `pnpm run test:vendor` | 运行 `vendor/electron-to-web` 测试。 |
| `pnpm run desktop:dev` | 编译后启动 Launcher 调试。 |
| `pnpm run desktop:pack:mac` | 生成未压缩的 macOS `.app`。 |
| `pnpm run desktop:dist:mac` | 生成 macOS `.dmg` 和 `.zip` 产物。 |
| `pnpm run desktop:pack:win` | 生成未压缩的 Windows 应用目录。 |
| `pnpm run desktop:dist:win` | 生成 Windows NSIS 安装器和 `.zip` 产物。 |

## 排障

### 打开会话历史聊天空

第一次加载较慢，且受到远程局域网速率限制，一般看不到记录等一会就好。

### 启动后打不开页面

先确认 gateway 是否监听成功：

```bash
curl http://127.0.0.1:3737/api/health
```

如果端口冲突，换端口启动：

```bash
PORT=3738 pnpm run web:dev
```

### 找不到 Codex Desktop official bundle

显式指定本机 Codex Desktop 路径：

```bash
CODEX_DESKTOP_APP_PATH="/Applications/Codex.app" pnpm run web:dev
```

也可以指定缓存目录：

```bash
CODEX_WEB_OFFICIAL_BUNDLE_DIR="./cache/official-bundle" pnpm run web:dev
```

### IPC 行为不完整

查看未知 IPC 记录然后报告给开发者：

```bash
tail -f reports/unknown-ipc.jsonl
```

### 友链

[LinuxDo](https://linux.do/)
