import type { AgentScreenMissingState } from "@/hooks/use-agent-screen-state-machine";

export type AgentLookupTag = "idle" | "loading" | "not_found" | "error";

export function isAgentLookupSettled(tag: AgentLookupTag): boolean {
  return tag === "loading" || tag === "not_found" || tag === "error";
}

export function reconcileMissingAgentStateWithPresentAgent(
  state: AgentScreenMissingState,
): AgentScreenMissingState {
  if (state.kind === "resolving" || state.kind === "not_found") {
    return { kind: "idle" };
  }
  return state;
}

export function clearHistorySyncErrorAfterSuccessfulSync(
  state: AgentScreenMissingState,
): AgentScreenMissingState {
  if (state.kind === "error") {
    return { kind: "idle" };
  }
  return state;
}
