# OpenCodex

**中文** | [English](docs/README_EN.md)

OpenCodex 是一个Codex Desktop中间层，它可以让你直接使用手机、平板或另一台电脑通过浏览器访问并操作目标机器上的 Codex，让你可以随时随地AI Coding。

---
天塌了😭刚准备开源，谁知道一觉醒来 ChatGPT App 就对 Codex 做了支持。

但对比官方还是有一些使用场景上的优势：

1. 无需魔法上网。
2. 无需外区Google Play/苹果账号。
3. 支持 Codex 的完整功能，例如文件树、终端、审查等，便于随时随地 AI Coding。
4. 自由搭配内网穿透/公网，无需经过官方中继服务器，速度快且数据易于保护隐私数据。

---

## 特性

- 通过浏览器访问目标机器上的 Codex，无需魔法网络和账号，支持手机、平板、电脑等多种设备。
- 原汁原味Codex使用体验。
- 支持本机访问、局域网访问和配合 Tailscale / ZeroTier / VPN 的远程局域网访问。
- 支持设置访问密码，避免无认证暴露。
- 提供桌面启动器，可可视化配置监听地址、端口和访问密码等。
- 启动时会自动更新到本地 Codex Desktop 版本，自动兼容新版本功能。
- 针对移动端提供优化。

<p align="center">
  <img src="docs/image/start.jpg" alt="OpenCodex start" width="23%" />
  &nbsp;
  <img src="docs/image/settings.jpg" alt="OpenCodex settings" width="23%" />
  &nbsp;
  <img src="docs/image/home.jpg" alt="OpenCodex home" width="23%" />
  &nbsp;
  <img src="docs/image/new.jpg" alt="OpenCodex new session" width="23%" />
</p>

## 环境要求

- Node环境
- pnpm
- 本机已安装 Codex Desktop（无需启动，但也支持同时使用）。
- macOS 或 Windows（Linux暂未测试）。

## 如何使用

### 桌面启动器

下载安装：

打开release下载安装包安装

本地调试：

```bash
pnpm install
```

```bash
pnpm run launcher:dev
```

生成 macOS 安装包：

```bash
pnpm run launcher:dist:mac
```

生成 Windows 安装包：

```bash
pnpm run launcher:dist:win
```

产物会输出到 `release/`。首次启动会随机选择一个可用端口，修改监听地址、端口或访问密码后会自动重启服务让配置生效。

> 使用前需要本机已安装 Codex Desktop。

### 命令行启动

如果只是临时调试，也可以通过命令行启动：

局域网：
```bash
pnpm install
PORT=3737 pnpm run web:dev
```

支持远程访问：
```bash
pnpm install
HOST=0.0.0.0 PORT=3737 pnpm run web:dev
```

`强烈建议设置访问密码和修改端口`。可以复制示例配置后编辑其中的密码：

```bash
cp config.example.yaml config.yaml
```

配置示例：

```yaml
auth:
  password: "你的密码"
```

启动后访问：

```text
http://127.0.0.1:3737
```

### 远程访问

OpenCodex本身不提供远程访问服务，如果需要在其他设备中远程访问，请使用Tailscale、ZeroTier、Cloudflare Tunnel、企业自建 VPN 等方式搭建网络，然后在启动器中打开局域网模式进行访问。

> 也可以使用公网，但不建议把 OpenCodex 直接暴露到公网，还是推荐上述工具，更加安全可控

## 常用环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | 命令行 gateway 监听地址。 |
| `PORT` | `3737` | 命令行 gateway 监听端口。 |
| `OPENCODEX_HOST` | `127.0.0.1` | Launcher 首次启动 gateway 时使用的默认监听地址。 |
| `OPENCODEX_PORT` | 随机可用端口 | Launcher 首次启动 gateway 时使用的默认端口。 |
| `OPENCODEX_PREFERRED_LANGUAGES` | `zh-CN` | OpenCodex 自有界面语言首选列表，支持 JSON 数组或逗号分隔，例如 `["zh-Hans-CN","en-CN"]`。Launcher 会自动传入系统首选语言。 |
| `OPENCODEX_PLUGIN_DIRS` | 空 | 外部插件根目录，结构需与 `web-shell/plugins` 一致；多个目录可用系统路径分隔符或 JSON 数组传入。 |
| `OPENCODEX_LOG_MAX_MB` | `10` | Launcher 写入的 `gateway.log` 单文件大小上限，单位 MB；最多额外保留一个 `gateway.log.old`。 |
| `CODEX_WEB_CONFIG_PATH` | `config.yaml` | gateway 认证配置文件路径。 |
| `CODEX_WEB_AUTH_TOKEN_TTL_MS` | `43200000` | gateway 访问 token 有效期，默认 12 小时。 |
| `CODEX_WEB_DEBUG` | 空 | 设为 `1` 或 `true` 后输出更多调试日志。 |
| `CODEX_WEB_SLOW_LOG_MS` | `750` | IPC 慢调用日志阈值，单位毫秒。 |
| `CODEX_WEB_LOCAL_FILE_TOKEN_TTL_MS` | `300000` | 本地文件预览 URL token 有效期，单位毫秒。 |
| `CODEX_DESKTOP_APP_PATH` | 自动扫描 | 指定 Codex Desktop 安装路径或 `app.asar` 所在路径。 |
| `CODEX_DESKTOP_EXECUTABLE_PATH` | 自动扫描 | Windows/Linux 下指定 Codex Desktop Electron 可执行文件路径。 |
| `CODEX_APP_SERVER_BINARY_PATH` | 自动扫描 | Windows 下指定 Codex app-server/CLI 可执行文件路径。 |
| `CODEX_CLI_PATH` | 自动扫描 | Windows 下指定 Codex CLI 可执行文件路径。 |
| `CODEX_WEB_RUNTIME_DIR` | `.data/runtime` | 命令行 gateway 运行目录；打包态由 Launcher 指向用户数据目录。 |
| `CODEX_WEB_OFFICIAL_BUNDLE_DIR` | `.data/cache/codex-official-bundle` | 指定官方 bundle 解包缓存目录。 |
| `CODEX_WEB_OFFICIAL_AUTO_SCAN_UPGRADE` | `1` | 控制是否在启动时自动扫描官方 Codex 运行时更新；设为 `0` 后优先复用现有缓存，仅在缓存缺失或不可用时扫描。 |
| `CODEX_WEB_OFFICIAL_USER_DATA_DIR` | `.data/official-user-data` | 指定官方 Electron profile 隔离目录。 |
| `CODEX_WEB_OFFICIAL_TMPDIR` / `CODEX_WEB_OFFICIAL_TMP_DIR` | 自动生成 | 指定官方 hidden runtime 的临时目录，用于隔离官方 IPC socket。 |
| `CODEX_WEB_REPORTS_DIR` | `.data/reports` | gateway 诊断报告输出目录。 |
| `CODEX_WEB_WORKSPACE_ROOTS` | 空 | 初始 workspace roots，多个路径用逗号分隔。 |
| `CODEX_HOME` | `~/.codex` | Codex CLI / app-server 的配置和运行数据目录。 |

