import type { Request as ExpressRequest, Response as ExpressResponse } from "express";
import type { GatewayConfig } from "./config.js";

/**
 * The gateway's own CORS rules (myna's cors.go). A web page or browser
 * extension the user listed in gateway.json (`corsOrigins`) may call the
 * gateway from a browser: its preflight is answered, and its calls carry the
 * headers that let the page read the reply. Such a call must carry an enabled
 * key — a page is not an agent the user started, and on loopback a call needs
 * no key.
 *
 * Any other http(s) page is refused 403: on loopback a call needs no key and
 * a "simple" text/plain POST can be sent blind. `Origin: null` (a sandboxed
 * frame or a local file) and a `*.localhost` subdomain (WebKit hands the name
 * to the system resolver) are refused too unless the call carries a key.
 * Schemes only an app or extension can send pass untouched, as before.
 */

const EXPOSED_HEADERS = ["x-magpie-session", "x-neolix-conversation"];

interface CorsRequestLike {
  method?: string | undefined;
  headers: Record<string, string | string[] | undefined>;
  url?: string | undefined;
}

function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string {
  const value = headers[name];
  if (Array.isArray(value)) {
    return value[0] ?? "";
  }
  return value ?? "";
}

const EXTENSION_IDS: Record<string, RegExp> = {
  "chrome-extension": /^[a-p]{32}$/,
  "moz-extension": /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  "safari-web-extension": /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
};

/** An origin as a browser's Origin header spells it; null when it isn't one. */
export function cleanOrigin(raw: string): string | null {
  const text = raw.trim();
  if (text.length === 0 || text.includes("*")) {
    return null;
  }
  const extension = cleanExtensionOrigin(text);
  if (extension !== undefined) {
    return extension;
  }
  return cleanWebOrigin(text);
}

/** An extension's origin, or undefined when `text` names no extension scheme. */
function cleanExtensionOrigin(text: string): string | null | undefined {
  const cut = text.toLowerCase().indexOf("://");
  if (cut < 0) {
    return undefined;
  }
  const scheme = text.slice(0, cut).toLowerCase();
  const pattern = EXTENSION_IDS[scheme];
  if (pattern === undefined) {
    return undefined;
  }
  const rest = text
    .slice(cut + 3)
    .replace(/\/+$/, "")
    .toLowerCase();
  return pattern.test(rest) ? `${scheme}://${rest}` : null;
}

function cleanWebOrigin(text: string): string | null {
  let url: URL;
  try {
    url = new URL(text.replace(/\/$/, ""));
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return null;
  }
  if (url.host === "" || url.username !== "" || url.password !== "" || url.search !== "") {
    return null;
  }
  if (url.pathname !== "" && url.pathname !== "/") {
    return null;
  }
  const scheme = url.protocol.slice(0, -1);
  const host = url.hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  const port =
    (scheme === "http" && url.port === "80") || (scheme === "https" && url.port === "443")
      ? ""
      : url.port;
  const shown = host.includes(":") ? `[${host}]` : host;
  const shownHostPort = port === "" ? shown : `${shown}:${port}`;
  return `${scheme}://${shownHostPort}`;
}

/** The settings list in one form, without repeats. */
export function cleanOrigins(list: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of list) {
    const origin = cleanOrigin(raw);
    if (origin !== null && !out.includes(origin)) {
      out.push(origin);
    }
  }
  return out;
}

/** `origin` is one the user listed. */
export function corsAllowed(origin: string, config: GatewayConfig): boolean {
  const saved = cleanOrigins(config.corsOrigins ?? []);
  if (saved.length === 0) {
    return false;
  }
  const cleaned = cleanOrigin(origin);
  return cleaned !== null && saved.includes(cleaned);
}

/** A browser's CORS preflight: an OPTIONS declaring the call to come. */
export function isCorsPreflight(req: CorsRequestLike): boolean {
  return (
    req.method === "OPTIONS" &&
    headerValue(req.headers, "origin") !== "" &&
    headerValue(req.headers, "access-control-request-method") !== ""
  );
}

