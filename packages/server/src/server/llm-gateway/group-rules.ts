import { homedir } from "node:os";
import type { GatewayConfig, GatewayGroup, GatewayGroupRule } from "./config.js";
import { groupByRequest } from "./groups-auto.js";
import {
  GATEWAY_EFFORTS,
  parseMemberRef,
  resolveGatewayCandidates,
  matchedGroupMembers,
  resolveMemberCandidates,
  type GatewayCandidate,
  type GatewayEffort,
} from "./catalog.js";
import { classifyTurn, type ClassifierTransport, type TurnClassification } from "./classifier.js";
import type { RoutingState } from "./routing.js";

const GROUP_PREFIX = "group/";
const EFFORT_RANK: Record<string, number> = {
  low: 1,
  medium: 2,
  high: 3,
  xhigh: 4,
  max: 5,
};

/** What a rule may look at: the request as the gateway sees it. */
export interface GatewayRuleContext {
  /** The agent id `clientOfUserAgent` reads, which rules name. */
  agent: string;
  /** The prompt's tokens, estimated from the body. */
  tokens: number;
  images: boolean;
  /** The reasoning the agent asked for, when it named a level. */
  effort: GatewayEffort | null;
  /** Whether the agent asked for any reasoning at all. */
  reasoning: boolean;
  /** The working folder the request says, or null when it says none. */
  folder: string | null;
  /** The request is an agent compacting its conversation. */
  compact: boolean;
  /** The last user message's text, for a rule that names an intent. */
  text: string;
  now: number;
}

export interface PlannedRequestCandidates {
  candidates: GatewayCandidate[];
  /** A rule or weighted turn fixed the order; the strategy must not reorder it. */
  preserveOrder: boolean;
  /** The rule that decided, when one did. */
  rule: GatewayGroupRule | null;
  /** Members a pause rule left out. */
  paused: string[];
}

export function requestedGroup(config: GatewayConfig, requestedModel: string): GatewayGroup | null {
  return groupByRequest(config, requestedModel);
}

/**
 * Expands a request into candidates, applying the group's rules, weights,
 * matched models and fast members. A non-group request resolves as before.
 */
// eslint-disable-next-line complexity -- myna's one routing decision, kept whole so its steps stay beside each other.
export async function planRequestCandidates(input: {
  config: GatewayConfig;
  requestedModel: string;
  state: RoutingState;
  context: GatewayRuleContext;
  /**
   * Asks the group's classifier through the gateway. Omitted for the
   * classifier's own call, so it never asks a classifier in turn.
   */
  classify?: ClassifierTransport;
}): Promise<PlannedRequestCandidates> {
  const group = requestedGroup(input.config, input.requestedModel);
  if (group === null) {
    return {
      candidates: resolveGatewayCandidates(input.config, input.requestedModel),
      preserveOrder: false,
      rule: null,
      paused: [],
    };
  }
  if (group.disabled === true) {
    throw new Error(`Routing group ${group.id} is switched off`);
  }
  const named = [...group.members, ...matchedGroupMembers(input.config, group)];
  const off = new Set((group.off ?? []).map((member) => parseMemberRef(member).id));
  const members = named.filter((member) => !off.has(parseMemberRef(member).id));
  // manual sends every request to its pick alone; the others and the rules
  // wait until another is picked (myna's Group.Picked)
  const manual = group.manual === true;
  const decided = manual
    ? {
        order: manualOrder(group, members),
        paused: new Set<string>(),
        rule: null,
        // Its rules wait (myna's Group.Live), but its effort=auto does not:
        // the classifier still rates the turn the pick reasons on.
        effort: await manualEffort(
          group,
          input.context,
          input.classify,
          input.config.classifyTimeout,
        ),
      }
    : await applyRules(group, members, input.context, input.classify, input.config.classifyTimeout);
  let ordered = decided.order.filter((member) => !decided.paused.has(parseMemberRef(member).id));
  let preserveOrder = decided.rule !== null;
  if (!manual && decided.rule === null && group.pick !== undefined) {
    ordered = putFirst(ordered, group.pick);
    preserveOrder = true;
  }
  if (!manual && decided.rule === null && group.weighted === true && ordered.length > 1) {
    ordered = weightedOrder(group, ordered, input.state);
    preserveOrder = true;
  }
  const use = decided.rule === null ? null : parseMemberRef(decided.rule.use).id;
  const useEffort = decided.rule?.useEffort ?? null;
  const fast = new Set((group.fast ?? []).map((member) => parseMemberRef(member).id));
  const levels = group.levels ?? [];
  const candidates: GatewayCandidate[] = [];
  for (const member of ordered) {
    const expanded = resolveMemberCandidates(
      input.config,
      member,
      use !== null && parseMemberRef(member).id === use ? useEffort : null,
    );
    for (const candidate of expanded) {
      candidates.push(fitCandidate(candidate, fast.has(parseMemberRef(member).id), levels));
    }
  }
  // effort=auto: as a turn begins, the classifier rates how hard it is and
  // every member without a pin of its own reasons at that level. It was
  // asked together with the intent above, in the one call myna makes.
  const auto = decided.effort;
  if (auto !== null) {
    for (const [index, candidate] of candidates.entries()) {
      if (candidate.effort === undefined && candidate.ruleEffort === undefined) {
        candidates[index] = { ...candidate, ruleEffort: fitEffort(auto, levels) };
      }
    }
  }
  return { candidates, preserveOrder, rule: decided.rule, paused: [...decided.paused] };
}

