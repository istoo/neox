// FILE: gatewayTypes.ts
// Purpose: The parts of the daemon's gateway documents the settings page reads or
//          writes. The daemon owns these shapes (packages/protocol/src/gateway.ts);
//          the bridge forwards them as JSON, so fields this file omits still make
//          the round trip when the page saves a whole document.
// Layer: Web settings types

export interface GatewayModel {
  id: string;
  label?: string | undefined;
  contextWindow?: number | undefined;
  maxOutputTokens?: number | undefined;
  kind?: "chat" | "image" | "video" | undefined;
  images?: boolean | undefined;
  picked?: boolean | undefined;
  released?: string | undefined;
}

export interface GatewayAccountQuota {
  tokens5h?: number | undefined;
  tokens7d?: number | undefined;
}

export interface GatewayAccount {
  id: string;
  label?: string | undefined;
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  headers?: Record<string, string> | undefined;
  priority?: number | undefined;
  weight?: number | undefined;
  maxConcurrency?: number | undefined;
  maxRpm?: number | undefined;
  models?: string[] | undefined;
  monthlyUsd?: number | undefined;
  enabled?: boolean | undefined;
  proxy?: string | undefined;
  usageUrl?: string | undefined;
  usageIntervalMs?: number | undefined;
  warmup?: boolean | undefined;
  quota?: GatewayAccountQuota | undefined;
  agent?: string | undefined;
  subscriptionUser?: string | undefined;
  /** Before a Codex reset expires, when its week runs out, or both. */
  autoReset?: "week" | "expiring" | "auto" | undefined;
  /** How the account spends its credits once a usage window is used up. */
  creditsMode?: "on" | "first" | "last" | "off" | undefined;
  /** Time of day to start its 5-hour window at, "off", or "" for its agent's list. */
  warmAt?: string | undefined;
  /** The `CLAUDE_CONFIG_DIR` this account's Claude Code keeps its sign-in in. */
  configDir?: string | undefined;
}

/** A provider's time-of-day price multiplier. */
export interface GatewayRateWindow {
  days?: number[] | undefined;
  start: string;
  end: string;
  rate: number;
}

export interface GatewayPrice {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok?: number | undefined;
  cacheWritePerMTok?: number | undefined;
  cacheWrite1hPerMTok?: number | undefined;
  tiers?:
    | Array<{
        aboveTokens: number;
        inputPerMTok: number;
        outputPerMTok: number;
        cacheReadPerMTok?: number | undefined;
        cacheWritePerMTok?: number | undefined;
        cacheWrite1hPerMTok?: number | undefined;
      }>
    | undefined;
}

export type GatewayProtocol = "anthropic" | "openai" | "openai-responses" | "gemini";

export interface GatewayProviderPresetRegion {
  id: string;
  name: string;
  endpoints: Partial<Record<GatewayProtocol, string>>;
  website?: string | undefined;
  keysUrl?: string | undefined;
  catalog?: string | undefined;
  decide?: string | undefined;
}

export interface GatewayProviderPreset {
  id: string;
  name: string;
  fullName?: string | undefined;
  kind: "vendor" | "relay" | "local";
  endpoints: Partial<Record<GatewayProtocol, string>>;
  website?: string | undefined;
  keysUrl?: string | undefined;
  note?: string | undefined;
  vertex?: boolean | undefined;
  models?: readonly string[] | undefined;
  catalog?: string | undefined;
  decide?: string | undefined;
  regionLabel?: string | undefined;
  regions?: readonly GatewayProviderPresetRegion[] | undefined;
}

