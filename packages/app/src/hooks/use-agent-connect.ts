import { useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { AgentConnectSnapshot } from "@neolix/protocol/agent-connect";
import { useReplicaQuery } from "@/data/query";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";

interface UseAgentConnectResult {
  snapshot: AgentConnectSnapshot | null;
  isLoading: boolean;
  /** False on hosts that predate the agent-connect RPCs. */
  supported: boolean;
  error: Error | null;
  refresh: () => Promise<AgentConnectSnapshot | null>;
  setConnected: (
    provider: string,
    connected: boolean,
    model?: string | null,
  ) => Promise<AgentConnectSnapshot | null>;
  saveProfile: (name: string) => Promise<AgentConnectSnapshot | null>;
  applyProfile: (name: string) => Promise<AgentConnectSnapshot | null>;
  deleteProfile: (name: string) => Promise<AgentConnectSnapshot | null>;
  renameProfile: (name: string, to: string) => Promise<AgentConnectSnapshot | null>;
  setLayout: (input: { order: string[]; hidden: string[] }) => Promise<AgentConnectSnapshot | null>;
  setShellFunction: (provider: string, enabled: boolean) => Promise<AgentConnectSnapshot | null>;
  setModels: (provider: string, hidden: string[]) => Promise<AgentConnectSnapshot | null>;
  /** One of the agent's own fields; "" puts it back to the agent's default. */
  setField: (
    provider: string,
    field: string,
    value: string,
  ) => Promise<AgentConnectSnapshot | null>;
  restartStale: (
    provider: string,
    kind: "app" | "ide" | "daemon" | "cli",
  ) => Promise<AgentConnectSnapshot | null>;
}

export function agentConnectQueryKey(serverId: string | null): readonly unknown[] {
  return ["agent-connect", serverId ?? ""];
}

/** Settings → Use → Agent: the gateway wiring of each installed agent. */
export function useAgentConnect(serverId: string | null): UseAgentConnectResult {
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const supported = useHostFeature(serverId, "agentConnect");
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => agentConnectQueryKey(serverId), [serverId]);
  const enabled = Boolean(serverId && client && isConnected && supported);

  const query = useReplicaQuery({
    queryKey,
    enabled,
    // Each write answers with the new snapshot, so there is no server push
    // for this query; the event name is inert bookkeeping for the replica.
    pushEvent: "agent.connect.get.response",
    queryFn: async (): Promise<AgentConnectSnapshot> => {
      if (!client) {
        throw new Error("Host not connected");
      }
      const result = await client.getAgentConnect();
      return result.snapshot;
    },
  });

  const apply = useCallback(
    (snapshot: AgentConnectSnapshot): AgentConnectSnapshot => {
      queryClient.setQueryData(queryKey, snapshot);
      return snapshot;
    },
    [queryClient, queryKey],
  );

  const call = useCallback(
    async (
      run: (
        activeClient: NonNullable<typeof client>,
      ) => Promise<{ snapshot: AgentConnectSnapshot }>,
    ): Promise<AgentConnectSnapshot | null> => {
      if (!client) return null;
      return apply((await run(client)).snapshot);
    },
    [apply, client],
  );

  const setConnected = useCallback(
    (provider: string, connected: boolean, model?: string | null) =>
      call((activeClient) =>
        activeClient.setAgentConnect({
          provider,
          connected,
          ...(model === null || model === undefined ? {} : { model }),
        }),
      ),
    [call],
  );

  const saveProfile = useCallback(
    (name: string) => call((activeClient) => activeClient.saveAgentConnectProfile(name)),
    [call],
  );
  const applyProfile = useCallback(
    (name: string) => call((activeClient) => activeClient.applyAgentConnectProfile(name)),
    [call],
  );
  const deleteProfile = useCallback(
    (name: string) => call((activeClient) => activeClient.deleteAgentConnectProfile(name)),
    [call],
  );
  const renameProfile = useCallback(
    (name: string, to: string) =>
      call((activeClient) => activeClient.renameAgentConnectProfile(name, to)),
    [call],
  );
  const setLayout = useCallback(
    (input: { order: string[]; hidden: string[] }) =>
      call((activeClient) => activeClient.setAgentConnectLayout(input)),
    [call],
  );
  const setShellFunction = useCallback(
    (provider: string, nextEnabled: boolean) =>
      call((activeClient) => activeClient.setAgentConnectShell({ provider, enabled: nextEnabled })),
    [call],
  );
  const setModels = useCallback(
    (provider: string, hidden: string[]) =>
      call((activeClient) => activeClient.setAgentConnectModels({ provider, hidden })),
    [call],
  );
  const setField = useCallback(
    (provider: string, field: string, value: string) =>
      call((activeClient) =>
        activeClient.setAgentConnect({ provider, connected: false, field, value }),
      ),
    [call],
  );
  const restartStale = useCallback(
    (provider: string, kind: "app" | "ide" | "daemon" | "cli") =>
      call((activeClient) => activeClient.restartAgentConnectStale({ provider, kind })),
    [call],
  );
  const refresh = useCallback(async () => {
    const result = await query.refetch();
    return result.data ?? null;
  }, [query]);

  return {
    snapshot: query.data ?? null,
    isLoading: query.isLoading,
    supported,
    error: query.error instanceof Error ? query.error : null,
    refresh,
    setConnected,
    saveProfile,
    applyProfile,
    deleteProfile,
    renameProfile,
    setLayout,
    setShellFunction,
    setModels,
    setField,
    restartStale,
  };
}