/** A manual group's pick alone, or its first member when none was picked. */
function manualOrder(group: GatewayGroup, members: readonly string[]): string[] {
  const pick = group.pick === undefined ? null : parseMemberRef(group.pick).id;
  const chosen =
    pick === null ? [] : members.filter((member) => parseMemberRef(member).id === pick);
  return chosen.length > 0 ? chosen : members.slice(0, 1);
}

function fitCandidate(
  candidate: GatewayCandidate,
  fast: boolean,
  levels: readonly GatewayEffort[],
): GatewayCandidate {
  const effort = candidate.effort === undefined ? undefined : fitEffort(candidate.effort, levels);
  const ruleEffort =
    candidate.ruleEffort === undefined ? undefined : fitEffort(candidate.ruleEffort, levels);
  if (!fast && effort === candidate.effort && ruleEffort === candidate.ruleEffort) {
    return candidate;
  }
  return {
    ...candidate,
    ...(effort === undefined ? {} : { effort }),
    ...(ruleEffort === undefined ? {} : { ruleEffort }),
    ...(fast ? { fast: true } : {}),
  };
}

/** The level a group offers nearest the one asked for; a tie goes up. */
function fitEffort(effort: GatewayEffort, levels: readonly GatewayEffort[]): GatewayEffort {
  if (levels.length === 0 || levels.includes(effort)) {
    return effort;
  }
  const wanted = EFFORT_RANK[effort] ?? 0;
  let best = levels[0] ?? effort;
  let distance = Number.POSITIVE_INFINITY;
  for (const candidate of levels) {
    const gap = Math.abs((EFFORT_RANK[candidate] ?? 0) - wanted);
    if (
      gap < distance ||
      (gap === distance && (EFFORT_RANK[candidate] ?? 0) > (EFFORT_RANK[best] ?? 0))
    ) {
      best = candidate;
      distance = gap;
    }
  }
  return best;
}

function putFirst(members: string[], pick: string): string[] {
  const id = parseMemberRef(pick).id;
  const found = members.find((member) => parseMemberRef(member).id === id);
  if (found === undefined) {
    return members;
  }
  return [found, ...members.filter((member) => member !== found)];
}

interface RuleDecision {
  /** The members in the order the rule sends to them, or the group's order. */
  order: string[];
  paused: Set<string>;
  rule: GatewayGroupRule | null;
  /** The reasoning the classifier picked for the turn, when `effort=auto`. */
  effort: GatewayEffort | null;
}

async function applyRules(
  group: GatewayGroup,
  members: string[],
  context: GatewayRuleContext,
  classify: ClassifierTransport | undefined,
  timeoutMs: number | undefined,
): Promise<RuleDecision> {
  const intents = [
    ...new Set(
      (group.rules ?? [])
        .map((rule) => rule.intent)
        .filter((intent): intent is string => intent !== undefined),
    ),
  ];
  // A rule's intent and effort=auto are asked together, in one call (myna's
  // jevBody): the classifier is asked only when a rule that could be the
  // first to match waits on its intent, or the group picks the effort of a
  // turn the agent asked to reason in.
  const wantsIntent = (group.rules ?? []).some(
    (rule) => rule.intent !== undefined && conditionsHold(rule, context),
  );
  const wantsEffort = group.effort === "auto" && context.reasoning;
  const asked = await askTurn(
    group,
    context,
    intents,
    wantsIntent,
    wantsEffort,
    classify,
    timeoutMs,
  );
  const effort = asked?.effort ?? null;
  const decided = decideByRules(
    group,
    members,
    context,
    asked === null ? null : asked.intent,
    effort,
  );
  return decided ?? { order: members, paused: new Set(), rule: null, effort };
}

