import { randomBytes } from "node:crypto";
import { unwatchFile, watchFile } from "node:fs";
import { readFile } from "node:fs/promises";
import { refreshProxy, setConfiguredProxy } from "../network/index.js";
import { isValidJson, keepLastGood, readJsonLastGood, UnreadableFileError } from "../last-good.js";
import { writePrivateFileAtomic } from "../private-files.js";
import { normalizeWarmAtConfig } from "./warm-at.js";
import path from "node:path";
import type { Logger } from "pino";
import { z } from "zod";

export const GATEWAY_CONFIG_FILENAME = "gateway.json";

/** A plugin's routing strategy, named `<pluginId>/<strategyId>`. */
const PluginRoutingStrategyName = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/);

/** A new key's id, as myna makes one: 12 random bytes in hex (access.random(12)). */
export function newGatewayKeyId(): string {
  return randomBytes(12).toString("hex");
}

/**
 * A proxy address as myna accepts one: "direct" for no proxy (the settings
 * row's Off), or an http://, https://, socks5:// or socks5h:// address. A
 * bare host:port is an HTTP proxy.
 */
const ProxyAddressSchema = z
  .string()
  .min(1)
  .refine(
    (value) => {
      const text = value.trim();
      if (text === "direct") {
        return true;
      }
      try {
        const url = new URL(text.includes("://") ? text : `http://${text}`);
        return ["http:", "https:", "socks5:", "socks5h:"].includes(url.protocol);
      } catch {
        return false;
      }
    },
    { message: "Expected direct, or an http://, https:// or socks5:// proxy" },
  );

/**
 * One of a gateway key's budget windows (#2227): a calendar day, week or
 * month in local time, or a cycle of `days`/`hours` from when the limit
 * was set (`since`). Tokens are the call's uncached input, output and cache
 * writes, and its cache reads when `cacheReads` says so; cost is the
 * Usage page's estimate, not a vendor's bill. myna's access.Limit.
 */
export const GatewayKeyLimitSchema = z
  .object({
    period: z.enum(["day", "week", "month", "days", "hours"]).default("day"),
    /** A "days" period's cycle, 1 to 3650. */
    days: z.number().int().min(1).max(3650).optional(),
    /** An "hours" period's cycle, 1 to 8760. */
    hours: z.number().int().min(1).max(8760).optional(),
    tokens: z.number().int().positive().optional(),
    cost: z.number().nonnegative().optional(),
    cacheReads: z.boolean().default(false),
    /**
     * When the cycle began, or when the limit was last reset; a calendar
     * window that started before it counts nothing before it. Absent for a
     * calendar window never reset, as myna's zero Since is.
     */
    since: z.string().optional(),
  })
  .strip()
  .refine(
    (limit) =>
      (limit.tokens !== undefined && limit.tokens > 0) ||
      (limit.cost !== undefined && limit.cost > 0),
    { message: "A key limit needs a token or cost cap" },
  )
  .refine((limit) => limit.period !== "days" || limit.days !== undefined, {
    message: "A days limit needs its cycle in days",
  })
  .refine((limit) => limit.period !== "hours" || limit.hours !== undefined, {
    message: "An hours limit needs its cycle in hours",
  });

export type GatewayKeyLimit = z.infer<typeof GatewayKeyLimitSchema>;

const GatewayModelSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1).optional(),
    contextWindow: z.number().int().positive().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    /** What the model makes: chat unless said, or an image or a video. */
    kind: z.enum(["chat", "image", "video"]).optional(),
    /**
     * Whether the model accepts images. `false` makes the gateway describe
     * each image in text before the request goes out; `true` marks it as a
     * describer the auto pick may use. Absent means unknown, and images pass.
     */
    images: z.boolean().optional(),
    /** Served when the provider's mode is `picked`. */
    picked: z.boolean().optional(),
    /** The day the vendor released it, for best-in-family tie-breaks (`YYYY-MM-DD`). */
    released: z.string().optional(),
  })
  .strip();

const GatewayAccountSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/),
    label: z.string().min(1).optional(),
    apiKey: z.string().min(1).optional(),
    baseUrl: z.string().url().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    /** Higher tiers are tried first; 0 is the normal tier. */
    priority: z.number().int().default(0),
    /** Relative share inside one priority tier. */
    weight: z.number().positive().default(1),
    maxConcurrency: z.number().int().positive().optional(),
    /** Requests per minute this account accepts. */
    maxRpm: z.number().int().positive().optional(),
    /** Sends one tiny request every five hours to keep the quota window warm. */
    warmup: z.boolean().default(false),
    /**
     * A time of day of its own to start its 5-hour window at, local "HH:MM";
     * "off" for none, "" to follow its agent's list. myna's CodexWarmAtOf.
     */
    warmAt: z.string().default(""),
    /** Model ids this account serves; empty means every model the provider lists. */
    models: z.array(z.string().min(1)).default([]),
    /** Monthly spend cap for this account, in USD. */
    monthlyUsd: z.number().positive().optional(),
    /**
     * The share of each usage window this subscription account is used to
     * at most, in percent (myna's AccountCaps, `provider account-cap`).
     */
    capPercent: z.number().int().min(1).max(100).optional(),
    /**
     * One usage window's own share, by the window's name ("5 hours");
     * 100 is no cap on that window (myna's AccountWindowCaps).
     */
    capWindows: z.record(z.string(), z.number().int().min(1).max(100)).optional(),
    /**
     * How much this API key may spend, in USD as the Usage page prices its
     * calls, a day, a month or in all from `since` (myna's SpendCap,
     * `provider spend-cap`).
     */
    spendCap: z
      .object({
        usd: z.number().nonnegative(),
        period: z.enum(["day", "month", "total"]).default("day"),
        /** When a "total" period began; absent is the account's creation. */
        since: z.string().optional(),
      })
      .strip()
      .optional(),
    /**
     * The Neolix-signed-in ChatGPT account this one spends, by its id in
     * $NEOLIX_HOME/gateway/codex-accounts.json (`neolix:<chatgpt account id>`);
     * absent leaves it to the account order.
     */
    codexAccountId: z.string().optional(),
    /**
     * When this account spends a Codex rate-limit reset by itself, myna's
     * CodexAutoReset list and CodexAutoResetOnly map: before a reset expires,
     * when its week runs out, or both. Absent is off.
     */
    autoReset: z.enum(["week", "expiring", "auto"]).optional(),
    /**
     * How this account spends its credits once a usage window is used up,
     * myna's CodexCreditsMode: "on" in its place (the default when absent),
     * "first" before moving on, "last" only after everything else, "off"
     * held as used up so the vendor's credits are not spent.
     */
    creditsMode: z.enum(["on", "first", "last", "off"]).optional(),
    enabled: z.boolean().default(true),
    /** This account's own proxy, or "direct"; absent follows the gateway's. */
    proxy: ProxyAddressSchema.optional(),
    /** Vendor usage endpoint polled for real window percentages. */
    usageUrl: z.string().url().optional(),
    usageIntervalMs: z.number().int().positive().optional(),
    /** Rolling token caps this account sells; requests rest when they are used up. */
    quota: z
      .object({
        tokens5h: z.number().int().positive().optional(),
        tokens7d: z.number().int().positive().optional(),
      })
      .strip()
      .optional(),
    /**
     * The app this account is signed in to, when it is not an API key: a
     * Claude subscription is served by driving the real Claude Code, and
     * the four sign-ins Neolix runs itself by the tokens it keeps.
     */
    agent: z
      .enum(["claude-code", "chatgpt-api", "copilot", "gemini", "antigravity", "factory"])
      .optional(),
    /**
     * Which of the agent's signed-in accounts this is, by its name in the
     * account store (`subscription-store.ts`). Empty is the first one.
     */
    subscriptionUser: z.string().min(1).optional(),
    /**
     * The `CLAUDE_CONFIG_DIR` this account's Claude Code keeps its sign-in
     * in. Absent is the machine's own sign-in.
     */
    configDir: z.string().min(1).optional(),
  })
  .strip();

