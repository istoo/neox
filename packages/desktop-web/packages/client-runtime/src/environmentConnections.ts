// FILE: environmentConnections.ts
// Purpose: One transport per environment, opened on demand and reference-counted.
//   The local environment shares the controller socket; a connected host uses
//   its existing /rpc/remote/<hostId>/rpc channel. Releasing a lease closes only
//   the socket this registry opened — it never disconnects the host.
// Layer: Client runtime connection registry

import type { RemoteExecutionScope } from "@synara/contracts";

import type { WsTransport } from "./wsTransport";

export interface EnvironmentConnectionTarget {
  readonly hostId: string;
  readonly executionScope: RemoteExecutionScope;
  /** Aborts an in-flight host connection when the owning lifetime ends. */
  readonly signal?: AbortSignal | undefined;
}

export interface EnvironmentConnectionsOptions {
  readonly createController: () => WsTransport;
  /** Opens a channel for one host. Must not call the host disconnect RPC. */
  readonly connectEnvironment: (target: EnvironmentConnectionTarget) => Promise<WsTransport>;
  readonly disposeTransport?: (transport: WsTransport) => Promise<void> | void;
}

export interface EnvironmentLease {
  readonly environmentId: string;
  readonly transport: WsTransport;
  /** Idempotent. The last release closes the transport this registry opened. */
  release(): Promise<void>;
}

interface EnvironmentEntry {
  readonly hostId: string;
  readonly transport: WsTransport;
  leases: number;
}

export class EnvironmentMismatchError extends Error {
  constructor(environmentId: string) {
    super(`Environment ${environmentId} is already connected to a different host.`);
    this.name = "EnvironmentMismatchError";
  }
}

export class EnvironmentConnections {
  private controllerTransport: WsTransport | null = null;
  private activeExecution: WsTransport | null = null;
  private localEnvironmentId: string | null = null;
  private readonly entries = new Map<string, EnvironmentEntry>();
  private readonly opening = new Map<string, Promise<EnvironmentEntry>>();
  private disposed = false;

  constructor(private readonly options: EnvironmentConnectionsOptions) {}

  controller(): WsTransport {
    if (this.disposed) throw new Error("Environment connections disposed");
    this.controllerTransport ??= this.options.createController();
    return this.controllerTransport;
  }

  /** The selected execution socket, or the controller before a host is selected. */
  execution(): WsTransport {
    return this.activeExecution ?? this.controller();
  }

  /** The local daemon is the execution environment when no host is selected. */
  setLocalExecution(environmentId: string, transport: WsTransport): void {
    this.localEnvironmentId = environmentId;
    if (this.activeExecution === null) this.activeExecution = transport;
  }

  /** Adopt an acquired host transport as the selected execution socket. */
  setActiveExecution(transport: WsTransport): void {
    this.activeExecution = transport;
  }

  forEnvironment(environmentId: string): WsTransport | undefined {
    if (environmentId === this.localEnvironmentId) return this.controllerTransport ?? undefined;
    return this.entries.get(environmentId)?.transport;
  }

  /**
   * Opens or reuses one environment channel. Concurrent callers share a single
   * connect, and the returned lease holds a reference until released.
   */
  async acquire(target: EnvironmentConnectionTarget): Promise<EnvironmentLease> {
    if (this.disposed) throw new Error("Environment connections disposed");
    const environmentId = target.executionScope.environmentId;
    const existing = this.entries.get(environmentId);
    if (existing) {
      if (existing.hostId !== target.hostId) throw new EnvironmentMismatchError(environmentId);
      existing.leases += 1;
      return this.leaseFor(environmentId, existing);
    }

    let pending = this.opening.get(environmentId);
    if (!pending) {
      pending = this.open(environmentId, target);
      this.opening.set(environmentId, pending);
    }
    let entry: EnvironmentEntry;
    try {
      entry = await pending;
    } finally {
      if (this.opening.get(environmentId) === pending) this.opening.delete(environmentId);
    }
    entry.leases += 1;
    return this.leaseFor(environmentId, entry);
  }

  /** Closes every transport this registry opened, then the controller. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const transports = new Set<WsTransport>();
    for (const entry of this.entries.values()) transports.add(entry.transport);
    this.entries.clear();
    this.opening.clear();
    if (this.controllerTransport) transports.add(this.controllerTransport);
    this.controllerTransport = null;
    this.activeExecution = null;
    await Promise.all([...transports].map((transport) => this.disposeOne(transport)));
  }

  private async open(
    environmentId: string,
    target: EnvironmentConnectionTarget,
  ): Promise<EnvironmentEntry> {
    const transport = await this.options.connectEnvironment(target);
    // A dispose may land while the connect is in flight; nobody owns the new
    // socket then, so close it rather than leaking it.
    if (this.disposed) {
      await this.disposeOne(transport);
      throw new Error("Environment connections disposed");
    }
    const entry: EnvironmentEntry = { hostId: target.hostId, transport, leases: 0 };
    this.entries.set(environmentId, entry);
    return entry;
  }

  private leaseFor(environmentId: string, entry: EnvironmentEntry): EnvironmentLease {
    let released = false;
    return {
      environmentId,
      transport: entry.transport,
      release: async () => {
        if (released) return;
        released = true;
        entry.leases -= 1;
        if (entry.leases > 0) return;
        if (this.entries.get(environmentId) === entry) this.entries.delete(environmentId);
        if (this.activeExecution === entry.transport) this.activeExecution = null;
        await this.disposeOne(entry.transport);
      },
    };
  }

  private async disposeOne(transport: WsTransport): Promise<void> {
    if (this.options.disposeTransport) {
      await this.options.disposeTransport(transport);
      return;
    }
    await transport.dispose();
  }
}
