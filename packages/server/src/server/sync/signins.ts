import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { writePrivateFileAtomic } from "../private-files.js";

/**
 * The subscription sign-ins myna carries in its `sign-ins` share, one file
 * per vendor under `$NEOLIX_HOME/gateway/`. Neolix keeps the same accounts in
 * `codex-accounts.json` and the `subscription-store` files; a sync that is
 * allowed to carry credentials puts them in the settings part.
 *
 * Merged per account: a sign-in renewed later on either computer wins, and
 * one only this computer has is kept. Each account's last-synced hash is
 * kept in the sync state, so a removal on one computer is told apart from a
 * join on the other and is mirrored (myna `MergeSignIns`,
 * `internal/provider/signins_carry.go:280`).
 */
export const SIGNIN_FILES = [
  "gateway/codex-accounts.json",
  "gateway/chatgpt-api-accounts.json",
  "gateway/copilot-accounts.json",
  // Gemini CLI's and Antigravity's accounts share one store
  // (`subscriptionAccountsFile` in `llm-gateway/subscription-store.ts`).
  "gateway/google-accounts.json",
] as const;

export interface SignInBundle {
  files: Record<string, unknown[]>;
}

interface SignInAccount {
  id?: unknown;
  expiresAt?: unknown;
  addedAt?: unknown;
}

function accountId(value: unknown): string | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const id = (value as SignInAccount).id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function renewedAt(value: unknown): number {
  if (typeof value !== "object" || value === null) {
    return 0;
  }
  const account = value as SignInAccount;
  const expires = typeof account.expiresAt === "number" ? account.expiresAt : 0;
  const added = typeof account.addedAt === "number" ? account.addedAt : 0;
  return Math.max(expires, added);
}

async function readAccounts(file: string): Promise<unknown[] | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** This computer's sign-ins, by file; empty when there are none. */
export async function collectSignIns(neolixHome: string): Promise<SignInBundle> {
  const files: Record<string, unknown[]> = {};
  for (const relPath of SIGNIN_FILES) {
    const accounts = await readAccounts(path.join(neolixHome, relPath));
    if (accounts && accounts.length > 0) {
      files[relPath] = accounts;
    }
  }
  return { files };
}

/** Each account's hash as the last sync left it, by account id. */
export type SignInHashes = Record<string, string>;

interface SignInEntry {
  relPath: string;
  account: unknown;
  hash: string;
}

function hashOf(account: unknown): string {
  return createHash("sha256").update(JSON.stringify(account)).digest("hex");
}

function entriesOfBundle(bundle: SignInBundle | null | undefined): Map<string, SignInEntry> {
  const out = new Map<string, SignInEntry>();
  for (const [relPath, accounts] of Object.entries(bundle?.files ?? {})) {
    if (!(SIGNIN_FILES as readonly string[]).includes(relPath) || !Array.isArray(accounts)) {
      continue;
    }
    for (const account of accounts) {
      const id = accountId(account);
      if (id) {
        out.set(id, { relPath, account, hash: hashOf(account) });
      }
    }
  }
  return out;
}

async function entriesHere(neolixHome: string): Promise<Map<string, SignInEntry>> {
  return entriesOfBundle(await collectSignIns(neolixHome));
}

/** The hashes of this computer's sign-ins, to keep in the sync state. */
export async function signInHashes(neolixHome: string): Promise<SignInHashes> {
  const out: SignInHashes = {};
  for (const [id, entry] of await entriesHere(neolixHome)) {
    out[id] = entry.hash;
  }
  return out;
}

/** The sign-ins the settings part carries, or null when it carries none. */
export function signInBundleOf(content: Buffer | string): SignInBundle | null {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.isBuffer(content) ? content.toString("utf8") : content,
    );
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const files = (parsed as { files?: unknown }).files;
    return typeof files === "object" && files !== null
      ? { files: files as Record<string, unknown[]> }
      : null;
  } catch {
    return null;
  }
}

export interface SignInMergeResult {
  /** The merged set differs from the server's: the settings part goes up. */
  changed: boolean;
  hashes: SignInHashes;
}

/**
 * Brings the server's sign-ins in and mirrors removals both ways. An
 * account both sides lack stays gone; one the server dropped while it was
 * unchanged here is removed here; one removed here since the last sync is
 * not brought back. Every account's hash is returned for the next sync.
 */
