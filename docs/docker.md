# Running Neox in Docker

Neox publishes a container image for running the daemon on a server, VM, NAS,
or homelab box. The image runs the daemon and includes the web client. The daemon
serves that client to browsers through Settings › Network › Browser access, on a
port of its own.

The image source lives in [`docker/`](../docker/).

## How it works

The official image:

- builds `@neolix/server` and `@neolix/cli` from source-built workspace tarballs
- builds the desktop web app with Bun in the build stage and ships
  `dist/server/web-app` (the page and its RPC bundle) in `@neolix/server`; Bun is
  not in the final image
- runs the daemon as the non-root `neolix` user
- listens on `0.0.0.0:6868` inside the container
- stores daemon state and agent credentials under `/home/neolix`
- leaves agent CLIs out of the base image

Point clients at the container's HTTP origin, for example `http://localhost:6868`.
The web app on that port answers only requests from inside the container: the
daemon checks the peer and the `Host` name against loopback. A published port is
reached from another address, so the browser page comes from Browser access
instead. API and WebSocket requests still require `NEOLIX_PASSWORD` when one is
configured.

Host-side CLI commands select the container explicitly, for example `neox project ls --host 127.0.0.1:6868`. Without an endpoint selector the CLI looks for a local home’s supervisor. Container environment settings are deployment overrides; worker restart preserves them. Your container manager owns full supervisor replacement.

## Quick Start

```bash
docker run -d --name neolix \
  -p 6868:6868 \
  -p 3430:3430 \
  -e NEOLIX_PASSWORD=change-me \
  -v "$PWD/neox-home:/home/neolix" \
  -v "$PWD:/workspace" \
  ghcr.io/istoo/neox:latest
```

Connect a Neox client to `127.0.0.1:6868` with that password. Open Settings ›
Network › Browser access, choose LAN, keep port `3430`, and copy the key. Then
open:

```text
http://localhost:3430/?k=<the key>
```

`localhost` is one of the names Browser access answers to. From another
computer, use the Docker host's address in the link and start the container with
`NEOLIX_PUBLIC_URL` set to that same origin (for example
`http://192.168.1.5:3430`), so the daemon's Host check accepts the name.

## Docker Compose

Use [`docker/docker-compose.example.yml`](../docker/docker-compose.example.yml):

```bash
cp docker/docker-compose.example.yml docker-compose.yml
$EDITOR docker-compose.yml
docker compose up -d
```

Minimal example:

```yaml
services:
  neolix:
    image: ghcr.io/istoo/neox:latest
    restart: unless-stopped
    ports:
      - "6868:6868"
      - "3430:3430"
    environment:
      NEOLIX_PASSWORD: "change-me"
    volumes:
      - ./neox-home:/home/neolix
      - ./workspace:/workspace
```

## Installing Agents

The base image does not preinstall Claude Code, Codex, OpenCode, Copilot, Pi, or
other agent CLIs. That keeps the default image small and avoids coupling Neox
releases to third-party agent release cycles.

Create a child image for the agents you use:

```Dockerfile
FROM ghcr.io/istoo/neox:latest

USER root
RUN npm install -g @openai/codex @anthropic-ai/claude-code opencode-ai
```

Build it:

```bash
docker build -f Dockerfile -t neolix-with-agents .
```

Then use `image: neolix-with-agents` in Compose.

Leave the child image user as root. The base entrypoint uses root only for
first-run directory setup, then drops the daemon and launched agents to the
non-root `neolix` user.

An example child image is in
[`docker/Dockerfile.agents.example`](../docker/Dockerfile.agents.example).

You can also mount credentials from the host or run agent login once inside the
container:

```bash
docker exec -it --user neolix neox codex
docker exec -it --user neolix neox claude
```

