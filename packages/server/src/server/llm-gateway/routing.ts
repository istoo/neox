import type { GatewayCandidate } from "./catalog.js";
import type { GatewayConfig } from "./config.js";
import { groupByRequest } from "./groups-auto.js";
import { peakOf } from "./peak.js";
import { providerRoutingStrategy } from "./provider-shaping.js";
import { priceAtPeak, priceWithRate, resolvePrice } from "./pricing.js";
import type { PricingCatalog } from "./pricing-catalog.js";
import { runGatewayRoutingStrategy } from "./plugin-upstream.js";
import type { GatewayStrategySeat } from "@neolix/plugin/server";

export type RoutingStrategy =
  | "order"
  | "rotate"
  | "least-used"
  | "smart"
  | "pace"
  | "free"
  | "fast"
  | "cheap"
  | "drain"
  /** A plugin's, named `<pluginId>/<strategyId>`. */
  | (string & {});

export function candidateKey(candidate: GatewayCandidate): string {
  return `${candidate.provider.id}/${candidate.model.id}`;
}

/** A conversation's upstream, optionally pinned to one of its accounts. */
export interface StickyBinding {
  candidateKey: string;
  accountId: string | null;
}

export function stickyValue(candidate: string, accountId: string | null): string {
  return accountId === null ? candidate : `${candidate}#${accountId}`;
}

export function parseSticky(value: string): StickyBinding {
  const separator = value.indexOf("#");
  if (separator === -1) {
    return { candidateKey: value, accountId: null };
  }
  return {
    candidateKey: value.slice(0, separator),
    accountId: value.slice(separator + 1),
  };
}

/**
 * Remembers which upstreams failed recently so the next request skips them
 * instead of paying the same timeout again.
 */
export class RestTable {
  private readonly restingUntil = new Map<string, number>();

  public rest(key: string, durationMs: number, now: number): void {
    const until = now + durationMs;
    const existing = this.restingUntil.get(key) ?? 0;
    if (until > existing) {
      this.restingUntil.set(key, until);
    }
  }

  public isResting(key: string, now: number): boolean {
    const until = this.restingUntil.get(key);
    if (until === undefined) {
      return false;
    }
    if (until <= now) {
      this.restingUntil.delete(key);
      return false;
    }
    return true;
  }

  public clear(key: string): void {
    this.restingUntil.delete(key);
  }

  /** When the rest ends, or null when the key is awake. */
  public until(key: string, now: number): number | null {
    const until = this.restingUntil.get(key);
    if (until === undefined) {
      return null;
    }
    if (until <= now) {
      this.restingUntil.delete(key);
      return null;
    }
    return until;
  }
}

/**
 * What the vendor said of the answer a conversation last got, for
 * `affinity: "auto"` (myna's stick): a conversation stays where it is
 * across turns while what the answer read from the vendor's cache, or
 * wrote to it, is worth keeping — and the cache has not gone cold.
 */
export interface AffinityRecord {
  /** The upstream that answered, as `stickyValue` writes it. */
  key: string;
  /** The user's turn it answered. */
  turn: number;
  /** The answer came mid-turn, to the agent handing tool results back. */
  within: boolean;
  /** When the answer came back. */
  at: number;
  /** Tokens it read from the vendor's cache, and wrote to it. */
  cacheRead: number;
  cacheWrite: number;
  /** Anthropic's 1-hour write: the tokens it keeps warm, and since when. */
  hourTokens: number;
  hourAt: number;
}

/** The tokens that make a conversation worth staying where it is (myna's cacheWorth). */
export const CACHE_WORTH = 1024;
/** How long a vendor keeps a prompt cached unread, the shortest there is. */
const CACHE_COLD_MS = 5 * 60_000;
/** The ChatGPT backend holds a Codex thread's prompt for an hour. */
const CHATGPT_COLD_MS = 60 * 60_000;
/** DeepSeek's own API holds a conversation's prefix for about an hour. */
const DEEPSEEK_COLD_MS = 60 * 60_000;
/** Anthropic keeps a 1-hour cache write for an hour unread. */
const CACHE_HOUR_MS = 60 * 60_000;
/** How long a conversation's last answerer is remembered (myna's stickKeep). */
const STICK_KEEP_MS = 24 * 60 * 60_000;

/** Usage a reply reported, as the affinity record keeps it. */
export interface AnswerUsage {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number;
}

