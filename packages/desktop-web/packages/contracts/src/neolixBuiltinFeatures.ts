// FILE: neolixBuiltinFeatures.ts
// Purpose: The daemon's built-in feature switches (`builtinFeatures` in its
//   config), the per-feature settings kept beside them, and the ids the
//   Plugins page shows. The bridge already forwards the daemon config through
//   `neolix.host.getConfig`/`patchConfig`, so these are wire shapes rather
//   than an RPC group of their own.
// Layer: Contracts

export const NEOLIX_BUILTIN_FEATURE_IDS = [
  "sessions",
  "library",
  "routing",
  "usage",
  "gateway",
  "redact",
  "otel",
  "warmups",
  "groups",
  "rotation",
  "middleware",
  "budget",
  "tools",
  "search",
] as const;

export type NeolixBuiltinFeatureId = (typeof NEOLIX_BUILTIN_FEATURE_IDS)[number];

/** A feature's switch: false turns it off; a missing id is on. */
export type NeolixBuiltinFeatures = Readonly<Partial<Record<NeolixBuiltinFeatureId, boolean>>>;

/** myna's gateway plugin schema: how many recent calls the page shows before "Show more". */
export const NEOLIX_GATEWAY_CALLS_PAGE_OPTIONS = [10, 20, 50, 100] as const;
export const DEFAULT_NEOLIX_GATEWAY_CALLS_PAGE = 20;

/** Per-feature settings myna keeps beside the switches (`pluginConfig` in its gui config). */
export interface NeolixBuiltinFeatureConfig {
  readonly gateway?: {
    readonly callsPage?: number;
  };
}
