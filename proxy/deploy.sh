#!/usr/bin/env bash
# 中继部署管理：只替换程序文件，账号、设备密钥和用户配置始终保留。
# 开源用户入口（root）：下载本脚本后直接执行 bash deploy.sh，按菜单操作。
# 一键入口：curl -fsSL https://raw.githubusercontent.com/laidichao/OpenCodex/main/proxy/deploy.sh -o /tmp/opencodex-deploy.sh && bash /tmp/opencodex-deploy.sh
set -Eeuo pipefail

INSTALL_DIR=/opt/proxy
SERVICE=openCodeProxy.service
UNIT=/etc/systemd/system/$SERVICE
SOURCE=${OCX_PROXY_SOURCE:-https://raw.githubusercontent.com/laidichao/OpenCodex/main/proxy}
STAGE=
MUTATED=false
RECOVERY_REQUIRED=false
WAS_ACTIVE=false
REPLACED=()
REQUESTED_PORT=

die() { printf '%s\n' "$*" >&2; exit 1; }
cleanup() {
  # 回滚失败时保留备份，避免清理临时目录导致旧程序无法人工恢复。
  if [[ "$RECOVERY_REQUIRED" == true ]]; then
    printf '恢复未完成，程序备份保留于：%s/old\n' "$STAGE" >&2
  elif [[ -n "$STAGE" ]]; then
    rm -rf -- "$STAGE"
  fi
}
trap cleanup EXIT

rollback() {
  [[ "$MUTATED" == true ]] || return 0
  MUTATED=false
  systemctl stop "$SERVICE" || true
  # 恢复程序及安装时调整的端口配置；账号和设备数据保持原状。
  local file
  mkdir -p "$STAGE/failed"
  for file in "${REPLACED[@]}"; do
    [[ ! -e "$INSTALL_DIR/$file" ]] || mv "$INSTALL_DIR/$file" "$STAGE/failed/$file"
    [[ ! -e "$STAGE/old/$file" ]] || mv "$STAGE/old/$file" "$INSTALL_DIR/$file"
  done
  if [[ "$WAS_ACTIVE" == true ]]; then systemctl start "$SERVICE"; fi
  RECOVERY_REQUIRED=false
}
# 替换过程中任何命令失败都执行回滚，不仅处理启动失败。
trap 'rollback' ERR
trap 'rollback; exit 130' INT
trap 'rollback; exit 143' TERM

prepare_runtime() {
  # 仅在缺少运行依赖时使用系统包管理器，安装后检查实际 Node 版本。
  local packages=()
  command -v curl >/dev/null || packages+=(curl)
  command -v node >/dev/null || packages+=(nodejs)
  command -v npm >/dev/null || packages+=(npm)
  if ((${#packages[@]})); then
    if command -v apt-get >/dev/null; then
      apt-get update
      apt-get install -y "${packages[@]}"
    elif command -v dnf >/dev/null; then
      dnf install -y "${packages[@]}"
    else
      die '请先安装 Node.js >=16、npm 和 curl（自动安装支持 apt/dnf）。'
    fi
  fi
  node -e 'if(Number(process.versions.node.split(".")[0])<16)process.exit(1)' || die 'Node.js 版本必须 >=16，请升级系统 Node.js。'
}

# 安装与命令行修改端口共用 IPv4/IPv6 探测。
choose_port() {
  node - "$REQUESTED_PORT" <<'NODE'
const net = require('node:net');
// 实际尝试绑定，避免仅解析端口列表遗漏 IPv6 或其他监听进程。
function probe(port, host) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (error) => resolve(error.code));
    server.listen({ port, host, exclusive: true }, () => server.close(() => resolve(null)));
  });
}
(async () => {
  for (let port = Number(process.argv[2]); port <= 65535; port += 1) {
    let occupied = false;
    for (const host of ['0.0.0.0', '::']) {
      // 两种地址族均确认可用才选定，未启用 IPv6 的系统只检查 IPv4。
      const error = await probe(port, host);
      if (error === 'EADDRINUSE') { occupied = true; break; }
      if (host === '::' && ['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes(error)) continue;
      if (error) throw new Error(`端口 ${port} 探测失败：${error}`);
    }
    if (!occupied) { console.log(port); return; }
  }
  throw new Error('从指定端口到 65535 均被占用，没有可用端口');
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
NODE
}

deploy() {
  local operation=$1 file ready=false
  # 读取上次成功部署的下载地址，不把配置文件作为 shell 代码执行。
  if [[ -z "${OCX_PROXY_SOURCE:-}" && -f "$INSTALL_DIR/.deploy-source" ]]; then
    IFS= read -r SOURCE < "$INSTALL_DIR/.deploy-source"
  fi
  [[ "$SOURCE" == https://* && "$SOURCE" != *$'\n'* && "$SOURCE" != *$'\r'* ]] || die 'OCX_PROXY_SOURCE 必须是 HTTPS 源码目录地址。'
  SOURCE=${SOURCE%/}
  if [[ "$operation" == update && ! -f "$INSTALL_DIR/server.js" ]]; then
    die '尚未安装，请先执行 install。'
  fi
  # 下载及依赖安装全部完成后才停止现有服务；临时目录由系统生成并由退出钩子回收。
  prepare_runtime
  mkdir -p "$INSTALL_DIR"
  STAGE=$(mktemp -d "$INSTALL_DIR/.deploy.XXXXXXXX")
  mkdir "$STAGE/new" "$STAGE/old"
  for file in server.js package.json deploy.sh; do
    curl --fail --silent --show-error --location --connect-timeout 15 --max-time 120 "$SOURCE/$file" -o "$STAGE/new/$file"
  done
  node --check "$STAGE/new/server.js"
  bash -n "$STAGE/new/deploy.sh"
  (cd "$STAGE/new" && npm install --omit=dev --no-audit --no-fund)
  [[ -f "$STAGE/new/node_modules/ws/package.json" ]] || die '下载程序缺少 ws 运行依赖。'

  # 暂存配置；安装仅调整端口，更新沿用配置，失败时一起恢复。
  if [[ -f "$INSTALL_DIR/relay.env" ]]; then
    cp -p "$INSTALL_DIR/relay.env" "$STAGE/new/relay.env"
  else
    printf '# 默认 HTTP；通过 HTTPS 反向代理或自备 TLS_KEY/TLS_CERT 可启用 HTTPS。\nRELAY_PORT=8443\nRELAY_HOST=0.0.0.0\n' > "$STAGE/new/relay.env"
  fi
  chmod 600 "$STAGE/new/relay.env"
  if [[ ! -f "$UNIT" ]]; then
    cat > "$UNIT" <<EOF
[Unit]
Description=OpenCodex reverse tunnel relay
After=network.target

[Service]
WorkingDirectory=$INSTALL_DIR
EnvironmentFile=$INSTALL_DIR/relay.env
ExecStart=$(command -v node) $INSTALL_DIR/server.js
Restart=on-failure
RestartSec=3
UMask=0077

[Install]
WantedBy=multi-user.target
EOF
  fi
  systemctl daemon-reload
  systemctl is-active --quiet "$SERVICE" && WAS_ACTIVE=true
  systemctl stop "$SERVICE"
  MUTATED=true
  RECOVERY_REQUIRED=true
  if [[ "$operation" == install ]]; then
    # 停止自身服务后探测 IPv4/IPv6，避免重复安装把自己的端口误判为占用。
    local selected_port
    # 从请求端口开始查找可用监听端口。
    if ! selected_port=$(choose_port); then
      # 在父进程执行一次回滚，避免命令替换子进程重复移动备份。
      rollback
      die '没有可用端口，已恢复原配置和服务状态。'
    fi
    if [[ "$selected_port" != "$REQUESTED_PORT" ]]; then
      printf '端口 %s 被占用，自动顺延到 %s。\n' "$REQUESTED_PORT" "$selected_port"
    fi
    # 只替换 RELAY_PORT，保留 TLS、设备及其他用户设置。
    sed '/^RELAY_PORT=/d' "$STAGE/new/relay.env" > "$STAGE/new/relay.env.tmp"
    printf 'RELAY_PORT=%s\n' "$selected_port" >> "$STAGE/new/relay.env.tmp"
    mv "$STAGE/new/relay.env.tmp" "$STAGE/new/relay.env"
    chmod 600 "$STAGE/new/relay.env"
  fi
  # 备份和回滚仅处理白名单内的程序，绝不触碰 auth.json、.auth.key、devices.json。
  for file in server.js package.json package-lock.json node_modules deploy.sh relay.env; do
    [[ ! -e "$INSTALL_DIR/$file" ]] || mv "$INSTALL_DIR/$file" "$STAGE/old/$file"
    REPLACED+=("$file")
    [[ ! -e "$STAGE/new/$file" ]] || mv "$STAGE/new/$file" "$INSTALL_DIR/$file"
  done
  chmod 755 "$INSTALL_DIR/deploy.sh"
  if systemctl start "$SERVICE"; then
    # 等待真实端口响应，避免把进程刚启动就崩溃误判为成功；同时兼容自备 HTTPS。
    local port=8443 scheme=http attempt response
    port=$(sed -n 's/^RELAY_PORT=\([0-9][0-9]*\)$/\1/p' "$INSTALL_DIR/relay.env")
    port=${port:-8443}
    if grep -Eq '^TLS_(KEY|CERT)=.+' "$INSTALL_DIR/relay.env"; then scheme=https; fi
    for attempt in {1..15}; do
      if systemctl is-active --quiet "$SERVICE"; then
        # 本机探活不验证自备证书；客户端 HTTPS 的证书验证策略不受此操作影响。
        response=$(curl -k --silent --output /dev/null --write-out '%{http_code}' --max-time 2 "$scheme://127.0.0.1:$port/" || true)
        if [[ "$response" == 200 || "$response" == 302 ]]; then ready=true; break; fi
      fi
      sleep 1
    done
  fi
  if [[ "$ready" != true ]]; then
    # 恢复旧程序以及部署前的运行状态。
    rollback
    die '新程序启动失败，已恢复旧程序。请通过 logs 查看启动原因。'
  fi
  systemctl enable "$SERVICE"
  printf '%s\n' "$SOURCE" > "$INSTALL_DIR/.deploy-source"
  MUTATED=false
  RECOVERY_REQUIRED=false
  printf '部署成功。访问入口：%s://<服务器地址>:%s/\n管理命令：sudo bash %s/deploy.sh\n配置文件：%s/relay.env\n请自行放行 %s/TCP，并在 PC 启动器填写此端口；首次登录需修改初始密码。\n' "$scheme" "$port" "$INSTALL_DIR" "$INSTALL_DIR" "$port"
}

change_port() {
  [[ -f "$INSTALL_DIR/server.js" && -f "$INSTALL_DIR/relay.env" ]] || die '尚未安装，请先执行 install。'
  command -v node >/dev/null || die '缺少 Node.js，无法检查端口。'
  # 保留原配置，以便探测或重启失败时恢复原端口和运行状态。
  STAGE=$(mktemp -d "$INSTALL_DIR/.port.XXXXXXXX")
  mkdir "$STAGE/old" "$STAGE/new"
  cp -p "$INSTALL_DIR/relay.env" "$STAGE/old/relay.env"
  systemctl is-active --quiet "$SERVICE" && WAS_ACTIVE=true
  systemctl stop "$SERVICE"
  REPLACED=(relay.env)
  MUTATED=true
  RECOVERY_REQUIRED=true
  local selected_port
  # 停止自身服务后查找可用端口，占用时顺延。
  if ! selected_port=$(choose_port); then
    # 探测失败时保持原端口。
    rollback
    die '没有可用端口，已恢复原配置和服务状态。'
  fi
  sed '/^RELAY_PORT=/d' "$STAGE/old/relay.env" > "$STAGE/new/relay.env"
  printf 'RELAY_PORT=%s\n' "$selected_port" >> "$STAGE/new/relay.env"
  chmod 600 "$STAGE/new/relay.env"
  mv "$STAGE/new/relay.env" "$INSTALL_DIR/relay.env"
  if [[ "$WAS_ACTIVE" == true ]]; then
    systemctl start "$SERVICE"
    sleep 1
    systemctl is-active --quiet "$SERVICE"
  fi
  MUTATED=false
  RECOVERY_REQUIRED=false
  printf '端口已保存：%s（请求端口：%s）。请放行 %s/TCP 并同步修改 PC 中继端口。\n' "$selected_port" "$REQUESTED_PORT" "$selected_port"
}

show_help() {
  # 完整操作说明随脚本分发，离开仓库文档也能独立使用。
  cat <<'HELP'
OpenCodex 中继服务管理

交互入口：sudo bash deploy.sh
以 root 登录时可以省略 sudo。首次选择「安装」，输入监听端口即可。
默认 HTTP、端口 8443；安装或命令行改端口时，占用自动顺延。
安装后：sudo bash /opt/proxy/deploy.sh 随时再次打开管理菜单。

直接命令（自动化部署可用）：
  sudo bash deploy.sh install                 安装，默认端口 8443
  sudo bash deploy.sh install --port 9000     安装并指定起始端口
  sudo bash deploy.sh start                   启动
  sudo bash deploy.sh stop                    停止
  sudo bash deploy.sh restart                 重启
  sudo bash deploy.sh update                  更新程序，保留端口和用户数据
  sudo bash deploy.sh status                  查看服务状态
  sudo bash deploy.sh logs                    查看最近 100 条日志
  sudo bash deploy.sh port --port 9000        修改端口，占用时顺延
  sudo bash deploy.sh --help                  查看本说明

端口设置：
  菜单「修改端口」和网页看板「监听端口」均可设置。
  网页端口被占用时提示错误，并保留原入口。
  更改后请放行最终端口/TCP，并同步修改 PC 启动器中的中继端口。
  使用 HTTPS 反向代理时，还需同步修改代理的上游端口。

配置及数据：
  安装目录 /opt/proxy；端口配置 /opt/proxy/relay.env。
  更新保留账号、设备密钥、加密主密钥和配置；启动失败恢复旧程序。
  默认 HTTP 不申请证书；需要 HTTPS 时自备有效证书或反向代理。
  HTTP 不加密，远程浏览器的麦克风等能力可能受限。
  Linux/systemd 必需，缺少 Node.js/npm/curl 时通过 apt/dnf 安装。
  OCX_PROXY_SOURCE 可指定版本的 HTTPS 源码目录。
HELP
}

interactive_menu() {
  [[ "$EUID" -eq 0 ]] || die '请使用 sudo bash deploy.sh 或以 root 执行。'
  command -v systemctl >/dev/null || die '此脚本需要 Linux systemd。'
  local choice action default_port entered_port entry
  while true; do
    # 每次返回菜单重新读取端口，避免网页或其他终端改配置后展示旧值。
    default_port=8443
    if [[ -f "$INSTALL_DIR/relay.env" ]]; then
      default_port=$(sed -n 's/^RELAY_PORT=\([0-9][0-9]*\)$/\1/p' "$INSTALL_DIR/relay.env")
      default_port=${default_port:-8443}
    fi
    printf '\nOpenCodex 中继管理\n安装目录：%s\n配置端口：%s\n' "$INSTALL_DIR" "$default_port"
    printf '1) 安装中继（输入端口，占用自动顺延）\n2) 启动服务\n3) 停止服务\n4) 重启服务\n5) 更新程序（保留配置和用户数据）\n6) 查看状态\n7) 查看日志\n8) 修改端口（输入新端口并应用）\n9) 操作说明与命令帮助\n0) 退出\n'
    printf '首次使用请选择 1；修改端口后需放行端口并同步 PC 设置。\n'
    if ! read -r -p '选择操作：' choice; then return; fi
    case "$choice" in
      1) action=install;; 2) action=start;; 3) action=stop;; 4) action=restart;;
      5) action=update;; 6) action=status;; 7) action=logs;; 8) action=port;;
      9) show_help; continue;; 0) return;;
      *) printf '无效选项，请输入 0–9。\n'; continue;;
    esac
    # 独立子进程保持部署的错误退出及回滚语义，失败后主菜单仍可继续使用。
    entry=$0
    if [[ -f "$INSTALL_DIR/deploy.sh" ]]; then entry="$INSTALL_DIR/deploy.sh"; fi
    if [[ "$action" == install || "$action" == port ]]; then
      if ! read -r -p "监听端口 [$default_port]（回车保留，占用自动顺延）：" entered_port; then return; fi
      if ! bash "$entry" "$action" --port "${entered_port:-$default_port}"; then
        printf '操作失败，请查看上方错误，可选择「查看日志」排查。\n'
      fi
    elif ! bash "$entry" "$action"; then
      printf '操作未成功，请查看上方输出，可选择「查看日志」排查。\n'
    fi
  done
}

