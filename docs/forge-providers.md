# Adding a Git Forge to Neox

Neox's forge layer is a registry/manifest system. A forge is a runtime concern:
shared protocol messages carry neutral/open facts, the server adapter owns
behavior, and the app owns bundled presentation/runtime interpretation.

The maintainer litmus test is the rule of thumb:

> Adding a new forge means adding files in a new directory/module that implement
> an interface, plus one entry in the centralized registry/manifest for that
> package.

## The Three Registrations

For forge `acme`, the expected end state is:

1. **Protocol manifest** - optional, only when the forge should be presented by
   shared manifest data. Add one `ForgeDefinition` to
   `packages/protocol/src/forge-manifest.ts`.

2. **Server adapter** - add `packages/server/src/services/acme-service.ts`
   implementing `ForgeService`, any adapter-owned fact types/guards/constants
   beside it, and one `defaultForgeRegistry` entry in
   `packages/server/src/services/forge-registry.ts`.

The web client renders a forge from the server's `ForgeService` plus the shared
`FORGE_DEFINITIONS` manifest. There should be no protocol typed-union arm and no central
server union of known forge facts.

## Protocol

`forgeSpecific` on PR status is an open envelope:

```ts
z.object({ forge: z.string() }).passthrough();
```

The `forgeSpecific.forge` field is a **facts-family tag**, not the workspace
brand id. Gitea, Forgejo, and Codeberg can all emit `forgeSpecific.forge ===
"gitea"` when they share the same facts shape, while top-level `status.forge`
keeps the brand id (`"gitea"`, `"forgejo"`, `"codeberg"`).

Protocol does not validate per-forge fact fields. Consumers that understand a
facts family validate at runtime with their own schema/guard. Unknown or
schema-mismatched facts render neutrally instead of failing the whole message
parse. This is the version-skew win: an old client can receive facts from a
newer forge and still show the PR/MR in a neutral state.

Check results keep a stable normalized `status` for aggregation and an optional
open `traits: string[]` for composable forge-neutral refinements such as
`manual`, `action_required`, and `warning`. Consumers ignore unknown traits and
fall back to `status`; `rawStatus` preserves provider-native detail. Do not add
provider vocabulary to the normalized status union. Producers and the
presentation layer share the trait constants in
`packages/protocol/src/check-traits.ts` — use those instead of string literals
so classification and emission cannot drift apart.

Shipped GitHub compatibility stays separate:

- The forge compatibility layer first shipped in `v0.2.0-beta.1`. Its initial
  six-month cleanup target is `2027-01-17`, after supported client and daemon
  floors reach stable `v0.2.0`.
- `status.github` remains accepted for released peers.
- The server keeps the `COMPAT(forgeSpecific)` mirror that copies GitHub facts
  into `status.github` for older clients.
- Do not add a compatibility shim unless a released peer (<= 0.1.102) can
  actually produce the state.

## Server

The server-wide status type only promises:

```ts
type ForgeSpecificStatusFacts = { forge: string } & Record<string, unknown>;
```

Adapter-owned files define the typed shapes and guards, for example
`github-facts.ts`, `gitlab-facts.ts`, and `gitea-facts.ts`. The adapter can keep
strong internal types for construction and command guards, but shared server
code must not grow a central list of forge fact arms.

Register the adapter in `defaultForgeRegistry` with:

- `createService`
- `matchesHost` from manifest `cloudHosts`
- `probeHost` when self-hosted/Enterprise detection is supported

Current change-request lookup matches the branch and repository for both open and
terminal requests. Prefer an open request, then a terminal request at the local
HEAD, then the most recently updated terminal request. A reused branch can show
its previous request until a new one opens. Auto-archive separately requires an
observed open-to-merged transition and a fresh exact match between checkout HEAD
and the PR head, along with the existing workspace safety checks.

Keep checkout HEAD in adapter cache and poll identities so checkout changes
refresh the facts used by archive eligibility.

Cloud hosts in the manifest are a bounded public-host list, not a self-host
allowlist. Self-hosted detection is a trust gate: Neox only talks to a forge
host that is either a known cloud host or one the CLI is already authenticated
to. Adapter probes must not make anonymous HTTP requests to remote-derived
hosts, and adapters must not route credentials to an unauthenticated host.

