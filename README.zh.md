# DshDocker

[English](README.md) | 中文

**[DeepSeek Harness (`dsh`)](https://github.com/deepseek-ai/deepseek-harness)** 的非官方 Docker 镜像，
**基于官方源码构建**（不是 npm 包）。

GitHub Actions 会克隆上游源码、执行真正的 monorepo 构建（`pnpm install && pnpm run build`），
然后推送多架构镜像到 GHCR（`linux/amd64` + `linux/arm64`）。

```
ghcr.io/medyma/dshdocker:latest
```

---

## ⚠️ 先看这条：DSH 的 Web 只能绑 loopback

上游对 Web GUI 做了硬性限制：

| 位置 | 规则 |
|---|---|
| `dsh-web-app/startup.js` | 直接拒绝 `--host 0.0.0.0`（理由是"会把远程代码执行暴露到网络"）|
| `dsh-host-webserver` 配置 schema | `host: z.union([z.const("127.0.0.1"), z.const("0.0.0.0")])` —— **只允许这两个值** |

`0.0.0.0` 在启动时就被拒，其它值又过不了 schema，所以**唯一能绑的就是 `127.0.0.1`**。
而 `docker -p` 的 DNAT 是转发到容器 `eth0`（不是 loopback），因此本镜像在容器内跑了一个
**极简 TCP 转发器** `dsh-forward.js`：

```
0.0.0.0:3080  ──转发──▶  127.0.0.1:30801  (dsh web)
        ▲
        └── docker -p 3080:3080
```

转发器是**纯 TCP 中继，不改写任何 HTTP 头**，所以 DSH 的 Host/Origin 信任围栏和
「绑定 authority 的 cookie」都按你原始的访问地址正常工作。

### 由此带来的两点后果

1. **`DSH_TRUSTED_HOSTS` 变成必填**（只要不是用 localhost 访问）。DSH 只在绑定 `0.0.0.0` 时
   才自动信任局域网 IP 字面量——而 `0.0.0.0` 用不了——所以**局域网 IP 不会自动信任**，必须显式声明。
2. **需要做一次 `?token=` 访问**来换取会话 cookie（见下）。

---

## 快速开始

```bash
docker run -d --name dsh \
  --restart unless-stopped \
  -p 3080:3080 \
  -v dsh-home:/home/node/.dsh \
  -v "$PWD/workspace:/workspace" \
  -e DSH_TRUSTED_HOSTS="192.168.2.1,dsh.example.com" \
  ghcr.io/medyma/dshdocker:latest
```

然后看下面的 **[如何访问](#如何访问)** —— 直接开 `http://主机:3080` 会返回 `401 unauthorized`，
必须先完成 token 换取。

### docker compose

改好 `docker-compose.yml` 里的 `DSH_TRUSTED_HOSTS` 后：

```bash
docker compose up -d
```

---

## 如何访问

DSH Web 有**两道门**，都作用在 `/api` 上：

| 门 | 报错 | 原因 | 解法 |
|---|---|---|---|
| Host/Origin 信任围栏 | **403 forbidden** | 你访问用的 authority 不在 `trustedHosts` 里 | 加进 `DSH_TRUSTED_HOSTS` |
| 浏览器会话认证 | **401 unauthorized** | 没有会话 cookie | 访问一次 `/?token=…` |

流程：

```bash
# 1. 从容器日志里取启动 token
docker logs dsh 2>&1 | grep 'dsh web:'
#    dsh web: http://127.0.0.1:30801/?token=XXXXXX

# 2. 用【你自己的访问地址】去换 cookie（不要用 127.0.0.1）
#    局域网：   http://192.168.2.1:3080/?token=XXXXXX
#    内网穿透： https://dsh.example.com/?token=XXXXXX
```

会返回 `303 → /` 并下发 `Set-Cookie`，之后正常访问即可。

注意：

- cookie **绑定 authority**（host:port）：换域名或换端口要重新用 token 换一次。
- token **每次进程启动都重新生成**：`docker restart` 之后要用新 token。
- `sec-fetch-site: cross-site` 会被拒：直接在地址栏打开，别放进 iframe 或从别的站点跳转。

### 局域网访问

把你实际访问用的地址加进去：

```bash
-e DSH_TRUSTED_HOSTS="192.168.2.1"          # 不带端口 = 匹配任意端口（推荐）
-e DSH_TRUSTED_HOSTS="192.168.2.1:3080"     # 或精确锁定
```

### 内网穿透 / 反向代理

1. **把公网域名加进 `DSH_TRUSTED_HOSTS`**（不带端口最省事，例如 `dsh.example.com`）。
2. **代理必须保留原始 `Host` 头**：
   - `frp` —— 默认保留 ✅
   - nginx —— `proxy_set_header Host $host;`
3. **必须支持 WebSocket 升级** —— RPC 走 WS，不支持的话页面能开但一直转圈。
4. 最后**在公网地址上**完成 `?token=` 换取。

> 如果代理把 `Host` 改写成了 `127.0.0.1:30801`，围栏会当作 loopback 放行，但浏览器发出的
> `Origin` 就对不上了 —— 正确做法是声明真实 authority。

---

## 配置

### 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DSH_PORT` | `3080` | 容器内对外暴露 / 转发器监听端口 |
| `DSH_WEB_INTERNAL_PORT` | `30801` | `dsh web` 内部绑定的 loopback 端口 |
| `DSH_TRUSTED_HOSTS` | 空 | 逗号分隔的可信 authority，供 `/api` 围栏校验。**非 localhost 访问必填。** 不带端口 = 匹配任意端口 |
| `DSH_BIN` | `/src/apps/cli/lib/bin.js` | 源码构建出的 CLI 入口 |
| `DSH_HOME` | `/home/node/.dsh` | DSH 数据根目录（凭证 / 设置 / 会话 / profile）|
| `DSH_TELEMETRY_DISABLED` | `1` | 关闭遥测 |

> 特意**没有 `DSH_HOST`**：DSH 除了 loopback 绑不了别的。

### 数据卷

| 路径 | 用途 |
|---|---|
| `/home/node/.dsh` | **必须持久化。** 凭证、设置、会话、profile |
| `/workspace` | DSH 读写文件、执行命令的工作目录 |

> 容器以基础镜像自带的 **`node` 用户（UID/GID 1000）** 运行。bind mount 时要
> `sudo chown -R 1000:1000 ./data ./workspace`

### 跑 web 之外的模式

传入参数会**原样交给 CLI**（不再启动 web 和转发器）：

```bash
docker run --rm -v dsh-home:/home/node/.dsh \
  ghcr.io/medyma/dshdocker:latest --profile headless "总结 /workspace/notes.txt"
```

---

## 镜像 tag

| tag | 含义 |
|---|---|
| `latest` | 本仓库构建的上游 `master` 最新代码 |
| `0.1.5-rc.2` | 构建时上游 `package.json` 的版本号 |
| `sha-<short>` | 所构建的上游 commit（**最精确**，锁版本用它）|

---

## 构建参数（本地构建）

| 参数 | 默认值 | 说明 |
|---|---|---|
| `DSH_REPO` | `https://github.com/deepseek-ai/deepseek-harness.git` | 上游仓库（可指向镜像站）|
| `DSH_REF` | `master` | 分支 / 标签 / commit |
| `DSH_BUILD_SCRIPT` | `build` | pnpm 脚本；`build:official` 对应官方发版 profile |
| `NODE_VERSION` | `24` | Node 基础镜像（官方 CI 用 24）|
| `PNPM_VERSION` | `11.7.0` | corepack 启用的 pnpm 版本 |

```bash
docker build -t dshdocker .
docker build --build-arg DSH_REF=<commit-sha> -t dshdocker .
docker buildx build --platform linux/arm64 -t dshdocker .
```

构建很重：`build:native-system`（需 `musl-gcc`）→ `build:lib`（tsc，4GB 堆）→ `build:web`。

---

## CI 说明

`.github/workflows/docker.yml`：**resolve**（浅克隆上游、读版本、算 tag、`sha-<short>` 已存在则跳过）
→ **build**（原生矩阵：`ubuntu-24.04` 构建 amd64、`ubuntu-24.04-arm` 构建 arm64，按 digest 推送）
→ **merge**（合成一个多架构 manifest）。

所有 action 都锁定在 `action.yml` 声明 `runs.using: node24` 的大版本 —— 不再有 Node 20 弃用警告。

---

## 许可

[MIT](LICENSE)。DeepSeek Harness 本身遵循其作者自己的许可。
