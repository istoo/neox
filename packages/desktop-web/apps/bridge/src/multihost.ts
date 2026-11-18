// Multiple daemons, one bridge.
//
// Synara models another computer as an execution environment: `hosts.connect` opens a
// session, answers a local upgrade path, and the renderer speaks the ordinary protocol to
// that path. The bridge is the shell in this deployment, so it owns the outbound session
// instead of a desktop main process. Each connected host gets its own routed DaemonClient
// (the Neox client's host channel), its own BridgeModel, and its own feature socket under
// `/rpc/remote/<hostId>`; the frontend then runs that computer in its own workspace frame.
import { createHash, randomUUID } from "node:crypto";
import * as net from "node:net";
import * as path from "node:path";

import {
  WS_METHODS,
  WS_REMOTE_PATH_PREFIX,
  WsRpcError,
  type AccountHost,
  type HostConnection,
  type HostConnectionTransport,
  type ListHostConnectionsResponse,
  type RemoteAccessRequest,
  type RemoteAccessResult,
  type RemoteExecutionScope,
} from "@synara/contracts";
import { Effect } from "effect";

import type { DaemonClient } from "../../../../client/dist/daemon-client.js";
import type {
  HostAdd,
  HostDirectory,
  HostSummary,
  HostUpdate,
} from "../../../../client/dist/index.js";

import { bridgeClientRuntime } from "./clientRuntime.ts";

import { BridgeModel } from "./model.ts";
import { ProjectPins } from "./projectPins.ts";
import { DraftThreads } from "./draftThreads.ts";
import type { DaemonClient as PrimaryClient } from "./neolix.ts";
import { LOCAL_HOST_ID } from "./pairingRpc.ts";
import { bridgeError, rpcError } from "./rpcErrors.ts";
import type { AnyHandler } from "./stubs.ts";
import { bridgeServerCapabilities, type WsNegotiationOptions } from "./compatibility.ts";
import { channelFromVersion, worktreesDirFor, type HostPaths } from "./serverInfo.ts";

export { LOCAL_HOST_ID };

const REMOTE_HOST_PREFIX = "neolix-host-";
const REMOTE_PATH_PREFIX = WS_REMOTE_PATH_PREFIX;
const SESSION_LIFETIME_MS = 365 * 24 * 60 * 60 * 1_000;

/** A registration id is opaque; keep it out of paths and environment ids verbatim. */
function safeIdPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_");
}

export function remoteHostId(registrationId: string): string {
  return `${REMOTE_HOST_PREFIX}${safeIdPart(registrationId)}`;
}

export function registrationIdFromHostId(hostId: string): string | null {
  return hostId.startsWith(REMOTE_HOST_PREFIX) ? hostId.slice(REMOTE_HOST_PREFIX.length) : null;
}

export function wsPathForHost(hostId: string): string {
  return `${REMOTE_PATH_PREFIX}${encodeURIComponent(hostId)}`;
}

export function hostIdFromWsPath(wsPath: string): string | null {
  if (!wsPath.startsWith(REMOTE_PATH_PREFIX)) return null;
  try {
    return decodeURIComponent(wsPath.slice(REMOTE_PATH_PREFIX.length));
  } catch {
    return null;
  }
}

function platformForHost(row?: {
  readonly metadata?: Record<string, string>;
}): AccountHost["platform"] {
  const declared = row?.metadata?.platform;
  if (declared === "darwin" || declared === "linux" || declared === "windows") return declared;
  switch (process.platform) {
    case "darwin":
      return "darwin";
    case "win32":
      return "windows";
    default:
      return "linux";
  }
}

function transportForTarget(description: string): HostConnectionTransport {
  if (description.startsWith("ssh://")) return "ssh";
  if (description.startsWith("relay://")) return "relay";
  if (description.startsWith("unix://") || description.startsWith("pipe://")) return "loopback";
  return "lan";
}

