import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** A run's budget is an eighth of what this machine's memory holds. */
export const CLAUDE_RUN_FLOOR_BYTES = 1 * (1 << 30);
export const CLAUDE_RUN_UNKNOWN_BYTES = 4 * (1 << 30);

/** The most a kept run may hold resident: an eighth of the memory, 1 GiB at least. */
export function claudeRunBudget(memoryLimitBytes: number): number {
  if (memoryLimitBytes <= 0) {
    return CLAUDE_RUN_UNKNOWN_BYTES;
  }
  return Math.max(memoryLimitBytes / 8, CLAUDE_RUN_FLOOR_BYTES);
}

/**
 * Whether a run holds more than budget times share/2: 2 for a whole turn, 3
 * for a run waiting on tool results (it has no session to shelve there, so it
 * is let go only past half as much again).
 */
export function isOversized(rssBytes: number, budgetBytes: number, share: number): boolean {
  return rssBytes > (budgetBytes * share) / 2;
}

export type ProcessReader = (pid: number) => Promise<number | null>;

/**
 * A process's resident memory in bytes, from `ps`; null when it cannot be
 * read. Claude Code holds about 100 MiB at its start, and on a long
 * conversation can grow to gigabytes.
 */
export async function readProcessRss(pid: number): Promise<number | null> {
  if (pid <= 0) {
    return null;
  }
  try {
    const { stdout } = await run("ps", ["-o", "rss=", "-p", String(pid)]);
    const kib = Number.parseInt(stdout.trim(), 10);
    return Number.isFinite(kib) && kib > 0 ? kib * 1024 : null;
  } catch {
    return null;
  }
}

/** `isOversized` by pid, reading the process's memory; false when it cannot be read. */
export async function oversizedRun(
  pid: number,
  budgetBytes: number,
  share: number,
  reader: ProcessReader = readProcessRss,
): Promise<boolean> {
  const rss = await reader(pid);
  return rss === null ? false : isOversized(rss, budgetBytes, share);
}