const GatewayRateWindowSchema = z
  .object({
    /** 0 = Sunday … 6 = Saturday; absent for every day. */
    days: z.array(z.number().int().min(0).max(6)).optional(),
    /** "HH:MM" on the host's clock; a start after the end wraps past midnight. */
    start: z.string().regex(/^\d{1,2}:\d{2}$/),
    end: z.string().regex(/^\d{1,2}:\d{2}$/),
    rate: z.number().positive(),
  })
  .strip();

const GatewayProviderSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/),
    label: z.string().min(1).optional(),
    protocol: z.enum(["anthropic", "openai", "openai-responses", "gemini"]),
    baseUrl: z.string().url(),
    /**
     * A plugin's subscription provider serves this provider: the plugin's
     * loader names the real address and signs each attempt, and an account's
     * `id` names the sign-in kept in the plugin's account store. `baseUrl`
     * is then a placeholder the loader overrides.
     */
    plugin: z
      .object({ pluginId: z.string().min(1), providerId: z.string().min(1) })
      .strict()
      .optional(),
    /**
     * myna's own provider: one model served at an address per API
     * (`provider.Config` Chat/Responses/Anthropic/Gemini). A model is tried
     * on each address in this order, on that API's wire; `protocol` and
     * `baseUrl` stay the provider's main address.
     */
    wires: z
      .object({
        anthropic: z.string().url().optional(),
        openai: z.string().url().optional(),
        "openai-responses": z.string().url().optional(),
        gemini: z.string().url().optional(),
      })
      .strip()
      .optional(),
    /**
     * Google Vertex AI: the project, location and credentials its requests are
     * signed with (`vertex-auth.ts`, myna's provider.Vertex). Present, the
     * provider's address is the project's, not `baseUrl`.
     */
    vertex: z
      .object({
        /** The Google Cloud project's id: requests are made, and billed, there. */
        project: z.string().optional(),
        /** global, us, eu or a region (us-central1); global when unset. */
        location: z.string().optional(),
        /** A credentials file; unset finds Application Default Credentials. */
        credentials: z.string().optional(),
        /** A service account's email the credentials are traded for. */
        impersonate: z.string().optional(),
      })
      .strip()
      .optional(),
    apiKey: z.string().min(1).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    /**
     * Headers of the vendor's reply passed on to the agent, beside the
     * defaults (Request-Id and its kin); myna's replyHeaders.
     */
    replyHeaders: z.array(z.string()).default([]),
    /**
     * Headers of the agent's request passed on to the vendor as sent, over a
     * fixed `headers` value of the same name; myna's passHeaders.
     */
    passHeaders: z.array(z.string()).default([]),
    /** Multiple credentials for one vendor; `apiKey` is the implicit first one. */
    accounts: z.array(GatewayAccountSchema).default([]),
    /** Unset means on. Switched off, it keeps its keys and settings but serves nothing. */
    enabled: z.boolean().optional(),
    /**
     * myna's SwitchOnly (`provider.go:168`, `provider/routing.go:149`): the
     * gateway only moves this agent's own sign-in between its accounts and
     * serves no request on them. `neolix accounts switch-only`.
     */
    switchOnly: z.boolean().optional(),
    /**
     * myna's RestartApp on Codex's subscription: restart the Codex app's
     * app-server for a switch back that Neolix makes by itself, once the
     * account it moved off has room. A switch off a spent account is
     * restarted either way. Off unless the user turns it on.
     */
    restartApp: z.boolean().optional(),
    /** Skip TLS verification for this provider's upstream requests. */
    insecureTls: z.boolean().optional(),
    /** JSON fields merged into every upstream request body; a `!name` key replaces. */
    extraBody: z.record(z.string(), z.unknown()).optional(),
    /** Unset means listed. False hides its models from clients; an explicit id still resolves. */
    exposeModels: z.boolean().optional(),
    /**
     * Which of its models it serves. `list` (unset) serves them all, `picked`
     * serves the ones marked `picked`, `best` the newest of each family and
     * `none` serves nothing (kept for its balance and usage).
     */
    modelMode: z.enum(["list", "picked", "best", "none"]).optional(),
    /** Drawn by the app; the daemon ignores it. */
    icon: z.string().optional(),
    /** Requests to this provider go unmasked; the user asked for it. */
    unredacted: z.boolean().optional(),
    /** Counts every model it serves as free for `free` and `cheap` routing. */
    countFree: z.boolean().default(false),
    /**
     * A tag for which agents are shown its models, myna's Family
     * (`internal/provider/provider.go`, Family). No runtime reads it yet;
     * `neolix provider set <id> family=…` persists it.
     */
    family: z.string().optional(),
    /**
     * Where requests go when this provider is out of quota, rate limited or
     * down: `provider/model` or `group/<id>`, in order. myna's Fallback
     * (`internal/cli/providers_cli.go`, `provider fallback`). Routing reads
     * it; empty is none.
     */
    fallback: z.array(z.string().min(1)).default([]),
    /**
     * How requests spread over this provider's keys or accounts, myna's
     * Routing. Manual and cheapest are a group's, not a provider's
     * (`internal/cli/providers_cli.go`, `provider set … routing=`).
     */
    routing: z
      .union([
        z.enum(["smart", "order", "rotate", "usage", "pace", "weight", "free", "fast", "drain"]),
        PluginRoutingStrategyName,
      ])
      .optional(),
    /** The endpoint a model list is fetched from, when it is not the vendor's own; myna's ModelsURL. */
    modelsUrl: z.string().url().optional(),
    /** The preset this provider was added from, myna's Provider.Preset; region= and plan= read its Regions. */
    preset: z.string().optional(),
    /**
     * On the Cline API: a request for a maker's model is pinned to the
     * maker's own API (DeepSeek by DeepSeek, GLM by Z.ai), which keeps its
     * prompt cache (myna's PinUpstream, provider.go:377 — see ClinePin).
     */
    pinUpstream: z.boolean().optional(),
    /**
     * The root of a decision API (myna's Provider.Decide, TypeSafe's System
     * One): the provider routes routing groups, and its models are never an
     * agent's. A Bailian workspace stands in it as `{WorkspaceId}`.
     */
    decide: z.string().min(1).optional(),
    /**
     * A Volcengine account's access key, or a Tencent Cloud SecretId, whose
     * access secret lets its Coding/Agent Plan or Token Plan usage be read
     * (myna's AccessKeyID, provider.go:68-76).
     */
    accessKeyId: z.string().optional(),
    /** The access key's secret, myna's SecretAccessKey. */
    secretAccessKey: z.string().optional(),
    /** The vendor's home page, shown by `neolix provider <id>`; myna's Website. */
    website: z.string().optional(),
    /** Where the vendor's API keys are made; myna's KeysURL. */
    keysUrl: z.string().optional(),
    /** The catalog this provider takes prices from; myna's Catalog. */
    catalog: z.string().optional(),
    /**
     * Send the User-Agent the agent gave, not the gateway's own, for a plan
     * that serves only the agents it names (myna's `user-agent=agent`).
     */
    passUserAgent: z.boolean().optional(),
    /** Send Antigravity's system prompt exactly as written (myna's `prompt=as-written`). */
    promptAsWritten: z.boolean().optional(),
    /** Send Codex's Responses requests as Codex sent them (myna's `codex=as-sent`). */
    codexAsSent: z.boolean().optional(),
    /**
     * Where a tool Claude Code's tool search loads goes on a Responses API:
     * `on` keeps it as an `additional_tools` item, `off` puts it with the
     * other tools, absent is myna's default (myna's `additional-tools=`).
     */
    additionalTools: z.enum(["on", "off", "default"]).optional(),
    /**
     * How long a request addressed to this provider alone is kept while it
     * is busy or briefly rate limited; 0 is no patience, absent is myna's
     * one minute (myna's `patience=`).
     */
    patienceMs: z.number().int().nonnegative().optional(),
    /**
     * Have the gateway fetch this provider's model list again once it is
     * this old; absent is only when asked (myna's `refresh-every`).
     */
    refreshEveryMs: z.number().int().positive().optional(),
    /**
     * When its model list was last fetched, in epoch ms (myna's Fetched): the
     * scheduler reads it to know a list is due, and the gateway writes it
     * after every fetch. Only the daemon writes it.
     */
    listFetchedAt: z.number().int().nonnegative().optional(),
    /**
     * Glob or `re:` rules that expose a newly listed model, in any case;
     * myna's AutoInclude (`provider auto-include`).
     */
    autoInclude: z.array(z.string().min(1)).optional(),
    /**
     * How long a key sits out after an allowance refusal that names no
     * reset time, or the time of day a daily allowance comes back; myna's
     * QuotaRest and QuotaResetAt (`provider quota-rest`).
     */
    quotaRest: z
      .object({
        /** A duration, in seconds; 0 is myna's own default (15 minutes). */
        seconds: z.number().int().nonnegative().optional(),
        /** "HH:MM" or "HH:MM+08:00", a daily allowance's comeback time. */
        resetAt: z.string().optional(),
      })
      .strip()
      .optional(),
    /**
     * The most a key or account rests while it keeps failing or being rate
     * limited; 0 means an unknown failure does not rest it at all
     * (myna's RestCapOff). Absent is myna's own cap.
     */
    restCapMs: z.number().int().nonnegative().optional(),
    /**
     * How many requests may wait for each account or key past its limit;
     * absent or 0 is no bound (myna's QueueLimit, `provider queue`).
     */
    queueLength: z.number().int().nonnegative().optional(),
    /** Answer 429 at the pool's caps instead of going on to the fallbacks (myna's CapStop). */
    stopAtCap: z.boolean().optional(),
    /** The upstream itself answers a web search tool (Anthropic and Responses only). */
    searches: z.boolean().optional(),
    /**
     * A capped account near its cap is read again before a request goes to
     * it, and held while its usage can't be told (myna's CapCareful).
     */
    capCareful: z.boolean().optional(),
    /**
     * Codex compacts natively here: its compaction_trigger and the sealed
     * compaction item go as Codex sent them, for a wire that carries them
     * (a Responses API). Off, the gateway summarises the conversation itself.
     */
    nativeCompaction: z.boolean().optional(),
    /** Where the provider reports what is left on its key; `{key}` takes the key. */
    balanceUrl: z.string().url().optional(),
    /** The amount's field in that reply, dot-separated (`data.balance`). */
    balancePath: z.string().min(1).optional(),
    /** How the balance URL is asked; POST carries no body. */
    balanceMethod: z.enum(["GET", "POST"]).optional(),
    /** An account's own token, asked instead of the key where a vendor wants one. */
    balanceToken: z.string().min(1).optional(),
    /** How many accounts of this provider may serve at once; the rest wait as reserve. */
    maxAccounts: z.number().int().positive().optional(),
    /** How long a request waits for a free slot before falling back. 0 disables waiting. */
    queueWaitMs: z.number().int().nonnegative().default(0),
    /** A 429 with allowance left moves the account to the back instead of resting it. */
    sink: z.boolean().default(false),
    /** Multiplier applied to this provider's list price. */
    priceRate: z.number().positive().default(1),
    /**
     * Time-of-day multipliers, myna's RateWindows: the first window that holds
     * a call's local time wins, at most eight of them. A start after the end
     * wraps past midnight and belongs to the day it starts on.
     */
    rateWindows: z.array(GatewayRateWindowSchema).max(8).optional(),
    /** COMPAT(rateWindows): the one peak window gateway.json used to carry. */
    peak: z
      .object({
        startHour: z.number().int().min(0).max(23),
        endHour: z.number().int().min(0).max(23),
        rate: z.number().positive(),
      })
      .strip()
      .optional(),
    models: z.array(GatewayModelSchema).default([]),
    /** Which video API the provider speaks; inferred from its host when unset. */
    videoApi: z.enum(["openai", "ark", "minimax", "grok"]).optional(),
  })
  .strip();

