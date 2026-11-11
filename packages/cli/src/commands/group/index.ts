import chalk from "chalk";
import { Command } from "commander";
import type { Logger } from "pino";
import { resolveNeolixHome } from "@neolix/server/daemon-control";
import { foundGroups, groupsOf, sameModel, slug } from "@neolix/server/gateway-groups-auto";
import {
  GatewayConfigStore,
  type GatewayConfig,
  type GatewayGroup,
  type GatewayGroupRule,
  type GatewayModel,
  type GatewayProvider,
} from "@neolix/server/gateway-config";
import { parseTokens } from "../model/index.js";
import type { AgentConnectSnapshot } from "@neolix/protocol/agent-connect";
import { GATEWAY_PROVIDER_PRESETS } from "@neolix/protocol/gateway-presets";
import { agentUses, applyReseat, connectedAgents, reseatPlan } from "./agent-uses.js";

/**
 * `neolix group` — myna's `myna group …` (internal/cli/groups_cli.go,
 * groups_rules_cli.go), over this computer's gateway.json. The daemon watches
 * that file, so no daemon is needed. The wording and usage strings are myna's,
 * with neolix as the command, and the settings neolix's gateway.json keeps.
 *
 * myna's `stays=`, `family=`, `listed=` and `effort=auto` are not settings a
 * neolix group has; the commands name them and say so rather than writing a
 * field the gateway would drop.
 */

type Group = GatewayGroup;
type Rule = GatewayGroupRule;
type Strategy = GatewayGroup["strategy"];

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
type Effort = (typeof EFFORTS)[number];
const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const MAX_WEIGHT = 1000;

/** The agents set to each group, read once per command from agent-connect. */
let usedBy: ReadonlyMap<string, string[]> = new Map();
let agentSnapshot: AgentConnectSnapshot | null = null;

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => silentLogger,
} as unknown as Logger;

async function withStore<T>(work: (store: GatewayConfigStore) => Promise<T>): Promise<T> {
  const neolixHome = resolveNeolixHome({ NEOLIX_HOME: process.env.NEOLIX_HOME });
  const store = new GatewayConfigStore({ neolixHome, logger: silentLogger });
  await store.start();
  try {
    return await work(store);
  } finally {
    store.dispose();
  }
}

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

const groupUsage = `usage:
  neox groups                           list routing groups: yours, then those Neox found
  neox group <id>                       show one group and its models (also: neox group show <id>)
  neox group add <name> models=<m1>[,m2…] [routing=…]
                                          make a group; agents pick it as group/<id>, the id made from the name;
                                          a name in use replaces that group
  neox group set <id> k=v…              change one: name, models (the whole list, in order, patterns too),
                                          models+=<m>[,m2…] (append), models-=<m>[,m2…] (drop), routing,
                                          stays (auto|session|turn|off|strict: how long a conversation
                                          keeps the account or key that answered it),
                                          patience=off|default|<time, e.g. 2m> (how long a
                                          request may be kept once every member has failed in a
                                          way that passes; at most 4m),
                                          context (how long a request agents are told it takes: 272k),
                                          levels (the reasoning levels agents are offered),
                                          family (a tag), listed=no|yes (its models leave the
                                          lists agents see, offered through the group alone),
                                          effort=auto|agent (whether the classifier picks each turn's
                                          reasoning), classifier=<provider/model>|group/<id>,
                                          pick=<model>, fast=<m1>[,m2…], weight=<m1>=<n>[,m2=<n>…],
                                          id (what agents pick it as)
  neox group pick <id> <model>          route the group manually, every request to that model
  neox group copy <id> [name]           duplicate a group with its models, routing and rules, listed after it
                                          (name: "<its name> copy" when left out; also: neox group duplicate)
  neox group template [kind] [name]     a group for a common need, made of your own models in one go; without
                                          a kind, lists them and the models each would take: smart (hard turns
                                          to the strongest model, easy ones to a cheap one, a classifier telling
                                          them apart), thrifty (a cheap model first, the strongest for high
                                          reasoning or when the cheap ones fail), steady (the strongest model of
                                          each of up to three providers, each behind the other). A name or id in
                                          use is numbered, never replaced
  neox group rm <id>…                   remove groups (one Neox found is hidden instead)
  neox group restore <id>               bring back a group Neox found that you removed
  neox group auto [on|off]              whether Neox finds groups on its own (on by default); off, none is
                                          listed or served — yours, and found ones you changed, stay
  neox group auto skip <provider>…      keep providers out of the groups Neox finds; skip none lets every one back in
  neox group rule add|rm|mv <id> …      rules: which model a turn goes to first
  neox group rule classifier <id> <model>
                                          the model that tells which intent a message is

  Neox finds a group for each model two or more providers serve (auto-<model>, never stored;
  neox group auto off stops it)

  models   provider/model ids as neox provider ls lists them; a bare model id works when one provider serves it;
           group/<id> puts another group in it; provider/model:<effort> fixes the member's reasoning;
           provider/model:fast sends the member in its vendor's fast mode; a glob or re:<regexp> pattern
           puts in every model it matches

  routing  smart   (default) of the subscriptions with quota to spare, the one renewing soonest first
           order   the first model until it can't answer, then the next
           drain   one account or key until it is used up, then the next
           rotate  each conversation's next turn goes to the next member's account or key
           usage   the account or key with the most of its allowance left first
           pace    the account with the most of its week left per hour until it renews first
           weight  each model takes its share by its weight (weight=)
           free, fast, cheap   the provider that is free, fastest or cheapest first

  e.g. neox group add "Opus anywhere" models=claude/claude-opus-5-5,copilot/claude-opus-5.5 routing=order
       neox group set opus-anywhere models+=openrouter/anthropic/claude-opus-5.5
       neox group add Everything models=group/opus-anywhere,deepseek/deepseek-v4-flash routing=order
       neox group set opus-anywhere routing=weight weight=claude/claude-opus-5-5=3
       neox group pick opus-anywhere copilot/claude-opus-5.5
       neox claude group/opus-anywhere`;

const ruleUsage = `usage:
  neox group rule <group>               the group's rules
  neox group rule add <group> use=<model> [use-effort=low|medium|high|xhigh|max] [tokens=<n>] [images]
                        [effort=on|low|medium|high|xhigh|max] [agents=a,b…]
                        [intent="<what the message asks for>"] [compact] [time=HH:MM-HH:MM] [days=mon-fri]
                        [tz=<zone>] [folders=<folder>,…] [except-folders=<folder>,…]
                        [classifier=<model>] [at=<n>]
                                          a rule: a turn that matches it goes to <model>, one of the group's,
                                          first. use=a,b names several, in order
  neox group rule add <group> pause=<model> [time=HH:MM-HH:MM] [days=mon-fri] [tz=<zone>] [agents=a,b…]
                        [folders=<folder>,…] [except-folders=<folder>,…] [at=<n>]
                                          a pause: while it holds, <model> is left out of the group
  neox group rule rm <group> <n>        remove rule n
  neox group rule mv <group> <n> <to>   move rule n to place <to>
  neox group rule classifier <group> <model>
                                          the model that tells which intent a message is

  Rules are looked at top first when you send a message (a new turn); the first that
  matches puts its model first, and the group's others stay behind it if it fails.
  A pause is looked at on every request and leaves its model out while it holds.
  Every condition given must hold: tokens, images, effort, agents, intent, compact,
  time, days, tz, folders, except-folders.`;

// ---------------------------------------------------------------- providers

interface ServedModel {
  id: string;
  provider: GatewayProvider;
  model: GatewayModel;
}

/** The provider's models as it serves them (a superset for `best`). */
function servedOf(config: GatewayConfig): ServedModel[] {
  const entries: ServedModel[] = [];
  for (const provider of config.providers) {
    if (provider.enabled === false || provider.exposeModels === false) {
      continue;
    }
    if (provider.modelMode === "none") {
      continue;
    }
    for (const model of provider.models) {
      if (provider.modelMode === "picked" && model.picked !== true) {
        continue;
      }
      entries.push({ id: `${provider.id}/${model.id}`, provider, model });
    }
  }
  return entries;
}

function providerName(provider: GatewayProvider): string {
  return provider.label ?? provider.id;
}

function modelName(model: GatewayModel): string {
  return model.label ?? model.id;
}

function serviceOf(config: GatewayConfig, id: string): ServedModel | undefined {
  return servedOf(config).find((entry) => entry.id === id);
}

// ------------------------------------------------------------------ groups

interface FoundGroup {
  group: Group;
  stored: boolean;
  hidden: boolean;
}

/** Every group id an agent could pick now, the user's then found ones. */
function visibleGroups(config: GatewayConfig): Group[] {
  return groupsOf(config);
}

function isHidden(config: GatewayConfig, id: string): boolean {
  return (config.hiddenGroups ?? []).some((hidden) => hidden.toLowerCase() === id.toLowerCase());
}

