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

### ⚠️ 设置页只在 loopback 可用 —— 模型配置请走下面两条路

DSH 对「设置文档」有 loopback 限制（`dsh-client-ui-settings/lib/client.js:1345`）：

```js
const persistence = ctx.remote.$host.isLoopback ? "host" : "memory";
```

`isLoopback` 判断的是**浏览器地址栏里的主机名**，只认 `localhost` / `127.x.x.x` / `[::1]`
（`dsh-client-connection/lib/client.js:6344`）。所以在 `memory` 模式下设置文档不会加载，
「模型」页会报 `加载提供方目录失败: settings are unavailable in this browser`。

| 访问地址 | 聊天 | 设置页（模型） |
|---|---|---|
| `http://127.0.0.1:3080` | ✅ | ✅ |
| `http://192.168.x.x:3080` | ✅ | ❌ |
| `https://<穿透域名>` | ✅ | ❌ |

这是上游**有意的安全设计**（设置里含 API Key）。有三条路：

**A. SSH 本地转发，让浏览器变成 loopback（推荐）**

```bash
# 在你自己的电脑上执行，窗口保持打开
ssh -N -L 3080:127.0.0.1:3080 root@<路由器IP>

# 取 token
docker logs dsh 2>&1 | sed -n 's/.*[?&]token=\([A-Za-z0-9_-]*\).*/\1/p' | tail -n1

# 浏览器打开（必须是 127.0.0.1）
#   http://127.0.0.1:3080/?token=<TOKEN>
```

配置写进容器 `DSH_HOME`（服务端持久化），之后日常继续用穿透域名即可。

**B. 直接写 `settings.yaml`（不用浏览器）**

模板见 [`examples/settings.deepseek.yaml`](examples/settings.deepseek.yaml)（DeepSeek 官方公网 API）。

如果要接自己的 OpenAI / Anthropic 兼容服务，按 `llm-pi-ai` 加一段即可：

```yaml
llm-pi-ai:
  providers:
    myprovider:
      displayName: My Provider
      apiKeyEnv: MY_PROVIDER_API_KEY     # Key 用这个环境变量名传入
      api: anthropic-messages            # 或 openai-chat-completions
      baseURL: https://api.example.com/v1
      models:
        - id: my-model
          name: my-model
          contextWindow: 128000
          maxTokens: 8192
agent-default-model:
  provider: myprovider
  model: my-model
```

写进数据卷并重启：

```bash
MP=$(docker volume inspect dsh-home --format '{{.Mountpoint}}')
cp examples/settings.deepseek.yaml "$MP/settings.yaml"     # 或写你自己的那份
chown 1000:1000 "$MP/settings.yaml"
docker restart dsh
```

API Key 用环境变量传入（名字取自 provider 的 `apiKeyEnv`）：

```bash
-e DEEPSEEK_API_KEY=sk-xxxxxxxx
-e MY_PROVIDER_API_KEY=xxxxxxxx
```

**C. 解除限制：让任意来源都能用设置页（`DSH_ALLOW_REMOTE_SETTINGS=1`）**

本镜像内置了这个开关：启动时把客户端里那两处 loopback 判断改成恒真，
于是**穿透域名/局域网 IP 也能正常打开「模型」「插件」设置页**。

```bash
docker rm -f dsh
docker run -d --name dsh --restart unless-stopped --network host \
  -v dsh-home:/home/node/.dsh -v "$PWD/workspace:/workspace" \
  -e DSH_TRUSTED_HOSTS="192.168.2.1,dsh.example.com" \
  -e DSH_ALLOW_REMOTE_SETTINGS=1 \
  -e DEEPSEEK_API_KEY=sk-xxxxxxxx \
  ghcr.io/medyma/dshdocker:latest
```

> ⚠️ **安全性代价**：这等于去掉 upstream 的一层保护 —— 设置页里有 API Key，
> 开启后**任何能访问该地址的人都能查看/修改它**。穿透地址是公网域名时风险实在，请自行评估。
>
> 补丁只在容器**运行时**作用于客户端插件（`ui-settings` / `ui-settings-general` 的
> `lib/client.js`），不改变镜像内容；关闭该开关即恢复 upstream 行为。
> 生效后浏览器需**强制刷新**（Ctrl+Shift+R）以丢弃旧的插件缓存。

---

## 配置