/** A provider's rate windows, a legacy peak read as one of them. */
export function rateWindowsOf(provider: {
  rateWindows?: GatewayRateWindow[];
  peak?: { startHour: number; endHour: number; rate: number };
}): GatewayRateWindow[] | undefined {
  return provider.rateWindows ?? legacyRateWindows(provider.peak);
}

/**
 * The config as stored: the groups the gateway finds are derived on every
 * read (groups-auto.ts), so a write never keeps one. An edited found group
 * arrives without the flag, and is the user's from then on.
 */
function withoutFoundGroups(config: GatewayConfig): GatewayConfig {
  return config.groups.some((group) => group.auto === true)
    ? { ...config, groups: config.groups.filter((group) => group.auto !== true) }
    : config;
}

/**
 * COMPAT(rateWindows): a config written before the windows existed carries one
 * peak window. Loading turns it into the equivalent rate window, so every
 * reader sees the one shape; remove after 2027-11-05.
 */
function normalizeRateWindows(config: GatewayConfig): GatewayConfig {
  const providers = config.providers.map((provider) =>
    provider.rateWindows === undefined && provider.peak !== undefined
      ? { ...provider, rateWindows: legacyRateWindows(provider.peak), peak: undefined }
      : provider,
  );
  return { ...config, providers };
}

/** The one peak window older configs carry, as a RateWindow. */
function legacyRateWindows(
  peak: { startHour: number; endHour: number; rate: number } | undefined,
): GatewayRateWindow[] | undefined {
  if (peak === undefined) {
    return undefined;
  }
  const clock = (hour: number) => `${String(hour).padStart(2, "0")}:00`;
  return [{ start: clock(peak.startHour), end: clock(peak.endHour), rate: peak.rate }];
}

const GatewayPriceTierSchema = z
  .object({
    /** The prompt size the whole request is billed at this price from, over it. */
    aboveTokens: z.number().int().positive(),
    inputPerMTok: z.number().nonnegative(),
    outputPerMTok: z.number().nonnegative(),
    cacheReadPerMTok: z.number().nonnegative().optional(),
    cacheWritePerMTok: z.number().nonnegative().optional(),
    cacheWrite1hPerMTok: z.number().nonnegative().optional(),
  })
  .strip();

const GatewayPriceSchema = z
  .object({
    inputPerMTok: z.number().nonnegative().default(0),
    outputPerMTok: z.number().nonnegative().default(0),
    /** Cache reads, per million tokens. */
    cacheReadPerMTok: z.number().nonnegative().optional(),
    /** Cache writes kept 5 minutes, per million tokens. */
    cacheWritePerMTok: z.number().nonnegative().optional(),
    /** Cache writes kept an hour; a Claude model's is 2× input when unset. */
    cacheWrite1hPerMTok: z.number().nonnegative().optional(),
    tiers: z.array(GatewayPriceTierSchema).optional(),
  })
  .strip();

