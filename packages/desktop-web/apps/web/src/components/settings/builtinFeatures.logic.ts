// FILE: builtinFeatures.logic.ts
// Purpose: Pure rules for the daemon's built-in feature switches: which Neox
//   settings sections and gateway tabs each switch hides, and how much of a
//   feature is in use (a feature with something in use stays on, as myna's
//   InUse plugins do).
// Layer: Settings logic
// Exports: the desktop surface map, effective switches, hidden surfaces, and
//          gateway use counts.

import {
  DEFAULT_NEOLIX_GATEWAY_CALLS_PAGE,
  NEOLIX_BUILTIN_FEATURE_IDS,
  type NeolixBuiltinFeatureId,
  type NeolixBuiltinFeatures,
} from "@synara/contracts";

import type { GatewayConfig } from "~/lib/gatewayTypes";

/**
 * Which settings sections a switch takes away. `library` covers the four
 * Library pages and the MCP server list they feed; `routing` and `redact` are
 * gateway tabs, handled by `BUILTIN_FEATURE_GATEWAY_TABS`. `tools` is Neox's
 * MCP tools surface (Settings › Integrations).
 */
export const BUILTIN_FEATURE_SETTINGS_SECTIONS: Readonly<
  Record<NeolixBuiltinFeatureId, readonly string[]>
> = {
  sessions: ["sessions"],
  library: [
    "library-instructions",
    "library-hooks",
    "library-subagents",
    "library-rtk",
    "connectors",
    "skills",
  ],
  routing: [],
  usage: ["usage", "quota"],
  gateway: ["gateway"],
  redact: ["privacy"],
  otel: ["observability"],
  warmups: [],
  groups: [],
  rotation: [],
  middleware: [],
  budget: [],
  tools: ["integrations"],
  search: [],
};

/** Gateway tabs a switch removes. The rest of the page keeps its own switches. */
export const BUILTIN_FEATURE_GATEWAY_TABS: Readonly<
  Partial<Record<NeolixBuiltinFeatureId, readonly string[]>>
> = {
  routing: ["routing"],
  redact: ["masking"],
};

export interface HiddenBuiltinSurfaces {
  readonly settingsSections: ReadonlySet<string>;
  readonly gatewayTabs: ReadonlySet<string>;
  /** The rail's provider-usage rings; the Usage pages fall with `settingsSections`. */
  readonly railUsage: boolean;
}

export function emptyBuiltinFeatureUseCounts(): Record<NeolixBuiltinFeatureId, number> {
  return Object.fromEntries(NEOLIX_BUILTIN_FEATURE_IDS.map((id) => [id, 0] as const)) as Record<
    NeolixBuiltinFeatureId,
    number
  >;
}

/**
 * A feature without a stored switch is on. A feature with something in use is
 * on too: hiding a page whose data is still being written would hide evidence
 * the user needs, and myna refuses the same switch-off.
 */
export function effectiveBuiltinFeatures(
  stored: NeolixBuiltinFeatures | undefined,
  useCounts: Readonly<Record<NeolixBuiltinFeatureId, number>>,
): Record<NeolixBuiltinFeatureId, boolean> {
  return Object.fromEntries(
    NEOLIX_BUILTIN_FEATURE_IDS.map((id) => [id, stored?.[id] !== false || useCounts[id] > 0]),
  ) as Record<NeolixBuiltinFeatureId, boolean>;
}

/** Every surface the effective switches turn off. */
export function hiddenBuiltinSurfaces(
  effective: Readonly<Record<NeolixBuiltinFeatureId, boolean>>,
): HiddenBuiltinSurfaces {
  const settingsSections = new Set<string>();
  const gatewayTabs = new Set<string>();
  for (const id of NEOLIX_BUILTIN_FEATURE_IDS) {
    if (effective[id]) continue;
    for (const section of BUILTIN_FEATURE_SETTINGS_SECTIONS[id]) settingsSections.add(section);
    for (const tab of BUILTIN_FEATURE_GATEWAY_TABS[id] ?? []) gatewayTabs.add(tab);
  }
  return { settingsSections, gatewayTabs, railUsage: !effective.usage };
}

