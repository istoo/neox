import { Schema } from "effect";
import { ServerProviderUsageSnapshot } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import type { DaemonClient } from "./neolix.ts";
import { getProviderUsageSnapshot, listProviderUsage, toUsageSnapshots } from "./usageRpc.ts";

const list = {
  fetchedAt: "2026-11-08T00:00:00.000Z",
  providers: [
    {
      providerId: "claude",
      displayName: "Claude",
      status: "available" as const,
      planLabel: "Max",
      sourceLabel: "Claude",
      fetchedAt: "2026-11-08T00:00:00.000Z",
      windows: [
        { id: "5h", label: "5 hours", usedPct: 42.5, resetsAt: "2026-11-08T05:00:00.000Z" },
        { id: "wk", label: "Weekly", usedPct: null },
      ],
      details: [{ id: "login", label: "Account", value: "user@example.com" }],
      balances: [],
    },
    {
      providerId: "codex",
      displayName: "Codex",
      status: "error" as const,
      windows: [],
      error: "Rate limited",
    },
    {
      providerId: "kimi",
      displayName: "Kimi",
      status: "available" as const,
      windows: [],
    },
  ],
};

function fakeClient(payload: unknown): DaemonClient {
  return { listProviderUsage: async () => payload } as unknown as DaemonClient;
}

function codexList(status: "available" | "error" | "unavailable", fetchedAt: string) {
  return {
    fetchedAt,
    providers: [
      {
        providerId: "codex",
        displayName: "Codex",
        status,
        fetchedAt,
        windows: status === "available" ? [{ id: "30d", label: "30 days", usedPct: 0 }] : [],
        ...(status === "available" ? {} : { error: "Usage fetch timed out" }),
      },
    ],
  };
}

describe("usageRpc", () => {
  it("maps windows, details and statuses onto Synara snapshots", () => {
    const snapshots = toUsageSnapshots(list);
    expect(snapshots.map((snapshot) => snapshot.provider)).toEqual(["claudeAgent", "codex"]);
    expect(snapshots[0]).toMatchObject({
      instanceId: "claudeAgent",
      planName: "Max",
      status: "ok",
      source: "Claude",
      limits: [
        { window: "5 hours", usedPercent: 42.5, resetsAt: "2026-11-08T05:00:00.000Z" },
        { window: "Weekly" },
      ],
      usageLines: [{ label: "Account", value: "user@example.com" }],
    });
    expect(snapshots[1]).toMatchObject({ status: "error", detail: "Rate limited" });
    expect(() =>
      Schema.encodeUnknownSync(Schema.Array(ServerProviderUsageSnapshot) as never)(snapshots),
    ).not.toThrow();
  });

  it("filters the batch and prefers the default instance for a snapshot", async () => {
    const client = fakeClient(list);
    expect(await listProviderUsage(client, { provider: "codex" })).toHaveLength(1);
    expect(await getProviderUsageSnapshot(client, { provider: "claudeAgent" })).toMatchObject({
      provider: "claudeAgent",
      instanceId: "claudeAgent",
    });
    expect(await getProviderUsageSnapshot(client, { provider: "cursor" })).toBeNull();
  });

  it("keeps the last successful values through a transient error, not through a sign-out", async () => {
    let payload: unknown = codexList("available", "2026-11-10T13:00:00.000Z");
    const client = { listProviderUsage: async () => payload } as unknown as DaemonClient;

    const first = await getProviderUsageSnapshot(client, { provider: "codex" });
    expect(first).toMatchObject({ status: "ok", limits: [{ window: "30 days" }] });

    // A failed poll shows the values from the last good one, dated when they were fetched.
    payload = codexList("error", "2026-11-10T13:05:00.000Z");
    expect(await getProviderUsageSnapshot(client, { provider: "codex" })).toEqual(first);

    // Another daemon connection has its own history.
    const other = { listProviderUsage: async () => payload } as unknown as DaemonClient;
    expect(await getProviderUsageSnapshot(other, { provider: "codex" })).toMatchObject({
      status: "error",
    });

    // Signing out is real news: show it, and do not bring the old values back afterwards.
    payload = codexList("unavailable", "2026-11-10T13:10:00.000Z");
    expect(await getProviderUsageSnapshot(client, { provider: "codex" })).toMatchObject({
      status: "needs-auth",
    });
    payload = codexList("error", "2026-11-10T13:15:00.000Z");
    expect(await getProviderUsageSnapshot(client, { provider: "codex" })).toMatchObject({
      status: "error",
    });
  });
});