const GatewayBudgetSchema = z
  .object({
    /** Across every provider, in USD, per calendar month. */
    monthlyUsd: z.number().positive().optional(),
  })
  .strip();

const GatewayRecordingSchema = z
  .object({
    /** Off unless the reader opts in from Settings → Use → Sessions. */
    enabled: z.boolean().default(false),
  })
  .strip();

const GatewayKeySchema = z.union([
  z.string().min(1),
  z
    .object({
      key: z.string().min(1),
      /**
       * The key's own name, as myna's Key.ID (12 random bytes in hex): what
       * `neolix gateway-key <id>` names it by. Absent on keys written before
       * this field, which are still named by their label or secret.
       */
      id: z.string().min(1).optional(),
      label: z.string().min(1).optional(),
      /** Model ids or `group/*`; empty means every model. */
      models: z.array(z.string().min(1)).default([]),
      /**
       * The accounts and keys it may use, `provider/account` (myna's
       * Key.Accounts): a provider it names none of keeps all of them.
       * Empty means every account.
       */
      accounts: z.array(z.string().min(1)).optional(),
      /**
       * Whether a key held to a budget, models or accounts is told the
       * quotas of what it may use (myna's Key.Quotas). Off when absent.
       */
      quotas: z.boolean().optional(),
      /** COMPAT(keyLimits): the day-token and month-dollar caps before `limits`. */
      dailyTokens: z.number().int().positive().optional(),
      monthlyUsd: z.number().positive().optional(),
      /**
       * This key's budget windows, at most five, each holding it on its own
       * (myna access.Key.Limits). A request passes only while every one has
       * something left. Older configs' dailyTokens and monthlyUsd are read as
       * the equivalent day-token and month-cost limits.
       */
      limits: z.array(GatewayKeyLimitSchema).max(5).optional(),
      /** Requests per minute. */
      ratePerMinute: z.number().int().positive().optional(),
      /** Search calls this key may make per calendar month. */
      searchCallsPerMonth: z.number().int().positive().optional(),
      /** Only read endpoints; inference is refused. */
      readOnly: z.boolean().default(false),
      /** ISO timestamp after which the key is refused. */
      expiresAt: z.string().optional(),
      /** This key may mint child keys from its own limits. */
      issues: z.boolean().default(false),
      /** Set on keys minted through /v1/myna/keys. */
      issuer: z.string().optional(),
    })
    .strip(),
]);

const GatewayGroupTimeSchema = z
  .object({
    /** "HH:MM"; To before From wraps past midnight. */
    from: z.string().regex(/^\d{2}:\d{2}$/),
    to: z.string().regex(/^\d{2}:\d{2}$/),
    /** "mon" … "sun"; empty means every day. A window past midnight belongs to the day it starts. */
    days: z.array(z.string()).optional(),
    /** IANA zone the hours were set in; absent means this computer's clock. */
    zone: z.string().optional(),
  })
  .strip();

/**
 * A group's rule: the first matching one sends the request to its members
 * first, in order. A pause rule instead leaves its member out while it holds.
 */
export const GatewayGroupRuleSchema = z
  .object({
    use: z.string().min(1),
    /** Tried after `use`, in order, before the group's other members. */
    more: z.array(z.string().min(1)).optional(),
    /** The reasoning asked of `use`, whatever the agent asked. */
    useEffort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
    /** The request is at least this long, in estimated tokens. */
    tokens: z.number().int().positive().optional(),
    images: z.boolean().optional(),
    /** The agent asked for reasoning at least this level, or "on" for any. */
    effort: z.string().min(1).optional(),
    agents: z.array(z.string().min(1)).optional(),
    time: GatewayGroupTimeSchema.optional(),
    pause: z.boolean().optional(),
    /** Kept so a myna config round-trips; the gateway cannot judge it and the rule holds for nothing. */
    intent: z.string().optional(),
    compact: z.boolean().optional(),
    folders: z.array(z.string()).optional(),
    exceptFolders: z.array(z.string()).optional(),
  })
  .strip();

const GatewayGroupSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/),
    label: z.string().min(1).optional(),
    /** `provider/model`, `provider/model:effort`, or `group/<id>`, in order. */
    members: z.array(z.string().min(1)).min(1),
    strategy: z
      .union([
        z.enum([
          "order",
          "rotate",
          "least-used",
          "smart",
          "pace",
          "free",
          "fast",
          "cheap",
          "drain",
        ]),
        PluginRoutingStrategyName,
      ])
      .default("order"),
    /**
     * Only the picked member is used (myna's Manual routing): the others
     * and the rules wait until another is picked. A field of its own
     * rather than a strategy value, so a client from before it still
     * parses the group.
     */
    manual: z.boolean().optional(),
    /**
     * How long a conversation stays with the account or key that answered
     * it (myna's Group.Affinity): `auto` while its cache is worth keeping,
     * `session` for the whole session, `turn` only within one turn, `off`
     * never, `strict` for the whole session and never moved.
     */
    affinity: z.enum(["auto", "session", "turn", "off", "strict"]).optional(),
    /**
     * How long, in milliseconds, a request may be kept once every member
     * has failed in a way that passes (myna's Group.Patience): 0 hands the
     * agent the last error at once, absent waits the 60s a group that sets
     * none waits, and a value is at most 240s.
     */
    patience: z.number().int().min(0).max(240_000).optional(),
    /** A tag for `neolix visible`'s families (myna's Group.Family). */
    family: z.string().min(1).optional(),
    /**
     * The models in it leave the lists agents see, offered through the
     * group alone (myna's Group.Unlists, `listed=no`).
     */
    unlists: z.boolean().optional(),
    /**
     * Whether the classifier picks each turn's reasoning (myna's
     * Group.Effort == EffortAuto) or the agent's own level stands.
     */
    effort: z.enum(["agent", "auto"]).optional(),
    /** Turns members by weight, smoothly, instead of by `strategy`. */
    weighted: z.boolean().optional(),
    /** Each member's share when weighted; one not named weighs 1. */
    weights: z.record(z.string(), z.number().int().positive()).optional(),
    /** Members sent in their vendor's fast mode. */
    fast: z.array(z.string().min(1)).optional(),
    /** Accounts (`provider/account`) the group is held to; providers not named keep all. */
    accounts: z.array(z.string().min(1)).optional(),
    rules: z.array(GatewayGroupRuleSchema).optional(),
    /** Glob or `re:` patterns whose matching models join the group after its members. */
    match: z.array(z.string().min(1)).optional(),
    /** Members switched off: kept in place and out of every request. */
    off: z.array(z.string().min(1)).optional(),
    /** The member a group with no matching rule sends first, when it names one. */
    pick: z.string().min(1).optional(),
    /** Kept on the page but serves nothing, and is skipped where another group names it. */
    disabled: z.boolean().optional(),
    /** The reasoning levels agents are offered for the group, lowest first. */
    levels: z.array(z.enum(["low", "medium", "high", "xhigh", "max"])).optional(),
    /** The window agents are told, in tokens; -1 tells the smallest member's. */
    context: z.number().int().optional(),
    /** The model asked which intent a turn's message is, for rules with `intent`. */
    classifier: z.string().min(1).optional(),
    /**
     * Found by the gateway, not stored: a model more than one provider
     * serves is a group of them (myna's found groups). Editing one saves it
     * as the user's, with this flag gone.
     */
    auto: z.boolean().optional(),
  })
  .strip();

