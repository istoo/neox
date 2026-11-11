// Synara dev servers / workspace scripts backed by the Neox workspace-script runtime.
//
// Synara's sidebar runs a project command and tracks it as a dev server keyed by project id.
// Neox exposes configured workspace scripts (neox.json) plus an event channel for their
// lifecycle, so this module maps the two:
//   - `projects.discoverScripts` scans package.json files (the daemon has no route for it).
//   - `projects.runDevServer` starts the matching workspace script; a command that is not a
//     configured script runs in a plain daemon terminal and is tracked here by project.
//   - `projects.listDevServers` / `subscribeDevServerEvents` project running scripts and the
//     terminals started above; the daemon's `script_status_update` drives the stream.
import * as path from "node:path";

import {
  type ProjectDevServer,
  type ProjectDevServerEvent,
  type ProjectDevServerUrl,
  type ProjectDiscoverScriptsResult,
  type ProjectRestartDevServerInput,
  type ProjectRestartDevServerResult,
  type ProjectRunDevServerInput,
  type ProjectRunDevServerResult,
  type ProjectStopDevServerInput,
  type ProjectStopDevServerResult,
  WS_METHODS,
  WsRpcError,
} from "@synara/contracts";
import { Effect, Queue, Stream } from "effect";

import type { BridgeModel } from "./model.ts";
import { bridgeError, rpcError } from "./rpcErrors.ts";
import type { AnyHandler } from "./stubs.ts";

interface WorkspaceScript {
  readonly scriptName: string;
  readonly type?: "script" | "service";
  readonly hostname?: string;
  readonly port?: number | null;
  readonly localProxyUrl?: string | null;
  readonly publicProxyUrl?: string | null;
  readonly proxyUrl?: string | null;
  readonly lifecycle: "running" | "stopped";
  readonly terminalId?: string | null;
}

interface WorkspaceDescriptor {
  readonly id: string;
  readonly projectId: string;
  readonly projectRootPath: string;
  readonly workspaceDirectory?: string;
  readonly scripts: ReadonlyArray<WorkspaceScript>;
}

interface PackageJson {
  readonly name?: unknown;
  readonly scripts?: unknown;
}

interface TrackedRun {
  readonly projectId: string;
  readonly command: string;
  readonly cwd: string;
  readonly terminalId: string;
  readonly startedAt: string;
}

/** Directories that never hold a runnable package.json. */
const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "dist",
  "build",
  "out",
  ".next",
  ".turbo",
  "coverage",
  "vendor",
  ".venv",
  "target",
]);

const PACKAGE_JSON_MAX_BYTES = 512 * 1024;
const DEFAULT_DISCOVERY_DEPTH = 3;
const EVENT_DEBOUNCE_MS = 50;

function fromPromise<A>(_method: string, run: () => Promise<A>): Effect.Effect<A, WsRpcError> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => rpcError(cause),
  });
}

function fromSubscription<A>(subscribe: (emit: (item: A) => void) => () => void): Stream.Stream<A> {
  return Stream.callback<A>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => subscribe((item) => Queue.offerUnsafe(queue, item))),
      (unsubscribe) => Effect.sync(unsubscribe),
    ),
  );
}

/** Joins a workspace-relative directory onto the absolute project root. */
function joinRoot(root: string, relative: string): string {
  return relative ? path.join(root, relative) : root;
}

function relativeDepth(relative: string): number {
  return relative ? relative.split("/").filter(Boolean).length : 0;
}

async function readPackageJson(
  client: BridgeModel["client"],
  root: string,
  relative: string,
): Promise<PackageJson | null> {
  const packagePath = relative ? `${relative}/package.json` : "package.json";
  try {
    const file = await client.readFile(root, packagePath, undefined, PACKAGE_JSON_MAX_BYTES);
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(file.bytes);
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as PackageJson) : null;
  } catch {
    // A missing or malformed package.json simply ends this branch of the scan.
    return null;
  }
}

async function packageManagerFor(client: BridgeModel["client"], root: string): Promise<string> {
  const lockfiles: ReadonlyArray<[string, string]> = [
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lockb", "bun"],
    ["bun.lock", "bun"],
  ];
  for (const [file, manager] of lockfiles) {
    try {
      await client.readFile(root, file, undefined, 1);
      return manager;
    } catch {
      // Try the next lockfile.
    }
  }
  return "npm";
}

interface DiscoveredTarget {
  readonly cwd: string;
  readonly relativePath: string;
  readonly packageJsonPath: string;
  readonly packageName?: string;
  readonly scripts: ReadonlyArray<{ readonly name: string; readonly command: string }>;
}

