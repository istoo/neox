// `GET /api/site-favicon?domain=example.com`: the website icon Synara shows on link chips and
// connector rows. The bridge fetches it from the public site on the client's behalf, so the
// request is fenced like any server-side fetch of a user-supplied host: hostnames only, every
// hop (including redirects) must resolve to public addresses, bodies are size-capped and must
// really be images, and results are cached so a page of links costs one fetch per site.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { Effect } from "effect";

export const SITE_FAVICON_PATH = "/api/site-favicon";

const MAX_ICON_BYTES = 256 * 1024;
const FETCH_TIMEOUT_MS = 4_000;
const MAX_REDIRECTS = 3;
const HIT_TTL_MS = 24 * 60 * 60 * 1000;
const MISS_TTL_MS = 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 512;
const SECURITY_HEADERS = {
  "Content-Security-Policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'",
  "X-Content-Type-Options": "nosniff",
} as const;

export interface SiteIcon {
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

/** A bare public hostname, lowercased, or null for IPs, local names and malformed input. */
export function normalizeSiteHost(raw: string): string | null {
  const host = raw.trim().toLowerCase().replace(/\.$/, "");
  if (!host || isIP(host) !== 0) return null;
  if (
    host === "localhost" ||
    /\.(localhost|local|internal|lan|home\.arpa|intranet|corp)$/.test(host)
  )
    return null;
  const label = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
  const pattern = new RegExp(`^(?=.{1,253}$)(?:${label}\\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$`);
  return pattern.test(host) ? host : null;
}

function ipv4Parts(address: string): number[] | null {
  const parts = address.split(".").map(Number);
  return parts.length === 4 &&
    parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? parts
    : null;
}

/** False for loopback, private, link-local, CGNAT, multicast, reserved and mapped-private addresses. */
export function isPublicAddress(address: string): boolean {
  const v4 = ipv4Parts(address);
  if (v4) {
    const [a, b] = v4 as [number, number, number, number];
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && (b === 168 || (b === 0 && v4[2] === 0))) return false;
    // 198.18.0.0/15 (benchmarking) stays allowed: proxy clients in fake-IP mode (Clash, Surge)
    // answer every lookup from it and route the connection to the real public host.
    return true;
  }
  const v6 = address.toLowerCase();
  if (isIP(v6) !== 6) return false;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  if (mapped) return isPublicAddress(mapped[1]!);
  if (v6 === "::" || v6 === "::1") return false;
  // fc00::/7 unique local, fe80::/10 link-local, ff00::/8 multicast, 64:ff9b::/96 NAT64.
  return !/^(f[cd]|fe[89ab]|ff)/.test(v6) && !v6.startsWith("64:ff9b:");
}

type Resolve = (host: string) => Promise<ReadonlyArray<{ readonly address: string }>>;
type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface SiteFaviconDeps {
  readonly resolve?: Resolve;
  readonly fetch?: Fetch;
  readonly now?: () => number;
}

const defaultResolve: Resolve = (host) => lookup(host, { all: true });

