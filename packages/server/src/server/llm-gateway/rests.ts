import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "pino";
import { writePrivateFileAtomic } from "../private-files.js";

const FILENAME = "gateway-rests.json";
const SAVE_DEBOUNCE_MS = 2000;
/**
 * A rest that ended longer ago than this is let go from the file. An ended
 * rest keeps its rung until then, so a key that fails again after a restart
 * climbs on from where it was rather than from the first rung (myna's
 * restsKeep).
 */
export const REST_KEEP_MS = 35 * 24 * 60 * 60_000;

/** Credit failures rest longer on every repeat: 30m, 2h, 8h, 1d, 3d, 7d. */
export const CREDIT_LADDER_MS = [
  30 * 60_000,
  2 * 60 * 60_000,
  8 * 60 * 60_000,
  24 * 60 * 60_000,
  3 * 24 * 60 * 60_000,
  7 * 24 * 60 * 60_000,
] as const;

export function creditRestMs(level: number): number {
  const index = Math.min(Math.max(level - 1, 0), CREDIT_LADDER_MS.length - 1);
  return CREDIT_LADDER_MS[index] ?? CREDIT_LADDER_MS[0];
}

/**
 * A 402, or a 4xx whose body talks about credit or balance, follows the ladder.
 * Matching text is how the vendors differ; the ladder is the same.
 */
export function isCreditFailure(status: number, body: string): boolean {
  if (status === 402) {
    return true;
  }
  if (status !== 400 && status !== 403 && status !== 429) {
    return false;
  }
  return /insufficient|credit|balance|payment required|quota exceeded/i.test(body);
}

export interface SavedRest {
  key: string;
  until: number;
  level: number;
}

/**
 * Credit-ladder rests outlive a daemon restart. A rest that ended keeps its
 * rung for REST_KEEP_MS, as myna keeps it; short rests (a rate limit, an
 * outage) stay in memory, matching how quickly they expire.
 */
export class RestStore {
  public readonly filePath: string;

  private readonly logger: Logger;
  private timer: NodeJS.Timeout | null = null;
  private pending: Map<string, SavedRest> | null = null;
  private disposed = false;
  /** The last save written or in flight; `dispose()` waits for it. */
  private flushing: Promise<void> = Promise.resolve();

  constructor(options: { neolixHome: string; logger: Logger }) {
    this.filePath = path.join(options.neolixHome, FILENAME);
    this.logger = options.logger;
  }

  public async load(now: number): Promise<Map<string, SavedRest>> {
    let text: string;
    try {
      text = await readFile(this.filePath, "utf8");
    } catch {
      return new Map();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return new Map();
    }
    const result = new Map<string, SavedRest>();
    for (const entry of readEntries(parsed)) {
      if (entry.until > now - REST_KEEP_MS) {
        result.set(entry.key, { ...entry, level: clampLevel(entry.level) });
      }
    }
    return result;
  }

  public scheduleSave(rests: ReadonlyMap<string, SavedRest>): void {
    if (this.disposed) {
      return;
    }
    this.pending = new Map(rests);
    if (this.timer !== null) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      const snapshot = this.pending;
      this.pending = null;
      if (snapshot !== null) {
        this.flushing = this.flushing.then(() => this.flush(snapshot));
      }
    }, SAVE_DEBOUNCE_MS);
    this.timer.unref();
  }

  /** Waits for the save in flight, then refuses new ones. */
  public async dispose(): Promise<void> {
    if (!this.disposed) {
      this.disposed = true;
      if (this.timer !== null) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      const snapshot = this.pending;
      this.pending = null;
      if (snapshot !== null) {
        this.flushing = this.flushing.then(() => this.flush(snapshot));
      }
    }
    await this.flushing;
  }

  private async flush(rests: ReadonlyMap<string, SavedRest>): Promise<void> {
    const now = Date.now();
    const entries: SavedRest[] = [];
    for (const entry of rests.values()) {
      if (entry.until > now - REST_KEEP_MS) {
        entries.push({ key: entry.key, until: entry.until, level: clampLevel(entry.level) });
      }
    }
    try {
      await writePrivateFileAtomic(
        this.filePath,
        `${JSON.stringify({ version: 1, rests: entries }, null, 2)}\n`,
      );
    } catch (error) {
      this.logger.error({ err: error, file: this.filePath }, "Cannot save gateway rests");
    }
  }
}

function clampLevel(level: number): number {
  return Math.min(Math.max(Math.trunc(level), 1), CREDIT_LADDER_MS.length);
}

function readEntries(parsed: unknown): SavedRest[] {
  if (!isRecord(parsed) || !Array.isArray(parsed.rests) || parsed.version !== 1) {
    return [];
  }
  const entries: SavedRest[] = [];
  for (const entry of parsed.rests) {
    if (!isRecord(entry)) {
      continue;
    }
    const key = entry.key;
    const until = entry.until;
    const level = entry.level;
    if (typeof key !== "string" || typeof until !== "number" || typeof level !== "number") {
      continue;
    }
    entries.push({ key, until, level });
  }
  return entries;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
