import { rememberVerifiedController } from "./controllerRecovery";
import {
  WS_FEATURE_PATH,
  WS_METHODS,
  RemoteConnectionUnavailable,
  type AccountStatus,
  type ExecutionEnvironmentDescriptor,
  type HostConnection,
  type ListHostConnectionsResponse,
  type RemoteExecutionScope,
} from "@synara/contracts";
import { Schema } from "effect";
import {
  EnvironmentConnections,
  type EnvironmentConnectionTarget,
  type EnvironmentLease,
} from "@synara/client-runtime/environmentConnections";
import { WsTransport, rawSocketUrl } from "../../wsTransport";
import { readActiveHost } from "./activeHost";
import { readWorkspaceFrame } from "./workspaceFrame";
import { initializeExecutionContext } from "./executionContext";

let connections: EnvironmentConnections | undefined;
let generationChanged: (() => void) | undefined;
let unregisterConnectionRecovery: (() => void) | undefined;
let bootstrapLifetime: AbortController | undefined;
const openedDescriptors = new Map<string, ExecutionEnvironmentDescriptor>();

export function setExecutionGenerationHandler(handler: () => void): void {
  generationChanged = handler;
}

function ensureConnections(): EnvironmentConnections {
  if (connections) return connections;
  let created!: EnvironmentConnections;
  created = new EnvironmentConnections({
    createController: () => {
      let local!: WsTransport;
      local = new WsTransport(undefined, {
        onGenerationChanged: () => {
          if (created.execution() === local) generationChanged?.();
        },
      });
      return local;
    },
    connectEnvironment: (target) => openHostConnection(target),
  });
  connections = created;
  return created;
}

export function getConnectionClients(): { controller: WsTransport; execution: WsTransport } {
  const current = ensureConnections();
  return { controller: current.controller(), execution: current.execution() };
}

/** The channel for one environment, when this frame has it open. */
export function forEnvironment(environmentId: string): WsTransport | undefined {
  return ensureConnections().forEnvironment(environmentId);
}

/**
 * Opens or reuses a host channel for a reader that is not the selected
 * execution (History). The lease only closes the socket this frame opened.
 */
export function acquireEnvironment(input: {
  readonly hostId: string;
  readonly executionScope: RemoteExecutionScope;
  readonly signal?: AbortSignal | undefined;
}): Promise<EnvironmentLease> {
  return ensureConnections().acquire(input);
}

/**
 * Opens the existing routed channel for one host: the controller authorizes a
 * `hostsConnect`, and the returned `wsPath` (`/rpc/remote/<hostId>`) carries the
 * feature socket. Titles and account checks stay with the caller's frame.
 */
