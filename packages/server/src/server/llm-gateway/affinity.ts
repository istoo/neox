import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "pino";
import { writePrivateFileAtomic } from "../private-files.js";

const RETENTION_MS = 24 * 60 * 60_000;
const MAX_BINDINGS = 512;
const SAVE_DEBOUNCE_MS = 2000;
const FILENAME = "gateway-affinity.json";

interface StoredBinding {
  conversation: string;
  value: string;
  at: number;
}

interface StoredFile {
  version: 1;
  bindings: StoredBinding[];
}

/**
 * Conversation-to-upstream bindings survive a daemon restart so a long chat
 * keeps the prompt cache it already paid for. Mirrors myna's affinity.json:
 * newest 512 entries, dropped after one day.
 */
export class AffinityStore {
  public readonly filePath: string;

  private readonly logger: Logger;
  private timer: NodeJS.Timeout | null = null;
  private pending: Map<string, string> | null = null;
  private disposed = false;
  /** The last save written or in flight; `dispose()` waits for it. */
  private flushing: Promise<void> = Promise.resolve();
  /** Each binding's own time, so an unrelated save does not refresh it. */
  private saved = new Map<string, { value: string; at: number }>();

  constructor(options: { neolixHome: string; logger: Logger }) {
    this.filePath = path.join(options.neolixHome, FILENAME);
    this.logger = options.logger;
  }

  public async load(now: number): Promise<Map<string, string>> {
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
    const bindings = readBindings(parsed, now);
    this.saved = new Map(bindings.map((entry) => [entry.conversation, entry]));
    return new Map(bindings.map((entry) => [entry.conversation, entry.value]));
  }

  public scheduleSave(bindings: ReadonlyMap<string, string>): void {
    if (this.disposed) {
      return;
    }
    this.pending = new Map(bindings);
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

  private async flush(bindings: ReadonlyMap<string, string>): Promise<void> {
    const now = Date.now();
    const saved = new Map<string, { value: string; at: number }>();
    const entries: StoredBinding[] = [...bindings].map(([conversation, value]) => {
      const before = this.saved.get(conversation);
      // A value that changed is a new binding; one that did not keeps the
      // time it was made at, so an unrelated save can't keep it alive.
      const at = before !== undefined && before.value === value ? before.at : now;
      saved.set(conversation, { value, at });
      return { conversation, value, at };
    });
    this.saved = saved;
    const newest = entries.slice(-MAX_BINDINGS);
    const file: StoredFile = { version: 1, bindings: newest };
    try {
      await writePrivateFileAtomic(this.filePath, `${JSON.stringify(file, null, 2)}\n`);
    } catch (error) {
      this.logger.error({ err: error, file: this.filePath }, "Cannot save gateway affinity");
    }
  }
}

function readBindings(parsed: unknown, now: number): StoredBinding[] {
  if (!isRecord(parsed) || !Array.isArray(parsed.bindings) || parsed.version !== 1) {
    return [];
  }
  const cutoff = now - RETENTION_MS;
  const bindings: StoredBinding[] = [];
  for (const entry of parsed.bindings) {
    if (!isRecord(entry)) {
      continue;
    }
    const conversation = entry.conversation;
    const value = entry.value;
    const at = entry.at;
    if (typeof conversation !== "string" || typeof value !== "string" || typeof at !== "number") {
      continue;
    }
    if (at <= cutoff) {
      continue;
    }
    bindings.push({ conversation, value, at });
  }
  return bindings.slice(-MAX_BINDINGS);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
