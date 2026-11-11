import { useCallback, useEffect, useRef, useState } from "react";
import { isElectronRuntime } from "@/desktop/host";
import { useDesktopSettings } from "@/desktop/settings/desktop-settings";
import { useDesktopAppUpdater } from "@/desktop/updates/use-desktop-app-updater";
import { useHostRuntimeClient, useHosts } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";

const POLL_MS = 5_000;

/**
 * myna's AutoRestart: restart into an update that was downloaded by itself,
 * once the gateway has nothing in flight. Neolix adds the condition the user
 * asked for: no agent may be running, since a restart ends its turn.
 */
export function AutoRestartWatcher() {
  if (!isElectronRuntime()) {
    return null;
  }
  return <AutoRestartInner />;
}

function AutoRestartInner() {
  const { settings } = useDesktopSettings();
  const { availableUpdate, installUpdate } = useDesktopAppUpdater();
  const hosts = useHosts();
  const agentsBusy = useSessionStore((state) =>
    Object.values(state.sessions).some((session) =>
      [...session.agents.values()].some(
        (agent) => agent.status === "running" || agent.status === "initializing",
      ),
    ),
  );
  const [busyHosts, setBusyHosts] = useState<ReadonlySet<string>>(() => new Set());
  const triggered = useRef(false);
  const ready = availableUpdate?.readyToInstall === true;

  const reportBusy = useCallback((serverId: string, busy: boolean) => {
    setBusyHosts((current) => {
      const next = new Set(current);
      if (busy) {
        next.add(serverId);
      } else {
        next.delete(serverId);
      }
      return next.size === current.size && [...next].every((id) => current.has(id))
        ? current
        : next;
    });
  }, []);

  useEffect(() => {
    if (!settings.autoRestartOnUpdate || !ready || agentsBusy || busyHosts.size > 0) {
      return;
    }
    if (triggered.current) {
      return;
    }
    triggered.current = true;
    void installUpdate();
  }, [agentsBusy, busyHosts, installUpdate, ready, settings.autoRestartOnUpdate]);

  if (!settings.autoRestartOnUpdate || !ready) {
    return null;
  }
  return (
    <>
      {hosts.map((host) => (
        <GatewayBusyProbe key={host.serverId} serverId={host.serverId} onChange={reportBusy} />
      ))}
    </>
  );
}

/** Reports whether a host's gateway has a request in flight. */
function GatewayBusyProbe({
  serverId,
  onChange,
}: {
  serverId: string;
  onChange: (serverId: string, busy: boolean) => void;
}) {
  const client = useHostRuntimeClient(serverId);

  useEffect(() => {
    if (client === null) {
      onChange(serverId, false);
      return;
    }
    let cancelled = false;
    const read = async () => {
      try {
        const trace = await client.getGatewayTrace();
        if (!cancelled) {
          onChange(serverId, trace.trace.stats.active > 0);
        }
      } catch {
        // A host without the trace RPC has no gateway to wait for.
        if (!cancelled) {
          onChange(serverId, false);
        }
      }
    };
    void read();
    const timer = setInterval(() => void read(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [client, onChange, serverId]);

  return null;
}
