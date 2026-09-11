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

### ⚠️ Settings only work on a loopback page — configure the model like this

DSH gates the settings document on loopback (`dsh-client-ui-settings/lib/client.js:1345`):

```js
const persistence = ctx.remote.$host.isLoopback ? "host" : "memory";
```

`isLoopback` is computed from **the browser's address-bar hostname** and only accepts
`localhost` / `127.x.x.x` / `[::1]` (`dsh-client-connection/lib/client.js:6344`). On a
`memory` page the document never loads, so the Models tab reports
`settings are unavailable in this browser`.

| Address | Chat | Settings (Models) |
|---|---|---|
| `http://127.0.0.1:3080` | ✅ | ✅ |
| `http://192.168.x.x:3080` | ✅ | ❌ |
| `https://<tunnel domain>` | ✅ | ❌ |

This is a deliberate upstream safeguard (settings hold API keys). Three ways:

**A. SSH local forward so the browser is loopback (recommended)**

```bash
# on your own machine, keep this window open
ssh -N -L 3080:127.0.0.1:3080 root@<router-ip>

# read the token
docker logs dsh 2>&1 | sed -n 's/.*[?&]token=\([A-Za-z0-9_-]*\).*/\1/p' | tail -n1

# open in the browser (127.0.0.1 is required)
#   http://127.0.0.1:3080/?token=<TOKEN>
```

The config lands in the container's `DSH_HOME`, so afterwards you can go back to the
tunnel domain for normal use.

**B. Write `settings.yaml` directly (no browser)**

Template: [`examples/settings.deepseek.yaml`](examples/settings.deepseek.yaml) (public DeepSeek API).

To point at your own OpenAI / Anthropic-compatible service, add an `llm-pi-ai` provider:

```yaml
llm-pi-ai:
  providers:
    myprovider:
      displayName: My Provider
      apiKeyEnv: MY_PROVIDER_API_KEY     # the env var that carries the key
      api: anthropic-messages            # or openai-chat-completions
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

Install it into the volume and restart:

```bash
MP=$(docker volume inspect dsh-home --format '{{.Mountpoint}}')
cp examples/settings.deepseek.yaml "$MP/settings.yaml"     # or your own file
chown 1000:1000 "$MP/settings.yaml"
docker restart dsh
```

Pass the key as an environment variable (named by the provider's `apiKeyEnv`):

```bash
-e DEEPSEEK_API_KEY=sk-xxxxxxxx
-e MY_PROVIDER_API_KEY=xxxxxxxx
```

**C. Lift the restriction: `DSH_ALLOW_REMOTE_SETTINGS=1`**

This image ships a switch that, at container start, rewrites the two client-side
loopback checks to be unconditionally true — so the Models and Plugins settings pages
work from a LAN IP or a tunnel domain too.

```bash
docker rm -f dsh
docker run -d --name dsh --restart unless-stopped --network host \
  -v dsh-home:/home/node/.dsh -v "$PWD/workspace:/workspace" \
  -e DSH_TRUSTED_HOSTS="192.168.2.1,dsh.example.com" \
  -e DSH_ALLOW_REMOTE_SETTINGS=1 \
  -e DEEPSEEK_API_KEY=sk-xxxxxxxx \
  ghcr.io/medyma/dshdocker:latest
```

> ⚠️ **Security trade-off**: this removes an upstream protection. The settings page holds
> your API keys, so once enabled **anyone who can reach that address can read and change
> them**. Real risk on a public tunnel domain — judge for yourself.
>
> The patch is applied at **runtime** to the client plugin files
> (`ui-settings` / `ui-settings-general` `lib/client.js`); the image itself is unchanged,
> and turning the switch off restores upstream behaviour. Hard-refresh the browser
> (Ctrl+Shift+R) afterwards to drop the cached plugin bundle.

---

## Configuration

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `DSH_PORT` | `3080` | Exposed / forwarder listen port inside the container |
| `DSH_WEB_INTERNAL_PORT` | `30801` | Internal loopback port the `dsh web` server binds |
| `DSH_TRUSTED_HOSTS` | *(empty)* | Comma-separated authorities accepted by the `/api` fence. **Required for any non-localhost access.** Port-less entries match any port. |
| `DSH_ALLOW_REMOTE_SETTINGS` | `0` | `=1` lifts the loopback-only settings gate (see C above). ⚠️ exposes API-key read/write to anyone who can reach the address |
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

## Rebuilding after upstream releases a new version

### 1. Normal case: nothing to do (fully automatic)

A daily schedule (`cron: "0 2 * * *"`, UTC = **10:00 Beijing**) does:

1. shallow-clone upstream `master`
2. read its commit SHA and `package.json` version
3. **skip if the image for that SHA already exists** (no wasted builds)
4. otherwise build amd64 + arm64 and push

So a new upstream release lands in your registry by ~10:00 the next day. All you run:

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

> The `dsh-home` volume persists, so **model config, sessions and credentials survive**.

### 2. Don't want to wait: trigger it manually

**GitHub → Actions → Build & Push DSH Image (from source) → Run workflow**

| Input | Meaning |
|---|---|
| `ref` | Upstream ref. **Empty = latest `master`**; or `v0.1.5-rc.3`, or a commit SHA |
| `force` | Ignore the "image already exists" check (manual runs always build anyway) |

> `workflow_dispatch` is never subject to the skip logic — it always builds.

### 3. Pin a specific version

Set `ref` to an upstream tag; the build produces:

| Tag | Use |
|---|---|
| `0.1.5-rc.3` | upstream version |
| `sha-<upstream-commit>` | **most precise — preferred for production** |
| `latest` | also updated |

```bash
# production: pin the exact tag so `latest` can't drift under you
ghcr.io/medyma/dshdocker:sha-<upstream-commit>
```

List existing tags: GitHub → Packages → `dshdocker`.

### 4. Without GitHub at all: build locally

```bash
git clone https://github.com/MedyMa/DshDocker.git && cd DshDocker