const GatewayOidcRuleSchema = z
  .object({
    id: z.string().optional(),
    /** The gateway key (label or secret) that issues these keys; it must allow issuing. */
    key: z.string().min(1),
    issuer: z.string().url(),
    audience: z.string().optional(),
    /** Every claim must match; a value may be a glob with * and ?. */
    claims: z.record(z.string(), z.string()).default({}),
    ttlSeconds: z.number().int().positive().default(3600),
  })
  .strip();

const GatewaySearchApiSchema = z
  .object({
    vendor: z.string().min(1),
    /** One key, or several separated by commas; each tried in turn or in order. */
    key: z.string().optional(),
    /** Its address, for a SearXNG or one the user runs. */
    url: z.string().url().optional(),
    /** `order` asks the first key until it is refused; unset takes them in turn. */
    pick: z.enum(["", "order"]).optional(),
    /** Kept, key and all, out of every search until switched on again. */
    off: z.boolean().optional(),
  })
  .strip();

const GatewaySearchSchema = z
  .object({
    enabled: z.boolean().default(false),
    /** Tavily-compatible search endpoint. */
    url: z.string().url().default("https://api.tavily.com/search"),
    apiKey: z.string().optional(),
    /** Calls per calendar month across every key; null means no cap. */
    monthlyCalls: z.number().int().positive().nullish(),
    /** Search APIs asked in this order for a search (myna's Searches). */
    apis: z.array(GatewaySearchApiSchema).default([]),
    /**
     * The provider that searches for a model that can't, myna's Searcher:
     * `<provider>` (its pick of a model that can search), `<provider>/<model>`,
     * "off" to use only the Search APIs, or absent for the gateway's pick.
     */
    searcher: z.string().optional(),
    /** The searchers asked in turn when that one fails, in this order (myna's SearcherThen). */
    searcherThen: z.array(z.string()).optional(),
    /** Which is asked first when both can: "" or "model" is the provider (myna's SearchFirst). */
    searchFirst: z.enum(["", "model", "api"]).optional(),
    /** Search for every model, even one whose provider searches by itself (myna's SearchAll). */
    searchAll: z.boolean().optional(),
  })
  .strip();

const GatewayMaskRuleSchema = z
  .object({
    kind: z.string().min(1),
    /** A prefix matches itself followed by 8+ key characters (myna's Rule). */
    prefix: z.string().optional(),
    /** Empty while the settings row is still being typed; the masker skips it. */
    pattern: z.string(),
    flags: z.string().optional(),
  })
  .strip();

const GatewayMaskingSchema = z
  .object({
    enabled: z.boolean().default(false),
    /**
     * Emails, phone numbers, ID and bank card numbers and the kinds under
     * them; none of them masks while this is off, whatever its own switch
     * says (myna's RedactPersonal, off until turned on).
     */
    personal: z.boolean().default(false),
    allow: z.array(z.string().min(1)).default([]),
    /** Empty means every built-in category. */
    categories: z.array(z.string().min(1)).default([]),
    /** Mask unless a kind says warn (send as written) or block (hold back). */
    actions: z.record(z.string(), z.enum(["mask", "warn", "block"])).default({}),
    /** A key goes as a made-up key of its form, not a placeholder. */
    shape: z.boolean().default(false),
    /** Opt-in detectors; absent categories stay off, as in myna. */
    categorySwitches: z.record(z.string(), z.boolean()).default({}),
    /** The user's own words, masked as written unless anyCase says otherwise. */
    words: z.array(z.string()).default([]),
    /** A word also matches in other capitals (myna's redactWordsAnyCase). */
    wordsAnyCase: z.boolean().default(false),
    /** A word is not masked inside a longer one (myna's redactWordsWhole). */
    wordsWhole: z.boolean().default(false),
    /**
     * The model a request goes to as written when masking would change it
     * (myna's RedactRouteTo, "provider/model"); empty masks as before.
     */
    routeTo: z.string().optional(),
    /** The local model masking asks: `astrlink-guard`; empty is off. */
    model: z.string().optional(),
    /** The score its finds need, 0.5–0.95; absent is 0.8. */
    modelScore: z.number().min(0.5).max(0.95).optional(),
    /** Tell the client when a value is masked for the first time. */
    alert: z.boolean().default(false),
    rules: z.array(GatewayMaskRuleSchema).default([]),
  })
  .strip();

const GatewayOverrideSchema = z
  .object({
    model: z.string().min(1).optional(),
    set: z.record(z.string(), z.unknown()).default({}),
    remove: z.array(z.string().min(1)).default([]),
  })
  .strip();

const GatewayMiddlewareSchema = z
  .object({
    aliases: z.record(z.string(), z.string()).default({}),
    overrides: z.array(GatewayOverrideSchema).default([]),
    /** JavaScript sources run with `ctx` in scope; see docs/llm-gateway.md. */
    hooks: z
      .object({
        request: z.string().optional(),
        provider: z.string().optional(),
        account: z.string().optional(),
        response: z.string().optional(),
        event: z.string().optional(),
      })
      .strip()
      .optional(),
  })
  .strip();

