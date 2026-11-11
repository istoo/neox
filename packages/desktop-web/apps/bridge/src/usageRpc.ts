// Neox provider usage → Synara's provider-usage snapshots. Neox reports account-level
// windows, balances and detail rows without Synara's instance scoping; each source id maps to
// the Synara driver that owns it so the UI can attach the snapshot to an instance.
import type {
  ProviderKind,
  ServerGetProviderUsageSnapshotResult,
  ServerListProviderUsageInput,
  ServerListProviderUsageResult,
  ServerProviderUsageSnapshot,
} from "@synara/contracts";

import type { DaemonClient } from "./neolix.ts";
import { driverForProvider, instanceIdForProvider } from "./providers.ts";

export interface NeolixUsageWindow {
  readonly id: string;
  readonly label: string;
  readonly usedPct?: number | null;
  readonly resetsAt?: string | null;
}

export interface NeolixUsageBalance {
  readonly id: string;
  readonly label: string;
  readonly used?: number | null;
  readonly remaining?: number | null;
  readonly limit?: number | null;
  readonly unit: string;
  readonly resetsAt?: string | null;
}

export interface NeolixUsageDetail {
  readonly id: string;
  readonly label: string;
  readonly value: string;
}

export interface NeolixProviderUsage {
  readonly providerId: string;
  readonly displayName: string;
  readonly status: "available" | "unavailable" | "error";
  readonly planLabel?: string | null;
  readonly sourceLabel?: string | null;
  readonly fetchedAt?: string | null;
  readonly windows: readonly NeolixUsageWindow[];
  readonly balances?: readonly NeolixUsageBalance[];
  readonly details?: readonly NeolixUsageDetail[];
  readonly error?: string | null;
}

export interface NeolixUsageList {
  readonly fetchedAt: string;
  readonly providers: readonly NeolixProviderUsage[];
}

/** Neox reports titles and branch names that may be empty; Synara's schema requires text. */
function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isoOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : undefined;
}

function percentOrUndefined(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(100, Math.max(0, value));
}

function usageStatus(status: NeolixProviderUsage["status"]): "ok" | "needs-auth" | "error" {
  switch (status) {
    case "available":
      return "ok";
    case "error":
      return "error";
    default:
      return "needs-auth";
  }
}

function balanceLine(balance: NeolixUsageBalance): { label: string; value: string } | null {
  const label = nonEmpty(balance.label);
  const amount = balance.remaining ?? balance.used ?? balance.limit;
  if (!label || typeof amount !== "number" || !Number.isFinite(amount)) return null;
  return { label, value: `${Math.round(amount * 100) / 100} ${balance.unit}`.trim() };
}

/** One Synara snapshot, or null when Synara has no driver for the source. */
export function toUsageSnapshot(
  usage: NeolixProviderUsage,
  fetchedAt: string,
): ServerProviderUsageSnapshot | null {
  const driver: ProviderKind = driverForProvider(usage.providerId);
  // `driverForProvider` falls back to Claude for unknown sources; usage cards must not claim a
  // provider they do not belong to, so only known driver ids are reported.
  if (driver === "claudeAgent" && usage.providerId !== "claude") return null;
  const updatedAt = isoOrUndefined(usage.fetchedAt) ?? isoOrUndefined(fetchedAt);
  if (!updatedAt) return null;
  const limits = usage.windows.flatMap((window) => {
    const label = nonEmpty(window.label) ?? nonEmpty(window.id);
    if (!label) return [];
    const usedPercent = percentOrUndefined(window.usedPct);
    const resetsAt = isoOrUndefined(window.resetsAt);
    return [
      {
        window: label,
        ...(usedPercent !== undefined ? { usedPercent } : {}),
        ...(resetsAt ? { resetsAt } : {}),
      },
    ];
  });
  const lines: Array<{ label: string; value: string }> = [];
  for (const detail of usage.details ?? []) {
    const label = nonEmpty(detail.label);
    const value = nonEmpty(detail.value);
    if (label && value) lines.push({ label, value });
  }
  for (const balance of usage.balances ?? []) {
    const line = balanceLine(balance);
    if (line) lines.push(line);
  }
  const detail = nonEmpty(usage.error);
  const planName = nonEmpty(usage.planLabel);
  return {
    provider: driver,
    instanceId: instanceIdForProvider(
      usage.providerId,
    ) as ServerProviderUsageSnapshot["instanceId"],
    updatedAt: updatedAt as ServerProviderUsageSnapshot["updatedAt"],
    limits,
    usageLines: lines,
    source: nonEmpty(usage.sourceLabel) ?? "neolix",
    status: usageStatus(usage.status),
    ...(planName ? { planName } : {}),
    ...(detail ? { detail } : {}),
  };
}

export function toUsageSnapshots(list: NeolixUsageList): ServerProviderUsageSnapshot[] {
  return list.providers.flatMap((usage) => {
    const snapshot = toUsageSnapshot(usage, list.fetchedAt);
    return snapshot ? [snapshot] : [];
  });
}

/**
 * Last successful snapshot per daemon connection and provider instance. The legacy usage list
 * carries no history, so a single failed poll would flip a healthy "30 days 100%" row to
 * "Unavailable". Like the native app, a transient error keeps the last good values (still dated
 * by their own `updatedAt`); a sign-out (`needs-auth`) is shown and forgets them.
 */
const lastSuccessfulByClient = new WeakMap<
  DaemonClient,
  Map<string, ServerProviderUsageSnapshot>
>();

function withLastSuccessful(
  client: DaemonClient,
  snapshots: readonly ServerProviderUsageSnapshot[],
): ServerProviderUsageSnapshot[] {
  let remembered = lastSuccessfulByClient.get(client);
  if (!remembered) {
    remembered = new Map();
    lastSuccessfulByClient.set(client, remembered);
  }
  return snapshots.map((snapshot) => {
    const key = `${snapshot.provider}:${snapshot.instanceId}`;
    if (snapshot.status === "ok") {
      remembered.set(key, snapshot);
      return snapshot;
    }
    if (snapshot.status === "error") return remembered.get(key) ?? snapshot;
    remembered.delete(key);
    return snapshot;
  });
}

/** Live batch, filtered to one driver when the caller scopes the request. */
export async function listProviderUsage(
  client: DaemonClient,
  input: ServerListProviderUsageInput,
): Promise<ServerListProviderUsageResult> {
  const payload = (await client.listProviderUsage()) as unknown as NeolixUsageList;
  const snapshots = withLastSuccessful(client, toUsageSnapshots(payload));
  if (!input.provider) return snapshots;
  return snapshots.filter((snapshot) => snapshot.provider === input.provider);
}

/** The snapshot for one driver, preferring its default instance. */
export async function getProviderUsageSnapshot(
  client: DaemonClient,
  input: { readonly provider: ProviderKind },
): Promise<ServerGetProviderUsageSnapshotResult> {
  const snapshots = await listProviderUsage(client, { provider: input.provider });
  return (
    snapshots.find((snapshot) => snapshot.instanceId === input.provider) ?? snapshots[0] ?? null
  );
}
