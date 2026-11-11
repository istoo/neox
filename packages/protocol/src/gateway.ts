import { z } from "zod";

/** Wire shape of `$NEOLIX_HOME/gateway.json`, shared by the settings UI and the daemon. */

export const GatewayProtocolSchema = z.enum(["anthropic", "openai", "openai-responses", "gemini"]);

/** A plugin's strategy, named `<pluginId>/<strategyId>` (myna's `<plugin>/<name>`). */
export const PluginRoutingStrategySchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/);

export const GatewayRoutingStrategySchema = z.union([
  z.enum([
    "order",
    "rotate",
    "least-used",
    "smart",
    "pace",
    /** Free models first, then the paid ones, each in their listed order. */
    "free",
    /** The one that has answered fastest lately first. */
    "fast",
    /** The member whose model costs least at the request's time first. */
    "cheap",
    /** One member until it is used up, then the next, never back. */
    "drain",
  ]),
  PluginRoutingStrategySchema,
]);

export const GatewayModelWireSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().optional(),
    contextWindow: z.number().int().positive().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    /** What the model makes: chat unless said, or an image or a video. */
    kind: z.enum(["chat", "image", "video"]).optional(),
    /** Whether it accepts images. False: the gateway describes them in text first. */
    images: z.boolean().optional(),
    /** Served when the provider's model mode is `picked`. */
    picked: z.boolean().optional(),
    /** The day the vendor released it, for best-in-family tie-breaks. */
    released: z.string().optional(),
  })
  .passthrough();

export const GatewayAccountQuotaWireSchema = z
  .object({
    tokens5h: z.number().int().positive().optional(),
    tokens7d: z.number().int().positive().optional(),
  })
  .passthrough();

export const GatewayAccountWireSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().optional(),
    apiKey: z.string().optional(),
    baseUrl: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    priority: z.number().int().optional(),
    weight: z.number().optional(),
    maxConcurrency: z.number().int().positive().optional(),
    maxRpm: z.number().int().positive().optional(),
    models: z.array(z.string()).optional(),
    monthlyUsd: z.number().positive().optional(),
    /** The Neolix-signed-in ChatGPT account this one spends, from the codex account store. */
    codexAccountId: z.string().optional(),
    /** When it spends a Codex rate-limit reset by itself; absent is off. */
    autoReset: z.enum(["week", "expiring", "auto"]).optional(),
    /** How it spends its credits once a window is used up; absent is "on". */
    creditsMode: z.enum(["on", "first", "last", "off"]).optional(),
    enabled: z.boolean().optional(),
    proxy: z.string().optional(),
    usageUrl: z.string().optional(),
    usageIntervalMs: z.number().int().positive().optional(),
    warmup: z.boolean().optional(),
    /** Its own time of day for that, "off" for none, "" to follow the agent's list. */
    warmAt: z.string().optional(),
    quota: GatewayAccountQuotaWireSchema.optional(),
    /**
     * `claude-code` serves the account's Claude subscription through Claude
     * Code itself; the four sign-ins Neolix runs itself are served by the
     * tokens its account store keeps.
     */
    agent: z
      .enum(["claude-code", "chatgpt-api", "copilot", "gemini", "antigravity", "factory"])
      .optional(),
    /** Which signed-in account this is, by its name in the account store. */
    subscriptionUser: z.string().optional(),
    /** The `CLAUDE_CONFIG_DIR` this account's Claude Code keeps its sign-in in. */
    configDir: z.string().optional(),
  })
  .passthrough();

/** A time-of-day window a provider bills at its own rate, myna's RateWindow. */
export const GatewayRateWindowWireSchema = z
  .object({
    /** 0 = Sunday … 6 = Saturday; absent for every day. */
    days: z.array(z.number().int().min(0).max(6)).optional(),
    /** "HH:MM" on the host's clock; a start after the end wraps past midnight. */
    start: z.string(),
    end: z.string(),
    rate: z.number().positive(),
  })
  .passthrough();

/** Google Vertex AI's project and credentials; present, it signs the provider's requests. */
export const GatewayVertexWireSchema = z
  .object({
    project: z.string().optional(),
    location: z.string().optional(),
    credentials: z.string().optional(),
    impersonate: z.string().optional(),
  })
  .passthrough();

export const GatewayProviderWireSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().optional(),
    protocol: GatewayProtocolSchema,
    baseUrl: z.string(),
    /**
     * A provider of the user's own names an address per API (myna's provider
     * Chat/Responses/Anthropic/Gemini); its models are tried on each in turn.
     */
    wires: z
      .object({
        anthropic: z.string().optional(),
        openai: z.string().optional(),
        "openai-responses": z.string().optional(),
        gemini: z.string().optional(),
      })
      .optional(),
    /** Where its model list is, when it isn't `${baseUrl}/models` (myna's ModelsURL). */
    modelsUrl: z.string().optional(),
    /** When the gateway last fetched its list, in epoch ms (myna's Fetched); read-only. */
    listFetchedAt: z.number().int().nonnegative().optional(),
    /** The tag its models go by in what agents are shown (myna's Family). */
    family: z.string().optional(),
    /** A decision API's address: routing groups ask it, agents never see it (myna's Decide). */
    decide: z.string().optional(),
    /** Google Vertex AI's project, location and credentials, when it is one. */
    vertex: GatewayVertexWireSchema.optional(),
    apiKey: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    /** Headers of the vendor's reply passed on to the agent, beside Request-Id and its kin. */
    replyHeaders: z.array(z.string()).optional(),
    /** Headers of the agent's request passed on to the vendor as sent. */
    passHeaders: z.array(z.string()).optional(),
    accounts: z.array(GatewayAccountWireSchema).optional(),
    /** Switched off, the provider keeps its keys and settings but serves no request. */
    enabled: z.boolean().optional(),
    /**
     * myna's SwitchOnly: the gateway only moves this agent's own sign-in
     * between its accounts, serving no request on them.
     */
    switchOnly: z.boolean().optional(),
    /** myna's RestartApp: restart Codex's app-server for a switch Neolix makes back. */
    restartApp: z.boolean().optional(),
    /** Skip TLS verification for this provider, for a server with its own CA. */
    insecureTls: z.boolean().optional(),
    /** JSON fields merged into every upstream request body; `!name` replaces. */
    extraBody: z.record(z.string(), z.unknown()).optional(),
    /** Listed to gateway clients unless false; explicit `provider/model` still resolves. */
    exposeModels: z.boolean().optional(),
    /** Which of its models it serves: all, the picked ones, the newest per family, or none. */
    modelMode: z.enum(["list", "picked", "best", "none"]).optional(),
    /** The app draws this in the provider's row; the daemon ignores it. */
    icon: z.string().optional(),
    /** Requests to this provider go unmasked; the user asked for it. */
    unredacted: z.boolean().optional(),
    /** Counts every model it serves as free for `free` and `cheap` routing. */
    countFree: z.boolean().optional(),
    /** The upstream itself answers a web search tool (Anthropic and Responses only). */
    searches: z.boolean().optional(),
    /**
     * Read-only: the daemon's answer to whether this upstream searches by
     * itself. Its explicit `searches` wins, else the host decides; written
     * back by the app, the daemon strips it.
     */
    searchesUpstream: z.boolean().optional(),
    /** A capped account near its cap is read again, and held while unknown. */
    capCareful: z.boolean().optional(),
    /** Codex compacts natively here; only a Responses API carries it. */
    nativeCompaction: z.boolean().optional(),
    /** Where the provider reports what is left on its key; `{key}` takes the key. */
    balanceUrl: z.string().optional(),
    /** The amount's field in that reply, dot-separated (`data.balance`). */
    balancePath: z.string().optional(),
    /** How the balance URL is asked; POST carries no body. */
    balanceMethod: z.enum(["GET", "POST"]).optional(),
    /** An account's own token, asked instead of the key where a vendor wants one. */
    balanceToken: z.string().optional(),
    maxAccounts: z.number().int().positive().optional(),
    queueWaitMs: z.number().int().nonnegative().optional(),
    sink: z.boolean().optional(),
    priceRate: z.number().positive().optional(),
    /** At most 8; the first that holds a call's time wins. */
    rateWindows: z.array(GatewayRateWindowWireSchema).max(8).optional(),
    /** COMPAT(rateWindows) with v0.15: one peak window, read as `rateWindows`. */
    peak: z
      .object({
        startHour: z.number().int(),
        endHour: z.number().int(),
        rate: z.number(),
      })
      .passthrough()
      .optional(),
    models: z.array(GatewayModelWireSchema),
    videoApi: z.enum(["openai", "ark", "minimax", "grok"]).optional(),
  })
  .passthrough();

