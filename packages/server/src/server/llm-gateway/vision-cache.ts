import { appendFile, chmod, mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { writePrivateFileAtomic } from "../private-files.js";

/**
 * Completed image descriptions. An agent sends a conversation's images again
 * on every turn, so a description is kept under the image itself: the newest
 * 2048 in memory, and inline images (whose key is their bytes) on disk, so a
 * restart does not describe them again. A URL's bytes can change, so only its
 * in-memory entry is kept.
 */

const FILENAME = "gateway-vision-cache.jsonl";
const VERSION = 2;
const KIND_INLINE = "inline";
const MAX_ENTRIES = 2048;
const COMPACT_AFTER = MAX_ENTRIES * 2;

interface SavedSight {
  version: number;
  kind: string;
  key: string;
  text: string;
  by: string;
}

export interface CachedSight {
  text: string;
  by: string;
}

export class VisionCache {
  public readonly filePath: string;
  private readonly entries = new Map<string, CachedSight>();
  private readonly persisted = new Map<string, CachedSight>();
  private diskLines = 0;
  private saving: Promise<void> = Promise.resolve();

  public constructor(neolixHome: string) {
    this.filePath = path.join(neolixHome, FILENAME);
  }

  /** Loads the inline descriptions a previous run saved. */
  public async start(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.filePath, "utf8");
    } catch {
      return;
    }
    const latest = new Map<string, SavedSight>();
    let lines = 0;
    for (const line of text.split("\n")) {
      if (line.trim().length === 0) {
        continue;
      }
      lines += 1;
      const record = parseSight(line);
      if (record === null) {
        continue;
      }
      latest.delete(record.key);
      latest.set(record.key, record);
    }
    this.diskLines = lines;
    const records = [...latest.values()].slice(-MAX_ENTRIES);
    for (const record of records) {
      this.persisted.set(record.key, { text: record.text, by: record.by });
      this.remember(record.key, { text: record.text, by: record.by });
    }
    await chmod(this.filePath, 0o600).catch(() => undefined);
  }

  /** A description kept under `key`, or null. */
  public get(key: string): CachedSight | null {
    const entry = this.entries.get(key);
    if (entry === undefined) {
      return null;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }

  /**
   * Keeps a description. `persistent` records it on disk; an inline image is
   * content-addressed, so its key is its bytes.
   */
  public set(key: string, sight: CachedSight, persistent: boolean): void {
    this.remember(key, sight);
    if (!persistent) {
      return;
    }
    this.persisted.delete(key);
    this.persisted.set(key, sight);
    while (this.persisted.size > MAX_ENTRIES) {
      const oldest = this.persisted.keys().next();
      if (oldest.done === true) {
        break;
      }
      this.persisted.delete(oldest.value);
    }
    this.saving = this.saving.then(() => this.append(key, sight)).catch(() => undefined);
    if (this.diskLines >= COMPACT_AFTER) {
      this.saving = this.saving.then(() => this.compact()).catch(() => undefined);
    }
  }

  /** Waits for pending writes, so a restart or handover sees a finished cache. */
  public async dispose(): Promise<void> {
    await this.saving;
  }

  private remember(key: string, sight: CachedSight): void {
    this.entries.delete(key);
    this.entries.set(key, sight);
    while (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) {
        break;
      }
      this.entries.delete(oldest.value);
    }
  }

  private async append(key: string, sight: CachedSight): Promise<void> {
    const record: SavedSight = {
      version: VERSION,
      kind: KIND_INLINE,
      key,
      text: sight.text,
      by: sight.by,
    };
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    let prefix = "";
    try {
      const info = await stat(this.filePath);
      if (info.size > 0) {
        const tail = await readFile(this.filePath, { encoding: "utf8" });
        if (!tail.endsWith("\n")) {
          prefix = "\n";
        }
      }
    } catch {
      // A missing file needs no prefix.
    }
    await appendFile(this.filePath, `${prefix}${JSON.stringify(record)}\n`, { mode: 0o600 });
    this.diskLines += 1;
  }

  private async compact(): Promise<void> {
    const lines = [...this.persisted.entries()].map(([key, sight]) =>
      JSON.stringify({
        version: VERSION,
        kind: KIND_INLINE,
        key,
        text: sight.text,
        by: sight.by,
      } satisfies SavedSight),
    );
    await writePrivateFileAtomic(this.filePath, `${lines.join("\n")}\n`);
    this.diskLines = lines.length;
  }
}

function parseSight(line: string): SavedSight | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    record.version !== VERSION ||
    record.kind !== KIND_INLINE ||
    typeof record.key !== "string" ||
    !/^[0-9a-f]{64}$/.test(record.key) ||
    typeof record.text !== "string" ||
    record.text.trim().length === 0 ||
    typeof record.by !== "string" ||
    record.by.trim().length === 0
  ) {
    return null;
  }
  return { version: VERSION, kind: KIND_INLINE, key: record.key, text: record.text, by: record.by };
}