/**
 * The daemon's download route is plain HTTP and the token is the whole capability, so a
 * host can serve a backup only when the bridge reaches it over TCP. Relay and SSH targets
 * have no such address here; the handler reports that instead of reading a local file.
 */
export function httpBaseForTarget(description: string): string | null {
  if (description.startsWith("tcp://")) return `http://${description.slice("tcp://".length)}`;
  try {
    const url = new URL(description);
    if (url.protocol === "ws:") return `http://${url.host}`;
    if (url.protocol === "wss:") return `https://${url.host}`;
    if (url.protocol === "http:" || url.protocol === "https:") return url.origin;
  } catch {
    return null;
  }
  return null;
}

/** The primary daemon's configured target, in the same grammar a saved host uses. */
export function httpBaseForConnection(connection: string): string | null {
  try {
    return httpBaseForTarget(bridgeClientRuntime().node.parseHostTarget(connection).description);
  } catch {
    return null;
  }
}

function endpointsForTarget(description: string): AccountHost["endpoints"] {
  // debt: a daemon registration has exactly one connection target, so a host
  // cannot publish LAN + relay + SSH paths at once. Grouping several
  // registrations by serverId into one row is the upgrade path once the
  // daemon exposes per-path availability.
  if (description.startsWith("tcp://")) return [{ url: description, transport: "lan" }];
  return [];
}

const PROBE_TIMEOUT_MS = 3_000;

type ProbeTransport = "cloudflare" | "loopback" | "lan" | "tailscale" | "ssh" | "relay";

type ProbeTarget =
  | { readonly kind: "tcp"; readonly host: string; readonly port: number }
  | { readonly kind: "socket"; readonly path: string }
  | { readonly kind: "none" };

/** The address a saved registration's target description points at, for a TCP probe. */
function probeTargetFor(description: string): { target: ProbeTarget; transport: ProbeTransport } {
  const trimmed = description.trim();
  if (trimmed.startsWith("tcp://")) {
    try {
      const url = new URL(trimmed);
      const port = Number(url.port);
      if (url.hostname && Number.isInteger(port) && port > 0) {
        return {
          target: { kind: "tcp", host: url.hostname, port },
          transport: "lan",
        };
      }
    } catch {
      // Fall through to the URL forms below.
    }
  }
  if (trimmed.startsWith("relay://")) {
    try {
      const url = new URL(trimmed);
      const port = Number(url.port || "443");
      if (url.hostname && Number.isInteger(port) && port > 0) {
        return { target: { kind: "tcp", host: url.hostname, port }, transport: "relay" };
      }
    } catch {
      // No address to probe.
    }
  }
  if (trimmed.startsWith("ssh://")) {
    try {
      const url = new URL(trimmed);
      const port = Number(url.port || "22");
      if (url.hostname && Number.isInteger(port) && port > 0) {
        return { target: { kind: "tcp", host: url.hostname, port }, transport: "ssh" };
      }
    } catch {
      // No address to probe.
    }
  }
  if (trimmed.startsWith("unix://") || trimmed.startsWith("pipe://")) {
    return {
      target: { kind: "socket", path: trimmed.replace(/^(unix|pipe):\/\//, "") },
      transport: "loopback",
    };
  }
  if (trimmed.startsWith("ws://") || trimmed.startsWith("wss://") || trimmed.startsWith("http")) {
    try {
      const url = new URL(trimmed);
      const port = Number(
        url.port || (url.protocol === "wss:" || url.protocol === "https:" ? "443" : "80"),
      );
      if (url.hostname && Number.isInteger(port) && port > 0) {
        return { target: { kind: "tcp", host: url.hostname, port }, transport: "lan" };
      }
    } catch {
      // No address to probe.
    }
  }
  // The saved-host grammar also accepts a bare host:port.
  const bare = /^(\[[^\]]+\]|[^:/]+):(\d{1,5})$/.exec(trimmed);
  if (bare) {
    return {
      target: { kind: "tcp", host: bare[1]!.replace(/^\[|\]$/g, ""), port: Number(bare[2]) },
      transport: "lan",
    };
  }
  return { target: { kind: "none" }, transport: "lan" };
}

/**
 * Dial the address once. A refused connection is evidence the host answered
 * (so it is reachable); a timeout is not evidence the host is off, which is
 * why the UI distinguishes `unreachable` from `no-answer`.
 */
async function probe(
  target: ProbeTarget,
): Promise<{ result: "reachable" | "unreachable" | "no-answer"; latencyMs?: number }> {
  if (target.kind === "none") return { result: "no-answer" };
  const startedAt = Date.now();
  const result = await new Promise<"reachable" | "unreachable" | "no-answer">((resolve) => {
    const socket =
      target.kind === "tcp"
        ? net.createConnection({ host: target.host, port: target.port })
        : net.createConnection({ path: target.path });
    let settled = false;
    const finish = (value: "reachable" | "unreachable" | "no-answer") => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS);
    socket.once("connect", () => finish("reachable"));
    socket.once("timeout", () => finish("no-answer"));
    socket.once("error", () => finish("unreachable"));
  });
  return result === "reachable" ? { result, latencyMs: Date.now() - startedAt } : { result };
}

