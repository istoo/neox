import { z } from "zod";

/**
 * myna's built-in plugins (internal/pluginrt, plugins/*): the optional parts of the window.
 * The ids match myna's, so a feature switched off there means the same thing here.
 */
export const BUILTIN_FEATURE_IDS = [
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

export type BuiltinFeatureId = (typeof BUILTIN_FEATURE_IDS)[number];

export const BuiltinFeatureIdSchema = z.enum(BUILTIN_FEATURE_IDS);

/** A feature's switch: false turns it off; a missing id is on, as a missing myna row is. */
export const BuiltinFeaturesSchema = z.partialRecord(BuiltinFeatureIdSchema, z.boolean());
export type BuiltinFeatures = z.infer<typeof BuiltinFeaturesSchema>;

export function isBuiltinFeatureId(value: string): value is BuiltinFeatureId {
  return (BUILTIN_FEATURE_IDS as readonly string[]).includes(value);
}

/** myna's gateway plugin schema: how many recent calls the page shows before "Show more". */
export const GATEWAY_CALLS_PAGE_OPTIONS = [10, 20, 50, 100] as const;
export const DEFAULT_GATEWAY_CALLS_PAGE = 20;

/**
 * Per-feature settings myna keeps beside the switches (`pluginConfig` in its gui config). Only
 * the values Neolix has a use for are modelled; an absent value means myna's default.
 */
export const BuiltinFeatureConfigSchema = z.object({
  gateway: z
    .object({
      callsPage: z.number().int().positive().optional(),
    })
    .optional(),
});
export type BuiltinFeatureConfig = z.infer<typeof BuiltinFeatureConfigSchema>;

/**
 * What a feature hides in Neolix. `hostSections` are settings sidebar sections, `settingsPages`
 * are app settings pages, and `sidebarItems` are the main sidebar's built-in rows. Empty arrays
 * mean Neolix has no surface for that myna feature yet; its switch is still kept.
 */
export interface BuiltinFeatureSurfaces {
  hostSections: readonly string[];
  settingsPages: readonly string[];
  sidebarItems: readonly string[];
}

export const BUILTIN_FEATURE_SURFACES: Record<BuiltinFeatureId, BuiltinFeatureSurfaces> = {
  sessions: { hostSections: ["sessions"], settingsPages: [], sidebarItems: ["history"] },
  library: { hostSections: ["library"], settingsPages: [], sidebarItems: [] },
  routing: { hostSections: ["gateway-routing"], settingsPages: [], sidebarItems: [] },
  usage: {
    hostSections: ["usage"],
    settingsPages: ["quota"],
    sidebarItems: ["usage"],
  },
  gateway: { hostSections: ["gateway"], settingsPages: [], sidebarItems: [] },
  redact: { hostSections: ["masking"], settingsPages: ["privacy"], sidebarItems: [] },
  otel: { hostSections: [], settingsPages: ["observability"], sidebarItems: [] },
  warmups: { hostSections: [], settingsPages: [], sidebarItems: [] },
  groups: { hostSections: [], settingsPages: [], sidebarItems: [] },
  rotation: { hostSections: [], settingsPages: [], sidebarItems: [] },
  middleware: { hostSections: [], settingsPages: [], sidebarItems: [] },
  budget: { hostSections: [], settingsPages: [], sidebarItems: [] },
  tools: { hostSections: [], settingsPages: [], sidebarItems: [] },
  search: { hostSections: [], settingsPages: [], sidebarItems: [] },
};

/** Every surface the given switches turn off. A missing switch is on. */
export function hiddenBuiltinSurfaces(features: BuiltinFeatures | undefined): {
  hostSections: Set<string>;
  settingsPages: Set<string>;
  sidebarItems: Set<string>;
} {
  const hostSections = new Set<string>();
  const settingsPages = new Set<string>();
  const sidebarItems = new Set<string>();
  for (const id of BUILTIN_FEATURE_IDS) {
    if (features?.[id] !== false) continue;
    const surfaces = BUILTIN_FEATURE_SURFACES[id];
    for (const section of surfaces.hostSections) hostSections.add(section);
    for (const page of surfaces.settingsPages) settingsPages.add(page);
    for (const item of surfaces.sidebarItems) sidebarItems.add(item);
  }
  return { hostSections, settingsPages, sidebarItems };
}
