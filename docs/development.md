# Development

## Prerequisites

- Node.js (see `.tool-versions` for exact version)
- npm workspaces (comes with Node)

## Running the dev server

```bash
npm run dev:server
npm run dev:desktop
```

Root checkout dev is intentionally split across terminals:

- `npm run dev:server` runs the daemon on `127.0.0.1:6768`.
- `npm run dev:desktop` runs Electron against its own desktop-managed daemon. It loads the daemon-hosted web UI; set `NEOLIX_DESKTOP_WEB_URL` to point the window at a Vite dev server instead.

Desktop dev launches its desktop-managed daemon with `NEOLIX_NODE_ENV=development`,
so development-only providers such as Mock Load Test are available. Packaged
desktop launches always force the daemon to production mode.

### Desktop web UI

The desktop shell has one renderer: the web app at
`packages/desktop-web/apps/web`, served by the daemon on its own HTTP port
(`packages/server/src/server/web-app.ts`). The shell starts the desktop-managed
daemon (or uses `NEOLIX_DESKTOP_DAEMON`), polls `GET /` until it returns 200,
and loads `http://host:port/#<route>`. The daemon answers 503 while its web
module loads, so the shell keeps polling for up to 30 seconds. Unix socket and
pipe listen addresses cannot be loaded this way; a missing daemon, a socket
address, or a failed probe opens a Retry page that names the log file instead of
falling back to another renderer.

A vite dev server replaces the daemon for the window when
`NEOLIX_DESKTOP_WEB_URL` is set; the shell skips the daemon probe and loads that
address directly:

```bash
bun run --cwd packages/desktop-web/apps/web dev
NEOLIX_DESKTOP_WEB_URL=http://localhost:5173 npm run dev:desktop
```

Packaged builds ship `resources/desktop-web/bridge/embed.js` (the embeddable
web module, produced by `npm run build:desktop-web`) and
`resources/desktop-web/web` (a copy of `apps/web/dist`). The daemon loads that
bundle in-process, so no separate bridge process or Bun runtime ships.

The Nix packages build the same artifacts from the same sources. The daemon
package and the Linux desktop keep one copy in
`packages/server/dist/server/web-app`, which `webAppCandidates` resolves for an
unpackaged app. The macOS bundle gets them through electron-builder's
`extraResources` and excludes the server copy from the asar, as a published
desktop build does.

`packages/desktop-web` is a Bun workspace with its own lockfile, outside the npm
workspace `npmDeps` covers. `nix/bun-bin.nix` pins Bun 1.4.3 (nixpkgs' Bun
cannot read the lockfile format), and `nix/desktop-web-deps.nix` is a
fixed-output derivation that runs `bun install --frozen-lockfile`. It installs
every platform's optional packages and uses the hoisted linker, so one hash in
`nix/desktop-web-deps.hash` covers all supported systems and repeated runs
produce the same store path. After changing `bun.lock` or a desktop-web
`package.json`, run `./scripts/update-nix.sh` to refresh that hash.

The Vite build needs a builder with at least 6 GiB of RAM. Peak RSS is about
4.7 GB with React Compiler enabled. `scripts/build-daemon-web-app.mjs` caps
V8's old space at 3072 MiB and sets `RAYON_NUM_THREADS=2` for Rolldown's render
pool, and `packages/desktop-web/apps/web/vite.config.ts` bounds precompress
concurrency. The compiler's analysis of the two oversized single-file
components (`ChatView.tsx`, `Sidebar.tsx`) is what drives the peak; the rest of
the graph stays far below. Re-measure peak RSS before raising any of these.

`npm run dev` is only a shorthand for `npm run dev:server`. Keep `127.0.0.1:6868` for the packaged app and production-style `~/.neox` state.

## Nix desktop package

The flake exposes `packages.<system>.desktop` on Linux and macOS:

```bash
nix build .#desktop
```

Linux produces the `neolix-desktop` launcher and desktop entry. macOS produces
`Applications/Neox.app` plus the `neolix-desktop` launcher. Both use the nixpkgs
Electron runtime and the checkout's built daemon, client, and renderer rather
than downloading a published desktop release.

### NEOLIX_HOME

