import type { Response as ExpressResponse } from "express";
import { resolveDaemonVersion } from "../daemon-version.js";
import type { GatewayAccount, GatewayProvider } from "./config.js";
import { middlewareReplyHeaderNames } from "./middleware-reply-headers.js";

/**
 * The provider's reply headers passed on to the agent (myna's
 * replyheaders.go), and the agent's request headers passed on to the vendor
 * (requestheaders.go). A relay's own request id is matched with its logs; a
 * header that changes per client goes as the client sent it.
 *
 * A name the gateway writes itself, or one that would act on its own
 * address, is never passed on, listed or not.
 */

/** Passed on from every provider's reply, without being listed. */
export const DEFAULT_REPLY_HEADERS = ["Request-Id", "X-Request-Id", "X-Oneapi-Request-Id"];

const REPLY_HEADERS_NEVER = new Set(
  [
    "Connection",
    "Keep-Alive",
    "Te",
    "Trailer",
    "Transfer-Encoding",
    "Upgrade",
    "Cache-Control",
    "X-Accel-Buffering",
    "Retry-After",
    "Date",
    "Server",
    "Vary",
    "Set-Cookie",
    "Set-Cookie2",
    "Cookie",
    "Authorization",
    "Www-Authenticate",
    "Authentication-Info",
    "X-Api-Key",
    "Api-Key",
    "Location",
    "Refresh",
    "Link",
    "Alt-Svc",
    "Strict-Transport-Security",
    "Content-Security-Policy",
    "Origin",
    "Host",
    "Clear-Site-Data",
  ].map((name) => name.toLowerCase()),
);

const REPLY_HEADERS_NEVER_PREFIX = [
  "content-",
  "proxy-",
  "access-control-",
  "sec-",
  "x-magpie-",
  "x-neolix-",
];

const REQUEST_HEADERS_NEVER = new Set(
  [
    "Authorization",
    "X-Api-Key",
    "X-Goog-Api-Key",
    "Api-Key",
    "Cookie",
    "Set-Cookie",
    "Set-Cookie2",
    "Www-Authenticate",
    "Authentication-Info",
    "Host",
    "Connection",
    "Keep-Alive",
    "Te",
    "Trailer",
    "Transfer-Encoding",
    "Upgrade",
    "Expect",
    "Accept",
    "Accept-Encoding",
    "Origin",
  ].map((name) => name.toLowerCase()),
);

const REQUEST_HEADERS_NEVER_PREFIX = ["content-", "proxy-", "sec-", "x-magpie-", "x-neolix-"];

/** A header name as HTTP spells it, e.g. `x-trace` → `X-Trace`. */
export function canonicalHeaderName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("-");
}

/** An HTTP token (RFC 9110): no space, colon or control character. */
export function validHeaderName(name: string): boolean {
  if (name.length === 0) {
    return false;
  }
  for (const character of name) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x20 || code >= 0x7f || '"(),/:;<=>?@[\\]{}'.includes(character)) {
      return false;
    }
  }
  return true;
}

export function replyHeaderPassable(name: string): boolean {
  const canonical = canonicalHeaderName(name);
  if (!validHeaderName(canonical) || REPLY_HEADERS_NEVER.has(canonical.toLowerCase())) {
    return false;
  }
  const lower = canonical.toLowerCase();
  return !REPLY_HEADERS_NEVER_PREFIX.some((prefix) => lower.startsWith(prefix));
}

export function requestHeaderPassable(name: string): boolean {
  const canonical = canonicalHeaderName(name);
  if (!validHeaderName(canonical) || REQUEST_HEADERS_NEVER.has(canonical.toLowerCase())) {
    return false;
  }
  const lower = canonical.toLowerCase();
  return !REQUEST_HEADERS_NEVER_PREFIX.some((prefix) => lower.startsWith(prefix));
}

/** What is wrong with a reply-header list, or null when nothing is. */
export function replyHeadersProblem(names: readonly string[]): string | null {
  for (const name of names) {
    const canonical = canonicalHeaderName(name);
    if (canonical.length === 0) {
      continue;
    }
    if (!validHeaderName(canonical)) {
      return `"${name.trim()}" isn't a header name`;
    }
    if (!replyHeaderPassable(canonical)) {
      return `${canonical} is never passed on: the gateway writes it, or it would act on its own address`;
    }
  }
  return null;
}

/** What is wrong with a request-header list, or null when nothing is. */
export function requestHeadersProblem(names: readonly string[]): string | null {
  for (const name of names) {
    const canonical = canonicalHeaderName(name);
    if (canonical.length === 0) {
      continue;
    }
    if (!validHeaderName(canonical)) {
      return `"${name.trim()}" isn't a header name`;
    }
    if (!requestHeaderPassable(canonical)) {
      return `${canonical} is never passed on: it carries a key, or the gateway or the connection writes it`;
    }
  }
  return null;
}

