import { chmod, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildPacks,
  openPack,
  sealPack,
  unpackPacks,
  type PartFileInput,
  type SyncPack,
} from "./archive.js";
import { applyPart, collectPart, SYNC_PARTS, type SyncPart } from "./parts.js";

/**
 * A whole export/import, sealed with a passphrase and packed the way sync
 * packs a part (`archive.ts`). One backup holds every part's files under
 * `<part>/<path>`, so `library/instructions/a.md` travels beside
 * `settings/settings.json` (myna `internal/backup/backup.go`).
 */
export const BACKUP_EXT = ".neolix-backup";
export const BACKUP_DIR = "backups";
const AUTO_FILENAME = "autobackup.json";

export interface BackupAutoConfig {
  enabled: boolean;
  /** Hours between automatic backups; 0 is off. */
  everyHours: number;
  /** How many automatic backups to keep. */
  keep: number;
  /** Whether the backup carries provider and library credentials. */
  keys: boolean;
  /**
   * Whether it carries subscription sign-ins too (myna `autobackup.js:79`).
   * Sealed with the same passphrase as the rest of the file.
   */
  signIns: boolean;
  /** A folder other than `$NEOLIX_HOME/backups`; "" is that one. */
  dir: string;
}

/** What a caller may save: the older fields alone are still a whole config. */
export type BackupAutoConfigInput = Omit<BackupAutoConfig, "signIns" | "dir"> & {
  signIns?: boolean;
  dir?: string;
};

export const DEFAULT_AUTO: BackupAutoConfig = {
  enabled: false,
  everyHours: 24,
  keep: 7,
  keys: false,
  signIns: false,
  dir: "",
};

export interface BackupEntry {
  file: string;
  name: string;
  size: number;
  at: string;
  auto: boolean;
}

export function backupsDir(neolixHome: string): string {
  return path.join(neolixHome, BACKUP_DIR);
}

/** The folder backups live in: the configured one, or `$NEOLIX_HOME/backups`. */
export function resolveBackupDir(neolixHome: string, dir?: string): string {
  const custom = dir?.trim() ?? "";
  return custom.length > 0 ? custom : backupsDir(neolixHome);
}

function autoPath(neolixHome: string): string {
  return path.join(neolixHome, AUTO_FILENAME);
}

export async function loadAutoConfig(neolixHome: string): Promise<BackupAutoConfig> {
  try {
    const parsed: unknown = JSON.parse(await readFile(autoPath(neolixHome), "utf8"));
    if (typeof parsed !== "object" || parsed === null) {
      return { ...DEFAULT_AUTO };
    }
    const input = parsed as Record<string, unknown>;
    return {
      enabled: input.enabled === true,
      everyHours:
        typeof input.everyHours === "number" && input.everyHours > 0
          ? input.everyHours
          : DEFAULT_AUTO.everyHours,
      keep:
        typeof input.keep === "number" && input.keep > 0
          ? Math.floor(input.keep)
          : DEFAULT_AUTO.keep,
      keys: input.keys === true,
      signIns: input.signIns === true,
      dir: typeof input.dir === "string" ? input.dir : "",
    };
  } catch {
    return { ...DEFAULT_AUTO };
  }
}

export async function saveAutoConfig(
  neolixHome: string,
  config: BackupAutoConfigInput,
): Promise<BackupAutoConfig> {
  const dir = typeof config.dir === "string" ? config.dir.trim() : "";
  if (dir.length > 0 && !path.isAbsolute(dir)) {
    throw new Error("The backup folder must be an absolute path on this computer");
  }
  const normalized: BackupAutoConfig = {
    enabled: config.enabled === true,
    everyHours: config.everyHours > 0 ? config.everyHours : DEFAULT_AUTO.everyHours,
    keep: config.keep > 0 ? Math.floor(config.keep) : DEFAULT_AUTO.keep,
    keys: config.keys === true,
    signIns: config.signIns === true,
    dir,
  };
  await mkdir(neolixHome, { recursive: true, mode: 0o700 });
  await writeFile(autoPath(neolixHome), `${JSON.stringify(normalized, null, 2)}\n`, {
    mode: 0o600,
  });
  await chmod(autoPath(neolixHome), 0o600).catch(() => {});
  return normalized;
}

/** Every part's files as one pack, with its paths prefixed by the part. */
async function collectBackupFiles(
  neolixHome: string,
  keys: boolean,
  parts?: Partial<Record<SyncPart, boolean>>,
  signIns?: boolean,
): Promise<PartFileInput[]> {
  const files: PartFileInput[] = [];
  for (const part of SYNC_PARTS) {
    // Shared usage is not setup: no backup carries it (myna's usage folder
    // is beside the backup, never in it).
    if (part === "usage" || parts?.[part] === false) {
      continue;
    }
    const snapshot = await collectPart(part, { neolixHome, keys, signIns });
    for (const file of snapshot.files) {
      files.push({ ...file, path: `${part}/${file.path}` });
    }
  }
  return files;
}

export interface ExportResult {
  file: string;
  name: string;
  size: number;
  at: string;
  /** The parts the file carries, and how many files it holds. */
  parts: SyncPart[];
  files: number;
}