export interface RoutingState {
  rest: RestTable;
  rotationCursors: Map<string, number>;
  usageCounts: ReadonlyMap<string, number>;
  /** Conversation id → the upstream that last answered it. */
  sticky: Map<string, string>;
  /** Conversation id → what that answer's usage said, for `affinity: "auto"`. */
  affinity?: Map<string, AffinityRecord>;
  /** Upstream key → when it last answered, for `smart` and `pace`. */
  lastUsed: Map<string, number>;
  /** `group/<id>` → each member's running weight, for a weighted group's turns. */
  groupTurns?: Map<string, Map<string, number>>;
  /** `provider/model` → how fast it answered lately, for `fast`. */
  speed?: ReadonlyMap<string, CandidateSpeed>;
  /** Pool → the probe turn `fast` is on, so an unmeasured seat gets a turn. */
  speedProbes?: Map<string, { count: number; turns: number }>;
  /** Pool → the member `drain` is on. */
  drainAt?: Map<string, string>;
  /** Members refused for their quota or credit; `drain` goes on from them. */
  spent?: Set<string>;
}

/** How fast a member answered lately: to its first token, then tokens a second. */
export interface CandidateSpeed {
  ttft: number;
  tps: number;
}

/** The reply `fast` weighs a seat's speed at, as myna's RefTokens. */
const FAST_REF_TOKENS = 200;
/** One request in this many gives the turn to a member not measured lately. */
const FAST_PROBE_EVERY = 5;
/** Prices within this much of each other count as the same, so rounding keeps order. */
const SAME_COST = 1e-6;

export interface RouteInput {
  config: GatewayConfig;
  requestedModel: string;
  candidates: GatewayCandidate[];
  state: RoutingState;
  now: number;
  /** Null when the caller cannot identify its conversation. */
  conversationKey: string | null;
  /**
   * The agent handing tool results back within the turn it is on, as myna
   * reads it off the request (its `turnIn`). `affinity: "turn"` keeps the
   * answerer only within such a turn.
   */
  withinTurn?: boolean;
  /** A group rule or a weighted turn fixed this order; the strategy must not reorder it. */
  preserveOrder?: boolean;
  /** models.dev prices, for `free` and `cheap`. */
  catalog?: PricingCatalog | null;
  /** Reads a candidate's load, for `busyLoad`; absent or null keeps its place. */
  loadOf?: (candidate: GatewayCandidate) => ModelLoad | null;
}

/** A model's load as its provider reports it: a percent of what the vendor serves, and when read. */
export interface ModelLoad {
  percent: number;
  at: number;
}

/** A load older than this is not read; the model keeps its place (myna's plugin.LoadFresh). */
export const LOAD_FRESH_MS = 5 * 60_000;

/**
 * myna's BusyLoad: a model whose provider says it is busier than the
 * user's threshold goes behind the others a request could go to, in its
 * order. A model with no load reported lately keeps its place.
 */
export function busyLast(
  candidates: readonly GatewayCandidate[],
  loadOf: ((candidate: GatewayCandidate) => ModelLoad | null) | undefined,
  threshold: number,
  now: number,
): GatewayCandidate[] {
  if (loadOf === undefined || threshold <= 0) {
    return [...candidates];
  }
  const ready: GatewayCandidate[] = [];
  const busy: GatewayCandidate[] = [];
  for (const candidate of candidates) {
    const load = loadOf(candidate);
    const fresh = load !== null && now - load.at <= LOAD_FRESH_MS;
    (fresh && load.percent > threshold ? busy : ready).push(candidate);
  }
  return [...ready, ...busy];
}

/**
 * Orders candidates by the requested group's strategy, then moves rested
 * upstreams to the back. When every candidate is resting the original order is
 * kept: trying a rested upstream beats failing the request outright.
 */
export function planCandidates(input: RouteInput): GatewayCandidate[] {
  // routingFor's `weighted` spreads over a provider's keys or accounts,
  // which the gateway chooses after this plan: the candidates here are
  // provider/model, so their order stays the list's (account weights are
  // applied where an account is picked).
  const strategy = strategyFor(input.config, input.requestedModel);
  const ordered =
    input.preserveOrder === true
      ? input.candidates
      : applyStrategy(input.candidates, strategy, input);
  const affinity = groupByRequest(input.config, input.requestedModel)?.affinity ?? "auto";
  const withSticky = promoteSticky(ordered, input, affinity);
  if (affinity === "strict") {
    // the account that answered is asked again even resting or spent: its
    // error goes to the agent, and nothing takes the request from it
    return withSticky;
  }
  const withBusy = busyLast(withSticky, input.loadOf, input.config.busyLoad ?? 0, input.now);
  const awake: GatewayCandidate[] = [];
  const resting: GatewayCandidate[] = [];
  for (const candidate of withBusy) {
    if (input.state.rest.isResting(candidateKey(candidate), input.now)) {
      resting.push(candidate);
    } else {
      awake.push(candidate);
    }
  }
  return [...awake, ...resting];
}

