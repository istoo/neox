// FILE: neolixProjectIcons.ts
// Purpose: RPC schemas for the daemon's project-icon surface: the icon the host
//   resolved for a project (custom upload or automatic discovery), the legacy
//   cwd lookup older hosts answer, and the write that replaces it. The bridge
//   forwards each method to `project.icon.*` / `project_icon_request`.
// Layer: Contracts

import { Schema } from "effect";
import { ProjectId, TrimmedNonEmptyString } from "./baseSchemas";

export const NEOLIX_PROJECT_ICON_WS_METHODS = {
  get: "neolix.projectIcons.get",
  request: "neolix.projectIcons.request",
  set: "neolix.projectIcons.set",
} as const;

export type NeolixProjectIconWsMethod =
  (typeof NEOLIX_PROJECT_ICON_WS_METHODS)[keyof typeof NEOLIX_PROJECT_ICON_WS_METHODS];

/** Base64 bytes plus the type the host detected; the web renders it as a data URI. */
export const ProjectIcon = Schema.Struct({
  data: Schema.String,
  mimeType: Schema.String,
});
export type ProjectIcon = typeof ProjectIcon.Type;

/** `automatic` clears a custom upload and returns to repository discovery. */
export const ProjectIconSource = Schema.Union([
  Schema.Struct({ type: Schema.Literal("automatic") }),
  Schema.Struct({ type: Schema.Literal("upload"), data: Schema.String }),
]);
export type ProjectIconSource = typeof ProjectIconSource.Type;

export const ProjectIconGetInput = Schema.Struct({ projectId: ProjectId });
export type ProjectIconGetInput = typeof ProjectIconGetInput.Type;

export const ProjectIconGetResult = Schema.Struct({
  icon: Schema.NullOr(ProjectIcon),
  /**
   * False on hosts that predate custom uploads. The automatic icon still
   * resolves, so the caller uses `request` instead of hiding the glyph.
   */
  supportsCustomIcons: Schema.Boolean,
});
export type ProjectIconGetResult = typeof ProjectIconGetResult.Type;

/** Legacy lookup: hosts without custom icons resolve discovery from the cwd. */
export const ProjectIconRequestInput = Schema.Struct({ cwd: TrimmedNonEmptyString });
export type ProjectIconRequestInput = typeof ProjectIconRequestInput.Type;

export const ProjectIconRequestResult = Schema.Struct({
  icon: Schema.NullOr(ProjectIcon),
});
export type ProjectIconRequestResult = typeof ProjectIconRequestResult.Type;

export const ProjectIconSetInput = Schema.Struct({
  projectId: ProjectId,
  source: ProjectIconSource,
});
export type ProjectIconSetInput = typeof ProjectIconSetInput.Type;

export const ProjectIconSetResult = Schema.Struct({});
export type ProjectIconSetResult = typeof ProjectIconSetResult.Type;
