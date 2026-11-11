// Draft threads are `thread.create` shells that have no Neox agent yet, so the daemon cannot
// list them. A terminal chat stays a draft for its whole life; without this file a bridge restart
// dropped it from the sidebar while its daemon terminal kept running. Drafts are kept per
// environment in one bridge-local JSON file, the same layout as project pins.
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { OrchestrationThreadShell } from "@synara/contracts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The file is ours, but a hand edit or a truncated write must not put a broken row in the shell. */
function isDraftShell(value: unknown): value is OrchestrationThreadShell {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.projectId === "string" &&
    value.projectId.length > 0 &&
    typeof value.title === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string"
  );
}

export class DraftThreads {
  private loadPromise: Promise<readonly OrchestrationThreadShell[]> | null = null;
  /** Writes run one after another so a slow write never lands after a newer one. */
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly options: {
      readonly file: string;
      /** Host-environment key this instance reads and writes. */
      readonly scope: string;
      readonly log: (line: string) => void;
    },
  ) {}

  /** This host's saved drafts, read once. */
  load(): Promise<readonly OrchestrationThreadShell[]> {
    this.loadPromise ??= this.readStored().then((stored) => {
      const entries = stored[this.options.scope];
      return Array.isArray(entries) ? entries.filter(isDraftShell) : [];
    });
    return this.loadPromise;
  }

  /** Replaces this host's drafts; other hosts' entries in the shared file are kept. */
  save(drafts: readonly OrchestrationThreadShell[]): Promise<void> {
    this.writes = this.writes
      .then(() => this.write(drafts))
      .catch((error: unknown) => {
        this.options.log(`draft threads not saved: ${String(error)}`);
      });
    return this.writes;
  }

  private async readStored(): Promise<Record<string, unknown>> {
    try {
      const raw = JSON.parse(await fs.readFile(this.options.file, "utf8")) as unknown;
      return isRecord(raw) ? raw : {};
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.options.log(`draft threads unreadable, starting empty: ${String(error)}`);
      }
      return {};
    }
  }

  private async write(drafts: readonly OrchestrationThreadShell[]): Promise<void> {
    const stored = await this.readStored();
    stored[this.options.scope] = drafts;
    const file = this.options.file;
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temp, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
    await fs.rename(temp, file);
  }
}
