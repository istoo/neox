import {
  isProviderEnabled,
  type GatewayAccount,
  type GatewayConfig,
  type GatewayProvider,
} from "./config.js";
import { disabledPattern } from "./model-prefs.js";
import { readySearchApis } from "./search-apis.js";

/**
 * myna's settings for who searches the web for a model that can't, in the
 * order they are asked: the searcher provider (settings.Searcher), the ones
 * after it (SearcherThen), whether the search APIs go first (SearchFirst),
 * and whether every model is searched for, one whose provider searches by
 * itself too (SearchAll).
 *
 * The plan is pure; asking a searcher is the caller's, on the request path.
 */

export interface SearchPlan {
  /** The provider that searches: "provider", "provider/model", "off", or "" for the gateway's pick. */
  searcher: string;
  /** Asked in its turn when the searcher fails, in this order. */
  after: string[];
  /** The search APIs are asked before the searcher, the searcher after them. */
  apisFirst: boolean;
  /** Search for every model, even one whose provider searches by itself. */
  all: boolean;
}

/** One thing a search is asked of, in the order asked. */
export type SearchStep = { kind: "apis" } | { kind: "provider"; ref: string; model: string };

export function searchPlanOf(config: GatewayConfig): SearchPlan {
  const search = config.search;
  const searcher = (search?.searcher ?? "").trim();
  // myna's settings normalization: no empty refs, no "off", no repeat of
  // the searcher itself nor of each other (settings.go SearcherThen).
  const after: string[] = [];
  for (const raw of search?.searcherThen ?? []) {
    const ref = raw.trim();
    if (ref.length > 0 && ref !== "off" && ref !== searcher && !after.includes(ref)) {
      after.push(ref);
    }
  }
  return {
    searcher,
    after,
    apisFirst: search?.searchFirst === "api",
    all: search?.searchAll === true,
  };
}

/**
 * The hosts whose API answers a search tool on its own, by protocol (myna's
 * searchHosts, `internal/gateway/search.go:276`). A protocol alone says
 * nothing: a relay speaks Anthropic's wire without Anthropic's search.
 */
const SEARCH_HOSTS: Record<GatewayProvider["protocol"], readonly string[]> = {
  "openai-responses": [
    "api.openai.com",
    "api.x.ai",
    "api.deepseek.com",
    "open.bigmodel.cn",
    "api.z.ai",
    "ark.cn-beijing.volces.com",
  ],
  anthropic: ["api.anthropic.com", "api.deepseek.com"],
  openai: ["openrouter.ai"],
  gemini: ["generativelanguage.googleapis.com"],
};

