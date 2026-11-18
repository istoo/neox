# CLAUDE.md

Neox is a desktop app for monitoring and controlling your local AI coding agents. It connects directly to your actual development environment — your code stays on your machine.

**Supported agents:** Claude Code, Codex, GitHub Copilot, OpenCode, Pi, Antigravity, and Muse Code.

## Repository map

This is an npm workspace monorepo:

- `packages/server` — Daemon: agent lifecycle, WebSocket API, MCP server
- `packages/desktop-web` — The web client the daemon serves and the desktop shell loads (separate Bun workspace)
- `packages/cli` — Docker-style CLI (`neox run/ls/logs/wait`)
- `packages/relay` — E2E encrypted relay for remote access
- `packages/desktop` — Electron desktop wrapper; loads the daemon URL

## Docs

`docs/` is the source of truth for system-level and process-level knowledge. **"The docs", "check the docs", or "check the X docs" always mean this directory — not the web.** Look here before fetching anything online; the docs capture gotchas and conventions you cannot derive from the code or external sources.

At the start of non-trivial work, list `docs/` and skim anything relevant to the task.

| Doc                                                                | What's in it                                                                                                                  |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| [docs/product.md](docs/product.md)                                 | What Neox is, who it's for, where it's going                                                                                  |
| [docs/architecture.md](docs/architecture.md)                       | System design, package layering, WebSocket protocol, agent lifecycle, data flow                                               |
| [docs/agent-lifecycle.md](docs/agent-lifecycle.md)                 | Agent states, parent/child relationships, archive semantics, tabs vs archive, subagents track                                 |
| [docs/data-model.md](docs/data-model.md)                           | File-based JSON persistence, Zod schemas, atomic writes, no migrations                                                        |
| [docs/glossary.md](docs/glossary.md)                               | Authoritative terminology — UI label wins, no synonyms                                                                        |
| [docs/coding-standards.md](docs/coding-standards.md)               | Type hygiene, error handling, state design, React patterns, file organization                                                 |
| [docs/providers.md](docs/providers.md)                             | Adding a new agent provider end-to-end                                                                                        |
| [docs/forge-providers.md](docs/forge-providers.md)                 | Adding a git forge: registry/manifest, drop-in checklist, self-host/GHES, the two facts tiers                                 |
| [docs/custom-providers.md](docs/custom-providers.md)               | Custom provider config: Z.AI, Alibaba/Qwen, ACP agents, profiles, custom binaries                                             |
| [docs/llm-gateway.md](docs/llm-gateway.md)                         | Model gateway: daemon `/v1` endpoints, `gateway.json` providers and groups, failover                                          |
| [docs/plugins.md](docs/plugins.md)                                 | Local plugin manifest, directory source config, RPCs, native surfaces, and attachment sources                                 |
| [docs/service-proxy.md](docs/service-proxy.md)                     | Service proxy: exposing workspace scripts at public URLs, DNS setup, reverse proxy config                                     |
| [docs/relay-endpoint-security.md](docs/relay-endpoint-security.md) | Relay E2EE modes: Noise NK mapping, record framing, negotiation, the `requireProtectedSecurity` flag, close codes             |
| [docs/development.md](docs/development.md)                         | Dev server, build sync gotchas, CLI reference, agent state, Playwright MCP                                                    |
| [docs/rpc-namespacing.md](docs/rpc-namespacing.md)                 | WebSocket RPC naming convention — dotted namespaces and `.request`/`.response` pairs                                          |
| [docs/protocol-compatibility.md](docs/protocol-compatibility.md)   | Why app/daemon versions drift, protocol vs feature contract, capability gating, COMPAT tagging                                |
| [docs/protocol-validation.md](docs/protocol-validation.md)         | zod-aot generated inbound WebSocket validation, patched compiler regressions, schema-purity rules                             |
| [docs/connected-hosts.md](docs/connected-hosts.md)                 | Daemon-owned host registrations, routed SDK scopes, identity and authority boundaries                                         |
| [docs/permissions.md](docs/permissions.md)                         | Semantic daemon permissions, principals, credentials, pairing invitations, and Hub authority                                  |
| [docs/terminal-performance.md](docs/terminal-performance.md)       | Terminal latency pipeline, coalescing/backpressure invariants, benchmark + perf spec usage                                    |
| [docs/file-observation.md](docs/file-observation.md)               | Recursive watcher ownership, Linux constraints, teardown invariants, and Parcel comparison                                    |
| [docs/testing.md](docs/testing.md)                                 | TDD workflow, determinism, real dependencies over mocks, test organization                                                    |
| [docs/qa.md](docs/qa.md)                                           | QA evidence bar for pull requests — platform matrix, version drift, performance, UI proof                                     |
| [docs/ad-hoc-daemon-testing.md](docs/ad-hoc-daemon-testing.md)     | Isolated in-process daemon test harness                                                                                       |
| [docs/browser-capture-harness.md](docs/browser-capture-harness.md) | Real-Electron browser screenshot harness and compositor-surface gotcha                                                        |
| [docs/docker.md](docs/docker.md)                                   | Running the daemon in Docker, volumes, agent images, security                                                                 |
| [docs/release.md](docs/release.md)                                 | Neox publish flow (squashed public history, no npm), release playbook, completion checklist                                   |
| [docs/terminal-worker.md](docs/terminal-worker.md)                 | Terminal worker process model, socket/record/secret, protocol-bump rule and draining, the worker's file copy, Windows desktop |
| [docs/terminal-activity.md](docs/terminal-activity.md)             | Terminal activity indicators — source-agnostic tracker, agent hook reporting, adding a new hook provider                      |
| [SECURITY.md](SECURITY.md)                                         | Relay threat model, E2E encryption, DNS rebinding, agent auth                                                                 |

### Writing docs

- **Integrate, don't append.** Find the doc that owns the subject and rewrite the part that is now wrong. The standard failure is finishing a task and adding a paragraph to the bottom of the closest-looking doc; ten tasks later the doc is a pile of paragraphs in discovery order. `docs/custom-providers.md` is what that looks like.
- **Don't document logic.** Prose that restates code drifts from the code and loses. Write down what the code can't tell you: why something is shaped the way it is, the gotcha that cost an afternoon, conventions nothing enforces, constraints that span packages or versions. If a reader could get it in two minutes by opening the file, cut it.
- **One fact, one doc.** Every other mention is a link. If you are about to write the same paragraph in two docs, one of them is a link.
- **Respect the layers.** `CONTRIBUTING.md` and this file name things and link out. Activity docs like `docs/qa.md` and `docs/testing.md` set the bar for a kind of work. Subject docs like `docs/plugins.md` own one thing completely. A layer never re-explains the one below it.
- **One subject per doc.** If the subject doesn't fit in a sentence, split the doc. A section per provider, vendor, or platform is a table plus one worked example.
- **Delete.** Obsolete sections go. Prefer a `packages/desktop-web/apps/web/src/thing.ts:120` reference over a pasted block.
- **New doc?** Add a row to the table above and link it from the docs that should send readers there.
- Code-level facts belong in comments next to the code, not here.

### Doc voice

Plain and short. Second person. State the rule, then the reason when the reason isn't obvious. Match the doc you're editing.

Do not:

- Write a sentence to land a point. "It's not X, it's Y", "That's not a Z, that's a W", and every other setup-and-punchline shape.
- Add a clause that only asserts importance: "and that matters", "which is what keeps it working", "this is critical".
- Use "honest", "robust", "seamless", "powerful", "simply", "just", "delightful".
- Restate something you already said, in different words, for emphasis.
- Hedge with "generally", "typically", or "you may want to" when the answer is "do this".
- Clear your throat: "It's worth noting that", "In order to", "This section covers".

## Quick start

