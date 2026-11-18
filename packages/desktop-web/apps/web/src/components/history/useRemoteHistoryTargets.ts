// FILE: useRemoteHistoryTargets.ts
// Purpose: Hold one acquired channel per connected host while History is open,
//   so reading another computer's sessions never depends on its workspace frame
//   and never disconnects the host.
// Layer: History screen hook

import type { EnvironmentLease } from "@synara/client-runtime/environmentConnections";
import { useEffect, useMemo, useRef, useState } from "react";

import { acquireEnvironment } from "~/lib/hosts/connectionClients";
import type { WorkspaceSession } from "~/lib/hosts/workspaceSessions";
import type { WsTransport } from "~/wsTransport";

export interface RemoteHistoryTarget {
  readonly environmentId: string;
  readonly hostName: string;
  readonly transport: WsTransport;
}

interface HeldLease {
  readonly lease: EnvironmentLease;
  readonly hostName: string;
}

export function useRemoteHistoryTargets(
  sessions: readonly WorkspaceSession[],
): readonly RemoteHistoryTarget[] {
  const hostKey = sessions
    .map((session) => `${session.host.executionScope.environmentId}:${session.host.hostId}`)
    .join("|");
  const leases = useRef(new Map<string, HeldLease>());
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const wanted = new Map(
      sessions.map((session) => [
        session.host.executionScope.environmentId,
        { session, hostName: session.host.hostName },
      ]),
    );

    for (const [environmentId, held] of leases.current) {
      if (wanted.has(environmentId)) continue;
      leases.current.delete(environmentId);
      void held.lease.release();
    }

    for (const [environmentId, { session, hostName }] of wanted) {
      if (leases.current.has(environmentId)) continue;
      void acquireEnvironment({
        hostId: session.host.hostId,
        executionScope: session.host.executionScope,
      })
        .then((lease) => {
          if (cancelled) {
            void lease.release();
            return;
          }
          leases.current.set(environmentId, { lease, hostName });
          setVersion((current) => current + 1);
        })
        .catch(() => {
          // A host that is offline keeps its frame rows; History simply omits it.
        });
    }
    return () => {
      cancelled = true;
    };
    // hostKey collapses identity churn in the sessions array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostKey]);

  useEffect(() => {
    const held = leases.current;
    return () => {
      for (const entry of held.values()) void entry.lease.release();
      held.clear();
    };
  }, []);

  return useMemo(
    () =>
      [...leases.current.entries()].map(([environmentId, held]) => ({
        environmentId,
        hostName: held.hostName,
        transport: held.lease.transport,
      })),
    // version changes when a new lease arrives; hostKey when hosts leave.
    [hostKey, version],
  );
}
