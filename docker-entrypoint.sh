#!/usr/bin/env bash
# DshDocker 入口脚本
#
# 为什么需要转发器：DSH 的 web 只能绑定 127.0.0.1
#   - dsh-web-app/startup.js 拒绝 --host 0.0.0.0
#   - dsh-host-webserver 的 schema 只接受 "127.0.0.1" | "0.0.0.0"
# 而 docker -p 的 DNAT 是转发到容器 eth0（不是 loopback），
# 所以在 0.0.0.0:<暴露端口> 上跑一个 TCP 转发器指向 127.0.0.1:<内部端口>。
#
# 环境变量：
#   DSH_BIN                    构建出的 CLI 入口（默认 /src/apps/cli/lib/bin.js）
#   DSH_PORT                   对外暴露端口 / 转发器监听端口（默认 3080）
#   DSH_WEB_INTERNAL_PORT      dsh 内部 loopback 端口（默认 30801）
#   DSH_TRUSTED_HOSTS          逗号分隔的可信 authority（**非 localhost 访问必填**）
#                              例：192.168.2.1,dsh.example.com
set -euo pipefail

DSH_BIN="${DSH_BIN:-/src/apps/cli/lib/bin.js}"

# 传了参数就完全交给用户（例如：--profile headless "任务"），不启动 web 与转发器
if [[ $# -gt 0 ]]; then
  exec node "${DSH_BIN}" "$@"
fi

PUBLIC_PORT="${DSH_PORT:-3080}"
INTERNAL_PORT="${DSH_WEB_INTERNAL_PORT:-30801}"
BIND_HOST="127.0.0.1"

args=(web --host "${BIND_HOST}" --port "${INTERNAL_PORT}" --no-open)

if [[ -n "${DSH_TRUSTED_HOSTS:-}" ]]; then
  IFS=',' read -r -a hosts <<< "${DSH_TRUSTED_HOSTS// /}"
  for h in "${hosts[@]}"; do
    [[ -n "${h}" ]] && args+=(--trusted-host "${h}")
  done
fi

echo "[dshdocker] dsh      : node ${DSH_BIN} ${args[*]}"
echo "[dshdocker] forward  : 0.0.0.0:${PUBLIC_PORT} -> ${BIND_HOST}:${INTERNAL_PORT}"
if [[ -z "${DSH_TRUSTED_HOSTS:-}" ]]; then
  echo "[dshdocker] 警告: 未设置 DSH_TRUSTED_HOSTS —— 只有 localhost 能通过 /api 信任围栏。"
  echo "[dshdocker]       用局域网 IP / 域名访问时请设置，例如 -e DSH_TRUSTED_HOSTS=192.168.2.1"
fi

# 启动 dsh（loopback）与转发器（0.0.0.0），任一退出则整体退出，交给 --restart 处理
node "${DSH_BIN}" "${args[@]}" &
DSH_PID=$!

DSH_FORWARD_LISTEN_PORT="${PUBLIC_PORT}" \
DSH_FORWARD_TARGET_PORT="${INTERNAL_PORT}" \
DSH_FORWARD_TARGET_HOST="${BIND_HOST}" \
  node /usr/local/bin/dsh-forward.js &
FWD_PID=$!

cleanup() {
  kill "${DSH_PID}" "${FWD_PID}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# 提示如何拿到访问 token（DSH 会打印 "dsh web: http://127.0.0.1:<内部端口>/?token=..."
# 那一行的 token 才是关键，端口要换成你实际访问的端口）
echo "[dshdocker] 提示: 从下面的 'dsh web:' 行取出 token，然后访问"
echo "[dshdocker]       http://<你的地址>:${PUBLIC_PORT}/?token=<token>  换取会话 cookie（一次即可）"

set +e
wait -n "${DSH_PID}" "${FWD_PID}"
STATUS=$?
set -e

echo "[dshdocker] 有进程退出（status=${STATUS}），容器将停止"
exit "${STATUS}"