`NEOLIX_HOME` is the directory that holds runtime state (agents, worktrees, workspace config, sockets, daemon log). Resolution rules:

- The **server itself** (e.g. when launched by the desktop app or `npm run start`) defaults to `~/.neox` (see `packages/server/src/server/neolix-home.ts`).
- **Repo dev scripts** default to `$ROOT/.dev/neox-home`, where `$ROOT` is the current checkout or worktree root. This keeps all dev state scoped to the checkout instead of the packaged desktop app.
- **`npm run cli -- ...`** runs through the same dev-home wrapper as the dev scripts, so the in-repo CLI automatically targets the current checkout's `.dev/neox-home` and configured dev daemon endpoint.
- **Neox-created worktrees** seed `$NEOLIX_WORKTREE_PATH/.dev/neox-home` from `$NEOLIX_SOURCE_CHECKOUT_PATH/.dev/neox-home` by copying durable JSON metadata. Runtime files like pid files, sockets, and logs are not copied.

Override knobs:

```bash
NEOLIX_HOME=~/.neox-blue npm run dev           # explicit home
NEOLIX_DEV_SEED_HOME=/path/to/home npm run dev # seed from a different source home
NEOLIX_DEV_RESET_HOME=1 npm run dev            # clear and reseed the derived worktree home
```

### Daemon endpoints

- Stable daemon launched by the desktop app: `localhost:6767`.
- Root checkout dev daemon: `localhost:6768`.
- Desktop web UI: the daemon origin, for example `http://localhost:6768/`.
- Vite dev server for the web UI: `bun run --cwd packages/desktop-web/apps/web dev` (default `http://localhost:5173`), paired with `NEOLIX_DESKTOP_WEB_URL`.
- `npm run dev` (Windows): `localhost:6767` for the daemon.

In Neox-managed worktree services, use the injected service environment rather than hardcoded root checkout ports.

### Desktop renderer profiling

`npm run dev:desktop` starts Electron with Chromium remote debugging enabled so
renderer CPU profiles can be captured through CDP. By default it passes
`--remote-debugging-port=0`, so Chromium atomically asks the OS for an available
port and prints the selected DevTools endpoint. Set
`NEOLIX_ELECTRON_REMOTE_DEBUGGING_PORT` when a QA workflow requires a validated,
fixed port.

Desktop dev also scopes Electron `userData` to the current dev root. This prevents
desktop-only environment inherited by terminals opened inside Neox from coupling
a new worktree instance to the parent desktop instance's profile or single-instance
lock.

The desktop workspace script `exec`s the dev runner so the terminal owns the runner
PID. Terminal shutdown reaches the runner as `SIGHUP`; the runner asks Electron to
quit through its normal app lifecycle. Do not add an npm wrapper or
detach Electron: either change leaves an orphan holding the worktree's single-instance
lock and broken output pipes.

With desktop dev running, verify the real BrowserWindow, titlebar clearance, fullscreen
transition, and 751-pixel settings split with:

```bash
npm run verify:electron-cdp --workspace=@neolix/desktop
```

The verifier reads the same `NEOLIX_LISTEN`,
`NEOLIX_DESKTOP_WEB_URL`, and `NEOLIX_ELECTRON_REMOTE_DEBUGGING_PORT` environment
names as desktop dev. Set an explicit remote-debugging port for verifier runs, and
set both when testing an isolated instance on non-default ports.

### Preview Windows and Linux window controls on macOS

Desktop development can replace native macOS traffic lights with Neox's custom controls:

```bash
NEOLIX_DESKTOP_WINDOW_CONTROLS=windows npm run dev:desktop
NEOLIX_DESKTOP_WINDOW_CONTROLS=linux npm run dev:desktop
```

The override is rejected in packaged builds. Restart the desktop process when changing it.

### Desktop macOS compositor watchdog

macOS display sleep can leave Chromium's GPU-process display link — the vsync
source that drives frame production — stuck on a stale display. The compositor
then stops producing frames and the window looks frozen: unresponsive to clicks
and keys even though the renderer and every process stay alive. It self-recovers
after a few minutes, which is too long for a foreground app.

