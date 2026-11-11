import { servedModels } from "./catalog.js";
import { isProviderEnabled, type GatewayConfig, type GatewayGroup } from "./config.js";
import { disabledPattern, listedModelId } from "./model-prefs.js";

/**
 * The groups the gateway finds on its own, as myna's found groups: a model
 * more than one provider serves is a group of them, and one the user says is
 * the same as another (the "Same as" field, myna's ModelSameAs) joins that
 * model's group. They are derived on every read and never stored; editing one
 * saves it as the user's own group, which then hides the found one.
 */

const MODEL_GAPS = /[\s\p{Zs}_-]+/gu;
const SNAPSHOT = /^\d+$/;

function digit(code: number): boolean {
  return code >= 48 && code <= 57;
}

/** The date a vendor dates a snapshot of a model by: 20000101, or Ark's 230101. */
function snapshotDate(value: string): boolean {
  if (!SNAPSHOT.test(value)) {
    return false;
  }
  if (value.length === 8) {
    return value.startsWith("20");
  }
  if (value.length !== 6) {
    return false;
  }
  const yy = Number(value.slice(0, 2));
  const mm = Number(value.slice(2, 4));
  const dd = Number(value.slice(4, 6));
  return yy >= 23 && yy <= 39 && mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31;
}

/**
 * A model's name as vendors agree on it, myna's catalog.SameModel: the bare
 * id, gaps as one "-", a version dot as "-" (5.5 = 5-5, 4p1 = 4-1), and a
 * trailing snapshot date dropped.
 */
export function sameModel(id: string): string {
  let key = id.trim().toLowerCase();
  const slash = key.lastIndexOf("/");
  if (slash >= 0) {
    key = key.slice(slash + 1);
  }
  key = key.replace(MODEL_GAPS, "-").replace(/^-+|-+$/g, "");
  const chars = [...key];
  for (let at = 1; at + 1 < chars.length; at++) {
    const mark = chars[at];
    if ((mark === "." || mark === "p") && digit(chars[at - 1]!.codePointAt(0) ?? 0)) {
      if (digit(chars[at + 1]!.codePointAt(0) ?? 0)) {
        chars[at] = "-";
      }
    }
  }
  key = chars.join("");
  const last = Math.max(key.lastIndexOf("-"), key.lastIndexOf("@"));
  if (last > 0 && snapshotDate(key.slice(last + 1))) {
    key = key.slice(0, last);
  }
  return key;
}

/** A group's id from a name, myna's Slug: lowercase, anything else one "-". */
export function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** The id of the group found for a model, myna's AutoGroupID. */
export function autoGroupId(model: string): string {
  return `auto-${slug(sameModel(model))}`;
}

/** What the found groups merge a model by: its "Same as" model, else its own id. */
export function mergeKey(
  providerId: string,
  modelId: string,
  sameAs: Readonly<Record<string, string>> | undefined,
): string {
  const same = sameAs?.[`${providerId}/${modelId}`];
  return sameModel(same === undefined || same.trim() === "" ? modelId : same);
}

interface FoundEntry {
  providerId: string;
  modelId: string;
  name: string;
}