export async function mergeSignInsOnPull(
  neolixHome: string,
  incoming: SignInBundle | null,
  prev: SignInHashes | undefined,
): Promise<SignInMergeResult> {
  const local = await entriesHere(neolixHome);
  if (!incoming) {
    // An older file carries no sign-ins at all: this computer's go up.
    return { changed: local.size > 0, hashes: hashesOf(local) };
  }
  const remote = entriesOfBundle(incoming);
  const shared = new Map<string, SignInEntry>();
  for (const [id, here] of local) {
    const entry = chooseShared(here, remote.get(id), prev?.[id]);
    if (entry !== null) {
      shared.set(id, entry);
    }
  }
  for (const [id, there] of remote) {
    if (local.has(id) || removedHere(there, prev?.[id])) {
      continue;
    }
    shared.set(id, there);
  }

  const hashes = hashesOf(shared);
  const grouped = groupByFile(shared);
  await writeMergedFiles(neolixHome, grouped);
  const merged = bundleOf(grouped);
  return { changed: JSON.stringify(merged) !== JSON.stringify(incoming), hashes };
}

/** The account both sides have, or null when the other computer removed it. */
function chooseShared(
  here: SignInEntry,
  there: SignInEntry | undefined,
  was: string | undefined,
): SignInEntry | null {
  if (!there) {
    // Removed on the other computer while unchanged here: removed here
    // too. A local addition since the last sync stays.
    return was === undefined || was !== here.hash ? here : null;
  }
  if (there.hash === here.hash) {
    return here;
  }
  if (renewedAt(there.account) > renewedAt(here.account)) {
    return there;
  }
  if (renewedAt(here.account) > renewedAt(there.account)) {
    return here;
  }
  // Neither says it was renewed later: the side changed since the last
  // sync goes on; when both did, or there was none, the one here stays.
  const hereChanged = was === undefined || was !== here.hash;
  const thereChanged = was === undefined || was !== there.hash;
  return thereChanged && !hereChanged ? there : here;
}

/** Whether this computer removed the account since the last sync. */
function removedHere(there: SignInEntry, was: string | undefined): boolean {
  return was !== undefined && was === there.hash;
}

/** The merged accounts by file, ids sorted so a push is deterministic. */
function groupByFile(shared: Map<string, SignInEntry>): Map<string, unknown[]> {
  const grouped = new Map<string, unknown[]>();
  for (const id of [...shared.keys()].sort()) {
    const entry = shared.get(id)!;
    const list = grouped.get(entry.relPath) ?? [];
    list.push(entry.account);
    grouped.set(entry.relPath, list);
  }
  return grouped;
}

async function writeMergedFiles(
  neolixHome: string,
  grouped: Map<string, unknown[]>,
): Promise<void> {
  for (const relPath of SIGNIN_FILES) {
    const next = grouped.get(relPath) ?? [];
    const here = (await readAccounts(path.join(neolixHome, relPath))) ?? [];
    if (JSON.stringify(next) === JSON.stringify(here)) {
      continue;
    }
    await writePrivateFileAtomic(path.join(neolixHome, relPath), `${JSON.stringify(next)}\n`);
  }
}

function hashesOf(entries: Map<string, SignInEntry>): SignInHashes {
  const out: SignInHashes = {};
  for (const [id, entry] of entries) {
    out[id] = entry.hash;
  }
  return out;
}

function bundleOf(grouped: Map<string, unknown[]>): SignInBundle {
  const files: Record<string, unknown[]> = {};
  for (const relPath of SIGNIN_FILES) {
    const accounts = grouped.get(relPath);
    if (accounts && accounts.length > 0) {
      files[relPath] = accounts;
    }
  }
  return { files };
}

/** Merges the bundle's accounts into this computer's, later renewal winning. */
export async function applySignIns(neolixHome: string, bundle: SignInBundle): Promise<void> {
  for (const [relPath, incoming] of Object.entries(bundle.files)) {
    if (!(SIGNIN_FILES as readonly string[]).includes(relPath) || !Array.isArray(incoming)) {
      continue;
    }
    const target = path.join(neolixHome, relPath);
    const here = (await readAccounts(target)) ?? [];
    const merged = new Map<string, unknown>();
    for (const account of here) {
      const id = accountId(account);
      if (id) {
        merged.set(id, account);
      }
    }
    for (const account of incoming) {
      const id = accountId(account);
      if (!id) {
        continue;
      }
      const current = merged.get(id);
      if (current === undefined || renewedAt(account) > renewedAt(current)) {
        merged.set(id, account);
      }
    }
    const next = [...merged.values()];
    if (JSON.stringify(next) === JSON.stringify(here)) {
      continue;
    }
    await writePrivateFileAtomic(target, `${JSON.stringify(next)}\n`);
  }
}
