# syntax=docker/dockerfile:1
#
# DshDocker — 从 DeepSeek Harness 官方源码构建的 Docker 镜像
# https://github.com/MedyMa/DshDocker
#
# 上游仓库：https://github.com/deepseek-ai/deepseek-harness
#
# 构建（默认取 master 最新源码）：
#   docker build -t dshdocker .
#
# 指定 ref（分支 / 标签 / commit）：
#   docker build --build-arg DSH_REF=v0.1.5-rc.2 -t dshdocker .
#   docker build --build-arg DSH_REF=<commit-sha> -t dshdocker .
#
# 交叉构建 arm64：
#   docker buildx build --platform linux/arm64 -t dshdocker .
#
# 说明：上游是 pnpm monorepo，官方 CI 用 Node 24 + pnpm 11.7.0。
#      `pnpm run build` 会依次执行 build:native-system（原生 Landlock 插件，
#      Linux 需要 musl-gcc）→ build:lib（tsc，堆 4GB）→ build:web（前端产物）。

ARG NODE_VERSION=24

# ===========================================================================
# 阶段 1：构建
# ===========================================================================
FROM node:${NODE_VERSION}-bookworm AS builder

# 上游源码位置与版本
ARG DSH_REPO=https://github.com/deepseek-ai/deepseek-harness.git
ARG DSH_REF=master
# 可换成 build:official（官方发版用的 profile）
ARG DSH_BUILD_SCRIPT=build
ARG PNPM_VERSION=11.7.0

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=1

RUN corepack enable && corepack prepare "pnpm@${PNPM_VERSION}" --activate

# 工具链：
#   git/ca-certificates       -> 拉源码
#   python3/make/g++/pkg-config -> 原生模块编译
#   musl-tools                -> 提供 musl-gcc（build:native-system 需要）
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git ca-certificates python3 make g++ pkg-config musl-tools \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /src

# 支持分支 / 标签 / commit：fetch 指定 ref 后 checkout FETCH_HEAD
RUN git init -q . \
 && git remote add origin "${DSH_REPO}" \
 && git fetch -q --depth 1 origin "${DSH_REF}" \
 && git checkout -q FETCH_HEAD \
 && printf 'dsh source @ %s\n' "$(git rev-parse HEAD)" \
 && node -p "'upstream version: ' + require('./package.json').version"

RUN pnpm install --frozen-lockfile

RUN pnpm run "${DSH_BUILD_SCRIPT}"

# 产物自检：CLI 入口必须存在
RUN test -f /src/apps/cli/lib/bin.js \
 && printf 'built CLI bin OK: %s bytes\n' "$(stat -c %s /src/apps/cli/lib/bin.js)"

# 去掉 git 元数据，减小体积
RUN rm -rf /src/.git

# ===========================================================================
# 阶段 2：运行
# ===========================================================================
FROM node:${NODE_VERSION}-bookworm-slim AS runtime

LABEL org.opencontainers.image.title="DshDocker" \
      org.opencontainers.image.description="DeepSeek Harness (dsh) built from official source, in Docker" \
      org.opencontainers.image.authors="medyma" \
      org.opencontainers.image.source="https://github.com/MedyMa/DshDocker" \
      org.opencontainers.image.url="https://github.com/deepseek-ai/deepseek-harness" \
      org.opencontainers.image.licenses="MIT"

ENV DEBIAN_FRONTEND=noninteractive

# 运行所需：bash / git / ripgrep(检索) / procps(进程) / tini(1 号进程)
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash ca-certificates git ripgrep procps tini \
 && rm -rf /var/lib/apt/lists/*

# 构建产物整棵树（含 workspace 软链与原生模块）
COPY --from=builder /src /src

# 非 root 运行：直接用基础镜像自带的 node 用户（UID/GID 1000）。
# 注意：不要 useradd -u 1000 自建用户 —— node 镜像里 UID 1000 已被 node 占用，
# 会以 "UID 1000 is not unique" 失败（exit code 4）。
ENV DSH_HOME=/home/node/.dsh \
    DSH_HOST=0.0.0.0 \
    DSH_PORT=3080 \
    DSH_TELEMETRY_DISABLED=1 \
    DSH_BIN=/src/apps/cli/lib/bin.js

RUN mkdir -p /workspace "${DSH_HOME}" \
 && chown -R node:node /workspace "${DSH_HOME}"

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

VOLUME ["/home/node/.dsh", "/workspace"]
WORKDIR /workspace
USER node
EXPOSE 3080

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD []
