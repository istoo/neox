// Neox bundled skills → Synara settings RPCs (`neolix.agentSkills.*`).
//
// Each handler forwards one-to-one to the daemon's `agent.skills.*` request.
// The bridge adds no policy: the bundled skills, the choice and the host's skill
// directories are the daemon's. Every write answers with the resulting status,
// so the front end replaces its cache instead of re-reading.
import { NEOLIX_AGENT_SKILLS_WS_METHODS, type AgentSkillsSaveInput } from "@synara/contracts";

import type { BridgeModel } from "./model.ts";
import { fromPromise } from "./rpcErrors.ts";
import type { AnyHandler } from "./stubs.ts";

export function makeAgentSkillsHandlers(model: BridgeModel): Record<string, AnyHandler> {
  const client = model.client;

  return {
    [NEOLIX_AGENT_SKILLS_WS_METHODS.get]: () =>
      fromPromise("neolix.agentSkills.get", () => client.getAgentSkillsStatus()),

    [NEOLIX_AGENT_SKILLS_WS_METHODS.reconcile]: () =>
      fromPromise("neolix.agentSkills.reconcile", () => client.reconcileAgentSkills()),

    [NEOLIX_AGENT_SKILLS_WS_METHODS.uninstall]: () =>
      fromPromise("neolix.agentSkills.uninstall", () => client.uninstallAgentSkills()),

    [NEOLIX_AGENT_SKILLS_WS_METHODS.saveSelection]: (payload) =>
      fromPromise("neolix.agentSkills.saveSelection", () => {
        const input = payload as AgentSkillsSaveInput;
        // The contract's schema arrays are readonly; the daemon's wire type is mutable.
        const selection = input.selection as unknown as Parameters<
          typeof client.saveAgentSkillsSelection
        >[0];
        return client.saveAgentSkillsSelection(selection, input.confirmedRemovals);
      }),
  };
}
