/**
 * Neolix provider-subagent reads.
 *
 * Neolix keeps provider-native subagents (Claude Code task agents, Codex collab agents) on the
 * parent agent: `listProviderSubagents` and `fetchProviderSubagentTimeline`. The Synara fork has
 * no RPC for that inventory — its own subagent surfaces read thread activities — so these calls
 * exist for the dock and its timeline view.
 */
import { Schema } from "effect";

import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas";

export const NeolixSubagentStatus = Schema.Literals(["running", "completed", "failed", "canceled"]);
export type NeolixSubagentStatus = typeof NeolixSubagentStatus.Type;

export const NeolixSubagent = Schema.Struct({
  id: TrimmedNonEmptyString,
  parentAgentId: TrimmedNonEmptyString,
  parentSubagentId: Schema.optional(Schema.NullOr(Schema.String)),
  provider: Schema.String,
  title: Schema.NullOr(Schema.String),
  description: Schema.NullOr(Schema.String),
  status: NeolixSubagentStatus,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  toolCallId: Schema.NullOr(Schema.String),
  cwd: Schema.optional(Schema.NullOr(Schema.String)),
  subtitle: Schema.optional(Schema.NullOr(Schema.String)),
});
export type NeolixSubagent = typeof NeolixSubagent.Type;

export const NeolixSubagentsListInput = Schema.Struct({
  threadId: TrimmedNonEmptyString,
});
export type NeolixSubagentsListInput = typeof NeolixSubagentsListInput.Type;

export const NeolixSubagentsListResult = Schema.Struct({
  subagents: Schema.Array(NeolixSubagent),
});
export type NeolixSubagentsListResult = typeof NeolixSubagentsListResult.Type;

export const NeolixSubagentTimelineInput = Schema.Struct({
  threadId: TrimmedNonEmptyString,
  subagentId: TrimmedNonEmptyString,
  direction: Schema.optional(Schema.Literals(["tail", "before", "after"])),
  limit: Schema.optional(NonNegativeInt),
});
export type NeolixSubagentTimelineInput = typeof NeolixSubagentTimelineInput.Type;

export const NeolixSubagentTimelineRow = Schema.Struct({
  item: Schema.Unknown,
  timestamp: IsoDateTime,
  seq: NonNegativeInt,
});
export type NeolixSubagentTimelineRow = typeof NeolixSubagentTimelineRow.Type;

export const NeolixSubagentTimelineResult = Schema.Struct({
  rows: Schema.Array(NeolixSubagentTimelineRow),
  hasOlder: Schema.Boolean,
  hasNewer: Schema.Boolean,
});
export type NeolixSubagentTimelineResult = typeof NeolixSubagentTimelineResult.Type;

/** Turn a child agent into a standalone agent: the daemon clears its parent link. */
export const NeolixSubagentDetachInput = Schema.Struct({
  /** A Synara thread id is the Neox agent id. */
  agentId: TrimmedNonEmptyString,
});
export type NeolixSubagentDetachInput = typeof NeolixSubagentDetachInput.Type;

export const NeolixSubagentDetachResult = Schema.Struct({});
export type NeolixSubagentDetachResult = typeof NeolixSubagentDetachResult.Type;
