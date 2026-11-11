import type { UsageRecord } from "./usage.js";
import type { TuneSettingState } from "./tune-settings.js";

/**
 * The routing history's advice, myna's `tune`: replay a user's own calls and
 * say which compaction window and which Claude Code cache lifetime would
 * have cost the fewest tokens. Tokens are weighed by what the vendor charges
 * against a plain input token — a cache read is a tenth, a cache write a
 * quarter more (twice for an hour's), an output token several. Only what
 * this user's calls did is said; another's habits give another answer.
 */

/** One call of a conversation, as the replay sees it. */
export interface TuneCall {
  time: number;
  /** The conversation it belongs to; calls without one are left out. */
  stream: string;
  model: string;
  /** The whole prompt: input, cache read and cache write. */
  prompt: number;
  out: number;
  /** Of the prompt, written to the cache; and how much of that an hour's. */
  wrote: number;
  wrote1: number;
  /** The share of the prompt read from the vendor's cache. */
  read: number;
}

export interface TuneFacts {
  calls: number;
  streams: number;
  /** Compactions seen in the period. */
  compacts?: number;
  /** The median prompt a compaction was made at, and right after it. */
  peak?: number;
  after?: number;
  /** The median a prompt grows by from one call to the next. */
  growth?: number;
  /** What a compaction costs to read back, in the calls after it. */
  rework?: number;
  /** Of the calls, the share that passed the window advised. */
  long?: number;
  /** Gaps between calls: under 5 minutes, 5 minutes to an hour, over. */
  quick?: number;
  pause?: number;
  away?: number;
  /** Of the cache writes, the share kept an hour. */
  hour?: number;
  /** Streams that reached a compaction. */
  sessions?: number;
}

export interface TunePoint {
  value: number;
  cost: number;
  compacts: number;
  /** Calls that still passed the window, for the facts; not drawn. */
  over?: number;
}

/** The compaction window advised for one model of one agent. */
export interface TuneCompaction {
  model: string;
  /** Where it compacts now, as the replayed peaks tell it. */
  current: number;
  /** The model's whole window, when one is known. */
  window: number | null;
  best: number;
  /** Weighted tokens with `current`, and with `best`. */
  cost: number;
  low: number;
  curve: TunePoint[];
  facts: TuneFacts;
  /** How the agent has this window now; the session fills it from the files. */
  setting?: TuneSettingState;
}

/** The cache lifetime advised for Claude Code's calls. */
export interface TuneTtl {
  /** "5m" or "1h", as the calls' own writes tell it. */
  current: string;
  best: string;
  cost: number;
  low: number;
  short: number;
  hour: number;
  facts: TuneFacts;
  /** How the agent has the lifetime now; the session fills it from the files. */
  setting?: TuneSettingState;
}

export interface TuneAdvice {
  agent: string;
  calls: number;
  compact?: TuneCompaction;
  ttl?: TuneTtl;
}

const AGENTS = ["claude", "codex"] as const;
const MIN_CALLS = 50;
const DROP_SHARE = 0.6;
const DROP_FROM = 20_000;
const REWORK_CALLS = 10;
const SAME_COST = 0.03;

const COMPACT_CLAUDE = { min: 100_000, max: 1_000_000, step: 10_000, reserve: 33_000 };
const COMPACT_CODEX = { min: 50_000, max: 1_000_000, step: 10_000, reserve: 0 };

/** Weights against one plain input token, by vendor. */
export function weightsFor(model: string): {
  read: number;
  write: number;
  write1h: number;
  out: number;
} {
  if (model.toLowerCase().startsWith("claude")) {
    return { read: 0.1, write: 1.25, write1h: 2, out: 5 };
  }
  return { read: 0.1, write: 1, write1h: 1, out: 8 };
}

/** The calls the replay keeps: a conversation, a prompt, and an answer. */
export function tuneCalls(records: readonly UsageRecord[]): TuneCall[] {
  const calls: TuneCall[] = [];
  for (const record of records) {
    if (record.probe !== undefined || !record.ok) {
      continue;
    }
    const prompt =
      record.inputTokens + (record.cacheReadTokens ?? 0) + (record.cacheWriteTokens ?? 0);
    if (prompt <= 0 || record.session === undefined || record.session.length === 0) {
      continue;
    }
    const time = Date.parse(record.time);
    if (!Number.isFinite(time)) {
      continue;
    }
    calls.push({
      time,
      stream: record.session,
      model: record.model.toLowerCase(),
      prompt,
      out: record.outputTokens,
      wrote: record.cacheWriteTokens ?? 0,
      wrote1: record.cacheWrite1hTokens ?? 0,
      read: record.cacheReadTokens ?? 0,
    });
  }
  return calls;
}