`setupDarwinCompositorWatchdog`
(`packages/desktop/src/window/compositor-watchdog/index.ts`) guards against
this. It polls the renderer for frame production every couple of seconds and,
after a sustained stall while the window is visible and unlocked, restarts the
GPU process so Chromium rebuilds the display link. The probe is skipped while
the screen is locked or the window is hidden or minimized, since a window
legitimately stops producing frames then.

The watchdog deliberately leaves background throttling **enabled**. Calling
`webContents.setBackgroundThrottling(false)` would keep the compositor producing
frames non-stop, pinning ProMotion displays at 120Hz forever and draining the
battery while the app is idle — so do not re-add it. The probe's visibility
guards already prevent throttling from causing a false stall.

### Desktop Linux hidden-window fallback

On Wayland (seen on ChromeOS Linux) a window created with `show: false` can sit
forever without a single compositor frame: the renderer loads and runs, but
`ready-to-show` never fires, so the window is never shown and the app looks like
it did not start while every process is alive. `showWindowWhenReady`
(`packages/desktop/src/window/show-when-ready.ts`) shows the main window when
the document finishes loading if the event has not arrived. The fallback is
Linux-only; macOS and Windows keep waiting for `ready-to-show`.

Run the startup regression on Linux with an isolated display:

```bash
xvfb-run -a npm run test:e2e:window-startup --workspace=@neolix/desktop
```

### Daemon logs

Check `$NEOLIX_HOME/daemon.log` for daemon logs. The default level is `info`; set
`NEOLIX_LOG_LEVEL=trace` before launching the daemon when you need full provider,
session, and agent-manager traces for stuck-state debugging.

The supervisor rotates `daemon.log`. Persisted `log.file.rotate` settings in
`$NEOLIX_HOME/config.json` win first. Without persisted config, the optional
`NEOLIX_LOG_ROTATE_SIZE` and `NEOLIX_LOG_ROTATE_COUNT` env vars override the
defaults. The default rotation is `10m` x `3` files everywhere.

### Git process pressure

If Git refreshes consume too much CPU, disk, or antivirus capacity, especially on Windows, reduce
the daemon-global Git process limits in `$NEOLIX_HOME/config.json`:

```json
{
  "daemon": {
    "git": {
      "maxProcessesPerSecond": 5,
      "maxProcessConcurrency": 4
    }
  }
}
```

