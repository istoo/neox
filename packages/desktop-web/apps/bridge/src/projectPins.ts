// Project pins are a front-end preference: Neox's project registry has no pin field.
// They are kept per environment in a bridge-local JSON file so the sidebar order survives
// bridge restarts. The file is shared by every host this bridge serves; each host writes only
// its own environment key.
import * as fs from "node:fs/promises";
import * as path from "node:path";

type StoredPins = Record<string, string[]>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class ProjectPins {
  private readonly pinned = new Set<string>();
  private loadPromise: Promise<void> | null = null;

  constructor(
    private readonly options: {
      readonly file: string;
      /** Host-environment key this instance reads and writes. */
      readonly scope: string;
      readonly log: (line: string) => void;
    },
  ) {}

  /** Reads the pins once; callers await this before asking `isPinned`. */
  load(): Promise<void> {
    this.loadPromise ??= this.read();
    return this.loadPromise;
  }

  private async read(): Promise<void> {
    try {
      const raw = JSON.parse(await fs.readFile(this.options.file, "utf8")) as unknown;
      if (!isRecord(raw)) return;
      const entries = raw[this.options.scope];
      if (!Array.isArray(entries)) return;
      for (const entry of entries) {
        if (typeof entry === "string" && entry.length > 0) this.pinned.add(entry);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.options.log(`project pins unreadable, starting empty: ${String(error)}`);
      }
    }
  }

  isPinned(projectId: string): boolean {
    return this.pinned.has(projectId);
  }

  /** Updates this host's pins and rewrites the shared file (temp file, then rename). */
  async setPinned(projectId: string, pinned: boolean): Promise<void> {
    await this.load();
    if (pinned) this.pinned.add(projectId);
    else this.pinned.delete(projectId);

    const file = this.options.file;
    const stored: StoredPins = {};
    try {
      const raw = JSON.parse(await fs.readFile(file, "utf8")) as unknown;
      if (isRecord(raw)) {
        for (const [scope, entries] of Object.entries(raw)) {
          if (!Array.isArray(entries)) continue;
          const ids = entries.filter(
            (entry): entry is string => typeof entry === "string" && entry.length > 0,
          );
          stored[scope] = ids;
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.options.log(`project pins unreadable, rewriting: ${String(error)}`);
      }
    }
    stored[this.options.scope] = Array.from(this.pinned).toSorted();

    await fs.mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temp, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
    await fs.rename(temp, file);
  }
}