/** myna's findGroup: by id, then by name. */
function findGroup(config: GatewayConfig, ref: string): FoundGroup {
  const wanted = ref
    .trim()
    .replace(/^neolix\//, "")
    .replace(/^group\//, "");
  const user = config.groups.find((group) => group.id === wanted);
  if (user !== undefined) {
    return { group: user, stored: true, hidden: isHidden(config, user.id) };
  }
  const insensitive = config.groups.find(
    (group) => group.id.toLowerCase() === wanted.toLowerCase(),
  );
  if (insensitive !== undefined) {
    return { group: insensitive, stored: true, hidden: isHidden(config, insensitive.id) };
  }
  const named = config.groups.find(
    (group) => group.label?.toLowerCase() === wanted.toLowerCase() && !isHidden(config, group.id),
  );
  if (named !== undefined) {
    return { group: named, stored: true, hidden: false };
  }
  const found = foundGroups(config).find(
    (group) => group.id.toLowerCase() === wanted.toLowerCase(),
  );
  if (found !== undefined) {
    return { group: found, stored: false, hidden: isHidden(config, found.id) };
  }
  const foundName = foundGroups(config).find(
    (group) => group.label?.toLowerCase() === wanted.toLowerCase(),
  );
  if (foundName !== undefined) {
    return { group: foundName, stored: false, hidden: isHidden(config, foundName.id) };
  }
  const ids = visibleGroups(config)
    .filter((group) => !isHidden(config, group.id))
    .map((group) => group.id);
  if (ids.length === 0) {
    throw new Error(`no group "${wanted}"; there are none yet (neox group add <name> models=…)`);
  }
  throw new Error(`no group "${wanted}" (groups: ${ids.join(", ")})`);
}

/** A group's id as the agent asks for it. */
function groupRef(group: Group): string {
  return `group/${group.id}`;
}

function nameOf(group: Group): string {
  return group.label ?? group.id;
}

function saveGroup(config: GatewayConfig, group: Group): GatewayConfig {
  const at = config.groups.findIndex((existing) => existing.id === group.id);
  const groups =
    at < 0
      ? [...config.groups, group]
      : config.groups.map((existing, index) => (index === at ? group : existing));
  return { ...config, groups };
}

function removeStored(config: GatewayConfig, id: string): GatewayConfig {
  return { ...config, groups: config.groups.filter((group) => group.id !== id) };
}

function setHidden(config: GatewayConfig, id: string, hidden: boolean): GatewayConfig {
  const present = isHidden(config, id);
  if (hidden === present) {
    return config;
  }
  const ids = (config.hiddenGroups ?? []).filter(
    (existing) => existing.toLowerCase() !== id.toLowerCase(),
  );
  if (hidden) {
    ids.push(id);
  }
  return { ...config, hiddenGroups: ids };
}

function takenIds(config: GatewayConfig): Set<string> {
  return new Set([
    ...config.groups.map((group) => group.id),
    ...groupsOf(config).map((group) => group.id),
    ...(config.hiddenGroups ?? []),
  ]);
}

function freeGroupName(
  config: GatewayConfig,
  name: string,
  base?: string,
): { name: string; id: string } {
  const names = new Set(
    [
      ...config.groups.filter((group) => !isHidden(config, group.id)),
      ...groupsOf(config).filter((group) => group.auto === true),
    ].map((group) => nameOf(group).toLowerCase()),
  );
  const ids = takenIds(config);
  let chosen = name.trim();
  const original = chosen;
  for (let n = 2; names.has(chosen.toLowerCase()); n += 1) {
    chosen = `${original} ${n}`;
  }
  const baseId = slug(base ?? chosen) || "group";
  let id = baseId;
  for (let n = 2; ids.has(id); n += 1) {
    id = `${baseId}-${n}`;
  }
  return { name: chosen, id };
}

// ----------------------------------------------------------- model parsing

function isPattern(value: string): boolean {
  return value.includes("*") || value.startsWith("re:");
}

function compilePattern(pattern: string): RegExp {
  if (pattern.startsWith("re:")) {
    try {
      return new RegExp(pattern.slice(3), "i");
    } catch {
      throw new Error(`"${pattern}" is not a regular expression`);
    }
  }
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

function cleanPatterns(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

function splitMemberRef(member: string): { id: string; effort: Effort | null } {
  const colon = member.lastIndexOf(":");
  if (colon > 0) {
    const suffix = member.slice(colon + 1);
    if ((EFFORTS as readonly string[]).includes(suffix)) {
      return { id: member.slice(0, colon), effort: suffix as Effort };
    }
  }
  return { id: member, effort: null };
}

interface ResolvedMember {
  id: string;
  fast: boolean;
}

/** myna's memberResolver: the catalog's provider/model id for what was typed. */
function resolveMember(
  config: GatewayConfig,
  value: string,
  keep: readonly string[],
): ResolvedMember {
  let typed = value.trim().replace(/^neolix\//, "");
  if (keep.includes(typed)) {
    return { id: typed, fast: false };
  }
  let fast = false;
  if (typed.endsWith(":fast")) {
    fast = true;
    typed = typed.slice(0, -":fast".length);
  }
  const { id: base, effort } = splitMemberRef(typed);
  const finish = (id: string): ResolvedMember => ({
    id: effort === null ? id : `${id}:${effort}`,
    fast,
  });
  const kept = effort === null ? keep.includes(base) : keep.includes(`${base}:${effort}`);
  if (kept) {
    return finish(base);
  }
  if (base.startsWith("group/") || base.startsWith("auto/")) {
    const wanted = base.startsWith("group/")
      ? base.slice("group/".length)
      : `auto-${slug(sameModel(base.slice("auto/".length)))}`;
    const group = groupsOf(config).find(
      (candidate) => candidate.id.toLowerCase() === wanted.toLowerCase(),
    );
    if (group === undefined) {
      throw new Error(`Neox has no group "${wanted}" (neox group <id> shows them)`);
    }
    if (effort !== null) {
      throw new Error(
        `${base} is a group: its models reason as it says, so it takes no :${effort}`,
      );
    }
    return { id: `group/${group.id}`, fast };
  }
  const entries = servedOf(config);
  const exact = entries.find((entry) => entry.id.toLowerCase() === base.toLowerCase());
  if (exact !== undefined) {
    return finish(exact.id);
  }
  const byModel = entries.filter((entry) => entry.model.id.toLowerCase() === base.toLowerCase());
  if (byModel.length === 1) {
    return finish(byModel[0]!.id);
  }
  if (byModel.length > 1) {
    throw new Error(
      `${base} is served by ${byModel.length} providers; name one: ${byModel.map((entry) => entry.id).join(", ")}`,
    );
  }
  throw new Error(`Neox knows no model "${base}" (neox provider ls lists them)`);
}

/** A typed value as one of the group's members (myna's pickMember/GroupMember). */
function groupMember(group: Group, value: string): string {
  const wanted = value.trim().replace(/^neolix\//, "");
  const plain = (member: string): string => splitMemberRef(member).id;
  const attempts: Array<(member: string) => boolean> = [
    (member) => member === wanted,
    (member) => member.toLowerCase() === wanted.toLowerCase(),
    (member) => member.slice(member.indexOf("/") + 1).toLowerCase() === wanted.toLowerCase(),
    (member) => member.slice(member.lastIndexOf("/") + 1).toLowerCase() === wanted.toLowerCase(),
    (member) => plain(member).toLowerCase() === wanted.toLowerCase(),
    (member) =>
      plain(member)
        .slice(plain(member).indexOf("/") + 1)
        .toLowerCase() === wanted.toLowerCase(),
  ];
  for (const match of attempts) {
    const hits = group.members.filter(match);
    if (hits.length === 1) {
      return hits[0]!;
    }
    if (hits.length > 1) {
      throw new Error(`${wanted} is ${hits.join(" and ")}: name one`);
    }
  }
  throw new Error(
    `${wanted} is not in group/${group.id} (its models: ${group.members.join(", ")})`,
  );
}

function parseMemberList(
  config: GatewayConfig,
  value: string,
  keep: readonly string[],
): { members: string[]; match: string[]; fast: string[] } {
  const members: string[] = [];
  const match: string[] = [];
  const fast: string[] = [];
  for (const part of cleanPatterns(value)) {
    if (isPattern(part)) {
      compilePattern(part);
      if (!match.includes(part)) {
        match.push(part);
      }
      continue;
    }
    const resolved = resolveMember(config, part, keep);
    if (!members.includes(resolved.id)) {
      members.push(resolved.id);
    }
    if (resolved.fast && !fast.includes(resolved.id)) {
      fast.push(resolved.id);
    }
  }
  return { members, match, fast };
}

/** Takes a pattern off the group (myna's models-<pattern>), or says it isn't one. */
function dropPattern(group: Group, pattern: string): void {
  const patterns = group.match ?? [];
  if (!patterns.includes(pattern)) {
    throw new Error(
      `${pattern} is not one of the group's patterns (${patterns.length === 0 ? "none" : patterns.join(", ")})`,
    );
  }
  group.match = patterns.filter((candidate) => candidate !== pattern);
}

/** Takes a member off the group, with what named it. */
function dropMember(group: Group, value: string): void {
  const member = groupMember(group, value);
  group.members = group.members.filter((candidate) => candidate !== member);
  group.fast = (group.fast ?? []).filter((candidate) => candidate !== member);
  if (group.pick === member) {
    delete group.pick;
  }
  if (group.weights !== undefined) {
    delete group.weights[member];
  }
}

// ----------------------------------------------------------------- routing

const ROUTING_NAMES: Array<{ value: Strategy; name: string; also: string[] }> = [
  { value: "smart", name: "smart", also: ["default", "auto"] },
  { value: "order", name: "order", also: ["ordered", "in-order"] },
  { value: "rotate", name: "rotate", also: ["in-turn", "round-robin"] },
  { value: "least-used", name: "usage", also: ["least-used"] },
  { value: "pace", name: "pace", also: ["weekly-pace"] },
  { value: "free", name: "free", also: ["free-first", "freest", "no-cost"] },
  { value: "fast", name: "fast", also: ["fastest", "speed", "speed-first"] },
  { value: "cheap", name: "cheap", also: ["cheapest", "cheapest-first", "price", "cost"] },
  { value: "drain", name: "drain", also: ["until-used-up", "use-up", "sticky"] },
];

function parseRouting(value: string): {
  strategy: Strategy;
  weighted: boolean;
  manual: boolean;
} {
  const text = value.trim().toLowerCase();
  if (["weight", "weighted", "by-weight", "weighted-round-robin", "wrr"].includes(text)) {
    return { strategy: "order", weighted: true, manual: false };
  }
  if (["manual", "pick", "picked", "pinned"].includes(text)) {
    // myna's Manual: only the picked member, the others and the rules wait
    return { strategy: "order", weighted: false, manual: true };
  }
  for (const routing of ROUTING_NAMES) {
    if (text === routing.value || text === routing.name || routing.also.includes(text)) {
      return { strategy: routing.value, weighted: false, manual: false };
    }
  }
  throw new Error(
    `routing "${value}" is not one Neox has: ${[...ROUTING_NAMES.map((routing) => routing.name), "manual"].join(", ")}`,
  );
}

function routingName(group: Group): string {
  if (group.manual === true) {
    return "manual";
  }
  if (group.weighted === true) {
    return "weight";
  }
  return ROUTING_NAMES.find((routing) => routing.value === group.strategy)?.name ?? group.strategy;
}

const AFFINITIES = ["auto", "session", "turn", "off", "strict"] as const;
type Affinity = (typeof AFFINITIES)[number];

function parseStays(value: string): Affinity {
  const text = value.trim().toLowerCase();
  const aliases: Record<string, Affinity> = {
    "": "auto",
    default: "auto",
    "within-a-turn": "turn",
    none: "off",
    never: "off",
    "strict-session": "strict",
    "never-move": "strict",
  };
  if (aliases[text] !== undefined) {
    return aliases[text];
  }
  if ((AFFINITIES as readonly string[]).includes(text)) {
    return text as Affinity;
  }
  throw new Error(`stays "${value}" is not one Neox has: ${AFFINITIES.join(", ")}`);
}

const PATIENCE_LONGEST_MS = 240_000;
const DURATION_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
};

/**
 * patience= as myna reads it: `off` (0 here), `default` (absent), or a time
 * such as 90, 90s or 2m, at most 4m. Neolix keeps it in milliseconds, so no
 * rounding to a second is needed.
 */
function parsePatience(value: string): number | undefined {
  const text = value.trim().toLowerCase();
  if (["off", "no", "none", "0"].includes(text)) {
    return 0;
  }
  if (text === "" || text === "default") {
    return undefined;
  }
  let ms: number;
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    // a bare number is seconds, as myna reads it
    ms = Number(text) * 1_000;
  } else {
    const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(text);
    if (match === null) {
      throw new Error(`patience=off|default|<time, e.g. 2m>, not "${value}"`);
    }
    ms = Number(match[1]) * (DURATION_MS[match[2]!] ?? 1);
  }
  if (ms === 0) {
    return 0;
  }
  if (ms < 0 || ms > PATIENCE_LONGEST_MS) {
    throw new Error(`patience is at most 4m0s, not "${value}"`);
  }
  return Math.round(ms);
}

/** patience in milliseconds as a card says it: off, 90s, 2m. */
function patienceText(ms: number): string {
  if (ms === 0) {
    return "off";
  }
  if (ms % 60_000 === 0) {
    return `${ms / 60_000}m`;
  }
  if (ms % 1_000 === 0) {
    return `${ms / 1_000}s`;
  }
  return `${ms}ms`;
}

// ----------------------------------------------------------------- editing

// eslint-disable-next-line complexity -- myna's one field table, kept whole so its wording stays beside it.
function applyPairs(
  config: GatewayConfig,
  group: Group,
  pairs: readonly string[],
  allowId: boolean,
): void {
  const keep = () => group.members;
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq < 0) {
      throw new Error(`expected key=value, got "${pair}" (neox group help)`);
    }
    const field = pair.slice(0, eq).trim().toLowerCase();
    const value = pair.slice(eq + 1);
    switch (field) {
      case "id": {
        if (!allowId) {
          throw new Error("a group's id stays as it is; add a new group for another");
        }
        group.id = value.trim().toLowerCase();
        break;
      }
      case "name": {
        const name = value.trim();
        if (name === "") {
          delete group.label;
        } else {
          group.label = name;
        }
        break;
      }
      case "models":
      case "members":
      case "model": {
        const parsed = parseMemberList(config, value, []);
        group.members = parsed.members;
        group.match = parsed.match.length > 0 ? parsed.match : undefined;
        group.fast = parsed.fast.length > 0 ? parsed.fast : undefined;
        break;
      }
      case "models+":
      case "members+":
      case "model+": {
        const parsed = parseMemberList(config, value, keep());
        for (const member of parsed.members) {
          if (!group.members.includes(member)) {
            group.members = [...group.members, member];
          }
        }
        for (const pattern of parsed.match) {
          if (!(group.match ?? []).includes(pattern)) {
            group.match = [...(group.match ?? []), pattern];
          }
        }
        for (const member of parsed.fast) {
          if (!(group.fast ?? []).includes(member)) {
            group.fast = [...(group.fast ?? []), member];
          }
        }
        break;
      }
      case "models-":
      case "members-":
      case "model-": {
        for (const part of cleanPatterns(value).map((item) => item.trim())) {
          if (isPattern(part)) {
            dropPattern(group, part);
          } else {
            dropMember(group, part);
          }
        }
        break;
      }
      case "routing":
      case "strategy": {
        const parsed = parseRouting(value);
        group.strategy = parsed.strategy;
        if (parsed.weighted) {
          group.weighted = true;
        } else {
          delete group.weighted;
        }
        if (parsed.manual) {
          group.manual = true;
        } else {
          delete group.manual;
        }
        break;
      }
      case "patience": {
        const patience = parsePatience(value);
        if (patience === undefined) {
          delete group.patience;
        } else {
          group.patience = patience;
        }
        break;
      }
      case "stays":
      case "stay":
      case "affinity": {
        const affinity = parseStays(value);
        if (affinity === "auto") {
          delete group.affinity;
        } else {
          group.affinity = affinity;
        }
        break;
      }
      case "context": {
        const text = value.trim().toLowerCase();
        if (text === "" || text === "largest" || text === "max") {
          delete group.context;
        } else if (text === "smallest" || text === "min") {
          group.context = -1;
        } else {
          group.context = parseTokens(value);
        }
        break;
      }
      case "levels":
      case "level": {
        const levels = value
          .split(/[,\s]+/)
          .map((level) => level.trim())
          .filter((level) => level !== "");
        if (levels.length === 0) {
          delete group.levels;
          break;
        }
        for (const level of levels) {
          if (!(EFFORTS as readonly string[]).includes(level)) {
            throw new Error(`a reasoning level is one of ${EFFORTS.join(", ")}, not "${level}"`);
          }
        }
        group.levels = levels as Effort[];
        break;
      }
      case "family":
      case "tag": {
        const family = value.trim();
        if (family === "") {
          delete group.family;
        } else {
          group.family = family;
        }
        break;
      }
      case "listed": {
        // no: the models in it leave the lists agents see (myna's Unlists)
        const listed = value.trim().toLowerCase();
        if (listed === "no") {
          group.unlists = true;
        } else if (listed === "yes") {
          delete group.unlists;
        } else {
          throw new Error(
            `listed=no (its models offered through the group alone) or listed=yes, not "${value}"`,
          );
        }
        break;
      }
      case "effort":
      case "reasoning": {
        const effort = value.trim().toLowerCase();
        if (effort === "auto" || effort === "jev") {
          group.effort = "auto";
        } else if (effort === "" || effort === "agent" || effort === "off") {
          delete group.effort;
        } else {
          throw new Error(
            `effort=auto (the classifier picks each turn's) or effort=agent (the agent's), not "${value}"`,
          );
        }
        break;
      }
      case "classifier":
      case "classify": {
        const classifier = value.trim().replace(/^neolix\//, "");
        if (classifier === "") {
          delete group.classifier;
        } else {
          group.classifier = classifier;
        }
        break;
      }
      case "fast": {
        const fast: string[] = [];
        for (const part of cleanPatterns(value)) {
          if (part === "") {
            continue;
          }
          const member = groupMember(group, part.replace(/:fast$/, ""));
          if (!fast.includes(member)) {
            fast.push(member);
          }
        }
        group.fast = fast.length > 0 ? fast : undefined;
        break;
      }
      case "weight":
      case "weights": {
        if (value.trim() === "") {
          delete group.weights;
          break;
        }
        for (const part of cleanPatterns(value)) {
          const at = part.lastIndexOf("=");
          if (at <= 0) {
            throw new Error(`weight=<model>=<n>, as weight=${part}=3, not "${part}"`);
          }
          const n = Number(part.slice(at + 1).trim());
          if (!Number.isInteger(n) || n < 1 || n > MAX_WEIGHT) {
            throw new Error(`${part}: a model's weight is 1 to ${MAX_WEIGHT}`);
          }
          const member = groupMember(group, part.slice(0, at).replace(/:fast$/, ""));
          group.weights = { ...group.weights, [member]: n };
        }
        break;
      }
      case "pick":
      case "use": {
        const member = groupMember(group, value);
        group.pick = member;
        // myna's manual routing: only the pick, until another is picked
        group.manual = true;
        break;
      }
      default:
        throw new Error(
          `unknown field "${field}" (fields: name, models, models+, models-, routing, pick, context, ` +
            "levels, classifier, fast, weight, id; neox group help)",
        );
    }
  }
}

/** myna's RenameGroup: `group/<from>` in the other groups becomes `group/<to>`. */
function renameReferences(groups: readonly Group[], from: string, to: string): Group[] {
  const old = `group/${from}`;
  const now = `group/${to}`;
  const rename = (member: string): string => (member === old ? now : member);
  return groups.map((group) => ({
    ...group,
    members: group.members.map(rename),
    ...(group.match === undefined ? {} : { match: group.match.map(rename) }),
    ...(group.fast === undefined ? {} : { fast: group.fast.map(rename) }),
    ...(group.weights === undefined
      ? {}
      : {
          weights: Object.fromEntries(
            Object.entries(group.weights).map(([member, weight]) => [rename(member), weight]),
          ),
        }),
    ...(group.pick === undefined ? {} : { pick: rename(group.pick) }),
    ...(group.rules === undefined
      ? {}
      : {
          rules: group.rules.map((rule) => ({
            ...rule,
            use: rename(rule.use),
            ...(rule.more === undefined ? {} : { more: rule.more.map(rename) }),
          })),
        }),
  }));
}

/** myna's pruneRules: the rules for models no longer in the group go. */
function pruneRules(group: Group): void {
  const kept: Rule[] = [];
  group.rules = structuredClone(group.rules ?? []);
  for (const [at, rule] of (group.rules ?? []).entries()) {
    let current: Rule | null = rule;
    const uses = [rule.use, ...(rule.more ?? [])];
    for (const use of uses) {
      if (group.members.includes(use)) {
        continue;
      }
      if (use === rule.use && (rule.more ?? []).length === 0) {
        out(`${chalk.yellow("!")} rule ${at + 1} is removed with ${use}`);
        current = null;
        break;
      }
      current = {
        ...current,
        use: current.use === use ? (current.more?.[0] ?? "") : current.use,
        more: (current.more ?? []).filter((candidate) => candidate !== use),
      };
      if (current.use === "") {
        current = null;
        break;
      }
      out(`${chalk.yellow("!")} rule ${at + 1} no longer sends to ${use}`);
    }
    if (current !== null && current.use !== "") {
      kept.push(current);
    }
  }
  group.rules = kept.length > 0 ? kept : undefined;
}

// ------------------------------------------------------------------ output

/** The models a pattern matches now, not counting the group's own members. */
function patternHits(config: GatewayConfig, group: Group, pattern: string): number {
  const matcher = compilePattern(pattern);
  return servedOf(config).filter(
    (entry) => !group.members.includes(entry.id) && matcher.test(entry.id),
  ).length;
}

function memberLabel(config: GatewayConfig, member: string): string | null {
  if (member.startsWith("group/")) {
    const group = groupsOf(config).find(
      (candidate) => candidate.id === member.slice("group/".length),
    );
    if (group === undefined) {
      return null;
    }
    return `routing group ${nameOf(group)} · ${routingName(group)} · ${group.members.join(", ")}`;
  }
  const ref = splitMemberRef(member);
  const entry = serviceOf(config, ref.id);
  if (entry === undefined) {
    return null;
  }
  let name = modelName(entry.model);
  if (ref.effort !== null) {
    name += ` · ${ref.effort} reasoning, whatever the agent asks`;
  }
  return `${providerName(entry.provider)} · ${name}`;
}

function whyNotServed(config: GatewayConfig, member: string): string {
  if (member.startsWith("group/")) {
    return "not served";
  }
  const ref = splitMemberRef(member);
  const slash = ref.id.indexOf("/");
  if (slash < 0) {
    return "not served";
  }
  const providerId = ref.id.slice(0, slash);
  const modelId = ref.id.slice(slash + 1);
  const provider = config.providers.find((candidate) => candidate.id === providerId);
  if (provider === undefined) {
    return `not served: no provider ${providerId}`;
  }
  if (provider.enabled === false) {
    return `not served: ${providerName(provider)} is off`;
  }
  if (provider.exposeModels === false || provider.modelMode === "none") {
    return "not served: not exposed";
  }
  if (
    provider.modelMode === "picked" &&
    !provider.models.some((model) => model.id === modelId && model.picked === true)
  ) {
    return "not served: not exposed";
  }
  if (!provider.models.some((model) => model.id === modelId)) {
    return "not served";
  }
  return "";
}

function patternCountLine(pattern: string, hits: number): string {
  if (hits === 0) {
    return `${pattern}${chalk.yellow("  matches nothing now")}`;
  }
  if (hits === 1) {
    return `${pattern}${chalk.gray("  1 model")}`;
  }
  return `${pattern}${chalk.gray(`  ${hits} models`)}`;
}

function typedMember(group: Group, member: string): string {
  return (group.fast ?? []).includes(member) ? `${member}:fast` : member;
}

function ruleConditions(rule: Rule): string[] {
  const parts: string[] = [];
  if (rule.tokens !== undefined) {
    parts.push(`tokens ≥ ${rule.tokens}`);
  }
  if (rule.images === true) {
    parts.push("images");
  }
  if (rule.effort !== undefined && rule.effort !== "") {
    parts.push(rule.effort === "on" ? "reasoning" : `effort ≥ ${rule.effort}`);
  }
  if ((rule.agents ?? []).length > 0) {
    parts.push(`agent ${(rule.agents ?? []).join("|")}`);
  }
  if (rule.intent !== undefined) {
    parts.push(`intent ${JSON.stringify(rule.intent)}`);
  }
  if (rule.compact === true) {
    parts.push("compacting");
  }
  if (rule.time !== undefined) {
    parts.push(`time ${timeText(rule.time)}`);
  }
  if ((rule.folders ?? []).length > 0) {
    parts.push(`folder ${(rule.folders ?? []).join("|")}`);
  }
  if ((rule.exceptFolders ?? []).length > 0) {
    parts.push(`not folder ${(rule.exceptFolders ?? []).join("|")}`);
  }
  return parts;
}

function daysText(days: readonly string[]): string {
  if (days.length === 0) {
    return "";
  }
  if (days.length === 7) {
    return "every day";
  }
  const at = (day: string): number => WEEKDAYS.indexOf(day.toLowerCase());
  const indexes = [...new Set(days.map(at).filter((index) => index >= 0))].sort(
    (left, right) => left - right,
  );
  if (indexes.length === 0) {
    return days.join(",");
  }
  const runs: string[] = [];
  let start = indexes[0]!;
  let previous = start;
  const close = (): void => {
    runs.push(previous === start ? WEEKDAYS[start]! : `${WEEKDAYS[start]!}-${WEEKDAYS[previous]!}`);
  };
  for (const index of indexes.slice(1)) {
    if (index === previous + 1) {
      previous = index;
      continue;
    }
    close();
    start = index;
    previous = index;
  }
  close();
  return runs.join(",");
}

function timeText(time: NonNullable<Rule["time"]>): string {
  let text = time.from === time.to ? "all day" : `${time.from}–${time.to}`;
  const days = daysText(time.days ?? []);
  if (days !== "") {
    text += ` ${days}`;
  }
  if (time.zone !== undefined) {
    text += ` (${time.zone})`;
  }
  return text;
}

function ruleLine(rule: Rule): string {
  const conditions = ruleConditions(rule).join(" · ");
  if (rule.pause === true) {
    return `${conditions} ${chalk.gray("→ pause")} ${rule.use}`;
  }
  const uses = [rule.use, ...(rule.more ?? [])];
  const arrow = chalk.gray(" → ");
  if (rule.useEffort !== undefined) {
    return `${conditions}${arrow}${uses.join(chalk.gray(", "))}${chalk.gray(" at ")}${rule.useEffort}`;
  }
  return `${conditions}${arrow}${uses.join(chalk.gray(", "))}`;
}

/** How a group routes, as its card says it: manual and picked included. */
function routingLine(group: Group): string {
  if (group.manual === true) {
    return `manual${chalk.gray(
      `  every request to ${group.pick ?? "its first model"}; neox group pick ${group.id} <model> picks another`,
    )}`;
  }
  if (group.pick === undefined) {
    return routingName(group);
  }
  return `${routingName(group)}${chalk.gray(`  every request to ${group.pick} first`)}`;
}

// eslint-disable-next-line complexity -- myna's one card, kept whole so its lines stay beside each other.
function showGroup(config: GatewayConfig, group: Group): void {
  const key = (name: string, value: string): void => {
    out(`  ${chalk.gray(name.padEnd(9))} ${value}`);
  };
  let head = `${chalk.bold(nameOf(group))}${chalk.gray(`  ${groupRef(group)}`)}`;
  if (group.auto === true) {
    head += chalk.gray("  found by Neox — changing it makes it yours");
  }
  if (isHidden(config, group.id)) {
    head += chalk.yellow("  removed") + chalk.gray(` · neox group restore ${group.id}`);
  }
  out(` ${head}`);
  key("routing", routingLine(group));
  key(
    "stays",
    `${group.affinity ?? "auto"}${
      group.affinity === undefined
        ? chalk.gray("  with the account or key that answered, while its cache is worth keeping")
        : ""
    }`,
  );
  if (group.patience !== undefined) {
    key("patience", patienceText(group.patience));
  }
  if (group.unlists === true) {
    key(
      "listed",
      `no${chalk.gray("  its models are offered through the group alone; listed=yes lists them too")}`,
    );
  }
  const weights = group.weights ?? {};
  group.members.forEach((member, at) => {
    let line = `${at + 1} ${typedMember(group, member)}`;
    if (group.pick === member) {
      line = chalk.green(`${at + 1} ${typedMember(group, member)} ●`);
    }
    const label = memberLabel(config, member);
    if (label !== null) {
      let extra = label;
      if ((group.fast ?? []).includes(member)) {
        extra += " · fast";
      }
      if (group.weighted === true) {
        extra += ` · weight ${weights[member] ?? 1}`;
      }
      line += chalk.gray(`  ${extra}`);
    } else {
      line = chalk.gray(line) + chalk.yellow(`  ${whyNotServed(config, member)} now, skipped`);
    }
    key(at === 0 ? "models" : "", line);
  });
  if (group.members.length === 0) {
    key("models", chalk.gray("none now"));
  }
  (group.match ?? []).forEach((pattern, at) => {
    const hits = patternHits(config, group, pattern);
    key(at === 0 ? "patterns" : "", patternCountLine(pattern, hits));
  });
  (group.rules ?? []).forEach((rule, at) => {
    key(at === 0 ? "rules" : "", `${at + 1} ${ruleLine(rule)}`);
  });
  if ((group.levels ?? []).length > 0) {
    key(
      "levels",
      `${(group.levels ?? []).join(", ")}${chalk.gray("  offered to agents; a model without the one asked is sent its nearest")}`,
    );
  }
  if (group.effort === "auto") {
    key("effort", `auto${chalk.gray("  the classifier picks each turn's reasoning")}`);
  }
  if (group.classifier !== undefined) {
    const intents = (group.rules ?? []).some((rule) => rule.intent !== undefined);
    key(
      "classifier",
      `${group.classifier}${chalk.gray(intents ? "  tells which intent a message is" : "  rates how hard each turn is")}`,
    );
  }
  const agents = usedBy.get(group.id) ?? [];
  if (agents.length > 0) {
    key("used by", chalk.green(agents.join(", ")));
  }
}

// ------------------------------------------------------------------ adding

function checkGroup(group: Group): void {
  if (group.id === "" || !/^[a-z][a-z0-9-]*$/.test(group.id)) {
    throw new Error(`a group's id must be lowercase letters, digits and dashes, not "${group.id}"`);
  }
  if (group.members.length === 0 && (group.match ?? []).length === 0) {
    throw new Error(
      "a group needs a model in it: models=<provider/model>[,…] (neox provider ls lists them), " +
        "or a pattern: models='openrouter/*:free'",
    );
  }
}

async function addGroup(name: string, pairs: readonly string[]): Promise<void> {
  const written = await withStore(async (store) => {
    const config = store.get();
    const group: Group = { id: "", members: [], strategy: "smart" };
    applyPairs(config, group, pairs, true);
    const named = name.trim();
    if (named === "") {
      throw new Error("neox group add <name> models=<m1>[,m2…] [routing=…]");
    }
    group.label = group.label ?? named;
    let verb = "added";
    if (group.id === "") {
      // a group is known by its name: adding one under a name taken
      // replaces that group (its id stays), rather than making name-2
      const same = [...config.groups, ...groupsOf(config)].find(
        (candidate) =>
          !isHidden(config, candidate.id) &&
          nameOf(candidate).toLowerCase() === named.toLowerCase(),
      );
      if (same !== undefined) {
        verb = "replaced";
        group.id = same.id;
      } else {
        group.id = freeGroupName(config, named).id;
      }
    } else if (findGroupOrNull(config, group.id) !== null) {
      throw new Error(
        `there is a group ${group.id} already: neox group set ${group.id} k=v… changes it`,
      );
    }
    checkGroup(group);
    const writtenConfig = await store.write(saveGroup(config, group));
    return { config: writtenConfig, id: group.id, verb };
  });
  const saved = findGroup(written.config, written.id);
  out(
    `${chalk.green("✓")} ${written.verb} ${chalk.bold(nameOf(saved.group))} ` +
      chalk.gray(`· agents pick it as ${groupRef(saved.group)}`),
  );
  showGroup(written.config, saved.group);
}

function findGroupOrNull(config: GatewayConfig, ref: string): FoundGroup | null {
  try {
    return findGroup(config, ref);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- commands

async function setGroup(ref: string, pairs: readonly string[]): Promise<void> {
  const written = await withStore(async (store) => {
    const config = store.get();
    const found = findGroup(config, ref);
    if (isHidden(config, found.group.id)) {
      throw new Error(
        `${found.group.id} was removed: neox group restore ${found.group.id} brings it back first`,
      );
    }
    const from = found.group.id;
    const group: Group = structuredClone(found.group);
    // one neolix found is the user's now; a stored group never carries auto
    delete group.auto;
    applyPairs(config, group, pairs, true);
    checkGroup(group);
    pruneRules(group);
    const to = group.id;
    if (to !== from) {
      if (!/^[a-z][a-z0-9-]*$/.test(to)) {
        throw new Error(`a group's id must be lowercase letters, digits and dashes, not "${to}"`);
      }
      if (findGroupOrNull(config, to) !== null) {
        throw new Error(`there is a group ${to} already: neox group set ${to} k=v… changes it`);
      }
    }
    group.id = to;
    let next =
      found.stored && to !== from
        ? { ...config, groups: config.groups.filter((candidate) => candidate.id !== from) }
        : config;
    next = saveGroup(next, group);
    if (to !== from) {
      // the groups that have it in them, and their rules, name it by the new id
      next = { ...next, groups: renameReferences(next.groups, from, to) };
    }
    if (found.stored && to !== from) {
      next = {
        ...next,
        groupOrder: (next.groupOrder ?? []).map((id) => (id === from ? to : id)),
      };
    }
    if (!found.stored && to !== from) {
      // the found group keeps its own id: hide it now that this one is the user's
      next = setHidden(next, from, true);
    }
    const saved = await store.write(next);
    return { config: saved, id: to, renamed: to !== from };
  });
  const saved = findGroup(written.config, written.id);
  out(`${chalk.green("✓")} saved ${chalk.bold(nameOf(saved.group))}`);
  if (pairs.some((pair) => pair.toLowerCase().startsWith("name="))) {
    out(
      chalk.gray(
        `  its id stays ${saved.group.id}: agents ask for ${groupRef(saved.group)} (a client given the name may ask by the name too)`,
      ),
    );
  }
  showGroup(written.config, saved.group);
}

async function pickGroup(ref: string, model: string): Promise<void> {
  const written = await withStore(async (store) => {
    const config = store.get();
    const found = findGroup(config, ref);
    if (isHidden(config, found.group.id)) {
      throw new Error(
        `${found.group.id} was removed: neox group restore ${found.group.id} brings it back first`,
      );
    }
    const group: Group = structuredClone(found.group);
    delete group.auto;
    group.pick = groupMember(group, model);
    group.manual = true;
    const next = saveGroup(config, group);
    const saved = await store.write(next);
    return { config: saved, id: group.id };
  });
  const saved = findGroup(written.config, written.id).group;
  out(
    `${chalk.green("✓")} ${chalk.bold(nameOf(saved))} sends every request to ` +
      `${chalk.bold(String(saved.pick))} ${chalk.gray("· routing manual")}`,
  );
  showGroup(written.config, saved);
}

async function copyGroup(ref: string, name: string): Promise<void> {
  const written = await withStore(async (store) => {
    const config = store.get();
    const found = findGroup(config, ref);
    if (isHidden(config, found.group.id)) {
      throw new Error(
        `${found.group.id} was removed: neox group restore ${found.group.id} brings it back first`,
      );
    }
    const source = structuredClone(found.group);
    delete source.auto;
    const named = name.trim() === "" ? `${nameOf(source)} copy` : name.trim();
    const free = freeGroupName(config, named);
    const group: Group = { ...source, id: free.id, label: free.name };
    delete group.disabled;
    let order = (config.groupOrder ?? []).filter(
      (id) => !config.groups.some((candidate) => candidate.id === id),
    );
    if (order.length === 0) {
      order = config.groups.map((candidate) => candidate.id);
    }
    const at = order.indexOf(source.id);
    order =
      at < 0 ? [...order, group.id] : [...order.slice(0, at + 1), group.id, ...order.slice(at + 1)];
    const saved = await store.write({
      ...saveGroup(config, group),
      groupOrder: order,
    });
    return { config: saved, id: group.id, source: nameOf(source), name: nameOf(group) };
  });
  const saved = findGroup(written.config, written.id).group;
  out(
    `${chalk.green("✓")} copied ${chalk.bold(written.source)} to ${chalk.bold(written.name)} ` +
      chalk.gray(`· agents pick it as ${groupRef(saved)}`),
  );
  showGroup(written.config, saved);
}

async function removeGroups(refs: readonly string[]): Promise<void> {
  if (refs.length === 0) {
    throw new Error("neox group rm <id>…");
  }
  const lines = await withStore(async (store) => {
    const config = store.get();
    const removals: Array<{ group: Group; found: boolean }> = [];
    for (const ref of refs) {
      const found = findGroup(config, ref);
      if (isHidden(config, found.group.id)) {
        throw new Error(
          `${found.group.id} is removed already; neox group restore ${found.group.id} brings it back`,
        );
      }
      removals.push({ group: found.group, found: !found.stored || found.group.auto === true });
    }
    let next = config;
    for (const removal of removals) {
      if (removal.found) {
        next = setHidden(next, removal.group.id, true);
      } else {
        next = removeStored(next, removal.group.id);
        next = {
          ...next,
          groupOrder: (next.groupOrder ?? []).filter((id) => id !== removal.group.id),
        };
      }
    }
    await store.write(next);
    return removals.map((removal) =>
      removal.found
        ? `${chalk.green("✓")} removed ${chalk.bold(nameOf(removal.group))} ` +
          chalk.gray(
            `· Neox found it, so it's hidden: neox group restore ${removal.group.id} brings it back`,
          )
        : `${chalk.green("✓")} removed ${chalk.bold(nameOf(removal.group))}`,
    );
  });
  for (const line of lines) {
    out(line);
  }
}

async function restoreGroup(ref: string): Promise<void> {
  const written = await withStore(async (store) => {
    const config = store.get();
    const wanted = ref
      .trim()
      .replace(/^neolix\//, "")
      .replace(/^group\//, "");
    if (!isHidden(config, wanted)) {
      const found = findGroup(config, wanted);
      throw new Error(`${found.group.id} isn't removed`);
    }
    const next = setHidden(config, wanted, false);
    const saved = await store.write(next);
    return { config: saved, id: wanted };
  });
  const found = findGroupOrNull(written.config, written.id);
  if (found === null || found.group.members.length === 0) {
    out(
      `${chalk.green("✓")} ${chalk.bold(written.id)} is no longer removed ` +
        chalk.gray("· it shows once two providers serve its model"),
    );
    return;
  }
  out(`${chalk.green("✓")} ${chalk.bold(nameOf(found.group))} is back`);
  showGroup(written.config, found.group);
}

async function autoGroups(args: readonly string[]): Promise<void> {
  if (args.length === 0) {
    const on = (await withStore(async (store) => store.get())).autoGroups !== false;
    out(
      on
        ? `found groups are ${chalk.green("on")} ${chalk.gray("· a model two or more providers serve is a group of them (auto-<model>); neox group auto off turns them off")}`
        : `found groups are ${chalk.yellow("off")} ${chalk.gray("· only the groups you made or changed; neox group auto on brings the others back")}`,
    );
    const skip = await withStore(async (store) => store.get().autoGroupSkip ?? []);
    if (skip.length > 0) {
      out(
        `left out: ${skip.join(", ")} ${chalk.gray("· neox group auto skip none lets them back in")}`,
      );
    }
    return;
  }
  if (args[0] === "skip") {
    await autoGroupSkip(args.slice(1));
    return;
  }
  const text = args[0]!.toLowerCase();
  let on: boolean;
  if (["on", "true", "yes", "1"].includes(text)) {
    on = true;
  } else if (["off", "false", "no", "0"].includes(text)) {
    on = false;
  } else {
    throw new Error("neox group auto [on|off|skip <provider>…|skip none]");
  }
  if (args.length > 1) {
    throw new Error("neox group auto [on|off]");
  }
  const change = await withStore(async (store) => {
    const config = store.get();
    const before = foundGroups(config);
    const written = await store.write({ ...config, autoGroups: on });
    return { before, after: foundGroups(written) };
  });
  const moved = await reseat(change.before, change.after);
  out(
    on
      ? `${chalk.green("✓")} found groups are on ${chalk.gray("· a model two or more providers serve is a group of them again")}`
      : `${chalk.green("✓")} found groups are off ${chalk.gray("· the groups you made or changed stay; a request for an auto- group goes to its model from one provider")}`,
  );
  for (const line of moved) {
    out(`${chalk.green("✓")} ${line}`);
  }
}

/** Moves the agents off the found groups a change takes away (myna's Reseat). */
async function reseat(before: readonly Group[], after: readonly Group[]): Promise<string[]> {
  if (agentSnapshot === null) {
    return [];
  }
  return applyReseat(reseatPlan(before, after, agentSnapshot));
}

async function autoGroupSkip(args: readonly string[]): Promise<void> {
  if (args.length === 0) {
    const skip = await withStore(async (store) => store.get().autoGroupSkip ?? []);
    out(
      skip.length === 0
        ? `no provider is left out of found groups ${chalk.gray("· neox group auto skip <provider>… leaves them out")}`
        : `left out of found groups: ${skip.join(", ")}`,
    );
    return;
  }
  let ids: string[] = [];
  if (!(args.length === 1 && args[0]!.toLowerCase() === "none")) {
    ids = await withStore(async (store) => {
      const config = store.get();
      const have = new Set(config.providers.map((provider) => provider.id));
      return args.map((value) => {
        const id = value.trim().toLowerCase();
        if (!have.has(id)) {
          throw new Error(`no provider "${value}" (neox provider ls lists their ids)`);
        }
        return id;
      });
    });
  }
  const change = await withStore(async (store) => {
    const config = store.get();
    const before = foundGroups(config);
    const written = await store.write({ ...config, autoGroupSkip: ids });
    return { before, after: foundGroups(written) };
  });
  const moved = await reseat(change.before, change.after);
  out(
    ids.length === 0
      ? `${chalk.green("✓")} no provider is left out of found groups`
      : `${chalk.green("✓")} left out of found groups: ${ids.join(", ")} ${chalk.gray("· the groups you made or changed keep them")}`,
  );
  for (const line of moved) {
    out(`${chalk.green("✓")} ${line}`);
  }
}

// -------------------------------------------------------------------- rules

interface ParsedRule {
  rule: Rule;
  at?: number;
  classifier?: string;
}

function parseDays(value: string): string[] {
  const days: string[] = [];
  for (const part of value.split(/[,\s]+/).filter((item) => item !== "")) {
    const [from, to] = part.replace(/–/g, "-").split("-");
    const start = WEEKDAYS.indexOf((from ?? "").toLowerCase());
    if (start < 0) {
      throw new Error(`days: "${from}" is not a day of the week (mon … sun)`);
    }
    const end = to === undefined ? start : WEEKDAYS.indexOf(to.toLowerCase());
    if (end < 0) {
      throw new Error(`days: "${to}" is not a day of the week (mon … sun)`);
    }
    for (let at = start; ; at = (at + 1) % 7) {
      if (!days.includes(WEEKDAYS[at]!)) {
        days.push(WEEKDAYS[at]!);
      }
      if (at === end) {
        break;
      }
    }
  }
  if (days.length === 0) {
    throw new Error("days names the days of the week it holds on: days=mon-fri");
  }
  return days;
}

function validZone(zone: string): boolean {
  try {
    Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function parseTimeWindow(value: string): NonNullable<Rule["time"]> {
  const [hours, zone] = value.split("@");
  const [from, to] = (hours ?? "").replace(/–/g, "-").split("-");
  const clock = /^(\d{1,2}):(\d{2})$/;
  const fromMatch = clock.exec((from ?? "").trim());
  const toMatch = clock.exec((to ?? "").trim());
  if (fromMatch === null || toMatch === null) {
    throw new Error(
      `time is hours of the day: time=09:00-18:00 (or 22:00-08:00, past midnight; ` +
        `09:00-18:00@Asia/Shanghai in a time zone), not "${value}"`,
    );
  }
  for (const match of [fromMatch, toMatch]) {
    if (Number(match[1]) > 23 || Number(match[2]) > 59) {
      throw new Error(`time: "${match[0]}" is not a time of the day`);
    }
  }
  const window: NonNullable<Rule["time"]> = {
    from: fromMatch[0].padStart(5, "0"),
    to: toMatch[0].padStart(5, "0"),
  };
  if (zone !== undefined && zone.trim() !== "") {
    const name = zone.trim();
    if (!validZone(name)) {
      throw new Error(
        `tz: "${name}" is not a time zone Neox knows: an IANA name such as Asia/Shanghai, Europe/Berlin or America/New_York`,
      );
    }
    window.zone = name;
  }
  return window;
}

// eslint-disable-next-line complexity -- myna's one word table, kept whole so its wording stays beside it.
function parseRule(group: Group, words: readonly string[]): ParsedRule {
  const rule: Rule = { use: "" };
  let at: number | undefined;
  let classifier: string | undefined;
  let zone: string | undefined;
  const splitList = (value: string): string[] =>
    value
      .split(/[,\s]+/)
      .map((part) => part.trim())
      .filter((part) => part !== "");
  for (const word of words) {
    const eq = word.indexOf("=");
    const field = (eq < 0 ? word : word.slice(0, eq)).toLowerCase().trim();
    const value = eq < 0 ? "" : word.slice(eq + 1);
    switch (field) {
      case "use":
      case "model":
      case "to": {
        const uses: string[] = [];
        for (const part of value
          .split(",")
          .map((item) => item.trim())
          .filter((item) => item !== "")) {
          const member = groupMember(group, part);
          if (!uses.includes(member)) {
            uses.push(member);
          }
        }
        if (uses.length === 0) {
          throw new Error("use=<model> names the model it sends to, or several in order: use=a,b");
        }
        rule.use = uses[0]!;
        rule.more = uses.length > 1 ? uses.slice(1) : undefined;
        break;
      }
      case "pause":
      case "skip":
        rule.use = groupMember(group, value);
        rule.more = undefined;
        rule.pause = true;
        break;
      case "tokens":
      case "context":
      case "longer":
        rule.tokens = parseTokens(value);
        break;
      case "images":
      case "image":
        if (value === "" || ["yes", "true", "on", "1"].includes(value.toLowerCase())) {
          rule.images = true;
        } else if (["no", "false", "off", "0"].includes(value.toLowerCase())) {
          rule.images = false;
        } else {
          throw new Error(`images takes no value (or yes/no), not "${value}"`);
        }
        break;
      case "compact":
      case "compacting":
      case "compaction":
        if (value === "" || ["yes", "true", "on", "1"].includes(value.toLowerCase())) {
          rule.compact = true;
        } else if (["no", "false", "off", "0"].includes(value.toLowerCase())) {
          rule.compact = false;
        } else {
          throw new Error(`compact takes no value (or yes/no), not "${value}"`);
        }
        break;
      case "effort":
      case "reasoning":
      case "thinking":
        rule.effort = eq < 0 ? "on" : value.trim().toLowerCase();
        break;
      case "use-effort":
      case "useeffort":
      case "set-effort":
      case "seteffort": {
        const effort = value.trim().toLowerCase();
        if (!(EFFORTS as readonly string[]).includes(effort)) {
          throw new Error(
            `use-effort is the reasoning the rule's model is asked for: one of ${EFFORTS.join(", ")}, not "${value}"`,
          );
        }
        rule.useEffort = effort as Effort;
        break;
      }
      case "agents":
      case "agent":
        rule.agents = splitList(value).map((agent) => agent.toLowerCase());
        break;
      case "intent":
      case "asks":
      case "about":
        rule.intent = value.trim();
        if (rule.intent === "") {
          throw new Error(
            'intent says what the message asks for: intent="writing or fixing tests"',
          );
        }
        break;
      case "time":
      case "hours":
      case "between": {
        const window = parseTimeWindow(value);
        if (window.zone !== undefined) {
          zone = window.zone;
        }
        if (rule.time !== undefined) {
          window.days = rule.time.days;
        }
        rule.time = window;
        break;
      }
      case "tz":
      case "zone":
      case "timezone":
      case "time-zone": {
        const name = value.trim();
        if (name === "" || !validZone(name)) {
          throw new Error(
            `tz: "${value}" is not a time zone Neox knows: an IANA name such as Asia/Shanghai, Europe/Berlin or America/New_York`,
          );
        }
        zone = name;
        break;
      }
      case "days":
      case "day": {
        const days = parseDays(value);
        rule.time = rule.time ?? { from: "00:00", to: "00:00" };
        rule.time.days = days;
        break;
      }
      case "folders":
      case "folder":
      case "in":
      case "project":
      case "projects": {
        const folders = splitList(value);
        if (folders.length === 0) {
          throw new Error(
            "folders names the working folders it holds in: folders=~/work/acme,~/oss",
          );
        }
        rule.folders = [...(rule.folders ?? []), ...folders];
        break;
      }
      case "except-folders":
      case "except-folder":
      case "exceptfolders":
      case "not-in":
      case "outside": {
        const folders = splitList(value);
        if (folders.length === 0) {
          throw new Error(
            "except-folders names the working folders it doesn't hold in: except-folders=~/big-task",
          );
        }
        rule.exceptFolders = [...(rule.exceptFolders ?? []), ...folders];
        break;
      }
      case "classifier":
      case "classify":
      case "by":
        classifier = value.trim().replace(/^neolix\//, "");
        if (classifier === "") {
          throw new Error("classifier=<model>: the model that tells which intent a message is");
        }
        break;
      case "at": {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1) {
          throw new Error(`at is a place from 1, not "${value}"`);
        }
        at = n;
        break;
      }
      default:
        throw new Error(
          `unknown "${word}" (use, use-effort, pause, tokens, images, effort, agents, intent, ` +
            `compact, time, days, tz, folders, except-folders, classifier, at)\n\n${ruleUsage}`,
        );
    }
  }
  if (zone !== undefined) {
    if (rule.time === undefined) {
      throw new Error("tz= is the time zone of time= or days=: give one of them too");
    }
    rule.time.zone = zone;
  }
  if (rule.use === "") {
    throw new Error(
      `use=<model> (or pause=<model>) is missing: one of ${group.members.join(", ")}`,
    );
  }
  if (rule.pause === true) {
    if ((rule.more ?? []).length > 0) {
      throw new Error("pause=<model> names one model: give each its own rule");
    }
    if (rule.useEffort !== undefined) {
      throw new Error("pause=<model> sends nothing, so it takes no use-effort=");
    }
    if (
      rule.tokens !== undefined ||
      rule.images === true ||
      (rule.effort !== undefined && rule.effort !== "") ||
      rule.intent !== undefined ||
      rule.compact === true
    ) {
      throw new Error(
        "pause=<model> holds by time=, days=, agents=, folders= or except-folders= only",
      );
    }
    if (
      rule.time === undefined &&
      (rule.agents ?? []).length === 0 &&
      (rule.folders ?? []).length === 0 &&
      (rule.exceptFolders ?? []).length === 0
    ) {
      throw new Error(
        "pause=<model> needs time=, days=, agents=, folders= or except-folders=: when the model is left out",
      );
    }
  }
  if (rule.intent !== undefined && classifier === undefined && group.classifier === undefined) {
    throw new Error(
      "a rule with an intent needs the group's classifier, the model that tells which intent " +
        "a message is: add classifier=<model>, best a small fast one",
    );
  }
  return {
    rule,
    ...(at === undefined ? {} : { at }),
    ...(classifier === undefined ? {} : { classifier }),
  };
}

async function ruleCommand(args: readonly string[]): Promise<void> {
  if (args.length === 0 || ["help", "-h", "--help"].includes(args[0]!)) {
    out(ruleUsage);
    return;
  }
  const verb = args[0]!;
  const rest = args.slice(1);
  if (rest.length === 0) {
    const found = findGroupOrNull(await withStore(async (store) => store.get()), verb);
    if (found !== null) {
      if ((found.group.rules ?? []).length === 0) {
        out(
          chalk.gray(
            `  ${found.group.id} has no rules · neox group rule add ${found.group.id} use=<model> …`,
          ),
        );
        return;
      }
      const config = await withStore(async (store) => store.get());
      showGroup(config, findGroup(config, verb).group);
      return;
    }
    throw new Error(ruleUsage);
  }
  const ref = rest[0]!;
  const written = await withStore(async (store) => {
    const config = store.get();
    const found = findGroup(config, ref);
    if (isHidden(config, found.group.id)) {
      throw new Error(
        `${found.group.id} was removed: neox group restore ${found.group.id} brings it back first`,
      );
    }
    const group: Group = structuredClone(found.group);
    delete group.auto;
    const place = (value: string): number => {
      const n = Number(value);
      const rules = group.rules ?? [];
      if (!Number.isInteger(n) || n < 1 || n > rules.length) {
        if (rules.length === 0) {
          throw new Error(`${group.id} has no rules`);
        }
        throw new Error(`rule ${value}: ${group.id} has rules 1 to ${rules.length}`);
      }
      return n - 1;
    };
    if (verb === "add" || verb === "new") {
      const parsed = parseRule(group, rest.slice(1));
      if (parsed.classifier !== undefined) {
        group.classifier = parsed.classifier;
      }
      const rules = group.rules ?? [];
      const at = parsed.at === undefined ? rules.length : parsed.at - 1;
      group.rules = [
        ...rules.slice(0, at),
        parsed.rule,
        ...rules.slice(Math.min(at, rules.length)),
      ];
    } else if (["rm", "remove", "delete"].includes(verb)) {
      if (rest.length !== 2) {
        throw new Error("neox group rule rm <group> <n>");
      }
      const at = place(rest[1]!);
      group.rules = (group.rules ?? []).filter((_rule, index) => index !== at);
    } else if (["mv", "move"].includes(verb)) {
      if (rest.length !== 3) {
        throw new Error("neox group rule mv <group> <n> <to>");
      }
      const from = place(rest[1]!);
      const to = place(rest[2]!);
      const rules = [...(group.rules ?? [])];
      const [rule] = rules.splice(from, 1);
      rules.splice(to, 0, rule!);
      group.rules = rules;
    } else if (["classifier", "classify"].includes(verb)) {
      if (rest.length !== 2) {
        throw new Error("neox group rule classifier <group> <model>");
      }
      if (!(group.rules ?? []).some((rule) => rule.intent !== undefined)) {
        throw new Error(`${group.id} has no rule with an intent to classify for`);
      }
      group.classifier = rest[1]!;
    } else {
      throw new Error(`neox group rule has no "${verb}"\n\n${ruleUsage}`);
    }
    const saved = await store.write(saveGroup(config, group));
    return { config: saved, id: group.id };
  });
  const saved = findGroup(written.config, written.id).group;
  out(`${chalk.green("✓")} saved ${chalk.bold(nameOf(saved))}`);
  showGroup(written.config, saved);
}

// ---------------------------------------------------------------- templates

const TEMPLATE_KINDS = ["smart", "thrifty", "steady"] as const;
type TemplateKind = (typeof TEMPLATE_KINDS)[number];

const TEMPLATE_NAMES: Record<TemplateKind, string> = {
  smart: "Hard to strong, easy to cheap",
  thrifty: "Cheap first",
  steady: "Never stuck",
};

const TEMPLATE_IDS: Record<TemplateKind, string> = {
  smart: "smart-split",
  thrifty: "cheap-first",
  steady: "never-stuck",
};

const INTENT_HARD = "a hard task: designing, debugging, a change across several files, or planning";
const INTENT_EASY = "an easy task: a quick question, a small edit, a lookup, or running a command";

const NON_CHAT =
  /embed|rerank|image|imagen|dall-e|tts|whisper|audio|realtime|transcribe|moderation|ocr|veo|sora|speech|research|guard|computer-use/;

const SMALL_WORDS = new Set([
  "mini",
  "nano",
  "flash",
  "haiku",
  "lite",
  "small",
  "air",
  "turbo",
  "fast",
  "instant",
  "tiny",
  "highspeed",
]);
const TINY_WORDS = new Set(["nano", "lite", "tiny"]);

interface Rated {
  entry: ServedModel;
  out: number;
  maker: boolean;
  small: boolean;
  tiny: boolean;
}

function sizeOf(model: string): { small: boolean; tiny: boolean } {
  let small = false;
  let tiny = false;
  for (const word of model.toLowerCase().split(/[^a-z0-9.]+/)) {
    const size = /^(\d+(?:\.\d+)?)b$/.exec(word);
    if (size !== null) {
      const billions = Number(size[1]);
      small = small || billions <= 72;
      tiny = tiny || billions <= 15;
      continue;
    }
    small = small || SMALL_WORDS.has(word);
    tiny = tiny || TINY_WORDS.has(word);
  }
  return { small, tiny };
}

function priceOut(config: GatewayConfig, id: string): number {
  const pricing = config.pricing ?? {};
  const slash = id.indexOf("/");
  const provider = id.slice(0, slash);
  const model = id.slice(slash + 1);
  const price = pricing[id] ?? pricing[`${provider}/*`] ?? pricing[`*/${model}`] ?? undefined;
  return price?.outputPerMTok ?? 0;
}

const VENDOR_PRESETS = GATEWAY_PROVIDER_PRESETS.filter((preset) => preset.kind === "vendor");

/**
 * Whether a model's maker is one of the vendors the presets know (myna's
 * MakerPrice): its provider is that vendor, or its id names one.
 */
function presetMaker(entry: ServedModel): boolean {
  const providerId = entry.provider.id.toLowerCase();
  const model = entry.model.id.toLowerCase();
  return VENDOR_PRESETS.some((preset) => {
    const names = [preset.id, preset.name, preset.fullName ?? ""]
      .map((name) => name.toLowerCase())
      .filter((name) => name.length > 2);
    return names.some((name) => name === providerId || model.includes(name));
  });
}

function templateModels(config: GatewayConfig): Rated[] {
  return servedOf(config)
    .filter((entry) => !NON_CHAT.test(entry.model.id.toLowerCase()))
    .map((entry) => {
      const output = priceOut(config, entry.id);
      const { small, tiny } = sizeOf(entry.model.id);
      return { entry, out: output, maker: presetMaker(entry), small, tiny };
    });
}

function strongest(models: Rated[]): Rated[] {
  return models
    .filter((model) => model.out <= 100)
    .sort(
      (left, right) =>
        Number(right.maker) - Number(left.maker) ||
        Number(right.out >= 10) - Number(left.out >= 10) ||
        Number(left.small) - Number(right.small) ||
        (right.entry.model.released ?? "").localeCompare(left.entry.model.released ?? "") ||
        right.out - left.out,
    );
}

function cheapest(models: Rated[], strong: Rated): Rated[] {
  return models
    .filter((model) => {
      if (model.entry.id === strong.entry.id) {
        return false;
      }
      if (strong.out > 0 && model.out > 0) {
        return model.out <= strong.out / 4;
      }
      return model.small && !strong.small;
    })
    .sort(
      (left, right) =>
        Number(right.maker) - Number(left.maker) ||
        Number(left.tiny) - Number(right.tiny) ||
        (right.entry.model.released ?? "").localeCompare(left.entry.model.released ?? "") ||
        right.out - left.out,
    );
}

interface TemplateGroup {
  kind: TemplateKind;
  name: string;
  id: string;
  group: Group;
  why?: string;
}

function templateOf(config: GatewayConfig, kind: TemplateKind): TemplateGroup {
  const models = templateModels(config);
  const template: TemplateGroup = {
    kind,
    name: TEMPLATE_NAMES[kind],
    id: TEMPLATE_IDS[kind],
    group: { id: TEMPLATE_IDS[kind], members: [], strategy: "order" },
  };
  const strong = strongest(models);
  if (strong.length === 0) {
    return { ...template, why: "no model to make it of: add a provider first" };
  }
  const best = strong[0]!;
  if (kind === "steady") {
    const seen = new Set<string>();
    for (const model of strong) {
      if (template.group.members.length === 3) {
        break;
      }
      if (!seen.has(model.entry.provider.id)) {
        seen.add(model.entry.provider.id);
        template.group.members.push(model.entry.id);
      }
    }
    if (template.group.members.length < 2) {
      return {
        ...template,
        group: { ...template.group, members: [] },
        why: `it needs models from two providers: ${providerName(best.entry.provider)} is the only one`,
      };
    }
    return template;
  }
  const cheap = cheapest(models, best);
  if (cheap.length === 0) {
    return {
      ...template,
      why: `no model cheap beside ${modelName(best.entry.model)} to send the easy turns to`,
    };
  }
  const low = cheap[0]!;
  const images = best.entry.model.images === true && low.entry.model.images !== true;
  if (kind === "smart") {
    const rules: Rule[] = [{ use: low.entry.id, compact: true }];
    if (images) {
      rules.push({ use: best.entry.id, images: true });
    }
    rules.push({ use: best.entry.id, intent: INTENT_HARD });
    rules.push({ use: low.entry.id, intent: INTENT_EASY });
    const classifier =
      models
        .filter((model) => model.out > 0 && !model.tiny && model.out <= low.out)
        .sort((left, right) => left.out - right.out)[0]?.entry.id ?? low.entry.id;
    template.group = {
      ...template.group,
      members: [best.entry.id, low.entry.id],
      rules,
      classifier,
    };
    return template;
  }
  const members = [low.entry.id];
  const other = (model: Rated): boolean => model.entry.provider.id !== low.entry.provider.id;
  const bare = (model: string): string => model.slice(model.lastIndexOf("/") + 1).toLowerCase();
  const second =
    cheap.find(
      (model) => other(model) && bare(model.entry.model.id) !== bare(low.entry.model.id),
    ) ?? cheap.find(other);
  if (second !== undefined) {
    members.push(second.entry.id);
  }
  members.push(best.entry.id);
  const rules: Rule[] = [{ use: best.entry.id, effort: "high" }];
  if (images) {
    rules.push({ use: best.entry.id, images: true });
  }
  template.group = { ...template.group, members, rules };
  return template;
}

async function templateCommand(rest: readonly string[]): Promise<void> {
  const config = await withStore(async (store) => store.get());
  if (rest.length === 0) {
    for (const kind of TEMPLATE_KINDS) {
      const template = templateOf(config, kind);
      out(`${chalk.bold(kind)} ${chalk.gray(`· ${TEMPLATE_NAMES[kind]}`)}`);
      if (template.why !== undefined) {
        out(`  ${chalk.gray(`can't be made: ${template.why}`)}`);
        continue;
      }
      out(`  ${template.group.members.join(" → ")}`);
      if (template.group.classifier !== undefined) {
        out(`  ${chalk.gray(`classifier ${template.group.classifier}`)}`);
      }
    }
    out(chalk.gray("neox group template <kind> [name] adds one"));
    return;
  }
  const wanted = rest[0]!.toLowerCase();
  const kind = TEMPLATE_KINDS.find((candidate) => candidate === wanted);
  if (kind === undefined) {
    throw new Error(`no template "${rest[0]}" (one of ${TEMPLATE_KINDS.join(", ")})`);
  }
  const written = await withStore(async (store) => {
    const current = store.get();
    const template = templateOf(current, kind);
    if (template.why !== undefined) {
      throw new Error(template.why);
    }
    const name = rest.slice(1).join(" ").trim() || template.name;
    const free = freeGroupName(current, name, template.id);
    const group: Group = {
      ...structuredClone(template.group),
      id: free.id,
      label: free.name,
    };
    const saved = await store.write(saveGroup(current, group));
    return { config: saved, id: group.id };
  });
  const saved = findGroup(written.config, written.id).group;
  out(
    `${chalk.green("✓")} added ${chalk.bold(nameOf(saved))} ` +
      chalk.gray(`· agents pick it as ${groupRef(saved)}`),
  );
  showGroup(written.config, saved);
}

// -------------------------------------------------------------------- entry

// eslint-disable-next-line complexity -- one branch per verb myna's group takes.
async function groupCommand(args: readonly string[]): Promise<void> {
  if (args.length === 0) {
    out(groupUsage);
    return;
  }
  const verb = args[0]!;
  const rest = args.slice(1);
  if (["-h", "--help", "help"].includes(verb)) {
    out(groupUsage);
    return;
  }
  // the agents connected here, for "used by" and for a found group going
  if (!["rm", "remove", "delete"].includes(verb)) {
    agentSnapshot = await connectedAgents();
    usedBy = agentSnapshot === null ? new Map() : agentUses(agentSnapshot);
  } else {
    agentSnapshot = null;
    usedBy = new Map();
  }
  switch (verb) {
    case "add":
    case "new":
      if (rest.length === 0 || rest[0]!.includes("=")) {
        throw new Error(`neox group add <name> models=<m1>[,m2…] [routing=…]\n\n${groupUsage}`);
      }
      await addGroup(rest[0]!, rest.slice(1));
      return;
    case "set":
    case "edit":
      if (rest.length < 2) {
        throw new Error(`neox group set <id> k=v…\n\n${groupUsage}`);
      }
      await setGroup(rest[0]!, rest.slice(1));
      return;
    case "rm":
    case "remove":
    case "delete":
      await removeGroups(rest);
      return;
    case "pick":
    case "use":
      if (rest.length !== 2) {
        throw new Error("neox group pick <id> <model>");
      }
      await pickGroup(rest[0]!, rest[1]!);
      return;
    case "copy":
    case "duplicate":
    case "dup":
    case "clone":
      if (rest.length < 1) {
        throw new Error("neox group copy <id> [name]");
      }
      await copyGroup(rest[0]!, rest.slice(1).join(" "));
      return;
    case "template":
    case "templates":
    case "tpl":
      await templateCommand(rest);
      return;
    case "rule":
    case "rules":
      await ruleCommand(rest);
      return;
    case "show":
      if (rest.length !== 1) {
        throw new Error("neox group show <id>");
      }
      {
        const config = await withStore(async (store) => store.get());
        showGroup(config, findGroup(config, rest[0]!).group);
      }
      return;
    case "auto":
    case "found":
      await autoGroups(rest);
      return;
    case "restore":
    case "unhide":
      if (rest.length !== 1) {
        throw new Error("neox group restore <id>");
      }
      await restoreGroup(rest[0]!);
      return;
    default:
      if (rest.length > 0) {
        throw new Error(`neox group has no "${verb}"\n\n${groupUsage}`);
      }
      {
        const config = await withStore(async (store) => store.get());
        showGroup(config, findGroup(config, verb).group);
      }
  }
}

/** myna's `groups` (groups_cli.go:1045): every routing group on one line. */
async function listGroups(): Promise<void> {
  const config = await withStore(async (store) => store.get());
  agentSnapshot = await connectedAgents();
  usedBy = agentSnapshot === null ? new Map() : agentUses(agentSnapshot);
  const shown = groupsOf(config);
  if (shown.length === 0) {
    out(
      `${chalk.gray("no routing groups yet ·")} neox group add <name> models=<m1>,<m2> ${chalk.gray("· neox group help")}`,
    );
  }
  for (const group of shown) {
    const members: string[] = [];
    for (const member of group.members) {
      const label = memberLabel(config, member);
      const typed = typedMember(group, member);
      members.push(
        label === null ? chalk.gray(`${typed} (${whyNotServed(config, member)})`) : typed,
      );
    }
    for (const pattern of group.match ?? []) {
      members.push(patternCountLine(pattern, patternHits(config, group, pattern)));
    }
    const separator =
      group.strategy === "order" || group.strategy === "drain"
        ? chalk.gray(" → ")
        : chalk.gray(" · ");
    const rules = group.rules?.length
      ? chalk.gray(` · ${group.rules.length} rule${group.rules.length === 1 ? "" : "s"}`)
      : "";
    const stays = group.affinity === undefined ? "" : chalk.gray(` · stays ${group.affinity}`);
    const users = usedBy.get(group.id) ?? [];
    out(
      `  ${chalk.bold(nameOf(group))}${group.auto === true ? chalk.dim(" found") : ""}  ` +
        `${chalk.gray(groupRef(group))}  ${routingName(group)}${stays}${rules}  ` +
        `${members.join(separator)}${users.length > 0 ? chalk.green(`  ← ${users.join(", ")}`) : ""}`,
    );
  }
  if (config.autoGroups === false) {
    out(chalk.gray("  found groups are off · neox group auto on brings them back"));
  }
  const removed = config.hiddenGroups ?? [];
  if (removed.length > 0) {
    out("");
    out(chalk.gray(`  removed: ${removed.join(", ")} · neox group restore <id> brings one back`));
  }
}

export function createGroupsCommand(): Command {
  return new Command("groups")
    .description("Routing groups: the ones you made, then the ones Neox found")
    .argument("[args...]")
    .allowUnknownOption(true)
    .helpOption(false)
    .action(async () => {
      await listGroups();
    });
}

export function createGroupCommand(): Command {
  return new Command("group")
    .description("Routing groups: several models agents pick as one, group/<id>")
    .argument("[args...]")
    .allowUnknownOption(true)
    .helpOption(false)
    .action(async (args: string[] | undefined) => {
      await groupCommand(args ?? []);
    });
}
