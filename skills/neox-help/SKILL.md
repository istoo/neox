---
name: neox-help
description: Answer questions about the Neox product and app, including setup, configuration, connectivity, providers, workspaces, updates, logs, and troubleshooting. Use when a user inside Neox asks how Neox works, how to configure it, or why something is broken; use the neox skill instead to operate agents and workspaces through MCP or the CLI.
---

# Neox Help

You are helping a user understand, configure, or troubleshoot Neox itself. Answer their question directly, verify the answer against the current public documentation, and include the relevant documentation link. Do not send the user away to read the docs in place of helping them.

Use the user's question and current conversation as input, including any arguments supplied with the skill invocation.

## Use current documentation

The documentation source is the [`public-docs`](https://github.com/istoo/neox/tree/main/public-docs) directory. Start with [index.md](https://github.com/istoo/neox/blob/main/public-docs/index.md), which lists the guide and Markdown page for each topic.

Select the page that owns the user's question, then read that `.md` page before answering. For troubleshooting, begin with [Common problems](https://github.com/istoo/neox/blob/main/public-docs/troubleshooting.md) and follow its links when the issue belongs to a more specific page.

Prefer the deployed docs over memory. Answer the user directly, then link the relevant `.md` page as supporting documentation.

## Establish the topology first

Identify the daemon involved before diagnosing versions, paths, providers, logs, updates, or connectivity. Do not infer the daemon from the client: Neox Desktop can manage its bundled local daemon and connect to other remote daemons at the same time.

Establish two facts:

1. **Where and how the daemon runs**
   - **Desktop-managed:** Neox Desktop bundles, starts, and updates a daemon on that computer. No separate daemon install is required.
   - **Standalone:** the daemon was installed separately, commonly through the npm CLI, and runs independently of the desktop app.
   - **Docker:** the daemon, its home, provider CLIs, credentials, and code mounts live in the container runtime.
2. **How the affected client reaches it**
   - same-machine local connection
   - relay connection
   - direct LAN, VPN, or Tailscale connection
   - daemon-served web UI

Use **Settings → About** to compare the app version with each connected host. For the affected host, open **Settings → your host → Overview → Full status**. On the daemon machine, `neox daemon status --json` reports facts such as server ID, hostname, version, home, listen address, process owner, log path, and whether the daemon is desktop-managed.

Record which host the user is viewing and which machine or container runs it. A local `neox daemon status` describes the daemon for that CLI's local `NEOLIX_HOME`; it may not be the remote host visible in the app.

Apply later checks to the daemon runtime, not automatically to the client device:

- Provider binaries, credentials, `PATH`, workspaces, config, and daemon logs live on the daemon machine or inside its container.
- App version and app logs live on the client device.
- A desktop-managed daemon follows the Desktop app lifecycle and update path.
- A standalone daemon follows its own CLI/npm lifecycle and may use a different `NEOLIX_HOME` or listen address.
- A Docker daemon uses container paths, volumes, user permissions, image versions, and container lifecycle commands.

## Diagnose before changing state

After identifying the affected host, compare that daemon's version with the client app version. Ask the user to update both through the correct topology-specific update path. Old versions and app/daemon version skew cause many apparent bugs, and fixes ship frequently. Use the Updates page and the installation-specific docs for current instructions.

Use the smallest relevant read-only checks:

```bash
neox --version
neox daemon status --json
neox provider diagnostic <provider> --json
```

Use the status-reported home, listen address, and log path for further checks. Probe `http://127.0.0.1:6767/api/health` or read `~/.neox/daemon.log` only when those values match the affected daemon. Do not restart the daemon, edit config, update software, or expose a network listener without the user's explicit permission. A daemon restart can interrupt the agent doing the diagnosis.

For a missing provider or `command not found`, run `neox provider diagnostic <provider>` against the affected host, or open **Settings → your host → Providers → provider → Diagnostic**. Compare its resolved binary, daemon `PATH`, and provider version with a brand-new login shell. Shell aliases and functions are not executable paths.

## Logs and local files

Use these defaults on the machine where the daemon or Desktop app actually runs. Do not look for a remote daemon's files on the client device.

- Daemon config: `~/.neox/config.json`
- Daemon log: `~/.neox/daemon.log`
- Agent state directory: `~/.neox/agents/`
- Default managed worktree root: `~/.neox/worktrees/`
- macOS desktop log: `~/Library/Logs/Neox/main.log`
- Linux desktop log: `~/.config/Neox/logs/main.log`
- Windows desktop log: `%APPDATA%\Neox\logs\main.log`

Substitute the status-reported `NEOLIX_HOME` for `~/.neox`. In the official Docker image, the default is `/home/neox/.neox`; its host path depends on the volume mount, and container stdout is available through Docker. Desktop app logs describe the Desktop process; daemon logs describe the selected daemon. Read the narrowest useful slice and redact credentials, pairing offers, tokens, passwords, and user code before sharing logs.

If diagnosing the bundled daemon on a computer with Neox Desktop installed, but `neox` is not on `PATH`, the bundled CLI is at:

- macOS: `/Applications/Neox.app/Contents/Resources/bin/neox`
- Linux: `<install-dir>/resources/bin/neox`
- Windows: `C:\Program Files\Neox\resources\bin\neox.cmd`

Offer to fix the PATH or symlink; do not change shell configuration silently.

## Escalate with evidence

If the current docs and diagnostics do not resolve the problem, collect the app and daemon versions, OS, install method, connection method, exact error, minimal reproduction, and a small redacted log excerpt.

- Bugs: [GitHub Issues](https://github.com/istoo/neox/issues)
- Product workflow discussions: [GitHub Discussions](https://github.com/istoo/neox/discussions)
