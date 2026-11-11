import { useMemo } from "react";
import { useLocalDaemonServerId } from "@/hooks/use-is-local-daemon";
import { useHosts } from "@/runtime/host-runtime";
import {
  useActiveWorkspaceSelection,
  useLastWorkspaceSelection,
} from "@/stores/navigation-active-workspace-store";
import { orderHostsLocalFirst, resolveActiveHostServerId } from "@/types/host-connection";

/** The host a workspace page belongs to: the active workspace's, or the local one. */
export function useActiveHostServerId(): string | null {
  const activeSelection = useActiveWorkspaceSelection();
  const lastSelection = useLastWorkspaceSelection();
  const selection = activeSelection ?? lastSelection;
  const hosts = useHosts();
  const localServerId = useLocalDaemonServerId();
  const orderedHosts = useMemo(
    () => orderHostsLocalFirst(hosts, localServerId),
    [hosts, localServerId],
  );
  const selectedServerId = selection?.serverId ?? null;
  return useMemo(
    () =>
      resolveActiveHostServerId({
        selectedServerId,
        localServerId,
        hosts,
        orderedHosts,
      }),
    [hosts, localServerId, orderedHosts, selectedServerId],
  );
}
