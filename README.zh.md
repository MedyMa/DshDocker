# DshDocker

[English](README.md) | 中文

**[DeepSeek Harness (`dsh`)](https://github.com/deepseek-ai/deepseek-harness)** 的非官方 Docker 镜像，
**基于官方最新源码构建**（不是 npm 包）。

GitHub Actions 会克隆上游源码、执行真正的 monorepo 构建（`pnpm install && pnpm run build`），
然后推送多架构镜像到 GHCR（`linux/amd64` + `linux/arm64`）。

```
ghcr.io/medyma/dshdocker:latest
```

---

## 快速开始

### docker run

```bash
docker run -d --name dsh \
  --restart unless-stopped \
  -p 3080:3080 \
  -v dsh-home:/home/dsh/.dsh \
  -v "$PWD/workspace:/workspace" \
  -e DSH_TRUSTED_HOSTS="192.168.1.10:3080" \
  ghcr.io/medyma/dshdocker:latest
```

然后浏览器打开 `http://<你的主机>:3080`。

### docker compose

```bash
docker compose up -d
```

记得把 `docker-compose.yml` 里的 `DSH_TRUSTED_HOSTS` 改成**你实际访问用的地址**
（`IP:端口` 或 `域名:端口`）。

---

## 镜像 tag

| tag | 含义 |
|---|---|
| `latest` | 本仓库构建的上游 `master` 最新代码 |
| `0.1.5-rc.2` | 构建时上游 `package.json` 的版本号 |
| `sha-<short>` | 所构建的上游 commit（**最精确**）|
| `v1.0.0` | 推送到**本仓库**的 git tag |

因为是源码构建，想锁定某个确切的上游提交就用 `sha-<short>`。

---

## 构建参数（本地构建）

| 参数 | 默认值 | 说明 |
|---|---|---|
| `DSH_REPO` | `https://github.com/deepseek-ai/deepseek-harness.git` | 上游仓库（可指向镜像站）|
| `DSH_REF` | `master` | 要构建的分支 / 标签 / commit |
| `DSH_BUILD_SCRIPT` | `build` | 执行的 pnpm 脚本；`build:official` 对应官方发版 profile |
| `NODE_VERSION` | `24` | Node 基础镜像（官方 CI 用 24；`engines` 要求 `^22.19.0 \|\| >=24.0.0`）|
| `PNPM_VERSION` | `11.7.0` | corepack 启用的 pnpm 版本（对齐上游 `packageManager`）|

```bash
# 最新 master
docker build -t dshdocker .

# 指定发布标签
docker build --build-arg DSH_REF=v0.1.5-rc.2 -t dshdocker .

# 指定 commit（最可复现）
docker build --build-arg DSH_REF=<commit-sha> -t dshdocker .

# arm64
docker buildx build --platform linux/arm64 -t dshdocker .
```

> 构建很重：`pnpm run build` 会依次跑 `build:native-system`（原生 Landlock 插件，需要
> `musl-gcc`）→ `build:lib`（`tsc`，4GB 堆）→ `build:web`。请预留较长构建时间和数 GB 缓存空间。
>
> 国内网络可把 `DSH_REPO` 指向 GitHub 镜像，或传代理：
> `--build-arg HTTP_PROXY=... --build-arg HTTPS_PROXY=...`

---

## 配置

### 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DSH_BIN` | `/src/apps/cli/lib/bin.js` | 源码构建出的 CLI 入口 |
| `DSH_HOST` | `0.0.0.0` | Web UI 监听地址 |
| `DSH_PORT` | `3080` | 监听端口 |
| `DSH_TRUSTED_HOSTS` | 空 | 逗号分隔的额外可信 authority，供 `/api` 的浏览器信任围栏校验。**只要不是用 localhost 访问就必须填**，例如 `192.168.1.10:3080,dsh.local:3080` |
| `DSH_HOME` | `/home/dsh/.dsh` | DSH 数据根目录（凭证 / 设置 / 会话 / profile）|
| `DSH_TELEMETRY_DISABLED` | `1` | 关闭遥测 |

### 数据卷

| 路径 | 用途 |
|---|---|
| `/home/dsh/.dsh` | **必须持久化。** 凭证、设置、会话、profile、storages |
| `/workspace` | DSH 读写文件、执行命令的工作目录 |

> 容器以 **UID 1000** 运行。bind mount 时要 `sudo chown -R 1000:1000 ./data ./workspace`

### 跑 web 之外的模式

入口默认执行 `dsh web`，**传入的参数会原样转交给 CLI**：

```bash
# headless：跑一个任务，打印结果后退出
docker run --rm -v dsh-home:/home/dsh/.dsh \
  ghcr.io/medyma/dshdocker:latest --profile headless "总结 /workspace/notes.txt"

# 进容器
docker run --rm -it --entrypoint bash ghcr.io/medyma/dshdocker:latest
```

---

## CI 说明

`.github/workflows/docker.yml`：

1. **resolve** —— 浅克隆上游指定 ref，从 `package.json` 读版本号，算出
   `latest` / `<version>` / `sha-<short>` 等 tag；**定时任务里如果该 `sha-<short>`
   镜像已存在就跳过构建**。
2. **build** —— 用**原生 runner 矩阵**：`ubuntu-24.04` 构建 `linux/amd64`、
   `ubuntu-24.04-arm` 构建 `linux/arm64`，各自**按 digest 推送**（不用 QEMU，
   重型 TS/前端构建才不会慢到离谱）。
3. **merge** —— 收集 digest，合成一个多架构 manifest，并打上全部 tag。

每天定时跑，所以上游有新提交会自动出新镜像；没变化则跳过、不空跑。

> `ubuntu-24.04-arm` runner 对**公开仓库免费**。如果你的 fork 是私有的，要么改成公开，
> 要么把矩阵里那一项换成 QEMU 构建（`ubuntu-24.04` 上 `platforms: linux/arm64`），
> 代价是构建很慢。

---

## 注意事项

1. **GHCR 包默认私有。** 第一次构建成功后去
   *GitHub → 头像 → Packages → dshdocker → Package settings → Change visibility* 改成 **public**。
2. **镜像较大。** 这里会构建整个上游 monorepo 并打包进镜像（数 GB）。如果你只要个小运行时，
   npm 安装版的镜像会小得多——源码构建是用体积换「保真 / 可复现」。
3. **`DSH_TRUSTED_HOSTS` 很关键。** DSH 的 web 对 `/api` 有浏览器信任围栏，用局域网 IP 或域名
   访问而不填这一项会被拒。
4. **首次运行要配模型凭证**，配置存在 `DSH_HOME`，务必挂数据卷。
5. **沙箱 / Landlock。** DSH 在 Linux 上用基于 Landlock 的进程限制；Docker 默认 seccomp 可能挡掉
   相关系统调用，DSH 会优雅降级；确实需要沙箱可试 `--security-opt seccomp=unconfined`。
6. **需要走代理？** 设置 `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`。
7. **非官方。** 对官方开源项目的社区打包，与 DeepSeek 无隶属关系。

---

## 许可

[MIT](LICENSE)。DeepSeek Harness 本身遵循其作者自己的许可。
