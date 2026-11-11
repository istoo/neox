import { bridgedSocksUrl } from "./bridge.js";
import { readSystemProxy, type SystemProxy, type SystemProxyProbe } from "./system-proxy.js";

/**
 * Which proxy Neolix's own requests to vendors go through, in myna's order
 * (internal/netproxy/netproxy.go:284-301):
 *
 *   1. the proxy in settings, or "direct" for none;
 *   2. the usual *_PROXY variables;
 *   3. the system's proxy (macOS network settings, Windows Internet
 *      Options).
 *
 * Loopback is never proxied, nor is a host on the user's own network
 * unless a provider named a proxy of its own. The daemon's settings value
 * lives in `gateway.json`'s `proxy` field, which is where Neolix keeps what
 * myna keeps in its own settings file.
 */
export type ProxySource = "settings" | "environment" | "system" | "off" | "none";

export interface EffectiveProxy {
  /** The address, unredacted; "" when requests go direct. */
  url: string;
  /** What picked it. */
  source: ProxySource;
  /** Hosts the system sends around the proxy. */
  bypass: string[];
  /** The plain-http entry had one been named separately. */
  httpUrl: string;
}

export interface ProxyEnvironment {
  httpProxy: string;
  httpsProxy: string;
  noProxy: string;
}

export interface ProxyResolutionOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** The settings value: "" follows the environment and system, "direct" is off. */
  setting?: string;
  /** Injected in tests; the real probe otherwise. */
  systemProbe?: SystemProxyProbe;
}

export interface ResolvedProxy extends EffectiveProxy {
  /** The proxy for each scheme, as undici's EnvHttpProxyAgent takes them. */
  httpProxy: string;
  httpsProxy: string;
  noProxy: string;
}

let configuredProxy = "";

/**
 * Keep the settings proxy in step with `gateway.json`. Called when the
 * config store reads a revision, so a change of proxy reaches requests
 * without a restart. Returns what is in force afterwards.
 */
export function setConfiguredProxy(value: string | undefined): void {
  configuredProxy = (value ?? "").trim();
}

export function configuredProxyValue(): string {
  return configuredProxy;
}

/** Parse a proxy address; a bare host:port is an HTTP proxy (myna Parse). */
export function parseProxyAddress(raw: string): URL | null {
  const text = raw.trim();
  if (text === "") {
    return null;
  }
  try {
    return new URL(text.includes("://") ? text : `http://${text}`);
  } catch {
    return null;
  }
}

export function isSocksProxy(raw: string): boolean {
  const url = parseProxyAddress(raw);
  return url !== null && (url.protocol === "socks5:" || url.protocol === "socks5h:");
}

/** A proxy as the settings page may show it: its user and password left out. */
export function redactProxy(raw: string): string {
  const url = parseProxyAddress(raw);
  if (url === null) {
    return "";
  }
  if (url.username === "" && url.password === "") {
    return raw;
  }
  const shown = new URL(url.href);
  shown.username = "";
  shown.password = "";
  const address = shown.href;
  return raw.includes("://") ? address : address.replace(/^http:\/\//, "");
}

/** The *_PROXY variables, read as myna reads them. */
export function readProxyEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): ProxyEnvironment {
  const values = new Map(
    Object.entries(env).map(([name, value]) => [
      platform === "win32" ? name.toLowerCase() : name,
      value,
    ]),
  );
  const get = (name: string): string => validHttpProxy(values.get(name));
  const raw = (name: string): string => (values.get(name) ?? "").trim();
  const httpProxy = get("http_proxy") || get("HTTP_PROXY");
  const allProxy = get("ALL_PROXY") || get("all_proxy");
  const httpsProxy = get("https_proxy") || get("HTTPS_PROXY") || allProxy || httpProxy;
  return {
    httpProxy: httpProxy || allProxy,
    httpsProxy,
    noProxy: raw("no_proxy") || raw("NO_PROXY"),
  };
}

/**
 * An *_PROXY value as undici can use it: http(s) only, like myna's
 * http.ProxyFromEnvironment read. A socks5:// value in the environment is
 * left to the system proxy; a SOCKS proxy belongs in the settings, where
 * the bridge carries it.
 */
function validHttpProxy(value: string | undefined): string {
  if (value === undefined || value.trim() === "") {
    return "";
  }
  const url = parseProxyAddress(value);
  if (url === null || (url.protocol !== "http:" && url.protocol !== "https:")) {
    return "";
  }
  try {
    // undici decodes the login when it builds its ProxyAgent; a malformed
    // escape must fall back rather than throw during startup.
    decodeURIComponent(url.username);
    decodeURIComponent(url.password);
  } catch {
    return "";
  }
  return url.href;
}