async function discoverTargets(
  model: BridgeModel,
  root: string,
  maxDepth: number,
): Promise<ProjectDiscoverScriptsResult> {
  const client = model.client;
  const manager = await packageManagerFor(client, root);
  const targets: DiscoveredTarget[] = [];
  const queue: string[] = [""];

  while (queue.length > 0) {
    const relative = queue.shift() ?? "";
    const depth = relativeDepth(relative);
    if (depth > maxDepth) continue;

    const packageJson = await readPackageJson(client, root, relative);
    if (packageJson) {
      const scripts =
        packageJson.scripts && typeof packageJson.scripts === "object"
          ? Object.entries(packageJson.scripts as Record<string, unknown>)
              .filter((entry): entry is [string, string] => typeof entry[1] === "string")
              .filter(([name]) => name.trim().length > 0)
              .map(([name, body]) => ({ name, command: body }))
          : [];
      if (scripts.length > 0) {
        const packageName =
          typeof packageJson.name === "string" && packageJson.name.trim()
            ? packageJson.name
            : undefined;
        targets.push({
          cwd: joinRoot(root, relative),
          relativePath: relative || ".",
          packageJsonPath: relative ? `${relative}/package.json` : "package.json",
          ...(packageName ? { packageName } : {}),
          scripts: scripts.map((script) => ({
            name: script.name,
            // The command the bridge starts is the package script, which is also what makes
            // runDevServer's command round-trip back to a script name.
            command: `${manager} run ${script.name}`,
          })),
        });
      }
    }

    if (depth === maxDepth) continue;
    let entries: ReadonlyArray<{ name: string; kind: "file" | "directory" }>;
    try {
      const directory = await client.listDirectory(root, relative || ".");
      entries = directory.entries;
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.kind !== "directory") continue;
      if (entry.name.startsWith(".") || SKIPPED_DIRECTORIES.has(entry.name)) continue;
      queue.push(relative ? `${relative}/${entry.name}` : entry.name);
    }
  }

  return { targets };
}

/** Extracts the package script name from the command the discovery route returned. */
function scriptNameFromCommand(command: string): string | null {
  const trimmed = command.trim();
  const match = /^(?:npm|pnpm|yarn|bun)(?:\s+run)?\s+([A-Za-z0-9@:._-]+)(?:\s|$)/.exec(trimmed);
  if (match?.[1]) return match[1];
  if (/^[A-Za-z0-9@:._-]+$/.test(trimmed)) return trimmed;
  return null;
}

async function fetchWorkspaces(model: BridgeModel): Promise<ReadonlyArray<WorkspaceDescriptor>> {
  // debt: first page only. A host with enough workspaces to paginate a page is rare in the
  // desktop sidebar; paginate here when that becomes real.
  const payload = await model.client.fetchWorkspaces();
  return payload.entries as unknown as ReadonlyArray<WorkspaceDescriptor>;
}

function workspaceCwd(workspace: WorkspaceDescriptor): string {
  return workspace.workspaceDirectory?.trim() || workspace.projectRootPath;
}

function workspaceFor(
  workspaces: ReadonlyArray<WorkspaceDescriptor>,
  input: { projectId: string; cwd: string },
): WorkspaceDescriptor | undefined {
  const normalizedCwd = input.cwd.trim().replace(/\/+$/, "");
  let best: { workspace: WorkspaceDescriptor; length: number } | null = null;
  for (const workspace of workspaces) {
    const cwd = workspaceCwd(workspace).replace(/\/+$/, "");
    if (normalizedCwd !== cwd && !normalizedCwd.startsWith(`${cwd}/`)) continue;
    if (!best || cwd.length > best.length) best = { workspace, length: cwd.length };
  }
  return best?.workspace ?? workspaces.find((workspace) => workspace.projectId === input.projectId);
}

function stripUrlProtocol(url: string): string {
  return url.replace(/^https?:\/\//, "");
}

function isLocalOnlyUrl(url: string | null | undefined): boolean {
  if (!url) return true;
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
      ? true
      : hostname.endsWith(".localhost");
  } catch {
    return true;
  }
}

/**
 * The routes the daemon advertises for a workspace service script. The names mirror the old
 * app's route vocabulary: public proxy, the daemon's local proxy, and the direct port.
 */
function serviceUrls(script: WorkspaceScript): ProjectDevServerUrl[] {
  const targets: ProjectDevServerUrl[] = [];
  const add = (kind: ProjectDevServerUrl["kind"], url: string | null | undefined) => {
    if (!url || targets.some((target) => target.url === url)) return;
    targets.push({ kind, label: stripUrlProtocol(url), url });
  };
  // Old daemons only send `proxyUrl`; classify it the same way the old app did.
  const localProxyUrl =
    script.localProxyUrl ?? (isLocalOnlyUrl(script.proxyUrl) ? script.proxyUrl : null);
  const publicProxyUrl =
    script.publicProxyUrl ?? (!isLocalOnlyUrl(script.proxyUrl) ? script.proxyUrl : null);
  add("public", publicProxyUrl);
  add("neolix", localProxyUrl);
  if (script.port) add("direct", `http://localhost:${script.port}`);
  return targets;
}

