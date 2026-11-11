# Plugins

Local plugins contribute daemon RPCs, native app surfaces, workspace panels, Command Center items,
client slash commands, timeline items, header buttons, composer pills, app themes, composer attachment sources, and settings screens.
Neox executes `index.server.ts` in a subprocess and `index.client.tsx` in every connected app.

> **Trust every plugin you add.** `neox plugin add` and `neox plugin install` mean “I trust this codebase.” Plugins are unsandboxed: server code and preparation commands run with the daemon user's access on the daemon host, and client contributions run inside Neox. The repository's dependencies and future updates are part of that trust decision. With `--host`, preparation runs on that remote daemon host.

## Install a directory source

Create a typecheckable plugin project, install its development dependencies, then install it into
the daemon. `init` only writes the project files; it does not run the package manager.

```bash
neox plugin init /absolute/path/to/my-plugin
cd /absolute/path/to/my-plugin
npm install
npm run typecheck
neox plugin install /absolute/path/to/my-plugin
neox plugin install /absolute/path/to/my-plugin --id another-runtime-id
neox plugin ls
```

The daemon stores directory sources under the root `plugins` object:

```json
{
  "pluginsEnabled": true,
  "plugins": {
    "my-plugin": {
      "source": "directory",
      "path": "/absolute/path/to/my-plugin",
      "enabled": true
    }
  }
}
```

Installed plugins are disabled unless `pluginsEnabled` is `true`. Built-in plugins remain active.
Changing that root field is
runtime-safe: run `neox reload` after editing `config.json`. Enabling starts every configured,
enabled plugin; disabling tears them all down without restarting the daemon. Plugin source entries
remain lifecycle-owned and do not reload from manual config edits.

The directory contains a manifest declaring identity and Neox requirements, one optional entry per runtime, runtime-owned
directories, and local typechecking support. At least one entry is required.

```text
my-plugin/
  neox-plugin.json
  package.json
  tsconfig.json
  index.client.tsx
  index.server.ts
  client/greeting.tsx
  server/greeting.ts
  shared/greeting.ts
```

The generated `package.json` installs `@neolix/plugin` and the other host modules as development
dependencies for local typechecking and tests. Neox compiles TypeScript and TSX and supplies the
runtime modules, so consumers do not install these packages when adding the plugin.

```json
{
  "id": "my-plugin",
  "requirements": { "neolix": ">=0.8.0" }
}
```

