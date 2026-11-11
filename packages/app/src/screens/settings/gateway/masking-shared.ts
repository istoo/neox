import type { GatewayMaskingRecordWire } from "@neolix/protocol/gateway";

/** Built-in kinds the daemon's masker knows, in the order the page lists them. */
export const MASK_SECRET_KINDS = [
  "PRIVATE_KEY",
  "API_KEY",
  "GITHUB_TOKEN",
  "AWS_KEY",
  "SLACK_TOKEN",
  "BEARER_TOKEN",
  "TOKEN",
  "PASSWORD",
  "SECRET",
] as const;

/** Personal data, masked under the same switch. */
export const MASK_PERSONAL_KINDS = [
  "EMAIL",
  "PHONE",
  "ID_CARD",
  "CARD",
  "IBAN",
  "SSN",
  "PASSPORT",
  "BIRTHDAY",
  "MAC",
  "SERIAL",
  "IP",
  "USERNAME",
  "HOSTNAME",
  "BUCKET",
] as const;

export const MASK_KINDS = [...MASK_SECRET_KINDS, ...MASK_PERSONAL_KINDS] as const;

/** The facets that narrow the records list, as the daemon counts them. */
export type MaskFacet = "" | "secret" | "rule" | "blocked";

/** A record's values as the page ranks them, one row per kind. */
export interface RankedKind {
  kind: string;
  n: number;
}

export function rankRecordKinds(values: readonly { k: string; n: number }[]): RankedKind[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value.k, (counts.get(value.k) ?? 0) + value.n);
  }
  return [...counts].map(([kind, n]) => ({ kind, n })).sort((left, right) => right.n - left.n);
}

/** A kind's colour is its place in the summary's ranking, or a stable hash. */
export function kindColorIndex(kind: string, ranking: readonly { name: string }[]): number {
  const at = ranking.findIndex((entry) => entry.name === kind);
  if (at >= 0) {
    return at % 7;
  }
  let hash = 0;
  for (const character of kind) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return hash % 7;
}

export function formatCount(n: number): string {
  return n.toLocaleString();
}

/** What a value looks like masked: what it starts with, the rest dots. */
export function maskShape(head: string | undefined, length: number): string {
  const visible = [...(head ?? "")];
  const dots = Math.max(1, Math.min(length - visible.length, 8));
  return `${visible.join("")}${"•".repeat(dots)}`;
}

export function dayLabel(day: string, todayLabel: string): string {
  const date = new Date(`${day}T00:00:00`);
  if (Number.isNaN(date.getTime())) {
    return day;
  }
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return todayLabel;
  }
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function timeLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export function recordDayKey(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate(),
  ).padStart(2, "0")}`;
}

export function recordDayName(iso: string, todayLabel: string, yesterdayLabel: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((start - day) / 86_400_000);
  if (days === 0) {
    return todayLabel;
  }
  if (days === 1) {
    return yesterdayLabel;
  }
  return date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

export function splitValues(text: string): string[] {
  return text
    .split(/[,，\n]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * A poll refreshes the first page only. Keep the older pages already loaded
 * below it, so a reader who asked for more does not watch the list collapse
 * back to the first page every refresh; records are newest first by key.
 */
export function mergeMaskingFirstPage(
  current: readonly GatewayMaskingRecordWire[],
  first: readonly GatewayMaskingRecordWire[],
): GatewayMaskingRecordWire[] {
  const firstKeys = new Set(first.map((record) => record.key));
  const oldest = first.at(-1);
  const older = current.filter(
    (record) =>
      !firstKeys.has(record.key) &&
      (oldest === undefined || Number(record.key) < Number(oldest.key)),
  );
  return [...first, ...older];
}

/** The summary's numbers while its first read is still out are not zero. */
export function maskingSummaryPending(loading: boolean, summary: unknown): boolean {
  return loading && summary === null;
}
