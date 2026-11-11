import { limitsOf, refusalForLimits, type BudgetLimit } from "./budget.js";
import type { GatewayCandidate } from "./catalog.js";
import { gatewayKeyEntries, type GatewayConfig, type GatewayKey } from "./config.js";
import { isSameOSUser } from "./peer-user.js";
import type { UsageLedger } from "./usage.js";

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * What resolving a caller needs of a request: the key headers, the query's
 * `key`, and the connection. Express's Request and a raw upgrade request both
 * fit.
 */
export interface GatewayRequest {
  get(name: string): string | undefined;
  query?: unknown;
  socket: { remoteAddress?: string | undefined };
}

export interface GatewayPrincipal {
  /** The presented key, or null for an unauthenticated loopback caller. */
  key: string | null;
  label: string | null;
  /** The models it may use, accounts already folded in (myna's HeldModels). */
  models: string[];
  /** The accounts and keys it may use, `provider/account` (myna's Key.Accounts). */
  accounts?: string[];
  /** Whether a held key may be told the quotas of what it may use. */
  quotas?: boolean;
  dailyTokens: number | null;
  monthlyUsd: number | null;
  /** The key's budget windows, every one of which holds it (myna access.Limit). */
  limits: BudgetLimit[];
  ratePerMinute: number | null;
  searchCallsPerMonth: number | null;
  readOnly: boolean;
  issues: boolean;
  issuer: string | null;
}

export interface AccessDenial {
  status: number;
  type: string;
  message: string;
  /** For a quota refusal: seconds until the window resets, sent as Retry-After. */
  retryAfterSeconds?: number;
}

/**
 * The models a key that lists models and accounts may use (myna's
 * HeldModels): its own list; or, naming accounts and no model, its
 * accounts' providers' every model, so ticking an account alone narrows the
 * key rather than leaving it every other provider.
 */
export function heldModels(
  models: readonly string[] | undefined,
  accounts: readonly string[] | undefined,
): string[] {
  const listed = models ?? [];
  const held = accounts ?? [];
  if (listed.length > 0 || held.length === 0) {
    return [...listed];
  }
  const out: string[] = [];
  for (const account of held) {
    const slash = account.indexOf("/");
    if (slash <= 0) {
      continue;
    }
    const pattern = `${account.slice(0, slash)}/*`;
    if (!out.some((entry) => entry.toLowerCase() === pattern.toLowerCase())) {
      out.push(pattern);
    }
  }
  // no entry named a provider: held to nothing rather than let off to every model
  return out.length === 0 ? ["/"] : out;
}

/**
 * Whether a key listing accounts may use pid's account or key ref (myna's
 * AllowsAccount): a provider it names none of keeps all of its accounts.
 */
export function allowsAccount(
  accounts: readonly string[] | undefined,
  providerId: string,
  ref: string,
): boolean {
  const held = accounts ?? [];
  if (held.length === 0) {
    return true;
  }
  const pid = providerId.trim().toLowerCase();
  const wanted = `${pid}/${ref.trim().toLowerCase()}`;
  let named = false;
  for (const account of held) {
    const value = account.trim().toLowerCase();
    if (value === wanted) {
      return true;
    }
    const slash = value.indexOf("/");
    if (slash > 0 && value.slice(0, slash) === pid) {
      named = true;
    }
  }
  return !named;
}

/** Whether a key is held to a budget, models or accounts (myna's heldKey). */
export function keyIsHeld(
  principal: Pick<
    GatewayPrincipal,
    "models" | "accounts" | "limits" | "dailyTokens" | "monthlyUsd"
  >,
): boolean {
  return (
    principal.models.length > 0 ||
    (principal.accounts ?? []).length > 0 ||
    principal.limits.length > 0 ||
    principal.dailyTokens !== null ||
    principal.monthlyUsd !== null
  );
}

/** A key's accounts as the filter an attempt uses, `provider` → its accounts. */
export function keyAccountFilter(
  principal: Pick<GatewayPrincipal, "accounts">,
): Map<string, Set<string>> | null {
  return accountsFilter(principal.accounts ?? []);
}

/** myna's HeldToGroup: only the accounts a group and a key both name. */
export function combineAccountFilters(
  group: Map<string, Set<string>> | null,
  key: Map<string, Set<string>> | null,
): Map<string, Set<string>> | null {
  if (group === null) {
    return key;
  }
  if (key === null) {
    return group;
  }
  const out = new Map<string, Set<string>>();
  for (const [provider, accounts] of group) {
    const held = key.get(provider);
    out.set(
      provider,
      held === undefined ? accounts : new Set([...accounts].filter((account) => held.has(account))),
    );
  }
  for (const [provider, accounts] of key) {
    if (!group.has(provider)) {
      out.set(provider, accounts);
    }
  }
  return out;
}

