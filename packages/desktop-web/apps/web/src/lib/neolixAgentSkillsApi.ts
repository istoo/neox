// FILE: neolixAgentSkillsApi.ts
// Purpose: Typed calls into the bridge's `neolix.agentSkills.*` surface. The
//          bridge forwards each call to the Neox daemon's `agent.skills.*`
//          requests, so these wrappers stay thin and shape-free.
// Layer: Web transport adapter

import {
  NEOLIX_AGENT_SKILLS_WS_METHODS,
  type AgentSkillSelection,
  type AgentSkillsSaveResult,
  type AgentSkillsStatus,
} from "@synara/contracts";

import { getConnectionClients } from "~/lib/hosts/connectionClients";

function request<T>(method: string, payload?: unknown): Promise<T> {
  const body = payload === undefined ? {} : JSON.parse(JSON.stringify(payload));
  return getConnectionClients().execution.request<T>(method, body);
}

export const neolixAgentSkillsApi = {
  get: () => request<AgentSkillsStatus>(NEOLIX_AGENT_SKILLS_WS_METHODS.get),
  reconcile: () => request<AgentSkillsStatus>(NEOLIX_AGENT_SKILLS_WS_METHODS.reconcile),
  uninstall: () => request<AgentSkillsStatus>(NEOLIX_AGENT_SKILLS_WS_METHODS.uninstall),
  /** `confirmedRemovals` names directories the user already agreed to delete. */
  saveSelection: (selection: AgentSkillSelection, confirmedRemovals?: readonly string[]) =>
    request<AgentSkillsSaveResult>(NEOLIX_AGENT_SKILLS_WS_METHODS.saveSelection, {
      selection,
      ...(confirmedRemovals === undefined ? {} : { confirmedRemovals: [...confirmedRemovals] }),
    }),
};
