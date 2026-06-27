# Xvfb 无头运行指南

OpenCodex 本身是一个 Codex Desktop Web 中间层，让浏览器访问 Codex。原版仅支持 macOS/Windows，通过 Xvfb 可使其在无显示器的 Linux 服务器上运行。

## 原理

Codex Desktop 基于 Electron，需要一个 X Window 显示环境渲染界面。Xvfb（X Virtual Framebuffer）在内存中模拟一个虚拟显示器，Electron 将画面输出到虚拟显示器上，无需物理屏幕或桌面环境。

```
无头服务器                 用户浏览器
┌──────────────────┐      ┌─────────────┐
│  Xvfb :99        │      │             │
│  (虚拟 framebuffer)│     │ 手机/平板/   │
│       ↑          │      │ 另一台电脑   │
│  Codex Desktop   │◄────►│             │
│  (Electron)      │ HTTP │             │
│       ↑          │  +WS │             │
│  OpenCodex        │      │             │
│  Gateway         │────►│             │
└──────────────────┘      └─────────────┘
```

## 前置条件

安装 Xvfb：

```bash
# Debian/Ubuntu
sudo apt install xvfb

# CentOS/RHEL/Fedora
sudo yum install xorg-x11-server-Xvfb
```

另需 Node.js、pnpm 以及 Codex Desktop Linux 版。

## 获取 Codex Desktop Linux

Codex Desktop 官方仅提供 macOS/Windows 版。Linux 版由社区项目 [ilysenko/codex-desktop-linux](https://github.com/ilysenko/codex-desktop-linux) 自动从上游 macOS DMG 构建：

```bash
git clone https://github.com/ilysenko/codex-desktop-linux.git
cd codex-desktop-linux
make bootstrap-native
```

产物位于 `codex-app/` 目录，结构为：

```
codex-app/
├── electron        # Electron 二进制
├── resources/
│   └── app.asar    # Codex Desktop 应用代码
├── locales/
└── ...
```

OpenCodex 默认期望 `CODEX_DESKTOP_PATH` 指向此目录。

## 启动 Xvfb

```bash
Xvfb :99 -screen 0 1920x1080x24 -ac +extension GLX +render -noreset &
```

| 参数 | 说明 |
|------|------|
| `:99` | 显示编号，通过 `DISPLAY=:99` 引用 |
| `-screen 0 1920x1080x24` | 分辨率 1920×1080，24 位色深 |
| `-ac` | 关闭访问控制 |
| `+extension GLX` | 启用 GLX 扩展（某些 Electron 应用需要） |
| `+render` | 启用 Render 扩展 |
| `-noreset` | 不自动重置 |

确认运行：

```bash
pgrep -a Xvfb
```

## 环境变量

启动前需设置的关键环境变量：

| 变量 | 说明 | 示例 |
|------|------|------|
| `DISPLAY` | Xvfb 显示编号 | `:99` |
| `CODEX_DESKTOP_APP_PATH` | Codex Desktop 安装目录（含 `app.asar`） | `/tmp/codex-desktop-linux/codex-app` |
| `CODEX_DESKTOP_EXECUTABLE_PATH` | Electron 可执行文件路径 | `/tmp/codex-desktop-linux/codex-app/codex` |
| `CODEX_CLI_PATH` | Codex CLI 二进制路径 | `/opt/codex-cli/codex` |
| `CODEX_HOME` | Codex 配置目录 | `~/.codex` |

`DISPLAY` 指向 Xvfb。其余变量让 OpenCodex 知道 Electron 和 Codex CLI 的位置，以及配置文件存放路径。

## 修改 Electron 启动参数

原始仓库 `gateway/dev/run-gateway.cjs` 中仅传入 `--user-data-dir`：

```js
const officialRuntimeArgs = [`--user-data-dir=${officialUserDataDir}`];
```

在无头 Linux 上需改为：

```js
const officialRuntimeArgs = [
  `--user-data-dir=${officialUserDataDir}`,
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
];
```

| 参数 | 说明 |
|------|------|
| `--no-sandbox` | 服务器环境下 Chrome 沙箱通常不可用（root 运行或容器环境），不加会导致 Electron 启动失败 |
| `--disable-setuid-sandbox` | 配合 `--no-sandbox` 禁用 setuid 辅助进程 |
| `--disable-dev-shm-usage` | 避免 `/dev/shm` 过小（容器默认 64MB）导致崩溃，改用普通内存 |

## 启动 OpenCodex

```bash
export DISPLAY=:99
export CODEX_DESKTOP_APP_PATH=/tmp/codex-desktop-linux/codex-app
export CODEX_DESKTOP_EXECUTABLE_PATH=/tmp/codex-desktop-linux/codex-app/codex
export CODEX_CLI_PATH=/opt/codex-cli/codex

cd /path/to/OpenCodex
pnpm install
PORT=3737 pnpm run web:dev
```

访问 `http://服务器IP:3737` 即可使用。

如设置了密码，先编辑 `config.yaml`：

```yaml
auth:
  password: "你的密码"
```

## 与 systemd 集成

```ini
# /etc/systemd/system/xvfb.service
[Unit]
Description=X Virtual Frame Buffer Service
After=network.target

[Service]
ExecStart=/usr/bin/Xvfb :99 -screen 0 1920x1080x24 -ac +extension GLX +render -noreset
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now xvfb.service
```

## 常见问题

### Electron 无法启动 / "Cannot open display"

- 确认 Xvfb 是否运行：`pgrep -a Xvfb`
- 确认 `DISPLAY` 已设置：`echo $DISPLAY`
- 测试连接：`xdpyinfo -display :99`
- Xvfb 启动后未完全就绪，添加 `sleep 2` 等待

### 渲染异常 / 白屏

部分 Electron 应用依赖 GPU 加速，Xvfb 默认软件渲染可能不兼容。尝试禁用 GLX 扩展：

```bash
Xvfb :99 -screen 0 1920x1080x24 -ac -extension GLX &
```