export const GatewayGroupTimeWireSchema = z
  .object({
    /** "HH:MM"; To before From wraps past midnight. */
    from: z.string(),
    to: z.string(),
    /** "mon" … "sun"; empty means every day. */
    days: z.array(z.string()).optional(),
    /** IANA zone the hours were set in; absent means the host's clock. */
    zone: z.string().optional(),
  })
  .passthrough();

export const GatewayGroupRuleWireSchema = z
  .object({
    /** The member the rule sends to first, as the group spells it. */
    use: z.string().min(1),
    /** Tried after `use`, in order, before the group's other members. */
    more: z.array(z.string()).optional(),
    /** The reasoning asked of `use`, whatever the agent asked. */
    useEffort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
    /** The request is at least this long, in estimated tokens. */
    tokens: z.number().int().positive().optional(),
    images: z.boolean().optional(),
    /** The agent asked for reasoning at least this level, or "on" for any. */
    effort: z.string().optional(),
    agents: z.array(z.string()).optional(),
    time: GatewayGroupTimeWireSchema.optional(),
    /** Leaves `use` out of the group while the rule holds. */
    pause: z.boolean().optional(),
    /** Judged only by hosts that support it; other hosts let the rule hold for nothing. */
    intent: z.string().optional(),
    compact: z.boolean().optional(),
    folders: z.array(z.string()).optional(),
    exceptFolders: z.array(z.string()).optional(),
  })
  .passthrough();

export const GatewayGroupWireSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().optional(),
    /** `provider/model`, `provider/model:effort`, or `group/<id>`, in order. */
    members: z.array(z.string().min(1)),
    strategy: GatewayRoutingStrategySchema.optional(),
    /** Turns members by weight, smoothly, instead of by `strategy`. */
    weighted: z.boolean().optional(),
    /** Each member's share when weighted; one not named weighs 1. */
    weights: z.record(z.string(), z.number().int().positive()).optional(),
    /** Members sent in their vendor's fast mode. */
    fast: z.array(z.string()).optional(),
    /** Accounts (`provider/account`) the group is held to; providers not named keep all. */
    accounts: z.array(z.string()).optional(),
    rules: z.array(GatewayGroupRuleWireSchema).optional(),
    /** Glob or `re:` patterns whose matching models join the group after its members. */
    match: z.array(z.string()).optional(),
    /** Members switched off: kept in place and out of every request. */
    off: z.array(z.string()).optional(),
    /** The member a group with no matching rule sends first, when it names one. */
    pick: z.string().optional(),
    /** Kept on the page but serves nothing, and is skipped where another group names it. */
    disabled: z.boolean().optional(),
    /** The reasoning levels agents are offered for the group, lowest first. */
    levels: z.array(z.string()).optional(),
    /** The window agents are told, in tokens; -1 tells the smallest member's. */
    context: z.number().int().optional(),
    /** The model asked which intent a turn's message is, for rules with `intent`. */
    classifier: z.string().optional(),
    /** Found by the gateway (not stored); editing one saves it as the user's. */
    auto: z.boolean().optional(),
  })
  .passthrough();

export type GatewayGroupRuleWire = z.infer<typeof GatewayGroupRuleWireSchema>;

export const GatewayMaskingActionSchema = z.enum(["mask", "warn", "block"]);

