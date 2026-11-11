import { z } from "zod";

/**
 * Declarative plugin contributions.
 *
 * The Neolix plugin SDK registers contributions by running client code. A host that cannot run a
 * React Native client bundle (the Synara-based desktop web app) renders these manifest declarations
 * natively instead. Custom UI stays behind a sandboxed iframe view, selected by `web.views[].id`.
 *
 * Wire rules from `docs/protocol-compatibility.md`: every field is optional and additive, and
 * schemas never transform. Old daemons omit `contributions`/`web`; old clients ignore them.
 */

/** Contribution and view IDs share one shape: lowercase, dash-separated, URL-safe. */
export const PluginContributionIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9-]*$/);
export type PluginContributionId = z.infer<typeof PluginContributionIdSchema>;

/** Slash commands keep their leading-slash spelling out of the value, as the SDK does. */
export const PluginSlashCommandNameSchema = z
  .string()
  .min(1)
  .max(64)
  .check(z.regex(/^[a-z0-9][a-z0-9-]*$/));

/** JSON payloads have already crossed serialization; validation happens at the plugin boundary. */
const PluginJsonValueSchema = z.unknown();

/** A relative path inside the plugin package. */
export const PluginWebAssetPathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      value === value.trim() &&
      !value.startsWith("/") &&
      !/[\\:?#\p{Cc}]/u.test(value) &&
      !value.split("/").includes("..") &&
      !value.endsWith("/") &&
      value.split("/").at(-1) !== ".",
    "Expected a relative file path inside the plugin package",
  );

/**
 * What a declarative contribution does when the user activates it.
 *
 * `pluginRpc` calls one of the plugin server's RPC methods through the ordinary plugin RPC
 * transport. `openView` opens one of the plugin's declared web views.
 */
export const PluginContributionActionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("pluginRpc"),
    method: z.string().min(1).max(200),
    input: PluginJsonValueSchema.optional(),
  }),
  z.object({
    kind: z.literal("openView"),
    view: PluginContributionIdSchema,
    params: z.record(z.string(), z.string()).optional(),
  }),
]);
export type PluginContributionAction = z.infer<typeof PluginContributionActionSchema>;

export const PluginContributionContextSchema = z.enum(["global", "workspace", "agent"]);
export type PluginContributionContext = z.infer<typeof PluginContributionContextSchema>;

/** A Command Center item rendered in the host's command palette. */
export const PluginCommandContributionSchema = z.object({
  id: PluginContributionIdSchema,
  title: z.string().min(1).max(200),
  icon: z.string().min(1).max(64).optional(),
  keywords: z.array(z.string().min(1).max(64)).max(32).optional(),
  context: PluginContributionContextSchema,
  action: PluginContributionActionSchema,
});
export type PluginCommandContribution = z.infer<typeof PluginCommandContributionSchema>;

/** A composer slash command. The host owns the leading `/` and substitutes `{args}`. */
export const PluginSlashCommandContributionSchema = z.object({
  name: PluginSlashCommandNameSchema,
  description: z.string().min(1).max(300),
  argumentHint: z.string().max(200).optional(),
  context: z.enum(["workspace", "agent"]),
  action: PluginContributionActionSchema,
});
export type PluginSlashCommandContribution = z.infer<typeof PluginSlashCommandContributionSchema>;

/** A sidebar page entry. Selecting it opens the referenced web view. */
export const PluginSidebarItemContributionSchema = z.object({
  id: PluginContributionIdSchema,
  title: z.string().min(1).max(200),
  icon: z.string().min(1).max(64).optional(),
  section: z.enum(["header", "footer"]).optional(),
  /** Lower numbers sort first; ties fall back to plugin ID then contribution ID. */
  order: z.number().int().optional(),
  view: PluginContributionIdSchema,
});
export type PluginSidebarItemContribution = z.infer<typeof PluginSidebarItemContributionSchema>;

/** A control in the composer's trailing cluster. */
export const PluginComposerPillContributionSchema = z.object({
  id: PluginContributionIdSchema,
  title: z.string().min(1).max(200),
  icon: z.string().min(1).max(64).optional(),
  context: z.enum(["workspace", "agent"]),
  action: PluginContributionActionSchema,
});
export type PluginComposerPillContribution = z.infer<typeof PluginComposerPillContributionSchema>;

