import { z } from "zod";

/**
 * The sign-ins a plugin keeps for its providers, one entry per account as
 * myna's `plugin-auth.json` holds them: an id the plugin chooses (`qoder`,
 * `qoder#second`) and the auth object its own sign-in wrote.
 *
 * The store belongs to the installation, not the process: it outlives a
 * reload and goes away when the plugin is removed. A plugin only ever sees
 * its own entries.
 */
export interface PluginAccounts {
  /** The ids this plugin has stored, sorted. */
  list(): Promise<string[]>;
  /** One entry, or null when there is none. Throws when the file is unreadable. */
  read(id: string): Promise<Record<string, unknown> | null>;
  /** Writes one entry, replacing the id's previous auth. */
  write(id: string, auth: Record<string, unknown>): Promise<void>;
  /** Removes one entry; true when there was one. */
  remove(id: string): Promise<boolean>;
}

/** A store call that can't be served. */
export class PluginAccountsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginAccountsError";
  }
}

/** Ids a plugin may store: no controls, no path separators, bounded. */
export function assertPluginAccountId(id: string): string {
  const trimmed = id.trim();
  if (trimmed === "" || trimmed.length > 256) {
    throw new PluginAccountsError("Account id must be 1-256 characters");
  }
  if (/[/\\]/.test(trimmed)) {
    throw new PluginAccountsError(`Invalid account id: ${id}`);
  }
  for (const character of trimmed) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      throw new PluginAccountsError(`Invalid account id: ${id}`);
    }
  }
  return trimmed;
}

/** An auth object must be JSON, never an array or a primitive. */
export function assertPluginAccountAuth(auth: unknown): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = z.json().parse(auth);
  } catch {
    throw new PluginAccountsError("Account auth must be JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new PluginAccountsError("Account auth must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}