export interface GatewayProvider {
  id: string;
  label?: string | undefined;
  protocol: GatewayProtocol;
  baseUrl: string;
  modelsUrl?: string | undefined;
  apiKey?: string | undefined;
  headers?: Record<string, string> | undefined;
  accounts?: GatewayAccount[] | undefined;
  enabled?: boolean | undefined;
  exposeModels?: boolean | undefined;
  modelMode?: "list" | "picked" | "best" | "none" | undefined;
  unredacted?: boolean | undefined;
  searches?: boolean | undefined;
  maxAccounts?: number | undefined;
  queueWaitMs?: number | undefined;
  sink?: boolean | undefined;
  priceRate?: number | undefined;
  insecureTls?: boolean | undefined;
  balanceUrl?: string | undefined;
  balancePath?: string | undefined;
  balanceMethod?: "GET" | "POST" | undefined;
  /** An account's own token, asked instead of the key where a vendor wants one. */
  balanceToken?: string | undefined;
  /** The upstream answers a web search tool by itself (read-only for the app). */
  searchesUpstream?: boolean | undefined;
  vertex?:
    | {
        project?: string | undefined;
        location?: string | undefined;
        credentials?: string | undefined;
        impersonate?: string | undefined;
      }
    | undefined;
  decide?: string | undefined;
  family?: string | undefined;
  icon?: string | undefined;
  extraBody?: Record<string, unknown> | undefined;
  rateWindows?: GatewayRateWindow[] | undefined;
  countFree?: boolean | undefined;
  switchOnly?: boolean | undefined;
  restartApp?: boolean | undefined;
  models: GatewayModel[];
  videoApi?: "openai" | "ark" | "minimax" | "grok" | undefined;
  [key: string]: unknown;
}

export interface GatewayGroupTime {
  from: string;
  to: string;
  days?: string[] | undefined;
  zone?: string | undefined;
}

export type GatewayEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface GatewayGroupRule {
  use: string;
  more?: string[] | undefined;
  useEffort?: GatewayEffort | undefined;
  tokens?: number | undefined;
  images?: boolean | undefined;
  effort?: string | undefined;
  agents?: string[] | undefined;
  time?: GatewayGroupTime | undefined;
  pause?: boolean | undefined;
  intent?: string | undefined;
  compact?: boolean | undefined;
  folders?: string[] | undefined;
  exceptFolders?: string[] | undefined;
}

export interface GatewayGroup {
  id: string;
  label?: string | undefined;
  members: string[];
  strategy?: string | undefined;
  weighted?: boolean | undefined;
  weights?: Record<string, number> | undefined;
  fast?: string[] | undefined;
  accounts?: string[] | undefined;
  rules?: GatewayGroupRule[] | undefined;
  match?: string[] | undefined;
  off?: string[] | undefined;
  pick?: string | undefined;
  disabled?: boolean | undefined;
  levels?: string[] | undefined;
  context?: number | undefined;
  auto?: boolean | undefined;
  [key: string]: unknown;
}

export interface GatewayKeyLimit {
  period: "day" | "week" | "month" | "days" | "hours";
  days?: number | undefined;
  hours?: number | undefined;
  tokens?: number | undefined;
  cost?: number | undefined;
  cacheReads?: boolean | undefined;
  since?: string | undefined;
}

export interface GatewayKeyObject {
  key: string;
  label?: string | undefined;
  models?: string[] | undefined;
  dailyTokens?: number | undefined;
  monthlyUsd?: number | undefined;
  limits?: GatewayKeyLimit[] | undefined;
  ratePerMinute?: number | undefined;
  searchCallsPerMonth?: number | undefined;
  readOnly?: boolean | undefined;
  expiresAt?: string | undefined;
  issues?: boolean | undefined;
  issuer?: string | undefined;
}

export type GatewayKey = string | GatewayKeyObject;

export interface GatewayMaskingConfig {
  enabled: boolean;
  personal?: boolean | undefined;
  allow?: string[] | undefined;
  categories?: string[] | undefined;
  actions?: Record<string, "mask" | "warn" | "block"> | undefined;
  shape?: boolean | undefined;
  categorySwitches?: Record<string, boolean> | undefined;
  words?: string[] | undefined;
  wordsAnyCase?: boolean | undefined;
  wordsWhole?: boolean | undefined;
  routeTo?: string | undefined;
  model?: string | undefined;
  modelScore?: number | undefined;
  alert?: boolean | undefined;
  rules?: Array<{ kind: string; prefix?: string; pattern: string; flags?: string }> | undefined;
}

