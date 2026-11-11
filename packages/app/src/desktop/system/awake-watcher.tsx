import { useCallback, useEffect, useState } from "react";
import { getIsElectron } from "@/constants/platform";
import { invokeDesktopCommand } from "@/desktop/electron/invoke";
import { useDesktopSettings } from "@/desktop/settings/desktop-settings";
import { useHostRuntimeClient, useHosts } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";

const REPORT_MS = 5_000;

/**
 * myna's awake (magpie/internal/awake/awake.go:61): with KeepAwake on, sleep
 * is held off only while a request is in flight, an agent is running, or one
 * stopped less than the grace period ago. This reports that state to the
 * desktop process, which owns the blocker and the grace timer.
 */
export function AwakeWatcher() {
  if (!getIsElectron()) {
    return null;
  }
  return <AwakeWatcherInner />;
}

function AwakeWatcherInner() {
  const { settings } = useDesktopSettings();
  const enabled = settings.preventSleep !== "off";
  const hosts = useHosts();
  const agentsBusy = useSessionStore((state) =>
    Object.values(state.sessions).some((session) =>
      [...session.agents.values()].some(
        (agent) => agent.status === "running" || agent.status === "initializing",
      ),
    ),
  );
  const [busyHosts, setBusyHosts] = useState<ReadonlySet<string>>(() => new Set());

  const reportHost = useCallback((serverId: string, busy: boolean) => {
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

  const busy = agentsBusy || busyHosts.size > 0;

  useEffect(() => {
    if (!enabled) {
      return;
    }
    void invokeDesktopCommand("desktop_report_agent_activity", { busy }).catch(() => undefined);
    if (!busy) {
      return;
    }
    // Keep the report fresh while work continues, so the desktop process
    // knows the renderer is alive and this is not a stale "busy".
    const timer = setInterval(() => {
      void invokeDesktopCommand("desktop_report_agent_activity", { busy: true }).catch(
        () => undefined,
      );
    }, REPORT_MS);
    return () => clearInterval(timer);
  }, [busy, enabled]);

  if (!enabled) {
    return null;
  }
  return (
    <>
      {hosts.map((host) => (
        <GatewayBusyProbe key={host.serverId} serverId={host.serverId} onChange={reportHost} />
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
    const timer = setInterval(() => void read(), REPORT_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [client, onChange, serverId]);

  return null;
}
