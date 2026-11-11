import { lstat, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface ClaudeWorkDirStats {
  isDirectory(): boolean;
  /** The owner's uid; absent where the platform has none. */
  uid?: number;
  /** The file mode bits, as `fs.Stats.mode`. */
  mode: number;
}

export interface ClaudeWorkDirIo {
  mkdir(dir: string): Promise<void>;
  lstat(dir: string): Promise<ClaudeWorkDirStats>;
}

const defaultIo: ClaudeWorkDirIo = {
  mkdir: async (dir) => {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  },
  lstat: async (dir) => {
    const stats = await lstat(dir);
    return { isDirectory: () => stats.isDirectory(), uid: stats.uid, mode: stats.mode };
  },
};

/** The folder's name in the temp directory, which on Linux every user shares. */
export function claudeWorkDirName(platform: NodeJS.Platform, uid: number | null): string {
  if (platform === "win32" || uid === null) {
    return "neolix-claude-work";
  }
  return `neolix-claude-work-${uid}`;
}

export interface EnsureClaudeWorkDirInput {
  tmpDir?: string;
  platform?: NodeJS.Platform;
  /** The user Neolix runs as; null where the platform has none. */
  uid?: number | null;
  io?: ClaudeWorkDirIo;
}

/**
 * The folder every run of the default account works in. Claude Code tells its
 * model the working directory, and a caller's own folder may be in a git
 * repository whose changing status breaks the cached prefix; the temp
 * directory is in none. It is used only when it is a folder the user owns and
 * no one else can write to: another user could otherwise put a CLAUDE.md in it
 * that every run would read.
 */
export async function ensureClaudeWorkDir(input: EnsureClaudeWorkDirInput = {}): Promise<string> {
  const platform = input.platform ?? process.platform;
  const uid = input.uid === undefined ? currentUid() : input.uid;
  const io = input.io ?? defaultIo;
  const tmpDir = input.tmpDir ?? os.tmpdir();
  const dir = path.join(tmpDir, claudeWorkDirName(platform, uid));
  await io.mkdir(dir);
  return assertClaudeWorkDir(dir, { platform, uid, io });
}

export interface AssertClaudeWorkDirInput {
  platform: NodeJS.Platform;
  uid: number | null;
  io: ClaudeWorkDirIo;
}

async function assertClaudeWorkDir(dir: string, input: AssertClaudeWorkDirInput): Promise<string> {
  const stats = await input.io.lstat(dir);
  if (!stats.isDirectory()) {
    throw new Error(`${dir} is not a folder`);
  }
  if (input.platform === "win32") {
    return dir;
  }
  const permissions = stats.mode & 0o777;
  if ((permissions & 0o022) !== 0) {
    throw new Error(
      `${dir} can be written by others (${permissions.toString(8).padStart(3, "0")})`,
    );
  }
  if (input.uid !== null && stats.uid !== undefined && stats.uid !== input.uid) {
    throw new Error(`${dir} belongs to another user`);
  }
  return dir;
}

function currentUid(): number | null {
  return typeof process.getuid === "function" ? process.getuid() : null;
}