export interface GatewaySearchApi {
  vendor: string;
  key?: string | undefined;
  url?: string | undefined;
  pick?: "" | "order" | undefined;
  off?: boolean | undefined;
}

export interface GatewayConfig {
  version: 1;
  enabled?: boolean | undefined;
  allowIPs?: string[] | undefined;
  corsOrigins?: string[] | undefined;
  keys?: GatewayKey[] | undefined;
  pricing?: Record<string, GatewayPrice | null> | undefined;
  modelSameAs?: Record<string, string> | undefined;
  budget?: { monthlyUsd?: number | undefined } | undefined;
  recording?: { enabled?: boolean | undefined } | undefined;
  modelNames?: "off" | "own" | "on" | undefined;
  bareModelIDs?: boolean | undefined;
  busyLoad?: number | undefined;
  codexWarmup?: "off" | "week" | "all" | undefined;
  claudeWarmup?: "off" | "week" | "all" | undefined;
  quotaReads?: "asked" | undefined;
  codexAgentsV1?: boolean | undefined;
  codexSubagentModel?: string | undefined;
  fullContext?: boolean | undefined;
  compactAt?: number | undefined;
  codexAsyncCompact?: boolean | undefined;
  codexAsyncCompactPercent?: number | undefined;
  codexTitles?: string | undefined;
  codexDescriptions?: string | undefined;
  codexPredictions?: string | undefined;
  codexAutoReview?: string | undefined;
  codexMemories?: string | undefined;
  turnDoneSeconds?: number | undefined;
  claudePrintMode?: boolean | undefined;
  providers?: GatewayProvider[] | undefined;
  groups?: GatewayGroup[] | undefined;
  autoGroups?: boolean | undefined;
  autoGroupSkip?: string[] | undefined;
  groupOrder?: string[] | undefined;
  hiddenGroups?: string[] | undefined;
  disabledModels?: string[] | undefined;
  middleware?:
    | {
        aliases?: Record<string, string> | undefined;
        overrides?: unknown[] | undefined;
      }
    | undefined;
  masking?: GatewayMaskingConfig | undefined;
  search?:
    | {
        enabled?: boolean | undefined;
        url?: string | undefined;
        apiKey?: string | undefined;
        monthlyCalls?: number | null | undefined;
        apis?: GatewaySearchApi[] | undefined;
        searcher?: string | undefined;
        searcherThen?: string[] | undefined;
        searchFirst?: "" | "model" | "api" | undefined;
        searchAll?: boolean | undefined;
      }
    | undefined;
  oidc?: { rules?: GatewayOidcRule[] | undefined } | undefined;
  archive?:
    | { local?: boolean | undefined; maxMB?: number | undefined; keepMB?: number | undefined }
    | undefined;
  vision?: { model?: string | undefined; effort?: string | undefined } | undefined;
  otel?: Record<string, unknown> | undefined;
  proxy?: string | undefined;
  [key: string]: unknown;
}

export interface GatewayOidcRule {
  id?: string | undefined;
  key: string;
  issuer: string;
  audience?: string | undefined;
  claims?: Record<string, string> | undefined;
  ttlSeconds?: number | undefined;
}

export interface GatewaySearchVendor {
  vendor: string;
  name: string;
  keysURL?: string | undefined;
  keyOptional?: boolean | undefined;
  needURL?: boolean | undefined;
}

export interface GatewayConfigResult {
  config: GatewayConfig;
  status: GatewayStatus;
  searchVendors?: GatewaySearchVendor[] | undefined;
}

export interface GatewayAccountStatus {
  provider: string;
  account: string;
  enabled: boolean;
  priority: number;
  weight: number;
  inflight: number;
  restingUntil: number | null;
  tokens5h: number;
  tokens7d: number;
  tokens5hCap?: number | null | undefined;
  tokens7dCap?: number | null | undefined;
  spendUsd?: number | undefined;
  monthlyUsdCap?: number | null | undefined;
  usedPercent?: number | null | undefined;
}

