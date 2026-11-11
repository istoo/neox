import { useCallback, useMemo } from "react";
import type { AgentInstallEntry, AgentInstallRunResult } from "@neolix/protocol/agent-install";
import { useFetchQuery } from "@/data/query";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";

interface UseAgentInstallsResult {
  entries: AgentInstallEntry[];
  isLoading: boolean;
  /** False on hosts that predate the agent-install RPCs. */
  supported: boolean;
  error: Error | null;
  run: (provider: string, commandId: string) => Promise<AgentInstallRunResult>;
}

export function agentInstallQueryKey(serverId: string | null): readonly unknown[] {
  return ["agent-installs", serverId ?? ""];
}

const NO_ENTRIES: AgentInstallEntry[] = [];

/** Settings → Use → Agent: the install commands the host can run for a CLI. */
export function useAgentInstalls(serverId: string | null): UseAgentInstallsResult {
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const supported = useHostFeature(serverId, "agentInstall");
  const queryKey = useMemo(() => agentInstallQueryKey(serverId), [serverId]);
  const enabled = Boolean(serverId && client && isConnected && supported);

  const query = useFetchQuery({
    queryKey,
    enabled,
    dataShape: "list",
    staleTimeMs: 5 * 60 * 1000,
    queryFn: async (): Promise<AgentInstallEntry[]> => {
      if (!client) {
        throw new Error("Host not connected");
      }
      const result = await client.listAgentInstalls();
      return result.entries;
    },
  });

  const run = useCallback(
    async (provider: string, commandId: string): Promise<AgentInstallRunResult> => {
      if (!client) {
        throw new Error("Host not connected");
      }
      return client.runAgentInstall({ provider, commandId });
    },
    [client],
  );

  return {
    entries: query.data ?? NO_ENTRIES,
    isLoading: query.isLoading,
    supported,
    error: query.error instanceof Error ? query.error : null,
    run,
  };
}