export async function exportBackup(options: {
  neolixHome: string;
  passphrase: string;
  keys: boolean;
  /** Subscription sign-ins go in the file too. */
  signIns?: boolean;
  /** A folder other than `$NEOLIX_HOME/backups`. */
  dir?: string;
  device?: string;
  /** Parts to leave out, as `--no-library` and `--no-agents` ask. */
  parts?: Partial<Record<SyncPart, boolean>>;
}): Promise<ExportResult> {
  if (!options.passphrase) {
    throw new Error("A backup needs a passphrase: it is sealed before it is written");
  }
  const files = await collectBackupFiles(
    options.neolixHome,
    options.keys,
    options.parts,
    options.signIns,
  );
  const at = new Date();
  const pack: SyncPack = buildPacks({
    part: "backup",
    device: options.device ?? os.hostname(),
    takenAt: at.toISOString(),
    files,
  })[0]!;
  const dir = resolveBackupDir(options.neolixHome, options.dir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const name = `neolix-${at.toISOString().replace(/[:.]/g, "-")}${BACKUP_EXT}`;
  const file = path.join(dir, name);
  const sealed = sealPack(pack, options.passphrase);
  await writeFile(file, sealed, { mode: 0o600 });
  await chmod(file, 0o600).catch(() => {});
  return {
    file,
    name,
    size: sealed.byteLength,
    at: at.toISOString(),
    parts: [...new Set(files.map((entry) => entry.path.split("/")[0] as SyncPart))],
    files: files.length,
  };
}

/** The backups in the backups folder, newest first. */
export async function listBackups(neolixHome: string, folder?: string): Promise<BackupEntry[]> {
  const dir = resolveBackupDir(neolixHome, folder);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: BackupEntry[] = [];
  for (const name of names) {
    if (!name.endsWith(BACKUP_EXT)) {
      continue;
    }
    const info = await stat(path.join(dir, name)).catch(() => null);
    if (!info) {
      continue;
    }
    out.push({
      file: path.join(dir, name),
      name,
      size: info.size,
      at: info.mtime.toISOString(),
      auto: name.includes("-auto"),
    });
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

export interface RestoreResult {
  parts: SyncPart[];
  /** The sealed copy of what was here before, when one was kept. */
  saved?: string;
}

/**
 * Applies a backup over this computer's setup. The setup here before is
 * sealed into `backups/pre-restore-<stamp>` first, so a restore can be
 * undone by restoring that file (myna's auto restore keeps the same).
 */
export async function restoreBackup(options: {
  neolixHome: string;
  file: string;
  passphrase: string;
  keys: boolean;
  /** Sign-ins in the file are brought in; absent follows `keys`. */
  signIns?: boolean;
  /** Where the pre-restore copy is kept; `$NEOLIX_HOME/backups` by default. */
  dir?: string;
  /** Parts to leave as they are here. */
  parts?: Partial<Record<SyncPart, boolean>>;
}): Promise<RestoreResult> {
  const sealed = await readFile(options.file);
  let pack: SyncPack;
  try {
    pack = openPack(sealed, options.passphrase);
  } catch (error) {
    throw new Error(
      `The backup can't be opened: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const grouped = new Map<SyncPart, PartFileInput[]>();
  for (const file of unpackPacks([pack])) {
    const slash = file.path.indexOf("/");
    if (slash < 0) {
      continue;
    }
    const part = file.path.slice(0, slash) as SyncPart;
    if (
      !(SYNC_PARTS as readonly string[]).includes(part) ||
      part === "usage" ||
      options.parts?.[part] === false
    ) {
      continue;
    }
    const list = grouped.get(part) ?? [];
    list.push({ ...file, path: file.path.slice(slash + 1) });
    grouped.set(part, list);
  }
  if (grouped.size === 0) {
    throw new Error("The backup holds no Neox setup");
  }

  let saved: string | undefined;
  try {
    const before = await exportBackup({
      neolixHome: options.neolixHome,
      passphrase: options.passphrase,
      keys: options.keys,
      signIns: options.signIns,
      dir: resolveBackupDir(options.neolixHome, options.dir),
      device: os.hostname(),
    });
    saved = before.file;
    // Name it so listBackups can tell it apart and auto keep can leave it.
    const renamed = path.join(
      path.dirname(before.file),
      `pre-restore-${path.basename(before.file).replace("neolix-", "")}`,
    );
    await rm(renamed, { force: true });
    await writeFile(renamed, await readFile(before.file), { mode: 0o600 });
    await rm(before.file, { force: true });
    saved = renamed;
  } catch {
    // A setup that can't be read is no reason to refuse the restore.
    saved = undefined;
  }

  const parts = [...grouped.keys()];
  for (const part of parts) {
    await applyPart(part, grouped.get(part) ?? [], {
      neolixHome: options.neolixHome,
      keys: options.keys,
      signIns: options.signIns,
    });
  }
  return { parts, ...(saved ? { saved } : {}) };
}

export async function deleteBackup(file: string): Promise<void> {
  await rm(file, { force: true });
}

/** Writes an automatic backup when one is due, and trims old ones. */
export async function runAutoBackup(
  neolixHome: string,
  passphrase: string | undefined,
): Promise<BackupEntry | null> {
  const config = await loadAutoConfig(neolixHome);
  if (!config.enabled) {
    return null;
  }
  if (!passphrase) {
    throw new Error(
      "An automatic backup needs the sync passphrase: turn sync on, or export a backup by hand",
    );
  }
  const dir = resolveBackupDir(neolixHome, config.dir);
  const last = (await listBackups(neolixHome, config.dir)).find((entry) => entry.auto);
  if (last && Date.now() - Date.parse(last.at) < config.everyHours * 3_600_000) {
    return null;
  }
  const written = await exportBackup({
    neolixHome,
    passphrase,
    keys: config.keys,
    signIns: config.signIns,
    dir,
  });
  const autoName = path.join(dir, written.name.replace(/^neolix-/, "neolix-auto-"));
  await writeFile(autoName, await readFile(written.file), { mode: 0o600 });
  await rm(written.file, { force: true });
  const auto = (await listBackups(neolixHome, config.dir)).filter((entry) => entry.auto);
  for (const old of auto.slice(config.keep)) {
    await deleteBackup(old.file);
  }
  return { ...written, file: autoName, name: path.basename(autoName), auto: true };
}
