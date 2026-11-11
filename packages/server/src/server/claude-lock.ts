import { promises as fs } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";

/**
 * The mkdir locks Claude Code holds while it saves its files, taken as
 * Claude Code takes them (2.1.316, its bundled proper-lockfile): a lock is
 * a directory made with mkdir, held while it stands and let go by removing
 * it. Its holder touches it every few seconds; one not touched for longer
 * than the lock's stale time is left by a holder that died, and is taken
 * over (myna internal/claudelock/claudelock.go).
 *
 * Neolix writes `~/.claude.json` for the Library's MCP page, and Claude Code
 * saves the same file: without the lock a save of ours can land while
 * Claude Code is mid-write, and one of the two changes is lost.
 */
export const CLAUDE_REFRESH_STALE_MS = 60_000;
export const CLAUDE_CONFIG_STALE_MS = 10_000;

export class ClaudeLockHeldError extends Error {
  public readonly lockPath: string;

  // No constructor parameter property: Node's --experimental-strip-types
  // (the daemon worker's loader) cannot transform one.
  constructor(lockPath: string) {
    super("Claude Code is saving its settings: try again in a moment");
    this.name = "ClaudeLockHeldError";
    this.lockPath = lockPath;
  }
}

export interface ClaudeLockOptions {
  /** How long to wait for Claude Code to let the lock go. */
  waitMs?: number;
  /** How often a held lock is looked at again. */
  pollMs?: number;
  /** How often a lock we hold is touched, so it never reads as left behind. */
  touchMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export interface ClaudeLock {
  release(): Promise<void>;
}

/**
 * `~/.claude.json`'s lock: the file's real path (proper-lockfile resolves
 * symlinks) plus ".lock". A file whose folder isn't there yet (Claude Code
 * never run) has no lock to wait for.
 */
export async function lockClaudeConfig(
  configPath: string,
  options: ClaudeLockOptions = {},
): Promise<ClaudeLock> {
  let resolved = configPath;
  try {
    resolved = await fs.realpath(configPath);
  } catch {
    // Not there yet: lock the path it will be written at.
  }
  try {
    const info = await fs.stat(path.dirname(resolved));
    if (!info.isDirectory()) {
      return { release: async () => undefined };
    }
  } catch {
    return { release: async () => undefined };
  }
  return takeClaudeLock(`${resolved}.lock`, CLAUDE_CONFIG_STALE_MS, options);
}

/**
 * Make the lock directory `lockPath`, waiting while another holds it and
 * taking over one left stale. Held, it is touched until released.
 */
export async function takeClaudeLock(
  lockPath: string,
  staleMs: number,
  options: ClaudeLockOptions = {},
): Promise<ClaudeLock> {
  const waitMs = options.waitMs ?? 20_000;
  const pollMs = options.pollMs ?? 100;
  const touchMs = options.touchMs ?? 2_000;
  const now = options.now ?? (() => Date.now());
  const wait = options.sleep ?? sleep;
  const deadline = now() + waitMs;
  for (;;) {
    try {
      await fs.mkdir(lockPath, { mode: 0o755 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      const info = await fs.stat(lockPath).catch(() => null);
      if (info !== null && now() - info.mtimeMs > staleMs) {
        // Its holder died without letting it go: Claude Code takes such a
        // lock over the same way.
        const removed = await fs.rmdir(lockPath).then(
          () => true,
          () => false,
        );
        if (removed) {
          continue;
        }
      }
      if (now() > deadline) {
        throw new ClaudeLockHeldError(lockPath);
      }
      await wait(pollMs);
    }
  }
  let released = false;
  let timer: NodeJS.Timeout | null = setInterval(() => {
    const at = new Date();
    void fs.utimes(lockPath, at, at).catch(() => undefined);
  }, touchMs);
  timer.unref?.();
  return {
    async release() {
      if (released) {
        return;
      }
      released = true;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      await fs.rmdir(lockPath).catch(() => undefined);
    },
  };
}
