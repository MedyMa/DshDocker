#!/usr/bin/env bash
# DshDocker 入口脚本
# 默认启动 dsh web（运行官方源码构建出的 CLI）；传入参数则原样交给 dsh。
#
# 环境变量：
#   DSH_BIN             构建出的 CLI 入口（默认 /src/apps/cli/lib/bin.js；想用全局安装的 dsh 可设为 dsh）
#   DSH_HOST            监听地址（默认 0.0.0.0）
#   DSH_PORT            监听端口（默认 3080）
#   DSH_TRUSTED_HOSTS   逗号分隔的额外可信 authority（非 localhost 访问必填），
#                       例如：192.168.1.10:3080,dsh.local:3080
set -euo pipefail

DSH_BIN="${DSH_BIN:-/src/apps/cli/lib/bin.js}"

# 传了参数就完全交给用户（例如：docker run ... <image> --profile headless "任务"）
if [[ $# -gt 0 ]]; then
  exec node "${DSH_BIN}" "$@"
fi

HOST="${DSH_HOST:-0.0.0.0}"
PORT="${DSH_PORT:-3080}"

args=(web --host "${HOST}" --port "${PORT}" --no-open)

if [[ -n "${DSH_TRUSTED_HOSTS:-}" ]]; then
  # 去掉空格后按逗号切分
  IFS=',' read -r -a hosts <<< "${DSH_TRUSTED_HOSTS// /}"
  for h in "${hosts[@]}"; do
    [[ -n "${h}" ]] && args+=(--trusted-host "${h}")
  done
fi

echo "[dshdocker] exec: node ${DSH_BIN} ${args[*]}"
exec node "${DSH_BIN}" "${args[@]}"
