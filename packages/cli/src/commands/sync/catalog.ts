import { Command } from "commander";
import type { Logger } from "pino";
import { resolveNeolixHome } from "@neolix/server/daemon-control";
import { GatewayConfigStore, type GatewayProvider } from "@neolix/server/gateway-config";
import { connectToDaemon, type ConnectOptions } from "../../utils/client.js";
import { addJsonAndDaemonHostOptions, withGlobalOptions } from "../../utils/command-options.js";

/**
 * myna's `myna sync` (`internal/cli/main.go:497`): fetch every vendor's model
 * list again after the catalog download. A daemon that has
 * `gatewayCatalogRefresh` does both halves in `gateway.catalog.refresh`
 * (the lists through `list-refresh`/`auto-include`, the prices through
 * `PricingCatalog`); an older one gets the lists from
 * `gateway.provider.get_models` and keeps its own price timer.
 */

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => silentLogger,
} as unknown as Logger;

export interface SyncOptions {
  home?: string;
  daemonTarget?: ConnectOptions["target"];
}

export interface ModelList {
  models: string[];
  error?: string;
}

export type FetchProviderModels = (provider: GatewayProvider) => Promise<ModelList>;

export interface CatalogRefresh {
  ok: boolean;
  models?: number;
  error?: string;
  /** The daemon predates the RPC; it refreshes on its own timer. */
  unsupported?: boolean;
}

export type RefreshCatalog = () => Promise<CatalogRefresh>;

export interface SyncedProvider {
  id: string;
  /** The model ids the vendor lists now. */
  ids: string[];
  /** The newly listed ones its AutoInclude rules took, on the daemon's side. */
  taken?: string[];
  error?: string;
}

export interface ServerSync {
  providers: SyncedProvider[];
  catalog: CatalogRefresh;
  /** The daemon predates `gateway.catalog.refresh`. */
  unsupported?: boolean;
}

export type SyncAll = () => Promise<ServerSync>;

export interface SyncDeps {
  fetchModels?: FetchProviderModels;
  refreshCatalog?: RefreshCatalog;
  syncAll?: SyncAll;
}

export interface SyncResult {
  refreshed: Array<{ id: string; count: number }>;
  failed: Array<{ id: string; error: string }>;
  catalog: CatalogRefresh;
}

