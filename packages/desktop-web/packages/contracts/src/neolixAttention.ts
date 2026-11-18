// FILE: neolixAttention.ts
// Purpose: RPC schemas for clearing Neox attention marks. Neox keeps two independent marks:
//   one on the agent (finished/error) and one on the workspace (status attention/failed).
//   The old app clears the agent mark when the agent is viewed, focused, or prompted, and
//   clears the workspace mark from the sidebar's "Mark read" action.
// Layer: Contracts

import { Schema } from "effect";

import { TrimmedNonEmptyString } from "./baseSchemas";

export const NEOLIX_ATTENTION_WS_METHODS = {
  clearAgent: "neolix.attention.clearAgent",
  clearWorkspace: "neolix.attention.clearWorkspace",
} as const;

export type NeolixAttentionWsMethod =
  (typeof NEOLIX_ATTENTION_WS_METHODS)[keyof typeof NEOLIX_ATTENTION_WS_METHODS];

export const NeolixAgentAttentionClearInput = Schema.Struct({
  /** A Synara thread id is the Neox agent id. */
  threadId: TrimmedNonEmptyString,
});
export type NeolixAgentAttentionClearInput = typeof NeolixAgentAttentionClearInput.Type;

export const NeolixWorkspaceAttentionClearInput = Schema.Struct({
  threadId: Schema.optional(TrimmedNonEmptyString),
  workspaceId: Schema.optional(TrimmedNonEmptyString),
});
export type NeolixWorkspaceAttentionClearInput = typeof NeolixWorkspaceAttentionClearInput.Type;

export const NeolixAttentionClearResult = Schema.Struct({});
export type NeolixAttentionClearResult = typeof NeolixAttentionClearResult.Type;