/**
 * The advice for every agent with enough calls: Claude Code's compaction
 * window and cache lifetime, Codex's compaction window.
 */
export function tuneAdvice(
  calls: readonly TuneCall[],
  options: { windowOf?: (model: string) => number | null } = {},
): TuneAdvice[] {
  const byAgent = new Map<string, TuneCall[]>();
  for (const call of calls) {
    const agent = agentOf(call.model);
    if (agent === null) {
      continue;
    }
    const list = byAgent.get(agent);
    if (list === undefined) {
      byAgent.set(agent, [call]);
    } else {
      list.push(call);
    }
  }
  const advice: TuneAdvice[] = [];
  for (const agent of AGENTS) {
    const agentCalls = byAgent.get(agent);
    if (agentCalls === undefined || agentCalls.length === 0) {
      continue;
    }
    const entry: TuneAdvice = { agent, calls: agentCalls.length };
    const compact = compactAdvice(agentCalls, agent, options.windowOf);
    if (compact !== undefined) {
      entry.compact = compact;
    }
    if (agent === "claude") {
      const ttl = cacheTtlAdvice(agentCalls);
      if (ttl !== undefined) {
        entry.ttl = ttl;
      }
    }
    if (entry.compact !== undefined || entry.ttl !== undefined) {
      advice.push(entry);
    }
  }
  return advice;
}

/** The agent a model's calls belong to, by the vendor's name. */
function agentOf(model: string): "claude" | "codex" | null {
  if (model.startsWith("claude") || model.includes("anthropic")) {
    return "claude";
  }
  if (model.startsWith("gpt") || model.startsWith("o") || model.includes("codex")) {
    return "codex";
  }
  return null;
}

function compactAdvice(
  calls: TuneCall[],
  agent: "claude" | "codex",
  windowOf: ((model: string) => number | null) | undefined,
): TuneCompaction | undefined {
  const options = agent === "claude" ? COMPACT_CLAUDE : COMPACT_CODEX;
  const streams = streamsOf(calls);
  const facts = observe(streams);
  if (facts.calls < MIN_CALLS || facts.streams === 0) {
    return undefined;
  }
  const plan = replayPlan(calls, streams, facts);
  const known = windowOf?.(plan.model) ?? null;
  const bounds = compactBounds(options, facts, known, plan.after);
  const run = (value: number): TunePoint => replayAt(streams, plan, options.reserve, value);
  const now = run(bounds.current);
  const curve = windowCurve(run, bounds.floor, bounds.top, options.step);
  if (curve.length === 0) {
    return undefined;
  }
  const best = pickBestWindow(curve);
  const compact: TuneCompaction = {
    model: plan.model,
    current: bounds.current,
    window: known,
    best: best.value,
    cost: now.cost,
    low: best.cost,
    curve,
    facts,
  };
  // It only says to change what would save 3% or more.
  if (now.cost <= 0 || (now.cost - best.cost) / now.cost < SAME_COST) {
    compact.best = bounds.current;
    compact.low = now.cost;
  }
  const over = replayAt(streams, plan, options.reserve, compact.best).over ?? 0;
  compact.facts.long = over / Math.max(1, facts.calls);
  return compact;
}

interface ReplayPlan {
  model: string;
  weights: { read: number; write: number; write1h: number; out: number };
  write: number;
  base: number;
  after: number;
  summary: number;
  rework: number;
}

/** What a replay of these streams reads from them, once. */
function replayPlan(calls: TuneCall[], streams: TuneCall[][], facts: TuneFacts): ReplayPlan {
  const model = calls[0]?.model ?? "";
  const weights = weightsFor(model);
  const base = median(streams.map((stream) => stream[0]?.prompt ?? 0));
  const after = facts.after ?? base + 10_000;
  // A window compacts back to the summary plus what the calls after it read
  // back; with few compactions seen, it is taken as at least 10K.
  const rework =
    facts.compacts !== undefined && facts.compacts >= 5
      ? (facts.rework ?? 0)
      : Math.max(facts.rework ?? 0, 10_000);
  return {
    model,
    weights,
    write: hourlyShare(calls) > 0.5 ? weights.write1h : weights.write,
    base,
    after,
    summary: Math.max(0, after - base),
    rework,
  };
}

