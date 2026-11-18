import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { PluginIdSchema, PluginRequirementsSchema } from "@neolix/protocol/messages";
import {
  PluginContributionsSchema,
  PluginWebSchema,
  type PluginContributionAction,
  type PluginContributions,
  type PluginWeb,
} from "@neolix/protocol/plugin-contributions";
import { validatePluginRequirements } from "@neolix/protocol/plugin-requirements";

const MANIFEST_FILENAME = "neox-plugin.json";
const PluginBuildCommandSchema = z
  .array(z.string().refine((argument) => argument.trim().length > 0))
  .min(1);
// Manifest asset paths use forward slashes and stay inside the plugin package.
const PluginAssetPathSchema = z
  .string()
  .min(1)
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
const PluginManifestSchema = z.object({
  id: PluginIdSchema,
  name: z.string().trim().min(1).optional(),
  description: z.string().trim().min(1).optional(),
  icon: PluginAssetPathSchema.refine(
    (value) => /\.png$/i.test(value),
    "Expected a relative path to a PNG",
  ).optional(),
  media: z.array(z.union([PluginAssetPathSchema, z.url({ protocol: /^https$/ })])).optional(),
  // A misspelled requirement must not silently disable compatibility checks.
  requirements: PluginRequirementsSchema.strict().optional(),
  build: z.array(PluginBuildCommandSchema).min(1).optional(),
  /** Contributions a non-RN host renders natively instead of running the client bundle. */
  contributions: PluginContributionsSchema.optional(),
  /** Sandboxed web view entries. Absent means the plugin has no custom web UI. */
  web: PluginWebSchema.optional(),
});

export type PluginManifest = z.infer<typeof PluginManifestSchema>;

/**
 * Cross-checks that declarations point at things that exist. A dangling view reference would
 * render a dead sidebar row or command, so it fails at manifest read time instead.
 */
export function validateManifestContributions(manifest: PluginManifest): void {
  const views = validateWebViews(manifest.web);
  if (manifest.contributions) validateContributions(manifest.contributions, views);
}

function validateWebViews(web: PluginWeb | undefined): ReadonlySet<string> {
  const views = web?.views ?? [];
  const duplicate = findDuplicateId(views.map((view) => view.id));
  if (duplicate) throw new Error(`Duplicate plugin web view ID: ${duplicate}`);
  for (const view of views) {
    if (view.permissions?.includes("rpc") && (view.rpcs?.length ?? 0) === 0)
      throw new Error(`Web view "${view.id}" grants "rpc" without listing any RPC methods`);
  }
  return new Set(views.map((view) => view.id));
}

/** Every contribution ID, namespaced by kind, in the order the manifest declares them. */
function contributionIds(contributions: PluginContributions): string[] {
  return [
    ...(contributions.commands ?? []).map((item) => `command:${item.id}`),
    ...(contributions.sidebarItems ?? []).map((item) => `sidebar:${item.id}`),
    ...(contributions.panels ?? []).map((item) => `panel:${item.id}`),
    ...(contributions.composerPills ?? []).map((item) => `pill:${item.id}`),
    ...(contributions.attachmentSources ?? []).map((item) => `attachment:${item.id}`),
    ...(contributions.themes ?? []).map((item) => `theme:${item.id}`),
    ...(contributions.timelineItems ?? []).map((item) => `timeline:${item.kind}:${item.version}`),
  ];
}

function validateContributions(
  contributions: PluginContributions,
  views: ReadonlySet<string>,
): void {
  const duplicate = findDuplicateId(contributionIds(contributions));
  if (duplicate) throw new Error(`Duplicate plugin contribution ID: ${duplicate}`);
  for (const item of contributions.sidebarItems ?? []) assertKnownView(item.view, views, item.id);
  for (const item of contributions.panels ?? [])
    assertKnownView(item.view, views, `panel "${item.id}"`);
  for (const item of contributions.commands ?? [])
    assertActionView(item.action, views, `command "${item.id}"`);
  for (const item of contributions.slashCommands ?? [])
    assertActionView(item.action, views, `slash command "${item.name}"`);
  for (const item of contributions.composerPills ?? [])
    assertActionView(item.action, views, `composer pill "${item.id}"`);
  for (const item of contributions.timelineItems ?? []) {
    if (item.view) assertKnownView(item.view, views, `timeline item "${item.kind}"`);
  }
}

function assertKnownView(view: string, views: ReadonlySet<string>, label: string): void {
  if (!views.has(view)) throw new Error(`${label} references unknown view "${view}"`);
}

function findDuplicateId(values: readonly string[]): string | null {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return null;
}

function assertActionView(
  action: PluginContributionAction,
  views: ReadonlySet<string>,
  label: string,
): void {
  if (action.kind === "openView" && !views.has(action.view))
    throw new Error(`${label} references unknown view "${action.view}"`);
}

export async function readPluginManifest(directory: string): Promise<PluginManifest> {
  const manifestPath = path.join(directory, MANIFEST_FILENAME);
  const info = await stat(manifestPath).catch(() => null);
  if (!info?.isFile()) throw new Error(`Plugin manifest is missing: ${manifestPath}`);
  const manifest = PluginManifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
  validatePluginRequirements(manifest.requirements);
  validateManifestContributions(manifest);
  return manifest;
}