/**
 * A composer attachment source. The host calls `search.method` with `{ query }` and expects
 * `{ items: [{ id, title, subtitle?, insertText }] }`; picking an item inserts `insertText`
 * into the composer through `pick.template` (`{title}`, `{insertText}`).
 */
export const PluginAttachmentSourceContributionSchema = z.object({
  id: PluginContributionIdSchema,
  title: z.string().min(1).max(200),
  icon: z.string().min(1).max(64).optional(),
  search: z.object({
    method: z.string().min(1).max(200),
    input: PluginJsonValueSchema.optional(),
  }),
  pick: z.object({ template: z.string().min(1).max(500) }).optional(),
});
export type PluginAttachmentSourceContribution = z.infer<
  typeof PluginAttachmentSourceContributionSchema
>;

export const PluginThemeColorsSchema = z.object({
  background: z.string().min(1),
  foreground: z.string().min(1),
  raised: z.string().min(1),
  control: z.string().min(1),
  border: z.string().min(1),
  accent: z.string().optional(),
  mutedForeground: z.string().min(1),
  ring: z.string().min(1),
});
export type PluginThemeColors = z.infer<typeof PluginThemeColorsSchema>;

/** An app theme. The host maps these semantic colors onto its own tokens. */
export const PluginThemeContributionSchema = z.object({
  id: PluginContributionIdSchema,
  name: z.string().min(1).max(200),
  appearance: z.enum(["light", "dark"]),
  colors: PluginThemeColorsSchema,
});
export type PluginThemeContribution = z.infer<typeof PluginThemeContributionSchema>;

/**
 * A timeline item kind. With `view`, the host renders the item in the declared sandboxed view and
 * sends the item as data. Without `view`, the host renders `card` with its own activity card.
 */
export const PluginTimelineItemContributionSchema = z.object({
  kind: z.string().min(1).max(100),
  version: z.number().int().positive(),
  title: z.string().min(1).max(200),
  tone: z.enum(["info", "success", "warning", "danger"]).optional(),
  view: PluginContributionIdSchema.optional(),
});
export type PluginTimelineItemContribution = z.infer<typeof PluginTimelineItemContributionSchema>;

export const PluginContributionsSchema = z.object({
  commands: z.array(PluginCommandContributionSchema).max(128).optional(),
  slashCommands: z.array(PluginSlashCommandContributionSchema).max(128).optional(),
  sidebarItems: z.array(PluginSidebarItemContributionSchema).max(128).optional(),
  composerPills: z.array(PluginComposerPillContributionSchema).max(64).optional(),
  attachmentSources: z.array(PluginAttachmentSourceContributionSchema).max(32).optional(),
  themes: z.array(PluginThemeContributionSchema).max(32).optional(),
  timelineItems: z.array(PluginTimelineItemContributionSchema).max(128).optional(),
});
export type PluginContributions = z.infer<typeof PluginContributionsSchema>;

/** Permissions a sandboxed web view can request from its host. */
export const PluginWebViewPermissionSchema = z.enum(["rpc", "navigate", "resize"]);
export type PluginWebViewPermission = z.infer<typeof PluginWebViewPermissionSchema>;

export const PluginWebViewSchema = z.object({
  id: PluginContributionIdSchema,
  title: z.string().min(1).max(200),
  /** Self-contained HTML entry inside the plugin package. */
  entry: PluginWebAssetPathSchema.refine(
    (value) => /\.html$/i.test(value),
    "Expected a relative HTML file path",
  ),
  /** Granted host APIs. Empty/missing means the view is display-only. */
  permissions: z.array(PluginWebViewPermissionSchema).max(8).optional(),
  /** Plugin RPC methods this view may call. Required for the `rpc` permission. */
  rpcs: z.array(z.string().min(1).max(200)).max(128).optional(),
});
export type PluginWebView = z.infer<typeof PluginWebViewSchema>;

export const PluginWebSchema = z.object({
  views: z.array(PluginWebViewSchema).max(64),
});
export type PluginWeb = z.infer<typeof PluginWebSchema>;