/** A listed origin's preflight, which the key check must let through. */
export function isListedPreflight(req: CorsRequestLike, config: GatewayConfig): boolean {
  return isCorsPreflight(req) && corsAllowed(headerValue(req.headers, "origin"), config);
}

/** A preflight's asked headers, as the answer allows them. */
export function corsAllowHeaders(asked: string): string {
  return asked
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0 && /^[A-Za-z0-9_-]+$/.test(name))
    .join(", ");
}

/** host[:port] lower-cased with the scheme's port filled in. */
function hostPort(raw: string, scheme: string): string {
  const text = raw.toLowerCase();
  if (text.length === 0) {
    return "";
  }
  if (text.startsWith("[")) {
    return text;
  }
  const colon = text.lastIndexOf(":");
  if (colon >= 0 && /^\d+$/.test(text.slice(colon + 1))) {
    return `${text.slice(0, colon)}:${text.slice(colon + 1)}`;
  }
  return `${text}:${scheme === "https" ? "443" : "80"}`;
}

/**
 * `origin` is an http(s) page that is neither on this computer (localhost,
 * *.localhost, 127.0.0.0/8, [::1], any port) nor the request's own origin, so
 * a browser sent it for a site elsewhere. Only http and https are judged:
 * app://, file://, chrome-extension:// and the like come from desktop apps,
 * editor webviews and extensions that don't enforce CORS.
 */
export function foreignPage(req: CorsRequestLike, origin: string): boolean {
  if (origin.length === 0) {
    return false;
  }
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return origin.toLowerCase().startsWith("http");
  }
  const scheme = url.protocol.toLowerCase();
  if (scheme !== "http:" && scheme !== "https:") {
    return false;
  }
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) {
    return false;
  }
  if (host.startsWith("127.") || host === "::1" || host === "[::1]") {
    return false;
  }
  const ownHost = headerValue(req.headers, "host");
  if (
    ownHost !== "" &&
    hostPort(url.host, scheme.slice(0, -1)) === hostPort(ownHost, scheme.slice(0, -1))
  ) {
    return false;
  }
  // myna's Omarchy page reads this machine's theme without a gateway key
  // (myna's cors.go:141).
  if ((req.url ?? "").split("?")[0] === "/v1/myna/omarchy" && omarchySiteOrigin(origin)) {
    return false;
  }
  return true;
}

/** The pages that may read this machine's Omarchy theme. */
const OMARCHY_SITE_ORIGINS = new Set([
  "https://github.com/istoo/myna",
  "https://www.github.com/istoo/myna",
]);

/** `origin` is a page the Omarchy theme answers (myna's omarchy.go:15-19). */
export function omarchySiteOrigin(origin: string): boolean {
  return (
    OMARCHY_SITE_ORIGINS.has(origin) ||
    (origin.length > 0 && origin === (process.env.MYNA_SITE_ORIGIN ?? ""))
  );
}

/**
 * An http(s) page at a subdomain of localhost. Chrome and Firefox resolve
 * *.localhost to loopback by rule, but Safari and other WebKit views hand the
 * name to the system resolver, which may answer from anywhere. Tauri's and
 * Wails' webviews on Windows serve themselves at tauri.localhost and
 * wails.localhost, so those are left out there.
 */
export function localhostSubdomain(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  const scheme = url.protocol.toLowerCase();
  if (scheme !== "http:" && scheme !== "https:") {
    return false;
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host.endsWith(".localhost")) {
    return false;
  }
  return process.platform !== "win32" || (host !== "tauri.localhost" && host !== "wails.localhost");
}

export interface CorsOutcome {
  /** The response was finished here. */
  done: boolean;
  /** The origin is listed: the call needs an enabled key. */
  keyed: boolean;
}

export interface CorsRefusal {
  status: number;
  message: string;
}

/**
 * The refusal the CORS rules give a request that isn't a listed origin's
 * preflight, or null when it may go on. `keyed` says the call carries an
 * enabled gateway key.
 */
