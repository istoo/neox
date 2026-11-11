import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { LibraryAgentTarget } from "./paths.js";
import { createBackupSession, writeManagedFile } from "./store.js";

export interface BackupFileView {
  /** Path inside the backup folder, shown to the user. */
  file: string;
  /** Bytes in the saved copy. */
  size: number;
  /** Where restoring puts it back, when the file still maps to this agent. */
  target: string | null;
}

export interface BackupSessionView {
  stamp: string;
  files: Record<string, BackupFileView[]>;
}

async function filesUnder(dir: string, prefix = ""): Promise<{ file: string; size: number }[]> {
  const out: { file: string; size: number }[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...(await filesUnder(full, name)));
      continue;
    }
    const info = await stat(full).catch(() => null);
    if (info?.isFile()) {
      out.push({ file: name, size: info.size });
    }
  }
  return out;
}

/** Every backup session, newest first, with its files grouped by agent. */
export async function listBackups(backupsDir: string): Promise<BackupSessionView[]> {
  let stamps: string[];
  try {
    stamps = await readdir(backupsDir);
  } catch {
    return [];
  }
  const sessions: BackupSessionView[] = [];
  for (const stamp of stamps
    .filter((entry) => !entry.startsWith("."))
    .sort()
    .toReversed()) {
    const dir = path.join(backupsDir, stamp);
    const info = await stat(dir).catch(() => null);
    if (!info?.isDirectory()) {
      continue;
    }
    const files: Record<string, BackupFileView[]> = {};
    let agents: string[];
    try {
      agents = await readdir(dir);
    } catch {
      continue;
    }
    for (const agent of agents) {
      const agentDir = path.join(dir, agent);
      const agentInfo = await stat(agentDir).catch(() => null);
      if (!agentInfo?.isDirectory()) {
        continue;
      }
      const listed = await filesUnder(agentDir);
      if (listed.length > 0) {
        files[agent] = listed.map(({ file, size }) => ({ file, size, target: null }));
      }
    }
    if (Object.keys(files).length > 0) {
      sessions.push({ stamp, files });
    }
  }
  return sessions;
}

/** Where a backup file goes back, from the current agent paths. */
export function restoreTargetFor(
  target: LibraryAgentTarget | undefined,
  file: string,
): string | null {
  if (!target || file.includes("/") || file.includes("\\")) {
    return null;
  }
  const candidates = [
    target.instructionsPath,
    target.overridePath,
    target.mcpPath,
    target.hooksPath,
  ].filter(
    (candidate): candidate is string => typeof candidate === "string" && candidate.length > 0,
  );
  for (const candidate of candidates) {
    if (path.basename(candidate) === file) {
      return candidate;
    }
  }
  if (target.subagentsDir) {
    return path.join(target.subagentsDir, file);
  }
  return null;
}

export interface RestoreResult {
  agent: string;
  file: string;
  restored: string;
}

/**
 * Puts one saved file back, keeping the current one aside first. The
 * backup folder is only read; the live file is the only write.
 */
export async function restoreBackup(options: {
  backupsDir: string;
  target: LibraryAgentTarget | undefined;
  stamp: string;
  agent: string;
  file: string;
  now?: Date;
}): Promise<RestoreResult> {
  const { backupsDir, target, stamp, agent, file } = options;
  if (stamp.includes("/") || stamp.includes("\\") || stamp.startsWith(".")) {
    throw new Error("Unknown backup");
  }
  const destination = restoreTargetFor(target, file);
  if (!destination) {
    throw new Error(`${file} cannot be put back: ${agent} no longer reads a file by that name`);
  }
  const source = path.join(backupsDir, stamp, agent, file);
  const info = await stat(source).catch(() => null);
  if (!info?.isFile()) {
    throw new Error(`${file} is not in that backup`);
  }
  const backup = createBackupSession(backupsDir, options.now ?? new Date());
  await backup.keep(agent, destination);
  await writeManagedFile(destination, await readFile(source, "utf8"));
  backup.done();
  return { agent, file, restored: destination };
}
