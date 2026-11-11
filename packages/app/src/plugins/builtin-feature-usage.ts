import type { GatewayConfigWire } from "@neolix/protocol/gateway";
import { BUILTIN_FEATURE_IDS, type BuiltinFeatureId } from "@neolix/protocol/plugin-features";

/**
 * What each feature has in use, as myna counts it for its InUse plugins. A feature with something
 * in use stays on whatever the switch says, so a user can still see and change it.
 */
export function builtinFeatureUseCounts(
  gateway: GatewayConfigWire | null | undefined,
): Record<BuiltinFeatureId, number> {
  const counts = Object.fromEntries(BUILTIN_FEATURE_IDS.map((id) => [id, 0] as const)) as Record<
    BuiltinFeatureId,
    number
  >;
  if (!gateway) return counts;

  const groups = gateway.groups ?? [];
  const usedGroups = groups.filter((group) => group.disabled !== true);
  const accounts = (gateway.providers ?? []).flatMap((provider) => provider.accounts ?? []);
  const keys = gateway.keys ?? [];
  const budgetKeys = keys.filter(
    (key): key is Exclude<(typeof keys)[number], string> => typeof key !== "string",
  );

  counts.gateway = keys.length;
  counts.sessions = gateway.recording?.enabled === true ? 1 : 0;
  counts.groups = usedGroups.length;
  counts.routing = usedGroups.length;
  counts.rotation = usedGroups.filter(
    // `order` is the schema's default, so only another strategy shows the user picked one.
    (group) => (group.strategy !== undefined && group.strategy !== "order") || group.weighted,
  ).length;
  const masking = gateway.masking;
  counts.redact =
    masking?.enabled === true || masking?.personal === true || (masking?.words?.length ?? 0) > 0
      ? 1
      : 0;
  counts.otel = gateway.otel?.enabled === true && Boolean(gateway.otel.endpoint) ? 1 : 0;
  counts.search = gateway.search?.enabled === true ? 1 : 0;
  counts.warmups = countWarmups(gateway, accounts);
  counts.middleware = countMiddleware(gateway);
  counts.budget = countBudgets(budgetKeys, accounts);
  return counts;
}

function countWarmups(
  gateway: GatewayConfigWire,
  accounts: readonly {
    warmup?: boolean | undefined;
    warmAt?: string | undefined;
    autoReset?: "week" | "expiring" | "auto" | undefined;
  }[],
): number {
  let count = 0;
  if (gateway.codexWarmup !== undefined && gateway.codexWarmup !== "off") count += 1;
  if (gateway.claudeWarmup !== undefined && gateway.claudeWarmup !== "off") count += 1;
  count += (gateway.codexWarmAts ?? []).length;
  count += (gateway.claudeWarmAts ?? []).length;
  // An account's own reset timer and the lead it spends by are warm-up settings too.
  if (gateway.codexResetLead !== undefined) count += 1;
  for (const account of accounts) {
    if (account.warmup === true) count += 1;
    if (account.warmAt && account.warmAt !== "off") count += 1;
    if (account.autoReset !== undefined) count += 1;
  }
  return count;
}

function countMiddleware(gateway: GatewayConfigWire): number {
  const middleware = gateway.middleware;
  if (!middleware) return 0;
  let count = Object.keys(middleware.aliases ?? {}).length + (middleware.overrides?.length ?? 0);
  for (const hook of Object.values(middleware.hooks ?? {})) {
    if (typeof hook === "string" && hook.trim()) count += 1;
  }
  return count;
}

function countBudgets(
  keys: readonly {
    dailyTokens?: number | undefined;
    monthlyUsd?: number | undefined;
    limits?: readonly unknown[] | undefined;
  }[],
  accounts: readonly { monthlyUsd?: number | undefined }[],
): number {
  let count = accounts.filter((account) => account.monthlyUsd !== undefined).length;
  for (const key of keys) {
    if (
      key.dailyTokens !== undefined ||
      key.monthlyUsd !== undefined ||
      (key.limits !== undefined && key.limits.length > 0)
    )
      count += 1;
  }
  return count;
}