export const GatewayConfigSchema = z
  .object({
    version: z.literal(1).default(1),
    enabled: z.boolean().default(true),
    /**
     * The addresses other computers may reach the gateway from, as IPs and
     * CIDR ranges (myna's allowIPs). Empty lets every address in; this
     * computer is always let in.
     */
    allowIPs: z.array(z.string()).default([]),
    /**
     * Web origins (scheme://host[:port]) and extension origins allowed to
     * call the gateway from a browser with a key (myna's corsOrigins).
     */
    corsOrigins: z.array(z.string()).default([]),
    keys: z.array(GatewayKeySchema).default([]),
    /** Keyed by `provider/model`, `provider/*`, or a bare model id for every provider. */
    pricing: z.record(z.string(), GatewayPriceSchema).default({}),
    /** `provider/model` → the model id whose maker's price it borrows. */
    modelSameAs: z.record(z.string(), z.string()).default({}),
    /** The name a vendor is asked for a model by, `*` in it the model (myna ModelWires). */
    modelWires: z.record(z.string(), z.string()).optional(),
    /** The id a model is listed and routed by (myna ModelIDs), keyed by that id. */
    modelIDs: z.record(z.string(), z.string()).optional(),
    /**
     * What each agent's model lists are narrowed to, by agent id (lower-case):
     * family tags and provider/group ids, myna's Settings.Visible and
     * `provider.VisibleTo` (`internal/provider/visible.go:39-52`). An agent
     * not named sees everything.
     */
    visible: z.record(z.string(), z.array(z.string().min(1))).default({}),
    /**
     * Models taken out of an agent's lists one by one, `provider/model` ids,
     * myna's Settings.HiddenModels (`visible.go:126-133`).
     */
    hiddenModels: z.record(z.string(), z.array(z.string().min(1))).default({}),
    /**
     * An agent named here is shown those entries alone; naming it with an
     * empty list shows it nothing. myna's Settings.PickedModels, where the
     * key's presence is the "only picked" switch (`visible.go:139-149`).
     */
    pickedModels: z.record(z.string(), z.array(z.string().min(1))).default({}),
    /** Models turned off everywhere: ids or globs, `*` any run, `?` one (myna DisabledModels). */
    disabledModels: z.array(z.string()).optional(),
    /** The reasoning levels a model offers (myna ModelEfforts), `provider/model` keys. */
    modelEfforts: z.record(z.string(), z.array(z.string())).optional(),
    /** Models sent no reasoning field at all (myna ModelReasonless). */
    modelReasonless: z.record(z.string(), z.boolean()).optional(),
    /** Bare model id → the id its usage is counted under (myna UsageAliases). */
    usageAliases: z.record(z.string(), z.string()).optional(),
    budget: GatewayBudgetSchema.optional(),
    /** Local copies of gateway conversations; off unless opted in. */
    recording: GatewayRecordingSchema.optional(),
    masking: GatewayMaskingSchema.optional(),
    oidc: z.object({ rules: z.array(GatewayOidcRuleSchema).default([]) }).optional(),
    search: GatewaySearchSchema.optional(),
    /** myna-style MCP names to the JSON-RPC endpoint that serves them. */
    mcp: z.record(z.string(), z.string().url()).optional(),
    /** Base URL of a Codex backend, for `/backend-api/codex/*`. */
    codexBackend: z.string().url().optional(),
    /**
     * Whether the gateway may read the agents' own sign-ins at all (myna's
     * `AccountDiscoveryOff`): Codex's ChatGPT sign-in, and Copilot's editors
     * and CLI. Off leaves every credential file and keychain item unread.
     */
    accountDiscovery: z.boolean().optional(),
    /**
     * The switch `accountDiscovery` replaced. Read as the fallback while
     * configs written before it exist; `neolix accounts discovery` writes the
     * new key.
     */
    // COMPAT(codexAccountDiscovery): added in v0.16.0, remove after 2027-11-06.
    codexAccountDiscovery: z.boolean().default(true),
    /**
     * The vendors whose daily check-in (签到) the gateway presses, and the
     * accounts left out of it, myna's WorkBuddyCheckin, MiniMaxCheckin,
     * TraeCheckin, QoderCheckin and CheckinOff. Absent is off for every
     * vendor, as myna's switches are. `plugins` keeps a plugin provider's
     * own switch by its id.
     */
    checkin: z
      .object({
        workbuddy: z.boolean().optional(),
        minimax: z.boolean().optional(),
        trae: z.boolean().optional(),
        qoder: z.boolean().optional(),
        plugins: z.record(z.string(), z.boolean()).optional(),
        /** Account keys (`workbuddy|<uid>`, `minimax-code|<uid>`) left out. */
        off: z.array(z.string().min(1)).optional(),
      })
      .strip()
      .optional(),
    /**
     * Whether a renewed Codex sign-in may be written back to auth.json or
     * the keychain item. On as myna is; off reads it as it is and never
     * refreshes, so nothing of Codex's is touched.
     */
    codexSignInWriteBack: z.boolean().default(true),
    /**
     * Whether neolix may sign Codex in to the next account with room by
     * itself, writing Codex's own auth.json (`codex_switch.go`). Off by
     * default; it needs `switchOnly` on as well. The user has not decided.
     */
    codexAutoSwitchSignIn: z.boolean().default(false),
    /**
     * The same for Claude Code's own sign-in; off by default, and useful
     * only with `switchOnly`. Page-subs' Claude write-back switch is the
     * sibling of this one.
     */
    claudeAutoSwitchSignIn: z.boolean().default(false),
    /**
     * Whether `accounts switch claude` may write a saved sign-in back into
     * Claude Code's own store. Off by default: the Claude subscription
     * bridge is not decided yet, and until it is, Neolix only keeps and
     * imports these accounts, never touches ~/.claude or its keychain item.
     */
    claudeSignInWriteBack: z.boolean().default(false),
    /**
     * Which agents' session files may be read, as myna's sessionReads: not
     * asked means none, then each named agent as it says and the rest by
     * `all`.
     */
    codexSessionReads: z
      .object({
        asked: z.boolean().default(false),
        all: z.boolean().optional(),
        agents: z.record(z.string(), z.boolean()).optional(),
      })
      .passthrough()
      .optional(),
    /** Show a sign-in link to copy instead of opening the browser (myna's signInLinkOnly). */
    codexSignInLinkOnly: z.boolean().default(false),
    /**
     * How `/v1/models` names a model: `on` appends its provider, `off` is the
     * model's own name, `own` keeps the user's custom labels plain and appends
     * the provider to the rest (myna's "Provider in model names").
     */
    modelNames: z.enum(["off", "own", "on"]).default("on"),
    /**
     * `/v1/models` also lists each model by its own id, as `gpt-5.6-sol`
     * beside `codex/gpt-5.6-sol`, for clients moved from another proxy
     * (myna's BareModelIDs). Off by default.
     */
    bareModelIDs: z.boolean().optional(),
    /**
     * A model whose provider reports it busier than this percent goes after
     * the others a request could go to, 1–9999 past 100 for a vendor that
     * queues; 0 is off (myna's BusyLoad).
     */
    busyLoad: z.number().int().min(0).max(9999).optional(),
    /**
     * The model the Image generation MCP server draws with, as
     * `provider/model`, "off" for none, or absent to use the first image
     * model it finds (myna's ImageGen).
     */
    imageGen: z.string().optional(),
    /**
     * Minutes a provider is given to draw an image and send it, 1–60;
     * absent is myna's 5 (ImageTimeout).
     */
    imageTimeout: z.number().int().min(1).max(60).optional(),
    /**
     * Warms a Codex subscription account's windows as they reset, myna's
     * CodexWarmup: "off" never, "week" when the weekly window resets, "all"
     * when the 5-hour one does too. Accounts of providers that aren't a
     * Codex or Claude subscription keep their own account-level switch at
     * the 5-hour cadence.
     */
    codexWarmup: z.enum(["off", "week", "all"]).default("off"),
    /** CodexWarmup for the Claude subscription accounts, myna's ClaudeWarmup. */
    claudeWarmup: z.enum(["off", "week", "all"]).default("off"),
    /**
     * The times of day a Codex account's 5-hour window is started at, local
     * "HH:MM", each once a day, myna's CodexWarmAts: an account whose window
     * isn't running then gets one tiny request, so a day that starts at 06:00
     * fits three windows. Works with or without `codexWarmup`; empty is off.
     */
    codexWarmAts: z.array(z.string()).default([]),
    /** CodexWarmAts for the Claude subscription accounts, myna's ClaudeWarmAts. */
    claudeWarmAts: z.array(z.string()).default([]),
    /**
     * How many minutes before a Codex reset runs out an account let to use
     * one by itself spends it, myna's CodexResetLead: 15 to 1440, absent or
     * out of range is the default of 30 minutes.
     */
    codexResetLead: z.number().int().min(15).max(1440).optional(),
    /**
     * When allowances are read from their vendors, myna's QuotaReads:
     * absent is whenever the poller's timer comes round; "asked" is only
     * when the user asks (the Usage page opened or refreshed, a card's
     * refresh, `neolix usage`), the readings kept standing until then.
     */
    quotaReads: z.enum(["asked"]).optional(),
    /**
     * Starts a Claude subscription's run with the caller's own instructions as
     * its system prompt, in place of Claude Code's, myna's ClaudeLeanPrompt.
     */
    claudeLeanPrompt: z.boolean().default(false),
    /**
     * Runs Claude Code as `claude -p` always; off is its interactive mode,
     * myna's ClaudePrintMode. The interactive mode is not ported yet, so off
     * still runs -p until it is.
     */
    claudePrintMode: z.boolean().default(false),
    /**
     * How many Claude Code processes the subscription may run at once; 0 sizes
     * it from this machine's memory on Linux, myna's ClaudeRunsMost.
     */
    claudeRunsMost: z.number().int().nonnegative().default(0),
    /**
     * Private hosts and ranges (name, name:port, IP or CIDR) a URL the gateway
     * did not choose may be fetched from, myna's FetchPrivate. Empty fetches
     * from public addresses only.
     */
    fetchPrivate: z.array(z.string().min(1)).default([]),
    /**
     * Where Codex's hidden turns go: "" (unset) keeps the model Codex asked
     * for, "off" answers with none and sends it nowhere, anything else is the
     * model id that answers it. myna's CodexTitles/Descriptions/Predictions.
     */
    codexTitles: z.string().optional(),
    codexDescriptions: z.string().optional(),
    codexPredictions: z.string().optional(),
    /**
     * Codex's OpenAI models say multi-agent V1 in the catalog Neolix hands
     * it, myna's CodexAgentsV1: a GPT lead's subagent tasks then go as
     * text, so they can run on Neolix's models. Codex's own
     * `features.multi_agent_v2` in the config still wins.
     */
    codexAgentsV1: z.boolean().optional(),
    /**
     * The model the gateway puts every Codex subagent on, whatever its
     * lead names, myna's CodexSubagentModel; "" is the lead's pick and
     * "lead" its own model. A subagent whose task a ChatGPT-backed lead
     * sealed stays on the model asked for.
     */
    codexSubagentModel: z.string().optional(),
    /**
     * Tells Codex and Claude Code a model's whole context window, myna's
     * FullContext; off, a longer one is told as `compactAt` or 272k.
     */
    fullContext: z.boolean().optional(),
    /** The window a longer one is told as, in tokens, myna's CompactAt; 0 is 272k. */
    compactAt: z.number().int().nonnegative().optional(),
    /**
     * Codex's background compaction, myna's CodexAsyncCompact: Codex sends
     * a compaction trigger of its own mid-turn once the conversation is
     * past `codexAsyncCompactPercent` of the model's window.
     */
    codexAsyncCompact: z.boolean().optional(),
    /** That share of the window, 1–100; 0 is Codex's own 65, myna's CodexAsyncCompactPercent. */
    codexAsyncCompactPercent: z.number().int().min(0).max(100).optional(),
    /**
     * The model Codex's auto-review runs on, myna's CodexAutoReview: ""
     * Codex's own pick, "session" the conversation's own, else a model id.
     */
    codexAutoReview: z.string().optional(),
    /**
     * The model Codex writes its memories with, myna's CodexMemories: a
     * model id, or "" for Codex's own. Written into both [memories]
     * extract_model and consolidation_model.
     */
    codexMemories: z.string().optional(),
    /**
     * How Codex takes Neolix's models, myna's Codex login setting: "" (its
     * ChatGPT sign-in, Neolix joining as a provider), "chatgpt" (always
     * ChatGPT) or "api" (Neolix API alone). Kept here, not in Codex's
     * config, as myna keeps it in its settings.
     */
    codexLogin: z.string().optional(),
    /**
     * What a reply's `model` field says: asked (unset) is the model the
     * client asked for, member the provider/model that answered, vendor the
     * vendor's own model name. myna's ReplyModel.
     */
    replyModel: z.enum(["asked", "member", "vendor"]).optional(),
    /** COMPAT(memberModel): ReplyModel "member" before ReplyModel existed. */
    memberModel: z.boolean().optional(),
    /**
     * Notify when a gateway-served turn ran at least this many seconds, from
     * the user's prompt to its last reply (myna's TurnDoneAlert); 0 is off.
     * Timed here, in the gateway, which is the only place that sees turns.
     */
    turnDoneSeconds: z.number().int().min(0).max(3600).optional(),
    /** Lets a streamed reply run on when its text or reasoning loops. */
    noLoopGuard: z.boolean().optional(),
    /** How many more times a safety-refused request is asked (0 = none). */
    refusalRetries: z.number().int().min(0).optional(),
    /** Seconds a routing group's intent classifier is given (myna's ClassifyTimeout); absent is 8. */
    classifyTimeout: z.number().int().positive().optional(),
    /**
     * Proxy every upstream request without an account proxy of its own:
     * "direct" for none, a socks5:// address, or "" (absent) to follow
     * *_PROXY and then the system's proxy, as myna's settings.Proxy does.
     */
    proxy: ProxyAddressSchema.optional(),
    /**
     * Optional OTLP/HTTP trace export of gateway requests. The endpoint is a
     * base URL (Langfuse's `/api/public/otel` included); spans go to
     * `/v1/traces`. Export failures never affect a request.
     */
    otel: z
      .object({
        enabled: z.boolean().default(false),
        endpoint: z.string().url().optional(),
        headers: z.record(z.string(), z.string()).optional(),
        /** Also send duration and token histograms to /v1/metrics. */
        metrics: z.boolean().default(false),
        /** Attach the request and reply bodies (masked, 256 KiB) to the span. */
        bodies: z.boolean().default(false),
        /** Send them whole rather than cut at 256 KiB, myna's settings.OTel.BodiesWhole. */
        bodiesWhole: z.boolean().default(false),
        /**
         * Trace the agents' local conversations as well, including calls that
         * never went through the gateway, myna's OTel.Sessions. Off unless on.
         */
        sessions: z.boolean().default(false),
      })
      .strip()
      .optional(),
    middleware: GatewayMiddlewareSchema.optional(),
    /**
     * Image recognition. `model` names the `provider/model` that describes
     * images to text-only models; "off" turns it off; absent picks the first
     * served model marked `images: true`.
     */
    vision: z
      .object({
        model: z.string().min(1).optional(),
        effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
      })
      .strip()
      .optional(),
    /**
     * The request archive on this computer, myna's RequestArchiveLocal: each
     * POST's request and response, secrets taken out, in
     * `$NEOLIX_HOME/request-archive/<date>/<id>.json`. `maxMB` is how much of
     * each body is kept (32 unless set); `keepMB` is the folder's cap (1 GiB
     * unless set), the oldest calls going first.
     */
    archive: z
      .object({
        local: z.boolean().default(false),
        maxMB: z.number().int().positive().optional(),
        keepMB: z.number().int().positive().optional(),
      })
      .strip()
      .optional(),
    providers: z.array(GatewayProviderSchema).default([]),
    groups: z.array(GatewayGroupSchema).default([]),
    /**
     * Whether the gateway finds groups on its own (myna's NoAutoGroups, on
     * until turned off): a model more than one provider serves is a group of
     * them. Absent is on.
     */
    autoGroups: z.boolean().optional(),
    /** Provider ids kept out of the found groups, myna's AutoGroupSkip. */
    autoGroupSkip: z.array(z.string()).optional(),
    /** The order the page lists groups in, myna's GroupOrder; unlisted ones follow. */
    groupOrder: z.array(z.string()).optional(),
    /** Found groups the user hid, myna's removed found groups; the ids are kept. */
    hiddenGroups: z.array(z.string()).optional(),
  })
  .strip();

