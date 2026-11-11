import type { NeolixApi } from "@neolix/client";
import type { ZodType, input as ZodInput, output as ZodOutput } from "zod";
import type { PluginRpcContract, PluginSubscriptionContract, PluginWireInput } from "../rpc.js";
import type { PluginCleanup } from "../contracts.js";
import type { ProviderRegistration } from "./provider.js";
import type { UsageSourceRegistration } from "./usage.js";
import type { SearchApiRegistration } from "./search.js";
import type { PluginAccounts } from "./accounts.js";
import type { SubscriptionProviderRegistration } from "./subscription.js";
import type { PluginLifecycleRegistration } from "./lifecycle.js";

export interface PluginHandlerContext {
  neolix: NeolixApi;
}

/** What a subscription handler receives beside its input. */
export interface PluginSubscriptionContext<Event = unknown> extends PluginHandlerContext {
  /**
   * Sends one event to this subscriber. A `Uint8Array` event travels as a binary frame; any other
   * event is JSON and must not contain a `Uint8Array`. Resolves once the event left the plugin
   * process. Events pushed after `signal` aborts are dropped.
   */
  push(event: Event): Promise<void>;
  /** Aborts when the subscriber releases, disconnects, or the plugin stops. */
  signal: AbortSignal;
}

export type PluginSettingsState<Schema extends ZodType> =
  | {
      status: "ready";
      revision: string;
      values: ZodOutput<Schema>;
    }
  | {
      status: "invalid";
      revision: string;
      error: string;
    };

export interface PluginSettings<Schema extends ZodType> {
  read(): Promise<PluginSettingsState<Schema>>;
  subscribe(listener: (state: PluginSettingsState<Schema>) => void | Promise<void>): PluginCleanup;
}

/** What the gateway is about to send upstream, as a middleware sees it. */
export interface GatewayMiddlewareRequest {
  providerId: string;
  protocol: string;
  model: string;
  accountId: string;
  body: Record<string, unknown>;
}

/** What a middleware may change on its way out; nothing keeps the request as it is. */
export interface GatewayMiddlewareRequestChange {
  body?: Record<string, unknown>;
}

/** The vendor's answer, before the gateway hands it on (non-streaming only). */
export interface GatewayMiddlewareResponse {
  providerId: string;
  model: string;
  accountId: string;
  status: number;
  headers: Record<string, string>;
  body: string | null;
}

export interface GatewayMiddlewareResponseChange {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
}

/** One try of the request: the provider and account it is about to go to. */
export interface GatewayMiddlewareProvider {
  providerId: string;
  protocol: string;
  /** Null when the try uses the provider's own key rather than an account. */
  accountId: string | null;
  model: string;
  body: Record<string, unknown>;
}

export interface GatewayMiddlewareProviderChange {
  body?: Record<string, unknown>;
}

/** The account a try would go to, before anything is asked of it. */
export interface GatewayMiddlewareAccount {
  providerId: string;
  protocol: string;
  accountId: string;
  model: string;
}

/** `skip` passes this account over for the request (myna's onAccount). */
export interface GatewayMiddlewareAccountDecision {
  skip?: boolean;
}

/** One event of a streamed answer, as onEvent sees it (myna's 50ms hook). */
export interface GatewayMiddlewareEvent {
  providerId: string;
  model: string;
  accountId: string;
  event: unknown;
}

/** `event: null` drops the event; leaving it out keeps it as it was. */
export interface GatewayMiddlewareEventChange {
  event?: unknown;
}

/**
 * A hook on gateway traffic, beside myna's `magpie.middleware`: rewrite a
 * request body before it goes out, an answer before it is returned, or one
 * event of a streamed answer. Hooks run in registration order; a hook that
 * throws is skipped and the traffic goes on as it was.
 */
export interface GatewayMiddlewareRegistration {
  id: string;
  onRequest?(
    input: GatewayMiddlewareRequest,
  ): void | GatewayMiddlewareRequestChange | Promise<void | GatewayMiddlewareRequestChange>;
  onProvider?(
    input: GatewayMiddlewareProvider,
  ): void | GatewayMiddlewareProviderChange | Promise<void | GatewayMiddlewareProviderChange>;
  onAccount?(
    input: GatewayMiddlewareAccount,
  ): void | GatewayMiddlewareAccountDecision | Promise<void | GatewayMiddlewareAccountDecision>;
  onResponse?(
    input: GatewayMiddlewareResponse,
  ): void | GatewayMiddlewareResponseChange | Promise<void | GatewayMiddlewareResponseChange>;
  onEvent?(
    input: GatewayMiddlewareEvent,
  ): void | GatewayMiddlewareEventChange | Promise<void | GatewayMiddlewareEventChange>;
}

/** What a plugin's agent wiring is told: where Neolix's gateway is and what to pick. */
export interface GatewayAgentWiringInput {
  gateway: { v1: string; key: string };
  /** The model the agent should keep as its default. */
  model: string;
  /** The models the agent may choose from. */
  models: string[];
}

