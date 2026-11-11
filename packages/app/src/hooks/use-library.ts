import { useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { LibrarySnapshot } from "@neolix/protocol/library";
import type { DaemonClient } from "@neolix/client/internal/daemon-client";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useHostFeature } from "@/runtime/host-features";

export interface UseLibraryResult {
  library: LibrarySnapshot | null;
  isLoading: boolean;
  error: Error | null;
  supported: boolean;
  isConnected: boolean;
  client: DaemonClient | null;
  applyLibrary: (library: LibrarySnapshot) => void;
  refresh: () => void;
}

export function libraryQueryKey(serverId: string | null) {
  return ["library", serverId] as const;
}

/** The Library page's data, read once per host and updated by each change. */
export function useLibrary(serverId: string): UseLibraryResult {
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const supported = useHostFeature(serverId, "library");
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => libraryQueryKey(serverId), [serverId]);

  const query = useFetchQuery({
    queryKey,
    enabled: Boolean(serverId && client && isConnected && supported),
    retry: false,
    dataShape: "value",
    staleTimeMs: 30_000,
    queryFn: async (): Promise<LibrarySnapshot> => {
      if (!client) {
        throw new Error("The host is not connected");
      }
      const result = await client.getLibrary();
      return result.library;
    },
  });

  const applyLibrary = useCallback(
    (library: LibrarySnapshot) => {
      queryClient.setQueryData(queryKey, library);
    },
    [queryClient, queryKey],
  );

  const refresh = useCallback(() => {
    void query.refetch();
  }, [query]);

  return {
    library: query.data ?? null,
    isLoading: query.isLoading,
    error: query.error,
    supported,
    isConnected,
    client,
    applyLibrary,
    refresh,
  };
}