function sniffImageType(bytes: Uint8Array): string | null {
  const head = (n: number) => Array.from(bytes.subarray(0, n));
  const starts = (sig: number[]) => sig.every((value, index) => bytes[index] === value);
  if (starts([0x89, 0x50, 0x4e, 0x47])) return "image/png";
  if (starts([0x00, 0x00, 0x01, 0x00])) return "image/x-icon";
  if (starts([0x47, 0x49, 0x46, 0x38])) return "image/gif";
  if (starts([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (starts([0x52, 0x49, 0x46, 0x46]) && String.fromCharCode(...head(12).slice(8)) === "WEBP")
    return "image/webp";
  const text = new TextDecoder().decode(bytes.subarray(0, 512)).trimStart().toLowerCase();
  if (text.startsWith("<svg") || (text.startsWith("<?xml") && text.includes("<svg")))
    return "image/svg+xml";
  return null;
}

/**
 * The body up to the size cap. An image over the cap is refused; a page is cut at the cap,
 * since the icon links sit in its `<head>`.
 */
async function readCapped(response: Response, truncate: boolean): Promise<Uint8Array | null> {
  const declared = Number(response.headers.get("content-length"));
  if (!truncate && Number.isFinite(declared) && declared > MAX_ICON_BYTES) return null;
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > MAX_ICON_BYTES) {
      await reader.cancel();
      if (!truncate) return null;
      chunks.push(value.subarray(0, MAX_ICON_BYTES - total));
      total = MAX_ICON_BYTES;
      break;
    }
    total += value.byteLength;
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function resolvesPublic(host: string, resolve: Resolve): Promise<boolean> {
  try {
    const addresses = await resolve(host);
    return addresses.length > 0 && addresses.every((entry) => isPublicAddress(entry.address));
  } catch {
    return false;
  }
}

/**
 * Fetches one URL over HTTPS, following redirects by hand so every hop is re-checked, and
 * returns the capped body with the URL it finally came from.
 * debt: the address is checked before fetch() resolves the host again, so a DNS rebind between
 * the two can still reach a private address; pin the checked address (connect by IP with SNI)
 * if this proxy is ever exposed beyond the local user.
 */
async function fetchPublic(
  start: URL,
  accept: string,
  deps: Required<SiteFaviconDeps>,
): Promise<{ readonly bytes: Uint8Array; readonly url: URL } | null> {
  let url = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const host = normalizeSiteHost(url.hostname);
    if (url.protocol !== "https:" || !host || !(await resolvesPublic(host, deps.resolve)))
      return null;
    let response: Response;
    try {
      response = await deps.fetch(url.href, {
        redirect: "manual",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { Accept: accept },
      });
    } catch {
      return null;
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) return null;
      try {
        url = new URL(location, url);
      } catch {
        return null;
      }
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    const bytes = await readCapped(response, accept === "text/html").catch(() => null);
    return bytes && bytes.byteLength > 0 ? { bytes, url } : null;
  }
  return null;
}

async function fetchIcon(url: URL, deps: Required<SiteFaviconDeps>): Promise<SiteIcon | null> {
  const fetched = await fetchPublic(url, "image/*", deps);
  const contentType = fetched ? sniffImageType(fetched.bytes) : null;
  return fetched && contentType ? { bytes: fetched.bytes, contentType } : null;
}

/** Icon URLs the page declares, `rel="icon"` before `apple-touch-icon`. */
export function declaredIconUrls(html: string, base: URL): URL[] {
  const icons: URL[] = [];
  const touch: URL[] = [];
  for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
    const rel = /\brel\s*=\s*["']?([^"'>]+)/i.exec(tag)?.[1]?.toLowerCase() ?? "";
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (!href || !/\bicon\b/.test(rel) || href.startsWith("data:")) continue;
    let url: URL;
    try {
      url = new URL(href.replaceAll("&amp;", "&"), base);
    } catch {
      continue;
    }
    (rel.includes("apple-touch-icon") ? touch : icons).push(url);
  }
  return [...icons, ...touch].slice(0, 4);
}

async function fetchDeclaredIcon(
  host: string,
  deps: Required<SiteFaviconDeps>,
): Promise<SiteIcon | null> {
  const page = await fetchPublic(new URL(`https://${host}/`), "text/html", deps);
  if (!page) return null;
  const html = new TextDecoder().decode(page.bytes);
  for (const url of declaredIconUrls(html, page.url)) {
    const icon = await fetchIcon(url, deps);
    if (icon) return icon;
  }
  return null;
}

interface CacheEntry {
  readonly expiresAt: number;
  readonly icon: SiteIcon | null;
}

export class SiteFaviconCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<SiteIcon | null>>();
  private readonly deps: Required<SiteFaviconDeps>;

  constructor(deps: SiteFaviconDeps = {}) {
    this.deps = {
      resolve: deps.resolve ?? defaultResolve,
      fetch: deps.fetch ?? ((url, init) => fetch(url, init)),
      now: deps.now ?? Date.now,
    };
  }

  /** The site's icon, or null when it has none the proxy may serve. */
  async get(host: string): Promise<SiteIcon | null> {
    const cached = this.entries.get(host);
    if (cached && cached.expiresAt > this.deps.now()) return cached.icon;
    const pending = this.inFlight.get(host);
    if (pending) return pending;
    const lookup = (async () => {
      // The conventional path is one cheap request; the page's own <link> tags cover sites
      // that keep their icon elsewhere.
      const icon =
        (await fetchIcon(new URL("/favicon.ico", `https://${host}`), this.deps)) ??
        (await fetchDeclaredIcon(host, this.deps)) ??
        (await fetchIcon(new URL("/apple-touch-icon.png", `https://${host}`), this.deps));
      this.remember(host, icon);
      return icon;
    })().finally(() => this.inFlight.delete(host));
    this.inFlight.set(host, lookup);
    return lookup;
  }

  private remember(host: string, icon: SiteIcon | null): void {
    this.entries.delete(host);
    if (this.entries.size >= MAX_CACHE_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(host, {
      expiresAt: this.deps.now() + (icon ? HIT_TTL_MS : MISS_TTL_MS),
      icon,
    });
  }
}

export function makeSiteFaviconHandler(
  cache: SiteFaviconCache = new SiteFaviconCache(),
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  never,
  HttpServerRequest.HttpServerRequest
> {
  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    const host = normalizeSiteHost(url?.searchParams.get("domain") ?? "");
    if (!host) return HttpServerResponse.text("Invalid domain", { status: 400 });
    const icon = yield* Effect.promise(() => cache.get(host));
    if (!icon) {
      return HttpServerResponse.empty({
        status: 404,
        headers: { "Cache-Control": "public, max-age=3600" },
      });
    }
    return HttpServerResponse.uint8Array(icon.bytes, {
      status: 200,
      contentType: icon.contentType,
      headers: { "Cache-Control": "public, max-age=86400", ...SECURITY_HEADERS },
    });
  });
}