## Client rendering

The web client renders a forge from the server's `ForgeService` and the shared
`FORGE_DEFINITIONS` manifest: URL builders, merge capability, icon kind, brand color, and
pane contributions are derived from those server-owned facts. Do not add a parallel client
registry that redefines them.

## Checklist

To add `acme`:

1. Add `acme` to `FORGE_DEFINITIONS` if the shared manifest should know its
   label, nouns, icon kind, sign-in CLI, or cloud hosts.
2. Add `acme-service.ts` implementing `ForgeService`.
3. Add `acme-facts.ts` beside the adapter if it reports native facts.
4. Add one `defaultForgeRegistry` entry.
5. If the forge's CI/data model does not fit an existing required
   `ForgeService` field, widen the shared interface (plus the protocol schema
   and its guards) instead of faking a value — e.g. Gitea Actions runs carry no
   check-run id, so `GetCheckDetailsOptions.checkRunId` became optional with
   `workflowRunId` as the alternative address. Expect this step to touch
   `forge-service.ts`, `messages.ts`, and the call-site guards of the other
   adapters. Widening a shared field is not forge-local: it also affects the
   already-shipped forges/GitHub call sites and the capability-gated RPC (e.g.
   `forgeCheckDetails`), so verify every consumer rather than assuming the change
   only reaches the new adapter.
6. Run targeted tests: manifest/registry/resolver, the adapter test, the
   protocol PR schema, and any merge-capability or PR-pane data tests touched.

Run `npm run typecheck` after each implementation slice. If protocol or client
declarations are stale, run `npm run build:client`; if server/CLI declarations
are stale, run `npm run build:server`.

## Gotchas

- GitHub is a normal registry entry plus released compatibility shims. Keep all
  real shims tagged with `COMPAT(name)`.
- Gitea-family facts use `forgeSpecific.forge === "gitea"` even when the
  top-level brand is Forgejo or Codeberg.
- Gitea's legacy Actions task endpoint cannot filter by commit, may enforce a
  page size below the requested limit, and omits rerun-attempt numbers. Walk a
  bounded number of pages using `total_count` and filter locally. Preserve
  ambiguous same-run tasks: display names are not stable job identities, so
  name-based deduplication can hide a real failure.
- A blocked Gitea Actions task is not necessarily manual: only add the
  `action_required` trait when the matching run metadata reports
  `need_approval`.
- Brand icons are bundled React components, so they cannot come from protocol
  manifest data.
- Source URL grammars are app-side because blob/tree path syntax is
  forge-specific. If a forge has no grammar, omit the "Open on ..." source link
  rather than constructing a wrong URL.
- Pasted issue/change-request URL recognition is also app-side and registry
  driven. Put the forge's route infixes in `urlGrammar.referencePaths`; the
  neutral extractor matches the pasted host and full repository path against
  the current remote before it invokes cwd-routed forge search. Do not add a
  central forge switch or guess a self-hosted Gitea-family brand from URL shape.
- Shorthand references in rendered Markdown (`#12`, GitLab and Gitea `!12`,
  cross-repository `owner/repo#12`) come from the `sigil` on each
  `referencePaths` entry. Leave `sigil` off a kind the forge does not link in
  prose: GitHub has no `!`, and its `#` targets `/issues/`, which GitHub
  redirects to the pull request. The client builds the recognition pattern from the
  workspace descriptor's forge and remote.
- GitLab pipeline status constants belong to the GitLab adapter/client module,
  not protocol.
- GitLab `manual` jobs need `allow_failure` to distinguish optional gray jobs
  (`manual`) from blocking jobs (`manual` plus `action_required`). A failed
  allowed-failure job carries the `warning` trait, and `canceling` remains active
  until GitLab reports a terminal status.
- GitHub PR polling owns one account-wide GraphQL budget. Coordinate retained
  targets per host, batch their reads, and stop until GitHub's reset time when
  the reserve is exhausted. Never add a per-target GitHub request to the poll
  path. Resolve fork PRs through their parent repository without abandoning the
  shared batch.
