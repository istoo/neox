// FILE: useAgentProfiles.ts
// Purpose: Read and write the host's agent profiles (daemon config `agentProfiles`) through
//          the same host-config query the settings panels already share.
// Layer: Web data hook
// Exports: useAgentProfiles

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { hostConfigQueryKey } from "~/components/settings/hostSettingsModel";
import { getHostConfig, patchHostConfig, type NeolixAgentProfileWire } from "~/lib/neolixHostApi";

export interface UseAgentProfilesResult {
  /** Null until the host config has arrived. */
  readonly profiles: ReadonlyArray<NeolixAgentProfileWire> | null;
  readonly isLoading: boolean;
  readonly error: string | null;
  /** Writes the whole list: the daemon has no per-profile RPC. */
  readonly saveProfiles: (
    next: ReadonlyArray<NeolixAgentProfileWire>,
  ) => Promise<ReadonlyArray<NeolixAgentProfileWire>>;
}

export function useAgentProfiles(active = true): UseAgentProfilesResult {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: hostConfigQueryKey,
    queryFn: getHostConfig,
    enabled: active,
    staleTime: 5_000,
  });

  const saveProfiles = useCallback(
    async (next: ReadonlyArray<NeolixAgentProfileWire>) => {
      const saved = await patchHostConfig({ agentProfiles: next });
      queryClient.setQueryData(hostConfigQueryKey, saved);
      return saved.config.agentProfiles ?? [];
    },
    [queryClient],
  );

  return {
    profiles: query.data?.config.agentProfiles ?? null,
    isLoading: query.isLoading,
    error: query.error
      ? query.error instanceof Error
        ? query.error.message
        : String(query.error)
      : null,
    saveProfiles,
  };
}