/** The groups the gateway finds now, in the order the providers were added. */
export function foundGroups(config: GatewayConfig): GatewayGroup[] {
  if (config.autoGroups === false) {
    return [];
  }
  const skip = new Set((config.autoGroupSkip ?? []).map((id) => id.trim().toLowerCase()));
  const order: string[] = [];
  const byKey = new Map<string, FoundEntry[]>();
  for (const provider of config.providers) {
    if (!isProviderEnabled(provider) || provider.exposeModels === false) {
      continue;
    }
    if (skip.has(provider.id.toLowerCase())) {
      continue;
    }
    for (const model of servedModels(provider)) {
      // A disabled model leaves every list and every group, as myna does.
      if (disabledPattern(config, provider.id, model.id) !== null) {
        continue;
      }
      const key = mergeKey(provider.id, model.id, config.modelSameAs);
      const entries = byKey.get(key) ?? [];
      if (entries.length === 0) {
        order.push(key);
      }
      if (!entries.some((entry) => entry.providerId === provider.id)) {
        entries.push({ providerId: provider.id, modelId: model.id, name: model.label ?? model.id });
        byKey.set(key, entries);
      }
    }
  }
  const out: GatewayGroup[] = [];
  for (const key of order) {
    const entries = byKey.get(key) ?? [];
    if (entries.length < 2) {
      continue;
    }
    const first = entries[0]!;
    // A vendor that names the model names the group too, over one that only
    // lists its id.
    let label = first.name;
    for (const entry of entries) {
      if (label === first.modelId && entry.name !== entry.modelId) {
        label = entry.name;
      }
    }
    out.push({
      id: `auto-${slug(key)}`,
      label: label === first.modelId ? key : label,
      members: entries.map(
        (entry) => `${entry.providerId}/${listedModelId(config, entry.providerId, entry.modelId)}`,
      ),
      strategy: "order",
      auto: true,
    });
  }
  return out;
}

/**
 * The groups the gateway serves and lists: the user's own, in their order,
 * then the found ones whose id the user hasn't changed.
 */
export function groupsOf(config: GatewayConfig): GatewayGroup[] {
  const hidden = new Set(config.hiddenGroups ?? []);
  const stored = (config.groups ?? []).filter((group) => !hidden.has(group.id));
  const taken = new Set(stored.map((group) => group.id));
  const found = foundGroups(config).filter(
    (group) => !taken.has(group.id) && !hidden.has(group.id),
  );
  const groups = [...stored, ...found];
  const order = config.groupOrder ?? [];
  if (order.length === 0) {
    return groups;
  }
  const rank = new Map(order.map((id, at) => [id, at]));
  return groups
    .map((group, at) => ({ group, at, rank: rank.get(group.id) ?? order.length }))
    .sort((left, right) => left.rank - right.rank || left.at - right.at)
    .map((entry) => entry.group);
}

/** The group a request names: `group/<id>`, or myna's `auto/<model>` for a found one. */
export function groupByRequest(config: GatewayConfig, requestedModel: string): GatewayGroup | null {
  const groups = groupsOf(config);
  if (requestedModel.startsWith("group/")) {
    const id = requestedModel.slice("group/".length);
    return groups.find((group) => group.id === id) ?? null;
  }
  if (requestedModel.startsWith("auto/")) {
    // Claude Code puts a [1m] mark on a 1M window; the model is the same.
    const model = requestedModel.slice("auto/".length).replace(/\[1m\]$/, "");
    const id = autoGroupId(model);
    return groups.find((group) => group.id === id) ?? null;
  }
  // A bare id a group goes by is that group, as myna's GroupFor takes it:
  // its id, its slug, the found group's auto-slug, then a group's name.
  const bare = requestedModel.replace(/\[1m\]$/, "");
  const wanted = [bare.toLowerCase(), slug(sameModel(bare)), autoGroupId(bare)];
  for (const id of wanted) {
    const group = groups.find((entry) => entry.id === id);
    if (group !== undefined) {
      return group;
    }
  }
  return groupNamed(groups, bare);
}

/** A group a request names by its label, when exactly one goes by it. */
function groupNamed(groups: readonly GatewayGroup[], id: string): GatewayGroup | null {
  const key = slug(id);
  if (key === "") {
    return null;
  }
  const wanted = id.toLowerCase();
  let hit: GatewayGroup | null = null;
  for (const group of groups) {
    if (group.label === undefined) {
      continue;
    }
    if (group.label.toLowerCase() === wanted || slug(group.label) === key) {
      if (hit !== null) {
        return null;
      }
      hit = group;
    }
  }
  return hit;
}

/** The config as stored: found groups are derived, so they are never written. */
export function stripFoundGroups(config: GatewayConfig): GatewayConfig {
  if (!(config.groups ?? []).some((group) => group.auto === true)) {
    return config;
  }
  return { ...config, groups: config.groups.filter((group) => group.auto !== true) };
}
