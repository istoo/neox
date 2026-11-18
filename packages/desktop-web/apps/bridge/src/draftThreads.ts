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
      // COMPAT(environment-id): added in 0.16.5, remove after 2027-05-14.
      /** Older scope keys whose drafts must survive the move to a stable environment id. */
      readonly legacyScopes?: readonly string[] | undefined;
      readonly log: (line: string) => void;
    },
  ) {}

  /** This host's saved drafts, read once. */
  load(): Promise<readonly OrchestrationThreadShell[]> {
    this.loadPromise ??= this.readStored().then(async (stored) => {
      const current = stored[this.options.scope];
      if (Array.isArray(current)) return current.filter(isDraftShell);
      // COMPAT(environment-id): added in 0.16.5, remove after 2027-05-14.
      // Only a scope that has never been written is migrated. Merging on every start would
      // bring back a draft the user deleted after the move, from the legacy key's copy.
      const drafts: OrchestrationThreadShell[] = [];
      const seen = new Set<string>();
      let migrated = false;
      for (const scope of this.options.legacyScopes ?? []) {
        const legacy = stored[scope];
        if (!Array.isArray(legacy)) continue;
        for (const entry of legacy.filter(isDraftShell)) {
          if (seen.has(entry.id)) continue;
          seen.add(entry.id);
          drafts.push(entry);
          migrated = true;
        }
      }
      // Persist a copy under the stable key once, without deleting the legacy key.
      if (migrated) await this.write(drafts);
      return drafts;
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