```bash
npm run dev                          # Start the dev daemon
npm run dev:desktop                  # Start Electron desktop dev
bun run --cwd packages/desktop-web/apps/web dev  # Vite dev server for the web UI
npm run cli -- ls -a -g              # List all agents
npm run cli -- daemon status         # Check daemon status
npm run typecheck                    # Always run after changes
npm run lint                         # Always run after changes
npm run format                       # Auto-format with Biome
npm run format:check                 # Check formatting without writing
```

Repo dev commands use checkout-local state by default. In this checkout, `NEOLIX_HOME` resolves to `.dev/neox-home`, and `npm run cli -- ...` targets that same dev home automatically. The packaged desktop app and production-style daemon keep using `~/.neox` on port `6868`.

See [docs/development.md](docs/development.md) for full setup, build sync requirements, and debugging.

## Release branches

Merge normal PRs into `main`, including while a beta soaks or a release is being finalized. Each
release builds in a short-lived release workspace from `origin/main` or a release tag; see
[release base and source](docs/release.md#release-base-and-source).

## Critical rules

- **NEVER restart the main Neox daemon on port 6868 without permission** — it manages all running agents. If you're an agent, restarting it kills your own process.
- **NEVER assume a timeout means the service needs restarting** — timeouts can be transient.
- **NEVER add auth checks to tests** — agent providers handle their own auth.
- **NEVER run the full test suite locally.** The test suites are heavy and will freeze the machine, especially if multiple agents run them in parallel. Rules:
  - Run only the specific test file you changed: `npx vitest run <file> --bail=1`
  - Never run `npm run test` for an entire workspace unless explicitly asked.
  - If you must run a broad suite, pipe output to a file and read it afterward: `npx vitest run <file> --bail=1 > /tmp/test-output.txt 2>&1` then read the file.
  - Never re-run a test suite that another agent already ran and reported green — trust the result.
  - For full suite verification, push to CI and check GitHub Actions instead.
- Add tests to existing suites and reuse their npm scripts and CI jobs instead of creating feature-specific ones.
- **Always run typecheck and lint after every change.**
- **Build workspace packages before diagnosing cross-package type errors.** This repo consumes generated declarations across workspaces. If typecheck fails in a package that depends on another workspace, rebuild the owning stack first so `dist` declarations are current:
  - `npm run build:client` — rebuild protocol and client declarations.
  - `npm run build:server` — rebuild highlight, relay, protocol, client, server, and CLI when server/CLI types may be stale.
  - Do not patch inferred callback parameters or add local duplicate types just to silence stale declaration errors.
- **Run `npm run format` before committing.** This repo uses Biome for formatting. Do not manually fix formatting — let the formatter handle it.
- **Always use npm scripts for linting and formatting.** Do not run tools directly with `npx eslint`, `npx oxfmt`, `npx oxlint`, or package-local binaries. For targeted checks, pass file paths through the npm script:
  - `npm run lint -- packages/server/src/server/bootstrap.ts`
  - `npm run format:files -- CLAUDE.md packages/server/src/server/bootstrap.ts`
- **The protocol stays backward-compatible. Features don't have to.** Read [docs/protocol-compatibility.md](docs/protocol-compatibility.md) before touching `packages/protocol`. The short version:
  - **Protocol contract (always):** an old client parses messages from a new daemon, and a new daemon parses messages from an old client. New fields are optional; never narrow, never remove, never require. Wire schemas stay pure — no `.transform()`, `.catch()`, or `.preprocess()`.
  - **Feature contract (per-feature):** gate the capability once on `server_info.features.*`, then run the feature or tell the user to update the host. No fallback paths, no defensive branches.
  - **Every shim is tagged.** `// COMPAT(name): added in vX, remove after <date>` at the site that has to be deleted. `rg "COMPAT\("` is the cleanup backlog; untagged back-compat is permanent by accident.
  - **New RPCs use dotted namespaces with direction suffixes.** Follow [docs/rpc-namespacing.md](docs/rpc-namespacing.md): `domain.provider.operation.request` pairs with `domain.provider.operation.response`. Existing flat RPC names will migrate over time; don't add new ones.

## Debugging

Find the complete daemon logs and traces in the $NEOLIX_HOME/daemon.log
