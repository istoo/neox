import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assertPluginAccountAuth,
  assertPluginAccountId,
  PluginAccountsError,
  type PluginAccounts,
} from "@neolix/plugin/server/accounts";

interface Document {
  version: 1;
  accounts: Record<string, Record<string, unknown>>;
}

function parseDocument(raw: string): Record<string, Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new PluginAccountsError("Plugin accounts file is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new PluginAccountsError("Plugin accounts file has an unknown shape");
  }
  const document = parsed as Record<string, unknown>;
  const accounts = document.accounts;
  if (
    document.version !== 1 ||
    typeof accounts !== "object" ||
    accounts === null ||
    Array.isArray(accounts)
  ) {
    throw new PluginAccountsError("Plugin accounts file has an unknown shape");
  }
  const out: Record<string, Record<string, unknown>> = {};
  for (const [id, auth] of Object.entries(accounts)) {
    if (typeof auth !== "object" || auth === null || Array.isArray(auth)) {
      throw new PluginAccountsError(`Plugin accounts file has an invalid entry: ${id}`);
    }
    out[id] = auth as Record<string, unknown>;
  }
  return out;
}

/**
 * One plugin's sign-ins, kept in its own settings directory. Writes are
 * serialized in this process, written atomically at 0600, and refused when
 * the file can't be read, so a damaged file is never replaced with an empty
 * one.
 */
export class PluginAccountsStore implements PluginAccounts {
  private readonly directory: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(directory: string) {
    this.directory = directory;
  }

  list(): Promise<string[]> {
    return this.serial(async () => {
      const accounts = await this.load();
      return Object.keys(accounts).sort();
    });
  }

  read(id: string): Promise<Record<string, unknown> | null> {
    return this.serial(async () => {
      const key = assertPluginAccountId(id);
      const accounts = await this.load();
      return accounts[key] ?? null;
    });
  }

  write(id: string, auth: Record<string, unknown>): Promise<void> {
    return this.serial(async () => {
      const key = assertPluginAccountId(id);
      const value = assertPluginAccountAuth(auth);
      const accounts = await this.load();
      await this.persist({ ...accounts, [key]: value });
    });
  }

  remove(id: string): Promise<boolean> {
    return this.serial(async () => {
      const key = assertPluginAccountId(id);
      const accounts = await this.load();
      if (!(key in accounts)) return false;
      const next = { ...accounts };
      delete next[key];
      await this.persist(next);
      return true;
    });
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(work);
    this.queue = pending.catch(() => undefined);
    return pending;
  }

  private async load(): Promise<Record<string, Record<string, unknown>>> {
    let raw: string;
    try {
      raw = await readFile(this.target(), "utf8");
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return {};
      }
      throw new PluginAccountsError("Plugin accounts file could not be read");
    }
    return parseDocument(raw);
  }

  private async persist(accounts: Record<string, Record<string, unknown>>): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const target = this.target();
    const temporary = `${target}.${randomUUID()}.tmp`;
    const document: Document = { version: 1, accounts };
    const raw = `${JSON.stringify(document, null, 2)}\n`;
    try {
      await writeFile(temporary, raw, { mode: 0o600 });
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private target(): string {
    return path.join(this.directory, "accounts.json");
  }
}