async function syncAllFromDaemon(options: SyncOptions): Promise<ServerSync> {
  if (options.daemonTarget === undefined) {
    return {
      providers: [],
      catalog: { ok: false, error: "this command needs a running daemon" },
      unsupported: true,
    };
  }
  const client = await connectToDaemon({ target: options.daemonTarget });
  try {
    if (client.getLastServerInfoMessage()?.features?.gatewayCatalogRefresh !== true) {
      return { providers: [], catalog: { ok: false, unsupported: true }, unsupported: true };
    }
    const payload = await client.refreshGatewayCatalog();
    return {
      providers: (payload.providers ?? []).map((entry) => {
        const synced: SyncedProvider = {
          id: entry.id,
          ids: entry.ids,
          taken: [...entry.taken],
        };
        if (entry.error !== undefined) {
          synced.error = entry.error;
        }
        return synced;
      }),
      catalog: {
        ok: payload.ok,
        ...(payload.models === undefined ? {} : { models: payload.models }),
        ...(payload.error === undefined ? {} : { error: payload.error }),
      },
    };
  } catch (error) {
    return {
      providers: [],
      catalog: { ok: false, error: error instanceof Error ? error.message : String(error) },
      unsupported: true,
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

function ready(provider: GatewayProvider): boolean {
  if (provider.enabled === false) {
    return false;
  }
  if (provider.vertex !== undefined) {
    return true;
  }
  if (provider.apiKey !== undefined && provider.apiKey.length > 0) {
    return true;
  }
  return provider.accounts.some(
    (account) =>
      account.enabled &&
      ((account.apiKey ?? "").length > 0 ||
        account.agent !== undefined ||
        account.codexAccountId !== undefined),
  );
}

/** Keeps each held model's facts, drops the ones gone, adds the new ones unpicked. */
function mergeModels(provider: GatewayProvider, ids: string[]): GatewayProvider["models"] {
  const held = new Map(provider.models.map((model) => [model.id, model]));
  return ids.map((id) => held.get(id) ?? { id, picked: false });
}

async function fetchModelsFromDaemon(
  provider: GatewayProvider,
  options: SyncOptions,
): Promise<ModelList> {
  if (options.daemonTarget === undefined) {
    throw new Error("this command needs a running daemon: pass --host or start one");
  }
  const client = await connectToDaemon({ target: options.daemonTarget });
  try {
    const payload = await client.getGatewayProviderModels({
      protocol: provider.protocol,
      baseUrl: provider.baseUrl,
      providerId: provider.id,
      ...(provider.apiKey === undefined ? {} : { apiKey: provider.apiKey }),
      ...(provider.headers === undefined ? {} : { headers: provider.headers }),
      ...(provider.insecureTls === undefined ? {} : { insecureTls: provider.insecureTls }),
      ...(provider.modelsUrl === undefined ? {} : { modelsUrl: provider.modelsUrl }),
    });
    return {
      models: payload.models,
      ...(payload.error === null ? {} : { error: payload.error }),
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

// One function reads the server's answer, falls back to per-provider calls
// for an older daemon, and writes the list; the branches are its two paths.
// eslint-disable-next-line complexity
export async function runCatalogSyncCommand(
  options: SyncOptions,
  deps: SyncDeps = {},
): Promise<SyncResult> {
  const neolixHome = resolveNeolixHome({
    NEOLIX_HOME: options.home ?? process.env.NEOLIX_HOME,
  } as NodeJS.ProcessEnv);
  const store = new GatewayConfigStore({ neolixHome, logger: silentLogger });
  await store.start();
  try {
    const providers = store.get().providers.filter(ready);
    let synced: SyncedProvider[] | undefined;
    let catalog: CatalogRefresh | undefined;
    let serverSynced = false;

    // The daemon does both halves when it can; an older one gets only the
    // lists here, and keeps its own price timer.
    if (
      deps.syncAll !== undefined ||
      (deps.fetchModels === undefined && deps.refreshCatalog === undefined)
    ) {
      const server = await (deps.syncAll ?? (() => syncAllFromDaemon(options)))();
      catalog = server.catalog;
      if (server.unsupported !== true) {
        synced = server.providers;
        serverSynced = true;
      }
    }
    if (synced === undefined) {
      synced = [];
      for (const provider of providers) {
        try {
          const list =
            deps.fetchModels === undefined
              ? await fetchModelsFromDaemon(provider, options)
              : await deps.fetchModels(provider);
          synced.push({
            id: provider.id,
            ids: list.models,
            ...(list.error === undefined ? {} : { error: list.error }),
          });
        } catch (error) {
          synced.push({
            id: provider.id,
            ids: [],
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (catalog === undefined) {
        catalog =
          deps.refreshCatalog === undefined
            ? { ok: false, unsupported: true }
            : await deps.refreshCatalog();
      }
    }

    const refreshed: SyncResult["refreshed"] = [];
    const failed: SyncResult["failed"] = [];
    // The daemon owns gateway.json's writes on the server path (its
    // auto-include merge already ran there); writing from this stale store
    // would undo it. The per-provider fallback is this CLI's own write.
    const fromServer = serverSynced;
    for (const entry of synced) {
      if (entry.error !== undefined) {
        failed.push({ id: entry.id, error: entry.error });
        continue;
      }
      const config = store.get();
      const provider = config.providers.find((held) => held.id === entry.id);
      if (provider === undefined) {
        continue;
      }
      if (!fromServer) {
        const models = mergeModels(provider, entry.ids);
        await store.write({
          ...config,
          providers: config.providers.map((held) =>
            held.id === provider.id ? Object.assign({}, held, { models }) : held,
          ),
        });
      }
      refreshed.push({ id: provider.id, count: entry.ids.length });
    }
    return { refreshed, failed, catalog: catalog ?? { ok: false, unsupported: true } };
  } finally {
    store.dispose();
  }
}

/** `neolix sync`: fetch every ready vendor's model list again. */
export function createCatalogSyncCommand(): Command {
  const command = addJsonAndDaemonHostOptions(
    new Command("sync").description(
      "Refresh the gateway's vendor model lists and models.dev price catalog (myna sync)",
    ),
  );
  command.action(
    withGlobalOptions(async (options: SyncOptions & { json?: boolean }, source: Command) => {
      const merged = source.optsWithGlobals() as SyncOptions & { json?: boolean };
      try {
        const result = await runCatalogSyncCommand(merged ?? options);
        if (merged.json === true) {
          process.stdout.write(`${JSON.stringify(result)}\n`);
          return;
        }
        if (result.refreshed.length > 0) {
          const lists = result.refreshed.map((entry) => `${entry.id} (${entry.count})`).join(", ");
          process.stdout.write(`✓ model lists: ${lists}\n`);
        } else if (result.failed.length === 0) {
          process.stdout.write("No provider has a key to fetch a list with\n");
        }
        for (const failure of result.failed) {
          process.stdout.write(`! ${failure.id}: ${failure.error}\n`);
        }
        if (result.catalog.unsupported === true) {
          process.stdout.write(
            "  the price catalog (models.dev) is refreshed by that older daemon itself\n",
          );
        } else if (result.catalog.ok) {
          process.stdout.write(`✓ price catalog: ${result.catalog.models ?? 0} list prices\n`);
        } else {
          process.stdout.write(`! price catalog: ${result.catalog.error ?? "unavailable"}\n`);
        }
      } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
      }
    }),
  );
  return command;
}
