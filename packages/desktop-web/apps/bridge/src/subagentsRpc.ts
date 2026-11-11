// Neox provider-native subagents. They belong to the parent agent, not to a Synara thread, so
// the fork's activity-derived subagent surfaces cannot see them; these reads feed the dock's
// provider subagent section and its timeline view.
import { WS_METHODS } from "@synara/contracts";

import type { BridgeModel } from "./model.ts";
import { fromPromise } from "./rpcErrors.ts";
import type { AnyHandler } from "./stubs.ts";

interface NeolixSubagentDescriptor {
  readonly id: string;
  readonly parentAgentId: string;
  readonly parentSubagentId?: string | null;
  readonly provider: string;
  readonly title?: string | null;
  readonly description?: string | null;
  readonly status: "running" | "completed" | "failed" | "canceled";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly toolCallId?: string | null;
  readonly cwd?: string | null;
  readonly subtitle?: string | null;
}

interface NeolixSubagentTimelinePayload {
  readonly rows: ReadonlyArray<{
    readonly item: unknown;
    readonly timestamp: string;
    readonly seq: number;
  }>;
  readonly hasOlder: boolean;
  readonly hasNewer: boolean;
}

export function makeSubagentHandlers(model: BridgeModel): Record<string, AnyHandler> {
  const client = model.client;
  return {
    [WS_METHODS.neolixSubagentsList]: (payload) =>
      fromPromise("neolix.subagents.list", async () => {
        const { threadId } = payload as { threadId: string };
        const listing = (await client.listProviderSubagents(threadId)) as unknown as {
          subagents: ReadonlyArray<NeolixSubagentDescriptor>;
        };
        return {
          subagents: listing.subagents.map((subagent) => ({
            id: subagent.id,
            parentAgentId: subagent.parentAgentId,
            parentSubagentId: subagent.parentSubagentId ?? null,
            provider: subagent.provider,
            title: subagent.title ?? null,
            description: subagent.description ?? null,
            status: subagent.status,
            createdAt: subagent.createdAt,
            updatedAt: subagent.updatedAt,
            toolCallId: subagent.toolCallId ?? null,
            ...(subagent.cwd !== undefined ? { cwd: subagent.cwd } : {}),
            ...(subagent.subtitle !== undefined ? { subtitle: subagent.subtitle } : {}),
          })),
        };
      }),

    [WS_METHODS.neolixSubagentsTimeline]: (payload) =>
      fromPromise("neolix.subagents.timeline", async () => {
        const input = payload as {
          threadId: string;
          subagentId: string;
          direction?: "tail" | "before" | "after";
          limit?: number;
        };
        const timeline = (await client.fetchProviderSubagentTimeline(
          input.threadId,
          input.subagentId,
          {
            ...(input.direction ? { direction: input.direction } : {}),
            ...(typeof input.limit === "number" ? { limit: input.limit } : {}),
          },
        )) as unknown as NeolixSubagentTimelinePayload;
        return {
          rows: timeline.rows.map((row) => ({
            item: row.item,
            timestamp: row.timestamp,
            seq: row.seq,
          })),
          hasOlder: timeline.hasOlder,
          hasNewer: timeline.hasNewer,
        };
      }),
  };
}