function accountHostForRegistration(row: HostSummary): AccountHost {
  const hostId = remoteHostId(row.registrationId);
  const seenAt = row.lastOnlineAt ?? new Date().toISOString();
  return {
    id: hostId,
    // The daemon's serverId is the stable environment identity; the registration id only
    // names this saved connection.
    environmentId: (row.serverId?.trim() || hostId) as AccountHost["environmentId"],
    name: row.label?.trim() || row.targetDescription || "Neox host",
    platform: platformForHost(row),
    kind: "ssh-managed",
    endpoints: endpointsForTarget(row.targetDescription),
    ownerUserId: "local",
    discoverable: true,
    linked: true,
    keyGeneration: 0,
    mine: true,
    createdAt: seenAt,
    lastSeenAt: seenAt,
  };
}

function accountHostForSelf(environmentId: string, label: string): AccountHost {
  const now = new Date().toISOString();
  return {
    id: LOCAL_HOST_ID,
    environmentId: environmentId as AccountHost["environmentId"],
    name: label,
    platform: platformForHost(),
    kind: "local",
    endpoints: [],
    ownerUserId: "local",
    discoverable: false,
    linked: true,
    keyGeneration: 0,
    mine: true,
    createdAt: now,
    lastSeenAt: now,
  };
}

/** Per-host handler options. `hosts` is only set on the controller's map. */
export interface HostHandlerOptions {
  readonly environmentId: string;
  readonly home: string;
  /** Paths from this host's daemon, never the controller's. */
  readonly paths: HostPaths;
  readonly platform?: {
    readonly os: "darwin" | "linux" | "windows" | "unknown";
    readonly arch: "arm64" | "x64" | "other";
  };
  readonly log: (line: string) => void;
  readonly label?: string;
  /** HTTP origin of the daemon this handler map talks to, for token-based downloads. */
  readonly daemonHttpBase?: string;
  /** Bridge-local project pins for this host; already loaded before handlers are built. */
  readonly projectPins: ProjectPins;
}

export type HostHandlerFactory = (
  model: BridgeModel,
  options: HostHandlerOptions,
) => Record<string, AnyHandler>;

interface HostSession {
  readonly key: string;
  readonly hostId: string;
  readonly registrationId: string;
  readonly environmentId: string;
  readonly label: string;
  readonly transport: HostConnectionTransport;
  readonly startedAt: string;
  readonly client: DaemonClient;
  readonly handlers: Record<string, AnyHandler>;
  readonly model: BridgeModel;
}

interface HostRegistryOptions {
  readonly home: string;
  /** The controller's own environment id, shared by `server.getEnvironment`. */
  readonly environmentId: string;
  readonly label: string;
  readonly log: (line: string) => void;
  readonly buildHandlers: HostHandlerFactory;
}

function fromPromise<A>(_method: string, run: () => Promise<A>): Effect.Effect<A, WsRpcError> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => rpcError(cause),
  });
}