/**
 * The first of the group's rules that matches, and the members it puts
 * first. Null when none does. `said` is the intent the classifier named,
 * null when it was not asked or did not say.
 */
function decideByRules(
  group: GatewayGroup,
  members: string[],
  context: GatewayRuleContext,
  said: string | null,
  effort: GatewayEffort | null,
): RuleDecision | null {
  for (const rule of group.rules ?? []) {
    if (!conditionsHold(rule, context)) {
      continue;
    }
    if (rule.intent !== undefined && said !== rule.intent) {
      continue;
    }
    if (rule.pause === true) {
      return {
        order: members,
        paused: new Set([parseMemberRef(rule.use).id]),
        rule: null,
        effort,
      };
    }
    const uses = [rule.use, ...(rule.more ?? [])].map((member) => parseMemberRef(member).id);
    const byId = new Map(members.map((member) => [parseMemberRef(member).id, member]));
    const head: string[] = [];
    for (const id of uses) {
      const member = byId.get(id);
      if (member !== undefined && !head.includes(member)) {
        head.push(member);
      }
    }
    const rest = members.filter((member) => !head.includes(member));
    return { order: [...head, ...rest], paused: new Set(), rule, effort };
  }
  return null;
}

/** A manual group's rules wait; its effort=auto is still the classifier's to pick. */
async function manualEffort(
  group: GatewayGroup,
  context: GatewayRuleContext,
  classify: ClassifierTransport | undefined,
  timeoutSeconds: number | undefined,
): Promise<GatewayEffort | null> {
  const asked = await askTurn(
    group,
    context,
    [],
    false,
    group.effort === "auto" && context.reasoning,
    classify,
    timeoutSeconds,
  );
  return asked?.effort ?? null;
}

/**
 * Asks the group's classifier once for the intent and the effort together,
 * when either is needed. Null is "not asked": no rule that could match
 * waits on an intent and the group does not pick the effort; or there is
 * nothing to ask with. The classifier's own call carries no transport.
 */
async function askTurn(
  group: GatewayGroup,
  context: GatewayRuleContext,
  intents: string[],
  wantsIntent: boolean,
  wantsEffort: boolean,
  classify: ClassifierTransport | undefined,
  timeoutSeconds: number | undefined,
): Promise<TurnClassification | null> {
  if ((!wantsIntent && !wantsEffort) || group.classifier === undefined || classify === undefined) {
    return null;
  }
  return classifyTurn({
    model: group.classifier,
    intents,
    effort: wantsEffort,
    text: context.text,
    transport: classify,
    ...(timeoutSeconds === undefined ? {} : { timeoutMs: timeoutSeconds * 1000 }),
  });
}

function conditionsHold(rule: GatewayGroupRule, context: GatewayRuleContext): boolean {
  if (rule.use.length === 0) {
    return false;
  }
  if (rule.tokens !== undefined && context.tokens < rule.tokens) {
    return false;
  }
  if (rule.images === true && !context.images) {
    return false;
  }
  if (rule.effort !== undefined && !effortHolds(rule.effort, context)) {
    return false;
  }
  if (rule.agents !== undefined && rule.agents.length > 0) {
    const wanted = rule.agents.map((agent) => agent.toLowerCase());
    if (!wanted.includes(context.agent.toLowerCase())) {
      return false;
    }
  }
  if (rule.time !== undefined && !windowHolds(rule.time, context.now)) {
    return false;
  }
  if (rule.compact === true && !context.compact) {
    return false;
  }
  if (rule.folders !== undefined && !inFolders(context.folder, rule.folders)) {
    return false;
  }
  if (rule.exceptFolders !== undefined && inFolders(context.folder, rule.exceptFolders)) {
    return false;
  }
  return true;
}

function inFolders(folder: string | null, rules: string[]): boolean {
  if (folder === null) {
    return false;
  }
  const here = normalizeFolder(folder);
  return rules.some((rule) => {
    const wanted = normalizeFolder(rule);
    return wanted.length > 0 && (here === wanted || here.startsWith(`${wanted}/`));
  });
}

function normalizeFolder(folder: string): string {
  let value = folder.trim().replace(/\\/g, "/");
  if (value.startsWith("~/") || value === "~") {
    value = `${homedir().replace(/\\/g, "/")}${value.slice(1)}`;
  }
  return value.replace(/\/+$/, "");
}