async function openHostConnection(target: EnvironmentConnectionTarget): Promise<WsTransport> {
  const controller = ensureConnections().controller();
  const signal = target.signal;
  const ownsBootstrapRecovery = signal !== undefined && bootstrapLifetime?.signal === signal;

  let execution: WsTransport | undefined;
  let recoveryVersion = 0;
  let resumeBootstrap: (() => void) | undefined;
  if (ownsBootstrapRecovery) {
    unregisterConnectionRecovery = readWorkspaceFrame()?.registerConnectionRecovery?.({
      resume: (options) => {
        if (signal.aborted) return;
        recoveryVersion++;
        resumeBootstrap?.();
        execution?.resumeRemoteConnection(options);
      },
      dispose: () => {
        // A retired bootstrap must not tear down a newer one.
        if (bootstrapLifetime?.signal === signal) void disposeConnectionClients();
      },
    });
  }

  try {
    let connection: HostConnection;
    for (;;) {
      const attemptedRecoveryVersion = recoveryVersion;
      try {
        connection = await controller.request<HostConnection>(
          WS_METHODS.hostsConnect,
          { hostId: target.hostId },
          { timeoutMs: 60_000, ...(signal ? { signal } : {}) },
        );
        break;
      } catch (error) {
        signal?.throwIfAborted();
        if (attemptedRecoveryVersion !== recoveryVersion) continue;
        // RPC errors can contain provider text. Only authoritative controller state
        // may park this frame while its existing retry controls recover the same host.
        let response: ListHostConnectionsResponse;
        try {
          response = await controller.request<ListHostConnectionsResponse>(
            WS_METHODS.hostsListConnections,
            undefined,
            { ...(signal ? { signal } : {}) },
          );
        } catch {
          signal?.throwIfAborted();
          throw error;
        }
        signal?.throwIfAborted();
        if (attemptedRecoveryVersion !== recoveryVersion) continue;
        const scope = target.executionScope;
        // The scope is the full remote identity; only the directory lookup below uses it.
        const desired = response.desiredHosts?.find(
          (host) => host.hostId === target.hostId && host.environmentId === scope.environmentId,
        );
        const connected = response.connections.find(
          (host) =>
            host.hostId === target.hostId &&
            JSON.stringify(host.executionScope) === JSON.stringify(scope),
        );
        if (
          !Schema.is(RemoteConnectionUnavailable)({
            code: "REMOTE_CONNECTION_REQUIRES_ATTENTION",
            state: desired?.state ?? connected?.state,
          })
        )
          throw error;
        let account: AccountStatus;
        try {
          account = await controller.request<AccountStatus>(WS_METHODS.accountStatus, undefined, {
            ...(signal ? { signal } : {}),
          });
        } catch {
          signal?.throwIfAborted();
          throw error;
        }
        signal?.throwIfAborted();
        if (
          account.state !== "signed-in" ||
          account.me.id !== scope.userId ||
          account.me.organization.id !== scope.organizationId ||
          account.accountAuthority !== scope.accountAuthority
        )
          throw error;
        if (attemptedRecoveryVersion !== recoveryVersion) continue;
        await new Promise<void>((resolve, reject) => {
          const aborted = () => {
            resumeBootstrap = undefined;
            reject(signal?.reason);
          };
          signal?.addEventListener("abort", aborted, { once: true });
          resumeBootstrap = () => {
            signal?.removeEventListener("abort", aborted);
            resumeBootstrap = undefined;
            resolve();
          };
        });
      }
    }
    signal?.throwIfAborted();
    const scope = connection.executionScope;
    if (!scope || JSON.stringify(scope) !== JSON.stringify(target.executionScope))
      throw new Error("The selected host or account changed. Return locally and select it again.");
    const url = new URL(rawSocketUrl(null));
    url.pathname = `${connection.wsPath}${WS_FEATURE_PATH}`;
    execution = new WsTransport(url.toString(), {
      onGenerationChanged: () => generationChanged?.(),
    });
    // The descriptor comes through the authenticated real-host stream, not the directory.
    // Wait outside each RPC's normal deadline only for an explicit terminal-state recovery.
    let remote: ExecutionEnvironmentDescriptor;
    for (;;) {
      try {
        remote = await execution.request<ExecutionEnvironmentDescriptor>(
          WS_METHODS.serverGetEnvironment,
          undefined,
          { ...(signal ? { signal } : {}) },
        );
        break;
      } catch (error) {
        if (!(await execution.waitForRemoteConnectionRecovery(error))) throw error;
      }
    }
    signal?.throwIfAborted();
    if (remote.environmentId !== scope.environmentId)
      throw new Error("The host reported a different execution identity");
    openedDescriptors.set(scope.environmentId, remote);
    return execution;
  } catch (error) {
    await execution?.dispose().catch(() => undefined);
    throw error;
  }
}

export async function bootstrapExecutionContext(): Promise<void> {
  const current = ensureConnections();
  const controller = current.controller();
  const local = await controller.request<ExecutionEnvironmentDescriptor>(
    WS_METHODS.serverGetEnvironment,
  );
  rememberVerifiedController(local);
  const selected = readActiveHost();
  current.setLocalExecution(local.environmentId, controller);
  if (!selected) {
    initializeExecutionContext({ controller: local, execution: local, remote: null });
    return;
  }
  const selectedScope: RemoteExecutionScope | undefined = selected.executionScope;
  if (!selectedScope)
    throw new Error(
      "Choose this host again from local Connections to verify its account and identity.",
    );
  const lifetime = new AbortController();
  bootstrapLifetime = lifetime;
  try {
    const lease = await current.acquire({
      hostId: selected.hostId,
      executionScope: selectedScope,
      signal: lifetime.signal,
    });
    lifetime.signal.throwIfAborted();
    const remote = openedDescriptors.get(selectedScope.environmentId);
    if (!remote) throw new Error("The host reported a different execution identity");
    current.setActiveExecution(lease.transport);
    initializeExecutionContext({
      controller: local,
      execution: remote,
      remote: selectedScope,
      remoteHostId: selected.hostId,
    });
  } catch (error) {
    // A retired bootstrap may reject after a newer owner has already started.
    if (bootstrapLifetime === lifetime) await disposeConnectionClients();
    throw error;
  }
}

export async function disposeConnectionClients(): Promise<void> {
  const current = connections;
  connections = undefined;
  bootstrapLifetime?.abort(new Error("Transport disposed"));
  bootstrapLifetime = undefined;
  unregisterConnectionRecovery?.();
  unregisterConnectionRecovery = undefined;
  generationChanged = undefined;
  openedDescriptors.clear();
  await current?.dispose();
}

/** Controller reconnects refetch account state without touching execution stores. */
export function onControllerStateChange(
  listener: Parameters<WsTransport["onStateChange"]>[0],
): () => void {
  return getConnectionClients().controller.onStateChange(listener, { replayCurrent: true });
}
