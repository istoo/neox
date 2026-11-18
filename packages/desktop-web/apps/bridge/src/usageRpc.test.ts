import type { UsageReportEntry } from "../../../../protocol/dist/messages.js";
import { Schema } from "effect";
import { ServerProviderUsageSnapshot } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import type { DaemonClient } from "./neolix.ts";
import { getProviderUsageSnapshot, listProviderUsage, toUsageSnapshots } from "./usageRpc.ts";

const FETCHED_AT = "2026-11-08T00:00:00.000Z";

function claude(overrides: Partial<UsageReportEntry> = {}): UsageReportEntry {
  return {
    id: "claude:work",
    account: { label: "work" },
    fetchedAt: FETCHED_AT,
    successfulAt: FETCHED_AT,
    sourceId: "claude",
    sourceLabel: "Claude",
    report: {
      status: "available",
      planLabel: "Max",
      windows: [
        {
          id: "5h",
          label: "5 hours",
          usedPct: 42.5,
          resetsAt: "2026-11-08T05:00:00.000Z",
        },
        { id: "wk", label: "Weekly", remainingPct: 25 },
      ],
      details: [{ id: "login", label: "Account", value: "user@example.com" }],
      balances: [],
    },
    ...overrides,
  };
}

const codexError: UsageReportEntry = {
  id: "codex:work",
  account: { label: "work" },
  fetchedAt: FETCHED_AT,
  sourceId: "codex",
  sourceLabel: "Codex",
  report: { status: "error", error: "Rate limited" },
};

const kimi: UsageReportEntry = {
  id: "kimi:one",
  account: {},
  fetchedAt: FETCHED_AT,
  sourceId: "kimi",
  sourceLabel: "Kimi",
  report: { status: "available", windows: [] },
};

function fakeClient(
  reports: UsageReportEntry[],
  calls: Array<{ forceRefresh?: boolean | undefined }> = [],
): DaemonClient {
  return {
    listUsageReports: async (options?: { forceRefresh?: boolean | undefined }) => {
      calls.push({ forceRefresh: options?.forceRefresh });
      return { requestId: "usage-1", reports };
    },
  } as unknown as DaemonClient;
}

describe("usageRpc", () => {
  it("maps report windows, details and statuses onto Synara snapshots", () => {
    const snapshots = toUsageSnapshots([claude(), codexError, kimi]);
    expect(snapshots.map((snapshot) => snapshot.provider)).toEqual(["claudeAgent", "codex"]);
    expect(snapshots[0]).toMatchObject({
      instanceId: "claudeAgent-work",
      accountLabel: "work",
      planName: "Max",
      status: "ok",
      source: "Claude",
      limits: [
        { window: "5 hours", usedPercent: 42.5, resetsAt: "2026-11-08T05:00:00.000Z" },
        { window: "Weekly", usedPercent: 75 },
      ],
      usageLines: [{ label: "Account", value: "user@example.com" }],
    });
    expect(snapshots[1]).toMatchObject({ status: "error", detail: "Rate limited" });
    expect(() =>
      Schema.encodeUnknownSync(Schema.Array(ServerProviderUsageSnapshot) as never)(snapshots),
    ).not.toThrow();
  });

  it("shows retained values beside a failed attempt, dated when they were fetched", () => {
    const retained = claude({
      fetchedAt: "2026-11-10T13:05:00.000Z",
      successfulAt: undefined,
      report: {
        status: "unavailable",
        problem: { kind: "rejected", status: 401, refreshedBy: "claude" },
      },
      lastSuccessful: {
        fetchedAt: "2026-11-10T13:00:00.000Z",
        report: {
          status: "available",
          planLabel: "Max",
          windows: [{ id: "5h", label: "5 hours", usedPct: 10 }],
        },
      },
    });
    expect(toUsageSnapshots([retained])[0]).toMatchObject({
      status: "ok",
      stale: true,
      updatedAt: "2026-11-10T13:00:00.000Z",
      limits: [{ window: "5 hours", usedPercent: 10 }],
      detail: "Login rejected (HTTP 401). Run claude to refresh it.",
    });

    // Without a successful copy there is nothing to keep: signing out is shown as such.
    const signedOut = claude({
      report: { status: "unavailable", problem: { kind: "rejected", status: 401 } },
      lastSuccessful: undefined,
    });
    expect(toUsageSnapshots([signedOut])[0]).toMatchObject({
      status: "needs-auth",
      detail: "Login rejected (HTTP 401). Sign in again.",
    });
  });

  it("filters the batch, prefers the default instance, and asks the daemon to refresh", async () => {
    const calls: Array<{ forceRefresh?: boolean | undefined }> = [];
    const client = fakeClient([claude(), codexError], calls);
    expect(await listProviderUsage(client, { provider: "codex" })).toHaveLength(1);
    expect(await getProviderUsageSnapshot(client, { provider: "claudeAgent" })).toMatchObject({
      provider: "claudeAgent",
      instanceId: "claudeAgent-work",
    });
    expect(await getProviderUsageSnapshot(client, { provider: "cursor" })).toBeNull();

    await listProviderUsage(client, { forceRefresh: true });
    expect(calls.at(-1)).toEqual({ forceRefresh: true });
  });

  it("keeps one row per signed-in account of the same source", () => {
    const failed = claude({
      id: "claude:one",
      account: { label: "one@example.com" },
      report: { status: "error", error: "Usage fetch timed out" },
      lastSuccessful: undefined,
    });
    const live = claude({ id: "claude:two", account: { label: "two@example.com" } });
    expect(toUsageSnapshots([failed, live])).toMatchObject([
      {
        provider: "claudeAgent",
        status: "error",
        instanceId: "claudeAgent-one",
        accountLabel: "one@example.com",
      },
      {
        provider: "claudeAgent",
        status: "ok",
        instanceId: "claudeAgent-two",
        accountLabel: "two@example.com",
      },
    ]);
  });
});
