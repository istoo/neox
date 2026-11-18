import type { ProviderKind, ServerProviderUsageSnapshot } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  findUsageSnapshot,
  providerUsageAccountSnapshots,
  usageSnapshotKey,
  usageSnapshotOwner,
  usageSnapshotsForInstance,
} from "./providerUsageAccounts.logic";

function snapshot(instanceId: string, accountLabel?: string): ServerProviderUsageSnapshot {
  return {
    provider: "claudeAgent",
    instanceId,
    updatedAt: "2026-11-14T00:00:00.000Z",
    limits: [],
    usageLines: [],
    source: "Claude",
    ...(accountLabel ? { accountLabel } : {}),
  } as ServerProviderUsageSnapshot;
}

describe("providerUsageAccounts", () => {
  it("matches an instance's own snapshot and the accounts split under it", () => {
    const snapshots = [
      snapshot("claudeAgent-work", "work"),
      snapshot("claudeAgent-home", "home"),
      snapshot("codex-work", "work"),
    ];
    expect(usageSnapshotsForInstance(snapshots, "claudeAgent", "claudeAgent")).toHaveLength(2);
    expect(usageSnapshotsForInstance(snapshots, "claudeAgent", "claudeAgent-work")).toHaveLength(1);
    expect(usageSnapshotsForInstance(snapshots, "codex", "claudeAgent")).toHaveLength(0);
  });

  it("prefers the instance's own snapshot, then its first account", () => {
    const accounts = [snapshot("claudeAgent-home", "home"), snapshot("claudeAgent-work", "work")];
    expect(findUsageSnapshot(accounts, "claudeAgent", "claudeAgent")).toBe(accounts[0]);
    expect(findUsageSnapshot(accounts, "claudeAgent", "claudeAgent-work")).toBe(accounts[1]);
    expect(findUsageSnapshot([], "claudeAgent", "claudeAgent")).toBeNull();
  });

  it("keys accounts apart even when they share an instance", () => {
    expect(usageSnapshotKey(snapshot("claudeAgent-work", "work"))).toBe(
      "claudeAgent:claudeAgent-work:work",
    );
    expect(usageSnapshotKey(snapshot("claudeAgent-home", "home"))).not.toBe(
      usageSnapshotKey(snapshot("claudeAgent-work", "work")),
    );
  });

  it("lists every account of a provider, not just the first", () => {
    const snapshots = [
      snapshot("claudeAgent", "default"),
      snapshot("claudeAgent-work", "work"),
      snapshot("claudeAgent-home", "home"),
      snapshot("codex-work", "work"),
    ];
    const instances = [
      { instanceId: "claudeAgent", driver: "claudeAgent" as ProviderKind },
      { instanceId: "codex", driver: "codex" as ProviderKind },
    ];
    const accounts = providerUsageAccountSnapshots(snapshots, instances, "claudeAgent");
    expect(accounts.map(({ snapshot: entry }) => entry.accountLabel)).toEqual([
      "default",
      "work",
      "home",
    ]);
    // The instance is attached so a chip can name the account it draws.
    expect(accounts.every(({ instance }) => instance.instanceId === "claudeAgent")).toBe(true);
  });

  it("owns a snapshot by exact id or by the instance it was split from, never a stranger", () => {
    const claude = { instanceId: "claudeAgent", driver: "claudeAgent" as ProviderKind };
    const codex = { instanceId: "codex", driver: "codex" as ProviderKind };
    const instances = new Map<string, { instanceId: string; driver: ProviderKind }>([
      ["claudeAgent", claude],
      ["codex", codex],
    ]);
    expect(usageSnapshotOwner(snapshot("claudeAgent"), instances)).toBe(claude);
    expect(usageSnapshotOwner(snapshot("claudeAgent-work", "work"), instances)).toBe(claude);
    // A deleted instance's cached snapshot must not borrow the provider default's switch.
    expect(usageSnapshotOwner(snapshot("claude_removed"), instances)).toBeUndefined();
    // Same id prefix, different driver: not an account of that instance.
    expect(usageSnapshotOwner(snapshot("codex-work", "work"), instances)).toBeUndefined();
  });
});
