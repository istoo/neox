import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Logger } from "pino";
import { mergeAntigravityModels, type AntigravityModel } from "./codeassist.js";
import {
  providerAccounts,
  type GatewayConfigStore,
  type GatewayModel,
  type GatewayProvider,
} from "./config.js";
import { fetchAntigravityModels, type GoogleOptions } from "./google-signin.js";
import {
  loadAnySubscriptionAccounts,
  saveSubscriptionAccounts,
  subscriptionAccountsFile,
  type GoogleSubscriptionAccount,
} from "./subscription-store.js";

/**
 * Antigravity's models are per account: each signed-in account lists the
 * ones its picker shows, and a provider signed in to several serves their
 * union, in the order each account has them (`antigravity_pool.go`). The
 * lists are kept beside the account store so a daemon restart serves the
 * last pool before the first refresh, like myna's catalog.
 */

export const ANTIGRAVITY_POOL_FILE = "antigravity-models.json";

export interface AntigravityPool {
  /** Each account's own list, by user. */
  accounts: Record<string, readonly AntigravityModel[]>;
  /** Every account's lists merged (`mergeAntigravityModels`). */
  pooled: readonly AntigravityModel[];
}

export interface AntigravityPoolOptions extends GoogleOptions {
  logger?: Logger;
}

export function antigravityPoolFile(gatewayDir: string): string {
  return join(gatewayDir, ANTIGRAVITY_POOL_FILE);
}

const EMPTY_POOL: AntigravityPool = { accounts: {}, pooled: [] };

export async function loadAntigravityPool(gatewayDir: string): Promise<AntigravityPool> {
  let text: string;
  try {
    text = await readFile(antigravityPoolFile(gatewayDir), "utf8");
  } catch {
    return EMPTY_POOL;
  }
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null) {
      return EMPTY_POOL;
    }
    const record = value as { accounts?: unknown; pooled?: unknown };
    return { accounts: readLists(record.accounts), pooled: readList(record.pooled) };
  } catch {
    return EMPTY_POOL;
  }
}

function readLists(value: unknown): Record<string, readonly AntigravityModel[]> {
  const out: Record<string, readonly AntigravityModel[]> = {};
  if (typeof value !== "object" || value === null) {
    return out;
  }
  for (const [user, list] of Object.entries(value)) {
    out[user] = readList(list);
  }
  return out;
}

function readList(value: unknown): AntigravityModel[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (entry): entry is AntigravityModel =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as { id?: unknown }).id === "string",
  );
}

