import { createPublicKey, verify as verifySignature, type KeyObject } from "node:crypto";
import type { GatewayConfig } from "./config.js";

export interface OidcRule {
  id: string;
  key: string;
  issuer: string;
  audience: string;
  claims: Record<string, string>;
  ttlSeconds: number;
}

export interface OidcClaims {
  [claim: string]: unknown;
}

export interface OidcMatch {
  rule: OidcRule;
  claims: OidcClaims;
}

const JWKS_TTL_MS = 10 * 60_000;
const LEEWAY_MS = 60_000;
const MAX_TRADED_TOKENS = 10_000;

interface CachedKeys {
  fetchedAt: number;
  keys: Map<string, KeyObject>;
}

const keyCache = new Map<string, CachedKeys>();
/** `issuer|jti` → the token's expiry; a token may be traded once. */
const tradedTokens = new Map<string, number>();

/**
 * Verifies an OIDC token against the configured rules. Only RS256 is taken,
 * matching the issuers CI systems use. A token is judged only against rules
 * that name its issuer, so it cannot point the daemon at a URL of its own.
 */
export async function matchOidcToken(
  token: string,
  rules: readonly OidcRule[],
  now: number,
  fetchKeys: (issuer: string, kid: string | null) => Promise<KeyObject> = publicKeyFor,
): Promise<OidcMatch> {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("The bearer token is not a JWT");
  }
  const header = decodePart(parts[0]);
  if (!isRecord(header) || header.alg !== "RS256") {
    throw new Error("The token must be signed with RS256");
  }
  const kid = typeof header.kid === "string" ? header.kid : null;
  const claims = decodePart(parts[1]);
  if (!isRecord(claims)) {
    throw new Error("The token's claims cannot be read");
  }
  const issuer = typeof claims.iss === "string" ? claims.iss.replace(/\/+$/, "") : "";
  const candidates = rules.filter((rule) => rule.issuer.replace(/\/+$/, "") === issuer);
  if (candidates.length === 0) {
    throw new Error(`No rule takes tokens from ${clip(issuer)}`);
  }
  const signature = Buffer.from(parts[2] ?? "", "base64url");
  const publicKey = await fetchKeys(issuer, kid);
  if (
    !verifySignature("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), publicKey, signature)
  ) {
    throw new Error("The token's signature is not its issuer's");
  }
  const expiry = tokenExpiry(claims, now);
  const matched = findRule(candidates, claims, issuer, expiry, now);
  if (matched === null) {
    throw new Error("The token matches no rule");
  }
  return { rule: matched, claims };
}

function tokenExpiry(claims: OidcClaims, now: number): number {
  const expiry = numericClaim(claims.exp);
  if (expiry === null) {
    throw new Error("The token has no expiry");
  }
  if (now >= expiry + LEEWAY_MS) {
    throw new Error("The token has expired");
  }
  const notBefore = numericClaim(claims.nbf);
  if (notBefore !== null && now + LEEWAY_MS < notBefore) {
    throw new Error("The token is not valid yet");
  }
  const issuedAt = numericClaim(claims.iat);
  if (issuedAt !== null && now + LEEWAY_MS < issuedAt) {
    throw new Error("The token was issued in the future");
  }
  return expiry;
}

function findRule(
  candidates: readonly OidcRule[],
  claims: OidcClaims,
  issuer: string,
  expiry: number,
  now: number,
): OidcRule | null {
  const audiences = audienceList(claims.aud);
  for (const rule of candidates) {
    if (!audiences.includes(rule.audience)) {
      continue;
    }
    if (!claimsMatch(rule.claims, claims)) {
      continue;
    }
    const jti = typeof claims.jti === "string" ? claims.jti : "";
    if (jti.length > 0 && !firstUse(`${issuer}|${jti}`, expiry + LEEWAY_MS, now)) {
      throw new Error("This token was traded for a key already");
    }
    return rule;
  }
  return null;
}

/** Resolves the rule's configured gateway key: by label or by secret. */
export function resolveOidcIssuer(
  config: GatewayConfig,
  ruleKey: string,
): { secret: string; label: string | null; models: string[] } | null {
  for (const entry of config.keys) {
    if (typeof entry === "string") {
      if (entry === ruleKey) {
        return { secret: entry, label: null, models: [] };
      }
      continue;
    }
    if (entry.key !== ruleKey && entry.label !== ruleKey) {
      continue;
    }
    if (!entry.issues || entry.issuer !== undefined) {
      return null;
    }
    return { secret: entry.key, label: entry.label ?? null, models: entry.models };
  }
  return null;
}

