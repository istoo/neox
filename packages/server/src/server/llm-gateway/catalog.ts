import { effectiveProviderModels } from "./antigravity-pool.js";
import {
  isProviderEnabled,
  type GatewayConfig,
  type GatewayGroup,
  type GatewayModel,
  type GatewayProvider,
} from "./config.js";
import { factoryModel } from "./factory-accounts.js";
import { groupByRequest, groupsOf } from "./groups-auto.js";
import { disabledPattern, listedModelId, servedModelId, upstreamModelName } from "./model-prefs.js";

const GROUP_PREFIX = "group/";

/** The reasoning levels a group's rule or member pin may ask for. */
export const GATEWAY_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type GatewayEffort = (typeof GATEWAY_EFFORTS)[number];

export interface GatewayMemberRef {
  /** The member as the group spells it. */
  member: string;
  /** The member without its `:effort` suffix. */
  id: string;
  effort: GatewayEffort | null;
}

/**
 * Splits `provider/model:high` into the model and the reasoning a group pins
 * it to. A colon that isn't one of the known levels belongs to the model id.
 */
export function parseMemberRef(member: string): GatewayMemberRef {
  const colon = member.lastIndexOf(":");
  if (colon > 0) {
    const suffix = member.slice(colon + 1);
    if ((GATEWAY_EFFORTS as readonly string[]).includes(suffix)) {
      return { member, id: member.slice(0, colon), effort: suffix as GatewayEffort };
    }
  }
  return { member, id: member, effort: null };
}

/** A model as a candidate carries it: its own id, and the wire name. */
export interface CandidateModel extends GatewayModel {
  /** The name the vendor is asked for, when the user set one (myna's Wires). */
  upstreamName?: string;
}

export interface GatewayCandidate {
  provider: GatewayProvider;
  model: CandidateModel;
  /** The reasoning the group pins this member to, when it is pinned. */
  effort?: GatewayEffort;
  /** The reasoning a matching group rule asks for this member. */
  ruleEffort?: GatewayEffort;
  /** Sent in its vendor's fast mode, as the group's `fast` names it. */
  fast?: boolean;
}

export interface GatewayModelEntry {
  id: string;
  object: "model";
  owned_by: string;
  display_name: string;
  /** The family tag its models go by in what agents are shown (myna's Entry.Family). */
  family?: string;
  context_window?: number;
  max_output_tokens?: number;
  /** What the model makes, and whether it takes images. */
  kind?: "chat" | "image" | "video";
  images?: boolean;
}

/**
 * A model's family is its id with version numbers, snapshots and previews
 * taken out: `claude-opus-4-8` and `claude-opus-5-5` are both
 * `claude-opus`, `o4-mini` is `o-mini`. Nothing about a vendor is compiled
 * in; everything is read off the id. Ported from myna's `catalog.FamilyOf`.
 */
export interface ModelFamily {
  /** The id without its version, snapshot or preview. */
  name: string;
  /** Every version number, in the order the id has them. */
  version: number[];
  /** Its dates or revision; empty for an alias. */
  snapshot: string;
  preview: boolean;
}

const FAMILY_SEP = /[-_/:@[\]\s]+/g;
/** A number: 4, 4.5, 2.0. */
const FAMILY_NUM = /^\d+(?:\.\d+)*$/;
/** A word that ends in its version: qwen3, qwen2.5, o4, k2, v1, llama3.1. */
const FAMILY_TAIL = /^([a-z][a-z.]*?[a-z])(\d+(?:\.\d+)*)$|^([a-z])(\d+(?:\.\d+)*)$/;
/** A word that starts with its version: 4o, 4.5v, 3n. */
const FAMILY_HEAD = /^(\d+(?:\.\d+)*)([a-z]+)$/;
/** A size, kept in the name: 8b, 1.5b, 70b, 128e, 32k, 8x7b, a22b, e4b. */
const FAMILY_SIZE = /^(?:[a-z]?\d+(?:\.\d+)?|\d+x\d+(?:\.\d+)?)[bmkte]$/;
const FAMILY_YEAR = /^(?:19|20)\d\d$/;
const FAMILY_PREVIEW = new Set(["preview", "exp", "experimental", "beta", "alpha"]);

