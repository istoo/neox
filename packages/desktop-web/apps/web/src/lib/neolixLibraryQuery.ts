// FILE: neolixLibraryQuery.ts
// Purpose: Shared React Query keys/helpers for the Neox Library settings panels.
// Layer: Web query support

import type { LibraryMutationResult, LibrarySnapshotResult } from "@synara/contracts";
import { type QueryClient, useQuery } from "@tanstack/react-query";

import { neolixLibraryApi } from "./neolixLibraryClient";

export const NEOLIX_LIBRARY_QUERY_KEY = ["neolix", "library"] as const;

export function neolixLibraryQueryOptions() {
  return {
    queryKey: NEOLIX_LIBRARY_QUERY_KEY,
    queryFn: () => neolixLibraryApi.get(),
    staleTime: 5_000,
  } as const;
}

export function useNeolixLibrary() {
  return useQuery(neolixLibraryQueryOptions());
}

/** Writes a mutation's snapshot into the cache so every panel updates at once. */
export function applyLibraryMutation(
  queryClient: QueryClient,
  result: LibraryMutationResult,
): void {
  const snapshot: LibrarySnapshotResult = { library: result.library };
  queryClient.setQueryData(NEOLIX_LIBRARY_QUERY_KEY, snapshot);
}
