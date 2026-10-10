# openCodeProxy —— OpenCodex 反向隧道代理（VPS 统一入口）

部署在**有公网 IP 的 VPS** 上的单文件代理服务：接收 PC 端 OpenCodex 的主动反连，提供设备导航看板，并把浏览器对 `/d/<accessPath>/*` 的 HTTP 与 WebSocket 请求透明代理到对应 PC。

```
浏览器 ──HTTP/WS（可选 HTTPS/WSS）──> VPS(openCodeProxy :8443) <──WS /openCodeProxy 反连── PC1 (OpenCodex gateway)
                                      │<──WS /openCodeProxy 反连── PC2 (OpenCodex gateway)
```

- PC 端**零入站端口、零公网暴露**：由 PC 主动出站反连，VPS 是唯一公网入口。
- 依赖仅 `ws`，无数据库、无外部服务，单文件 `server.js`。
- 服务端源码位于仓库的 [`proxy/`](../proxy/) 目录；PC 端反连客户端实现在 [`gateway/runtime/relay/`](../gateway/runtime/relay/)，随安装包内置，无需单独部署。

## 目录结构

```
proxy/
├── server.js         # 代理服务端（唯一运行文件）
├── package.json      # 依赖声明（ws）
├── deploy.sh         # Linux/systemd 一键部署与管理
├── devices.json      # 运行时自动生成：设备与密钥持久化
└── key.pem/cert.pem  # 运行时自备：TLS 证书（仅启用 HTTPS 时需要）
```

## 一键部署与管理

支持使用 systemd 的 Linux 服务器，缺少依赖时通过 apt/dnf 安装 Node.js、npm 和 curl。默认安装目录 `/opt/proxy`、服务名 `openCodeProxy.service`、默认端口 `8443`（安装时可自定义，占用时自动顺延），使用 **HTTP/WS**，不生成自签证书。

以下命令需在本次代码发布到仓库后执行；服务器必须能下载 GitHub 原始文件及 npm 依赖。

```bash
# 下载管理脚本并打开菜单（需要 root 或 sudo）
script=$(mktemp)
curl -fsSL https://raw.githubusercontent.com/laidichao/OpenCodex/main/proxy/deploy.sh -o "$script" && sudo bash "$script"
rm -f "$script"
```

菜单包含安装、启动、停止、重启、更新、状态、日志、修改端口。首次选择「安装」，按提示输入端口（直接回车使用默认值）。操作完成或失败后都会返回菜单，可以继续管理；选择 `0` 退出，选择 `9` 查看脚本内置的完整命令和操作说明。脚本提示当前配置端口，并提醒修改后同步防火墙及 PC 设置。

也可以一键安装并指定起始端口（以下以 9000 为例；root 执行时去掉 sudo）：

```bash
curl -fsSL https://raw.githubusercontent.com/laidichao/OpenCodex/main/proxy/deploy.sh -o /tmp/opencodex-deploy.sh && sudo bash /tmp/opencodex-deploy.sh install --port 9000
```

安装检查 IPv4/IPv6 端口占用；如果 9000 被占用，依次尝试 9001、9002，直到找到可用端口。到 65535 仍无可用端口则报错。最终端口写入 `relay.env`，并显示访问地址和需要放行的端口；PC 启动器也需要填写这个最终端口。端口探测与服务启动之间仍可能被其他进程抢占，此时按部署失败处理并回滚。

重复安装默认从当前配置端口开始检查，更新保持已配置端口。安装后也可以直接执行：

```bash
sudo bash /opt/proxy/deploy.sh install   # 安装或重新安装，保留配置和用户数据
sudo bash /opt/proxy/deploy.sh start
sudo bash /opt/proxy/deploy.sh stop
sudo bash /opt/proxy/deploy.sh restart
sudo bash /opt/proxy/deploy.sh update    # 下载新版本，失败回滚程序
sudo bash /opt/proxy/deploy.sh status
sudo bash /opt/proxy/deploy.sh port --port 9000 # 修改端口，占用时顺延
sudo bash /opt/proxy/deploy.sh logs
sudo bash /opt/proxy/deploy.sh           # 交互菜单
```

指定版本或源码目录时使用 `OCX_PROXY_SOURCE`（HTTPS 原始文件目录，包含 `server.js`、`package.json`、`deploy.sh`）：

```bash
sudo env OCX_PROXY_SOURCE="https://raw.githubusercontent.com/laidichao/OpenCodex/<提交或标签>/proxy" bash /opt/proxy/deploy.sh update
```