main() {
  local action=${1:-}
  if (($#)); then shift; fi
  # 安装和改端口均可指定 --port，拒绝未知参数和缺失值。
  while (($#)); do
    case "$1" in
      --port) [[ $# -ge 2 ]] || die '--port 缺少端口值。'; REQUESTED_PORT=$2; shift 2;;
      *) die "未知参数：$1";;
    esac
  done
  # 无参数进入持续管理菜单，直接命令保留供自动化调用。
  if [[ -z "$action" ]]; then
    # 由菜单收集操作和端口，用户无需记住命令。
    interactive_menu
    return
  fi
  case "$action" in
    help|--help|-h) show_help; return;;
    install|start|stop|restart|update|status|logs|port) ;;
    *) die "未知操作：$action";;
  esac
  if [[ "$action" == install || "$action" == port ]]; then
    # 重复安装和直接命令默认保留已配置的端口。
    local default_port=8443
    if [[ -f "$INSTALL_DIR/relay.env" ]]; then
      default_port=$(sed -n 's/^RELAY_PORT=\([0-9][0-9]*\)$/\1/p' "$INSTALL_DIR/relay.env")
      default_port=${default_port:-8443}
    fi
    REQUESTED_PORT=${REQUESTED_PORT:-$default_port}
    [[ "$REQUESTED_PORT" =~ ^[0-9]{1,5}$ ]] || die '端口必须是 1–65535 的整数。'
    REQUESTED_PORT=$((10#$REQUESTED_PORT))
    ((REQUESTED_PORT >= 1 && REQUESTED_PORT <= 65535)) || die '端口必须在 1–65535 范围内。'
  elif [[ -n "$REQUESTED_PORT" ]]; then
    die '--port 仅用于 install 或 port，更新及启停沿用现有端口。'
  fi
  [[ "$EUID" -eq 0 ]] || die '请使用 sudo 或 root 执行。'
  command -v systemctl >/dev/null || die '此脚本需要 Linux systemd。'
  case "$action" in
    install|update) deploy "$action";;
    port) change_port;;
    start|stop|restart) systemctl "$action" "$SERVICE";;
    status) systemctl status "$SERVICE" --no-pager;;
    logs) journalctl -u "$SERVICE" -n 100 --no-pager;;
  esac
}

main "$@"
