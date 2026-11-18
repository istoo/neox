import { NeolixSyncUsage } from "@synara/contracts";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import type { NeolixSyncUsage as SyncUsagePayload } from "@synara/contracts";
import type { DaemonClient } from "./neolix.ts";
import { getSyncUsage } from "./syncUsageRpc.ts";

function payload(overrides: Partial<SyncUsagePayload> = {}): SyncUsagePayload {
  return {
    period: "90d",
    since: "2026-08-17T00:00:00.000Z",
    calls: 12,
    errors: 1,
    input: 1_000,
    output: 500,
    cache_read: 200,
    cache_write: 100,
    reasoning: 50,
    cost: 0.42,
    unpriced: 0,
    bucket: "day",
    series: [
      {
        label: "8/17",
        time: "2026-08-17",
        calls: 12,
        errors: 1,
        input: 1_000,
        output: 500,
        cache_read: 200,
        cache_write: 100,
        reasoning: 50,
        cost: 0.42,
        unpriced: 0,
      },
    ],
    computers: [
      {
        id: "this",
        name: "",
        calls: 8,
        errors: 0,
        input: 800,
        output: 400,
        cache_read: 0,
        cache_write: 0,
        reasoning: 0,
        cost: 0.3,
        unpriced: 0,
      },
      {
        id: "studio",
        name: "Studio",
        calls: 4,
        errors: 1,
        input: 200,
        output: 100,
        cache_read: 200,
        cache_write: 100,
        reasoning: 50,
        cost: 0.12,
        unpriced: 0,
      },
    ],
    rows: [],
    total: 0,
    offset: 0,
    quotaHistory: [
      {
        provider: "claude",
        user: "work@example.com",
        lines: [{ name: "allowance", points: [{ at: "2026-08-17T00:00:00.000Z", left: 72 }] }],
      },
    ],
    devices: [],
    quotas: [],
    ...overrides,
  };
}

function fakeClient(value: SyncUsagePayload | (() => Promise<SyncUsagePayload>)): DaemonClient {
  return {
    getSyncUsage: typeof value === "function" ? value : async () => value,
  } as unknown as DaemonClient;
}

describe("syncUsageRpc", () => {
  it("returns every computer's shared usage as the contract describes it", async () => {
    const value = payload();
    await expect(getSyncUsage(fakeClient(value))).resolves.toEqual(value);
    expect(() => Schema.encodeSync(NeolixSyncUsage)(value)).not.toThrow();
  });

  it("surfaces the daemon's error instead of drawing an empty page", async () => {
    await expect(
      getSyncUsage(fakeClient(payload({ error: "sync password is not set" }))),
    ).rejects.toThrow("sync password is not set");
  });

  it("keeps an answer without shared computers parseable", async () => {
    const value = payload({ computers: undefined, quotaHistory: undefined });
    await expect(getSyncUsage(fakeClient(value))).resolves.toEqual(value);
    expect(() => Schema.encodeSync(NeolixSyncUsage)(value)).not.toThrow();
  });
});