function unsupported(method: string, detail: string): WsRpcError {
  return new WsRpcError({
    message: `${method} is not available in the Neox bridge: ${detail}`,
    code: "neolix.not-supported",
    params: { method, detail },
    retryable: false,
  });
}

/**
 * Owns every routed daemon connection. Host registrations live in the primary daemon's
 * hosts.json; sessions live here and are created only when a renderer asks to connect.
 */
export class HostRegistry {
  private readonly sessions = new Map<string, HostSession>();
  /** A second `hosts.connect` for the same host joins the first instead of dialing again. */
  private readonly pendingConnects = new Map<string, Promise<HostSession>>();
  private allowConnections = true;

  constructor(
    private readonly primary: PrimaryClient,
    private readonly options: HostRegistryOptions,
  ) {}

  private get identityFingerprint(): string {
    return createHash("sha256").update(`neolix-bridge:${this.options.environmentId}`).digest("hex");
  }

  private async directory(): Promise<HostDirectory> {
    return this.primary.listHosts();
  }

  private async registrations(): Promise<HostSummary[]> {
    return (await this.directory()).hosts;
  }

  private async registrationFor(hostId: string): Promise<HostSummary | null> {
    const rows = await this.registrations();
    return rows.find((row) => remoteHostId(row.registrationId) === hostId) ?? null;
  }

  async hosts(): Promise<AccountHost[]> {
    let rows: HostSummary[];
    try {
      rows = await this.registrations();
    } catch (error) {
      // A daemon that predates connected hosts cannot list its registrations; the local
      // computer is still a valid row and the UI's update guidance comes from the error.
      if (isUnsupportedCapability(error)) rows = [];
      else throw error;
    }
    return [
      accountHostForSelf(this.options.environmentId, this.options.label),
      ...rows.map(accountHostForRegistration),
    ];
  }

  async add(input: HostAdd): Promise<AccountHost> {
    // Repeating an unchanged add returns the saved entry; the daemon would otherwise
    // create a second registration for the same target and flag it as a duplicate.
    let description: string | null = null;
    try {
      description = bridgeClientRuntime().node.parseHostTarget(input.connection).description;
    } catch {
      // Let the daemon report the grammar error with its own message.
    }
    if (description) {
      const existing = (await this.registrations()).find(
        (row) => row.targetDescription === description,
      );
      if (existing) {
        if (input.label && input.label !== existing.label) {
          const updated = await this.primary.updateHost(existing.registrationId, {
            label: input.label,
          });
          return accountHostForRegistration(updated);
        }
        return accountHostForRegistration(existing);
      }
    }
    const row = await this.primary.addHost(input);
    return accountHostForRegistration(row);
  }

  async update(hostId: string, patch: HostUpdate): Promise<AccountHost> {
    const registrationId = registrationIdFromHostId(hostId);
    if (!registrationId) throw unsupported("hosts.update", "this computer is not a saved host");
    // Discoverability is an account/workspace concept with no Neox equivalent. Accepting
    // the field and doing nothing is better than inventing a directory that does not exist.
    if (patch.label === undefined && patch.metadata === undefined) {
      const row = await this.registrationFor(hostId);
      if (!row) {
        throw bridgeError("host.saved-missing", "That saved host no longer exists.");
      }
      return accountHostForRegistration(row);
    }
    const row = await this.primary.updateHost(registrationId, patch);
    return accountHostForRegistration(row);
  }

  async remove(hostId: string): Promise<void> {
    const registrationId = registrationIdFromHostId(hostId);
    if (!registrationId) throw unsupported("hosts.delete", "this computer is not a saved host");
    await this.disconnect(hostId);
    await this.primary.removeHost(registrationId);
  }