/** The windows a setting is tried over, and where the agent runs now. */
function compactBounds(
  options: { min: number; max: number; step: number; reserve: number },
  facts: TuneFacts,
  known: number | null,
  after: number,
): { current: number; top: number; floor: number } {
  const peak = facts.peak ?? 0;
  let current =
    facts.compacts !== undefined && facts.compacts >= 3
      ? roundTo(peak + options.reserve, options.step)
      : (known ?? options.max);
  let top = options.max;
  if (known !== null && known > 0) {
    current = Math.min(current, known);
    top = Math.min(options.max, known);
  }
  // A window that leaves little room over the summary compacts over and
  // over: it keeps at least half the summary's size, or twenty calls'
  // growth, free over it.
  const floor = Math.max(
    options.min,
    roundUp(
      after + Math.max(Math.floor(after / 2), 20 * (facts.growth ?? 0)) + options.reserve,
      options.step,
    ),
  );
  return { current, top, floor };
}

function windowCurve(
  run: (value: number) => TunePoint,
  floor: number,
  top: number,
  step: number,
): TunePoint[] {
  const curve: TunePoint[] = [];
  for (let value = floor; value <= top; value += step) {
    const point = run(value);
    curve.push({ value: point.value, cost: point.cost, compacts: point.compacts });
  }
  return curve;
}

/** The cheapest window; of those within 1% of it, the largest. */
function pickBestWindow(curve: TunePoint[]): TunePoint {
  const cheapest = curve.reduce((low, point) => (point.cost < low.cost ? point : low));
  let best = cheapest;
  for (const point of curve) {
    if (point.cost <= cheapest.cost * 1.01 && point.value > best.value) {
      best = point;
    }
  }
  return best;
}

/** One window tried: its weighted cost and how many compactions it makes. */
function replayAt(
  streams: TuneCall[][],
  plan: ReplayPlan,
  reserve: number,
  value: number,
): TunePoint {
  const replay = replayCompact(
    streams,
    Math.max(plan.after + 1, value - reserve),
    plan.after,
    plan.summary,
    plan.rework,
    plan.weights,
    plan.write,
  );
  return { value, cost: replay.cost, compacts: replay.compacts, over: replay.over };
}

/** What the streams would have cost compacting at `threshold`. */
function replayCompact(
  streams: TuneCall[][],
  threshold: number,
  after: number,
  summary: number,
  rework: number,
  weights: { read: number; write: number; write1h: number; out: number },
  write: number,
): { cost: number; compacts: number; over: number } {
  let cost = 0;
  let compacts = 0;
  let over = 0;
  for (const stream of streams) {
    const first = stream[0];
    if (first === undefined) {
      continue;
    }
    let ctx = first.prompt;
    cost += ctx * write + first.out * weights.out;
    for (let index = 1; index < stream.length; index += 1) {
      const call = stream[index];
      const before = stream[index - 1];
      if (call === undefined || before === undefined) {
        continue;
      }
      let growth = call.prompt - before.prompt;
      if (growth < 0 || compacted(before.prompt, call.prompt)) {
        growth = 0;
      }
      if (ctx + growth > threshold && ctx > after) {
        cost += ctx * weights.read + summary * weights.out + (summary + rework) * write;
        ctx = after + rework;
        compacts += 1;
      }
      if (ctx + growth > threshold) {
        over += 1;
      }
      cost += ctx * weights.read + growth * write + call.out * weights.out;
      ctx += growth;
    }
  }
  return { cost, compacts, over };
}

/** The cache lifetime advised for an agent's calls. */
export function cacheTtlAdvice(calls: TuneCall[]): TuneTtl | undefined {
  const streams = streamsOf(calls);
  const facts = observe(streams);
  if (facts.calls < MIN_CALLS) {
    return undefined;
  }
  facts.hour = hourlyShare(calls);
  const current = facts.hour > 0.5 ? "1h" : "5m";
  const weights = weightsFor(streams[0]?.[0]?.model ?? "");
  const short = replayTtl(streams, 5 * 60_000, weights.write);
  const hour = replayTtl(streams, 60 * 60_000, weights.write1h);
  const gaps = gapShares(streams);
  facts.quick = gaps.quick;
  facts.pause = gaps.pause;
  facts.away = gaps.away;
  let cost = short;
  let best = "5m";
  let low = short;
  if (current === "1h") {
    cost = hour;
  }
  if (hour < short) {
    best = "1h";
    low = hour;
  }
  // It only says to change what would save 3% or more.
  if (cost <= 0 || (cost - low) / cost < SAME_COST) {
    best = current;
    low = cost;
  }
  return { current, best, cost, low, short, hour, facts };
}

