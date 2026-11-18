// FILE: useAgentSkills.ts
// Purpose: Read and write the host's bundled (orchestration) skills. Every
//          write answers with the new status, so the cache is replaced instead
//          of invalidated; failures reject and the panel reports them.
// Layer: Web hook

import type {
  AgentSkillSelection,
  AgentSkillsSaveResult,
  AgentSkillsStatus,
} from "@synara/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";

import { neolixAgentSkillsApi } from "~/lib/neolixAgentSkillsApi";

export const AGENT_SKILLS_QUERY_KEY = ["neolix-agent-skills", "status"] as const;

export interface AgentSkillsController {
  status: AgentSkillsStatus | null;
  isLoading: boolean;
  error: Error | null;
  isWorking: boolean;
  refresh: () => Promise<AgentSkillsStatus | null>;
  reconcile: () => Promise<AgentSkillsStatus>;
  uninstall: () => Promise<AgentSkillsStatus>;
  saveSelection: (
    selection: AgentSkillSelection,
    confirmedRemovals?: readonly string[],
  ) => Promise<AgentSkillsSaveResult>;
}

export function useAgentSkills({
  enabled = true,
}: { enabled?: boolean } = {}): AgentSkillsController {
  const queryClient = useQueryClient();
  const [isWorking, setIsWorking] = useState(false);

  const query = useQuery({
    queryKey: AGENT_SKILLS_QUERY_KEY,
    queryFn: neolixAgentSkillsApi.get,
    enabled,
    staleTime: 0,
    retry: false,
  });

  const apply = useCallback(
    <A extends AgentSkillsStatus>(status: A): A => {
      queryClient.setQueryData<AgentSkillsStatus>(AGENT_SKILLS_QUERY_KEY, status);
      return status;
    },
    [queryClient],
  );

  /** One write at a time; the panel disables every control while this is true. */
  const run = useCallback(
    async <A extends AgentSkillsStatus>(write: () => Promise<A>): Promise<A> => {
      setIsWorking(true);
      try {
        return apply(await write());
      } finally {
        setIsWorking(false);
      }
    },
    [apply],
  );

  const reconcile = useCallback(() => run(() => neolixAgentSkillsApi.reconcile()), [run]);
  const uninstall = useCallback(() => run(() => neolixAgentSkillsApi.uninstall()), [run]);
  const saveSelection = useCallback(
    (selection: AgentSkillSelection, confirmedRemovals?: readonly string[]) =>
      run(() => neolixAgentSkillsApi.saveSelection(selection, confirmedRemovals)),
    [run],
  );

  const refresh = useCallback(async () => {
    const result = await query.refetch();
    return result.data ?? null;
  }, [query]);

  return {
    status: query.data ?? null,
    isLoading: query.isLoading,
    error: query.error instanceof Error ? query.error : null,
    isWorking,
    refresh,
    reconcile,
    uninstall,
    saveSelection,
  };
}