  async connect(hostId: string): Promise<HostConnection> {
    const existing = this.sessions.get(hostId);
    if (existing) return this.describe(existing);
    const row = await this.registrationFor(hostId);
    if (!row) {
      const registrationId = registrationIdFromHostId(hostId);
      if (!registrationId) throw unsupported("hosts.connect", "this computer is the controller");
      throw bridgeError("host.saved-missing", "That saved host no longer exists.");
    }
    if (!row.enabled) throw bridgeError("host.disabled", "That host is disabled.");
    if (!row.serverId) {
      throw bridgeError(
        "host.not-connected",
        "That host has not connected yet. Check it is online and try again.",
      );
    }

    const pending = this.pendingConnects.get(hostId);
    if (pending) return this.describe(await pending);

    const creation = this.openSession(row);
    this.pendingConnects.set(hostId, creation);
    try {
      const session = await creation;
      this.sessions.set(hostId, session);
      return this.describe(session);
    } finally {
      this.pendingConnects.delete(hostId);
    }
  }

  async disconnect(hostId: string): Promise<void> {
    const pending = this.pendingConnects.get(hostId);
    if (pending) {
      // A caller is still dialing: wait for it, then tear the fresh session down so the
      // host really is disconnected instead of reconnecting behind the caller's back.
      await pending.catch(() => undefined);
    }
    const session = this.sessions.get(hostId);
    if (!session) return;
    this.sessions.delete(hostId);
    session.model.dispose();
    await session.client.close().catch((error) => {
      this.options.log(`host ${hostId} close failed: ${String(error)}`);
    });
  }

  async connections(): Promise<ListHostConnectionsResponse> {
    const hosts = await this.hosts();
    const pairedHosts = hosts
      .filter((host) => host.id !== LOCAL_HOST_ID)
      .map((host) => ({ hostId: host.id, environmentId: host.environmentId }));
    return {
      pairedHosts,
      desiredHosts: [],
      connections: [...this.sessions.values()].map((session) => this.describe(session)),
    };
  }

  /**
   * Probe the address a saved registration points at. The controller itself is
   * reachable by definition (this process is answering), and an already-open
   * session is the strongest possible evidence, so neither dials the network.
   */
  async checkReachability(
    hostId: string,
  ): Promise<
    | { state: "reachable"; transport: ProbeTransport; at: number }
    | { state: "unreachable"; at: number }
    | { state: "no-answer"; at: number }
    | { state: "no-route"; at: number }
  > {
    const now = Date.now();
    if (hostId === LOCAL_HOST_ID) return { state: "reachable", transport: "loopback", at: now };
    const session = this.sessions.get(hostId);
    if (session) return { state: "reachable", transport: session.transport, at: now };
    const row = await this.registrationFor(hostId);
    if (!row) return { state: "no-route", at: now };
    const { target, transport } = probeTargetFor(row.targetDescription);
    if (target.kind === "none") return { state: "no-route", at: now };
    const result = await probe(target);
    const at = Date.now();
    return result.result === "reachable"
      ? {
          state: "reachable",
          transport,
          at,
          ...(result.latencyMs !== undefined ? { latencyMs: result.latencyMs } : {}),
        }
      : { state: result.result, at };
  }

  handlersFor(hostId: string): { key: string; handlers: Record<string, AnyHandler> } | null {
    const session = this.sessions.get(hostId);
    return session ? { key: session.key, handlers: session.handlers } : null;
  }

  /** The version a connected host's negotiation must report, not the controller's. */
  negotiationFor(hostId: string): WsNegotiationOptions | undefined {
    const session = this.sessions.get(hostId);
    if (!session) return undefined;
    const info = session.client.getLastServerInfoMessage();
    return {
      serverBuild: info?.version ?? undefined,
      capabilities: bridgeServerCapabilities({
        daemonRuntimeStatus: info?.features?.daemonRuntimeStatus === true,
      }),
    };
  }