/**
 * What the streams would have cost with the cache kept for `ttl`: a call
 * within it of the one before reads what that one sent and writes what it
 * adds; one after it, or after a compaction, writes its whole prompt again.
 */
function replayTtl(streams: TuneCall[][], ttl: number, write: number): number {
  let cost = 0;
  for (const stream of streams) {
    const first = stream[0];
    if (first === undefined) {
      continue;
    }
    const weights = weightsFor(first.model);
    cost += first.prompt * write;
    for (let index = 1; index < stream.length; index += 1) {
      const call = stream[index];
      const before = stream[index - 1];
      if (call === undefined || before === undefined) {
        continue;
      }
      if (call.time - before.time > ttl || compacted(before.prompt, call.prompt)) {
        cost += call.prompt * write;
      } else if (call.prompt >= before.prompt) {
        cost += before.prompt * weights.read + (call.prompt - before.prompt) * write;
      } else {
        cost += call.prompt * weights.read;
      }
    }
  }
  return cost;
}

/** The calls grouped by conversation, each oldest first. */
function streamsOf(calls: TuneCall[]): TuneCall[][] {
  const by = new Map<string, TuneCall[]>();
  for (const call of calls) {
    const list = by.get(call.stream);
    if (list === undefined) {
      by.set(call.stream, [call]);
    } else {
      list.push(call);
    }
  }
  return [...by.keys()]
    .sort()
    .map((key) => (by.get(key) ?? []).sort((left, right) => left.time - right.time));
}

function compacted(previous: number, current: number): boolean {
  return previous >= DROP_FROM && current < DROP_SHARE * previous;
}

function observe(streams: TuneCall[][]): TuneFacts {
  const facts: TuneFacts = { calls: 0, streams: streams.length };
  const peaks: number[] = [];
  const afters: number[] = [];
  const growths: number[] = [];
  const reworks: number[] = [];
  let sessions = 0;
  for (const stream of streams) {
    facts.calls += stream.length;
    const growth: number[] = [];
    const cuts: number[] = [];
    for (let index = 1; index < stream.length; index += 1) {
      const call = stream[index];
      const before = stream[index - 1];
      if (call === undefined || before === undefined) {
        continue;
      }
      if (compacted(before.prompt, call.prompt)) {
        peaks.push(before.prompt);
        afters.push(call.prompt);
        cuts.push(index);
        continue;
      }
      const delta = call.prompt - before.prompt;
      if (delta >= 0) {
        growth.push(delta);
      }
    }
    if (cuts.length > 0) {
      sessions += 1;
    }
    const typical = median(growth);
    growths.push(...growth);
    for (const at of cuts) {
      const end = at + REWORK_CALLS;
      if (end >= stream.length) {
        continue;
      }
      const from = stream[at];
      const to = stream[end];
      if (from === undefined || to === undefined) {
        continue;
      }
      reworks.push(Math.max(0, to.prompt - from.prompt - REWORK_CALLS * typical));
    }
  }
  facts.compacts = peaks.length;
  facts.peak = median(peaks);
  facts.after = median(afters);
  facts.growth = median(growths);
  facts.rework = median(reworks);
  facts.sessions = sessions;
  return facts;
}

function hourlyShare(calls: TuneCall[]): number {
  let wrote = 0;
  let wrote1 = 0;
  for (const call of calls) {
    wrote += call.wrote;
    wrote1 += call.wrote1;
  }
  return wrote === 0 ? 0 : wrote1 / wrote;
}

function gapShares(streams: TuneCall[][]): { quick: number; pause: number; away: number } {
  let quick = 0;
  let pause = 0;
  let away = 0;
  let total = 0;
  for (const stream of streams) {
    for (let index = 1; index < stream.length; index += 1) {
      const call = stream[index];
      const before = stream[index - 1];
      if (call === undefined || before === undefined) {
        continue;
      }
      const gap = call.time - before.time;
      total += 1;
      if (gap <= 5 * 60_000) {
        quick += 1;
      } else if (gap <= 60 * 60_000) {
        pause += 1;
      } else {
        away += 1;
      }
    }
  }
  return total === 0
    ? { quick: 0, pause: 0, away: 0 }
    : { quick: quick / total, pause: pause / total, away: away / total };
}

function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function roundTo(value: number, step: number): number {
  return step <= 0 ? value : Math.round(value / step) * step;
}

function roundUp(value: number, step: number): number {
  return step <= 0 ? value : Math.ceil(value / step) * step;
}
