import type { Agent } from "node:http";
import {
  Agent as UndiciAgent,
  EnvHttpProxyAgent,
  Pool,
  interceptors,
  setGlobalDispatcher,
  type Dispatcher,
} from "undici";
import { HttpsProxyAgent } from "https-proxy-agent";
import { bridgeForSocks, readyBridgeUrl } from "./bridge.js";
import {
  applyProxyEnvironment,
  bypassEntries,
  bypassedHost,
  configuredProxyValue,
  describeEffectiveProxy,
  isLoopbackHost,
  isSocksProxy,
  proxyForUrl,
  refreshSystemProxy,
  resolveProxy,
  type EffectiveProxy,
  type ProxyResolutionOptions,
  type ProxySource,
  type ResolvedProxy,
} from "./proxy-config.js";

export {
  applyProxyEnvironment,
  configuredProxyValue,
  describeEffectiveProxy,
  isSocksProxy,
  proxyForUrl,
  redactProxy,
  resolveProxy,
  setConfiguredProxy,
} from "./proxy-config.js";
export { bridgeForSocks, closeAllSocksBridges, dialSocks } from "./bridge.js";

// Node 26's fetch reads this symbol; keep the dispatcher it started with so a
// proxy can be uninstalled without leaving fetch without one (it asserts).
const PLATFORM_DISPATCHER = Symbol.for("undici.globalDispatcher.2");
const platformDefaultDispatcher = (globalThis as unknown as Record<symbol, unknown>)[
  PLATFORM_DISPATCHER
];
export {
  parseScutil,
  parseWindows,
  readSystemProxy,
  type SystemProxy,
  type SystemProxyProbe,
} from "./system-proxy.js";

const NO_SYSTEM_PROXY = (): { url: string; http: string; socks: string; bypass: string[] } => ({
  url: "",
  http: "",
  socks: "",
  bypass: [],
});

/** The proxy in force from the last initialization, for WebSockets. */
let resolution: ResolvedProxy = resolveProxy({
  env: process.env,
  platform: process.platform,
  setting: configuredProxyValue(),
  systemProbe: NO_SYSTEM_PROXY,
});
let installed: { close(): Promise<void> } | null = null;
let systemProbeOverride: ProxyResolutionOptions["systemProbe"];

/** The *_PROXY variables that couldn't be parsed, for startup logging. */
function readEnvironment(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  // process.env lookups are case-insensitive on Windows. Read each actual entry once.
  const values = new Map(
    Object.entries(env).map(([name, value]) => [
      platform === "win32" ? name.toLowerCase() : name,
      value,
    ]),
  );
  const ignored: string[] = [];
  function proxy(variable: string): string | undefined {
    const value = values.get(variable);
    if (value === undefined) return undefined;
    if (!value.trim()) return undefined;
    try {
      const url = new URL(value.includes("://") ? value : `http://${value}`);
      if (url.protocol !== "http:" && url.protocol !== "https:")
        throw new Error("Unsupported proxy protocol");
      decodeURIComponent(url.username);
      decodeURIComponent(url.password);
      return url.href;
    } catch {
      ignored.push(variable);
      return undefined;
    }
  }
  proxy("http_proxy");
  proxy("HTTP_PROXY");
  proxy("https_proxy");
  proxy("HTTPS_PROXY");
  proxy("ALL_PROXY");
  proxy("all_proxy");
  return ignored;
}

function bypassList(noProxy: string): string {
  return noProxy.split(/[,\s]+/).includes("*") ? "*" : `${noProxy},localhost,127.0.0.1,[::1],::1`;
}

function proxyClient(origin: URL, options: object) {
  const pool = new Pool(origin, options);
  if (!origin.username && !origin.password) return pool;
  const credentials = `${decodeURIComponent(origin.username)}:${decodeURIComponent(origin.password)}`;
  const authorization = `Basic ${Buffer.from(credentials).toString("base64")}`;
  // This pool only sends CONNECT requests to this proxy, never requests to the origin.
  // undici's URL auth requires both fields; HTTP Basic also permits either field to be empty.
  return pool.compose(
    (dispatch) => (request, handler) =>
      dispatch(
        {
          ...request,
          headers: { ...request.headers, "proxy-authorization": authorization },
        },
        handler,
      ),
  );
}

