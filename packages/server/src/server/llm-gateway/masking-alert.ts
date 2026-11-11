import type { MaskingRecord, MaskingRecordStore } from "./masking-records.js";

/** How long after a record its notification waits for more. */
const GATHER_MS = 3_000;
/** The least time from one notification to the next. */
const GAP_MS = 60_000;
/** Past this many records waiting, a record is dropped; its values are still masked. */
const PENDING_MAX = 5000;

export interface MaskingAlertNote {
  total: number;
  kinds: Array<{ name: string; n: number }>;
  agents: string[];
  key: string | null;
}

/**
 * Says that masking swapped a value it never masked before (myna's
 * `mask_alert.go`): the kind and how many, never the value, a burst said
 * once and at most once a minute. A conversation sends its whole history
 * again each turn, so only a placeholder's first record is news.
 *
 * `send` runs when a note is due; `enabled` is read as a record comes and
 * as a note is said, so turning the alert off stops the next one.
 */
export class MaskingAlerts {
  private pending: MaskingRecord[] = [];
  private waiting: ReturnType<typeof setTimeout> | null = null;
  private last = 0;

  public constructor(
    private readonly store: MaskingRecordStore,
    private readonly enabled: () => boolean,
    private readonly send: (note: MaskingAlertNote) => void,
    private readonly now: () => number = Date.now,
  ) {}

  /** Takes a request's record; it is on the request's way, so it only keeps it. */
  public add(record: MaskingRecord): void {
    if (!this.enabled()) {
      return;
    }
    if (this.pending.length >= PENDING_MAX) {
      return;
    }
    this.pending.push(record);
    if (this.waiting !== null) {
      return;
    }
    const wait = Math.max(GATHER_MS, this.last + GAP_MS - this.now());
    this.waiting = setTimeout(() => {
      this.waiting = null;
      this.flush();
    }, wait);
    this.waiting.unref?.();
  }

  /** Stops the timer; a note not yet said is dropped. */
  public stop(): void {
    if (this.waiting !== null) {
      clearTimeout(this.waiting);
      this.waiting = null;
    }
    this.pending = [];
  }

  private flush(): void {
    const records = this.pending;
    this.pending = [];
    if (!this.enabled()) {
      return;
    }
    const kinds = new Map<string, number>();
    const agents: string[] = [];
    const seen = new Set<string>();
    let key: number | null = null;
    for (const record of records) {
      let got = false;
      for (const value of this.store.freshValues(record)) {
        if (seen.has(value.p)) {
          continue;
        }
        seen.add(value.p);
        kinds.set(value.k, (kinds.get(value.k) ?? 0) + 1);
        got = true;
      }
      if (!got) {
        continue;
      }
      key = Math.max(key ?? 0, Number(record.key));
      if (record.agent !== undefined && record.agent.length > 0 && !agents.includes(record.agent)) {
        agents.push(record.agent);
      }
    }
    if (kinds.size === 0) {
      return;
    }
    this.last = this.now();
    this.send({
      total: [...kinds.values()].reduce((sum, n) => sum + n, 0),
      kinds: [...kinds]
        .map(([name, n]) => ({ name, n }))
        .sort((left, right) => right.n - left.n || left.name.localeCompare(right.name)),
      agents,
      key: key === null ? null : String(key),
    });
  }
}