/** A base URL's host as myna reads it: no scheme, path, query or case (HostOf). */
function hostOf(baseUrl: string): string {
  let value = baseUrl.trim();
  const scheme = value.indexOf("://");
  if (scheme >= 0) {
    value = value.slice(scheme + 3);
  }
  const rest = value.search(/[/?#]/);
  if (rest >= 0) {
    value = value.slice(0, rest);
  }
  return value.toLowerCase();
}

/** The signed-in agents whose Responses API runs web_search for every model. */
const SEARCHING_ACCOUNT_AGENTS = new Set(["chatgpt-api", "copilot"]);

export interface ProviderSearchContext {
  /**
   * The signed-in account the request will spend, when one will (myna's
   * `Provider.Account`); absent or null for a request served by an API key.
   * An account makes the answer its own: the host whitelist is not read.
   */
  account?: GatewayAccount | null;
  /**
   * The plugin that contributed this provider, when one did (myna's
   * `PluginProvider`). `"grok"` is the plugin whose Responses API searches.
   */
  plugin?: string | null;
}

/**
 * Whether a provider searches the web by itself — myna's `searchesItself`
 * (`internal/gateway/search.go:109-131`), branch for branch.
 *
 * A request with a signed-in account reads only the account rule: codex
 * (`chatgpt-api` here) and Copilot accounts search on a Responses API, as
 * does a Grok provider, and a plugin's provider when it said so. A Claude
 * subscription searches nothing here even at Anthropic's host. A request
 * with an API key reads its explicit `searches` (Anthropic or Responses
 * only) and then the host whitelist.
 */
export function providerCanSearch(
  provider: GatewayProvider,
  context: ProviderSearchContext = {},
): boolean {
  if (!isProviderEnabled(provider)) {
    return false;
  }
  // Neolix keeps an explicit false where myna has only an on switch; a user
  // who turned it off gets off even on a host that usually searches.
  if (provider.searches === false) {
    return false;
  }
  const proto = provider.protocol;
  const saidTo =
    provider.searches === true &&
    (proto === "anthropic" || proto === "openai-responses") &&
    provider.baseUrl.trim() !== "";
  const account = context.account ?? null;
  if (account !== null) {
    const accountSearches =
      (account.agent !== undefined && SEARCHING_ACCOUNT_AGENTS.has(account.agent)) ||
      account.codexAccountId !== undefined ||
      provider.id === "grok" ||
      context.plugin === "grok";
    return (accountSearches && proto === "openai-responses") || (context.plugin != null && saidTo);
  }
  if (saidTo) {
    return true;
  }
  return SEARCH_HOSTS[proto].includes(hostOf(provider.baseUrl));
}

/**
 * The signed-in account a provider-level answer speaks for: the first one a
 * request could spend. Null for an API-key provider, whose answer then reads
 * the switch and the host. Pages and the automatic searcher ask this before
 * a request has picked its account; the request path passes the real one.
 */
export function providerSearchAccount(provider: GatewayProvider): GatewayAccount | null {
  return (
    (provider.accounts ?? []).find(
      (account) =>
        account.enabled !== false &&
        (account.agent !== undefined || account.codexAccountId !== undefined),
    ) ?? null
  );
}

/** `providerCanSearch` for a list or a page, with the account it would spend. */
export function providerSearchesByItself(provider: GatewayProvider): boolean {
  return providerCanSearch(provider, { account: providerSearchAccount(provider) });
}

/** The models of a provider that are not turned off (myna's DisabledModels). */
function askableModels(config: GatewayConfig, provider: GatewayProvider) {
  return provider.models.filter((model) => disabledPattern(config, provider.id, model.id) === null);
}

/**
 * The model a searcher ref asks: the one it names, else the provider's
 * first model that is not disabled. A model turned off is not asked.
 */
export function searcherModel(config: GatewayConfig, ref: string): string | null {
  const slash = ref.indexOf("/");
  if (slash > 0) {
    const provider = config.providers.find(
      (entry) => entry.id === ref.slice(0, slash) && isProviderEnabled(entry),
    );
    const model = ref.slice(slash + 1);
    if (
      provider === undefined ||
      !askableModels(config, provider).some((entry) => entry.id === model)
    ) {
      return null;
    }
    return ref;
  }
  const provider = config.providers.find((entry) => entry.id === ref && isProviderEnabled(entry));
  const model = provider === undefined ? undefined : askableModels(config, provider)[0];
  return provider === undefined || model === undefined ? null : `${provider.id}/${model.id}`;
}

/**
 * The searcher refs to ask, in order: the named one, then the names after
 * it; with no name, the first provider whose own wire can search. A ref
 * whose provider is gone, switched off or can't search is left out, so
 * what can search is asked in its place, as myna does.
 */
export function searcherRefs(
  config: GatewayConfig,
  plan: SearchPlan = searchPlanOf(config),
): string[] {
  if (plan.searcher === "off") {
    return [];
  }
  const refs: string[] = [];
  const askable = (ref: string): boolean => {
    const providerId = ref.split("/")[0] ?? "";
    const provider = config.providers.find((entry) => entry.id === providerId);
    return (
      provider !== undefined &&
      providerSearchesByItself(provider) &&
      searcherModel(config, ref) !== null
    );
  };
  if (plan.searcher !== "") {
    if (askable(plan.searcher)) {
      refs.push(plan.searcher);
    }
    for (const ref of plan.after) {
      if (ref !== plan.searcher && !refs.includes(ref) && askable(ref)) {
        refs.push(ref);
      }
    }
    return refs;
  }
  const auto = config.providers.find((provider) => providerSearchesByItself(provider));
  if (auto !== undefined) {
    refs.push(auto.id);
  }
  return refs;
}

/** Whether a request's search can be answered here at all: a searcher or a ready search API. */
export function canSearchForClient(
  config: GatewayConfig,
  plan: SearchPlan = searchPlanOf(config),
): boolean {
  return searcherRefs(config, plan).length > 0 || readySearchApis(config.search?.apis).length > 0;
}

/**
 * What a request of `protocol` asks for a search, in the order asked: the
 * APIs or the searcher first as SearchFirst says, then the rest, then the
 * APIs when the searcher was first.
 */
export function searchSteps(
  config: GatewayConfig,
  plan: SearchPlan = searchPlanOf(config),
): SearchStep[] {
  const refs = searcherRefs(config, plan);
  const providers: SearchStep[] = [];
  for (const ref of refs) {
    const model = searcherModel(config, ref);
    if (model !== null) {
      providers.push({ kind: "provider", ref, model });
    }
  }
  const hasApis = readySearchApis(config.search?.apis).length > 0;
  if (providers.length === 0) {
    return hasApis ? [{ kind: "apis" }] : [];
  }
  if (!hasApis) {
    return providers;
  }
  return plan.apisFirst ? [{ kind: "apis" }, ...providers] : [...providers, { kind: "apis" }];
}

/**
 * Whether a model whose provider searches by itself is searched for anyway
 * (myna's SearchAll): only while there is something to search with, so the
 * switch does nothing when it would leave the model unable to search.
 */
export function searchesForAll(
  config: GatewayConfig,
  plan: SearchPlan = searchPlanOf(config),
): boolean {
  return plan.all && canSearchForClient(config, plan);
}