/**
 * Lets a plugin's routing strategy order the plan (`<pluginId>/<id>` in a
 * group's `strategy` or a provider's `routing`). The hook gets the seats in
 * their planned order and answers a permutation of their keys or indexes;
 * anything else, a failure, or a timeout keeps that order (myna's strategy
 * point, which fails open the same way).
 */
export async function planPluginStrategy(
  candidates: readonly GatewayCandidate[],
  input: RouteInput,
): Promise<GatewayCandidate[]> {
  const strategy = strategyFor(input.config, input.requestedModel);
  if (!strategy.includes("/") || candidates.length < 2) {
    return [...candidates];
  }
  const weights = groupByRequest(input.config, input.requestedModel)?.weights ?? {};
  const seats: GatewayStrategySeat[] = candidates.map((candidate, index) => ({
    key: candidateKey(candidate),
    provider: candidate.provider.id,
    model: candidate.model.id,
    index,
    priority: 0,
    weight: weights[candidateKey(candidate)] ?? 1,
    resting: input.state.rest.isResting(candidateKey(candidate), input.now),
  }));
  const order = await runGatewayRoutingStrategy(strategy, {
    pool: input.requestedModel,
    seats,
    options: {},
  });
  const indices = permutationIndices(
    order,
    seats.map((seat) => seat.key),
  );
  if (indices === null) return [...candidates];
  return indices.map((index) => candidates[index] as GatewayCandidate);
}

/** A strategy's answer as seat positions, or null when it isn't a permutation. */
export function permutationIndices(
  order: readonly unknown[] | null,
  keys: readonly string[],
): number[] | null {
  if (order === null || order.length !== keys.length) return null;
  const byKey = new Map(keys.map((key, index) => [key, index]));
  const seen = new Set<number>();
  const indices: number[] = [];
  for (const entry of order) {
    let index: number | undefined;
    if (typeof entry === "number") {
      index = entry;
    } else if (typeof entry === "string") {
      index = byKey.get(entry);
    }
    if (
      index === undefined ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= keys.length ||
      seen.has(index)
    ) {
      return null;
    }
    seen.add(index);
    indices.push(index);
  }
  return indices.length === keys.length ? indices : null;
}

/**
 * A conversation stays with the upstream that answered its last turn while that
 * upstream is still a member, so the vendor's prompt cache keeps paying off.
 */
function promoteSticky(
  candidates: GatewayCandidate[],
  input: RouteInput,
  affinity: NonNullable<GatewayConfig["groups"][number]["affinity"]>,
): GatewayCandidate[] {
  // off: every request routed afresh (myna's AffinityOff)
  if (affinity === "off" || input.conversationKey === null) {
    return candidates;
  }
  // A turn's key is its own: within the turn the answerer stays, and the
  // next turn routes afresh, as myna's AffinityTurn. The caller says
  // whether this request is within one — the agent handing tool results
  // back — since only the request body tells.
  if (affinity === "turn" && input.withinTurn !== true) {
    return candidates;
  }
  const sticky = input.state.sticky.get(input.conversationKey);
  if (sticky === undefined) {
    return candidates;
  }
  const bound = parseSticky(sticky);
  const index = candidates.findIndex((candidate) => candidateKey(candidate) === bound.candidateKey);
  const stickyCandidate = candidates[index];
  if (stickyCandidate === undefined) {
    return candidates;
  }
  if (affinity === "strict") {
    // never moved: the one that answered is the one asked
    return [stickyCandidate];
  }
  if (affinity === "auto" && !keepsWhereItIs(input, sticky, stickyCandidate, bound.accountId)) {
    return candidates;
  }
  if (index <= 0) {
    return candidates;
  }
  return [stickyCandidate, ...candidates.slice(0, index), ...candidates.slice(index + 1)];
}

/**
 * Whether `affinity: "auto"` keeps a conversation with the one that
 * answered it last, as myna's affinity decision does: within a turn
 * always, and across turns while what the vendor said it read from its
 * cache, or wrote to it, is worth keeping and the cache has not gone cold.
 * Without a record (state written before this was kept) the answerer is
 * kept, as before.
 */