function accountsFilter(accounts: readonly string[]): Map<string, Set<string>> | null {
  if (accounts.length === 0) {
    return null;
  }
  const filter = new Map<string, Set<string>>();
  for (const entry of accounts) {
    const separator = entry.indexOf("/");
    if (separator <= 0) {
      continue;
    }
    const provider = entry.slice(0, separator);
    const allowed = filter.get(provider) ?? new Set<string>();
    allowed.add(entry.slice(separator + 1));
    filter.set(provider, allowed);
  }
  return filter.size === 0 ? null : filter;
}

/**
 * Whether a held key may be told a provider's quota card (myna's
 * quotaScope.card): only with `quotas` on, only for a provider whose every
 * model it may use, and only for an account it may use.
 */
export function quotaScopeAllows(
  principal: Pick<
    GatewayPrincipal,
    "models" | "accounts" | "quotas" | "limits" | "dailyTokens" | "monthlyUsd"
  >,
  input: { providerId: string; accountRef: string; usesEveryModelOfProvider: boolean },
): boolean {
  if (!keyIsHeld(principal)) {
    return true;
  }
  if (principal.quotas !== true || !input.usesEveryModelOfProvider) {
    return false;
  }
  return allowsAccount(principal.accounts ?? [], input.providerId, input.accountRef);
}

/** A known key turned away, and the reason its 401 carries. */
export interface PrincipalResolution {
  principal: GatewayPrincipal | null;
  /** Why a key the gateway knows was refused; null for an unknown one. */
  refusal: string | null;
}

/**
 * Resolves the caller to the rule set it must satisfy. Null means the request
 * is not allowed at all: either a key was required and missing/wrong, or the
 * gateway has no keys and the caller is not on loopback.
 */
export function resolvePrincipal(
  req: GatewayRequest,
  config: GatewayConfig,
): GatewayPrincipal | null {
  return resolvePrincipalWithReason(req, config).principal;
}

/**
 * As resolvePrincipal, but a key it knows and refuses carries why: a key
 * issued under another is folded through that issuer on every authentication
 * (myna access identityOf, issue.go:262-290), so a change to the issuer
 * reaches its keys at once. Null principal with a null refusal means the key
 * is unknown, not merely refused.
 */
export function resolvePrincipalWithReason(
  req: GatewayRequest,
  config: GatewayConfig,
): PrincipalResolution {
  if (config.keys.length === 0) {
    // Loopback is answered without a key only for this computer's own user:
    // another user's process can reach 127.0.0.1 too.
    if (!LOOPBACK_ADDRESSES.has(req.socket.remoteAddress ?? "") || !isSameOSUser(req.socket)) {
      return { principal: null, refusal: null };
    }
    return {
      principal: {
        key: null,
        label: "loopback",
        models: [],
        accounts: [],
        quotas: false,
        dailyTokens: null,
        monthlyUsd: null,
        limits: [],
        ratePerMinute: null,
        searchCallsPerMonth: null,
        readOnly: false,
        issues: false,
        issuer: null,
      },
      refusal: null,
    };
  }
  const presented = readPresentedKey(req);
  if (presented === null) {
    return { principal: null, refusal: null };
  }
  for (const entry of config.keys) {
    if (typeof entry === "string") {
      if (entry === presented) {
        return {
          principal: {
            key: entry,
            label: null,
            models: [],
            accounts: [],
            quotas: false,
            dailyTokens: null,
            monthlyUsd: null,
            limits: [],
            ratePerMinute: null,
            searchCallsPerMonth: null,
            readOnly: false,
            issues: false,
            issuer: null,
          },
          refusal: null,
        };
      }
      continue;
    }
    if (entry.key !== presented) {
      continue;
    }
    if (entry.expiresAt !== undefined && Date.parse(entry.expiresAt) <= Date.now()) {
      return { principal: null, refusal: null };
    }
    const resolved = principalOfEntry(entry, config, Date.now());
    return "refusal" in resolved
      ? { principal: null, refusal: resolved.refusal }
      : { principal: resolved.principal, refusal: null };
  }
  return { principal: null, refusal: null };
}

