/**
 * Neolix workspace metadata.
 *
 * Synara's `Thread` is a Neolix agent; the daemon's workspace carries the title, pin, labels and
 * unread mark that the old React Native UI exposed. These reads/writes are keyed by thread id and
 * resolve the agent's `workspaceId` inside the bridge, so the fork's UI never has to know the
 * daemon's workspace directory bookkeeping.
 */
import { Schema } from "effect";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas";

export const NeolixWorkspaceLabelColor = Schema.Literals([
  "violet",
  "sky",
  "emerald",
  "orange",
  "pink",
  "indigo",
  "teal",
  "red",
  "amber",
  "blue",
]);
export type NeolixWorkspaceLabelColor = typeof NeolixWorkspaceLabelColor.Type;

export const NeolixWorkspaceLabelDefinition = Schema.Struct({
  name: Schema.String,
  color: NeolixWorkspaceLabelColor,
});
export type NeolixWorkspaceLabelDefinition = typeof NeolixWorkspaceLabelDefinition.Type;

export const NeolixWorkspace = Schema.Struct({
  id: TrimmedNonEmptyString,
  projectId: TrimmedNonEmptyString,
  name: Schema.String,
  title: Schema.NullOr(Schema.String),
  directory: Schema.String,
  pinnedAt: Schema.NullOr(IsoDateTime),
  labels: Schema.Array(Schema.String),
  activityAt: Schema.NullOr(IsoDateTime),
  status: Schema.String,
  // Row display fields (branch / CI / diff / services). Optional so an older bridge that
  // only sent the identity fields still decodes.
  branch: Schema.optional(Schema.NullOr(Schema.String)),
  checksStatus: Schema.optional(
    Schema.NullOr(Schema.Literals(["none", "pending", "success", "failure"])),
  ),
  diffStat: Schema.optional(
    Schema.NullOr(Schema.Struct({ additions: Schema.Number, deletions: Schema.Number })),
  ),
  runningServiceCount: Schema.optional(Schema.Number),
});
export type NeolixWorkspace = typeof NeolixWorkspace.Type;

export const NeolixWorkspacesListInput = Schema.Struct({});
export const NeolixWorkspacesListResult = Schema.Struct({
  workspaces: Schema.Array(NeolixWorkspace),
});
export type NeolixWorkspacesListResult = typeof NeolixWorkspacesListResult.Type;

export const NeolixWorkspaceLabelsResult = Schema.Struct({
  labels: Schema.Array(NeolixWorkspaceLabelDefinition),
});
export type NeolixWorkspaceLabelsResult = typeof NeolixWorkspaceLabelsResult.Type;

export const NeolixWorkspaceTargetInput = Schema.Struct({
  /** The thread whose agent names the workspace. */
  threadId: Schema.optional(TrimmedNonEmptyString),
  /** An explicit workspace, when the caller already has one. */
  workspaceId: Schema.optional(TrimmedNonEmptyString),
});
export type NeolixWorkspaceTargetInput = typeof NeolixWorkspaceTargetInput.Type;

export const NeolixWorkspaceSetPinnedInput = Schema.Struct({
  threadId: Schema.optional(TrimmedNonEmptyString),
  workspaceId: Schema.optional(TrimmedNonEmptyString),
  pinned: Schema.Boolean,
});
export type NeolixWorkspaceSetPinnedInput = typeof NeolixWorkspaceSetPinnedInput.Type;
export const NeolixWorkspaceSetPinnedResult = Schema.Struct({
  pinnedAt: Schema.NullOr(IsoDateTime),
});
export type NeolixWorkspaceSetPinnedResult = typeof NeolixWorkspaceSetPinnedResult.Type;

export const NeolixWorkspaceSetTitleInput = Schema.Struct({
  threadId: Schema.optional(TrimmedNonEmptyString),
  workspaceId: Schema.optional(TrimmedNonEmptyString),
  title: Schema.NullOr(Schema.String),
});
export type NeolixWorkspaceSetTitleInput = typeof NeolixWorkspaceSetTitleInput.Type;
export const NeolixWorkspaceSetTitleResult = Schema.Struct({
  title: Schema.NullOr(Schema.String),
});
export type NeolixWorkspaceSetTitleResult = typeof NeolixWorkspaceSetTitleResult.Type;

export const NeolixWorkspaceSetLabelInput = Schema.Struct({
  threadId: Schema.optional(TrimmedNonEmptyString),
  workspaceId: Schema.optional(TrimmedNonEmptyString),
  label: NeolixWorkspaceLabelDefinition,
  assigned: Schema.Boolean,
});
export type NeolixWorkspaceSetLabelInput = typeof NeolixWorkspaceSetLabelInput.Type;
export const NeolixWorkspaceSetLabelResult = Schema.Struct({
  labels: Schema.Array(Schema.String),
});
export type NeolixWorkspaceSetLabelResult = typeof NeolixWorkspaceSetLabelResult.Type;