function splitFamilyWords(text: string): { words: string[]; seps: string[] } {
  const words: string[] = [];
  const seps: string[] = [];
  let cursor = 0;
  for (const match of text.matchAll(FAMILY_SEP)) {
    words.push(text.slice(cursor, match.index));
    seps.push(match[0]);
    cursor = match.index + match[0].length;
  }
  words.push(text.slice(cursor));
  return { words, seps };
}

/** Which purely numeric words are a snapshot rather than a version. */
function snapshotFlags(words: string[]): boolean[] {
  const snap = words.map((word) => {
    if (!FAMILY_NUM.test(word) || word.includes(".")) {
      return false;
    }
    // A date or revision: 0528, 2507, 20251101, 2024, 001, 05.
    return word.length >= 4 || (word.length >= 2 && word.startsWith("0"));
  });
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!;
    if (snap[index] === true || !FAMILY_NUM.test(word) || word.length !== 2) {
      continue;
    }
    // The day after a month (05-20), the month before a year (12-2024).
    const afterSnapshot = index > 0 && snap[index - 1] === true;
    const beforeYear = index + 1 < words.length && FAMILY_YEAR.test(words[index + 1]!);
    if (afterSnapshot || beforeYear) {
      snap[index] = true;
    }
  }
  return snap;
}

export function modelFamily(id: string): ModelFamily {
  const text = id.trim().toLowerCase();
  const { words, seps } = splitFamilyWords(text);
  const snap = snapshotFlags(words);

  let name = "";
  let snapshots = "";
  const version: number[] = [];
  let preview = false;
  const keep = (index: number, word: string) => {
    if (name.length > 0 && index > 0) {
      name += seps[index - 1] ?? "";
    }
    name += word;
  };
  const addVersion = (value: string) => {
    for (const part of value.split(".")) {
      const parsed = Number.parseInt(part, 10);
      version.push(Number.isNaN(parsed) ? 0 : parsed);
    }
  };

  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!;
    if (word.length === 0) {
      continue;
    }
    if (snap[index] === true) {
      snapshots += `${snapshots.length > 0 ? "-" : ""}${word}`;
      continue;
    }
    if (FAMILY_PREVIEW.has(word)) {
      preview = true;
      continue;
    }
    if (word === "latest") {
      continue;
    }
    if (FAMILY_NUM.test(word)) {
      addVersion(word);
      continue;
    }
    if (FAMILY_SIZE.test(word)) {
      keep(index, word);
      continue;
    }
    if (keepVersionedWord(index, word, keep, addVersion)) {
      continue;
    }
    keep(index, word);
  }
  return {
    name: name.length > 0 ? name : text,
    version,
    snapshot: snapshots,
    preview,
  };
}

/** Keeps a word's name and records the version it ends or starts with. */
function keepVersionedWord(
  index: number,
  word: string,
  keep: (index: number, word: string) => void,
  addVersion: (value: string) => void,
): boolean {
  const tail = FAMILY_TAIL.exec(word);
  if (tail !== null) {
    const kept = tail[1] ?? tail[3] ?? "";
    // v3, v1: the version alone.
    if (kept !== "v") {
      keep(index, kept);
    }
    addVersion(tail[2] ?? tail[4] ?? "");
    return true;
  }
  const head = FAMILY_HEAD.exec(word);
  if (head === null) {
    return false;
  }
  addVersion(head[1]!);
  keep(index, head[2]!);
  return true;
}

