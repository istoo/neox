import type { GatewayConfig } from "./config.js";
import { listGatewayModels } from "./catalog.js";

/**
 * Which models an agent is shown, written into `gateway.json`: myna's
 * Settings.Visible/HiddenModels/PickedModels and the switches over them
 * (`internal/provider/visible.go`).
 *
 * The fields live at the config root, keyed by the agent's id lower-cased:
 *
 * - `visible`: the families, provider ids and group ids the agent's lists
 *   hold. No key means not narrowed.
 * - `hiddenModels`: the entry ids taken out one by one.
 * - `pickedModels`: a key means the agent is shown only the ids in it, and
 *   an empty list shows it nothing. No key means every model not hidden.
 *
 * These functions answer the three records after a change; they never
 * mutate the config they are given, so a caller can store the result.
 */
export type VisibilityRecords = Pick<GatewayConfig, "visible" | "hiddenModels" | "pickedModels">;

function agentKey(agent: string): string {
  const key = agent.trim().toLowerCase();
  if (key.length === 0) {
    throw new Error("no agent");
  }
  return key;
}

/** The three records, as saved; a config built by hand may leave them out. */
function recordsOf(config: GatewayConfig): Required<VisibilityRecords> {
  return {
    visible: config.visible ?? {},
    hiddenModels: config.hiddenModels ?? {},
    pickedModels: config.pickedModels ?? {},
  };
}

/** ids trimmed, without blanks or twins, sorted; never empty as a value (`sortedIDs`). */
export function sortedIds(ids: readonly string[]): string[] {
  const keep = new Set<string>();
  for (const id of ids) {
    const clean = id.trim();
    if (clean.length > 0) {
      keep.add(clean);
    }
  }
  return [...keep].sort();
}

function without(record: Record<string, string[]>, key: string): Record<string, string[]> {
  const out = { ...record };
  delete out[key];
  return out;
}

function withList(
  record: Record<string, string[]>,
  key: string,
  ids: readonly string[],
): Record<string, string[]> {
  return { ...record, [key]: [...ids] };
}

/** Whether the agent is shown only the models picked for it (`PickedModels`). */
export function onlyPicked(config: GatewayConfig, agent: string): boolean {
  return recordsOf(config).pickedModels[agentKey(agent)] !== undefined;
}

/**
 * The agent's visibility narrowed to these names; null (myna's `all`) takes
 * every narrowing out: the names, the hidden models, and the picks.
 */
export function setVisibleNames(
  config: GatewayConfig,
  agent: string,
  names: readonly string[] | null,
): VisibilityRecords {
  const { visible, hiddenModels, pickedModels } = recordsOf(config);
  const key = agentKey(agent);
  if (names === null) {
    return {
      visible: without(visible, key),
      hiddenModels: without(hiddenModels, key),
      pickedModels: without(pickedModels, key),
    };
  }
  return {
    visible: withList(visible, key, names),
    hiddenModels,
    pickedModels,
  };
}

/** Takes these entries out of the agent's lists, or every one for none (`SetHiddenModels`). */
export function setHiddenModels(
  config: GatewayConfig,
  agent: string,
  ids: readonly string[],
): VisibilityRecords {
  const { visible, hiddenModels, pickedModels } = recordsOf(config);
  const key = agentKey(agent);
  const keep = sortedIds(ids);
  return {
    visible,
    hiddenModels:
      keep.length === 0 ? without(hiddenModels, key) : withList(hiddenModels, key, keep),
    pickedModels,
  };
}

/**
 * The only entries the agent is shown (`SetPickedModels`). A pick of an
 * entry not listed for it now is kept, so it comes back picked when it is
 * listed again; an agent not shown only its picks is refused.
 */
export function setPickedModels(
  config: GatewayConfig,
  agent: string,
  ids: readonly string[],
): VisibilityRecords {
  const { visible, hiddenModels, pickedModels } = recordsOf(config);
  const key = agentKey(agent);
  if (pickedModels[key] === undefined) {
    throw new Error(
      `${key} is shown every model not taken out of its lists, not only the ones picked`,
    );
  }
  const listed = new Set(listGatewayModels(config, agent).map((entry) => entry.id));
  const keep = [...ids, ...(pickedModels[key] ?? []).filter((id) => !listed.has(id))];
  return {
    visible,
    hiddenModels,
    pickedModels: withList(pickedModels, key, sortedIds(keep)),
  };
}

/**
 * Switches the agent between every model not taken out of its lists and
 * only the ones picked for it (`SetOnlyPicked`, myna visible.go:162-200).
 * The models it is shown now stay as they are: switched on they become its
 * picks; switched off the listed ones not picked are taken out, and a model
 * that comes later is shown again.
 */
export function setOnlyPicked(
  config: GatewayConfig,
  agent: string,
  on: boolean,
): VisibilityRecords {
  const { visible, hiddenModels, pickedModels } = recordsOf(config);
  const key = agentKey(agent);
  if ((pickedModels[key] !== undefined) === on) {
    return { visible, hiddenModels, pickedModels };
  }
  const shown = listGatewayModels(config, agent).map((entry) => entry.id);
  if (on) {
    return {
      visible,
      hiddenModels: without(hiddenModels, key),
      pickedModels: withList(pickedModels, key, sortedIds(shown)),
    };
  }
  // Every entry the visibility names, before the picked switch and hidden
  // models take theirs out; what that leaves is now kept one by one.
  const listed = listGatewayModels({ ...config, hiddenModels: {}, pickedModels: {} }, agent).map(
    (entry) => entry.id,
  );
  const shownNow = new Set(shown);
  const hidden = sortedIds(listed.filter((id) => !shownNow.has(id)));
  return {
    visible,
    hiddenModels:
      hidden.length === 0 ? without(hiddenModels, key) : withList(hiddenModels, key, hidden),
    pickedModels: without(pickedModels, key),
  };
}