/** A list as saved: canonical, each name once, what can't be passed dropped. */
export function cleanHeaderList(
  names: readonly string[],
  passable: (name: string) => boolean,
): string[] {
  const out: string[] = [];
  for (const name of names) {
    const canonical = canonicalHeaderName(name);
    if (canonical.length > 0 && passable(canonical) && !out.includes(canonical)) {
      out.push(canonical);
    }
  }
  return out;
}

/** The reply headers of `upstream` that go on to the agent. */
export function passedReplyHeaders(
  provider: GatewayProvider,
  upstream: { headers: Headers },
): Record<string, string> {
  const out: Record<string, string> = {};
  // A gateway middleware may set reply headers of its own; they go on under
  // the same rules as a provider's listed ones.
  const names = [
    ...DEFAULT_REPLY_HEADERS,
    ...(provider.replyHeaders ?? []),
    ...middlewareReplyHeaderNames(upstream),
  ];
  for (const name of names) {
    const canonical = canonicalHeaderName(name);
    if (!replyHeaderPassable(canonical) || out[canonical] !== undefined) {
      continue;
    }
    const value = upstream.headers.get(canonical);
    if (value !== null) {
      out[canonical] = value;
    }
  }
  return out;
}

/** Puts the vendor's reply headers a provider passes on into a reply. */
export function applyReplyHeaders(
  res: ExpressResponse,
  provider: GatewayProvider,
  upstream: { headers: Headers },
): void {
  for (const [name, value] of Object.entries(passedReplyHeaders(provider, upstream))) {
    res.setHeader(name, value);
  }
}

/**
 * Puts into the vendor's request the agent's headers `provider.passHeaders`
 * lists, as sent, in place of a fixed header of the same name. A listed
 * header the agent didn't send leaves the fixed one as it was.
 */
export function passClientHeaders(
  provider: GatewayProvider,
  incoming: Record<string, string | string[] | undefined>,
  upstream: Headers,
): void {
  for (const name of provider.passHeaders ?? []) {
    const canonical = canonicalHeaderName(name);
    if (!requestHeaderPassable(canonical)) {
      continue;
    }
    const raw = incoming[canonical.toLowerCase()];
    const value = Array.isArray(raw) ? raw.join(", ") : raw;
    if (typeof value === "string" && value.length > 0) {
      upstream.set(canonical, value);
    }
  }
}

/**
 * The User-Agent the agent sent, ready to be passed on: null when it sent
 * none, or when the one it sent is Neolix's own (`mynasOwn`, a classifier's
 * or another Neolix's, which no agent sent —
 * `internal/gateway/user_agent.go:19-36`). Whether the provider passes it
 * on at all is `provider-shaping.ts`'s `userAgentFor`/`passesUserAgent`,
 * the one decision both the settings page and the request path read.
 */
export function sentUserAgentOf(
  incoming: Record<string, string | string[] | undefined>,
): string | null {
  const raw = incoming["user-agent"];
  const value = Array.isArray(raw) ? raw.join(", ") : raw;
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  const agent = value.trim();
  return neolixOwnUserAgent(agent) ? null : agent;
}

/**
 * COMPAT(agentUserAgentOfArgs): the provider and account take no part in
 * the answer anymore — `provider-shaping.ts`'s `userAgentFor` decides — but
 * upstream.ts's call still passes them. Remove this wrapper with that call
 * after 2027-11-06.
 */
export function agentUserAgentOf(
  _provider: GatewayProvider,
  _account: GatewayAccount | undefined,
  incoming: Record<string, string | string[] | undefined>,
): string | null {
  return sentUserAgentOf(incoming);
}

/** A User-Agent Neolix's own requests carry, or another Neolix's. */
export function neolixOwnUserAgent(userAgent: string): boolean {
  const lower = userAgent.trim().toLowerCase();
  return ["neolix/", "neolix-"].some((prefix) => lower.startsWith(prefix));
}

let gatewayUserAgentValue: string | null = null;

/**
 * The User-Agent Neolix's own requests go upstream with, myna's
 * `myna/<version>` (`internal/gateway/user_agent.go:12`): the daemon's own
 * version, read once from the package it runs from.
 */
export function gatewayUserAgent(): string {
  if (gatewayUserAgentValue === null) {
    let version = "0";
    try {
      version = resolveDaemonVersion(import.meta.url);
    } catch {
      // A checkout without the package file still names the client.
    }
    gatewayUserAgentValue = `neolix/${version}`;
  }
  return gatewayUserAgentValue;
}