function principalOfEntry(
  entry: Exclude<GatewayKey, string>,
  config: GatewayConfig,
  now: number,
): { principal: GatewayPrincipal } | { refusal: string } {
  let models = heldModels(entry.models, entry.accounts ?? []);
  let accounts = entry.accounts ?? [];
  let quotas = entry.quotas === true;
  let readOnly = entry.readOnly;
  if (entry.issuer !== undefined) {
    const parent = gatewayKeyEntries(config).find((candidate) => candidate.key === entry.issuer);
    if (
      parent === undefined ||
      (parent.expiresAt !== undefined && Date.parse(parent.expiresAt) <= now)
    ) {
      return {
        refusal: `the gateway key ${JSON.stringify(keyNameOf(entry))} was issued under a key that is no longer enabled, so it no longer works`,
      };
    }
    const parentModels = heldModels(parent.models, parent.accounts ?? []);
    if (parentModels.length > 0) {
      models = foldModels(models, parentModels);
      if (models.length === 0) {
        return {
          refusal: `the gateway key ${JSON.stringify(keyNameOf(entry))} may use none of its models now: the key it was issued under no longer lets it`,
        };
      }
    }
    accounts = foldAccounts(accounts, parent.accounts ?? []);
    // A child can only be narrower than its issuer (myna issue.go:138, 288-289).
    readOnly = readOnly || parent.readOnly;
    quotas = quotas && parent.quotas === true;
  }
  return {
    principal: {
      key: entry.key,
      label: entry.label ?? null,
      models,
      accounts,
      quotas,
      dailyTokens: entry.dailyTokens ?? null,
      monthlyUsd: entry.monthlyUsd ?? null,
      limits: limitsOf(entry),
      ratePerMinute: entry.ratePerMinute ?? null,
      searchCallsPerMonth: entry.searchCallsPerMonth ?? null,
      readOnly,
      issues: entry.issues,
      issuer: entry.issuer ?? null,
    },
  };
}

/** A key's name for a refusal: its label, else enough to tell it apart. */
function keyNameOf(entry: { label?: string; key: string }): string {
  if (entry.label !== undefined) {
    return entry.label;
  }
  return entry.key.length > 8 ? `${entry.key.slice(0, 4)}…${entry.key.slice(-4)}` : "…";
}

/**
 * What both a child's and its issuer's model lists allow (myna's foldModels,
 * issue.go:298-319): a child's pattern the issuer covers, and an issuer's
 * pattern the child covers. Empty when they share none.
 */
function foldModels(child: readonly string[], issuer: readonly string[]): string[] {
  if (child.length === 0) {
    return [...issuer];
  }
  const out: string[] = [];
  const add = (model: string): void => {
    if (!out.some((entry) => entry.toLowerCase() === model.toLowerCase())) {
      out.push(model);
    }
  };
  for (const model of child) {
    if (modelCovers(issuer, model)) {
      add(model);
    }
  }
  for (const model of issuer) {
    if (modelCovers(child, model)) {
      add(model);
    }
  }
  return out;
}

