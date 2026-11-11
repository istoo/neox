import { randomBytes } from "node:crypto";
import type { GatewayConfig } from "./config.js";
import { configuredOidcRules, type OidcRule } from "./oidc.js";

export { configuredOidcRules } from "./oidc.js";

/**
 * Managing the OIDC rules a CI job trades a token for a gateway key with
 * (myna's oidc/rules.go): which issuer, which audience, the claims a token
 * must match, the gateway key it is issued under, and how long it lives.
 *
 * The rules live in gateway.json (`oidc.rules`), not a file of their own; the
 * daemon's config store writes them atomically and the change applies at once.
 * Validation follows myna's Add: an https issuer without query or fragment,
 * at least one claim, a GitHub rule naming itself a repository or owner without
 * a wildcard, a TTL from a minute to thirty days, and a key that may issue.
 */

export const OIDC_GITHUB_ISSUER = "https://token.actions.githubusercontent.com";
export const OIDC_DEFAULT_TTL_SECONDS = 3_600;
export const OIDC_MIN_TTL_SECONDS = 60;
export const OIDC_MAX_TTL_SECONDS = 30 * 24 * 60 * 60;

/** Claims a GitHub rule may name itself by, without a wildcard (rules.go:80). */
const GITHUB_SCOPES = ["repository", "repository_owner", "repository_id", "repository_owner_id"];

export interface OidcRuleInput {
  /** The rule being changed; absent adds a new one. */
  id?: string;
  /** The gateway key's label or secret, which must be allowed to issue keys. */
  key: string;
  issuer?: string;
  audience?: string;
  claims?: Record<string, string>;
  ttlSeconds?: number;
}

/** Why a rule can't be saved, or null. */
export function checkOidcRule(config: GatewayConfig, input: OidcRuleInput): string | null {
  const issuer = issuerOf(input.issuer);
  if (issuer === null) {
    return `the issuer is an https URL, such as ${OIDC_GITHUB_ISSUER}`;
  }
  const claims = input.claims ?? {};
  if (Object.keys(claims).length === 0) {
    return "a rule names at least one claim the token must have, such as repository=owner/name";
  }
  for (const [name, value] of Object.entries(claims)) {
    if (name.trim() !== name || name.length === 0 || value.length === 0) {
      return `a claim is name=value, both given: "${name}"="${value}"`;
    }
  }
  if (issuer === OIDC_GITHUB_ISSUER && !githubScopeGiven(claims)) {
    return (
      "a GitHub rule names the repository (repository=owner/name) or its owner " +
      "(repository_owner=owner) without a wildcard: otherwise any repository's workflow " +
      "on GitHub could get a key"
    );
  }
  const ttl = input.ttlSeconds ?? OIDC_DEFAULT_TTL_SECONDS;
  if (!Number.isInteger(ttl) || ttl < OIDC_MIN_TTL_SECONDS || ttl > OIDC_MAX_TTL_SECONDS) {
    return `a key lives from a minute to 30 days, not ${ttl}s`;
  }
  return checkIssuerKey(config, input.key);
}

function issuerOf(given: string | undefined): string | null {
  const trimmed = (given ?? "").trim().replace(/\/+$/, "");
  if (trimmed.length === 0) {
    return OIDC_GITHUB_ISSUER;
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname.length === 0) {
    return null;
  }
  if (url.search.length > 0 || url.hash.length > 0) {
    return null;
  }
  return trimmed;
}

function githubScopeGiven(claims: Record<string, string>): boolean {
  return GITHUB_SCOPES.some((scope) => {
    const value = claims[scope];
    return value !== undefined && !/[*?[\\]/.test(value);
  });
}

/** The rule's key may issue keys, as myna's rules.go:165 checks. */
function checkIssuerKey(config: GatewayConfig, ruleKey: string): string | null {
  for (const entry of config.keys) {
    if (typeof entry === "string") {
      if (entry === ruleKey) {
        return "that gateway key can't issue keys: turn on issuing for it first";
      }
      continue;
    }
    if (entry.key !== ruleKey && entry.label !== ruleKey) {
      continue;
    }
    if (entry.issues !== true || entry.issuer !== undefined) {
      return `the gateway key ${entry.label ?? entry.key} can't issue keys: turn on issuing for it first`;
    }
    return null;
  }
  return `no gateway key has the id "${ruleKey}"`;
}

export interface OidcRuleChange {
  rule: OidcRule;
  rules: OidcRule[];
}

/** Adds a rule, or changes one by id; answers it and every rule after. */
export function saveOidcRule(config: GatewayConfig, input: OidcRuleInput): OidcRuleChange {
  const problem = checkOidcRule(config, input);
  if (problem !== null) {
    throw new Error(problem);
  }
  const existing = configuredOidcRules(config);
  const found = input.id === undefined ? null : findRule(existing, input.id);
  if (input.id !== undefined && found === null) {
    throw new Error(`no rule has the id "${input.id}"`);
  }
  const id = found?.id ?? randomId();
  const audience = (input.audience ?? found?.audience ?? "").trim();
  const rule: OidcRule = {
    id,
    key: input.key,
    issuer: issuerOf(input.issuer) ?? OIDC_GITHUB_ISSUER,
    audience: audience.length > 0 ? audience : `neolix-${id}`,
    claims: { ...input.claims },
    ttlSeconds: input.ttlSeconds ?? found?.ttlSeconds ?? OIDC_DEFAULT_TTL_SECONDS,
  };
  const rules =
    found === null ? [...existing, rule] : existing.map((r) => (r.id === id ? rule : r));
  return { rule, rules };
}

/** Takes a rule away; answers every rule after. */
export function removeOidcRule(
  config: GatewayConfig,
  id: string,
): { removed: OidcRule; rules: OidcRule[] } {
  const rules = configuredOidcRules(config);
  const removed = findRule(rules, id);
  if (removed === null) {
    throw new Error(`no rule has the id "${id}"`);
  }
  return { removed, rules: rules.filter((rule) => rule.id !== id) };
}

/** What gateway.json's `oidc.rules` becomes after a change. */
export function oidcRulesForConfig(rules: readonly OidcRule[]): NonNullable<GatewayConfig["oidc"]> {
  return {
    rules: rules.map((rule) => ({
      id: rule.id,
      key: rule.key,
      issuer: rule.issuer,
      audience: rule.audience,
      claims: rule.claims,
      ttlSeconds: rule.ttlSeconds,
    })),
  };
}

/** What a rule looks like on the wire: plain fields, no extra keys. */
export function oidcRuleWire(rule: OidcRule): {
  id: string;
  key: string;
  issuer: string;
  audience: string;
  claims: Record<string, string>;
  ttlSeconds: number;
} {
  return {
    id: rule.id,
    key: rule.key,
    issuer: rule.issuer,
    audience: rule.audience,
    claims: rule.claims,
    ttlSeconds: rule.ttlSeconds,
  };
}

/** The rules a settings form draws. */
export function oidcRulesWire(rules: readonly OidcRule[]): ReturnType<typeof oidcRuleWire>[] {
  return rules.map(oidcRuleWire);
}

function findRule(rules: readonly OidcRule[], id: string): OidcRule | null {
  return rules.find((rule) => rule.id === id) ?? null;
}

function randomId(): string {
  return randomBytes(6).toString("hex");
}
