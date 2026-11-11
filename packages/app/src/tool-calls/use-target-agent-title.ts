import type { ToolCallDetail } from "@neolix/protocol/agent-types";
import { getNeolixToolTargetAgentId } from "@neolix/protocol/neolix-tool-presentation/index";
import { useSessionStore } from "@/stores/session-store";

/** Title of the agent a Neolix tool call acts on, when this host knows it. */
export function useTargetAgentTitle(input: {
  serverId: string | undefined;
  toolName: string;
  detail: ToolCallDetail | undefined;
}): string | undefined {
  const agentId = getNeolixToolTargetAgentId(input.toolName, input.detail);
  const { serverId } = input;
  return useSessionStore((state) => {
    if (!serverId || !agentId) return undefined;
    const session = state.sessions[serverId];
    const agent = session?.agents.get(agentId) ?? session?.agentDetails.get(agentId);
    return agent?.title ?? undefined;
  });
}
