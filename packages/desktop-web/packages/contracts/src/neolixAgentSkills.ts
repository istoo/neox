// FILE: neolixAgentSkills.ts
// Purpose: RPC schemas for the daemon's bundled (orchestration) skills surface:
//   whether they are installed, how their installed copy drifted from the
//   bundled one, which skills the user chose, and the two writes that converge
//   a host on that choice. The bridge forwards each method to the daemon's
//   `agent.skills.*` request.
// Layer: Contracts

import { Schema } from "effect";

export const NEOLIX_AGENT_SKILLS_WS_METHODS = {
  get: "neolix.agentSkills.get",
  reconcile: "neolix.agentSkills.reconcile",
  uninstall: "neolix.agentSkills.uninstall",
  saveSelection: "neolix.agentSkills.saveSelection",
} as const;

export type NeolixAgentSkillsWsMethod =
  (typeof NEOLIX_AGENT_SKILLS_WS_METHODS)[keyof typeof NEOLIX_AGENT_SKILLS_WS_METHODS];

/** `all` keeps every bundled skill (including ones added later); `custom` names them. */
export const AgentSkillSelection = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("all") }),
  Schema.Struct({ mode: Schema.Literal("custom"), skills: Schema.Array(Schema.String) }),
]);
export type AgentSkillSelection = typeof AgentSkillSelection.Type;

/** One difference between what the host bundles and what it installed. */
export const AgentSkillOperation = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("add"), name: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("update"), name: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("delete"), name: Schema.String }),
]);
export type AgentSkillOperation = typeof AgentSkillOperation.Type;

export const AgentSkillsStatus = Schema.Struct({
  state: Schema.Literals(["not-installed", "up-to-date", "drift"]),
  ops: Schema.Array(AgentSkillOperation),
  available: Schema.Array(Schema.String),
  installed: Schema.Array(Schema.String),
  selection: AgentSkillSelection,
});
export type AgentSkillsStatus = typeof AgentSkillsStatus.Type;

/** The skills a save would delete from disk; the host asks before doing it. */
export const AgentSkillsConfirmation = Schema.Struct({ removals: Schema.Array(Schema.String) });
export type AgentSkillsConfirmation = typeof AgentSkillsConfirmation.Type;

export const AgentSkillsSaveResult = Schema.Struct({
  state: Schema.Literals(["not-installed", "up-to-date", "drift"]),
  ops: Schema.Array(AgentSkillOperation),
  available: Schema.Array(Schema.String),
  installed: Schema.Array(Schema.String),
  selection: AgentSkillSelection,
  confirmationRequired: Schema.NullOr(AgentSkillsConfirmation),
});
export type AgentSkillsSaveResult = typeof AgentSkillsSaveResult.Type;

export const AgentSkillsEmptyInput = Schema.Struct({});
export type AgentSkillsEmptyInput = typeof AgentSkillsEmptyInput.Type;

export const AgentSkillsSaveInput = Schema.Struct({
  selection: AgentSkillSelection,
  /** Names the user has already approved deleting on a previous attempt. */
  confirmedRemovals: Schema.optional(Schema.Array(Schema.String)),
});
export type AgentSkillsSaveInput = typeof AgentSkillsSaveInput.Type;
