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
#   DSH_ALLOW_REMOTE_SETTINGS  =1 时解除「设置页仅 loopback 可用」的限制（默认 0）
#                              ⚠️ 会让任意能访问该地址的人读写设置（含 API Key）
set -euo pipefail

DSH_BIN="${DSH_BIN:-/src/apps/cli/lib/bin.js}"

# ---------------------------------------------------------------------------
# 可选：解除「设置页仅 loopback 可用」的限制（DSH_ALLOW_REMOTE_SETTINGS=1）
#
# 上游在客户端硬编码了持久化模式（源码 packages/client/ui-settings/src/client/index.ts:58）：
#   const persistence = ctx.remote.$host.isLoopback ? 'host' : 'memory'
# 非 loopback 页面落到 memory 模式 → 设置文档不加载 →
#   模型页报 "settings are unavailable in this browser"、插件配置空白。
#
# 该判断只在浏览器端，且这两个客户端插件是运行时单独加载的 lib/client.js，
# 所以启动前把表达式改成恒真即可，无需改镜像。
#
# ⚠️ 安全性：设置页含 API Key，开启后任何能访问此地址的人都能读写它。
# ---------------------------------------------------------------------------
apply_remote_settings_patch() {
  local target patched=0
  for target in \
    /src/packages/client/ui-settings/lib/client.js \
    /src/packages/client/ui-settings-general/lib/client.js \
    /src/node_modules/@deepseek-ai/dsh-client-ui-settings/lib/client.js \
    /src/node_modules/@deepseek-ai/dsh-client-ui-settings-general/lib/client.js
  do
    [ -f "${target}" ] || continue
    grep -q 'isLoopback' "${target}" 2>/dev/null || continue
    if sed -i 's/ctx\.remote\.\$host\.isLoopback/true/g' "${target}" 2>/dev/null; then
      echo "[dshdocker] 已解除 loopback 门控: ${target}"
      patched=$((patched + 1))
    else
      echo "[dshdocker] 警告: 无法改写 ${target}（权限不足？）"
    fi
  done
  [ "${patched}" -gt 0 ] || echo "[dshdocker] 警告: 未找到可打补丁的客户端插件文件"
}

if [[ "${DSH_ALLOW_REMOTE_SETTINGS:-0}" == "1" ]]; then
  apply_remote_settings_patch
  echo "[dshdocker] ⚠️  已放开远程设置读写：任何能访问本地址的人都能查看/修改 API Key"
else
  echo "[dshdocker] 设置页保持 upstream 默认（仅 127.0.0.1/localhost 可用）"
fi

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
