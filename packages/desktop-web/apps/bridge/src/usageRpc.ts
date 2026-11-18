// Neox usage reports → Synara's provider-usage snapshots. The daemon reports one entry per
// usage source and signed-in account, with the last successful values kept beside a failed
// attempt; this bridge maps those onto the account-level rows the desktop UI already draws.
import type {
  ProviderKind,
  ServerGetProviderUsageSnapshotResult,
  ServerListProviderUsageInput,
  ServerListProviderUsageResult,
  ServerProviderUsageSnapshot,
} from "@synara/contracts";
import type { UsageReportEntry } from "../../../../protocol/dist/messages.js";

import type { DaemonClient } from "./neolix.ts";
import { driverForProvider, instanceIdForProvider } from "./providers.ts";

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

/** The percent a window used, from either side of the report. */
function usedPercent(window: {
  readonly usedPct?: number | null | undefined;
  readonly remainingPct?: number | null | undefined;
}): number | undefined {
  const used = percentOrUndefined(window.usedPct);
  if (used !== undefined) return used;
  const remaining = percentOrUndefined(window.remainingPct);
  return remaining === undefined ? undefined : 100 - remaining;
}

function usageStatus(entry: UsageReportEntry): "ok" | "needs-auth" | "error" {
  if (entry.report.status === "available" || entry.lastSuccessful !== undefined) return "ok";
  return entry.report.status === "error" ? "error" : "needs-auth";
}

type UsageProblem = Extract<UsageReportEntry["report"], { status: "unavailable" }>["problem"];

function problemText(problem: UsageProblem): string {
  if (problem.kind === "no_quota") return problem.detail;
  const remedy = problem.refreshedBy
    ? `Run ${problem.refreshedBy} to refresh it.`
    : "Sign in again.";
  if (problem.kind === "rejected") {
    return `Login rejected (HTTP ${problem.status}). ${remedy}`;
  }
  const elapsed = Math.max(0, Date.now() - Date.parse(problem.expiresAt));
  let ago = "just now";
  if (elapsed >= 86_400_000) ago = `${Math.floor(elapsed / 86_400_000)}d ago`;
  else if (elapsed >= 3_600_000) ago = `${Math.floor(elapsed / 3_600_000)}h ago`;
  else if (elapsed >= 60_000) ago = `${Math.floor(elapsed / 60_000)}m ago`;
  return `Login expired ${ago}. ${remedy}`;
}

/** Why the latest attempt failed, or null when it succeeded. */
function failureText(entry: UsageReportEntry): string | null {
  if (entry.report.status === "available") return null;
  if (entry.report.status === "error") return entry.report.error;
  const logins = entry.loginErrors ?? [];
  if (logins.length > 0) {
    return logins
      .map(
        (login) =>
          `${login.harness}: ${
            login.report.status === "error" ? login.report.error : problemText(login.report.problem)
          }`,
      )
      .join("\n");
  }
  return problemText(entry.report.problem);
}

function balanceLine(balance: {
  readonly label: string;
  readonly used?: number | null | undefined;
  readonly remaining?: number | null | undefined;
  readonly limit?: number | null | undefined;
  readonly unit: string;
}): { label: string; value: string } | null {
  const label = nonEmpty(balance.label);
  const amount = balance.remaining ?? balance.used ?? balance.limit;
  if (!label || typeof amount !== "number" || !Number.isFinite(amount)) return null;
  return { label, value: `${Math.round(amount * 100) / 100} ${balance.unit}`.trim() };
}

/**
 * One id per report. The default account keeps its provider's instance id; every other
 * signed-in account gets `<instance>-<account key>` so each account draws its own row.
 */
function instanceIdForReport(entry: UsageReportEntry): string {
  const base = instanceIdForProvider(entry.sourceId);
  const prefix = `${entry.sourceId}:`;
  if (!entry.id.startsWith(prefix)) return base;
  const key = entry.id
    .slice(prefix.length)
    .replace(/[^A-Za-z0-9_-]/gu, "-")
    .slice(0, Math.max(0, 63 - base.length));
  return key === "" ? base : `${base}-${key}`;
}

/** One Synara snapshot, or null when Synara has no driver for the source. */
export function toUsageSnapshot(entry: UsageReportEntry): ServerProviderUsageSnapshot | null {
  const driver: ProviderKind = driverForProvider(entry.sourceId);
  // `driverForProvider` falls back to Claude for unknown sources; usage cards must not claim a
  // provider they do not belong to, so only known driver ids are reported.
  if (driver === "claudeAgent" && entry.sourceId !== "claude") return null;
  const retained = entry.report.status !== "available" ? entry.lastSuccessful : undefined;
  const content = entry.report.status === "available" ? entry.report : (retained?.report ?? null);
  const updatedAt =
    isoOrUndefined(entry.successfulAt) ??
    isoOrUndefined(retained?.fetchedAt) ??
    isoOrUndefined(entry.fetchedAt) ??
    new Date().toISOString();
  const limits = (content?.windows ?? []).flatMap((window) => {
    const label = nonEmpty(window.label) ?? nonEmpty(window.id);
    if (!label) return [];
    const used = usedPercent(window);
    const resetsAt = isoOrUndefined(window.resetsAt);
    return [
      {
        window: label,
        ...(used !== undefined ? { usedPercent: used } : {}),
        ...(resetsAt ? { resetsAt } : {}),
      },
    ];
  });
  const lines: Array<{ label: string; value: string }> = [];
  for (const detail of content?.details ?? []) {
    const label = nonEmpty(detail.label);
    const value = nonEmpty(detail.value);
    if (label && value) lines.push({ label, value });
  }
  for (const balance of content?.balances ?? []) {
    const line = balanceLine(balance);
    if (line) lines.push(line);
  }
  const detail = failureText(entry);
  const planName = nonEmpty(content?.planLabel);
  const accountLabel = nonEmpty(entry.account.label);
  return {
    provider: driver,
    instanceId: instanceIdForReport(entry) as ServerProviderUsageSnapshot["instanceId"],
    updatedAt: updatedAt as ServerProviderUsageSnapshot["updatedAt"],
    limits,
    usageLines: lines,
    source: nonEmpty(entry.sourceLabel) ?? nonEmpty(entry.sourceId) ?? "neolix",
    status: usageStatus(entry),
    ...(accountLabel ? { accountLabel } : {}),
    ...(planName ? { planName } : {}),
    ...(detail ? { detail } : {}),
    // A failed attempt keeps the last successful values on screen, still dated when they
    // were fetched, exactly as the app shows them beside the failure message.
    ...(retained === undefined ? {} : { stale: true }),
  };
}

export function toUsageSnapshots(
  reports: readonly UsageReportEntry[],
): ServerProviderUsageSnapshot[] {
  return reports.flatMap((entry) => {
    const snapshot = toUsageSnapshot(entry);
    return snapshot ? [snapshot] : [];
  });
}

/** Live batch, filtered to one driver when the caller scopes the request. */
export async function listProviderUsage(
  client: DaemonClient,
  input: ServerListProviderUsageInput,
): Promise<ServerListProviderUsageResult> {
  const { reports } = await client.listUsageReports({ forceRefresh: input.forceRefresh === true });
  const snapshots = toUsageSnapshots(reports);
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
