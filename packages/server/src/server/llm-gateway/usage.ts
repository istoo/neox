import { appendFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { Logger } from "pino";
import { notePendingRecord } from "./budget.js";

export const GATEWAY_USAGE_FILENAME = "gateway-usage.jsonl";

/** How fast an upstream answered lately, for `fast` routing. */
export interface CandidateSpeed {
  ttft: number;
  tps: number;
}

export interface UsageRecord {
  time: string;
  requested: string;
  provider: string;
  /** Which credential served the request; null when the provider has none. */
  account: string | null;
  model: string;
  protocol: string;
  status: number;
  ok: boolean;
  inputTokens: number;
  outputTokens: number;
  attempts: number;
  durationMs: number;
  /** Cost at the effective price, in USD. */
  costUsd: number;
  /**
   * Whether a price was known for the call. Absent in records written before
   * it existed; a price of zero is priced, an unknown price is not.
   */
  priced?: boolean;
  /** The gateway key that made the request; null for loopback without keys. */
  key: string | null;
  /**
   * Where the call went: the upstream's host, after an account's own base
   * URL, as myna's `Host` names provider.Where.
   */
  host?: string;
  /** The reasoning the attempt was asked for, when it was pinned or ruled. */
  effort?: string;
  /**
   * What the agent made the call for when it isn't a turn of the
   * conversation (Codex's `request_kind`, a subagent's kind): myna's `Kind`.
   */
  kind?: string;
  /** The fingerprint of the upstream API key that served the call, myna's `ProviderKeyID`. */
  providerKeyId?: string;
  /** That key's name ("default", an account's label), myna's `ProviderKeyName`. */
  providerKeyName?: string;
  /** The routing route shared by every attempt of the request, when tracing kept one. */
  routeId?: number;
  /** The path the agent called, myna's `Endpoint`. */
  endpoint?: string;
  /** Why the call failed, in the vendor's words and cut short, myna's `Err`. */
  errorMessage?: string;
  /** What the vendor's refusal body called the error, myna's `ErrType`. */
  errorType?: string;
  /** The service tier the client asked for, myna's `TierAsked`. */
  tierAsked?: string;
  /** The tier this attempt sent after a fast pick, myna's `TierSent`. */
  tierSent?: string;
  /** The tier the vendor's reply said it ran at, myna's `TierServed`. */
  tierServed?: string;
  /** Why the upstream said its reply ended, in its own words, myna's `Stop`. */
  upstreamStop?: string;
  /** What the vendor said the call cost in its plan's own credits, myna's `Credits`. */
  credits?: number;
  /** The provider ID the agent recorded for the session, myna's `SessionProvider`. */
  sessionProvider?: string;
  /** The session's creator, not the account that served the call, myna's `SessionAccount`. */
  sessionAccount?: string;
  /**
   * The agent behind the request, from its User-Agent (see `clientOfUserAgent`).
   * Absent in records written before the usage report read it.
   */
  client?: string;
  /** The protocol the request went upstream in, when it differs from `protocol`. */
  upstreamProtocol?: string;
  /**
   * The conversation the request belongs to. `x-neolix-conversation` first,
   * then the headers the agents name a session in, then an id derived from
   * how the conversation opens (see `sessionOfRequest`).
   */
  session?: string;
  /**
   * One id per request, shared by every attempt of it, so a failure a later
   * try took over can be told from the request's outcome. Absent in records
   * written before it existed.
   */
  requestId?: string;
  /**
   * One id for the client call, stable across every candidate it tried.
   * `requestId` is scoped to one candidate's attempts; this is the call the
   * reader sees as one row. Absent in records written before it existed.
   */
  gatewayCallId?: string;
  /**
   * What the request's prompt was made of, estimated from its body the way
   * routing's `summarizePrompt` reads it.
   */
  prompt?: UsagePromptSummary;
  /** Prompt tokens the vendor served from its cache (optional: older records have none). */
  cacheReadTokens?: number;
  /** Prompt tokens written to the vendor's cache. */
  cacheWriteTokens?: number;
  /** Of those, the ones the vendor kept for an hour (Anthropic's 1-hour TTL). */
  cacheWrite1hTokens?: number;
  /** Reasoning tokens, for vendors that count them inside the output. */
  reasoningTokens?: number;
  /** Milliseconds from the request to the first streamed token. */
  ttftMs?: number;
  /**
   * Neolix's own probe, outside any agent's turn: the provider editor's test,
   * an API detection, or a model list refresh. The row is kept in the request
   * log but never counted in usage or cost — myna's probelog.
   */
  probe?: "test" | "detect" | "list";
  /** `<date>/<id>` in the request archive, when it kept the call. */
  archive?: string;
  /** The response object's id as the client received it, myna's ResponseID. */
  responseId?: string;
}

/** What a request's prompt was made of, in the parts the usage report reads. */
export interface UsagePromptSummary {
  /** Estimated tokens in the whole prompt. */
  tokens: number;
  parts: { kind: string; tokens: number }[];
}

/**
 * The headers agents name their conversation in, in the order myna reads
 * them. `x-neolix-conversation` comes first: a client that names its
 * conversation to Neolix is believed over any other header.
 */
const SESSION_HEADERS = [
  "x-neolix-conversation",
  "x-opencode-session",
  "x-session-affinity",
  "x-session-id",
  "session_id",
  "session-id",
  "x-claude-code-session-id",
  "x-conversation-id",
  "x-deepseek-harness-session-id",
] as const;

/**
 * The conversation a request belongs to, myna's rule: its own header first
 * (Neolix's here), then the headers the agents send, then an id derived from
 * how the conversation opens — the first user message, which every later turn
 * of the conversation repeats. A request with no user message and no session
 * header belongs to no session.
 */
export function sessionOfRequest(
  headers: Record<string, string | string[] | undefined>,
  body: unknown,
): string | null {
  for (const name of SESSION_HEADERS) {
    const raw = headers[name];
    const value = Array.isArray(raw) ? raw[0] : raw;
    const trimmed = (value ?? "").trim();
    if (trimmed.length > 0) {
      return trimmed.slice(0, 128);
    }
  }
  const opening = conversationOpening(body);
  if (opening === null) {
    return null;
  }
  const digest = createHash("sha256").update(opening).digest("hex").slice(0, 24);
  return `neolix-${digest}`;
}

/** The first user turn of a chat body, as text, in the protocol shapes the gateway takes. */
function conversationOpening(body: unknown): string | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  const record = body as Record<string, unknown>;
  const items =
    firstArray(record.messages) ?? firstArray(record.contents) ?? firstArray(record.input);
  if (items === null) {
    return null;
  }
  for (const item of items) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      continue;
    }
    const message = item as Record<string, unknown>;
    const role = typeof message.role === "string" ? message.role : "";
    // Gemini leaves the role off a user turn; Chat and Responses do not.
    if (role !== "" && role !== "user") {
      continue;
    }
    const text = textOfMessage(message);
    if (text.length > 0) {
      return `${role}\n${text}`;
    }
  }
  return null;
}