/** Replaces the pool in one step, 0600, so a half-written file is never read. */
export async function saveAntigravityPool(
  gatewayDir: string,
  pool: AntigravityPool,
): Promise<void> {
  const file = antigravityPoolFile(gatewayDir);
  const temp = join(dirname(file), `.${ANTIGRAVITY_POOL_FILE}.${process.pid}.${randomUUID()}.tmp`);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(temp, JSON.stringify(pool), { mode: 0o600 });
  try {
    await rename(temp, file);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

/** Several accounts' lists as one, in each account's picker order. */
export function mergeAntigravityLists(
  lists: readonly (readonly AntigravityModel[])[],
): AntigravityModel[] {
  let pooled: AntigravityModel[] = [];
  for (const list of lists) {
    pooled = mergeAntigravityModels(pooled, list);
  }
  return pooled;
}

/**
 * Asks every Antigravity account for its own list and pools them. An
 * account whose fetch fails keeps the list it had (`antigravity_pool.go`
 * :51-57): one vendor hiccup does not take a working model away.
 */
export async function refreshAntigravityPool(
  gatewayDir: string,
  options: AntigravityPoolOptions = {},
): Promise<AntigravityPool> {
  const file = subscriptionAccountsFile(gatewayDir, "antigravity");
  const all = await loadAnySubscriptionAccounts(file);
  const accounts = all.filter(
    (account): account is GoogleSubscriptionAccount => account.agent === "antigravity",
  );
  const previous = await loadAntigravityPool(gatewayDir);
  const lists: Record<string, readonly AntigravityModel[]> = {};
  const renewed: GoogleSubscriptionAccount[] = [];
  for (const account of accounts) {
    const answer = await fetchAntigravityModels(account, options);
    if ("error" in answer) {
      options.logger?.warn(
        { err: answer.error, account: account.user },
        "Antigravity models not refreshed; keeping the list it had",
      );
      lists[account.user] = previous.accounts[account.user] ?? [];
      continue;
    }
    lists[account.user] = answer.models;
    if (answer.refreshed) {
      renewed.push(answer.account);
    }
  }
  if (renewed.length > 0) {
    const byId = new Map(renewed.map((account) => [account.id, account]));
    await saveSubscriptionAccounts(
      file,
      all.map((account) => byId.get(account.id) ?? account),
    ).catch(() => undefined);
  }
  const pool: AntigravityPool = {
    accounts: lists,
    pooled: mergeAntigravityLists(Object.values(lists)),
  };
  await saveAntigravityPool(gatewayDir, pool).catch(() => undefined);
  return pool;
}

/**
 * The provider with the pool's models served: the pool in its own order,
 * then any model the user added that no account lists. A provider without
 * an Antigravity sign-in is left alone.
 */
export function mergeAntigravityPoolIntoProvider(
  provider: GatewayProvider,
  pooled: readonly AntigravityModel[],
): GatewayProvider | null {
  if (!(provider.accounts ?? []).some((account) => account.agent === "antigravity")) {
    return null;
  }
  if (pooled.length === 0) {
    return provider;
  }
  const existing = new Map(provider.models.map((model) => [model.id, model]));
  const picked = provider.modelMode === "picked";
  const models: GatewayModel[] = pooled.map((model) => {
    const before = existing.get(model.id);
    const base: GatewayModel = before === undefined ? { id: model.id } : { ...before };
    return {
      ...base,
      id: model.id,
      ...(model.context === undefined ? {} : { contextWindow: model.context }),
      ...(model.output === undefined ? {} : { maxOutputTokens: model.output }),
      ...(model.images === undefined ? {} : { images: model.images }),
      ...(picked && before === undefined ? { picked: true } : {}),
    };
  });
  const listed = new Set(pooled.map((model) => model.id));
  for (const model of provider.models) {
    if (!listed.has(model.id)) {
      models.push(model);
    }
  }
  if (sameModels(provider.models, models)) {
    return provider;
  }
  return { ...provider, models };
}

function sameModels(before: readonly GatewayModel[], after: readonly GatewayModel[]): boolean {
  if (before.length !== after.length) {
    return false;
  }
  return before.every((model, index) => {
    const other = after[index];
    return other !== undefined && JSON.stringify(model) === JSON.stringify(other);
  });
}

/**
 * The pool the daemon is serving now. myna keeps Antigravity's pooled list
 * in its catalog store rather than in the provider (`antigravity_pool.go`),
 * and so does Neolix: the file is the source, read over the configured
 * models at request time, never written into `gateway.json`.
 */
let runtimePool: AntigravityPool = EMPTY_POOL;

/** Replaces the models served from the pool; the refresh does this once a beat. */
export function setAntigravityPool(pool: AntigravityPool): void {
  runtimePool = pool;
}

/** Forgets the pool; a test starts from none. */
export function resetAntigravityPool(): void {
  runtimePool = EMPTY_POOL;
}

/**
 * The models a provider serves, with the runtime pool laid over its own:
 * the pool in its picker order, then anything the user added. A provider
 * signed in to no Antigravity account is its config as it is.
 */
export function effectiveProviderModels(provider: GatewayProvider): GatewayModel[] {
  const merged = mergeAntigravityPoolIntoProvider(provider, runtimePool.pooled);
  return merged === null ? provider.models : merged.models;
}

/**
 * Whether an entry is exactly what the pool's merge wrote into the config,
 * and so may be taken back out: a user's own fields (a label, a kind, a
 * different window) mark it theirs and stay.
 */
function isPoolWrite(model: GatewayModel, fromPool: AntigravityModel, picked: boolean): boolean {
  if (model.label !== undefined || model.kind !== undefined) {
    return false;
  }
  return (
    model.contextWindow === fromPool.context &&
    model.maxOutputTokens === fromPool.output &&
    model.images === fromPool.images &&
    model.picked === (picked ? true : undefined)
  );
}

/**
 * Takes the models the old code wrote into `gateway.json` back out, and
 * only those: a model the pool lists but the user has made their own stays.
 * The pool is read at request time now, so the config needs none of them.
 */
export async function clearAntigravityPoolFromConfig(
  store: GatewayConfigStore,
  pooled: readonly AntigravityModel[],
): Promise<void> {
  if (pooled.length === 0) {
    return;
  }
  const config = store.get();
  const byId = new Map(pooled.map((model) => [model.id, model]));
  let changed = false;
  const providers = config.providers.map((provider) => {
    if (!(provider.accounts ?? []).some((account) => account.agent === "antigravity")) {
      return provider;
    }
    const picked = provider.modelMode === "picked";
    const models = provider.models.filter((model) => {
      const fromPool = byId.get(model.id);
      return fromPool === undefined || !isPoolWrite(model, fromPool, picked);
    });
    if (models.length === provider.models.length) {
      return provider;
    }
    changed = true;
    return { ...provider, models };
  });
  if (changed) {
    await store.write({ ...config, providers });
  }
}

/**
 * Refreshes the pool and serves it, when a provider is signed in to an
 * Antigravity account. Nothing is fetched on a machine with none; the last
 * pool read from the file is served until the refresh lands.
 */
export async function refreshAntigravityModels(input: {
  store: GatewayConfigStore;
  gatewayDir: string;
  logger?: Logger;
  options?: GoogleOptions;
}): Promise<void> {
  const config = input.store.get();
  // A daemon that just started serves the pool it last wrote before the
  // first listing answers.
  setAntigravityPool(await loadAntigravityPool(input.gatewayDir));
  const wanted = config.providers.some((provider) =>
    providerAccounts(provider).some((account) => account.agent === "antigravity"),
  );
  if (!wanted) {
    return;
  }
  const pool = await refreshAntigravityPool(input.gatewayDir, {
    ...(input.options === undefined ? {} : input.options),
    ...(input.logger === undefined ? {} : { logger: input.logger }),
  });
  setAntigravityPool(pool);
  // Models earlier builds copied into every provider's config are no longer
  // needed there; the pool serves them over it.
  await clearAntigravityPoolFromConfig(input.store, pool.pooled);
}