function serverFromScript(
  projectId: string,
  cwd: string,
  script: WorkspaceScript,
  startedAt: string,
): ProjectDevServer {
  return {
    projectId: projectId as ProjectDevServer["projectId"],
    command: script.scriptName,
    cwd,
    pid: null,
    startedAt,
    status: "running",
    scriptName: script.scriptName,
    terminalId: script.terminalId ?? null,
    ...(script.hostname ? { hostname: script.hostname } : {}),
    port: script.port ?? null,
    urls: serviceUrls(script),
  };
}

class DevServers {
  private readonly listeners = new Set<(event: ProjectDevServerEvent) => void>();
  private readonly tracked = new Map<string, TrackedRun>();
  private eventTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly model: BridgeModel) {}

  subscribe(listener: (event: ProjectDevServerEvent) => void): () => void {
    this.listeners.add(listener);
    const unsubscribeDaemon = this.model.client.on("script_status_update", () => {
      this.schedulePublish();
    });
    void this.publish();
    return () => {
      this.listeners.delete(listener);
      unsubscribeDaemon();
      if (this.eventTimer) {
        clearTimeout(this.eventTimer);
        this.eventTimer = null;
      }
    };
  }

  private schedulePublish(): void {
    if (this.eventTimer) return;
    this.eventTimer = setTimeout(() => {
      this.eventTimer = null;
      void this.publish();
    }, EVENT_DEBOUNCE_MS);
  }

  async publish(): Promise<void> {
    try {
      const servers = await this.list();
      const event: ProjectDevServerEvent = { type: "snapshot", servers };
      for (const listener of this.listeners) listener(event);
    } catch {
      // Keep the last snapshot; the next daemon event retries.
    }
  }

  async list(): Promise<ProjectDevServer[]> {
    const servers: ProjectDevServer[] = [];
    const workspaces = await fetchWorkspaces(this.model);
    const now = new Date().toISOString();
    for (const workspace of workspaces) {
      for (const script of workspace.scripts) {
        if (script.lifecycle !== "running") continue;
        servers.push(serverFromScript(workspace.projectId, workspaceCwd(workspace), script, now));
      }
    }
    for (const run of this.tracked.values()) {
      servers.push({
        projectId: run.projectId as ProjectDevServer["projectId"],
        command: run.command,
        cwd: run.cwd,
        pid: null,
        startedAt: run.startedAt,
        status: "running",
        terminalId: run.terminalId,
      });
    }
    return servers;
  }

  async run(input: ProjectRunDevServerInput): Promise<ProjectRunDevServerResult> {
    const workspaces = await fetchWorkspaces(this.model);
    const workspace = workspaceFor(workspaces, input);
    const scriptName = scriptNameFromCommand(input.command);

    if (workspace && scriptName) {
      const script = workspace.scripts.find((entry) => entry.scriptName === scriptName);
      if (script?.lifecycle === "running") {
        return {
          server: serverFromScript(
            input.projectId,
            workspaceCwd(workspace),
            script,
            new Date().toISOString(),
          ),
        };
      }
      if (script) {
        const started = (await this.model.client.startWorkspaceScriptWithStatus(
          workspace.id,
          scriptName,
        )) as unknown as {
          script?: WorkspaceScript | null;
          error: string | null;
        };
        if (started.error) {
          throw bridgeError("dev-server.start-failed", started.error, { detail: started.error });
        }
        const running = started.script;
        if (!running) {
          throw bridgeError(
            "dev-server.script-not-started",
            "The daemon did not report the started script.",
          );
        }
        await this.publish();
        return {
          server: serverFromScript(
            input.projectId,
            workspaceCwd(workspace),
            running,
            new Date().toISOString(),
          ),
        };
      }
    }

    // Not a configured workspace script: run it in a daemon terminal and track the process here.
    const startedAt = new Date().toISOString();
    const created = await this.model.client.createTerminal(
      input.cwd,
      `synara:dev:${input.projectId}`,
      undefined,
      {
        command: "/bin/sh",
        args: ["-lc", input.command],
        ...(workspace ? { workspaceId: workspace.id } : {}),
      },
    );
    if (!created.terminal) {
      throw bridgeError(
        "dev-server.terminal-failed",
        created.error ?? "The daemon did not create the dev-server terminal.",
        created.error ? { detail: created.error } : undefined,
      );
    }
    this.tracked.set(input.projectId, {
      projectId: input.projectId,
      command: input.command,
      cwd: input.cwd,
      terminalId: created.terminal.id,
      startedAt,
    });
    await this.publish();
    return {
      server: {
        projectId: input.projectId,
        command: input.command,
        cwd: input.cwd,
        pid: null,
        startedAt,
        status: "running",
        terminalId: created.terminal.id,
      },
    };
  }

  async stop(input: ProjectStopDevServerInput): Promise<ProjectStopDevServerResult> {
    const tracked = this.tracked.get(input.projectId);
    if (tracked) {
      await this.model.client.killTerminal(tracked.terminalId);
      this.tracked.delete(input.projectId);
      await this.publish();
      return { stopped: true };
    }

    const workspaces = await fetchWorkspaces(this.model);
    let stopped = false;
    for (const workspace of workspaces) {
      if (workspace.projectId !== input.projectId) continue;
      for (const script of workspace.scripts) {
        if (script.lifecycle !== "running") continue;
        const result = (await this.model.client.stopWorkspaceScript(
          workspace.id,
          script.scriptName,
        )) as unknown as { error: string | null };
        if (result.error) {
          throw bridgeError("dev-server.stop-failed", result.error, { detail: result.error });
        }
        stopped = true;
      }
    }
    if (stopped) await this.publish();
    return { stopped };
  }

  /** Waits for the daemon to tear down its script runtime entries after a stop. */
  private async waitForProjectScriptsStopped(projectId: string): Promise<void> {
    // debt: fixed 10s ceiling. A hung stop leaves the restart starting against a live
    // runtime; the daemon's own start error then surfaces instead of being swallowed.
    const deadline = Date.now() + 10_000;
    for (;;) {
      const workspaces = await fetchWorkspaces(this.model).catch(() => []);
      const running = workspaces.some(
        (workspace) =>
          workspace.projectId === projectId &&
          workspace.scripts.some((script) => script.lifecycle === "running"),
      );
      if (!running || Date.now() >= deadline) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  async restart(input: ProjectRestartDevServerInput): Promise<ProjectRestartDevServerResult> {
    const tracked = this.tracked.get(input.projectId);
    if (tracked) {
      const command = tracked.command;
      const cwd = tracked.cwd;
      await this.stop({ projectId: input.projectId });
      await this.run({ projectId: input.projectId, command, cwd });
      await this.publish();
      return { restarted: true };
    }

    const workspaces = await fetchWorkspaces(this.model);
    const targets = workspaces
      .filter((workspace) => workspace.projectId === input.projectId)
      .flatMap((workspace) =>
        workspace.scripts
          .filter((script) => script.lifecycle === "running")
          .map((script) => ({ workspaceId: workspace.id, scriptName: script.scriptName })),
      );
    if (targets.length === 0) return { restarted: false };

    for (const target of targets) {
      const result = (await this.model.client.stopWorkspaceScript(
        target.workspaceId,
        target.scriptName,
      )) as unknown as { error: string | null };
      if (result.error) {
        throw bridgeError("dev-server.stop-failed", result.error, { detail: result.error });
      }
    }
    await this.waitForProjectScriptsStopped(input.projectId);
    for (const target of targets) {
      const started = (await this.model.client.startWorkspaceScriptWithStatus(
        target.workspaceId,
        target.scriptName,
      )) as unknown as { error: string | null };
      if (started.error) {
        throw bridgeError("dev-server.restart-failed", started.error, { detail: started.error });
      }
    }
    await this.publish();
    return { restarted: true };
  }
}

export function makeDevServerHandlers(model: BridgeModel): Record<string, AnyHandler> {
  const servers = new DevServers(model);
  return {
    [WS_METHODS.projectsDiscoverScripts]: (payload) =>
      fromPromise("projects.discoverScripts", () => {
        const input = payload as { cwd: string; depth?: number };
        const depth = Math.min(Math.max(input.depth ?? DEFAULT_DISCOVERY_DEPTH, 0), 3);
        return discoverTargets(model, input.cwd, depth);
      }),
    [WS_METHODS.projectsListDevServers]: () =>
      fromPromise("projects.listDevServers", async () => ({
        servers: await servers.list(),
      })),
    [WS_METHODS.projectsRunDevServer]: (payload) =>
      fromPromise("projects.runDevServer", () => servers.run(payload as ProjectRunDevServerInput)),
    [WS_METHODS.projectsStopDevServer]: (payload) =>
      fromPromise("projects.stopDevServer", () =>
        servers.stop(payload as ProjectStopDevServerInput),
      ),
    [WS_METHODS.projectsRestartDevServer]: (payload) =>
      fromPromise("projects.restartDevServer", () =>
        servers.restart(payload as ProjectRestartDevServerInput),
      ),
    [WS_METHODS.subscribeProjectDevServerEvents]: () =>
      fromSubscription<ProjectDevServerEvent>((emit) => servers.subscribe(emit)),
  };
}

export { discoverTargets, packageManagerFor, scriptNameFromCommand };
