import { appendFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type { Logger } from "pino";

/**
 * The routing history: every finished route as the Routing page sees it,
 * kept a day to a file under `$NEOLIX_HOME/gateway-routing`, one route a
 * line, a day that is over gzipped. Kept 30 days and 200 MiB in all, the
 * oldest days going first — myna's `history.go`.
 */

const KEEP_DAYS = 30;
const KEEP_BYTES = 200 << 20;
const DAY_MOST = 2000;

export class RouteHistory {
  public readonly dir: string;
  private readonly logger: Logger;
  private saving: Promise<void> = Promise.resolve();
  private lines = new Map<string, number>();

  public constructor(options: { neolixHome: string; logger: Logger }) {
    this.dir = path.join(options.neolixHome, "gateway-routing");
    this.logger = options.logger;
  }

  /** Gzips the days that are over and prunes what is too old or too large. */
  public async start(): Promise<void> {
    try {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
    } catch {
      return;
    }
    await this.settle();
  }

  /** Keeps a finished route; nothing is written twice. */
  public record(route: Record<string, unknown>): void {
    const time = typeof route.time === "string" ? Date.parse(route.time) : Number.NaN;
    const day = dayOf(Number.isFinite(time) ? time : Date.now());
    this.saving = this.saving
      .then(() => this.append(day, route))
      .catch((error: unknown) => {
        this.logger.warn({ err: error, day }, "Routing history write failed");
      });
  }

  /** A day's routes, oldest first, at most the latest 2000. */
  public async routes(day: string): Promise<Record<string, unknown>[]> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      return [];
    }
    const plain = path.join(this.dir, `${day}.jsonl`);
    const gz = `${plain}.gz`;
    let text: string;
    try {
      text = await readFile(plain, "utf8");
    } catch {
      try {
        text = gunzipSync(await readFile(gz)).toString("utf8");
      } catch {
        return [];
      }
    }
    const routes: Record<string, unknown>[] = [];
    for (const line of text.split("\n")) {
      if (line.trim().length === 0) {
        continue;
      }
      try {
        const value: unknown = JSON.parse(line);
        if (typeof value === "object" && value !== null && !Array.isArray(value)) {
          routes.push(value as Record<string, unknown>);
        }
      } catch {
        // a half-written last line after a crash
      }
    }
    return routes.slice(-DAY_MOST);
  }

  /** The days on disk, oldest first. */
  public async days(): Promise<string[]> {
    try {
      const names = await readdir(this.dir);
      return names
        .map((name) => /^(\d{4}-\d{2}-\d{2})\.jsonl(\.gz)?$/.exec(name)?.[1] ?? null)
        .filter((name): name is string => name !== null)
        .sort();
    } catch {
      return [];
    }
  }

  public async dispose(): Promise<void> {
    await this.saving;
  }

  private async append(day: string, route: Record<string, unknown>): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await appendFile(path.join(this.dir, `${day}.jsonl`), `${JSON.stringify(route)}\n`, {
      mode: 0o600,
    });
    this.lines.set(day, (this.lines.get(day) ?? 0) + 1);
  }

  private async settle(): Promise<void> {
    const today = dayOf(Date.now());
    let files: { day: string; file: string; size: number; gz: boolean }[];
    try {
      const names = await readdir(this.dir);
      files = [];
      for (const name of names) {
        const match = /^(\d{4}-\d{2}-\d{2})\.jsonl(\.gz)?$/.exec(name);
        if (match === null || typeof match[1] !== "string") {
          continue;
        }
        const file = path.join(this.dir, name);
        try {
          const info = await stat(file);
          files.push({ day: match[1], file, size: info.size, gz: match[2] !== undefined });
        } catch {
          // gone
        }
      }
    } catch {
      return;
    }
    files.sort((left, right) => left.day.localeCompare(right.day));
    const oldest = dayOf(Date.now() - KEEP_DAYS * 86_400_000);
    for (const entry of files) {
      if (entry.day < oldest) {
        await rm(entry.file).catch(() => undefined);
      }
    }
    let total = files.reduce((sum, entry) => sum + entry.size, 0);
    for (const entry of files) {
      if (total <= KEEP_BYTES) {
        break;
      }
      if (entry.day < oldest) {
        continue;
      }
      try {
        await rm(entry.file);
        total -= entry.size;
      } catch {
        // another writer took it
      }
    }
    for (const entry of files) {
      if (entry.gz || entry.day === today) {
        continue;
      }
      try {
        const data = await readFile(entry.file);
        await writeFile(`${entry.file}.gz`, gzipSync(data), { mode: 0o600 });
        await rm(entry.file);
      } catch (error) {
        this.logger.warn({ err: error, day: entry.day }, "Routing history gzip failed");
      }
    }
  }
}

function dayOf(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}