Declare the supported Neox range and keep it current when adopting newer APIs. See the
[requirements contract](../public-docs/plugins/reference.md#requirements), including legacy
manifests and prerelease matching.

The config key is the runtime plugin ID. The manifest ID is the default selected during install;
`--id` overrides it. Existing configuration is not renamed when the manifest changes, and the
runtime does not compare the two IDs. The same directory can be installed under several config
keys.

Never enable plugins on a user's behalf without explicit permission. Before asking, check the
target daemon's current `pluginsEnabled` value. State that plugins are trusted, unsandboxed code:
backend code can access the daemon machine, while client contributions run inside the Neox app.

Source changes are explicit. Run `neox plugin reload <id>` to stop and fully tear down the old
plugin before compiling and starting from disk. A failed reload stays failed; Neox does not restore
the old code. Use `enable`, `disable`, and `remove` to manage one plugin. Removing a directory source
never deletes it. The global `pluginsEnabled` switch remains available.

## Client translations

Plugin runtime translations follow the connected app, so never send a daemon locale through RPCs or add plugin resources to the app catalog. The installation owns the translation engine; native portal bridges must carry it alongside RPC and client-state contexts. Keep host label resolution at presentation time so language changes preserve the installation lifetime.

The author contract is in [runtime translations](../public-docs/plugins/reference.md#runtime-translations).

## Built-in plugins

Built-in plugins ship from `plugins/<id>/`, with `neox-plugin.json`, `index.server.ts`,
`server/`, and optional client entry and icon. Add the plugin ID to `builtinPlugins` in
`packages/server/src/server/plugins/builtin/index.ts`; the workspace, build copy, and CI
checks cover that registry. Unlisted directories do not load.

The `worktree-include` built-in copies gitignored files selected by
[`.worktreeinclude`](../public-docs/worktrees.md#copy-local-files-with-worktreeinclude)
before setup and agents, through `worktree.create.after`.

Desktop packaging ships the entire built-in plugin directory as an external resource,
including declarations. The external esbuild compiler cannot read Electron's `app.asar`
filesystem, and packaging dependencies excludes `.d.ts` files needed for import validation.
Built-ins can import only host modules (`@neolix/plugin/*`, `zod`) and Node built-ins:
outside the archive, nothing resolves an npm dependency, and the dist build test cannot catch
one because it resolves through the repository's `node_modules`.
The packaged-app smoke check requires every listed built-in to start without relying on
account credentials.

Built-ins run in process and remain active independently of `pluginsEnabled`. They are
absent from the installed plugin list and source configuration; their client bundles
appear in the plugin catalog. Editing one in development requires a daemon restart.
Directory, Git, and npm installs cannot use a built-in ID.

A provider registration with `requiresConfiguration: true` participates only while its ID exists
under `agents.providers`. Hoplite uses this for catalog opt-in. Add writes `{ "enabled": true }`
without `extends`, so it selects the bundled adapter. Remove deletes the config entry; setting
`enabled: false` keeps the entry. The bundled JavaScript still loads at startup, but an absent
provider does not enter executable resolution or catalog discovery.

Provider plugins use separate installation and provider IDs. `muse-provider` registers the
selectable `muse` provider (Muse Code) and a usage source. Its `status({ launch })` reports
availability and a diagnostic after the daemon resolves the executable. Configure command,
environment, or enablement overrides under `agents.providers.muse`. Omit `extends` to keep
the bundled integration; an entry with `extends` shadows it with a custom provider. See
[provider contributions](#contribute-a-provider) for the contract and
[Muse Code](../public-docs/muse-code.md) for setup, per-agent options, and version limitations.

## Install from a registry

`neox plugin add owner/slug` installs the registry's reviewed artifact by default.
Browse published plugins at [public-docs/plugins](https://github.com/istoo/neox/tree/main/public-docs/plugins).
Use `git:owner/repository` or a full Git URL for a Git source. Registry installs
keep the registry URL and ID, so update checks use its approved pin. Explicit version/ref
selection is unavailable for registry installs; install an explicit source to select your own.

Registry overviews are untrusted author content, even before installation. Render them with
`@neolix/protocol/plugin-overview`: no raw HTML, HTTPS-only links and images, no relative
URLs, and isolated external links. The reusable corpus is
`packages/protocol/tests/fixtures/plugin-overview.json`. An app overview must share
this policy. Installed-plugin descriptions in the app remain plain text.

Use `host/owner/slug` for a registry at `https://host`, or set
`NEOLIX_PLUGIN_REGISTRY` to set the registry base (including a path prefix).
Private registry credentials live in daemon config under
`pluginRegistries: { "host": { "authorization": "Bearer token" } }`.
Restart your daemon after changing these startup settings. Credentials go only to the registry,
never artifact hosts or redirects. Git/npm use their own host authentication.

The [open registry protocol](https://github.com/istoo/neox/tree/main/public-docs/plugins/publishing.md)
owns static hosting, record shapes, pins, and advisory install counts.

## Install a Git source

GitHub repositories use `git:owner/repository` or `github:owner/repository`. Other hosts use a Git
URL.

```bash
neox plugin install git:owner/repository
neox plugin install https://gitlab.com/group/repository.git
neox plugin install git:owner/monorepo:plugins/review
neox plugin install github:owner/repository --ref main
```

Append `:relative/path` for a plugin below the repository root. `--ref` chooses the initial
branch, tag, or commit once. Updates of explicit Git sources resolve the remote's default HEAD
and ask for approval. `ls` reports the installed commit without contacting the remote.

## Managed source ownership

The [public source reference](../public-docs/plugins/reference.md#plugin-sources) owns identifier
syntax and npm prerequisites; the [publishing guide](../public-docs/plugins/publishing.md) owns distribution. The CLI resolves directory sources before
calling `installPluginSource`; see the public source reference for CLI and app path semantics.
Only the daemon reads plugin files and acquires sources.

`ManagedPluginSources` owns acquisition and offline source description. Config stores the active
directory; sources.json stores managed kind and the Git acquisition remote. The remote is needed
because authenticated clones may have a rewritten placeholder origin. Fixed owned directory layout
provides the selected subdirectory, npm package name and cleanup root. Git HEAD and the installed
npm package.json checked against package-lock.json provide the current revision. Keep the complete
npm dependency tree and lockfile after staging activation. No install selector governs updates.

The loader sees only the configured directory and never invokes npm. npm lifecycle scripts are
disabled during acquisition; manifest preparation owns required commands before validation.

List responses retain the closed `source: directory | git` enum. The optional `installation`
projection carries identity and current revision. Old npm metadata remains accepted but is no longer
emitted. Installation uses `features.pluginSourceInstallation`; reviewed preview/apply uses
`features.pluginSourceUpdates`, gated by the SDK and CLI entry. The old immediate-update request
returns update-client guidance. Basic management remains independently available.

Preview returns exact targets and expected installed identity/root/revision. Apply validates those
values, acquires the displayed artifact or commit, then rechecks state before activation. No review
session is stored in the daemon. PluginService owns activation/recovery and independent bulk results.

### Declare Git preparation

Most plugins should omit `build`. Use it only when the staged checkout must install a dependency
that Neox does not provide, generate source or assets, or perform another required preparation
step:

```json
{
  "id": "review",
  "requirements": { "neolix": ">=0.8.0" },
  "build": [
    ["npm", "ci"],
    ["npm", "run", "build"]
  ]
}
```

`build` is an optional list of argv arrays. Each array must contain at least one non-empty string;
shell command strings are rejected. Neox starts the executable directly, without a shell, from the
plugin directory in the staged checkout. It never detects lockfiles or chooses a package manager.

On install and every update, Neox resolves the exact Git revision and manifest, runs the declared
commands, then validates, compiles, and activates the candidate. It logs each argv command and its
output in the daemon log. If a command fails, the error includes its output, Neox discards the
candidate, and the existing installed and running version stays untouched. On a remote daemon, all
of this happens on the remote daemon host.

Server contributions can write to stdout and stderr with normal Node logging. Neox adds `[neolix]`
entries for loading, ready, stopping, and stopped transitions. Compilation and load failures are
recorded as stderr entries before a subprocess exists. Inspect the recent in-memory
tail from the host plugin settings or with `neox plugin logs <id>`. Git preparation commands are
recorded in `$NEOLIX_HOME/daemon.log` before a plugin exists, rather than the plugin log tail. Reload, disable, and process
failure retain the tail; removing the plugin clears it. Daemon restarts do not retain the tail, but
structured copies remain in `$NEOLIX_HOME/daemon.log`. Plugin output can contain secrets, so do not
log credentials or tokens.

## Contribute behavior and UI

Default export one contribution function from each runtime entry. Keep the entries to registration
wiring. Runtime code lives behind directory boundaries:

| Path                             | Owns                                                                 |
| -------------------------------- | -------------------------------------------------------------------- |
| `index.client.tsx` and `client/` | React, React Native, hooks, styles, surfaces, panels, and callbacks. |
| `index.server.ts` and `server/`  | Node APIs, filesystem and process access, credentials, and handlers. |
| `shared/`                        | Zod RPC contracts and plain values used by both runtimes.            |

Do not put any other code modules in the plugin root.

Shared files import contract helpers and types from `@neolix/plugin`. Server handler files import
`PluginHandlerContext` from `@neolix/plugin/server`. Client files import Neox UI from
`@neolix/plugin/client/ui`. Its `Icon` draws a Lucide name from the client's installed
icon set, or any `PluginIcon` through its `icon` prop; an unknown name or unsafe SVG renders nothing
so it cannot break the plugin surface.
Its controlled modal keeps presentation metadata on `<Modal title="…" icon={…}>` and body UI in
`<Modal.Content>`. Body layout, sheet-aware scrolling, and clipboard actions follow the
[host UI contract](../public-docs/plugins/reference.md#host-ui).
Plugin UI runs on desktop and mobile across multiple themes: color every `Text` from
`theme.colors.foreground` or `theme.colors.foregroundMuted`, and size layout from `layout.compact`.
See `public-docs/plugins/reference.md`.

### SDK import boundaries

Classify every SDK export before adding it. All client entry points and implementations live under
`client/`; all server entry points and implementations live under `server/`. The package root is shared code: plain data types,
Zod schemas, and functions that run in both runtimes. A type-only import is still an architectural
dependency; shared types must not refer to React components, hooks, Node APIs, or server contexts.

| Entry                                           | Owns                                                                       | May depend on          |
| ----------------------------------------------- | -------------------------------------------------------------------------- | ---------------------- |
| `@neolix/plugin`                                | Shared data, schemas, RPC/settings definitions, runtime-neutral helpers    | Shared code only       |
| `@neolix/plugin/server`                         | Server contexts, lifecycle contracts, and CLI process launch               | Shared and server code |
| `@neolix/plugin/server/provider`, `/server/acp` | Server provider contracts and adapters                                     | Shared and server code |
| `@neolix/plugin/server/opencode`                | Adapter from a myna OpenCode auth plugin to a subscription provider        | Shared and server code |
| `@neolix/plugin/client`                         | Client contribution contexts, hooks, navigation, and UI contribution types | Shared and client code |
| `@neolix/plugin/client/ui`                      | Host-provided UI components                                                | Shared and client code |
| `@neolix/plugin/client/host`                    | App-owned rendering integration; not a plugin-author entry                 | Shared and client code |

Server code imports shared helpers from the root and server capabilities from `/server`. Client
code imports shared helpers from the root and client capabilities from `/client`. Neither runtime
imports the other. Re-exports follow the same rule; tree shaking does not establish a boundary.
React, React Native, JSX runtimes, and client hooks must never be reachable from the root or any
server entry. Node and platform-specific code must never be reachable from the shared root.

The SDK boundary checks and real plugin-subprocess tests enforce these rules. Every SDK change
must preserve them and update the public reference, migration guide, scaffold, and examples when
an author-facing import changes. The plugin compiler enforces the same runtime entry rules for
plugin-authored code. Keep the package export map and host-provided module maps consistent.

The compiler rejects imports across runtime directories or SDK entries, React dependencies in
server code, and Node imports in client code (including bare names such as `fs`). Shared modules
cannot import runtime-owned modules. Forbidden imports fail compilation; never replace them with
empty module stubs. A relative
import to any other code file in the plugin root is also rejected; move it into `client/`, `server/`,
or `shared/`. These are compile errors naming the importing file and boundary rule. Top-level React
Native calls such as `StyleSheet.create` belong in `client/`.

The scaffold omits `"DOM"` from `tsconfig.json` and does not use `/// <reference lib="dom" />`, so
browser globals are not available across the plugin. Put sanctioned web-only APIs in
`client/web.ts`, declare only the globals that module uses, gate each export with
`Platform.OS === "web"`, and provide a native implementation or no-op. See the
[public plugin reference](../public-docs/plugins/reference.md#works-on-mobile) for the complete
pattern.

```ts
// index.server.ts
import type { PluginServerContext } from "@neolix/plugin/server";
import { createGreeting } from "./server/greeting";
import { greetRpc } from "./shared/greeting";

export default function contribute(server: PluginServerContext) {
  server.handle(greetRpc, createGreeting);
  return () => {};
}
```

```tsx
// index.client.tsx
import type { PluginClientContext, PluginSidebarItemProps } from "@neolix/plugin/client";
import { SidebarRow } from "@neolix/plugin/client/ui";
import { Greeting } from "./client/greeting";

function GreetingItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="MessageCircle"
      active={currentScreen?.screenId === "main"}
      onPress={() => openScreen({ screenId: "main" })}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: "main", title: "Greeting", Component: Greeting });
  client.addSidebarHeaderItem({ id: "main", title: "Greeting", Component: GreetingItem });
  return () => {};
}
```

The contribution function must return cleanup for resources created by plugin code. Server cleanup
may be async; Neox waits for it when stopping the server plugin. Cleanup errors are logged and do
not interrupt host teardown. Client installation retention and disposal follow the public
[hosts and lifecycle contract](../public-docs/plugins/reference.md#hosts-and-lifecycle).

Neox owns the route, screen header, icon validation, close action, theme DTO, layout facts,
and render error boundary. The contributed component owns the complete body below the header.
The plugin owns the header's text through the screen's `title` (`resolvePluginScreenTitle` in
`plugins/surface-contribution.ts`). A legacy `addSidebarItem` route (`/sidebar/<id>`) shows the
item's title and icon instead, as before screens had titles; the `addSurface` alias titles its
screen with the id. A `/sidebar/<id>` route with no legacy item of that id opens the screen with
that id, so links saved before a plugin migrated keep working.

Screen params ride in the screen route's query string (`plugins/routes.ts`), not in app state, so
reload, history, links, and the host switcher keep them without a store. Expo Router merges the
route's segments (`serverId`, `pluginId`, ...) into the same search params as the query, so param
keys are stored under a `param.` prefix; plugins never see it and may use any key.
`openScreen` validates its input once (`parsePluginOpenScreenInput`); code past it trusts the
params.

RPC and subscription contracts validate inputs, outputs, and events in both the app and plugin
subprocess. `useRpc` returns a typed async function. Use the host-provided `@tanstack/react-query`
for request state and caching; Neox gives each plugin installation its own query client.

A subscription is a session-owned observation (`plugin-rpc` delivery family): the session that
subscribed owns its lifetime, so release, disconnect, plugin stop, and reload need no plugin code.
Each subscriber gets its own handler call in the subprocess; there is no fan-out or replay. The
runtime buffers pushes until the session has sent `plugin.rpc.subscribe.response`, so a client
never sees an event for an unknown subscription. The app installation's lifetime aborts every
subscription its surfaces left open, and a reload replaces the installation, which resubscribes
mounted hooks.

The byte rule (a top-level `Uint8Array` is binary, a nested one is a validation error) is checked
once per hop by `assertPluginWireValue`. Bytes ride plugin binary frames, opcodes `0x20`-`0x2f`
(`packages/protocol/src/binary-frames/plugin.ts`); nothing on the path copies or re-encodes them,
and `plugin-subscriptions.perf.e2e.test.ts` locks that. Keep it that way: never stringify a plugin
payload for a log, and the client's bootstrap buffer holds bytes only until the first observer
attaches. Binary outputs reach only clients that send `pluginBinaryPayloads`. A binary input
frame (`0x22`) becomes a synthetic `plugin.rpc.invoke.request` and runs through the normal message
path, so it is authorized like any other invoke. The author contract, including the native upload
limit, is in [stream events from the daemon](../public-docs/plugins/reference.md#subscriptions).

`useNeolix()` and the handler's `{ neolix }` context expose the same `NeolixApi`: projects,
workspaces, agents, terminals, providers, and daemon config. They do not expose connection lifecycle.

`useNeolix()` is the plugin's one client: `InstalledPlugin.neolix`, created with the installation in
`packages/app/src/plugins/registry.ts` over the host's existing connection and passed to setup as
`client.neolix`. Authors release their subscriptions in their own cleanup, and teardown (disable,
reload, removal, host removal) disposes the client, which ends the rest; nothing is created or
disposed per mounted surface. See the
[public example](../public-docs/plugins/reference.md#use-the-neox-sdk). Switching the screen's host
changes both `useNeolix()` and `useRpc()` to that host's installation. An offline selected host fails there and never falls through to another
installation. A server handler owns an IPC-backed daemon session for the life of its subprocess.
Use plugin RPC for plugin-specific backend behavior that is not a normal Neox operation.

Host-targeted clients and discovery are owned by `packages/app/src/plugins/hosts`, with per-installation
bindings supplied by the bundle loader. Bind the imperative getter to that installation; do not
resolve ownership through a mutable current-plugin global. Keep observation ownership in this module
and transport ownership in the app host runtime. See the [public host API contract](../public-docs/plugins/reference.md#discover-hosts-and-target-another-host).

Each subprocess gets an exclusively owned `plugin:<id>` session. That identity is reserved from
normal clients, never resumes another session, and is cleaned immediately on exit without reconnect
grace. During daemon startup, plugin sessions may connect while application WebSockets remain
paused; the daemon accepts clients only after configured plugins have settled and the initial
catalog is complete.

The app retains client bundles per host in its file cache (IndexedDB on web), keyed by plugin ID
and the daemon's SHA-256. A cold client verifies stored contents before advertising their hashes;
missing or corrupt files request full bundles. Only the latest catalog's bundles remain. Hashing
uses Expo's native async digest on mobile, avoiding a JavaScript hash loop on Hermes; reading and
passing the bundle string still costs memory and time once per client lifetime.
Persistence runs after catalog reconstruction without delaying installation. One write runs at a
time; while storage is busy, only the newest pending catalog is kept. A failed write leaves the
in-memory bundles usable, and a later catalog retries persistence.

When the same plugin contribution exists on multiple hosts, Neox shows it once in the sidebar and
adds a host picker to the screen header. The selected host supplies the bundle, RPC transport, and
query cache. Explicit SDK targets follow the [host API contract](../public-docs/plugins/reference.md#discover-hosts-and-target-another-host).

Workspace panels, Command Center items, and client slash commands are client contributions. The
daemon transports their compiled bundle without interpreting placement or callbacks. Panel props
contain workspace and agent IDs. Required-selector hooks read normalized client state synchronously
and use shallow equality, so a panel does not subscribe to fields it does not render. Command
callbacks materialize their snapshots only when invoked. Contribution discovery and panel opening
never fetch active context through plugin RPC. Snapshot DTOs are deeply readonly and frozen at
runtime so plugin code cannot mutate normalized app state or a memoized selection. Panels use one persisted
`plugin` workspace-tab target, so reload, disable, removal, and restoration resolve through the
current installed-plugin catalog. A missing contribution renders unavailable inside the tab.
Panels declare `locations: ["workspace", "explorer"]` to opt into Explorer hosting; omission means
workspace only. Location controls hosting, not context. An agent panel target keeps its `agentId`
when moved between hosts. Explorer configuration can create workspace-context panels and remove
existing agent-context instances, but it cannot create an agent panel without an agent-aware command.

Command Center callbacks use the selected host's existing `NeolixApi` for normal Neox operations.
They use typed plugin RPC only for plugin-specific backend work. Surface and panel navigation
belongs to the app; plugins do not receive Expo Router or workspace-layout store access.
See the public [navigation fields](../public-docs/plugins/reference.md#screens-and-sidebar-items)
and [external links and workspace browsers](../public-docs/plugins/reference.md#external-links-and-workspace-browsers)
for the author-facing contract.

### Declarative contributions and sandboxed web views

The Synara-based desktop web app cannot run React Native client bundles. It renders the optional
`contributions` and `web` blocks of `neox-plugin.json` instead. The daemon reads them as manifest
metadata and includes them in `plugin.list`; no client code runs. React Native hosts keep using
`index.client.tsx` and ignore these blocks.

```json
{
  "id": "review",
  "contributions": {
    "commands": [
      {
        "id": "open",
        "title": "Open review",
        "icon": "Plugin",
        "context": "global",
        "action": { "kind": "openView", "view": "main" }
      }
    ],
    "slashCommands": [
      {
        "name": "review-greet",
        "description": "Greet through the plugin server",
        "context": "agent",
        "action": { "kind": "pluginRpc", "method": "greet" }
      }
    ],
    "sidebarItems": [{ "id": "main", "title": "Review", "view": "main" }],
    "composerPills": [
      {
        "id": "greet",
        "title": "Greet",
        "context": "agent",
        "action": { "kind": "pluginRpc", "method": "greet" }
      }
    ],
    "attachmentSources": [
      {
        "id": "notes",
        "title": "Notes",
        "search": { "method": "notes.search" }
      }
    ],
    "themes": [
      {
        "id": "ocean",
        "name": "Ocean",
        "appearance": "dark",
        "colors": {
          "background": "#071a24",
          "foreground": "#e6f7ff",
          "raised": "#0b2633",
          "control": "#0f3344",
          "border": "#17475c",
          "mutedForeground": "#8fb4c4",
          "ring": "#38bdf8"
        }
      }
    ],
    "timelineItems": [{ "kind": "greeting", "version": 1, "title": "Greeting" }]
  },
  "web": {
    "views": [
      {
        "id": "main",
        "title": "Review",
        "entry": "web/main.html",
        "permissions": ["rpc", "navigate", "resize"],
        "rpcs": ["greet", "notes.search"]
      }
    ]
  }
}
```

An action is `pluginRpc` (the named server method must be registered with `server.handle`) or
`openView`. Slash-command and attachment-source RPCs receive `{ args }` and `{ query }` merged into
their declared input. An attachment source's search returns
`{ items: [{ id, identifier?, title, subtitle?, text, resourceType?, url? }] }`. Picking one creates
a UTF-8 text file containing the resource and attaches it through the normal composer file upload,
so it reaches the provider the same way a dropped file does. A timeline item is matched by `kind`
and `version`. `sidebarItems`, `openView` actions, and timeline-item `view` must name a declared
view; the manifest fails to load otherwise. Icons are Lucide names the host knows; an unknown name
falls back to the plugin glyph.

The web host also reads five keys that stand in for surfaces the React Native client registers in
code:

| Key               | Fields                                                              | Where it shows                                                              |
| ----------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `workspacePanels` | `id`, `title`, `icon?`, `context?` (`workspace`/`agent`), `view`    | Right dock "add panel" list; params carry `workspaceId` (and `agentId`)     |
| `filePanels`      | `id`, `title`, `icon?`, `files: { extensions, filenames? }`, `view` | Replaces the body of a matching file tab; users pick per `ext:`/`name:` key |
| `providerActions` | `id`, `title`, `icon?`, `action`                                    | Provider row menu in settings                                               |
| `providerPanels`  | `id`, `title`, `icon?`, `view`                                      | Expanded provider row in settings                                           |
| `agentActions`    | `id`, `title`, `icon?`, `action`                                    | Thread row context menu                                                     |

The daemon's manifest schema drops these keys, so the bridge decodes them from
`neox-plugin.json` in the installed plugin directory and merges them into `plugin.list`. Unlike the
keys above, a malformed entry is not a load error: the bridge drops all five keys for that plugin.

The bridge serves a view's entry from `GET /plugin-web/<pluginId>/<entry>`. Every request is read
from the plugin package by the daemon with its extension allowlist, size cap, and traversal checks;
the bridge validates the path again. Asset URLs in the entry are relative to that route, so HTML,
CSS, scripts, images, and fonts can be separate files. HTML responses carry
`default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;
connect-src 'none'`, `frame-ancestors` limited to the host origin, and
`X-Content-Type-Options: nosniff`; inline scripts are not allowed. The frame runs with
`sandbox="allow-scripts"` and no `allow-same-origin`: it has an opaque origin, cannot read host
cookies, storage, or DOM, and receives no host token. The host validates every inbound message by
source window, opaque origin (`null`), and a per-frame session token in the document.
`permissions` gates host APIs, and `rpc` additionally requires the method to appear in `rpcs`;
navigation may only open another declared view of the same plugin.

The bridge injects a script tag for `window.neolix` before the entry's own scripts; authors do not
bundle it. It exposes `getContext`, `onReady`, `onTheme`, `rpc.invoke`, `navigate.openView`, and
`setHeight`. Types live in `packages/desktop-web/packages/plugin-web-sdk`. Requests time out after
15 seconds and errors return to the frame instead of failing silently.
`plugin-examples/web-view` is a complete example.

A plugin without `web` keeps its declarative contributions. Asking a web host to open a custom
surface for it shows "此插件的自定义界面仅在移动端可用" instead. That host never runs the React
Native client bundle.

### Plugin icons

The [public reference](../public-docs/plugins/reference.md#icons) owns the author API: a contribution
`icon` is a Lucide name, `{ svg }`, or a component.

- `findSvgIconProblem` in the SDK root (`packages/plugin/src/icons.ts`) is the only SVG rule set.
  The daemon applies it to provider and usage-source icon files; the app applies it to inline
  icons. Change the rules there, never at a call site.
- The app validates each icon once, at registration, through `parsePluginIcon` in
  `packages/app/src/plugins/icons.ts`. Rendering trusts the stored icon.
- That module is the only code that branches on the icon form. Surfaces draw with
  `PluginIconView`, or take a stable component from `pluginIconComponent` when their slot expects
  one. Lucide and SVG icons receive only size and color, so the host props a button passes to its
  component icon never reach an SVG element.
- Attachment sources take `PluginSerializableIcon`: composer drafts persist the source's icon with
  each attachment, and a component cannot be stored.
- The plugin compiler loads `.svg` imports as text, so `import icon from "./client/icon.svg"` is the
  markup string.

## Lifecycle hooks

Server entries register async handlers with `server.addHook(name, handler)`, returning a cleanup
function. Names follow `subject.operation.position`, ending in `before` or `after`. Waiting is a per-hook
registry property, independent of position. The [hooks reference](../public-docs/plugins/hooks.md)
owns payloads, ordering, failure behavior, and examples. `agent.create.before` edits saved
configuration; `agent.open.before` contributes launch-only `env`, `tools`, and `mcpServers` on
every open. Executable tool definitions stay in the plugin process; only metadata crosses the boundary.

Worktree placement is resolved before Git source planning, so a hook can change the branch and base
without undoing fetched refs. Restores use the recorded destination and bypass creation hooks.
Workspace records decide ownership, including explicit non-ownership after recovery. Without a record,
ownership checks prefer the marker-verified worktree root over the legacy
path shape: a plugin can place a worktree several directories below the default worktrees root.

Emit from the operation owner, not a client subscription. Provider history replay must not trigger
live hooks. Notifications must not be awaited inside agent mutations: a handler can send a prompt
or answer a permission through its own daemon session. Awaiting it there deadlocks that command.

## Contribute a provider

Register a provider from `index.server.ts`. The provider connection is callback-based and owns all
of its sessions; plugin RPC is not part of the provider data path.

```ts
import type { PluginServerContext } from "@neolix/plugin/server";
import type { ProviderRegistration } from "@neolix/plugin/server/provider";
import { createProvider } from "./server/provider";

export default function contribute(server: PluginServerContext) {
  server.registerProvider(createProvider() satisfies ProviderRegistration);
  return () => {};
}
```

Declare `command: ["agent", "serve"]` when your provider launches an executable. The daemon applies
`agents.providers.<id>.command` and `env`, resolves the executable against the effective PATH, and
removes parent-session and daemon-control environment variables. `connect({ launch })` receives
`{ command, args, env }`: an executable path, effective arguments, and the complete sanitized
environment. Spawn with those values; do not merge the plugin process's environment back in.
The launch travels as data through the same provider protocol for built-in and subprocess plugins.
Without a declared command, existing providers keep their connection behavior and receive no launch.

Implement optional `status({ launch })` to check credentials, versions, or other prerequisites using
that effective launch. Return `{ available: true }` or
`{ available: false, diagnostic: "Run agent login" }`. The daemon checks executable availability
before calling status; it exposes your diagnostic through the normal provider diagnostic command.
A command-backed provider without status is available when its executable resolves. Providers with
neither command nor status retain connection-based availability.

A same-ID config entry without `extends` overrides the plugin's `enabled`, `command`, `env`, label,
description, and model configuration through the normal provider registry. `enabled: false` disables
selection and discovery. An entry with `extends` defines the user's own provider, shadows the plugin,
and logs a warning. Overrides validate before plugins load; an override for an absent plugin stays
inactive and logs a warning naming the unmatched ID after built-in and configured plugin startup
settles (including disabled plugins), then on each installed registry generation.
Use IDs matching `/^[a-z][a-z0-9-]*$/` for configurable providers. Dots and underscores
remain valid for plugin registration but cannot be used as config provider IDs.

A configured provider may extend a plugin provider as well as a built-in one, but only when that
plugin provider declares `supportsAccountDerivation: true` on its registration. The derived entry
reuses the base plugin's connection and merges the configured command, env, and models like a
built-in derivation. Config loading accepts the reference because plugins register later; the
registry rejects an unknown base, and names a plugin provider that did not opt in, once plugins
have registered.

Provider config changes rebuild the affected registry entry and invalidate its catalogue; the next
connection receives the new launch without restarting the daemon. Running sessions keep their
current launch until refreshed, as native providers do.

Implement optional `ProviderRegistration.getCatalogCacheKey(options)` to share equivalent catalogue
probes. The callback runs in the plugin process before discovery and receives the actual global or
workspace target plus the resolved `launch` when a command is declared. Return a key covering
effective configuration and execution environment, or
`undefined` for target-specific caching. Ignore `force` when choosing identity. Existing providers
need no change. See [catalogue ownership](providers.md#provider-snapshot-refresh-contract).

`send()` resolves after acceptance. Publish operation completion, prompt disposition, turn state,
configuration, permissions, persistence, and complete timeline snapshots through `onEvent()`.
Route messages, structured commands, steering, and command side effects through `session.prompt`.
Provider settings are toggle/select data that Neox renders in the composer. Keep private options in
the opaque `ProviderSessionConfig.providerOptions` object on `session.open`.
It contains the provider defaults and per-agent overrides merged by the daemon.
Validate and apply it inside the provider; core does not know your option shape.
See [provider options](custom-providers.md#provider-options) for configuration and
merge semantics.

Providers add an optional veto to daemon baseline cleanup through the per-session
[runtime safety query](../public-docs/plugins/providers.md#permit-idle-runtime-cleanup).
The daemon calls the same `AgentSession.canStopRuntime()` interface for built-ins and plugins;
the plugin bridge transports that query through the existing provider request/event protocol.

Agent refresh closes the current provider session and opens it again with current configuration and
persistence. Re-read credentials and provider-owned configuration on `session.open`; consume the
daemon launch from `connect` and the per-session env and MCP servers from `session.open`. There is
no provider reload input.

For an ACP command, register `runAcpProvider({ id, label, command })` from
`@neolix/plugin/server/acp`. Its transformer hooks cover narrow vendor differences; do not translate the
whole provider event stream. The shim uses the resolved launch for every probe and session, overlaying
only the supplied per-session env for sessions. The direct and ACP examples live in
`plugin-examples/provider-direct`
and `plugin-examples/provider-acp-transformer`.

Provider-emitted plugin timeline items use the same renderer registration as transformed and
daemon-appended plugin items. The direct example includes both sides. The renderer-only
`plugin-examples/inline-thinking` example shows that timeline presentation remains independent of a
provider implementation. The public [provider plugin guide](../public-docs/plugins/providers.md)
owns author workflow, lifecycle, testing, and distribution guidance.

`ProviderRegistration.icon` is a file path relative to the plugin directory, such as `icon.svg`.
It must resolve inside that directory to a regular file that passes the shared SVG icon rules
(see [Plugin icons](#plugin-icons)). Neox reads and validates the file when the plugin starts; the
string is never inline SVG or a URL.

## Search APIs

Register a web search API from `index.server.ts` with `server.registerSearchApi()`, importing
`SearchApiRegistration` from `@neolix/plugin/server/search`. `execute({ query, key, url })`
returns `{ title, url, text, age? }` pages; `keyOptional` and `needURL` let the gateway treat the
API as ready without a key or require the user's address, and `keysURL` is where they get a key.
The gateway lists it beside the built-in vendors under `plugin:<pluginId>:<searchId>` in
`search.apis`, with the same key, url, pick and off rules. Plugins are trusted code, so a search
API runs in the plugin process with the daemon's network.

## Usage sources

Register a usage source from `index.server.ts` with `server.registerUsageSource()`. Import `UsageSourceRegistration` and normalization helpers from `@neolix/plugin/server/usage`. The plugin owns account discovery, harness labels, and credential-store reads; the daemon owns account grouping and the fetch cache. Agent popovers use only the agent's own login. The host-wide Usage modal falls back across an account's logins; any success shows usage only, and all failures show every login's labeled error and remedy. Follow the [usage source discovery contract](../public-docs/plugins/reference.md#usage-sources). The resolved launch environment crosses into the trusted, unsandboxed plugin subprocess for session discovery. Usage queries never run lifecycle hooks. Inputs are validated in the plugin process and remain daemon-side. `icon` uses the same SVG file rules as provider icons.

When the host’s **Check usage** switch is off, the daemon rejects usage requests before discovery, without reading logins or calling vendors. Otherwise, the daemon calls discovery for `usage.list_reports`; the client gates this RPC on `server_info.features.usageSources`. The old `provider.usage.list` RPC maps discovered reports for older clients.

## Contribute sidebar items

Sidebar header and footer items are plugin components, not descriptors. The
[public reference](../public-docs/plugins/reference.md#sidebar-items) owns the author API. The host
lives in `packages/app/src/plugins/sidebar-items/`; `packages/app/src/sidebar-nav/model.ts` resolves
one section's order from built-ins, plugin groups, and the section's preference
(`sidebarNavItems` or `sidebarFooterItems`).

- The item's `Component` renders directly in the section, with no wrapper, so a fragment or array
  of rows lays out like separate items while Settings keeps one entry for the block. Footer items
  are rows between Add project and the footer's icon row. The icon row (Hosts,
  Help and support, Settings) is fixed app code, not a contribution slot, so the kit has no icon
  button.
- `openPopover` opens through the same `PluginPopoverSurface` as header buttons
  (`plugins/popover.tsx`). Any press inside a `SidebarRow`, including its `trailing` content, moves
  the menu anchor to that row: a capture-phase `onStartShouldSetResponderCapture` runs before the
  pressed child claims the touch on native and web, and returns false. Keyboard activation skips
  the responder system, so the row's own press anchors too. Until a press, the first mounted row
  holds the anchor. An item that renders no kit component
  anchors to its section container.
- `SidebarSeparator` reuses the app's separator and cancels the footer's horizontal padding, so
  the line runs edge to edge in both sections.
- `SidebarRow.trailing` sits in a second `Pressable` beside the row's button, since web cannot nest
  buttons. Its `onPress` is the row's, so a press on non-interactive trailing content presses the
  row; a button inside it wins its own press because only the innermost pressable responds.
- A new-API item renders from the current route's host, else the host remembered under
  `pluginScreensHostKey(pluginId)`, which the screen's host switcher and the item's `openScreen`
  set. One key per plugin: switching host on any of its screens moves all its items.
- `addSurface`, `openSurface`, and `addSidebarItem` are undocumented aliases, tagged
  `COMPAT(pluginSidebarAliases)`. `addSidebarItem` is recorded only in `legacySidebarItems` and
  groups as a `legacy` sidebar group, which the app draws as its own row: its registered icon, in
  the sidebar and in Settings > Sidebar, opening `/plugin/<id>/sidebar/<item>` on the host it
  remembers under its own key. It shares header ids and the `plugin:<pluginId>:<id>` settings key
  with new-API items.

## Contribute file panels

Client `addFilePanel` registrations become the body of a file tab. The tab stats the file, picks a
panel, and mounts it with a `PluginFile` handle; the panel reads, shows its own `Loading`, writes,
and resolves conflicts. The host has no bar and no notion of a panel's views: the Markdown and HTML
panels own their Preview and Source views, toolbar and editor buffer, and the tab only shows the
dot a panel sets through `tab.setModified`. Source is the floor for text files no other built-in
claims, never a candidate beside one. Built-in panels (Markdown, HTML, Image, and Source, Neox's
editor) take exactly `PluginFilePanelProps`, including params and persisted tab state, so a fix to reading, watching, or writing lands in one place:
`packages/app/src/file-panels/file/`. Do not add a host-side read or loading gate for one panel;
make that panel faster instead. Source highlights a large file on native in idle-time slices,
the lines around the opening line first.

The handle checks every write against the version it last read or wrote, so two panels or a panel
and an agent cannot silently overwrite each other. The daemon reports the file's kind (text,
image, binary) with its stat from a bounded sniff, which is how Source claims text files without a
read. See the [public file panel reference](../public-docs/plugins/reference.md#file-panels) for
the author API, selection, `DocumentFrame`, and the version requirement. The examples live in
`plugin-examples/pdf-panel` and `plugin-examples/markdown-panel`.

## Contribute buttons

Header buttons and composer pills share the client-only descriptor and registration lifecycle in
`packages/app/src/plugins/buttons/`. The [public button reference](../public-docs/plugins/reference.md#header-buttons)
owns the author API and placement rules. Keep presentation policy in this module so another
placement can reuse behavior without copying registration or action state. The header overflow
and the compact workspace menu share one builder that turns buttons into menu rows and pages; the
workspace menu reaches it through `usePluginWorkspaceMenu`.

Native sheets teleport their children. Button surfaces rebuild the installation's SDK, state,
query, and toast providers inside the surface content. A host menu can hold buttons from several
installations, so each of its rows and pages resolves its own installation's runtime. Providers
only around the trigger do not reach those bodies.

Request observation with `client.neolix.agents.list({ subscribe: {} })` and consume the returned
`subscription` handle. Plain `list()` and agent/workspace directory `.subscribe(handler)` listeners create no daemon
demand. Provider and project `subscribe()` calls establish their own demand. On capable daemons, each
list-and-subscribe call has its own server ID, even for the same query. Older daemons retain
[shared delivery behavior](protocol-compatibility.md#owned-observations). Handle snapshots
also run after reconnect; replace your view before applying its subsequent updates. An installation
stays loaded during a dropped connection while the app retains its `DaemonClient` object. An
unchanged installation does not rerun setup on reconnect, so refresh state from those snapshots
rather than from setup. Switching connections replaces the client object and reinstalls plugins. The installation
owns every observation created through its API and releases them on unload, including setup failure.
Mounted surfaces and command invocations have shorter API lifetimes.

Keep the client entry synchronous: return its cleanup function immediately and start asynchronous
work inside it. See the maintained [composer pill example](../plugin-examples/local-plugin/client/main.tsx).

## Contribute timeline items

Timeline transformers and renderers are client contributions. The daemon's canonical rows and
built-in projection stay unchanged. The app transforms each source item while building the render
model, for both fetched history and live events, before native Markdown splitting and Overview
tool grouping. Assistant callbacks receive the accumulated source text, never display fragments.
Live assistant messages use `phase: "streaming"`; committing to history makes them `"complete"`.
Neox memoizes by source-item reference and phase and derives replacement IDs from source identity, so
streaming updates preserve mounted component identity.

`query.itemType` selects one public `AgentTimelineItem.type`. The callback owns any detailed
recognition and returns plain plugin item objects. `undefined` keeps the source item, `items`
replaces it, and an empty array removes it. Output `data` must be JSON-compatible. Neox adds the
runtime plugin ID, preserves the source timeline cursor and identity, validates renderer data with
its Zod schema, and mounts the component inside the normal plugin runtime and error boundary. An
optional output `id` distinguishes several stable replacements from the same source item; its output
index is the default.

Transformers run synchronously and must be deterministic. When several transformers match, the
first one that returns a result owns that source item. Plugin and registration ordering is stable.
See `plugin-examples/timeline-items` for the complete contract.

A plugin subprocess can also append a canonical plugin row from a server handler:

```ts
await neolix.agents.ref(agentId).timeline.append({
  type: "plugin",
  id: "review",
  kind: "review-result",
  version: 1,
  data: { status: "ready" },
});
```

The daemon stamps the runtime `pluginId`; plugin code never supplies it. Reusing the same `id`
replaces the previous row from that plugin on live clients and fresh timeline fetches. Rows live in
the daemon's in-memory timeline and survive scroll, refetch, and reconnect, but not a daemon
restart. A row without an installed renderer shows an unavailable placeholder. Serialized `data`
must be at most 64 KiB; the daemon rejects a larger append instead of storing a payload that cannot
be rendered intact. The daemon advertises this RPC through
`server_info.features.pluginTimelineItems`.

## Contribute client slash commands

`addSlashCommand` registers an agent- or workspace-context command in the composer. The
callback runs in the app, receives the trimmed text after the command name as `args`, and receives
the same `neolix`, `rpc`, `openScreen`, workspace, agent, and `openPanel` capabilities as the matching
Command Center callback.

```ts
client.addSlashCommand({
  name: "review",
  description: "Run the review bot",
  argumentHint: "[scope]",
  context: "agent",
  async onSubmit({ args, agent, rpc }) {
    await rpc(startReview, { agentId: agent.id, scope: args });
  },
});
```

Neox owns the autocomplete row, input clearing, and error toast. It never sends the command text to
the agent. Built-in client commands win name and alias collisions, plugin commands win
provider-command collisions, and the first plugin in stable catalog order wins collisions between
plugins. Plugin slash commands do not run when the composer has attachments.

## Contribute composer attachments

Register a declarative attachment source backed by a plugin RPC. Neox owns the attachment menu,
search picker, drafts, selected pill, and submission. The plugin returns complete text snapshots;
credentials and vendor API calls stay in the daemon handler.

```ts
// index.server.ts
import type { PluginServerContext } from "@neolix/plugin/server";
import { search } from "./server/issues";
import { searchIssues } from "./shared/issues";

export default function contribute(server: PluginServerContext) {
  server.handle(searchIssues, search);
  return () => {};
}
```

```tsx
// index.client.tsx
import type { PluginClientContext } from "@neolix/plugin/client";
import { issues } from "./shared/issues";

export default function contribute(client: PluginClientContext) {
  client.addAttachmentSource(issues);
  return () => {};
}
```

Attachment sources stay scoped to the composer's host. Unlike sidebar contributions, equal sources
on several hosts are not coalesced. The selected snapshot submits as a text attachment with neutral
external-resource presentation, so it remains readable if the plugin is removed or an older peer
drops the optional presentation fields.

## Contribute settings

Register ordinary components with `client.addSettingsScreen` and open them with `openSettings`.
The host settings shell owns navigation and layout; plugin content must not add another page
scroll view or header. See the [author contract](../public-docs/plugins/reference.md#settings-screens)
and `plugin-examples/settings` for the named UI components and persistence API.

Settings storage is scoped to the runtime installation ID, never the source path or manifest ID.
Its writer lives with the plugin subprocess, while its directory lives outside managed sources,
so updates and reloads retain values. Settings-change notifications must not enter the catalog
reload path: that path disposes the plugin and would destroy open drafts after every save.

`server.registerSettings(definition)` returns a server-side handle. Use `read()` for the current
`ready` or `invalid` state and `subscribe()` for successful saves, resets, and migrations. The
subscription cleanup belongs in the plugin's contribution cleanup when it outlives the entry.

Each registration also appears in `plugin.list` as an optional `settings` entry carrying `id`,
`title` (falling back to the ID), and the definition's schema as draft-07 JSON Schema. A host that
cannot run the React Native client bundle renders a form from that schema and saves through the
same `settings.<id>.read/write/reset` RPCs, so both hosts share one copy of the values. A schema the
converter cannot represent omits `schema`; the client screen and the declarative `settingsScreens`
forms remain the fallback and stay supported beside it.

## Contribute a theme

`addTheme` takes a small light or dark palette and a display name. Neox expands it through the
same semantic builders as the built-in themes, so plugins do not depend on the complete app token
contract. Unistyles needs every theme name at `StyleSheet.configure` time, so
`packages/app/src/styles/theme.ts` reserves one light and one dark plugin slot. The appearance
provider rewrites the matching slot when the selection changes. See [unistyles.md](unistyles.md)
for the runtime-patching rules the appearance settings share.

`addTheme` is a client registration and belongs in `index.client.tsx`. A client that predates it
cannot evaluate that entry. Daemons advertise
`features.pluginThemes` in `server_info`; the plugin theme catalog is the one place the app reads it, and
a host without it contributes no themes.

The selection persists as `theme: "plugin"` plus a `pluginThemeId` of `<pluginId>/theme/<themeId>`,
so equal themes on several hosts coalesce the way sidebar contributions do. Two hosts can answer
that id with different palettes, so picking a theme records its host through
`rememberPluginContributionHost` and resolution prefers it; a peer connecting or dropping then does
not repaint the app. Without a preference the sorted registry snapshot decides, so the result is
stable rather than arrival-ordered. The app resolves that id
against the installed catalog on every change; an id nothing contributes falls back to the default
preference instead of painting the reserved slot's placeholder colors.

Existing plugin authors should follow the standalone [v0.8 runtime-entry migration guide](../public-docs/plugins/migration.md).

See `plugin-examples/local-plugin` for a native surface, `plugin-examples/linear` for a complete
attachment-source example, `plugin-examples/timeline-items` for timeline projection, and
`plugin-examples/catppuccin` for a theme.

## myna provider plugins

`neox plugin install` can read a myna package's `package.json.magpie` for its `tool` hook. It also
converts `magpie.page`, `magpie.panels` and `magpie.actions`: each HTML file is inlined with its
local stylesheets, scripts and media, keeps myna's `window.myna` bridge (`hello`, `options.get`/
`set`, `read`, `onAction`), and renders through `HtmlFrame`. `replaces` maps to Neox's replaceable
pages; a `settings` or `usage` panel becomes a settings screen, an `agents` panel a sidebar row, a
`provider` panel is drawn inside the provider editor, and an action a provider or agent row menu
item. The reads a page may ask for are
still `providers:list` and `usage:summary`, from `magpie.permissions`. A page's `service` is not
run — the bridge reports no service address — and ES module scripts with imports are rejected
rather than inlined broken. A page that `fetch`es files beside it has no base URL in the frame;
inline the data or read it through the plugin's RPCs. The community
`@magpie-community/opencode-*-auth` packages are OpenCode plugins, not manifests Neox can
install: wrap their 1.x export with `openCodeSubscriptionProvider` in a Neox plugin (below).
Installing one directly fails the manifest check rather than installing a package that would do
nothing.

A plugin keeps its own sign-ins through `server.accounts` (`$NEOLIX_HOME/plugin-settings/<id>/accounts.json`,
0600, atomic, serialized writes, refuses to overwrite a corrupt file). It declares a subscription
provider with `server.registerSubscriptionProvider` (sign-in methods, `loader`, `models`, `usage`,
`check-in`, `refresh`); the gateway asks its loader before each attempt (see
[llm-gateway.md](llm-gateway.md#plugin-backed-providers)). A sign-in run through the plugin process
is stored under the account id before it is reported. `neox accounts subscriptions` lists the
providers running plugins declare; `--models <plugin>/<provider> --account <id>` reads an account's
models and `--sign-in <plugin>/<provider> --method <n> --account <id> --input key=value` runs a
sign-in, following a device flow's instructions until it is authorized.

`openCodeSubscriptionProvider` (`@neolix/plugin/server/opencode`) adapts a myna community auth
plugin's export to these hooks: its methods, loader, model list, usage and check-in are registered
as they are, and its `client.auth.set` writes the plugin's own account store. A loader that returns
its own `fetch` is called in the plugin process, so vendor signing stays there. The providers page's
subscription sheet lists these providers and runs a method in place; a device flow's page opens from
the card and is followed until the account is signed in.

A plugin wraps a community package itself: import `openCodeSubscriptionProvider` from
`@neolix/plugin/server/opencode`, pass `server.accounts` and the package's 1.x plugin export, and
register the result. The compiler bundles the package's `main`/`1.x` entry (`opencode.mjs`) when the
import names that file; the package's `exports["."]` is the OpenCode 2.x face and is not the one a
myna host loads. A verified setup with `@magpie-community/opencode-zen-free-auth`: sign in with the
`public` key through `neox accounts subscriptions --sign-in <plugin>/opencode-zen-free`, the account
is written as `{type:"api",key:"public"}` (0600), `--models` lists the 10 discovered free models, and
a gateway provider whose `plugin` names it reaches Zen (the vendor answered 429 once free usage was
spent). All 14 community packages (18 provider ids) load through the adapter; per-vendor behaviour
beyond sign-in/models/usage still depends on the package's own hooks.

## Gateway middleware

`server.registerGatewayMiddleware({ id, onRequest, onProvider, onAccount, onResponse, onEvent })` is
the hook beside myna's `magpie.middleware`. It runs in the plugin process for every gateway upstream
attempt while the plugin runs, not only for the plugin's own provider. Hooks run in registration
order.

`onRequest` sees `providerId`, `protocol`, `model`, `accountId` and the body after protocol
translation, and may return a replacement body. Headers are not exposed (myna's hook gets none
either), so credentials never enter the plugin process. The address and streaming mode are chosen
before hooks run, so a hook that flips `stream` does not move the request to the endpoint the other
mode uses.

`onProvider` runs once per try, with the provider, account (null for a key), model and body; it may
return a replacement body. `onAccount` runs before a try's account is asked, with
`{ providerId, protocol, accountId, model }`, and `{ skip: true }` passes that account over for the
request. `onEvent` sees each streamed event as `{ providerId, model, accountId, event }` and returns
`{ event }` or `{ event: null }` to drop it.

`onResponse` sees a non-streaming answer (status, headers, text) and may replace any of them.
Reply headers it sets reach the client unless the gateway never passes them on (`Set-Cookie`,
`Content-*`, `x-neolix-*` and the rest of `REPLY_HEADERS_NEVER`). Streaming answers pass through
untouched. Every hook but `onEvent` gets 250ms; one event gets 50ms. A hook that throws, times out,
or is not loaded leaves the traffic exactly as it was.

`server.registerGatewayUsageObserver({ id, onUsage })` is the hook beside myna's `onUsage`: one call
per finished gateway request, with the ledger row (`time`, `requested`, `provider`, `account`,
`model`, `protocol`, `status`, tokens, `costUsd`, and the rest of the record). Rows are handed over
asynchronously; a plugin that takes longer than 250ms has that row dropped rather than delaying the
gateway.

`server.registerRoutingStrategy({ id, order })` is the routing point beside myna's `strategies`.
The strategy is named `<pluginId>/<id>` in a group's `strategy` — ordering provider/model
candidates — or in a provider's `routing`, where it orders that provider's accounts and keys
(myna's seats). It gets `{ pool, seats, options }`: `pool` is the requested model or
`group/<id>` for a group and the provider id for an account pool; each seat is
`{ key, provider, model, index, priority, weight, resting }` in the planned order. It returns the
seat keys or indexes in the order to try them. Anything other than a permutation, a throw, or a
timeout keeps the listed order (myna fails open the same way). The hook gets 250ms; myna's own
limit is 20ms in-process, and a plugin call is a round trip to the plugin process.

`server.registerAgentIntegration({ id, label, config, format, model, connect })` is the point
beside myna's `magpie.agent`. `config` is the file Neox edits (`~` allowed), `format` is `json`,
`yaml` or `env` (read from the extension when omitted), and `model` is the key path the model goes
at. `connect({ gateway, model, models })` returns the settings to write, where `gateway.v1` is the
gateway's OpenAI-compatible base. The file's own values are kept, the integration's win, the
previous file is kept as `<config>.neox.bak`, and the file is written 0600. `neox gateway agents`
lists what running plugins offer; `--wire <plugin>/<id> --model <model> --gateway-url <url>
[--gateway-key <key>]` writes one.