/**
 * Install once at startup; return ignored variable names for logging without
 * exposing credentials. The proxy follows myna's order: the settings value
 * (from `gateway.json`), then *_PROXY, then the system's proxy.
 */
export function initializeEnvironmentProxy(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  systemProbe?: ProxyResolutionOptions["systemProbe"],
): string[] {
  systemProbeOverride = systemProbe;
  const ignored = readEnvironment(env, platform);
  installProxy({ env, platform, systemProbe });
  return ignored;
}

/**
 * Re-read the proxy in force after the settings changed. Called by the
 * gateway config store, so a proxy edited in Settings › Network reaches
 * requests and new child processes without a restart.
 */
export function refreshProxy(options: ProxyResolutionOptions = {}): void {
  installProxy({
    env: process.env,
    platform: process.platform,
    systemProbe: systemProbeOverride,
    ...options,
  });
}

function installProxy(options: ProxyResolutionOptions): void {
  resolution = resolveProxy({ ...options, setting: configuredProxyValue() });
  if (resolution.url === "") {
    installDispatcher(new UndiciAgent(), false);
    return;
  }
  if (isSocksProxy(resolution.url)) {
    // undici refuses a socks5:// proxy; a bridge on loopback speaks HTTP to it.
    const socksUrl = resolution.url;
    const ready = readyBridgeUrl(socksUrl);
    if (ready !== null) {
      installDispatcher(httpAgentOf({ ...resolution, httpProxy: ready, httpsProxy: ready }));
      return;
    }
    void bridgeForSocks(socksUrl)
      .then((bridge) => {
        if (resolution.url === socksUrl) {
          installDispatcher(
            httpAgentOf({ ...resolution, httpProxy: bridge.url, httpsProxy: bridge.url }),
          );
        }
        return undefined;
      })
      .catch(() => {
        // The bridge couldn't listen; requests take the dispatcher in force.
      });
    installDispatcher(new UndiciAgent(), false);
    return;
  }
  installDispatcher(httpAgentOf(resolution));
  // The system probe runs off the request path; once it lands, install what
  // it found so the next request takes the system's proxy.
  if (resolution.source === "none") {
    void refreshSystemProxy(options.platform).then((changed) => {
      if (changed) {
        installProxy(options);
      }
      return undefined;
    });
  }
}

function httpAgentOf(resolved: ResolvedProxy): EnvHttpProxyAgent {
  return new EnvHttpProxyAgent({
    httpProxy: resolved.httpProxy,
    httpsProxy: resolved.httpsProxy,
    noProxy: resolved.noProxy,
    clientFactory: proxyClient,
  });
}

/**
 * The npm undici dispatcher in front of Node's own fetch hands a compressed
 * body back undecoded, while the platform's own dispatcher decodes it
 * (models.dev, npm, Cloudflare and most JSON hosts answer compressed). The
 * decompress interceptor restores that for every platform-fetch caller, so
 * no call site has to name an encoding. It is undici's experimental
 * interceptor, but it composes with both the plain and the proxy agent and
 * works through Node's own fetch as tested.
 */
function withDecompression(dispatcher: UndiciAgent | EnvHttpProxyAgent): Dispatcher {
  return dispatcher.compose(interceptors.decompress({ skipErrorResponses: false }));
}

/**
 * `routesPlatformFetch` is false when no proxy is in force: the platform
 * fetch already decodes through its own dispatcher, and routing it is only
 * needed so a proxied request goes through the proxy.
 */
function installDispatcher(
  dispatcher: UndiciAgent | EnvHttpProxyAgent,
  routesPlatformFetch = true,
): void {
  const previous = installed;
  installed = null;
  setGlobalDispatcher(dispatcher);
  // Node 26's built-in fetch reads a later global dispatcher symbol than
  // the npm undici this daemon imports (`undici.globalDispatcher.2` vs
  // `.1`). Setting both keeps the daemon's own fetch on the same proxy from
  // Node 22 through 26; npm undici reads `.1`, the platform fetch `.2`.
  const platformGlobal = globalThis as unknown as Record<symbol, unknown>;
  if (routesPlatformFetch) {
    platformGlobal[PLATFORM_DISPATCHER] = withDecompression(dispatcher);
  } else if (platformDefaultDispatcher !== undefined) {
    // The platform installs this symbol non-configurable, so restore the
    // dispatcher Node started with rather than deleting it.
    platformGlobal[PLATFORM_DISPATCHER] = platformDefaultDispatcher;
  }
  if (previous !== null && previous !== dispatcher) {
    void previous.close().catch(() => undefined);
  }
  installed = dispatcher;
}