### 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DSH_PORT` | `3080` | 容器内对外暴露 / 转发器监听端口 |
| `DSH_WEB_INTERNAL_PORT` | `30801` | `dsh web` 内部绑定的 loopback 端口 |
| `DSH_TRUSTED_HOSTS` | 空 | 逗号分隔的可信 authority，供 `/api` 围栏校验。**非 localhost 访问必填。** 不带端口 = 匹配任意端口 |
| `DSH_ALLOW_REMOTE_SETTINGS` | `0` | `=1` 解除「设置页仅 loopback 可用」的限制（见上文 C）。⚠️ 会暴露 API Key 的读写权限 |
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

| workflow | 作用 |
|---|---|
| `docker.yml` | **resolve**（浅克隆上游、读版本、算 tag）→ **build**（`ubuntu-24.04` 构建 amd64、`ubuntu-24.04-arm` 构建 arm64，按 digest 推送）→ **merge**（合成多架构 manifest） |
| `desktop-win.yml` | 从上游源码构建 Windows x64 桌面端（未签名） |
| `ghcr-prune.yml` | 每周清理 GHCR 里无 tag 的包版本 |

`docker.yml` 的「`sha-<short>` 已存在就跳过」**只在定时任务时生效**，`push` 触发一律重建
（改了 `Dockerfile` 就该重建），所以**改一行文档也会重建整个多架构镜像**；想避免可给 push 加 `paths` 过滤。

**GHCR 里为什么有一堆无 tag 版本**：每次构建会推送多个 manifest —— 2 个平台镜像、2 个 provenance
attestation（buildx 默认产出，内含时间戳/run id，每次内容都不同）、各架构的单架构 index，最后 merge
出带 tag 的多架构 index。GHCR 把**每个 manifest** 都算作一个版本，所以那 30 多个里只有 1 个带 tag
（`latest`/`sha-<short>`/`<版本>` 三个 tag 指向同一个 index）—— **镜像内容其实只有一份**，`docker pull`
永远拿到最新的。`ghcr-prune.yml` 每周日清理这些无 tag 版本（只删 untagged，保留最近 10 个 + 全部带 tag）。

所有 action 都锁定在 `action.yml` 声明 `runs.using: node24` 的大版本 —— 不再有 Node 20 弃用警告
（`ghcr-prune.yml` 不含 action，纯用 `gh` CLI，同样与 Node 无关）。

---

## 上游发新版后如何重建镜像

### 一、常规情况：什么都不用做（全自动）

CI 里有每天定时任务（`cron: "0 2 * * *"`，UTC = **北京时间 10:00**），每天会：

1. 浅克隆上游 `master`
2. 读它的 commit SHA 与 `package.json` 版本号
3. **该 SHA 的镜像已存在就跳过**（不空跑）
4. 有新提交 → 构建 amd64 + arm64 → 推送

**所以上游发版后，最迟次日早上 10 点就有新镜像。** 你只需要：

```bash
docker pull ghcr.io/medyma/dshdocker:latest

docker rm -f dsh && docker run -d --name dsh --restart unless-stopped \
  --network host \
  -v dsh-home:/home/node/.dsh \
  -v "$PWD/workspace:/workspace" \
  -e DSH_TRUSTED_HOSTS="192.168.2.1,dsh.example.com" \
  -e DSH_ALLOW_REMOTE_SETTINGS=1 \
  -e DEEPSEEK_API_KEY=sk-xxxxxxxx \
  ghcr.io/medyma/dshdocker:latest
```

> 数据卷 `dsh-home` 会保留 —— **模型配置、会话、凭证都不丢**。

### 二、不想等定时：手动立刻构建

**GitHub → Actions → Build & Push DSH Image (from source) → Run workflow**

| 输入 | 说明 |
|---|---|
| `ref` | 上游 ref。**留空 = master 最新**；也可填 `v0.1.5-rc.3` 这类标签或具体 commit |
| `force` | 勾上忽略「镜像已存在」检查（手动触发本来就会构建，一般不用勾）|

> 手动触发（`workflow_dispatch`）不受跳过逻辑影响，**一定会构建**。

### 三、锁定某个版本

`ref` 填上游标签后，会产出这些 tag：

| Tag | 用途 |
|---|---|
| `0.1.5-rc.3` | 上游版本号 |
| `sha-<上游commit>` | **最精确，生产建议用这个** |
| `latest` | 也会同步更新 |

