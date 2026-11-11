import type { GatewayGroupRuleWire } from "@neolix/protocol/gateway";
import type { TuiGatewayConfig, TuiGroup } from "./data.js";

/**
 * The routing group's list: models, then rules, as myna's group page shows
 * them. Pure moves and picker options, so both can be tested without Ink.
 */

export interface MovedGroupEntry {
  cursor: number;
  members?: string[];
  rules?: GatewayGroupRuleWire[];
}

/**
 * Swaps the entry under the cursor with its neighbour. Models and rules
 * never mix: a member stays among the members, a rule among the rules.
 */
export function movedGroupEntry(
  group: TuiGroup,
  cursor: number,
  by: number,
): MovedGroupEntry | null {
  const memberCount = group.members.length;
  const rules = group.rules ?? [];
  const total = memberCount + rules.length;
  const to = cursor + by;
  const onRule = cursor >= memberCount;
  if (cursor < 0 || cursor >= total || to < 0 || to >= total) return null;
  if (to >= memberCount !== onRule) return null;
  if (onRule) {
    const next = [...rules];
    const fromIndex = cursor - memberCount;
    const toIndex = to - memberCount;
    [next[fromIndex], next[toIndex]] = [next[toIndex], next[fromIndex]];
    return { cursor: to, rules: next };
  }
  const members = [...group.members];
  [members[cursor], members[to]] = [members[to], members[cursor]];
  return { cursor: to, members };
}

/** The models and groups a picker can add to `group`; models only for a classifier. */
export function groupMemberOptions(
  config: TuiGatewayConfig,
  group: TuiGroup | null,
  modelsOnly = false,
): { value: string; note?: string }[] {
  const skip = new Set(group?.members ?? []);
  const items: { value: string; note?: string }[] = [];
  for (const provider of config.providers) {
    for (const model of provider.models) {
      const value = `${provider.id}/${model.id}`;
      if (skip.has(value)) continue;
      items.push({ value, note: model.label ?? provider.label ?? provider.id });
    }
  }
  if (modelsOnly) return items;
  for (const other of config.groups) {
    const value = `group/${other.id}`;
    if (other.id === group?.id || skip.has(value)) continue;
    items.push({ value, note: `group · ${other.label ?? other.id}` });
  }
  return items;
}
