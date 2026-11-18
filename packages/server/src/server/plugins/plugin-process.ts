import { PluginAgentTools } from "./agent-tools.js";
import { PluginHookHandlers } from "./lifecycle/index.js";
import { evaluateBundle } from "./bundle-evaluator.js";
import {
  PluginProcessRequestSchema,
  type PluginProcessMessage,
  type PluginProcessRequest,
} from "./plugin-process-protocol.js";
import type { UsageSourceRegistration } from "@neolix/plugin/server/usage";
import type { SearchApiRegistration } from "@neolix/plugin/server/search";
import type {
  SettingsDefinition,
  PluginRpcContract,
  PluginSubscriptionContract,
} from "@neolix/plugin";
import type {
  SubscriptionFetchInit,
  SubscriptionProviderMetadata,
  SubscriptionProviderRegistration,
  SubscriptionSignInFlow,
  SubscriptionSignInOutcome,
} from "@neolix/plugin/server/subscription";
import { randomUUID } from "node:crypto";
import type {
  GatewayAgentIntegrationRegistration,
  GatewayMiddlewareEventChange,
  GatewayMiddlewareRegistration,
  GatewayRoutingStrategyRegistration,
  GatewayStrategySeat,
  GatewayUsageObserverRegistration,
  GatewayUsageRow,
  PluginHandlerContext,
  PluginServerContext,
  PluginServerContribution,
} from "@neolix/plugin/server";
import { assertPluginWireValue } from "@neolix/protocol/binary-frames/index";
import {
  PluginSubscriptionHandlers,
  type PluginSubscriptionHandler,
} from "./subscription-handlers.js";
import { fileURLToPath } from "node:url";
import type { ZodType } from "zod";
import {
  ProviderEventSchema,
  type ProviderConnection,
  type ProviderRegistration,
  ProviderStatusSchema,
} from "@neolix/plugin/server/provider";
import { createNeolixApi, type NeolixApi } from "@neolix/client";
import { DaemonClient } from "@neolix/client/internal/daemon-client";
import { createPluginDaemonTransportFactory } from "./daemon-transport.js";
import { createPluginClientId } from "./plugin-session-identity.js";

import { PluginSettingsStore } from "./settings/index.js";
import { PluginAccountsStore } from "./accounts/index.js";
import { PluginAccountsError, type PluginAccounts } from "@neolix/plugin/server/accounts";
import { readPluginProviderIcon } from "./provider-icon.js";
import { initializeEnvironmentProxy } from "../network/index.js";
/**
 * A cause's code and message, without the outer message. Node's fetch reports a DNS or
 * connection failure as `TypeError("fetch failed", { cause })`, so the cause is the only
 * place naming the host and failure code.
 */
function causeText(cause: unknown): string {
  if (!(cause instanceof Error)) return String(cause);
  const code = (cause as { code?: unknown }).code;
  const message = cause.message.trim();
  if (typeof code === "string" && code.length > 0) {
    if (message.length === 0) return code;
    return message.includes(code) ? message : `${code} ${message}`;
  }
  return message;
}

/** The cause chain's codes and messages, outermost first. */
function describeErrorCause(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = (error as { cause?: unknown }).cause;
  while (current !== null && current !== undefined && !seen.has(current)) {
    seen.add(current);
    const text = causeText(current);
    if (text.length > 0) parts.push(text);
    current = typeof current === "object" ? (current as { cause?: unknown }).cause : undefined;
  }
  return parts.length === 0 ? undefined : parts.join(": ");
}

/** The error's own message first, then its cause chain, for the daemon's message text. */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = describeErrorCause(error);
  return cause === undefined ? error.message : `${error.message}: ${cause}`;
}

/** The cross-process error payload: a message that keeps its prefix, plus the cause chain. */
function errorPayload(error: unknown): { error: string; cause?: string } {
  const cause = describeErrorCause(error);
  return cause === undefined
    ? { error: describeError(error) }
    : { error: describeError(error), cause };
}

/** The string entries of a headers object a plugin gave back. */
function stringHeaders(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (typeof entry === "string") out[name] = entry;
  }
  return out;
}

function requireAccounts(store: PluginAccountsStore | null): PluginAccountsStore {
  if (store === null) throw new PluginAccountsError("Plugin accounts storage is unavailable");
  return store;
}

function isSignInFlow(outcome: SubscriptionSignInOutcome): outcome is SubscriptionSignInFlow {
  return (
    typeof outcome === "object" &&
    outcome !== null &&
    typeof (outcome as { complete?: unknown }).complete === "function"
  );
}

const SUBSCRIPTION_PROTOCOLS = ["anthropic", "openai", "openai-responses", "gemini"] as const;

export interface PluginWorkerChannel {
  send(message: PluginProcessMessage, callback?: () => void): void;
  onMessage(handler: (message: PluginProcessRequest) => void): () => void;
  disconnect(): void;
}