/**
 * What each feature has in use, counted from the gateway document. The counts
 * match myna's InUse plugins: groups count as routing, non-order strategies
 * count as rotation, and a configured key/cap counts as a limit.
 */
export function builtinFeatureUseCounts(
  config: GatewayConfig | null | undefined,
): Record<NeolixBuiltinFeatureId, number> {
  const counts = emptyBuiltinFeatureUseCounts();
  if (!config) return counts;

  const groups = config.groups ?? [];
  const usedGroups = groups.filter((group) => group.disabled !== true);
  const accounts = (config.providers ?? []).flatMap((provider) => provider.accounts ?? []);
  const keys = config.keys ?? [];
  const budgetKeys = keys.filter(
    (key): key is Exclude<(typeof keys)[number], string> => typeof key !== "string",
  );

  counts.gateway = keys.length;
  counts.sessions = config.recording?.enabled === true ? 1 : 0;
  counts.groups = usedGroups.length;
  counts.routing = usedGroups.length;
  counts.rotation = usedGroups.filter(
    (group) =>
      (group.strategy !== undefined && group.strategy !== "order") || group.weighted === true,
  ).length;

  const masking = config.masking;
  counts.redact =
    masking?.enabled === true || masking?.personal === true || (masking?.words?.length ?? 0) > 0
      ? 1
      : 0;

  const otel = (config.otel ?? {}) as { enabled?: unknown; endpoint?: unknown };
  counts.otel = otel.enabled === true && Boolean(otel.endpoint) ? 1 : 0;
  counts.search = config.search?.enabled === true ? 1 : 0;
  counts.warmups = countWarmups(config, accounts);
  counts.middleware = countMiddleware(config);
  counts.budget = countBudgets(budgetKeys, accounts);
  return counts;
}

function countWarmups(
  config: GatewayConfig,
  accounts: ReadonlyArray<{
    warmup?: boolean | undefined;
    warmAt?: string | undefined;
    autoReset?: "week" | "expiring" | "auto" | undefined;
  }>,
): number {
  let count = 0;
  if (config.codexWarmup !== undefined && config.codexWarmup !== "off") count += 1;
  if (config.claudeWarmup !== undefined && config.claudeWarmup !== "off") count += 1;
  count += ((config.codexWarmAts as string[] | undefined) ?? []).length;
  count += ((config.claudeWarmAts as string[] | undefined) ?? []).length;
  // An account's own reset timer and its lead are warm-up settings too.
  if ((config as { codexResetLead?: unknown }).codexResetLead !== undefined) count += 1;
  for (const account of accounts) {
    if (account.warmup === true) count += 1;
    if (account.warmAt && account.warmAt !== "off") count += 1;
    if (account.autoReset !== undefined) count += 1;
  }
  return count;
}

function countMiddleware(config: GatewayConfig): number {
  const middleware = config.middleware as
    | { aliases?: Record<string, string>; overrides?: unknown[]; hooks?: Record<string, unknown> }
    | undefined;
  if (!middleware) return 0;
  let count = Object.keys(middleware.aliases ?? {}).length + (middleware.overrides?.length ?? 0);
  for (const hook of Object.values(middleware.hooks ?? {})) {
    if (typeof hook === "string" && hook.trim()) count += 1;
  }
  return count;
}

function countBudgets(
  keys: ReadonlyArray<{
    dailyTokens?: number | undefined;
    monthlyUsd?: number | undefined;
    limits?: readonly unknown[] | undefined;
  }>,
  accounts: ReadonlyArray<{ monthlyUsd?: number | undefined }>,
): number {
  let count = accounts.filter((account) => account.monthlyUsd !== undefined).length;
  for (const key of keys) {
    if (
      key.dailyTokens !== undefined ||
      key.monthlyUsd !== undefined ||
      (key.limits !== undefined && key.limits.length > 0)
    ) {
      count += 1;
    }
  }
  return count;
}

/** The gateway page's "recent calls" size, or myna's default when it is unset. */
export function gatewayCallsPageOf(
  config:
    | { readonly builtinFeatureConfig?: { readonly gateway?: { readonly callsPage?: number } } }
    | undefined,
): number {
  return config?.builtinFeatureConfig?.gateway?.callsPage ?? DEFAULT_NEOLIX_GATEWAY_CALLS_PAGE;
}