成功部署后记录该来源，后续更新沿用。部署只下载这三个文件并安装运行依赖，不下载集成测试。下载、语法检查、依赖安装完成后才停止服务；更新或重复安装保留 `relay.env`（安装时仅调整端口）、systemd 单元、`devices.json`、`auth.json`、`.auth.key` 和用户证书。新程序启动失败时恢复旧程序及此前运行状态；服务重启后需要重新登录。

配置位于 `/opt/proxy/relay.env`，修改后执行 `restart`：

```ini
RELAY_PORT=8443
RELAY_HOST=0.0.0.0
```

浏览器打开安装成功时显示的地址（默认 `http://<服务器地址>:8443/`）。自行放行实际监听端口及云安全组；脚本不修改防火墙。首次登录后立即修改初始密码。

### 在管理面板修改端口

- **命令行菜单**：运行 `sudo bash /opt/proxy/deploy.sh`，选择「8) 修改端口」，输入端口。也可执行 `sudo bash /opt/proxy/deploy.sh port --port 9000`。端口占用时自动顺延；正在运行的服务会重启，失败恢复原端口，原先停止的服务仍保持停止。
- **网页看板**：登录并完成首次改密后，在「监听端口」输入新端口并保存。新端口实际绑定成功、配置保存成功后才关闭旧监听；占用或写入失败会保留原入口并显示错误。成功后显示新访问地址，点击地址进入新端口。已有会话及隧道保留，后续连接需使用新端口。

两者共用 `/opt/proxy/relay.env` 的 `RELAY_PORT`。手动部署可用 `RELAY_CONFIG_FILE` 指定配置文件；直接传入 `RELAY_PORT` 环境变量时，重启仍以该显式环境变量为准。修改前请放行新端口，随后同步修改 PC 启动器中继端口；使用外部 HTTPS 反向代理时还需更新其上游端口，外部浏览器入口端口由反向代理配置决定。

### 可选 HTTPS

HTTP 可以完成登录、设备管理、页面加载和 WebSocket 中继。HTTP 传输不加密；跨公网使用时可选择 HTTPS。远程 HTTP 页面通常不是浏览器安全上下文，麦克风、异步剪贴板、通知及 Service Worker 等能力可能受限。看板复制按钮提供选区复制及手动复制回退。

如需 HTTPS，选择已有有效证书的反向代理，或自行准备有效 PEM 证书，在 `relay.env` 设置：

```ini
TLS_KEY=/path/to/private-key.pem
TLS_CERT=/path/to/certificate.pem
```

然后重启服务，并在 PC 启动器中勾选「使用 HTTPS」。使用外部 HTTPS 反向代理时，中继服务本身可继续使用 HTTP，反向代理需要转发 WebSocket 升级；PC 填外部域名和 HTTPS 端口。开关只决定连接协议，不申请证书，不跳过证书验证。

### 手动部署

```bash
mkdir -p /opt/proxy
# 将 proxy/server.js、proxy/package.json 上传到此目录
cd /opt/proxy
npm install --omit=dev
node server.js
```

需要常驻和开机启动时使用上方管理脚本。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `RELAY_PORT` | `8443` | 监听端口 |
| `RELAY_CONFIG_FILE` | `./relay.env` | 网页与命令行共享端口配置文件（可选） |
| `RELAY_HOST` | `0.0.0.0` | 监听地址 |
| `DEVICE_SECRETS` | 空 | 初始设备密钥表，`{"PC1":"s1"}` 或 `PC1=s1,PC2=s2`；**仅首次启动导入 devices.json**，兼容旧名 `AGENT_SECRETS` |
| `RELAY_DEVICES_FILE` | `./devices.json` | 设备与密钥持久化文件 |
| `RELAY_AUTH_FILE` | `./auth.json` | 账号数据持久化文件（AES-256-GCM 加密存储） |
| `RELAY_AUTH_KEY_FILE` | `./.auth.key` | 账号数据加密主密钥（首启自动生成，务必备份；丢失则账号数据不可解密，需删除 auth.json 重建） |
| `TLS_KEY` / `TLS_CERT` | 空 | PEM 证书路径；设置后启用 HTTPS/WSS（可选；默认 HTTP/WS） |

## 浏览器登录（账号密码）

看板与设备页使用账号密码登录（不再使用 Basic Auth，旧 `BROWSER_PASSWORD` 环境变量已弃用）：

