// FILE: useAgentConnect.ts
// Purpose: Read and write Agent Connect for the execution host. Every write
//          answers with the new snapshot, so the cache is replaced instead of
//          invalidated (the daemon pushes no change event for this surface).
// Layer: Web hook

import type {
  AgentConnectLayoutInput,
  AgentConnectModelsInput,
  AgentConnectSnapshot,
  AgentConnectStaleKind,
} from "@synara/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { neolixAgentConnectApi } from "~/lib/neolixAgentConnectApi";

export const AGENT_CONNECT_QUERY_KEY = ["neolix-agent-connect", "snapshot"] as const;

export interface AgentConnectController {
  snapshot: AgentConnectSnapshot | null;
  isLoading: boolean;
  error: Error | null;
  refresh: () => Promise<AgentConnectSnapshot | null>;
  setConnected: (
    provider: string,
    connected: boolean,
    model?: string | null,
  ) => Promise<AgentConnectSnapshot | null>;
  setField: (
    provider: string,
    field: string,
    value: string,
  ) => Promise<AgentConnectSnapshot | null>;
  saveProfile: (name: string) => Promise<AgentConnectSnapshot | null>;
  applyProfile: (name: string) => Promise<AgentConnectSnapshot | null>;
  deleteProfile: (name: string) => Promise<AgentConnectSnapshot | null>;
  renameProfile: (name: string, to: string) => Promise<AgentConnectSnapshot | null>;
  setLayout: (input: AgentConnectLayoutInput) => Promise<AgentConnectSnapshot | null>;
  setModels: (provider: string, hidden: string[]) => Promise<AgentConnectSnapshot | null>;
  setShellFunction: (provider: string, enabled: boolean) => Promise<AgentConnectSnapshot | null>;
  restartStale: (
    provider: string,
    kind: AgentConnectStaleKind,
  ) => Promise<AgentConnectSnapshot | null>;
}

export function useAgentConnect({
  enabled = true,
}: { enabled?: boolean } = {}): AgentConnectController {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: AGENT_CONNECT_QUERY_KEY,
    queryFn: async () => (await neolixAgentConnectApi.get()).snapshot,
    enabled,
    staleTime: 5_000,
  });

  const apply = useCallback(
    (snapshot: AgentConnectSnapshot): AgentConnectSnapshot => {
      queryClient.setQueryData<AgentConnectSnapshot>(AGENT_CONNECT_QUERY_KEY, snapshot);
      return snapshot;
    },
    [queryClient],
  );

  const call = useCallback(
    async (
      run: () => Promise<{ snapshot: AgentConnectSnapshot }>,
    ): Promise<AgentConnectSnapshot | null> => apply((await run()).snapshot),
    [apply],
  );

  const setConnected = useCallback(
    (provider: string, connected: boolean, model?: string | null) =>
      call(() =>
        neolixAgentConnectApi.set({
          provider,
          connected,
          ...(model === null || model === undefined ? {} : { model }),
        }),
      ),
    [call],
  );

  const setField = useCallback(
    (provider: string, field: string, value: string) =>
      call(() => neolixAgentConnectApi.set({ provider, connected: false, field, value })),
    [call],
  );

  const saveProfile = useCallback(
    (name: string) => call(() => neolixAgentConnectApi.saveProfile(name)),
    [call],
  );
  const applyProfile = useCallback(
    (name: string) => call(() => neolixAgentConnectApi.applyProfile(name)),
    [call],
  );
  const deleteProfile = useCallback(
    (name: string) => call(() => neolixAgentConnectApi.deleteProfile(name)),
    [call],
  );
  const renameProfile = useCallback(
    (name: string, to: string) => call(() => neolixAgentConnectApi.renameProfile({ name, to })),
    [call],
  );
  const setLayout = useCallback(
    (input: AgentConnectLayoutInput) => call(() => neolixAgentConnectApi.setLayout(input)),
    [call],
  );
  const setModels = useCallback(
    (provider: string, hidden: string[]): Promise<AgentConnectSnapshot | null> => {
      const input: AgentConnectModelsInput = { provider, hidden };
      return call(() => neolixAgentConnectApi.setModels(input));
    },
    [call],
  );
  const setShellFunction = useCallback(
    (provider: string, nextEnabled: boolean) =>
      call(() => neolixAgentConnectApi.setShell({ provider, enabled: nextEnabled })),
    [call],
  );
  const restartStale = useCallback(
    (provider: string, kind: AgentConnectStaleKind) =>
      call(() => neolixAgentConnectApi.restartStale({ provider, kind })),
    [call],
  );

  const refresh = useCallback(async () => {
    const result = await query.refetch();
    return result.data ?? null;
  }, [query]);

  return {
    snapshot: query.data ?? null,
    isLoading: query.isLoading,
    error: query.error instanceof Error ? query.error : null,
    refresh,
    setConnected,
    setField,
    saveProfile,
    applyProfile,
    deleteProfile,
    renameProfile,
    setLayout,
    setModels,
    setShellFunction,
    restartStale,
  };
}