function compareVersions(left: number[], right: number[]): number {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

function releasedOf(model: GatewayModel): string {
  return typeof model.released === "string" ? model.released : "";
}

/**
 * Whether `a`, of the same family as `b`, is the one to serve over it: the
 * higher version; at the same version a release over a preview, then the
 * alias over a dated snapshot, then the later release date, then the later
 * snapshot.
 */
function newerInFamily(
  a: GatewayModel,
  b: GatewayModel,
  familyA: ModelFamily,
  familyB: ModelFamily,
): boolean {
  const byVersion = compareVersions(familyA.version, familyB.version);
  if (byVersion !== 0) {
    return byVersion > 0;
  }
  if (familyA.preview !== familyB.preview) {
    return familyB.preview;
  }
  if ((familyA.snapshot === "") !== (familyB.snapshot === "")) {
    return familyA.snapshot === "";
  }
  const releasedA = releasedOf(a);
  const releasedB = releasedOf(b);
  if (releasedA !== releasedB) {
    return releasedA > releasedB;
  }
  return familyA.snapshot > familyB.snapshot;
}

/** The newest model of each family, keeping the list's order; its first listed wins a tie. */
export function bestInFamily(models: GatewayModel[]): GatewayModel[] {
  const families = models.map((model) => modelFamily(model.id));
  const best = new Map<string, number>();
  for (let index = 0; index < models.length; index += 1) {
    const family = families[index]!;
    const current = best.get(family.name);
    if (
      current === undefined ||
      newerInFamily(models[index]!, models[current]!, family, families[current]!)
    ) {
      best.set(family.name, index);
    }
  }
  return models.filter((_model, index) => best.get(families[index]!.name) === index);
}

/** The models a provider serves under its model mode. */
export function servedModels(provider: GatewayProvider): GatewayModel[] {
  // Antigravity's pooled models are read over the provider at request time
  // (`antigravity-pool.ts`); every other provider is its config as it is.
  const served = effectiveProviderModels(provider);
  switch (provider.modelMode ?? "list") {
    case "none":
      return [];
    case "picked":
      return served.filter((model) => model.picked === true);
    case "best":
      return bestInFamily(served);
    default:
      return served;
  }
}

/** Whether the provider's model mode lets this model be served. */
export function servesModel(provider: GatewayProvider, model: GatewayModel): boolean {
  return servedModels(provider).some((entry) => entry.id === model.id);
}

/**
 * What `/v1/models` calls a model, as myna's "Provider in model names" says:
 * `off` names the model alone, `own` keeps the user's own labels plain and
 * appends the provider to the rest, `on` appends it to every name that does
 * not already carry it.
 */
function gatewayModelDisplayName(
  provider: GatewayProvider,
  model: GatewayModel,
  mode: GatewayConfig["modelNames"],
): string {
  const name = model.label ?? model.id;
  if (mode === "off") {
    return name;
  }
  const owned = provider.label ?? provider.id;
  if (mode === "own" && model.label !== undefined) {
    return name;
  }
  if (model.label !== undefined && name.toLowerCase().includes(owned.toLowerCase())) {
    return name;
  }
  return `${name} · ${owned}`;
}

/**
 * A group's `match` pattern as the regular expression it means (myna's
 * compilePattern): a glob's `*` is any run of characters, "/" too, and
 * the rest is the id as spelt; a pattern after `re:` is a regular
 * expression. Either matches the whole id, in any case.
 */
export function compileGroupPattern(pattern: string): RegExp | null {
  if (pattern.startsWith("re:")) {
    const source = pattern.slice(3).trim();
    if (source.length === 0) {
      return null;
    }
    try {
      return new RegExp(`^(?:${source})$`, "i");
    } catch {
      return null;
    }
  }
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

/** A member's model id, without the `:effort` a group pins it to. */
function memberModelId(member: string): string {
  return parseMemberRef(member).id;
}

/**
 * The models a group's `match` patterns find now, after the ones it names
 * (myna's matchesIn): the models served now, never a group, in the
 * catalog's order, and not one the group names itself.
 */
export function matchedGroupMembers(config: GatewayConfig, group: GatewayGroup): string[] {
  const patterns = group.match ?? [];
  if (patterns.length === 0) {
    return [];
  }
  const matchers = patterns
    .map((pattern) => compileGroupPattern(pattern))
    .filter((matcher): matcher is RegExp => matcher !== null);
  const named = new Set(group.members.map(memberModelId));
  const out: string[] = [];
  for (const provider of config.providers) {
    if (!isProviderEnabled(provider)) {
      continue;
    }
    for (const model of servedModels(provider)) {
      const id = `${provider.id}/${model.id}`;
      if (named.has(id) || out.includes(id)) {
        continue;
      }
      if (matchers.some((matcher) => matcher.test(id))) {
        out.push(id);
      }
    }
  }
  return out;
}

/** The models a group with `unlists` takes out of the lists agents see. */
function unlistedModels(config: GatewayConfig): Set<string> {
  const out = new Set<string>();
  for (const group of groupsOf(config)) {
    if (group.unlists !== true || group.disabled === true) {
      continue;
    }
    for (const member of group.members) {
      const id = parseMemberRef(member).id;
      if (!id.startsWith(GROUP_PREFIX)) {
        out.add(id);
      }
    }
    // Unlists keeps the models the patterns match too (myna's Group.Unlists).
    for (const id of matchedGroupMembers(config, group)) {
      out.add(id);
    }
  }
  return out;
}

/** What one agent's lists are narrowed to, myna's VisibleTo/PickedModels/HiddenModels. */
export interface AgentVisibility {
  /** The families and ids its lists hold; undefined when not narrowed. */
  names?: string[];
  hidden: Set<string>;
  /** The entries it alone is shown; undefined when not "only picked". */
  picked?: Set<string>;
}

export function visibilityForAgent(
  config: GatewayConfig,
  agent: string | undefined,
): AgentVisibility | undefined {
  if (agent === undefined || agent.trim().length === 0) {
    return undefined;
  }
  const key = agent.trim().toLowerCase();
  const names = config.visible?.[key];
  const picked = config.pickedModels?.[key];
  return {
    ...(names === undefined ? {} : { names: [...names] }),
    hidden: new Set(config.hiddenModels?.[key] ?? []),
    ...(picked === undefined ? {} : { picked: new Set(picked) }),
  };
}

/** myna's ModelOff/Shows for one entry (`visible.go:43-52,154-160`). */
function showsEntry(visibility: AgentVisibility | undefined, id: string, names: string[]): boolean {
  if (visibility === undefined) {
    return true;
  }
  if (visibility.picked !== undefined) {
    return visibility.picked.has(id);
  }
  if (visibility.hidden.has(id)) {
    return false;
  }
  if (visibility.names === undefined) {
    return true;
  }
  return names.some((name) =>
    visibility.names?.some((wanted) => wanted.toLowerCase() === name.toLowerCase()),
  );
}

function providerVisibilityNames(provider: GatewayProvider): string[] {
  return [
    ...(provider.family === undefined || provider.family.length === 0 ? [] : [provider.family]),
    provider.id,
  ];
}

function groupVisibilityNames(group: GatewayGroup): string[] {
  return [
    ...(group.family === undefined || group.family.length === 0 ? [] : [group.family]),
    group.id,
    `${GROUP_PREFIX}${group.id}`,
  ];
}

// The list's own filters (enabled, exposed, disabled, unlisted, bare ids)
// plus the per-agent visibility the `agent` argument narrows.
// eslint-disable-next-line complexity
export function listGatewayModels(config: GatewayConfig, agent?: string): GatewayModelEntry[] {
  const entries: GatewayModelEntry[] = [];
  const visibility = visibilityForAgent(config, agent);
  // a group's `listed=no`: its models are offered through the group alone
  const unlisted = unlistedModels(config);
  for (const provider of config.providers) {
    if (!isProviderEnabled(provider) || provider.exposeModels === false) {
      continue;
    }
    const providerNames = providerVisibilityNames(provider);
    for (const model of servedModels(provider)) {
      const entryId = `${provider.id}/${listedModelId(config, provider.id, model.id)}`;
      if (!showsEntry(visibility, entryId, providerNames)) {
        continue;
      }
      // A disabled model leaves every list, as myna's DisabledModels does.
      if (disabledPattern(config, provider.id, model.id) !== null) {
        continue;
      }
      if (unlisted.has(`${provider.id}/${model.id}`)) {
        continue;
      }
      entries.push({
        id: entryId,
        object: "model",
        owned_by: provider.id,
        display_name: gatewayModelDisplayName(provider, model, config.modelNames),
        ...(provider.family === undefined || provider.family.length === 0
          ? {}
          : { family: provider.family }),
        ...(model.contextWindow === undefined ? {} : { context_window: model.contextWindow }),
        ...(model.maxOutputTokens === undefined
          ? {}
          : { max_output_tokens: model.maxOutputTokens }),
        ...(model.kind === undefined ? {} : { kind: model.kind }),
        ...(model.images === undefined ? {} : { images: model.images }),
      });
    }
  }
  for (const group of groupsOf(config)) {
    if (group.disabled === true) {
      continue;
    }
    if (!showsEntry(visibility, `${GROUP_PREFIX}${group.id}`, groupVisibilityNames(group))) {
      continue;
    }
    const context = groupContextWindow(config, group);
    entries.push({
      id: `${GROUP_PREFIX}${group.id}`,
      object: "model",
      owned_by: "group",
      display_name: group.label ?? group.id,
      ...(group.family === undefined || group.family.length === 0 ? {} : { family: group.family }),
      ...(context === undefined ? {} : { context_window: context }),
    });
  }
  if (config.bareModelIDs === true) {
    entries.push(...bareModelEntries(config, entries));
  }
  return entries;
}

/**
 * myna's BareEntries: the rows `/v1/models` adds for the bare ids when
 * `bareModelIDs` is on — each id once, after the provider/model ids, each
 * pointing where a request for it goes: the routing group it is in (its
 * members in the Providers order), else the first provider that serves it.
 * An id the list already has is not added again.
 */
function bareModelEntries(
  config: GatewayConfig,
  entries: readonly GatewayModelEntry[],
): GatewayModelEntry[] {
  const known = new Set(entries.map((entry) => entry.id));
  const groups = groupsOf(config).filter((group) => group.disabled !== true);
  const out: GatewayModelEntry[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry.id.startsWith(GROUP_PREFIX)) {
      continue;
    }
    const slash = entry.id.indexOf("/");
    if (slash <= 0) {
      continue;
    }
    const bare = entry.id.slice(slash + 1);
    if (bare.length === 0 || known.has(bare) || seen.has(bare)) {
      continue;
    }
    const group = groups.find((candidate) => candidate.members.includes(entry.id));
    const target =
      group === undefined
        ? entry
        : entries.find((candidate) => candidate.id === `${GROUP_PREFIX}${group.id}`);
    if (target === undefined) {
      continue;
    }
    seen.add(bare);
    out.push({ ...target, id: bare });
  }
  return out;
}

/**
 * The window agents are told for a group: the one it names, the smallest
 * member's when it says -1, else its largest member's.
 */
function groupContextWindow(
  config: GatewayConfig,
  group: GatewayConfig["groups"][number],
): number | undefined {
  if (group.context !== undefined && group.context > 0) {
    return group.context;
  }
  let candidates: GatewayCandidate[];
  try {
    candidates = resolveGatewayCandidates(config, `${GROUP_PREFIX}${group.id}`);
  } catch {
    return undefined;
  }
  const windows = candidates
    .map((candidate) => candidate.model.contextWindow)
    .filter((value): value is number => value !== undefined);
  if (windows.length === 0) {
    return undefined;
  }
  return group.context === -1 ? Math.min(...windows) : Math.max(...windows);
}

/**
 * Expands a requested model id into the ordered upstream candidates.
 *
 * Accepts `provider/model`, a bare model id (first provider that has it), or
 * `group/<id>`. Group members may be groups themselves; a cycle throws rather
 * than resolving to a partial list.
 */
export function resolveGatewayCandidates(
  config: GatewayConfig,
  requestedModel: string,
): GatewayCandidate[] {
  // A bare id a routing group goes by is served by that group before any
  // provider's model of the same id, as myna's GroupFor does and its bare
  // id rows show.
  const group = requestedModel.includes("/") ? null : groupByRequest(config, requestedModel);
  if (group !== null) {
    return resolveMemberCandidates(config, `${GROUP_PREFIX}${group.id}`);
  }
  const candidates: GatewayCandidate[] = [];
  expandMember(config, requestedModel, [], candidates);
  return candidates;
}

/** One group member as the candidates it expands to, its pin applied. */
export function resolveMemberCandidates(
  config: GatewayConfig,
  member: string,
  ruleEffort: GatewayEffort | null = null,
): GatewayCandidate[] {
  const candidates: GatewayCandidate[] = [];
  expandMember(config, member, [], candidates, ruleEffort);
  return candidates;
}

/**
 * Where a request goes when a provider is out of quota, rate limited or
 * down: its own `fallback` entries, in order (`provider/model` or
 * `group/<id>`), never itself (myna's Fallback, `providers_cli.go`).
 */
export function fallbackCandidates(config: GatewayConfig, providerId: string): GatewayCandidate[] {
  const provider = config.providers.find((entry) => entry.id === providerId);
  if (provider === undefined || (provider.fallback ?? []).length === 0) {
    return [];
  }
  const out: GatewayCandidate[] = [];
  const seen = new Set<string>();
  for (const ref of provider.fallback) {
    let expanded: GatewayCandidate[];
    try {
      expanded = resolveGatewayCandidates(config, ref);
    } catch {
      // a fallback naming a missing group is skipped, as an unknown one is
      continue;
    }
    for (const candidate of expanded) {
      if (candidate.provider.id === providerId) {
        continue;
      }
      const key = `${candidate.provider.id}/${candidate.model.id}/${candidate.provider.protocol}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(candidate);
      }
    }
  }
  return out;
}

function expandMember(
  config: GatewayConfig,
  member: string,
  visitingGroups: string[],
  out: GatewayCandidate[],
  ruleEffort: GatewayEffort | null = null,
): void {
  const ref = parseMemberRef(member);
  if (ref.id.startsWith(GROUP_PREFIX)) {
    const groupId = ref.id.slice(GROUP_PREFIX.length);
    if (visitingGroups.includes(groupId)) {
      throw new Error(`Routing group cycle: ${[...visitingGroups, groupId].join(" -> ")}`);
    }
    const group = groupsOf(config).find((entry) => entry.id === groupId);
    if (!group) {
      throw new Error(`Unknown routing group: ${groupId}`);
    }
    if (group.disabled === true) {
      // A switched-off group in another group serves nothing; a request
      // that names it directly is turned away in group-rules.
      return;
    }
    for (const groupMember of group.members) {
      expandMember(config, groupMember, [...visitingGroups, groupId], out, ruleEffort);
    }
    return;
  }

  const candidates = findCandidates(config, ref.id);
  if (candidates.length === 0) {
    throw new Error(`Unknown model: ${ref.id}`);
  }
  for (const candidate of candidates) {
    out.push({
      ...candidate,
      ...(ref.effort === null ? {} : { effort: ref.effort }),
      ...(ruleEffort === null ? {} : { ruleEffort }),
    });
  }
}

function findCandidates(config: GatewayConfig, member: string): GatewayCandidate[] {
  const separator = member.indexOf("/");
  if (separator > 0) {
    const providerId = member.slice(0, separator);
    const requestedId = member.slice(separator + 1);
    const provider = config.providers.find(
      (entry) => entry.id === providerId && isProviderEnabled(entry),
    );
    // The request names the id the model is listed by; the provider is
    // asked for its own (myna's OwnModelID).
    const modelId = servedModelId(config, providerId, requestedId);
    const model =
      provider === undefined
        ? undefined
        : effectiveProviderModels(provider).find((entry) => entry.id === modelId);
    return provider === undefined || model === undefined || !servesModel(provider, model)
      ? []
      : candidatesOf(config, provider, model);
  }

  for (const provider of config.providers) {
    if (!isProviderEnabled(provider) || provider.exposeModels === false) {
      continue;
    }
    const model = modelByListedId(config, provider, member);
    if (model) {
      return candidatesOf(config, provider, model);
    }
  }
  return [];
}

/**
 * The model a bare id names: the id the user listed it by wins over a
 * provider's own id of the same spelling (myna's localIDs.list).
 */
function modelByListedId(
  config: GatewayConfig,
  provider: GatewayProvider,
  member: string,
): GatewayModel | undefined {
  const models = servedModels(provider);
  const listed = models.find(
    (entry) => entry.id !== member && listedModelId(config, provider.id, entry.id) === member,
  );
  return listed ?? models.find((entry) => entry.id === member);
}

/** The model as a candidate carries it, with the wire name a user set. */
function candidateModel(
  config: GatewayConfig,
  provider: GatewayProvider,
  model: GatewayModel,
): CandidateModel {
  return { ...model, upstreamName: upstreamModelName(config, provider.id, model.id) };
}

/** myna's four provider addresses, in the order a model is tried on them. */
const WIRE_ORDER: readonly GatewayProvider["protocol"][] = [
  "anthropic",
  "openai",
  "openai-responses",
  "gemini",
];

/** The clones that serve a provider's models at each of its own addresses. */
function wireProviders(provider: GatewayProvider): GatewayProvider[] | null {
  const wires = provider.wires;
  if (wires === undefined) {
    return null;
  }
  const out: GatewayProvider[] = [];
  for (const protocol of WIRE_ORDER) {
    const baseUrl = wires[protocol];
    if (baseUrl === undefined || baseUrl === "") {
      continue;
    }
    out.push({ ...provider, protocol, baseUrl });
  }
  return out.length > 0 ? out : null;
}

/** The order myna tries a Factory model droid's list does not name. */
const FACTORY_UNKNOWN_WIRES: readonly GatewayProvider["protocol"][] = [
  "anthropic",
  "openai-responses",
  "openai",
];

/** The wires a Factory model is tried on, or null for another provider. */
export function factoryWiresFor(
  provider: GatewayProvider,
  modelId: string,
): GatewayProvider["protocol"][] | null {
  if (!(provider.accounts ?? []).some((account) => account.agent === "factory")) {
    return null;
  }
  const listed = factoryModel(modelId);
  return listed === null ? [...FACTORY_UNKNOWN_WIRES] : [listed.protocol];
}

/** Whether another Factory wire is left after this candidate's (myna's factoryAPIs). */
export function factoryWireLeft(candidate: GatewayCandidate): boolean {
  const wires = factoryWiresFor(candidate.provider, candidate.model.id);
  if (wires === null) {
    return false;
  }
  const index = wires.indexOf(candidate.provider.protocol);
  return index >= 0 && index < wires.length - 1;
}

/**
 * The candidates a provider/model makes. Factory signs one account in for
 * models on three wires and Gemini's generate route: the model decides
 * which, and one droid's list doesn't name is tried on all three in turn
 * (myna's factoryAPIs). Another provider asks every model on its own
 * protocol.
 */
function candidatesOf(
  config: GatewayConfig,
  provider: GatewayProvider,
  model: GatewayModel,
): GatewayCandidate[] {
  const candidate = candidateModel(config, provider, model);
  // A provider of the user's own names an address per API (myna's provider
  // Chat/Responses/Anthropic/Gemini): its models are tried on each in turn.
  const wireList = wireProviders(provider);
  if (wireList !== null) {
    return wireList.map((wire) => ({ provider: wire, model: candidate }));
  }
  const protocols = factoryWiresFor(provider, model.id) ?? [provider.protocol];
  return protocols.map((protocol) => ({
    provider: protocol === provider.protocol ? provider : { ...provider, protocol },
    model: candidate,
  }));
}
