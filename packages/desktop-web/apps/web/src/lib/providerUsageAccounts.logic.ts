// FILE: providerUsageAccounts.logic.ts
// Purpose: One usage snapshot per signed-in account. A Neox host reports accounts
//          separately while the desktop's provider instances stay provider-scoped,
//          so consumers match an instance's own snapshot and its account children.

import type {
  ProviderInstanceId,
  ProviderKind,
  ServerProviderUsageSnapshot,
} from "@synara/contracts";

export function usageSnapshotInstanceId(snapshot: ServerProviderUsageSnapshot): string {
  return snapshot.instanceId ?? snapshot.provider;
}

/** A stable React/cache key: provider + instance + account. */
export function usageSnapshotKey(snapshot: ServerProviderUsageSnapshot): string {
  return `${snapshot.provider}:${usageSnapshotInstanceId(snapshot)}:${snapshot.accountLabel ?? ""}`;
}

/** The snapshots of one instance: its own and the accounts the bridge split under it. */
export function usageSnapshotsForInstance(
  snapshots: readonly ServerProviderUsageSnapshot[],
  provider: ProviderKind,
  instanceId: ProviderInstanceId | string,
): ServerProviderUsageSnapshot[] {
  return snapshots.filter(
    (snapshot) => snapshot.provider === provider && isUsageSnapshotOfInstance(snapshot, instanceId),
  );
}

function isUsageSnapshotOfInstance(
  snapshot: ServerProviderUsageSnapshot,
  instanceId: ProviderInstanceId | string,
): boolean {
  const id = usageSnapshotInstanceId(snapshot);
  return id === instanceId || id.startsWith(`${instanceId}-`);
}

/**
 * The provider instance a snapshot belongs to: an exact id match, else the instance
 * whose accounts the bridge split it from. A snapshot of a deleted instance has none,
 * so it must not borrow another instance's switch.
 */
export function usageSnapshotOwner<T extends { instanceId: string; driver: ProviderKind }>(
  snapshot: ServerProviderUsageSnapshot,
  instances: ReadonlyMap<string, T>,
): T | undefined {
  const exact = instances.get(usageSnapshotInstanceId(snapshot));
  if (exact) return exact;
  for (const instance of instances.values()) {
    if (
      instance.driver === snapshot.provider &&
      isUsageSnapshotOfInstance(snapshot, instance.instanceId)
    ) {
      return instance;
    }
  }
  return undefined;
}

export interface ProviderUsageAccountSnapshot<T> {
  readonly instance: T;
  readonly snapshot: ServerProviderUsageSnapshot;
}

/**
 * Every signed-in account of `provider`, one entry per snapshot. A report split under an
 * instance is its own account, so the chat header can draw one chip per account instead of
 * collapsing the provider to its first one.
 */
export function providerUsageAccountSnapshots<
  T extends { instanceId: string; driver: ProviderKind },
>(
  snapshots: readonly ServerProviderUsageSnapshot[],
  instances: Iterable<T>,
  provider: ProviderKind,
): Array<ProviderUsageAccountSnapshot<T>> {
  const accounts: Array<ProviderUsageAccountSnapshot<T>> = [];
  for (const instance of instances) {
    if (instance.driver !== provider) continue;
    for (const snapshot of usageSnapshotsForInstance(snapshots, provider, instance.instanceId)) {
      accounts.push({ instance, snapshot });
    }
  }
  return accounts;
}

/** The instance's own snapshot, else its first account; null when it reports none. */
export function findUsageSnapshot(
  snapshots: readonly ServerProviderUsageSnapshot[],
  provider: ProviderKind,
  instanceId?: ProviderInstanceId | string | null,
): ServerProviderUsageSnapshot | null {
  const target = instanceId ?? provider;
  const matches = usageSnapshotsForInstance(snapshots, provider, target);
  return (
    matches.find((snapshot) => usageSnapshotInstanceId(snapshot) === target) ?? matches[0] ?? null
  );
}
