// Neox attention marks. The daemon keeps an agent mark (finished/error) and a workspace mark
// (attention/failed); the old app clears the agent mark when the agent is viewed and the
// workspace mark from the sidebar's "Mark read" action. The bridge resolves a Synara thread to
// its agent id (they are the same value) and to its workspace before forwarding.
import { WS_METHODS } from "@synara/contracts";

import type { BridgeModel } from "./model.ts";
import { fromPromise } from "./rpcErrors.ts";
import type { AnyHandler } from "./stubs.ts";
import { resolveWorkspaceId } from "./workspacesRpc.ts";

export function makeAttentionHandlers(model: BridgeModel): Record<string, AnyHandler> {
  const client = model.client;
  return {
    [WS_METHODS.neolixAttentionClearAgent]: (payload) =>
      fromPromise("neolix.attention.clearAgent", async () => {
        const { threadId } = payload as { threadId: string };
        await client.clearAgentAttention(threadId);
        return {};
      }),

    [WS_METHODS.neolixAttentionClearWorkspace]: (payload) =>
      fromPromise("neolix.attention.clearWorkspace", async () => {
        const workspaceId = await resolveWorkspaceId(
          model,
          payload as { threadId?: string; workspaceId?: string },
        );
        await client.clearWorkspaceAttention(workspaceId);
        return {};
      }),
  };
}