export type GatewayModel = z.infer<typeof GatewayModelSchema>;
export type GatewayProvider = z.infer<typeof GatewayProviderSchema>;
export type GatewayAccount = z.infer<typeof GatewayAccountSchema>;
export type GatewayGroup = z.infer<typeof GatewayGroupSchema>;
export type GatewayGroupRule = z.infer<typeof GatewayGroupRuleSchema>;
export type GatewayKey = z.infer<typeof GatewayKeySchema>;
export type GatewayHooks = NonNullable<NonNullable<GatewayConfig["middleware"]>["hooks"]>;
export type GatewayPrice = z.infer<typeof GatewayPriceSchema>;
export type GatewayRateWindow = z.infer<typeof GatewayRateWindowSchema>;
export type GatewayConfig = z.infer<typeof GatewayConfigSchema>;

/**
 * Whether the agents' own sign-ins may be read (myna's `AccountDiscoveryOff`,
 * checked before every switch and read). The general key answers; the
 * Codex-only key it replaced still does for configs written before it, and
 * absent both means on, as myna's default.
 */
export function accountDiscoveryOn(config: GatewayConfig | undefined): boolean {
  // COMPAT(codexAccountDiscovery): added in v0.16.0, remove after 2027-11-06.
  const switchValue = config?.accountDiscovery ?? config?.codexAccountDiscovery;
  return switchValue !== false;
}

