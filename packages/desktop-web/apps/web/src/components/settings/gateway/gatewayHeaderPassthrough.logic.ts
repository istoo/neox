// FILE: gatewayHeaderPassthrough.logic.ts
// Purpose: The checks a provider's header-passthrough lists need before the
//          settings page writes them: an HTTP token, the spellings the daemon
//          saves, and the names it never passes on.
// Layer: Settings logic

/**
 * Which list a name is for: `reply` is a header of the vendor's reply passed on
 * to the agent, `request` a header of the agent's request passed on to the
 * vendor.
 */
export type HeaderListKind = "reply" | "request";

/** What is wrong with a name: not a header name, or one never passed on. */
export type HeaderNameProblem = "invalid" | "reserved";

// debt: mirror of packages/server/src/server/llm-gateway/header-passthrough.ts.
// The server silently drops these names, so the page has to name them too; keep
// both lists in step when the server's change.
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

function listNeverPassed(kind: HeaderListKind): ReadonlySet<string> {
  return kind === "reply" ? REPLY_HEADERS_NEVER : REQUEST_HEADERS_NEVER;
}

function prefixesNeverPassed(kind: HeaderListKind): readonly string[] {
  return kind === "reply" ? REPLY_HEADERS_NEVER_PREFIX : REQUEST_HEADERS_NEVER_PREFIX;
}

/** Whether the daemon passes this name on at all. */
export function headerPassable(name: string, kind: HeaderListKind): boolean {
  const canonical = canonicalHeaderName(name);
  if (!validHeaderName(canonical) || listNeverPassed(kind).has(canonical.toLowerCase())) {
    return false;
  }
  const lower = canonical.toLowerCase();
  return !prefixesNeverPassed(kind).some((prefix) => lower.startsWith(prefix));
}

/**
 * What is wrong with a name being typed, or null. An empty row is still being
 * typed, not an error.
 */
export function headerNameProblem(name: string, kind: HeaderListKind): HeaderNameProblem | null {
  if (name.trim().length === 0) {
    return null;
  }
  const canonical = canonicalHeaderName(name);
  if (!validHeaderName(canonical)) {
    return "invalid";
  }
  return headerPassable(canonical, kind) ? null : "reserved";
}

/** Names as saved: canonical, each once, what the daemon cannot pass dropped. */
export function cleanHeaderList(names: readonly string[], kind: HeaderListKind): string[] {
  const out: string[] = [];
  for (const name of names) {
    const canonical = canonicalHeaderName(name);
    if (canonical.length > 0 && headerPassable(canonical, kind) && !out.includes(canonical)) {
      out.push(canonical);
    }
  }
  return out;
}
