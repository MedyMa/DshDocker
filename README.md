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

## Quick start

### Docker run

```bash
docker run -d --name dsh \
  --restart unless-stopped \
  -p 3080:3080 \
  -v dsh-home:/home/node/.dsh \
  -v "$PWD/workspace:/workspace" \
  -e DSH_TRUSTED_HOSTS="192.168.1.10:3080" \
  ghcr.io/medyma/dshdocker:latest
```

Then open `http://<your-host>:3080`.

### Docker Compose

```bash
docker compose up -d
```

Edit `DSH_TRUSTED_HOSTS` in `docker-compose.yml` to match **the address you actually
browse with** (`IP:port` or `hostname:port`).

---

## Image tags

| Tag | Meaning |
|---|---|
| `latest` | Newest upstream `master` built by this repo |
| `0.1.5-rc.2` | Upstream `package.json` version at build time |
| `sha-<short>` | Upstream commit that was built (**most precise**) |
| `v1.0.0` | Git tag pushed to *this* repo |

Because images come from source, `sha-<short>` is the tag to pin when you want exactly
one upstream commit.

---

## Build args (local builds)

| Arg | Default | Description |
|---|---|---|
| `DSH_REPO` | `https://github.com/deepseek-ai/deepseek-harness.git` | Upstream repo (point at a mirror if needed) |
| `DSH_REF` | `master` | Branch, tag, or commit SHA to build |
| `DSH_BUILD_SCRIPT` | `build` | pnpm script to run; `build:official` matches upstream's release profile |
| `NODE_VERSION` | `24` | Node base image (upstream CI uses 24; `engines` requires `^22.19.0 \|\| >=24.0.0`) |
| `PNPM_VERSION` | `11.7.0` | pnpm version via corepack (matches upstream `packageManager`) |

```bash
# latest master
docker build -t dshdocker .

# a specific release tag
docker build --build-arg DSH_REF=v0.1.5-rc.2 -t dshdocker .

# a specific commit (most reproducible)
docker build --build-arg DSH_REF=<commit-sha> -t dshdocker .

# arm64
docker buildx build --platform linux/arm64 -t dshdocker .
```

> The build is heavy: `pnpm run build` runs `build:native-system` (native Landlock addon,
> needs `musl-gcc`) → `build:lib` (`tsc` with a 4 GB heap) → `build:web`. Expect a long
> build and several GB of build cache.
>
> Behind the GFW? Set `DSH_REPO` to a GitHub mirror, or pass a proxy:
> `--build-arg HTTP_PROXY=... --build-arg HTTPS_PROXY=...`

---

## Configuration

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `DSH_BIN` | `/src/apps/cli/lib/bin.js` | CLI entry point produced by the source build |
| `DSH_HOST` | `0.0.0.0` | Bind host for the web UI |
| `DSH_PORT` | `3080` | Listen port |
| `DSH_TRUSTED_HOSTS` | *(empty)* | Comma-separated extra authorities accepted by the `/api` browser-trust fence. **Required when you access the UI from anything other than localhost.** e.g. `192.168.1.10:3080,dsh.local:3080` |
| `DSH_HOME` | `/home/node/.dsh` | DSH data root (credentials, settings, sessions, profiles) |
| `DSH_TELEMETRY_DISABLED` | `1` | Disable telemetry |

### Volumes

| Path | Purpose |
|---|---|
| `/home/node/.dsh` | **Persist this.** Credentials, settings, sessions, profiles, storages. |
| `/workspace` | Working directory DSH reads/writes and runs commands in |

> The container runs as the base image's **`node` user (UID/GID 1000)** — not root.
> For bind mounts: `sudo chown -R 1000:1000 ./data ./workspace`

### Running other modes

The entrypoint runs `dsh web` by default; **any arguments are forwarded to the CLI**:

```bash
# headless: run one task, print the answer, exit
docker run --rm -v dsh-home:/home/node/.dsh \
  ghcr.io/medyma/dshdocker:latest --profile headless "summarize /workspace/notes.txt"

# shell inside the container
docker run --rm -it --entrypoint bash ghcr.io/medyma/dshdocker:latest
```

---

## CI

`.github/workflows/docker.yml`:

1. **resolve** — shallow-clones upstream at the requested ref, reads `package.json`
   for the version, computes tags (`latest` / `<version>` / `sha-<short>`), and on
   scheduled runs **skips the build if that `sha-<short>` image already exists**.
2. **build** — a matrix of **native runners**: `ubuntu-24.04` for `linux/amd64` and
   `ubuntu-24.04-arm` for `linux/arm64`. Each pushes **by digest** (no QEMU, so the
   heavy TypeScript/frontend build stays fast).
3. **merge** — collects the digests and creates one multi-arch manifest with all tags.

Daily schedule means you get new upstream commits automatically, without rebuilding
when nothing changed.

> The `ubuntu-24.04-arm` runner is free for **public** repositories. If your fork is
> private, either make it public or replace that matrix entry with a QEMU build
> (`platforms: linux/arm64` on `ubuntu-24.04`) and accept the slower build.

---

## Notes & caveats

1. **GHCR packages are private by default.** After the first successful run:
   *GitHub → your profile → Packages → dshdocker → Package settings → Change visibility*
   → **public**.
2. **Image size.** This builds the whole upstream monorepo and ships it, so the image is
   large (multiple GB). If you only need a small runtime, the npm-install flavour of
   this image is far leaner — source builds trade size for fidelity/reproducibility.
3. **`DSH_TRUSTED_HOSTS` matters.** DSH's web app has a browser-trust fence on `/api`;
   LAN IP / domain access is rejected unless listed.
4. **First run needs model credentials.** Stored under `DSH_HOME` — mount a volume.
5. **Sandbox / Landlock.** DSH uses a Landlock-based confinement helper. Docker's default
   seccomp profile may block those syscalls; DSH degrades gracefully, but if you want the
   sandbox try `--security-opt seccomp=unconfined`.
6. **Behind a proxy?** Set `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` for the container so
   it can reach your model API.
7. **Unofficial.** Community packaging of an official open-source project. Not affiliated
   with DeepSeek.

---

## License

[MIT](LICENSE). DeepSeek Harness itself is licensed by its own authors.
