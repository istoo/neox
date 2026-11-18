import type { PluginHookAgent } from "@neolix/plugin/server";
import { UsageScopeSchema, type UsageScope } from "@neolix/plugin/server/usage";
import type {
  SubscriptionLoaderInput,
  SubscriptionProviderMetadata,
} from "@neolix/plugin/server/subscription";
import type {
  ProviderConnectRequest,
  ProviderCatalogOptions,
  ProviderEvent,
  ProviderInput,
  ProviderStatusRequest,
} from "@neolix/plugin/server/provider";
import {
  ProviderEventSchema,
  ProviderInputSchema,
  ProviderLaunchSchema,
} from "@neolix/plugin/server/provider";
import { z } from "zod";

export interface PluginProviderMetadata {
  requiresConfiguration?: boolean;
  supportsAccountDerivation?: boolean;
  hasCatalogCacheKey?: boolean;
  hasStatus?: boolean;
  command?: readonly [string, ...string[]];
  id: string;
  label: string;
  description?: string;
  iconPath?: string;
}

export interface PluginUsageSourceMetadata {
  id: string;
  label: string;
  icon?: string;
}

export interface PluginSearchApiMetadata {
  id: string;
  name: string;
  keysURL?: string;
  keyOptional?: boolean;
  needURL?: boolean;
}

export type PluginProcessRequest =
  | { type: "tool.call"; requestId: string; agent: PluginHookAgent; name: string; input: unknown }
  | { type: "tool.cancel"; requestId: string }
  | { type: "tools.detach"; agentId: string }
  | {
      type: "provider.status";
      requestId: string;
      providerId: string;
      request: ProviderStatusRequest;
    }
  | {
      type: "initialize";
      pluginId: string;
      bundle: string;
      appVersion: string;
      pluginDirectory: string;
      settingsDirectory?: string;
    }
  | {
      type: "provider.catalog_key";
      requestId: string;
      providerId: string;
      options: ProviderCatalogOptions;
    }
  | { type: "hook"; requestId: string; name: string; input: unknown }
  | { type: "hook.cancel"; requestId: string }
  | { type: "usage.fetch"; requestId: string; sourceId: string; input: unknown }
  | { type: "usage.discover"; requestId: string; sourceId: string; scope: UsageScope }
  | {
      type: "search.execute";
      requestId: string;
      searchId: string;
      query: string;
      key: string | null;
      url: string | null;
    }
  | {
      type: "subscription.models";
      requestId: string;
      providerId: string;
      accountId: string;
    }
  | {
      type: "subscription.load";
      requestId: string;
      providerId: string;
      input: SubscriptionLoaderInput;
    }
  | {
      type: "subscription.usage";
      requestId: string;
      providerId: string;
      accountId: string;
    }
  | {
      type: "subscription.checkin";
      requestId: string;
      providerId: string;
      accountId: string;
    }
  | {
      type: "subscription.refresh";
      requestId: string;
      providerId: string;
      accountId: string;
    }
  | {
      type: "subscription.sign_in";
      requestId: string;
      providerId: string;
      method: number;
      accountId: string;
      inputs: Record<string, string>;
    }
  | {
      type: "subscription.request";
      requestId: string;
      providerId: string;
      token: string;
      url: string;
      method: string;
      headers: Record<string, string>;
      body: string;
    }
  | {
      type: "subscription.sign_in.poll";
      requestId: string;
      providerId: string;
      token: string;
    }
  | {
      type: "middleware.request";
      requestId: string;
      requestKey?: string;
      providerId: string;
      protocol: string;
      model: string;
      accountId: string;
      body: Record<string, unknown>;
    }
  | {
      type: "middleware.response";
      requestId: string;
      requestKey?: string;
      providerId: string;
      model: string;
      accountId: string;
      status: number;
      headers: Record<string, string>;
      body: string | null;
    }
  | {
      type: "middleware.usage";
      requestId: string;
      row: Record<string, unknown>;
    }
  | {
      type: "middleware.provider";
      requestId: string;
      requestKey?: string;
      providerId: string;
      protocol: string;
      model: string;
      accountId: string | null;
      body: Record<string, unknown>;
    }
  | {
      type: "middleware.account";
      requestId: string;
      requestKey?: string;
      providerId: string;
      protocol: string;
      model: string;
      accountId: string;
    }
  | {
      type: "middleware.event";
      requestId: string;
      requestKey?: string;
      providerId: string;
      model: string;
      accountId: string;
      event: unknown;
    }
  | {
      type: "middleware.headers";
      requestId: string;
      requestKey?: string;
      providerId: string;
      protocol: string;
      model: string;
      accountId: string | null;
    }
  | {
      type: "strategy.order";
      requestId: string;
      strategyId: string;
      pool: string;
      seats: Array<Record<string, unknown>>;
      options: Record<string, unknown>;
    }
  | {
      type: "agent.wire";
      requestId: string;
      integrationId: string;
      gateway: { v1: string; key: string };
      model: string;
      models: string[];
    }
  | { type: "invoke"; requestId: string; method: string; input: unknown }
  | {
      type: "subscribe";
      requestId: string;
      subscriptionId: string;
      method: string;
      input: unknown;
    }
  | { type: "unsubscribe"; subscriptionId: string }
  | {
      type: "provider.connect";
      providerId: string;
      connectionId: string;
      request: ProviderConnectRequest;
    }
  | {
      type: "provider.send";
      connectionId: string;
      acceptanceId: string;
      input: ProviderInput;
    }
  | { type: "provider.close"; connectionId: string }
  | { type: "shutdown" }
  | { type: "neolix_frame"; data: string | Uint8Array; isBinary: boolean }
  | { type: "neolix_close" };