Reload the daemon with `neox reload`. Environment-variable overrides still require a restart because
the launch environment remains authoritative. Lower values reduce machine pressure but make Git-backed workspace state and
Git RPCs wait longer. See [Git process limits](data-model.md#git-process-limits) for defaults,
semantics, and environment-variable overrides.

### Agent Tool Catalog Measurement

Measure the MCP `tools/list` payload that Neox injects into agents with:

```bash
npm run measure:agent-tools --workspace=@neolix/server
```

The command reports compact JSON bytes, estimated tokens, field totals, largest
tools, and the browser-tools delta. It defaults to the agent-scoped catalog; use
`-- --scope=top-level` for the unaffiliated `/mcp/agents` shape and `-- --json`
for machine-readable output.

## Worktree starting refs

A new worktree starts from the current branch's upstream, or the local branch when it has no
upstream. This keeps unpushed local commits out of new workspaces by default. The picker collapses
identical refs; divergent local or non-origin refs remain explicit, qualified choices.

The daemon sends the exact upstream ref because the remote and branch names cannot be inferred.
Worktrees retain that ref for comparisons and updates from base while exposing its branch name to
the UI. Merging into base requires a mutable local target: `origin/main` maps to local `main`, while
another remote fails closed until the worktree records an explicit local target. Older daemons omit
the optional field and retain the previous local-first behavior; older worktree metadata without the
exact ref also resolves through its stored branch name.

Worktrees inherit committed Git state only; uncommitted source-checkout changes are not copied.

## neox.json service scripts

`worktree.setup` and `worktree.teardown` accept either a multiline shell script or an array
of commands. Both run sequentially.

Lifecycle commands run in the worktree through a stable script shell: `bash`
resolved from `PATH` on macOS/Linux, and PowerShell with `-NoProfile` on
Windows. They inherit the daemon environment plus Neox's lifecycle variables;
login and interactive shell startup files are not loaded, and Bash's `BASH_ENV`
hook is unset. ACP single-string terminal commands use the same non-login Bash
behavior on macOS/Linux, but preserve their existing `cmd.exe /c` string semantics
on Windows. Service scripts are separate:
they launch in a terminal and receive the service environment described below.

Because the shell differs per platform, a lifecycle command that must run
everywhere cannot use POSIX-only syntax — `VAR=1 cmd` env prefixes, `$VAR`
expansion, `cp`/`rm`, or a `./scripts/*.sh` entrypoint all fail under PowerShell,
and `bash` is not guaranteed to exist on Windows. Put that logic in a Node script
that reads what it needs from `process.env` and invoke it as
`node ./scripts/<name>.mjs`. This repo's own setup does exactly that in
`scripts/seed-worktree-dev-state.mjs`.

```json
{
  "worktree": {
    "setup": "npm ci\ncp \"$NEOLIX_SOURCE_CHECKOUT_PATH/.env\" .env\nnpm run db:migrate",
    "teardown": "npm run db:drop || true"
  }
}
```

Every `scripts` entry with `"type": "service"` receives these environment variables:

| Variable                     | Value                                                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `NEOLIX_SERVICE_<NAME>_URL`  | Proxied URL for a declared peer service. Prefer this for peer discovery; it survives peer restarts.                       |
| `NEOLIX_SERVICE_<NAME>_PORT` | Raw ephemeral port for a declared peer service. Use only as a bypass escape hatch; it can go stale if that peer restarts. |
| `NEOLIX_URL`                 | Self alias for `NEOLIX_SERVICE_<SELF>_URL`.                                                                               |
| `NEOLIX_PORT`                | Self alias for `NEOLIX_SERVICE_<SELF>_PORT`.                                                                              |
| `HOST`                       | Bind host for the service process.                                                                                        |

Service proxy hostnames use the double-dash shape: `web--feature-auth--project.localhost` or, on the default branch, `web--project.localhost`. Optional public aliases use the same leftmost label under the configured public base host.

`<NAME>` is normalized from the script name by uppercasing it, replacing each run of non-`A-Z0-9` characters with `_`, and trimming leading or trailing `_`. For example, `app-server` and `app.server` both normalize to `APP_SERVER`; that collision fails at spawn time with an actionable error.

`PORT` is not injected by default. If a framework requires `PORT`, set it in the command:

```json
{
  "scripts": {
    "web": {
      "type": "service",
      "command": "PORT=$NEOLIX_PORT npm run dev:web"
    }
  }
}
```

Service ports use OS ephemeral allocation by default. Set `worktrees.servicePorts` in
`$NEOLIX_HOME/config.json`, or replace it for one project with `worktree.servicePorts` in
`neox.json`. The block accepts an inclusive `range` such as `"3000-4000"` or a `portScript`
executable. Since `portScript` is executed directly without a shell, it must point to a real executable (e.g., a binary or a script with a proper shebang like `#!/bin/sh`) rather than an inline shell command or shell pipeline. For inline shell commands or pipelines, wrap them in a small script. `portScript` runs in the workspace directory with four arguments: service name,
workspace ID, branch name, and worktree path. A missing branch is passed as an empty string. The same
values are available as `NEOLIX_SCRIPTNAME`, `NEOLIX_WORKSPACE_ID`, `NEOLIX_BRANCH_NAME`, and
`NEOLIX_WORKTREE_PATH`. The script must print one valid TCP port. Neox trusts the external allocator,
so the port may already be bound. `portScript` takes precedence when both values are present.

## Daemon-hosted web UI

> The user-facing guide for Browser access (enabling it, reverse proxy, TLS, tunnels, security) lives at [public-docs/web-ui.md](../public-docs/web-ui.md). This section is the contributor/build reference.

The daemon serves the desktop web app on its own HTTP origin. `WebAppHost` in
`packages/server/src/server/web-app.ts` loads `embed.js` in-process and serves the page,
`/rpc`, and the web app's upload/download routes. The same HTTP server continues to serve
`/api/*`, `/mcp/*`, `/public/*`, the WebSocket upgrade, and service-proxy routes. Static
files load without daemon bearer auth; API and WebSocket calls still enforce auth.

Build the artifact for packaging or measurement with:

```bash
npm run build:daemon-web-app
```

This runs the Bun builds in `packages/desktop-web/apps/bridge` and
`packages/desktop-web/apps/web`, then copies `embed.js` and the page into
`packages/server/dist/server/web-app/`. `webAppCandidates` resolves, best first: the
`NEOLIX_WEB_APP_BUNDLE`/`NEOLIX_WEB_APP_DIST` overrides, packaged desktop resources
(`resources/desktop-web`), the server build, and this checkout's
`packages/desktop-web/apps` builds.

`features.webUi.enabled` and `NEOLIX_WEB_UI_ENABLED` remain in the config surface for
protocol compatibility, but they no longer gate the daemon-origin page. Settings ›
Network › Browser access still reads `features.webUi.distDir` (or
`NEOLIX_WEB_UI_DIST_DIR`) and serves that same build on its separate port.

## Built workspace packages

Package imports resolve through package exports to compiled `dist/` output, not sibling `src/` files. This is true in local dev and in published packages: the daemon, desktop shell, CLI, and SDK consumers should all exercise the same runtime paths.

`npm run dev:server` builds the server-side workspace packages once, then keeps `@neolix/protocol` and `@neolix/client` fresh with TypeScript watch builds while the daemon runs. If you change protocol schemas or client code outside that watch workflow, rebuild the producer before trusting runtime behavior.

Use the named root build targets instead of remembering workspace dependency chains:

```bash
npm run build:client       # protocol -> client
npm run build:server-deps  # highlight -> relay -> protocol -> client
npm run build:server       # server-deps -> server -> cli
```

Use `npm run build:server` whenever you have changed any daemon/server-facing package and need clean cross-package types or runtime behavior.

For tighter loops, you can rebuild a single workspace:

- Changed `packages/protocol/src/*` or `packages/client/src/*`: `npm run build:client`.
- Changed `packages/server/src/*`, `packages/cli/src/*`, `packages/relay/src/*`, or `packages/highlight/src/*`: `npm run build:server`.
- Changed the web client: `npm run build:daemon-web-app`.

## Dependency patches

`patches/*.patch` are applied by `scripts/postinstall-patches.mjs` on every install. A patch only
runs when its package is actually present, so add the package to that script's `patchedPackages`
list when you introduce a new patch — otherwise the file sits in `patches/` and never applies.
patch-package cannot apply a patch that changed after an earlier version was applied, so the
script removes that package and fails the install; the next `npm install` reinstalls it clean
with the current patch. Regenerate a patch with `npx patch-package <package>` after editing `node_modules/<package>`.

## Dependency overrides and workspace tooling

Root `package.json` `overrides` keep one React and React Native version across the npm
workspaces. `packages/plugin` is the remaining consumer: it declares `react` and an optional
`react-native` peer for plugin UI surfaces. `packages/desktop-web` is a separate Bun workspace
and resolves its own frontend dependencies, so its tree is not governed by these overrides.

## Dependency signature audit

The `quality` CI job runs `npm audit signatures`. It verifies every lockfile package's registry
signature and, for packages published with provenance, fetches
`/-/npm/v1/attestations/<name>@<version>` from the registry. Cloudflare caches that document
for a year. An edge that cached it in the seconds before the registry attached the publish
attestation keeps serving a document with only the provenance bundle, and npm fails with:

```
npm error code EMISSINGSIGNATUREKEY
npm error <name>@<version> has attestations but no corresponding public key(s) can be found
```

The same package's registry signature verified a moment earlier with the same keys, so the
key list is intact. The failure names one package, repeats only for that package, and depends
on the Azure region the runner landed in, because each region maps to one Cloudflare colo. A
rerun passes only by landing elsewhere.

To confirm, fetch the URL from several runners and compare `content-length`, the `cf-ray` colo
suffix, and the number of `attestations` entries (#7730 has the probe). To fix, remove or
replace that version in the lockfile. If the dependent’s range cannot be changed, pin a clean
version in root `overrides`. Report the URL to npm so they purge it.

A lockfile regeneration is itself how new bad versions enter: the pkijs fix re-resolved the
electron-builder tree and pulled in `semver` 5.7.3 and 6.3.2, published two days earlier, and
5.7.3 then failed the same way. After editing `overrides`, run `npm install --package-lock-only`
and check that the changed `resolved` lines in `package-lock.json` are only the ones you meant.

A per-parent override such as `"tiny-async-pool": { "semver": "5.7.2" }` applies to that
parent's whole subtree, so it can also downgrade a grandchild that needs a different major. Key
the child by range (`{ "semver@^5": "5.7.2" }`) so only matching edges are replaced.

## CLI reference

Use `npm run cli` to run the in-repo CLI from source (`npx tsx packages/cli/src/index.ts`). The script wraps the CLI with `scripts/dev-home.sh`, so it automatically uses this checkout's `.dev/neox-home` and dev daemon endpoint unless you pass an explicit override. The globally installed `neox` binary on macOS is a symlink into the installed Neox desktop app, not this checkout — use it to drive the desktop's built-in daemon, but use `npm run cli` when you want to talk to the CLI you are editing.

Canonical automation uses `neox project create/ls/rename/delete`, `neox workspace create/ls/rename/archive`, `neox heartbeat create/update/delete`, and the full `neox schedule` group. MCP heartbeat automation is intentionally smaller: create and delete only. Detach remains an explicit user lifecycle action rather than an agent tool. `neox run --new-workspace local|worktree` composes workspace creation with agent creation. The old `neox worktree` and `neox run --worktree` forms are hidden compatibility aliases.

```bash
npm run cli -- ls -a -g              # List all agents globally
npm run cli -- ls -a -g --json       # Same, as JSON
npm run cli -- inspect <id>          # Show detailed agent info
npm run cli -- logs <id>             # View agent timeline
npm run cli -- agent open <id>       # Focus an existing agent in Neox Desktop
npm run cli -- daemon status         # Check daemon status
npm run cli -- sessions              # Latest sessions across agents, and their cost
npm run cli -- sessions read off all # Stop reading agents' own session history
npm run cli -- clone owner/repo --dir ~/workspace # Clone GitHub repo and register project
```

Use the global `--host` option to point the CLI at a different daemon:

```bash
npm run cli -- --host localhost:7777 ls -a
npm run cli -- --host ssh://user@host ls -a
```

Set `NEOLIX_HOST` to use the same target across invocations. An explicit
selector overrides both environment selectors. With both `NEOLIX_HOME` and `NEOLIX_HOST` set, pass an explicit selector. See [CLI target selection](../public-docs/cli.md#select-one-daemon).

In an SSH URI, the URL port is the SSH server port. The remote daemon defaults to `127.0.0.1:6868`; use `?daemonPort=7777` to override it. The transport runs non-interactively through the local OpenSSH client and never installs, starts, or configures the remote daemon. User-facing setup and troubleshooting live in [public-docs/connectivity.md](../public-docs/connectivity.md#ssh).

Desktop integrations can focus an existing agent without creating one or
sending a message. Run `neox agent open <agent-id>`. The CLI reads the local daemon's server ID by
default; pass `--server <server-id>` when targeting another server.

## Agent state

Agent data lives at:

```
$NEOLIX_HOME/agents/{cwd-with-dashes}/{agent-id}.json
```

Find an agent by ID:

```bash
find $NEOLIX_HOME/agents -name "{agent-id}.json"
```

Find by content:

```bash
rg -l "some title text" $NEOLIX_HOME/agents/
```

## Provider session files

Get the session ID from the agent JSON (`persistence.sessionId`), then:

**Claude:**

```
~/.claude/projects/{cwd-with-dashes}/{session-id}.jsonl
```

**Codex:**

```
~/.codex/sessions/{YYYY}/{MM}/{DD}/rollout-{timestamp}-{session-id}.jsonl
```

## Testing with Playwright MCP

Point Playwright MCP at the running web target. For root checkout dev, the daemon serves the
web UI at `http://localhost:6768/`. When the window is pointed at a Vite dev server through
`NEOLIX_DESKTOP_WEB_URL`, use that origin instead. For Neox-managed worktree services, use the
service URL or port shown by Neox for that worktree.

Do NOT use browser history (back/forward). Always navigate by clicking UI elements or using `browser_navigate` with the full URL — the app uses client-side routing and browser history breaks state.

## Typecheck

Always run typecheck after changes:

```bash
npm run typecheck
```