function keepsWhereItIs(
  input: RouteInput,
  sticky: string,
  candidate: GatewayCandidate,
  accountId: string | null,
): boolean {
  if (input.withinTurn === true) {
    return true;
  }
  const record = input.state.affinity?.get(input.conversationKey ?? "");
  if (record === undefined || record.key !== sticky) {
    return true;
  }
  if (input.now - record.at > STICK_KEEP_MS) {
    // nobody has answered it in a day: routing decides afresh
    return false;
  }
  // Written counts as read: the first turn wrote the whole prompt, and the
  // next reads it if it stays. A vendor that reports neither is taken as
  // having written what it was sent (noteAffinity fills that in).
  if (record.cacheRead + record.cacheWrite < CACHE_WORTH) {
    return false;
  }
  if (coldAt(input.now, record, candidate, accountId)) {
    return false;
  }
  return true;
}

/** The vendor no longer has the conversation cached, beyond an hour-long write. */
function coldAt(
  now: number,
  record: AffinityRecord,
  candidate: GatewayCandidate,
  accountId: string | null,
): boolean {
  if (record.hourTokens >= CACHE_WORTH && now - record.hourAt <= CACHE_HOUR_MS) {
    return false;
  }
  return now - record.at > coldAfterMs(candidate, accountId);
}

/**
 * How long this upstream's vendor keeps a prompt cached unread: an hour at
 * the ChatGPT backend, an hour on DeepSeek's own API, five minutes
 * elsewhere (myna's coldAfter).
 */
