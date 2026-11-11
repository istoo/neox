# syntax=docker/dockerfile:1

ARG NODE_IMAGE=node:22-bookworm-slim
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS source-pack

ARG NEOLIX_VERSION

ENV ONNXRUNTIME_NODE_INSTALL=skip

WORKDIR /tmp/neolix-src
COPY . .

RUN set -eux; \
    if [ -n "${NEOLIX_VERSION:-}" ]; then \
      test "$(node -p "require('./package.json').version")" = "${NEOLIX_VERSION}"; \
    fi; \
    node -e 'const fs=require("node:fs"); const pkg=JSON.parse(fs.readFileSync("package.json","utf8")); delete pkg.scripts.prepare; fs.writeFileSync("package.json", `${JSON.stringify(pkg)}\n`);'; \
    npm ci

RUN set -eux; \
    mkdir -p /tmp/neolix-packs; \
    npm pack --workspace=@neolix/highlight --pack-destination /tmp/neolix-packs; \
    npm pack --workspace=@neolix/relay --pack-destination /tmp/neolix-packs; \
    npm pack --workspace=@neolix/protocol --pack-destination /tmp/neolix-packs; \
    npm pack --workspace=@neolix/client --pack-destination /tmp/neolix-packs; \
    npm pack --workspace=@neolix/plugin --pack-destination /tmp/neolix-packs; \
    npm pack --workspace=@neolix/server --pack-destination /tmp/neolix-packs; \
    npm pack --workspace=@neolix/cli --pack-destination /tmp/neolix-packs

FROM ${NODE_IMAGE}

ENV HOME=/home/neolix \
    NEOLIX_HOME=/home/neolix/.neox \
    NEOLIX_LISTEN=0.0.0.0:6868 \
    NEOLIX_WEB_UI_ENABLED=true \
    NEOLIX_LOG_FORMAT=json \
    NEOLIX_LOG_LEVEL=info \
    CLAUDE_CONFIG_DIR=/home/neolix/.claude \
    CODEX_HOME=/home/neolix/.codex \
    XDG_CONFIG_HOME=/home/neolix/.config \
    XDG_DATA_HOME=/home/neolix/.local/share \
    XDG_STATE_HOME=/home/neolix/.local/state \
    XDG_CACHE_HOME=/home/neolix/.cache \
    ONNXRUNTIME_NODE_INSTALL=skip

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      bash \
      ca-certificates \
      curl \
      git \
      gosu \
      lbzip2 \
      openssh-client \
      procps \
      tini; \
    rm -rf /var/lib/apt/lists/*

COPY --from=source-pack /tmp/neolix-packs /tmp/neolix-packs
RUN set -eux; \
	npm install -g /tmp/neolix-packs/*.tgz; \
    rm -rf /tmp/neolix-packs; \
    npm cache clean --force; \
    server_entry="$(npm root -g)/@neolix/server/dist/scripts/supervisor-entrypoint.js"; \
    test -f "$server_entry"; \
    printf '%s\n' "$server_entry" > /etc/neolix-server-entry; \
    node --check "$server_entry"

RUN set -eux; \
    existing_group="$(getent group 1000 | cut -d: -f1 || true)"; \
    if [ -n "$existing_group" ] && [ "$existing_group" != "neolix" ]; then \
      groupmod --new-name neolix "$existing_group"; \
    elif [ -z "$existing_group" ]; then \
      groupadd --gid 1000 neolix; \
    fi; \
    existing_user="$(getent passwd 1000 | cut -d: -f1 || true)"; \
    if [ -n "$existing_user" ] && [ "$existing_user" != "neolix" ]; then \
      usermod --login neolix --gid neolix --home /home/neolix --shell /bin/bash "$existing_user"; \
    elif [ -z "$existing_user" ]; then \
      useradd --uid 1000 --gid neolix --create-home --home-dir /home/neolix --shell /bin/bash neolix; \
    fi; \
    mkdir -p \
      /workspace \
      "$NEOLIX_HOME" \
      "$CLAUDE_CONFIG_DIR" \
      "$CODEX_HOME" \
      "$XDG_CONFIG_HOME" \
      "$XDG_DATA_HOME" \
      "$XDG_STATE_HOME" \
      "$XDG_CACHE_HOME"; \
    chown -R neolix:neolix /home/neolix /workspace

COPY docker/base/rootfs/ /
RUN chmod +x /usr/local/bin/neolix-docker-entrypoint

WORKDIR /workspace

EXPOSE 6868
VOLUME ["/home/neolix"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "const listen=process.env.NEOLIX_LISTEN||'0.0.0.0:6868'; const m=listen.match(/:(\\d+)$/); const port=m?Number(m[1]):6868; require('http').get({hostname:'127.0.0.1',port,path:'/api/health'},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/neolix-docker-entrypoint"]
