import type { GatewayStrategyInput, GatewayUsageRow } from "@neolix/plugin/server";
import type { GatewayProvider } from "./config.js";

/**
 * Where a plugin-backed provider's request goes and how it is signed. The
 * plugin's loader answers it per attempt: Neolix never holds the sign-in, and
 * the headers it returns are the plugin's to choose.
 */
export interface PluginUpstreamTarget {
  baseUrl: string;
  headers: Record<string, string>;
  /** A body the loader shaped for its vendor; the gateway's otherwise. */
  body?: Record<string, unknown>;
  /** A loader fetch's one-use token: the request goes through the plugin. */
  token?: string;
}

export interface PluginUpstreamProxyResult {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

export interface PluginUpstreamInput {
  pluginId: string;
  providerId: string;
  /** The gateway account's id, which names the plugin's stored sign-in. */
  accountId: string;
  model: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

export interface PluginUpstreamResolver {
  load(input: PluginUpstreamInput): Promise<PluginUpstreamTarget>;
  request(input: {
    pluginId: string;
    providerId: string;
    token: string;
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string;
  }): Promise<PluginUpstreamProxyResult>;
}

/** Gateway traffic hooks a plugin registers (myna's middleware). */
export interface GatewayMiddlewareRequestInput {
  providerId: string;
  protocol: string;
  model: string;
  accountId: string;
  body: Record<string, unknown>;
}

export interface GatewayMiddlewareResponseInput {
  providerId: string;
  model: string;
  accountId: string;
  status: number;
  headers: Record<string, string>;
  body: string | null;
}

export interface GatewayMiddlewareProviderInput {
  providerId: string;
  protocol: string;
  model: string;
  accountId: string | null;
  body: Record<string, unknown>;
}

export interface GatewayMiddlewareAccountInput {
  providerId: string;
  protocol: string;
  model: string;
  accountId: string;
}

export interface GatewayMiddlewareEventInput {
  providerId: string;
  model: string;
  accountId: string;
  event: unknown;
}

export interface GatewayMiddlewareRunner {
  /** Whether any running plugin hooks gateway traffic. */
  active(): boolean;
  /** Whether any running middleware implements `hook` (myna's hook names). */
  hasHook(hook: string): boolean;
  request(input: GatewayMiddlewareRequestInput): Promise<GatewayMiddlewareRequestInput | null>;
  response(input: GatewayMiddlewareResponseInput): Promise<GatewayMiddlewareResponseInput | null>;
  provider(input: GatewayMiddlewareProviderInput): Promise<GatewayMiddlewareProviderInput | null>;
  account(input: GatewayMiddlewareAccountInput): Promise<boolean>;
  event(input: GatewayMiddlewareEventInput): Promise<{ event: unknown } | "drop" | null>;
}

let resolver: PluginUpstreamResolver | null = null;
let middlewareRunner: GatewayMiddlewareRunner | null = null;

/** The daemon's plugin runtime answers loaders while it runs. Returns its release. */
export function setPluginUpstreamResolver(next: PluginUpstreamResolver | null): () => void {
  resolver = next;
  return () => {
    if (resolver === next) resolver = null;
  };
}

/** The daemon's plugin runtime runs gateway middleware. Returns its release. */
export function setGatewayMiddlewareRunner(next: GatewayMiddlewareRunner | null): () => void {
  middlewareRunner = next;
  return () => {
    if (middlewareRunner === next) middlewareRunner = null;
  };
}

/** Gateway usage hooks a plugin registers (myna's onUsage). */
export interface GatewayUsageObserver {
  observe(row: GatewayUsageRow): void;
}

let usageObserver: GatewayUsageObserver | null = null;

/** The daemon's plugin runtime observes gateway usage. Returns its release. */
export function setGatewayUsageObserver(next: GatewayUsageObserver | null): () => void {
  usageObserver = next;
  return () => {
    if (usageObserver === next) usageObserver = null;
  };
}

/** Hands one finished call to the running plugins' usage observers. */
export function observeGatewayUsage(row: GatewayUsageRow): void {
  try {
    usageObserver?.observe(row);
  } catch {
    // Fail open: observation never fails the call that produced it.
  }
}

/** Routing strategies plugins register (myna's `strategies`). */
export interface GatewayRoutingStrategyRunner {
  /** The order a plugin answers, or null when it isn't running or failed. */
  order(name: string, input: GatewayStrategyInput): Promise<unknown[] | null>;
}

let routingStrategyRunner: GatewayRoutingStrategyRunner | null = null;

/** The daemon's plugin runtime orders candidates. Returns its release. */
export function setGatewayRoutingStrategyRunner(
  next: GatewayRoutingStrategyRunner | null,
): () => void {
  routingStrategyRunner = next;
  return () => {
    if (routingStrategyRunner === next) routingStrategyRunner = null;
  };
}

/** One plugin strategy's order, or null to keep the listed order. */
export async function runGatewayRoutingStrategy(
  name: string,
  input: GatewayStrategyInput,
): Promise<unknown[] | null> {
  if (routingStrategyRunner === null) return null;
  try {
    return await routingStrategyRunner.order(name, input);
  } catch {
    return null;
  }
}

/** Whether a running plugin hooks gateway traffic. */
export function hasGatewayMiddlewares(): boolean {
  return middlewareRunner !== null && middlewareRunner.active();
}

/** Whether a running middleware implements `hook` ("event", "provider", …). */
export function hasGatewayMiddlewareHook(hook: string): boolean {
  return middlewareRunner !== null && middlewareRunner.hasHook(hook);
}

/** The request after every plugin middleware, or null when none changed it. */
export async function runGatewayMiddlewareRequest(
  input: GatewayMiddlewareRequestInput,
): Promise<GatewayMiddlewareRequestInput | null> {
  if (middlewareRunner === null) return null;
  try {
    return await middlewareRunner.request(input);
  } catch {
    // Fail open: a middleware that can't run leaves the traffic as it is.
    return null;
  }
}

/** The answer after every plugin middleware, or null when none changed it. */
export async function runGatewayMiddlewareResponse(
  input: GatewayMiddlewareResponseInput,
): Promise<GatewayMiddlewareResponseInput | null> {
  if (middlewareRunner === null) return null;
  try {
    return await middlewareRunner.response(input);
  } catch {
    return null;
  }
}

/** The body after every provider hook, or null when none changed it. */
export async function runGatewayMiddlewareProvider(
  input: GatewayMiddlewareProviderInput,
): Promise<GatewayMiddlewareProviderInput | null> {
  if (middlewareRunner === null) return null;
  try {
    return await middlewareRunner.provider(input);
  } catch {
    return null;
  }
}

/** Whether a hook passes the account over; a failing hook passes nothing over. */
export async function runGatewayMiddlewareAccount(
  input: GatewayMiddlewareAccountInput,
): Promise<boolean> {
  if (middlewareRunner === null) return false;
  try {
    return await middlewareRunner.account(input);
  } catch {
    return false;
  }
}

/** One event after every event hook: a replacement, "drop", or null when kept. */
export async function runGatewayMiddlewareEvent(
  input: GatewayMiddlewareEventInput,
): Promise<{ event: unknown } | "drop" | null> {
  if (middlewareRunner === null) return null;
  try {
    return await middlewareRunner.event(input);
  } catch {
    return null;
  }
}

/** A provider configured to be served by a plugin, or null for an ordinary one. */
export function pluginRefOf(provider: GatewayProvider): {
  pluginId: string;
  providerId: string;
} | null {
  return provider.plugin ?? null;
}

/**
 * The loader's answer for this attempt, or null for a provider that isn't a
 * plugin's. A plugin provider without a running resolver is skipped, not
 * failed: the plugin may be disabled or still loading.
 */
export async function preparePluginUpstream(input: {
  provider: GatewayProvider;
  accountId: string;
  model: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}): Promise<PluginUpstreamTarget | null | { skip: string }> {
  const ref = pluginRefOf(input.provider);
  if (ref === null) return null;
  if (resolver === null) {
    return { skip: `plugin upstream ${ref.pluginId}/${ref.providerId} is not available` };
  }
  return resolver.load({
    pluginId: ref.pluginId,
    providerId: ref.providerId,
    accountId: input.accountId,
    model: input.model,
    body: input.body,
    headers: input.headers,
  });
}

/** Sends one request through the plugin's own fetch, or says to skip it. */
export async function proxyPluginUpstream(input: {
  pluginId: string;
  providerId: string;
  token: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}): Promise<PluginUpstreamProxyResult | { skip: string }> {
  if (resolver === null) {
    return { skip: `plugin upstream ${input.pluginId}/${input.providerId} is not available` };
  }
  return resolver.request(input);
}