function firstArray(value: unknown): unknown[] | null {
  return Array.isArray(value) && value.length > 0 ? value : null;
}

function textOfMessage(message: Record<string, unknown>): string {
  const content = message.content ?? message.parts;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push(part);
    } else if (typeof part === "object" && part !== null) {
      const text = (part as Record<string, unknown>).text;
      if (typeof text === "string") {
        parts.push(text);
      }
    }
  }
  return parts.join("\n");
}

/**
 * The agent a User-Agent names, lower-cased: Neolix's own agents first, then
 * whatever product name the header carries. An HTTP library or an API SDK
 * (`curl`, `node`, `openai`, ...) says nothing of which agent is calling, so
 * it reads as "other" — myna's rule, so a script does not get an agent's
 * scorecard.
 */
export function clientOfUserAgent(userAgent: string | undefined): string {
  const name = (userAgent ?? "").trim().split("/")[0]?.split(" ")[0]?.toLowerCase() ?? "";
  if (name.length === 0) {
    return "other";
  }
  const exact = AGENT_USER_AGENTS.get(name);
  if (exact !== undefined) {
    return exact;
  }
  for (const [prefix, id] of AGENT_USER_AGENT_PREFIXES) {
    if (name.startsWith(prefix)) {
      return id;
    }
  }
  return LIBRARY_USER_AGENTS.has(name) ? "other" : name;
}

const AGENT_USER_AGENTS = new Map<string, string>([
  ["claude", "claude-code"],
  ["claude-cli", "claude-code"],
  ["claude-code", "claude-code"],
  ["codex", "codex"],
  ["codex_cli_rs", "codex"],
  ["copilot", "copilot"],
  ["opencode", "opencode"],
  ["pi", "pi"],
  ["pi-desktop", "pi"],
  ["antigravity", "antigravity"],
  ["muse-code", "muse-code"],
  ["neolix", "neolix"],
]);

/** Versioned names: "claude-cli/2.1.0 (external, cli)", "codex_cli_rs/0.48". */
const AGENT_USER_AGENT_PREFIXES: readonly (readonly [string, string])[] = [
  ["claude-cli/", "claude-code"],
  ["claude-code/", "claude-code"],
  ["codex_cli_rs/", "codex"],
  ["github-copilot", "copilot"],
  ["opencode/", "opencode"],
  ["pi-desktop/", "pi"],
  ["antigravity/", "antigravity"],
  ["muse-code/", "muse-code"],
  ["neolix/", "neolix"],
];

