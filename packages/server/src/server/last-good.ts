import { promises as fs } from "node:fs";
// eslint-disable-next-line neolix/no-sync-io -- loadPersistedConfig is synchronous by design (startup and offline CLI); its last-good fallback has no async caller.
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readFileSteady, statSteady, writeFileSteady } from "./steady.js";

/**
 * Keeps the last good generation of Neolix's own state files (accounts,
 * sign-ins, providers, settings) and reads it back when the file itself
 * can't be read, as myna's lastgood package does
 * (internal/lastgood/lastgood.go).
 *
 * A Windows machine that went down mid-write left logins.json at its full
 * length with every byte zero (#1505). Neolix then read no accounts, and
 * its next write made that final. Here a file that is there but not valid
 * is unknown, never empty: before each write the file there now is kept as
 * `<file>.bak` when it is valid, or copied aside as `<file>.bad-<time>`
 * when it isn't, and a read of a file that isn't valid gives the .bak's
 * contents instead, noted for the GUI and the log.
 */
export type Valid = (contents: Buffer) => boolean;

/** Whether a file holds one JSON value: empty, whitespace or cut short is not. */
export function isValidJson(contents: Buffer): boolean {
  const text = contents.toString("utf8").replace(/^﻿/, "");
  if (text.trim().length === 0) {
    return false;
  }
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** Whether a file parses into the shape its reader expects. */
export function isValidJsonAs<T>(contents: Buffer, parse: (value: unknown) => T): boolean {
  if (!isValidJson(contents)) {
    return false;
  }
  try {
    parse(JSON.parse(contents.toString("utf8").replace(/^﻿/, "")) as unknown);
    return true;
  } catch {
    return false;
  }
}

export const UNREADABLE = "unreadable";

/** A file that is there but neither it nor its .bak is valid: unknown, never empty. */
export class UnreadableFileError extends Error {
  public readonly code = UNREADABLE;
  public readonly filePath: string;
  public readonly reason: string;

  // Fields are assigned here rather than declared as constructor parameter
  // properties: Node's --experimental-strip-types (the daemon worker's
  // loader) erases types but cannot transform parameter properties.
  constructor(filePath: string, reason: string) {
    super(`${filePath} can't be read (${reason}) and has no good backup`);
    this.name = "UnreadableFileError";
    this.filePath = filePath;
    this.reason = reason;
  }
}

export interface LastGoodNote {
  /** The file's name: logins.json. */
  file: string;
  path: string;
  /** What was wrong with it. */
  why: string;
  /** When the .bak was written; null when it can't be read. */
  bak: Date | null;
  at: Date;
}

const notes = new Map<string, LastGoodNote>();

/** The files read back from their last good generation since start. */
export function recoveredFiles(): LastGoodNote[] {
  return [...notes.values()];
}

/** Forget the notes; for tests. */
export function resetRecoveredFiles(): void {
  notes.clear();
}

function note(filePath: string, why: string, bakTime: Date | null): void {
  if (notes.has(filePath)) {
    return;
  }
  const entry: LastGoodNote = {
    file: path.basename(filePath),
    path: filePath,
    why,
    bak: bakTime,
    at: new Date(),
  };
  notes.set(filePath, entry);
  // The daemon's log, where a recovery can be found later.
  console.warn(
    { file: entry.file, why, bak: bakTime?.toISOString() ?? null },
    "State file unreadable; using its last good backup",
  );
}

/** What is wrong with a bad file, in the words the log and GUI use. */
export function describeBadFile(contents: Buffer | null): string {
  if (contents === null) {
    return "it doesn't parse";
  }
  if (contents.length > 0 && contents.every((byte) => byte === 0)) {
    return `${contents.length} bytes, every one zero`;
  }
  if (contents.toString("utf8").trim().length === 0) {
    return "it is empty";
  }
  return "it doesn't parse";
}

/** Where `filePath`'s last good generation is kept. */
export function backupPath(filePath: string): string {
  return `${filePath}.bak`;
}

/**
 * Read `filePath` when valid; a file there that isn't gives its .bak's
 * contents when that is valid, noted. A file not there is ENOENT and its
 * .bak is not looked at: a crash leaves a file renamed over as it was or
 * as it became, never gone, so one gone was removed on purpose.
 */
export async function readLastGood(filePath: string, valid: Valid): Promise<Buffer> {
  const contents = await readFileSteady(filePath);
  if (valid(contents)) {
    return contents;
  }
  return fallbackToLastGood(filePath, contents, valid);
}

/** `readLastGood` for a synchronous startup path. */
export function readLastGoodSync(filePath: string, valid: Valid): Buffer {
  const contents = readFileSync(filePath);
  if (valid(contents)) {
    return contents;
  }
  const why = describeBadFile(contents);
  try {
    const backup = readFileSync(backupPath(filePath));
    if (valid(backup)) {
      let bak: Date | null = null;
      try {
        bak = statSync(backupPath(filePath)).mtime;
      } catch {
        // a .bak that went away between read and stat
      }
      note(filePath, why, bak);
      return backup;
    }
  } catch {
    // no .bak, or it isn't valid: unknown, not empty
  }
  throw new UnreadableFileError(filePath, why);
}

/** `keepLastGood` for a synchronous startup path. */
export function keepLastGoodSync(filePath: string, valid: Valid, mode = 0o600): void {
  if (!existsSync(filePath)) {
    return;
  }
  const contents = readFileSync(filePath);
  if (valid(contents)) {
    if (existsSync(backupPath(filePath))) {
      try {
        if (readFileSync(backupPath(filePath)).equals(contents)) {
          return;
        }
      } catch {
        // replace an unreadable .bak
      }
    }
    writeFileSync(backupPath(filePath), contents, { mode });
    return;
  }
  const stamp = `${filePath}.bad-${timestamp(new Date())}`;
  writeFileSync(stamp, contents, { flag: "wx", mode: 0o600 });
  console.warn(
    { file: path.basename(filePath), kept: path.basename(stamp), why: describeBadFile(contents) },
    "State file unreadable; kept aside",
  );
}

/** Read a JSON state file, falling back to its .bak when it is unreadable. */
export async function readJsonLastGood(filePath: string): Promise<unknown> {
  const contents = await readLastGood(filePath, isValidJson);
  return JSON.parse(contents.toString("utf8").replace(/^﻿/, "")) as unknown;
}

/**
 * `readLastGood` for a caller that read the file itself and found it bad
 * (`contents` may be null when only its parse said so).
 */
export async function fallbackToLastGood(
  filePath: string,
  contents: Buffer | null,
  valid: Valid,
): Promise<Buffer> {
  const why = describeBadFile(contents);
  try {
    const backup = await readFileSteady(backupPath(filePath));
    if (valid(backup)) {
      const info = await statSteady(backupPath(filePath)).catch(() => null);
      note(filePath, why, info?.mtime ?? null);
      return backup;
    }
  } catch {
    // no .bak, or it isn't valid: unknown, not empty
  }
  throw new UnreadableFileError(filePath, why);
}

/**
 * Called before `filePath` is replaced, under the writer's lock: the file
 * there now, when valid, becomes the last good generation, `<file>.bak`,
 * written to the disk before the new file is; one that isn't valid is
 * copied aside (`<file>.bad-<time>`) and the .bak left as it is, so a file
 * that can't be read is never written over before a copy of it is kept. A
 * file not there needs neither. An error stops the write.
 */
export async function keepLastGood(filePath: string, valid: Valid, mode = 0o600): Promise<void> {
  let contents: Buffer;
  try {
    contents = await readFileSteady(filePath);
  } catch (error) {
    if (isMissing(error)) {
      return;
    }
    throw error;
  }
  if (valid(contents)) {
    try {
      const previous = await readFileSteady(backupPath(filePath));
      if (previous.equals(contents)) {
        return;
      }
    } catch {
      // no .bak yet
    }
    await writeFileSteady(backupPath(filePath), contents, mode);
    return;
  }
  await keepBadFile(filePath, contents);
}

/**
 * Keep a file that doesn't parse, before a writer whose reader takes it as
 * empty writes over it, so the write doesn't lose what it held. A file not
 * there, or empty, needs nothing.
 */
export async function keepUnparsed(filePath: string, parses: Valid): Promise<void> {
  let contents: Buffer;
  try {
    contents = await readFileSteady(filePath);
  } catch (error) {
    if (isMissing(error)) {
      return;
    }
    throw error;
  }
  if (contents.toString("utf8").trim().length === 0 || parses(contents)) {
    return;
  }
  await keepBadFile(filePath, contents);
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/**
 * Copy a bad file aside as `<file>.bad-<time>`, deduplicated by content.
 * Returns the name it is kept under.
 */
export async function keepBadFile(filePath: string, contents: Buffer): Promise<string> {
  const already = await keptAlready(filePath, contents);
  if (already !== null) {
    return already;
  }
  const stamp = `${filePath}.bad-${timestamp(new Date())}`;
  for (let index = 1; index < 1000; index += 1) {
    const name = index === 1 ? stamp : `${stamp}-${index}`;
    try {
      await fs.writeFile(name, contents, { flag: "wx", mode: 0o600 });
      console.warn(
        {
          file: path.basename(filePath),
          kept: path.basename(name),
          why: describeBadFile(contents),
        },
        "State file unreadable; kept aside",
      );
      return name;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        continue;
      }
      throw error;
    }
  }
  throw new Error(
    `${path.basename(filePath)} can't be read and there is no free name to keep it under`,
  );
}

function timestamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

async function keptAlready(filePath: string, contents: Buffer): Promise<string | null> {
  const folder = path.dirname(filePath);
  const prefix = `${path.basename(filePath)}.bad-`;
  let entries: string[];
  try {
    entries = await fs.readdir(folder);
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) {
      continue;
    }
    const candidate = path.join(folder, entry);
    try {
      const info = await fs.stat(candidate);
      if (info.size !== contents.length) {
        continue;
      }
      if ((await fs.readFile(candidate)).equals(contents)) {
        return candidate;
      }
    } catch {
      // a file that went away between readdir and stat
    }
  }
  return null;
}