export interface GatewayRecentCall {
  time: string;
  requested: string;
  provider: string;
  account: string | null;
  model: string;
  status: number;
  ok: boolean;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface GatewayStatus {
  enabled: boolean;
  startedAt: number;
  monthSpendUsd: number;
  budgetUsd: number | null;
  proxy?: string | undefined;
  proxySource?: string | undefined;
  accounts: GatewayAccountStatus[];
  served: Array<{ key: string; count: number }>;
  recent?: GatewayRecentCall[] | undefined;
}

export interface GatewayUsageTotals {
  calls: number;
  failed: number;
  retried: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  costUsd: number;
  unpricedCalls: number;
  handedOn: number;
  cacheHitRate: number | null;
  meanTtftMs: number | null;
}

export interface GatewayUsageGroup extends GatewayUsageTotals {
  id: string;
  name: string;
  sub?: string | undefined;
}

export interface GatewayUsagePoint {
  label: string;
  start: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface GatewayUsageRequest {
  time: string;
  client: string;
  requested: string;
  model: string;
  provider: string;
  account: string | null;
  protocol: string;
  status: number;
  ok: boolean;
  attempts: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number | undefined;
  cacheWriteTokens?: number | undefined;
  cacheWrite1hTokens?: number | undefined;
  reasoningTokens?: number | undefined;
  ttftMs?: number | undefined;
  handedOn?: boolean | undefined;
  probe?: "test" | "detect" | "list" | undefined;
  requestId?: string | undefined;
  gatewayCallId?: string | undefined;
  responseId?: string | undefined;
  archive?: string | undefined;
  sessionProvider?: string | undefined;
  sessionAccount?: string | undefined;
  effort?: string | undefined;
  kind?: string | undefined;
  providerKeyId?: string | undefined;
  providerKeyName?: string | undefined;
  routeId?: number | undefined;
  endpoint?: string | undefined;
  errorType?: string | undefined;
  upstreamProtocol?: string | undefined;
  tierAsked?: string | undefined;
  tierSent?: string | undefined;
  tierServed?: string | undefined;
  upstreamStop?: string | undefined;
  credits?: number | undefined;
  costUsd: number;
  priced?: boolean | undefined;
  errorMessage?: string | undefined;
  session?: string | undefined;
  key: string | null;
  keyLabel?: string | undefined;
  [key: string]: unknown;
}

export interface GatewayUsageReport {
  period: string;
  since: string;
  until: string;
  from?: string | undefined;
  to?: string | undefined;
  bucket: "hour" | "day" | "week";
  totals: GatewayUsageTotals;
  prompt?:
    | {
        tokens: number;
        calls: number;
        parts: Array<{ kind: string; tokens: number }>;
      }
    | undefined;
  series: GatewayUsagePoint[];
  byClient: GatewayUsageGroup[];
  byModel: GatewayUsageGroup[];
  byProvider: GatewayUsageGroup[];
  byAccount: GatewayUsageGroup[];
  byKey: GatewayUsageGroup[];
  bySession: GatewayUsageGroup[];
  requests: { rows: GatewayUsageRequest[]; total: number; offset: number; limit: number };
  path: string;
}

export interface GatewayQuotaWindow {
  id: string;
  name?: string | undefined;
  kind: "allowance" | "tokens5h" | "tokens7d";
  usedPercent: number | null;
  remaining: number | null;
  limit: number | null;
  resetsAt: number | null;
  pacePct: number | null;
  windowMs?: number | undefined;
  holds?: { tokens: number; costUsd: number; priced: boolean; calls: number } | undefined;
  holdsWhy?: string | undefined;
}

export interface GatewayQuotaAccount {
  id: string;
  provider: string;
  providerLabel: string;
  account: string;
  accountLabel: string;
  kind?: "plan" | undefined;
  providerId?: string | undefined;
  planId?: string | undefined;
  error?: string | undefined;
  enabled: boolean;
  restingUntil: number | null;
  windows: GatewayQuotaWindow[];
  spendUsd: number;
  monthlyUsdCap: number | null;
  canWarm: boolean;
  warmup: boolean;
  lastReadAt: number | null;
  history: Array<{
    at: number;
    usedPercent: number | null;
    resetsAt: number | null;
    device?: string | undefined;
  }>;
}

export interface GatewayQuota {
  accounts: GatewayQuotaAccount[];
  until: number;
}

export interface GatewayMaskingSummary {
  n: number;
  distinct: number;
  requests: number;
  blocked: number;
  restored: number;
  days: Array<{ day: string; n: number; requests: number }>;
  kinds: Array<{ name: string; n: number }>;
  agents: Array<{ name: string; n: number }>;
  providers: Array<{ name: string; n: number }>;
  values: Array<{
    p: string;
    k: string;
    b: string;
    h?: string | undefined;
    l: number;
    n: number;
    requests: number;
    last: string;
  }>;
  by: { rule: number; yours: number; model: number };
}

export interface GatewayMaskingRecord {
  key: string;
  t: string;
  gatewayCallId?: string | undefined;
  agent?: string | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  n: number;
  took?: number | undefined;
  blocked?: boolean | undefined;
  values: Array<{
    p: string;
    k: string;
    b: string;
    h?: string | undefined;
    l: number;
    n: number;
    a?: "mask" | "warn" | "block" | undefined;
  }>;
  back?: Record<string, number> | undefined;
  [key: string]: unknown;
}

export interface GatewayMaskingPreview {
  text: string;
  hits: Array<{
    placeholder: string;
    kind: string;
    by: string;
    head?: string | undefined;
    len: number;
    action?: "mask" | "warn" | "block" | undefined;
  }>;
  blocked: boolean;
  off: boolean;
}

export interface GatewayLocalModelStatus {
  model: string;
  supported: boolean;
  installed: boolean;
  size: number;
  downloading?: boolean | undefined;
  done?: number | undefined;
  total?: number | undefined;
  error?: string | undefined;
  running?: boolean | undefined;
  device?: string | undefined;
  loadMs?: number | undefined;
  failed?: string | undefined;
  score?: number | undefined;
  [key: string]: unknown;
}

export interface GatewayHeldReport {
  name: string;
  at?: string | undefined;
  model?: string | undefined;
  [key: string]: unknown;
}

export interface GatewayRouteHistoryRow {
  id: string;
  time: string;
  asked?: string | undefined;
  served?: string | undefined;
  model?: string | undefined;
  group?: string | undefined;
  client?: string | undefined;
  session?: string | undefined;
  done?: boolean | undefined;
  status?: number | null | undefined;
  millis?: number | null | undefined;
  tries?:
    | Array<{
        provider?: string | undefined;
        account?: string | null | undefined;
        model?: string | null | undefined;
        status?: number | null | undefined;
        millis?: number | null | undefined;
        error?: string | null | undefined;
      }>
    | undefined;
  error?: string | undefined;
  responseId?: string | undefined;
  /** `<date>/<id>` in the request archive, when the archive kept the call. */
  archive?: string | undefined;
  /** The held-request report's file name, when Neox held the request. */
  held?: string | undefined;
  /** Codex's hidden turn kind, for a title request. */
  kind?: string | undefined;
  /** The conversation a title turn belongs to. */
  parentSession?: string | undefined;
  parentMatched?: boolean | undefined;
}

/** One side of an archived call: its headers and body. */
export interface GatewayArchivePart {
  method?: string | undefined;
  path?: string | undefined;
  status?: number | undefined;
  headers: Record<string, string[]>;
  body: string;
  size?: number | undefined;
  truncated?: boolean | undefined;
}

/** Each request the gateway sent upstream for an archived call. */
export interface GatewayArchiveUpstream {
  method: string;
  url: string;
  request: Record<string, string[]>;
  status: number;
  response: Record<string, string[]>;
  millis: number;
  error?: string | undefined;
}

/** One call the request archive kept, as `gateway.getArchive` returns it. */
export interface GatewayArchiveRecord {
  id: string;
  time: string;
  request: GatewayArchivePart;
  response: GatewayArchivePart;
  upstream?: GatewayArchiveUpstream[] | undefined;
}

export interface GatewayTraceRoute {
  id: number;
  time: number;
  agent: string;
  key: string | null;
  model: string;
  routedModel: string;
  group: string | null;
  strategy: string;
  provider: string | null;
  seats: Array<{
    id: string;
    provider: string;
    providerLabel: string;
    account: string | null;
    model: string;
    rank: number;
    restingUntil: number | null;
    served: number;
  }>;
  tries: Array<{
    provider: string;
    account: string | null;
    model: string;
    status: number | null;
    millis: number | null;
    error: string | null;
  }>;
  done: boolean;
  status: number | null;
  error: string | null;
  millis: number | null;
  prompt: { tokens: number; window: number | null } | null;
  masked: boolean;
}

export interface GatewayTrace {
  routes: GatewayTraceRoute[];
  stats: { requests: number; rerouted: number; errors: number; active: number };
}

export interface GatewayProbeTarget {
  protocol: GatewayProtocol;
  baseUrl: string;
  apiKey?: string | undefined;
  headers?: Record<string, string> | undefined;
  insecureTls?: boolean | undefined;
  modelsUrl?: string | undefined;
  providerId?: string | undefined;
}

export interface GatewayProviderTestResult {
  ok: boolean;
  status: number;
  latencyMs: number;
  error: string | null;
}

export interface GatewayProviderDetectResult {
  results: Array<{
    protocol: GatewayProtocol;
    base: string;
    ok: boolean;
    status: number;
    error: string | null;
  }>;
}

export interface GatewayProviderModelsResult {
  models: string[];
  error: string | null;
}

export interface GatewayProviderBalanceResult {
  amount: string | null;
  error?: string | undefined;
}

export interface GatewayImportSource {
  id: string;
  name: string;
  path: string;
  found: boolean;
  error?: string | undefined;
  providers: Array<{
    source: string;
    ref: string;
    name: string;
    protocol: GatewayProtocol;
    baseUrl: string;
    apiKey?: string | undefined;
    models: string[];
    headers?: Record<string, string> | undefined;
    enabled?: boolean | undefined;
  }>;
}

export interface GatewayUpstreamStatus {
  statuses: Array<{
    vendor: string;
    name: string;
    page: string;
    hosts: string[];
    level: "ok" | "maintenance" | "degraded" | "partial" | "major" | null;
    parts: Array<{ name: string; status: string }>;
    incidents: Array<{ name: string; impact?: string; url?: string }>;
    readAt: string | null;
    error?: string | undefined;
  }>;
}

export interface GatewayPricingResult {
  prices: Record<string, GatewayPrice | null>;
}

/** The daemon's read on how a Claude subscription's runs are made. */
export interface GatewayClaudeMode {
  tui: boolean;
  why: "" | "os" | "missing" | "off";
  last: { tui: boolean; why: string; at: number } | null;
}

export interface GatewayClaudeModeResult {
  mode: GatewayClaudeMode;
}

export const GATEWAY_SUBSCRIPTION_AGENTS = [
  "claude-code",
  "chatgpt-api",
  "copilot",
  "gemini",
  "antigravity",
  "factory",
] as const;

export interface GatewayPluginSubscriptionPrompt {
  type: "text" | "select";
  key: string;
  message: string;
  placeholder?: string | undefined;
  options?: Array<{ label: string; value: string }> | undefined;
}

export interface GatewayPluginSubscriptionMethod {
  type: "oauth" | "api";
  label: string;
  prompts?: GatewayPluginSubscriptionPrompt[] | undefined;
}

export interface GatewayPluginSubscriptionProvider {
  pluginId: string;
  id: string;
  label: string;
  protocol: string;
  methods: GatewayPluginSubscriptionMethod[];
  options?: Record<string, unknown> | undefined;
}

export interface GatewayPluginSubscriptionsResult {
  providers: GatewayPluginSubscriptionProvider[];
}

export interface GatewayPluginSubscriptionSignInResult {
  status: "signed_in" | "pending";
  token?: string | undefined;
  url?: string | undefined;
  instructions?: string | undefined;
}

export interface GatewayCheckin {
  accounts?:
    | Array<{
        by: string;
        key: string;
        user: string;
        on: boolean;
        again?: boolean | undefined;
        record?:
          | {
              day: string;
              at: string;
              outcome: string;
              credit?: number | undefined;
              streak?: number | undefined;
              msg?: string | undefined;
              until?: string | undefined;
              offline?: boolean | undefined;
              tries?: number | undefined;
              claimed?: string | undefined;
            }
          | undefined;
      }>
    | undefined;
  switches?: Record<string, boolean> | undefined;
  [key: string]: unknown;
}

export interface GatewayTuneAdvice {
  advice?:
    | Array<{
        agent: string;
        calls: number;
        compact?:
          | {
              best: string;
              cost: number;
              low: number;
              model?: string | undefined;
              current?: number | undefined;
              setting?: { ours?: boolean | undefined; locked?: string | undefined } | undefined;
            }
          | undefined;
        ttl?:
          | {
              best: string;
              cost: number;
              low: number;
              current?: string | undefined;
              setting?: { ours?: boolean | undefined; locked?: string | undefined } | undefined;
            }
          | undefined;
      }>
    | undefined;
  [key: string]: unknown;
}

/** One search API key's usage, as Tavily's /usage reports it. */
export interface GatewaySearchKeyQuota {
  /** The key, masked. */
  key: string;
  /** Read, or unknown with `err`. */
  known: boolean;
  unlimited?: boolean | undefined;
  used: number;
  limit: number;
  /** What the limit belongs to: the key itself, or its account's plan. */
  of?: "key" | "plan" | undefined;
  plan?: string | undefined;
  paygoLeft?: number | undefined;
  usedUp?: boolean | undefined;
  err?: string | undefined;
}

export interface GatewaySearchQuotaResult {
  keys: GatewaySearchKeyQuota[];
}

export interface GatewaySubscriptionAccount {
  id: string;
  agent: string;
  user: string;
  label?: string | undefined;
  alias?: string | undefined;
  plan?: string | null | undefined;
  active?: boolean | undefined;
  lapsed?: string | null | undefined;
  [key: string]: unknown;
}

/** The daemon's sign-in flow state, as `gateway.signin.*` reports it. */
export interface GatewaySignInState {
  id: string;
  agent: string;
  state: "installing" | "waiting" | "done" | "failed" | "canceled";
  url?: string | undefined;
  code?: string | undefined;
  pasteCallback?: boolean | undefined;
  instructions?: string | undefined;
  user?: string | undefined;
  plan?: string | undefined;
  error?: string | undefined;
  /** Where the account signs in, for Copilot's enterprise host. */
  site?: string | undefined;
  callbackBlocked?: "reserved" | "busy" | undefined;
  callbackPort?: number | undefined;
  /** The account was listed already: its sign-in was renewed. */
  again?: boolean | undefined;
  [key: string]: unknown;
}

/** One ChatGPT account the gateway signed in itself. */
export interface GatewayCodexAccount {
  id: string;
  label: string;
  plan: string | null;
  accountId: string | null;
  expiresAt: number | null;
  addedAt: number;
  disabled?: boolean | undefined;
  [key: string]: unknown;
}

export interface GatewayCodexAccountsResult {
  discovery?: boolean | undefined;
  owned: GatewayCodexAccount[];
  /** The sign-in Codex itself keeps, or why it was not read. */
  codex?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export interface GatewayCodexImportResult {
  added: number;
  updated: number;
  failed: Array<{ file: string; error: string }>;
}
