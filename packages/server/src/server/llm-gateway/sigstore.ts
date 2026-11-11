/**
 * Long values a call's id refers to by a short key: Gemini's thought
 * signatures and a Responses step's reasoning items (myna's
 * gemini_sigstore.go). One file per value under `$NEOLIX_HOME/gateway-sig`,
 * named by the first 12 bytes of its sha256 in base64url (16 characters),
 * so the same value is one file however often it comes. A file is written
 * whole (temp and rename) so a reader never sees half of one, and one not
 * read for 90 days is removed; its call then goes as unsigned history,
 * which the vendors take.
 */
import { createHash, randomUUID } from "node:crypto";
/* eslint-disable neolix/no-sync-io -- 调用 id 在请求解析时解码，同步读写几 KB 的文件，开销有限。 */
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
/* eslint-enable neolix/no-sync-io */
import type { Dirent } from "node:fs";
import path from "node:path";

/** The length of a key in an id. */
export const SIG_KEY_LENGTH = 16;

/** A value not read for this is removed (myna's sigKeep). */
const SIG_KEEP_MS = 90 * 24 * 60 * 60 * 1000;
/** A write lists the folder at most this often (myna's sigPruneTick). */
const SIG_PRUNE_TICK_MS = 60 * 60 * 1000;
/** A temp file a failed write left behind is removed after this. */
const TEMP_KEEP_MS = 60 * 60 * 1000;

let home: string | null = null;
let prunedAt = 0;

/** Where kept values live; a null home turns keeping off. */
export function configureSigstore(neolixHome: string | null): void {
  home = neolixHome;
  prunedAt = 0;
}

function keyOf(value: string): string {
  return createHash("sha256").update(value, "utf8").digest().subarray(0, 12).toString("base64url");
}

function directory(): string | null {
  return home === null ? null : path.join(home, "gateway-sig");
}

/** Marks a file as read, so pruning keeps what a call still refers to. */
function touch(file: string): void {
  const now = new Date();
  utimesSync(file, now, now);
}

/** The short key a value is kept under, or null when it can't be kept. */
export function keepValue(value: string): string | null {
  const dir = directory();
  if (dir === null || value.length === 0) {
    return null;
  }
  const key = keyOf(value);
  const file = path.join(dir, key);
  try {
    if (readFileSync(file, "utf8") === value) {
      touch(file);
      return key;
    }
  } catch {
    // Not kept yet.
  }
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const temp = path.join(dir, `.tmp-${randomUUID()}`);
    writeFileSync(temp, value, { mode: 0o600 });
    renameSync(temp, file);
    pruneSignatures(dir);
    return key;
  } catch {
    return null;
  }
}

/** The value a key was kept under, or null when it is gone or not that key. */
export function keptValue(key: string): string | null {
  const dir = directory();
  if (dir === null || !/^[A-Za-z0-9_-]{16}$/.test(key)) {
    return null;
  }
  const file = path.join(dir, key);
  try {
    const value = readFileSync(file, "utf8");
    if (value.length === 0 || keyOf(value) !== key) {
      return null;
    }
    touch(file);
    return value;
  } catch {
    return null;
  }
}

/** Removes what no call has read for 90 days, and stale temp files. */
function pruneSignatures(dir: string): void {
  const now = Date.now();
  if (now - prunedAt < SIG_PRUNE_TICK_MS) {
    return;
  }
  prunedAt = now;
  let entries: Dirent<string>[];
  try {
    entries = readdirSync(dir, { encoding: "utf8", withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      continue;
    }
    const file = path.join(dir, entry.name);
    try {
      const age = now - statSync(file).mtimeMs;
      if (age > SIG_KEEP_MS || (entry.name.startsWith(".") && age > TEMP_KEEP_MS)) {
        unlinkSync(file);
      }
    } catch {
      // Gone already.
    }
  }
}

/** A call's signature, kept under its key. */
export function keepSignature(value: string): string | null {
  return keepValue(value);
}

/** The signature a key was kept under. */
export function keptSignature(key: string): string | null {
  return keptValue(key);
}
