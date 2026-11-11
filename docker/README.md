# Neolix Docker Image

This directory contains the official Neolix daemon image.

The image runs the daemon headless and serves the bundled web UI from the same
HTTP origin. Start it, then open the daemon URL in a browser.

```bash
docker run -d --name neolix \
  -p 6868:6868 \
  -e NEOLIX_PASSWORD=change-me \
  -v "$PWD/neox-home:/home/neolix" \
  -v "$PWD:/workspace" \
  ghcr.io/istoo/neox:latest
```

Then open `http://localhost:6868`.

The base image intentionally does not bundle agent CLIs. Extend it with the
agents you use:

```Dockerfile
FROM ghcr.io/istoo/neox:latest

USER root
RUN npm install -g @openai/codex @anthropic-ai/claude-code
```

See [docs/docker.md](../docs/docker.md) for Compose, reverse proxy, security,
agent auth, and troubleshooting notes.