/** myna's ModelAllowed: exact, or a `*` pattern matched whole, in any case. */
export function modelCovers(patterns: readonly string[], model: string): boolean {
  if (patterns.length === 0) {
    return true;
  }
  for (const pattern of patterns) {
    if (pattern.toLowerCase() === model.toLowerCase()) {
      return true;
    }
    if (pattern.includes("*")) {
      const source = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
      if (new RegExp(`^${source}$`, "i").test(model)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * A child key's accounts, held to its issuer's too (myna's foldAccounts,
 * issue.go:324-355): for a provider the issuer names accounts of, the child's
 * own of them the issuer has; the issuer's of that provider when none; the
 * child's of providers the issuer names none of.
 */
function foldAccounts(child: readonly string[], issuer: readonly string[]): string[] {
  if (issuer.length === 0) {
    return [...child];
  }
  const byProvider = (entries: readonly string[]): Map<string, string[]> => {
    const out = new Map<string, string[]>();
    for (const entry of entries) {
      const slash = entry.trim().toLowerCase().indexOf("/");
      if (slash < 0) {
        continue;
      }
      const provider = entry.trim().toLowerCase().slice(0, slash);
      out.set(provider, [...(out.get(provider) ?? []), entry]);
    }
    return out;
  };
  const mine = byProvider(child);
  const theirs = byProvider(issuer);
  const out: string[] = [];
  for (const account of child) {
    const provider = account.trim().toLowerCase().split("/")[0] ?? "";
    const named = theirs.get(provider);
    if (
      named === undefined ||
      named.some((entry) => entry.toLowerCase() === account.toLowerCase())
    ) {
      out.push(account);
    }
  }
  for (const account of issuer) {
    const provider = account.trim().toLowerCase().split("/")[0] ?? "";
    const shared = (mine.get(provider) ?? []).some((entry) =>
      (theirs.get(provider) ?? []).some((parent) => parent.toLowerCase() === entry.toLowerCase()),
    );
    if (!shared) {
      out.push(account);
    }
  }
  return out;
}

export function readPresentedKey(req: GatewayRequest): string | null {
  const apiKey = req.get("x-api-key");
  if (apiKey !== undefined && apiKey.length > 0) {
    return apiKey;
  }
  // Gemini clients send the key in their own header, and some SDKs use ?key=.
  const googleKey = req.get("x-goog-api-key");
  if (googleKey !== undefined && googleKey.length > 0) {
    return googleKey;
  }
  const query = req.query;
  const queryKey =
    typeof query === "object" && query !== null && "key" in query
      ? (query as { key?: unknown }).key
      : undefined;
  if (typeof queryKey === "string" && queryKey.length > 0) {
    return queryKey;
  }
  const authorization = req.get("authorization");
  if (authorization === undefined) {
    return null;
  }
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return match?.[1] ?? null;
}

/**
 * Per-key request pacing. Windows are one minute; a rejected request does not
 * consume the bucket.
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  public check(id: string, limit: number, now: number): boolean {
    const cutoff = now - 60_000;
    const list = (this.hits.get(id) ?? []).filter((at) => at > cutoff);
    if (list.length >= limit) {
      this.hits.set(id, list);
      return false;
    }
    list.push(now);
    this.hits.set(id, list);
    return true;
  }
}

export interface AccessCheckInput {
  config: GatewayConfig;
  ledger: UsageLedger;
  principal: GatewayPrincipal;
  requestedModel: string;
  routingModel: string;
  candidates: GatewayCandidate[];
  rateLimiter: RateLimiter;
  now: number;
  /**
   * A route that names no model (a by-id video poll) is still held to the
   * key's pace and budgets, but the model list cannot be applied.
   */
  skipModelCheck?: boolean;
}

export function checkAccess(input: AccessCheckInput): AccessDenial | null {
  const { principal } = input;
  if (!input.skipModelCheck && principal.models.length > 0 && !modelAllowed(input)) {
    return {
      status: 403,
      type: "model_not_allowed",
      message: `This key cannot use ${input.requestedModel}`,
    };
  }
  if (
    principal.ratePerMinute !== null &&
    !input.rateLimiter.check(principal.key ?? "loopback", principal.ratePerMinute, input.now)
  ) {
    return { status: 429, type: "rate_limited", message: "Too many requests for this key" };
  }
  // A key's limits, every window of them (myna budget.Refusal): the older
  // dailyTokens and monthlyUsd fields are read as the equivalent windows by
  // budget.limitsOf, so both shapes hold the key the same way.
  if (principal.key !== null) {
    // A principal assembled without the `limits` list still holds its older
    // day/month caps, so both shapes behave the same.
    const ownLimits =
      principal.limits.length > 0
        ? principal.limits
        : limitsOf({
            dailyTokens: principal.dailyTokens ?? undefined,
            monthlyUsd: principal.monthlyUsd ?? undefined,
          });
    const refusal = refusalForLimits(
      input.config,
      principal.key,
      ownLimits,
      new Date(input.now),
      input.ledger.filePath,
    );
    if (refusal !== null) {
      return {
        status: 429,
        type: "quota_exceeded",
        message: refusal.message,
        retryAfterSeconds: refusal.retryAfterSeconds,
      };
    }
  }
  const monthlyLimit = input.config.budget?.monthlyUsd;
  if (monthlyLimit !== undefined && input.ledger.spentThisMonth(input.now) >= monthlyLimit) {
    return {
      status: 402,
      type: "budget_exceeded",
      message: "The gateway monthly budget is used up",
    };
  }
  return null;
}

function modelAllowed(input: AccessCheckInput): boolean {
  const allowed = input.principal.models;
  if (allowed.includes(input.requestedModel) || allowed.includes(input.routingModel)) {
    return true;
  }
  return input.candidates.some((candidate) => {
    const key = `${candidate.provider.id}/${candidate.model.id}`;
    return (
      allowed.includes(key) ||
      allowed.includes(candidate.model.id) ||
      allowed.includes(`${candidate.provider.id}/*`)
    );
  });
}

const READ_ONLY_GET_PATHS = new Set([
  "/v1/models",
  "/v1beta/models",
  "/v1/myna/quotas",
  "/v1/myna/usage",
]);
const READ_ONLY_POST_PATHS = new Set(["/v1/messages/count_tokens"]);

/** A read-only key reads the catalog and usage; it never runs inference. */
export function allowsReadOnly(method: string, path: string): boolean {
  if (method === "GET") {
    return (
      READ_ONLY_GET_PATHS.has(path) ||
      path === "/v1" ||
      path === "/v1/" ||
      path === "/me" ||
      /^\/v1beta\/models\/[^/]+$/.test(path) ||
      /^\/v1\/models\/[^/]+\/[^/]+$/.test(path) ||
      /^\/v1\/videos\/[^/]+(\/content)?$/.test(path) ||
      path.startsWith("/v1/myna/")
    );
  }
  return method === "POST" && READ_ONLY_POST_PATHS.has(path);
}