docker build -t dshdocker .                                    # latest master
docker build --build-arg DSH_REF=v0.1.5-rc.3 -t dshdocker .    # specific version
docker buildx build --platform linux/arm64 -t dshdocker .      # cross-build arm64
```

Ship it to the router:

```bash
docker save dshdocker | gzip > dsh.tgz
scp dsh.tgz root@192.168.2.1:/tmp/
# on the router
gunzip -c /tmp/dsh.tgz | docker load
```

> ⚠️ The upstream build is heavy (tsc with a 4 GB heap + frontend + native addons),
> roughly 5–10 minutes on x86. **Never build on the router.**

### 5. Checking for new versions

```bash
# latest version published on npm
curl -s https://registry.npmjs.org/@deepseek-ai/dsh/latest | head -c 200

# the version your container runs
docker exec dsh node -e "console.log(require('/src/package.json').version)"
```

Then look at GitHub → Actions for a recent automated build.

### 6. If an automated build fails

Actions → open the failed run → check the red job's log. Three usual causes:

| Symptom | Cause | Fix |
|---|---|---|
| `pnpm install` fails | upstream changed the lockfile/deps | usually transient upstream — **Re-run jobs** later |
| `pnpm run build` fails | upstream changed the build script | open an issue with the error; the Dockerfile needs updating |
| ref not found | upstream renamed a branch | pass the right branch via `ref` |

Re-run: Actions → that run → **Re-run jobs** (top right).

### 7. TL;DR

| Situation | What you do |
|---|---|
| **Upstream releases (normal)** | **nothing** — next-day auto build, then `docker pull` + recreate the container |
| Want it now | Actions → Run workflow (`ref` empty) |
| Need a fixed version | set `ref`, use the `sha-xxx` tag in your container |
| Avoid GitHub | local `docker build` + `docker save/load` |

---

## Desktop app (Windows x64, unsigned)

Besides the web build, this repo also builds the **Electron desktop app** for Windows x64
from upstream source, automatically.

**Download**: GitHub → Releases → look for `desktop-v<version>` (e.g. `desktop-v0.1.5-rc.2`),
or grab the Artifacts of that run (kept for 30 days).

### Why Windows only

| Target | Buildable on hosted runners | Reason |
|---|---|---|
| **Windows x64 (unsigned)** | ✅ | upstream only exposes an `--unsigned` path for `win-x64` |
| Windows, signed | ❌ | needs a GlobalSign EV certificate **and** a SafeNet USB token (physical), so self-hosted runners only |
| macOS (Intel / Apple Silicon) | ❌ | upstream **requires** an Apple signing identity + Team ID + notarization credentials; impossible without a developer account |

### It is always 64-bit

The installer is named `deepseek-harness-0.1.5-rc.2-win-x64.exe` (`x64` = 64-bit; a 32-bit build
would be `ia32`, and the unpacked directory would be `win-ia32-unpacked`).

Upstream has no 32-bit path at all: `desktop-build-paths.mjs` lists only
`mac-arm64 / mac-x64 / win-x64` in `SUPPORTED_TARGETS`, and `package-target.ts` hard-codes
`arch: 'x64'` for `win-x64` while requiring a Windows x64 build host.

On top of that, the workflow enforces a binary-level gate
(`.github/scripts/verify-win-artifacts.mjs`): the PE header `Machine` field of both the
**main executable** and the **bundled `node.exe`** must be `AMD64 (0x8664)`, or the build fails.
The gate has its own regression test (`verify-win-artifacts.test.mjs`, 8 cases) run before packaging.

> **Easily misunderstood**: the installer *shell* is itself a 32-bit PE. NSIS has no 64-bit
> implementation, so electron-builder's `.exe` is always an i386 bootstrap — **that says nothing
> about the installed app**, which is a pure 64-bit Electron runtime plus a 64-bit `node.exe`.
>
> The app also legitimately ships a few non-x64 companion binaries
> (`runtime/pnpm/dist/vendor/fastlist-0.3.0-x86.exe`,
> `node-pty/third_party/conpty/<version>/win10-arm64/OpenConsole.exe`) — they are pnpm's and
> node-pty's own multi-arch payloads, so the gate only warns about them instead of failing.

### Installing

- **Unsigned**: SmartScreen will warn about an unknown publisher — choose “More info → Run anyway”.
- An unsigned package carries no auto-update configuration; it is meant for local install testing.

### Triggering it

Actions → **Build DSH Desktop (Windows, unsigned)** → Run workflow. Leave `ref` empty to use
upstream `master`; tick `force` to ignore the “release already exists” check.

A daily job runs at UTC 02:30 (10:30 Beijing time) and skips versions whose release already exists.

---

## License

[MIT](LICENSE). DeepSeek Harness itself is licensed by its own authors.