/**
 * What Settings › Network shows: the proxy in force and what chose it. The
 * system is read only when neither the settings nor the environment names
 * a proxy, as myna's Describe does.
 */
export function currentProxy(): { proxy: string; source: ProxySource } {
  return describeEffectiveProxy({
    env: process.env,
    platform: process.platform,
    systemProbe: systemProbeOverride,
  });
}

/** The proxy in force, for logging and status without credentials. */
export function effectiveProxy(): EffectiveProxy {
  return resolution;
}

/** ws uses Node HTTP agents rather than the fetch dispatcher. */
export function webSocketProxyAgent(address: string): Agent | undefined {
  const url = new URL(address);
  const port = url.port || (url.protocol === "wss:" ? "443" : "80");
  if (
    isLoopbackHost(url.hostname) ||
    bypassedHost(url.hostname, resolution.bypass) ||
    noProxyNamesHost(url.hostname, port)
  ) {
    return undefined;
  }
  if (resolution.url === "") {
    return undefined;
  }
  const proxy = resolution.url;
  if (isSocksProxy(proxy)) {
    const bridged = readyBridgeUrl(proxy);
    return bridged === null ? undefined : new HttpsProxyAgent(bridged);
  }
  return new HttpsProxyAgent(proxy);
}

/** Whether NO_PROXY names this host (a port on an entry must match). */
function noProxyNamesHost(hostname: string, port: string): boolean {
  const host = hostname.toLowerCase();
  for (const raw of bypassEntries(resolution.noProxy)) {
    const entry = raw.toLowerCase();
    if (entry === "*") return true;
    const match = /^(.+):(\d+)$/.exec(entry);
    // Numeric comparison: NO_PROXY may spell the port with a leading zero.
    if (match !== null && Number(match[2]) !== Number(port)) {
      continue;
    }
    const name = (match === null ? entry : match[1]!).replace(/^\*?\./, "");
    if (name !== "" && (host === name || host.endsWith(`.${name}`))) {
      return true;
    }
  }
  return false;
}

/**
 * `env` for a child process Neolix starts, with myna's proxy injected: the
 * settings proxy replaces any *_PROXY, "direct" drops them, and the
 * system's is added only where the environment names none. A SOCKS proxy
 * is bridged when a bridge is already listening, since a CLI that takes
 * http:// proxies only (Bun, undici) refuses socks5://.
 */
export function childProxyEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  options: ProxyResolutionOptions = {},
): NodeJS.ProcessEnv {
  const resolved =
    options.setting === undefined && options.env === undefined && options.systemProbe === undefined
      ? resolution
      : resolveProxy({
          env,
          platform: process.platform,
          systemProbe: systemProbeOverride,
          ...options,
        });
  if (resolved.source !== "settings" && resolved.source !== "system") {
    if (resolved.source !== "off") {
      return env;
    }
    // "direct": drop whatever env names, as myna's withProxy does.
    return applyProxyEnvironment(env, { env, platform: process.platform, setting: "direct" });
  }
  let proxy = resolved.url;
  if (isSocksProxy(proxy)) {
    const bridged = readyBridgeUrl(proxy);
    if (bridged === null) {
      return env;
    }
    proxy = bridged;
  }
  return withProxyVariables(env, proxy, resolved.noProxy);
}

function withProxyVariables(
  env: NodeJS.ProcessEnv,
  proxy: string,
  noProxy: string,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (
      ![
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
        "no_proxy",
      ].includes(name)
    ) {
      out[name] = value;
    }
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

/** Whether a host is on this computer's loopback (myna's loopback check). */
export function isLoopback(name: string): boolean {
  return isLoopbackHost(name);
}

/** NO_PROXY entries as the dispatcher reads them. */
export function proxyBypassList(noProxy: string): string {
  return bypassList(noProxy);
}

/** Re-exported for tests that inspect the parsed environment. */
export function environmentProxy(url: URL): string | undefined {
  return proxyForUrl(url, resolution);
}