export function configuredOidcRules(config: GatewayConfig): OidcRule[] {
  return (config.oidc?.rules ?? []).map((rule) => ({
    id: rule.id ?? rule.audience ?? rule.key,
    key: rule.key,
    issuer: rule.issuer.replace(/\/+$/, ""),
    audience: rule.audience ?? `neolix-${rule.id ?? rule.key}`,
    claims: rule.claims,
    ttlSeconds: rule.ttlSeconds,
  }));
}

/** Keeps `sub`/`repository`/`ref`/`run_id`, matching myna's naming. */
export function oidcKeyName(claims: OidcClaims): string {
  let name = "OIDC";
  if (typeof claims.repository === "string" && claims.repository.length > 0) {
    name = claims.repository;
  } else if (typeof claims.sub === "string") {
    name = claims.sub;
  }
  if (typeof claims.ref === "string" && claims.ref.length > 0) {
    name += `@${claims.ref.replace(/^refs\/heads\//, "")}`;
  }
  if (typeof claims.run_id === "string" && claims.run_id.length > 0) {
    name += ` (run ${claims.run_id})`;
  }
  return name.slice(0, 120);
}

/** Claims are exact or a glob where `*` and `?` stop at `/`. */
export function claimsMatch(expected: Record<string, string>, claims: OidcClaims): boolean {
  return Object.entries(expected).every(([name, pattern]) => {
    const value = claimText(claims[name]);
    return value !== null && globMatch(pattern, value);
  });
}

function globMatch(pattern: string, value: string): boolean {
  let source = "^";
  for (const character of pattern) {
    if (character === "*") {
      source += "[^/]*";
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`${source}$`).test(value);
}

function claimText(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return null;
}

function audienceList(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }
  return [];
}

function numericClaim(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value * 1000;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return Number(value) * 1000;
  }
  return null;
}

function decodePart(part: string): unknown {
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function firstUse(mark: string, expiresAt: number, now: number): boolean {
  for (const [key, expiry] of tradedTokens) {
    if (expiry <= now) {
      tradedTokens.delete(key);
    }
  }
  if (tradedTokens.has(mark)) {
    return false;
  }
  tradedTokens.set(mark, expiresAt);
  while (tradedTokens.size > MAX_TRADED_TOKENS) {
    const oldest = tradedTokens.keys().next();
    if (oldest.done) {
      break;
    }
    tradedTokens.delete(oldest.value);
  }
  return true;
}

async function publicKeyFor(issuer: string, kid: string | null): Promise<KeyObject> {
  const now = Date.now();
  const cached = keyCache.get(issuer);
  if (cached !== undefined && now - cached.fetchedAt < JWKS_TTL_MS) {
    const key = selectKey(cached.keys, kid);
    if (key !== null) {
      return key;
    }
  }
  const jwksUri = await discoverJwksUri(issuer);
  const response = await fetch(jwksUri, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) {
    throw new Error(`The issuer's keys answered ${response.status}`);
  }
  const payload: unknown = await response.json();
  const keys = new Map<string, KeyObject>();
  if (isRecord(payload) && Array.isArray(payload.keys)) {
    for (const jwk of payload.keys) {
      if (!isRecord(jwk)) {
        continue;
      }
      try {
        keys.set(
          typeof jwk.kid === "string" ? jwk.kid : "",
          createPublicKey({ key: jwk, format: "jwk" }),
        );
      } catch {
        // A key of a type Node does not import simply cannot verify here.
      }
    }
  }
  keyCache.set(issuer, { fetchedAt: now, keys });
  const key = selectKey(keys, kid);
  if (key === null) {
    throw new Error("The issuer has no key for this token");
  }
  return key;
}

function selectKey(keys: Map<string, KeyObject>): KeyObject | null;
function selectKey(keys: Map<string, KeyObject>, kid: string | null): KeyObject | null;
function selectKey(keys: Map<string, KeyObject>, kid?: string | null): KeyObject | null {
  if (kid !== undefined && kid !== null) {
    const exact = keys.get(kid);
    if (exact !== undefined) {
      return exact;
    }
  }
  const first = keys.values().next();
  return first.done ? null : first.value;
}

async function discoverJwksUri(issuer: string): Promise<string> {
  try {
    const response = await fetch(`${issuer}/.well-known/openid-configuration`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) {
      const payload: unknown = await response.json();
      if (isRecord(payload) && typeof payload.jwks_uri === "string") {
        return payload.jwks_uri;
      }
    }
  } catch {
    // Fall through to the conventional path.
  }
  return `${issuer}/.well-known/jwks.json`;
}

function clip(value: string): string {
  return value.length > 100 ? `${value.slice(0, 100)}…` : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