const LIBRARY_USER_AGENTS = new Set([
  "curl",
  "wget",
  "httpie",
  "postmanruntime",
  "insomnia",
  "bun",
  "node",
  "deno",
  "node-fetch",
  "undici",
  "axios",
  "got",
  "ky",
  "python",
  "python-httpx",
  "httpx",
  "python-requests",
  "python-urllib",
  "urllib3",
  "aiohttp",
  "go-http-client",
  "okhttp",
  "java",
  "java-http-client",
  "apache-httpclient",
  "ruby",
  "guzzlehttp",
  "dart",
  "reqwest",
  "libcurl",
  "openai",
  "asyncopenai",
  "anthropic",
  "asyncanthropic",
  "ai-sdk",
  "google-genai-sdk",
]);

export interface UsageLedgerOptions {
  neolixHome: string;
  logger: Logger;
}

/** How many recent calls the ring keeps; myna's recentMost in gateway.go:700. */
const RECENT_CALLS_MOST = 40;

/** One served call, as the allowance cards replay it: who it went through and what it cost. */
export interface AccountTokenEntry {
  at: number;
  provider: string;
  account: string;
  tokens: number;
  /** What the call cost at the effective price, for the whole-window estimate. */
  costUsd: number;
  cacheReadTokens: number;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60_000;

/**
 * Appends one JSON line per request and keeps the counters routing needs:
 * served requests per upstream for `least-used`, spend per month, tokens per
 * key and per account for quotas. The file is replayed on start so a restart
 * does not forget this month's spend.
 */
export class UsageLedger {
  public readonly filePath: string;
  /** Called for each row as it is recorded, e.g. to export a trace span. */
  public onRecord: ((entry: UsageRecord) => void) | null = null;

  private readonly counts = new Map<string, number>();
  /** `YYYY-MM` → USD. */
  private readonly monthSpend = new Map<string, number>();
  /** `YYYY-MM|key` → USD. */
  private readonly keyMonthSpend = new Map<string, number>();
  /** `YYYY-MM-DD|key` → tokens. */
  private readonly keyDayTokens = new Map<string, number>();
  /** Recent per-account usage, for seeding quota windows after a restart. */
  private accountTokens: AccountTokenEntry[] = [];
  /** Newest first; the settings UI shows the last calls of this run. */
  private readonly recentCalls: UsageRecord[] = [];
  private readonly pendingWrites = new Set<Promise<void>>();
  private readonly logger: Logger;
  private loggedWriteError = false;

  constructor(options: UsageLedgerOptions) {
    this.filePath = path.join(options.neolixHome, GATEWAY_USAGE_FILENAME);
    this.logger = options.logger;
  }