function effortHolds(wanted: string, context: GatewayRuleContext): boolean {
  if (wanted === "on") {
    return context.reasoning;
  }
  const minimum = EFFORT_RANK[wanted];
  if (minimum === undefined || context.effort === null) {
    return false;
  }
  return EFFORT_RANK[context.effort] >= minimum;
}

/** Days are "mon" … "sun"; a window past midnight belongs to the day it starts. */
function windowHolds(
  window: { from: string; to: string; days?: string[]; zone?: string },
  now: number,
): boolean {
  const from = clockMinutes(window.from);
  const to = clockMinutes(window.to);
  const current = clockOf(now, window.zone);
  if (from === null || to === null || current === null) {
    return false;
  }
  let startsToday: boolean;
  if (from === to) {
    startsToday = true;
  } else if (from < to) {
    startsToday = current.minutes >= from && current.minutes < to;
  } else if (current.minutes >= from) {
    startsToday = true;
  } else {
    startsToday = current.minutes < to;
  }
  if (!startsToday) {
    return false;
  }
  if (window.days === undefined || window.days.length === 0) {
    return true;
  }
  const startDay = from < to || current.minutes >= from ? current.day : previousDay(current.day);
  return window.days.map(normalizeDay).includes(startDay);
}

function clockMinutes(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (match === null) {
    return null;
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) {
    return null;
  }
  return hours * 60 + minutes;
}

function clockOf(now: number, zone: string | undefined): { minutes: number; day: string } | null {
  if (zone === undefined || zone.length === 0) {
    const date = new Date(now);
    return {
      minutes: date.getHours() * 60 + date.getMinutes(),
      day: normalizeDay(dayName(date.getDay())),
    };
  }
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(now));
    const weekday = parts.find((part) => part.type === "weekday")?.value;
    const hour = parts.find((part) => part.type === "hour")?.value;
    const minute = parts.find((part) => part.type === "minute")?.value;
    if (weekday === undefined || hour === undefined || minute === undefined) {
      return null;
    }
    return {
      minutes: Number(hour) * 60 + Number(minute),
      day: normalizeDay(weekday),
    };
  } catch {
    return null;
  }
}

const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

function dayName(index: number): string {
  return DAY_NAMES[index] ?? "sun";
}

function normalizeDay(value: string): string {
  return value.slice(0, 3).toLowerCase();
}

function previousDay(day: string): string {
  const index = DAY_NAMES.indexOf(day as (typeof DAY_NAMES)[number]);
  return DAY_NAMES[(index + 6) % 7] ?? day;
}

/**
 * The smooth weighted order of a whole round: the first pick is the one the
 * round advances to, and the failover order behind it is the round's next
 * picks simulated, so a failed first goes to the member the weights owe next.
 */
export function weightedOrder(
  group: GatewayGroup,
  members: string[],
  state: RoutingState,
): string[] {
  if (members.length <= 1) {
    return members;
  }
  const turns = (state.groupTurns ??= new Map());
  const key = `${GROUP_PREFIX}${group.id}`;
  const current = turns.get(key) ?? new Map<string, number>();
  turns.set(key, current);
  const weights = group.weights ?? {};
  // myna's Weighted: one smooth round picks the member to try first, and the
  // rest follow in the group's order, for failover.
  const first = pickWeighted(members, current, weights);
  for (const member of current.keys()) {
    if (!members.includes(member)) {
      current.delete(member);
    }
  }
  return [first, ...members.filter((member) => member !== first)];
}

function pickWeighted(
  pool: string[],
  current: Map<string, number>,
  weights: Record<string, number>,
): string {
  let total = 0;
  let picked = pool[0] ?? "";
  let best = Number.NEGATIVE_INFINITY;
  for (const member of pool) {
    const weight = weights[member] ?? 1;
    total += weight;
    const score = (current.get(member) ?? 0) + weight;
    current.set(member, score);
    if (score > best) {
      best = score;
      picked = member;
    }
  }
  current.set(picked, best - total);
  return picked;
}

/**
 * For a group that names accounts, the accounts of each provider it holds:
 * a provider named uses only those, one not named keeps every account.
 */
