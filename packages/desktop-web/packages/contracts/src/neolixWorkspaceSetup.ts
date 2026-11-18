// FILE: neolixWorkspaceSetup.ts
// Purpose: RPC schemas for observing and re-running a workspace's worktree setup. The
//   daemon already exposes `workspace.setup.subscribe` / `workspace.setup.run` over its
//   owned-subscription protocol; the bridge republishes that snapshot to the web renderer
//   as a regular Effect RPC stream keyed by workspace id.
// Layer: Contracts

import { Schema } from "effect";

export const NEOLIX_WORKSPACE_SETUP_WS_METHODS = {
  subscribe: "neolix.workspaceSetup.subscribe",
  run: "neolix.workspaceSetup.run",
} as const;

export type NeolixWorkspaceSetupWsMethod =
  (typeof NEOLIX_WORKSPACE_SETUP_WS_METHODS)[keyof typeof NEOLIX_WORKSPACE_SETUP_WS_METHODS];

export const WorkspaceSetupCommandStatus = Schema.Literals(["running", "completed", "failed"]);
export type WorkspaceSetupCommandStatus = typeof WorkspaceSetupCommandStatus.Type;

export const WorkspaceSetupCommand = Schema.Struct({
  index: Schema.Number,
  command: Schema.String,
  cwd: Schema.optional(Schema.String),
  log: Schema.optional(Schema.String),
  status: WorkspaceSetupCommandStatus,
  exitCode: Schema.optional(Schema.NullOr(Schema.Number)),
  durationMs: Schema.optional(Schema.Number),
});
export type WorkspaceSetupCommand = typeof WorkspaceSetupCommand.Type;

export const WorkspaceSetupDetail = Schema.Struct({
  type: Schema.Literal("worktree_setup"),
  worktreePath: Schema.String,
  branchName: Schema.String,
  log: Schema.String,
  commands: Schema.Array(WorkspaceSetupCommand),
  truncated: Schema.optional(Schema.Boolean),
});
export type WorkspaceSetupDetail = typeof WorkspaceSetupDetail.Type;

export const WorkspaceSetupBlockedSource = Schema.Struct({
  kind: Schema.Literal("change_request"),
  forge: Schema.String,
  number: Schema.Number,
  headRepository: Schema.String,
});
export type WorkspaceSetupBlockedSource = typeof WorkspaceSetupBlockedSource.Type;

export const WorkspaceSetupSnapshot = Schema.Struct({
  status: Schema.Literals(["running", "completed", "failed", "blocked"]),
  detail: WorkspaceSetupDetail,
  error: Schema.NullOr(Schema.String),
  blockedSource: Schema.optional(WorkspaceSetupBlockedSource),
});
export type WorkspaceSetupSnapshot = typeof WorkspaceSetupSnapshot.Type;

export const WorkspaceSetupSubscribeInput = Schema.Struct({
  workspaceId: Schema.String,
});
export type WorkspaceSetupSubscribeInput = typeof WorkspaceSetupSubscribeInput.Type;

/**
 * One snapshot per emission: the initial cached read, then every progress transition.
 * `error` is a host-level failure (an old daemon without owned setup subscriptions);
 * the stream stays open afterwards so the transport does not retry in a loop.
 */
export const WorkspaceSetupEvent = Schema.Struct({
  workspaceId: Schema.String,
  snapshot: Schema.NullOr(WorkspaceSetupSnapshot),
  error: Schema.optional(Schema.NullOr(Schema.String)),
});
export type WorkspaceSetupEvent = typeof WorkspaceSetupEvent.Type;

export const WorkspaceSetupRunInput = Schema.Struct({
  workspaceId: Schema.String,
});
export type WorkspaceSetupRunInput = typeof WorkspaceSetupRunInput.Type;

export const WorkspaceSetupRunResult = Schema.Struct({
  workspaceId: Schema.String,
  started: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
});
export type WorkspaceSetupRunResult = typeof WorkspaceSetupRunResult.Type;
