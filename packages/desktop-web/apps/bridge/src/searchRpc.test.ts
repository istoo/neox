import { OrchestrationSearchThreadsResult } from "@synara/contracts";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import type { BridgeModel } from "./model.ts";
import type { DaemonClient } from "./neolix.ts";
import { searchThreads } from "./searchRpc.ts";

function fakeModel(entries: Array<{ id: string; title: string; updatedAt: string }>): BridgeModel {
  return {
    allEntries: () => entries.map((entry) => ({ agent: entry, project: null })),
  } as unknown as BridgeModel;
}

function fakeClient(input: {
  locations: Record<string, Array<{ seq: number; count?: number }>>;
  timelines?: Record<
    string,
    Array<{ seqStart: number; seqEnd?: number; item: Record<string, unknown> }>
  >;
}): DaemonClient {
  return {
    searchAgentTimeline: async ({ agentId }: { agentId: string }) => ({
      agentId,
      epoch: "e",
      locations: input.locations[agentId] ?? [],
      nextCursor: null,
      error: null,
    }),
    fetchAgentTimeline: async (agentId: string) => ({
      entries: input.timelines?.[agentId] ?? [],
    }),
  } as unknown as DaemonClient;
}

describe("searchRpc", () => {
  it("ranks content matches ahead of title-only matches and excerpts the hit", async () => {
    const model = fakeModel([
      { id: "thread-a", title: "First", updatedAt: "2026-11-08T00:00:03.000Z" },
      { id: "thread-b", title: "Alpha plan", updatedAt: "2026-11-08T00:00:02.000Z" },
      { id: "thread-c", title: "Unrelated", updatedAt: "2026-11-08T00:00:01.000Z" },
    ]);
    const client = fakeClient({
      locations: {
        "thread-a": [{ seq: 2, count: 2 }],
        "thread-c": [],
      },
      timelines: {
        "thread-a": [
          { seqStart: 1, item: { type: "user_message", text: "please check" } },
          {
            seqStart: 2,
            seqEnd: 2,
            item: { type: "assistant_message", text: "The alpha result is here" },
          },
        ],
      },
    });
    const result = await searchThreads(model, client, { query: "alpha" });
    expect(result.matches).toEqual([
      { threadId: "thread-a", excerpt: "The alpha result is here", matchCount: 2 },
      { threadId: "thread-b", excerpt: "Alpha plan", matchCount: 1 },
    ]);
    expect(() =>
      Schema.encodeUnknownSync(OrchestrationSearchThreadsResult as never)(result),
    ).not.toThrow();
  });

  it("excerpts a merged assistant entry from the seqEnd the daemon reports", async () => {
    const model = fakeModel([
      { id: "thread-a", title: "Unrelated title", updatedAt: "2026-11-08T00:00:01.000Z" },
    ]);
    const client = fakeClient({
      // The daemon's search reports the projected entry's seqEnd. Streaming replies are
      // merged from many rows, so seqStart and seqEnd differ.
      locations: { "thread-a": [{ seq: 14, count: 1 }] },
      timelines: {
        "thread-a": [
          {
            seqStart: 2,
            seqEnd: 14,
            item: { type: "assistant_message", text: "Now the scroll anchor logic is clear" },
          },
        ],
      },
    });
    const result = await searchThreads(model, client, { query: "scroll anchor" });
    expect(result.matches).toEqual([
      {
        threadId: "thread-a",
        excerpt: "Now the scroll anchor logic is clear",
        matchCount: 1,
      },
    ]);
  });

  it("caps the result at the requested limit", async () => {
    const model = fakeModel([
      { id: "thread-a", title: "Alpha one", updatedAt: "2026-11-08T00:00:03.000Z" },
      { id: "thread-b", title: "Alpha two", updatedAt: "2026-11-08T00:00:02.000Z" },
    ]);
    const result = await searchThreads(model, fakeClient({ locations: {} }), {
      query: "alpha",
      limit: 1,
    });
    expect(result.matches).toHaveLength(1);
  });

  it("returns nothing for an empty query", async () => {
    const result = await searchThreads(fakeModel([]), fakeClient({ locations: {} }), {
      query: "  ",
    });
    expect(result.matches).toEqual([]);
  });
});