export const EMPTY_GATEWAY_CONFIG: GatewayConfig = GatewayConfigSchema.parse({});

/**
 * Codex's native compaction can be turned on only where the wire carries it:
 * a Responses API. Another protocol would be sent a trigger it can't answer
 * and would refuse the turn, so the setting is rejected as myna rejects it.
 */
function refuseUncarriedNativeCompaction(config: GatewayConfig): void {
  for (const provider of config.providers) {
    if (provider.nativeCompaction === true && provider.protocol !== "openai-responses") {
      throw new Error(
        `Invalid gateway config: ${provider.id} can't carry Codex's native compaction: only a provider with a Responses API can`,
      );
    }
  }
}

/** A provider is on unless it was switched off; the field is absent on older files. */
export function isProviderEnabled(provider: GatewayProvider): boolean {
  return provider.enabled !== false;
}

/** A bare `apiKey` on the provider is its only, implicit account. */
export function providerAccounts(provider: GatewayProvider): GatewayAccount[] {
  if (provider.accounts.length > 0) {
    return provider.accounts;
  }
  if (provider.apiKey === undefined) {
    return [];
  }
  return [
    {
      id: "default",
      weight: 1,
      priority: 0,
      enabled: true,
      models: [],
      warmup: false,
      warmAt: "",
      apiKey: provider.apiKey,
    },
  ];
}

export function isKeyEntry(key: GatewayKey): key is Exclude<GatewayKey, string> {
  return typeof key !== "string";
}

/** Normalised view of `keys`, used by the access rules. */
export function gatewayKeyEntries(config: GatewayConfig): Exclude<GatewayKey, string>[] {
  return config.keys.map((entry) =>
    typeof entry === "string" ? { key: entry, models: [], readOnly: false, issues: false } : entry,
  );
}

/**
 * Configs written before Mask personal data had a switch masked personal
 * data whenever masking itself was on: `enabled` was the only switch then.
 * An absent `personal` on such a config reads as on, and the first write
 * stores it, so a settings page cannot turn it off by accident.
 */
// COMPAT(maskingPersonalDefault): added in v0.17.0, remove after 2027-11-06.
function withLegacyMaskingPersonal(input: unknown): unknown {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return input;
  }
  const masking = (input as Record<string, unknown>).masking;
  if (typeof masking !== "object" || masking === null || Array.isArray(masking)) {
    return input;
  }
  const fields = masking as Record<string, unknown>;
  if (fields.personal !== undefined || fields.enabled !== true) {
    return input;
  }
  return { ...input, masking: { ...fields, personal: true } };
}

export interface GatewayConfigStoreOptions {
  neolixHome: string;
  logger: Logger;
}

/**
 * Serves `$NEOLIX_HOME/gateway.json` from memory and reloads it when the file
 * changes. Requests never touch the disk.
 *
 * A malformed file disables the gateway rather than serving stale credentials,
 * and the parse error is logged once per revision.
 */
export class GatewayConfigStore {
  public readonly filePath: string;

  private config: GatewayConfig = EMPTY_GATEWAY_CONFIG;
  private loggedError: string | null = null;
  private readonly listeners = new Set<(config: GatewayConfig) => void>();
  private readonly logger: Logger;

  constructor(options: GatewayConfigStoreOptions) {
    this.filePath = path.join(options.neolixHome, GATEWAY_CONFIG_FILENAME);
    this.logger = options.logger;
  }

  public async start(): Promise<void> {
    await this.reload();
    watchFile(this.filePath, { interval: 1000, persistent: false }, (current, previous) => {
      if (current.mtimeMs === previous.mtimeMs && current.size === previous.size) {
        return;
      }
      void this.reload();
    });
  }

  public get(): GatewayConfig {
    return this.config;
  }

  /**
   * Validates and replaces the file in one atomic step. Memory is updated from
   * the parsed value, not from the raw input, so callers cannot install a
   * config the gateway would later reject.
   */
  public async write(input: unknown): Promise<GatewayConfig> {
    const parsed = GatewayConfigSchema.safeParse(withLegacyMaskingPersonal(input));
    if (!parsed.success) {
      throw new Error(`Invalid gateway config: ${parsed.error.message}`);
    }
    refuseUncarriedNativeCompaction(parsed.data);
    const config = withoutFoundGroups(normalizeWarmAtConfig(normalizeRateWindows(parsed.data)));
    // The generation being replaced becomes gateway.json.bak; a file that
    // is itself unreadable is copied aside before it is written over.
    await keepLastGood(this.filePath, isValidJson);
    await writePrivateFileAtomic(this.filePath, `${JSON.stringify(config, null, 2)}\n`);
    this.installProxy(config);
    this.config = config;
    this.loggedError = null;
    this.publish(this.config);
    return config;
  }

  public dispose(): void {
    unwatchFile(this.filePath);
    this.listeners.clear();
  }

  /** Fires after every accepted revision, whether from disk or `write()`. */
  public onChange(listener: (config: GatewayConfig) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private publish(config: GatewayConfig): void {
    for (const listener of this.listeners) {
      listener(config);
    }
  }

  /**
   * Puts the config's proxy into the network layer, which Neolix's own
   * requests and the agents it starts read (myna's settings.Proxy). A
   * change re-installs the dispatcher so the next request takes it; the
   * daemon does not restart.
   */
  private installProxy(config: GatewayConfig): void {
    if ((config.proxy ?? "") === (this.config.proxy ?? "")) {
      return;
    }
    setConfiguredProxy(config.proxy);
    refreshProxy();
  }

  private async reload(): Promise<void> {
    const parsed = GatewayConfigSchema.safeParse(withLegacyMaskingPersonal(await this.readJson()));
    if (parsed.success) {
      const config = normalizeWarmAtConfig(normalizeRateWindows(parsed.data));
      this.installProxy(config);
      this.config = config;
      this.loggedError = null;
      this.publish(this.config);
      return;
    }
    this.installProxy(EMPTY_GATEWAY_CONFIG);
    this.config = EMPTY_GATEWAY_CONFIG;
    if (this.loggedError !== parsed.error.message) {
      this.loggedError = parsed.error.message;
      this.logger.error(
        { err: parsed.error, file: this.filePath },
        "Invalid LLM gateway config; gateway disabled",
      );
    }
  }

  private async readJson(): Promise<unknown> {
    try {
      return JSON.parse(await readFile(this.filePath, "utf8"));
    } catch (error) {
      // A file that is there but unreadable (zeroed by a crash mid-write)
      // gives its last good generation instead of disabling the gateway.
      if (error instanceof UnreadableFileError) {
        return null;
      }
      try {
        return await readJsonLastGood(this.filePath);
      } catch {
        return null;
      }
    }
  }
}