/** Split NO_PROXY/ProxyOverride into hosts; "*" stays as itself. */
export function bypassEntries(noProxy: string): string[] {
  return noProxy
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** NO_PROXY with loopback and the system's exceptions always left out. */
export function mergedNoProxy(noProxy: string, bypass: readonly string[]): string {
  const entries = bypassEntries(noProxy);
  if (entries.includes("*")) {
    return "*";
  }
  for (const entry of bypass) {
    const text = entry.trim().replace(/^\*/, "");
    if (text !== "" && text !== "<local>") {
      entries.push(text);
    }
  }
  for (const loopback of ["localhost", "127.0.0.1", "[::1]", "::1"]) {
    if (!entries.includes(loopback)) {
      entries.push(loopback);
    }
  }
  return entries.join(",");
}

/** Whether a host is on this computer (myna loopback). */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    host === "[::1]" ||
    host.startsWith("127.")
  );
}

/** Whether the system's exception list sends a host around the proxy. */
export function bypassedHost(hostname: string, bypass: readonly string[]): boolean {
  const host = hostname.toLowerCase();
  for (const raw of bypass) {
    const entry = raw.trim().toLowerCase();
    if (entry === "") {
      continue;
    }
    if (entry === "<local>") {
      if (!host.includes(".")) {
        return true;
      }
      continue;
    }
    if (entry === "*") {
      return true;
    }
    if (entry.startsWith("*.") || entry.startsWith(".")) {
      const suffix = entry.replace(/^\*/, "");
      if (host.endsWith(suffix) || host === suffix.slice(1)) {
        return true;
      }
      continue;
    }
    if (host === entry) {
      return true;
    }
  }
  return false;
}

/**
 * The proxy a request to this URL would use, or undefined for direct.
 * `choice` is a provider's own proxy (myna's With): "" follows the global
 * one, "direct" goes through none, anything else is that address.
 */
export function proxyForUrl(
  target: URL,
  resolution: ResolvedProxy,
  choice = "",
): string | undefined {
  if (isLoopbackHost(target.hostname)) {
    return undefined;
  }
  const named = choice.trim();
  if (named !== "") {
    if (named === "direct") {
      return undefined;
    }
    const parsed = parseProxyAddress(named);
    return parsed?.href;
  }
  if (resolution.url === "" || bypassedHost(target.hostname, resolution.bypass)) {
    return undefined;
  }
  return resolution.url;
}

/**
 * Read the proxy in force. The system is read only when neither the
 * settings nor the environment names one, so a machine without a proxy
 * costs nothing on the common path.
 */
export function resolveProxy(options: ProxyResolutionOptions = {}): ResolvedProxy {
  const setting = (options.setting ?? configuredProxy).trim();
  if (setting === "direct") {
    return emptyResolution("off");
  }
  if (setting !== "") {
    const url = parseProxyAddress(setting);
    if (url !== null) {
      return {
        url: url.href,
        source: "settings",
        bypass: [],
        httpUrl: url.href,
        httpProxy: url.href,
        httpsProxy: url.href,
        noProxy: mergedNoProxy("", []),
      };
    }
  }
  const env = readProxyEnvironment(options.env, options.platform);
  if (env.httpProxy !== "" || env.httpsProxy !== "") {
    return {
      url: env.httpsProxy || env.httpProxy,
      source: "environment",
      bypass: [],
      httpUrl: env.httpProxy,
      httpProxy: env.httpProxy,
      httpsProxy: env.httpsProxy,
      noProxy: mergedNoProxy(env.noProxy, []),
    };
  }
  return fromSystem(readSystemCached(options));
}

/**
 * The system read stands for 15 seconds while a proxy is set and 2 while
 * none is, as myna keeps it (netproxy.go:513-518). The read runs a tool,
 * so it happens off the request path: a caller takes the value in force
 * now and a refresh lands on the next call.
 */
let systemCache: { at: number; platform: NodeJS.Platform; proxy: SystemProxy } | null = null;
let systemReading: { platform: NodeJS.Platform; promise: Promise<boolean> } | null = null;

const EMPTY_SYSTEM: SystemProxy = { url: "", http: "", socks: "", bypass: [] };