  /** Rebuilds the running counters from the ledger file. Missing file is fine. */
  public async start(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.filePath, "utf8");
    } catch {
      return;
    }
    for (const line of text.split("\n")) {
      if (line.trim().length === 0) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        // A probe asks the settings page for a reading; it is kept in the
        // log but spends no budget, key tokens or account allowance, as
        // `record` skips it live (myna's probelog, usage.SourceProbe).
        const entry = parsed as UsageRecord;
        if (entry.probe === undefined) {
          // The budget sums from the same rows, so a restart does not forget
          // what a key spent in its window.
          notePendingRecord(this.filePath, entry);
          this.tally(entry);
        }
      }
    }
  }

  /** Resolves once every line recorded so far has reached the file. */
  public async flush(): Promise<void> {
    await Promise.all(this.pendingWrites);
  }

  public record(entry: UsageRecord): void {
    // An observer (OTel export) sees the row before it is written; it never
    // gets to fail the request that produced it.
    try {
      this.onRecord?.(entry);
    } catch {
      // Ignored: observability must not break serving.
    }
    this.recentCalls.unshift(entry);
    if (this.recentCalls.length > RECENT_CALLS_MOST) {
      this.recentCalls.pop();
    }
    // A probe is the settings page asking, not an agent's turn: it is written
    // down for the request log but never spends a budget, a key's tokens or
    // the month's allowance (myna's probelog, usage.SourceProbe).
    if (entry.probe === undefined) {
      // The budget must see the call before its line reaches the file, so
      // the very next request cannot overshoot the cap.
      notePendingRecord(this.filePath, entry);
      // `least-used` compares served requests; failed attempts are ignored there
      // because the rest table already keeps load off a rate-limited upstream.
      this.tally(entry);
    }
    const line = `${JSON.stringify(entry)}\n`;
    const write = appendFile(this.filePath, line, "utf8").catch((error: unknown) => {
      if (!this.loggedWriteError) {
        this.loggedWriteError = true;
        this.logger.error({ err: error, file: this.filePath }, "Cannot append LLM gateway usage");
      }
    });
    this.pendingWrites.add(write);
    void write.finally(() => this.pendingWrites.delete(write));
  }

  public countFor(key: string): number {
    return this.counts.get(key) ?? 0;
  }

  public countsSnapshot(): ReadonlyMap<string, number> {
    return new Map(this.counts);
  }

  public spentThisMonth(now: number): number {
    return this.monthSpend.get(monthKey(now)) ?? 0;
  }

  public spentThisMonthForKey(key: string, now: number): number {
    return this.keyMonthSpend.get(`${monthKey(now)}|${key}`) ?? 0;
  }

  public tokensToday(key: string, now: number): number {
    return this.keyDayTokens.get(`${dayKey(now)}|${key}`) ?? 0;
  }

  public recentEntries(): UsageRecord[] {
    return [...this.recentCalls];
  }

  /**
   * How fast each upstream answered lately, by `provider/model`: a decayed
   * average of its first token and its write speed. Meant for `fast` routing.
   */
  public speedSnapshot(now = Date.now()): Map<string, CandidateSpeed> {
    const sums = new Map<string, { ttft: number; tps: number; weight: number }>();
    const halfLife = 60 * 60_000;
    for (const entry of this.recentCalls) {
      const at = Date.parse(entry.time);
      if (!Number.isFinite(at) || now - at > 6 * halfLife) {
        continue;
      }
      const ttft = entry.ttftMs;
      if (ttft === undefined || ttft <= 0) {
        continue;
      }
      const writing = entry.durationMs - ttft;
      const tps = writing > 0 ? entry.outputTokens / (writing / 1000) : 0;
      const weight = Math.pow(0.5, (now - at) / halfLife);
      const key = `${entry.provider}/${entry.model}`;
      const sum = sums.get(key) ?? { ttft: 0, tps: 0, weight: 0 };
      sum.ttft += ttft * weight;
      sum.tps += tps * weight;
      sum.weight += weight;
      sums.set(key, sum);
    }
    const speeds = new Map<string, CandidateSpeed>();
    for (const [key, sum] of sums) {
      if (sum.weight > 0) {
        speeds.set(key, { ttft: sum.ttft / sum.weight, tps: sum.tps / sum.weight });
      }
    }
    return speeds;
  }

  public accountUsageHistory(now: number): AccountTokenEntry[] {
    const cutoff = now - SEVEN_DAYS_MS;
    return this.accountTokens.filter((entry) => entry.at > cutoff);
  }

  private tally(entry: Partial<UsageRecord>): void {
    if (entry.ok !== true) {
      return;
    }
    const at = typeof entry.time === "string" ? Date.parse(entry.time) : Number.NaN;
    if (Number.isNaN(at)) {
      return;
    }
    const tokens = readNumber(entry.inputTokens) + readNumber(entry.outputTokens);
    this.countServed(entry);
    this.countSpend(entry, at, readNumber(entry.costUsd));
    this.countKeyTokens(entry, at, tokens);
    this.countAccountTokens(entry, at, tokens);
  }

  private countServed(entry: Partial<UsageRecord>): void {
    const provider = typeof entry.provider === "string" ? entry.provider : "";
    const model = typeof entry.model === "string" ? entry.model : "";
    if (provider.length === 0 || model.length === 0) {
      return;
    }
    const key = `${provider}/${model}`;
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }

  private countSpend(entry: Partial<UsageRecord>, at: number, cost: number): void {
    if (cost <= 0) {
      return;
    }
    const month = monthKey(at);
    this.monthSpend.set(month, (this.monthSpend.get(month) ?? 0) + cost);
    if (typeof entry.key === "string") {
      const scoped = `${month}|${entry.key}`;
      this.keyMonthSpend.set(scoped, (this.keyMonthSpend.get(scoped) ?? 0) + cost);
    }
  }

  private countKeyTokens(entry: Partial<UsageRecord>, at: number, tokens: number): void {
    if (typeof entry.key !== "string" || tokens <= 0) {
      return;
    }
    const day = `${dayKey(at)}|${entry.key}`;
    this.keyDayTokens.set(day, (this.keyDayTokens.get(day) ?? 0) + tokens);
  }

  private countAccountTokens(entry: Partial<UsageRecord>, at: number, tokens: number): void {
    if (typeof entry.account !== "string" || tokens <= 0) {
      return;
    }
    this.accountTokens.push({
      at,
      provider: typeof entry.provider === "string" ? entry.provider : "",
      account: entry.account,
      tokens,
      costUsd: readNumber(entry.costUsd),
      cacheReadTokens: readNumber(entry.cacheReadTokens),
    });
  }
}

function readNumber(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

// Calendar months and days are the reader's own, as the per-key budget
// windows are (myna's SpendCap.Window uses the machine's local time).
function monthKey(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function dayKey(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