export const GatewayMaskingWireSchema = z
  .object({
    enabled: z.boolean(),
    /**
     * Mask personal data too: emails, phone numbers, ID and bank card
     * numbers, and the kinds under them (myna's redactPersonal). Off, none
     * of them masks whatever its own switch says.
     */
    personal: z.boolean().optional(),
    allow: z.array(z.string()).optional(),
    categories: z.array(z.string()).optional(),
    /** What each kind of found value does; an absent kind is masked. */
    actions: z.record(z.string(), GatewayMaskingActionSchema).optional(),
    /** Send a key as a made-up key of its own form rather than a placeholder. */
    shape: z.boolean().optional(),
    /** Opt-in detectors (`userhost`, `bucket`); absent ones stay off. */
    categorySwitches: z.record(z.string(), z.boolean()).optional(),
    /** The user's own words, masked as written unless anyCase says otherwise. */
    words: z.array(z.string()).optional(),
    /** A word also matches in other capitals. */
    wordsAnyCase: z.boolean().optional(),
    /** A word is not masked inside a longer one. */
    wordsWhole: z.boolean().optional(),
    /** The model a request masking would change goes to as written. */
    routeTo: z.string().optional(),
    /**
     * The local model that finds what the rules can't: `astrlink-guard`;
     * absent or empty is off. It runs on this machine and never leaves it.
     */
    model: z.string().optional(),
    /** The score its finds need, 0.5–0.95; absent is 0.8. */
    modelScore: z.number().optional(),
    /** Tell the client when a value is masked for the first time. */
    alert: z.boolean().optional(),
    rules: z
      .array(
        z
          .object({
            kind: z.string(),
            /** A prefix matches itself followed by key characters. */
            prefix: z.string().optional(),
            pattern: z.string(),
            flags: z.string().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

/** One value a request had masked: its kind, finder and shape, never its text. */
export const GatewayMaskingValueWireSchema = z
  .object({
    p: z.string(),
    k: z.string(),
    b: z.string(),
    h: z.string().optional(),
    l: z.number(),
    n: z.number(),
    a: GatewayMaskingActionSchema.optional(),
  })
  .passthrough();

export const GatewayMaskingHitWireSchema = z
  .object({
    placeholder: z.string(),
    kind: z.string(),
    by: z.string(),
    head: z.string().optional(),
    len: z.number(),
    action: GatewayMaskingActionSchema.optional(),
  })
  .passthrough();

export const GatewayMaskingRecordWireSchema = z
  .object({
    key: z.string(),
    t: z.string(),
    /** The client call this masking belonged to, when the daemon named one. */
    gatewayCallId: z.string().optional(),
    agent: z.string().optional(),
    provider: z.string().optional(),
    model: z.string().optional(),
    n: z.number(),
    took: z.number().optional(),
    blocked: z.boolean().optional(),
    values: z.array(GatewayMaskingValueWireSchema),
    /** By stand-in, how often the reply had it put back. */
    back: z.record(z.string(), z.number()).optional(),
  })
  .passthrough();

export const GatewayMaskingRecordsWireSchema = z
  .object({
    records: z.array(GatewayMaskingRecordWireSchema),
    more: z.boolean(),
  })
  .passthrough();

export const GatewayMaskingSummaryWireSchema = z
  .object({
    n: z.number(),
    distinct: z.number(),
    requests: z.number(),
    blocked: z.number(),
    restored: z.number(),
    days: z.array(z.object({ day: z.string(), n: z.number(), requests: z.number() }).passthrough()),
    kinds: z.array(z.object({ name: z.string(), n: z.number() }).passthrough()),
    agents: z.array(z.object({ name: z.string(), n: z.number() }).passthrough()),
    providers: z.array(z.object({ name: z.string(), n: z.number() }).passthrough()),
    values: z.array(
      z
        .object({
          p: z.string(),
          k: z.string(),
          b: z.string(),
          h: z.string().optional(),
          l: z.number(),
          n: z.number(),
          requests: z.number(),
          last: z.string(),
        })
        .passthrough(),
    ),
    by: z.object({ rule: z.number(), yours: z.number(), model: z.number() }).passthrough(),
  })
  .passthrough();

export const GatewayMaskingPreviewWireSchema = z
  .object({
    text: z.string(),
    hits: z.array(GatewayMaskingHitWireSchema),
    blocked: z.boolean(),
    off: z.boolean(),
  })
  .passthrough();

/** AstrLink Guard, as Settings → Masking shows it (myna's pii.Status). */
export const GatewayMaskingLocalModelStatusWireSchema = z
  .object({
    model: z.string(),
    supported: z.boolean(),
    installed: z.boolean(),
    /** How much turning it on downloads. */
    size: z.number(),
    downloading: z.boolean().optional(),
    done: z.number().optional(),
    total: z.number().optional(),
    error: z.string().optional(),
    running: z.boolean().optional(),
    device: z.string().optional(),
    loadMs: z.number().optional(),
    /** Why the last request got no answer. */
    failed: z.string().optional(),
    /** The threshold its finds need now. */
    score: z.number().optional(),
  })
  .passthrough();

export const GatewayMaskingAlertWireSchema = z
  .object({
    total: z.number(),
    /** Each kind and how many of it, the most first. */
    kinds: z.array(z.object({ name: z.string(), n: z.number() }).passthrough()),
    /** The clients that sent them, in the order they came. */
    agents: z.array(z.string()),
    /** The latest record, which the settings page opens on. */
    key: z.string().nullable(),
    at: z.string(),
  })
  .passthrough();

/** What came of a day's check-in, as myna names it. */
export const GatewayCheckinOutcomeSchema = z.enum([
  "claimed",
  "done",
  "ineligible",
  "inactive",
  "failed",
  "captcha",
  "own-app",
]);

/** One account's last check-in, as the vendor's file keeps it. */
export const GatewayCheckinRecordWireSchema = z
  .object({
    /** The Beijing day (`YYYY-MM-DD`) it counts in. */
    day: z.string(),
    at: z.string(),
    outcome: GatewayCheckinOutcomeSchema,
    credit: z.number().optional(),
    streak: z.number().optional(),
    msg: z.string().optional(),
    /** A campaign's end, or when the vendor's own day turns. */
    until: z.string().optional(),
    /** A failure that never reached the vendor. */
    offline: z.boolean().optional(),
    tries: z.number().optional(),
    claimed: z.string().optional(),
  })
  .passthrough();

/** One account a check-in reaches, and its last record. */
export const GatewayCheckinAccountWireSchema = z
  .object({
    by: z.string(),
    key: z.string(),
    user: z.string(),
    /** Takes part in the daily check-in (the per-account opt-out is `off`). */
    on: z.boolean(),
    /** Its record is provisional and will be asked again today. */
    again: z.boolean().optional(),
    record: GatewayCheckinRecordWireSchema.optional(),
  })
  .passthrough();

/** An account as one run found it, which a press then shows. */
export const GatewayCheckinEntryWireSchema = GatewayCheckinRecordWireSchema.extend({
  key: z.string(),
  user: z.string(),
  by: z.string(),
  again: z.boolean(),
  asked: z.boolean(),
}).passthrough();

/** The accounts and the vendors' switches, as the Usage card shows them. */
export const GatewayCheckinWireSchema = z
  .object({
    accounts: z.array(GatewayCheckinAccountWireSchema),
    /** The vendors with a switch of their own, on or off. */
    switches: z.record(z.string(), z.boolean()).optional(),
  })
  .passthrough();

export const GatewayTurnDoneWireSchema = z
  .object({
    /** The agent the turn belonged to, as `clientOfUserAgent` reads it. */
    agent: z.string(),
    session: z.string(),
    /** From the turn's first request to its last reply. */
    tookSeconds: z.number(),
    at: z.string(),
  })
  .passthrough();

export const GatewayOverrideWireSchema = z
  .object({
    model: z.string().optional(),
    set: z.record(z.string(), z.unknown()).optional(),
    remove: z.array(z.string()).optional(),
  })
  .passthrough();

export const GatewayMiddlewareWireSchema = z
  .object({
    aliases: z.record(z.string(), z.string()).optional(),
    overrides: z.array(GatewayOverrideWireSchema).optional(),
    hooks: z
      .object({
        request: z.string().optional(),
        provider: z.string().optional(),
        account: z.string().optional(),
        response: z.string().optional(),
        event: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

/** A whole-request price once the prompt is over `aboveTokens`. */
export const GatewayPriceTierWireSchema = z
  .object({
    aboveTokens: z.number().int().positive(),
    inputPerMTok: z.number().nonnegative(),
    outputPerMTok: z.number().nonnegative(),
    cacheReadPerMTok: z.number().nonnegative().optional(),
    cacheWritePerMTok: z.number().nonnegative().optional(),
    cacheWrite1hPerMTok: z.number().nonnegative().optional(),
  })
  .passthrough();

export const GatewayPriceWireSchema = z
  .object({
    inputPerMTok: z.number().nonnegative(),
    outputPerMTok: z.number().nonnegative(),
    /** Cache reads, per million tokens. */
    cacheReadPerMTok: z.number().nonnegative().optional(),
    /** Cache writes kept 5 minutes, per million tokens. */
    cacheWritePerMTok: z.number().nonnegative().optional(),
    /** Cache writes kept an hour (Anthropic's 1-hour TTL), per million tokens. */
    cacheWrite1hPerMTok: z.number().nonnegative().optional(),
    tiers: z.array(GatewayPriceTierWireSchema).optional(),
    /**
     * Set by the daemon on a catalog price whose vendor bills it by the hour:
     * it is the off-peak one and doubles in these hours.
     */
    peak: z.enum(["deepseek", "weekdays", "ollama"]).optional(),
  })
  .passthrough();

/**
 * One of a gateway key's budget windows (myna access.Limit): a calendar
 * day, week or month, or a cycle of `days`/`hours` from `since`. `tokens`
 * counts uncached input, output and cache writes, and cache reads when
 * `cacheReads` is set; `cost` is the Usage page's estimate.
 */
export const GatewayKeyLimitWireSchema = z
  .object({
    period: z.enum(["day", "week", "month", "days", "hours"]),
    days: z.number().int().min(1).max(3650).optional(),
    hours: z.number().int().min(1).max(8760).optional(),
    tokens: z.number().int().positive().optional(),
    cost: z.number().nonnegative().optional(),
    cacheReads: z.boolean().optional(),
    /** When the cycle began, or when the limit was last reset. */
    since: z.string().optional(),
  })
  .passthrough();

export const GatewayKeyWireSchema = z.union([
  z.string().min(1),
  z
    .object({
      key: z.string().min(1),
      label: z.string().optional(),
      models: z.array(z.string()).optional(),
      dailyTokens: z.number().int().positive().optional(),
      monthlyUsd: z.number().positive().optional(),
      /** This key's budget windows, at most five; absent falls back to the two above. */
      limits: z.array(GatewayKeyLimitWireSchema).max(5).optional(),
      ratePerMinute: z.number().int().positive().optional(),
      searchCallsPerMonth: z.number().int().positive().optional(),
      readOnly: z.boolean().optional(),
      expiresAt: z.string().optional(),
      issues: z.boolean().optional(),
      issuer: z.string().optional(),
    })
    .passthrough(),
]);

export const GatewaySearchApiWireSchema = z
  .object({
    vendor: z.string(),
    key: z.string().optional(),
    url: z.string().optional(),
    pick: z.enum(["", "order"]).optional(),
    off: z.boolean().optional(),
  })
  .passthrough();

export type GatewaySearchApiWire = z.infer<typeof GatewaySearchApiWireSchema>;

export const GatewaySearchWireSchema = z
  .object({
    enabled: z.boolean().optional(),
    url: z.string().optional(),
    apiKey: z.string().optional(),
    monthlyCalls: z.number().int().positive().nullish(),
    /** Search APIs asked in this order; unset keeps the single Tavily endpoint. */
    apis: z.array(GatewaySearchApiWireSchema).optional(),
    /** The provider that searches for a model that can't: "provider", "provider/model", "off", or unset for the gateway's pick (myna's Searcher). */
    searcher: z.string().optional(),
    /** The searchers asked in turn when the one above fails, in this order (myna's SearcherThen). */
    searcherThen: z.array(z.string()).optional(),
    /** Which is asked first when both a provider and a search API can: unset or "model" is the provider (myna's SearchFirst). */
    searchFirst: z.enum(["", "model", "api"]).optional(),
    /** Search for every model, one whose provider searches by itself too (myna's SearchAll). */
    searchAll: z.boolean().optional(),
  })
  .passthrough();

/** What one key of a search API has used of its limit, as myna reads Tavily's. */
export const GatewaySearchKeyQuotaWireSchema = z
  .object({
    /** The key, masked. */
    key: z.string(),
    /** Read, or unknown with `err`. */
    known: z.boolean(),
    unlimited: z.boolean().optional(),
    used: z.number(),
    limit: z.number(),
    /** What the limit belongs to: the key itself, or its account's plan. */
    of: z.enum(["key", "plan"]).optional(),
    plan: z.string().optional(),
    paygoLeft: z.number().optional(),
    usedUp: z.boolean().optional(),
    err: z.string().optional(),
  })
  .passthrough();

export type GatewaySearchKeyQuotaWire = z.infer<typeof GatewaySearchKeyQuotaWireSchema>;

export const GatewayOidcRuleWireSchema = z
  .object({
    id: z.string().optional(),
    key: z.string(),
    issuer: z.string(),
    audience: z.string().optional(),
    claims: z.record(z.string(), z.string()).optional(),
    ttlSeconds: z.number().int().positive().optional(),
  })
  .passthrough();

export const GatewayConfigWireSchema = z
  .object({
    version: z.literal(1),
    enabled: z.boolean().optional(),
    /** Addresses other computers may reach the gateway from (myna's allowIPs). */
    allowIPs: z.array(z.string()).optional(),
    /** Web origins allowed to call the gateway from a browser (myna's corsOrigins). */
    corsOrigins: z.array(z.string()).optional(),
    keys: z.array(GatewayKeyWireSchema).optional(),
    pricing: z.record(z.string(), GatewayPriceWireSchema).optional(),
    /** `provider/model` → the model id whose maker's price it borrows. */
    modelSameAs: z.record(z.string(), z.string()).optional(),
    budget: z.object({ monthlyUsd: z.number().positive().optional() }).passthrough().optional(),
    /** Local copies of gateway conversations; off unless opted in. */
    recording: z.object({ enabled: z.boolean().optional() }).passthrough().optional(),
    /** How the model list names models: with their provider, plain, or plain only for custom labels. */
    modelNames: z.enum(["off", "own", "on"]).optional(),
    /** The gateway's `/v1/models` also names each model by its bare id (myna's bareModelIDs). */
    bareModelIDs: z.boolean().optional(),
    /** A model its provider reports busier than this percent goes behind the others; 0 is off (myna's busyLoad). */
    busyLoad: z.number().int().min(0).max(9999).optional(),
    /** The model the Image generation MCP server draws with: "provider/model", "off", or unset to pick one. */
    imageGen: z.string().optional(),
    /** Minutes a provider is given to draw an image and send it; absent is 5 (myna's imageTimeout). */
    imageTimeout: z.number().int().positive().max(60).optional(),
    /** Warm a Codex subscription's windows as they reset: off, weekly, or 5-hourly too. */
    codexWarmup: z.enum(["off", "week", "all"]).optional(),
    /** Warm a Claude subscription's windows, as `codexWarmup` does Codex's. */
    claudeWarmup: z.enum(["off", "week", "all"]).optional(),
    /** Local "HH:MM" times of day a Codex account's 5-hour window is started at. */
    codexWarmAts: z.array(z.string()).optional(),
    /** The same for the Claude subscription accounts. */
    claudeWarmAts: z.array(z.string()).optional(),
    /** Minutes before a Codex reset runs out that it is spent; absent is 30. */
    codexResetLead: z.number().int().min(15).max(1440).optional(),
    /** Read allowances only when asked; absent reads them on the poller's timer. */
    quotaReads: z.enum(["asked"]).optional(),
    /** Seconds a routing group's intent classifier is given; absent means 8. */
    classifyTimeout: z.number().int().positive().optional(),
    /** Start a Claude subscription's run with the caller's instructions as its system prompt. */
    claudeLeanPrompt: z.boolean().optional(),
    /** Run Claude Code as `claude -p` always, not in its interactive mode. */
    claudePrintMode: z.boolean().optional(),
    /** What each agent is shown: family tags, provider ids and group ids (myna's Visible). */
    visible: z.record(z.string(), z.array(z.string())).optional(),
    /** Model ids hidden from one agent (myna's HiddenModels). */
    hiddenModels: z.record(z.string(), z.array(z.string())).optional(),
    /** A key's presence is "only these models" for that agent (myna's PickedModels). */
    pickedModels: z.record(z.string(), z.array(z.string())).optional(),
    /** How many Claude Code processes the subscription may run at once; 0 sizes it from memory. */
    claudeRunsMost: z.number().int().optional(),
    /** Private hosts and ranges a URL the gateway did not choose may be fetched from. */
    fetchPrivate: z.array(z.string()).optional(),
    /** Codex side turns: "" keeps Codex's model, "off" sends none, else a model id. */
    codexTitles: z.string().optional(),
    codexDescriptions: z.string().optional(),
    codexPredictions: z.string().optional(),
    /** Codex's OpenAI models say multi-agent V1 in the catalog Neolix hands it. */
    codexAgentsV1: z.boolean().optional(),
    /** The model every Codex subagent runs on; "lead" is its lead's own. */
    codexSubagentModel: z.string().optional(),
    /** Tell Codex and Claude the whole context window, not the compacting one. */
    fullContext: z.boolean().optional(),
    /** The window to compact at, in tokens; 0 is the working window (myna's 272k). */
    compactAt: z.number().int().nonnegative().optional(),
    /** Codex compacts long conversations in the background. */
    codexAsyncCompact: z.boolean().optional(),
    /** The share of a model's window background compaction starts at, 0–100. */
    codexAsyncCompactPercent: z.number().int().min(0).max(100).optional(),
    /** The model Codex's auto-review runs on; "session" is the conversation's own. */
    codexAutoReview: z.string().optional(),
    /** The model Codex writes its memories with; unset is Codex's own. */
    codexMemories: z.string().optional(),
    // COMPAT(agentConnectFields): added in v0.16.0, remove after 2027-11-06.
    /** How Codex takes Neolix's models: "", "chatgpt" or "api" (myna's login). */
    codexLogin: z.string().optional(),
    /** Read the agents' own sign-ins; off reads no credential (myna's noAccountDiscovery). */
    accountDiscovery: z.boolean().optional(),
    // COMPAT(codexAccountDiscovery): added in v0.16.0, remove after 2027-11-06.
    /** The Codex-only switch `accountDiscovery` replaced. */
    codexAccountDiscovery: z.boolean().optional(),
    /** Whether a renewed Codex sign-in may be written back; off never touches it. */
    codexSignInWriteBack: z.boolean().optional(),
    /** Sign Codex in to the next account with room by itself; off by default. */
    codexAutoSwitchSignIn: z.boolean().optional(),
    /** The same for Claude Code's own sign-in; off by default. */
    claudeAutoSwitchSignIn: z.boolean().optional(),
    /** Whether a saved Claude sign-in may be written back; off by default. */
    claudeSignInWriteBack: z.boolean().optional(),
    /** Which agents' session files may be read (myna's sessionReads). */
    codexSessionReads: z
      .object({
        asked: z.boolean().optional(),
        all: z.boolean().optional(),
        agents: z.record(z.string(), z.boolean()).optional(),
      })
      .passthrough()
      .optional(),
    /** Show the sign-in link instead of opening the browser (myna's signInLinkOnly). */
    codexSignInLinkOnly: z.boolean().optional(),
    /** A reply's model field: asked (unset), member (provider/model), vendor. */
    replyModel: z.enum(["asked", "member", "vendor"]).optional(),
    /** COMPAT(memberModel): ReplyModel "member" before it existed. */
    memberModel: z.boolean().optional(),
    /** Notify when a gateway-served turn ran at least this many seconds; 0 is off. */
    turnDoneSeconds: z.number().int().optional(),
    /** Lets a streamed reply run on when it loops. */
    noLoopGuard: z.boolean().optional(),
    /** Extra tries for a safety-refused request. */
    refusalRetries: z.number().int().min(0).optional(),
    /** Proxy upstream requests that name no proxy of their own. */
    proxy: z.string().optional(),
    /** Optional OTLP/HTTP trace export of gateway requests. */
    otel: z
      .object({
        enabled: z.boolean().optional(),
        endpoint: z.string().optional(),
        headers: z.record(z.string(), z.string()).optional(),
        /** Also send duration and token histograms. */
        metrics: z.boolean().optional(),
        /** Attach request and reply bodies to the span. */
        bodies: z.boolean().optional(),
        /** Send them whole rather than cut at 256 KiB, as myna's BodiesWhole. */
        bodiesWhole: z.boolean().optional(),
        /** Trace the agents' local conversations, not only gateway requests. */
        sessions: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
    masking: GatewayMaskingWireSchema.optional(),
    search: GatewaySearchWireSchema.optional(),
    oidc: z
      .object({ rules: z.array(GatewayOidcRuleWireSchema).optional() })
      .passthrough()
      .optional(),
    middleware: GatewayMiddlewareWireSchema.optional(),
    /** Image recognition: `model` is `provider/model`, or "off"; absent picks one that sees. */
    vision: z
      .object({
        model: z.string().optional(),
        effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
      })
      .passthrough()
      .optional(),
    /** The request archive on this computer: bodies and headers, masked. */
    archive: z
      .object({
        local: z.boolean().optional(),
        maxMB: z.number().int().positive().optional(),
        keepMB: z.number().int().positive().optional(),
      })
      .passthrough()
      .optional(),
    /** Daily check-ins: the vendors' switches, plugins', and accounts left out. */
    checkin: z
      .object({
        workbuddy: z.boolean().optional(),
        minimax: z.boolean().optional(),
        trae: z.boolean().optional(),
        qoder: z.boolean().optional(),
        /** Plugin provider id → whether it checks in. */
        plugins: z.record(z.string(), z.boolean()).optional(),
        /** Account keys left out of the daily check-in. */
        off: z.array(z.string()).optional(),
      })
      .passthrough()
      .optional(),
    providers: z.array(GatewayProviderWireSchema).optional(),
    groups: z.array(GatewayGroupWireSchema).optional(),
    /** Whether the gateway finds groups on its own; absent is on. */
    autoGroups: z.boolean().optional(),
    /** Provider ids kept out of the found groups. */
    autoGroupSkip: z.array(z.string()).optional(),
    /** The order the page lists groups in. */
    groupOrder: z.array(z.string()).optional(),
    /** Found groups the user hid. */
    hiddenGroups: z.array(z.string()).optional(),
    /** The name a vendor is asked for a model by, `*` in it the model. */
    modelWires: z.record(z.string(), z.string()).optional(),
    /** The id a model is listed and routed by, keyed by that id. */
    modelIDs: z.record(z.string(), z.string()).optional(),
    /** Models turned off everywhere: ids or globs. */
    disabledModels: z.array(z.string()).optional(),
    /** The reasoning levels a model offers, `provider/model` keys. */
    modelEfforts: z.record(z.string(), z.array(z.string())).optional(),
    /** Models sent no reasoning field at all. */
    modelReasonless: z.record(z.string(), z.boolean()).optional(),
    /** Bare model id to the id its usage is counted under. */
    usageAliases: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();

export const GatewayAccountStatusWireSchema = z
  .object({
    provider: z.string(),
    account: z.string(),
    enabled: z.boolean(),
    priority: z.number(),
    weight: z.number(),
    inflight: z.number(),
    restingUntil: z.number().nullable(),
    tokens5h: z.number(),
    tokens7d: z.number(),
    tokens5hCap: z.number().nullable().optional(),
    tokens7dCap: z.number().nullable().optional(),
    spendUsd: z.number().optional(),
    monthlyUsdCap: z.number().nullable().optional(),
    usedPercent: z.number().nullable().optional(),
  })
  .passthrough();

export const GatewayStatusWireSchema = z
  .object({
    enabled: z.boolean(),
    startedAt: z.number(),
    monthSpendUsd: z.number(),
    budgetUsd: z.number().nullable(),
    /** The proxy in force for upstream requests, with its login redacted. */
    proxy: z.string().optional(),
    /** What chose it: the settings, *_PROXY, the system, off, or none. */
    proxySource: z.enum(["settings", "environment", "system", "off", "none"]).optional(),
    accounts: z.array(GatewayAccountStatusWireSchema),
    served: z.array(z.object({ key: z.string(), count: z.number() }).passthrough()),
    recent: z
      .array(
        z
          .object({
            time: z.string(),
            requested: z.string(),
            provider: z.string(),
            account: z.string().nullable(),
            model: z.string(),
            status: z.number(),
            ok: z.boolean(),
            inputTokens: z.number(),
            outputTokens: z.number(),
            costUsd: z.number(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

export const GatewayRouteSeatWireSchema = z
  .object({
    /** `provider/account`, or `provider` when it has no accounts. */
    id: z.string(),
    provider: z.string(),
    providerLabel: z.string(),
    account: z.string().nullable(),
    accountLabel: z.string(),
    model: z.string(),
    /** Position in the order routing planned, 0 first. */
    rank: z.number(),
    restingUntil: z.number().nullable(),
    /** Requests this seat served lately. */
    served: z.number(),
  })
  .passthrough();

export const GatewayRouteTryWireSchema = z
  .object({
    provider: z.string(),
    account: z.string().nullable(),
    model: z.string(),
    start: z.number(),
    done: z.boolean(),
    status: z.number().nullable(),
    millis: z.number().nullable(),
    error: z.string().nullable(),
    /** Milliseconds a patience round waited before asking again. */
    again: z.number().int().optional(),
    /** How many members the next patience round asked. */
    replan: z.number().int().optional(),
    /** The patience the round was budgeted, in seconds. */
    patience: z.number().int().optional(),
  })
  .passthrough();

export const GatewayRoutePromptItemWireSchema = z
  .object({
    name: z.string(),
    tokens: z.number(),
    tag: z.string(),
  })
  .passthrough();

export const GatewayRoutePromptPartWireSchema = z
  .object({
    kind: z.enum(["system", "tools", "messages", "other"]),
    tokens: z.number(),
    items: z.array(GatewayRoutePromptItemWireSchema),
  })
  .passthrough();

export const GatewayRoutePromptWireSchema = z
  .object({
    tokens: z.number(),
    window: z.number().nullable(),
    parts: z.array(GatewayRoutePromptPartWireSchema),
  })
  .passthrough();

export const GatewayRouteWireSchema = z
  .object({
    id: z.number(),
    time: z.number(),
    /** What the client's User-Agent names. */
    agent: z.string(),
    key: z.string().nullable(),
    /** The model the client asked for. */
    model: z.string(),
    /** `model` after the alias middleware. */
    routedModel: z.string(),
    alias: z.string().nullable(),
    group: z.string().nullable(),
    strategy: z.string(),
    provider: z.string().nullable(),
    providerLabel: z.string().nullable(),
    seats: z.array(GatewayRouteSeatWireSchema),
    tries: z.array(GatewayRouteTryWireSchema),
    done: z.boolean(),
    status: z.number().nullable(),
    error: z.string().nullable(),
    millis: z.number().nullable(),
    prompt: GatewayRoutePromptWireSchema.nullable(),
    masked: z.boolean(),
    /** The client call this route belongs to, for its masking records. */
    gatewayCallId: z.string().optional(),
    /** The held-request report saved for this request, for its Copy action. */
    held: z.string().optional(),
    /** The agent conversation the request names (myna's Route.Session). */
    session: z.string().optional(),
    /** Codex's hidden turn: thread_title and its siblings. */
    kind: z.string().optional(),
    /** Prompt and title fingerprints tying a title turn to its conversation. */
    titleLink: z
      .object({
        scope: z.string(),
        prompt: z.string(),
        reply: z.string(),
      })
      .optional(),
    /** The conversation a title turn is drawn under, once resolved. */
    parentSession: z.string().optional(),
    /** The parent was inferred from the title, not named by the client. */
    parentMatched: z.boolean().optional(),
  })
  .passthrough();

export const GatewayRouteTraceStatsWireSchema = z
  .object({
    requests: z.number(),
    rerouted: z.number(),
    errors: z.number(),
    active: z.number(),
  })
  .passthrough();

export const GatewayRouteTraceWireSchema = z
  .object({
    routes: z.array(GatewayRouteWireSchema),
    stats: GatewayRouteTraceStatsWireSchema,
  })
  .passthrough();

export type GatewayRouteWire = z.infer<typeof GatewayRouteWireSchema>;
export type GatewayRouteTraceWire = z.infer<typeof GatewayRouteTraceWireSchema>;
export type GatewayRouteSeatWire = z.infer<typeof GatewayRouteSeatWireSchema>;
export type GatewayRouteTryWire = z.infer<typeof GatewayRouteTryWireSchema>;
export type GatewayRoutePromptWire = z.infer<typeof GatewayRoutePromptWireSchema>;

/**
 * One row of the routing history as it is kept on disk: the shape myna's
 * Routing page lists and opens (`id` is the request's id, `time` ISO). Only
 * what the page draws is typed; the record keeps whatever else it was
 * written with.
 */
export const GatewayHistoryPromptWireSchema = z
  .object({
    tokens: z.number(),
    parts: z.array(z.object({ kind: z.string(), tokens: z.number() }).passthrough()).optional(),
  })
  .passthrough();

export const GatewayHistoryTryWireSchema = z
  .object({
    provider: z.string().optional(),
    account: z.string().nullable().optional(),
    model: z.string().nullable().optional(),
    done: z.boolean().optional(),
    status: z.number().nullable().optional(),
    millis: z.number().nullable().optional(),
    error: z.string().nullable().optional(),
  })
  .passthrough();

export const GatewayTitleLinkWireSchema = z
  .object({
    scope: z.string().optional(),
    prompt: z.string().optional(),
    reply: z.string().optional(),
  })
  .passthrough();

export const GatewayHistoryRouteWireSchema = z
  .object({
    id: z.string(),
    time: z.string(),
    asked: z.string().optional(),
    served: z.string().optional(),
    model: z.string().optional(),
    group: z.string().optional(),
    client: z.string().optional(),
    session: z.string().optional(),
    done: z.boolean().optional(),
    status: z.number().nullable().optional(),
    millis: z.number().nullable().optional(),
    tries: z.array(GatewayHistoryTryWireSchema).optional(),
    error: z.string().optional(),
    /** The response object's id as the client received it, myna's ResponseID. */
    responseId: z.string().optional(),
    /** `<date>/<id>` in the request archive, when the archive kept it. */
    archive: z.string().optional(),
    /** The held-request report's file name, when Neolix held the request. */
    held: z.string().optional(),
    /** Codex's hidden turn kind, for a title request. */
    kind: z.string().optional(),
    /** The request a title turn's title and reply came from (myna's TitleLink). */
    titleLink: GatewayTitleLinkWireSchema.optional(),
    /** The conversation a title turn belongs to, resolved by the daemon. */
    parentSession: z.string().optional(),
    /** True when the parent was inferred from the prompt and the applied title. */
    parentMatched: z.boolean().optional(),
    prompt: GatewayHistoryPromptWireSchema.optional(),
  })
  .passthrough();

export type GatewayHistoryRouteWire = z.infer<typeof GatewayHistoryRouteWireSchema>;
export type GatewayHistoryPromptWire = z.infer<typeof GatewayHistoryPromptWireSchema>;
export type GatewayHistoryTryWire = z.infer<typeof GatewayHistoryTryWireSchema>;

/** One call in the request archive, headers and bodies both ways. */
export const GatewayArchiveHeadersSchema = z.record(z.string(), z.array(z.string()));

export const GatewayArchivePartWireSchema = z
  .object({
    method: z.string().optional(),
    path: z.string().optional(),
    status: z.number().optional(),
    headers: GatewayArchiveHeadersSchema,
    body: z.string(),
    /** The body's length before the archive's cap, when it was cut. */
    size: z.number().optional(),
    truncated: z.boolean().optional(),
  })
  .passthrough();

export const GatewayArchiveWireRecordSchema = z
  .object({
    method: z.string(),
    url: z.string(),
    request: GatewayArchiveHeadersSchema,
    status: z.number(),
    response: GatewayArchiveHeadersSchema,
    millis: z.number(),
    error: z.string().optional(),
  })
  .passthrough();

export const GatewayArchiveRecordWireSchema = z
  .object({
    id: z.string(),
    time: z.string(),
    request: GatewayArchivePartWireSchema,
    response: GatewayArchivePartWireSchema,
    /** Each request the gateway sent upstream for it. */
    upstream: z.array(GatewayArchiveWireRecordSchema).optional(),
  })
  .passthrough();

export type GatewayArchiveRecordWire = z.infer<typeof GatewayArchiveRecordWireSchema>;
export type GatewayArchivePartWire = z.infer<typeof GatewayArchivePartWireSchema>;
export type GatewayArchiveWireRecord = z.infer<typeof GatewayArchiveWireRecordSchema>;

/** The masked request body the prompt viewer reads, while it is still kept. */
export const GatewayPromptTextWireSchema = z
  .object({
    id: z.string(),
    /** The protocol the body was written in, for the reader's parser. */
    protocol: z.string(),
    body: z.string(),
  })
  .passthrough();

export type GatewayPromptTextWire = z.infer<typeof GatewayPromptTextWireSchema>;

/** The reply beside a prompt's text, myna's prompt_reply. */
export const GatewayReplyPieceWireSchema = z
  .object({
    role: z.enum(["assistant", "thinking", "call"]),
    name: z.string().optional(),
    text: z.string(),
  })
  .passthrough();

export const GatewayReplyWireSchema = z
  .object({
    pieces: z.array(GatewayReplyPieceWireSchema),
    /** Only the reply's start was kept, or it ended before it was whole. */
    cut: z.boolean().optional(),
  })
  .passthrough();

export type GatewayReplyWire = z.infer<typeof GatewayReplyWireSchema>;

/** The advice tune works out from the user's own calls (myna's tune). */
export const GatewayTuneFactsWireSchema = z
  .object({
    calls: z.number().int().nonnegative(),
    streams: z.number().int().nonnegative(),
    compacts: z.number().int().nonnegative().optional(),
    peak: z.number().optional(),
    after: z.number().optional(),
    growth: z.number().optional(),
    rework: z.number().optional(),
    long: z.number().optional(),
    quick: z.number().optional(),
    pause: z.number().optional(),
    away: z.number().optional(),
    hour: z.number().optional(),
    sessions: z.number().int().nonnegative().optional(),
  })
  .passthrough();

export const GatewayTunePointWireSchema = z
  .object({
    value: z.number(),
    cost: z.number(),
    compacts: z.number().int().nonnegative(),
  })
  .passthrough();

export const GatewayTuneSettingWireSchema = z
  .object({
    /** What the agent has now; null when nothing sets it. */
    value: z.string().nullable(),
    source: z.enum(["settings", "model", "env"]).nullable(),
    /** An environment variable that takes precedence; Apply refuses it. */
    locked: z.string().optional(),
    /** Neolix put the value in, and Undo has what to put back. */
    ours: z.boolean().optional(),
  })
  .passthrough();

export type GatewayTuneSettingWire = z.infer<typeof GatewayTuneSettingWireSchema>;

export const GatewayTuneCompactionWireSchema = z
  .object({
    model: z.string(),
    current: z.number(),
    window: z.number().nullable(),
    best: z.number(),
    cost: z.number(),
    low: z.number(),
    curve: z.array(GatewayTunePointWireSchema),
    facts: GatewayTuneFactsWireSchema,
    setting: GatewayTuneSettingWireSchema.optional(),
  })
  .passthrough();

export const GatewayTuneTtlWireSchema = z
  .object({
    current: z.string(),
    best: z.string(),
    cost: z.number(),
    low: z.number(),
    short: z.number(),
    hour: z.number(),
    facts: GatewayTuneFactsWireSchema,
    setting: GatewayTuneSettingWireSchema.optional(),
  })
  .passthrough();

export const GatewayTuneAdviceWireSchema = z
  .object({
    agent: z.string(),
    calls: z.number().int().nonnegative(),
    compact: GatewayTuneCompactionWireSchema.optional(),
    ttl: GatewayTuneTtlWireSchema.optional(),
  })
  .passthrough();

export type GatewayTuneAdviceWire = z.infer<typeof GatewayTuneAdviceWireSchema>;
export type GatewayTuneCompactionWire = z.infer<typeof GatewayTuneCompactionWireSchema>;
export type GatewayTuneTtlWire = z.infer<typeof GatewayTuneTtlWireSchema>;

export type GatewayMaskingActionWire = z.infer<typeof GatewayMaskingActionSchema>;

/** Settings → Model gateway → Usage: one window summed up. */
export const GatewayUsagePeriodSchema = z.enum(["today", "7d", "30d", "all", "custom"]);

const usageTotalsFields = {
  calls: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  retried: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative(),
  costUsd: z.number(),
  unpricedCalls: z.number().int().nonnegative(),
  /** Failed attempts a later try took over: in neither `calls` nor `failed`. */
  handedOn: z.number().int().nonnegative(),
  /** Cache reads over the prompt (input, cache read and cache write); null when nothing was counted. */
  cacheHitRate: z.number().nullable(),
  /** Mean milliseconds to the first streamed token; null when no call was timed. */
  meanTtftMs: z.number().nullable(),
};

export const GatewayUsageTotalsWireSchema = z.object(usageTotalsFields).passthrough();

/** What a prompt was made of, in the slices the gateway can tell apart. */
export const GatewayUsagePromptWireSchema = z
  .object({
    tokens: z.number().int().nonnegative(),
    calls: z.number().int().nonnegative(),
    parts: z.array(
      z
        .object({
          kind: z.enum(["system", "tools", "results", "chat", "other"]),
          tokens: z.number().int().nonnegative(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export const GatewayUsageGroupWireSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    /** A second name under the first: a model's provider, an account's provider. */
    sub: z.string().optional(),
    ...usageTotalsFields,
    /** What this group's prompts were made of. */
    prompt: GatewayUsagePromptWireSchema.optional(),
  })
  .passthrough();

export const GatewayUsagePointWireSchema = z
  .object({
    label: z.string(),
    start: z.string(),
    calls: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    costUsd: z.number(),
  })
  .passthrough();

export const GatewayUsageRequestWireSchema = z
  .object({
    time: z.string(),
    client: z.string(),
    requested: z.string(),
    model: z.string(),
    provider: z.string(),
    account: z.string().nullable(),
    protocol: z.string(),
    upstreamProtocol: z.string().optional(),
    /** Where the call went: the upstream's host (myna's `Host`). */
    host: z.string().optional(),
    /** The reasoning the attempt was asked for (myna's `Effort`). */
    effort: z.string().optional(),
    /** What an agent made the call for when it wasn't a turn (myna's `Kind`). */
    kind: z.string().optional(),
    /** The upstream API key that served the call, fingerprint and name. */
    providerKeyId: z.string().optional(),
    providerKeyName: z.string().optional(),
    /** The routing route shared by every attempt, when tracing kept one. */
    routeId: z.number().optional(),
    /** The path the agent called (myna's `Endpoint`). */
    endpoint: z.string().optional(),
    /** Why the call failed, in the vendor's words, and what its body called it. */
    errorMessage: z.string().optional(),
    errorType: z.string().optional(),
    /** The service tier asked, sent and served (myna's `Tier*`). */
    tierAsked: z.string().optional(),
    tierSent: z.string().optional(),
    tierServed: z.string().optional(),
    /** Why the upstream said its reply ended, in its own words. */
    upstreamStop: z.string().optional(),
    /** What the reply said the call cost in its plan's credits. */
    credits: z.number().optional(),
    /** The provider and account an agent recorded for the session, not this call's. */
    sessionProvider: z.string().optional(),
    sessionAccount: z.string().optional(),
    status: z.number(),
    ok: z.boolean(),
    attempts: z.number().int().nonnegative(),
    durationMs: z.number().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative(),
    cacheWriteTokens: z.number().int().nonnegative(),
    /** Of the cache writes, the ones kept an hour; the rest were 5-minute. */
    cacheWrite1hTokens: z.number().int().nonnegative().optional(),
    reasoningTokens: z.number().int().nonnegative(),
    costUsd: z.number(),
    /** False when no price was known; a price of zero is priced. Absent before v0.15. */
    priced: z.boolean().optional(),
    ttftMs: z.number().nonnegative().optional(),
    /** A failed try a later try of the same request took over. */
    handedOn: z.boolean(),
    /** The conversation the call belongs to, when one can be told. */
    session: z.string().optional(),
    /** One id for every attempt of the request. */
    requestId: z.string().optional(),
    /** One id for the client call, shared by every candidate it tried. */
    gatewayCallId: z.string().optional(),
    /** The response object's id as the client received it, myna's ResponseID. */
    responseId: z.string().optional(),
    /** `<date>/<id>` in the request archive, when the archive kept the call. */
    archive: z.string().optional(),
    /** The gateway key, masked. */
    key: z.string().nullable(),
    keyLabel: z.string().optional(),
    /**
     * Neolix's own probe, not an agent's turn: the provider editor's test, an
     * API detection or a model list refresh. Left out of every total.
     */
    probe: z.enum(["test", "detect", "list"]).optional(),
  })
  .passthrough();

export const GatewayUsageRequestPageWireSchema = z
  .object({
    rows: z.array(GatewayUsageRequestWireSchema),
    total: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
  })
  .passthrough();

export const GatewayUsageReportWireSchema = z
  .object({
    period: GatewayUsagePeriodSchema,
    /** ISO start of the window, and its end (now, or the picked last day's end). */
    since: z.string(),
    until: z.string(),
    /** The days picked, when `period` is custom. */
    from: z.string().optional(),
    to: z.string().optional(),
    bucket: z.enum(["hour", "day", "week"]),
    totals: GatewayUsageTotalsWireSchema,
    prompt: GatewayUsagePromptWireSchema,
    series: z.array(GatewayUsagePointWireSchema),
    byClient: z.array(GatewayUsageGroupWireSchema),
    byModel: z.array(GatewayUsageGroupWireSchema),
    byProvider: z.array(GatewayUsageGroupWireSchema),
    byAccount: z.array(GatewayUsageGroupWireSchema),
    byKey: z.array(GatewayUsageGroupWireSchema),
    /** The conversations whose calls named one; empty when no client names a session. */
    bySession: z.array(GatewayUsageGroupWireSchema),
    requests: GatewayUsageRequestPageWireSchema,
    /** Where the ledger is, with the home folder as `~`, for the page's footnote. */
    path: z.string(),
  })
  .passthrough();
export type GatewayMaskingRecordWire = z.infer<typeof GatewayMaskingRecordWireSchema>;
export type GatewayMaskingSummaryWire = z.infer<typeof GatewayMaskingSummaryWireSchema>;
export type GatewayMaskingPreviewWire = z.infer<typeof GatewayMaskingPreviewWireSchema>;
export type GatewayMaskingAlertWire = z.infer<typeof GatewayMaskingAlertWireSchema>;
export type GatewayMaskingLocalModelStatusWire = z.infer<
  typeof GatewayMaskingLocalModelStatusWireSchema
>;
export type GatewayTurnDoneWire = z.infer<typeof GatewayTurnDoneWireSchema>;
export type GatewayCheckinRecordWire = z.infer<typeof GatewayCheckinRecordWireSchema>;
export type GatewayCheckinAccountWire = z.infer<typeof GatewayCheckinAccountWireSchema>;
export type GatewayCheckinEntryWire = z.infer<typeof GatewayCheckinEntryWireSchema>;
export type GatewayCheckinWire = z.infer<typeof GatewayCheckinWireSchema>;
export type GatewayConfigWire = z.infer<typeof GatewayConfigWireSchema>;
export type GatewayPriceWire = z.infer<typeof GatewayPriceWireSchema>;
export type GatewayRateWindowWire = z.infer<typeof GatewayRateWindowWireSchema>;
export type GatewayStatusWire = z.infer<typeof GatewayStatusWireSchema>;
export type GatewayAccountStatusWire = z.infer<typeof GatewayAccountStatusWireSchema>;
export type GatewayVertexWire = z.infer<typeof GatewayVertexWireSchema>;
export type GatewayProviderWire = z.infer<typeof GatewayProviderWireSchema>;
export type GatewayAccountWire = z.infer<typeof GatewayAccountWireSchema>;
export type GatewayGroupWire = z.infer<typeof GatewayGroupWireSchema>;
export type GatewayKeyWire = z.infer<typeof GatewayKeyWireSchema>;
export type GatewayKeyLimitWire = z.infer<typeof GatewayKeyLimitWireSchema>;
export type GatewayOidcRuleWire = z.infer<typeof GatewayOidcRuleWireSchema>;
export const GatewayQuotaPointWireSchema = z
  .object({
    at: z.number(),
    usedPercent: z.number().nullable(),
    resetsAt: z.number().nullable(),
    /** The computer a shared reading came from: "this" or another's id. */
    device: z.string().optional(),
  })
  .passthrough();

/**
 * A window's whole, reckoned from the calls the gateway routed through the
 * account since it began over the share the vendor says is used.
 */
export const GatewayQuotaHoldWireSchema = z
  .object({
    /** The window's whole, in input and output tokens. */
    tokens: z.number().nonnegative(),
    /** That whole at the effective prices, when every model it used had one. */
    costUsd: z.number().nonnegative(),
    priced: z.boolean(),
    calls: z.number().int().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative(),
    /** The reading the window began with. */
    since: z.number(),
  })
  .passthrough();

/** Settings → Model gateway → Usage: a gateway account's allowance cards. */
export const GatewayQuotaWindowWireSchema = z
  .object({
    id: z.string(),
    /** The vendor's own word for the window, when it has one ("5 hours", "Month"). */
    name: z.string().optional(),
    /** `allowance` is the vendor's own usage endpoint; the others are the token caps. */
    kind: z.enum(["allowance", "tokens5h", "tokens7d"]),
    usedPercent: z.number().nullable(),
    remaining: z.number().nullable(),
    limit: z.number().nullable(),
    /** When the window starts again, in ms since the epoch; null when it rolls. */
    resetsAt: z.number().nullable(),
    /** Points of allowance burned faster (+) or slower (-) than an even burn. */
    pacePct: z.number().nullable(),
    /** The window's length, for the rolling token windows. */
    windowMs: z.number().optional(),
    /** This window's readings over time, when they are its own (the token caps'). */
    history: z.array(GatewayQuotaPointWireSchema).optional(),
    /** What the whole window holds, when it could be reckoned. */
    holds: GatewayQuotaHoldWireSchema.optional(),
    /** Why it couldn't, when it couldn't. */
    holdsWhy: z.enum(["low", "clock", "none", "log"]).optional(),
  })
  .passthrough();

export const GatewayQuotaAccountWireSchema = z
  .object({
    id: z.string(),
    provider: z.string(),
    providerLabel: z.string(),
    account: z.string(),
    accountLabel: z.string(),
    /**
     * `plan` marks a provider plan's card (Ark's Coding/Agent Plan, TokenHub's
     * Token Plan), which has no gateway account; the fields below tell which.
     * COMPAT(gatewayQuotaPlanCards): added in v0.16.0, remove gate after 2027-11-06.
     */
    kind: z.literal("plan").optional(),
    /** The provider the plan belongs to. */
    providerId: z.string().optional(),
    /** The plan within it: Ark's action, or a TokenHub team id. */
    planId: z.string().optional(),
    /** Why the plan has no windows, when it doesn't (a missing access key). */
    error: z.string().optional(),
    enabled: z.boolean(),
    restingUntil: z.number().nullable(),
    windows: z.array(GatewayQuotaWindowWireSchema),
    spendUsd: z.number(),
    monthlyUsdCap: z.number().nullable(),
    /** Whether a Warm up can be asked for this account. */
    canWarm: z.boolean(),
    /** Whether the account is set to keep its window warm. */
    warmup: z.boolean(),
    lastReadAt: z.number().nullable(),
    /** The readings kept for this account, oldest first, evenly sampled. */
    history: z.array(GatewayQuotaPointWireSchema),
  })
  .passthrough();

export const GatewayQuotaWireSchema = z
  .object({
    accounts: z.array(GatewayQuotaAccountWireSchema),
    until: z.number(),
  })
  .passthrough();

export type GatewayUsagePeriodWire = z.infer<typeof GatewayUsagePeriodSchema>;
export type GatewayQuotaWindowWire = z.infer<typeof GatewayQuotaWindowWireSchema>;
export type GatewayQuotaPointWire = z.infer<typeof GatewayQuotaPointWireSchema>;
export type GatewayQuotaAccountWire = z.infer<typeof GatewayQuotaAccountWireSchema>;
export type GatewayQuotaWire = z.infer<typeof GatewayQuotaWireSchema>;
export type GatewayUsageTotalsWire = z.infer<typeof GatewayUsageTotalsWireSchema>;
export type GatewayUsagePromptWire = z.infer<typeof GatewayUsagePromptWireSchema>;
export type GatewayUsageGroupWire = z.infer<typeof GatewayUsageGroupWireSchema>;
export type GatewayUsagePointWire = z.infer<typeof GatewayUsagePointWireSchema>;
export type GatewayUsageRequestWire = z.infer<typeof GatewayUsageRequestWireSchema>;
export type GatewayUsageRequestPageWire = z.infer<typeof GatewayUsageRequestPageWireSchema>;
export type GatewayUsageReportWire = z.infer<typeof GatewayUsageReportWireSchema>;
