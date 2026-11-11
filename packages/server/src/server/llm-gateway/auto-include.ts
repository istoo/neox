/**
 * A provider's own list kept up to date by itself (myna's autolist.go): a
 * model a fetch lists that the list before it didn't, and that one of its
 * AutoInclude rules matches, joins what it serves.
 *
 * The merge only adds. Nothing served is taken away, and a model the user
 * unticked afterwards isn't new to the next fetch, so it stays unticked.
 */
import { GatewayConfigStore, type GatewayModel, type GatewayProvider } from "./config.js";
import { autoIncludedModels } from "./provider-limits.js";

export interface AutoIncludeMerge {
  /** The provider with the newly listed matches served. */
  provider: GatewayProvider;
  /** The model ids taken, in the vendor's order; empty when nothing was. */
  taken: string[];
}

/**
 * The provider after a model-list fetch, `listed` being what the vendor
 * lists now. New models a rule matches are added, served from then on: a
 * `picked` provider takes them picked, and one that served none or the
 * best of each family serves its list again (myna's takeMatching clears
 * NoModels and BestInFamily).
 */
export function mergeAutoIncludedModels(
  provider: GatewayProvider,
  listed: readonly string[],
): AutoIncludeMerge {
  const before = provider.models.map((model) => model.id);
  const taken = autoIncludedModels(provider.autoInclude, listed, before);
  if (taken.length === 0) {
    return { provider, taken };
  }
  const picked = provider.modelMode === "picked";
  const mode = picked ? "picked" : "list";
  const added: GatewayModel[] = taken.map((id) => (picked ? { id, picked: true } : { id }));
  return {
    provider: {
      ...provider,
      models: [...added, ...provider.models],
      ...(provider.modelMode === mode ? {} : { modelMode: mode }),
    },
    taken,
  };
}

/**
 * Merges a fetched list into the saved provider, stamps when the list was
 * fetched (myna's `Fetched`) and writes the config; answers the models
 * taken. Nothing is written when the provider is no longer in the config.
 */
export async function takeAutoIncludedModels(
  store: GatewayConfigStore,
  providerId: string,
  listed: readonly string[],
  now: number = Date.now(),
): Promise<string[]> {
  const config = store.get();
  const provider = config.providers.find((entry) => entry.id === providerId);
  if (provider === undefined) {
    return [];
  }
  const merged = mergeAutoIncludedModels(provider, listed);
  const saved: GatewayProvider = { ...merged.provider, listFetchedAt: now };
  await store.write({
    ...config,
    providers: config.providers.map((entry) => (entry.id === providerId ? saved : entry)),
  });
  return merged.taken;
}