  async remoteAccess(request: RemoteAccessRequest): Promise<RemoteAccessResult> {
    switch (request.operation) {
      case "device-info":
        return {
          kind: "device-info",
          deviceJkt: this.identityFingerprint,
          label: this.options.label,
        };
      case "list":
        return {
          kind: "host-state",
          invitations: [],
          devices: [],
          rootFingerprint: this.identityFingerprint,
          rootExpiresAt: null,
          rootNeedsRepair: false,
          allowConnections: this.allowConnections,
        };
      case "create-code":
      case "create-invitation": {
        // The daemon's connection offer is the pairing artifact: the old app encodes the
        // same URL in its QR. There is no rendezvous service, so it is handed over whole.
        const offer = await this.primary.getDaemonPairingOffer();
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString();
        return {
          kind: "pairing-code",
          code: offer.url || this.identityFingerprint.slice(0, 8).toUpperCase(),
          inviteId: this.identityFingerprint.slice(0, 8),
          // The offer is the daemon's public identity, not a single-use code;
          // the UI must not count it down.
          neverExpires: true,
          expiresAt,
          rootFingerprint: this.identityFingerprint,
          ...(offer.url ? { link: offer.url } : {}),
        };
      }
      case "cancel-invitation":
      case "approve":
        return { kind: "done" };
      case "set-allow-connections":
        this.allowConnections = request.enabled;
        return { kind: "done" };
      case "forget-host": {
        const rows = await this.registrations();
        const row = rows.find((entry) => rowEnvironmentId(entry) === request.environmentId);
        if (row) await this.remove(remoteHostId(row.registrationId));
        return { kind: "done" };
      }
      default:
        throw unsupported("hosts.remoteAccess", `operation ${request.operation}`);
    }
  }

  async dispose(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    for (const session of sessions) session.model.dispose();
    await Promise.all(sessions.map((session) => session.client.close().catch(() => undefined)));
  }

  private async openSession(row: HostSummary): Promise<HostSession> {
    const serverId = row.serverId;
    if (!serverId) throw bridgeError("host.no-server-id", "Host reported no server id");
    const hostId = remoteHostId(row.registrationId);
    const label = row.label?.trim() || row.targetDescription || "Neox host";
    const scopeId = randomUUID();
    const startedAt = new Date().toISOString();
    const httpBase = httpBaseForTarget(row.targetDescription);

    this.options.log(`opening route to ${row.targetDescription} (${serverId})`);
    const routeId = await this.primary.openHostRoute(serverId, scopeId);
    const runtime = bridgeClientRuntime();
    const client = new runtime.daemonClient.DaemonClient({
      url: "ws://routed-host/ws",
      clientId: scopeId,
      clientType: "cli",
      appVersion: "0.15.0",
      transportFactory: runtime.hosts.createHostChannelTransport(
        this.primary,
        serverId,
        scopeId,
        routeId,
      ),
      // Initial acquisition has a deadline; established scopes restore demand on loss.
      reconnect: { enabled: false },
    });

    try {
      await client.connect();
      client.setReconnectEnabled(true);
      // The remote daemon's own serverId, read from the server_info it just sent.
      const environmentId = client.getLastServerInfoMessage()?.serverId?.trim() || serverId;
      const legacyScopes = hostId === environmentId ? [] : [hostId];
      const projectPins = new ProjectPins({
        file: path.join(this.options.home, "desktop-web", "project-pins.json"),
        scope: environmentId,
        legacyScopes,
        log: this.options.log,
      });
      await projectPins.load();
      const draftThreads = new DraftThreads({
        file: path.join(this.options.home, "desktop-web", "draft-threads.json"),
        scope: environmentId,
        legacyScopes,
        log: this.options.log,
      });
      const model = new BridgeModel(client, this.options.log, undefined, projectPins, draftThreads);
      await model.load();
      // Paths and OS come from this host. Without a status RPC, no path is invented from the
      // control machine: root is the only honest fallback, and `homeDir` stays unknown.
      const status = await client.getDaemonStatus().catch(() => null);
      const hostHome = status?.configDir?.trim() || null;
      const hostPaths: HostPaths = hostHome
        ? {
            cwd: hostHome,
            homeDir: hostHome,
            worktreesDir: await worktreesDirFor(
              client,
              `${hostHome.replace(/[\\/]+$/, "")}/worktrees`,
            ),
          }
        : { cwd: "/", worktreesDir: "/worktrees" };
      this.options.log(`host ${hostId} ready`);
      const handlers = this.options.buildHandlers(model, {
        environmentId,
        home: this.options.home,
        paths: hostPaths,
        platform: { os: platformForHost(row), arch: "other" },
        log: this.options.log,
        label,
        projectPins,
        ...(httpBase ? { daemonHttpBase: httpBase } : {}),
      });
      return {
        key: randomUUID(),
        hostId,
        registrationId: row.registrationId,
        environmentId,
        label,
        transport: transportForTarget(row.targetDescription),
        startedAt,
        client,
        handlers,
        model,
      };
    } catch (error) {
      await client.close().catch(() => undefined);
      this.primary.closeHostRoute(routeId);
      throw Object.assign(error instanceof Error ? error : new Error("Host connection failed"), {
        hostId,
        serverId,
      });
    }
  }