function coldAfterMs(candidate: GatewayCandidate, accountId: string | null): number {
  const account = candidate.provider.accounts?.find((entry) => entry.id === accountId);
  const baseUrl = account?.baseUrl ?? candidate.provider.baseUrl;
  const host = hostOf(baseUrl);
  if (candidate.provider.id.toLowerCase().includes("codex") || host.endsWith("chatgpt.com")) {
    return CHATGPT_COLD_MS;
  }
  if (host === "deepseek.com" || host.endsWith(".deepseek.com")) {
    return DEEPSEEK_COLD_MS;
  }
  return CACHE_COLD_MS;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Remembers what an answer said of the conversation, as myna's `answered`:
 * a reply that reported no cache traffic is taken as having written what
 * it was sent, and a reply that wrote for an hour keeps that part warm
 * past the vendor's unread window.
 */
export function noteAffinity(
  state: RoutingState,
  conversationKey: string,
  input: {
    key: string;
    turn: number;
    within: boolean;
    at: number;
    usage: AnswerUsage;
  },
): void {
  const { usage } = input;
  const cacheRead = usage.cacheRead;
  const cacheWrite =
    usage.cacheRead === 0 && usage.cacheWrite === 0 ? usage.input : usage.cacheWrite;
  const previous = state.affinity?.get(conversationKey);
  const kept = previous !== undefined && previous.key === input.key ? previous : null;
  let hourTokens = 0;
  const wroteForAnHour = usage.cacheWrite1h ?? 0;
  if (wroteForAnHour > 0) {
    hourTokens = cacheRead + wroteForAnHour;
  } else if (
    kept !== null &&
    kept.hourTokens > 0 &&
    input.at - kept.hourAt <= CACHE_HOUR_MS &&
    cacheRead >= kept.hourTokens
  ) {
    // read the whole of what was kept: still warm, measured from now
    hourTokens = kept.hourTokens;
  }
  const hourAt = hourTokens > 0 ? input.at : 0;
  if (state.affinity === undefined) {
    state.affinity = new Map();
  }
  state.affinity.set(conversationKey, {
    key: input.key,
    turn: input.turn,
    within: input.within,
    at: input.at,
    cacheRead,
    cacheWrite,
    hourTokens,
    hourAt,
  });
}

/**
 * How a request spreads over what it can go to. A group's own strategy; a
 * provider's `routing`, and — as myna's Routing defaults to smart
 * (internal/provider/provider.go:123-135) — smart when it sets none. A
 * provider Neolix cannot find keeps the list's order, as before.
 *
 * Note the change for existing configs: a provider with no `routing` used
 * to be tried in order and is now smart (the one that has rested longest
 * first, written order for the never used).
 */
export function routingFor(
  config: GatewayConfig,
  requestedModel: string,
): { strategy: RoutingStrategy; weighted: boolean } {
  if (!requestedModel.startsWith("group/") && !requestedModel.startsWith("auto/")) {
    const slash = requestedModel.indexOf("/");
    const providerId = slash < 0 ? "" : requestedModel.slice(0, slash);
    const provider = config.providers.find((entry) => entry.id === providerId);
    if (provider === undefined) {
      return { strategy: "order", weighted: false };
    }
    return providerRoutingStrategy(provider) ?? { strategy: "smart", weighted: false };
  }
  const group = groupByRequest(config, requestedModel);
  return { strategy: group?.strategy ?? "order", weighted: group?.weighted === true };
}

export function strategyFor(config: GatewayConfig, requestedModel: string): RoutingStrategy {
  return routingFor(config, requestedModel).strategy;
}

function applyStrategy(
  candidates: GatewayCandidate[],
  strategy: RoutingStrategy,
  input: RouteInput,
): GatewayCandidate[] {
  const requestedModel = input.requestedModel;
  const state = input.state;
  if (candidates.length < 2) {
    return candidates;
  }
  if (strategy === "rotate") {
    const cursor = state.rotationCursors.get(requestedModel) ?? 0;
    state.rotationCursors.set(requestedModel, cursor + 1);
    const offset = cursor % candidates.length;
    return [...candidates.slice(offset), ...candidates.slice(0, offset)];
  }
  if (strategy === "least-used") {
    const keyed = candidates.map((candidate, index) => ({
      candidate,
      index,
      count: state.usageCounts.get(candidateKey(candidate)) ?? 0,
    }));
    keyed.sort((left, right) => left.count - right.count || left.index - right.index);
    return keyed.map((entry) => entry.candidate);
  }
  if (strategy === "smart" || strategy === "pace") {
    // Both prefer the upstream that has rested longest, which spreads a
    // window's allowance instead of draining one account first. `smart` keeps
    // written order for never-used members; `pace` also weighs usage, so a
    // frequently used member waits longer.
    const keyed = candidates.map((candidate, index) => ({
      candidate,
      index,
      lastUsed: state.lastUsed.get(candidateKey(candidate)) ?? 0,
      count: state.usageCounts.get(candidateKey(candidate)) ?? 0,
    }));
    keyed.sort((left, right) => {
      if (left.lastUsed !== right.lastUsed) {
        return left.lastUsed - right.lastUsed;
      }
      if (strategy === "pace" && left.count !== right.count) {
        return left.count - right.count;
      }
      return left.index - right.index;
    });
    return keyed.map((entry) => entry.candidate);
  }
  if (strategy === "free") {
    return freeFirst(candidates, input);
  }
  if (strategy === "fast") {
    return fastest(candidates, requestedModel, state);
  }
  if (strategy === "cheap") {
    return cheapest(candidates, input);
  }
  if (strategy === "drain") {
    return drain(candidates, requestedModel, state);
  }
  return candidates;
}

/** A model costs nothing here when its price is zero on every count (myna's FreeModel). */
function isFree(input: RouteInput, candidate: GatewayCandidate): boolean {
  if (candidate.provider.countFree === true) {
    return true;
  }
  const price = resolvePrice(
    input.config,
    candidate.provider.id,
    candidate.model.id,
    input.catalog ?? null,
  );
  return (
    price !== null &&
    price.inputPerMTok === 0 &&
    price.outputPerMTok === 0 &&
    (price.cacheReadPerMTok ?? 0) === 0 &&
    (price.cacheWritePerMTok ?? 0) === 0
  );
}

/** Free members first, then the paid ones, each in their listed order. */
function freeFirst(candidates: GatewayCandidate[], input: RouteInput): GatewayCandidate[] {
  const free: GatewayCandidate[] = [];
  const paid: GatewayCandidate[] = [];
  for (const candidate of candidates) {
    (isFree(input, candidate) ? free : paid).push(candidate);
  }
  return [...free, ...paid];
}

/** The member whose model costs least at the request's time, then by cache cost. */
function cheapest(candidates: GatewayCandidate[], input: RouteInput): GatewayCandidate[] {
  const keyed = candidates.map((candidate, index) => {
    const price = resolvePrice(
      input.config,
      candidate.provider.id,
      candidate.model.id,
      input.catalog ?? null,
    );
    const rated = price === null ? null : priceWithRate(price, candidate.provider, input.now);
    // A vendor's peak hours count double where it bills them so.
    const hourly = priceAtPeak(rated, peakOf(candidate.provider, candidate.model.id), input.now);
    return {
      candidate,
      index,
      cost: hourly === null ? null : hourly.inputPerMTok + hourly.outputPerMTok,
      cacheCost: hourly?.cacheReadPerMTok ?? 0,
    };
  });
  keyed.sort((left, right) => {
    if ((left.cost === null) !== (right.cost === null)) {
      return left.cost === null ? 1 : -1;
    }
    if (left.cost === null || right.cost === null) {
      return left.index - right.index;
    }
    if (!sameCost(left.cost, right.cost)) {
      return left.cost - right.cost;
    }
    if (!sameCost(left.cacheCost, right.cacheCost)) {
      return left.cacheCost - right.cacheCost;
    }
    return left.index - right.index;
  });
  return keyed.map((entry) => entry.candidate);
}

function sameCost(left: number, right: number): boolean {
  const difference = Math.abs(left - right);
  return difference <= SAME_COST || difference <= SAME_COST * Math.max(left, right);
}

/** The member that answered fastest lately, one not measured getting a turn now and then. */
function fastest(
  candidates: GatewayCandidate[],
  pool: string,
  state: RoutingState,
): GatewayCandidate[] {
  const measured: { candidate: GatewayCandidate; index: number; estimate: number }[] = [];
  const unmeasured: { candidate: GatewayCandidate; index: number }[] = [];
  const spent: GatewayCandidate[] = [];
  candidates.forEach((candidate, index) => {
    const key = candidateKey(candidate);
    if (state.spent?.has(key) === true) {
      spent.push(candidate);
      return;
    }
    const speed = state.speed?.get(key);
    if (speed !== undefined && speed.ttft > 0) {
      measured.push({ candidate, index, estimate: 0 });
    } else {
      unmeasured.push({ candidate, index });
    }
  });
  const paces = measured
    .map((entry) => state.speed?.get(candidateKey(entry.candidate))?.tps ?? 0)
    .filter((tps) => tps > 0)
    .sort((a, b) => a - b);
  const mid = paces.length === 0 ? 0 : paces[Math.floor(paces.length / 2)]!;
  for (const entry of measured) {
    const speed = state.speed?.get(candidateKey(entry.candidate));
    entry.estimate = estimateSpeed(speed?.ttft ?? 0, speed?.tps ?? 0, mid);
  }
  measured.sort((left, right) => left.estimate - right.estimate || left.index - right.index);
  let awake = [
    ...measured.map((entry) => entry.candidate),
    ...unmeasured.map((entry) => entry.candidate),
  ];
  if (measured.length > 0 && unmeasured.length > 0) {
    state.speedProbes ??= new Map();
    const probe = state.speedProbes.get(pool) ?? { count: 0, turns: 0 };
    probe.count += 1;
    if (probe.count >= FAST_PROBE_EVERY) {
      const turn = unmeasured[probe.turns % unmeasured.length]!;
      probe.count = 0;
      probe.turns += 1;
      awake = [turn.candidate, ...awake.filter((entry) => entry !== turn.candidate)];
    }
    state.speedProbes.set(pool, probe);
  }
  return [...awake, ...spent];
}

function estimateSpeed(ttft: number, tps: number, mid: number): number {
  const pace = tps > 0 ? tps : mid;
  return pace > 0 ? ttft + (FAST_REF_TOKENS * 1000) / pace : ttft;
}

/** One member until it is used up, then the next one in the listed order, never back. */
function drain(
  candidates: GatewayCandidate[],
  pool: string,
  state: RoutingState,
): GatewayCandidate[] {
  state.drainAt ??= new Map();
  const spent = (candidate: GatewayCandidate) => state.spent?.has(candidateKey(candidate)) === true;
  const current = state.drainAt.get(pool);
  let at =
    current === undefined ? -1 : candidates.findIndex((entry) => candidateKey(entry) === current);
  if (at < 0) {
    const first = candidates.findIndex((entry) => !spent(entry));
    at = first < 0 ? 0 : first;
  } else if (spent(candidates[at]!)) {
    for (let step = 1; step < candidates.length; step += 1) {
      const next = (at + step) % candidates.length;
      if (!spent(candidates[next]!)) {
        at = next;
        break;
      }
    }
  }
  const on = candidates[at];
  if (on !== undefined) {
    state.drainAt.set(pool, candidateKey(on));
  }
  return [...candidates.slice(at), ...candidates.slice(0, at)];
}