```bash
# 生产环境建议锁精确 tag，避免 latest 漂移
ghcr.io/medyma/dshdocker:sha-<上游commit>
```

查看已有 tag：GitHub → Packages → `dshdocker`。

### 四、完全不用 GitHub：本地构建

```bash
git clone https://github.com/MedyMa/DshDocker.git && cd DshDocker

docker build -t dshdocker .                                    # 最新 master
docker build --build-arg DSH_REF=v0.1.5-rc.3 -t dshdocker .    # 指定版本
docker buildx build --platform linux/arm64 -t dshdocker .      # 交叉构建 arm64
```

拷到路由器：

```bash
docker save dshdocker | gzip > dsh.tgz
scp dsh.tgz root@192.168.2.1:/tmp/
# 路由器上
gunzip -c /tmp/dsh.tgz | docker load
```

> ⚠️ 上游构建很重（tsc 4GB 堆 + 前端 + 原生插件），x86 上约 5–10 分钟，**别在路由器上构建**。

### 五、怎么知道有没有新版

```bash
# 上游 npm 上的最新版本号
curl -s https://registry.npmjs.org/@deepseek-ai/dsh/latest | head -c 200

# 你容器里跑的版本
docker exec dsh node -e "console.log(require('/src/package.json').version)"
```

再看 GitHub → Actions，有没有新的自动构建记录。

### 六、自动构建失败怎么办

Actions → 点开那条失败的 run → 看红叉 job 的日志。常见三类：

| 现象 | 原因 | 处理 |
|---|---|---|
| `pnpm install` 失败 | 上游改了 lockfile / 依赖 | 多为上游临时问题，稍后 **Re-run jobs** |
| `pnpm run build` 失败 | 上游改了构建脚本 | 把报错发到仓库 Issue，需更新 Dockerfile |
| 找不到 ref | 上游改了分支名 | 用 `ref` 指定正确分支 |

重跑：Actions → 那条 run → 右上角 **Re-run jobs**。

### 七、一句话总结

| 场景 | 你要做什么 |
|---|---|
| **上游发新版（常规）** | **什么都不用做** —— 次日自动构建，你只管 `docker pull` + 重启容器 |
| 想立刻要 | Actions 手动 Run workflow（`ref` 留空）|
| 要固定版本 | `ref` 填标签，容器里用 `sha-xxx` tag |
| 不用 GitHub | 本地 `docker build` + `docker save/load` |

---

## 桌面端 App（Windows x64，未签名）

本仓库同时从上游源码构建 Electron 桌面端的 **Windows x64 安装包**。
下载：GitHub → Releases → `desktop-v<版本>`（或该次构建的 Actions Artifacts，保留 30 天）。

| 目标 | 托管 runner | 原因 |
|---|---|---|
| **Windows x64（未签名）** | ✅ | 上游只给 `win-x64` 开了 `--unsigned` |
| Windows 正式签名 | ❌ | 需 GlobalSign EV 证书 + SafeNet USB Token（物理设备），只能自托管 |
| macOS | ❌ | 上游**强制**要求 Apple 签名身份 + Team ID + 公证，无开发者账号打不出来 |

**一定是 64 位**：安装包名为 `...-win-x64.exe`（32 位会叫 `ia32`），上游 `SUPPORTED_TARGETS`
里没有 32 位目标。流程另有二进制级闸门 `verify-win-artifacts.mjs`：主程序与随包 `node.exe`
的 PE 头必须是 `AMD64 (0x8664)`，否则构建失败（闸门自带 8 用例回归测试）。

> 安装包**外壳**是 32 位 PE —— NSIS 只有 32 位实现，与安装后的应用位数无关。
> 应用内的 `fastlist-0.3.0-x86.exe`、`win10-arm64/OpenConsole.exe` 是 pnpm / node-pty
> 自带的多架构 payload，闸门只告警。

安装：未签名包会被 SmartScreen 拦（「更多信息 → 仍要运行」），且不含自动更新配置。
手动触发：Actions → **Build DSH Desktop (Windows, unsigned)** → Run workflow（`force` 忽略已存在检查）。
定时：每天 UTC 02:30（北京 10:30）。

---

## 许可

[MIT](LICENSE)。DeepSeek Harness 本身遵循其作者自己的许可。