  private describe(session: HostSession): HostConnection {
    const executionScope: RemoteExecutionScope = {
      environmentId: session.environmentId,
      accountAuthority: "neolix",
      userId: "local",
      organizationId: "local",
      // Derived from the host's own version; `dev` remains the only value when it is
      // unavailable because the scope field is required.
      channel: channelFromVersion(session.client.getLastServerInfoMessage()?.version) ?? "dev",
    };
    return {
      executionScope,
      state: "connected",
      environmentId: session.environmentId,
      hostId: session.hostId,
      hostName: session.label,
      transport: session.transport,
      startedAt: session.startedAt,
      credentialExpiresAt: new Date(
        Date.parse(session.startedAt) + SESSION_LIFETIME_MS,
      ).toISOString(),
      wsPath: wsPathForHost(session.hostId),
    };
  }
}

function rowEnvironmentId(row: HostSummary): string {
  return row.serverId?.trim() || remoteHostId(row.registrationId);
}

function isUnsupportedCapability(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "unsupported_capability"
  );
}

/** The `hosts.*` RPC surface. Only the controller's handler map carries a registry. */
export function makeHostRegistryHandlers(registry: HostRegistry): Record<string, AnyHandler> {
  return {
    [WS_METHODS.hostsList]: () =>
      fromPromise("hosts.list", async () => ({ hosts: await registry.hosts() })),

    [WS_METHODS.hostsAdd]: (payload) =>
      fromPromise("hosts.add", async () => {
        const input = payload as { connection: string; label?: string };
        return registry.add({
          connection: input.connection,
          ...(input.label ? { label: input.label } : {}),
        });
      }),

    [WS_METHODS.hostsUpdate]: (payload) =>
      fromPromise("hosts.update", async () => {
        const input = payload as { hostId: string; name?: string; discoverable?: boolean };
        return registry.update(input.hostId, input.name === undefined ? {} : { label: input.name });
      }),

    [WS_METHODS.hostsDelete]: (payload) =>
      fromPromise("hosts.delete", async () => {
        await registry.remove((payload as { hostId: string }).hostId);
      }),

    [WS_METHODS.hostsConnect]: (payload) =>
      fromPromise("hosts.connect", () => registry.connect((payload as { hostId: string }).hostId)),

    [WS_METHODS.hostsDisconnect]: (payload) =>
      fromPromise("hosts.disconnect", async () => {
        await registry.disconnect((payload as { hostId: string }).hostId);
      }),

    [WS_METHODS.hostsListConnections]: () =>
      fromPromise("hosts.listConnections", () => registry.connections()),

    [WS_METHODS.hostsCheckReachability]: (payload) =>
      fromPromise("hosts.checkReachability", () =>
        registry.checkReachability((payload as { hostId: string }).hostId),
      ),

    [WS_METHODS.hostsRemoteAccess]: (payload) =>
      fromPromise("hosts.remoteAccess", () =>
        registry.remoteAccess((payload as { request: RemoteAccessRequest }).request),
      ),
  };
}
