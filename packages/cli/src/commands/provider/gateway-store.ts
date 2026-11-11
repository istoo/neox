import type { Logger } from "pino";
import { resolveNeolixHome } from "@neolix/server/daemon-control";
import {
  GatewayConfigStore,
  providerAccounts,
  type GatewayAccount,
  type GatewayConfig,
  type GatewayProvider,
} from "@neolix/server/gateway-config";

/**
 * The local half of myna's `provider` CLI (`internal/cli/providers_cli.go`):
 * a change is written to this computer's gateway.json, which the daemon
 * watches and takes at once, so no daemon has to be running.
 */

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => silentLogger,
} as unknown as Logger;

export interface StoreOptions {
  home?: string;
  /** The daemon a command that needs runtime state (refresh, test) asks. */
  daemonTarget?: import("../../utils/client.js").ConnectOptions["target"];
}

export async function withGatewayStore<T>(
  options: StoreOptions,
  work: (store: GatewayConfigStore) => Promise<T>,
): Promise<T> {
  const neolixHome = resolveNeolixHome({
    NEOLIX_HOME: options.home ?? process.env.NEOLIX_HOME,
  } as NodeJS.ProcessEnv);
  const store = new GatewayConfigStore({ neolixHome, logger: silentLogger });
  await store.start();
  try {
    return await work(store);
  } finally {
    store.dispose();
  }
}

/** myna's provider.Find: an id first, then the name the user gave it. */
export function findGatewayProvider(config: GatewayConfig, ref: string): GatewayProvider {
  const wanted = ref.trim().toLowerCase();
  const byId = config.providers.find((provider) => provider.id === wanted);
  if (byId !== undefined) {
    return byId;
  }
  const byLabel = config.providers.find(
    (provider) => (provider.label ?? "").trim().toLowerCase() === wanted,
  );
  if (byLabel !== undefined) {
    return byLabel;
  }
  throw new Error(`no provider "${ref}" — neox providers lists them`);
}

export function hasGatewayProvider(config: GatewayConfig, ref: string): boolean {
  const wanted = ref.trim().toLowerCase();
  return config.providers.some(
    (provider) => provider.id === wanted || (provider.label ?? "").trim().toLowerCase() === wanted,
  );
}

/** myna's provider.Mask (`internal/provider/provider.go:2228`). */
export function maskKey(value: string): string {
  if (value.length <= 8) {
    return "•".repeat(value.length);
  }
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

/** myna's provider.Slug: letters and digits, runs of anything else as one dash. */
export function slugName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function freeProviderId(config: GatewayConfig, wanted: string): string {
  const taken = new Set(config.providers.map((provider) => provider.id));
  if (!taken.has(wanted)) {
    return wanted;
  }
  for (let n = 2; ; n += 1) {
    const candidate = `${wanted}-${n}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
}

/** The accounts a provider has, with a bare apiKey read as its one implicit account. */
export function accountsOf(provider: GatewayProvider): GatewayAccount[] {
  return providerAccounts(provider);
}

/** The accounts a provider holds in its file; a bare apiKey alone has none. */
function storedAccounts(provider: GatewayProvider): GatewayAccount[] {
  return provider.accounts ?? [];
}

export function findAccount(provider: GatewayProvider, ref: string): GatewayAccount {
  const wanted = ref.trim().toLowerCase();
  const account = accountsOf(provider).find(
    (candidate) =>
      candidate.id === wanted ||
      (candidate.label ?? "").trim().toLowerCase() === wanted ||
      `${provider.id}/${candidate.id}` === wanted,
  );
  if (account === undefined) {
    const known = accountsOf(provider).map((candidate) => candidate.id);
    throw new Error(
      `${provider.label ?? provider.id} has no account or key "${ref}"${
        known.length > 0 ? ` — ${known.join(", ")}` : ""
      }`,
    );
  }
  return account;
}

/**
 * Replaces one account, materialising the implicit `default` account of a
 * bare apiKey first so its own setting has somewhere to live.
 */
export function withAccount(
  provider: GatewayProvider,
  accountId: string,
  change: (account: GatewayAccount) => GatewayAccount,
): GatewayProvider {
  const accounts = accountsOf(provider).map((account) =>
    account.id === accountId ? change(account) : account,
  );
  return { ...provider, accounts };
}

export interface SavedProvider {
  config: GatewayConfig;
  provider: GatewayProvider;
  before: GatewayProvider;
}

/** Writes one provider back, keeping the file's other providers as they were. */
export async function saveProvider(
  store: GatewayConfigStore,
  providerId: string,
  change: (provider: GatewayProvider) => GatewayProvider,
): Promise<SavedProvider> {
  const config = store.get();
  const before = findGatewayProvider(config, providerId);
  const next = change({
    ...before,
    accounts: [...storedAccounts(before)],
  });
  const saved = await store.write({
    ...config,
    providers: config.providers.map((provider) => (provider.id === before.id ? next : provider)),
  });
  const provider = findGatewayProvider(saved, next.id);
  return { config: saved, provider, before };
}

export async function addProviderToStore(
  store: GatewayConfigStore,
  provider: GatewayProvider,
): Promise<SavedProvider> {
  const config = store.get();
  const saved = await store.write({
    ...config,
    providers: [...config.providers, provider],
  });
  return {
    config: saved,
    provider: findGatewayProvider(saved, provider.id),
    before: provider,
  };
}

export async function removeProviderFromStore(
  store: GatewayConfigStore,
  providerId: string,
): Promise<SavedProvider> {
  const config = store.get();
  const before = findGatewayProvider(config, providerId);
  const saved = await store.write({
    ...config,
    providers: config.providers.filter((provider) => provider.id !== before.id),
  });
  return { config: saved, provider: before, before };
}

/** A provider's one-line address for `neolix providers`. */
export function providerHost(provider: GatewayProvider): string {
  try {
    return new URL(provider.baseUrl).host;
  } catch {
    return provider.baseUrl;
  }
}

/** How many models it exposes under its modelMode. */
export function exposedModels(provider: GatewayProvider): string[] {
  const all = provider.models.map((model) => model.id);
  switch (provider.modelMode ?? "list") {
    case "none":
      return [];
    case "picked":
      return provider.models.filter((model) => model.picked === true).map((model) => model.id);
    case "best": {
      // myna's Best in family: the newest of each family the vendor lists.
      const byFamily = new Map<string, (typeof provider.models)[number]>();
      for (const model of provider.models) {
        const family = model.id.replace(/[-_.]?\d+(?:[.-]\d+)*[a-z]*$/i, "") || model.id;
        const held = byFamily.get(family);
        if (held === undefined || (model.released ?? "") > (held.released ?? "")) {
          byFamily.set(family, model);
        }
      }
      return [...byFamily.values()].map((model) => model.id);
    }
    default:
      return all;
  }
}
