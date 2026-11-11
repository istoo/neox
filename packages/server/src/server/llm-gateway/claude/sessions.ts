import { randomUUID } from "node:crypto";
import { readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/** How long a cut waits for the line it cuts after to be written. */
export const CUT_WAIT_MS = 2_000;

/** How often the session is read while a cut waits. */
const CUT_POLL_MS = 20;

/** The folder Claude Code keeps a working directory's sessions under. */
export function claudeProjectName(work: string): string {
  return work.replace(/[^A-Za-z0-9]/g, "-");
}

/**
 * The folders Claude Code may keep a run's session in: the work folder as it
 * is, and with every link followed (a Mac's /var is /private/var). More than
 * one is read because the path the process was given and the path Claude Code
 * resolved may differ.
 */
export async function claudeSessionDirs(configDir: string, work: string): Promise<string[]> {
  const names = [work];
  const resolved = await realpath(work).catch(() => "");
  if (resolved !== "" && resolved !== work) {
    names.push(resolved);
  }
  const dirs: string[] = [];
  for (const name of names) {
    const dir = path.join(configDir, "projects", claudeProjectName(name));
    if (!dirs.includes(dir)) {
      dirs.push(dir);
    }
  }
  return dirs;
}

/**
 * A session's transcript as far as the line whose uuid is uuid, under a new
 * id of its own: a branch of it, so a request that didn't make the calls can
 * go on from the reply that did, with the prefix Anthropic cached. The line
 * is waited for (CUT_WAIT_MS), as Claude Code may still be writing it.
 */
export async function cutSession(
  dirs: readonly string[],
  session: string,
  uuid: string,
  waitMs = CUT_WAIT_MS,
): Promise<string> {
  if (!safeName(session) || !safeName(uuid)) {
    throw new Error("no session to cut");
  }
  const mark = `"uuid":"${uuid}"`;
  const until = Date.now() + waitMs;
  for (;;) {
    for (const dir of dirs) {
      const text = await readFile(path.join(dir, `${session}.jsonl`), "utf8").catch(() => null);
      if (text === null) {
        continue;
      }
      const end = cutAfter(text, mark, uuid);
      if (end <= 0) {
        continue;
      }
      const id = randomUUID();
      const lines = text
        .slice(0, end)
        .replaceAll(`"sessionId":"${session}"`, `"sessionId":"${id}"`);
      const file = path.join(dir, `${id}.jsonl`);
      try {
        await writeFile(file, lines, { mode: 0o600 });
      } catch (error) {
        await rm(file, { force: true });
        throw error;
      }
      return id;
    }
    if (Date.now() >= until) {
      throw new Error(`line ${uuid} isn't in session ${session}`);
    }
    await sleep(CUT_POLL_MS);
  }
}

/** Where the whole line whose uuid is uuid ends in a session's text, -1 when it isn't there. */
function cutAfter(text: string, mark: string, uuid: string): number {
  let at = 0;
  while (at < text.length) {
    const end = text.indexOf("\n", at);
    if (end < 0) {
      return -1;
    }
    const line = text.slice(at, end);
    at = end + 1;
    if (!line.includes(mark)) {
      continue;
    }
    try {
      if ((JSON.parse(line) as { uuid?: unknown }).uuid === uuid) {
        return at;
      }
    } catch {
      // a line half written is no line
    }
  }
  return -1;
}

/** Whether a session or line id can name a file of the bridge's own. */
function safeName(value: string): boolean {
  return value !== "" && !value.includes("/") && !value.includes("\\") && !value.includes("..");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Removes a session the bridge owns: its transcript and its side folder. */
export async function removeSession(dirs: readonly string[], session: string): Promise<void> {
  if (session === "" || session.includes("/") || session.includes("\\") || session.includes("..")) {
    return;
  }
  for (const dir of dirs) {
    await rm(path.join(dir, `${session}.jsonl`), { force: true });
    await rm(path.join(dir, session), { recursive: true, force: true });
  }
}

export interface SavedSession {
  session: string;
  dirs: readonly string[];
  /** The conversation key the next turn comes by. */
  key: string;
  at: number;
  timer: NodeJS.Timeout;
}

export interface SessionShelfOptions {
  /** How many saved sessions the shelf keeps; myna keeps 64. */
  most?: number;
  /** How long a saved session waits for its next turn; the cache's hour. */
  ttlMs?: number;
  now?: () => number;
}

/**
 * Conversations whose Claude Code was let go, kept by their transcript: the
 * next turn starts a new process with `--resume`, told only what the caller
 * said since, so Anthropic reads the prefix it cached.
 */
export class ClaudeSessionShelf {
  private readonly entries = new Map<string, SavedSession>();
  private readonly options: SessionShelfOptions;

  public constructor(options: SessionShelfOptions = {}) {
    this.options = options;
  }

  public put(session: string, dirs: readonly string[], key: string): void {
    const old = this.entries.get(key);
    if (old !== undefined) {
      clearTimeout(old.timer);
      this.entries.delete(key);
      void removeSession(old.dirs, old.session);
    }
    const entry: SavedSession = {
      session,
      dirs,
      key,
      at: (this.options.now ?? Date.now)(),
      timer: setTimeout(
        () => {
          const current = this.entries.get(key);
          if (current?.session === session) {
            this.entries.delete(key);
            void removeSession(dirs, session);
          }
        },
        this.options.ttlMs ?? 60 * 60_000,
      ),
    };
    this.entries.set(key, entry);
    while (this.entries.size > (this.options.most ?? 64)) {
      const oldest = [...this.entries.values()].sort((left, right) => left.at - right.at)[0];
      if (oldest === undefined) {
        break;
      }
      clearTimeout(oldest.timer);
      this.entries.delete(oldest.key);
      void removeSession(oldest.dirs, oldest.session);
    }
  }

  /** The shelf's session for a conversation, if one waits there. */
  public get(key: string): SavedSession | undefined {
    return this.entries.get(key);
  }

  public delete(key: string): void {
    const entry = this.entries.get(key);
    if (entry === undefined) {
      return;
    }
    clearTimeout(entry.timer);
    this.entries.delete(key);
  }

  public dispose(): void {
    for (const entry of this.entries.values()) {
      clearTimeout(entry.timer);
      void removeSession(entry.dirs, entry.session);
    }
    this.entries.clear();
  }
}
