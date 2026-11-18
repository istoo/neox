// FILE: agentConnect.logic.ts
// Purpose: Pure list, status, and model-choice rules for Agent Connect. Kept
//          out of the components so both the settings panel and the tray panel
//          apply the same order, status and default-model rules.
// Layer: Web logic

import type { AgentConnectEntry, AgentConnectModel } from "@synara/contracts";

export interface AgentConnectRow {
  readonly provider: string;
  readonly entry: AgentConnectEntry;
  /** An agent Neox wires to the gateway but does not run as its own provider. */
  readonly external: boolean;
}

export type AgentConnectStatusTone = "on" | "off" | "bad";

export interface AgentConnectStatus {
  readonly tone: AgentConnectStatusTone;
  readonly key: string;
  readonly params?: Readonly<Record<string, string | number>>;
}

/** Translation keys for the providers Neox writes a config for. */
const PROVIDER_LABEL_KEYS: Readonly<Record<string, string>> = {
  claude: "settings:agentConnect_provider_claude",
  codex: "settings:agentConnect_provider_codex",
  opencode: "settings:agentConnect_provider_opencode",
  pi: "settings:agentConnect_provider_pi",
};

export function providerLabelKey(provider: string): string | null {
  return PROVIDER_LABEL_KEYS[provider] ?? null;
}

/** `open-code` style ids read as `Open code` when no catalog name exists. */
export function humanizeProvider(provider: string): string {
  const words = provider.replace(/[-_]+/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function agentLabel(
  entry: Pick<AgentConnectEntry, "provider" | "name">,
  translate: (key: string) => string,
): string {
  if (entry.name !== undefined && entry.name.length > 0) return entry.name;
  const key = providerLabelKey(entry.provider);
  return key === null ? humanizeProvider(entry.provider) : translate(key);
}

export function buildRows(entries: readonly AgentConnectEntry[]): AgentConnectRow[] {
  return entries.map((entry) => ({
    provider: entry.provider,
    entry,
    external: entry.kind === "external",
  }));
}

/**
 * The reader's order first, anything it does not name after, in snapshot order.
 * Ordering is stable so a partially written order never reshuffles the rest.
 */
export function orderAgentRows(
  rows: readonly AgentConnectRow[],
  order: readonly string[] | undefined,
): AgentConnectRow[] {
  if (order === undefined || order.length === 0) return [...rows];
  const rank = new Map(order.map((id, index) => [id, index]));
  return rows
    .map((row, index) => ({ row, index }))
    .toSorted(
      (left, right) =>
        (rank.get(left.row.provider) ?? order.length) -
          (rank.get(right.row.provider) ?? order.length) || left.index - right.index,
    )
    .map((entry) => entry.row);
}

export function splitHiddenRows(
  rows: readonly AgentConnectRow[],
  hidden: readonly string[] | undefined,
): { shown: AgentConnectRow[]; hidden: AgentConnectRow[] } {
  const hiddenSet = new Set(hidden ?? []);
  return {
    shown: rows.filter((row) => !hiddenSet.has(row.provider)),
    hidden: rows.filter((row) => hiddenSet.has(row.provider)),
  };
}

/** Connected agents first, the rest after; `fold` marks where the rest start. */
export function splitConnectedRows(rows: readonly AgentConnectRow[]): {
  used: AgentConnectRow[];
  rest: AgentConnectRow[];
} {
  return {
    used: rows.filter((row) => row.entry.connected),
    rest: rows.filter((row) => !row.entry.connected),
  };
}

/** The dot-and-words line under an agent's name, as the gateway wiring stands. */
export function agentConnectStatus(
  entry: AgentConnectEntry | null,
  label: string,
): AgentConnectStatus {
  if (entry === null) {
    return { tone: "off", key: "settings:agentConnect_statusUnknown" };
  }
  if (entry.drift === "unwired") {
    return {
      tone: "bad",
      key: "settings:agentConnect_statusDriftUnwired",
      params: { name: label },
    };
  }
  if (entry.drift === "stale") {
    return {
      tone: "bad",
      key: "settings:agentConnect_statusDriftStale",
      params: { name: label },
    };
  }
  if (entry.reason === "unsupported") {
    return { tone: "off", key: "settings:agentConnect_statusUnsupported" };
  }
  if (entry.connected) {
    if (entry.provider === "claude") {
      return { tone: "on", key: "settings:agentConnect_statusConnectedClaude" };
    }
    return {
      tone: "on",
      key: "settings:agentConnect_statusConnected",
      params: { count: entry.modelCount },
    };
  }
  if (entry.reason === "gateway_unavailable") {
    return { tone: "bad", key: "settings:agentConnect_statusGatewayUnavailable" };
  }
  if (entry.reason === "no_gateway_models") {
    return { tone: "bad", key: "settings:agentConnect_statusNoModels" };
  }
  return {
    tone: "off",
    key: "settings:agentConnect_statusDisconnected",
    params: { name: label },
  };
}

/** Whether the row's model menu and switch are out of reach. */
export function isConnectBlocked(
  entry: AgentConnectEntry | null,
  models: readonly AgentConnectModel[],
  saving: boolean,
): boolean {
  if (entry === null || models.length === 0) return true;
  if (entry.reason !== null && !entry.connected) return true;
  return saving;
}

/** The agent still points at the gateway through something out of date. */
export function canReapply(entry: AgentConnectEntry | null): boolean {
  return entry?.drift === "unwired" || entry?.drift === "stale";
}

export function modelLabel(models: readonly AgentConnectModel[], id: string | null): string {
  if (id === null) return "";
  return models.find((entry) => entry.id === id)?.label ?? id;
}

/**
 * Turning the switch off then on again starts on the gateway's first model
 * rather than a value left in the agent's own config; a disconnect keeps the
 * value the daemon already has.
 */
export function modelWhenToggling(entry: AgentConnectEntry | null): string | null {
  return entry?.connected === true ? entry.model : null;
}

/** Reapply keeps the model when the gateway still serves it. */
export function reapplyModel(
  entry: AgentConnectEntry | null,
  models: readonly AgentConnectModel[],
): string | null {
  const current = entry?.model ?? null;
  return current !== null && models.some((model) => model.id === current) ? current : null;
}

/** One model's eye switch: removing an id from `hidden` shows it. */
export function toggleHiddenModel(hidden: readonly string[], id: string, shown: boolean): string[] {
  if (shown) return hidden.filter((entry) => entry !== id);
  return hidden.includes(id) ? [...hidden] : [...hidden, id];
}

export function toggleHiddenProvider(
  hidden: readonly string[],
  provider: string,
  shouldHide: boolean,
): string[] {
  return shouldHide
    ? hidden.includes(provider)
      ? [...hidden]
      : [...hidden, provider]
    : hidden.filter((id) => id !== provider);
}

/** A move past either end is a no-op, so the caller keeps the same order. */
export function moveProvider(
  order: readonly string[],
  provider: string,
  direction: -1 | 1,
): string[] {
  const from = order.indexOf(provider);
  const to = from + direction;
  if (from < 0 || to < 0 || to >= order.length) return [...order];
  const next = [...order];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}

export function profileInUse(profile: { inUse?: boolean }): boolean {
  return profile.inUse === true;
}