### 高级调试环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `CODEX_WEB_PICKED_FILES_MAX_COUNT` | `20` | Web 端临时 picked file 请求目录数量上限。 |
| `CODEX_WEB_PICKED_FILE_MAX_BYTES` | `52428800` | 单个 picked file 大小上限，单位字节。 |
| `CODEX_WEB_PICKED_FILES_MAX_TOTAL_BYTES` | `104857600` | picked file 临时目录总大小上限，单位字节。 |
| `CODEX_WEB_PICKED_FILE_TTL_MS` | `86400000` | picked file 临时目录保留时间，单位毫秒。 |
| `CODEX_WEB_DISABLE_ASSET_CACHE` | 空 | 设为 `1` 后禁用 gateway 静态资源缓存。 |
| `CODEX_WEB_DISABLE_GZIP` | 空 | 设为 `1` 后禁用 gateway gzip 响应压缩。 |
| `OPENCODEX_DEBUG_WS` | 空 | 设为 `1` 后启用 WebSocket/app-host 链路诊断。 |
| `OPENCODEX_WS_LARGE_LOG_BYTES` | `262144` | WebSocket 大消息日志阈值，单位字节。 |
| `OPENCODEX_WS_SEND_SLOW_MS` | `80` | WebSocket 发送慢日志阈值，单位毫秒。 |
| `OPENCODEX_WS_STRINGIFY_SLOW_MS` | `20` | WebSocket JSON 序列化慢日志阈值，单位毫秒。 |
| `OPENCODEX_WS_BUFFERED_LOG_BYTES` | `524288` | WebSocket bufferedAmount 日志阈值，单位字节。 |
| `OPENCODEX_APP_HOST_TRAFFIC_FLUSH_MS` | `2000` | app-host 流量统计 flush 间隔，单位毫秒。 |
| `OPENCODEX_APP_HOST_LARGE_FRAME_BYTES` | `65536` | app-host 大帧日志阈值，单位字节。 |
| `OPENCODEX_WS_DISABLE_DEFLATE` | 空 | 设为 `1` 后关闭 WebSocket permessage-deflate。 |
| `OPENCODEX_WS_DEFLATE_THRESHOLD` | `65536` | WebSocket 压缩启用阈值，单位字节。 |
| `OPENCODEX_WS_DEFLATE_CONCURRENCY` | `4` | WebSocket 压缩并发限制。 |
| `OPENCODEX_WS_DEFLATE_LEVEL` | `3` | WebSocket zlib 压缩等级。 |

## 常见问题

### 第一次打开会话历史为空

第一次加载可能较慢，也会受到远程局域网网速影响。稍等一会后再刷新或重新进入即可。

### 会话同步不及时

如果你把OpenCodex和官方Desktop同时使用，因为两者都各自维护一个会话状态，虽然是同一个数据但是可能并不会完全实时同步。

推荐无论是本地还是远程都直接只使用OpenCodex，可以配合PWA，体验和官方Desktop相差无几。

### 启动后打不开页面

可以先确认服务是否正常：

```bash
curl http://127.0.0.1:3737/api/health
```

如果端口被占用，可以换一个端口：

```bash
PORT=3738 pnpm run web:dev
```

## 插件系统

OpenCodex自带插件系统，可以通过插件对Codex做一些功能增强，欢迎广大开发者基于本系统开发插件

- [插件开发文档](docs/PLUGINS.md)

## 友链

[LinuxDo](https://linux.do/)