export type PluginProcessMessage =
  | { type: "settings.changed"; settingsId: string }
  | { type: "hooks.changed"; hooks: string[] }
  | {
      type: "ready";
      methods: string[];
      subscriptions?: string[];
      providers: PluginProviderMetadata[];
      usageSources?: PluginUsageSourceMetadata[];
      searchApis?: PluginSearchApiMetadata[];
      subscriptionProviders?: SubscriptionProviderMetadata[];
      gatewayMiddlewares?: string[];
      /** Which hooks each middleware implements, so unused ones cost no round trip. */
      gatewayMiddlewareHooks?: Array<{ id: string; hooks: string[] }>;
      gatewayUsageObservers?: string[];
      routingStrategies?: string[];
      agentIntegrations?: Array<{
        id: string;
        label: string;
        config: string;
        format?: string;
        model?: string;
      }>;
      hooks?: string[];
      /** Host-scoped settings registered with `server.registerSettings`, for non-RN hosts. */
      settings?: Array<{ id: string; title?: string; schema?: Record<string, unknown> }>;
    }
  | { type: "result"; requestId: string; output: unknown }
  | { type: "error"; requestId: string; error: string; cause?: string }
  | { type: "fatal"; error: string }
  | { type: "subscription.event"; subscriptionId: string; event: unknown }
  | { type: "subscription.closed"; subscriptionId: string; error?: string }
  | {
      type: "provider.connected";
      connectionId: string;
      version: number;
      capabilities: readonly string[];
    }
  | { type: "provider.connect_failed"; connectionId: string; error: string }
  | { type: "provider.accepted"; connectionId: string; acceptanceId: string }
  | {
      type: "provider.rejected";
      connectionId: string;
      acceptanceId: string;
      error: string;
    }
  | { type: "provider.event"; connectionId: string; event: ProviderEvent }
  | { type: "provider.closed"; connectionId: string; error?: string }
  | { type: "neolix_frame"; data: string | Uint8Array; isBinary: boolean }
  | { type: "neolix_close" };

const hooksSchema = z.array(z.string());

const providerMetadataSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    description: z.string().optional(),
    iconPath: z.string().optional(),
    requiresConfiguration: z.boolean().optional(),
    supportsAccountDerivation: z.boolean().optional(),
    hasCatalogCacheKey: z.boolean().optional(),
    hasStatus: z.boolean().optional(),
    command: z.tuple([z.string().min(1)], z.string()).optional(),
  })
  .strict();
const usageSourceMetadataSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    icon: z.string().optional(),
  })
  .strict();
const searchApiMetadataSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    keysURL: z.string().optional(),
    keyOptional: z.boolean().optional(),
    needURL: z.boolean().optional(),
  })
  .strict();