function readSystemCached(options: ProxyResolutionOptions): SystemProxy {
  if (options.systemProbe !== undefined) {
    return options.systemProbe();
  }
  const platform = options.platform ?? process.platform;
  const now = Date.now();
  const keep = (systemCache?.proxy.url ?? "") === "" ? 2_000 : 15_000;
  if (systemCache !== null && systemCache.platform === platform && now - systemCache.at <= keep) {
    return systemCache.proxy;
  }
  void refreshSystemProxy(platform);
  return systemCache?.platform === platform ? systemCache.proxy : EMPTY_SYSTEM;
}

/**
 * Re-read the system proxy and keep it. Returns whether what a request
 * would use changed, so the caller can re-install its dispatcher.
 */
export async function refreshSystemProxy(platform = process.platform): Promise<boolean> {
  if (systemReading !== null && systemReading.platform === platform) {
    return systemReading.promise;
  }
  const promise = readSystemProxy(platform)
    .then((proxy) => {
      const previous = systemCache?.platform === platform ? systemCache.proxy : EMPTY_SYSTEM;
      systemCache = { at: Date.now(), platform, proxy };
      return previous.url !== proxy.url || previous.socks !== proxy.socks;
    })
    .finally(() => {
      systemReading = null;
    });
  systemReading = { platform, promise };
  return promise;
}

/** Forget the cached system read; for tests. */
export function resetSystemProxyCache(): void {
  systemCache = null;
  systemReading = null;
}

function fromSystem(system: SystemProxy): ResolvedProxy {
  if (system.url === "") {
    return emptyResolution("none");
  }
  return {
    url: system.url,
    source: "system",
    bypass: system.bypass,
    httpUrl: system.http || system.url,
    httpProxy: system.http || system.url,
    httpsProxy: system.url,
    noProxy: mergedNoProxy("", system.bypass),
  };
}

function emptyResolution(source: ProxySource): ResolvedProxy {
  return {
    url: "",
    source,
    bypass: [],
    httpUrl: "",
    httpProxy: "",
    httpsProxy: "",
    noProxy: mergedNoProxy("", []),
  };
}

/** What Settings › Network shows: the proxy in force and what chose it. */
export function describeEffectiveProxy(options: ProxyResolutionOptions = {}): {
  proxy: string;
  source: ProxySource;
} {
  const resolution = resolveProxy(options);
  return { proxy: redactProxy(resolution.url), source: resolution.source };
}

/**
 * The address to give a consumer that takes http:// only (undici, Bun):
 * a SOCKS5 proxy is replaced by its loopback bridge when one is running.
 */
export async function httpProxyAddress(url: string): Promise<string> {
  if (!isSocksProxy(url)) {
    return url;
  }
  return (await bridgedSocksUrl(url)) ?? url;
}

/**
 * `env` for a CLI Neolix starts, told to use the proxy Neolix's own requests
 * would (myna EnvWith, netproxy.go:315-348). A proxy set in the settings
 * replaces any in `env`; "direct" drops them; the system's is added only
 * where `env` names none. Loopback never goes through it.
 */
export function applyProxyEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  options: ProxyResolutionOptions = {},
): NodeJS.ProcessEnv {
  const current = readProxyEnvironment(env, options.platform);
  const setting = (options.setting ?? configuredProxy).trim();
  if (setting === "") {
    if (current.httpProxy !== "" || current.httpsProxy !== "") {
      return env;
    }
    const system = readSystemCached(options);
    if (system.url === "") {
      return env;
    }
    return withProxyEnvironment(env, system.url, mergedNoProxy("", system.bypass));
  }
  if (setting === "direct") {
    return withProxyEnvironment(env, "", "");
  }
  const url = parseProxyAddress(setting);
  if (url === null) {
    return env;
  }
  return withProxyEnvironment(env, url.href, mergedNoProxy("", []));
}

const PROXY_VARIABLES = new Set([
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
]);

function withProxyEnvironment(
  env: NodeJS.ProcessEnv,
  proxy: string,
  noProxy: string,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (!PROXY_VARIABLES.has(name)) {
      out[name] = value;
    }
  }
  if (proxy === "") {
    return out;
  }
  return {
    ...out,
    HTTPS_PROXY: proxy,
    https_proxy: proxy,
    HTTP_PROXY: proxy,
    http_proxy: proxy,
    ALL_PROXY: proxy,
    all_proxy: proxy,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
  };
}

/** For tests: forget the settings value. */
export function resetConfiguredProxy(): void {
  configuredProxy = "";
}
