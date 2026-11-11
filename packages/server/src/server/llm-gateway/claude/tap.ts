import { access, cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Names the file tap.cjs copies the main turn's replies to. */
export const TAP_ENV = "NEOLIX_CLAUDE_TAP";

/** Names the file the bridge writes the client's extra body to. */
export const TAP_GUARD_ENV = "NEOLIX_CLAUDE_GUARD";

/** Names the folders a tap lives in; tap.cjs knows itself by it. */
export const TAP_PREFIX = "neolix-claude-tap-";

export interface ClaudeTap {
  /** Where tap.cjs and the file it writes live. */
  dir: string;
  /** The file tap.cjs writes its JSON lines to. */
  file: string;
  /** What Claude Code's environment carries to load the tap. */
  env: Record<string, string>;
  /** Removes the tap's folder; the caller reads it before this. */
  drop(): Promise<void>;
}

export interface ClaudeTapOptions {
  /** tap.cjs's path; found beside this module or in the source tree. */
  script?: string;
  /** The user's BUN_OPTIONS, for a Claude Code that is not in a WSL. */
  bunOptions?: string;
  /** Where the helper's own files live; the OS's temporary folder by default. */
  tmpDir?: string;
}

/**
 * Makes Claude Code load tap.cjs before itself (Bun's --preload), and tells
 * it where to write. A path BUN_OPTIONS cannot carry, which it splits at
 * whitespace with no quoting, gives no tap: the caller tells replies whole.
 */
export async function createClaudeTap(options: ClaudeTapOptions = {}): Promise<ClaudeTap | null> {
  const script = options.script ?? (await defaultTapScript());
  try {
    await access(script);
  } catch {
    return null;
  }
  const dir = await mkdtemp(path.join(options.tmpDir ?? os.tmpdir(), TAP_PREFIX));
  const js = path.join(dir, "tap.cjs");
  const file = path.join(dir, "tap.jsonl");
  try {
    if (/[\s]/.test(js)) {
      await rm(dir, { recursive: true, force: true });
      return null;
    }
    await cp(script, js);
    await writeFile(file, "");
  } catch {
    await rm(dir, { recursive: true, force: true });
    return null;
  }
  const preload = `--preload ${js}`;
  const mine = options.bunOptions?.trim();
  const bunOptions = mine ? `${mine} ${preload}` : preload;
  return {
    dir,
    file,
    env: { BUN_OPTIONS: bunOptions, [TAP_ENV]: file },
    drop: () => rm(dir, { recursive: true, force: true }),
  };
}

/** tap.cjs is copied beside this module when built, and lives in assets in the source tree. */
async function defaultTapScript(): Promise<string> {
  const built = fileURLToPath(new URL("./tap.cjs", import.meta.url));
  try {
    await access(built);
    return built;
  } catch {
    return fileURLToPath(new URL("../../../../assets/claude/tap.cjs", import.meta.url));
  }
}