Agent credentials and config persist in `/home/neolix`, alongside daemon state.
Provider environment variables such as `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
`OPENAI_BASE_URL`, or `ANTHROPIC_BASE_URL` can be passed through `docker run -e`
or `compose.environment`; Neox passes them to launched agents.

## Volumes

| Mount          | Purpose                                                                |
| -------------- | ---------------------------------------------------------------------- |
| `/home/neolix` | Neox state under `.neox` plus agent config such as `.codex`, `.claude` |
| `/workspace`   | Code that Neox and launched agents can read and write                  |

The image defaults:

| Variable        | Default              |
| --------------- | -------------------- |
| `HOME`          | `/home/neolix`       |
| `NEOLIX_HOME`   | `/home/neolix/.neox` |
| `NEOLIX_LISTEN` | `0.0.0.0:6868`       |

If you bind-mount host directories on Linux, make sure the container user can
write them. The built-in `neolix` user has uid/gid `1000:1000`. For a different
host uid/gid, either adjust ownership on the mounted directories or run the
container with Docker's `--user` / Compose `user:` option.

## Reverse Proxies

When serving Neox behind a reverse proxy, forward normal HTTP requests and
WebSocket upgrades to the Browser access port, and set `NEOLIX_PUBLIC_URL` to
the public origin. Browser access refuses a `Host` it was not told about, and
that variable is how a tunnel's or proxy's own name is allowed in. The daemon
port serves API clients directly and answers its web app only on loopback.

Caddy example:

```caddy
neox.example.com {
  reverse_proxy 127.0.0.1:3430
}
```

Nginx example:

```nginx
server {
    listen 443 ssl;
    server_name neox.example.com;

    location / {
        proxy_pass http://127.0.0.1:3430;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

If API clients reach the daemon by DNS name, set `NEOLIX_HOSTNAMES` so the
daemon's host-header validation allows that name:

```yaml
environment:
  NEOLIX_HOSTNAMES: "neox.example.com,.lan"
  NEOLIX_PUBLIC_URL: "https://neox.example.com"
```

IPs and `localhost` are allowed by default.

## Security

- Set `NEOLIX_PASSWORD` for any published port or network-reachable deployment.
- Prefer HTTPS at the reverse proxy for direct browser access.
- Deploy your own [relay](../packages/relay) for untrusted networks or remote
  access when you do not want to expose the daemon port directly.
- The container is the isolation boundary for agents. Agents can read and write
  whatever you mount into `/workspace` and whatever credentials you place in
  `/home/neolix`.
- Browser access is guarded by its key and its `Host` check. The web app on the
  daemon port answers loopback requests only. The daemon API and WebSocket remain
  protected by password auth when configured.

See [SECURITY.md](../SECURITY.md) for the daemon trust model.

## Building Locally

```bash
docker build -f docker/base/Dockerfile -t neox:local .
```

To assert the source tree version while building:

```bash
docker build \
  --build-arg NEOLIX_VERSION=0.1.102 \
  -t neolix:0.1.102 \
  -f docker/base/Dockerfile \
  .
```

The Docker workflow builds the image on pull requests and on `main` as a
non-publishing check. Stable `vX.Y.Z` tag pushes publish
`ghcr.io/istoo/neox:X.Y.Z` and `ghcr.io/istoo/neox:latest`. Beta tags
publish only the exact prerelease tag, such as
`ghcr.io/istoo/neox:0.1.102-beta.1`, and do not update `latest`.

To replace a Docker image in place without rebuilding desktop, APK, or EAS
mobile release artifacts, dispatch the Docker workflow manually instead of
pushing a `v*` release tag:

```bash
gh workflow run docker.yml \
  --ref main \
  -f neolix_version=0.1.102-beta.1 \
  -f publish=true
```

Manual Docker publishes require an explicit `neolix_version`. The workflow builds
from the checked-out source tree and publishes only the exact prerelease image
tag for prerelease versions.

The published image is multi-arch for `linux/amd64` and `linux/arm64`.

## Troubleshooting

- **The page does not open on `:6868`**: expected. The daemon port serves its web
  app to loopback only; publish `3430` and use Browser access.
- **403 Host not allowed**: for API clients set `NEOLIX_HOSTNAMES`; for Browser
  access set `NEOLIX_PUBLIC_URL` to the address the browser uses.
- **Provider not available**: install that agent CLI in a child image or mount a
  runtime where the binary is on `PATH`.
- **Permission errors in `/workspace`**: make the mounted directory writable by
  uid/gid `1000:1000`, or run the container as the host uid/gid.
- **Logs**: inspect `docker logs neolix` or
  `/home/neolix/.neox/daemon.log` inside the container.