- 首次启动自动创建默认账号 **admin / admin**，并标记「首次登录必须改密」。
- 登录后若未改密，访问任何页面都会被重定向到改密页；改密成功后解除。
- 账号数据（用户名、scrypt 口令哈希）整体以 **AES-256-GCM** 加密写入 `auth.json`（权限 600），主密钥独立存放于 `.auth.key`（权限 600）。
- 会话为 HttpOnly Cookie（12 小时滑动续期），服务重启后需重新登录。
- 登录连续失败 5 次将锁定该来源 IP 60 秒。

## 设备与密钥管理（看板）

设备表持久化在 `devices.json`（deviceId / secret / name / accessPath）。客户端上线后，deviceId 为设备 MAC；accessPath 是独立访问后缀。首次启动从 `DEVICE_SECRETS` 导入并落盘，之后**以文件为准**，改环境变量不再生效。

浏览器打开 `http://<服务器地址>:8443/`，用账号密码登录（首次部署为 admin/admin，登录后强制改密）：

- **添加设备**：输入名称（可留空），服务端生成登记条目、随机访问后缀与 32 位随机密钥；客户端连接后以 MAC 绑定设备身份。
- **复制密钥**：每台设备行内有「复制密钥」按钮。
- **删除设备**：密钥立即失效；在线连接会被踢掉。
- PC 端上线后注册的设备名会自动写回 `devices.json`。

设备管理 API（受登录会话保护）：

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/devices` | 列出全部注册设备（含密钥与在线状态） |
| `POST` | `/api/devices` | 添加设备，body `{"name":"办公机"}`，返回生成的 id/secret |
| `DELETE` | `/api/devices/<id>` | 删除设备 |
| `GET` | `/api/status` | 当前在线连接列表 |

## PC 端配置（OpenCodex）

1. 安装带中继功能的 OpenCodex（本 fork 构建的安装包）。
2. 打开设置 → **启动地址** 选 **「服务器」**（面板仅在此模式下显示）。
3. 填写：
   - **服务器 IP**：服务器 IP 或域名（端口默认 8443，可改）
   - **设备 MAC**：自动从本机网卡读取并保存，不可编辑，用于标识设备
   - **访问后缀**：留空使用单独生成并保存的 16 位随机码，无 `pc-` 前缀；也可填写自定义后缀，修改后缀不改变 MAC 身份
   - **本机名称**：留空用计算机名
   - **设备密钥**：从看板「添加设备」生成后复制粘贴
   - **使用 HTTPS**：默认不勾选，使用 HTTP/WS；服务器提供有效 HTTPS 入口时勾选，使用 HTTPS/WSS
4. 保存后自动重启服务，PC 主动反连 VPS；看板出现该设备即成功。

完整反连地址由 PC 端自动拼接：`ws://<服务器地址>:<端口>/openCodeProxy`；勾选 HTTPS 后为 `wss://<服务器地址>:<端口>/openCodeProxy`。

## 端点一览

| 路径 | 说明 |
|---|---|
| `WS /openCodeProxy?device=<mac>&path=<accessPath>&secret=<s>` | PC 端反连接入点（MAC 身份与访问后缀分离，注册即校验密钥） |
| `GET /` | 设备导航看板 |
| `GET/WS /d/<accessPath>/*` | 通过独立访问后缀进入该设备的 Codex Desktop（HTTP + WS 经隧道盲代理） |
| `GET/POST/DELETE /api/devices[/<id>]` | 设备管理 API |
| `GET/POST /api/settings/port` | 查询/修改中继监听端口，要求已改密的登录会话 |
| `GET /api/status` | 在线连接列表 |

## 透明代理关键点

浏览器访问 `/d/<accessPath>/codex-web-config.js` 时，服务端会把其中的 `gatewayWsUrl` 从
`location.origin + "/ws"` 自动改写为 `location.origin + "/d/<accessPath>/ws"`，使 web-shell **无需改源码**即走隧道路径；MAC 不作为浏览器访问后缀。

## 安全清单

- [ ] 首次登录 admin/admin 后已立即修改密码；`.auth.key` 已备份到安全位置
- [ ] 若使用 HTTPS，服务器证书有效且 PC 端已勾选「使用 HTTPS」
- [ ] 云安全组仅放行 `8443/TCP` 与 SSH
- [ ] 每台 PC 一个独立密钥；淘汰设备及时在看板删除

## 本地联调

```bash
pnpm install
pnpm test:proxy
# 期望输出：[test] ALL PASS ✅
```

脚本位于 [`gateway/test/proxy.integration.cjs`](../gateway/test/proxy.integration.cjs)，是独立的集成测试，不在部署目录或默认单元测试命令中。它会启动 mock gateway + 真实 server.js + 真实 PC 端反连客户端，验证 HTTP 代理、config.js 重写、WebSocket 隧道三项核心链路。
