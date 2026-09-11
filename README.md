# DshDocker

[English](README.md) | [中文](README.zh.md)

Unofficial Docker image for **[DeepSeek Harness (`dsh`)](https://github.com/deepseek-ai/deepseek-harness)**,
**built from the official source code** — not from the npm package.

GitHub Actions clones upstream, runs the real monorepo build (`pnpm install && pnpm run build`)
and publishes a multi-arch image to GHCR (`linux/amd64` + `linux/arm64`).

```
ghcr.io/medyma/dshdocker:latest
```

---

## ⚠️ Read this first: DSH's web server is loopback-only

Upstream deliberately restricts the Web GUI:

| Location | Rule |
|---|---|
| `dsh-web-app/startup.js` | rejects `--host 0.0.0.0` outright ("would expose remote code execution to the network") |
| `dsh-host-webserver` config | `host: z.union([z.const("127.0.0.1"), z.const("0.0.0.0")])` — **only those two values are legal** |

Since `0.0.0.0` is rejected at startup and every other value fails the schema,
**`127.0.0.1` is the only bindable host**. A container port mapping (`-p`) DNATs to the
container's `eth0`, *not* to loopback — so this image runs a **tiny TCP forwarder**
(`dsh-forward.js`) inside the container:

```
0.0.0.0:3080  ──forward──▶  127.0.0.1:30801  (dsh web)
        ▲
        └── docker -p 3080:3080
```

The forwarder is a raw TCP relay: it **does not rewrite any header**, so DSH's
Host/Origin fence and its authority-bound cookie keep working on the original authority.

### Consequences

1. **`DSH_TRUSTED_HOSTS` is mandatory** for any non-localhost access. DSH auto-trusts LAN IP
   literals only when bound to `0.0.0.0` — which is impossible — so LAN IPs are **not**
   trusted implicitly. Declare whatever you browse with.
2. **You need a one-time `?token=` visit** to obtain the session cookie (see below).

---

## Quick start

```bash
docker run -d --name dsh \
  --restart unless-stopped \
  -p 3080:3080 \
  -v dsh-home:/home/node/.dsh \
  -v "$PWD/workspace:/workspace" \
  -e DSH_TRUSTED_HOSTS="192.168.1.10,dsh.example.com" \
  ghcr.io/medyma/dshdocker:latest
```

Then see **[Getting access](#getting-access)** below — a bare `http://host:3080` will return
`401 unauthorized` until you complete the token exchange.

### Docker Compose

Edit `DSH_TRUSTED_HOSTS` in `docker-compose.yml`, then:

```bash
docker compose up -d
```

---

## Getting access

DSH Web has **two gates**, both enforced on `/api`:

| Gate | Failure | Cause | Fix |
|---|---|---|---|
| Host/Origin trust fence | **403 forbidden** | the authority you browse with is not in `trustedHosts` | add it to `DSH_TRUSTED_HOSTS` |
| Browser-session auth | **401 unauthorized** | no session cookie | visit `/?token=…` once |

Flow:

```bash
# 1. take the launch token from the container log
docker logs dsh 2>&1 | grep 'dsh web:'
#    dsh web: http://127.0.0.1:30801/?token=XXXXXX

# 2. exchange it for a cookie — use YOUR authority, not 127.0.0.1
#    http://192.168.1.10:3080/?token=XXXXXX
#    or through a tunnel:
#    https://dsh.example.com/?token=XXXXXX
```

That returns `303 → /` plus a `Set-Cookie`, after which the UI loads normally.

Notes:

- The cookie is **bound to the authority** (host:port). Changing host or port requires the
  token exchange again.
- The launch token is **regenerated on every process start** — after `docker restart` you
  need a fresh token.
- `sec-fetch-site: cross-site` is rejected: open the URL directly, don't embed it in an iframe
  or navigate from another site.

### LAN access

Add the IP/host you browse with:

```bash
-e DSH_TRUSTED_HOSTS="192.168.2.1"          # port-less: matches any port (recommended)
-e DSH_TRUSTED_HOSTS="192.168.2.1:3080"     # or pin an exact authority
```

### Remote access / reverse proxy / tunnel (内网穿透)

1. **Include the public domain** in `DSH_TRUSTED_HOSTS`
   (port-less is easiest, e.g. `dsh.example.com`).
2. **Preserve the original `Host` header** in your proxy:
   - `frp` — preserved by default ✅
   - nginx — `proxy_set_header Host $host;`
3. **Enable WebSocket upgrade** — the RPC bridge uses WS; without it the page loads but hangs.
4. Then complete the `?token=` exchange **on the public URL**.

> If your proxy rewrites `Host` to `127.0.0.1:30801`, the fence passes as loopback, but the
> browser's `Origin` will no longer match — declare the real authority instead.

---

## Configuration

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `DSH_PORT` | `3080` | Exposed / forwarder listen port inside the container |
| `DSH_WEB_INTERNAL_PORT` | `30801` | Internal loopback port the `dsh web` server binds |
| `DSH_TRUSTED_HOSTS` | *(empty)* | Comma-separated authorities accepted by the `/api` fence. **Required for any non-localhost access.** Port-less entries match any port. |
| `DSH_BIN` | `/src/apps/cli/lib/bin.js` | CLI entry produced by the source build |
| `DSH_HOME` | `/home/node/.dsh` | DSH data root (credentials, settings, sessions, profiles) |
| `DSH_TELEMETRY_DISABLED` | `1` | Disable telemetry |

> There is deliberately **no `DSH_HOST`**: DSH cannot bind anything but loopback.

### Volumes

| Path | Purpose |
|---|---|
| `/home/node/.dsh` | **Persist this.** Credentials, settings, sessions, profiles. |
| `/workspace` | Working directory DSH reads/writes and runs commands in |

> The container runs as the base image's **`node` user (UID/GID 1000)**. For bind mounts:
> `sudo chown -R 1000:1000 ./data ./workspace`

### Running other modes

Any arguments are forwarded straight to the CLI (the web server and forwarder are skipped):

```bash
docker run --rm -v dsh-home:/home/node/.dsh \
  ghcr.io/medyma/dshdocker:latest --profile headless "summarize /workspace/notes.txt"
```

---

## Image tags

| Tag | Meaning |
|---|---|
| `latest` | Newest upstream `master` built by this repo |
| `0.1.5-rc.2` | Upstream `package.json` version at build time |
| `sha-<short>` | Upstream commit that was built (**most precise** — use this to pin) |

---

## Build args (local builds)

| Arg | Default | Description |
|---|---|---|
| `DSH_REPO` | `https://github.com/deepseek-ai/deepseek-harness.git` | Upstream repo (point at a mirror if needed) |
| `DSH_REF` | `master` | Branch, tag, or commit SHA |
| `DSH_BUILD_SCRIPT` | `build` | pnpm script; `build:official` matches upstream's release profile |
| `NODE_VERSION` | `24` | Node base image (upstream CI uses 24) |
| `PNPM_VERSION` | `11.7.0` | pnpm version via corepack |

```bash
docker build -t dshdocker .
docker build --build-arg DSH_REF=<commit-sha> -t dshdocker .
docker buildx build --platform linux/arm64 -t dshdocker .
```

The build is heavy: `build:native-system` (needs `musl-gcc`) → `build:lib` (tsc, 4 GB heap) →
`build:web`.

---

## CI

`.github/workflows/docker.yml`: **resolve** (shallow-clone upstream, read version, compute tags,
skip when the `sha-<short>` image already exists) → **build** (native matrix: `ubuntu-24.04` for
amd64, `ubuntu-24.04-arm` for arm64, pushed by digest) → **merge** (one multi-arch manifest).

All actions are pinned to majors whose `action.yml` declares `runs.using: node24` — no
Node 20 deprecation warnings.

---

## License

[MIT](LICENSE). DeepSeek Harness itself is licensed by its own authors.
