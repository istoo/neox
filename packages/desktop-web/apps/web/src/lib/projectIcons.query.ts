// FILE: projectIcons.query.ts
// Purpose: Shared access to a daemon's project icon. A custom upload is host
//   state, not local UI state, so every row that shows the project reads the
//   same per-environment cache and one write updates them together.
// Layer: Web project icon store

import {
  NEOLIX_PROJECT_ICON_WS_METHODS,
  type ProjectIconGetResult,
  type ProjectIconRequestResult,
  type ProjectIconSource,
} from "@synara/contracts";
import { scopedKey } from "@synara/client-runtime/scopedKeys";
import { useCallback, useEffect, useState } from "react";

import type { EnvironmentLease } from "@synara/client-runtime/environmentConnections";

import {
  acquireEnvironment,
  forEnvironment,
  getConnectionClients,
} from "~/lib/hosts/connectionClients";
import { readExecutionContext } from "~/lib/hosts/executionContext";
import { readWorkspaceSessions } from "~/lib/hosts/workspaceSessions";
import { projectIconDataUri } from "~/lib/projectIcons.logic";
import type { WsTransport } from "~/wsTransport";

export interface ProjectIconRef {
  readonly environmentId: string;
  readonly projectId?: string | undefined;
  /** Legacy hosts resolve the automatic icon from the project's cwd. */
  readonly cwd?: string | undefined;
}

const entries = new Map<string, ProjectIconGetResult>();
const inflight = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
/**
 * Hosts that answered `supportsCustomIcons: false`. Their icon reads use the
 * legacy cwd lookup from then on, so the capability is gated once per host.
 */
const legacyHosts = new Set<string>();

function publish(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function entryKey(ref: ProjectIconRef): string {
  return scopedKey(ref.environmentId, ref.projectId ?? `cwd:${ref.cwd ?? ""}`);
}

/**
 * Held for the window's lifetime: the icon cache is app-level, so releasing a
 * host channel after one read only reopens it on the next glyph.
 */
const hostLeases = new Map<string, EnvironmentLease>();
const openingHosts = new Map<string, Promise<WsTransport | undefined>>();

async function transportFor(environmentId: string): Promise<WsTransport | undefined> {
  const execution = getConnectionClients().execution;
  const localId = readExecutionContext()?.execution.environmentId;
  const open = forEnvironment(environmentId);
  if (open) return open;
  if (localId === undefined || localId === environmentId) return execution;
  const held = hostLeases.get(environmentId);
  if (held) return held.transport;
  const pending = openingHosts.get(environmentId);
  if (pending) return pending;
  const session = readWorkspaceSessions().find(
    (entry) => entry.host.executionScope.environmentId === environmentId,
  );
  if (!session) return undefined;
  const opening = acquireEnvironment({
    hostId: session.host.hostId,
    executionScope: session.host.executionScope,
  })
    .then((lease) => {
      hostLeases.set(environmentId, lease);
      return lease.transport;
    })
    .catch(() => undefined)
    .finally(() => {
      openingHosts.delete(environmentId);
    });
  openingHosts.set(environmentId, opening);
  return opening;
}

function load(ref: ProjectIconRef, force = false): Promise<void> {
  const key = entryKey(ref);
  if (!force && entries.has(key)) return Promise.resolve();
  const existing = inflight.get(key);
  if (existing) return existing;
  const request = (async () => {
    const transport = await transportFor(ref.environmentId);
    if (!transport) return;
    try {
      if (ref.projectId && !legacyHosts.has(ref.environmentId)) {
        const result = await transport.request<ProjectIconGetResult>(
          NEOLIX_PROJECT_ICON_WS_METHODS.get,
          { projectId: ref.projectId },
        );
        if (result.supportsCustomIcons) {
          entries.set(key, result);
          publish();
          return;
        }
        legacyHosts.add(ref.environmentId);
      }
      if (!ref.cwd) return;
      const legacy = await transport.request<ProjectIconRequestResult>(
        NEOLIX_PROJECT_ICON_WS_METHODS.request,
        { cwd: ref.cwd },
      );
      entries.set(key, { icon: legacy.icon, supportsCustomIcons: false });
      publish();
    } catch {
      // A host that predates custom icons answers through the legacy cwd lookup
      // when it renders a glyph; failing here must not break the folder.
    }
  })().finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, request);
  return request;
}

export function useProjectIcon(ref: ProjectIconRef): {
  readonly iconDataUri: string | null;
  readonly supportsCustomIcons: boolean;
} {
  const key = entryKey(ref);
  const [entry, setEntry] = useState<ProjectIconGetResult | undefined>(() => entries.get(key));
  useEffect(() => {
    let active = true;
    const sync = () => {
      if (active) setEntry(entries.get(key));
    };
    sync();
    const unsubscribe = subscribe(sync);
    void load(ref);
    return () => {
      active = false;
      unsubscribe();
    };
    // The ref is fully described by the scoped key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return {
    iconDataUri: projectIconDataUri(entry?.icon),
    supportsCustomIcons: entry?.supportsCustomIcons ?? false,
  };
}

/** One write; every glyph of the project switches together. */
export function useSetProjectIcon() {
  return useCallback(async (projectId: string, source: ProjectIconSource) => {
    await getConnectionClients().execution.request(NEOLIX_PROJECT_ICON_WS_METHODS.set, {
      projectId,
      source,
    });
    const environmentId = readExecutionContext()?.execution.environmentId;
    if (environmentId) {
      await load({ environmentId, projectId }, true);
    }
  }, []);
}