export const NeolixWorkspaceMarkUnreadInput = Schema.Struct({
  threadId: Schema.optional(TrimmedNonEmptyString),
  workspaceId: Schema.optional(TrimmedNonEmptyString),
});
export type NeolixWorkspaceMarkUnreadInput = typeof NeolixWorkspaceMarkUnreadInput.Type;
export const NeolixWorkspaceMarkUnreadResult = Schema.Struct({});
export type NeolixWorkspaceMarkUnreadResult = typeof NeolixWorkspaceMarkUnreadResult.Type;

/** Rename and/or recolor one catalog entry. The daemon answers with the affected workspace count. */
export const NeolixWorkspaceUpdateLabelInput = Schema.Struct({
  name: TrimmedNonEmptyString,
  newName: Schema.optional(TrimmedNonEmptyString),
  color: Schema.optional(NeolixWorkspaceLabelColor),
});
export type NeolixWorkspaceUpdateLabelInput = typeof NeolixWorkspaceUpdateLabelInput.Type;
export const NeolixWorkspaceUpdateLabelResult = Schema.Struct({
  label: NeolixWorkspaceLabelDefinition,
  affectedWorkspaceCount: Schema.Number,
});
export type NeolixWorkspaceUpdateLabelResult = typeof NeolixWorkspaceUpdateLabelResult.Type;

export const NeolixWorkspaceDeleteLabelInput = Schema.Struct({
  name: TrimmedNonEmptyString,
});
export type NeolixWorkspaceDeleteLabelInput = typeof NeolixWorkspaceDeleteLabelInput.Type;

export const NeolixWorkspaceInspectLabelDeleteInput = Schema.Struct({
  name: TrimmedNonEmptyString,
});
export type NeolixWorkspaceInspectLabelDeleteInput =
  typeof NeolixWorkspaceInspectLabelDeleteInput.Type;
export const NeolixWorkspaceLabelDeleteResult = Schema.Struct({
  affectedWorkspaceCount: Schema.Number,
});
export type NeolixWorkspaceLabelDeleteResult = typeof NeolixWorkspaceLabelDeleteResult.Type;

/** Archive a whole Neolix workspace (its agents, terminals and setup runtime). */
export const NeolixWorkspaceArchiveInput = NeolixWorkspaceTargetInput;
export type NeolixWorkspaceArchiveInput = typeof NeolixWorkspaceArchiveInput.Type;
export const NeolixWorkspaceArchiveResult = Schema.Struct({
  archivedAt: Schema.NullOr(IsoDateTime),
});
export type NeolixWorkspaceArchiveResult = typeof NeolixWorkspaceArchiveResult.Type;

/**
 * Recovery is the only restore route. Restoring revives the workspace record and every agent the
 * archive took down; inspect reports what restore would do before the user commits.
 */
export const NeolixWorkspaceRecoveryInput = Schema.Struct({
  workspaceId: TrimmedNonEmptyString,
});
export type NeolixWorkspaceRecoveryInput = typeof NeolixWorkspaceRecoveryInput.Type;
export const NeolixWorkspaceRecoveryResult = Schema.Struct({
  kind: Schema.Literals(["recoverable", "unavailable"]),
  workspaceName: Schema.optional(Schema.String),
  action: Schema.optional(Schema.String),
  branch: Schema.optional(Schema.NullOr(Schema.String)),
  reason: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
});
export type NeolixWorkspaceRecoveryResult = typeof NeolixWorkspaceRecoveryResult.Type;
export const NeolixWorkspaceRestoreResult = Schema.Struct({});
export type NeolixWorkspaceRestoreResult = typeof NeolixWorkspaceRestoreResult.Type;

/**
 * A workspace the host no longer lists as active but whose archived agents still exist.
 * The daemon has no workspace-archive directory RPC, so the bridge derives this list from
 * archived agents grouped by workspace id. `title` is the most recent archived agent title.
 */
export const NeolixArchivedWorkspace = Schema.Struct({
  workspaceId: TrimmedNonEmptyString,
  directory: Schema.String,
  title: Schema.NullOr(Schema.String),
  projectName: Schema.NullOr(Schema.String),
  archivedAt: IsoDateTime,
  agentCount: Schema.Number,
});
export type NeolixArchivedWorkspace = typeof NeolixArchivedWorkspace.Type;

export const NeolixArchivedWorkspacesListInput = Schema.Struct({});
export type NeolixArchivedWorkspacesListInput = typeof NeolixArchivedWorkspacesListInput.Type;
export const NeolixArchivedWorkspacesListResult = Schema.Struct({
  workspaces: Schema.Array(NeolixArchivedWorkspace),
});
export type NeolixArchivedWorkspacesListResult = typeof NeolixArchivedWorkspacesListResult.Type;