/**
 * One third-party agent Neolix can wire to its gateway, beside myna's
 * `magpie.agent`: the file it edits, its format, and the settings that
 * point the agent at the gateway.
 */
export interface GatewayAgentIntegrationRegistration {
  id: string;
  label: string;
  /** The file Neolix edits; `~` is the user's home. */
  config: string;
  /** Its format; read from the file's extension when omitted. */
  format?: "json" | "yaml" | "env";
  /** The key path of the model in the config (myna's agent.model). */
  model?: string;
  connect(
    input: GatewayAgentWiringInput,
  ): Record<string, unknown> | Promise<Record<string, unknown>>;
}

/** One finished gateway call, as a usage observer sees it. */
export interface GatewayUsageRow {
  time: string;
  requested: string;
  provider: string;
  /** The credential that served it; null when the provider has none. */
  account: string | null;
  model: string;
  protocol: string;
  status: number;
  ok: boolean;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** The rest of the record, as the usage ledger writes it. */
  [field: string]: unknown;
}

/**
 * A hook on the gateway's usage ledger, beside myna's `onUsage`: one call
 * per finished request, dropped rather than delayed when the plugin is
 * slow (myna's 250ms per row).
 */
export interface GatewayUsageObserverRegistration {
  id: string;
  onUsage?(row: GatewayUsageRow): void | Promise<void>;
}

/** One candidate a routing strategy orders: a provider/model the gateway can try. */
export interface GatewayStrategySeat {
  /** Stable across requests for the same candidate, myna's Seat.Key. */
  key: string;
  provider: string;
  model: string;
  /** Its provider's or account's written priority; lower goes first by default. */
  priority: number;
  weight: number;
  /** It failed lately and the gateway means to rest it. */
  resting: boolean;
}

/** What a routing strategy is asked, beside myna's `(pool, seats, options)`. */
export interface GatewayStrategyInput {
  /** The requested model or `group/<id>` the order is for. */
  pool: string;
  seats: GatewayStrategySeat[];
  options: Record<string, unknown>;
}

/**
 * A routing the gateway may order candidates by, beside myna's
 * `strategies`: registered as `<pluginId>/<id>` and named in a group's
 * `strategy` (or a provider's `routing`). The answer is seat keys or
 * indexes; anything else, a throw, or a timeout keeps the listed order.
 */
export interface GatewayRoutingStrategyRegistration {
  id: string;
  order(input: GatewayStrategyInput): number[] | string[] | Promise<number[] | string[]>;
}

export interface PluginServerContext extends PluginLifecycleRegistration {
  /** This plugin's own sign-ins, kept across reloads. */
  accounts: PluginAccounts;
  registerSettings<Schema extends ZodType>(
    definition: import("../settings.js").SettingsDefinition<Schema>,
  ): PluginSettings<Schema>;
  /**
   * Serves a subscription. The handler starts the work and returns; the subscription stays open
   * until `signal` aborts. A handler that throws refuses the subscription. When it returns a
   * promise, settling the promise closes the subscription, with the rejection as its error.
   */
  handle<InputSchema extends ZodType, EventSchema extends ZodType>(
    contract: PluginSubscriptionContract<InputSchema, EventSchema>,
    handler: (
      input: ZodOutput<InputSchema>,
      context: PluginSubscriptionContext<PluginWireInput<ZodInput<EventSchema>>>,
    ) => void | Promise<void>,
  ): void;
  handle<InputSchema extends ZodType, OutputSchema extends ZodType>(
    contract: PluginRpcContract<InputSchema, OutputSchema>,
    handler: (
      input: ZodOutput<InputSchema>,
      context: PluginHandlerContext,
    ) => PluginWireInput<ZodInput<OutputSchema>> | Promise<PluginWireInput<ZodInput<OutputSchema>>>,
  ): void;
  registerProvider(provider: ProviderRegistration): void;
  /** A vendor this plugin signs in to and serves through the gateway. */
  registerSubscriptionProvider(provider: SubscriptionProviderRegistration): void;
  registerUsageSource(source: UsageSourceRegistration): void;
  registerSearchApi(search: SearchApiRegistration): void;
  /** Hooks on the gateway's upstream traffic. */
  registerGatewayMiddleware(middleware: GatewayMiddlewareRegistration): void;
  /** A hook on each finished gateway call. */
  registerGatewayUsageObserver(observer: GatewayUsageObserverRegistration): void;
  /** A candidate ordering the gateway may be asked for by name. */
  registerRoutingStrategy(strategy: GatewayRoutingStrategyRegistration): void;
  /** A third-party agent Neolix can point at the gateway (myna's magpie.agent). */
  registerAgentIntegration(integration: GatewayAgentIntegrationRegistration): void;
}

export type PluginServerContribution = (
  server: PluginServerContext,
) => PluginCleanup | Promise<PluginCleanup>;
