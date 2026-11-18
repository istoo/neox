import { WS_METHODS } from "@synara/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import type { BridgeModel } from "./model.ts";
import type { DaemonClient } from "./neolix.ts";
import { makeSubagentHandlers } from "./subagentsRpc.ts";

const DESCRIPTOR = {
  id: "child-1",
  parentAgentId: "parent-1",
  parentSubagentId: null,
  provider: "claude",
  title: "Review diff",
  description: "Review the pending change",
  status: "running" as const,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:05.000Z",
  toolCallId: "tool-1",
  cwd: "/repo",
  subtitle: "reading files",
};

function makeHandlers() {
  const calls: Array<[string, unknown]> = [];
  const client = {
    listProviderSubagents: async (parentAgentId: string) => {
      calls.push(["listProviderSubagents", parentAgentId]);
      return { subagents: [DESCRIPTOR], error: null };
    },
    fetchProviderSubagentTimeline: async (
      parentAgentId: string,
      subagentId: string,
      options: unknown,
    ) => {
      calls.push(["fetchProviderSubagentTimeline", { parentAgentId, subagentId, options }]);
      return {
        rows: [
          {
            item: { type: "user_message", text: "go" },
            timestamp: "2026-01-01T00:00:00.000Z",
            seq: 1,
          },
        ],
        hasOlder: false,
        hasNewer: true,
        error: null,
      };
    },
    detachAgent: async (agentId: string) => {
      calls.push(["detachAgent", agentId]);
    },
  } as unknown as DaemonClient;
  const model = { client } as unknown as BridgeModel;
  return { handlers: makeSubagentHandlers(model), calls };
}

const run = <A>(effect: unknown) => Effect.runPromise(effect as Effect.Effect<A>);

describe("subagentsRpc", () => {
  it("lists provider subagents with nullable fields normalized", async () => {
    const { handlers, calls } = makeHandlers();
    const result = await run(
      handlers[WS_METHODS.neolixSubagentsList]!({ threadId: "parent-1" }, undefined),
    );
    expect(result).toEqual({
      subagents: [
        expect.objectContaining({
          id: "child-1",
          parentSubagentId: null,
          title: "Review diff",
          status: "running",
        }),
      ],
    });
    expect(calls).toEqual([["listProviderSubagents", "parent-1"]]);
  });

  it("forwards timeline direction and limit", async () => {
    const { handlers, calls } = makeHandlers();
    const result = await run(
      handlers[WS_METHODS.neolixSubagentsTimeline]!(
        { threadId: "parent-1", subagentId: "child-1", direction: "tail", limit: 50 },
        undefined,
      ),
    );
    expect(result).toMatchObject({ hasOlder: false, hasNewer: true, rows: [{ seq: 1 }] });
    expect(calls).toEqual([
      [
        "fetchProviderSubagentTimeline",
        {
          parentAgentId: "parent-1",
          subagentId: "child-1",
          options: { direction: "tail", limit: 50 },
        },
      ],
    ]);
  });

  it("detaches a child agent by its thread id", async () => {
    const { handlers, calls } = makeHandlers();
    await run(handlers[WS_METHODS.neolixSubagentsDetach]!({ agentId: "child-1" }, undefined));
    expect(calls).toEqual([["detachAgent", "child-1"]]);
  });
});