export function createPluginWorker(options: {
  channel: PluginWorkerChannel;
  contribute: PluginServerContribution;
}): { shutdown(): Promise<void> } {
  const { channel, contribute } = options;
  let settingsStore: PluginSettingsStore | null = null;
  let accountsStore: PluginAccountsStore | null = null;
  function registerSettings<Schema extends ZodType>(definition: SettingsDefinition<Schema>) {
    if (!settingsStore) throw new Error("Plugin settings storage is unavailable");
    const handlers = settingsStore.register(definition);
    register(handlers.read.contract, handlers.read.handle);
    register(handlers.write.contract, (input) =>
      handlers.write.handle(handlers.write.contract.input.parse(input)),
    );
    register(handlers.reset.contract, (input) =>
      handlers.reset.handle(handlers.reset.contract.input.parse(input)),
    );
    return handlers.settings;
  }

  type RpcHandler = (input: unknown, context: PluginHandlerContext) => unknown | Promise<unknown>;

  interface RegisteredRpc {
    contract: PluginRpcContract;
    handler: RpcHandler;
  }

  const agentTools = new PluginAgentTools();
  const hooks = new PluginHookHandlers(() => {
    send({ type: "hooks.changed", hooks: hooks.catalog() });
  }, agentTools);
  const handlers = new Map<string, RegisteredRpc>();
  const subscriptions = new PluginSubscriptionHandlers({ send, sendAndWait });
  const providers = new Map<string, ProviderRegistration>();
  const usageSources = new Map<string, UsageSourceRegistration>();
  const searchApis = new Map<string, SearchApiRegistration>();
  const subscriptionProviders = new Map<string, SubscriptionProviderRegistration>();
  const gatewayMiddlewares: GatewayMiddlewareRegistration[] = [];
  const gatewayUsageObservers: GatewayUsageObserverRegistration[] = [];
  const routingStrategies: GatewayRoutingStrategyRegistration[] = [];
  const agentIntegrations: GatewayAgentIntegrationRegistration[] = [];
  /**
   * myna's `ctx.state`: one object per middleware per client request, shared by
   * that request's hooks. `requestKey` is the daemon's client-call id; an entry
   * is released when the request's `onResponse` runs, and expires otherwise so
   * a streamed request that never reports a response cannot leak.
   */
  const GATEWAY_STATE_TTL_MS = 15 * 60 * 1000;
  const gatewayStates = new Map<string, { state: Record<string, unknown>; at: number }>();

  function gatewayState(
    requestKey: string | undefined,
    middlewareId: string,
  ): Record<string, unknown> | undefined {
    if (requestKey === undefined || requestKey === "") return undefined;
    const now = Date.now();
    // debt: each hook sweeps the whole map; move to a timer once many requests
    // are live at once.
    for (const [key, entry] of gatewayStates) {
      if (now - entry.at > GATEWAY_STATE_TTL_MS) gatewayStates.delete(key);
    }
    const key = `${requestKey}\u0000${middlewareId}`;
    let entry = gatewayStates.get(key);
    if (entry === undefined) {
      entry = { state: {}, at: now };
      gatewayStates.set(key, entry);
    } else {
      entry.at = now;
    }
    return entry.state;
  }

  function releaseGatewayState(requestKey: string | undefined): void {
    if (requestKey === undefined || requestKey === "") return;
    const prefix = `${requestKey}\u0000`;
    for (const key of gatewayStates.keys()) {
      if (key.startsWith(prefix)) gatewayStates.delete(key);
    }
  }
  /** A loader's own fetch, kept for the one request that names its token. */
  const subscriptionRequests: Map<
    string,
    {
      providerId: string;
      fetch: (input: string, init: SubscriptionFetchInit) => Promise<Response>;
      at: number;
    }
  > = new Map();
  /** A device flow the user is finishing, by the token the host polls with. */
  const signInFlows = new Map<
    string,
    {
      providerId: string;
      url?: string;
      instructions?: string;
      done: Promise<Record<string, unknown>>;
      auth?: Record<string, unknown>;
      error?: Error;
      at: number;
    }
  >();
  const providerConnections = new Map<
    string,
    { connection: ProviderConnection; unsubscribe: () => void; closing?: Promise<void> }
  >();
  const pendingProviderConnections = new Map<string, { tombstoned: boolean }>();
  let cleanup: (() => void | Promise<void>) | null = null;
  let daemonClient: DaemonClient | null = null;
  let neolix: NeolixApi | null = null;
  let stopping = false;
  function send(message: PluginProcessMessage): void {
    channel.send(message);
  }

  function sendAndWait(message: PluginProcessMessage): Promise<void> {
    return new Promise((resolve) => {
      channel.send(message, () => resolve());
    });
  }

  function jsonTransportValue<Value>(value: Value): Value {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("Provider value is not JSON-serializable");
    return JSON.parse(encoded) as Value;
  }

  function validateMethod(method: string): string {
    const normalized = method.trim();
    if (!/^[a-z][a-z0-9._-]*$/.test(normalized)) {
      throw new Error(`Invalid plugin RPC method: ${method}`);
    }
    if (handlers.has(normalized) || subscriptions.has(normalized)) {
      throw new Error(`Duplicate plugin RPC method: ${normalized}`);
    }
    return normalized;
  }

  function registerSubscription(
    contract: PluginSubscriptionContract,
    handler: PluginSubscriptionHandler,
  ): void {
    if (typeof handler !== "function") {
      throw new Error(`Plugin subscription ${contract.name} must provide a handler`);
    }
    const method = validateMethod(contract.name);
    subscriptions.register({ ...contract, name: method }, handler);
  }

  // One name serves either an RPC or a subscription; the contract says which.
  const handle = ((
    contract: PluginRpcContract | PluginSubscriptionContract,
    handler: (input: unknown, context: never) => unknown,
  ) => {
    if ("event" in contract) {
      // The subscription handlers parse the input once and pass the result here.
      registerSubscription(contract, handler as PluginSubscriptionHandler);
      return;
    }
    register(contract, (input, context) => handler(input, context as never));
  }) as PluginServerContext["handle"];

  function register(contract: PluginRpcContract, handler: RpcHandler): void {
    if (typeof handler !== "function") {
      throw new Error(`Plugin RPC ${contract.name} must provide a handler`);
    }
    const method = validateMethod(contract.name);
    handlers.set(method, { contract: { ...contract, name: method }, handler });
  }

  function registerProvider(provider: ProviderRegistration): void {
    const id = provider.id.trim();
    if (!/^[a-z][a-z0-9._-]*$/.test(id)) {
      throw new Error(`Invalid plugin provider ID: ${provider.id}`);
    }
    if (!provider.label.trim()) throw new Error(`Plugin provider ${id} requires a label`);
    if (typeof provider.connect !== "function") {
      throw new Error(`Plugin provider ${id} must implement connect()`);
    }
    if (
      provider.getCatalogCacheKey !== undefined &&
      typeof provider.getCatalogCacheKey !== "function"
    ) {
      throw new Error(`Invalid catalogue key callback for plugin provider ${id}`);
    }
    if (provider.status !== undefined && typeof provider.status !== "function")
      throw new Error(`Invalid status callback for plugin provider ${id}`);
    if (
      provider.command !== undefined &&
      (provider.command.length === 0 ||
        provider.command.some((part) => typeof part !== "string" || !part.trim()))
    )
      throw new Error(`Invalid command for plugin provider ${id}`);
    if (providers.has(id)) throw new Error(`Duplicate plugin provider ID: ${id}`);
    providers.set(id, { ...provider, id });
  }

  function registerUsageSource(source: UsageSourceRegistration): void {
    const id = source.id.trim();
    if (
      !/^[a-z][a-z0-9._-]*$/.test(id) ||
      !source.label.trim() ||
      typeof source.fetch !== "function" ||
      typeof source.discover !== "function" ||
      !source.input ||
      typeof source.input.parseAsync !== "function"
    ) {
      throw new Error(`Invalid usage source: ${source.id}`);
    }
    if (usageSources.has(id)) throw new Error(`Duplicate usage source: ${id}`);
    usageSources.set(id, { ...source, id });
  }

  function registerSearchApi(search: SearchApiRegistration): void {
    const id = search.id.trim();
    if (
      !/^[a-z0-9-]{1,32}$/.test(id) ||
      !search.name.trim() ||
      typeof search.execute !== "function"
    ) {
      throw new Error(`Invalid search API: ${search.id}`);
    }
    if (searchApis.has(id)) throw new Error(`Duplicate search API: ${id}`);
    searchApis.set(id, { ...search, id });
  }

  function registerSubscriptionProvider(provider: SubscriptionProviderRegistration): void {
    const id = provider.id.trim();
    if (
      !/^[a-z][a-z0-9._-]*$/.test(id) ||
      !provider.label.trim() ||
      !SUBSCRIPTION_PROTOCOLS.includes(provider.protocol) ||
      !Array.isArray(provider.methods) ||
      provider.methods.length === 0 ||
      provider.methods.some(
        (method) =>
          (method.type !== "oauth" && method.type !== "api") ||
          !method.label.trim() ||
          (method.authorize !== undefined && typeof method.authorize !== "function"),
      ) ||
      typeof provider.loader !== "function" ||
      typeof provider.models !== "function"
    ) {
      throw new Error(`Invalid subscription provider: ${provider.id}`);
    }
    if (subscriptionProviders.has(id)) {
      throw new Error(`Duplicate subscription provider: ${id}`);
    }
    subscriptionProviders.set(id, { ...provider, id });
  }

  function subscriptionProviderMetadata(
    provider: SubscriptionProviderRegistration,
  ): SubscriptionProviderMetadata {
    return {
      id: provider.id,
      label: provider.label,
      protocol: provider.protocol,
      methods: provider.methods.map((method) => ({
        type: method.type,
        label: method.label,
        ...(method.prompts === undefined ? {} : { prompts: method.prompts }),
        ...(method.apiKey === undefined ? {} : { apiKey: method.apiKey }),
      })),
      ...(provider.options === undefined ? {} : { options: provider.options }),
      ...(provider.checkin === undefined ? {} : { checkin: true as const }),
    };
  }

  function providerMetadata(provider: ProviderRegistration) {
    return {
      id: provider.id,
      label: provider.label,
      description: provider.description,
      iconPath: provider.icon,
      requiresConfiguration: provider.requiresConfiguration,
      supportsAccountDerivation: provider.supportsAccountDerivation,
      hasCatalogCacheKey: provider.getCatalogCacheKey !== undefined,
      hasStatus: provider.status !== undefined,
      command: provider.command,
    };
  }

  async function connectProvider(
    message: Extract<PluginProcessRequest, { type: "provider.connect" }>,
  ): Promise<void> {
    if (stopping) throw new Error("Plugin is stopping");
    const provider = providers.get(message.providerId);
    if (!provider) throw new Error(`Unknown plugin provider: ${message.providerId}`);
    if (
      providerConnections.has(message.connectionId) ||
      pendingProviderConnections.has(message.connectionId)
    ) {
      throw new Error(`Duplicate provider connection: ${message.connectionId}`);
    }
    const pending = { tombstoned: false };
    pendingProviderConnections.set(message.connectionId, pending);
    let connection: ProviderConnection;
    try {
      connection = await provider.connect(message.request);
    } catch (error) {
      pendingProviderConnections.delete(message.connectionId);
      if (pending.tombstoned || stopping) return;
      throw error;
    }
    pendingProviderConnections.delete(message.connectionId);
    if (pending.tombstoned || stopping) {
      await connection.close().catch(() => undefined);
      return;
    }
    let unsubscribe = () => {};
    unsubscribe = connection.onEvent((event) => {
      try {
        send({
          type: "provider.event",
          connectionId: message.connectionId,
          event: ProviderEventSchema.parse(jsonTransportValue(event)),
        });
      } catch (error) {
        providerConnections.delete(message.connectionId);
        unsubscribe();
        void connection.close().catch(() => undefined);
        send({
          type: "provider.closed",
          connectionId: message.connectionId,
          error: describeError(error),
        });
      }
    });
    providerConnections.set(message.connectionId, { connection, unsubscribe });
    send({
      type: "provider.connected",
      connectionId: message.connectionId,
      version: connection.version,
      capabilities: connection.capabilities,
    });
  }

  async function sendProviderInput(
    message: Extract<PluginProcessRequest, { type: "provider.send" }>,
  ): Promise<void> {
    if (stopping) throw new Error("Plugin is stopping");
    const current = providerConnections.get(message.connectionId);
    if (!current) throw new Error(`Unknown provider connection: ${message.connectionId}`);
    if (current.closing) throw new Error("Provider connection is closing");
    await current.connection.send(message.input);
    send({
      type: "provider.accepted",
      connectionId: message.connectionId,
      acceptanceId: message.acceptanceId,
    });
  }

  // The connection stays registered until its close has reported, so shutdown
  // waits for a close already in flight instead of disconnecting underneath it.
  async function closeProviderConnection(connectionId: string): Promise<void> {
    const current = providerConnections.get(connectionId);
    if (!current) return;
    if (current.closing) return current.closing;
    const closing = (async () => {
      current.unsubscribe();
      try {
        await current.connection.close();
        send({ type: "provider.closed", connectionId });
      } catch (error) {
        send({ type: "provider.closed", connectionId, error: describeError(error) });
      } finally {
        providerConnections.delete(connectionId);
      }
    })();
    current.closing = closing;
    return closing;
  }

  const transportFactory = createPluginDaemonTransportFactory({
    send,
    onMessage(handler) {
      return channel.onMessage(handler);
    },
  });

  async function initialize(message: Extract<PluginProcessRequest, { type: "initialize" }>) {
    daemonClient = new DaemonClient({
      url: `ipc://plugin/${encodeURIComponent(message.pluginId)}`,
      clientId: createPluginClientId(message.pluginId),
      clientType: "cli",
      appVersion: message.appVersion,
      // The runtime re-attaches a session when the daemon drops this socket.
      reconnect: { enabled: true },
      transportFactory,
    });
    neolix = createNeolixApi(daemonClient);
    await daemonClient.connect();
    settingsStore = message.settingsDirectory
      ? new PluginSettingsStore(message.settingsDirectory, (settingsId) =>
          send({ type: "settings.changed", settingsId }),
        )
      : null;
    const store = message.settingsDirectory
      ? new PluginAccountsStore(message.settingsDirectory)
      : null;
    accountsStore = store;
    const accounts: PluginAccounts = {
      list: () => requireAccounts(accountsStore).list(),
      read: (id) => requireAccounts(accountsStore).read(id),
      write: (id, auth) => requireAccounts(accountsStore).write(id, auth),
      remove: (id) => requireAccounts(accountsStore).remove(id),
    };
    // A contribution may await work before returning its cleanup (an adapter that
    // loads a myna package's export on registration does).
    const contributedCleanup = await contribute({
      handle,
      registerProvider,
      registerUsageSource,
      registerSearchApi,
      registerSubscriptionProvider,
      registerGatewayMiddleware: (middleware) => {
        gatewayMiddlewares.push(middleware);
      },
      registerGatewayUsageObserver: (observer) => {
        gatewayUsageObservers.push(observer);
      },
      registerRoutingStrategy: (strategy) => {
        routingStrategies.push(strategy);
      },
      registerAgentIntegration: (integration) => {
        agentIntegrations.push(integration);
      },
      registerSettings,
      accounts,
      addHook: hooks.addHook,
      on: hooks.on,
      before: hooks.before,
    });
    if (typeof contributedCleanup !== "function") {
      throw new Error("Plugin contribution must return a cleanup function");
    }
    cleanup = contributedCleanup;
    const usageSourceMetadata = await Promise.all(
      [...usageSources.values()]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map(async (source) => ({
          id: source.id,
          label: source.label,
          icon: source.icon
            ? await readPluginProviderIcon(message.pluginDirectory, source.icon)
            : undefined,
        })),
    );
    send({
      type: "ready",
      methods: [...handlers.keys()].sort(),
      subscriptions: subscriptions.catalog(),
      hooks: hooks.catalog(),
      // Settings descriptors let a non-React-Native host render a form without the client bundle.
      settings: settingsStore?.catalog() ?? [],
      providers: [...providers.values()]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map(providerMetadata),
      usageSources: usageSourceMetadata,
      subscriptionProviders: [...subscriptionProviders.values()]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map(subscriptionProviderMetadata),
      ...(gatewayMiddlewares.length === 0
        ? {}
        : {
            gatewayMiddlewares: gatewayMiddlewares.map((middleware) => middleware.id),
            gatewayMiddlewareHooks: gatewayMiddlewares.map((middleware) => ({
              id: middleware.id,
              hooks: ["onRequest", "onProvider", "onAccount", "onResponse", "onEvent", "onHeaders"]
                .filter(
                  (hook) =>
                    typeof (middleware as unknown as Record<string, unknown>)[hook] === "function",
                )
                .map((hook) => hook.slice(2).toLowerCase()),
            })),
          }),
      ...(gatewayUsageObservers.length === 0
        ? {}
        : { gatewayUsageObservers: gatewayUsageObservers.map((observer) => observer.id) }),
      ...(routingStrategies.length === 0
        ? {}
        : { routingStrategies: routingStrategies.map((strategy) => strategy.id) }),
      ...(agentIntegrations.length === 0
        ? {}
        : {
            agentIntegrations: agentIntegrations.map((integration) => ({
              id: integration.id,
              label: integration.label,
              config: integration.config,
              ...(integration.format === undefined ? {} : { format: integration.format }),
              ...(integration.model === undefined ? {} : { model: integration.model }),
            })),
          }),
      searchApis: [...searchApis.values()]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((search) => ({
          id: search.id,
          name: search.name,
          keysURL: search.keysURL,
          keyOptional: search.keyOptional,
          needURL: search.needURL,
        })),
    });
  }

  async function shutdown(): Promise<void> {
    if (stopping) return;
    stopping = true;
    const releaseApi = neolix
      ?.dispose()
      .catch((error) => console.error("Plugin API cleanup failed", error));
    hooks.close();
    agentTools.close();
    gatewayStates.clear();
    subscriptions.releaseAll();
    for (const pending of pendingProviderConnections.values()) pending.tombstoned = true;
    const currentCleanup = cleanup;
    cleanup = null;
    try {
      await currentCleanup?.();
    } catch (error) {
      console.error("Plugin cleanup failed", error);
    }
    await Promise.all([...providerConnections.keys()].map(closeProviderConnection));
    await releaseApi;
    await daemonClient?.close().catch(() => undefined);
    await sendAndWait({ type: "neolix_close" });
    daemonClient = null;
    neolix = null;
    channel.disconnect();
  }

  function handleUsageRequest(
    message: Extract<PluginProcessRequest, { type: "usage.fetch" | "usage.discover" }>,
  ): void {
    void (async () => {
      const source = usageSources.get(message.sourceId);
      if (!source) throw new Error(`Unknown usage source: ${message.sourceId}`);
      if (message.type === "usage.discover")
        return jsonTransportValue(await source.discover(message.scope));
      const input = await source.input.parseAsync(message.input);
      return jsonTransportValue(await source.fetch(input));
    })().then(
      (output) => send({ type: "result", requestId: message.requestId, output }),
      (error) => send({ type: "error", requestId: message.requestId, ...errorPayload(error) }),
    );
  }

  /** The messages that answer on their own, before a provider's own. */
  function handleSideMessage(message: PluginProcessRequest): boolean {
    if (stopping) {
      rejectWhileStopping(message);
      return true;
    }
    if (handleToolMessage(message)) return true;
    if (message.type === "usage.fetch" || message.type === "usage.discover") {
      handleUsageRequest(message);
      return true;
    }
    if (message.type === "search.execute") {
      handleSearchRequest(message);
      return true;
    }
    if (isSubscriptionRequest(message)) {
      handleSubscriptionRequest(message);
      return true;
    }
    return false;
  }

  function handleProviderStatusRequest(
    message: Extract<PluginProcessRequest, { type: "provider.status" }>,
  ): void {
    void (async () => {
      const provider = providers.get(message.providerId);
      if (!provider || !provider.status)
        throw new Error(`Provider has no status capability: ${message.providerId}`);
      const output = ProviderStatusSchema.parse(await provider.status(message.request));
      send({ type: "result", requestId: message.requestId, output });
    })().catch((error) =>
      send({ type: "error", requestId: message.requestId, ...errorPayload(error) }),
    );
  }

  function handleCatalogKeyRequest(
    message: Extract<PluginProcessRequest, { type: "provider.catalog_key" }>,
  ): void {
    void (async () => {
      const provider = providers.get(message.providerId);
      if (!provider) throw new Error(`Unknown provider: ${message.providerId}`);
      const output = await provider.getCatalogCacheKey?.(message.options);
      if (output !== undefined && typeof output !== "string")
        throw new Error("Invalid catalogue key");
      send({ type: "result", requestId: message.requestId, output });
    })().catch((error) =>
      send({ type: "error", requestId: message.requestId, ...errorPayload(error) }),
    );
  }

  type SubscriptionRequest = Extract<
    PluginProcessRequest,
    {
      type:
        | "subscription.models"
        | "subscription.load"
        | "subscription.usage"
        | "subscription.checkin"
        | "subscription.refresh"
        | "subscription.sign_in"
        | "subscription.sign_in.poll"
        | "subscription.request";
    }
  >;

  function isSubscriptionRequest(message: PluginProcessRequest): message is SubscriptionRequest {
    return message.type.startsWith("subscription.");
  }

  type SignInRequest = Extract<SubscriptionRequest, { type: "subscription.sign_in" }>;
  type SignInPollRequest = Extract<SubscriptionRequest, { type: "subscription.sign_in.poll" }>;

  /**
   * Keeps a sign-in as myna does: beside the provider's own field, a result
   * that names another provider opens an account of that one
   * (`internal/plugin/host.js`, `save`/`freshKey`).
   */
  async function saveSignedIn(
    auth: Record<string, unknown>,
    fallbackAccountId: string,
  ): Promise<Record<string, unknown>> {
    const stored = { ...auth };
    const provider = stored.provider;
    delete stored.provider;
    const accounts = requireAccounts(accountsStore);
    let accountId = fallbackAccountId;
    if (
      typeof provider === "string" &&
      provider !== "" &&
      provider !== fallbackAccountId.split("#")[0]
    ) {
      const known = await accounts.list();
      accountId = known.includes(provider)
        ? `${provider}#${Math.random().toString(36).slice(2, 8)}`
        : provider;
    }
    await accounts.write(accountId, stored);
    return stored;
  }

  async function beginSubscriptionSignIn(
    message: SignInRequest,
    provider: SubscriptionProviderRegistration,
  ): Promise<unknown> {
    const method = provider.methods[message.method];
    if (!method) throw new Error(`Unknown sign-in method: ${message.method}`);
    if (!method.authorize) throw new Error(`Sign-in method ${message.method} has no authorize`);
    const outcome = await method.authorize(message.inputs);
    if (!isSignInFlow(outcome)) {
      // The sign-in is kept before it is reported, so the account the
      // caller is told about is one the plugin can serve.
      const stored = await saveSignedIn(outcome, message.accountId);
      return { status: "signed_in", auth: jsonTransportValue(stored) };
    }
    const now = Date.now();
    for (const [token, flow] of signInFlows) {
      if (now - flow.at > 600_000) signInFlows.delete(token);
    }
    const token = randomUUID();
    const entry: {
      providerId: string;
      url?: string;
      instructions?: string;
      done: Promise<Record<string, unknown>>;
      auth?: Record<string, unknown>;
      error?: Error;
      at: number;
    } = {
      providerId: provider.id,
      ...(outcome.url === undefined ? {} : { url: outcome.url }),
      ...(outcome.instructions === undefined ? {} : { instructions: outcome.instructions }),
      done: Promise.resolve({}),
      at: now,
    };
    entry.done = Promise.resolve()
      .then(() => outcome.complete())
      .then(async (auth) => {
        const stored = await saveSignedIn(auth, message.accountId);
        entry.auth = stored;
        return stored;
      })
      .catch((error) => {
        entry.error = error instanceof Error ? error : new Error(String(error));
        throw entry.error;
      });
    void entry.done.catch(() => undefined);
    signInFlows.set(token, entry);
    return {
      status: "pending",
      token,
      ...(entry.url === undefined ? {} : { url: entry.url }),
      ...(entry.instructions === undefined ? {} : { instructions: entry.instructions }),
    };
  }

  async function pollSubscriptionSignIn(
    message: SignInPollRequest,
    provider: SubscriptionProviderRegistration,
  ): Promise<unknown> {
    const entry = signInFlows.get(message.token);
    if (!entry || entry.providerId !== provider.id) {
      throw new Error(`Unknown sign-in flow: ${message.token}`);
    }
    if (entry.auth === undefined && entry.error === undefined) {
      await Promise.race([
        entry.done.catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 10_000)),
      ]);
    }
    if (entry.error !== undefined) {
      signInFlows.delete(message.token);
      throw entry.error;
    }
    if (entry.auth === undefined) return { status: "pending" };
    signInFlows.delete(message.token);
    return { status: "signed_in", auth: entry.auth };
  }

  function handleSubscriptionRequest(message: SubscriptionRequest): void {
    void (async () => {
      const provider = subscriptionProviders.get(message.providerId);
      if (!provider) throw new Error(`Unknown subscription provider: ${message.providerId}`);
      switch (message.type) {
        case "subscription.models":
          return jsonTransportValue(await provider.models({ accountId: message.accountId }));
        case "subscription.load": {
          const loaded = await provider.loader(message.input);
          if (typeof loaded.fetch !== "function") {
            return jsonTransportValue(loaded);
          }
          // The plugin's fetch stays here; the gateway gets a token for one
          // request through it.
          const now = Date.now();
          for (const [token, entry] of subscriptionRequests) {
            if (now - entry.at > 60_000) subscriptionRequests.delete(token);
          }
          const token = randomUUID();
          const { fetch, ...rest } = loaded;
          subscriptionRequests.set(token, {
            providerId: provider.id,
            fetch,
            at: now,
          });
          return jsonTransportValue({ ...rest, hasFetch: true, token });
        }
        case "subscription.request": {
          const entry = subscriptionRequests.get(message.token);
          subscriptionRequests.delete(message.token);
          if (!entry || entry.providerId !== provider.id) {
            throw new Error(`Unknown subscription request: ${message.token}`);
          }
          const response = await entry.fetch(message.url, {
            method: message.method,
            headers: message.headers,
            body: message.body,
          });
          const bytes = Buffer.from(await response.arrayBuffer());
          return {
            status: response.status,
            headers: Object.fromEntries(response.headers),
            body: bytes.toString("base64"),
          };
        }
        case "subscription.usage":
          if (!provider.usage) throw new Error(`No usage capability: ${provider.id}`);
          return jsonTransportValue(await provider.usage({ accountId: message.accountId }));
        case "subscription.checkin":
          if (!provider.checkin) throw new Error(`No check-in capability: ${provider.id}`);
          return jsonTransportValue(await provider.checkin({ accountId: message.accountId }));
        case "subscription.refresh":
          if (!provider.refresh) throw new Error(`No refresh capability: ${provider.id}`);
          await provider.refresh({ accountId: message.accountId });
          return null;
        case "subscription.sign_in":
          return beginSubscriptionSignIn(message, provider);
        case "subscription.sign_in.poll":
          return pollSubscriptionSignIn(message, provider);
      }
    })().then(
      (output) => send({ type: "result", requestId: message.requestId, output }),
      (error) => send({ type: "error", requestId: message.requestId, ...errorPayload(error) }),
    );
  }

  function handleSearchRequest(
    message: Extract<PluginProcessRequest, { type: "search.execute" }>,
  ): void {
    void (async () => {
      const search = searchApis.get(message.searchId);
      if (!search) throw new Error(`Unknown search API: ${message.searchId}`);
      const pages = await search.execute({
        query: message.query,
        key: message.key,
        url: message.url,
      });
      return jsonTransportValue(pages);
    })().then(
      (output) => send({ type: "result", requestId: message.requestId, output }),
      (error) => send({ type: "error", requestId: message.requestId, ...errorPayload(error) }),
    );
  }

  function rejectWhileStopping(message: PluginProcessRequest): void {
    if (
      message.type === "provider.status" ||
      message.type === "provider.catalog_key" ||
      message.type === "usage.fetch" ||
      message.type === "usage.discover" ||
      message.type === "search.execute" ||
      isSubscriptionRequest(message) ||
      message.type === "subscribe"
    ) {
      send({ type: "error", requestId: message.requestId, error: "Plugin is stopping" });
    } else if (message.type === "provider.connect") {
      send({
        type: "provider.connect_failed",
        connectionId: message.connectionId,
        error: "Plugin is stopping",
      });
    } else if (message.type === "provider.send") {
      send({
        type: "provider.rejected",
        connectionId: message.connectionId,
        acceptanceId: message.acceptanceId,
        error: "Plugin is stopping",
      });
    } else if (message.type === "provider.close") {
      send({ type: "provider.closed", connectionId: message.connectionId });
    }
  }

  function handleToolMessage(
    message: PluginProcessRequest,
  ): message is Extract<
    PluginProcessRequest,
    { type: "tool.call" | "tool.cancel" | "tools.detach" }
  > {
    if (message.type === "tools.detach") {
      agentTools.detach(message.agentId);
      return true;
    }
    if (message.type === "tool.cancel") {
      agentTools.cancel(message.requestId);
      return true;
    }
    if (message.type === "tool.call") {
      if (!neolix) {
        send({ type: "error", requestId: message.requestId, error: "Plugin API unavailable" });
        return true;
      }
      void agentTools
        .call(message.requestId, message.agent, message.name, message.input, neolix)
        .then((output) =>
          send({
            type: "result",
            requestId: message.requestId,
            output: jsonTransportValue(output),
          }),
        )
        .catch((error) =>
          send({ type: "error", requestId: message.requestId, ...errorPayload(error) }),
        );
      return true;
    }
    return false;
  }

  function handleSubscriptionMessage(message: PluginProcessRequest): void {
    if (message.type === "unsubscribe") {
      subscriptions.release(message.subscriptionId);
      return;
    }
    if (message.type !== "subscribe") {
      return;
    }
    if (neolix) subscriptions.start(message, neolix);
    else send({ type: "error", requestId: message.requestId, error: "Plugin API unavailable" });
  }

  function handleMessage(rawMessage: unknown): void {
    const parsed = PluginProcessRequestSchema.safeParse(rawMessage);
    if (!parsed.success) {
      const value = rawMessage as { connectionId?: unknown; acceptanceId?: unknown } | null;
      if (
        value &&
        typeof value.connectionId === "string" &&
        typeof value.acceptanceId === "string"
      ) {
        send({
          type: "provider.rejected",
          connectionId: value.connectionId,
          acceptanceId: value.acceptanceId,
          error: `Invalid provider input: ${parsed.error.message}`,
        });
        void closeProviderConnection(value.connectionId);
        return;
      }
      send({ type: "fatal", error: `Invalid plugin process request: ${parsed.error.message}` });
      void shutdown();
      return;
    }
    const message = parsed.data;
    if (message.type === "initialize") {
      void initialize(message).catch(async (error) => {
        send({ type: "fatal", error: describeError(error) });
        await neolix
          ?.dispose()
          .catch((failure) => console.error("Plugin API cleanup failed", failure));
        await daemonClient?.close().catch(() => undefined);
      });
      return;
    }
    if (message.type === "shutdown") {
      void shutdown();
      return;
    }
    if (handleSideMessage(message)) return;
    if (message.type === "provider.status") {
      handleProviderStatusRequest(message);
      return;
    }
    if (message.type === "provider.catalog_key") {
      handleCatalogKeyRequest(message);
      return;
    }
    if (message.type === "provider.connect") {
      void connectProvider(message).catch((error) => {
        if (stopping) return;
        send({
          type: "provider.connect_failed",
          connectionId: message.connectionId,
          error: describeError(error),
        });
      });
      return;
    }
    if (message.type === "provider.send") {
      void sendProviderInput(message).catch((error) => {
        if (stopping) return;
        send({
          type: "provider.rejected",
          connectionId: message.connectionId,
          acceptanceId: message.acceptanceId,
          error: describeError(error),
        });
      });
      return;
    }
    if (message.type === "provider.close") {
      void closeProviderConnection(message.connectionId);
      return;
    }
    if (message.type === "neolix_frame" || message.type === "neolix_close") return;
    if (isHookMessage(message)) {
      handleHookMessage(message);
      return;
    }
    if (handleGatewayMessage(message)) return;
    if (message.type === "invoke") invoke(message);
    else handleSubscriptionMessage(message);
  }

  /** Dispatches the gateway's plugin messages; false for any other. */
  function handleGatewayMessage(message: PluginProcessRequest): boolean {
    switch (message.type) {
      case "middleware.request":
      case "middleware.response":
        void runGatewayMiddleware(message);
        return true;
      case "middleware.headers":
        void runGatewayHeaders(message);
        return true;
      case "middleware.usage":
        void runGatewayUsage(message);
        return true;
      case "middleware.provider":
      case "middleware.account":
      case "middleware.event":
        void runGatewayPoint(message);
        return true;
      case "strategy.order":
        void runStrategyOrder(message);
        return true;
      case "agent.wire":
        void runAgentWire(message);
        return true;
      default:
        return false;
    }
  }

  /**
   * Runs this plugin's gateway middleware in registration order. A hook that
   * throws is logged and skipped; the traffic continues with what it had, as
   * myna's middleware does.
   */
  async function runGatewayMiddleware(
    message: Extract<PluginProcessRequest, { type: "middleware.request" | "middleware.response" }>,
  ): Promise<void> {
    try {
      const output =
        message.type === "middleware.request"
          ? await requestMiddlewareBody(message)
          : await responseMiddlewareAnswer(message);
      send({ type: "result", requestId: message.requestId, output });
    } catch (error) {
      send({ type: "error", requestId: message.requestId, ...errorPayload(error) });
    } finally {
      // A whole answer ends the request for this plugin's middleware hooks.
      if (message.type === "middleware.response") {
        releaseGatewayState(message.requestKey);
      }
    }
  }

  async function requestMiddlewareBody(
    message: Extract<PluginProcessRequest, { type: "middleware.request" }>,
  ): Promise<{
    body: Record<string, unknown>;
    reject?: { status: number; message: string };
  }> {
    let body = message.body;
    for (const middleware of gatewayMiddlewares) {
      if (!middleware.onRequest) continue;
      try {
        const change = await middleware.onRequest({
          ...(message.requestKey === undefined ? {} : { requestKey: message.requestKey }),
          state: gatewayState(message.requestKey, middleware.id),
          providerId: message.providerId,
          protocol: message.protocol,
          model: message.model,
          accountId: message.accountId,
          body,
        });
        if (change?.reject !== undefined) {
          // myna's ctx.reject: 400–599, 403 by default, and the hook chain stops.
          const status =
            typeof change.reject.status === "number" &&
            change.reject.status >= 400 &&
            change.reject.status <= 599
              ? change.reject.status
              : 403;
          const text =
            typeof change.reject.message === "string" && change.reject.message !== ""
              ? change.reject.message
              : "turned away by a gateway middleware";
          // The request ends here, so nothing later will run onResponse.
          releaseGatewayState(message.requestKey);
          return { body, reject: { status, message: text } };
        }
        if (change?.body !== undefined) body = change.body;
      } catch (error) {
        console.error(`gateway middleware ${middleware.id} onRequest failed`, error);
      }
    }
    return { body };
  }

  async function responseMiddlewareAnswer(
    message: Extract<PluginProcessRequest, { type: "middleware.response" }>,
  ): Promise<{ status: number; headers: Record<string, string>; body: string | null }> {
    let status = message.status;
    let headers = message.headers;
    let body = message.body;
    for (const middleware of gatewayMiddlewares) {
      if (!middleware.onResponse) continue;
      try {
        const change = await middleware.onResponse({
          ...(message.requestKey === undefined ? {} : { requestKey: message.requestKey }),
          state: gatewayState(message.requestKey, middleware.id),
          providerId: message.providerId,
          model: message.model,
          accountId: message.accountId,
          status,
          headers,
          body,
        });
        if (change?.status !== undefined) status = change.status;
        if (change?.headers !== undefined) headers = change.headers;
        if (change?.body !== undefined) body = change.body;
      } catch (error) {
        console.error(`gateway middleware ${middleware.id} onResponse failed`, error);
      }
    }
    return { status, headers, body };
  }

  /** Runs the usage observers on one finished call; a failure is logged and skipped. */
  async function runGatewayUsage(
    message: Extract<PluginProcessRequest, { type: "middleware.usage" }>,
  ): Promise<void> {
    try {
      for (const observer of gatewayUsageObservers) {
        if (!observer.onUsage) continue;
        try {
          await observer.onUsage(message.row as GatewayUsageRow);
        } catch (error) {
          console.error(`gateway usage observer ${observer.id} failed`, error);
        }
      }
      send({ type: "result", requestId: message.requestId, output: {} });
    } catch (error) {
      send({ type: "error", requestId: message.requestId, ...errorPayload(error) });
    }
  }

  /** Runs the per-try hooks: onProvider, onAccount and onEvent. */
  async function runGatewayPoint(
    message: Extract<
      PluginProcessRequest,
      { type: "middleware.provider" | "middleware.account" | "middleware.event" }
    >,
  ): Promise<void> {
    try {
      let output: unknown;
      if (message.type === "middleware.provider") {
        output = { body: await providerBody(message) };
      } else if (message.type === "middleware.account") {
        output = await accountDecision(message);
      } else {
        output = { event: await eventChange(message) };
      }
      send({ type: "result", requestId: message.requestId, output });
    } catch (error) {
      send({ type: "error", requestId: message.requestId, ...errorPayload(error) });
    }
  }

  async function providerBody(
    message: Extract<PluginProcessRequest, { type: "middleware.provider" }>,
  ): Promise<Record<string, unknown>> {
    let body = message.body;
    for (const middleware of gatewayMiddlewares) {
      if (!middleware.onProvider) continue;
      try {
        const change = await middleware.onProvider({
          ...(message.requestKey === undefined ? {} : { requestKey: message.requestKey }),
          state: gatewayState(message.requestKey, middleware.id),
          providerId: message.providerId,
          protocol: message.protocol,
          accountId: message.accountId,
          model: message.model,
          body,
        });
        if (change?.body !== undefined) body = change.body;
      } catch (error) {
        console.error(`gateway middleware ${middleware.id} onProvider failed`, error);
      }
    }
    return body;
  }

  async function accountDecision(
    message: Extract<PluginProcessRequest, { type: "middleware.account" }>,
  ): Promise<{ skip: boolean }> {
    for (const middleware of gatewayMiddlewares) {
      if (!middleware.onAccount) continue;
      try {
        const decision = await middleware.onAccount({
          ...(message.requestKey === undefined ? {} : { requestKey: message.requestKey }),
          state: gatewayState(message.requestKey, middleware.id),
          providerId: message.providerId,
          protocol: message.protocol,
          accountId: message.accountId,
          model: message.model,
        });
        if (decision?.skip === true) return { skip: true };
      } catch (error) {
        console.error(`gateway middleware ${middleware.id} onAccount failed`, error);
      }
    }
    return { skip: false };
  }

  /** The event after every hook; null drops it (myna's onEvent). */
  async function eventChange(
    message: Extract<PluginProcessRequest, { type: "middleware.event" }>,
  ): Promise<unknown> {
    let event = message.event;
    for (const middleware of gatewayMiddlewares) {
      if (!middleware.onEvent) continue;
      try {
        const change = (await middleware.onEvent({
          ...(message.requestKey === undefined ? {} : { requestKey: message.requestKey }),
          state: gatewayState(message.requestKey, middleware.id),
          providerId: message.providerId,
          accountId: message.accountId,
          model: message.model,
          event,
        })) as GatewayMiddlewareEventChange | null | undefined;
        if (change === null || (change !== undefined && change.event === null)) return null;
        if (change?.event !== undefined) event = change.event;
      } catch (error) {
        console.error(`gateway middleware ${middleware.id} onEvent failed`, error);
      }
    }
    return event;
  }

  /** Adds the headers this plugin's `onHeaders` hooks give one request. */
  async function runGatewayHeaders(
    message: Extract<PluginProcessRequest, { type: "middleware.headers" }>,
  ): Promise<void> {
    try {
      const headers: Record<string, string> = {};
      for (const middleware of gatewayMiddlewares) {
        if (!middleware.onHeaders) continue;
        try {
          const change = await middleware.onHeaders({
            ...(message.requestKey === undefined ? {} : { requestKey: message.requestKey }),
            state: gatewayState(message.requestKey, middleware.id),
            providerId: message.providerId,
            protocol: message.protocol,
            model: message.model,
            accountId: message.accountId,
          });
          if (change?.headers !== undefined) Object.assign(headers, stringHeaders(change.headers));
        } catch (error) {
          console.error(`gateway middleware ${middleware.id} onHeaders failed`, error);
        }
      }
      send({ type: "result", requestId: message.requestId, output: { headers } });
    } catch (error) {
      send({ type: "error", requestId: message.requestId, ...errorPayload(error) });
    }
  }

  /** Runs one routing strategy; the daemon validates the permutation. */
  async function runStrategyOrder(
    message: Extract<PluginProcessRequest, { type: "strategy.order" }>,
  ): Promise<void> {
    try {
      const strategy = routingStrategies.find((entry) => entry.id === message.strategyId);
      if (strategy === undefined) {
        send({
          type: "error",
          requestId: message.requestId,
          error: `Unknown routing strategy: ${message.strategyId}`,
        });
        return;
      }
      const order = await strategy.order({
        pool: message.pool,
        seats: message.seats as unknown as GatewayStrategySeat[],
        options: message.options,
      });
      send({ type: "result", requestId: message.requestId, output: { order } });
    } catch (error) {
      send({ type: "error", requestId: message.requestId, ...errorPayload(error) });
    }
  }

  /** Asks one agent integration what to write; the daemon writes the file. */
  async function runAgentWire(
    message: Extract<PluginProcessRequest, { type: "agent.wire" }>,
  ): Promise<void> {
    try {
      const integration = agentIntegrations.find((entry) => entry.id === message.integrationId);
      if (integration === undefined) {
        send({
          type: "error",
          requestId: message.requestId,
          error: `Unknown agent integration: ${message.integrationId}`,
        });
        return;
      }
      const settings = await integration.connect({
        gateway: message.gateway,
        model: message.model,
        models: message.models,
      });
      send({ type: "result", requestId: message.requestId, output: { settings } });
    } catch (error) {
      send({ type: "error", requestId: message.requestId, ...errorPayload(error) });
    }
  }

  function invoke(message: Extract<PluginProcessRequest, { type: "invoke" }>): void {
    const registered = handlers.get(message.method);
    if (!registered) {
      send({
        type: "error",
        requestId: message.requestId,
        error: `Unknown RPC method: ${message.method}`,
      });
      return;
    }
    void registered.contract.input
      .parseAsync(message.input)
      .then((input) => {
        if (!neolix) throw new Error("Plugin Neolix API is unavailable");
        return registered.handler(input, { neolix });
      })
      .then((output: unknown) => {
        assertPluginWireValue(output, "output");
        return output;
      })
      .then(
        (output) => send({ type: "result", requestId: message.requestId, output }),
        (error) => send({ type: "error", requestId: message.requestId, ...errorPayload(error) }),
      );
  }
  channel.onMessage(handleMessage);

  function handleHookMessage(
    message: Extract<PluginProcessRequest, { type: "hook" | "hook.cancel" }>,
  ): void {
    if (message.type === "hook.cancel") {
      hooks.cancel(message.requestId);
      return;
    }
    if (message.type === "hook") {
      if (!neolix) {
        send({
          type: "error",
          requestId: message.requestId,
          error: "Plugin Neolix API is unavailable",
        });
        return;
      }
      void hooks.invoke(message.requestId, message.name, message.input, neolix).then(
        (output) => {
          return send({ type: "result", requestId: message.requestId, output });
        },
        (error) => {
          return send({ type: "error", requestId: message.requestId, ...errorPayload(error) });
        },
      );
      return;
    }
  }

  function isHookMessage(
    message: PluginProcessRequest,
  ): message is Extract<PluginProcessRequest, { type: "hook" | "hook.cancel" }> {
    return message.type === "hook" || message.type === "hook.cancel";
  }
  return { shutdown };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let worker: ReturnType<typeof createPluginWorker> | null = null;
  const handlers = new Set<(message: PluginProcessRequest) => void>();
  const channel: PluginWorkerChannel = {
    send(message, callback) {
      if (callback) process.send?.(message, () => callback());
      else process.send?.(message);
    },
    onMessage(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    disconnect() {
      process.disconnect();
    },
  };
  process.on("message", (raw) => {
    const parsed = PluginProcessRequestSchema.safeParse(raw);
    if (!worker && parsed.success && parsed.data.type === "initialize") {
      try {
        initializeEnvironmentProxy();
        worker = createPluginWorker({ channel, contribute: evaluateBundle(parsed.data.bundle) });
      } catch (error) {
        channel.send({ type: "fatal", error: describeError(error) });
        return;
      }
    }
    if (worker) for (const handler of handlers) handler(raw as PluginProcessRequest);
  });
}