export function groupAccountFilter(
  config: GatewayConfig,
  requestedModel: string,
): Map<string, Set<string>> | null {
  const group = requestedGroup(config, requestedModel);
  const accounts = group?.accounts ?? [];
  if (accounts.length === 0) {
    return null;
  }
  const filter = new Map<string, Set<string>>();
  for (const entry of accounts) {
    const separator = entry.indexOf("/");
    if (separator <= 0) {
      continue;
    }
    const provider = entry.slice(0, separator);
    const account = entry.slice(separator + 1);
    const allowed = filter.get(provider) ?? new Set<string>();
    allowed.add(account);
    filter.set(provider, allowed);
  }
  return filter.size === 0 ? null : filter;
}

/** Reads what rules may weigh from a chat body. */
export function readRuleContext(input: {
  agent: string;
  tokens: number;
  body: unknown;
  now: number;
}): GatewayRuleContext {
  const effort = readRequestedEffort(input.body);
  const texts = requestTexts(input.body);
  return {
    agent: input.agent,
    tokens: input.tokens,
    images: hasImageContent(input.body, 0),
    effort: effort.effort,
    reasoning: effort.reasoning,
    folder: folderOf([...texts.system, ...texts.user]),
    compact: isCompaction(texts.system, texts.user.at(-1) ?? null),
    text: texts.user.at(-1) ?? "",
    now: input.now,
  };
}

/** The folder a chat body says its agent works in, "" when it says none. */
export function workFolderOf(body: unknown): string {
  const texts = requestTexts(body);
  return folderOf([...texts.system, ...texts.user]) ?? "";
}

interface RequestTexts {
  system: string[];
  user: string[];
}

/** The system text and the non-assistant messages, by protocol shape. */
function requestTexts(body: unknown): RequestTexts {
  const texts: RequestTexts = { system: [], user: [] };
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return texts;
  }
  const record = body as Record<string, unknown>;
  for (const value of [record.system, record.instructions, record.systemInstruction]) {
    const text = textOf(value);
    if (text.length > 0) {
      texts.system.push(text);
    }
  }
  addMessages(texts, record.messages);
  addMessages(texts, record.contents);
  addInput(texts, record.input);
  return texts;
}

function addMessages(texts: RequestTexts, list: unknown): void {
  if (!Array.isArray(list)) {
    return;
  }
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const role = typeof record.role === "string" ? record.role : "user";
    if (role === "assistant" || role === "model") {
      continue;
    }
    const text = textOf(record);
    if (text.length === 0) {
      continue;
    }
    (role === "system" || role === "developer" ? texts.system : texts.user).push(text);
  }
}

function addInput(texts: RequestTexts, input: unknown): void {
  if (typeof input === "string") {
    if (input.length > 0) {
      texts.user.push(input);
    }
    return;
  }
  addMessages(texts, input);
}

/**
 * The folder the request says its agent works in, as the agents spell it:
 * Claude Code's "Primary working directory:", Codex's and Pi's <cwd>, and
 * OpenCode's Working directory inside <env>. The last one said wins.
 */
function folderOf(texts: string[]): string | null {
  let dir: string | null = null;
  for (const text of texts) {
    const primary = lastMatch(/^(?: - )?Primary working directory: (.+)$/gm, text);
    if (primary !== null) {
      dir = cleanFolder(primary.replace(/ \(was .*\)$/, ""));
    }
    const cwd = lastMatch(/<cwd>\s*([^<\n]+?)\s*<\/cwd>/g, text);
    if (cwd !== null) {
      dir = cleanFolder(cwd);
    }
    for (const block of text.matchAll(/<env>([\s\S]*?)<\/env>/g)) {
      const inside = lastMatch(/^\s*Working directory: (.+)$/gm, block[1] ?? "");
      if (inside !== null) {
        dir = cleanFolder(inside);
      }
    }
  }
  return dir;
}

function lastMatch(pattern: RegExp, text: string): string | null {
  let found: string | null = null;
  for (const match of text.matchAll(pattern)) {
    found = match[1] ?? found;
  }
  return found;
}

function cleanFolder(value: string): string | null {
  const text = unescapeEntities(value.trim());
  return text.length === 0 ? null : text;
}

function unescapeEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

// An agent compacting its conversation asks a model to summarize it, with a
// prompt of its own in the system prompt or as the last user message, within
// the first 2048 bytes of it (myna's compacting.go, from each agent's own
// release).
const COMPACT_LEAD = 2048;