const subscriptionPromptSchema = z
  .object({
    type: z.enum(["text", "select"]),
    key: z.string().min(1),
    message: z.string(),
    placeholder: z.string().optional(),
    options: z.array(z.object({ label: z.string(), value: z.string() }).strict()).optional(),
  })
  .strict();
const subscriptionProviderMetadataSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    protocol: z.enum(["anthropic", "openai", "openai-responses", "gemini"]),
    methods: z
      .array(
        z
          .object({
            type: z.enum(["oauth", "api"]),
            label: z.string().min(1),
            prompts: z.array(subscriptionPromptSchema).optional(),
            apiKey: z
              .object({ label: z.string().min(1), placeholder: z.string().optional() })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .min(1),
    options: z.record(z.string(), z.unknown()).optional(),
    /** The plugin implements `auth.checkin`. */
    checkin: z.literal(true).optional(),
  })
  .strict();
const providerConnectRequestSchema = z
  .object({
    launch: ProviderLaunchSchema.optional(),
    versions: z.array(z.number().int().positive()),
    capabilities: z.array(z.string()),
  })
  .strict();
const frameFields = {
  data: z.union([z.string(), z.instanceof(Uint8Array)]),
  isBinary: z.boolean(),
};

export const PluginProcessRequestSchema: z.ZodType<PluginProcessRequest> = z.discriminatedUnion(
  "type",
  [
    z
      .object({
        type: z.literal("tool.call"),
        requestId: z.string(),
        agent: z
          .object({
            id: z.string(),
            workspaceId: z.string().nullable(),
            parentAgentId: z.string().nullable(),
            provider: z.string(),
            cwd: z.string(),
            title: z.string().nullable(),
          })
          .strict(),
        name: z.string(),
        input: z.unknown(),
      })
      .strict(),
    z.object({ type: z.literal("tool.cancel"), requestId: z.string() }).strict(),
    z.object({ type: z.literal("tools.detach"), agentId: z.string() }).strict(),
    z
      .object({
        type: z.literal("provider.status"),
        requestId: z.string().min(1),
        providerId: z.string().min(1),
        request: z.object({ launch: ProviderLaunchSchema.optional() }).strict(),
      })
      .strict(),
    z
      .object({
        type: z.literal("initialize"),
        pluginId: z.string().min(1),
        bundle: z.string(),
        appVersion: z.string(),
        pluginDirectory: z.string(),
        settingsDirectory: z.string().optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("provider.catalog_key"),
        requestId: z.string().min(1),
        providerId: z.string().min(1),
        options: z.discriminatedUnion("scope", [
          z
            .object({
              scope: z.literal("global"),
              force: z.boolean().optional(),
              launch: ProviderLaunchSchema.optional(),
            })
            .strict(),
          z
            .object({
              scope: z.literal("workspace"),
              cwd: z.string(),
              force: z.boolean().optional(),
              launch: ProviderLaunchSchema.optional(),
            })
            .strict(),
        ]),
      })
      .strict(),
    z
      .object({
        type: z.literal("hook"),
        requestId: z.string(),
        name: z.string(),
        input: z.unknown(),
      })
      .strict(),
    z.object({ type: z.literal("hook.cancel"), requestId: z.string() }).strict(),
    z
      .object({
        type: z.literal("usage.fetch"),
        requestId: z.string(),
        sourceId: z.string(),
        input: z.unknown(),
      })
      .strict(),
    z
      .object({
        type: z.literal("search.execute"),
        requestId: z.string(),
        searchId: z.string().min(1),
        query: z.string(),
        key: z.string().nullable(),
        url: z.string().nullable(),
      })
      .strict(),
    z
      .object({
        type: z.literal("subscription.models"),
        requestId: z.string(),
        providerId: z.string().min(1),
        accountId: z.string(),
      })
      .strict(),
    z
      .object({
        type: z.literal("subscription.load"),
        requestId: z.string(),
        providerId: z.string().min(1),
        input: z
          .object({
            accountId: z.string(),
            model: z.string(),
            body: z.record(z.string(), z.unknown()),
            headers: z.record(z.string(), z.string()),
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        type: z.literal("subscription.usage"),
        requestId: z.string(),
        providerId: z.string().min(1),
        accountId: z.string(),
      })
      .strict(),
    z
      .object({
        type: z.literal("subscription.checkin"),
        requestId: z.string(),
        providerId: z.string().min(1),
        accountId: z.string(),
      })
      .strict(),
    z
      .object({
        type: z.literal("subscription.refresh"),
        requestId: z.string(),
        providerId: z.string().min(1),
        accountId: z.string(),
      })
      .strict(),
    z
      .object({
        type: z.literal("subscription.sign_in"),
        requestId: z.string(),
        providerId: z.string().min(1),
        method: z.number().int().nonnegative(),
        accountId: z.string().min(1),
        inputs: z.record(z.string(), z.string()),
      })
      .strict(),
    z
      .object({
        type: z.literal("subscription.request"),
        requestId: z.string(),
        providerId: z.string().min(1),
        token: z.string().min(1),
        url: z.string(),
        method: z.string(),
        headers: z.record(z.string(), z.string()),
        body: z.string(),
      })
      .strict(),
    z
      .object({
        type: z.literal("subscription.sign_in.poll"),
        requestId: z.string(),
        providerId: z.string().min(1),
        token: z.string().min(1),
      })
      .strict(),
    z
      .object({
        type: z.literal("middleware.request"),
        requestId: z.string(),
        requestKey: z.string().optional(),
        providerId: z.string(),
        protocol: z.string(),
        model: z.string(),
        accountId: z.string(),
        body: z.record(z.string(), z.unknown()),
      })
      .strict(),
    z
      .object({
        type: z.literal("middleware.response"),
        requestId: z.string(),
        requestKey: z.string().optional(),
        providerId: z.string(),
        model: z.string(),
        accountId: z.string(),
        status: z.number().int(),
        headers: z.record(z.string(), z.string()),
        body: z.string().nullable(),
      })
      .strict(),
    z
      .object({
        type: z.literal("middleware.usage"),
        requestId: z.string(),
        row: z.record(z.string(), z.unknown()),
      })
      .strict(),
    z
      .object({
        type: z.literal("middleware.provider"),
        requestId: z.string(),
        requestKey: z.string().optional(),
        providerId: z.string(),
        protocol: z.string(),
        model: z.string(),
        accountId: z.string().nullable(),
        body: z.record(z.string(), z.unknown()),
      })
      .strict(),
    z
      .object({
        type: z.literal("middleware.account"),
        requestId: z.string(),
        requestKey: z.string().optional(),
        providerId: z.string(),
        protocol: z.string(),
        model: z.string(),
        accountId: z.string(),
      })
      .strict(),
    z
      .object({
        type: z.literal("middleware.event"),
        requestId: z.string(),
        requestKey: z.string().optional(),
        providerId: z.string(),
        model: z.string(),
        accountId: z.string(),
        event: z.unknown(),
      })
      .strict(),
    z
      .object({
        type: z.literal("middleware.headers"),
        requestId: z.string(),
        requestKey: z.string().optional(),
        providerId: z.string(),
        protocol: z.string(),
        model: z.string(),
        accountId: z.string().nullable(),
      })
      .strict(),
    z
      .object({
        type: z.literal("agent.wire"),
        requestId: z.string(),
        integrationId: z.string(),
        gateway: z.object({ v1: z.string(), key: z.string() }).strict(),
        model: z.string(),
        models: z.array(z.string()),
      })
      .strict(),
    z
      .object({
        type: z.literal("strategy.order"),
        requestId: z.string(),
        strategyId: z.string(),
        pool: z.string(),
        seats: z.array(z.record(z.string(), z.unknown())),
        options: z.record(z.string(), z.unknown()),
      })
      .strict(),
    z
      .object({
        type: z.literal("usage.discover"),
        requestId: z.string(),
        sourceId: z.string(),
        scope: UsageScopeSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal("invoke"),
        requestId: z.string().min(1),
        method: z.string().min(1),
        input: z.unknown(),
      })
      .strict(),
    z
      .object({
        type: z.literal("subscribe"),
        requestId: z.string().min(1),
        subscriptionId: z.string().min(1),
        method: z.string().min(1),
        input: z.unknown(),
      })
      .strict(),
    z.object({ type: z.literal("unsubscribe"), subscriptionId: z.string().min(1) }).strict(),
    z
      .object({
        type: z.literal("provider.connect"),
        providerId: z.string().min(1),
        connectionId: z.string().min(1),
        request: providerConnectRequestSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal("provider.send"),
        connectionId: z.string().min(1),
        acceptanceId: z.string().min(1),
        input: ProviderInputSchema,
      })
      .strict(),
    z.object({ type: z.literal("provider.close"), connectionId: z.string().min(1) }).strict(),
    z.object({ type: z.literal("shutdown") }).strict(),
    z.object({ type: z.literal("neolix_frame"), ...frameFields }).strict(),
    z.object({ type: z.literal("neolix_close") }).strict(),
  ],
);

export const PluginProcessMessageSchema: z.ZodType<PluginProcessMessage> = z.discriminatedUnion(
  "type",
  [
    z.object({ type: z.literal("settings.changed"), settingsId: z.string() }).strict(),
    z.object({ type: z.literal("hooks.changed"), hooks: hooksSchema }).strict(),
    z
      .object({
        type: z.literal("ready"),
        methods: z.array(z.string()),
        subscriptions: z.array(z.string()).optional(),
        providers: z.array(providerMetadataSchema),
        usageSources: z.array(usageSourceMetadataSchema).optional(),
        searchApis: z.array(searchApiMetadataSchema).optional(),
        subscriptionProviders: z.array(subscriptionProviderMetadataSchema).optional(),
        gatewayMiddlewares: z.array(z.string()).optional(),
        gatewayMiddlewareHooks: z
          .array(z.object({ id: z.string(), hooks: z.array(z.string()) }).strict())
          .optional(),
        gatewayUsageObservers: z.array(z.string()).optional(),
        routingStrategies: z.array(z.string()).optional(),
        agentIntegrations: z
          .array(
            z
              .object({
                id: z.string(),
                label: z.string(),
                config: z.string(),
                format: z.string().optional(),
                model: z.string().optional(),
              })
              .strict(),
          )
          .optional(),
        hooks: hooksSchema.optional(),
        settings: z
          .array(
            z
              .object({
                id: z.string().min(1),
                title: z.string().min(1).optional(),
                schema: z.record(z.string(), z.unknown()).optional(),
              })
              .strict(),
          )
          .optional(),
      })
      .strict(),
    z
      .object({ type: z.literal("result"), requestId: z.string().min(1), output: z.unknown() })
      .strict(),
    z
      .object({
        type: z.literal("error"),
        requestId: z.string().min(1),
        error: z.string(),
        // Optional so a daemon parses errors from a plugin that predates the cause chain.
        cause: z.string().optional(),
      })
      .strict(),
    z.object({ type: z.literal("fatal"), error: z.string() }).strict(),
    z
      .object({
        type: z.literal("subscription.event"),
        subscriptionId: z.string().min(1),
        event: z.unknown(),
      })
      .strict(),
    z
      .object({
        type: z.literal("subscription.closed"),
        subscriptionId: z.string().min(1),
        error: z.string().optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("provider.connected"),
        connectionId: z.string().min(1),
        version: z.number().int().positive(),
        capabilities: z.array(z.string()),
      })
      .strict(),
    z
      .object({
        type: z.literal("provider.connect_failed"),
        connectionId: z.string().min(1),
        error: z.string(),
      })
      .strict(),
    z
      .object({
        type: z.literal("provider.accepted"),
        connectionId: z.string().min(1),
        acceptanceId: z.string().min(1),
      })
      .strict(),
    z
      .object({
        type: z.literal("provider.rejected"),
        connectionId: z.string().min(1),
        acceptanceId: z.string().min(1),
        error: z.string(),
      })
      .strict(),
    z
      .object({
        type: z.literal("provider.event"),
        connectionId: z.string().min(1),
        event: ProviderEventSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal("provider.closed"),
        connectionId: z.string().min(1),
        error: z.string().optional(),
      })
      .strict(),
    z.object({ type: z.literal("neolix_frame"), ...frameFields }).strict(),
    z.object({ type: z.literal("neolix_close") }).strict(),
  ],
);