export function corsRefusal(
  req: CorsRequestLike,
  config: GatewayConfig,
  keyed: boolean,
): CorsRefusal | null {
  const origin = headerValue(req.headers, "origin");
  if (origin.length === 0 || corsAllowed(origin, config)) {
    return null;
  }
  if (foreignPage(req, origin)) {
    return {
      status: 403,
      message: `Neox doesn't answer the web page ${origin}: list it in gateway.json's corsOrigins to let it call the gateway with a key`,
    };
  }
  if (origin === "null" && !keyed) {
    return {
      status: 403,
      message:
        "Neox doesn't answer a sandboxed frame or a local page (Origin: null) without a gateway key: send one as Authorization: Bearer <key> (or x-api-key)",
    };
  }
  if (localhostSubdomain(origin) && !keyed) {
    return {
      status: 403,
      message: `Neox doesn't answer the web page ${origin} without a gateway key: Safari and other WebKit browsers ask the DNS for a localhost subdomain, so the page may not be on this computer. Open it at localhost or 127.0.0.1, or send a gateway key`,
    };
  }
  return null;
}

/**
 * Applies the gateway's CORS rules to a request. `keyed` says the call
 * carries an enabled gateway key. Returns done when a preflight or a refusal
 * was answered here; otherwise the CORS headers are set and the call goes on.
 */
export function applyGatewayCors(
  req: ExpressRequest,
  res: ExpressResponse,
  config: GatewayConfig,
  keyed: boolean,
): CorsOutcome {
  const origin = headerValue(req.headers, "origin");
  if (origin.length === 0) {
    return { done: false, keyed: false };
  }
  if (corsAllowed(origin, config)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Expose-Headers", EXPOSED_HEADERS.join(", "));
    res.setHeader("Vary", "Origin");
    if (isCorsPreflight(req)) {
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      const asked = corsAllowHeaders(headerValue(req.headers, "access-control-request-headers"));
      if (asked.length > 0) {
        res.setHeader("Access-Control-Allow-Headers", asked);
      }
      if (headerValue(req.headers, "access-control-request-private-network") === "true") {
        res.setHeader("Access-Control-Allow-Private-Network", "true");
      }
      res.setHeader("Access-Control-Max-Age", "600");
      res.status(204).end();
      return { done: true, keyed: false };
    }
    if (!keyed) {
      refuse(
        res,
        401,
        "a web page or browser extension calls Neox with a gateway key: create one in the gateway's settings and send it as Authorization: Bearer <key> (or x-api-key)",
      );
      return { done: true, keyed: false };
    }
    return { done: false, keyed: true };
  }
  const refusal = corsRefusal(req, config, keyed);
  if (refusal !== null) {
    refuse(res, refusal.status, refusal.message);
    return { done: true, keyed: false };
  }
  return { done: false, keyed: false };
}

function refuse(res: ExpressResponse, status: number, message: string): void {
  res
    .status(status)
    .json({ error: { message, type: status === 403 ? "forbidden" : "unauthorized" } });
}

/**
 * A path the gateway router answers. Only used to let a browser's preflight
 * reach the gateway past the daemon's blanket OPTIONS answer.
 */
const GATEWAY_EXACT_PATHS = new Set([
  "/v1",
  "/v1/",
  "/me",
  "/models",
  "/responses",
  "/chat/completions",
  "/messages",
  "/messages/count_tokens",
  "/embeddings",
  "/rerank",
  "/videos",
  "/images/generations",
  "/images/edits",
  "/audio/speech",
  "/audio/transcriptions",
  "/audio/translations",
  "/alpha/search",
  "/muse-code/models",
  "/api/version",
  "/api/tags",
  "/api/show",
  "/api/chat",
  "/api/generate",
  "/api/hello",
]);

const GATEWAY_PREFIXES = [
  "/v1/",
  "/v1beta/",
  "/backend-api/codex/",
  "/mcp/myna/",
  "/models/",
  "/videos/",
  "/images/",
  "/audio/",
];

export function isGatewayPath(pathname: string): boolean {
  return (
    GATEWAY_EXACT_PATHS.has(pathname) ||
    GATEWAY_PREFIXES.some((prefix) => pathname.startsWith(prefix))
  );
}