const COMPACT_SYSTEMS = [
  "You are a helpful AI assistant tasked with summarizing conversations.",
  "You are a context summarization agent.",
  "You are a context summarization assistant.",
  "You are a specialized system component responsible for distilling chat history into a structured XML <state_snapshot>",
  "You are the component that summarizes a conversation when its context window is about to overflow.",
  "You are a context compaction engine. Your summary will REPLACE the original messages in the conversation context window.",
  "You are a helpful assistant that compacts conversation context.",
  "You are compacting a long conversation so it can continue WITHOUT losing context.",
  "You are UPDATING an existing conversation summary with new activity so the conversation can continue WITHOUT losing context.",
];

const COMPACT_ASKS: { ask: string; opens?: string }[] = [
  { ask: "Your task is to create a detailed summary of the conversation so far" },
  { ask: "You are performing a CONTEXT CHECKPOINT COMPACTION." },
  { ask: "You are now given a task to compact this conversation context" },
  {
    ask: "END OF CONVERSATION TO COMPACT.",
    opens: "Compact this conversation into a context summary:",
  },
  { ask: "Merge the previous summary with the new conversation." },
  { ask: "Here is the full conversation to compact." },
];

function isCompaction(systemTexts: string[], lastUser: string | null): boolean {
  for (const text of systemTexts) {
    if (COMPACT_SYSTEMS.some((prompt) => leads(text, prompt))) {
      return true;
    }
  }
  if (lastUser === null) {
    return false;
  }
  for (const entry of COMPACT_ASKS) {
    if (entry.opens === undefined) {
      if (leads(lastUser, entry.ask)) {
        return true;
      }
    } else if (lastUser.trimStart().startsWith(entry.opens) && lastUser.includes(entry.ask)) {
      return true;
    }
  }
  return false;
}

function leads(text: string, prompt: string): boolean {
  const at = text.indexOf(prompt);
  return at >= 0 && at <= COMPACT_LEAD;
}

function textOf(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((entry) => textOf(entry))
      .filter((entry) => entry.length > 0)
      .join("\n");
  }
  if (typeof value !== "object" || value === null) {
    return "";
  }
  const record = value as Record<string, unknown>;
  if (typeof record.text === "string") {
    return record.text;
  }
  if (typeof record.content === "string") {
    return record.content;
  }
  if (Array.isArray(record.content)) {
    return textOf(record.content);
  }
  if (Array.isArray(record.parts)) {
    return textOf(record.parts);
  }
  return "";
}

function readRequestedEffort(body: unknown): {
  effort: GatewayEffort | null;
  reasoning: boolean;
} {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { effort: null, reasoning: false };
  }
  const record = body as Record<string, unknown>;
  const direct = level(record.reasoning_effort);
  if (direct !== null) {
    return { effort: direct, reasoning: true };
  }
  return nestedEffort(record) ?? { effort: null, reasoning: false };
}

/** The reasoning the agent asked for in its protocol's own shape. */
function nestedEffort(
  record: Record<string, unknown>,
): { effort: GatewayEffort | null; reasoning: boolean } | null {
  const reasoning = objectAt(record, "reasoning");
  if (reasoning !== null) {
    const named = level(reasoning.effort);
    if (named !== null) {
      return { effort: named, reasoning: true };
    }
  }
  const thinking = objectAt(record, "thinking");
  if (
    thinking !== null &&
    (thinking.type === "enabled" || typeof thinking.budget_tokens === "number")
  ) {
    return { effort: null, reasoning: true };
  }
  const generation = objectAt(record, "generationConfig");
  const thinkingConfig = generation === null ? null : objectAt(generation, "thinkingConfig");
  const budget = thinkingConfig === null ? undefined : thinkingConfig.thinkingBudget;
  if (typeof budget === "number" && budget > 0) {
    return { effort: null, reasoning: true };
  }
  return null;
}

function objectAt(record: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = record[key];
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function level(value: unknown): GatewayEffort | null {
  if (typeof value !== "string") {
    return null;
  }
  if (value === "minimal") {
    return "low";
  }
  return (GATEWAY_EFFORTS as readonly string[]).includes(value) ? (value as GatewayEffort) : null;
}

function hasImageContent(value: unknown, depth: number): boolean {
  if (depth > 8 || value === null || typeof value !== "object") {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((entry) => hasImageContent(entry, depth + 1));
  }
  const record = value as Record<string, unknown>;
  if (record.type === "image" || record.type === "image_url" || record.type === "input_image") {
    return true;
  }
  if (record.image_url !== undefined || record.inlineData !== undefined) {
    return true;
  }
  return Object.values(record).some((entry) => hasImageContent(entry, depth + 1));
}
