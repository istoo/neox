import { readFile } from "node:fs/promises";
import { writePrivateFileAtomic } from "../../private-files.js";

/**
 * Renewing a myna plugin sign-in before its access token ends, as the
 * plugin's own fetch does. Neolix never owns the sign-in: it reads myna's
 * `plugin-auth.json`, and a renewal is written back only where that file
 * still holds the token the renewal spent (a compare-and-swap), so a
 * refresh myna did meanwhile is not written over.
 */

/** A token this close to its end is renewed ahead of the request. */
export const TOKEN_EARLY_MS = 10 * 60_000;

export interface RefreshedTokens {
  access: string;
  refresh?: string;
  expires?: number;
}

/** Whether a sign-in's access token is about to end; no expiry is not. */
export function tokenStale(expires: number | undefined, now = Date.now()): boolean {
  return expires !== undefined && expires > 0 && now >= expires - TOKEN_EARLY_MS;
}

/** What one read of myna's sign-ins holds for an entry. */
export async function readAuthEntry(
  authPath: string,
  authKey: string,
): Promise<Record<string, unknown> | null> {
  let text: string;
  try {
    text = await readFile(authPath, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const entry = (parsed as Record<string, unknown>)[authKey];
  return typeof entry === "object" && entry !== null && !Array.isArray(entry)
    ? (entry as Record<string, unknown>)
    : null;
}

/**
 * Writes refreshed tokens back where the entry still holds expectedAccess,
 * merging only the token fields. false: the file changed, and what it holds
 * now is left alone.
 */
export async function writeAuthTokens(input: {
  authPath: string;
  authKey: string;
  expectedAccess: string;
  tokens: RefreshedTokens;
}): Promise<boolean> {
  return writeAuthFields({
    authPath: input.authPath,
    authKey: input.authKey,
    field: "access",
    expected: input.expectedAccess,
    values: {
      access: input.tokens.access,
      ...(input.tokens.refresh === undefined ? {} : { refresh: input.tokens.refresh }),
      ...(input.tokens.expires === undefined ? {} : { expires: input.tokens.expires }),
    },
  });
}

/**
 * Writes fields back where the entry's `field` still holds expected,
 * leaving every other field as it is. false: the file changed, and what it
 * holds now is left alone.
 */
export async function writeAuthFields(input: {
  authPath: string;
  authKey: string;
  field: string;
  expected: string;
  values: Record<string, string | number>;
}): Promise<boolean> {
  let text: string;
  try {
    text = await readFile(input.authPath, "utf8");
  } catch {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
  const all = parsed as Record<string, unknown>;
  const entry = all[input.authKey];
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
  const auth = entry as Record<string, unknown>;
  if (auth[input.field] !== input.expected) {
    return false;
  }
  const next: Record<string, unknown> = {
    ...auth,
    ...input.values,
  };
  const document = { ...all, [input.authKey]: next };
  try {
    await writePrivateFileAtomic(input.authPath, `${JSON.stringify(document, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

/**
 * One renewal in flight per entry, so two requests that read the same old
 * token spend its refresh token once.
 */
const renewing = new Map<string, Promise<unknown>>();

export function renewOnce<T>(key: string, renew: () => Promise<T | null>): Promise<T | null> {
  const running = renewing.get(key);
  if (running !== undefined) return running as Promise<T | null>;
  const started = renew().finally(() => renewing.delete(key));
  renewing.set(key, started);
  return started;
}
