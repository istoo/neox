import { WS_METHODS } from "@synara/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { makeAttentionHandlers } from "./attentionRpc.ts";
import type { BridgeModel } from "./model.ts";
import type { DaemonClient } from "./neolix.ts";

function makeHandlers() {
  const calls: Array<[string, unknown]> = [];
  const client = {
    clearAgentAttention: async (agentId: string) => {
      calls.push(["clearAgentAttention", agentId]);
    },
    clearWorkspaceAttention: async (workspaceId: string) => {
      calls.push(["clearWorkspaceAttention", workspaceId]);
    },
  } as unknown as DaemonClient;
  const model = {
    client,
    entry: (threadId: string) => ({
      agent: { id: threadId, workspaceId: "ws-1" },
    }),
  } as unknown as BridgeModel;
  return { handlers: makeAttentionHandlers(model), calls };
}

const run = <A>(effect: unknown) => Effect.runPromise(effect as Effect.Effect<A>);

describe("attentionRpc", () => {
  it("clears an agent attention mark by thread id", async () => {
    const { handlers, calls } = makeHandlers();
    await run(handlers[WS_METHODS.neolixAttentionClearAgent]!({ threadId: "agent-1" }, undefined));
    expect(calls).toEqual([["clearAgentAttention", "agent-1"]]);
  });

  it("resolves the thread's workspace before clearing its mark", async () => {
    const { handlers, calls } = makeHandlers();
    await run(
      handlers[WS_METHODS.neolixAttentionClearWorkspace]!({ threadId: "agent-1" }, undefined),
    );
    expect(calls).toEqual([["clearWorkspaceAttention", "ws-1"]]);
  });

  it("accepts an explicit workspace id", async () => {
    const { handlers, calls } = makeHandlers();
    await run(
      handlers[WS_METHODS.neolixAttentionClearWorkspace]!({ workspaceId: "ws-2" }, undefined),
    );
    expect(calls).toEqual([["clearWorkspaceAttention", "ws-2"]]);
  });
});
